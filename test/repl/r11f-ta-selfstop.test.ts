/**
 * Round-11 fix "terminal-a" (findings #1 and #2), unit level (repl/input.ts). When kiro-claude
 * needs its terminal and is not in the terminal's foreground (the REPL's first prompt after a start
 * in the background; the REPL's hand-back after a child that had the terminal; the line reader
 * away after a stop and `bg`), it only polled /proc/self/stat every 20 ms and never stopped. Under
 * `sudo` with `use_pty` sudo hands its inner pty over only once it is continued itself, which
 * follows the command's job-control stop (bash's `fg` of a job it knows to be running sends no
 * SIGCONT): the chat never came up after `fg` (#2). And a `!bash -i` child SIGKILLed while it held
 * the terminal left its dead group in the foreground, with the shell blocked on the chat's job: the
 * chat polled for good (#1). Now, after each look that still finds it in the background while it
 * needs the terminal, it stops like a background job that reads its terminal (SIGTTIN to its
 * process group, stopForTerminal) and looks again only after the signals that came with the
 * continue (`kill %1`) were dispatched.
 *
 * In-process: the waitForForeground seams, and a fake TTY with a mocked process.kill and the
 * LineReaderOptions.foreground / stopInBackground seams (nothing is really stopped; the real
 * terminal is in r11f-ta-selfstop-pty.test.ts and r11f-ta-sudo-pty.test.ts).
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { FOREGROUND_POLL_MS, LineReader, stopForTerminal, waitForForeground } from '../../src/repl/input.js';

const posix = process.platform !== 'win32';
const skip = posix ? false : 'POSIX job control';

const tick = (ms = 10): Promise<void> => new Promise((res) => setTimeout(res, ms));

// ───────────────────────────── waitForForeground ─────────────────────────────

test('r11f #1/#2 waitForForeground: in the background it stops itself, only after a poll interval, and comes up once `fg` continues it', async () => {
  let fg = false;
  const events: string[] = [];
  const t0 = performance.now();
  let stopAt = 0;
  const p = waitForForeground(
    () => fg,
    () => false,
    () => {
      stopAt = performance.now() - t0;
      events.push('stop');
      fg = true; // `fg`: the shell hands the terminal over and continues the job (SIGCONT)
      return true;
    },
  );
  assert.equal(await p, true);
  assert.deepEqual(events, ['stop']);
  assert.ok(stopAt >= FOREGROUND_POLL_MS - 2, `stopped ${stopAt.toFixed(1)} ms after the first look (before a poll interval)`);
});

test('r11f #1/#2 waitForForeground: `kill %1` of the self-stopped chat (SIGTERM dispatched after the continue): false, no second stop', async () => {
  let muted = false;
  let stops = 0;
  const r = await waitForForeground(
    () => false,
    () => muted,
    () => {
      stops++;
      // the continue returns from the stop; the SIGTERM that came with it is dispatched in the
      // poll phase that follows (ExitSignals): muted from then on
      setImmediate(() => (muted = true));
      return true;
    },
  );
  assert.equal(r, false);
  assert.equal(stops, 1, 'stopped again before the signal that came with the continue was handled');
});

test('r11f #1/#2 waitForForeground: `fg` and a fatal signal with the same continue: false (nothing of the terminal is taken)', async () => {
  let fg = false;
  let muted = false;
  const r = await waitForForeground(
    () => fg,
    () => muted,
    () => {
      fg = true;
      setImmediate(() => (muted = true));
      return true;
    },
  );
  assert.equal(r, false);
});

test('r11f #2 waitForForeground: `bg` of the self-stopped chat (continued, still in the background): it stops again at the next look, not in a busy loop', async () => {
  let fg = false;
  const at: number[] = [];
  const p = waitForForeground(
    () => fg,
    () => false,
    () => {
      at.push(performance.now());
      if (at.length === 3) fg = true;
      return true;
    },
  );
  assert.equal(await p, true);
  assert.equal(at.length, 3);
  for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! >= FOREGROUND_POLL_MS - 2, `stops ${(at[i]! - at[i - 1]!).toFixed(1)} ms apart`);
});

test('r11f #1/#2 waitForForeground: a stop that is not sent or is discarded (orphaned group, ignored) leaves the poll as before; `fg` is still seen', async () => {
  for (const sent of [false, true]) {
    let fg = false;
    let stops = 0;
    const p = waitForForeground(
      () => fg,
      () => false,
      () => {
        stops++;
        return sent; // returns at once: nothing stopped
      },
    );
    await tick(200);
    // about one look per poll interval: neither a busy loop nor no look at all
    assert.ok(stops >= 3 && stops <= 200 / FOREGROUND_POLL_MS + 2, `${stops} stops in 200 ms (sent: ${sent})`);
    fg = true;
    assert.equal(await p, true);
  }
});

test('r11f #1/#2 waitForForeground: muted (a fatal signal is in) or in the foreground: no stop at all', async () => {
  let stops = 0;
  const stop = (): boolean => {
    stops++;
    return true;
  };
  assert.equal(await waitForForeground(() => false, () => true, stop), false);
  assert.equal(await waitForForeground(() => true, () => false, stop), true);
  let muted = false;
  const p = waitForForeground(() => false, () => muted, stop);
  await tick(FOREGROUND_POLL_MS / 2);
  muted = true; // during the first poll interval
  assert.equal(await p, false);
  assert.equal(stops, 0);
});

// ───────────────────────────── stopForTerminal ─────────────────────────────

test('r11f #1/#2 stopForTerminal: nothing for an input that is no terminal file descriptor or not the controlling terminal (no kill)', (t) => {
  const kills: string[] = [];
  t.mock.method(process, 'kill', (pid: number, sig?: string | number) => {
    kills.push(`${pid}:${String(sig)}`);
    return true;
  });
  assert.equal(stopForTerminal(new PassThrough()), false);
  assert.equal(stopForTerminal(undefined), false);
  assert.equal(stopForTerminal({ fd: 99_999 }), false);
  // the test runner's stdin: not a terminal here, or (run from a shell) the controlling terminal in
  // its foreground: either way nothing is stopped
  assert.equal(stopForTerminal(process.stdin), false);
  assert.deepEqual(kills, []);
});

// ───────────────────────────── the line reader ─────────────────────────────

interface Tty {
  r: LineReader;
  input: PassThrough;
  /** Raw-mode changes, kill() calls, stops and output, in order. */
  log: string[];
  since: (i: number) => string[];
}

function ttyReader(t: TestContext, opts: { foreground: () => boolean; stop?: () => boolean; muted?: () => boolean; onKill?: () => void }): Tty {
  const log: string[] = [];
  const input = new PassThrough();
  Object.assign(input, {
    isTTY: true,
    setRawMode: (on: boolean) => {
      log.push(`raw:${on}`);
      return input;
    },
  });
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      log.push(`out:${chunk.toString()}`);
      cb();
    },
  });
  Object.assign(output, { isTTY: true, columns: 80 });
  // nothing is really stopped: kill() returns at once (the continue), after onKill (what came with it)
  t.mock.method(process, 'kill', (pid: number, sig?: string | number) => {
    log.push(`kill:${pid}:${String(sig)}`);
    opts.onKill?.();
    return true;
  });
  const before = new Set(process.listeners('SIGCONT'));
  t.after(() => {
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l as () => void);
  });
  const r = new LineReader({
    input,
    output,
    terminal: true,
    foreground: opts.foreground,
    ...(opts.stop
      ? {
          stopInBackground: () => {
            log.push('self-stop');
            return opts.stop!();
          },
        }
      : {}),
    ...(opts.muted ? { muted: opts.muted } : {}),
  });
  t.after(() => r.close());
  return { r, input, log, since: (i) => log.slice(i) };
}

const CTRL_Z = '\u001a';
const outText = (entries: string[]): string =>
  entries
    .filter((e) => e.startsWith('out:'))
    .map((e) => e.slice(4))
    .join('');
const terminalTouched = (entries: string[]): string[] => entries.filter((e) => e.startsWith('raw:') || e.startsWith('out:'));
async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await tick(2);
  return cond();
}

/** Ctrl+Z at the active read, then `bg` (the stop returns in the background). */
async function ctrlZThenBg(x: Tty, setFg: (v: boolean) => void): Promise<number> {
  const mark = x.log.length;
  setFg(false);
  x.input.write(CTRL_Z);
  await tick();
  process.emit('SIGCONT');
  return mark;
}

test('r11f #2: Ctrl+Z at the prompt, `bg`: the reader stops itself again (after a poll interval, never inside the SIGCONT dispatch), touching nothing of the terminal; `fg` takes it back', { skip }, async (t) => {
  let fg = true;
  let stopped = 0;
  const x = ttyReader(t, {
    foreground: () => fg,
    stop: () => {
      stopped++;
      if (stopped === 2) fg = true; // the second stop: `fg` (SIGCONT, in the foreground)
      return true;
    },
  });
  const p = x.r.readInput('> ');
  x.input.write('ab');
  await tick();
  const mark = await ctrlZThenBg(x, (v) => (fg = v));
  assert.deepEqual(x.since(mark).filter((e) => e === 'self-stop'), [], 'stopped inside the SIGCONT dispatch');
  assert.ok(await until(() => stopped >= 1), 'the reader never stopped itself in the background');
  // the first self-stop returned still in the background (`bg`): stopped again at the next look
  assert.ok(await until(() => stopped >= 2), 'not stopped again after `bg` of the self-stopped chat');
  const after = x.since(mark);
  const first = after.indexOf('self-stop');
  assert.deepEqual(terminalTouched(after.slice(after.indexOf('kill:0:SIGTSTP') + 1, after.lastIndexOf('self-stop'))), [], `the terminal was touched in the background: ${JSON.stringify(after)}`);
  assert.ok(first > after.indexOf('kill:0:SIGTSTP'), JSON.stringify(after));
  // `fg` continued it in the foreground: taken back two loop turns later, the read drawn again
  assert.ok(await until(() => x.log.slice(mark).includes('raw:true')), `not taken back after fg: ${JSON.stringify(x.since(mark))}`);
  await tick();
  assert.match(outText(x.since(mark)), /> ab/);
  assert.equal(stopped, 2);
  x.input.write('c\r');
  assert.deepEqual(await p, { kind: 'line', text: 'abc' });
});

test('r11f #2: `kill %1` of the self-stopped reader (SIGTERM, then SIGCONT): nothing of the terminal is touched, no second stop', { skip }, async (t) => {
  let fg = true;
  let muted = false;
  let stopped = 0;
  const x = ttyReader(t, {
    foreground: () => fg,
    muted: () => muted,
    stop: () => {
      stopped++;
      // the SIGTERM listener (ExitSignals) runs in the poll phase after the stop returned
      setImmediate(() => (muted = true));
      return true;
    },
  });
  void x.r.readInput('> ');
  await tick();
  const mark = await ctrlZThenBg(x, (v) => (fg = v));
  assert.ok(await until(() => stopped >= 1));
  const atStop = x.log.length;
  await tick(150);
  assert.equal(stopped, 1, 'stopped again after the fatal signal');
  assert.deepEqual(terminalTouched(x.log.slice(atStop)), [], `the terminal was touched after the signal: ${JSON.stringify(x.since(mark))}`);
  assert.equal(x.input.isPaused(), true, 'the input is read again (a read from the background stops the close: SIGTTIN)');
});

test('r11f #2: a turn running in the background (no read waits) is not stopped; its prompt stops the chat once it is due', { skip }, async (t) => {
  let fg = false;
  let stopped = 0;
  const x = ttyReader(t, {
    foreground: () => fg,
    stop: () => {
      stopped++;
      fg = true;
      return true;
    },
  });
  x.r.on('interrupt', () => undefined); // a turn runs
  const mark = x.log.length;
  process.emit('SIGCONT'); // a stop from elsewhere, continued in the background (`bg`)
  await tick(200);
  assert.equal(stopped, 0, 'stopped while no read waited for the terminal (a turn runs)');
  // the turn ends: its prompt needs the terminal
  const p = x.r.readInput('> ');
  assert.ok(await until(() => stopped === 1), 'the prompt did not stop the chat in the background');
  assert.ok(await until(() => x.log.slice(mark).includes('raw:true')), 'not taken back after fg');
  await tick();
  assert.equal(outText(x.since(mark)).match(/> /g)?.length, 1, JSON.stringify(outText(x.since(mark))));
  x.input.write('next\r');
  assert.deepEqual(await p, { kind: 'line', text: 'next' });
});

test('r11f #2: an approval read (discarding type-ahead) away in the background stops the chat too; after `fg` its answer is typed at its question', { skip }, async (t) => {
  let fg = false;
  let stopped = 0;
  const x = ttyReader(t, {
    foreground: () => fg,
    stop: () => {
      stopped++;
      fg = true;
      return true;
    },
  });
  x.r.on('interrupt', () => undefined);
  process.emit('SIGCONT');
  await tick(50);
  const p = x.r.read('Allow this action? [y/n/t]: ', { discardTypeahead: true });
  assert.ok(await until(() => stopped === 1), 'the approval prompt did not stop the chat in the background');
  // `y` + Return queued in the cooked window right after fg: no answer (r10 verification)
  x.input.write('y\n');
  const pending = await Promise.race([p, tick(150).then(() => 'still waiting' as const)]);
  assert.equal(pending, 'still waiting', 'a Return queued before the question was drawn again answered it');
  x.input.write('n\r');
  assert.deepEqual(await p, { kind: 'line', text: 'y\nn' });
});

test('r11f #2: muted (a fatal signal is in), or a stop not sent (orphaned group, not the controlling terminal): no stop; the poll still sees `fg`', { skip }, async (t) => {
  let fg = false;
  let stopped = 0;
  const muted = { v: true };
  const x = ttyReader(t, {
    foreground: () => fg,
    muted: () => muted.v,
    stop: () => {
      stopped++;
      return false;
    },
  });
  void x.r.readInput('> ');
  process.emit('SIGCONT');
  await tick(150);
  assert.equal(stopped, 0, 'stopped while muted');
  // not muted: the stop is asked for but not sent; the reader keeps looking
  muted.v = false;
  process.emit('SIGCONT');
  assert.ok(await until(() => stopped >= 3), 'the reader stopped looking after a stop that was not sent');
  const mark = x.log.length;
  fg = true;
  assert.ok(await until(() => x.log.slice(mark).includes('raw:true')), 'fg not seen after a stop that was not sent');
});

test('r11f #2: the default stop (stopForTerminal) never stops the process for an input that is not the controlling terminal', { skip }, async (t) => {
  let fg = false;
  const x = ttyReader(t, { foreground: () => fg });
  void x.r.readInput('> ');
  const mark = x.log.length;
  process.emit('SIGCONT');
  await tick(200);
  assert.deepEqual(x.since(mark).filter((e) => e.startsWith('kill:')), [], 'a real stop was sent for a fake terminal');
  fg = true;
  assert.ok(await until(() => x.log.slice(mark).includes('raw:true')));
});
