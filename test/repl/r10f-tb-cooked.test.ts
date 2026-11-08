/**
 * Round-10 fix "terminal-b" #2, unit level (repl/input.ts). After Ctrl+Z and `bg`, bash's `fg` of
 * the RUNNING chat sends no SIGCONT, so the reader (away, input paused) noticed the foreground only
 * at its next poll, up to 250 ms later. Until then the terminal is in the shell's cooked mode
 * (ICANON, ECHO, ICRNL): a line typed in that window was echoed by the terminal and its Return
 * queued as LF, which the reader read as Ctrl+J (a soft newline): the line was not submitted; a
 * Ctrl+D (canonical mode keeps it as a NUL placeholder) was dropped. Now the reader asks every
 * FOREGROUND_POLL_MS (20 ms) while away in the background, and what it reads right after it takes
 * the terminal back from the shell's cooked mode (a retake after a stop, resume(true) after a child
 * that ended in the background) is read as typed there (cookedKeys): LF is Return, a NUL at a line
 * start is Ctrl+D. A key typed later is raw
 * (Ctrl+J stays a soft newline), and so is everything from a bracketed-paste start on.
 *
 * In-process with a fake terminal (the LineReaderOptions.foreground seam stands for the shell's
 * `fg`; process.emit('SIGCONT') for `bg`). The real terminal is in r10f-tb-fg-pty.test.ts.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { FOREGROUND_POLL_MS, LineReader, cookedKeys, type ReadResult } from '../../src/repl/input.js';

const skip = process.platform === 'win32' ? 'POSIX job control' : false;

interface Ev {
  at: number;
  e: string;
}

function ttyReader(t: TestContext, foreground: () => boolean): { r: LineReader; input: PassThrough; log: Ev[] } {
  const log: Ev[] = [];
  const input = new PassThrough();
  Object.assign(input, {
    isTTY: true,
    setRawMode: (on: boolean) => {
      log.push({ at: performance.now(), e: `raw:${on}` });
      return input;
    },
  });
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      log.push({ at: performance.now(), e: `out:${chunk.toString()}` });
      cb();
    },
  });
  Object.assign(output, { isTTY: true, columns: 80 });
  const before = new Set(process.listeners('SIGCONT'));
  t.after(() => {
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l as () => void);
  });
  const r = new LineReader({ input, output, terminal: true, foreground });
  t.after(() => r.close());
  return { r, input, log };
}

const tick = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await tick(2);
  return cond();
}
const race = (p: Promise<ReadResult>, ms: number): Promise<ReadResult | 'still waiting'> => Promise.race([p, tick(ms).then(() => 'still waiting' as const)]);

/** Continued in the background (`bg`): away, polling the foreground; `fg()` hands the terminal back. */
async function inBackground(t: TestContext): Promise<{ r: LineReader; input: PassThrough; log: Ev[]; fg: () => void; asked: () => number }> {
  let fg = false;
  let asked = 0;
  const { r, input, log } = ttyReader(t, () => {
    asked++;
    return fg;
  });
  await tick(10);
  process.emit('SIGCONT');
  assert.ok(await until(() => asked >= 2, 2000), 'the reader never looked at the foreground');
  return { r, input, log, fg: () => (fg = true), asked: () => asked };
}

// ───────────────────────────── cookedKeys ─────────────────────────────

test('r10f #2 cookedKeys: LF (ICRNL\'s Return) becomes CR, in place; other bytes stay', () => {
  const b = Buffer.from('hello\nworld\n');
  const r = cookedKeys(b);
  assert.equal(b.toString(), 'hello\rworld\r');
  assert.deepEqual(r, { lineStart: true, raw: false });
  const c = Buffer.from('half');
  assert.deepEqual(cookedKeys(c), { lineStart: false, raw: false });
  assert.equal(c.toString(), 'half');
});

test('r10f #2 cookedKeys: a NUL (canonical end of file) at a line start becomes Ctrl+D; one ending a half-typed line is left', () => {
  const b = Buffer.from('\u0000a\n\u0000ab\u0000\u0000');
  cookedKeys(b);
  // at the start, after a newline, after the end of file that ended "ab" (a line end of its own)
  assert.equal(b.toString(), '\u0004a\r\u0004ab\u0000\u0004');
  // a chunk that continues a half-typed line
  const c = Buffer.from('\u0000x');
  assert.deepEqual(cookedKeys(c, false), { lineStart: false, raw: false });
  assert.equal(c.toString(), '\u0000x');
});

test('r10f #2 cookedKeys: nothing from a bracketed-paste start on (raw: the terminal brackets pastes only after the retake)', () => {
  const b = Buffer.from('hel\n\u001b[200~lo\nwo\u0000rld\u001b[201~\n');
  const r = cookedKeys(b);
  assert.equal(b.toString(), 'hel\r\u001b[200~lo\nwo\u0000rld\u001b[201~\n');
  assert.equal(r.raw, true);
  // a view into a larger buffer: only its own bytes
  const big = Buffer.from('xx\n\nyy');
  const view = big.subarray(3, 4);
  cookedKeys(view);
  assert.equal(big.toString(), 'xx\n\ryy');
});

// ───────────────────────────── the reader ─────────────────────────────

test('r10f #2: a line typed in the cooked window between `fg` of the running chat and the retake is submitted', { skip }, async (t) => {
  const { r, input, fg } = await inBackground(t);
  const p = r.readInput('> ');
  // `fg` of a running job: the terminal is the chat's again, no SIGCONT; hello + Enter typed
  // before the reader noticed: the shell's cooked mode (ICRNL) queued 'hello\n'
  fg();
  input.write('hello\n');
  assert.deepEqual(await race(p, 1500), { kind: 'line', text: 'hello' }, 'the Return was taken for a soft newline (Ctrl+J)');
});

test('r10f #2: after `fg` of the running chat (no SIGCONT) raw mode is back within a few polls, not up to 250 ms later', { skip }, async (t) => {
  const { r, log, fg } = await inBackground(t);
  void r.readInput('> ');
  await tick(5);
  const fgAt = performance.now();
  fg();
  assert.ok(await until(() => log.some((x) => x.e === 'raw:true' && x.at >= fgAt), 1000), 'raw mode never taken back');
  const lag = log.find((x) => x.e === 'raw:true' && x.at >= fgAt)!.at - fgAt;
  // a poll and two loop turns; generous for a loaded machine, far below the old 250 ms poll
  assert.ok(lag < 120, `raw mode taken back ${Math.round(lag)} ms after fg`);
  assert.ok(FOREGROUND_POLL_MS <= 25, `FOREGROUND_POLL_MS = ${FOREGROUND_POLL_MS}`);
});

test('r10f #2: a Ctrl+D typed in the cooked window (its NUL placeholder) acts as Ctrl+D', { skip }, async (t) => {
  const { r, input, fg } = await inBackground(t);
  const p = r.readInput('> ');
  fg();
  input.write('\u0000');
  assert.deepEqual(await race(p, 1500), { kind: 'ctrl-d' }, 'the Ctrl+D was dropped');
});

test('r10f #2: a NUL ending a half-typed cooked line is no Ctrl+D: the line stays and a later Return submits it', { skip }, async (t) => {
  const { r, input, fg } = await inBackground(t);
  const p = r.readInput('> ');
  fg();
  input.write('ab\u0000');
  assert.equal(await race(p, 300), 'still waiting');
  input.write('\r');
  assert.deepEqual(await race(p, 1500), { kind: 'line', text: 'ab' });
});

test('r10f #2 control: a Ctrl+J typed after the retake is raw: still a soft newline', { skip }, async (t) => {
  const { r, input, log, fg } = await inBackground(t);
  const p = r.readInput('> ');
  fg();
  assert.ok(await until(() => log.some((x) => x.e === 'raw:true'), 1000), 'raw mode never taken back');
  await tick(30);
  input.write('a\n');
  assert.equal(await race(p, 200), 'still waiting', 'a raw Ctrl+J submitted the input');
  input.write('b\r');
  assert.deepEqual(await race(p, 1500), { kind: 'line', text: 'a\nb' });
});

test('r10f #2: a bracketed paste in the first chunk after the retake keeps its newlines', { skip }, async (t) => {
  const { r, input, fg } = await inBackground(t);
  const p = r.readInput('> ');
  fg();
  input.write('hel\u001b[200~lo\nworld\u001b[201~\r');
  assert.deepEqual(await race(p, 1500), { kind: 'line', text: 'hello\nworld' });
});

test('r10f #2: lines queued while a child had the terminal are read as typed there at resume(true), after the child ended in the background (Return submits each)', { skip }, async (t) => {
  const { r, input } = ttyReader(t, () => true);
  const p = r.readInput('> ');
  await tick(10);
  r.suspend();
  // during `!sleep 3`, Ctrl+Z, `bg`, `sleep 1; fg`: typed into the cooked terminal, not read by
  // the child (r10f-terminal-verify.test.ts: after a child that ended in the foreground, resume()
  // without `cooked` keeps such a newline soft, as in Q)
  input.write('one\ntwo\n');
  await tick(20);
  r.resume(true);
  assert.deepEqual(await race(p, 1500), { kind: 'line', text: 'one' });
  // the second line was kept as type-ahead (a turn would run now) and goes to the next read
  assert.deepEqual(await race(r.readInput('> '), 1500), { kind: 'line', text: 'two' });
});

test('r10f #2: the foreground is asked only while away in the background (no polling at the prompt or after the retake)', { skip }, async (t) => {
  let fg = true;
  let asked = 0;
  const { r } = ttyReader(t, () => {
    asked++;
    return fg;
  });
  void r.readInput('> ');
  await tick(200);
  assert.equal(asked, 0, 'asked at the prompt');
  fg = false;
  process.emit('SIGCONT');
  await tick(400);
  const away = asked;
  // every 20 ms in the background (the first look two loop turns after the continue): not a busy
  // loop, and not one look per 250 ms either
  assert.ok(away >= 5 && away <= 30, `asked ${away} times in 400 ms in the background`);
  fg = true;
  assert.ok(await until(() => asked > away, 500));
  await tick(30);
  const atRetake = asked;
  await tick(200);
  assert.equal(asked, atRetake, 'still asking after the retake');
});
