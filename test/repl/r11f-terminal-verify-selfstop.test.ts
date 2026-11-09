/**
 * Round-11 verification of the "terminal-a" self-stop (repl/input.ts stopForTerminal), unit level:
 * the signal of each self-stop. SIGTTIN normally ('Stopped (tty input)'). Under `sudo` with
 * `use_pty`, sudo in the foreground answers a command's SIGTTIN by resuming it in the foreground
 * at once, giving its inner pty to the process group that had it at the stop; after a `!bash -i`
 * that died holding that pty the group is a dead one, so the chat stopped and was continued every
 * poll while the user's shell never got its terminal back. A self-stop that comes back at once
 * (TerminalStops, STOP_ANSWERED_MS) is followed by a SIGTSTP, which sudo answers by suspending
 * itself; one that lasts (a person's `bg`, `kill -CONT`) by a SIGTTIN again; a SIGTSTP that never
 * stopped it (back within STOP_DISCARDED_MS: an orphaned process group discards both) is not sent
 * again in that stretch, one continued soon after (an automated `fg`) still is.
 * The real terminal is in r11f-terminal-verify-sudo-pty.test.ts.
 *
 * In-process: the waitForForeground seams, and a fake TTY with a mocked process.kill and the
 * LineReaderOptions.foreground / stopInBackground seams (nothing is really stopped).
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { LineReader, STOP_ANSWERED_MS, STOP_DISCARDED_MS, TerminalStops, waitForForeground, type TerminalStop } from '../../src/repl/input.js';

const skip = process.platform === 'win32' ? 'POSIX job control' : false;
const tick = (ms = 10): Promise<void> => new Promise((res) => setTimeout(res, ms));
/** A stop that lasts (a person's `bg` or `kill -CONT` continues it): the event loop is held that long. */
const lasting = (): void => {
  const end = performance.now() + STOP_ANSWERED_MS + 15;
  while (performance.now() < end) {
    // stopped
  }
};
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await tick(2);
  return cond();
}

test('r11f verify TerminalStops: SIGTTIN first; SIGTSTP after a SIGTTIN that came back at once; SIGTTIN after one that lasted; no SIGTSTP again once one never stopped', () => {
  const sent = (s: TerminalStops, ms: number): TerminalStop => {
    s.sent(ms);
    return s.next;
  };
  const a = new TerminalStops();
  assert.equal(a.next, 'SIGTTIN');
  assert.equal(sent(a, STOP_ANSWERED_MS), 'SIGTTIN', 'a stop that lasted');
  assert.equal(sent(a, STOP_ANSWERED_MS - 1), 'SIGTSTP', 'a SIGTTIN answered at once (sudo resumed it without the terminal)');
  assert.equal(sent(a, 5000), 'SIGTTIN', 'the SIGTSTP lasted (sudo suspended itself; `fg`)');
  assert.equal(sent(a, 0), 'SIGTSTP', 'answered at once again');
  // a SIGTSTP continued soon (an automated `fg` right after bash said 'Stopped') still helps
  assert.equal(sent(a, STOP_DISCARDED_MS + 8), 'SIGTTIN');
  assert.equal(sent(a, 0.3), 'SIGTSTP', 'SIGTSTP no longer sent after one that was continued soon (it stopped the chat)');
  // a SIGTSTP that could not be sent (a listener for it): SIGTTIN next
  a.notSent();
  assert.equal(a.next, 'SIGTTIN');
  // an orphaned process group: every stop comes back at once
  const b = new TerminalStops();
  assert.deepEqual([sent(b, 0), sent(b, 0), sent(b, 0), sent(b, 0)], ['SIGTSTP', 'SIGTTIN', 'SIGTTIN', 'SIGTTIN']);
});

/** A clock for waitForForeground's measure of each stop (the seam says how long it lasted). */
function stopClock(t: TestContext): { advance: (ms: number) => void } {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  return { advance: (ms) => (now += ms) };
}

test('r11f verify waitForForeground: the first stop is SIGTTIN; one answered at once is followed by SIGTSTP, one that lasted by SIGTTIN; `fg` ends the wait', async (t) => {
  const clock = stopClock(t);
  let fg = false;
  const signals: TerminalStop[] = [];
  const r = await waitForForeground(
    () => fg,
    () => false,
    (signal) => {
      signals.push(signal);
      // 1st: answered at once (sudo resumes it without the terminal: half a millisecond); 2nd:
      // lasts (sudo suspended itself, `bg` 10 ms later, automated); 3rd: answered at once again;
      // 4th: `fg`
      clock.advance(signals.length === 2 ? STOP_DISCARDED_MS + 8 : 0.5);
      if (signals.length === 4) fg = true;
      return true;
    },
  );
  assert.equal(r, true);
  assert.deepEqual(signals, ['SIGTTIN', 'SIGTSTP', 'SIGTTIN', 'SIGTSTP']);
});

test('r11f verify waitForForeground: every stop discarded (an orphaned group): one SIGTSTP, then SIGTTIN only', async (t) => {
  stopClock(t); // each stop returns at once (no time passes)
  let fg = false;
  const signals: TerminalStop[] = [];
  await waitForForeground(
    () => fg,
    () => false,
    (signal) => {
      signals.push(signal);
      if (signals.length === 5) fg = true;
      return true;
    },
  );
  assert.deepEqual(signals, ['SIGTTIN', 'SIGTSTP', 'SIGTTIN', 'SIGTTIN', 'SIGTTIN']);
});

test('r11f verify waitForForeground: a SIGTSTP that cannot be sent (a listener for it) is followed by a SIGTTIN again, not by no stop at all', async (t) => {
  stopClock(t);
  let fg = false;
  const signals: TerminalStop[] = [];
  await waitForForeground(
    () => fg,
    () => false,
    (signal) => {
      signals.push(signal);
      if (signals.length === 4) fg = true;
      return signal === 'SIGTTIN';
    },
  );
  assert.deepEqual(signals, ['SIGTTIN', 'SIGTSTP', 'SIGTTIN', 'SIGTSTP']);
});

test('r11f verify waitForForeground: a stop that is not sent leaves the next one a SIGTTIN; each wait starts with SIGTTIN', async () => {
  let n = 0;
  const signals: TerminalStop[] = [];
  let fg = false;
  await waitForForeground(
    () => fg,
    () => false,
    (signal) => {
      signals.push(signal);
      if (++n === 3) fg = true;
      return false; // not sent (no controlling terminal, a listener)
    },
  );
  assert.deepEqual(signals, ['SIGTTIN', 'SIGTTIN', 'SIGTTIN']);
  const next: TerminalStop[] = [];
  fg = false;
  await waitForForeground(
    () => fg,
    () => false,
    (signal) => {
      next.push(signal);
      fg = true;
      return true;
    },
  );
  assert.deepEqual(next, ['SIGTTIN']);
});

// ───────────────────────────── the line reader ─────────────────────────────

function ttyReader(t: TestContext, foreground: () => boolean, stop: (signal: TerminalStop) => boolean): { r: LineReader; input: PassThrough } {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => input });
  const output = new Writable({ write: (_c, _e, cb) => cb() });
  Object.assign(output, { isTTY: true, columns: 80 });
  // nothing is really stopped: the reader's Ctrl+Z kill() returns at once (the continue)
  t.mock.method(process, 'kill', () => true);
  const before = new Set(process.listeners('SIGCONT'));
  t.after(() => {
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l as () => void);
  });
  const r = new LineReader({ input, output, terminal: true, foreground, stopInBackground: stop });
  t.after(() => r.close());
  return { r, input };
}

test('r11f verify LineReader: away in the background, a self-stop answered at once is followed by SIGTSTP, one that lasted by SIGTTIN; after the retake it starts with SIGTTIN again', { skip }, async (t) => {
  let fg = true;
  const signals: TerminalStop[] = [];
  let script: ((n: number) => void) | undefined;
  const x = ttyReader(
    t,
    () => fg,
    (signal) => {
      signals.push(signal);
      script?.(signals.length);
      return true;
    },
  );
  const p = x.r.readInput('> ');
  x.input.write('ab');
  await tick();
  // Ctrl+Z, `bg`: away in the background
  script = (n) => {
    if (n === 2) lasting();
    if (n === 3) fg = true; // `fg`
  };
  fg = false;
  x.input.write('\u001a');
  await tick();
  process.emit('SIGCONT');
  assert.ok(await until(() => signals.length >= 3), `the reader did not stop itself three times: ${JSON.stringify(signals)}`);
  assert.deepEqual(signals, ['SIGTTIN', 'SIGTSTP', 'SIGTTIN']);
  // taken back in the foreground; the next stretch in the background starts with SIGTTIN
  await tick(50);
  script = (n) => {
    if (n === 4) fg = true;
  };
  fg = false;
  x.input.write('\u001a');
  await tick();
  process.emit('SIGCONT');
  assert.ok(await until(() => signals.length >= 4), JSON.stringify(signals));
  assert.equal(signals[3], 'SIGTTIN', `the retake did not reset the stop signal: ${JSON.stringify(signals)}`);
  await tick(50);
  x.input.write('c\r');
  assert.deepEqual(await p, { kind: 'line', text: 'abc' });
});
