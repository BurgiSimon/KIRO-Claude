/**
 * Round-8 fix "repl-input", in-process (a fake TTY, a mocked process.kill: nothing is really
 * stopped). The real terminal is covered by r8f-repl-input-pty.test.ts.
 *
 *  - #2: `resume()` (the terminal back from a `!cmd` or `$EDITOR`) turns bracketed paste on again.
 *    The child may have turned it off (vim at exit; bash before it continues a job stopped with
 *    Ctrl+Z while the child owned the terminal), and only the constructor and the stop paths
 *    wrote ESC[?2004h: a later multi-line paste was submitted line by line.
 *  - #4: several Ctrl+Z typed while a turn runs stop the chat once at the next prompt (a
 *    cooked-mode program stops at the first press; the others go to the shell). Before the fix
 *    each kept press stopped it again: one `fg` per press.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { LineReader } from '../../src/repl/input.js';

const posix = process.platform !== 'win32';
const skip = posix ? false : 'POSIX job control';
const CTRL_Z = '\u001a';
const BP_ON = '\u001b[?2004h';

interface Tty {
  r: LineReader;
  input: PassThrough;
  log: string[];
}

function ttyReader(t: TestContext, opts: { muted?: () => boolean } = {}): Tty {
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
    return true;
  });
  const before = new Set(process.listeners('SIGCONT'));
  t.after(() => {
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l);
  });
  const r = new LineReader({ input, output, terminal: true, ...(opts.muted ? { muted: opts.muted } : {}) });
  t.after(() => r.close());
  return { r, input, log };
}

const tick = (ms = 10): Promise<void> => new Promise((res) => setTimeout(res, ms));
const out = (entries: string[]): string =>
  entries
    .filter((e) => e.startsWith('out:'))
    .map((e) => e.slice(4))
    .join('');
const lastBracketedPaste = (s: string): string | undefined => [...s.matchAll(/\u001b\[\?2004([hl])/g)].pop()?.[1];
const kills = (entries: string[]): string[] => entries.filter((e) => e.startsWith('kill:'));

// ───────────────────────────── #2: bracketed paste after a child ─────────────────────────────

test('r8 #2: resume() after a child turns bracketed paste on again (the child turned it off)', { skip }, async (t) => {
  const { r, input, log } = ttyReader(t);
  const read = r.readInput('> ');
  await tick();
  r.suspend();
  // the child (vim at exit; bash before `fg` continued the job stopped under it) turns it off
  log.push('out:\u001b[?2004l');
  // the SIGCONT of a stop while the child owned the terminal is the child's: nothing taken back
  process.emit('SIGCONT', 'SIGCONT');
  const at = log.length;
  r.resume();
  assert.ok(out(log.slice(at)).includes(BP_ON), `resume() wrote no ESC[?2004h: ${JSON.stringify(log.slice(at))}`);
  assert.equal(lastBracketedPaste(out(log)), 'h');
  assert.deepEqual(log.slice(at).filter((e) => e.startsWith('raw:')), ['raw:true'], 'raw mode is back too');
  // a paste of two lines stays one input
  input.write('\u001b[200~one\rtwo\u001b[201~\r');
  assert.deepEqual(await read, { kind: 'line', text: 'one\ntwo' });
});

test('r8 #2: resume() writes nothing while muted, after close, or when the reader was not suspended', { skip }, async (t) => {
  let muted = false;
  const { r, log } = ttyReader(t, { muted: () => muted });
  let at = log.length;
  r.resume(); // not suspended: nothing to take back
  assert.equal(out(log.slice(at)), '');
  r.suspend();
  muted = true; // a fatal signal while the child ran: nothing of the reader's own is written
  at = log.length;
  r.resume();
  assert.equal(out(log.slice(at)).includes(BP_ON), false, 'bracketed paste turned on after a fatal signal');
  muted = false;
  r.suspend();
  r.close();
  at = log.length;
  r.resume();
  assert.equal(out(log.slice(at)).includes(BP_ON), false, 'bracketed paste turned on after close');
});

// ───────────────────────────── #4: several Ctrl+Z typed ahead ─────────────────────────────

test('r8 #4: three Ctrl+Z typed while a turn runs stop the chat once at the next prompt', { skip }, async (t) => {
  const { r, input, log } = ttyReader(t);
  r.on('interrupt', () => undefined); // a turn listens for Ctrl+C
  let p = r.readInput('> ');
  input.write('slow one\r');
  assert.deepEqual(await p, { kind: 'line', text: 'slow one' });
  for (let i = 0; i < 3; i++) {
    input.write(CTRL_Z);
    await tick(5);
  }
  assert.equal(kills(log).length, 0, 'stopped while the turn ran');
  const mark = log.length;
  p = r.readInput('> ');
  await tick();
  input.write('next\r');
  assert.deepEqual(await p, { kind: 'line', text: 'next' });
  assert.deepEqual(kills(log.slice(mark)), ['kill:0:SIGTSTP'], 'one stop for the presses of one turn');
});

test('r8 #4: other keys typed between the presses are still replayed after the one stop', { skip }, async (t) => {
  const { r, input, log } = ttyReader(t);
  r.on('interrupt', () => undefined);
  let p = r.readInput('> ');
  input.write('go\r');
  await p;
  for (const k of ['a', CTRL_Z, 'b', CTRL_Z, 'c', CTRL_Z]) {
    input.write(k);
    await tick(2);
  }
  const mark = log.length;
  p = r.readInput('> ');
  await tick();
  input.write('\r');
  assert.deepEqual(await p, { kind: 'line', text: 'abc' });
  assert.equal(kills(log.slice(mark)).length, 1, JSON.stringify(kills(log.slice(mark))));
});

test('r8 #4: a Ctrl+Z typed during the next turn stops the chat again (one press, one stop)', { skip }, async (t) => {
  const { r, input, log } = ttyReader(t);
  r.on('interrupt', () => undefined);
  for (let turn = 0; turn < 2; turn++) {
    const p = r.readInput('> ');
    await tick();
    input.write(`turn ${turn}\r`);
    assert.deepEqual(await p, { kind: 'line', text: `turn ${turn}` });
    input.write(CTRL_Z);
    input.write(CTRL_Z);
    await tick();
  }
  const mark = log.length;
  const p = r.readInput('> ');
  await tick();
  input.write('last\r');
  assert.deepEqual(await p, { kind: 'line', text: 'last' });
  // the two turns' presses: the first turn's stop happened at the second prompt
  assert.equal(kills(log).length, 2, JSON.stringify(kills(log)));
  assert.equal(kills(log.slice(mark)).length, 1);
});
