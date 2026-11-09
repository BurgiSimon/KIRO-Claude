/**
 * Round-12 follow-up "terminal" T5: an approval's read again after an empty Enter at its question
 * (repl/core.ts approvalFlow, `case 'empty'`: the question is not drawn again) is no read of a
 * question still to come.
 *
 * r12 #0 (and its verification) hold a discarding read that starts while the input is held, in
 * the window that gives it back, or with the heartbeat overdue, and drop the keys that waited in
 * the terminal meanwhile: they were typed before its question was drawn. The re-read after an
 * empty Enter is such a read too, but its question has been on the screen since before that Enter:
 * when a stall ended in the Enter's own callbacks (the echo of the Enter blocked on a terminal that
 * does not drain), the re-read started overdue, parked the input, and dropped the rest of the keys
 * typed during the stall although they were typed at the question; one that started in the release
 * window dropped the keys still read in it. Now such a read (ReadOptions.questionShown) is never
 * held for them; the first read of every approval still is (r12 #0's guarantee, controls below).
 *
 * In-process fake TTYs, blocks of the event loop for the stall (the model of
 * r12f-terminal-verify-typeahead.test.ts), and the REPL with a MockSession for approvalFlow.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { INPUT_BEAT_MS, INPUT_GAP_MS, LineReader, type ReadOptions, type ReadResult } from '../../src/repl/input.js';
import { startRepl } from './harness.js';
import { MockSession, call as toolCall } from './mockSession.js';

const skip = process.platform === 'win32' ? 'POSIX job control' : false;
const Q = 'Allow this action? [y/n/t]: ';

const tick = (ms = 10): Promise<void> => new Promise((res) => setTimeout(res, ms));
/** Keep the event loop busy (no stop): a long synchronous step, a write that blocks. */
const block = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy
  }
};
const race = <T>(p: Promise<T>, ms = 300): Promise<T | 'still waiting'> => Promise.race([p, tick(ms).then(() => 'still waiting' as const)]);
/** The re-read's options (ReadOptions.questionShown; a cast where the option does not exist yet). */
const REREAD = { discardTypeahead: true, questionShown: true } as ReadOptions;

function ttyReader(t: TestContext): { r: LineReader; input: PassThrough } {
  t.mock.method(process, 'kill', () => true);
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => input });
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
  const r = new LineReader({ input, output, terminal: true, foreground: () => true, stopInBackground: () => false });
  t.after(() => r.close());
  return { r, input };
}

/** The heartbeat has run at least once since the reader started. */
const settle = (): Promise<void> => tick(INPUT_BEAT_MS + 30);

/**
 * An open approval; an empty Enter typed at its question; a stall in that Enter's callbacks, after
 * which the read is asked again (`opts`); `keys` typed during the stall arrive after it (they
 * waited in the terminal). What the read again gets.
 */
async function enterThenStall(t: TestContext, opts: ReadOptions, keys = 'y\r'): Promise<ReadResult | 'still waiting'> {
  const x = ttyReader(t);
  await settle();
  const first = x.r.read(Q, { discardTypeahead: true });
  await settle();
  let again: Promise<ReadResult> | undefined;
  void first.then((r) => {
    assert.deepEqual(r, { kind: 'line', text: '' });
    // the Enter's callbacks stall (its echo blocks on a terminal that does not drain) ...
    block(INPUT_GAP_MS + 150);
    // ... and the approval asks again, its question still on the screen
    again = x.r.read(Q, opts);
    // what was typed during the stall is still in the terminal
    setImmediate(() => x.input.write(keys));
  });
  x.input.write('\r');
  while (!again) await tick(2);
  return race(again);
}

test('r12g T5: the read again after an empty Enter, its question on the screen, gets the keys typed during a stall that ended in that Enter\'s callbacks (no overdue hold)', { skip }, async (t) => {
  assert.deepEqual(await enterThenStall(t, REREAD), { kind: 'line', text: 'y' }, 'keys typed at the question during the stall were dropped');
});

test('r12g T5 control: a first read of an approval that starts overdue still drops what waited (r12 #0: typed before its question)', { skip }, async (t) => {
  assert.equal(await enterThenStall(t, { discardTypeahead: true }), 'still waiting', 'keys typed before a question was drawn answered it');
});

test('r12g T5: the read again after an empty Enter read in the poll that gives the input back (the release window) gets the keys read after it in that window', { skip }, async (t) => {
  for (const [what, opts, want] of [
    ['read again (question on the screen)', REREAD, { kind: 'line', text: 'y' }],
    ['control: a first read in the window', { discardTypeahead: true }, 'still waiting'],
  ] as const) {
    const x = ttyReader(t);
    await settle();
    const first = x.r.read(Q, { discardTypeahead: true });
    await settle();
    let again: Promise<ReadResult> | undefined;
    void first.then(() => {
      again = x.r.read(Q, opts);
      // typed right after the Enter; read in a later poll, while the window is still open
      setImmediate(() => x.input.write('y\r'));
    });
    // a stall at the open approval: the heartbeat parks the input, and the Enter typed during it
    // waits in the terminal until the input is given back
    x.input.once('pause', () => x.input.write('\r'));
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        block(INPUT_GAP_MS + 150);
        resolve();
      }),
    );
    while (!again) await tick(2);
    assert.deepEqual(await race(again), want, what);
    x.r.close();
  }
});

// ───────────────────────────── the REPL: approvalFlow asks again ─────────────────────────────

const call = toolCall('Bash', { command: 'ls' }, 'tu1');

test('r12g T5: at the REPL\'s approval, an empty Enter whose echo stalls, then `y` typed during the stall: `y` answers it (approvalFlow reads again with questionShown)', { skip }, async (t) => {
  t.mock.method(process, 'kill', () => true);
  const s = new MockSession().script({ steps: [{ type: 'tool_start', toolUseId: 'tu1', call, trusted: false }, { approval: call }] });
  const run = startRepl({ session: s, tty: true, keepOpen: true });
  t.after(() => run.t.cleanup());
  const before = new Set(process.listeners('SIGCONT'));
  t.after(() => {
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l as () => void);
  });
  await run.waitFor(/> $/, 5000);
  run.stdin.write('go\r');
  await run.waitFor(/\[y\/n\/t\][\s\S]*> $/, 5000);
  await settle();
  // the echo of the next Enter blocks (a terminal that does not drain); `y` + Enter typed meanwhile
  const write = run.stdout.write.bind(run.stdout) as (...a: unknown[]) => boolean;
  let stall = true;
  (run.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]): boolean => {
    if (stall && String(a[0]).includes('\n')) {
      stall = false;
      block(INPUT_GAP_MS + 150);
      setImmediate(() => run.stdin.write('y\r'));
    }
    return write(...a);
  };
  run.stdin.write('\r');
  const t0 = Date.now();
  while (s.approvals.length === 0 && Date.now() - t0 < 3000) await tick(10);
  assert.deepEqual(s.approvals, [{ kind: 'allow-once' }], `the y typed at the question during the stall was dropped:\n${run.out().slice(-400)}`);
  run.stdin.write('/quit\r');
  assert.equal(await run.exit, 0);
});
