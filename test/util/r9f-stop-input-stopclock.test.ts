/**
 * Round-9 fix "stop-input" (finding #0): the stop clock (util/process.ts `runningTimeout`) credits
 * EVERY stop, also two back to back, whatever the order of the SIGCONT listeners.
 *
 * The interactive chat under a job-control shell: `kill -STOP` of kiro-claude from elsewhere while
 * a blocking preToolUse hook runs, then `kill -CONT` (or `bg`) while the shell holds the terminal.
 * The terminal reader's SIGCONT listener, registered at chat start (before the stop clock's), set
 * raw mode from the background and SIGTTOU stopped kiro-claude again inside the SIGCONT dispatch.
 * At SIGCONT libuv runs the timers phase first: a heartbeat saw the first stop's gap and moved on,
 * and the expired hook timeout fired. The clock's own listener, run after the second stop, then
 * credited only the longer of the two stops, and the expiry decided in that same turn, before the
 * poll phase that delivered the hook's exit from the second stop: the hook that exited 2 was killed
 * and reported "timed out", which never blocks, and the trusted tool ran. A hook still running
 * after both stops was killed early, and so were control requests (claude/process.ts).
 *
 * Now the clock's listener is prepended and credits both the gap the last heartbeat saw and the
 * span since it, and the expiry moves one more turn on when the turn after the timer took longer
 * than a heartbeat. Each case runs a driver process (the built util/process.js) whose SIGCONT
 * listener, registered first, stops it again once (SIGTTOU, what tcsetattr from the background
 * does); the test stops it from outside (SIGSTOP) and continues it twice. Linux (/proc).
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { fakeClaudePath } from '../claude/helpers.js';
import { removeOnExit } from '../tmpdirs.js';

const linux = process.platform === 'linux' ? {} : { skip: 'Linux (/proc, POSIX job control signals)' };
const PROCESS_JS = new URL('../../src/util/process.js', import.meta.url).href;
const CLAUDE_HELPERS_JS = new URL('../claude/helpers.js', import.meta.url).href;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tmp = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r9f-stop-'))));
let n = 0;

function procState(pid: number): string | undefined {
  try {
    return /^State:\s+(\S)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

interface Driver {
  dir: string;
  child: ChildProcess;
  result(ms?: number): Promise<Record<string, unknown>>;
  waitFile(name: string, ms?: number): Promise<void>;
  waitState(state: string, ms?: number): Promise<void>;
  dispose(): void;
}

/**
 * A driver running `body` (an async module body; `PROCESS_JS`, `HELPERS_JS`, `DIR` and `say` are in
 * scope). With `nested`, its first SIGCONT listener (registered before anything of `body` runs)
 * stops it again at its first SIGCONT: the second stop of the scenario.
 */
function driver(body: string, nested: boolean): Driver {
  const dir = path.join(tmp, `d${++n}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'driver.mjs');
  fs.writeFileSync(
    file,
    `const PROCESS_JS = ${JSON.stringify(PROCESS_JS)};
const HELPERS_JS = ${JSON.stringify(CLAUDE_HELPERS_JS)};
const DIR = ${JSON.stringify(dir)};
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let again = ${nested ? 'true' : 'false'};
process.on('SIGCONT', () => {
  if (!again) return;
  again = false;
  process.kill(process.pid, 'SIGTTOU'); // what a terminal mode change from the background does
});
${body}
`,
  );
  // the driver's cwd is not the repository: the fake claude is named explicitly
  // TMPDIR: the child is SIGKILLed at the end, so its own temp-dir cleanup never runs
  const env = { ...process.env, TMPDIR: tmp, KIRO_CLAUDE_FAKE: fakeClaudePath() };
  const child = spawn(process.execPath, [file], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d));
  return {
    dir,
    child,
    async result(ms = 20_000) {
      const end = Date.now() + ms;
      for (;;) {
        const l = out.split('\n').find((x) => x.startsWith('{"event":"done"'));
        if (l) return JSON.parse(l) as Record<string, unknown>;
        if (Date.now() > end) throw new Error(`no result; stdout ${JSON.stringify(out)} stderr ${JSON.stringify(err)}`);
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
    async waitState(state, ms = 5000) {
      const end = Date.now() + ms;
      while (procState(child.pid!) !== state) {
        if (Date.now() > end) throw new Error(`the driver is not in state ${state} (${procState(child.pid!)})`);
        await sleep(5);
      }
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

/** The shell records its pid (for cleanup: its cwd is the driver's dir) and that it started. */
const STARTED = 'echo $$ > sh.pid; touch started;';
const TIMEOUT_MS = 1500;
/** From the start of the command: kill -STOP; kill -CONT (stopped again at once); fg. */
const STOP_AT = 200;
const CONT_AT = 2000; // after the timeout, which thus fires at this continue
const FG_AT = 3600;

function shellDriver(command: string, nested: boolean): Driver {
  return driver(
    `const { runShell } = await import(PROCESS_JS);
const r = await runShell(${JSON.stringify(command)}, { cwd: DIR, timeoutMs: ${TIMEOUT_MS} });
say({ event: 'done', exitCode: r.exitCode, signal: r.signal, timedOut: r.timedOut, stderr: r.stderr, durationMs: r.durationMs });
process.exit(0);
`,
    nested,
  );
}

/** kill -STOP at STOP_AT, kill -CONT at CONT_AT (the driver stops again when `nested`), fg at FG_AT. */
async function stopTwice(d: Driver, t0: number, nested: boolean): Promise<void> {
  await sleep(STOP_AT - (Date.now() - t0));
  process.kill(d.child.pid!, 'SIGSTOP');
  await d.waitState('T');
  await sleep(CONT_AT - (Date.now() - t0));
  process.kill(d.child.pid!, 'SIGCONT');
  if (nested) {
    // precondition: its first SIGCONT listener stopped it again (as the reader's tcsetattr did)
    await sleep(300);
    assert.equal(procState(d.child.pid!), 'T', 'the driver did not stop again');
  }
  await sleep(FG_AT - (Date.now() - t0));
  // (without the second stop the driver may be done already)
  if (d.child.exitCode === null && d.child.signalCode === null) process.kill(d.child.pid!, 'SIGCONT');
}

describe('runShell: two stops back to back, the second inside an earlier SIGCONT listener (r9 #0)', linux, () => {
  it('a command that exits 2 during the second stop keeps its exit status (a block stays a block)', async (t) => {
    // exits at ~2.6 s, inside the second stop; kiro-claude ran only ~0.2 s of it
    const d = shellDriver(`${STARTED} sleep 2.6; echo NO-SECRETS >&2; exit 2`, true);
    t.after(() => d.dispose());
    await d.waitFile('started');
    await stopTwice(d, Date.now(), true);
    const r = await d.result();
    assert.equal(r.timedOut, false, `the command that exited during the second stop counted as timed out: ${JSON.stringify(r)}`);
    assert.equal(r.exitCode, 2, JSON.stringify(r));
    assert.match(String(r.stderr), /NO-SECRETS/);
  });

  it('a command still running after both stops gets the rest of its running time', async (t) => {
    // exits at ~4.2 s: about 0.2 s + 0.6 s of running time, well inside the 1.5 s timeout
    const d = shellDriver(`${STARTED} sleep 4.2; exit 3`, true);
    t.after(() => d.dispose());
    await d.waitFile('started');
    await stopTwice(d, Date.now(), true);
    const r = await d.result();
    assert.equal(r.timedOut, false, `killed early (only one of the two stops was credited): ${JSON.stringify(r)}`);
    assert.equal(r.exitCode, 3, JSON.stringify(r));
  });

  it('a hung command still times out, after its timeout of running time counted past both stops', async (t) => {
    const d = shellDriver(`${STARTED} sleep 30`, true);
    t.after(() => d.dispose());
    await d.waitFile('started');
    await stopTwice(d, Date.now(), true);
    const r = await d.result();
    assert.equal(r.timedOut, true, JSON.stringify(r));
    const ms = Number(r.durationMs);
    // 0.2 s before the stops, the rest (about 1.3 s, plus at most a heartbeat per stop) after fg
    assert.ok(ms >= FG_AT + 1100 && ms < FG_AT + 2500, `timed out after ${ms} ms`);
  });

  it('control: the same stops with no second stop (kill -STOP, kill -CONT, a stray SIGCONT)', async (t) => {
    const d = shellDriver(`${STARTED} sleep 2.6; exit 2`, false);
    t.after(() => d.dispose());
    await d.waitFile('started');
    await stopTwice(d, Date.now(), false);
    const r = await d.result();
    assert.deepEqual([r.timedOut, r.exitCode], [false, 2], JSON.stringify(r));
  });

  it('a SIGCONT storm without a stop does not keep a hung command alive', async (t) => {
    const d = shellDriver(`${STARTED} sleep 30`, false);
    t.after(() => d.dispose());
    await d.waitFile('started');
    const t0 = Date.now();
    while (Date.now() - t0 < 2500 && d.child.exitCode === null) {
      try {
        process.kill(d.child.pid!, 'SIGCONT');
      } catch {
        break;
      }
      await sleep(20);
    }
    const r = await d.result();
    assert.equal(r.timedOut, true, JSON.stringify(r));
    assert.ok(Number(r.durationMs) >= TIMEOUT_MS - 10 && Number(r.durationMs) < TIMEOUT_MS + 700, `timed out after ${String(r.durationMs)} ms`);
  });
});

describe('control requests: two stops back to back (r9 #0)', linux, () => {
  it('an answer that arrived during the second stop settles the request', async (t) => {
    // Claude Code answers 2.6 s after the request, during the second stop; the 1.5 s timeout
    // fires at the first continue
    const d = driver(
      `const { startFake } = await import(HELPERS_JS);
const h = await startFake({ env: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ set_permission_mode: 2600 }) }, requestTimeoutMs: ${TIMEOUT_MS} });
const p = h.proc.request('set_permission_mode', { mode: 'default' }).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e && e.message) }));
(await import('node:fs')).writeFileSync(DIR + '/started', '');
const r = await p;
say({ event: 'done', ...r });
await h.proc.close({ graceMs: 1000 });
process.exit(0);
`,
      true,
    );
    t.after(() => d.dispose());
    await d.waitFile('started', 20_000);
    await stopTwice(d, Date.now(), true);
    const r = await d.result();
    assert.equal(r.ok, true, `the request timed out although its answer had arrived during the second stop: ${JSON.stringify(r)}`);
  });
});
