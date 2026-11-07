/**
 * Round 5, group crew-acp, verifier of C1 (run/crashed.json: the evidence `crew stop` needs to
 * retire what a crashed gateway left, once its run/ready.json is gone).
 *
 * - A `held` lock (KiroCrew cannot name its holder) whose keeper is the leftover of a crashed
 *   gateway that only run/crashed.json still names (an earlier stop removed ready.json while that
 *   leftover outlived its SIGKILL): the next stop retires it, the lock is free again, and the
 *   stop says what it retired without claiming which gateway held the lock.
 * - An entry of run/crashed.json whose gateway still runs as recorded is never signalled, nor is
 *   anything in its process group, and the entry is kept.
 * - A stop that left its gateway running (it ignored every signal) archives that gateway; the
 *   next stop stops it as the running gateway (its normal stop and text), never as "an earlier
 *   gateway" it retires early, and the entry is dropped once it is gone.
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
async function waitDead(pid: number): Promise<void> {
  for (let i = 0; i < 250 && defaultSys.isAlive(pid); i++) await new Promise((res) => setTimeout(res, 20));
}

type Rec = { pid: number; start?: number };

async function startGateway(fe: FakeEnv, o: { env?: NodeJS.ProcessEnv; deps?: Partial<CrewDeps> } = {}): Promise<{ g: Rec; r: Awaited<ReturnType<typeof crew>> }> {
  const port = await freePort();
  const r = await crew(fe, ['start', '--port', String(port)], { env: o.env, deps: o.deps });
  const g = readJson<Rec>(path.join(kcHome(fe), 'fake-gateway.json'));
  return { g, r };
}
const gatewayChild = (fe: FakeEnv): Rec => readJson<Rec>(path.join(kcHome(fe), 'fake-gateway-child.json'));

async function holderOf(fe: FakeEnv): Promise<string> {
  const h = await crew(fe, ['exec', 'gateway-pid']);
  return (JSON.parse(h.stdout) as { holder: string }).holder;
}
function killIfOurs(...recs: Array<Rec | undefined>): void {
  for (const r of recs) if (r && stillRunsAs(r.pid, r.start)) process.kill(r.pid, 'SIGKILL');
}

/**
 * The real CrewSys, recording every signal; signals to `swallow` (real pids) are recorded but
 * never sent (a process that survives them); `extra` processes are listed and never signalled.
 */
function recordingSys(o: { swallow?: number[]; extra?: ProcessInfo[] } = {}) {
  const signals: Array<{ pid: number; signal: string }> = [];
  const swallow = new Set(o.swallow ?? []);
  const fake = new Map((o.extra ?? []).map((p) => [p.pid, p]));
  const sys = {
    ...defaultSys,
    isAlive: (pid: number) => (fake.has(pid) ? true : defaultSys.isAlive(pid)),
    startTime: (pid: number) => (fake.has(pid) ? fake.get(pid)!.startTime : defaultSys.startTime(pid)),
    kill: (pid: number, signal: NodeJS.Signals, start: number | undefined) => {
      signals.push({ pid, signal });
      if (fake.has(pid) || swallow.has(pid)) return true;
      return defaultSys.kill(pid, signal, start);
    },
    listProcesses: () => [...defaultSys.listProcesses(), ...fake.values()],
  } as CrewSys;
  return { sys, signals };
}

describe('C1 (verifier): run/crashed.json', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  it('a held lock kept by a leftover only run/crashed.json names: the next stop retires it with the K7 text', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_CHILD: 'stubborn', FAKE_LOCK_INHERIT: '1' });
    let child: Rec | undefined;
    try {
      const { g, r: s } = await startGateway(fe);
      assert.equal(s.code, 0, s.stderr);
      child = gatewayChild(fe);
      fs.writeFileSync(path.join(kcHome(fe), 'fake-held'), '');
      process.kill(g.pid, 'SIGKILL'); // the crash
      await waitDead(g.pid);
      assert.equal(await holderOf(fe), 'held');
      // the first stop cannot kill it (as if in D state): it reports the lock kept, removes
      // ready.json (the token) and keeps the evidence
      const first = recordingSys({ swallow: [child.pid] });
      let r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys: first.sys } });
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stderr, new RegExp(`run/ready\\.json named pid ${g.pid}, which had already exited: 1 leftover process\\(es\\) of its process group retired, 1 of them still running after SIGKILL`));
      assert.equal(fs.existsSync(readyFile(fe)), false);
      assert.equal(readJson<{ gateways: Rec[] }>(crashedFile(fe)).gateways[0]!.pid, g.pid);
      assert.equal(stillRunsAs(child.pid, child.start), true);

      r = await crew(fe, ['stop', '--timeout', '5']);
      assert.equal(stillRunsAs(child.pid, child.start), false, `the leftover outlived the stop: ${JSON.stringify(r)}`);
      // a held lock names no gateway, and nothing proves it was this leftover that kept it (a
      // gateway whose earlier stop failed may have released it meanwhile): no pid is claimed
      assert.deepEqual(
        { code: r.code, stderr: r.stderr, stdout: r.stdout },
        { code: 0, stderr: '', stdout: `Stopped (pid unknown); 0 orphan agent process(es) reaped; 1 leftover process(es) of the process group of an earlier gateway (pid ${g.pid}, which had already exited) retired\n` },
      );
      assert.equal(await holderOf(fe), 'nobody');
      assert.equal(fs.existsSync(crashedFile(fe)), false);
    } finally {
      killIfOurs(child);
      fe.cleanup();
    }
  });

  it('an entry whose gateway still runs as recorded: neither it nor its group is signalled, and the entry is kept', { skip: linux }, async () => {
    const fe = await setUp();
    try {
      const G = 2 ** 22 + 700;
      const T = 2_000_000;
      const mine = { HOME: fe.home, KIROCREW_KIRO_BIN: shimOf(fe) };
      fs.mkdirSync(path.dirname(crashedFile(fe)), { recursive: true });
      fs.writeFileSync(crashedFile(fe), JSON.stringify({ version: 1, gateways: [{ pid: G, startTime: T, bootId: bootId(), home: fe.home, kiroBin: shimOf(fe) }] }), { mode: 0o600 });
      const gw: ProcessInfo = { pid: G, ppid: 1, pgid: G, argv: ['python3', 'kirocrew', 'gateway', '--json-ready'], startTime: T, env: mine };
      const member: ProcessInfo = { pid: G + 1, ppid: G, pgid: G, argv: ['python3', 'worker'], startTime: T + 3, env: mine };
      const { sys, signals } = recordingSys({ extra: [gw, member] });
      const r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys } });
      assert.deepEqual(signals, [], 'a stop signalled a recorded gateway that still runs, or its group');
      assert.deepEqual({ code: r.code, stdout: r.stdout, stderr: r.stderr }, { code: 0, stdout: 'Kiro Crew gateway is not running.\n', stderr: '' });
      assert.equal(readJson<{ gateways: Rec[] }>(crashedFile(fe)).gateways[0]!.pid, G, 'the entry of a gateway that still runs was dropped');
    } finally {
      fe.cleanup();
    }
  });

  it('a stop that left its gateway running archives it; the next stop stops it as the running gateway (normal text), and the entry goes', { skip: linux }, async () => {
    const fe = await setUp({ FAKE_GATEWAY_MODE: 'ignore-term', FAKE_GATEWAY_CHILD: 'linger' });
    let g: Rec | undefined;
    let child: Rec | undefined;
    try {
      const s = await startGateway(fe);
      g = s.g;
      assert.equal(s.r.code, 0, s.r.stderr);
      child = gatewayChild(fe);
      const first = recordingSys({ swallow: [g.pid] });
      let r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys: first.sys } });
      assert.equal(r.code, 1, r.stdout);
      assert.equal(r.stderr, `kiro-claude: the Kiro Crew gateway (pid ${g.pid}) did not exit.\n`);
      assert.equal(stillRunsAs(g.pid, g.start), true);
      assert.equal(readJson<{ gateways: Rec[] }>(crashedFile(fe)).gateways[0]!.pid, g.pid, 'the evidence of the gateway that did not exit');
      assert.deepEqual(first.signals.filter((x) => x.pid !== g!.pid), [], 'its child was signalled while the gateway still ran');

      const second = recordingSys();
      r = await crew(fe, ['stop', '--timeout', '1'], { deps: { sys: second.sys } });
      assert.equal(stillRunsAs(g.pid, g.start), false);
      assert.equal(stillRunsAs(child.pid, child.start), false);
      assert.deepEqual(
        { code: r.code, stderr: r.stderr, stdout: r.stdout },
        { code: 0, stderr: '', stdout: `Stopped (pid ${g.pid}); 0 orphan agent process(es) reaped\n` },
        'the running gateway was taken for an earlier one',
      );
      // the gateway itself: its own stop (SIGTERM after the timeout, then SIGKILL), first
      assert.deepEqual(second.signals[0], { pid: g.pid, signal: 'SIGTERM' });
      assert.equal(fs.existsSync(crashedFile(fe)), false);
    } finally {
      killIfOurs(g, child);
      fe.cleanup();
    }
  });
});
