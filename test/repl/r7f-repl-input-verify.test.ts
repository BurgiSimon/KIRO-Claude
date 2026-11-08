/**
 * Round-7 verification of the "repl-input" fix (finding #2, Ctrl+Z in the terminal chat).
 *
 *  1. A Ctrl+Z pressed while no read is active (a turn runs) stopped kiro-claude at once. Its
 *     hook commands run in process groups of their own and keep running, but its timers do not
 *     wait: after a stop that outlasted a running preToolUse hook's timeout, that timeout fired
 *     before the hook's exit was seen, so a hook that had blocked the tool (exit 2) counted as
 *     timed out, which never blocks, and a trusted tool ran. The stop now waits for the next
 *     prompt (a read): it is kept as type-ahead and replayed there, after the prompt is drawn;
 *     an approval prompt drops it like any other type-ahead.
 *  2. A stop from elsewhere (`kill -TSTP` / `kill -STOP`, then `fg`) left the terminal in the
 *     shell's cooked mode: Enter arrived as LF (a soft newline), nothing could be submitted, and
 *     Ctrl+D was a real end of input taken for a hangup. At SIGCONT the reader now takes the
 *     terminal back (raw mode, bracketed paste, the active read's prompt on a fresh line), unless
 *     its own Ctrl+Z just did, while a child owns the terminal, or while muted.
 *
 * In-process: a fake TTY, a mocked process.kill and an emitted SIGCONT (nothing is really
 * stopped). The real terminal is covered by r7f-repl-input-verify-pty.test.ts.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { LineReader } from '../../src/repl/input.js';

const skip = process.platform !== 'win32' ? false : 'POSIX job control';

interface Tty {
  r: LineReader;
  input: PassThrough;
  log: string[];
  since: (i: number) => string[];
}

function ttyReader(t: TestContext, opts: { muted?: () => boolean; stopMs?: number } = {}): Tty {
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
  t.mock.method(process, 'kill', (pid: number, sig?: string | number) => {
    log.push(`kill:${pid}:${String(sig)}`);
    if (opts.stopMs) {
      const end = Date.now() + opts.stopMs;
      while (Date.now() < end) {
        // "stopped"
      }
    }
    return true;
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
/** The output with cursor movements and erasures removed. */
const plain = (entries: string[]): string => outText(entries).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const CTRL_Z = '\u001a';
const kills = (entries: string[]): string[] => entries.filter((e) => e.startsWith('kill:'));

test('r7f verify #2: a Ctrl+Z while a turn runs waits for the next prompt (drawn first), keeps the type-ahead order; an approval prompt drops it', { skip }, async (t) => {
  const { r, input, log, since } = ttyReader(t);
  r.on('interrupt', () => undefined); // a turn is listening for Ctrl+C
  let p = r.readInput('> ');
  input.write('first\r');
  assert.deepEqual(await p, { kind: 'line', text: 'first' });
  // a turn runs: hooks may be running; kiro-claude must not stop under them
  let mark = log.length;
  input.write(`ab${CTRL_Z}cd`);
  await tick();
  assert.deepEqual(kills(since(mark)), [], `kiro-claude stopped while a turn ran: ${JSON.stringify(since(mark))}`);
  assert.ok(!since(mark).includes('raw:false'), JSON.stringify(since(mark)));
  // the next prompt: drawn, then the stop, then the rest of the type-ahead
  mark = log.length;
  p = r.readInput('> ');
  const after = since(mark);
  const kill = after.indexOf('kill:0:SIGTSTP');
  assert.ok(kill >= 0, `no stop at the next prompt: ${JSON.stringify(after)}`);
  assert.match(plain(after.slice(0, kill)), /> ab$/, 'the prompt (with the keys typed before the Ctrl+Z) is drawn before the stop');
  assert.ok(after.indexOf('raw:true') > kill, JSON.stringify(after));
  input.write('\r');
  assert.deepEqual(await p, { kind: 'line', text: 'abcd' });
  assert.equal(kills(since(mark)).length, 1);
  // a Ctrl+Z typed before an approval prompt is dropped with the rest of the type-ahead
  mark = log.length;
  input.write(CTRL_Z);
  await tick();
  const ask = r.read('[y/n/t]: ', { discardTypeahead: true });
  input.write('y\r');
  assert.deepEqual(await ask, { kind: 'line', text: 'y' });
  assert.deepEqual(kills(since(mark)), [], 'a dropped Ctrl+Z stopped kiro-claude at the approval prompt');
  // a Ctrl+Z at the approval prompt itself still stops at once
  const ask2 = r.read('[y/n/t]: ', { discardTypeahead: true });
  mark = log.length;
  input.write(CTRL_Z);
  await tick();
  assert.deepEqual(kills(since(mark)), ['kill:0:SIGTSTP']);
  input.write('n\r');
  assert.deepEqual(await ask2, { kind: 'line', text: 'n' });
  assert.equal(r.hungUp, false);
});

test('r7f verify #2: a stop from elsewhere (SIGCONT) takes the terminal back: raw mode, bracketed paste, the prompt on a fresh line', { skip }, async (t) => {
  const { r, input, log, since } = ttyReader(t);
  const p = r.readInput('> ', { history: true });
  input.write('half');
  await tick();
  let mark = log.length;
  process.emit('SIGCONT');
  let after = since(mark);
  const off = after.indexOf('raw:false');
  const on = after.indexOf('raw:true');
  // libuv applies raw mode only on a change of mode: off, then on
  assert.ok(off >= 0 && on > off, `raw mode is not applied again: ${JSON.stringify(after)}`);
  assert.ok(after.indexOf('out:\u001b[?2004h') > on, `bracketed paste is not turned on again: ${JSON.stringify(after)}`);
  const redraw = outText(after);
  assert.match(redraw, /> half/, 'the prompt and the half-typed line are drawn again');
  assert.doesNotMatch(redraw, /\u001b\[\d*A/, 'the redraw climbed into the shell\'s lines');
  assert.deepEqual(kills(after), []);
  input.write(' more\r');
  assert.deepEqual(await p, { kind: 'line', text: 'half more' });
  assert.equal(r.hungUp, false);
  // while no read is active (a turn runs) the terminal is taken back, nothing is drawn
  await tick(300); // a later stop, not the SIGCONT of the one just handled
  mark = log.length;
  process.emit('SIGCONT');
  after = since(mark);
  assert.ok(after.includes('raw:false') && after.includes('raw:true'), JSON.stringify(after));
  assert.doesNotMatch(outText(after), />/, 'a prompt was drawn over the turn output');
});

test('r7f verify #2: SIGCONT right after the reader\'s own Ctrl+Z is not handled twice; nothing while a child owns the terminal, muted or closed', { skip }, async (t) => {
  // its own Ctrl+Z (a real stop: kill() returned late) already took the terminal back
  {
    const { r, input, log, since } = ttyReader(t, { stopMs: 80 });
    const p = r.readInput('> ');
    input.write('x');
    await tick();
    input.write(CTRL_Z);
    await tick();
    const mark = log.length;
    process.emit('SIGCONT'); // the stop's own SIGCONT, dispatched after the key handler
    assert.deepEqual(since(mark), [], 'the continuation was handled twice');
    input.write('\r');
    assert.deepEqual(await p, { kind: 'line', text: 'x' });
    // a later stop from elsewhere is handled again
    await tick(300);
    const mark2 = log.length;
    process.emit('SIGCONT');
    assert.ok(since(mark2).includes('raw:true'), JSON.stringify(since(mark2)));
  }
  // a child owns the terminal ($EDITOR, !cmd): it is the child's; resume() takes it back later
  {
    const { r, log, since } = ttyReader(t);
    void r.readInput('> ');
    await tick();
    r.suspend();
    const mark = log.length;
    process.emit('SIGCONT');
    assert.deepEqual(since(mark), []);
    r.resume();
  }
  // muted (a fatal signal's grace): nothing is written
  {
    let muted = false;
    const { r, log, since } = ttyReader(t, { muted: () => muted });
    void r.readInput('> ');
    await tick();
    muted = true;
    const mark = log.length;
    process.emit('SIGCONT');
    assert.ok(!since(mark).some((e) => e.startsWith('out:')), JSON.stringify(since(mark)));
  }
  // closed: the reader no longer listens
  {
    const { r, log, since } = ttyReader(t);
    r.close();
    const mark = log.length;
    process.emit('SIGCONT');
    assert.deepEqual(since(mark), []);
  }
});
