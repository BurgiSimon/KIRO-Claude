/**
 * Round 5, group crew-acp: the crashed-gateway retire (K7) after `crew start` replaced the
 * crashed gateway's run/ready.json (C1), and off Linux (C2).
 *
 * C1: `crew start` after a crash drops run/ready.json (its token is stale); what `crew stop`
 * needs to retire what that gateway left (pid, start time, boot, process group, HOME and
 * KIROCREW_KIRO_BIN) is kept in run/crashed.json, and a later stop retires those leftovers by the
 * same proof as K7, never anything it cannot prove this crew's.
 * C2: off Linux nothing a crashed gateway left is ever signalled (no /proc: no environment to
 * prove whose a process is), and a stop that cannot free the lock says why.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CrewDeps } from '../../src/crew/context.js';
import { defaultSys, type CrewSys, type ProcessInfo } from '../../src/crew/runner.js';
import { cloneFakeEnv, crew, freePort, makeFakeEnv, realPython, stillRunsAs, type FakeEnv } from './helpers.js';

const PY = realPython();
const linux = process.platform !== 'linux' ? 'needs /proc' : false;
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
after(() => base?.cleanup());

const kcHome = (fe: FakeEnv): string => path.join(fe.home, '.kiro', 'crew');
const shimOf = (fe: FakeEnv): string => path.join(fe.cs, 'bin', 'kiro-claude');
const crashedFile = (fe: FakeEnv): string => path.join(fe.cs, 'run', 'crashed.json');
const readyFile = (fe: FakeEnv): string => path.join(fe.cs, 'run', 'ready.json');
const holdLock = (fe: FakeEnv): void => fs.writeFileSync(path.join(kcHome(fe), 'fake-held'), '');

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function bootId(): string | undefined {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** Waits for a SIGKILLed `pid` to be gone as crew stop sees it. */
async function waitDead(pid: number): Promise<void> {
  for (let i = 0; i < 250 && defaultSys.isAlive(pid); i++) await new Promise((res) => setTimeout(res, 20));
}

type Rec = { pid: number; start?: number };

async function startGateway(fe: FakeEnv, o: { env?: NodeJS.ProcessEnv; deps?: Partial<CrewDeps> } = {}): Promise<{ g: Rec; port: number; r: Awaited<ReturnType<typeof crew>> }> {
  const port = await freePort();
  const r = await crew(fe, ['start', '--port', String(port)], { env: o.env, deps: o.deps });
  const g = readJson<Rec>(path.join(kcHome(fe), 'fake-gateway.json'));
  return { g, port, r };
}

/** The fake gateway's child (FAKE_GATEWAY_CHILD), as it recorded itself. */
const gatewayChild = (fe: FakeEnv): Rec => readJson<Rec>(path.join(kcHome(fe), 'fake-gateway-child.json'));

/** Starts a gateway with a child in its process group, then crashes it (SIGKILL); the child keeps running. */
async function crashGateway(fe: FakeEnv): Promise<{ g: Rec; child: Rec }> {
  const { g, r } = await startGateway(fe);
  assert.equal(r.code, 0, r.stderr);
  const child = gatewayChild(fe);
  assert.equal(stillRunsAs(child.pid, child.start), true, 'the gateway child runs');
  process.kill(g.pid, 'SIGKILL'); // the crash
  await waitDead(g.pid);
  assert.equal(defaultSys.isAlive(g.pid), false, 'the gateway is gone');
  return { g, child };
}

async function holderOf(fe: FakeEnv): Promise<string> {
  const h = await crew(fe, ['exec', 'gateway-pid']);
  return (JSON.parse(h.stdout) as { holder: string }).holder;
}

/** Only processes this test started, and only while they still have the recorded start time. */
function killIfOurs(...recs: Array<Rec | undefined>): void {
  for (const r of recs) if (r && stillRunsAs(r.pid, r.start)) process.kill(r.pid, 'SIGKILL');
}

type Proc = ProcessInfo;

/** The real CrewSys, recording every signal; `extra` processes are listed (until SIGKILLed, unless `unkillable`) and their signals never sent. */
function recordingSys(extra: Proc[] = [], o: { unkillable?: boolean } = {}) {
  const signals: Array<{ pid: number; signal: string }> = [];
  const fake = new Map(extra.map((p) => [p.pid, p]));
  const sys = {
    ...defaultSys,
    isAlive: (pid: number) => (fake.has(pid) ? true : defaultSys.isAlive(pid)),
    startTime: (pid: number) => (fake.has(pid) ? fake.get(pid)!.startTime : defaultSys.startTime(pid)),
    kill: (pid: number, signal: NodeJS.Signals, start: number | undefined) => {
      signals.push({ pid, signal });
      if (fake.has(pid)) {
        if (signal === 'SIGKILL' && !o.unkillable) fake.delete(pid);
        return true;
      }
      return defaultSys.kill(pid, signal, start);
    },
    listProcesses: () => [...defaultSys.listProcesses(), ...fake.values()],
  } as CrewSys;
  return { sys, signals };
}

describe('C1: crew stop retires what a crashed gateway left after crew start replaced its run/ready.json', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  it('start after a crash, then stop: the crashed gateway\'s leftover child is retired with the new gateway, and the stop says so', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn' });
    let a: { g: Rec; child: Rec } | undefined;
    let bChild: Rec | undefined;
    try {
      a = await crashGateway(fe);
      assert.equal(await holderOf(fe), 'nobody', 'the crashed gateway\'s child does not keep the lock here');
      const b = await startGateway(fe);
      assert.equal(b.r.code, 0, b.r.stderr);
      bChild = gatewayChild(fe);
      assert.notEqual(b.g.pid, a.g.pid);
      const kept = fs.existsSync(crashedFile(fe)) ? fs.readFileSync(crashedFile(fe), 'utf8') : undefined;
      const keptMode = kept !== undefined ? fs.statSync(crashedFile(fe)).mode & 0o777 : undefined;

      const r = await crew(fe, ['stop', '--timeout', '5']);
      assert.equal(stillRunsAs(a.child.pid, a.child.start), false, `the crashed gateway's leftover outlived crew stop: ${JSON.stringify(r)}`);
      // crew start said what it found, and kept the evidence (never the token) for crew stop
      assert.equal(
        b.r.stderr,
        `warning: the Kiro Crew gateway started earlier (pid ${a.g.pid}) has exited, but 1 process(es) of its process group still run (pid ${a.child.pid}); kiro-claude crew stop retires them\n`,
      );
      assert.equal(keptMode, 0o600);
      assert.doesNotMatch(kept!, /tok-/, 'run/crashed.json holds no dashboard token');
      assert.deepEqual(JSON.parse(kept!), {
        version: 1,
        gateways: [{ pid: a.g.pid, startTime: a.g.start, bootId: bootId(), home: fe.home, kiroBin: shimOf(fe) }],
      });
      assert.equal(stillRunsAs(bChild.pid, bChild.start), false, 'the stopped gateway\'s own child outlived crew stop');
      assert.deepEqual(
        { code: r.code, stderr: r.stderr, stdout: r.stdout },
        {
          code: 0,
          stderr: '',
          stdout: `Stopped (pid ${b.g.pid}); 0 orphan agent process(es) reaped; 1 leftover process(es) of the process group of an earlier gateway (pid ${a.g.pid}, which had already exited) retired\n`,
        },
      );
      assert.equal(fs.existsSync(crashedFile(fe)), false, 'nothing is left of either gateway: run/crashed.json is dropped');
    } finally {
      killIfOurs(a?.child, bChild);
      fe.cleanup();
    }
  });

  it('a crashed gateway\'s child that keeps the lock makes the next start fail; crew stop then retires it (the evidence survived that start), and the lock is free again', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn', FAKE_LOCK_INHERIT: '1' });
    let a: { g: Rec; child: Rec } | undefined;
    try {
      a = await crashGateway(fe);
      assert.equal(await holderOf(fe), 'indeterminate');
      // KiroCrew answers indeterminate, so crew start runs a gateway; it cannot take the lock and exits
      const b = await startGateway(fe, { env: { FAKE_GATEWAY_MODE: 'fail' } });
      assert.equal(b.r.code, 1, b.r.stdout);
      assert.match(b.r.stderr, /the Kiro Crew gateway exited before it was ready/);
      assert.equal(fs.existsSync(readyFile(fe)), false, 'crew start removed the crashed gateway\'s ready.json');

      const r = await crew(fe, ['stop', '--timeout', '3']);
      assert.equal(stillRunsAs(a.child.pid, a.child.start), false, `the child that keeps the lock outlived crew stop: ${JSON.stringify(r)}`);
      assert.match(b.r.stderr, new RegExp(`^warning: the Kiro Crew gateway started earlier \\(pid ${a.g.pid}\\) has exited, but 1 process\\(es\\) of its process group still run \\(pid ${a.child.pid}\\); kiro-claude crew stop retires them\n`));
      assert.deepEqual(
        { code: r.code, stderr: r.stderr, stdout: r.stdout },
        { code: 0, stderr: '', stdout: `Stopped (pid ${a.g.pid}, which had already exited; 1 leftover process(es) of its process group retired); 0 orphan agent process(es) reaped\n` },
      );
      assert.equal(await holderOf(fe), 'nobody', 'the lock is free again');
      assert.equal(fs.existsSync(crashedFile(fe)), false);
      const c = await startGateway(fe);
      assert.deepEqual({ code: c.r.code, stderr: c.r.stderr }, { code: 0, stderr: '' }, 'the next start works and warns about nothing');
      assert.equal((await crew(fe, ['stop'])).code, 0);
    } finally {
      killIfOurs(a?.child);
      fe.cleanup();
    }
  });

  it('a leftover that outlived a stop\'s SIGKILL is retried by the next stop (the stop keeps the evidence it removes with ready.json)', { skip: linux }, async () => {
    const fe = await setUp();
    try {
      const { g, r: s } = await startGateway(fe);
      assert.equal(s.code, 0, s.stderr);
      process.kill(g.pid, 'SIGKILL'); // the crash
      await waitDead(g.pid);
      const stuck: Proc = { pid: 2 ** 22 + 551, ppid: 1, pgid: g.pid, argv: ['/usr/bin/sleep', '30'], startTime: (g.start ?? 0) + 3, env: { HOME: fe.home, KIROCREW_KIRO_BIN: shimOf(fe) } };
      const first = recordingSys([stuck], { unkillable: true });
      let r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys: first.sys } });
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stderr, new RegExp(`1 of them still running after SIGKILL \\(pid ${stuck.pid}\\)`));
      assert.equal(fs.existsSync(readyFile(fe)), false);
      assert.equal(readJson<{ gateways: Array<{ pid: number }> }>(crashedFile(fe)).gateways[0]!.pid, g.pid, 'the evidence is kept for the next stop');

      // it can be killed by now (it was in D state): the next stop retries it
      const second = recordingSys([stuck]);
      r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys: second.sys } });
      assert.deepEqual(second.signals, [
        { pid: stuck.pid, signal: 'SIGTERM' },
        { pid: stuck.pid, signal: 'SIGKILL' },
      ]);
      assert.deepEqual(
        { code: r.code, stderr: r.stderr, stdout: r.stdout },
        { code: 0, stderr: '', stdout: `Stopped (pid ${g.pid}, which had already exited; 1 leftover process(es) of its process group retired); 0 orphan agent process(es) reaped\n` },
      );
      assert.equal(fs.existsSync(crashedFile(fe)), false, 'nothing is left of it: dropped');
    } finally {
      fe.cleanup();
    }
  });

  describe('run/crashed.json signals only what it proves this crew\'s', () => {
    // A synthetic crashed gateway G (a pid above any pid_max: never a real process) and its group.
    const G = 2 ** 22 + 600;
    const T = 1_000_000;
    function writeEvidence(fe: FakeEnv, o: { bootId?: string } = {}): void {
      fs.mkdirSync(path.dirname(crashedFile(fe)), { recursive: true });
      fs.writeFileSync(crashedFile(fe), JSON.stringify({ version: 1, gateways: [{ pid: G, startTime: T, bootId: o.bootId ?? bootId(), home: fe.home, kiroBin: shimOf(fe) }] }), { mode: 0o600 });
    }
    const member = (fe: FakeEnv, pid: number, env: Record<string, string>, startTime: number, pgid = G): Proc => ({ pid, ppid: 1, pgid, argv: ['/usr/bin/sleep', '30'], startTime, env: { KIROCREW_SPAWNED: '1', ...env } });

    it('only the members of its group that carry its HOME and KIROCREW_KIRO_BIN and started after it', { skip: linux }, async () => {
      const fe = await setUp();
      try {
        writeEvidence(fe);
        const other = path.join(fe.root, 'other-home');
        const mine = { HOME: fe.home, KIROCREW_KIRO_BIN: shimOf(fe) };
        const ok = member(fe, G + 1, mine, T + 5);
        const { sys, signals } = recordingSys([
          ok,
          member(fe, G + 2, { ...mine, HOME: other }, T + 5), // another HOME
          member(fe, G + 3, { ...mine, KIROCREW_KIRO_BIN: path.join(other, 'kiro-claude') }, T + 5), // another crew's kiro-cli
          member(fe, G + 4, mine, T - 1), // older than the gateway
          member(fe, G + 5, mine, T + 5, G + 50), // another group
        ]);
        const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys } });
        assert.deepEqual(signals, [
          { pid: ok.pid, signal: 'SIGTERM' },
          { pid: ok.pid, signal: 'SIGKILL' },
        ]);
        assert.deepEqual(
          { code: r.code, stderr: r.stderr, stdout: r.stdout },
          { code: 0, stderr: '', stdout: `Stopped (pid ${G}, which had already exited; 1 leftover process(es) of its process group retired); 0 orphan agent process(es) reaped\n` },
        );
        assert.equal(fs.existsSync(crashedFile(fe)), false);
      } finally {
        fe.cleanup();
      }
    });

    const unprovable = [
      { name: 'its pid taken by a later process that leads group <pid> (with a member of this crew env)', boot: undefined, takeover: true },
      { name: 'a record of an earlier boot', boot: '00000000-0000-4000-8000-000000000000', takeover: false },
    ];
    for (const u of unprovable) {
      it(`${u.name} → nothing is signalled, and the entry is dropped`, { skip: linux }, async () => {
        const fe = await setUp();
        try {
          writeEvidence(fe, u.boot ? { bootId: u.boot } : {});
          const mine = { HOME: fe.home, KIROCREW_KIRO_BIN: shimOf(fe) };
          const U: Proc = { pid: G, ppid: 1, pgid: G, argv: ['/usr/bin/sleep', '30'], startTime: T + 50, env: { HOME: path.join(fe.root, 'other-home') } };
          const W = member(fe, G + 1, mine, T + 51);
          const { sys, signals } = recordingSys(u.takeover ? [U, W] : [W]);
          const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys } });
          assert.deepEqual(signals, [], 'crew stop signalled a process it could not prove the crashed gateway\'s');
          assert.deepEqual({ code: r.code, stdout: r.stdout, stderr: r.stderr }, { code: 0, stdout: 'Kiro Crew gateway is not running.\n', stderr: '' });
          assert.equal(fs.existsSync(crashedFile(fe)), false, 'an entry that can never be proven again is dropped');
        } finally {
          fe.cleanup();
        }
      });
    }

    it('a running gateway that ready.json does not name (it names one that crashed before it): the stop retires the running one and what the crashed one left', { skip: linux }, async () => {
      const fe = await setUp();
      try {
        const { g: b, r: s } = await startGateway(fe);
        assert.equal(s.code, 0, s.stderr);
        // as if B had been started some other way while ready.json still named the crashed G
        const ready = readJson<Record<string, unknown>>(readyFile(fe));
        const mine = { HOME: fe.home, KIROCREW_KIRO_BIN: shimOf(fe) };
        fs.writeFileSync(readyFile(fe), JSON.stringify({ ...ready, pid: G, kiroClaude: { pid: G, startTime: T, bootId: bootId(), pgid: G, env: mine } }), { mode: 0o600 });
        const left = member(fe, G + 1, mine, T + 5);
        const { sys, signals } = recordingSys([left]);
        const r = await crew(fe, ['stop', '--timeout', '5'], { deps: { sys } });
        assert.deepEqual(
          signals.filter((x) => x.pid === left.pid),
          [
            { pid: left.pid, signal: 'SIGTERM' },
            { pid: left.pid, signal: 'SIGKILL' },
          ],
        );
        assert.equal(stillRunsAs(b.pid, b.start), false);
        assert.deepEqual(
          { code: r.code, stderr: r.stderr, stdout: r.stdout },
          { code: 0, stderr: '', stdout: `Stopped (pid ${b.pid}); 0 orphan agent process(es) reaped; 1 leftover process(es) of the process group of an earlier gateway (pid ${G}, which had already exited) retired\n` },
        );
      } finally {
        fe.cleanup();
      }
    });

    it('a broken run/crashed.json is ignored (nothing signalled) and replaced', { skip: linux }, async () => {
      const fe = await setUp();
      try {
        fs.mkdirSync(path.dirname(crashedFile(fe)), { recursive: true });
        fs.writeFileSync(crashedFile(fe), '{"gateways":[{"pid":"1","startTime":0},null,7', { mode: 0o600 });
        const { sys, signals } = recordingSys();
        const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys } });
        assert.deepEqual(signals, []);
        assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 0, stdout: 'Kiro Crew gateway is not running.\n' });
      } finally {
        fe.cleanup();
      }
    });
  });
});

describe('C2: off Linux a crashed gateway\'s leftovers are never signalled', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  it('darwin (ps has no environment): a crash whose child keeps the lock → nothing is signalled, no evidence is kept, and the failed stop says why', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn', FAKE_LOCK_INHERIT: '1' });
    let child: Rec | undefined;
    try {
      // CrewSys off Linux: no /proc (no process table, start times, process groups or boot id)
      const signals: Array<{ pid: number; signal: string }> = [];
      const sys = {
        ...defaultSys,
        platform: 'darwin',
        listProcesses: () => [],
        startTime: () => undefined,
        processGroup: () => undefined,
        bootId: () => undefined,
        kill: (pid: number, signal: NodeJS.Signals) => {
          signals.push({ pid, signal });
          return false;
        },
      } as CrewSys;
      const { g, r: s } = await startGateway(fe, { deps: { sys } });
      assert.equal(s.code, 0, s.stderr);
      assert.deepEqual(readJson<{ kiroClaude: unknown }>(readyFile(fe)).kiroClaude, { pid: g.pid }, 'off Linux crew start records the pid only');
      child = gatewayChild(fe);
      holdLock(fe);
      process.kill(g.pid, 'SIGKILL'); // the crash
      await waitDead(g.pid);
      assert.equal(await holderOf(fe), 'held');
      const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys } });
      assert.deepEqual(signals, [], 'crew stop signalled something off Linux');
      assert.equal(stillRunsAs(child.pid, child.start), true);
      assert.equal(r.code, 1, r.stdout);
      assert.equal(
        r.stderr,
        `kiro-claude: the Kiro Crew gateway did not exit. Nothing names its pid (kirocrew gateway-pid: held; run/ready.json named pid ${g.pid}, which is no longer that gateway), so nothing was signalled. On darwin, crew stop cannot tell what a gateway that crashed left running (that needs Linux /proc), so it signals none of it; if a process of its process group keeps the lock, stop that process yourself.\n`,
      );
      assert.equal(fs.existsSync(crashedFile(fe)), false, 'nothing to prove anything by is kept');
    } finally {
      killIfOurs(child);
      fe.cleanup();
    }
  });
});
