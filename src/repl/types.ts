/**
 * REPL-internal contracts (not cross-module: only src/repl/** and test/repl/** use them).
 *
 * {@link ReplContext} is the full surface built-in slash commands get. It extends the shared
 * {@link ReplHost} contract (src/types.ts) that contributed commands (spec/) receive, so one
 * object (repl/core.ts `Repl`) serves both.
 */

import type {
  CliContext,
  KiroSession,
  KiroSessionOptions,
  PromptInput,
  ReplHost,
  SessionEvent,
  SlashCommand,
  TurnResult,
} from '../types.js';

/** Session options the caller of runRepl supplies (everything but what the REPL owns). */
export type ReplSessionOptions = Omit<KiroSessionOptions, 'ui' | 'interactive' | 'origin' | 'ws'>;

/** Options of {@link runRepl} (signature fixed by the Wave-2 entry-point rules). */
export interface RunReplOptions {
  ctx: CliContext;
  sessionOptions: ReplSessionOptions;
  /** Positional `chat INPUT`: processed as the first input after the greeting (01 §3). */
  initialInput?: string;
  /** `--wrap` (01 §3): `auto` (default) wraps when stdout is a TTY. */
  wrap?: 'always' | 'never' | 'auto';
}

/** Injectable dependencies (the real ones are wired by repl/repl.ts; tests pass mocks). */
export interface ReplDeps {
  createSession(opts: KiroSessionOptions): Promise<KiroSession>;
  importSessionExport?(path: string, opts: Omit<KiroSessionOptions, 'resume' | 'fork'>): Promise<KiroSession>;
  /** Commands contributed by other modules (spec/slash.ts `specSlashCommands`). */
  extraCommands?: readonly SlashCommand[];
  /** Install a process SIGINT handler (only the real terminal entry point does). */
  installSignalHandlers?: boolean;
  /** Random source for the greeting tip (tests pin it). */
  random?: () => number;
}

/** One entry of the REPL-local transcript (for /transcript and /reply). */
export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

/** Outcome of opening `$EDITOR` (01 §5.7). */
export type EditorResult = { ok: true; text: string } | { ok: false; error: string };

/** Everything a built-in slash command may use (see module doc). */
export interface ReplContext extends ReplHost {
  readonly ctx: CliContext;
  /** `kiro-claude` or `kiro-cli` (shim), for user-facing hints. */
  readonly progName: string;
  /** Text of the last assistant answer (for /reply, /copy). */
  readonly lastAssistantText: string | undefined;
  readonly transcript: readonly TranscriptEntry[];
  /** Write raw text (no newline added). */
  write(text: string): void;
  /** All registered commands (built-ins first), for /help and completion. */
  commands(): readonly SlashCommand[];
  /** Process `text` exactly like a typed input line (prompt expansion, `!cmd`, turns). */
  submit(text: string): Promise<void | 'quit'>;
  /** Open `$EDITOR` (fallback `vi`) on a temp file prefilled with `initial`. */
  openEditor(initial: string, opts?: { suffix?: string; file?: string }): Promise<EditorResult>;
  /** Run `!cmd` semantics (01 §4.3 step 4). */
  runBang(command: string): Promise<void>;
  /** Options to create a sibling session (current agent/model/effort, no resume/fork). */
  baseSessionOptions(): ReplSessionOptions;
  /** Close the active session and make `next` active (/chat new|resume|load). */
  swapSession(next: KiroSession): Promise<void>;
  /** /chat load: import a `/chat save` export (undefined when unsupported). */
  importSession(path: string): Promise<KiroSession>;
  /** Re-read cached values (usage %, prompt) after a command changed the session. */
  refreshUsage(): Promise<void>;
  /** Ask the REPL to exit after the current command (with an exit code). */
  requestExit(code?: number): void;
  /** Read one answer line (default prompt: yellow `> `); undefined on Ctrl+C / EOF. */
  readAnswer(prompt?: string): Promise<string | undefined>;
  /** Send `text` as a user turn with the main-prompt follow-ups (plan handoff, usage refresh). */
  sendPrompt(input: PromptInput): Promise<void | 'quit'>;
  /** Render a session event stream (e.g. /compact) like a turn; `seen` = event types observed. */
  runEvents(start: (signal: AbortSignal) => AsyncGenerator<SessionEvent, TurnResult>): Promise<{ result: TurnResult; seen: Set<SessionEvent['type']> }>;
  /** Terminal width (80 when unknown). */
  readonly columns: number;
  /** A turn is running (commands typed at its `[y/n/t]` prompt must not replace the session). */
  readonly busy: boolean;
}

/** A built-in command: same shape as SlashCommand, but its run gets the full context. */
export interface BuiltinCommand {
  name: string;
  aliases?: string[];
  summary: string;
  usage?: string;
  /** Hidden from /help (deprecated aliases, stubs of retired commands). */
  hidden?: boolean;
  run(args: string[], raw: string, repl: ReplContext): Promise<void | 'quit'>;
}
