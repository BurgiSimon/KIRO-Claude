/**
 * Round-10 verification of the "terminal" group's fix for #2 (repl/input.ts cookedKeys /
 * takeCooked), unit level with a fake terminal (the LineReaderOptions.foreground seam stands for
 * the shell's `fg`, process.emit('SIGCONT') for `bg`).
 *
 * The fix reads the keys the terminal queued in a cooked mode as typed there (a newline is Return,
 * a NUL at a line start Ctrl+D) whenever the reader turned raw mode on again. Two cases went
 * further than the finding (a line typed in the window between `fg` of the running chat and the
 * reader's retake, the chat having been away in the background):
 *
 *  - An approval prompt (a read that discards type-ahead) took such a Return as its answer: keys
 *    typed blind while an approval-time `!cmd` ran (the question not on the screen), or into the
 *    shell's type-ahead before `fg`, answered `y` with no Enter typed at the question. Before r10
 *    (and in Q, whose rustyline reads that newline as Ctrl+J, bound to insert a new line) the
 *    answer needed an Enter. Now an approval read never takes a cooked Return or Ctrl+D.
 *  - After a child that ended with kiro-claude in the foreground (a `!cmd` that did not read what
 *    was typed meanwhile), and when the chat started in the foreground, every queued line was
 *    submitted on its own: a multi-line paste became several prompts, and a pasted line starting
 *    with `!` ran as a shell command (r10f-terminal-verify-pty.test.ts). Before r10 and in Q the
 *    newlines were soft (one input, nothing run before Enter). Now resume() and the reader's
 *    creation read the queue as cooked only after a stretch in the background (`resume(true)`,
 *    LineReaderOptions.cooked: the window the reader's own foreground poll leaves open).
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { LineReader, type LineReaderOptions, type ReadResult } from '../../src/repl/input.js';

const skip = process.platform === 'win32' ? 'POSIX job control' : false;

const tick = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await tick(2);
  return cond();
}
const race = (p: Promise<ReadResult>, ms: number): Promise<ReadResult | 'still waiting'> => Promise.race([p, tick(ms).then(() => 'still waiting' as const)]);

function ttyReader(t: TestContext, foreground: () => boolean, extra: Partial<LineReaderOptions> = {}): { r: LineReader; input: PassThrough; raw: () => boolean[] } {
  const modes: boolean[] = [];
  const input = new PassThrough();
  Object.assign(input, {
    isTTY: true,
    setRawMode: (on: boolean) => {
      modes.push(on);
      return input;
    },
  });
  const output = new Writable({
    write(_chunk: Buffer, _enc, cb) {
      cb();
    },
  });
  Object.assign(output, { isTTY: true, columns: 80 });
  const before = new Set(process.listeners('SIGCONT'));
  t.after(() => {
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l as () => void);
  });
  // (an object literal typed loosely: `cooked` is the option this file checks)
  const opts = { input, output, terminal: true, foreground, ...extra } as LineReaderOptions;
  const r = new LineReader(opts);
  t.after(() => r.close());
  return { r, input, raw: () => modes };
}

/** resume() as after a child that ended while kiro-claude was in the background (handBack waited for `fg`). */
const resumeAfterBackground = (r: LineReader): void => (r.resume as (cooked?: boolean) => void).call(r, true);

// ───────────────────────────── approval prompts ─────────────────────────────

test('r10f verify: keys typed blind during an approval-time `!cmd` do not answer the approval prompt (their Return stays a new line)', { skip }, async (t) => {
  const { r, input } = ttyReader(t, () => true);
  // the approval prompt; the user types `!make` there (repl/core.ts approvalFlow → runBang)
  r.suspend();
  // during the child, not read by it: "y" + Return in its cooked terminal (ICRNL: a newline)
  input.write('y\n');
  await tick(20);
  // the child ended while kiro-claude was in the background; handBack waited for `fg`
  resumeAfterBackground(r);
  // the question is asked again: a read that drops type-ahead
  const p = r.read('> ', { discardTypeahead: true });
  assert.equal(await race(p, 300), 'still waiting', 'a Return typed before the question was shown again allowed the tool');
  // an Enter typed at the question is the answer
  input.write('\r');
  const res = await race(p, 1500);
  assert.equal(res !== 'still waiting' && res.kind, 'line');
});

test('r10f verify: after `fg` of the running chat, a Return queued in the cooked window does not answer an approval prompt', { skip }, async (t) => {
  let fg = false;
  let asked = 0;
  const { r, input, raw } = ttyReader(t, () => {
    asked++;
    return fg;
  });
  // an approval prompt is up; Ctrl+Z there, then `bg`: away, polling the foreground
  const p = r.read('> ', { discardTypeahead: true });
  await tick(10);
  process.emit('SIGCONT');
  assert.ok(await until(() => asked >= 2, 2000), 'the reader never looked at the foreground');
  // `sleep 1; fg` with "y" + Return typed during the sleep: queued cooked
  fg = true;
  input.write('y\n');
  assert.ok(await until(() => raw().includes(true), 1000), 'raw mode never taken back');
  assert.equal(await race(p, 300), 'still waiting', 'a Return typed into the shell before `fg` allowed the tool');
  input.write('\r');
  const res = await race(p, 1500);
  assert.equal(res !== 'still waiting' && res.kind, 'line');
});

test('r10f verify control: at the chat prompt the same window is read as typed (the r10 #2 fix)', { skip }, async (t) => {
  const { r, input } = ttyReader(t, () => true);
  const p = r.readInput('> ');
  await tick(10);
  r.suspend();
  input.write('hello\n');
  await tick(20);
  resumeAfterBackground(r);
  assert.deepEqual(await race(p, 1500), { kind: 'line', text: 'hello' });
});

// ───────────────────────────── outside a background stretch ─────────────────────────────

test('r10f verify: after a `!cmd` that ended in the foreground, lines typed during it stay one input (a pasted `!` line is not run): as before r10 and in Q', { skip }, async (t) => {
  const { r, input } = ttyReader(t, () => true);
  const p = r.readInput('> ');
  await tick(10);
  r.suspend();
  // a multi-line paste into the child's cooked terminal (no brackets there), not read by it
  input.write('first line\n!touch pasted\n');
  await tick(20);
  r.resume();
  assert.equal(await race(p, 300), 'still waiting', 'a pasted line was submitted on its own');
  input.write('\r');
  const res = await race(p, 1500);
  assert.ok(res !== 'still waiting' && res.kind === 'line' && res.text.startsWith('first line\n!touch pasted'), JSON.stringify(res));
});

test('r10f verify: a reader created after the chat waited in the background for `fg` reads the queued keys as typed (LineReaderOptions.cooked); one created in the foreground does not', { skip }, async (t) => {
  const a = ttyReader(t, () => true, { cooked: true } as Partial<LineReaderOptions>);
  a.input.write('hello\n');
  assert.deepEqual(await race(a.r.readInput('> '), 1500), { kind: 'line', text: 'hello' }, '`chat &`, `sleep 1; fg` with hello + Enter typed during the sleep');
  const b = ttyReader(t, () => true);
  b.input.write('one\ntwo\n');
  assert.equal(await race(b.r.readInput('> '), 300), 'still waiting', 'lines typed while the chat started in the foreground were submitted');
});
