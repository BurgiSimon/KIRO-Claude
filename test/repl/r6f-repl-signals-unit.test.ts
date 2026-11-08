/**
 * Round-6 fix "repl-signals" #3, unit level (the pty guard is r6f-repl-signals-pty.test.ts):
 *  - LineReader `hungUp`: true once a terminal-mode input ended or failed (a hung-up terminal; in
 *    raw mode Ctrl+D is a key, never an end of input), never in line mode or after a Ctrl+D.
 *  - ExitSignals `awaitSignal(ms)`: resolves at the first signal, at once when one was received or
 *    the listeners are gone, else after `ms`; its timer keeps the process alive meanwhile, so a
 *    signal libuv already queued is dispatched, not dropped. Run in a child node process (the
 *    signal is re-raised at its own process).
 *  - The REPL with its signal handlers: a terminal input that ends without a SIGHUP is quit only
 *    after that bounded wait (exit 0 with the resume hint); a terminal Ctrl+D quit and a line-mode
 *    end of input are not delayed (measured).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';

import { openSettings } from '../../src/config/settings.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { runReplWith } from '../../src/repl/core.js';
import * as exitsModule from '../../src/repl/exitSignals.js';
import { LineReader } from '../../src/repl/input.js';
import type { ReplDeps } from '../../src/repl/types.js';
import type { CliContext, KiroSession, KiroSessionOptions } from '../../src/types.js';
import { stripAnsi } from '../../src/util/ansi.js';
import { tempEnv } from './harness.js';
import { MockSession } from './mockSession.js';

const DUPLICATE_SIGNAL_WINDOW_MS = (exitsModule as { DUPLICATE_SIGNAL_WINDOW_MS?: number }).DUPLICATE_SIGNAL_WINDOW_MS ?? 500;
const EXITS_URL = new URL('../../src/repl/exitSignals.js', import.meta.url).href;

// (loosely typed, so this file also builds against the code before the fix)
const hungUp = (r: LineReader): unknown => (r as unknown as { hungUp?: unknown }).hungUp;

class FakeTty extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(flag: boolean): this {
    this.isRaw = flag;
    return this;
  }
}

// ───────────────────────────── LineReader.hungUp ─────────────────────────────

test('r6f #3: LineReader.hungUp is set when the terminal input ends (the terminal hung up)', async () => {
  const input = new FakeTty();
  const output = new PassThrough();
  output.resume();
  const reader = new LineReader({ input, output, terminal: true });
  const p = reader.readInput('> ');
  assert.equal(hungUp(reader), false);
  input.emit('end');
  assert.deepEqual(await p, { kind: 'eof' });
  assert.equal(hungUp(reader), true);
  reader.close();
});

test('r6f #3: LineReader.hungUp is set when the terminal input fails (read EIO)', async () => {
  const input = new FakeTty();
  const output = new PassThrough();
  output.resume();
  const reader = new LineReader({ input, output, terminal: true });
  const p = reader.readInput('> ');
  input.emit('error', Object.assign(new Error('read EIO'), { code: 'EIO' }));
  assert.deepEqual(await p, { kind: 'eof' });
  assert.equal(hungUp(reader), true);
  reader.close();
});

test('r6f #3: LineReader.hungUp stays false after a terminal Ctrl+D and for a line-mode end of input', async () => {
  const input = new FakeTty();
  const output = new PassThrough();
  output.resume();
  const reader = new LineReader({ input, output, terminal: true });
  const p = reader.readInput('> ');
  input.write('\u0004');
  assert.deepEqual(await p, { kind: 'ctrl-d' });
  assert.equal(hungUp(reader), false);
  reader.close();

  const pipe = new PassThrough();
  const out2 = new PassThrough();
  out2.resume();
  const lines = new LineReader({ input: pipe, output: out2, terminal: false });
  const q = lines.readInput('> ');
  pipe.end();
  assert.deepEqual(await q, { kind: 'eof' });
  assert.equal(hungUp(lines), false);
  lines.close();

  // an input error in line mode ends the input too, but is no hangup either
  const pipe2 = new PassThrough();
  const out3 = new PassThrough();
  out3.resume();
  const failing = new LineReader({ input: pipe2, output: out3, terminal: false });
  const f = failing.readInput('> ');
  pipe2.emit('error', Object.assign(new Error('read EIO'), { code: 'EIO' }));
  assert.deepEqual(await f, { kind: 'eof' });
  assert.equal(hungUp(failing), false, 'line mode never reports a hangup');
  failing.close();
});

// ───────────────────────────── ExitSignals.awaitSignal ─────────────────────────────

/**
 * Child: an ExitSignals (ready) whose close takes `closeMs`, the signals of `plan` sent to itself,
 * then `awaitSignal(wait)` (after `firstWait` ms, and after dispose() when `dispose`). Nothing
 * else holds the event loop: once the plan's timers fired only awaitSignal's timer keeps it alive.
 */
const CHILD = `
const { ExitSignals } = await import(process.argv[2]);
const cfg = JSON.parse(process.argv[3]);
const { performance } = await import('node:perf_hooks');
const t0 = performance.now();
const log = (s) => process.stdout.write(Math.round(performance.now() - t0) + ' ' + s + '\\n');
const ex = new ExitSignals(async () => {
  log('close-start');
  await new Promise((r) => setTimeout(r, cfg.closeMs));
  log('close-done');
}, []);
ex.ready();
if (cfg.dispose) ex.dispose();
for (const [ms, sig] of cfg.plan) setTimeout(() => { log('send ' + sig); process.kill(process.pid, sig); }, ms);
if (cfg.firstWait) await new Promise((r) => setTimeout(r, cfg.firstWait));
log('wait');
await ex.awaitSignal(cfg.wait);
log('awaited ' + (ex.received ?? 'none'));
if (ex.received) await ex.die();
ex.dispose();
log('end');
`;

interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** [ms since start, text] */
  lines: [number, string][];
}

async function runChild(cfg: { closeMs: number; plan: [number, NodeJS.Signals][]; wait: number; firstWait?: number; dispose?: boolean }): Promise<ChildRun> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r6f-exits-'));
  const file = path.join(dir, 'child.mjs');
  fs.writeFileSync(file, CHILD);
  try {
    const child = spawn(process.execPath, [file, EXITS_URL, JSON.stringify(cfg)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const e = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
    clearTimeout(killer);
    assert.equal(err, '', `child stderr: ${err}`);
    const lines = out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l): [number, string] => {
        const i = l.indexOf(' ');
        return [Number(l.slice(0, i)), l.slice(i + 1)];
      });
    return { ...e, lines };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const at = (r: ChildRun, re: RegExp): number | undefined => r.lines.find(([, s]) => re.test(s))?.[0];

test('r6f #3: ExitSignals.awaitSignal without a signal resolves after its bound and keeps the process alive meanwhile', { timeout: 30_000 }, async () => {
  const r = await runChild({ closeMs: 0, plan: [], wait: 300 });
  const show = JSON.stringify(r);
  assert.equal(r.code, 0, show);
  const w = at(r, /^wait$/);
  const a = at(r, /^awaited none$/);
  assert.ok(w !== undefined && a !== undefined, `the wait did not keep the process alive: ${show}`);
  assert.ok(a - w >= 280 && a - w < 1500, show);
  assert.ok(at(r, /^end$/) !== undefined, show);
});

test('r6f #3: ExitSignals.awaitSignal resolves at the signal, and the close then re-raises it', { timeout: 30_000 }, async () => {
  const r = await runChild({ closeMs: 100, plan: [[100, 'SIGHUP']], wait: 5000 });
  const show = JSON.stringify(r);
  assert.equal(r.signal, 'SIGHUP', show);
  const sent = at(r, /^send SIGHUP$/);
  const a = at(r, /^awaited SIGHUP$/);
  assert.ok(sent !== undefined && a !== undefined, show);
  assert.ok(a - sent < 200, `awaitSignal resolved ${a - sent} ms after the signal: ${show}`);
  assert.ok(at(r, /^close-done$/) !== undefined, show);
});

test('r6f #3: ExitSignals.awaitSignal resolves at once when a signal was already received, or after dispose()', { timeout: 30_000 }, async () => {
  const a = await runChild({ closeMs: 600, plan: [[20, 'SIGTERM']], firstWait: 150, wait: 5000 });
  const showA = JSON.stringify(a);
  assert.equal(a.signal, 'SIGTERM', showA);
  const wa = at(a, /^wait$/);
  const aa = at(a, /^awaited SIGTERM$/);
  assert.ok(wa !== undefined && aa !== undefined && aa - wa < 100, showA);

  const b = await runChild({ closeMs: 0, plan: [], dispose: true, wait: 5000 });
  const showB = JSON.stringify(b);
  assert.equal(b.code, 0, showB);
  const wb = at(b, /^wait$/);
  const ab = at(b, /^awaited none$/);
  assert.ok(wb !== undefined && ab !== undefined && ab - wb < 100, showB);
});

// ───────────────────────────── the REPL's quit after an end of input ─────────────────────────────

/** The REPL over a MockSession with its signal handlers installed (none is ever sent here). */
function startSignalRepl(tty: boolean): { stdin: PassThrough; out: () => string; exit: Promise<number>; session: MockSession; cleanup: () => void } {
  const t = tempEnv();
  const ws = createWorkspaceContext(t.wsDir, t.env);
  const settings = openSettings(ws);
  const stdin = tty ? new FakeTty() : new PassThrough();
  const stdout = new PassThrough();
  if (tty) Object.assign(stdout, { isTTY: true, columns: 100 });
  let raw = '';
  stdout.on('data', (d: Buffer) => (raw += d.toString('utf8')));
  const ctx: CliContext = {
    ws,
    settings,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    progName: 'kiro-claude',
    verbosity: 0,
  };
  const session = new MockSession();
  const deps: ReplDeps = {
    async createSession(opts: KiroSessionOptions): Promise<KiroSession> {
      session.ui = opts.ui;
      session.opts = opts;
      return session;
    },
    random: () => 0,
    installSignalHandlers: true,
  };
  const exit = runReplWith({ ctx, sessionOptions: {} }, deps);
  return { stdin, out: () => stripAnsi(raw), exit, session, cleanup: () => t.cleanup() };
}

async function waitOut(r: { out: () => string }, re: RegExp, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!re.test(r.out())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${re}; output:\n${r.out()}`);
    await new Promise((res) => setTimeout(res, 5));
  }
}

const sigListeners = (): number => process.listenerCount('SIGHUP') + process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');

test('r6f #3: the terminal input ends without a SIGHUP: the REPL waits for the signal (bounded), then quits as usual (exit 0, resume hint)', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const before = sigListeners();
  const r = startSignalRepl(true);
  try {
    await waitOut(r, /> $/);
    const t0 = performance.now();
    r.stdin.end();
    const code = await r.exit;
    const ms = performance.now() - t0;
    assert.equal(code, 0);
    assert.match(r.out(), /To resume this session: kiro-claude chat --resume-id /);
    assert.ok(ms >= DUPLICATE_SIGNAL_WINDOW_MS - 50, `quit ${ms.toFixed(0)} ms after the hangup: the REPL did not wait for its SIGHUP`);
    assert.ok(ms < DUPLICATE_SIGNAL_WINDOW_MS + 1500, `quit ${ms.toFixed(0)} ms after the hangup`);
    assert.equal(sigListeners(), before, 'signal listeners were left behind');
  } finally {
    r.cleanup();
  }
});

test('r6f #3: a terminal Ctrl+D quit and a line-mode end of input are not delayed by the hangup wait (measured)', { skip: process.platform === 'win32', timeout: 30_000 }, async (t) => {
  const before = sigListeners();
  const a = startSignalRepl(true);
  try {
    await waitOut(a, /> $/);
    a.stdin.write('\u0004');
    await waitOut(a, /press Ctrl\+C or Ctrl\+D again/);
    const t0 = performance.now();
    a.stdin.write('\u0004');
    assert.equal(await a.exit, 0);
    const ms = performance.now() - t0;
    t.diagnostic(`terminal Ctrl+D quit: ${ms.toFixed(1)} ms`);
    assert.match(a.out(), /To resume this session: kiro-claude chat --resume-id /);
    assert.ok(ms < Math.min(250, DUPLICATE_SIGNAL_WINDOW_MS / 2), `the Ctrl+D quit took ${ms.toFixed(0)} ms`);
  } finally {
    a.cleanup();
  }
  const b = startSignalRepl(false);
  try {
    await waitOut(b, /> $/);
    const t0 = performance.now();
    b.stdin.end();
    assert.equal(await b.exit, 0);
    const ms = performance.now() - t0;
    t.diagnostic(`line-mode end of input: ${ms.toFixed(1)} ms`);
    assert.match(b.out(), /To resume this session: kiro-claude chat --resume-id /);
    assert.ok(ms < Math.min(250, DUPLICATE_SIGNAL_WINDOW_MS / 2), `the line-mode end of input took ${ms.toFixed(0)} ms`);
  } finally {
    b.cleanup();
  }
  assert.equal(sigListeners(), before, 'signal listeners were left behind');
});
