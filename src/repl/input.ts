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
 *        its half-typed line. readline's own suspend is never used: it left the input paused
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
 *        terminal is taken back the same way at SIGCONT, the prompt drawn on a fresh line.
 *        From the stop on the input is paused and nothing is drawn until the terminal is taken
 *        back, which happens two event-loop turns after the continue, never inside the stop's
 *        callback or the SIGCONT dispatch, and only in the foreground (r9 #0/#1: a mode change
 *        from the background stops kiro-claude again at once, SIGTTOU, before the other SIGCONT
 *        listeners and the signals that came with the continue run). So `kill %1` of a stopped
 *        chat (bash: SIGTERM, then SIGCONT) or a closed terminal (SIGHUP) closes it at once,
 *        muted, with the terminal left as the shell has it; and continued in the background
 *        (`bg`, `kill -CONT` while a shell holds the terminal) the chat runs on (a turn's output
 *        still appears) but stays off the terminal (no prompt, no mode change, no read) until
 *        `fg`: its SIGCONT, or the next look at the foreground ({@link FOREGROUND_POLL_MS}, 20 ms,
 *        while away in the background only: bash's `fg` of a job it knows to be running sends
 *        none). The foreground test is Linux's
 *        /proc/self/stat ({@link terminalInForeground}); elsewhere (DECISION, no portable
 *        tcgetpgrp without a native module) it takes the foreground: after `bg` the chat stops
 *        again (SIGTTOU) at the retake until `fg`, as before, while the deferral still lets a
 *        fatal signal win. {@link LineReader.close} in the background (away, or not in the
 *        foreground) changes no mode and writes nothing either (r10 #3: readline's close() turned
 *        raw mode off from there, and SIGTTOU stopped kiro-claude until `fg`);
 *      - keys queued in the shell's cooked mode: when the reader takes the terminal back after a
 *        stop (typed after `fg` before the retake), after a child that ended while kiro-claude was
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
 *        streamed can never answer a `[y/n/t]` question by accident (DECISION).
 *  - **line** (stdin is not a TTY: pipes, tests): lines are queued in arrival order and handed
 *    to reads; the prompt and the consumed line are written so transcripts look like the
 *    terminal. A line that is exactly `\x03` stands for Ctrl+C (emitted as `'interrupt'` at
 *    once when a turn is listening, else queued) and `\x04` for Ctrl+D. End of input ⇒ `eof`.
 *
 * In both modes an error on the input (a hung-up terminal: EIO from `setRawMode` or a read) is
 * end of input: every pending read gets `eof`, never an unhandled 'error' (r5 #1); in terminal
 * mode a half-typed line at the input's end (the terminal went away) is dropped, not delivered
 * as a line (line mode keeps a last line without a newline: piped text), and
 * {@link LineReader.hungUp} says the terminal hung up (its SIGHUP follows, r6 #3). While the
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

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
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
  /** Terminal mode: drop keys typed before this read started (approval prompts). */
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
   * Terminal mode: kiro-claude waited off the terminal in the background before this reader takes
   * it (repl/core.ts run: `kiro-claude chat &`, a stop while it started and `bg`; r10 #1), so the
   * keys the terminal queued in its cooked mode (typed after `fg` before the chat noticed it) are
   * read as typed there ({@link cookedKeys}). Without it, a newline typed while the chat started
   * stays Ctrl+J, a soft newline, as in Q (a paste stays one input).
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
 * the event loop after the stop was handled synchronously): nothing more to do.
 */
const OWN_CONT_MS = 250;
/**
 * Off the terminal in the background (the reader after a stop, {@link LineReader.retakeNow}; the
 * REPL after a child and before its first prompt, repl/core.ts), kiro-claude asks this often
 * whether it is in the foreground again: `fg` of a job bash knows to be running sends no SIGCONT,
 * and until the terminal is taken back it stays in the shell's cooked mode, where keys are echoed
 * by the terminal and Return arrives as a newline (r10 #2: at 250 ms a line typed right after `fg`
 * was not submitted). A /proc/self/stat read; only while in the background.
 */
export const FOREGROUND_POLL_MS = 20;

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
 * True whenever that cannot stop kiro-claude or cannot be told: an input that is no terminal
 * file descriptor (tests' fakes), a terminal that is not the controlling one (no job control
 * applies to it), no controlling terminal or no foreground group, and on other systems (no
 * /proc: DECISION, the module doc says what that leaves).
 */
export function terminalInForeground(input: unknown): boolean {
  if (process.platform !== 'linux') return true;
  const fd = (input as { fd?: unknown } | undefined)?.fd;
  if (typeof fd !== 'number' || !tty.isatty(fd)) return true;
  try {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    // after the command name: state ppid pgrp session tty_nr tpgid …
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgrp = Number(f[2]);
    const ttyNr = Number(f[4]);
    const tpgid = Number(f[5]);
    if (!(ttyNr > 0) || !(tpgid > 0)) return true;
    const rdev = fs.fstatSync(fd).rdev;
    if (rdev !== ttyNr && rdev !== DEV_TTY_RDEV) return true;
    return pgrp === tpgid;
  } catch {
    return true;
  }
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
   * and the terminal's mode is not touched (SIGTTOU) (r9 #0/#1).
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
  private suspended = false;
  private typeahead: [string | undefined, Key][] = [];
  private readlineAddedHistory = false;
  private ttyWrite: ((s: string | undefined, key: Key | undefined) => void) | undefined;
  private readonly onHistory: ((entry: string) => void) | undefined;
  private readonly muted: () => boolean;
  private readonly foreground: () => boolean;
  private readonly historySize: number;
  private readonly fallbackHistory: string[] = [];
  /** Terminal mode: removes the guarded stand-ins of readline's 'resize' listeners ({@link guardResize}). */
  private unguardResize: (() => void) | undefined;
  /** Ends the reading of the keys queued in a cooked mode as such ({@link takeCooked}). */
  private cookedOff: (() => void) | undefined;

  constructor(opts: LineReaderOptions) {
    super();
    this.terminal = opts.terminal;
    this.input = opts.input;
    this.output = opts.output;
    this.onHistory = opts.onHistory;
    this.muted = opts.muted ?? (() => false);
    this.foreground = opts.foreground ?? (() => terminalInForeground(opts.input));
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
      this.rl = readline.createInterface(ifOpts);
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
      });
      // Bracketed paste keeps pasted newlines inside one input.
      this.output.write('\u001b[?2004h');
      // keys typed after `fg` while the chat waited off the terminal were queued in its cooked mode
      if (opts.cooked) this.takeCooked();
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
  }

  /** Whether a read is waiting for input. */
  get reading(): boolean {
    return this.stack.length > 0;
  }

  /**
   * Terminal mode: the input ended or failed, i.e. the terminal hung up (in raw mode Ctrl+D is a
   * key, never an end of input), so its SIGHUP is on its way (repl/core.ts waits for it, r6 #3).
   * Always false in line mode, where the end of input is the end of the piped text.
   */
  get hungUp(): boolean {
    return this.terminal && this.inputEnded;
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
      else if (opts.discardTypeahead) this.typeahead = [];
      else this.replayTypeahead();
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
      this.rl.prompt();
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
      this.rl.prompt(true);
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
    this.rl.prompt(true);
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
   * applies) or while muted (a fatal signal: keys are dropped). An active read can be an approval
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
    this.rl.pause();
    const t0 = performance.now();
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
   * SIGCONT dispatch (r9 #0/#1). Not for the SIGCONT of a stop whose retake is scheduled or has
   * just run, while a child owns the terminal, or once the input ended; while muted (a fatal
   * signal closes kiro-claude) the input is only paused.
   */
  private continued(): void {
    if (this.closed || this.ended || this.suspended) return;
    if (this.muted()) {
      // nothing more is read: in the background a read would stop the close (SIGTTIN)
      this.rl.pause();
      return;
    }
    if (this.retakePending) return;
    if (!this.away && performance.now() - this.retakenAt < OWN_CONT_MS) return;
    if (!this.away) {
      this.away = true;
      this.modeLost = true;
      this.rl.pause();
    }
    this.scheduleRetake(true);
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
   * shell holds the terminal: the chat runs on, off the terminal); else {@link retake}. In the
   * background the foreground is asked again every {@link FOREGROUND_POLL_MS}: `fg` of a job a shell
   * knows to be running (bash, after `bg` or a `kill -CONT` it saw) gives it the terminal without
   * a SIGCONT. A SIGCONT comes back here at once ({@link continued}).
   */
  private retakeNow(freshLine: boolean): void {
    this.stopAwayPoll();
    if (this.closed || this.ended || !this.away || this.muted()) return;
    if (this.suspended) {
      // a child owns the terminal: resume() takes it back
      this.away = false;
      return;
    }
    if (this.foreground()) {
      this.retake(this.top(), freshLine);
      return;
    }
    this.awayPoll = setTimeout(() => {
      this.awayPoll = undefined;
      this.scheduleRetake(true);
    }, FOREGROUND_POLL_MS);
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
   * the shell's cooked mode meanwhile are read as typed there ({@link takeCooked}, r10 #2).
   */
  private retake(t: PendingRead | undefined, freshLine: boolean): void {
    const inp = this.input as NodeJS.ReadStream;
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
    if (this.closed || this.ended) return;
    this.rl.resume();
    this.takeCooked();
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
    if (!this.terminal) return;
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
    this.cookedOff?.();
    const away = this.terminal && (this.away || !this.foreground());
    if (this.terminal && !away) this.output.write('\u001b[?2004l');
    if (!away) {
      this.rl.close();
      return;
    }
    // readline's close() calls the input's setRawMode(false): a no-op stands in while it runs
    const inp = this.input as unknown as { setRawMode?: unknown };
    const own = Object.prototype.hasOwnProperty.call(inp, 'setRawMode');
    const setRawMode = inp.setRawMode;
    if (typeof setRawMode === 'function') inp.setRawMode = () => inp;
    try {
      this.rl.close();
    } finally {
      if (own) inp.setRawMode = setRawMode;
      else delete inp.setRawMode;
    }
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
