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
 *      - bracketed paste (`ESC[200~ … ESC[201~`) keeps pasted newlines inside one input; it is
 *        turned on again whenever the terminal is taken back: after a stop, and after a child
 *        (`!cmd`, `$EDITOR`), which may have turned it off (vim at exit; bash before `fg`
 *        continues a job stopped while the child owned the terminal; r8 #2);
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
 *        terminal is taken back the same way at SIGCONT, the prompt drawn on a fresh line;
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
}

interface PendingRead {
  prompt: string;
  resolve: (r: ReadResult) => void;
  done: boolean;
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

/** Ctrl+Z (readline's key for \x1a). */
const isCtrlZ = (k: Key): boolean => k.ctrl === true && !k.shift && k.name === 'z';

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
  private suspended = false;
  private typeahead: [string | undefined, Key][] = [];
  private readlineAddedHistory = false;
  private ttyWrite: ((s: string | undefined, key: Key | undefined) => void) | undefined;
  private readonly onHistory: ((entry: string) => void) | undefined;
  private readonly muted: () => boolean;
  private readonly historySize: number;
  private readonly fallbackHistory: string[] = [];
  /** Terminal mode: removes the guarded stand-ins of readline's 'resize' listeners ({@link guardResize}). */
  private unguardResize: (() => void) | undefined;

  constructor(opts: LineReaderOptions) {
    super();
    this.terminal = opts.terminal;
    this.input = opts.input;
    this.output = opts.output;
    this.onHistory = opts.onHistory;
    this.muted = opts.muted ?? (() => false);
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

  /** Feed keys typed while no read was active into the read that just started. */
  private replayTypeahead(): void {
    const write = this.ttyWrite;
    if (!write) return;
    while (this.typeahead.length > 0 && this.reading && !this.suspended) {
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
      if (this.suspended) return;
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
    if (this.terminal && !this.suspended && !this.muted()) {
      this.rl.setPrompt(prompt);
      this.rl.prompt(true);
    }
  }

  /** Print `text` (ending with a newline) above the active prompt, then redraw it. */
  printAbove(text: string): void {
    if (this.muted()) return;
    const t = this.top();
    if (!t || !this.terminal || this.suspended) {
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
        if (this.closed || this.suspended || this.muted() || !this.top()) return;
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
   * touched: only a failing input (the terminal went away meanwhile) ends it.
   */
  private jobStop(): void {
    if (process.platform === 'win32' || this.closed || this.ended || this.suspended || this.muted()) return;
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
    this.retake(t, performance.now() - t0 >= STOP_SEEN_MS);
  }

  /**
   * SIGCONT ({@link LineReader.onSigcont}): kiro-claude continues after a stop it did not make
   * itself (`kill -TSTP` / `kill -STOP`, then `fg`). The shell has put the terminal back in its
   * own (cooked) mode, where Enter would be a soft newline and Ctrl+D an end of input: it is
   * taken back as after {@link jobStop}, the active read's prompt drawn on the shell's fresh line.
   * Not for the SIGCONT of a stop that {@link retake} has just handled, while a child owns the
   * terminal, while muted, or once the input ended.
   */
  private continued(): void {
    if (this.closed || this.ended || this.suspended || this.muted()) return;
    if (performance.now() - this.retakenAt < OWN_CONT_MS) return;
    const inp = this.input as NodeJS.ReadStream;
    try {
      // libuv applies a mode only when it changes: off first, then on again in retake
      if (typeof inp.setRawMode === 'function') inp.setRawMode(false);
    } catch {
      // ignore
    }
    if (this.ended) return; // a hung-up terminal (EIO)
    this.retake(this.top(), true);
  }

  /**
   * After a stop: raw mode back on, the input resumed, bracketed paste on again (a shell turns it
   * off before it continues a job, bash does) and the active read `t` drawn again, on a fresh line
   * (`freshLine`: the shell printed below the input) or in place.
   */
  private retake(t: PendingRead | undefined, freshLine: boolean): void {
    const inp = this.input as NodeJS.ReadStream;
    try {
      // in the background (`bg`) this stops again (SIGTTOU) until `fg`
      if (typeof inp.setRawMode === 'function') inp.setRawMode(true);
    } catch {
      // ignore
    }
    this.retakenAt = performance.now();
    if (this.closed || this.ended) return;
    this.rl.resume();
    if (this.muted()) return;
    this.output.write('\u001b[?2004h');
    if (!t || t.done) return;
    if (freshLine) (this.rl as unknown as { prevRows?: number }).prevRows = 0;
    this.rl.prompt(true);
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

  /** Give the terminal to a child process (`$EDITOR`, `!cmd`). */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    if (!this.terminal) return;
    this.rl.pause();
    const inp = this.input as NodeJS.ReadStream;
    try {
      if (typeof inp.setRawMode === 'function') inp.setRawMode(false);
    } catch {
      // ignore
    }
  }

  /**
   * Take the terminal back from the child: raw mode, the input resumed, and bracketed paste on
   * again, as after a stop ({@link retake}): the child may have turned it off (vim at exit; bash
   * before it continues a job stopped with Ctrl+Z while the child owned the terminal, whose
   * SIGCONT {@link continued} leaves to the child), and a paste would then submit line by line (r8 #2).
   */
  resume(): void {
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
    if (!this.closed && !this.ended && !this.muted()) this.output.write('\u001b[?2004h');
  }

  private onClose(): void {
    this.ended = true;
    // every pending read gets EOF (top first)
    for (const p of [...this.stack].reverse()) this.finish(p, { kind: 'eof' });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.terminal) this.output.write('\u001b[?2004l');
    this.rl.close();
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
