/**
 * Round-5 fix "signals", unit level:
 *  - #1(c) ExitSignals: a repeat of the first signal within {@link DUPLICATE_SIGNAL_WINDOW_MS}
 *    (a closing tab delivers SIGHUP from the shell and from the kernel within a millisecond) does
 *    not cut the close short, nor does a SIGTERM right after a SIGHUP or the other way round
 *    (r7g: bash closing the terminal of a stopped job); a later second signal still re-raises at
 *    once.
 *  - #6 ExitSignals.closing(): during the front end's final close a SIGINT closes first (bounded
 *    by the grace) and then re-raises; a second press re-raises at once; never re-armed after
 *    dispose().
 *  - #1(a) LineReader: an 'error' on the input (a hung-up terminal: `setRawMode EIO` while
 *    readline closes on the input's end) is end of input, never an unhandled 'error' event.
 *  - g2 LineReader `muted`: no prompt and no echo while it says so.
 *  - #1(b) main()'s stdout / stderr listener ignores EIO (a hung-up terminal) like EPIPE.
 *
 * ExitSignals re-raises the signal at its own process, so those cases run in a child node process
 * that imports the built module; the parent reads its log and its death signal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import * as mainModule from '../../src/cli/main.js';
import * as exitsModule from '../../src/repl/exitSignals.js';
import { LineReader, type LineReaderOptions, type ReadResult } from '../../src/repl/input.js';

// (loosely typed, so this file also builds against the code before the fix)
const { SIGNAL_CLOSE_GRACE_MS } = exitsModule;
const DUPLICATE_SIGNAL_WINDOW_MS = (exitsModule as { DUPLICATE_SIGNAL_WINDOW_MS?: number }).DUPLICATE_SIGNAL_WINDOW_MS ?? 500;
const ignoreClosedOutput = (mainModule as { ignoreClosedOutput?: (e: NodeJS.ErrnoException) => void }).ignoreClosedOutput;

const EXITS_URL = new URL('../../src/repl/exitSignals.js', import.meta.url).href;

/**
 * Child: an ExitSignals whose close takes `closeMs`, set up as `setup` says, then the signals of
 * `plan` (`[delayMs, signal]`, delays from the start) sent to itself.
 */
const CHILD = `
const { ExitSignals } = await import(process.argv[2]);
const cfg = JSON.parse(process.argv[3]);
const t0 = Date.now();
const log = (s) => process.stdout.write(\`\${Date.now() - t0} \${s}\\n\`);
const ex = new ExitSignals(async () => {
  log('close-start');
  await new Promise((r) => setTimeout(r, cfg.closeMs));
  log('close-done');
}, []);
for (const step of cfg.setup) ex[step]();
setInterval(() => undefined, 1000);
for (const [ms, sig] of cfg.plan) setTimeout(() => { log('send ' + sig); process.kill(process.pid, sig); }, ms);
log('ready');
`;

interface ChildRun {
  signal: NodeJS.Signals | null;
  code: number | null;
  /** ms after the first signal was sent until the child died. */
  diedAfter: number;
  lines: string[];
}

async function runChild(cfg: { closeMs: number; setup: string[]; plan: [number, NodeJS.Signals][] }): Promise<ChildRun> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r5f-exits-'));
  const file = path.join(dir, 'child.mjs');
  fs.writeFileSync(file, CHILD);
  try {
    const child = spawn(process.execPath, [file, EXITS_URL, JSON.stringify(cfg)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let firstSent: number | undefined;
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (firstSent === undefined && /send /.test(out)) firstSent = Date.now();
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const e = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
    clearTimeout(killer);
    assert.equal(err, '', `child stderr: ${err}`);
    return { ...e, diedAfter: Date.now() - (firstSent ?? Date.now()), lines: out.trim().split('\n') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('r5f #1(c): a duplicate of the first signal within the window does not cut the close short', { timeout: 30_000 }, async () => {
  // three SIGHUPs within a few ms (the shell's killpg, the kernel's SIGHUP to the old foreground group)
  const r = await runChild({ closeMs: 600, setup: ['ready'], plan: [[50, 'SIGHUP'], [52, 'SIGHUP'], [60, 'SIGHUP']] });
  assert.equal(r.signal, 'SIGHUP', JSON.stringify(r));
  assert.ok(r.lines.some((l) => /close-done/.test(l)), `the close was cut short:\n${r.lines.join('\n')}`);
  assert.equal(r.lines.filter((l) => /send SIGHUP/.test(l)).length, 3, r.lines.join('\n'));
  assert.equal(typeof (exitsModule as { DUPLICATE_SIGNAL_WINDOW_MS?: number }).DUPLICATE_SIGNAL_WINDOW_MS, 'number');
  assert.ok(DUPLICATE_SIGNAL_WINDOW_MS >= 100 && DUPLICATE_SIGNAL_WINDOW_MS < SIGNAL_CLOSE_GRACE_MS);
});

test('r5f #1(c): a repeat of the signal after the window still re-raises at once', { timeout: 30_000 }, async () => {
  const later = 50 + DUPLICATE_SIGNAL_WINDOW_MS + 250;
  const r = await runChild({ closeMs: 10_000, setup: ['ready'], plan: [[50, 'SIGTERM'], [later, 'SIGTERM']] });
  assert.equal(r.signal, 'SIGTERM', JSON.stringify(r));
  assert.ok(!r.lines.some((l) => /close-done/.test(l)), r.lines.join('\n'));
  // it lived to send the second one (the first did not end it), and that one cut the grace short
  assert.equal(r.lines.filter((l) => /send SIGTERM/.test(l)).length, 2, r.lines.join('\n'));
  assert.ok(r.diedAfter < SIGNAL_CLOSE_GRACE_MS - 300, `died ${r.diedAfter} ms after the first signal (second at +${later - 50})`);
});

test('r7g: a SIGTERM right after a SIGHUP (bash hanging up a stopped job), or the other way round, does not cut the close short', { timeout: 30_000 }, async () => {
  for (const [first, second] of [['SIGHUP', 'SIGTERM'], ['SIGTERM', 'SIGHUP']] as const) {
    const r = await runChild({ closeMs: 600, setup: ['ready'], plan: [[50, first], [52, second]] });
    assert.equal(r.signal, first, JSON.stringify(r));
    assert.ok(r.lines.some((l) => /close-done/.test(l)), `${first} then ${second}: the close was cut short:\n${r.lines.join('\n')}`);
  }
});

test('r7g: a SIGINT right after a SIGTERM (during the final close) still re-raises at once', { timeout: 30_000 }, async () => {
  const r = await runChild({ closeMs: 10_000, setup: ['ready', 'closing'], plan: [[50, 'SIGTERM'], [55, 'SIGINT']] });
  assert.equal(r.signal, 'SIGTERM', JSON.stringify(r));
  assert.ok(!r.lines.some((l) => /close-done/.test(l)), r.lines.join('\n'));
  assert.ok(r.diedAfter < 800, `died ${r.diedAfter} ms after the first signal`);
});

test('r5f #1(c): a different signal after the window still re-raises at once (the first one)', { timeout: 30_000 }, async () => {
  const later = 50 + DUPLICATE_SIGNAL_WINDOW_MS + 250;
  const r = await runChild({ closeMs: 10_000, setup: ['ready'], plan: [[50, 'SIGHUP'], [later, 'SIGTERM']] });
  assert.equal(r.signal, 'SIGHUP', JSON.stringify(r));
  assert.ok(!r.lines.some((l) => /close-done/.test(l)), r.lines.join('\n'));
  assert.ok(r.diedAfter < SIGNAL_CLOSE_GRACE_MS - 300, `died ${r.diedAfter} ms after the first signal (second at +${later - 50})`);
});

test('r5f #6: after closing(), a SIGINT during the final close closes first, then kiro-claude dies of SIGINT', { timeout: 30_000 }, async () => {
  const r = await runChild({ closeMs: 500, setup: ['ready', 'closing'], plan: [[50, 'SIGINT']] });
  assert.equal(r.signal, 'SIGINT', JSON.stringify(r));
  assert.ok(r.lines.some((l) => /close-start/.test(l)) && r.lines.some((l) => /close-done/.test(l)), r.lines.join('\n'));
});

test('r5f #6: after closing(), a second SIGINT (after the duplicate window) stops waiting', { timeout: 30_000 }, async () => {
  const later = 50 + DUPLICATE_SIGNAL_WINDOW_MS + 250;
  const r = await runChild({ closeMs: 10_000, setup: ['ready', 'closing'], plan: [[50, 'SIGINT'], [later, 'SIGINT']] });
  assert.equal(r.signal, 'SIGINT', JSON.stringify(r));
  assert.ok(!r.lines.some((l) => /close-done/.test(l)), r.lines.join('\n'));
  assert.equal(r.lines.filter((l) => /send SIGINT/.test(l)).length, 2, r.lines.join('\n'));
  assert.ok(r.diedAfter < SIGNAL_CLOSE_GRACE_MS - 300, `died ${r.diedAfter} ms after the first press`);
});

test('r5f #6: the grace still bounds a SIGINT close after closing()', { timeout: 30_000 }, async () => {
  const r = await runChild({ closeMs: 10_000, setup: ['ready', 'closing'], plan: [[50, 'SIGINT']] });
  assert.equal(r.signal, 'SIGINT', JSON.stringify(r));
  assert.ok(r.lines.some((l) => /close-start/.test(l)) && !r.lines.some((l) => /close-done/.test(l)), r.lines.join('\n'));
  assert.ok(r.diedAfter >= SIGNAL_CLOSE_GRACE_MS - 500 && r.diedAfter < SIGNAL_CLOSE_GRACE_MS + 2500, `died ${r.diedAfter} ms after the press`);
});

test('r5f #6: without closing() SIGINT stays the front end\'s after ready(); closing() after dispose() re-arms nothing', { timeout: 30_000 }, async () => {
  const a = await runChild({ closeMs: 500, setup: ['ready'], plan: [[50, 'SIGINT']] });
  assert.equal(a.signal, 'SIGINT');
  assert.ok(!a.lines.some((l) => /close-start/.test(l)), a.lines.join('\n'));
  const b = await runChild({ closeMs: 500, setup: ['ready', 'dispose', 'closing'], plan: [[50, 'SIGINT']] });
  assert.equal(b.signal, 'SIGINT');
  assert.ok(!b.lines.some((l) => /close-start/.test(l)), b.lines.join('\n'));
});

// ───────────────────────────── LineReader ─────────────────────────────

class FakeTty extends PassThrough {
  isTTY = true;
  isRaw = false;
  /** Like a hung-up tty: switching raw mode off fails with EIO (tty.ReadStream emits it). */
  hungUp = false;
  setRawMode(flag: boolean): this {
    if (this.hungUp) {
      this.emit('error', Object.assign(new Error('setRawMode EIO'), { code: 'EIO', syscall: 'setRawMode' }));
      return this;
    }
    this.isRaw = flag;
    return this;
  }
}

test('r5f #1(a): terminal mode, the input ends on a hung-up tty (setRawMode EIO): pending reads get eof, no unhandled error', async () => {
  const input = new FakeTty();
  const output = new PassThrough();
  output.resume();
  const reader = new LineReader({ input, output, terminal: true });
  const outer = reader.readInput('> ');
  const inner = reader.read('[y/n/t]: ');
  input.hungUp = true;
  // readline closes on the input's end and switches raw mode off: the EIO is re-emitted on its
  // Interface, which must have a listener
  assert.doesNotThrow(() => input.emit('end'));
  assert.deepEqual(await inner, { kind: 'eof' } satisfies ReadResult);
  assert.deepEqual(await outer, { kind: 'eof' } satisfies ReadResult);
  // a read started afterwards ends at once too
  assert.deepEqual(await reader.read('> '), { kind: 'eof' });
  reader.close();
});

test('r5f #1(a): terminal mode, the terminal hangs up with a half-typed line: the read gets eof, the text is not delivered', async () => {
  const input = new FakeTty();
  const output = new PassThrough();
  output.resume();
  const reader = new LineReader({ input, output, terminal: true });
  const p = reader.readInput('> ');
  input.write('half-typed, no Enter');
  await new Promise((r) => setTimeout(r, 20));
  input.hungUp = true;
  assert.doesNotThrow(() => input.emit('end'));
  assert.deepEqual(await p, { kind: 'eof' } satisfies ReadResult);
  reader.close();
});

test('r5f #1(a): an input error (read EIO) ends the input in both modes', async () => {
  for (const terminal of [true, false]) {
    const input = terminal ? new FakeTty() : new PassThrough();
    const output = new PassThrough();
    output.resume();
    const reader = new LineReader({ input, output, terminal });
    const p = reader.readInput('> ');
    assert.doesNotThrow(() => input.emit('error', Object.assign(new Error('read EIO'), { code: 'EIO' })), `terminal=${terminal}`);
    assert.deepEqual(await p, { kind: 'eof' }, `terminal=${terminal}`);
    reader.close();
  }
});

test('r5f g2: a muted LineReader writes no prompt and no echo (line mode), and still delivers lines', async () => {
  let muted = false;
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (d: Buffer) => (written += d.toString()));
  const reader = new LineReader({ input, output, terminal: false, muted: () => muted } as LineReaderOptions);
  const first = reader.readInput('> ');
  input.write('one\n');
  assert.deepEqual(await first, { kind: 'line', text: 'one' });
  await new Promise((r) => setImmediate(r));
  assert.equal(written, '> one\n');
  muted = true;
  const second = reader.readInput('> ');
  input.write('two\n');
  assert.deepEqual(await second, { kind: 'line', text: 'two' });
  reader.printAbove('notice\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(written, '> one\n', 'a muted reader wrote');
  reader.close();
});

test('r5f g2: a muted LineReader in terminal mode shows no prompt, drops typed keys (no echo, no line), and works again once unmuted', async () => {
  let muted = true;
  const input = new FakeTty();
  const output = new PassThrough();
  let written = '';
  output.on('data', (d: Buffer) => (written += d.toString()));
  const reader = new LineReader({ input, output, terminal: true, muted: () => muted } as LineReaderOptions);
  await new Promise((r) => setImmediate(r));
  written = ''; // the bracketed-paste switch at start
  let got: ReadResult | undefined;
  void reader.readInput('> ').then((r) => (got = r));
  input.write('typed during the grace\r');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got, undefined, 'a key typed while muted was delivered');
  assert.equal(written, '', `a muted reader wrote ${JSON.stringify(written)}`);
  muted = false;
  input.write('ok\r');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got, { kind: 'line', text: 'ok' });
  reader.close();
});

// ───────────────────────────── main() ─────────────────────────────

test('r5f #1(b): main()\'s stdout / stderr error listener ignores EIO, EPIPE and destroyed streams, rethrows the rest', () => {
  assert.equal(typeof ignoreClosedOutput, 'function');
  if (!ignoreClosedOutput) return;
  for (const code of ['EIO', 'EPIPE', 'ERR_STREAM_DESTROYED']) {
    assert.doesNotThrow(() => ignoreClosedOutput(Object.assign(new Error(code), { code })), code);
  }
  assert.throws(() => ignoreClosedOutput(Object.assign(new Error('nospace'), { code: 'ENOSPC' })), /nospace/);
});
