/**
 * Round-12 verification of the "terminal" group's fix for #0 (repl/input.ts): keys typed before an
 * approval's question was drawn never answer it.
 *
 * The fix holds a discarding read (an approval) that starts while the input is parked by the
 * heartbeat or away after a continue, and drops what is read for it once the input is given back.
 * A stall (or a stop from elsewhere) can also land after Claude Code's request was read and before
 * its question is drawn: in the callbacks of one poll (a long synchronous step, a GC pause, a
 * freeze or SIGSTOP that lands while kiro-claude runs JavaScript), with the permission request
 * among them. The approval read then starts before the heartbeat has run since the stall (it is
 * overdue: the event loop got no turn for longer than INPUT_GAP_MS), the input is neither parked nor
 * away, and the keys typed during the stall, still waiting in the terminal (or in the same poll's
 * batch, after the request), were read into the approval: `y` + Enter allowed the tool.
 *
 * In-process fake TTYs (PassThrough marked as a TTY with a stub setRawMode), process.kill mocked,
 * blocks of the event loop for the stall (the same model as r12f-ta-typeahead.test.ts).
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { INPUT_BEAT_MS, INPUT_GAP_MS, LineReader, type ReadResult } from '../../src/repl/input.js';

const skip = process.platform === 'win32' ? 'POSIX job control' : false;
const Q = 'Allow this action? [y/n/t]: ';

const tick = (ms = 10): Promise<void> => new Promise((res) => setTimeout(res, ms));
/** Keep the event loop busy (no stop): a long synchronous step. */
const block = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy
  }
};
const race = (p: Promise<ReadResult>, ms = 300): Promise<ReadResult | 'still waiting'> => Promise.race([p, tick(ms).then(() => 'still waiting' as const)]);

interface Tty {
  r: LineReader;
  input: PassThrough;
  log: string[];
}

function ttyReader(t: TestContext): Tty {
  const log: string[] = [];
  t.mock.method(process, 'kill', () => true);
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
  const before = new Set(process.listeners('SIGCONT'));
  t.after(() => {
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l as () => void);
  });
  const r = new LineReader({ input, output, terminal: true, foreground: () => true, stopInBackground: () => false });
  t.after(() => r.close());
  return { r, input, log };
}

/** The heartbeat has run at least once since the reader started (its interval is live). */
const settle = (): Promise<void> => tick(INPUT_BEAT_MS + 30);

test('r12f verify #0: a stall that ends with the request read in the same callbacks (no beat since): keys typed during it and read afterwards never answer the approval; `n` typed at its question does', { skip }, async (t) => {
  for (const keys of ['y\r', 't\r', 'add tests\r', '\u0004']) {
    const x = ttyReader(t);
    x.r.on('interrupt', () => undefined); // a turn runs: no read is active
    await settle();
    let ask: Promise<ReadResult> | undefined;
    // the keys typed during the stall wait in the terminal: what is there once the input is held
    // (the park that follows the stall) is read when it is given back
    let parked = false;
    x.input.once('pause', () => {
      x.input.write(keys);
      parked = true;
    });
    setImmediate(() => {
      // a callback of the poll stalls; the one after it reads Claude Code's request (no turn of
      // the event loop between: the heartbeat is overdue, the input neither parked nor away)
      block(INPUT_GAP_MS + 150);
      ask = x.r.read(Q, { discardTypeahead: true });
    });
    while (!parked) await tick(2);
    assert.equal(await race(ask!), 'still waiting', `${JSON.stringify(keys)} typed during the stall, before the question was drawn, answered it`);
    x.input.write('n\r');
    assert.deepEqual(await race(ask!, 1000), { kind: 'line', text: 'n' }, `keys typed before the question were kept in its answer (${JSON.stringify(keys)})`);
    x.r.close();
  }
});

test('r12f verify #0: the keys typed during the stall come in the same poll as the request, right after it: they never answer the approval', { skip }, async (t) => {
  const x = ttyReader(t);
  x.r.on('interrupt', () => undefined);
  await settle();
  let ask: Promise<ReadResult> | undefined;
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      block(INPUT_GAP_MS + 150);
      ask = x.r.read(Q, { discardTypeahead: true });
      // the terminal's callback in the same batch, after the pipe's
      x.input.write('y\r');
      resolve();
    }),
  );
  assert.equal(await race(ask!), 'still waiting', 'keys typed during the stall answered the approval asked right before them');
  x.input.write('n\r');
  assert.deepEqual(await race(ask!, 1000), { kind: 'line', text: 'n' });
});

test('r12f verify #0 (b): with no stall, keys typed right after the question answer it at once (control)', { skip }, async (t) => {
  const x = ttyReader(t);
  x.r.on('interrupt', () => undefined);
  await settle();
  const ask = x.r.read(Q, { discardTypeahead: true });
  x.input.write('y\r');
  assert.deepEqual(await race(ask, 1000), { kind: 'line', text: 'y' });
});

test('r12f verify #0 (b): a stall at an open approval (its question up before it): `y` typed during the stall answers it (control)', { skip }, async (t) => {
  const x = ttyReader(t);
  await settle();
  const ask = x.r.read(Q, { discardTypeahead: true });
  await settle();
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      block(INPUT_GAP_MS + 150);
      setTimeout(() => {
        x.input.write('y\r');
        resolve();
      }, 0);
    }),
  );
  assert.deepEqual(await race(ask, 1000), { kind: 'line', text: 'y' }, 'keys typed at its question during a stall were dropped');
});

test('r12f verify #0 (c): a stall that ends with the prompt read pushed (the turn ended): the keys typed during it are its input, in order, once', { skip }, async (t) => {
  const x = ttyReader(t);
  x.r.on('interrupt', () => undefined);
  x.input.write('ab');
  await settle();
  let p: Promise<ReadResult> | undefined;
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      block(INPUT_GAP_MS + 150);
      p = x.r.readInput('> ');
      setTimeout(() => {
        x.input.write('cd\r');
        resolve();
      }, 0);
    }),
  );
  assert.deepEqual(await race(p!, 1000), { kind: 'line', text: 'abcd' });
  assert.equal(await race(x.r.readInput('> ')), 'still waiting', 'a key was delivered twice');
});
