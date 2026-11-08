/**
 * Round-10 fix "terminal-a" #3, unit level: LineReader.close() when kiro-claude is not in the
 * terminal's foreground. readline's close() turns raw mode off (a tcsetattr) and the reader wrote
 * its bracketed-paste switch: from the background (the chat stopped from elsewhere during its
 * final close and continued there, or ended there by a fatal REPL error) that stops kiro-claude
 * with SIGTTOU until `fg` (`stty tostop`: the write too). Now, not in the foreground, the reader
 * closes without touching the terminal: the input paused, its reads ended, no mode change, nothing
 * written; the terminal stays as the shell has it (Node's own exit restores the mode kiro-claude
 * started with, in the foreground). In the foreground close() is unchanged.
 *
 * In-process: a fake TTY and the reader's `foreground` seam (the real test is /proc/self/stat,
 * see r10f-term-quit-pty.test.ts).
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { LineReader } from '../../src/repl/input.js';

const skip = process.platform === 'win32' ? 'POSIX job control' : false;

function ttyReader(t: TestContext, foreground: () => boolean, ownSetRawMode = true): { r: LineReader; input: PassThrough; log: string[] } {
  const log: string[] = [];
  const input = new PassThrough();
  const setRawMode = (on: boolean): PassThrough => {
    log.push(`raw:${on}`);
    return input;
  };
  if (ownSetRawMode) Object.assign(input, { isTTY: true, setRawMode });
  else {
    // a tty.ReadStream's setRawMode comes from its prototype
    const proto = Object.create(Object.getPrototypeOf(input) as object) as { setRawMode: typeof setRawMode };
    proto.setRawMode = setRawMode;
    Object.setPrototypeOf(input, proto);
    Object.assign(input, { isTTY: true });
  }
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      log.push(`out:${chunk.toString()}`);
      cb();
    },
  });
  Object.assign(output, { isTTY: true, columns: 80 });
  const before = new Set(process.listeners('SIGCONT'));
  t.after(() => {
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l);
  });
  const r = new LineReader({ input, output, terminal: true, foreground });
  t.after(() => r.close());
  return { r, input, log };
}

const touched = (entries: string[]): string[] => entries.filter((e) => e.startsWith('raw:') || e.startsWith('out:'));

test('r10f #3: close() in the background touches nothing of the terminal (no raw-mode change, no bracketed-paste switch); its reads end', { skip }, async (t) => {
  let fg = true;
  const { r, input, log } = ttyReader(t, () => fg);
  const p = r.readInput('> ');
  input.write('half');
  await new Promise((res) => setImmediate(res));
  fg = false; // the shell took the terminal (a stop from elsewhere, then a continue in the background)
  const mark = log.length;
  r.close();
  assert.deepEqual(touched(log.slice(mark)), [], 'close() touched the terminal from the background (SIGTTOU stops kiro-claude until fg)');
  assert.deepEqual(await p, { kind: 'eof' });
  assert.equal(input.isPaused(), true, 'the input is still read (a read from the background stops kiro-claude: SIGTTIN)');
  r.close();
  assert.deepEqual(touched(log.slice(mark)), []);
});

test('r10f #3: the input keeps its own setRawMode after a close in the background (the no-op stand-in is gone)', { skip }, (t) => {
  for (const own of [true, false]) {
    const { r, input, log } = ttyReader(t, () => false, own);
    const before = (input as unknown as { setRawMode: unknown }).setRawMode;
    r.close();
    const after = input as unknown as { setRawMode: (on: boolean) => unknown };
    assert.equal(after.setRawMode, before);
    assert.equal(Object.prototype.hasOwnProperty.call(input, 'setRawMode'), own);
    const mark = log.length;
    after.setRawMode(false);
    assert.deepEqual(log.slice(mark), ['raw:false']);
  }
});

test('r10f #3 control: close() in the foreground turns raw mode and bracketed paste off as before', { skip }, async (t) => {
  const { r, log } = ttyReader(t, () => true);
  const p = r.readInput('> ');
  const mark = log.length;
  r.close();
  const after = touched(log.slice(mark));
  assert.ok(after.includes('out:\u001b[?2004l'), JSON.stringify(after));
  assert.ok(after.includes('raw:false'), JSON.stringify(after));
  assert.deepEqual(await p, { kind: 'eof' });
});
