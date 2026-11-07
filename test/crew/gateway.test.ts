/**
 * Gateway lifecycle wrappers (08 §3.8) against the fake KiroCrew CLI, whose `gateway` verb is a
 * real detached HTTP server printing `KIROCREW_READY:{…}` and serving the cookie-authenticated
 * dashboard routes crew uses.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readState, writeState } from '../../src/crew/state.js';
import { defaultRunner, defaultSys, type CrewRunner, type CrewSys, type ProcessInfo } from '../../src/crew/runner.js';
import { cloneFakeEnv, crew, freePort, makeFakeEnv, realPython, type FakeEnv } from './helpers.js';

const PY = realPython();
let base: FakeEnv | undefined;

async function setUp(extraEnv: NodeJS.ProcessEnv = {}): Promise<FakeEnv> {
  if (!base) {
    base = makeFakeEnv();
    fs.writeFileSync(path.join(base.home, '.fake-claude-login'), '');
    const r = await crew(base, ['setup', '--dir', path.join(base.root, 'KiroCrew'), '--allow-tmp']);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  }
  return cloneFakeEnv(base, { extraEnv });
}

// One setup for the whole file; every test works on its own copy.
after(() => base?.cleanup());

function kcHome(fe: FakeEnv): string {
  return path.join(fe.home, '.kiro', 'crew');
}

function gatewayPid(fe: FakeEnv): number | undefined {
  try {
    return (JSON.parse(fs.readFileSync(path.join(kcHome(fe), 'fake-gateway.json'), 'utf8')) as { pid: number }).pid;
  } catch {
    return undefined;
  }
}

/** Start time of a process (`/proc/<pid>/stat` field 22, clock ticks since boot). */
function procStart(pid: number): number | undefined {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const v = Number(s.slice(s.lastIndexOf(')') + 1).trim().split(/\s+/)[19]);
    return Number.isInteger(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Running = not gone and not a zombie (a zombie has an empty cmdline). */
function running(pid: number): boolean {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`).length > 0;
  } catch {
    return false;
  }
}

/** `pid` still runs the process that had start time `start` (not a later one reusing the pid). */
function stillRuns(pid: number, start: number | undefined): boolean {
  return running(pid) && procStart(pid) === start;
}

type Proc = ProcessInfo & { startTime?: number };

/**
 * Waits for a SIGKILLed `pid` to be gone as crew stop sees it: an empty cmdline is not enough (the
 * mm is released early in exit, while the task still runs and signal 0 still reaches it).
 */
async function waitDead(pid: number): Promise<void> {
  for (let i = 0; i < 250 && (running(pid) || defaultSys.isAlive(pid)); i++) await new Promise((res) => setTimeout(res, 20));
}

/** An unrelated live process (one that took a stale record's pid); it notes every SIGTERM it gets. */
async function bystander(fe: FakeEnv, env: NodeJS.ProcessEnv): Promise<{ pid: number; start?: number; terms(): number; stop(): void }> {
  const marker = path.join(fe.root, `bystander-${Date.now()}-${Math.random().toString(36).slice(2)}.sig`);
  const code = `const fs=require('fs');process.on('SIGTERM',()=>fs.appendFileSync(${JSON.stringify(marker)},'TERM\\n'));setInterval(()=>{},1000);`;
  const ch = spawn(process.execPath, ['-e', code], { env: { PATH: '/usr/bin:/bin', ...env }, stdio: 'ignore' });
  await new Promise((res) => setTimeout(res, 300)); // its SIGTERM handler is installed
  const pid = ch.pid!;
  return {
    pid,
    start: procStart(pid),
    terms: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0),
    stop: () => ch.kill('SIGKILL'), // through Node's handle: never a reused pid
  };
}

function bootId(): string | undefined {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * The real CrewSys, except that pid `g` (the gateway) is reused `delayMs` after the real gateway
 * has gone: by an unrelated process U (`uAlive`; else U has exited already) leading group `g`,
 * whose children never were in the gateway's tree: V of another crew (another HOME and
 * KIROCREW_KIRO_BIN) and, with `members: 'both'`, W of this crew (its HOME and KIROCREW_KIRO_BIN,
 * like a gateway restarted at once). Signals to the reused pid and to V/W are recorded, never sent.
 * With `hidden`, U (and V/W) belong to another user and /proc hides them (`hidepid`): signal 0
 * answers EPERM (it exists), its stat cannot be read, it is not listed, and a signal is refused.
 */
function reusedPidSys(g: number, o: { delayMs: number; uAlive: boolean; members: 'both' | 'other'; home: string; kiroBin: string; other: string; hidden?: boolean }) {
  const real = defaultSys;
  const signals: Array<{ pid: number; signal: string }> = [];
  const uStart = (procStart(g) ?? 0) + 1000;
  const V = 2 ** 22 + 101; // above any pid_max: never a real process
  const W = 2 ** 22 + 102;
  const ppid = o.uAlive ? g : 1;
  const sleepArgv = ['/usr/bin/sleep', '30'];
  const fakes: Proc[] = [
    { pid: V, ppid, pgid: g, argv: sleepArgv, startTime: uStart + 1, env: { HOME: o.other, KIROCREW_KIRO_BIN: path.join(o.other, '.local', 'share', 'kiro-claude', 'crew', 'bin', 'kiro-claude'), KIROCREW_SPAWNED: '1' } },
    ...(o.members === 'both' ? [{ pid: W, ppid, pgid: g, argv: sleepArgv, startTime: uStart + 2, env: { HOME: o.home, KIROCREW_KIRO_BIN: o.kiroBin, KIROCREW_SPAWNED: '1' } }] : []),
  ];
  const U: Proc = { pid: g, ppid: 1, pgid: g, argv: sleepArgv, startTime: uStart, env: { HOME: o.other, PATH: '/usr/bin:/bin' } };
  const fakePids = new Set(fakes.map((p) => p.pid));
  let goneAt: number | undefined;
  const reused = (): boolean => {
    if (goneAt === undefined && !real.isAlive(g)) goneAt = Date.now();
    return goneAt !== undefined && Date.now() - goneAt >= o.delayMs;
  };
  const sys = {
    ...real,
    isAlive: (pid: number) => (pid === g && reused() ? o.uAlive : fakePids.has(pid) ? reused() : real.isAlive(pid)),
    startTime: (pid: number) =>
      pid === g && reused() ? (o.uAlive && !o.hidden ? uStart : undefined) : fakePids.has(pid) ? (o.hidden ? undefined : fakes.find((p) => p.pid === pid)!.startTime) : procStart(pid),
    kill: (pid: number, signal: NodeJS.Signals, start: number | undefined) => {
      if (fakePids.has(pid) || (pid === g && !real.isAlive(g))) {
        signals.push({ pid, signal });
        return !o.hidden && reused();
      }
      return real.kill(pid, signal, start);
    },
    listProcesses: () => {
      const list = real.listProcesses();
      return reused() ? [...list.filter((p) => p.pid !== g), ...(o.hidden ? [] : [...(o.uAlive ? [U] : []), ...fakes])] : list;
    },
  } as CrewSys;
  return { sys, signals, V, W };
}

describe('crew start / status / open / stop (08 §3.8)', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  it('full lifecycle: start → already running → status → open → stop', async () => {
    const fe = await setUp({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'leak', CCR_TEST: 'x' });
    try {
      const port = await freePort();
      let r = await crew(fe, ['start', '--port', String(port), '--env', 'FAKE_EXTRA=yes', '--env', 'KIRO_CLAUDE_FORCE_MODEL=haiku']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      const pid = gatewayPid(fe)!;
      assert.equal(r.stdout, `Kiro Crew gateway running at http://localhost:${port} (pid ${pid}). Open it with: kiro-claude crew open\n`);

      // The detached launch: exact argv, cwd = checkout, §3.7 env, run files 0600.
      const launch = fe.callsOf('kirocrew').find((c) => c.args[0] === 'gateway')!;
      assert.deepEqual(launch.args, ['gateway', '--no-open', '--no-tunnel', '--json-ready', '--port', String(port)]);
      assert.equal(launch.cwd, path.join(fe.root, 'KiroCrew'));
      assert.equal(launch.env.KIROCREW_KIRO_BIN, path.join(fe.cs, 'bin', 'kiro-claude'));
      assert.equal(launch.env.FAKE_EXTRA, 'yes');
      assert.equal(launch.env.KIRO_CLAUDE_FORCE_MODEL, 'haiku');
      assert.equal(launch.env.PYTHONUNBUFFERED, '1');
      for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CCR_TEST']) assert.equal(launch.env[k], undefined, k);
      const run = path.join(fe.cs, 'run');
      const ready = JSON.parse(fs.readFileSync(path.join(run, 'ready.json'), 'utf8'));
      // W1: the READY object plus who the gateway is (its pid outlives it): start time and boot;
      // K7: and that it leads its own process group (setsid), where a crash leaves its children;
      // C1: and the HOME / KIROCREW_KIRO_BIN those children inherit (what tells them this crew's)
      const env = { HOME: fe.home, KIROCREW_KIRO_BIN: path.join(fe.cs, 'bin', 'kiro-claude') };
      const identity = process.platform === 'linux' ? { pid, startTime: procStart(pid), bootId: bootId(), pgid: pid, env } : { pid };
      assert.deepEqual(ready, { port, token: `tok-${pid}`, pid, home: kcHome(fe), kiroClaude: identity });
      assert.equal(fs.readFileSync(path.join(run, 'token'), 'utf8'), `tok-${pid}\n`);
      for (const f of ['ready.json', 'token', 'gateway.out', 'gateway.err']) assert.equal(fs.statSync(path.join(run, f)).mode & 0o777, 0o600, f);

      // Second start: no new gateway; prints status, exit 0.
      r = await crew(fe, ['start', '--port', String(port)]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, new RegExp(`Kiro Crew gateway: running \\(pid ${pid}, port ${port}\\)`));
      assert.equal(fe.callsOf('kirocrew').filter((c) => c.args[0] === 'gateway').length, 1);

      // status (human + json)
      r = await crew(fe, ['status']);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(
        r.stdout,
        [
          `Kiro Crew gateway: running (pid ${pid}, port ${port})`,
          `  URL:       http://localhost:${port}`,
          '  KiroCrew:  0.13.0',
          '  Backends:  main = kiro (kiro-claude) ✅, members = claude (claude-agent-acp) ✅',
          '  Ready:     yes',
          '',
        ].join('\n'),
      );
      r = await crew(fe, ['status', '--json']);
      const j = JSON.parse(r.stdout);
      assert.deepEqual(
        { running: j.running, ready: j.ready, pid: j.pid, port: j.port, version: j.version, main: j.backends.main, members: j.backends.members, pre: j.prerequisite },
        { running: true, ready: true, pid, port, version: '0.13.0', main: 'kiro', members: 'claude', pre: { installed: true, authenticated: true, ready: true, missingAgentSpecs: [], rejectedAgentSpecs: [] } },
      );
      // The token is presented once; later calls use the cookie (08b §2.3).
      const http = fs.readFileSync(path.join(kcHome(fe), 'fake-http.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { path: string; cookie: boolean; token: boolean });
      for (const h of http) assert.ok(h.path === '/api/status' ? h.token || h.cookie : h.cookie, JSON.stringify(h));

      // doctor sees the running gateway (D11).
      r = await crew(fe, ['doctor', '--json']);
      const d11 = (JSON.parse(r.stdout).rows as Array<{ id: string; status: string; detail: string }>).find((x) => x.id === 'D11')!;
      assert.equal(d11.status, 'ok', d11.detail);

      // open --print: a freshly minted URL on stdout only, the warning on stderr.
      r = await crew(fe, ['open', '--print', '--ttl', '30m']);
      assert.equal(r.code, 0);
      assert.match(r.stdout, new RegExp(`^http://localhost:${port}\\?token=minted-\\S+\\n$`));
      assert.equal(r.stderr, 'This link signs you in; do not share it.\n');
      assert.deepEqual(fe.callsOf('kirocrew').filter((c) => c.args[0] === 'token').pop()!.args, ['token', '--port', String(port), '--ttl', '30m']);
      // open: xdg-open gets the URL.
      r = await crew(fe, ['open']);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, 'Opened the Kiro Crew dashboard.\n');
      const opened = fe.callsOf('open').pop()!;
      assert.match(opened.args[0]!, /token=minted-/);
      r = await crew(fe, ['open'], { env: { FAKE_OPEN_EXIT: '3' } });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /^http:\/\/localhost:\d+\?token=/);
      assert.match(r.stderr, /Could not open a browser/);

      // stop
      r = await crew(fe, ['stop']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, `Stopped (pid ${pid}); 0 orphan agent process(es) reaped\n`);
      assert.equal(defaultSys.isAlive(pid), false);
      assert.equal(fs.existsSync(path.join(run, 'token')), false);
      assert.equal(fs.existsSync(path.join(run, 'ready.json')), false);
      r = await crew(fe, ['status']);
      assert.equal(r.code, 3);
      assert.equal(r.stdout, 'Kiro Crew gateway: stopped\n');
      r = await crew(fe, ['status', '--json']);
      assert.equal(r.code, 3);
      assert.equal(JSON.parse(r.stdout).running, false);
      r = await crew(fe, ['open']);
      assert.equal(r.code, 3);
      assert.match(r.stderr, /not running\. Start it with: kiro-claude crew start/);
      r = await crew(fe, ['stop']);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, 'Kiro Crew gateway is not running.\n');
    } finally {
      fe.cleanup();
    }
  });

  it('status: running but not ready → exit 4 with the reason; a stale token is re-minted', async () => {
    const fe = await setUp({ FAKE_GW_AUTH: '0' });
    try {
      let r = await crew(fe, ['start', '--port', 'auto']);
      assert.equal(r.code, 0, r.stderr);
      const port = JSON.parse(fs.readFileSync(path.join(fe.cs, 'run', 'ready.json'), 'utf8')).port as number;
      assert.ok(port > 0);
      fs.writeFileSync(path.join(fe.cs, 'run', 'token'), 'expired-token\n');
      r = await crew(fe, ['status']);
      assert.equal(r.code, 4, r.stdout);
      assert.match(r.stdout, /Ready: {5}no \(not signed in \(whoami failed\)\)/);
      assert.match(fs.readFileSync(path.join(fe.cs, 'run', 'token'), 'utf8'), /^minted-/);
      r = await crew(fe, ['stop']);
      assert.equal(r.code, 0);
    } finally {
      fe.cleanup();
    }
  });

  it('start: a gateway that exits early shows the last lines of gateway.err, exit 1', async () => {
    const fe = await setUp({ FAKE_GATEWAY_MODE: 'fail' });
    try {
      const r = await crew(fe, ['start', '--port', String(await freePort())]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /the Kiro Crew gateway exited before it was ready\. Last lines of .*gateway\.err:/);
      assert.match(r.stderr, /RuntimeError: fake gateway failure/);
    } finally {
      fe.cleanup();
    }
  });

  it('start: no READY line within the timeout → exit 1 with a hint', async () => {
    const fe = await setUp({ FAKE_GATEWAY_MODE: 'hang' });
    try {
      const r = await crew(fe, ['start', '--port', String(await freePort())], { deps: { startTimeoutMs: 800 } });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /did not become ready within 1 s/);
      assert.match(r.stderr, /booting fake gateway/);
      assert.match(r.stderr, /kiro-claude crew stop/);
      const s = await crew(fe, ['stop', '--timeout', '1']);
      assert.equal(s.code, 0, s.stderr);
    } finally {
      fe.cleanup();
    }
  });

  it('stop: falls back to SIGTERM, then SIGKILL, when kirocrew stop does not stop it', async () => {
    const fe = await setUp({ FAKE_STOP_IGNORE: '1', FAKE_GATEWAY_MODE: 'ignore-term' });
    try {
      let r = await crew(fe, ['start', '--port', String(await freePort())]);
      assert.equal(r.code, 0, r.stderr);
      const pid = gatewayPid(fe)!;
      const t0 = Date.now();
      r = await crew(fe, ['stop', '--timeout', '1']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(defaultSys.isAlive(pid), false);
      assert.ok(Date.now() - t0 >= 1000, 'waited for the timeout and the kill grace');
      assert.match(r.stdout, new RegExp(`Stopped \\(pid ${pid}\\)`));
    } finally {
      fe.cleanup();
    }
  });

  for (const kind of ['linger', 'stubborn'] as const) {
    it(`stop: retires a ${kind} child the gateway left in its process group (KiroCrew's history-index worker)`, { skip: process.platform !== 'linux' ? 'needs /proc' : false }, async () => {
      const fe = await setUp({ FAKE_GATEWAY_CHILD: kind });
      let child: number | undefined;
      let childStart: number | undefined;
      try {
        let r = await crew(fe, ['start', '--port', String(await freePort())]);
        assert.equal(r.code, 0, r.stderr);
        child = (JSON.parse(fs.readFileSync(path.join(kcHome(fe), 'fake-gateway-child.json'), 'utf8')) as { pid: number }).pid;
        childStart = procStart(child);
        assert.equal(stillRuns(child, childStart), true, 'the gateway child runs');
        r = await crew(fe, ['stop']);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /^Stopped \(pid \d+\); 0 orphan agent process\(es\) reaped\n$/);
        assert.equal(stillRuns(child, childStart), false, `the ${kind} gateway child outlived crew stop`);
      } finally {
        // K8: only the child itself, never a later process that took its pid
        if (child !== undefined && stillRuns(child, childStart)) process.kill(child, 'SIGKILL');
        fe.cleanup();
      }
    });
  }

  it('stop: retires a child the gateway starts while it shuts down (not in the snapshot; found in its process group)', { skip: process.platform !== 'linux' ? 'needs /proc' : false }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'late' });
    let child: { pid: number; start?: number } | undefined;
    try {
      let r = await crew(fe, ['start', '--port', String(await freePort())]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(fs.existsSync(path.join(kcHome(fe), 'fake-gateway-child.json')), false);
      r = await crew(fe, ['stop']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^Stopped \(pid \d+\); 0 orphan agent process\(es\) reaped\n$/);
      // pid and start time, as the gateway recorded them when it started the child
      child = JSON.parse(fs.readFileSync(path.join(kcHome(fe), 'fake-gateway-child.json'), 'utf8')) as { pid: number; start?: number };
      assert.ok(child.start !== undefined, 'the fake records the child\'s start time');
      assert.equal(stillRuns(child.pid, child.start), false, 'the late gateway child outlived crew stop');
    } finally {
      if (child !== undefined && stillRuns(child.pid, child.start)) process.kill(child.pid, 'SIGKILL');
      fe.cleanup();
    }
  });

  // G6: once crew stop has seen the gateway go, its pid (and, for a detached gateway, its process
  // group id) can be taken by any other process. Nothing that never was in the gateway's tree may
  // be signalled, and the stop is still reported as done.
  const reuseCases = [
    { name: 'a --foreground gateway whose pid is reused during the retire wait', foreground: true, delayMs: 300, uAlive: true, members: 'both' },
    { name: 'a detached gateway whose pid and group are reused during the retire wait', foreground: false, delayMs: 300, uAlive: true, members: 'both' },
    { name: 'a detached gateway whose pid is reused as soon as it exits', foreground: false, delayMs: 0, uAlive: true, members: 'both' },
    { name: "a detached gateway whose group id is left to another crew's process as soon as it exits", foreground: false, delayMs: 0, uAlive: false, members: 'other' },
  ] as const;
  for (const rc of reuseCases) {
    it(`stop: ${rc.name} → no foreign process is signalled, the stop is reported`, { skip: process.platform !== 'linux' ? 'needs /proc' : false }, async () => {
      const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn' });
      let child: number | undefined;
      let childStart: number | undefined;
      let gw: { pid: number; start?: number } | undefined;
      let fg: Promise<{ code: number; stdout: string; stderr: string }> | undefined;
      try {
        const port = await freePort();
        if (rc.foreground) {
          fg = crew(fe, ['start', '--foreground', '--port', String(port)]);
          for (let i = 0; i < 200 && (!gatewayPid(fe) || !fs.existsSync(path.join(kcHome(fe), 'fake-gateway-child.json'))); i++) await new Promise((res) => setTimeout(res, 50));
        } else {
          const r = await crew(fe, ['start', '--port', String(port)]);
          assert.equal(r.code, 0, r.stderr);
        }
        const g = gatewayPid(fe)!;
        assert.ok(g, 'the gateway runs');
        gw = { pid: g, start: procStart(g) };
        child = (JSON.parse(fs.readFileSync(path.join(kcHome(fe), 'fake-gateway-child.json'), 'utf8')) as { pid: number }).pid;
        childStart = procStart(child);
        const other = path.join(fe.root, 'other-home');
        const sim = reusedPidSys(g, { ...rc, home: fe.home, kiroBin: path.join(fe.cs, 'bin', 'kiro-claude'), other });
        const r = await crew(fe, ['stop', '--timeout', '2'], { deps: { sys: sim.sys } });
        assert.deepEqual(sim.signals, [], `crew stop signalled processes that never were in the gateway's tree (U = ${g}, V = ${sim.V}, W = ${sim.W})`);
        assert.deepEqual({ code: r.code, stderr: r.stderr }, { code: 0, stderr: '' }, 'the gateway did stop');
        assert.equal(r.stdout, `Stopped (pid ${g}); 0 orphan agent process(es) reaped\n`);
        assert.equal(stillRuns(child, childStart), false, "the gateway's own stubborn child outlived crew stop");
        if (fg) assert.equal((await fg).code, 0);
      } finally {
        if (child !== undefined && stillRuns(child, childStart)) process.kill(child, 'SIGKILL');
        if (gw && stillRuns(gw.pid, gw.start)) process.kill(gw.pid, 'SIGKILL');
        await fg;
        fe.cleanup();
      }
    });
  }

  // G6 (verifier): the same, on the paths the cases above do not reach.
  it('stop: a gateway pid taken by another user\'s process that /proc hides (hidepid) as soon as it exits → gone at once, nothing signalled, the stop is reported', { skip: process.platform !== 'linux' ? 'needs /proc' : false }, async () => {
    const fe = await setUp();
    let gw: { pid: number; start?: number } | undefined;
    try {
      let r = await crew(fe, ['start', '--port', String(await freePort())]);
      assert.equal(r.code, 0, r.stderr);
      const g = gatewayPid(fe)!;
      gw = { pid: g, start: procStart(g) };
      const sim = reusedPidSys(g, { delayMs: 0, uAlive: true, members: 'other', hidden: true, home: fe.home, kiroBin: path.join(fe.cs, 'bin', 'kiro-claude'), other: path.join(fe.root, 'other-home') });
      const t0 = Date.now();
      r = await crew(fe, ['stop', '--timeout', '5'], { deps: { sys: sim.sys } });
      assert.deepEqual(sim.signals, [], `crew stop signalled pid ${g} after another user's process took it`);
      assert.deepEqual({ code: r.code, stderr: r.stderr }, { code: 0, stderr: '' }, 'the gateway did stop');
      assert.equal(r.stdout, `Stopped (pid ${g}); 0 orphan agent process(es) reaped\n`);
      assert.ok(Date.now() - t0 < 5000, `crew stop waited ${Date.now() - t0} ms (the --timeout) for a gateway that was gone`);
    } finally {
      if (gw && stillRuns(gw.pid, gw.start)) process.kill(gw.pid, 'SIGKILL');
      fe.cleanup();
    }
  });

  it('stop: a gateway that needs the SIGKILL fallback and whose pid is reused the moment it dies → the stop is reported, the new process is not signalled', { skip: process.platform !== 'linux' ? 'needs /proc' : false }, async () => {
    const fe = await setUp({ FAKE_STOP_IGNORE: '1', FAKE_GATEWAY_MODE: 'ignore-term' });
    let gw: { pid: number; start?: number } | undefined;
    try {
      let r = await crew(fe, ['start', '--port', String(await freePort())]);
      assert.equal(r.code, 0, r.stderr);
      const g = gatewayPid(fe)!;
      gw = { pid: g, start: procStart(g) };
      const sim = reusedPidSys(g, { delayMs: 0, uAlive: true, members: 'other', home: fe.home, kiroBin: path.join(fe.cs, 'bin', 'kiro-claude'), other: path.join(fe.root, 'other-home') });
      r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys: sim.sys } });
      assert.equal(stillRuns(g, gw.start), false, 'the gateway was killed');
      assert.deepEqual(sim.signals, [], `crew stop signalled the process that took pid ${g}`);
      assert.deepEqual({ code: r.code, stderr: r.stderr }, { code: 0, stderr: '' }, 'the gateway did stop');
      assert.equal(r.stdout, `Stopped (pid ${g}); 0 orphan agent process(es) reaped\n`);
    } finally {
      if (gw && stillRuns(gw.pid, gw.start)) process.kill(gw.pid, 'SIGKILL');
      fe.cleanup();
    }
  });

  it("stop: a pid of the gateway's tree that another crew's process (same argv) takes during the retire wait is not signalled; the rest of the tree is retired", { skip: process.platform !== 'linux' ? 'needs /proc' : false }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'linger' });
    let gw: { pid: number; start?: number } | undefined;
    let child: number | undefined;
    let childStart: number | undefined;
    try {
      let r = await crew(fe, ['start', '--port', String(await freePort())]);
      assert.equal(r.code, 0, r.stderr);
      const g = gatewayPid(fe)!;
      gw = { pid: g, start: procStart(g) };
      const L = (JSON.parse(fs.readFileSync(path.join(kcHome(fe), 'fake-gateway-child.json'), 'utf8')) as { pid: number }).pid;
      child = L;
      childStart = procStart(L);
      const lInfo = defaultSys.listProcesses().find((p) => p.pid === L)!;
      assert.ok(lInfo && childStart !== undefined, 'the linger child runs');
      // F: a stubborn member of the tree (keeps the retire wait polling until the deadline).
      // X: after L has exited, another crew's process with L's argv takes pid L.
      const F = 2 ** 22 + 201;
      const fInfo: Proc = { pid: F, ppid: g, pgid: g, argv: ['/usr/bin/sleep', '30'], startTime: (gw.start ?? 0) + 1, env: { HOME: fe.home, KIROCREW_KIRO_BIN: path.join(fe.cs, 'bin', 'kiro-claude') } };
      const other = path.join(fe.root, 'other-home');
      const xInfo: Proc = { pid: L, ppid: 1, pgid: 1, argv: lInfo.argv, startTime: childStart + 1000, env: { HOME: other, KIROCREW_KIRO_BIN: path.join(other, '.local', 'share', 'kiro-claude', 'crew', 'bin', 'kiro-claude'), KIROCREW_SPAWNED: '1' } };
      const signals: Array<{ pid: number; signal: string }> = [];
      let fAlive = true;
      const lGone = (): boolean => !stillRuns(L, childStart);
      const sys = {
        ...defaultSys,
        startTime: (pid: number) => (pid === F ? fInfo.startTime : pid === L && lGone() ? xInfo.startTime : defaultSys.startTime(pid)),
        isAlive: (pid: number) => (pid === F ? fAlive : pid === L && lGone() ? true : defaultSys.isAlive(pid)),
        kill: (pid: number, signal: NodeJS.Signals, start: number | undefined) => {
          if (pid === F || (pid === L && lGone())) {
            signals.push({ pid: pid === F ? F : -L, signal });
            if (pid === F && signal === 'SIGKILL') fAlive = false;
            return true;
          }
          return defaultSys.kill(pid, signal, start);
        },
        listProcesses: () => {
          const list = defaultSys.listProcesses().filter((p) => p.pid !== L || !lGone());
          return [...list, ...(fAlive ? [fInfo] : []), ...(lGone() ? [xInfo] : [])];
        },
      } as CrewSys;
      r = await crew(fe, ['stop'], { deps: { sys } });
      assert.equal(lGone(), true, 'the linger child was retired');
      assert.deepEqual(signals, [
        { pid: F, signal: 'SIGTERM' },
        { pid: F, signal: 'SIGKILL' },
      ], `only F, of the tree, was signalled (X, which took pid ${L}, is -${L})`);
      assert.deepEqual({ code: r.code, stderr: r.stderr }, { code: 0, stderr: '' });
      assert.equal(r.stdout, `Stopped (pid ${g}); 0 orphan agent process(es) reaped\n`);
    } finally {
      if (child !== undefined && stillRuns(child, childStart)) process.kill(child, 'SIGKILL');
      if (gw && stillRuns(gw.pid, gw.start)) process.kill(gw.pid, 'SIGKILL');
      fe.cleanup();
    }
  });

  it('stop: reaps orphaned kiro-claude acp processes (KIROCREW_SPAWNED=1, same HOME)', { skip: process.platform !== 'linux' ? 'needs /proc' : false }, async () => {
    const fe = await setUp();
    const spawnAgent = (home: string) =>
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/x/dist/src/bin/kiro-claude.js', 'acp', '--agent-engine', 'v2'], {
        env: { HOME: home, KIROCREW_SPAWNED: '1', PATH: '/usr/bin:/bin' },
        stdio: 'ignore',
      });
    const mine = spawnAgent(fe.home);
    const other = spawnAgent(path.join(fe.root, 'someone-else'));
    try {
      await new Promise((r) => setTimeout(r, 300));
      let r = await crew(fe, ['start', '--port', String(await freePort())]);
      assert.equal(r.code, 0, r.stderr);
      r = await crew(fe, ['stop']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /; 1 orphan agent process\(es\) reaped/);
      await new Promise((res) => setTimeout(res, 300));
      assert.equal(mine.exitCode !== null || mine.signalCode !== null, true, 'our orphan was terminated');
      assert.equal(defaultSys.isAlive(other.pid!), true, 'another HOME is left alone');
    } finally {
      mine.kill('SIGKILL');
      other.kill('SIGKILL');
      fe.cleanup();
    }
  });

  it('start --kiro-bin records the foreign binary; --approval/--no-crons/--test-mode pass through', async () => {
    const fe = await setUp();
    try {
      const foreign = path.join(fe.root, 'fake-kiro-cli', 'kiro-claude');
      fs.mkdirSync(path.dirname(foreign), { recursive: true });
      fs.writeFileSync(foreign, '#!/bin/sh\n', { mode: 0o755 });
      const r = await crew(fe, ['start', '--port', String(await freePort()), '--kiro-bin', foreign, '--approval', 'reads', '--no-crons', '--test-mode']);
      assert.equal(r.code, 0, r.stderr);
      const launch = fe.callsOf('kirocrew').find((c) => c.args[0] === 'gateway')!;
      assert.equal(launch.env.KIROCREW_KIRO_BIN, foreign);
      assert.deepEqual(launch.args.slice(6), ['--approval', 'reads', '--no-crons', '--test-mode']);
      assert.equal(readState(path.join(fe.cs, 'crew.json'))!.kiroBinOverride, foreign);
      const d = JSON.parse((await crew(fe, ['doctor', '--json'])).stdout) as { rows: Array<{ id: string; status: string }> };
      assert.equal(d.rows.find((x) => x.id === 'D7')!.status, 'skip');
      assert.equal((await crew(fe, ['stop'])).code, 0);
      // A plain start clears the override.
      await crew(fe, ['start', '--port', String(await freePort())]);
      assert.equal(readState(path.join(fe.cs, 'crew.json'))!.kiroBinOverride, undefined);
      assert.equal((await crew(fe, ['stop'])).code, 0);
    } finally {
      fe.cleanup();
    }
  });

  it('start --foreground runs in place and returns the gateway exit code', async () => {
    const fe = await setUp({ FAKE_GATEWAY_MODE: 'fail' });
    try {
      const r = await crew(fe, ['start', '--foreground', '--port', '5999']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /RuntimeError: fake gateway failure/);
      assert.equal(fs.existsSync(path.join(fe.cs, 'run', 'ready.json')), false);
    } finally {
      fe.cleanup();
    }
  });

  it('setup while the gateway runs: a changed shim prints the restart hint; a rebuild is refused', async () => {
    const fe = await setUp();
    try {
      assert.equal((await crew(fe, ['start', '--port', String(await freePort())])).code, 0);
      const alt = path.join(fe.root, 'other-claude.mjs');
      fs.writeFileSync(alt, '', { mode: 0o755 });
      let r = await crew(fe, ['setup', '--allow-tmp', '--claude-bin', alt]);
      assert.match(r.stdout, /shim: .*\(written\)\n {3}restart the gateway: kiro-claude crew stop && kiro-claude crew start/);
      fs.rmSync(path.join(fe.root, 'KiroCrew', 'src', 'kiro_crew', 'static', 'dist'), { recursive: true });
      r = await crew(fe, ['setup', '--allow-tmp']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /❌ build: the Kiro Crew gateway is running; stop it first: kiro-claude crew stop/);
      assert.equal((await crew(fe, ['stop'])).code, 0);
    } finally {
      fe.cleanup();
    }
  });

  it('commands before setup explain what to do', async () => {
    const fe = makeFakeEnv();
    try {
      for (const sub of ['start', 'stop', 'open', 'exec']) {
        const r = await crew(fe, sub === 'exec' ? ['exec', '--', 'doctor'] : [sub]);
        assert.equal(r.code, 1, sub);
        assert.match(r.stderr, /Kiro Crew is not set up yet\. Run: kiro-claude crew setup/, sub);
      }
      const s = await crew(fe, ['status']);
      assert.equal(s.code, 3);
      const sj = await crew(fe, ['status', '--json']);
      assert.deepEqual(JSON.parse(sj.stdout), { running: false, ready: false, holder: 'nobody', reason: 'not set up' });
    } finally {
      fe.cleanup();
    }
  });

  it('usage errors exit 2', async () => {
    const fe = makeFakeEnv();
    try {
      for (const args of [
        ['start', '--port', '0'],
        ['start', '--port', 'x'],
        ['start', '--env', 'NOEQUALS'],
        ['start', '--approval', 'maybe'],
        ['start', '--kiro-bin', 'relative/kiro-claude'],
        ['stop', '--timeout', 'soon'],
        ['logs', '-n', 'many'],
        ['status', '--bogus'],
        ['exec'],
        ['exec', '--env', 'BAD', '--', 'doctor'],
      ]) {
        const r = await crew(fe, args);
        assert.equal(r.code, 2, args.join(' '));
        assert.match(r.stderr, /^error: /, args.join(' '));
      }
    } finally {
      fe.cleanup();
    }
  });
});

// W1: KiroCrew answers `gateway-pid` with {"holder":"held"} when a gateway holds the lock but
// nothing names it. run/ready.json's pid is then the only lead, and that file outlives its gateway
// (a crash, a reboot, a gateway started some other way) while its pid gets reused. Nothing may
// be signalled, or reported as the gateway, on the word of a stale file.
describe('crew stop / status with a held lock: run/ready.json pid identity (W1)', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  const linux = process.platform !== 'linux' ? 'needs /proc' : false;
  const readyFile = (fe: FakeEnv): string => path.join(fe.cs, 'run', 'ready.json');
  const holdLock = (fe: FakeEnv): void => fs.writeFileSync(path.join(kcHome(fe), 'fake-held'), '');
  const releaseName = (fe: FakeEnv): void => fs.rmSync(path.join(kcHome(fe), 'fake-held'), { force: true });
  const shimOf = (fe: FakeEnv): string => path.join(fe.cs, 'bin', 'kiro-claude');

  async function startGateway(fe: FakeEnv, port?: number): Promise<{ pid: number; start?: number; port: number }> {
    const p = port ?? (await freePort());
    const r = await crew(fe, ['start', '--port', String(p)]);
    assert.equal(r.code, 0, r.stderr);
    const pid = gatewayPid(fe)!;
    return { pid, start: procStart(pid), port: p };
  }

  /** The record a crashed earlier gateway left, whose pid `u` took since (`kind` of identity). */
  function staleRecord(fe: FakeEnv, u: { pid: number; start?: number }, port: number, kind: 'none' | 'start' | 'boot'): void {
    const id =
      kind === 'none' ? {} : kind === 'start' ? { kiroClaude: { pid: u.pid, startTime: (u.start ?? 0) + 7, bootId: bootId() } } : { kiroClaude: { pid: u.pid, startTime: u.start, bootId: '00000000-0000-4000-8000-000000000000' } };
    fs.writeFileSync(readyFile(fe), JSON.stringify({ port, token: 'stale-token', pid: u.pid, home: kcHome(fe), ...id }), { mode: 0o600 });
  }

  const staleCases = [
    { name: 'an older record (no identity) whose pid is now a process of another HOME', kind: 'none', sameEnv: false },
    { name: 'an older record (no identity) whose pid is now a non-gateway process of this crew env', kind: 'none', sameEnv: true },
    { name: 'a record whose pid now has another start time', kind: 'start', sameEnv: true },
    { name: 'a record of an earlier boot (same pid and start time)', kind: 'boot', sameEnv: true },
  ] as const;
  for (const sc of staleCases) {
    it(`stop, held: ${sc.name} → nothing is signalled; the gateway that ignores the stop is reported as not stopped`, { skip: linux }, async () => {
      const fe = await setUp({ FAKE_STOP_IGNORE: '1' });
      let u: Awaited<ReturnType<typeof bystander>> | undefined;
      try {
        const g = await startGateway(fe);
        holdLock(fe);
        u = await bystander(fe, sc.sameEnv ? { HOME: fe.home, KIROCREW_KIRO_BIN: shimOf(fe) } : { HOME: path.join(fe.root, 'other-home') });
        staleRecord(fe, u, g.port, sc.kind);
        const r = await crew(fe, ['stop', '--timeout', '1']);
        assert.equal(u.terms(), 0, `crew stop sent SIGTERM to pid ${u.pid}, which only a stale run/ready.json named`);
        assert.equal(stillRuns(u.pid, u.start), true, `crew stop killed pid ${u.pid}, which only a stale run/ready.json named`);
        assert.equal(stillRuns(g.pid, g.start), true, 'the held gateway (no pid known) was not signalled either');
        assert.equal(r.code, 1, `a held gateway that did not exit is not reported as stopped: ${r.stdout}`);
        assert.equal(r.stdout, '');
        assert.match(r.stderr, new RegExp(`the Kiro Crew gateway did not exit\\. Nothing names its pid \\(kirocrew gateway-pid: held; run/ready\\.json named pid ${u.pid}, which is no longer that gateway\\), so nothing was signalled\\.`));
      } finally {
        u?.stop();
        fe.cleanup();
      }
    });
  }

  it('stop, held: a stale record, and kirocrew stop does stop the gateway → "Stopped (pid unknown)", the stale pid untouched', { skip: linux }, async () => {
    const fe = await setUp();
    let u: Awaited<ReturnType<typeof bystander>> | undefined;
    try {
      const g = await startGateway(fe);
      holdLock(fe);
      u = await bystander(fe, { HOME: path.join(fe.root, 'other-home') });
      staleRecord(fe, u, g.port, 'none');
      const r = await crew(fe, ['stop', '--timeout', '5']);
      assert.equal(u.terms(), 0, `crew stop sent SIGTERM to pid ${u.pid}`);
      assert.equal(stillRuns(u.pid, u.start), true);
      assert.deepEqual({ code: r.code, stderr: r.stderr, stdout: r.stdout }, { code: 0, stderr: '', stdout: 'Stopped (pid unknown); 0 orphan agent process(es) reaped\n' });
      assert.equal(stillRuns(g.pid, g.start), false);
      assert.equal(fs.existsSync(readyFile(fe)), false);
    } finally {
      u?.stop();
      fe.cleanup();
    }
  });

  it('stop, held: when gateway-pid names the holder while stop waits, that pid gets the SIGTERM fallback (not the stale one)', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_STOP_IGNORE: '1' });
    let u: Awaited<ReturnType<typeof bystander>> | undefined;
    try {
      const g = await startGateway(fe);
      holdLock(fe);
      u = await bystander(fe, { HOME: path.join(fe.root, 'other-home') });
      staleRecord(fe, u, g.port, 'none');
      const p = crew(fe, ['stop', '--timeout', '3']);
      await new Promise((res) => setTimeout(res, 500));
      releaseName(fe); // KiroCrew can name the holder now
      const r = await p;
      assert.equal(u.terms(), 0, `crew stop sent SIGTERM to pid ${u.pid}`);
      assert.equal(stillRuns(g.pid, g.start), false, 'the named gateway was stopped');
      assert.deepEqual({ code: r.code, stderr: r.stderr, stdout: r.stdout }, { code: 0, stderr: '', stdout: `Stopped (pid ${g.pid}); 0 orphan agent process(es) reaped\n` });
    } finally {
      u?.stop();
      fe.cleanup();
    }
  });

  for (const rec of ['as crew start wrote it', 'of an older kiro-claude (no identity)'] as const) {
    it(`stop, held: a record ${rec} that still names the gateway → its pid gets the SIGTERM/SIGKILL fallback`, { skip: linux }, async () => {
      const fe = await setUp({ FAKE_STOP_IGNORE: '1', FAKE_GATEWAY_MODE: 'ignore-term' });
      try {
        const g = await startGateway(fe);
        holdLock(fe);
        if (rec !== 'as crew start wrote it') {
          const j = JSON.parse(fs.readFileSync(readyFile(fe), 'utf8')) as Record<string, unknown>;
          delete j.kiroClaude;
          fs.writeFileSync(readyFile(fe), JSON.stringify(j), { mode: 0o600 });
        }
        const r = await crew(fe, ['stop', '--timeout', '1']);
        assert.deepEqual({ code: r.code, stderr: r.stderr, stdout: r.stdout }, { code: 0, stderr: '', stdout: `Stopped (pid ${g.pid}); 0 orphan agent process(es) reaped\n` });
        assert.equal(defaultSys.isAlive(g.pid), false);
      } finally {
        fe.cleanup();
      }
    });
  }

  it('status, held: a stale record → the pid is not reported and its port is not used (crew.json\'s is)', { skip: linux }, async () => {
    const fe = await setUp();
    let u: Awaited<ReturnType<typeof bystander>> | undefined;
    try {
      const g = await startGateway(fe);
      const stateFile = path.join(fe.cs, 'crew.json');
      writeState(stateFile, { ...readState(stateFile)!, port: g.port });
      holdLock(fe);
      u = await bystander(fe, { HOME: path.join(fe.root, 'other-home') });
      staleRecord(fe, u, 1, 'none');
      let r = await crew(fe, ['status', '--json']);
      const j = JSON.parse(r.stdout) as { running: boolean; ready: boolean; holder: string; pid?: number; port: number; reason?: string };
      assert.deepEqual({ running: j.running, holder: j.holder, pid: j.pid, port: j.port }, { running: true, holder: 'held', pid: undefined, port: g.port }, `pid ${u.pid} of a stale run/ready.json reported as the gateway`);
      assert.equal(j.ready, true, j.reason);
      assert.equal(r.code, 0);
      r = await crew(fe, ['status']);
      assert.match(r.stdout, new RegExp(`^Kiro Crew gateway: running \\(pid unknown, port ${g.port}\\)\\n`));
      // the record crew start writes is believed again: its pid is reported
      releaseName(fe);
      fs.rmSync(readyFile(fe));
      assert.equal((await crew(fe, ['stop'])).code, 0);
      const g2 = await startGateway(fe, g.port);
      holdLock(fe);
      r = await crew(fe, ['status', '--json']);
      assert.deepEqual((({ holder, pid, port }) => ({ holder, pid, port }))(JSON.parse(r.stdout) as { holder: string; pid?: number; port: number }), { holder: 'held', pid: g2.pid, port: g.port });
      releaseName(fe);
    } finally {
      u?.stop();
      fe.cleanup();
    }
  });

  it('status, held: a record this process cannot check (no /proc) → pid unknown, its port still used', async () => {
    const fe = await setUp();
    try {
      const g = await startGateway(fe);
      holdLock(fe);
      const blind = { ...defaultSys, startTime: () => undefined, listProcesses: () => [], bootId: () => undefined } as CrewSys;
      const r = await crew(fe, ['status', '--json'], { deps: { sys: blind } });
      const j = JSON.parse(r.stdout) as { holder: string; pid?: number; port: number; ready: boolean };
      assert.deepEqual({ holder: j.holder, pid: j.pid, port: j.port, ready: j.ready }, { holder: 'held', pid: undefined, port: g.port, ready: true });
      releaseName(fe);
    } finally {
      fe.cleanup();
    }
  });

  it('status / open / doctor: a record naming another pid than the holder gateway-pid names → its port is not used (crew.json\'s is)', { skip: linux }, async () => {
    const fe = await setUp();
    let u: Awaited<ReturnType<typeof bystander>> | undefined;
    try {
      const g = await startGateway(fe);
      const stateFile = path.join(fe.cs, 'crew.json');
      writeState(stateFile, { ...readState(stateFile)!, port: g.port });
      u = await bystander(fe, { HOME: path.join(fe.root, 'other-home') });
      staleRecord(fe, u, 1, 'none');
      let r = await crew(fe, ['status', '--json']);
      const j = JSON.parse(r.stdout) as { holder: string; pid?: number; port: number; ready: boolean; reason?: string };
      assert.deepEqual({ holder: j.holder, pid: j.pid, port: j.port }, { holder: 'process', pid: g.pid, port: g.port });
      assert.equal(j.ready, true, j.reason);
      r = await crew(fe, ['open', '--print']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^http://localhost:${g.port}\\?token=`));
      const d = JSON.parse((await crew(fe, ['doctor', '--json'])).stdout) as { rows: Array<{ id: string; status: string; detail: string }> };
      const d11 = d.rows.find((x) => x.id === 'D11')!;
      assert.equal(d11.status, 'ok', d11.detail);
      assert.equal(u.terms(), 0);
      assert.equal((await crew(fe, ['stop'])).code, 0);
      assert.equal(stillRuns(u.pid, u.start), true);
    } finally {
      u?.stop();
      fe.cleanup();
    }
  });

  /** The real runner, except that once `kirocrew stop` returned, `gateway-pid` names `named()` (when set). */
  function namingRunner(onStop: () => Promise<void>, named: () => number | undefined): CrewRunner {
    return {
      ...defaultRunner,
      async run(file, args, opts) {
        const n = args[0] === 'gateway-pid' ? named() : undefined;
        if (n !== undefined) return { code: 0, signal: null, stdout: `${JSON.stringify({ holder: 'process', pid: n, alive: true, source: 'lock' })}\n`, stderr: '', timedOut: false, durationMs: 1 };
        const r = await defaultRunner.run(file, args, opts);
        if (args[0] === 'stop') await onStop();
        return r;
      },
    };
  }

  it('stop, held: a holder gateway-pid names only after the stop, started after it (a supervisor restarting the gateway), is not signalled; the held gateway is gone', { skip: linux }, async () => {
    const fe = await setUp();
    let u: Awaited<ReturnType<typeof bystander>> | undefined;
    let g2: Awaited<ReturnType<typeof bystander>> | undefined;
    try {
      const g = await startGateway(fe);
      holdLock(fe);
      u = await bystander(fe, { HOME: path.join(fe.root, 'other-home') });
      staleRecord(fe, u, g.port, 'none');
      const runner = namingRunner(
        async () => {
          // kirocrew stop stopped G; a new gateway G2 of this crew takes the lock at once
          for (let i = 0; i < 100 && stillRuns(g.pid, g.start); i++) await new Promise((res) => setTimeout(res, 20));
          g2 = await bystander(fe, { HOME: fe.home, KIROCREW_KIRO_BIN: shimOf(fe) });
        },
        () => g2?.pid,
      );
      const r = await crew(fe, ['stop', '--timeout', '2'], { deps: { runner } });
      assert.ok(g2, 'the restarted gateway ran');
      assert.equal(g2.terms(), 0, `crew stop sent SIGTERM to pid ${g2.pid}, a gateway started after the stop`);
      assert.equal(stillRuns(g2.pid, g2.start), true, `crew stop killed pid ${g2.pid}, a gateway started after the stop`);
      assert.equal(u.terms(), 0);
      assert.equal(stillRuns(g.pid, g.start), false);
      assert.deepEqual({ code: r.code, stderr: r.stderr, stdout: r.stdout }, { code: 0, stderr: '', stdout: 'Stopped (pid unknown); 0 orphan agent process(es) reaped\n' });
    } finally {
      u?.stop();
      g2?.stop();
      fe.cleanup();
    }
  });

  it('stop, held: a holder gateway-pid names after the stop that this process cannot tell from a later one (no /proc) is not signalled; exit 1 says so', async () => {
    const fe = await setUp({ FAKE_STOP_IGNORE: '1' });
    try {
      const g = await startGateway(fe);
      holdLock(fe);
      let stopped = false;
      const runner = namingRunner(
        async () => {
          stopped = true;
        },
        () => (stopped ? g.pid : undefined),
      );
      const signals: Array<[number, string]> = [];
      const blind = { ...defaultSys, startTime: () => undefined, listProcesses: () => [], bootId: () => undefined, kill: (pid: number, s: NodeJS.Signals) => (signals.push([pid, s]), false) } as CrewSys;
      const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { runner, sys: blind } });
      assert.deepEqual(signals, [], 'a pid named only after the stop, unverifiable, was signalled');
      assert.equal(defaultSys.isAlive(g.pid), true);
      assert.equal(r.code, 1, r.stdout);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, new RegExp(`the Kiro Crew gateway did not exit\\. kirocrew gateway-pid named pid ${g.pid} only after the stop`));
      assert.match(r.stderr, /nothing was signalled/);
    } finally {
      fe.cleanup();
    }
  });

  it('stop, held: a proven record → the gateway tree is retired as for a named holder (a stubborn child does not outlive the stop)', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn' });
    let child: number | undefined;
    let childStart: number | undefined;
    try {
      const g = await startGateway(fe);
      child = (JSON.parse(fs.readFileSync(path.join(kcHome(fe), 'fake-gateway-child.json'), 'utf8')) as { pid: number }).pid;
      childStart = procStart(child);
      holdLock(fe);
      const r = await crew(fe, ['stop']);
      assert.deepEqual({ code: r.code, stderr: r.stderr, stdout: r.stdout }, { code: 0, stderr: '', stdout: `Stopped (pid ${g.pid}); 0 orphan agent process(es) reaped\n` });
      assert.equal(stillRuns(child, childStart), false, 'the stubborn gateway child outlived crew stop');
    } finally {
      if (child !== undefined && stillRuns(child, childStart)) process.kill(child, 'SIGKILL');
      fe.cleanup();
    }
  });

  // K7: the gateway crashed while a child it started keeps the gateway lock it inherited (KiroCrew's
  // flock lives on in a forked child). gateway-pid then names no holder: `held`, or `indeterminate`
  // (KiroCrew's answer on Linux, where /proc/locks names the dead acquirer), and ready.json's pid is
  // dead. What the gateway left in its process group is this crew's and is retired; nothing else is.
  type Crashed = { g: { pid: number; start?: number }; child: { pid: number; start?: number } };
  async function crashGateway(fe: FakeEnv, answer: 'held' | 'indeterminate'): Promise<Crashed> {
    const g = await startGateway(fe);
    const child = JSON.parse(fs.readFileSync(path.join(kcHome(fe), 'fake-gateway-child.json'), 'utf8')) as { pid: number; start?: number };
    assert.equal(stillRuns(child.pid, child.start), true, 'the gateway child runs');
    if (answer === 'held') holdLock(fe);
    assert.equal(stillRuns(g.pid, g.start), true);
    process.kill(g.pid, 'SIGKILL'); // the crash
    await waitDead(g.pid);
    assert.equal(defaultSys.isAlive(g.pid), false, 'the gateway is gone');
    const h = await crew(fe, ['exec', 'gateway-pid']);
    assert.equal((JSON.parse(h.stdout) as { holder: string }).holder, answer, h.stdout);
    return { g, child };
  }

  /** The real CrewSys, recording every signal; `extra` processes are listed (until SIGKILLed) and their signals never sent. */
  function recordingSys(extra: Proc[] = [], o: { aliveAlso?: number; unkillable?: boolean; dyingMs?: number } = {}) {
    const signals: Array<{ pid: number; signal: string }> = [];
    const fake = new Map(extra.map((p) => [p.pid, p]));
    const sys = {
      ...defaultSys,
      isAlive: (pid: number) => (fake.has(pid) ? true : pid === o.aliveAlso ? true : defaultSys.isAlive(pid)),
      startTime: (pid: number) => (fake.has(pid) ? fake.get(pid)!.startTime : pid === o.aliveAlso ? undefined : defaultSys.startTime(pid)),
      kill: (pid: number, signal: NodeJS.Signals, start: number | undefined) => {
        signals.push({ pid, signal });
        if (fake.has(pid)) {
          // unkillable: in D state for good; dyingMs: still listed that long after the SIGKILL (a loaded machine)
          if (signal === 'SIGKILL' && !o.unkillable) {
            if (o.dyingMs) setTimeout(() => fake.delete(pid), o.dyingMs);
            else fake.delete(pid);
          }
          return true;
        }
        return defaultSys.kill(pid, signal, start);
      },
      listProcesses: () => [...defaultSys.listProcesses(), ...fake.values()],
    } as CrewSys;
    return { sys, signals };
  }

  for (const answer of ['held', 'indeterminate'] as const) {
    it(`stop after a crash (gateway-pid: ${answer}): the stubborn child that keeps the gateway lock is retired, and the stop says the gateway had already exited`, { skip: linux }, async () => {
      const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn', FAKE_LOCK_INHERIT: '1' });
      let k: Crashed | undefined;
      try {
        k = await crashGateway(fe, answer);
        const r = await crew(fe, ['stop', '--timeout', '3']);
        assert.equal(stillRuns(k.child.pid, k.child.start), false, `the crashed gateway's stubborn child, which keeps its lock, outlived crew stop: ${JSON.stringify(r)}`);
        assert.deepEqual(
          { code: r.code, stderr: r.stderr, stdout: r.stdout },
          { code: 0, stderr: '', stdout: `Stopped (pid ${k.g.pid}, which had already exited; 1 leftover process(es) of its process group retired); 0 orphan agent process(es) reaped\n` },
        );
        const h = await crew(fe, ['exec', 'gateway-pid']);
        assert.equal((JSON.parse(h.stdout) as { holder: string }).holder, 'nobody', 'the lock is free again');
        assert.equal(fs.existsSync(readyFile(fe)), false, 'the dead gateway\'s token is removed');
      } finally {
        if (k && stillRuns(k.child.pid, k.child.start)) process.kill(k.child.pid, 'SIGKILL');
        fe.cleanup();
      }
    });
  }

  it('stop after a crash: members of its process group that are not this crew\'s (another HOME or KIROCREW_KIRO_BIN) or older than the gateway are not signalled', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn', FAKE_LOCK_INHERIT: '1' });
    let k: Crashed | undefined;
    try {
      k = await crashGateway(fe, 'held');
      const other = path.join(fe.root, 'other-home');
      const mine = { HOME: fe.home, KIROCREW_KIRO_BIN: shimOf(fe), KIROCREW_SPAWNED: '1' };
      const base = (pid: number, env: Record<string, string>, startTime: number): Proc => ({ pid, ppid: 1, pgid: k!.g.pid, argv: ['/usr/bin/sleep', '30'], startTime, env });
      const gs = k.g.start ?? 0;
      const fakes = [
        base(2 ** 22 + 301, { ...mine, HOME: other }, gs + 1), // another HOME
        base(2 ** 22 + 302, { ...mine, KIROCREW_KIRO_BIN: path.join(other, 'kiro-claude') }, gs + 1), // another crew's kiro-cli
        base(2 ** 22 + 303, mine, gs - 1), // started before the gateway: not one it left
      ];
      const { sys, signals } = recordingSys(fakes);
      const r = await crew(fe, ['stop', '--timeout', '3'], { deps: { sys } });
      assert.deepEqual(signals, [
        { pid: k.child.pid, signal: 'SIGTERM' },
        { pid: k.child.pid, signal: 'SIGKILL' },
      ], 'only the gateway\'s own leftover child was signalled');
      assert.equal(stillRuns(k.child.pid, k.child.start), false);
      assert.deepEqual({ code: r.code, stderr: r.stderr }, { code: 0, stderr: '' });
      assert.match(r.stdout, /, which had already exited; 1 leftover process\(es\) of its process group retired\); 0 orphan/);
    } finally {
      if (k && stillRuns(k.child.pid, k.child.start)) process.kill(k.child.pid, 'SIGKILL');
      fe.cleanup();
    }
  });

  it('stop after a crash, held: a lock still held once the leftovers are retired → exit 1 says what was retired and that nothing else was signalled', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn', FAKE_LOCK_INHERIT: '1' });
    let k: Crashed | undefined;
    try {
      k = await crashGateway(fe, 'held');
      // something else (that nothing names) keeps holding the lock
      const runner: CrewRunner = {
        ...defaultRunner,
        async run(file, args, opts) {
          if (args[0] === 'gateway-pid') return { code: 0, signal: null, stdout: '{"holder":"held","reason":"x"}\n', stderr: '', timedOut: false, durationMs: 1 };
          return defaultRunner.run(file, args, opts);
        },
      };
      const { sys, signals } = recordingSys();
      const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { runner, sys } });
      assert.equal(stillRuns(k.child.pid, k.child.start), false);
      assert.deepEqual(signals.map((x) => x.pid), [k.child.pid, k.child.pid], 'only the leftover child was signalled');
      assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 1, stdout: '' });
      assert.equal(
        r.stderr,
        `kiro-claude: the Kiro Crew gateway lock is still held (kirocrew gateway-pid: held). run/ready.json named pid ${k.g.pid}, which had already exited: 1 leftover process(es) of its process group retired. Nothing else names a holder, so nothing else was signalled.\n`,
      );
    } finally {
      if (k && stillRuns(k.child.pid, k.child.start)) process.kill(k.child.pid, 'SIGKILL');
      fe.cleanup();
    }
  });

  // Verifier (K7, report the result truthfully): what the stop signalled is all said.
  /** `gateway-pid` answers `answers[i]` on its i-th call (the last one from then on); every other kirocrew verb runs. */
  function scriptedGatewayPid(answers: ReadonlyArray<{ code: number; json: object }>): { runner: CrewRunner; calls: () => number } {
    let n = 0;
    const runner: CrewRunner = {
      ...defaultRunner,
      async run(file, args, opts) {
        if (args[0] !== 'gateway-pid') return defaultRunner.run(file, args, opts);
        const a = answers[Math.min(n++, answers.length - 1)]!;
        return { code: a.code, signal: null, stdout: `${JSON.stringify(a.json)}\n`, stderr: '', timedOut: false, durationMs: 1 };
      },
    };
    return { runner, calls: () => n };
  }
  /** A `kiro-claude acp` agent of this HOME (its own session, as KiroCrew starts them): an orphan crew stop reaps. */
  const orphanAgent = (fe: FakeEnv, pid: number, startTime: number): Proc => ({
    pid,
    ppid: 1,
    pgid: pid,
    argv: [process.execPath, '/x/dist/src/bin/kiro-claude.js', 'acp'],
    startTime,
    env: { HOME: fe.home, KIROCREW_SPAWNED: '1', KIROCREW_KIRO_BIN: shimOf(fe) },
  });
  const LOCK_REASON = 'could not determine whether a gateway holds the lock at /x/gateway.lock: the lock is held but its recorded acquirer (pid 1) is gone';

  it('stop after a crash (indeterminate): a lock that is still not free once the leftovers are retired → exit 1 says so, and what was signalled', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn', FAKE_LOCK_INHERIT: '1' });
    let k: Crashed | undefined;
    try {
      k = await crashGateway(fe, 'indeterminate');
      // the lock lives on in a holder outside the gateway's process group (a child that setsid()-ed
      // before it closed the inherited fd): KiroCrew keeps answering indeterminate
      const { runner, calls } = scriptedGatewayPid([{ code: 2, json: { holder: 'indeterminate', reason: LOCK_REASON } }]);
      const orphan = orphanAgent(fe, 2 ** 22 + 401, (k.g.start ?? 0) + 5);
      const { sys, signals } = recordingSys([orphan]);
      const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { runner, sys } });
      assert.equal(stillRuns(k.child.pid, k.child.start), false);
      assert.deepEqual(signals, [
        { pid: k.child.pid, signal: 'SIGTERM' },
        { pid: k.child.pid, signal: 'SIGKILL' },
        { pid: orphan.pid, signal: 'SIGTERM' },
      ]);
      assert.equal(calls(), 2, 'the lock is probed again after the retire');
      assert.deepEqual(
        { code: r.code, stdout: r.stdout, stderr: r.stderr },
        {
          code: 1,
          stdout: '',
          stderr: `kiro-claude: the Kiro Crew gateway lock may still be held (kirocrew gateway-pid: indeterminate: ${LOCK_REASON}). run/ready.json named pid ${k.g.pid}, which had already exited: 1 leftover process(es) of its process group retired; 1 orphan agent process(es) reaped. Nothing else names a holder, so nothing else was signalled.\n`,
        },
      );
    } finally {
      if (k && stillRuns(k.child.pid, k.child.start)) process.kill(k.child.pid, 'SIGKILL');
      fe.cleanup();
    }
  });

  it('stop after a crash, held: the still-held report also names the orphan agents it reaped (it says nothing else was signalled)', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn', FAKE_LOCK_INHERIT: '1' });
    let k: Crashed | undefined;
    try {
      k = await crashGateway(fe, 'held');
      const { runner } = scriptedGatewayPid([{ code: 0, json: { holder: 'held', reason: 'x' } }]);
      const orphan = orphanAgent(fe, 2 ** 22 + 402, (k.g.start ?? 0) + 5);
      const { sys, signals } = recordingSys([orphan]);
      const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { runner, sys } });
      assert.deepEqual(signals.map((x) => x.pid), [k.child.pid, k.child.pid, orphan.pid]);
      assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 1, stdout: '' });
      assert.equal(
        r.stderr,
        `kiro-claude: the Kiro Crew gateway lock is still held (kirocrew gateway-pid: held). run/ready.json named pid ${k.g.pid}, which had already exited: 1 leftover process(es) of its process group retired; 1 orphan agent process(es) reaped. Nothing else names a holder, so nothing else was signalled.\n`,
      );
    } finally {
      if (k && stillRuns(k.child.pid, k.child.start)) process.kill(k.child.pid, 'SIGKILL');
      fe.cleanup();
    }
  });

  it('stop after a crash, held: a holder named only after the retire that crew stop cannot place → the report does not claim that nothing was signalled', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn', FAKE_LOCK_INHERIT: '1' });
    let k: Crashed | undefined;
    try {
      k = await crashGateway(fe, 'held');
      const P = 2 ** 22 + 403; // named by gateway-pid; its start time cannot be read (another user's)
      const { runner } = scriptedGatewayPid([
        { code: 0, json: { holder: 'held', reason: 'x' } },
        { code: 0, json: { holder: 'process', pid: P, alive: true, source: 'flock_owner' } },
      ]);
      const { sys, signals } = recordingSys([], { aliveAlso: P });
      const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { runner, sys } });
      assert.deepEqual(signals.map((x) => x.pid), [k.child.pid, k.child.pid], 'only the leftover child was signalled');
      assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 1, stdout: '' });
      assert.equal(
        r.stderr,
        `kiro-claude: the Kiro Crew gateway did not exit. kirocrew gateway-pid named pid ${P} only after the stop, and crew stop cannot tell it from a gateway started since, so it was not signalled (run/ready.json named pid ${k.g.pid}, which had already exited: 1 leftover process(es) of its process group retired). To stop it, run: kiro-claude crew stop\n`,
      );
    } finally {
      if (k && stillRuns(k.child.pid, k.child.start)) process.kill(k.child.pid, 'SIGKILL');
      fe.cleanup();
    }
  });

  it('stop, held: a stale record and orphan agents reaped → the report does not claim that nothing was signalled', { skip: linux }, async () => {
    const fe = await setUp();
    try {
      const g = await startGateway(fe);
      process.kill(g.pid, 'SIGKILL'); // gone, with nothing left in its group
      await waitDead(g.pid);
      const { runner } = scriptedGatewayPid([{ code: 0, json: { holder: 'held', reason: 'x' } }]);
      const orphan = orphanAgent(fe, 2 ** 22 + 405, (g.start ?? 0) + 5);
      const { sys, signals } = recordingSys([orphan]);
      const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { runner, sys } });
      assert.deepEqual(signals, [{ pid: orphan.pid, signal: 'SIGTERM' }]);
      assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 1, stdout: '' });
      assert.equal(
        r.stderr,
        `kiro-claude: the Kiro Crew gateway did not exit. Nothing names its pid (kirocrew gateway-pid: held; run/ready.json named pid ${g.pid}, which is no longer that gateway), so it was not signalled (1 orphan agent process(es) reaped).\n`,
      );
    } finally {
      fe.cleanup();
    }
  });

  it('stop: "Stopped" only once the gateway\'s SIGKILLed leftovers are gone (a process does not vanish the moment it is sent SIGKILL)', { skip: linux }, async () => {
    const fe = await setUp();
    try {
      const g = await startGateway(fe);
      // the gateway's own child (its tree and group), ignoring SIGTERM, still listed 300 ms after SIGKILL
      const slow: Proc = { pid: 2 ** 22 + 407, ppid: g.pid, pgid: g.pid, argv: ['/usr/bin/sleep', '30'], startTime: (g.start ?? 0) + 3, env: { HOME: fe.home, KIROCREW_KIRO_BIN: shimOf(fe) } };
      const { sys, signals } = recordingSys([slow], { dyingMs: 300 });
      const r = await crew(fe, ['stop', '--timeout', '5'], { deps: { sys } });
      const listed = sys.listProcesses().some((p) => p.pid === slow.pid);
      assert.deepEqual(signals.filter((x) => x.pid === slow.pid), [
        { pid: slow.pid, signal: 'SIGTERM' },
        { pid: slow.pid, signal: 'SIGKILL' },
      ]);
      assert.equal(listed, false, 'crew stop reported the stop while a leftover it had SIGKILLed was still running');
      assert.deepEqual({ code: r.code, stderr: r.stderr, stdout: r.stdout }, { code: 0, stderr: '', stdout: `Stopped (pid ${g.pid}); 0 orphan agent process(es) reaped\n` });
    } finally {
      fe.cleanup();
    }
  });

  it('stop after a crash: a leftover that outlives SIGKILL → exit 1 names it', { skip: linux }, async () => {
    const fe = await setUp();
    try {
      const g = await startGateway(fe);
      process.kill(g.pid, 'SIGKILL'); // the crash
      await waitDead(g.pid);
      const stuck: Proc = { pid: 2 ** 22 + 406, ppid: 1, pgid: g.pid, argv: ['/usr/bin/sleep', '30'], startTime: (g.start ?? 0) + 3, env: { HOME: fe.home, KIROCREW_KIRO_BIN: shimOf(fe) } };
      const { sys, signals } = recordingSys([stuck], { unkillable: true });
      const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys } });
      assert.deepEqual(signals, [
        { pid: stuck.pid, signal: 'SIGTERM' },
        { pid: stuck.pid, signal: 'SIGKILL' },
      ]);
      assert.deepEqual(
        { code: r.code, stdout: r.stdout, stderr: r.stderr },
        { code: 1, stdout: '', stderr: `kiro-claude: Stopped (pid ${g.pid}, which had already exited; 1 leftover process(es) of its process group retired, 1 of them still running after SIGKILL (pid ${stuck.pid})); 0 orphan agent process(es) reaped\n` },
      );
    } finally {
      fe.cleanup();
    }
  });

  it('stop after a crash: a pid the gateway had that a visible unrelated process took since (leading group <pid>, with a member of this crew env) → nothing is signalled', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn', FAKE_LOCK_INHERIT: '1' });
    let k: Crashed | undefined;
    try {
      k = await crashGateway(fe, 'indeterminate');
      const gs = k.g.start ?? 0;
      // U took pid g and leads group g; W (this crew's HOME and KIROCREW_KIRO_BIN, started after the gateway) is in it
      const U: Proc = { pid: k.g.pid, ppid: 1, pgid: k.g.pid, argv: ['/usr/bin/sleep', '30'], startTime: gs + 50, env: { HOME: path.join(fe.root, 'other-home') } };
      const W: Proc = { pid: 2 ** 22 + 404, ppid: k.g.pid, pgid: k.g.pid, argv: ['/usr/bin/sleep', '30'], startTime: gs + 51, env: { HOME: fe.home, KIROCREW_KIRO_BIN: shimOf(fe) } };
      const { sys, signals } = recordingSys([U, W]);
      const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys } });
      assert.deepEqual(signals, [], 'crew stop signalled a member of a group whose leader took the crashed gateway\'s pid');
      assert.equal(stillRuns(k.child.pid, k.child.start), true);
      assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 0, stdout: 'Kiro Crew gateway is not running.\n' });
    } finally {
      if (k && stillRuns(k.child.pid, k.child.start)) process.kill(k.child.pid, 'SIGKILL');
      fe.cleanup();
    }
  });

  const unprovable = [
    { name: 'a record of an older kiro-claude (no process group)', answer: 'held', edit: (id: Record<string, unknown>) => void delete id.pgid },
    { name: 'a record of an earlier boot', answer: 'held', edit: (id: Record<string, unknown>) => void (id.bootId = '00000000-0000-4000-8000-000000000000') },
    { name: 'a record of a gateway that started after the child', answer: 'indeterminate', edit: (id: Record<string, unknown>) => void (id.startTime = (id.startTime as number) + 10_000_000) },
    { name: 'a crashed gateway whose pid another user\'s hidden process took (signal 0: EPERM)', answer: 'indeterminate', hidden: true },
  ] as const;
  for (const u of unprovable) {
    it(`stop after a crash, ${u.name} → nothing is signalled, and the stop is reported as before`, { skip: linux }, async () => {
      const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn', FAKE_LOCK_INHERIT: '1' });
      let k: Crashed | undefined;
      try {
        k = await crashGateway(fe, u.answer);
        if ('edit' in u) {
          const j = JSON.parse(fs.readFileSync(readyFile(fe), 'utf8')) as { kiroClaude: Record<string, unknown> };
          assert.equal(j.kiroClaude.pgid, k.g.pid, 'crew start recorded that the gateway led its process group');
          u.edit(j.kiroClaude);
          fs.writeFileSync(readyFile(fe), JSON.stringify(j), { mode: 0o600 });
        }
        const { sys, signals } = recordingSys([], { aliveAlso: 'hidden' in u ? k.g.pid : undefined });
        const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys } });
        assert.deepEqual(signals, [], 'crew stop signalled a process it could not prove the crashed gateway\'s');
        assert.equal(stillRuns(k.child.pid, k.child.start), true);
        if (u.answer === 'held') {
          assert.equal(r.code, 1, r.stdout);
          assert.match(r.stderr, new RegExp(`Nothing names its pid \\(kirocrew gateway-pid: held; run/ready\\.json named pid ${k.g.pid}, which is no longer that gateway\\), so nothing was signalled\\.`));
        } else {
          assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 0, stdout: 'Kiro Crew gateway is not running.\n' });
        }
      } finally {
        if (k && stillRuns(k.child.pid, k.child.start)) process.kill(k.child.pid, 'SIGKILL');
        fe.cleanup();
      }
    });
  }

  // K8: the fake KiroCrew records its gateway's pid with its start time; a file left by a gateway
  // that crashed names a pid that may be another process's by now, and nothing acts on it.
  it("K8: a crashed gateway's fake-gateway.json whose pid another process took → gateway-pid names nobody; kirocrew stop and crew stop signal nothing", { skip: linux }, async () => {
    const fe = await setUp();
    let u: Awaited<ReturnType<typeof bystander>> | undefined;
    try {
      const g = await startGateway(fe);
      const file = path.join(kcHome(fe), 'fake-gateway.json');
      const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; start?: number; port: number };
      assert.equal(stillRuns(g.pid, g.start), true);
      process.kill(g.pid, 'SIGKILL'); // a crash: the file stays
      await waitDead(g.pid);
      u = await bystander(fe, { HOME: path.join(fe.root, 'other-home') });
      fs.writeFileSync(file, JSON.stringify({ ...rec, pid: u.pid })); // its pid now names u
      const h = await crew(fe, ['exec', 'gateway-pid']);
      assert.equal((JSON.parse(h.stdout) as { holder: string }).holder, 'nobody', `the fake named pid ${u.pid} (another process) as the gateway`);
      await crew(fe, ['exec', 'stop']);
      assert.equal(u.terms(), 0, `the fake kirocrew stop sent SIGTERM to pid ${u.pid}`);
      const r = await crew(fe, ['stop', '--timeout', '1']);
      assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 0, stdout: 'Kiro Crew gateway is not running.\n' });
      assert.equal(u.terms(), 0, `crew stop sent SIGTERM to pid ${u.pid}`);
      assert.equal(stillRuns(u.pid, u.start), true);
    } finally {
      u?.stop();
      fe.cleanup();
    }
  });
});

// K8: a test fixture that kills a pid read from a file (minutes after it was written, the gateway
// may be long gone and its pid another process's: another group's test job) checks it first.
describe('crew test fixtures signal only the processes they started (K8)', () => {
  it('FakeEnv.cleanup() SIGKILLs a fake gateway only while its pid still has the recorded start time', { skip: process.platform !== 'linux' ? 'needs /proc' : false }, async () => {
    const ch = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      await once(ch, 'spawn');
      const pid = ch.pid!;
      const start = procStart(pid);
      assert.ok(start !== undefined);
      const write = (fe: FakeEnv, rec: object): void => {
        fs.mkdirSync(kcHome(fe), { recursive: true });
        fs.writeFileSync(path.join(kcHome(fe), 'fake-gateway.json'), JSON.stringify(rec));
      };
      // the file of a gateway that was killed, whose pid this process has taken since
      const stale = makeFakeEnv();
      write(stale, { pid, start: start + 7, port: 1 });
      stale.cleanup();
      assert.equal(stillRuns(pid, start), true, `cleanup SIGKILLed pid ${pid}, which a stale fake-gateway.json named`);
      // the file of a gateway that still runs
      const live = makeFakeEnv();
      write(live, { pid, start, port: 1 });
      const exited = once(ch, 'exit');
      live.cleanup();
      assert.deepEqual(await exited, [null, 'SIGKILL']);
    } finally {
      ch.kill('SIGKILL');
    }
  });
});

describe('crew logs / exec / uninstall', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  it('logs: tails gateway.err and the KiroCrew gateway.log; --acp picks the newest kiro-chat.log; -f follows', async () => {
    const fe = await setUp();
    try {
      let r = await crew(fe, ['logs']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /No gateway logs yet/);
      const run = path.join(fe.cs, 'run');
      fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(path.join(run, 'gateway.err'), 'e1\ne2\ne3\n');
      fs.mkdirSync(kcHome(fe), { recursive: true });
      fs.writeFileSync(path.join(kcHome(fe), 'gateway.log'), 'g1\ng2\n');
      r = await crew(fe, ['logs', '-n', '2']);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, `==> ${path.join(run, 'gateway.err')} <==\ne2\ne3\n==> ${path.join(kcHome(fe), 'gateway.log')} <==\ng1\ng2\n`);
      for (const [n, t] of [['runtime-a', 1_000], ['runtime-b', 2_000]] as const) {
        const f = path.join(kcHome(fe), 'scratch', n, 'kiro-log', 'kiro-chat.log');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, `${n}\n`);
        fs.utimesSync(f, t, t);
      }
      r = await crew(fe, ['logs', '--acp']);
      assert.equal(r.stdout, 'runtime-b\n');
      // -f: appended data is printed until the signal aborts.
      const ac = new AbortController();
      const p = crew(fe, ['logs', '-f', '-n', '0'], { deps: { signal: ac.signal } });
      await new Promise((res) => setTimeout(res, 200));
      fs.appendFileSync(path.join(kcHome(fe), 'gateway.log'), 'g3\n');
      await new Promise((res) => setTimeout(res, 300));
      ac.abort();
      r = await p;
      assert.equal(r.code, 0);
      assert.ok(r.stdout.endsWith(`\n==> ${path.join(kcHome(fe), 'gateway.log')} <==\ng3\n`), JSON.stringify(r.stdout));
    } finally {
      fe.cleanup();
    }
  });

  it('exec: runs bin/kirocrew with the gateway env in the caller cwd and returns its exit code', async () => {
    const fe = await setUp({ CLAUDECODE: '1' });
    try {
      const cwd = path.join(fe.root, 'work');
      fs.mkdirSync(cwd);
      let r = await crew(fe, ['exec', '--', 'chat', '-m', 'hi there'], { cwd });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, `fake kirocrew chat -m hi there\nKIROCREW_KIRO_BIN=${path.join(fe.cs, 'bin', 'kiro-claude')}\ncwd=${cwd}\n`);
      const call = fe.callsOf('kirocrew').pop()!;
      assert.deepEqual(call.args, ['chat', '-m', 'hi there']);
      assert.equal(call.env.CLAUDECODE, undefined);
      r = await crew(fe, ['exec', '--env', 'FAKE_KC_EXIT=7', '--', 'learn', 'list']);
      assert.equal(r.code, 7);
      r = await crew(fe, ['exec', 'doctor']);
      assert.equal(r.code, 1, 'args without -- pass through too (kirocrew doctor exits 1 in the fake)');
      assert.match(r.stdout, /kiro-cli: {4}✅/);
    } finally {
      fe.cleanup();
    }
  });

  it('uninstall: restores config (absent keys removed, old values set back), removes shim, stub and state; --purge empties $CS', async () => {
    const fe = makeFakeEnv();
    try {
      fs.writeFileSync(path.join(fe.home, '.fake-claude-login'), '');
      const cfg = path.join(kcHome(fe), 'config.json');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, JSON.stringify({ agent: { acp_backend: 'claude', keep: 1 } }));
      assert.equal((await crew(fe, ['setup', '--dir', path.join(fe.root, 'KiroCrew'), '--allow-tmp'])).code, 0);
      assert.equal((await crew(fe, ['start', '--port', String(await freePort())])).code, 0);
      const store = path.join(fe.home, '.local', 'share', 'kiro-cli', 'data.sqlite3');
      assert.equal(fs.existsSync(store), true);
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Stopped \(pid \d+\)/);
      const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      assert.deepEqual(after.agent, { acp_backend: 'claude', keep: 1 });
      assert.equal('auto_update' in after, false);
      assert.equal(fs.existsSync(store), false, 'our stub removed');
      assert.equal(fs.existsSync(fe.cs), false, '$CS purged');
      assert.equal(fs.existsSync(path.join(fe.root, 'KiroCrew', 'bin', 'kirocrew')), true, 'the checkout is kept');
      assert.equal(fs.existsSync(kcHome(fe)), true, 'the KiroCrew data home is kept');
    } finally {
      fe.cleanup();
    }
  });
});
