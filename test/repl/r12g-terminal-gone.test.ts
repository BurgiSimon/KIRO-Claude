/**
 * Round-12 follow-up "terminal" T3 and T4, unit level: the end of the terminal session while
 * kiro-claude is off the terminal (r12 #4: input.ts terminalGone, LineReader.endAsHungUp).
 *
 * T3: terminalGone and the reader's check while away after a stop counted ANY failure to read
 * /proc/self/stat, fstat or isatty as the end of the terminal session: out of file descriptors
 * (EMFILE) or memory, the chat closed silently with exit status 0. Only a positive answer counts
 * now (the input no longer a terminal, `tty_nr` 0 or another terminal, an error that is no
 * transient one); a transient error is "cannot tell", which never ends the session.
 *
 * T4: once the terminal session ended that way (the hand-back after a child, the reader away
 * after a stop), the REPL still drew the next prompt, wrote the resume hint and turned bracketed
 * paste off on the hung-up terminal (EIO ignored), where the start's own 'gone' path writes
 * nothing. Now nothing more is written to the terminal on every such path; the resume hint still
 * goes to a stdout that is no terminal (a pipe).
 *
 * In-process: fake TTYs and the seams (a real fd exhaustion: r12g-terminal-gone-pty.test.ts).
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { openSettings } from '../../src/config/settings.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { Repl } from '../../src/repl/core.js';
import * as inputMod from '../../src/repl/input.js';
import type { ReplDeps } from '../../src/repl/types.js';
import type { CliContext, KiroSession, KiroSessionOptions } from '../../src/types.js';
import { stripAnsi } from '../../src/util/ansi.js';
import { tempEnv } from './harness.js';
import { MockSession } from './mockSession.js';

// (a namespace import: a check fails on its own where an export is missing, not the whole file)
const { LineReader } = inputMod;
type LineReader = InstanceType<typeof inputMod.LineReader>;

const skip = process.platform === 'win32' ? 'POSIX job control' : false;

/** The system calls of the controlling-terminal check, as a test gives them (input.ts TtySys). */
interface Sys {
  isatty(fd: number): boolean;
  procStat(): string;
  rdev(fd: number): number;
}
const terminalGone = inputMod.terminalGone as (input: unknown, sys?: Sys) => () => boolean;
const controllingTerminal = (inputMod as unknown as Record<string, unknown>).controllingTerminal as ((input: unknown, sys?: Sys) => boolean | undefined) | undefined;

const FD = 7;
const PTS = (136 << 8) | 3;
const OTHER = (136 << 8) | 9;
/** /proc/self/stat with this tty_nr (pgrp = tpgid: the foreground). */
const stat = (ttyNr: number): string => `4242 (node (x) y) S 1 4242 4000 ${ttyNr} 4242 4194560 1 0 0 0 0 0 0 0 20 0 11 0 9 1 1`;
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: test`), { code });

/** A seam whose answers the test changes: `state` is what the next calls see. */
function sys(): { s: Sys; state: { tty: boolean; ttyNr: number; rdev: number; statError?: string; rdevError?: string } } {
  const state: { tty: boolean; ttyNr: number; rdev: number; statError?: string; rdevError?: string } = { tty: true, ttyNr: PTS, rdev: PTS };
  return {
    state,
    s: {
      isatty: () => state.tty,
      procStat: () => {
        if (state.statError) throw errno(state.statError);
        return stat(state.ttyNr);
      },
      rdev: () => {
        if (state.rdevError) throw errno(state.rdevError);
        return state.rdev;
      },
    },
  };
}

const linux = process.platform === 'linux' ? false : 'Linux /proc';

test('r12g T3: terminalGone: a transient error reading /proc/self/stat or fstat (EMFILE, ENFILE, ENOMEM, EAGAIN, EINTR) is "cannot tell", never the end of the terminal session', { skip: linux }, () => {
  const { s, state } = sys();
  const gone = terminalGone({ fd: FD }, s);
  assert.equal(gone(), false, 'still the controlling terminal');
  for (const code of ['EMFILE', 'ENFILE', 'ENOMEM', 'EAGAIN', 'EINTR']) {
    state.statError = code;
    assert.equal(gone(), false, `/proc/self/stat failing with ${code} ended the terminal session`);
    state.statError = undefined;
    state.rdevError = code;
    assert.equal(gone(), false, `fstat failing with ${code} ended the terminal session`);
    state.rdevError = undefined;
  }
  assert.equal(gone(), false);
});

test('r12g T3: terminalGone: a positive answer still ends it (control): isatty fails, tty_nr 0, another terminal, an EIO from fstat', { skip: linux }, () => {
  for (const end of ['isatty', 'tty_nr 0', 'another terminal', 'fstat EIO'] as const) {
    const { s, state } = sys();
    const gone = terminalGone({ fd: FD }, s);
    assert.equal(gone(), false, `${end}: armed`);
    if (end === 'isatty') state.tty = false;
    else if (end === 'tty_nr 0') state.ttyNr = 0;
    else if (end === 'another terminal') state.ttyNr = OTHER;
    else state.rdevError = 'EIO';
    assert.equal(gone(), true, `${end}: the end of the terminal session was not seen`);
  }
});

test('r12g T3: terminalGone: a watch made while it cannot be told is armed by the first answer that it is the controlling terminal, and never by a "cannot tell"', { skip: linux }, () => {
  const { s, state } = sys();
  state.statError = 'EMFILE';
  const gone = terminalGone({ fd: FD }, s);
  assert.equal(gone(), false);
  state.statError = undefined;
  state.ttyNr = 0;
  // never seen as the controlling terminal: no end of a session it is known to have had
  assert.equal(gone(), false, 'a terminal never seen as the controlling one ended the session');
  state.ttyNr = PTS;
  assert.equal(gone(), false);
  state.ttyNr = 0;
  assert.equal(gone(), true, 'armed once seen as the controlling terminal');
  // and never for an input that is no controlling terminal at all (unchanged)
  const other = sys();
  other.state.ttyNr = OTHER;
  const g2 = terminalGone({ fd: FD }, other.s);
  other.state.ttyNr = 0;
  assert.equal(g2(), false);
});

test('r12g T3: controllingTerminal answers true / false, and undefined when it cannot be told (the reader\'s default `controlling`)', { skip: linux }, () => {
  assert.equal(typeof controllingTerminal, 'function', 'input.ts exports controllingTerminal');
  const { s, state } = sys();
  assert.equal(controllingTerminal!({ fd: FD }, s), true);
  state.statError = 'EMFILE';
  assert.equal(controllingTerminal!({ fd: FD }, s), undefined, 'EMFILE');
  state.statError = undefined;
  state.rdevError = 'ENOMEM';
  assert.equal(controllingTerminal!({ fd: FD }, s), undefined, 'ENOMEM');
  state.rdevError = undefined;
  state.ttyNr = 0;
  assert.equal(controllingTerminal!({ fd: FD }, s), false);
  assert.equal(controllingTerminal!(new PassThrough()), false, 'a fake: no terminal file descriptor');
});

test('r12g T3: terminalInForeground is false (not known to be the foreground: look again) while it cannot be told, so a wait off the terminal goes on; true for the foreground as before', { skip: linux }, () => {
  const inForeground = inputMod.terminalInForeground as (input: unknown, probe?: boolean, sys?: Sys) => boolean;
  const { s, state } = sys();
  assert.equal(inForeground({ fd: FD }, true, s), true, 'the foreground (pgrp = tpgid)');
  state.statError = 'EMFILE';
  assert.equal(inForeground({ fd: FD }, true, s), false, 'EMFILE taken for the foreground: the wait ended and the terminal was taken');
  state.statError = undefined;
  state.ttyNr = 0;
  assert.equal(inForeground({ fd: FD }, true, s), true, 'no controlling terminal: no job control applies (unchanged)');
});

// ───────────────────────────── the reader away after a stop ─────────────────────────────

function cleanSigcont(t: TestContext): void {
  const before = new Set(process.listeners('SIGCONT'));
  t.after(() => {
    for (const l of process.listeners('SIGCONT')) if (!before.has(l)) process.removeListener('SIGCONT', l as () => void);
  });
}

function ttyIo(log: string[]): { input: PassThrough; output: Writable } {
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
  return { input, output };
}

test('r12g T3: away after a stop, a look that cannot tell whether the input is still the controlling terminal does not end the input; `fg` takes it back', { skip }, async (t) => {
  cleanSigcont(t);
  const log: string[] = [];
  const { input, output } = ttyIo(log);
  let controlling: boolean | undefined = true;
  let fg = false;
  const r = new LineReader({
    input,
    output,
    terminal: true,
    foreground: () => fg,
    stopInBackground: () => false,
    controlling: (() => controlling) as () => boolean,
  });
  t.after(() => r.close());
  const p = r.readInput('> ');
  await new Promise((res) => setImmediate(res));
  // a stop from elsewhere, continued in the background (`bg`): away, polling the foreground
  process.emit('SIGCONT');
  await new Promise((res) => setTimeout(res, 60));
  // out of file descriptors: /proc cannot be read now
  controlling = undefined;
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(await Promise.race([p, new Promise((res) => setTimeout(() => res('pending'), 100))]), 'pending', 'the input ended: "cannot tell" taken for the end of the terminal session');
  const mark = log.length;
  fg = true;
  await new Promise((res) => setTimeout(res, 80));
  assert.ok(log.slice(mark).includes('raw:true'), `not taken back: ${JSON.stringify(log.slice(mark))}`);
  input.write('hi\r');
  assert.deepEqual(await p, { kind: 'line', text: 'hi' });
  assert.equal(r.hungUp, false);
});

test('r12g T3: away after a stop that could not be told at the stop, a later look that finds the controlling terminal arms the check: its loss then ends the input (control)', { skip }, async (t) => {
  cleanSigcont(t);
  const log: string[] = [];
  const { input, output } = ttyIo(log);
  let controlling: boolean | undefined;
  let fg = false;
  const r = new LineReader({ input, output, terminal: true, foreground: () => fg, stopInBackground: () => false, controlling: (() => controlling) as () => boolean });
  t.after(() => r.close());
  const p = r.readInput('> ');
  await new Promise((res) => setImmediate(res));
  process.emit('SIGCONT');
  await new Promise((res) => setTimeout(res, 60));
  controlling = true;
  await new Promise((res) => setTimeout(res, 80));
  const mark = log.length;
  controlling = false;
  fg = true;
  assert.deepEqual(await Promise.race([p, new Promise((res) => setTimeout(() => res('pending'), 2000))]), { kind: 'eof' });
  assert.deepEqual(log.slice(mark), [], 'the terminal was touched after the session ended');
});

// ───────────────────────────── T4: nothing written once the session ended ─────────────────────────────

test('r12g T4: once the terminal session ended (endAsHungUp), a read draws no prompt and close() writes nothing and switches no mode', { skip }, async (t) => {
  cleanSigcont(t);
  const log: string[] = [];
  const { input, output } = ttyIo(log);
  const r = new LineReader({ input, output, terminal: true, foreground: () => true, stopInBackground: () => false, controlling: () => true });
  const first = r.readInput('> ');
  await new Promise((res) => setImmediate(res));
  const mark = log.length;
  r.endAsHungUp();
  assert.deepEqual(await first, { kind: 'eof' });
  assert.equal((r as unknown as { terminalEnded?: unknown }).terminalEnded, true, 'LineReader.terminalEnded');
  assert.deepEqual(await r.read('Allow? '), { kind: 'eof' });
  r.close();
  assert.deepEqual(log.slice(mark), [], 'written to the hung-up terminal or its mode switched');
});

/** A REPL in terminal mode on fake streams, the instance at hand (its reader). */
function startRepl(t: TestContext, stdoutTty: boolean): { repl: Repl; raw: () => string; exit: Promise<number>; session: MockSession } {
  const env = tempEnv();
  t.after(() => env.cleanup());
  const ws = createWorkspaceContext(env.wsDir, env.env);
  const settings = openSettings(ws);
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
  const stdout = new PassThrough();
  if (stdoutTty) Object.assign(stdout, { isTTY: true, columns: 100 });
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
  };
  const repl = new Repl({ ctx, sessionOptions: {} }, deps);
  return { repl, raw: () => raw, exit: repl.run(), session };
}

async function promptUp(raw: () => string): Promise<void> {
  const t0 = Date.now();
  while (!/> $/.test(stripAnsi(raw()))) {
    if (Date.now() - t0 > 5000) throw new Error(`no prompt:\n${stripAnsi(raw())}`);
    await new Promise((res) => setTimeout(res, 5));
  }
}

test('r12g T4: the REPL whose terminal session ended off the terminal (the hand-back, the reader away) closes its session and writes nothing more to the terminal: no prompt, no resume hint, no bracketed-paste switch', { skip }, async (t) => {
  cleanSigcont(t);
  const { repl, raw, exit, session } = startRepl(t, true);
  await promptUp(raw);
  const mark = raw().length;
  (repl as unknown as { reader: LineReader }).reader.endAsHungUp();
  assert.equal(await exit, 0);
  assert.equal(session.closed, true, 'the session was not closed');
  assert.equal(raw().slice(mark), '', 'written to the hung-up terminal after its session ended');
});

test('r12g T4: the same with stdout piped (`kiro-claude chat | tee log`): the resume hint still goes to the pipe, nothing else', { skip }, async (t) => {
  cleanSigcont(t);
  const { repl, raw, exit, session } = startRepl(t, false);
  await promptUp(raw);
  const mark = raw().length;
  (repl as unknown as { reader: LineReader }).reader.endAsHungUp();
  assert.equal(await exit, 0);
  assert.equal(session.closed, true);
  const after = raw().slice(mark);
  assert.match(stripAnsi(after), /^\nTo resume this session: kiro-claude chat --resume-id \S+\n$/, JSON.stringify(after));
});
