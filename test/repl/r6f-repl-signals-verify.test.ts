/**
 * Round-6 verification of the "repl-signals" fixes: what the terminal-mode line reader writes on
 * its own. After a fatal signal (the reader is `muted`) kiro-claude prints nothing more; and the
 * prompt is shown only while a read is active (module doc of repl/input.ts).
 *
 *  - A process SIGINT during the SIGTERM / SIGHUP grace (`kill -INT`: the REPL's handler calls
 *    `LineReader.ctrlC()`) moved the cursor to a fresh line (readline's `clearLine`, `\r\n`) even
 *    though the reader was muted.
 *  - readline redraws its prompt and line at every resize of the terminal (`output` 'resize'),
 *    unconditionally: during the grace, while no read is active (a turn streaming: the current
 *    line of the answer was erased and a stale `> ` drawn over it) and while a child owns the
 *    terminal (`!cmd`, `$EDITOR`: drawn into the child's screen). It now redraws only for an
 *    active read of a reader that is neither muted nor suspended.
 *
 * The end-to-end check over a real pty is r6f-repl-signals-verify-pty.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { LineReader } from '../../src/repl/input.js';

class FakeTty extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(flag: boolean): this {
    this.isRaw = flag;
    return this;
  }
}

class FakeOut extends PassThrough {
  isTTY = true;
  columns = 80;
  rows = 24;
  text = '';
  constructor() {
    super();
    this.on('data', (d: Buffer) => (this.text += d.toString('utf8')));
  }
}

function terminalReader(muted: () => boolean = () => false): { reader: LineReader; input: FakeTty; output: FakeOut } {
  const input = new FakeTty();
  const output = new FakeOut();
  const reader = new LineReader({ input, output, terminal: true, muted });
  return { reader, input, output };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test('r6f verify: a SIGINT while the terminal reader is muted (the grace after a fatal signal) writes nothing; the read still ends as an interrupt', async () => {
  let muted = false;
  const { reader, input, output } = terminalReader(() => muted);
  const p = reader.readInput('> ');
  input.write('half typed');
  await tick();
  muted = true;
  const at = output.text.length;
  reader.ctrlC(); // the REPL's process SIGINT handler
  assert.deepEqual(await p, { kind: 'interrupt' });
  await tick();
  assert.equal(output.text.slice(at), '', 'the muted reader wrote to the terminal');
  reader.close();
});

test('r6f verify: a terminal resize while the reader is muted redraws nothing (no prompt after a fatal signal)', async () => {
  let muted = false;
  const { reader, input, output } = terminalReader(() => muted);
  void reader.readInput('> ');
  input.write('half typed');
  await tick();
  muted = true;
  const at = output.text.length;
  output.columns = 60;
  output.emit('resize');
  await tick();
  assert.equal(output.text.slice(at), '', 'readline redrew the prompt line after the signal');
  reader.close();
});

test('r6f verify: a terminal resize while no read is active (a turn streams) draws no stale prompt over the output', async () => {
  const { reader, input, output } = terminalReader();
  const p = reader.readInput('> ');
  input.write('hello\r');
  assert.deepEqual(await p, { kind: 'line', text: 'hello' });
  output.write('partial answer'); // the turn streams its answer on the current line
  await tick();
  const at = output.text.length;
  output.columns = 60;
  output.emit('resize');
  await tick();
  assert.equal(output.text.slice(at), '', 'readline erased the current line and drew its old prompt');
  reader.close();
});

test('r6f verify: a terminal resize while a child owns the terminal (suspended) draws nothing into its screen', async () => {
  const { reader, input, output } = terminalReader();
  void reader.readInput('> ');
  input.write('!vim');
  await tick();
  reader.suspend();
  const at = output.text.length;
  output.columns = 60;
  output.emit('resize');
  await tick();
  assert.equal(output.text.slice(at), '', 'readline drew the prompt into the child\'s screen');
  reader.resume();
  reader.close();
});

test('r6f verify (control): a terminal resize during an active read still redraws the prompt and the line', async () => {
  const { reader, input, output } = terminalReader();
  void reader.readInput('> ');
  input.write('half typed');
  await tick();
  const at = output.text.length;
  output.columns = 60;
  output.emit('resize');
  await tick();
  assert.match(output.text.slice(at), /> half typed/);
  reader.close();
});

test('r6f verify: closing the reader removes its resize listener (none is left on a shared stdout)', async () => {
  const output = new FakeOut();
  const before = output.listenerCount('resize');
  const input = new FakeTty();
  const reader = new LineReader({ input, output, terminal: true });
  assert.ok(output.listenerCount('resize') > before);
  reader.close();
  assert.equal(output.listenerCount('resize'), before);
  // and when readline closes on its own (the input ended)
  const input2 = new FakeTty();
  const reader2 = new LineReader({ input: input2, output, terminal: true });
  const p = reader2.readInput('> ');
  input2.emit('end');
  assert.deepEqual(await p, { kind: 'eof' });
  assert.equal(output.listenerCount('resize'), before);
  reader2.close();
});
