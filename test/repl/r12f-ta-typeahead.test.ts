/**
 * Round-12 fix "terminal-a", unit level (repl/input.ts), findings #0 and #3.
 *
 * #0: r11's heartbeat park (LineReader.onBeat: the input paused and its reading stopped for one
 * poll after a gap) and the away state after a SIGCONT (continued() ... retake() two loop turns
 * later) hold the terminal's input back while Claude Code's pipe is still read. A permission
 * request read in that window pushed the approval read (discardTypeahead) while the keys typed
 * BEFORE it were still in the terminal, so its discard cleared an empty type-ahead buffer and the
 * keys were then read into the approval: `y` + Enter allowed the tool, `t` trusted it, any other
 * line denied it as a redirect, Ctrl+D cancelled it, Ctrl+Z stopped the chat. Before r11 the keys
 * were read first, as type-ahead, and the approval dropped them. Now a discarding read that starts
 * while the input is held (or within the poll that gives it back) drops what is read for it until
 * the second check phase after the input is given back: those keys were typed before its question
 * was drawn. A Ctrl+C among them still interrupts; a read whose question was up before the input
 * was held takes its keys as before; prompt and question reads keep their type-ahead.
 *
 * #3: continued() took any SIGCONT within OWN_CONT_MS (250 ms) of a retake for that retake's own,
 * so a stop from elsewhere and its `fg` inside that window got no retake (the terminal left in
 * the shell's cooked mode). Now only a SIGCONT that the reader's own stop (Ctrl+Z's SIGTSTP, the
 * self-stop in the background) still has to come is absorbed.
 *
 * In-process fake TTYs (PassThrough marked as a TTY with a stub setRawMode), a mocked
 * process.kill (nothing is really stopped; a real SIGCONT to this running process is harmless),
 * and blocks of the event loop for the stall. The real terminal is in r12f-ta-approval-pty.test.ts
 * and r12f-ta-owncont-pty.test.ts.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { INPUT_BEAT_MS, INPUT_GAP_MS, LineReader, type ReadResult } from '../../src/repl/input.js';

const skip = process.platform === 'win32' ? 'POSIX job control' : false;
/** The real process.kill (mocked below: a Ctrl+Z must never stop the test runner). */
const realKill = process.kill.bind(process);
const Q = 'Allow this action? [y/n/t]: ';

const tick = (ms = 10): Promise<void> => new Promise((res) => setTimeout(res, ms));
/** Keep the event loop busy (no stop): a long synchronous step, a GC pause, a slow machine. */
const block = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy
  }
};
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await tick(2);
  return cond();
}
const race = (p: Promise<ReadResult>, ms = 300): Promise<ReadResult | 'still waiting'> => Promise.race([p, tick(ms).then(() => 'still waiting' as const)]);

interface Tty {
  r: LineReader;
  input: PassThrough;
  log: string[];
  kills: string[];
  since(mark: number): string[];
}

/** The signals process.kill was called with in a test (mocked once per test: recorded, returns at once, the continue). */
const killed = new WeakMap<TestContext, string[]>();
function mockKill(t: TestContext): string[] {
  let kills = killed.get(t);
  if (kills) return kills;
  const list: string[] = [];
  killed.set(t, list);
  t.mock.method(process, 'kill', (_pid: number, sig?: string | number) => {
    list.push(String(sig));
    return true;
  });
  kills = list;
  return kills;
}

/** A terminal-mode reader over a fake TTY (process.kill mocked, {@link mockKill}). */
function ttyReader(t: TestContext, opts: { foreground?: () => boolean; stop?: () => boolean } = {}): Tty {
  const log: string[] = [];
  const kills = mockKill(t);
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
  const r = new LineReader({
    input,
    output,
    terminal: true,
    foreground: opts.foreground ?? (() => true),
    stopInBackground: opts.stop ?? (() => false),
  });
  t.after(() => r.close());
  return { r, input, log, kills, since: (mark) => log.slice(mark) };
}

const outText = (entries: string[]): string =>
  entries
    .filter((e) => e.startsWith('out:'))
    .map((e) => e.slice(4))
    .join('');
const raws = (entries: string[]): string[] => entries.filter((e) => e.startsWith('raw:'));

/**
 * A stall of the event loop while no read is active (a turn runs): the heartbeat parks the input;
 * `parked` runs in the park (the terminal holds what was typed meanwhile; Claude Code's request,
 * queued meanwhile too, is read in the poll that follows). Resolves once `parked` has run.
 */
async function stall(x: Tty, parked: () => void): Promise<void> {
  let done = false;
  x.input.once('pause', () => {
    parked();
    done = true;
  });
  setTimeout(() => block(INPUT_GAP_MS + 150), 0);
  assert.ok(await until(() => done), 'the heartbeat never parked the input');
}

// ───────────────────────────── #0: keys typed before the approval's question ─────────────────────────────

const AHEAD: [string, string][] = [
  ['y + Enter', 'y\r'],
  ['t + Enter', 't\r'],
  ['a next message + Enter', 'add tests\r'],
  ['Ctrl+D', '\u0004'],
  ['Ctrl+Z', '\u001a'],
  ['a bracketed paste of y + Enter', '\u001b[200~y\r\u001b[201~'],
  ['a Return queued in a cooked mode (a newline)', 'y\n'],
];

for (const [what, keys] of AHEAD) {
  test(`r12f #0: a stall (park, no SIGCONT), the request read in the parked poll: ${what} typed during the stall never reaches the approval; \`n\` typed at its question answers it`, { skip }, async (t) => {
    const x = ttyReader(t);
    x.r.on('interrupt', () => undefined); // a turn runs: no read is active
    let ask: Promise<ReadResult> | undefined;
    await stall(x, () => {
      x.input.write(keys);
      // the poll after the park: Claude Code's permission request is read (the keys are not)
      process.nextTick(() => (ask = x.r.read(Q, { discardTypeahead: true })));
    });
    assert.ok(await until(() => ask !== undefined));
    const first = await race(ask!);
    assert.equal(first, 'still waiting', `keys typed before the question answered it: ${JSON.stringify(first)}`);
    assert.deepEqual(x.kills, [], 'a Ctrl+Z typed before the question stopped the chat at it');
    x.input.write('n\r');
    assert.deepEqual(await ask, { kind: 'line', text: 'n' }, 'keys typed before the question were kept in its answer');
  });
}

test('r12f #0: a bracketed paste that starts among the keys typed during the stall and ends later is dropped to its end; then `n` answers', { skip }, async (t) => {
  const x = ttyReader(t);
  x.r.on('interrupt', () => undefined);
  let ask: Promise<ReadResult> | undefined;
  await stall(x, () => {
    x.input.write('\u001b[200~y\r');
    process.nextTick(() => (ask = x.r.read(Q, { discardTypeahead: true })));
  });
  assert.ok(await until(() => ask !== undefined));
  await tick(50);
  // the rest of the paste, after the poll that gave the input back
  x.input.write('more\r\u001b[201~');
  assert.equal(await race(ask!), 'still waiting', 'a pasted line answered the approval');
  x.input.write('n\r');
  assert.deepEqual(await ask, { kind: 'line', text: 'n' });
});

test('r12f #0: the race: the hook answered in the parked poll, the request read in the next poll before the keys typed during the stall: they never reach the approval', { skip }, async (t) => {
  const x = ttyReader(t);
  x.r.on('interrupt', () => undefined);
  let ask: Promise<ReadResult> | undefined;
  await stall(x, () => {
    x.input.write('y\r');
    // the input is given back; in the poll that follows Claude Code's request comes first
    x.input.once('resume', () => (ask = x.r.read(Q, { discardTypeahead: true })));
  });
  assert.ok(await until(() => ask !== undefined));
  assert.equal(await race(ask!), 'still waiting', 'keys typed before the question answered it');
  x.input.write('y\r');
  assert.deepEqual(await ask, { kind: 'line', text: 'y' });
});

test('r12f #0: the request read after the keys typed during a stall (they were type-ahead): dropped as before (control)', { skip }, async (t) => {
  const x = ttyReader(t);
  x.r.on('interrupt', () => undefined);
  await stall(x, () => x.input.write('y\r'));
  await tick(50);
  const ask = x.r.read(Q, { discardTypeahead: true });
  assert.equal(await race(ask), 'still waiting');
  x.input.write('n\r');
  assert.deepEqual(await ask, { kind: 'line', text: 'n' });
});

test('r12f #0: a park decided by a SIGCONT (a stop from elsewhere), the request read in the parked poll: the keys the shell queued never reach the approval; one retake', { skip }, async (t) => {
  const x = ttyReader(t);
  x.r.on('interrupt', () => undefined);
  let ask: Promise<ReadResult> | undefined;
  const mark = x.log.length;
  await stall(x, () => {
    x.input.write('y\n');
    process.nextTick(() => {
      ask = x.r.read(Q, { discardTypeahead: true });
      realKill(process.pid, 'SIGCONT');
    });
  });
  assert.ok(await until(() => ask !== undefined && x.since(mark).includes('raw:true')), `not taken back: ${JSON.stringify(x.since(mark))}`);
  assert.equal(await race(ask!), 'still waiting');
  assert.deepEqual(raws(x.since(mark)), ['raw:false', 'raw:true'], JSON.stringify(x.since(mark)));
  x.input.write('n\r');
  assert.deepEqual(await ask, { kind: 'line', text: 'n' });
});

test('r12f #0: a SIGCONT from elsewhere (away until the retake; no shell: the keys typed during the stop are raw), the request read before the retake: the keys never reach the approval', { skip }, async (t) => {
  for (const keys of ['y\r', 't\r', 'add tests\r', '\u0004']) {
    const x = ttyReader(t);
    x.r.on('interrupt', () => undefined);
    process.emit('SIGCONT');
    // Claude Code's request, queued during the stop, is read before the terminal is taken back
    const ask = x.r.read(Q, { discardTypeahead: true });
    x.input.write(keys);
    assert.equal(await race(ask), 'still waiting', `${JSON.stringify(keys)} typed during the stop answered the approval`);
    x.input.write('n\r');
    assert.deepEqual(await ask, { kind: 'line', text: 'n' }, JSON.stringify(keys));
    x.r.close();
  }
});

test('r12f #0: the request read right after the retake (in the poll that gives the input back): the keys typed during the stop never reach the approval', { skip }, async (t) => {
  const x = ttyReader(t);
  x.r.on('interrupt', () => undefined);
  let ask: Promise<ReadResult> | undefined;
  x.input.once('resume', () => (ask = x.r.read(Q, { discardTypeahead: true })));
  process.emit('SIGCONT');
  x.input.write('y\r');
  assert.ok(await until(() => ask !== undefined));
  assert.equal(await race(ask!), 'still waiting');
  x.input.write('n\r');
  assert.deepEqual(await ask, { kind: 'line', text: 'n' });
});

test('r12f #0: Ctrl+Z at a question, an approval asked while stopped (before the retake), keys typed into the shell before `fg`: dropped; `y` typed at the question after `fg` answers it', { skip }, async (t) => {
  const x = ttyReader(t);
  const question = x.r.read('Which one? > ');
  await tick();
  let ask: Promise<ReadResult> | undefined;
  x.input.once('pause', () => {
    // the stop: what the shell's cooked mode queued before `fg`; after the continue Claude Code's
    // request is read before the terminal is taken back
    x.input.write('y\n');
    process.nextTick(() => (ask = x.r.read(Q, { discardTypeahead: true })));
  });
  const mark = x.log.length;
  x.input.write('\u001a');
  assert.ok(await until(() => ask !== undefined && x.since(mark).includes('raw:true')));
  assert.deepEqual(x.kills, ['SIGTSTP']);
  assert.equal(await race(ask!), 'still waiting');
  x.input.write('y\r');
  assert.deepEqual(await ask, { kind: 'line', text: 'y' });
  x.input.write('2\r');
  assert.deepEqual(await question, { kind: 'line', text: '2' });
});

test('r12f #0 (b): keys typed at an approval whose question was up before a stall answer it; Ctrl+Z at it, then `fg`: keys typed at it answer it (controls)', { skip }, async (t) => {
  {
    const x = ttyReader(t);
    const ask = x.r.read(Q, { discardTypeahead: true });
    await tick(INPUT_BEAT_MS + 20);
    await stall(x, () => x.input.write('y\r'));
    assert.deepEqual(await race(ask, 1000), { kind: 'line', text: 'y' }, 'keys typed at the question during a stall did not answer it');
    x.r.close();
  }
  {
    const x = ttyReader(t);
    const ask = x.r.read(Q, { discardTypeahead: true });
    await tick();
    const mark = x.log.length;
    x.input.write('\u001a');
    assert.ok(await until(() => x.since(mark).includes('raw:true')));
    await tick(30);
    x.input.write('t\r');
    assert.deepEqual(await race(ask, 1000), { kind: 'line', text: 't' });
  }
});

test('r12f #0: a Ctrl+C typed during the stall still interrupts (it is never dropped)', { skip }, async (t) => {
  const x = ttyReader(t);
  x.r.on('interrupt', () => undefined);
  let ask: Promise<ReadResult> | undefined;
  await stall(x, () => {
    x.input.write('y\u0003');
    process.nextTick(() => (ask = x.r.read(Q, { discardTypeahead: true })));
  });
  assert.ok(await until(() => ask !== undefined));
  assert.deepEqual(await race(ask!, 1000), { kind: 'interrupt' });
});

// ───────────────────────────── #0 (c): prompt and question reads keep their type-ahead ─────────────────────────────

test('r12f #0 (c): a stall at the prompt: what was typed before and during it is one input, in order, delivered once', { skip }, async (t) => {
  const x = ttyReader(t);
  const p = x.r.readInput('> ');
  x.input.write('ab');
  await tick(INPUT_BEAT_MS + 20);
  await stall(x, () => x.input.write('cd\r'));
  assert.deepEqual(await race(p, 1000), { kind: 'line', text: 'abcd' });
  const next = x.r.readInput('> ');
  assert.equal(await race(next), 'still waiting', 'a key was delivered twice');
});

test('r12f #0 (c): a stall while a turn runs: the type-ahead from before and during it goes to the next prompt, in order, once', { skip }, async (t) => {
  const x = ttyReader(t);
  x.r.on('interrupt', () => undefined);
  x.input.write('ab');
  await tick(INPUT_BEAT_MS + 20);
  await stall(x, () => x.input.write('cd\r'));
  await tick(50);
  assert.deepEqual(await race(x.r.readInput('> '), 1000), { kind: 'line', text: 'abcd' });
  assert.equal(await race(x.r.readInput('> ')), 'still waiting', 'a key was delivered twice');
});

test('r12f #0 (c): a question (no discard) asked in the parked poll takes the keys typed during the stall, as type-ahead', { skip }, async (t) => {
  const x = ttyReader(t);
  x.r.on('interrupt', () => undefined);
  let q: Promise<ReadResult> | undefined;
  await stall(x, () => {
    x.input.write('yes\r');
    process.nextTick(() => (q = x.r.read('[y/n]: ')));
  });
  assert.ok(await until(() => q !== undefined));
  assert.deepEqual(await race(q!, 1000), { kind: 'line', text: 'yes' });
});

// ───────────────────────────── #3: only the reader's own SIGCONT is absorbed ─────────────────────────────

/** Ctrl+Z at the prompt; its own SIGCONT dispatched in the poll after the stop (before the retake). Resolves at the retake. */
async function ctrlZ(x: Tty, ownCont = true): Promise<void> {
  if (ownCont) x.input.once('pause', () => setImmediate(() => process.emit('SIGCONT')));
  const mark = x.log.length;
  x.input.write('\u001a');
  assert.ok(await until(() => x.since(mark).includes('raw:true')), `not taken back after Ctrl+Z: ${JSON.stringify(x.since(mark))}`);
  await tick(5);
}

test('r12f #3: Ctrl+Z, `fg`, then a stop from elsewhere and its `fg` right after the retake: taken back again (raw mode applied, the prompt drawn)', { skip }, async (t) => {
  const x = ttyReader(t);
  const p = x.r.readInput('> ');
  x.input.write('ab');
  await tick();
  await ctrlZ(x);
  const mark = x.log.length;
  process.emit('SIGCONT'); // kill -STOP <pid>, bash: Stopped, `fg`: within 250 ms of the retake
  assert.ok(await until(() => x.since(mark).includes('raw:true')), `the SIGCONT of a stop from elsewhere was taken for the retake's own: ${JSON.stringify(x.since(mark))}`);
  assert.deepEqual(raws(x.since(mark)), ['raw:false', 'raw:true']);
  assert.match(outText(x.since(mark)), /> ab/, 'the prompt was not drawn again');
  x.input.write('c\r');
  assert.deepEqual(await race(p, 1000), { kind: 'line', text: 'abc' });
});

test('r12f #3: the own SIGCONT of Ctrl+Z, dispatched late (after the retake), is still absorbed: one retake (r7 control)', { skip }, async (t) => {
  const x = ttyReader(t);
  void x.r.readInput('> ');
  await tick();
  await ctrlZ(x, false);
  const mark = x.log.length;
  process.emit('SIGCONT');
  await tick(30);
  assert.deepEqual(x.since(mark), [], 'the own SIGCONT was handled as a second stop');
  // and the next one is a stop from elsewhere
  process.emit('SIGCONT');
  assert.ok(await until(() => x.since(mark).includes('raw:true')), JSON.stringify(x.since(mark)));
});

test('r12f #3: a Ctrl+Z whose stop was discarded (no SIGCONT comes): a SIGCONT after the next heartbeat, still within 250 ms of the retake, is a stop from elsewhere', { skip }, async (t) => {
  const beats: number[] = [];
  const realSet = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (fn: () => void, ms?: number) =>
    realSet(() => {
      if (ms === INPUT_BEAT_MS) beats.push(performance.now());
      fn();
    }, ms),
  );
  const x = ttyReader(t);
  void x.r.readInput('> ');
  await tick();
  await ctrlZ(x, false);
  const retakenAt = performance.now();
  const n = beats.length;
  assert.ok(await until(() => beats.length > n), 'no heartbeat after the retake');
  const elapsed = performance.now() - retakenAt;
  if (elapsed >= 240) {
    t.skip(`the heartbeat came ${elapsed.toFixed(0)} ms after the retake: past the window, nothing to tell apart`);
    return;
  }
  const mark = x.log.length;
  process.emit('SIGCONT');
  assert.ok(await until(() => x.since(mark).includes('raw:true')), `taken for the discarded stop's own SIGCONT: ${JSON.stringify(x.since(mark))}`);
});

test('r12f #3: the reader\'s own stop in the background (Ctrl+Z, `bg`, the self-stop, `fg`), then a stop from elsewhere and its `fg` right after the retake: taken back again', { skip }, async (t) => {
  let fg = true;
  let stops = 0;
  const x = ttyReader(t, {
    foreground: () => fg,
    stop: () => {
      stops++;
      fg = true; // `fg`: its SIGCONT is dispatched in the poll after the stop returned
      setImmediate(() => process.emit('SIGCONT'));
      return true;
    },
  });
  const p = x.r.readInput('> ');
  x.input.write('ab');
  await tick();
  fg = false;
  await ctrlZ(x); // its continue is `bg`: the reader stays away and stops itself at the next look
  assert.equal(stops, 1);
  const mark = x.log.length;
  process.emit('SIGCONT');
  assert.ok(await until(() => x.since(mark).includes('raw:true')), `the SIGCONT of a stop from elsewhere was taken for the self-stop's own: ${JSON.stringify(x.since(mark))}`);
  x.input.write('c\r');
  assert.deepEqual(await race(p, 1000), { kind: 'line', text: 'abc' });
});
