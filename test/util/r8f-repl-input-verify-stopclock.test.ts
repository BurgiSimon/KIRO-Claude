/**
 * Round-8 verification of the "repl-input" fix #0/#1 (util/process.ts `runningTimeout`, the stop
 * clock): only a stop is given back, never an earlier blocked event loop.
 *
 * The stop clock records the gap a heartbeat saw and lets the next SIGCONT take it for the stop
 * it ends. It kept the longest gap of the last second, so a blocked event loop (no stop) followed
 * within a second by a SIGCONT (one ending a short real stop, or a stray one) was credited as
 * stopped time: a 1.5 s block moved a 2.5 s timeout to about 3.9 s, against "never more than the
 * stop" and "a blocked event loop extends nothing". Now only the gap that the latest heartbeat saw
 * (the loop has not run since) can be the stop a SIGCONT ends. Linux for the real-stop case.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { runningTimeout } from '../../src/util/process.js';
import { removeOnExit } from '../tmpdirs.js';

const posix = process.platform === 'win32' ? { skip: 'POSIX (SIGCONT)' } : {};
const linux = process.platform === 'linux' ? {} : { skip: 'Linux (/proc, SIGSTOP)' };
const PROCESS_JS = new URL('../../src/util/process.js', import.meta.url).href;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const busy = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // the event loop is blocked
  }
};

function procState(pid: number): string | undefined {
  try {
    return /^State:\s+(\S)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

describe('runningTimeout: a blocked loop before a later SIGCONT is no stop (r8 verification)', () => {
  it('a SIGCONT 400 ms after a 1.5 s blocked loop gives nothing back (the loop ran in between)', posix, async () => {
    const t0 = performance.now();
    const fired = new Promise<number>((res) => runningTimeout(2500, () => res(performance.now() - t0)));
    await sleep(50);
    busy(1500); // blocked, not stopped: heartbeats see the gap, no SIGCONT follows it
    await sleep(400); // the loop runs normally (heartbeats every 100 ms)
    process.emit('SIGCONT', 'SIGCONT'); // a stray SIGCONT (no stop at all)
    const at = await fired;
    assert.ok(at >= 2490 && at < 2900, `the timer expired at ${Math.round(at)} ms: the blocked loop was given back as stopped time`);
  });

  it('the gap the latest heartbeat saw is still the stop that a SIGCONT handled next ends', posix, async () => {
    const t0 = performance.now();
    const fired = new Promise<number>((res) => runningTimeout(300, () => res(performance.now() - t0)));
    // as at a real SIGCONT after a stop inside a callback: in the next timers phase the overdue
    // heartbeat (due at +100 ms) sees the gap and moves on, then the SIGCONT is handled (+200 ms,
    // no heartbeat in between), then the timeout fires (+300 ms) and its expiry is decided. Timer
    // lists run in the order they are due, and all three are due after the block.
    setTimeout(() => process.emit('SIGCONT', 'SIGCONT'), 200);
    busy(1000); // as long as a stop
    const at = await fired;
    // 1000 ms, less one heartbeat interval at most, are given back: about 200 ms remain after it
    assert.ok(at >= 1120 && at < 1500, `after a confirmed stop the timer expired at ${Math.round(at)} ms`);
  });
});

describe('runShell: a short real stop after a blocked loop gives back the stop only (r8 verification)', linux, () => {
  it('a 2.5 s timeout, a 1.5 s blocked loop, 400 ms later a 300 ms stop: it expires after about 2.8 s, not 3.9 s', async (t) => {
    const dir = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r8f-v-stop-'))));
    const file = path.join(dir, 'driver.mjs');
    fs.writeFileSync(
      file,
      `const { runShell } = await import(${JSON.stringify(PROCESS_JS)});
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
const running = runShell('echo $$ > sh.pid; sleep 30', { cwd: ${JSON.stringify(dir)}, timeoutMs: 2500 });
await new Promise((r) => setTimeout(r, 50));
busy(1500);
await new Promise((r) => setTimeout(r, 400));
process.stdout.write('stopping\\n');
process.kill(process.pid, 'SIGSTOP');
const r = await running;
process.stdout.write(JSON.stringify({ timedOut: r.timedOut, durationMs: r.durationMs }) + '\\n');
process.exit(0);
`,
    );
    const child = spawn(process.execPath, [file], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(child.pid!, 'SIGCONT');
          child.kill('SIGKILL');
        } catch {
          // gone
        }
      }
      const f = path.join(dir, 'sh.pid');
      const pid = fs.existsSync(f) ? Number.parseInt(fs.readFileSync(f, 'utf8'), 10) : NaN;
      if (pid > 0) {
        try {
          if (fs.readlinkSync(`/proc/${pid}/cwd`) === dir) process.kill(-pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
    });
    const until = async (cond: () => boolean, what: string, ms = 20_000): Promise<void> => {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) throw new Error(`timeout: ${what}; stdout ${JSON.stringify(out)} stderr ${JSON.stringify(err)}`);
        await sleep(5);
      }
    };
    await until(() => out.includes('stopping') && procState(child.pid!) === 'T', 'the driver stops itself');
    await sleep(300);
    process.kill(child.pid!, 'SIGCONT');
    await until(() => /"durationMs"/.test(out), 'the result');
    const r = JSON.parse(out.split('\n').find((l) => l.startsWith('{'))!) as { timedOut: boolean; durationMs: number };
    assert.equal(r.timedOut, true, JSON.stringify(r));
    // 2.5 s of running time plus the 300 ms stop (less at most a heartbeat of it); before, the
    // 1.5 s blocked loop was given back too (about 3.9 s)
    assert.ok(r.durationMs >= 2500 && r.durationMs < 3400, `timed out after ${r.durationMs} ms`);
  });
});
