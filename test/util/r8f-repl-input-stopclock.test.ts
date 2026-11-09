/**
 * Round-8 fix "repl-input" (findings #0/#1): stopped time does not count against a hook
 * command's timeout (util/process.ts runShell, `runningTimeout`), nor against a control
 * request's timeout (claude/process.ts), however kiro-claude was stopped.
 *
 * Hook commands run in process groups of their own and go on while kiro-claude is stopped. At
 * SIGCONT libuv ran the expired timeout (timers phase) before the poll phase delivered the exit
 * of a hook that exited meanwhile: a hook that exited 2 (block) during the stop counted as
 * "timed out", which never blocks, and the guarded tool ran. Now the expiry is decided one
 * event-loop turn later (a pending exit wins) and a stop's duration (a heartbeat while timers
 * are armed, confirmed by the SIGCONT) is not counted, so a command still running after the stop
 * gets the rest of its time; a hung one still times out, and a blocked event loop alone extends
 * nothing.
 *
 * Each case runs a driver process (the built util/process.js) that the test stops: from outside
 * (`kill -STOP` while it waits on its event loop) or from inside a callback (as the REPL's own
 * Ctrl+Z does), and continues with SIGCONT. Linux (/proc for the stop state).
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { runningTimeout } from '../../src/util/process.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { removeOnExit } from '../tmpdirs.js';

const linux = process.platform === 'linux' ? {} : { skip: 'Linux (/proc, POSIX job control signals)' };
const PROCESS_JS = new URL('../../src/util/process.js', import.meta.url).href;
const CLAUDE_HELPERS_JS = new URL('../claude/helpers.js', import.meta.url).href;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const busy = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // the event loop is blocked
  }
};

const tmp = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r8f-stop-'))));
let n = 0;

interface Event {
  event: string;
  [k: string]: unknown;
}

interface Driver {
  dir: string;
  child: ChildProcess;
  waitEvent(name: string, ms?: number): Promise<Event>;
  waitFile(name: string, ms?: number): Promise<void>;
  /** Stop it from outside (kill -STOP), while it waits on its event loop. */
  stopOutside(): Promise<void>;
  /** Stop it from inside a callback (a stdin 'data' handler sends itself SIGSTOP). */
  stopInside(): Promise<void>;
  cont(): void;
  dispose(): void;
}

function procState(pid: number): string | undefined {
  try {
    return /^State:\s+(\S)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

/**
 * A driver running `body` (an async module body; `PROCESS_JS`, `HELPERS_JS`, `DIR`, `say`, `busy`
 * and `line(text)` are in scope). A stdin line `stop` makes it SIGSTOP itself inside that callback.
 */
function driver(body: string): Driver {
  const dir = path.join(tmp, `d${++n}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'driver.mjs');
  fs.writeFileSync(
    file,
    `const PROCESS_JS = ${JSON.stringify(PROCESS_JS)};
const HELPERS_JS = ${JSON.stringify(CLAUDE_HELPERS_JS)};
const DIR = ${JSON.stringify(dir)};
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
const waiting = new Map();
const line = (text) => new Promise((res) => waiting.set(text, res));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  for (const l of d.split('\\n')) {
    if (l === 'stop') process.kill(process.pid, 'SIGSTOP');
    const w = waiting.get(l);
    if (w) { waiting.delete(l); w(); }
  }
});
${body}
`,
  );
  // the driver's cwd is not the repository: the fake claude is named explicitly
  // TMPDIR: the child is SIGKILLed at the end, so its own temp-dir cleanup never runs
  const env = { ...process.env, TMPDIR: tmp, KIRO_CLAUDE_FAKE: fakeClaudePath() };
  const child = spawn(process.execPath, [file], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d));
  child.stdin!.on('error', () => undefined);
  const events = (): Event[] =>
    out
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Event);
  const waitStopped = async (): Promise<void> => {
    const end = Date.now() + 5000;
    while (procState(child.pid!) !== 'T') {
      if (Date.now() > end) throw new Error(`the driver did not stop (state ${procState(child.pid!)})`);
      await sleep(5);
    }
  };
  return {
    dir,
    child,
    async waitEvent(name, ms = 20_000) {
      const end = Date.now() + ms;
      for (;;) {
        const e = events().find((x) => x.event === name);
        if (e) return e;
        if (Date.now() > end) throw new Error(`no '${name}' event; stdout ${JSON.stringify(out)} stderr ${JSON.stringify(err)}`);
        await sleep(5);
      }
    },
    async waitFile(name, ms = 10_000) {
      const end = Date.now() + ms;
      while (!fs.existsSync(path.join(dir, name))) {
        if (Date.now() > end) throw new Error(`no ${name}; stderr ${JSON.stringify(err)}`);
        await sleep(5);
      }
    },
    async stopOutside() {
      process.kill(child.pid!, 'SIGSTOP');
      await waitStopped();
    },
    async stopInside() {
      child.stdin!.write('stop\n');
      await waitStopped();
    },
    cont() {
      process.kill(child.pid!, 'SIGCONT');
    },
    dispose() {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(child.pid!, 'SIGCONT');
          child.kill('SIGKILL');
        } catch {
          // gone
        }
      }
      // the shell our driver started (its own process group), should it outlive the driver
      const f = path.join(dir, 'sh.pid');
      const pid = fs.existsSync(f) ? Number.parseInt(fs.readFileSync(f, 'utf8'), 10) : NaN;
      if (pid > 0) {
        try {
          if (fs.readlinkSync(`/proc/${pid}/cwd`) === dir) process.kill(-pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
    },
  };
}

/** A driver that runs `command` through runShell with `timeoutMs` and reports the result. */
function shellDriver(command: string, timeoutMs: number, before = ''): Driver {
  return driver(`const { runShell } = await import(PROCESS_JS);
const running = runShell(${JSON.stringify(command)}, { cwd: DIR, timeoutMs: ${timeoutMs} });
${before}
const r = await running;
say({ event: 'done', exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, stderr: r.stderr, durationMs: r.durationMs });
process.exit(0);
`);
}

/** The shell records its pid (for cleanup: its cwd is the driver's dir) and that it started. */
const STARTED = 'echo $$ > sh.pid; touch started;';

describe('runShell: stopped time does not count against a timeout (r8 #0/#1)', linux, () => {
  for (const how of ['outside', 'inside'] as const) {
    it(`a command that exits 2 while kiro-claude is stopped (${how === 'outside' ? 'kill -STOP from elsewhere' : 'stopped inside a callback, as its own Ctrl+Z'}) keeps its exit status`, async (t) => {
      const d = shellDriver(`${STARTED} sleep 1; echo NO-SECRETS >&2; exit 2`, 1500);
      t.after(() => d.dispose());
      await d.waitFile('started');
      await sleep(100);
      await (how === 'outside' ? d.stopOutside() : d.stopInside());
      await sleep(3000); // the command exits (2) after 1 s; the 1.5 s timeout runs out meanwhile
      d.cont();
      const r = await d.waitEvent('done');
      assert.equal(r.timedOut, false, `a command that exited while kiro-claude was stopped counted as timed out: ${JSON.stringify(r)}`);
      assert.equal(r.exitCode, 2, JSON.stringify(r));
      assert.match(String(r.stderr), /NO-SECRETS/);
    });
  }

  for (const how of ['outside', 'inside'] as const) {
    it(`a command still running after the stop (${how}) gets the rest of its timeout`, async (t) => {
      // timeout 2 s; stopped 2 s at ~0.2 s: about 1.8 s of running time are left at SIGCONT, and the
      // command exits (3) 0.8 s later
      const d = shellDriver(`${STARTED} sleep 3; exit 3`, 2000);
      t.after(() => d.dispose());
      await d.waitFile('started');
      await sleep(200);
      await (how === 'outside' ? d.stopOutside() : d.stopInside());
      await sleep(2000);
      d.cont();
      const r = await d.waitEvent('done');
      assert.equal(r.timedOut, false, `the stop counted against the timeout: ${JSON.stringify(r)}`);
      assert.equal(r.exitCode, 3, JSON.stringify(r));
    });
  }

  it('a hung command still times out, after its timeout of running time', async (t) => {
    const d = shellDriver(`${STARTED} sleep 30`, 1500);
    t.after(() => d.dispose());
    await d.waitFile('started');
    await sleep(200);
    await d.stopOutside();
    await sleep(2000);
    d.cont();
    const r = await d.waitEvent('done');
    assert.equal(r.timedOut, true, JSON.stringify(r));
    const ms = Number(r.durationMs);
    // 1.5 s of running time plus the 2 s stop (less at most a heartbeat of the stop)
    assert.ok(ms >= 3200 && ms < 6000, `timed out after ${ms} ms`);
  });

  it('without a stop a timeout is unchanged', async (t) => {
    const d = shellDriver(`${STARTED} sleep 30`, 400);
    t.after(() => d.dispose());
    const r = await d.waitEvent('done');
    assert.equal(r.timedOut, true, JSON.stringify(r));
    assert.ok(Number(r.durationMs) >= 390 && Number(r.durationMs) < 1200, `timed out after ${String(r.durationMs)} ms`);
  });

  it('a blocked event loop (no stop, no SIGCONT) does not extend a timeout', async (t) => {
    const d = shellDriver(`${STARTED} sleep 30`, 400, 'busy(1500);');
    t.after(() => d.dispose());
    const r = await d.waitEvent('done');
    assert.equal(r.timedOut, true, JSON.stringify(r));
    assert.ok(Number(r.durationMs) >= 1500 && Number(r.durationMs) < 2000, `timed out after ${String(r.durationMs)} ms`);
  });
});

describe('runningTimeout: the stop clock seam (r8 #0/#1)', () => {
  it('a gap the SIGCONT confirms as a stop is not counted; without the SIGCONT it is', process.platform === 'win32' ? { skip: 'POSIX' } : {}, async () => {
    const run = async (sigcont: boolean): Promise<number> => {
      const t0 = performance.now();
      const fired = new Promise<number>((res) => runningTimeout(300, () => res(performance.now() - t0)));
      busy(1000); // as long as a stop: nothing of the event loop runs
      if (sigcont) process.emit('SIGCONT', 'SIGCONT');
      return fired;
    };
    const blocked = await run(false);
    assert.ok(blocked >= 990 && blocked < 1100, `a blocked loop moved the expiry to ${blocked} ms`);
    const stopped = await run(true);
    // 1000 ms gap, less one heartbeat interval at most, is the stop: about 200 ms remain after it
    assert.ok(stopped >= 1120 && stopped < 1500, `after a confirmed stop the timer expired at ${stopped} ms`);
  });

  it('clear() before the expiry cancels it', async () => {
    let fired = false;
    const t = runningTimeout(50, () => (fired = true));
    t.clear();
    t.clear();
    await sleep(150);
    assert.equal(fired, false);
  });
});

describe('control requests: stopped time does not count against their timeout (r8 #0/#1)', linux, () => {
  it('an answer that arrived while kiro-claude was stopped settles the request after SIGCONT', async (t) => {
    const d = driver(`const { startFake } = await import(HELPERS_JS);
const h = await startFake({ env: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ set_permission_mode: 300 }) }, requestTimeoutMs: 1500 });
say({ event: 'ready' });
await line('go');
const p = h.proc.request('set_permission_mode', { mode: 'default' }).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e && e.message) }));
say({ event: 'sent' });
const r = await p;
say({ event: 'done', ...r });
await h.proc.close({ graceMs: 1000 });
process.exit(0);
`);
    t.after(() => d.dispose());
    await d.waitEvent('ready');
    d.child.stdin!.write('go\n');
    await d.waitEvent('sent');
    await d.stopOutside();
    await sleep(3000); // Claude Code answers after 300 ms; the 1.5 s timeout runs out meanwhile
    d.cont();
    const r = await d.waitEvent('done');
    assert.equal(r.ok, true, `the request timed out although its answer had arrived: ${JSON.stringify(r)}`);
  });
});
