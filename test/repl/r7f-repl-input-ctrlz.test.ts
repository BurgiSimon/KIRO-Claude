/**
 * Round-7 fix "repl-input" (finding #2): Ctrl+Z in the terminal chat.
 *
 * Before the fix the terminal reader let node's readline handle Ctrl+Z by itself: readline turned
 * raw mode off, sent SIGTSTP to kiro-claude alone and, on SIGCONT, paused its interface without
 * anybody resuming it (after `fg` nothing typed was read again). When the stop was discarded (an
 * orphaned process group: kiro-claude is the terminal's session leader) raw mode stayed off for
 * good: Enter arrived as LF (a soft newline), so nothing could be submitted, and Ctrl+D was a real
 * end of input taken for a hangup.
 *
 * Now the reader handles Ctrl+Z itself (the key hook, and readline's 'SIGTSTP' event as a
 * fallback): the terminal is handed back as a shell expects it (bracketed paste off, cooked mode),
 * SIGTSTP stops kiro-claude's process group (like the terminal's own Ctrl+Z and rustyline's
 * suspend), and once kill() returns (after SIGCONT, or at once when the stop was discarded) raw
 * mode, bracketed paste and the active read's prompt with its half-typed line come back.
 *
 * In-process: a fake TTY and a mocked process.kill (nothing is really stopped). The real terminal
 * (an interactive bash with job control, and the session leader) is covered by
 * r7f-repl-input-ctrlz-pty.test.ts.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { LineReader } from '../../src/repl/input.js';

const posix = process.platform !== 'win32';
const skip = posix ? false : 'POSIX job control';

interface Tty {
  r: LineReader;
  input: PassThrough;
  /** Raw-mode changes, kill() calls and output, in order. */
  log: string[];
  /** Entries after index `i`. */
  since: (i: number) => string[];
}

function ttyReader(t: TestContext, opts: { muted?: () => boolean; stopMs?: number; columns?: number } = {}): Tty {
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
  Object.assign(output, { isTTY: true, columns: opts.columns ?? 80 });
  // nothing is really stopped: the "stop" lasts stopMs (a shell's fg), or returns at once (discarded)
  t.mock.method(process, 'kill', (pid: number, sig?: string | number) => {
    log.push(`kill:${pid}:${String(sig)}`);
    if (opts.stopMs) {
      const end = Date.now() + opts.stopMs;
      while (Date.now() < end) {
        // the process is "stopped"
      }
    }
    return true;
  });
  // readline's own suspend (the pre-fix path) leaves a process.once('SIGCONT') behind: removed again
  const before = new Set(process.listeners('SIGCONT'));
  t.after(() => {
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l);
  });
  const r = new LineReader({ input, output, terminal: true, ...(opts.muted ? { muted: opts.muted } : {}) });
  t.after(() => r.close());
  return { r, input, log, since: (i) => log.slice(i) };
}

const tick = (ms = 10): Promise<void> => new Promise((res) => setTimeout(res, ms));
const outText = (entries: string[]): string =>
  entries
    .filter((e) => e.startsWith('out:'))
    .map((e) => e.slice(4))
    .join('');
const CTRL_Z = '\u001a';

test('r7f #2: Ctrl+Z at the prompt stops the process group, then raw mode, bracketed paste and the half-typed line come back', { skip }, async (t) => {
  const { r, input, log, since } = ttyReader(t);
  const p = r.readInput('> ', { history: true });
  input.write('half');
  await tick();
  const mark = log.length;
  input.write(CTRL_Z);
  await tick();
  const after = since(mark);
  const kill = after.findIndex((e) => e.startsWith('kill:'));
  assert.ok(kill >= 0, `no stop: ${JSON.stringify(after)}`);
  const rawOff = after.indexOf('raw:false');
  const rawOn = after.indexOf('raw:true');
  assert.ok(rawOff >= 0 && rawOff < kill, `raw mode is not turned off before the stop: ${JSON.stringify(after)}`);
  assert.ok(rawOn > kill, `raw mode is not turned back on after the stop: ${JSON.stringify(after)}`);
  // the whole process group, as the terminal's own Ctrl+Z (a wrapper such as npx stops too)
  assert.equal(after[kill], 'kill:0:SIGTSTP');
  const pasteOff = after.indexOf('out:\u001b[?2004l');
  const pasteOn = after.indexOf('out:\u001b[?2004h');
  assert.ok(pasteOff >= 0 && pasteOff < kill, `bracketed paste is not turned off before the stop: ${JSON.stringify(after)}`);
  assert.ok(pasteOn > kill, `bracketed paste is not turned back on: ${JSON.stringify(after)}`);
  assert.match(outText(after.slice(kill)), /> half/, 'the prompt and the half-typed line are drawn again');
  assert.equal(r.hungUp, false);
  assert.equal(r.reading, true);
  // the line is kept: typing goes on where it stopped, Enter submits it
  input.write(' more\r');
  assert.deepEqual(await p, { kind: 'line', text: 'half more' });
  assert.deepEqual(r.history(), ['half more']);
  assert.equal(r.hungUp, false);
});

test('r7f #2: Ctrl+Z while a turn runs (no read active) draws nothing and stops once, at the next prompt', { skip }, async (t) => {
  // r7 verification: never at once under a running turn (the r7 DECISION; since r8 stopped time no
  // longer counts against hook timeouts either); see r7f-repl-input-verify.test.ts
  const { r, input, log, since } = ttyReader(t);
  r.on('interrupt', () => undefined); // a turn is listening for Ctrl+C
  let p = r.readInput('> ');
  input.write('first\r');
  assert.deepEqual(await p, { kind: 'line', text: 'first' });
  const mark = log.length;
  input.write(CTRL_Z);
  await tick();
  const after = since(mark);
  assert.ok(!after.some((e) => e.startsWith('kill:')), `stopped under the running turn: ${JSON.stringify(after)}`);
  assert.doesNotMatch(outText(after), />/, 'a prompt was drawn over the turn output');
  const mark2 = log.length;
  p = r.readInput('> ');
  input.write('next\r');
  assert.deepEqual(await p, { kind: 'line', text: 'next' });
  assert.equal(since(mark2).filter((e) => e.startsWith('kill:')).length, 1, `not stopped once at the next prompt: ${JSON.stringify(since(mark2))}`);
});

test('r7f #2: Ctrl+Z at a nested read (an approval prompt) redraws that prompt; its answer and the prompt below still work', { skip }, async (t) => {
  const { r, input, log, since } = ttyReader(t);
  const idle = r.readInput('> ', { history: true });
  await tick();
  const ask = r.read('[y/n/t]: ', { discardTypeahead: true });
  await tick();
  const mark = log.length;
  input.write(CTRL_Z);
  await tick();
  const after = since(mark);
  const kill = after.indexOf('kill:0:SIGTSTP');
  assert.ok(kill >= 0 && after.indexOf('raw:true') > kill, JSON.stringify(after));
  assert.match(outText(after.slice(kill)), /\[y\/n\/t\]: /, 'the approval prompt is drawn again');
  input.write('y\r');
  assert.deepEqual(await ask, { kind: 'line', text: 'y' });
  await tick();
  input.write('next\r');
  assert.deepEqual(await idle, { kind: 'line', text: 'next' });
});

test('r7f #2: readline itself never suspends (its SIGTSTP event takes the same path)', { skip }, async (t) => {
  const { r, input, log, since } = ttyReader(t);
  const rl = (r as unknown as { rl: NodeJS.EventEmitter }).rl;
  assert.ok(rl.listenerCount('SIGTSTP') > 0, 'readline would suspend by itself (no SIGTSTP listener)');
  const p = r.readInput('> ');
  input.write('ab');
  await tick();
  const mark = log.length;
  rl.emit('SIGTSTP');
  const after = since(mark);
  const kill = after.indexOf('kill:0:SIGTSTP');
  assert.ok(kill >= 0 && after.indexOf('raw:true') > kill, JSON.stringify(after));
  input.write('c\r');
  assert.deepEqual(await p, { kind: 'line', text: 'abc' });
});

test('r7f #2: no stop while a child owns the terminal, while muted, or for a Ctrl+Z inside a paste', { skip }, async (t) => {
  // a child owns the terminal ($EDITOR, !cmd): its own job control applies; the key is dropped
  {
    const { r, input, log, since } = ttyReader(t);
    r.suspend();
    const mark = log.length;
    (r as unknown as { rl: { _ttyWrite: (s: string, k: object) => void } }).rl._ttyWrite(CTRL_Z, { ctrl: true, name: 'z', sequence: CTRL_Z });
    assert.deepEqual(since(mark), [], 'something happened while a child owned the terminal');
    r.resume();
    const mark2 = log.length;
    const p = r.readInput('> ');
    input.write('ok\r');
    assert.deepEqual(await p, { kind: 'line', text: 'ok' });
    assert.ok(!since(mark2).some((e) => e.startsWith('kill:')), `a dropped Ctrl+Z was replayed: ${JSON.stringify(since(mark2))}`);
  }
  // muted (a fatal signal's grace): keys are dropped, nothing is written
  {
    let muted = false;
    const { r, input, log, since } = ttyReader(t, { muted: () => muted });
    const p = r.readInput('> ');
    await tick();
    muted = true;
    const mark = log.length;
    input.write(CTRL_Z);
    await tick();
    assert.deepEqual(since(mark), []);
    muted = false;
    input.write('ok\r');
    assert.deepEqual(await p, { kind: 'line', text: 'ok' });
  }
  // pasted text never stops kiro-claude
  {
    const { r, input, log, since } = ttyReader(t);
    const p = r.readInput('> ');
    await tick();
    const mark = log.length;
    input.write(`\u001b[200~ab${CTRL_Z}cd\u001b[201~\r`);
    assert.deepEqual(await p, { kind: 'line', text: 'abcd' });
    assert.ok(!since(mark).some((e) => e.startsWith('kill:') || e.startsWith('raw:')), JSON.stringify(since(mark)));
  }
});

test('r7f #2: an input that wraps is redrawn on the shell\'s fresh line after a real stop, in place when the stop was discarded', { skip }, async (t) => {
  const long = 'a'.repeat(100); // '> ' + 100 columns: two rows of an 80-column terminal
  for (const [stopMs, wantUp] of [
    [150, false],
    [0, true],
  ] as const) {
    const { r, input, log, since } = ttyReader(t, { stopMs });
    const p = r.readInput('> ');
    input.write(long);
    await tick();
    const mark = log.length;
    input.write(CTRL_Z);
    await tick();
    const after = since(mark);
    const redraw = outText(after.slice(after.indexOf('kill:0:SIGTSTP')));
    assert.match(redraw, new RegExp(`> ${long}`), `stop ${stopMs} ms: the input is not drawn again`);
    // a real stop: the shell printed its lines and left the cursor on a fresh one, so the redraw
    // must not climb into them; a discarded stop: the input is still on screen, redrawn in place
    assert.equal(/\u001b\[\d*A/.test(redraw), wantUp, `stop ${stopMs} ms: ${JSON.stringify(redraw)}`);
    input.write('\r');
    assert.deepEqual(await p, { kind: 'line', text: long });
  }
});
