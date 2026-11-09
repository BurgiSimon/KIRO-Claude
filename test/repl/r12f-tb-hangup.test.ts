/**
 * Round-12 fix "terminal-b" #4/#8, unit level: the end of the terminal session while kiro-claude
 * waits off the terminal, and a reader created on a hung-up terminal.
 *
 * A chat waiting off the terminal in an orphaned background group (`bash -mc 'kiro-claude chat &
 * sleep 1'` once that shell exited) gets no SIGHUP when the terminal closes; the hangup takes its
 * controlling terminal away, which read as "cannot be told" (= the foreground), so the wait ended
 * and Repl.run created the reader outside the try that closes the session: readline's constructor
 * turned raw mode on before LineReader's 'error' listener existed, the EIO was thrown out of it,
 * and the chat ended with 'setRawMode EIO', exit 1, no SessionEnd, its lock left. Now:
 *  - LineReader: readline's own raw switch is a no-op, and the reader switches once its 'error'
 *    listener is there: an EIO is the input's end (hungUp, every read `eof`), never a throw;
 *  - Repl.run creates the reader inside that try (a reader that cannot be created still closes);
 *  - waitForForeground takes a `gone` seam (input.ts terminalGone): the loss of the controlling
 *    terminal ends the wait, which the REPL closes as a hangup whose SIGHUP never comes;
 *  - the reader away after a stop whose input stops being the controlling terminal ends its input
 *    as at a hangup, the terminal not touched.
 *
 * In-process: fake TTYs and the seams (the real case: r12f-tb-orphan-pty.test.ts).
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import * as inputMod from '../../src/repl/input.js';
import type { TerminalStop } from '../../src/repl/input.js';
import { startRepl } from './harness.js';

// (a namespace import: a check fails on its own where an export is missing, not the whole file)
const { LineReader, waitForForeground } = inputMod;
type LineReader = InstanceType<typeof inputMod.LineReader>;

const skip = process.platform === 'win32' ? 'POSIX job control' : false;

const eio = (): NodeJS.ErrnoException => Object.assign(new Error('setRawMode EIO'), { code: 'EIO', errno: -5, syscall: 'setRawMode' });

/**
 * A fake TTY input whose setRawMode emits 'error' (EIO) as a hung-up tty.ReadStream does (no
 * throw: tty.ReadStream.setRawMode emits it), with its setRawMode an own property or a prototype
 * one (a tty.ReadStream's).
 */
function hungUpTty(own: boolean, log: string[]): PassThrough {
  const input = new PassThrough();
  const setRawMode = function (this: PassThrough, on: boolean): PassThrough {
    log.push(`raw:${on}`);
    input.emit('error', eio());
    return input;
  };
  if (own) Object.assign(input, { isTTY: true, setRawMode });
  else {
    const proto = Object.create(Object.getPrototypeOf(input) as object) as { setRawMode: typeof setRawMode };
    proto.setRawMode = setRawMode;
    Object.setPrototypeOf(input, proto);
    Object.assign(input, { isTTY: true });
  }
  return input;
}

function ttyOutput(log: string[]): Writable {
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      log.push(`out:${chunk.toString()}`);
      cb();
    },
  });
  Object.assign(output, { isTTY: true, columns: 80 });
  return output;
}

function cleanSigcont(t: TestContext): void {
  const before = new Set(process.listeners('SIGCONT'));
  t.after(() => {
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l as () => void);
  });
}

test('r12f #4/#8: a reader created on a hung-up terminal (setRawMode EIO) does not throw: its input ended as at a hangup, every read gets eof', { skip }, async (t) => {
  for (const own of [true, false]) {
    cleanSigcont(t);
    const log: string[] = [];
    const input = hungUpTty(own, log);
    const before = (input as unknown as { setRawMode: unknown }).setRawMode;
    let r: LineReader | undefined;
    assert.doesNotThrow(() => {
      r = new LineReader({ input, output: ttyOutput(log), terminal: true });
    }, `the raw switch's EIO was thrown out of the constructor (own setRawMode: ${own})`);
    assert.ok(r);
    t.after(() => r?.close());
    assert.equal(r.hungUp, true, 'a hung-up terminal: its SIGHUP is on its way (the REPL waits for it)');
    assert.deepEqual(await r.readInput('> '), { kind: 'eof' });
    assert.deepEqual(await r.read('? '), { kind: 'eof' });
    assert.deepEqual(log.filter((e) => e.startsWith('raw:')), ['raw:true'], 'raw mode is asked for once, by the reader');
    assert.ok(!log.includes('out:\u001b[?2004h'), 'nothing more is written once the input ended');
    // the input keeps its own setRawMode (the no-op stand-in during readline's constructor is gone)
    assert.equal((input as unknown as { setRawMode: unknown }).setRawMode, before);
    assert.equal(Object.prototype.hasOwnProperty.call(input, 'setRawMode'), own);
  }
});

test('r12f #4/#8 control: on a working terminal the reader turns raw mode on once, then bracketed paste, as before', { skip }, (t) => {
  cleanSigcont(t);
  const log: string[] = [];
  const input = new PassThrough();
  Object.assign(input, {
    isTTY: true,
    setRawMode: (on: boolean) => {
      log.push(`raw:${on}`);
      return input;
    },
  });
  const r = new LineReader({ input, output: ttyOutput(log), terminal: true });
  t.after(() => r.close());
  assert.deepEqual(log, ['raw:true', 'out:\u001b[?2004h']);
  assert.equal(r.hungUp, false);
});

test('r12f #4/#8: the REPL whose terminal hung up before its reader exists closes its session (no "setRawMode EIO" error, no rejection)', { skip }, async (t) => {
  cleanSigcont(t);
  const run = startRepl({ tty: true, keepOpen: true });
  t.after(() => run.t.cleanup());
  // the hung-up terminal: every raw-mode switch fails with EIO (emitted, as tty.ReadStream does)
  Object.assign(run.stdin, {
    setRawMode: () => {
      run.stdin.emit('error', eio());
      return run.stdin;
    },
  });
  const code = await Promise.race([run.exit, new Promise<string>((res) => setTimeout(() => res('timeout'), 10_000))]);
  assert.notEqual(code, 'timeout', 'the REPL did not end');
  assert.equal(run.session.closed, true, 'the session was not closed (no SessionEnd, lock left)');
  assert.doesNotMatch(run.out() + run.err(), /setRawMode|EIO/);
  assert.equal(code, 0);
});

test('r12f #4/#8: waitForForeground ends (false) once the terminal is gone, which "cannot be told" made look like the foreground; no stop for it', async () => {
  let isGone = false;
  let fg = false;
  const stops: TerminalStop[] = [];
  const p = waitForForeground(
    () => fg,
    () => false,
    (sig) => {
      stops.push(sig);
      return false;
    },
    () => isGone,
  );
  await new Promise((res) => setTimeout(res, 70));
  // the hangup: the controlling terminal goes away, and /proc then says nothing: "the foreground"
  isGone = true;
  fg = true;
  assert.equal(await p, false, 'the wait took the gone terminal for the foreground (the reader was created on it)');
  const before = stops.length;
  assert.equal(await waitForForeground(() => true, () => false, () => true, () => true), false, 'gone before the wait');
  assert.equal(stops.length, before);
  // controls: without `gone` the foreground ends the wait as before; muted wins
  assert.equal(await waitForForeground(() => true, () => false, () => true), true);
  assert.equal(await waitForForeground(() => true, () => true, () => true, () => false), false);
});

test('r12f #4/#8: terminalGone is never true for an input that is not the controlling terminal (fakes, a pipe; off Linux)', () => {
  for (const input of [new PassThrough(), undefined, { fd: 99_999 }]) assert.equal(inputMod.terminalGone(input)(), false);
});

test('r12f #4/#8: away after a stop, an input that stops being the controlling terminal ends as at a hangup at the retake, the terminal not touched', { skip }, async (t) => {
  cleanSigcont(t);
  const log: string[] = [];
  const input = new PassThrough();
  Object.assign(input, {
    isTTY: true,
    setRawMode: (on: boolean) => {
      log.push(`raw:${on}`);
      return input;
    },
  });
  let controlling = true;
  let fg = false;
  const r = new LineReader({
    input,
    output: ttyOutput(log),
    terminal: true,
    foreground: () => fg,
    stopInBackground: () => false,
    controlling: () => controlling,
  });
  t.after(() => r.close());
  const p = r.readInput('> ');
  await new Promise((res) => setImmediate(res));
  // a stop from elsewhere, continued in the background (`bg`): away, polling the foreground
  process.emit('SIGCONT');
  await new Promise((res) => setTimeout(res, 60));
  const mark = log.length;
  // the terminal session ends: no SIGHUP for this (orphaned, running) group; "cannot be told" = foreground
  controlling = false;
  fg = true;
  assert.deepEqual(await Promise.race([p, new Promise((res) => setTimeout(() => res('pending'), 2000))]), { kind: 'eof' });
  assert.equal(r.hungUp, true, 'the REPL waits for the SIGHUP of a hangup, then closes');
  assert.deepEqual(log.slice(mark), [], 'the terminal was touched (raw mode, the prompt) after the session ended');
});

test('r12f #4/#8 control: away after a stop, the controlling terminal still there: `fg` takes it back as before', { skip }, async (t) => {
  cleanSigcont(t);
  const log: string[] = [];
  const input = new PassThrough();
  Object.assign(input, {
    isTTY: true,
    setRawMode: (on: boolean) => {
      log.push(`raw:${on}`);
      return input;
    },
  });
  let fg = false;
  const r = new LineReader({ input, output: ttyOutput(log), terminal: true, foreground: () => fg, stopInBackground: () => false, controlling: () => true });
  t.after(() => r.close());
  const p = r.readInput('> ');
  await new Promise((res) => setImmediate(res));
  process.emit('SIGCONT');
  await new Promise((res) => setTimeout(res, 60));
  const mark = log.length;
  fg = true;
  await new Promise((res) => setTimeout(res, 80));
  assert.ok(log.slice(mark).includes('raw:true'), `not taken back: ${JSON.stringify(log.slice(mark))}`);
  assert.equal(r.hungUp, false);
  input.write('hi\r');
  assert.deepEqual(await p, { kind: 'line', text: 'hi' });
});
