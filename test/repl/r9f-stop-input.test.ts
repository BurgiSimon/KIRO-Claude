/**
 * Round-9 fix "stop-input" (findings #0, #1, #8): the terminal reader after a stop, and while a
 * child owns the terminal. In-process: a fake TTY, a mocked process.kill (nothing is really
 * stopped) and a `foreground` seam (the real test is /proc/self/stat, see the pty tests in
 * r9f-stop-input-pty.test.ts).
 *
 *  - #0/#1: the reader set raw mode (tcsetattr) synchronously inside the SIGCONT dispatch
 *    (continued()) and right after its own SIGTSTP returned (retake()), also when kiro-claude was
 *    continued in the BACKGROUND (`bg`, `kill -CONT`, bash's `kill %1`): SIGTTOU stopped it again
 *    before the other SIGCONT listeners (the stop clock) and the signals that came with the
 *    continue (`kill %1`'s SIGTERM) were handled. Now nothing of the terminal is touched there: the
 *    retake runs two event-loop turns later, not at all while muted (a fatal signal closes the
 *    chat), and only in the foreground; the input is paused from the stop on.
 *  - #8: suspend() (a `!cmd` or `$EDITOR` gets the terminal) left bracketed paste on, so a paste
 *    into a cooked-mode child arrived wrapped in ESC[200~ … ESC[201~.
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
  since: (i: number) => string[];
}

function ttyReader(
  t: TestContext,
  opts: { muted?: () => boolean; foreground?: () => boolean; onKill?: () => void; terminal?: boolean } = {},
): Tty {
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
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l);
  });
  const r = new LineReader({
    input,
    output,
    terminal: opts.terminal ?? true,
    ...(opts.muted ? { muted: opts.muted } : {}),
    ...(opts.foreground ? { foreground: opts.foreground } : {}),
  });
  t.after(() => r.close());
  return { r, input, log, since: (i) => log.slice(i) };
}

const tick = (ms = 10): Promise<void> => new Promise((res) => setTimeout(res, ms));
const outText = (entries: string[]): string =>
  entries
    .filter((e) => e.startsWith('out:'))
    .map((e) => e.slice(4))
    .join('');
const terminalTouched = (entries: string[]): string[] => entries.filter((e) => e.startsWith('raw:') || e.startsWith('out:'));
const lastBracketedPaste = (s: string): string | undefined => [...s.matchAll(/\u001b\[\?2004([hl])/g)].pop()?.[1];
const CTRL_Z = '\u001a';

test('r9f #0/#1: a SIGCONT (a stop from elsewhere) touches nothing of the terminal inside its dispatch; it is taken back two loop turns later', { skip }, async (t) => {
  const { r, input, log, since } = ttyReader(t);
  const p = r.readInput('> ');
  input.write('half');
  await tick();
  const mark = log.length;
  process.emit('SIGCONT');
  assert.deepEqual(since(mark), [], 'the terminal was touched inside the SIGCONT dispatch (from the background: SIGTTOU stops kiro-claude again)');
  await tick();
  const after = since(mark);
  const off = after.indexOf('raw:false');
  const on = after.indexOf('raw:true');
  assert.ok(off >= 0 && on > off, `raw mode is not applied again: ${JSON.stringify(after)}`);
  assert.ok(after.indexOf('out:\u001b[?2004h') > on, JSON.stringify(after));
  assert.match(outText(after), /> half/);
  input.write(' more\r');
  assert.deepEqual(await p, { kind: 'line', text: 'half more' });
});

test('r9f #1: Ctrl+Z, then `kill %1` (a SIGTERM handled with the continue): the terminal is not taken back, nothing is drawn, the input stays paused', { skip }, async (t) => {
  let muted = false;
  // the SIGTERM listener (ExitSignals) runs in the poll phase after kill() returned: muted from then on
  const { r, input, log, since } = ttyReader(t, { muted: () => muted, onKill: () => setImmediate(() => (muted = true)) });
  void r.readInput('> ');
  input.write('typed');
  await tick();
  const mark = log.length;
  input.write(CTRL_Z);
  await tick();
  process.emit('SIGCONT'); // the continue's own SIGCONT, dispatched after it
  await tick(50);
  const after = since(mark);
  const kill = after.indexOf('kill:0:SIGTSTP');
  assert.ok(kill >= 0, JSON.stringify(after));
  assert.deepEqual(terminalTouched(after.slice(kill + 1)), [], `the terminal was touched after the stop (a tcsetattr from the background stops the close: SIGTTOU): ${JSON.stringify(after)}`);
  assert.equal(input.isPaused(), true, 'the input is read again (a read from the background stops the close: SIGTTIN)');
});

test('r9f #1: kill -STOP, then kill -TERM and kill -CONT (the SIGCONT dispatched first): nothing of the terminal is touched', { skip }, async (t) => {
  let muted = false;
  const { r, input, log, since } = ttyReader(t, { muted: () => muted });
  void r.readInput('> ');
  await tick();
  const mark = log.length;
  process.emit('SIGCONT');
  muted = true; // the SIGTERM, dispatched right after the SIGCONT
  process.emit('SIGCONT'); // a later SIGCONT while muted: the input is only paused
  await tick(50);
  assert.deepEqual(since(mark), [], 'the terminal was touched');
  assert.equal(input.isPaused(), true);
});

test('r9f #0/#1: continued in the background, the reader stays off the terminal until fg (its SIGCONT, or the next look at the foreground)', { skip }, async (t) => {
  let fg = true;
  const { r, input, log, since } = ttyReader(t, { foreground: () => fg, onKill: () => (fg = false) });
  const p = r.readInput('> ');
  input.write('ab');
  await tick();
  // Ctrl+Z, then `bg`: kill() returns in the background
  let mark = log.length;
  input.write(CTRL_Z);
  await tick();
  process.emit('SIGCONT');
  await tick(50);
  let after = since(mark);
  const kill = after.indexOf('kill:0:SIGTSTP');
  assert.ok(kill >= 0, JSON.stringify(after));
  assert.deepEqual(terminalTouched(after.slice(kill + 1)), [], `the terminal was taken back in the background: ${JSON.stringify(after)}`);
  // something printed meanwhile (a notice) does not draw the prompt either
  mark = log.length;
  r.printAbove('NOTICE\n');
  assert.equal(outText(since(mark)), 'NOTICE\n', 'only the notice is written');
  // `fg`: its SIGCONT takes the terminal back, the read's prompt and line drawn again
  fg = true;
  mark = log.length;
  process.emit('SIGCONT');
  await tick();
  after = since(mark);
  assert.ok(after.includes('raw:true'), JSON.stringify(after));
  assert.ok(after.includes('out:\u001b[?2004h'), JSON.stringify(after));
  assert.match(outText(after), /> ab/);
  input.write('c\r');
  assert.deepEqual(await p, { kind: 'line', text: 'abc' });
});

test('r9f #0: kill -STOP and kill -CONT during a turn (background): no prompt until fg; bash\'s fg of a running job (no SIGCONT) is seen within a poll', { skip }, async (t) => {
  let fg = false;
  const { r, input, log, since } = ttyReader(t, { foreground: () => fg });
  r.on('interrupt', () => undefined); // a turn runs
  const mark = log.length;
  process.emit('SIGCONT'); // continued in the background
  await tick(50);
  // the turn ends while in the background: its prompt is not drawn
  const p = r.readInput('> ');
  await tick(400);
  assert.deepEqual(terminalTouched(since(mark)), [], `the terminal was touched in the background: ${JSON.stringify(since(mark))}`);
  // `fg` (bash sends no SIGCONT to a job it knows to be running): seen at the next look
  fg = true;
  await tick(600);
  const after = since(mark);
  const off = after.indexOf('raw:false');
  const on = after.indexOf('raw:true');
  assert.ok(off >= 0 && on > off, `not taken back after fg: ${JSON.stringify(after)}`);
  assert.equal(outText(after).match(/> /g)?.length, 1, `the prompt is not drawn once: ${JSON.stringify(outText(after))}`);
  input.write('next\r');
  assert.deepEqual(await p, { kind: 'line', text: 'next' });
});

test('r9f #0/#1: keys typed ahead after a Ctrl+Z are replayed once the terminal is taken back (one stop)', { skip }, async (t) => {
  const { r, input, log, since } = ttyReader(t);
  r.on('interrupt', () => undefined); // a turn runs
  input.write(`ab${CTRL_Z}cd${CTRL_Z}`);
  await tick();
  const mark = log.length;
  const p = r.readInput('> ');
  const sync = since(mark);
  const kill = sync.indexOf('kill:0:SIGTSTP');
  assert.ok(kill >= 0, JSON.stringify(sync));
  assert.doesNotMatch(outText(sync.slice(kill)), /c|d/, 'keys after the Ctrl+Z were drawn before the terminal was taken back');
  await tick();
  const after = since(mark);
  assert.ok(after.indexOf('raw:true') > kill, JSON.stringify(after));
  assert.match(outText(after.slice(after.indexOf('raw:true'))), /> ab[\s\S]*c[\s\S]*d/);
  input.write('\r');
  assert.deepEqual(await p, { kind: 'line', text: 'abcd' });
  assert.equal(since(mark).filter((e) => e.startsWith('kill:')).length, 1);
});

test('r9f #8: suspend() hands the child a terminal with bracketed paste off; resume() turns it on again', { skip }, async (t) => {
  const { r, log, since } = ttyReader(t);
  void r.readInput('> ');
  await tick();
  assert.equal(lastBracketedPaste(outText(log)), 'h');
  let mark = log.length;
  r.suspend();
  assert.equal(lastBracketedPaste(outText(log)), 'l', `the child gets bracketed paste on: ${JSON.stringify(since(mark))}`);
  assert.ok(since(mark).includes('raw:false'));
  mark = log.length;
  r.resume();
  assert.equal(lastBracketedPaste(outText(log)), 'h');
  assert.deepEqual(since(mark).filter((e) => e.startsWith('raw:')), ['raw:true']);
});

test('r9f #8: suspend() writes nothing while muted or once closed, nor in line mode', { skip }, async (t) => {
  let muted = false;
  {
    const { r, log, since } = ttyReader(t, { muted: () => muted });
    void r.readInput('> ');
    await tick();
    muted = true; // a fatal signal: nothing more is printed
    const mark = log.length;
    r.suspend();
    assert.equal(outText(since(mark)), '');
    r.resume();
    assert.equal(outText(since(mark)), '');
  }
  {
    const { r, log, since } = ttyReader(t);
    r.close();
    const mark = log.length;
    r.suspend();
    assert.equal(outText(since(mark)), '');
  }
  {
    const { r, log } = ttyReader(t, { terminal: false });
    r.suspend();
    r.resume();
    assert.equal(lastBracketedPaste(outText(log)), undefined, 'line mode never writes bracketed-paste switches');
  }
});
