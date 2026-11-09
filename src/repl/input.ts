/**
 * Line input for the chat REPL (01 §4.3, §4.5; 06 §2.2).
 *
 * {@link LineReader} reads physical lines from the REPL's input stream in one of two modes:
 *
 *  - **terminal** (stdin is a TTY): `node:readline` with raw keys. Emacs editing, Up/Down
 *    history, Tab completion and Ctrl+L come from readline. On top of it (by wrapping
 *    readline's `_ttyWrite`, the documented-by-usage monkeypatch point Node keeps for
 *    compatibility):
 *      - `Ctrl+J` (LF) and `Alt+Enter` insert a newline: the current physical line is accepted
 *        as a non-final line of a multi-line input (01 §4.5 P1);
 *      - bracketed paste (`ESC[200~ … ESC[201~`) keeps pasted newlines inside one input. It is
 *        off whenever the reader hands the terminal over: to the shell at Ctrl+Z, and to a child
 *        (`!cmd`, `$EDITOR`), which gets plain pastes, as from Q's rustyline and from bash (r9 #8);
 *        and on again whenever the terminal is taken back: after a stop, and after a child, which
 *        may have toggled it itself (vim at exit; bash before `fg` continues a job stopped while
 *        the child owned the terminal; r8 #2). The switches are written to the reader's own
 *        output only, in terminal mode, and none while muted;
 *      - `Ctrl+C` ⇒ `interrupt` (resolves the active read, or emits `'interrupt'` while no
 *        read is active, i.e. while a turn runs); ignored while a child owns the terminal
 *        (suspended: the SIGINT is the child's);
 *      - `Ctrl+D` on an empty line ⇒ `ctrl-d` (Q treats it like Ctrl+C, 06 §2.2);
 *      - `Shift+Tab` ⇒ `'shift-tab'` event (Kiro TUI plan-mode toggle, 01 §4.5 P2);
 *      - `Ctrl+Z` (POSIX) suspends kiro-claude like the terminal's own Ctrl+Z, and as rustyline's
 *        suspend does in Q: bracketed paste and raw mode are turned off, SIGTSTP stops
 *        kiro-claude's process group (a wrapper such as `npx` included), and once it continues
 *        (`fg`; at once when the stop is discarded because the group is orphaned: kiro-claude is
 *        the terminal's session leader, as under `ssh -t`, `docker run -it` or `tmux new 'cmd'`)
 *        raw mode and bracketed paste are back and the active read's prompt is drawn again with
 *        its half-typed line. As a PID namespace's init on Linux (`unshare --fork --pid
 *        --mount-proc kiro-claude chat`), which no default-action stop signal stops, Ctrl+Z does
 *        nothing (r12 #2: the SIGTSTP stopped only `unshare`, the shell took the terminal and the
 *        chat ran on behind it). readline's own suspend is never used: it left the input paused
 *        after SIGCONT, and raw mode off when the stop was discarded (r7 #2). While no read is
 *        active (a turn runs) Ctrl+Z is kept as type-ahead: the stop happens at the next prompt,
 *        once it is drawn, and an approval prompt drops it with the rest; presses typed ahead
 *        stop the chat once (one Ctrl+Z is kept, and one replayed drops any other: r8 #4)
 *        (DECISION: Q, whose terminal is in cooked mode then, stops at once; kiro-claude stops
 *        between turns, when nothing of the turn runs on: Claude Code and hook commands run in
 *        process groups of their own and go on while it is stopped). However kiro-claude is
 *        stopped (here, at an approval prompt while other calls' hooks run, or from elsewhere),
 *        the stop does not count against a hook command's timeout or a control request's, and a
 *        hook that exited meanwhile keeps its exit status, a block included (util/process.ts
 *        runningTimeout, r8 #0/#1). A Ctrl+Z inside a paste, read while a child owns the
 *        terminal, or while muted is dropped. After a stop from elsewhere
 *        (`kill -TSTP` / `kill -STOP`, then `fg`: the shell left the terminal in cooked mode) the
 *        terminal is taken back the same way at SIGCONT, the prompt drawn on a fresh line. Such a
 *        stop is seen before the keys typed in the shell meanwhile are read (r11 #0: libuv
 *        dispatches the SIGCONT after the other I/O of its poll, so they were read first, in the
 *        shell's canonical mode: a Ctrl+D was an end of input taken for a hangup, a Return a soft
 *        newline): while the input flows an unref'd heartbeat ({@link INPUT_BEAT_MS}, 100 ms) gives
 *        the poll a finite timeout, and a beat that finds a gap (over {@link INPUT_GAP_MS}) parks
 *        the input, its reading stopped, until the check phase after the next poll (a prompt
 *        drawn in that poll, by Claude Code's output read before the SIGCONT, leaves it paused:
 *        readline's prompt() would resume it); a SIGCONT
 *        in that poll makes it a stop, none a blocked event loop, and the input goes on as if
 *        nothing happened (no redraw, no mode change, the keys raw and in the order typed). Keys
 *        typed during a stop with no shell that could take the terminal (kiro-claude leads its
 *        session) are raw keys and read as such. Either way they are read after the Claude Code
 *        output that came meanwhile (its pipe is read while the terminal is held), so for a
 *        permission request in it they were typed before its approval question was drawn: they
 *        are dropped there, as type-ahead always is (below, r12 #0).
 *        From the stop on the input is paused and nothing is drawn until the terminal is taken
 *        back, which happens two event-loop turns after the continue, never inside the stop's
 *        callback or the SIGCONT dispatch, and only in the foreground (r9 #0/#1: a mode change
 *        from the background stops kiro-claude again at once, SIGTTOU, before the other SIGCONT
 *        listeners and the signals that came with the continue run). So `kill %1` of a stopped
 *        chat (bash: SIGTERM, then SIGCONT) or a closed terminal (SIGHUP) closes it at once,
 *        muted, with the terminal left as the shell has it; and continued in the background
 *        (`bg`, `kill -CONT` while a shell holds the terminal) the chat stays off the terminal
 *        (no prompt, no mode change, no read) until `fg`: its SIGCONT, or the next look at the
 *        foreground ({@link FOREGROUND_POLL_MS}, 20 ms, while away in the background only:
 *        bash's `fg` of a job it knows to be running sends none). While a read waits for the
 *        terminal there (the prompt, an approval, a question) such a look stops kiro-claude like
 *        a background job that reads its terminal ({@link stopForTerminal}, r11: 'Stopped (tty
 *        input)'; under `sudo` with `use_pty` the polling alone never came up after `fg`), as
 *        Q's rustyline and any terminal program stop there; `bg` or a `kill -CONT` continue it
 *        and the next look stops it again (with SIGTSTP after a stop that came back at once:
 *        {@link TerminalStops}, and when another process of its group holds SIGTTIN off and none
 *        SIGTSTP, GNU `timeout`: r12 #5, {@link groupHoldsOff}); a turn without a read runs on (its
 *        output still written there) until its prompt. The foreground test is Linux's
 *        /proc/self/stat ({@link terminalInForeground}; in a PID namespace with its own /proc and
 *        no job-control shell, where the job's IDs read 0, a short-lived `stty` child that the
 *        kernel stops in the background, r12 #2, {@link probeForeground}); elsewhere (DECISION, no
 *        portable tcgetpgrp without a native module) it takes the foreground: after `bg` the chat
 *        stops again (SIGTTOU) at the retake until `fg`, as before, while the deferral still lets a
 *        fatal signal win. An input that was the controlling terminal when the reader went away
 *        and is not any more (the terminal session ended; no SIGHUP reaches an orphaned group that
 *        is not stopped) ends as at a hangup at the retake, nothing touched (r12 #4,
 *        {@link LineReader.endAsHungUp}). {@link LineReader.close} in the background (away, or not in the
 *        foreground) changes no mode and writes nothing either (r10 #3: readline's close() turned
 *        raw mode off from there, and SIGTTOU stopped kiro-claude until `fg`);
 *      - keys queued in the shell's cooked mode: when the reader takes the terminal back after a
 *        stop (typed after `fg` before the retake; after a stop from elsewhere also those typed in
 *        the shell before `fg`, `sleep 1; fg`), after a child that ended while kiro-claude was
 *        in the background ({@link LineReader.resume} `cooked`) and when it is created after the
 *        chat waited in the background (LineReaderOptions.cooked), what the terminal had queued is
 *        read as typed there (r10 #2, {@link cookedKeys}): its Return (a newline after ICRNL, else
 *        Ctrl+J, a soft newline) submits, and its Ctrl+D (canonical mode's NUL placeholder, else
 *        dropped) is Ctrl+D. That is what is read before the second check phase after the switch;
 *        later keys are raw. Not for an approval prompt (its answer is typed at its question), and
 *        not after a child that ended in the foreground or for a chat that started there: a
 *        newline typed meanwhile stays a soft newline, as in Q (a paste stays one input);
 *      - while no read is active, other keys are kept as type-ahead and replayed into the next
 *        read (rustyline left them in the TTY buffer, so Classic behaves the same); reads with
 *        `discardTypeahead` (approval prompts) drop them, so text typed while a response
 *        streamed can never answer a `[y/n/t]` question by accident (DECISION). The approval
 *        prompt (repl/core.ts approvalFlow) is the only such read: the prompt and the other
 *        questions (`ask`, `confirm`, `choose`: a Stop hook's choice, the plan-mode `[y/n]`, the
 *        `/spec` menus) take type-ahead, as rustyline's next read took what was typed. That holds
 *        also for keys kiro-claude could not read before the request came (r12 #0): while the
 *        heartbeat parks the input, and while it is away after a continue, Claude Code's pipe is
 *        still read, so a permission request typed after them is read first. An approval whose
 *        read starts while the input is held, or in the poll that gives it back ({@link
 *        LineReader.release}), or with the heartbeat overdue (a stall that ended in the callbacks
 *        that read the request, before its question was drawn: a long synchronous step, a write to
 *        a terminal that does not drain, a slow `ssh` link; the input is parked then, as the beat
 *        would have; r12 verification), drops what is read for it up to the second check phase
 *        after the input is given back (the keys that waited in the terminal): they are not echoed, not
 *        kept in its line or sent anywhere, and no Return, Ctrl+D, Ctrl+Z or Shift+Tab among them
 *        acts; a bracketed paste that starts among them is dropped to its end; a Ctrl+C still
 *        interrupts, as it would have at once. Not when its question was on the screen before the
 *        input was held (a stall or a stop at an open approval, a self-stop in the background
 *        after the question was written there): those keys were typed at it and are read as such,
 *        the cooked ones as above (no answer without an Enter typed at its question).
 *  - **line** (stdin is not a TTY: pipes, tests): lines are queued in arrival order and handed
 *    to reads; the prompt and the consumed line are written so transcripts look like the
 *    terminal. A line that is exactly `\x03` stands for Ctrl+C (emitted as `'interrupt'` at
 *    once when a turn is listening, else queued) and `\x04` for Ctrl+D. End of input ⇒ `eof`.
 *
 * In both modes an error on the input (a hung-up terminal: EIO from `setRawMode` or a read) is
 * end of input: every pending read gets `eof`, never an unhandled 'error' (r5 #1), also at the
 * reader's creation (readline's constructor turned raw mode on before the reader's 'error'
 * listener existed, and its EIO was thrown out of it: r12 #4; the reader switches itself); in terminal
 * mode a half-typed line at the input's end (the terminal went away) is dropped, not delivered
 * as a line (line mode keeps a last line without a newline: piped text), and
 * {@link LineReader.hungUp} says the terminal hung up (its SIGHUP follows, r6 #3; not for an end
 * right after a stop the heartbeat did not see in time while the input is still the controlling
 * terminal: canonical mode's end of file, a Ctrl+D typed in the shell, r11 #0). While the
 * `muted` option says so (the REPL after a fatal signal) the reader writes nothing of its own:
 * no prompt, no echo, nothing printed above the prompt, no fresh line for a Ctrl+C (a process
 * SIGINT); in terminal mode keys typed meanwhile are dropped (readline does not echo them either).
 * readline's own redraw of the prompt line at a terminal resize happens only for an active read
 * of a reader neither muted nor suspended: never over a turn's output (no read active), into a
 * child's screen, or after a fatal signal (r6 verification).
 *
 * Reads nest (a stack): an approval prompt or `ask()` raised while the idle prompt is shown
 * takes the next line; when it finishes the previous prompt is shown again.
 *
 * {@link LineReader.readInput} assembles one logical input: a trailing `\` continues the input
 * on the next line (the backslash is dropped — DECISION, rustyline kept it), an odd number of
 * ```` ``` ```` fences continues until the block closes (Q `MultiLineValidator`), and soft
 * newlines (Ctrl+J / Alt+Enter / paste) continue as well.
 *
 * History (01 §7.2 `chat.historyMode`, DECISION on the file location since Kiro's is
 * UNVERIFIED): JSON-lines files under `<kiroHome>/kiro-claude/history/`: `global.jsonl` for
 * `global`, `<sessionId>.jsonl` for `session` (the default). Only logical inputs typed at the
 * main prompt are recorded, and only in terminal mode.
 */

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as tty from 'node:tty';
import type { WorkspaceContext } from '../types.js';
import { isSafeSessionId } from '../session/store.js';

/** Result of one read. */
export type ReadResult =
  | { kind: 'line'; text: string }
  /** Ctrl+C */
  | { kind: 'interrupt' }
  /** Ctrl+D on an empty line */
  | { kind: 'ctrl-d' }
  /** The input stream ended. */
  | { kind: 'eof' }
  /** The read was cancelled through its AbortSignal. */
  | { kind: 'aborted' };


export interface ReadOptions {
  signal?: AbortSignal;
  /**
   * Terminal mode: drop keys typed before this read started (approval prompts): the type-ahead,
   * and those still waiting in the terminal while the input is held (module doc, r12 #0).
   */
  discardTypeahead?: boolean;
}

export interface ReadInputOptions extends ReadOptions {
  /** Prompt for continuation lines (default ''). */
  contPrompt?: string;
  /** Record the logical input in the history. */
  history?: boolean;
}

export interface LineReaderOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Raw-key terminal mode (stdin is a TTY). */
  terminal: boolean;
  /** Initial history, oldest first. */
  history?: string[];
  historySize?: number;
  completer?: (line: string) => [string[], string];
  /** Called for every logical input added to the history. */
  onHistory?: (entry: string) => void;
  /**
   * While true, nothing of the reader's own is written: no prompt, no line-mode echo, no
   * {@link LineReader.printAbove} (the REPL after a fatal signal, r5 g2). Line-mode reads still
   * get their lines; terminal-mode keys are dropped.
   */
  muted?: () => boolean;
  /**
   * Terminal mode: whether kiro-claude is in the terminal's foreground process group, asked before
   * the terminal is taken back after a stop (module doc). Default {@link terminalInForeground} on
   * the input; tests pass their own.
   */
  foreground?: () => boolean;
  /**
   * Terminal mode: stop kiro-claude like a background job that reads its terminal, while a read
   * waits for the terminal and the reader is away in the background (r11: Ctrl+Z, then `bg`; a
   * `kill -CONT` while the shell holds the terminal); true when a stop was sent (the reader looks
   * again two event-loop turns later). Default {@link stopForTerminal} on the input, which checks
   * /proc itself and does nothing for an input that is not the controlling terminal; tests pass
   * their own (never a real stop of the test runner). `signal`: SIGTTIN, or SIGTSTP after a stop
   * that came back at once while away ({@link TerminalStops}).
   */
  stopInBackground?: (signal: TerminalStop) => boolean;
  /**
   * Terminal mode: whether the input is still kiro-claude's controlling terminal, asked when it
   * ends right after a stop (r11 #0, {@link LineReader.hungUp}: then it is canonical mode's end of
   * file, a Ctrl+D typed while the shell had the terminal, not a hangup, which takes the
   * controlling terminal away). Default: Linux's /proc/self/stat on the input ({@link
   * terminalInForeground}), false elsewhere and for an input that is no controlling terminal;
   * tests pass their own.
   */
  controlling?: () => boolean;
  /**
   * Terminal mode: kiro-claude waited off the terminal in the background before this reader takes
   * it (repl/core.ts run: `kiro-claude chat &`, a stop while it started and `bg`; r10 #1), so the
   * keys the terminal queued in its cooked mode (typed after `fg` before the chat noticed it) are
   * read as typed there ({@link cookedKeys}). Without it, a newline typed while the chat started
   * stays Ctrl+J, a soft newline, as in Q (a paste stays one input); that includes a `fg` that
   * came while the start still ran (the REPL decides once, after the start: r11 #3).
   */
  cooked?: boolean;
}

interface PendingRead {
  prompt: string;
  resolve: (r: ReadResult) => void;
  done: boolean;
  /**
   * Keys typed before this read started are dropped (`discardTypeahead`: approval prompts), and
   * keys the terminal queued in a cooked mode are never read as typed for it ({@link takeCooked}).
   */
  discard: boolean;
  /**
   * A discarding read that started while the input was held (parked by the heartbeat, or away
   * after a stop; or with the heartbeat overdue, which parks it then: r12 verification): the keys
   * still waiting in the terminal then were typed before its question was drawn, and are dropped
   * when the input is given back ({@link LineReader.release}, r12 #0).
   */
  held?: boolean;
  /** Logical input (backslash / fence continuation) vs a single answer line. */
  logical: boolean;
  contPrompt: string;
  history: boolean;
  /** Lines collected so far (continuations stay inside the same pending read). */
  parts: string[];
}

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

/** Unicode "tag" characters U+E0000–U+E007F are removed from input (Q `sanitize_unicode_tags`). */
export function sanitizeUnicodeTags(s: string): string {
  return s.replace(/[\u{E0000}-\u{E007F}]/gu, '');
}

/** Number of ```` ``` ```` occurrences (non-overlapping, Q `matches("```").count()`). */
export function countFences(s: string): number {
  return s.split('```').length - 1;
}

/** True when a logical input that currently reads `text` must continue on another line. */
export function needsContinuation(text: string): boolean {
  return countFences(text) % 2 === 1;
}

const CRLF_WINDOW_MS = 100;
const DEFAULT_HISTORY_SIZE = 1000;
/**
 * Ctrl+Z: a `kill(SIGTSTP)` that returns later than this really stopped the process group (a shell
 * ran meanwhile and printed below the input); a discarded stop returns at once. It only decides
 * where the prompt is drawn again.
 */
const STOP_SEEN_MS = 50;
/**
 * A SIGCONT this soon after the terminal was taken back belongs to that stop (its handler runs on
 * the event loop after the stop was handled synchronously): nothing more to do. Only while the
 * reader's own stop (Ctrl+Z, the self-stop in the background) still has its SIGCONT to come
 * (LineReader.ownContPending): by time alone a stop from elsewhere and its `fg` inside this window
 * got no retake, the terminal left in the shell's cooked mode (r12 #3).
 */
const OWN_CONT_MS = 250;
/**
 * Off the terminal in the background (the reader after a stop, {@link LineReader.retakeNow}; the
 * REPL after a child and before its first prompt, repl/core.ts), kiro-claude asks this often
 * whether it is in the foreground again: `fg` of a job bash knows to be running sends no SIGCONT,
 * and until the terminal is taken back it stays in the shell's cooked mode, where keys are echoed
 * by the terminal and Return arrives as a newline (r10 #2: at 250 ms a line typed right after `fg`
 * was not submitted). A /proc/self/stat read; only while in the background. A look that still
 * finds it there while it needs the terminal stops it ({@link stopForTerminal}, r11), so a further
 * look normally follows a continue; in an orphaned process group (the stop is discarded) the poll
 * alone goes on.
 */
export const FOREGROUND_POLL_MS = 20;

/**
 * Terminal mode on POSIX, while the reader's input flows (the prompt, an approval, a turn's
 * type-ahead): a heartbeat this often, unref'd (10 wakeups a second, a clock read each; none while
 * away after a stop, while a child owns the terminal, in line mode or once closed) (r11 #0).
 * Nothing sees a stop from elsewhere begin (`kill -STOP` cannot be caught, `kill -TSTP` is not),
 * and at its continue libuv dispatches the SIGCONT only after the other I/O of the same poll, so
 * keys the shell's cooked mode had queued were read before the reader's SIGCONT listener could
 * pause the input: a Ctrl+D at a line start (canonical mode's end of file, a 0-byte read) ended it
 * as at a hangup, a Return was a newline (Ctrl+J, a soft newline). With the heartbeat the poll
 * that the stop interrupted has a finite timeout, so it returns to the timers phase before the
 * next poll, and the beat there sees the gap and parks the input first ({@link
 * LineReader.onBeat}).
 */
export const INPUT_BEAT_MS = 100;
/**
 * A beat this much later than the one before saw a gap: a stop that long, or an event loop
 * blocked that long (no stop: a long synchronous step, a GC pause, a slow machine), which the
 * park leaves as it was ({@link LineReader.unpark}). Not below OWN_CONT_MS.
 */
export const INPUT_GAP_MS = 250;

/**
 * Stop a paused stream's reading now (r11 #0, {@link LineReader.onBeat}). A paused net.Socket (a
 * tty.ReadStream: highWaterMark 0) still reads one more chunk, an end of file included, before its
 * push is refused and it stops; only process.stdin stops one tick after a pause, through a
 * 'pause' listener of Node's own. These are the steps of that listener, for any stream with such a
 * handle (process.stdin's own then finds nothing to do); a stream without one is left paused
 * only. `resume()` reads again (its `_read` starts the handle).
 */
function stopReading(input: unknown): void {
  const s = input as { _handle?: { reading?: unknown; readStop?: unknown }; _readableState?: { reading?: unknown }; readableFlowing?: unknown } | undefined;
  const h = s?._handle;
  if (!h || h.reading !== true || typeof h.readStop !== 'function' || !s._readableState || s.readableFlowing === true) return;
  s._readableState.reading = false;
  h.reading = false;
  (h.readStop as () => unknown).call(h);
}

/**
 * Run `fn` (readline's constructor or close(), which switch raw mode themselves) with a no-op
 * standing in for the input's setRawMode, then give the input its own back (an own property as
 * such, a prototype one by removing the stand-in).
 */
function withoutRawSwitch<T>(input: unknown, fn: () => T): T {
  const inp = input as { setRawMode?: unknown };
  const own = Object.prototype.hasOwnProperty.call(inp, 'setRawMode');
  const setRawMode = inp.setRawMode;
  if (typeof setRawMode === 'function') inp.setRawMode = () => inp;
  try {
    return fn();
  } finally {
    if (own) inp.setRawMode = setRawMode;
    else delete inp.setRawMode;
  }
}

/** Ctrl+Z (readline's key for \x1a). */
const isCtrlZ = (k: Key): boolean => k.ctrl === true && !k.shift && k.name === 'z';

/** ESC[200~, the start of a bracketed paste. */
const PASTE_START = Buffer.from('\u001b[200~');

/**
 * Keys the terminal queued while it was in a cooked mode (a shell's after a stop, a child's, the
 * one kiro-claude started in), changed in place into the raw keys they were typed as (r10 #2).
 * The line discipline handled them as they arrived: ICRNL made Return a newline (LF), which raw
 * mode reads as Ctrl+J, a soft newline here, and canonical mode keeps an end of file (Ctrl+D) as a
 * NUL placeholder, which a raw read returns and readline drops. So LF becomes Return (CR: in
 * cooked mode Ctrl+J ends a line too) and a NUL at a line start becomes Ctrl+D; a NUL elsewhere
 * (an end of file that ended a half-typed line) is left, which readline ignores. Nothing from a
 * bracketed-paste start (ESC[200~) on: the terminal brackets a paste only once the reader turned
 * bracketed paste on again, after raw mode, so those bytes are raw. `lineStart`: whether `chunk`
 * starts at a line start. Returns whether it ends at one, and whether a paste start was met
 * (`raw`: nothing after it is cooked).
 */
export function cookedKeys(chunk: Uint8Array, lineStart = true): { lineStart: boolean; raw: boolean } {
  const paste = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).indexOf(PASTE_START);
  const end = paste < 0 ? chunk.length : paste;
  let start = lineStart;
  for (let i = 0; i < end; i++) {
    const b = chunk[i];
    if (b === 0x0a) {
      chunk[i] = 0x0d;
      start = true;
    } else if (b === 0x00) {
      // canonical mode's end of file: a line end of its own
      if (start) chunk[i] = 0x04;
      start = true;
    } else start = false;
  }
  return { lineStart: start, raw: paste >= 0 };
}

/** Linux's `/dev/tty` (character device 5:0, as fstat's `rdev` gives it): the controlling terminal. */
const DEV_TTY_RDEV = 5 << 8;

/**
 * Whether kiro-claude's process group is the foreground process group of the terminal `input`
 * reads, i.e. whether changing that terminal's mode (tcsetattr) or reading it would NOT stop
 * kiro-claude (SIGTTOU / SIGTTIN, as a background job). Linux: /proc/self/stat, `pgrp` against
 * `tpgid` of the controlling terminal, when the input is that terminal (`tty_nr` = its device, or
 * `/dev/tty`, which is it under another device number: `kiro-claude chat < /dev/tty`; r9
 * verification: taken for another terminal, it stopped the chat again in the background).
 * In a PID namespace with its own /proc and no job-control shell inside it (`unshare --fork
 * --pid --mount-proc kiro-claude chat`) both groups belong to the parent namespace and read 0
 * (r12 #2): one of them visible and the other not is the background; neither visible is asked of
 * a short-lived child ({@link probeForeground}). True whenever that cannot stop kiro-claude or
 * cannot be told: an input that is no terminal file descriptor (tests' fakes), a terminal that is
 * not the controlling one (no job control applies to it), no controlling terminal or no
 * foreground group, a probe that cannot run (no `stty`), and on other systems (no /proc:
 * DECISION, the module doc says what that leaves). `probe` false: where only the probe could tell,
 * false (not known to be the foreground) without asking it (the probe stops a job in the
 * background, which after a fatal signal's continue left the job stopped).
 */
export function terminalInForeground(input: unknown, probe = true): boolean {
  const job = terminalJob(input);
  if (!job) return true;
  return job.foreground ?? (probe ? probeForeground(job.fd) ?? true : false);
}

/** /proc/self/stat's view of the controlling terminal `input` reads (Linux), see {@link controllingTty}. */
interface ControllingTty {
  fd: number;
  /** kiro-claude's process group, session, and the terminal's foreground group: 0 when outside its PID namespace. */
  pgrp: number;
  sid: number;
  tpgid: number;
}

/**
 * The controlling terminal `input` reads (Linux: /proc/self/stat's `tty_nr` is the input's device,
 * or the input is `/dev/tty`), or undefined: off Linux, an input that is no terminal file
 * descriptor (tests' fakes, or a hung-up terminal: isatty fails with EIO), a terminal that is not
 * the controlling one, and no controlling terminal (none, or it went away: a hangup and the end of
 * the session, its leader's exit, clear `tty_nr`).
 */
function controllingTty(input: unknown): ControllingTty | undefined {
  if (process.platform !== 'linux') return undefined;
  const fd = (input as { fd?: unknown } | undefined)?.fd;
  if (typeof fd !== 'number' || !tty.isatty(fd)) return undefined;
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    // after the command name: state ppid pgrp session tty_nr tpgid …
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ttyNr = Number(f[4]);
    if (!(ttyNr > 0)) return undefined;
    const rdev = fs.fstatSync(fd).rdev;
    if (rdev !== ttyNr && rdev !== DEV_TTY_RDEV) return undefined;
    return { fd, pgrp: Number(f[2]), sid: Number(f[3]), tpgid: Number(f[5]) };
  } catch {
    return undefined;
  }
}

/**
 * kiro-claude's job on the controlling terminal `input` reads ({@link terminalInForeground}):
 * whether its process group is that terminal's foreground group (undefined: both groups are
 * outside kiro-claude's PID namespace, r12 #2, where only {@link probeForeground} can tell), and
 * whether kiro-claude leads its session (no shell above it: `ssh -t host kiro-claude chat`; a
 * session outside its PID namespace reads 0: not). undefined wherever no job control applies or
 * it cannot be told (see there; a terminal with no foreground group, `tpgid` -1, too).
 */
function terminalJob(input: unknown): { fd: number; pgrp: number; foreground: boolean | undefined; sessionLeader: boolean } | undefined {
  const c = controllingTty(input);
  if (!c || !(c.tpgid >= 0)) return undefined;
  const sessionLeader = c.sid === process.pid;
  if (c.pgrp > 0 && c.tpgid > 0) return { fd: c.fd, pgrp: c.pgrp, foreground: c.pgrp === c.tpgid, sessionLeader };
  // a group outside the PID namespace reads 0: one visible and the other not are two groups
  return { fd: c.fd, pgrp: c.pgrp, foreground: c.pgrp > 0 || c.tpgid > 0 ? false : undefined, sessionLeader };
}

/**
 * A watch for the end of the terminal session (r12 #4): when `input` is kiro-claude's controlling
 * terminal now ({@link controllingTty}), the returned function is true once it no longer is (a
 * hangup, the session leader's exit: the kernel takes the controlling terminal away, and sends a
 * process group neither in the foreground nor stopped no SIGHUP); otherwise always false (off
 * Linux, an input that is no controlling terminal).
 */
export function terminalGone(input: unknown): () => boolean {
  if (!controllingTty(input)) return () => false;
  return () => !controllingTty(input);
}

/**
 * How long the foreground probe's mode change may take ({@link probeForeground}): in the
 * foreground `stty` re-applies the mode in a few milliseconds; one still running after this was
 * stopped by the kernel (SIGTTOU) as a background job's.
 */
export const FOREGROUND_PROBE_MS = 100;

/**
 * Whether kiro-claude is in its terminal's foreground where /proc cannot tell (r12 #2): in a PID
 * namespace with its own /proc and no job-control shell inside it (`unshare --fork --pid
 * --mount-proc kiro-claude chat`, also as its PID 2 under a plain `bash -c`) kiro-claude's process
 * group and the terminal's foreground group belong to the parent namespace and read 0, and as
 * that namespace's init the kernel ignores every default-action stop signal for kiro-claude: a
 * terminal mode change of its own from the background got SIGTTOU, which the kernel dropped,
 * and restarted for good inside the ioctl (100% CPU, no JS ran, `kill %1` never closed it). So a
 * short-lived child in kiro-claude's process group (`stty`, never kiro-claude itself) re-applies
 * the terminal's current mode (`stty -g`, read without a job-control check): in the foreground it
 * exits 0 at once (true); in the background the kernel stops it, and the processes of the job it
 * can stop with it (SIGTTOU to the group: the shell reports the job 'Stopped (tty output)' and
 * takes the terminal), and it is killed after {@link FOREGROUND_PROBE_MS} (false; also when a
 * signal ended it, `kill %1`). undefined when it cannot run or fails (no `stty`, a hung-up
 * terminal): the caller's old answer applies. Each call spawns `stty` twice (a few milliseconds),
 * and blocks the event loop up to {@link FOREGROUND_PROBE_MS} in the background; it is asked only
 * where kiro-claude would otherwise take the foreground for granted ({@link
 * terminalInForeground}: the first prompt and its wait, the reader's retake and looks while away,
 * the hand-back after a child, a close, a write held while the chat starts). Within one event-loop
 * turn the answer is reused (no signal is dispatched to kiro-claude before the next one: a second
 * probe right after `kill %1`'s SIGCONT stopped the job again before its SIGTERM was handled, and
 * the chat's exit then waited for that stopped wrapper to reap it).
 */
function probeForeground(fd: number): boolean | undefined {
  if (lastProbe?.fd === fd) return lastProbe.verdict;
  let verdict: boolean | undefined;
  try {
    const g = spawnSync('stty', ['-g'], { stdio: [fd, 'pipe', 'ignore'], encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' });
    const mode = g.status === 0 ? g.stdout.trim() : '';
    if (/^[0-9A-Fa-f:]+$/.test(mode)) {
      const s = spawnSync('stty', [mode], { stdio: [fd, 'ignore', 'ignore'], timeout: FOREGROUND_PROBE_MS, killSignal: 'SIGKILL' });
      if (s.status === 0) verdict = true;
      // stopped (SIGTTOU) and killed at the timeout, or ended by a signal meanwhile (`kill %1`)
      else if (s.signal !== null || (s.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') verdict = false;
    }
  } catch {
    // (no stty: the old answer)
  }
  const probe = { fd, verdict };
  lastProbe = probe;
  setImmediate(() => {
    if (lastProbe === probe) lastProbe = undefined;
  });
  return verdict;
}

/** The last {@link probeForeground} answer, until the check phase after it. */
let lastProbe: { fd: number; verdict: boolean | undefined } | undefined;

/**
 * Stop kiro-claude the way the kernel stops a background job that reads its terminal, because it
 * needs the terminal and is not in its foreground (r11 #1/#2): SIGTTIN at its default action to
 * kiro-claude's process group, so the shell sees the whole job stopped (bash: 'Stopped'; `jobs
 * -l`: 'Stopped (tty input)') and takes the terminal back, and `fg` continues it with a SIGCONT.
 * Returns once kiro-claude continues (`fg`, `bg`, `kill -CONT`, `kill %1`: SIGTERM, then
 * SIGCONT), or at once when the
 * kernel discards the stop: kiro-claude's process group is orphaned (no shell of its session
 * waits for it: `bash -mc 'kiro-claude chat & …'` once that shell has exited). True when the stop
 * was sent (the caller lets the signals that came with the continue be dispatched before it looks
 * again).
 *
 * Polling alone (r9/r10) never stopped, and something above kiro-claude may depend on that stop:
 * under `sudo` with `use_pty` sudo hands its inner pty to the command only after sudo itself is
 * continued, which follows the command's job-control stop (bash's `fg` of a job it knows to be
 * running sends no SIGCONT), and a `!cmd` child that died holding the terminal (`!bash -i`, then
 * SIGKILL) leaves its dead group in the foreground with the shell blocked on the chat's job, where
 * only a stop gives the shell the terminal back. The whole group, as the kernel's own SIGTTIN
 * (and the reader's Ctrl+Z) does: bash counts a job stopped only once none of its processes runs,
 * so a wrapper (`npx`, a script) or the rest of a pipeline (`kiro-claude chat | tee log`) left
 * running kept the job 'Running', and `fg` then sent no SIGCONT. SIGTTIN rather than SIGTTOU,
 * which the REPL catches while a child owns the terminal (repl/exitSignals.ts childOwnsTerminal),
 * or SIGTSTP, which sudo answers by suspending itself even when it is in the foreground already;
 * but after a stop that came back at once while kiro-claude is still in the background, SIGTSTP
 * is what helps ({@link TerminalStops}). Nor does SIGTTIN stop a process of the group that ignores
 * or catches it: GNU `timeout` (also with `--foreground`) ignores SIGTTIN and SIGTTOU itself, so
 * under it the job stayed 'Running', `fg` sent no SIGCONT, and the chat stayed stopped (r12 #5).
 * So when another process of kiro-claude's group holds SIGTTIN off and none holds SIGTSTP off
 * ({@link groupHoldsOff}: /proc, looked at only here, before a stop), the stop is a SIGTSTP
 * (bash: 'Stopped', also in `jobs -l`); when one holds both off, it stays a SIGTTIN, as before.
 *
 * Nothing (false) where it cannot be told or does not apply (as {@link terminalInForeground}: off
 * Linux, an input that is not the controlling terminal), in the foreground, when kiro-claude leads
 * its session (its group is orphaned: the stop would be discarded), and while a listener for the
 * signal is installed (it would catch the signal instead of stopping). Node starts every program
 * with SIGTTIN at its default action (an inherited SIG_IGN is reset), and a stop the kernel
 * discards or ignores returns at once: the caller's poll goes on as before. `signal` is SIGTSTP
 * instead after a stop that came back at once ({@link TerminalStops}). With job IDs outside
 * kiro-claude's PID namespace nothing is sent and the answer is true: the foreground probe that
 * found it in the background was the stop ({@link probeForeground}, r12 #2).
 */
export function stopForTerminal(input: unknown, signal: TerminalStop = 'SIGTTIN'): boolean {
  const job = terminalJob(input);
  if (!job || job.foreground === true || job.sessionLeader) return false;
  // job IDs outside the PID namespace: the probe that found kiro-claude in the background was the
  // stop (the kernel stopped it and the job's processes it can stop, SIGTTOU); the caller lets the
  // signals that came with a continue be dispatched before it probes again (`kill %1`'s SIGCONT
  // was followed by a probe that stopped the job again, its SIGTERM not handled yet)
  if (job.foreground === undefined) return true;
  // (a group outside the PID namespace reads 0 for its members too: not looked at)
  if (signal === 'SIGTTIN' && job.pgrp > 0) {
    const held = groupHoldsOffCached(job.pgrp);
    if (held.SIGTTIN && !held.SIGTSTP) signal = 'SIGTSTP';
  }
  if (process.listenerCount(signal) > 0) return false;
  try {
    process.kill(0, signal);
  } catch {
    return false;
  }
  return true;
}

/** Which stop signals another process of a process group holds off ({@link groupHoldsOff}). */
export type StopHolds = Record<TerminalStop, boolean>;

/**
 * Whether a process of process group `pgrp` other than kiro-claude (a wrapper: GNU `timeout`, a
 * script with `trap '' TTIN`; the rest of a pipeline) ignores or catches SIGTTIN, and SIGTSTP
 * (Linux /proc: each process's `stat` for its group, `status` SigIgn / SigCgt for the signals): at
 * either such a stop leaves it running, and bash counts its job stopped only once none of its
 * processes runs (r12 #5). Zombies count as gone. Nothing off Linux or when /proc cannot be read.
 * One `stat` read per process on the system (a fraction of a millisecond for a hundred).
 */
export function groupHoldsOff(pgrp: number): StopHolds {
  const held: StopHolds = { SIGTTIN: false, SIGTSTP: false };
  if (process.platform !== 'linux' || !(pgrp > 0)) return held;
  const bit = (sig: TerminalStop): bigint => 1n << BigInt((os.constants.signals[sig] ?? 1) - 1);
  let names: string[];
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return held;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(f[2]) !== pgrp || f[0] === 'Z' || f[0] === 'X') continue;
      const status = fs.readFileSync(`/proc/${name}/status`, 'utf8');
      const mask = (field: string): bigint => {
        const m = new RegExp(`^${field}:\\s*([0-9a-fA-F]+)$`, 'm').exec(status);
        return m ? BigInt(`0x${m[1]}`) : 0n;
      };
      const off = mask('SigIgn') | mask('SigCgt');
      for (const sig of ['SIGTTIN', 'SIGTSTP'] as const) if ((off & bit(sig)) !== 0n) held[sig] = true;
    } catch {
      // gone meanwhile
    }
  }
  return held;
}

/** {@link groupHoldsOff} is looked at again only this long after its last look, for the same group. */
const GROUP_LOOK_MS = 1000;
let groupLook: { pgrp: number; at: number; held: StopHolds } | undefined;

/**
 * {@link groupHoldsOff}, at most once per {@link GROUP_LOOK_MS} for the same group: in an orphaned
 * group every self-stop is discarded and the next one follows a poll later ({@link
 * FOREGROUND_POLL_MS}), and the members of a job seldom change.
 */
function groupHoldsOffCached(pgrp: number): StopHolds {
  const now = performance.now();
  if (groupLook && groupLook.pgrp === pgrp && now - groupLook.at < GROUP_LOOK_MS) return groupLook.held;
  groupLook = { pgrp, at: now, held: groupHoldsOff(pgrp) };
  return groupLook.held;
}

/** The signal of a self-stop ({@link stopForTerminal}): SIGTTIN, or SIGTSTP ({@link TerminalStops}). */
export type TerminalStop = 'SIGTTIN' | 'SIGTSTP';

/**
 * A self-stop ({@link stopForTerminal}) that returned sooner than this was no person's job control
 * (`fg`, `bg`, `kill %1`): the kernel discarded it (an orphaned process group), the signal is
 * blocked, or something above kiro-claude continued it at once without the terminal. sudo with
 * `use_pty`, itself in the foreground, answers a command's SIGTTIN (or SIGTTOU) by resuming it in
 * the foreground: its monitor gives the inner pty to the process group that had it when the
 * command stopped and continues the command. After a `!cmd` that died holding that pty (`!bash
 * -i`, then `kill -9 $$` in it) that group is a dead one, the tcsetpgrp fails, and the chat
 * stopped and was continued every poll, still off its terminal, while the shell, blocked on sudo's
 * job, never got the terminal back (r11 verification).
 */
export const STOP_ANSWERED_MS = 20;
/**
 * A self-stop that returned sooner than this never stopped kiro-claude: the kernel discarded it
 * (an orphaned process group) or the signal is blocked. Nothing that sees a stop (a shell, sudo)
 * continues it that soon: it must be told of the stop first (its SIGCHLD), sudo's resume of a
 * command that stopped with SIGTTIN takes about half a millisecond, a shell's `fg` many.
 */
export const STOP_DISCARDED_MS = 2;

/**
 * The signals of a stretch of self-stops (a wait for the foreground, the reader away in the
 * background): {@link next} is SIGTTIN ({@link stopForTerminal}), and SIGTSTP after a SIGTTIN
 * that came back at once ({@link STOP_ANSWERED_MS}), which sudo answers by suspending itself
 * whether or not it is in the foreground (the shell gets the terminal back: 'Stopped'; `kill %1`
 * closes the chat). A SIGTSTP that never stopped kiro-claude ({@link STOP_DISCARDED_MS}: an
 * orphaned process group discards both) did not help: no more of them in this stretch, so the
 * members of the group that catch SIGTSTP (vim, less in a pipeline) do not get one every poll.
 */
export class TerminalStops {
  /** The signal of the next stop. */
  next: TerminalStop = 'SIGTTIN';
  private tstpHelps = true;

  /** A stop with {@link next} was not sent (a listener for it, no terminal): SIGTTIN next. */
  notSent(): void {
    this.next = 'SIGTTIN';
  }

  /** A stop with {@link next} was sent and came back after `ms`. */
  sent(ms: number): void {
    if (this.next === 'SIGTSTP' && ms < STOP_DISCARDED_MS) this.tstpHelps = false;
    this.next = this.next === 'SIGTTIN' && ms < STOP_ANSWERED_MS && this.tstpHelps ? 'SIGTSTP' : 'SIGTTIN';
  }
}

/** Two event-loop turns: the poll phase between them dispatches the signals that came with a continue. */
const twoTurns = (): Promise<void> => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

/**
 * Off the terminal, wait until kiro-claude is in its terminal's foreground (`foreground()`): the
 * REPL's first prompt and its hand-back after a child that had the terminal (repl/core.ts). Looked
 * at every {@link FOREGROUND_POLL_MS}; after each look that still finds it in the background,
 * `stop()` stops it like a background job that reads its terminal ({@link stopForTerminal}, r11),
 * and once it continues the next look comes two event-loop turns later, after the signals that came
 * with the continue (`kill %1`: SIGTERM, then SIGCONT; a closed terminal: SIGHUP) were dispatched;
 * a further stop only after another poll interval and another look at `muted()`. True in the
 * foreground; false once `muted()` (a fatal signal: its close runs, nothing of the terminal is
 * taken). A stop that is discarded or ignored (`stop()` false, or true and back at once) leaves the
 * poll alone, as before r11. Each wait's first stop is a SIGTTIN; one that came back at once makes
 * the next one a SIGTSTP ({@link TerminalStops}: under `sudo` with `use_pty`, after a child
 * that died holding the terminal). False too once `gone()` (r12 #4, {@link terminalGone}: the
 * terminal session ended meanwhile, which a hung-up terminal's "cannot be told" made look like
 * the foreground), looked at before the foreground each time.
 */
export async function waitForForeground(
  foreground: () => boolean,
  muted: () => boolean,
  stop: (signal: TerminalStop) => boolean,
  gone: () => boolean = () => false,
): Promise<boolean> {
  const stops = new TerminalStops();
  for (;;) {
    // (muted first: where the foreground is probed, a probe after `kill %1`'s continue stopped the
    // job again, r12 #2)
    if (muted() || gone()) return false;
    if (foreground()) break;
    await new Promise((resolve) => setTimeout(resolve, FOREGROUND_POLL_MS));
    if (muted() || gone() || foreground()) continue;
    const t0 = performance.now();
    if (!stop(stops.next)) {
      stops.notSent();
      continue;
    }
    stops.sent(performance.now() - t0);
    await twoTurns();
  }
  return !muted();
}

/** See module doc. Events: `'interrupt'` (Ctrl+C with no active read), `'shift-tab'`. */
export class LineReader extends EventEmitter {
  /** Open terminal-mode readers (POSIX); one process SIGCONT listener serves them all. */
  private static readonly watching = new Set<LineReader>();
  private static readonly onSigcont = (): void => {
    for (const r of [...LineReader.watching]) r.continued();
  };

  readonly terminal: boolean;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly rl: readline.Interface;
  private readonly stack: PendingRead[] = [];
  private readonly queue: string[] = [];
  private ended = false;
  /** Terminal mode: the input ended or failed (the terminal hung up). */
  private inputEnded = false;
  private closed = false;
  private pasting = false;
  /** Between a paste-start and a paste-end key as they arrive, whether or not a read is active. */
  private inPaste = false;
  /** Time of a Return that was the most recent key (for collapsing CRLF), else 0. */
  private lastReturnAt = 0;
  /** When the terminal was last taken back after a stop ({@link retake}); see OWN_CONT_MS. */
  private retakenAt = -Infinity;
  /**
   * Terminal mode, from a stop until the terminal is taken back ({@link retake}): from
   * {@link jobStop}'s SIGTSTP or the SIGCONT after a stop from elsewhere, for as long as
   * kiro-claude runs in the background (`bg`, `kill -CONT`) or a fatal signal closes it. The input
   * is paused meanwhile (a read in the background stops kiro-claude, SIGTTIN), nothing is drawn
   * and the terminal's mode is not touched (SIGTTOU) (r9 #0/#1); while a read waits, kiro-claude
   * stops itself there instead, at a look of the away poll ({@link lookAgain}, r11).
   */
  private away = false;
  /** A {@link retake} is scheduled ({@link scheduleRetake}); `freshLine` for its redraw. */
  private retakePending: { freshLine: boolean } | undefined;
  /** Away in the background: the next look at the foreground ({@link retakeNow}). */
  private awayPoll: NodeJS.Timeout | undefined;
  /**
   * A stop from elsewhere: the shell put the terminal in its own mode behind libuv's back, which
   * still believes it raw, so {@link retake} turns raw mode off first (libuv applies only changes).
   */
  private modeLost = false;
  /**
   * The input was kiro-claude's controlling terminal when the reader went {@link away}: once it is
   * not any more (a hangup, the session's end: no SIGHUP reaches an orphaned group that is not
   * stopped), the input ends as at a hangup at the retake, nothing touched (r12 #4).
   */
  private awayOnTty = false;
  private suspended = false;
  private typeahead: [string | undefined, Key][] = [];
  private readlineAddedHistory = false;
  private ttyWrite: ((s: string | undefined, key: Key | undefined) => void) | undefined;
  private readonly onHistory: ((entry: string) => void) | undefined;
  private readonly muted: () => boolean;
  private readonly foreground: () => boolean;
  private readonly stopInBackground: (signal: TerminalStop) => boolean;
  /** The self-stops' signals while away ({@link lookAgain}); a new stretch at the retake. */
  private stops = new TerminalStops();
  private readonly historySize: number;
  private readonly fallbackHistory: string[] = [];
  /** Terminal mode: removes the guarded stand-ins of readline's 'resize' listeners ({@link guardResize}). */
  private unguardResize: (() => void) | undefined;
  /** Ends the reading of the keys queued in a cooked mode as such ({@link takeCooked}). */
  private cookedOff: (() => void) | undefined;
  private readonly controlling: () => boolean;
  /** Terminal mode on POSIX, while the input flows: the heartbeat ({@link INPUT_BEAT_MS}, {@link syncBeat}). */
  private beat: NodeJS.Timeout | undefined;
  /** When the heartbeat last ran, or started. */
  private beatAt = 0;
  /**
   * The heartbeat saw a gap and paused the input ({@link onBeat}; or an approval read started with
   * the beat overdue, {@link overdue}) until the check phase after the next poll ({@link unpark}),
   * unless a SIGCONT in that poll ({@link continued}) decides first.
   */
  private parked = false;
  /**
   * The input was given back after it was held ({@link release}): set from then until the second
   * check phase after it, while what is read was already waiting in the terminal (r12 #0).
   */
  private releasing: object | undefined;
  /**
   * Keys read now for this read (the active one) were typed before its question was drawn: they
   * are dropped ({@link dropAhead}). Set by {@link release} for a {@link PendingRead.held} read and
   * for a discarding read that starts while {@link releasing}; cleared with it.
   */
  private dropFor: PendingRead | undefined;
  /** A bracketed paste whose start was dropped for this read: dropped up to its end too. */
  private dropPaste: PendingRead | undefined;
  /**
   * The reader stopped itself (Ctrl+Z's SIGTSTP in {@link jobStop}, the self-stop in {@link
   * lookAgain}) and its SIGCONT has not been dispatched yet: the next SIGCONT is that stop's own
   * ({@link continued}, r12 #3). Cleared by that SIGCONT, and at the first heartbeat after the
   * retake (a stop the kernel discarded sends none).
   */
  private ownContPending = false;
  /**
   * The input ended right after a stop while it was still the controlling terminal: canonical
   * mode's end of file (a Ctrl+D typed while the shell had the terminal), not a hangup ({@link
   * hungUp}, r11 #0).
   */
  private eofTyped = false;

  constructor(opts: LineReaderOptions) {
    super();
    this.terminal = opts.terminal;
    this.input = opts.input;
    this.output = opts.output;
    this.onHistory = opts.onHistory;
    this.muted = opts.muted ?? (() => false);
    this.foreground = opts.foreground ?? (() => terminalInForeground(opts.input));
    this.stopInBackground = opts.stopInBackground ?? ((signal) => stopForTerminal(opts.input, signal));
    this.controlling = opts.controlling ?? (() => terminalJob(opts.input) !== undefined);
    this.historySize = opts.historySize ?? DEFAULT_HISTORY_SIZE;
    if (this.terminal) {
      const ifOpts: readline.ReadLineOptions = {
        input: opts.input,
        output: opts.output,
        terminal: true,
        historySize: this.historySize,
        tabSize: 4,
        prompt: '',
      };
      if (opts.completer) ifOpts.completer = opts.completer;
      const out = opts.output as unknown as Partial<EventEmitter>;
      const resizeBefore = new Set(out.listeners?.('resize') ?? []);
      // readline's constructor turns raw mode on before this reader's 'error' listener (below)
      // exists: on a hung-up terminal its EIO was thrown out of createInterface, and the REPL
      // ended with 'setRawMode EIO' without closing its session (r12 #4); turned on below instead
      this.rl = withoutRawSwitch(opts.input, () => readline.createInterface(ifOpts));
      this.guardResize(out, resizeBefore);
      const hist = this.rlHistory();
      if (hist && opts.history) {
        hist.length = 0;
        for (const h of opts.history.slice(-this.historySize).reverse()) hist.push(h);
      }
      this.installKeyHook();
      // Fallback if the key hook could not be installed: readline emits SIGINT itself.
      this.rl.on('SIGINT', () => this.ctrlC());
      // Likewise for Ctrl+Z; with a listener readline never suspends by itself (r7 #2).
      this.rl.on('SIGTSTP', () => this.jobStop());
      // A stop from elsewhere (kill -TSTP / -STOP, then fg): take the terminal back (r7 verification).
      if (process.platform !== 'win32') {
        LineReader.watching.add(this);
        if (!process.listeners('SIGCONT').includes(LineReader.onSigcont)) process.on('SIGCONT', LineReader.onSigcont);
      }
      // readline adds every accepted physical line to its history (and says so); only logical
      // inputs belong there, so that entry is taken out again in onTerminalLine.
      this.rl.on('history', () => {
        this.readlineAddedHistory = true;
      });
      this.rl.on('line', (line: string) => this.onTerminalLine(line));
      // The terminal hung up: readline hands the half-typed line over as a line when its input
      // ends; nobody pressed Enter, so it is no input (marked before readline sees the end).
      (opts.input as unknown as Partial<EventEmitter>).prependListener?.('end', () => {
        this.inputEnded = true;
        // right after a stop (no beat since) and still the controlling terminal: a Ctrl+D typed
        // in the shell's cooked mode, read before the stop was seen (r11 #0)
        if (this.beat && performance.now() - this.beatAt > INPUT_GAP_MS && this.controlling()) this.eofTyped = true;
      });
    } else {
      this.rl = readline.createInterface({ input: opts.input, terminal: false, crlfDelay: Infinity });
      this.rl.on('line', (line: string) => this.onPipeLine(line));
    }
    this.rl.on('close', () => {
      this.unguardResize?.();
      if (LineReader.watching.delete(this) && LineReader.watching.size === 0) process.removeListener('SIGCONT', LineReader.onSigcont);
      this.onClose();
    });
    // A failing input is its end: a hung-up terminal fails `setRawMode(false)` with EIO while
    // readline closes on the input's end, and readline re-emits the input's errors here (r5 #1).
    // Without a listener that 'error' would be thrown before the REPL could close the session.
    this.rl.on('error', () => {
      if (this.terminal) this.inputEnded = true;
      this.onClose();
    });
    if (this.terminal) this.takeTerminal(opts.cooked === true);
  }

  /**
   * The constructor takes the terminal once its 'error' listener is there: raw mode on (an EIO, a
   * hung-up terminal, is the input's end, {@link hungUp}: every read gets `eof`; r12 #4), bracketed
   * paste on (it keeps pasted newlines inside one input), the keys typed after `fg` while the chat
   * waited off the terminal read as queued in its cooked mode (`cooked`, {@link takeCooked}), and
   * the heartbeat started.
   */
  private takeTerminal(cooked: boolean): void {
    const inp = this.input as NodeJS.ReadStream;
    try {
      if (typeof inp.setRawMode === 'function') inp.setRawMode(true);
    } catch {
      // ignore
    }
    if (this.ended) return; // a hung-up terminal: setRawMode failed (EIO), the input ended
    this.output.write('\u001b[?2004h');
    if (cooked) this.takeCooked();
    this.syncBeat();
  }

  /**
   * The input ends as at a hangup ({@link hungUp}: every read gets `eof`), nothing of the terminal
   * touched: the REPL's hand-back after a child found the terminal session over while it waited
   * off the terminal (repl/core.ts handBack; an orphaned process group gets no SIGHUP, r12 #4).
   */
  endAsHungUp(): void {
    if (this.closed || this.ended) return;
    if (this.terminal) this.inputEnded = true;
    this.onClose();
  }

  /** Whether a read is waiting for input. */
  get reading(): boolean {
    return this.stack.length > 0;
  }

  /**
   * Terminal mode: the input ended or failed, i.e. the terminal hung up (in raw mode Ctrl+D is a
   * key, never an end of input), so its SIGHUP is on its way (repl/core.ts waits for it, r6 #3).
   * Always false in line mode, where the end of input is the end of the piped text. Also false
   * for an end that came right after a stop (no heartbeat since: the stop was not seen in time,
   * {@link INPUT_BEAT_MS}) while the input was still the controlling terminal (a hangup takes
   * that away first): canonical mode's end of file, a Ctrl+D typed while the shell had the
   * terminal (DECISION, r11 #0: the input is over either way, and no SIGHUP comes for it).
   */
  get hungUp(): boolean {
    return this.terminal && this.inputEnded && !this.eofTyped;
  }

  // ───────────────────────────── reads ─────────────────────────────

  /**
   * Read one answer line. A soft newline (Ctrl+J, Alt+Enter, paste) continues it; trailing `\`
   * and fences do not.
   */
  read(prompt: string, opts: ReadOptions = {}): Promise<ReadResult> {
    return this.readImpl(prompt, { ...opts, logical: false });
  }

  /** Read one logical (possibly multi-line) input; see module doc. */
  readInput(prompt: string, opts: ReadInputOptions = {}): Promise<ReadResult> {
    return this.readImpl(prompt, { ...opts, logical: true });
  }

  private readImpl(prompt: string, opts: ReadInputOptions & { logical: boolean }): Promise<ReadResult> {
    if (opts.signal?.aborted) return Promise.resolve({ kind: 'aborted' });
    return new Promise<ReadResult>((resolve) => {
      const pending: PendingRead = {
        prompt,
        resolve: () => undefined,
        done: false,
        discard: opts.discardTypeahead === true,
        logical: opts.logical,
        contPrompt: opts.contPrompt ?? '',
        history: opts.history === true,
        parts: [],
      };
      const onAbort = (): void => {
        if (pending.done) return;
        if (this.terminal && this.top() === pending && !this.muted()) {
          this.clearCurrentLine();
          this.output.write('\n');
        }
        this.finish(pending, { kind: 'aborted' });
      };
      pending.resolve = (r: ReadResult): void => {
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.stack.push(pending);
      this.showPrompt(pending);
      if (!this.terminal) this.drainQueue();
      else if (this.ended) this.finish(pending, { kind: 'eof' });
      else if (opts.discardTypeahead) {
        this.typeahead = [];
        // the input is held (r12 #0): what the terminal holds meanwhile was typed before this
        // question, and is dropped once the input is given back; or it is being given back now
        if (this.parked || this.away) pending.held = true;
        else if (this.releasing) this.dropFor = pending;
        else if (this.overdue()) {
          // a stall ended in these callbacks, after Claude Code's request was read and before its
          // question was drawn (a long synchronous step, a write to a terminal that does not drain,
          // a stop that landed in JavaScript): the keys typed during it are still in the terminal,
          // or later in this poll's batch, and were read into the approval (r12 verification). The
          // input is parked now, as the overdue heartbeat would have, and they are dropped
          pending.held = true;
          this.park();
        }
      } else this.replayTypeahead();
    });
  }

  /**
   * Feed keys typed while no read was active into the read that just started. A replayed Ctrl+Z
   * stops kiro-claude: the rest is replayed once the terminal is taken back ({@link retake}).
   */
  private replayTypeahead(): void {
    const write = this.ttyWrite;
    if (!write) return;
    while (this.typeahead.length > 0 && this.reading && !this.suspended && !this.away) {
      const [s, key] = this.typeahead.shift()!;
      write(s, key);
    }
  }

  /**
   * One physical line for the active read `t`. Continuations keep `t` active (synchronously:
   * keys or queued lines that follow are never lost) and show the continuation prompt.
   */
  private deliverLine(t: PendingRead, text: string, soft: boolean): void {
    if (soft) {
      t.parts.push(text);
      this.continueRead(t);
      return;
    }
    if (t.logical && text.endsWith('\\')) {
      t.parts.push(text.slice(0, -1));
      this.continueRead(t);
      return;
    }
    t.parts.push(text);
    const full = t.parts.join('\n');
    if (t.logical && needsContinuation(full)) {
      this.continueRead(t);
      return;
    }
    if (t.history) this.addHistory(full);
    this.finish(t, { kind: 'line', text: full });
  }

  private continueRead(t: PendingRead): void {
    t.prompt = t.contPrompt;
    this.showPrompt(t);
  }

  private top(): PendingRead | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** Resolve `p` and remove it from the stack; re-show the prompt of the read below it. */
  private finish(p: PendingRead, r: ReadResult): void {
    if (p.done) return;
    p.done = true;
    const i = this.stack.lastIndexOf(p);
    const wasTop = i === this.stack.length - 1;
    if (i >= 0) this.stack.splice(i, 1);
    p.resolve(r);
    if (wasTop && !this.closed && r.kind !== 'eof') {
      const below = this.top();
      if (below) {
        // Let the resolved read's continuation (which may push a new read) run first.
        setImmediate(() => {
          if (!below.done && this.top() === below) this.showPrompt(below);
        });
      }
    }
  }

  private showPrompt(p: PendingRead): void {
    if (this.closed || this.muted()) return;
    if (this.terminal) {
      // a child owns the terminal, or it is not taken back yet after a stop (drawn then)
      if (this.suspended || this.away) return;
      this.rl.setPrompt(p.prompt);
      this.promptLine();
    } else if (p.prompt !== '') {
      this.output.write(p.prompt);
    }
  }

  /** Replace the prompt of the active read (e.g. after Shift+Tab toggled plan mode). */
  updatePrompt(prompt: string): void {
    const t = this.top();
    if (!t) return;
    t.prompt = prompt;
    if (this.terminal && !this.suspended && !this.away && !this.muted()) {
      this.rl.setPrompt(prompt);
      this.promptLine(true);
    }
  }

  /** Print `text` (ending with a newline) above the active prompt, then redraw it. */
  printAbove(text: string): void {
    if (this.muted()) return;
    const t = this.top();
    if (!t || !this.terminal || this.suspended || this.away) {
      // line mode: the prompt is already on the current line; end it, then show it again
      const reprompt = t && !this.terminal && t.prompt !== '';
      this.output.write(reprompt ? `\n${text}${t.prompt}` : text);
      return;
    }
    readline.cursorTo(this.output as NodeJS.WritableStream, 0);
    readline.clearLine(this.output as NodeJS.WritableStream, 0);
    this.output.write(text);
    this.promptLine(true);
  }

  /**
   * readline's prompt() for the active read (its prompt drawn, or its line drawn again under text
   * printed above it). prompt() resumes a paused input first. While the input is parked ({@link
   * onBeat}) that resume undid the park: an I/O callback of the poll whose SIGCONT decides the park
   * (Claude Code's output, queued during a stop from elsewhere: a notice printed above the prompt,
   * a question or an approval asked, the prompt after a turn) drew a prompt, and the keys the shell
   * had queued in its cooked mode were read in that same poll, before the SIGCONT was dispatched (a
   * Return a soft newline, a Ctrl+D an end of input, as before r11; r11 verification). While parked
   * the line is drawn and the input stays paused: {@link unpark} or the retake gives it back.
   */
  private promptLine(preserveCursor?: boolean): void {
    const r = this.rl as unknown as { paused?: boolean };
    if (!this.parked || r.paused !== true) {
      this.rl.prompt(preserveCursor);
      return;
    }
    r.paused = false;
    try {
      this.rl.prompt(preserveCursor);
    } finally {
      r.paused = true;
    }
  }

  // ───────────────────────────── line mode ─────────────────────────────

  private onPipeLine(line: string): void {
    if (line === '\u0003' && !this.reading && this.listenerCount('interrupt') > 0) {
      this.emit('interrupt');
      return;
    }
    this.queue.push(line);
    this.drainQueue();
  }

  private drainQueue(): void {
    for (;;) {
      const t = this.top();
      if (!t) return;
      const line = this.queue.shift();
      if (line === undefined) {
        if (this.ended) this.finish(t, { kind: 'eof' });
        return;
      }
      // echo like a terminal would, so transcripts read naturally
      const echo = !this.muted();
      if (line === '\u0003') {
        if (echo) this.output.write('^C\n');
        this.finish(t, { kind: 'interrupt' });
      } else if (line === '\u0004') {
        if (echo) this.output.write('\n');
        this.finish(t, { kind: 'ctrl-d' });
      } else {
        if (echo) this.output.write(`${line}\n`);
        this.deliverLine(t, line, false);
      }
    }
  }

  // ───────────────────────────── terminal mode ─────────────────────────────

  private rlHistory(): string[] | undefined {
    const h = (this.rl as unknown as { history?: unknown }).history;
    return Array.isArray(h) ? (h as string[]) : undefined;
  }

  private rlLine(): string {
    return (this.rl as unknown as { line?: string }).line ?? '';
  }

  private clearCurrentLine(): void {
    readline.cursorTo(this.output as NodeJS.WritableStream, 0);
    readline.clearLine(this.output as NodeJS.WritableStream, 0);
    const r = this.rl as unknown as { line: string; cursor: number };
    r.line = '';
    r.cursor = 0;
  }

  /** Move to a fresh line the way readline does on Enter, forgetting the current line. */
  private acceptLineDisplay(): void {
    const r = this.rl as unknown as { clearLine?: () => void; line: string; cursor: number };
    if (typeof r.clearLine === 'function') r.clearLine();
    else {
      this.output.write('\r\n');
      r.line = '';
      r.cursor = 0;
    }
  }

  /**
   * readline redraws its prompt and line at every resize of the terminal (its `output` 'resize'
   * listener), whether or not a prompt is shown. Its listeners (those added since `before`) are
   * replaced by stand-ins that redraw only for an active read of a reader neither muted (a fatal
   * signal: nothing more is printed) nor suspended (a child owns the terminal); while no read is
   * active (a turn streams) the redraw erased the current line of the output and drew the last
   * prompt over it. The stand-ins are removed when the interface closes.
   */
  private guardResize(out: Partial<EventEmitter>, before: ReadonlySet<unknown>): void {
    if (typeof out.listeners !== 'function' || typeof out.removeListener !== 'function' || typeof out.on !== 'function') return;
    const offs: (() => void)[] = [];
    for (const l of out.listeners('resize') as ((...args: unknown[]) => void)[]) {
      if (before.has(l)) continue;
      out.removeListener('resize', l);
      const guarded = (...args: unknown[]): void => {
        if (this.closed || this.suspended || this.away || this.muted() || !this.top()) return;
        l.apply(out, args);
      };
      out.on('resize', guarded);
      offs.push(() => out.removeListener?.('resize', guarded));
    }
    this.unguardResize = () => {
      for (const off of offs.splice(0)) off();
    };
  }

  private installKeyHook(): void {
    const r = this.rl as unknown as { _ttyWrite?: (s: string | undefined, key: Key | undefined) => void };
    if (typeof r._ttyWrite !== 'function') return;
    const orig = r._ttyWrite.bind(this.rl);
    r._ttyWrite = (s: string | undefined, key: Key | undefined): void => {
      if (this.handleKey(s, key ?? {})) return;
      orig(s, key);
    };
    this.ttyWrite = r._ttyWrite;
  }

  /** True when the key was consumed. */
  private handleKey(s: string | undefined, k: Key): boolean {
    // muted (a fatal signal): keys typed now are dropped, not echoed, kept or delivered
    if (this.muted()) return true;
    if (k.ctrl && k.name === 'c') {
      this.lastReturnAt = 0;
      if (!this.top() && !this.suspended && this.listenerCount('interrupt') === 0) {
        // between a turn and the next prompt: deliver it to the next read
        this.typeahead.push([s, { ...k }]);
        return true;
      }
      this.typeahead = [];
      this.ctrlC();
      return true;
    }
    if (k.name === 'paste-start') this.inPaste = true;
    else if (k.name === 'paste-end') this.inPaste = false;
    if (this.dropAhead(k)) return true;
    if (isCtrlZ(k) && (this.inPaste || this.suspended || this.top())) {
      // a read is active: stop now; in a paste or while a child owns the terminal: dropped.
      // While no read is active (a turn runs) it is kept as type-ahead below: the stop waits
      // for the next prompt (see module doc).
      this.lastReturnAt = 0;
      if (!this.inPaste && !this.suspended) this.jobStop();
      return true;
    }
    const t = this.top();
    if (!t || this.suspended) {
      // no read active: keep as type-ahead (bounded); one Ctrl+Z at most, as in a cooked-mode
      // program, where the first press stops the job and the next ones go to the shell (r8 #4)
      if (isCtrlZ(k) && this.typeahead.some(([, q]) => isCtrlZ(q))) return true;
      if (this.typeahead.length < 4096) this.typeahead.push([s, { ...k }]);
      return true;
    }
    const prevReturnAt = this.lastReturnAt;
    this.lastReturnAt = 0;
    if (k.name === 'paste-start') {
      this.pasting = true;
      return true;
    }
    if (k.name === 'paste-end') {
      this.pasting = false;
      return true;
    }
    if (k.ctrl && k.name === 'd' && this.rlLine() === '') {
      this.acceptLineDisplay();
      this.finish(t, { kind: 'ctrl-d' });
      return true;
    }
    if (k.name === 'tab' && k.shift) {
      this.emit('shift-tab');
      return true;
    }
    if (k.name === 'return' || k.name === 'enter') {
      const now = Date.now();
      // LF right after CR (no key in between, within the window) is the second half of CRLF
      if (k.name === 'enter' && !k.meta && prevReturnAt !== 0 && now - prevReturnAt < CRLF_WINDOW_MS) return true;
      if (k.name === 'return' && !k.meta) this.lastReturnAt = now;
      if (this.pasting || k.meta || k.name === 'enter') {
        const text = this.rlLine();
        this.acceptLineDisplay();
        this.deliverLine(t, text, true);
        return true;
      }
      return false; // plain Enter: readline accepts the line
    }
    return false;
  }

  /**
   * A key that was typed before the active read's question was drawn ({@link dropFor}: it waited
   * in the terminal while the input was held, r12 #0) is dropped, as type-ahead always is at an
   * approval prompt: not echoed, not kept in its line, not read as a Ctrl+D, Ctrl+Z or Shift+Tab;
   * a bracketed paste that starts among them is dropped up to its end. A Ctrl+C is handled before
   * (it interrupts, as at once). True when `k` was dropped.
   */
  private dropAhead(k: Key): boolean {
    const t = this.top();
    if (!t || this.suspended || (this.dropFor !== t && this.dropPaste !== t)) return false;
    if (k.name === 'paste-start') this.dropPaste = t;
    else if (k.name === 'paste-end') this.dropPaste = undefined;
    // a dropped Return's LF (the second half of CRLF) is not read as Ctrl+J at the question
    this.lastReturnAt = k.name === 'return' && !k.meta ? Date.now() : 0;
    return true;
  }

  /**
   * The input is given back after it was held ({@link unpark}, {@link retake}; r12 #0): what is
   * read before the second check phase from now (whichever phase this runs in) already waited in
   * the terminal, as for {@link takeCooked}. For a discarding read that started while it was held
   * ({@link PendingRead.held}), or that starts meanwhile ({@link readImpl}), those keys were typed
   * before its question was drawn (Claude Code's request was read first: the park keeps the
   * terminal unread for a poll while the pipe is read, and a continue is taken in two event-loop
   * turns), so they are dropped ({@link dropAhead}), as they were when read as type-ahead before
   * the request. Nothing for any other read: the prompt and a question take them, as typed.
   */
  private release(): void {
    const t = this.top();
    this.dropFor = t !== undefined && (t.held === true || this.dropFor === t) ? t : undefined;
    for (const p of this.stack) p.held = false;
    const mark = {};
    this.releasing = mark;
    setImmediate(() =>
      setImmediate(() => {
        if (this.releasing !== mark) return;
        this.releasing = undefined;
        this.dropFor = undefined;
      }),
    );
  }

  /** Ctrl+C (also used for a process SIGINT in line mode). */
  ctrlC(): void {
    // While a child owns the terminal (`!cmd`, `$EDITOR`) the SIGINT is the child's: it stops
    // that program, not the agent turn an approval-time `!cmd` was started from.
    if (this.suspended) return;
    const t = this.top();
    if (!t) {
      if (this.listenerCount('interrupt') > 0) this.emit('interrupt');
      else if (this.terminal) this.typeahead.push(['\u0003', { ctrl: true, name: 'c', sequence: '\u0003' }]);
      else this.queue.push('\u0003');
      return;
    }
    if (this.terminal) {
      // muted (a process SIGINT during a fatal signal's grace): the line is forgotten, nothing written
      if (this.muted()) {
        const r = this.rl as unknown as { line: string; cursor: number };
        r.line = '';
        r.cursor = 0;
      } else this.acceptLineDisplay();
    }
    this.finish(t, { kind: 'interrupt' });
  }

  /**
   * Ctrl+Z at an active read (terminal mode, see module doc): stop kiro-claude's process group
   * the way the terminal's own Ctrl+Z would, then take the terminal back. Nothing on Windows (no
   * job control, as readline), without an active read (a turn runs: the Ctrl+Z waits as
   * type-ahead), after the input's end, while a child owns the terminal (its own job control
   * applies), while muted (a fatal signal: keys are dropped), or as a PID namespace's init on Linux
   * (which no default-action stop can stop, r12 #2: the key is dropped). An active read can be an approval
   * prompt in the middle of a turn, with other calls' hook commands still running: they go on
   * while kiro-claude is stopped, and the stop does not count against their timeouts
   * (util/process.ts runningTimeout; one that exited meanwhile keeps its exit status, r8 #0/#1).
   * Any other Ctrl+Z still typed ahead is dropped (one press, one stop: r8 #4). `hungUp` is not
   * touched: only a failing input (the terminal went away meanwhile) ends it. The terminal is
   * taken back later, never here ({@link scheduleRetake}): what came with the continue (a SIGTERM
   * from `kill %1`, a hangup) is handled first, and in the background (`bg`) it is left alone.
   */
  private jobStop(): void {
    if (process.platform === 'win32' || this.closed || this.ended || this.suspended || this.away || this.muted()) return;
    // a PID namespace's init (`unshare --fork --pid --mount-proc kiro-claude chat`): the kernel
    // ignores a default-action stop for it, so SIGTSTP stopped only the rest of its group (unshare),
    // the shell took the terminal and the chat ran on behind it (r12 #2): Ctrl+Z does nothing there,
    // as for a session leader
    if (process.platform === 'linux' && process.pid === 1) return;
    const inp = this.input as NodeJS.ReadStream;
    const t = this.top();
    if (!t) return;
    // the shell prints below the input, and gets the terminal as a shell expects it
    this.cursorToInputEnd();
    this.output.write('\u001b[?2004l');
    try {
      if (typeof inp.setRawMode === 'function') inp.setRawMode(false);
    } catch {
      // ignore
    }
    if (this.ended) return; // a hung-up terminal: setRawMode failed (EIO), the input ended
    // not ours until it is taken back: nothing read (in the background a read stops kiro-claude
    // again, SIGTTIN), nothing drawn
    this.away = true;
    this.modeLost = false;
    this.awayOnTty = this.controlling();
    this.rl.pause();
    this.syncBeat();
    const t0 = performance.now();
    // the next SIGCONT is this stop's own (r12 #3)
    this.ownContPending = true;
    try {
      // returns once the group continues (fg, bg), or at once when the stop is discarded
      process.kill(0, 'SIGTSTP');
    } catch {
      // ignore
    }
    // a Ctrl+Z still typed ahead from before this one (being replayed) stops nothing more (r8 #4)
    this.typeahead = this.typeahead.filter(([, q]) => !isCtrlZ(q));
    // after a real stop the shell's lines are below the input and the cursor is on a fresh line:
    // the prompt is drawn there; after a discarded one the input is redrawn in place
    this.scheduleRetake(performance.now() - t0 >= STOP_SEEN_MS);
  }

  /**
   * SIGCONT ({@link LineReader.onSigcont}): kiro-claude continues after a stop it did not make
   * itself (`kill -TSTP` / `kill -STOP`, then `fg`), or in the background after any stop (`bg`,
   * `kill -CONT`), or is brought back to the foreground after that (`fg`). The shell has put the
   * terminal in its own (cooked) mode, where Enter would be a soft newline and Ctrl+D an end of
   * input: it is taken back as after {@link jobStop} ({@link scheduleRetake}), the active read's
   * prompt drawn on the shell's fresh line. Nothing of the terminal is touched here, inside the
   * SIGCONT dispatch (r9 #0/#1). Not for the SIGCONT of a stop whose retake is scheduled, nor for
   * the reader's own stop's SIGCONT dispatched within {@link OWN_CONT_MS} after its retake (only
   * while {@link ownContPending}: a stop from elsewhere and its `fg` right after a retake is
   * taken back too, r12 #3), while a child owns the terminal, or once the input ended; while
   * muted (a fatal signal closes kiro-claude) the input is only paused. A stop from elsewhere that
   * the heartbeat saw ({@link onBeat}) parked the input before this poll, so the keys the shell
   * queued are still in the terminal, read at the retake as typed ({@link takeCooked}; r11 #0:
   * this listener runs after the other I/O of its poll, and pausing here alone came after they
   * were read), or dropped for an approval asked in the meantime ({@link release}, r12 #0); this
   * SIGCONT decides the park: it was a stop.
   */
  private continued(): void {
    // the SIGCONT of the reader's own stop, if one was still to come (r12 #3)
    const own = this.ownContPending;
    this.ownContPending = false;
    const parked = this.parked;
    this.parked = false;
    if (this.closed || this.ended || this.suspended) return;
    if (this.muted()) {
      // nothing more is read: in the background a read would stop the close (SIGTTIN)
      this.rl.pause();
      return;
    }
    if (this.retakePending) return;
    if (!this.away && own && performance.now() - this.retakenAt < OWN_CONT_MS) {
      // (a park needs a gap longer than this since the retake: not reached; given back all the same)
      if (parked) {
        this.rl.resume();
        this.release();
      }
      return;
    }
    if (!this.away) {
      this.away = true;
      this.modeLost = true;
      this.awayOnTty = this.controlling();
      this.rl.pause();
      this.syncBeat();
    }
    this.scheduleRetake(true);
  }

  /**
   * The heartbeat runs while the input flows in terminal mode on POSIX (not away after a stop,
   * not while a child owns the terminal, not once closed), and only then ({@link INPUT_BEAT_MS});
   * called wherever one of those changes. A restart starts from now: no gap is seen across a stop
   * the reader made or knew of.
   */
  private syncBeat(): void {
    const on = this.terminal && process.platform !== 'win32' && !this.closed && !this.ended && !this.away && !this.suspended;
    if (on === (this.beat !== undefined)) return;
    if (!on) {
      clearInterval(this.beat);
      this.beat = undefined;
      return;
    }
    this.beatAt = performance.now();
    this.beat = setInterval(() => this.onBeat(), INPUT_BEAT_MS);
    this.beat.unref();
  }

  /**
   * A beat ({@link INPUT_BEAT_MS}). One that comes more than {@link INPUT_GAP_MS} after the one
   * before saw a gap: a stop from elsewhere (`kill -STOP`, `kill -TSTP`) or a blocked event loop.
   * Which one is told only by the poll that follows, whose signals are dispatched after its other
   * I/O, so the input is parked first: paused, its reading stopped ({@link stopReading}), the keys
   * left in the terminal. A SIGCONT in that poll makes it a stop ({@link continued}: the terminal
   * is taken back and the keys the shell queued are read as typed there); none, and the check
   * phase right after gives the input back as it was ({@link unpark}). Nothing while muted, or when
   * the input is paused already.
   */
  private onBeat(): void {
    // an own stop's SIGCONT is dispatched before its retake, and the beat runs only from then on:
    // one still to come here belongs to a stop the kernel discarded, which sends none (r12 #3)
    this.ownContPending = false;
    const now = performance.now();
    const gap = now - this.beatAt;
    this.beatAt = now;
    if (gap <= INPUT_GAP_MS || this.parked) return;
    if (this.closed || this.ended || this.away || this.suspended || this.muted()) return;
    if ((this.rl as unknown as { paused?: boolean }).paused === true) return;
    this.park();
  }

  /**
   * Park the input ({@link onBeat}): paused, its reading stopped (also for the rest of this poll's
   * callbacks), given back in the next check phase ({@link unpark}) unless a SIGCONT decides first.
   */
  private park(): void {
    this.beatAt = performance.now();
    this.parked = true;
    this.rl.pause();
    stopReading(this.input);
    setImmediate(() => this.unpark());
  }

  /**
   * The event loop got no turn for longer than {@link INPUT_GAP_MS} and the heartbeat has not run
   * since (it is overdue): a stall, or a stop from elsewhere, ended in the callbacks running now,
   * and what the terminal holds was typed during it (r12 verification: {@link readImpl}).
   */
  private overdue(): boolean {
    if (this.beat === undefined || this.parked || this.closed || this.ended || this.away || this.suspended || this.muted()) return false;
    return performance.now() - this.beatAt > INPUT_GAP_MS;
  }

  /**
   * The check phase after the poll that followed a park ({@link onBeat}) with no SIGCONT in it
   * ({@link continued} decides otherwise): no stop, the event loop was blocked. The input goes on
   * as if nothing happened: resumed (unless something else holds it meanwhile: away, a child,
   * closed; a prompt drawn meanwhile left it paused, {@link promptLine}), nothing drawn, no mode
   * changed, the keys read raw, in the order typed, but after the Claude Code output read during
   * the park: for an approval asked in it they were typed before its question, and are dropped
   * ({@link release}, r12 #0). A stop that came after that poll had begun is seen by the next beat
   * (the gap is still there).
   */
  private unpark(): void {
    if (!this.parked) return;
    this.parked = false;
    if (this.closed || this.ended || this.away || this.suspended) return;
    if ((this.rl as unknown as { paused?: boolean }).paused === true) this.rl.resume();
    this.release();
  }

  /**
   * Take the terminal back after a stop ({@link retakeNow}) two event-loop turns from now, never
   * inside the stop's own callback or the SIGCONT dispatch: a terminal mode change from the
   * background stops kiro-claude again at once (SIGTTOU), before the other SIGCONT listeners and
   * the signals that came with the continue had run (r9 #0/#1). The first turn's check phase runs
   * before the poll phase that dispatches those signals (`kill %1`: SIGTERM, then SIGCONT; a
   * closed terminal: SIGHUP), the second after it.
   */
  private scheduleRetake(freshLine: boolean): void {
    const p = this.retakePending;
    if (p) {
      p.freshLine ||= freshLine;
      return;
    }
    const pending = { freshLine };
    this.retakePending = pending;
    setImmediate(() =>
      setImmediate(() => {
        if (this.retakePending !== pending) return;
        this.retakePending = undefined;
        this.retakeNow(pending.freshLine);
      }),
    );
  }

  /**
   * The scheduled retake: nothing while muted (a fatal signal's close runs; the terminal stays as
   * the shell left it, nothing is drawn: r9 #1) nor in the background (`bg`, `kill -CONT` while a
   * shell holds the terminal: off the terminal); else {@link retake}. In the background the reader
   * looks again every {@link FOREGROUND_POLL_MS} ({@link lookAgain}). An input that was the
   * controlling terminal when the reader went away and is not any more (the terminal session
   * ended: no SIGHUP reaches an orphaned group that is not stopped, and "cannot be told" counts as
   * the foreground) ends as at a hangup, nothing touched ({@link endAsHungUp}, r12 #4).
   */
  private retakeNow(freshLine: boolean): void {
    this.stopAwayPoll();
    if (this.closed || this.ended || !this.away || this.muted()) return;
    if (this.suspended) {
      // a child owns the terminal: resume() takes it back
      this.away = false;
      return;
    }
    if (this.awayOnTty && !this.controlling()) {
      this.endAsHungUp();
      return;
    }
    if (this.foreground()) {
      this.retake(this.top(), freshLine);
      return;
    }
    this.pollAway();
  }

  private pollAway(): void {
    this.awayPoll = setTimeout(() => {
      this.awayPoll = undefined;
      this.lookAgain();
    }, FOREGROUND_POLL_MS);
  }

  /**
   * Away in the background, the next look ({@link FOREGROUND_POLL_MS} after the last): in the
   * foreground again (`fg` of a job a shell knows to be running gives it the terminal without a
   * SIGCONT) the terminal is taken back ({@link scheduleRetake}). Still in the background while a
   * read waits for the terminal (the prompt, an approval, a question), kiro-claude stops like a
   * background job that reads its terminal ('Stopped (tty input)', {@link stopInBackground}, r11:
   * before, it only polled, and under `sudo` with `use_pty` it then never came up after `fg`); once
   * it continues (`fg`: its SIGCONT; `bg` or a `kill -CONT` while the shell holds the terminal: it
   * stops again at the next look) the retake is scheduled as after any continue, two event-loop
   * turns on, after the signals that came with it (`kill %1` closes it, muted). While no read waits
   * (a turn runs in the background, its output still written there) it only looks again later; it
   * stops at the turn's next prompt. A stop the kernel discards (an orphaned process group) leaves
   * the poll as before. A SIGCONT comes back through {@link continued} at once (the stop's own:
   * {@link ownContPending}). A stop that came back at once makes the next one a SIGTSTP ({@link
   * TerminalStops}). The question of a read that waits here was written to the terminal before
   * the look: keys typed after `fg` are typed at it, not dropped as typed before it ({@link
   * PendingRead.held}).
   */
  private lookAgain(): void {
    if (this.closed || this.ended || !this.away || this.suspended || this.muted() || this.foreground()) {
      this.scheduleRetake(true);
      return;
    }
    if (this.top()) {
      // the question of a read that waits here is on the screen now (written from the background):
      // what is typed after `fg` is typed at it, so it is read as after any stop (r12 #0)
      for (const p of this.stack) p.held = false;
      const t0 = performance.now();
      if (this.stopInBackground(this.stops.next)) {
        this.stops.sent(performance.now() - t0);
        // the next SIGCONT is this stop's own (r12 #3)
        this.ownContPending = true;
        this.scheduleRetake(true);
        return;
      }
      this.stops.notSent();
    }
    this.pollAway();
  }

  private stopAwayPoll(): void {
    if (this.awayPoll) clearTimeout(this.awayPoll);
    this.awayPoll = undefined;
  }

  /**
   * Raw mode was just turned on after the shell had the terminal in its cooked mode ({@link
   * retake} after a stop; {@link resume} after a child that ended while kiro-claude was in the
   * background, and the constructor of a reader created after the chat waited in the background:
   * LineReaderOptions.cooked; r10 #2): the keys the terminal queued meanwhile (typed after `fg`
   * before the foreground poll noticed it) are read as typed in that mode ({@link cookedKeys}):
   * their Return submits and a Ctrl+D is Ctrl+D. Those keys are what the
   * input already holds now, so they are read at the next poll phase: what is read before the
   * second check phase from now (whichever phase this runs in) counts as cooked, a key typed after
   * that (a few milliseconds at most, before the prompt is even seen) is raw: a Ctrl+J stays a soft
   * newline, and so does everything from a bracketed-paste start on. The bytes are changed in place
   * by a 'data' listener ahead of readline's. Not for an approval prompt (a read that discards
   * type-ahead): keys typed before its question was on the screen again (blind, during an
   * approval-time `!cmd`; into the shell before `fg`) answer nothing without an Enter typed at it
   * (r10 verification). Not after a child that ended in the foreground, nor for a chat that
   * started there either: a newline typed meanwhile stays a soft newline, as in Q, so a paste
   * (unbracketed in a cooked terminal) stays one input and none of its lines runs on its own.
   */
  private takeCooked(): void {
    this.cookedOff?.();
    if (this.closed || this.ended) return;
    const inp = this.input as unknown as Partial<EventEmitter>;
    if (typeof inp.prependListener !== 'function' || typeof inp.removeListener !== 'function') return;
    let lineStart = true;
    const onData = (chunk: unknown): void => {
      if (!(chunk instanceof Uint8Array)) return;
      // an approval prompt: its answer is typed at its question
      if (this.top()?.discard) return;
      const r = cookedKeys(chunk, lineStart);
      lineStart = r.lineStart;
      if (r.raw) off();
    };
    const off = (): void => {
      if (this.cookedOff !== off) return;
      this.cookedOff = undefined;
      inp.removeListener?.('data', onData);
    };
    inp.prependListener('data', onData);
    this.cookedOff = off;
    setImmediate(() => setImmediate(off));
  }

  /**
   * After a stop, in the foreground: raw mode back on, the input resumed, bracketed paste on again
   * (a shell turns it off before it continues a job, bash does), the active read `t` drawn again,
   * on a fresh line (`freshLine`: the shell printed below the input) or in place, and the keys
   * still typed ahead after a replayed Ctrl+Z replayed into it. The keys the terminal queued in
   * the shell's cooked mode meanwhile are read as typed there ({@link takeCooked}, r10 #2); after
   * a stop from elsewhere these include the keys typed in the shell before `fg` (the heartbeat
   * parked the input before they were read, r11 #0), except when kiro-claude leads its session:
   * no shell can have taken the terminal, its mode stayed raw, and the keys typed during the stop
   * are raw keys, read as such. For an approval asked since the stop (Claude Code's request was
   * read while away) they were typed before its question, and are dropped ({@link release}).
   */
  private retake(t: PendingRead | undefined, freshLine: boolean): void {
    const inp = this.input as NodeJS.ReadStream;
    // a stop from elsewhere with no shell that could have taken the terminal meanwhile
    // (kiro-claude leads its session: `ssh -t`, `docker run -it`): its mode stayed raw, and the
    // keys typed during the stop were raw keys (r11 #0: they wait in the terminal until now)
    const keysRaw = this.modeLost && terminalJob(this.input)?.sessionLeader === true;
    if (this.modeLost) {
      this.modeLost = false;
      try {
        // libuv applies a mode only when it changes: off first, then on again below
        if (typeof inp.setRawMode === 'function') inp.setRawMode(false);
      } catch {
        // ignore
      }
      if (this.ended) return; // a hung-up terminal (EIO)
    }
    try {
      if (typeof inp.setRawMode === 'function') inp.setRawMode(true);
    } catch {
      // ignore
    }
    this.retakenAt = performance.now();
    this.away = false;
    this.stops = new TerminalStops();
    this.syncBeat();
    if (this.closed || this.ended) return;
    this.rl.resume();
    this.release();
    if (!keysRaw) this.takeCooked();
    if (this.muted()) return;
    this.output.write('\u001b[?2004h');
    if (t && !t.done) {
      if (freshLine) (this.rl as unknown as { prevRows?: number }).prevRows = 0;
      // (a read that started while away has not had its prompt set: showPrompt drew nothing)
      this.rl.setPrompt(t.prompt);
      this.rl.prompt(true);
    }
    this.replayTypeahead();
  }

  /** Put the terminal's cursor after the active read's input (readline's own cursor stays). */
  private cursorToInputEnd(): void {
    const r = this.rl as unknown as {
      line: string;
      cursor: number;
      prevRows?: number;
      getCursorPos?: () => { rows: number; cols: number };
    };
    if (typeof r.getCursorPos !== 'function') return;
    const at = r.getCursorPos();
    const cursor = r.cursor;
    r.cursor = r.line.length;
    const end = r.getCursorPos();
    r.cursor = cursor;
    readline.moveCursor(this.output as NodeJS.WritableStream, end.cols - at.cols, end.rows - at.rows);
    r.prevRows = end.rows;
  }

  private onTerminalLine(line: string): void {
    // readline added the physical line to its history; logical inputs are added explicitly.
    const hist = this.rlHistory();
    if (this.readlineAddedHistory && hist && hist[0] === line) hist.shift();
    this.readlineAddedHistory = false;
    if (this.inputEnded) return;
    const t = this.top();
    if (!t) return;
    this.deliverLine(t, line, false);
  }

  // ───────────────────────────── history / lifecycle ─────────────────────────────

  /** Add a logical input to the Up/Down history (consecutive duplicates collapse). */
  addHistory(entry: string): void {
    if (entry.trim() === '') return;
    const hist = this.rlHistory() ?? this.fallbackHistory;
    if (hist[0] !== entry) {
      hist.unshift(entry);
      if (hist.length > this.historySize) hist.length = this.historySize;
      this.onHistory?.(entry);
    }
  }

  /** History, newest first. */
  history(): string[] {
    return [...(this.rlHistory() ?? this.fallbackHistory)];
  }

  /**
   * Give the terminal to a child process (`$EDITOR`, `!cmd`): the input paused, bracketed paste
   * off (r9 #8: the terminal would wrap a paste into the child in ESC[200~ … ESC[201~, which a
   * cooked-mode program such as `cat` or `read` takes as input; Q's rustyline and bash turn it off
   * too whenever they leave raw mode) and raw mode off. The bracketed-paste switch goes where the
   * reader turned it on, its own output (terminal mode only), and not while muted or closed.
   * Until {@link resume} the reader changes no terminal mode: the REPL catches SIGTTOU meanwhile
   * (repl/core.ts guardChild, r10 #0), and with it caught a mode change from the background would
   * restart forever; for the same reason the REPL holds what is written to its output then (a
   * {@link printAbove} included) until the child is done.
   */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    if (!this.terminal) return;
    this.syncBeat();
    this.rl.pause();
    if (!this.closed && !this.ended && !this.muted()) this.output.write('\u001b[?2004l');
    const inp = this.input as NodeJS.ReadStream;
    try {
      if (typeof inp.setRawMode === 'function') inp.setRawMode(false);
    } catch {
      // ignore
    }
  }

  /**
   * Take the terminal back from the child: raw mode, the input resumed, and bracketed paste on
   * again, as after a stop ({@link retake}): {@link suspend} turned it off for the child, which
   * may also have toggled it itself (vim at exit; bash before it continues a job stopped with
   * Ctrl+Z while the child owned the terminal, whose SIGCONT {@link continued} leaves to the
   * child), and a paste would then submit line by line (r8 #2). `cooked`: the child ended while
   * kiro-claude was in the background and the REPL waited for `fg` (repl/core.ts handBack), so the
   * keys the terminal queued meanwhile (typed after `fg` before the REPL noticed it, and those the
   * child left unread) are read as typed in its cooked mode ({@link takeCooked}, r10 #2). Without
   * it a newline typed during the child stays a soft newline, as in Q.
   */
  resume(cooked = false): void {
    if (!this.suspended) return;
    this.suspended = false;
    // (a read's question was up during the child: what it left is read as typed at it, r10)
    for (const p of this.stack) p.held = false;
    if (!this.terminal) return;
    this.syncBeat();
    const inp = this.input as NodeJS.ReadStream;
    try {
      if (typeof inp.setRawMode === 'function') inp.setRawMode(true);
    } catch {
      // ignore
    }
    this.rl.resume();
    if (cooked) this.takeCooked();
    if (!this.closed && !this.ended && !this.muted()) this.output.write('\u001b[?2004h');
  }

  private onClose(): void {
    this.ended = true;
    this.stopAwayPoll();
    this.syncBeat();
    // every pending read gets EOF (top first)
    for (const p of [...this.stack].reverse()) this.finish(p, { kind: 'eof' });
  }

  /**
   * End the reader: its reads get `eof`. In terminal mode raw mode and bracketed paste are turned
   * off, unless kiro-claude is not in the terminal's foreground (away after a stop, or {@link
   * foreground} says so): from the background readline's close() (raw mode off: a tcsetattr) and
   * the switch (a write, with `stty tostop`) stopped kiro-claude with SIGTTOU until `fg` (r10 #3).
   * There the input is paused and readline closed without the mode change; the terminal stays as
   * the shell has it (Node's own exit restores the mode kiro-claude started with).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopAwayPoll();
    this.syncBeat();
    this.cookedOff?.();
    const away = this.terminal && (this.away || !this.foreground());
    if (this.terminal && !away) this.output.write('\u001b[?2004l');
    if (!away) {
      this.rl.close();
      return;
    }
    // readline's close() calls the input's setRawMode(false): a no-op stands in while it runs
    withoutRawSwitch(this.input, () => this.rl.close());
  }
}

// ───────────────────────────── history files ─────────────────────────────

/** History file for `mode` (see module doc). */
export function historyFilePath(ws: WorkspaceContext, mode: string | undefined, sessionId: string): string {
  const dir = path.join(ws.kiroHome, 'kiro-claude', 'history');
  if (mode === 'global' || !isSafeSessionId(sessionId)) return path.join(dir, 'global.jsonl');
  return path.join(dir, `${sessionId}.jsonl`);
}

/** Entries of a history file, oldest first (bad lines skipped; at most `max`). */
export function loadHistoryFile(file: string, max = DEFAULT_HISTORY_SIZE): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v: unknown = JSON.parse(line);
      if (typeof v === 'string') out.push(v);
    } catch {
      // skip
    }
  }
  return out.slice(-max);
}

/** Append one entry (JSON string per line); trims the file when it grows past 2×max. */
export function appendHistoryFile(file: string, entry: string, max = DEFAULT_HISTORY_SIZE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    const st = fs.statSync(file);
    if (st.size > 4096 && st.size > max * 400) {
      const keep = loadHistoryFile(file, max);
      fs.writeFileSync(file, keep.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
    }
  } catch {
    // history is best effort
  }
}
