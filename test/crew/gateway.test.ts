/**
 * Gateway lifecycle wrappers (08 §3.8) against the fake KiroCrew CLI, whose `gateway` verb is a
 * real detached HTTP server printing `KIROCREW_READY:{…}` and serving the cookie-authenticated
 * dashboard routes crew uses.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readState } from '../../src/crew/state.js';
import { defaultSys } from '../../src/crew/runner.js';
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
      assert.deepEqual(ready, { port, token: `tok-${pid}`, pid, home: kcHome(fe) });
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
      // running = not gone and not a zombie (a zombie has an empty cmdline)
      const running = (pid: number): boolean => {
        try {
          return fs.readFileSync(`/proc/${pid}/cmdline`).length > 0;
        } catch {
          return false;
        }
      };
      let child: number | undefined;
      try {
        let r = await crew(fe, ['start', '--port', String(await freePort())]);
        assert.equal(r.code, 0, r.stderr);
        child = (JSON.parse(fs.readFileSync(path.join(kcHome(fe), 'fake-gateway-child.json'), 'utf8')) as { pid: number }).pid;
        assert.equal(running(child), true, 'the gateway child runs');
        r = await crew(fe, ['stop']);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /^Stopped \(pid \d+\); 0 orphan agent process\(es\) reaped\n$/);
        assert.equal(running(child), false, `the ${kind} gateway child outlived crew stop`);
      } finally {
        if (child !== undefined && running(child)) process.kill(child, 'SIGKILL');
        fe.cleanup();
      }
    });
  }

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
