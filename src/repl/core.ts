/**
 * The interactive chat REPL (Classic-style line REPL with Kiro command names; 01 §4–§5,
 * 06 §2 / §5 / §6, 00 §2.3–§2.5).
 *
 * Flow: create + start the KiroSession (`origin: 'repl'`, interactive, this REPL as its
 * SessionUI) → greeting → optional initial input → read/dispatch loop → on exit close the
 * session and print `To resume this session: <prog> chat --resume-id <id>` for the record the
 * close kept (`KiroSession.resumeId`; none for a chat that never had a message) (exit 0;
 * 1 when the session could not start or Claude reported an auth failure). SIGHUP / SIGTERM (a
 * closed terminal included: two SIGHUPs within a millisecond count as one, and the hung-up
 * terminal's EIO ends the input, r5 #1), and Ctrl+C while the session starts or during the final
 * close after `/quit` (r5 #6), close it before kiro-claude dies of the signal
 * ({@link ExitSignals}): every session the REPL and its spec runtime opened that is still open,
 * the user's chat first (during a `/spec` flow the current session is a phase or task session;
 * the chat is the one the command started from), then its record is made the newest, under its
 * lock, so `chat --resume` reaches the user's conversation ({@link Repl.closeOnSignal}, r5 P3,
 * g1). From the signal on no session is created and no turn is sent; a running command's signal
 * is aborted; nothing more is printed (no prompt, no turn error, no notice, nothing a command
 * prints through ReplHost.print, no output of a `!cmd` still running, and a spinner animating at
 * the signal is cleared; only the resume hint of a `/quit` whose close the signal came
 * into), and input typed during the grace is neither sent nor run (r5 g2). The same silence holds
 * while kiro-claude dies of a signal the lifecycle forwarder owns (no REPL handlers, r5 g3).
 *
 * Input handling order (01 §4.3): empty ⇒ re-prompt; `/…` ⇒ built-in command, else a file
 * prompt (`/<prompt> args`, prompts take precedence, 00 §2.2), else a skill (inlined with
 * config/skills), else a manual/auto steering name (`/<stem>`, sent as a turn so the session's
 * SteeringActivator injects it), else `Unknown command: /x` (never forwarded to the model:
 * Claude would treat unknown slash text as a prompt, 00 §3.8); `!cmd` ⇒ shell, not sent;
 * `@<prompt> args` ⇒ prompt expansion, any other `@…` text goes to the session (which expands
 * `@file` references); everything else is a user turn.
 *
 * Approvals (SessionUI.requestApproval) are serialized (one question at a time, 00 §3.6), show
 * the Classic tool block and `Allow this action? … [y/n/t]:`, then read a line at the normal
 * prompt (repl/approval.ts semantics); turn events arriving meanwhile (parallel tool calls) are
 * rendered after the answer, and the tool's block is printed again when something came after
 * it, so the question always sits under the tool it is about. A request queued behind an
 * answer that quit the REPL resolves `cancelled` unseen. Ctrl+C there ⇒ `cancelled`. A free-text answer
 * (`redirect`) is sent as the next user turn after the cancelled turn unless the session
 * already did so (detected through the last `record.turns` preview — the contract leaves open
 * which side sends it).
 *
 * Ctrl+C during a turn, or during a slash command that runs without a turn of the REPL's own
 * (`/tangent merge` runs a model summary turn, `/agent swap` respawns Claude Code), ⇒
 * `session.interrupt()`; the press is never kept as type-ahead for the next prompt. Every press
 * while a command runs also aborts its {@link ReplContext.commandSignal} (`/spec run` stops
 * scheduling tasks, 03 §1.7; `/hooks run` and `/chat save|load-via-script` kill the hook's
 * command / the script, whose process group the terminal's SIGINT never reaches). A second
 * Ctrl+C aborts the prompt's signal and, when the turn / command still runs
 * {@link FORCE_STOP_GRACE_MS} later (Claude Code did not end it after the interrupt), stops
 * Claude Code like headless (session close) and ACP (`replaceStuckSession`) do:
 * the session is closed (stdin EOF, SIGTERM after 2 s, then SIGKILL; 00 §2.3 / 04 §8.4), the REPL
 * returns to its prompt and the next input re-creates the session with `--resume` (a conversation
 * without a finished turn, which closing drops, starts afresh; a tangent continues as its own
 * conversation; a Ctrl+C while it restarts cancels that input, and one while the restarted session
 * runs its agentSpawn hooks cancels the restart itself: the hooks are killed, the stopped session
 * stays, and the next input restarts it again, r5 P2). A command is stopped that way only
 * while the session still has work of its own in flight ({@link KiroSession.busy}): a command
 * waiting on another session (a `/spec run` task session or `/chat new` starting) or on Claude
 * Code (re)starting is neither stopped nor abandoned; one waiting on a process of kiro-claude's
 * own (`/hooks run`, `/chat *-via-script`) or on Claude Code's answer to a control request of the
 * idle session (`/usage`, `/mcp`, `/tools`, `/model`, which `busy` does not count; K9,
 * commands/cancellable.ts) ends through the command signal; `$EDITOR` and
 * `!cmd` get the terminal and its SIGINT themselves. A command signal stays aborted after its first
 * press; work a command starts after that (an interrupted `/spec run` task's PostTaskExec hooks,
 * the `/spec` continuation's start) takes {@link ReplContext.nextPressSignal}, which the next press
 * aborts (r5 P1). At the idle prompt the first Ctrl+C / Ctrl+D prints Q's hint, the second exits.
 *
 * Slash commands are shlex-split; unbalanced quotes fall back to a whitespace split so free-text
 * commands (`/plan I don't …`) work. `/<steering>` sends `#steering:<name> …` with
 * `steeringRefs`, never text starting with `/` (Claude runs leading-slash text as its own
 * command). A session that fails to start is closed before exiting 1.
 *
 * All terminal output goes to `ctx.stdout` (child programs' stderr to `ctx.stderr`).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dyingSignal } from '../claude/lifecycle.js';
import { loadPrompts, findPrompt, expandPrompt, parsePromptInvocation } from '../config/prompts.js';
import { discoverSkills, expandSkillInvocation, pluginSkillName } from '../config/skills.js';
import { loadSteering } from '../config/steering.js';
import { findModelEntry } from '../models/models.js';
import { currentStartSignal, isSessionStartCancelled, withStartSignal } from '../session/startSignal.js';
import { SessionStore, previewText, sessionsDir } from '../session/store.js';
import type {
  ApprovalRequest,
  ApprovalResponse,
  CliContext,
  HookConfirmOption,
  KiroSession,
  KiroSessionOptions,
  PromptInput,
  SessionEvent,
  SessionUI,
  SettingsStore,
  SkillInfo,
  SlashCommand,
  TurnResult,
  WorkspaceContext,
} from '../types.js';
import { c, colorEnabled, setColorEnabled } from '../util/ansi.js';
import { shlexSplit } from '../util/shlex.js';
import { classifyApprovalInput } from './approval.js';
import { CANCELLED, untilCancelled } from './commands/cancellable.js';
import { builtinCommands } from './commands/index.js';
import { PLAN_EXECUTE_PROMPT, PLAN_EXECUTE_QUESTION, looksLikePlan } from './commands/plan.js';
import { ExitSignals, anySignal } from './exitSignals.js';
import { openEditor, runShellCommand } from './external.js';
import { LineReader, appendHistoryFile, historyFilePath, loadHistoryFile, sanitizeUnicodeTags } from './input.js';
import { BUSY_MESSAGE, TIPS, approvalQuestion, colorPrompt, exitHint, formatGreeting, resumeHint } from './prompt.js';
import { CommandRegistry, formatCommandHelp } from './registry.js';
import { Spinner, TurnRenderer } from './render.js';
import type { EditorResult, ReplContext, ReplDeps, ReplSessionOptions, RunReplOptions, TranscriptEntry } from './types.js';

const USAGE_TIMEOUT_MS = 2000;
/** After a second Ctrl+C: how long the turn / command may still take before Claude Code is stopped. */
export const FORCE_STOP_GRACE_MS = 1000;
/** Bound on closing a stopped session (ClaudeProcess.close: stdin EOF, 2 s, SIGTERM, 2 s, SIGKILL). */
const FORCE_CLOSE_TIMEOUT_MS = 10_000;
/** A turn / command still unfinished this long after its session was closed is abandoned. */
const ABANDON_AFTER_CLOSE_MS = 2000;
const ABANDONED = Symbol('abandoned');
const NOTIFY_TERMS = [
  'xterm', 'xterm-256color', 'screen', 'screen-256color', 'tmux', 'tmux-256color', 'rxvt', 'rxvt-unicode', 'linux',
  'konsole', 'gnome', 'gnome-256color', 'alacritty', 'iterm2', 'eat-truecolor', 'eat-256color', 'eat-color',
];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

/** Rust `ExitStatus` Display (`exit status: 1`, `signal: 9 (SIGKILL)`), used by Q's `!` message. */
export function exitStatusText(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) {
    const n = (os.constants.signals as Record<string, number>)[signal];
    return n !== undefined ? `signal: ${n} (${signal})` : `signal: ${signal}`;
  }
  return `exit status: ${code ?? 1}`;
}

function errorResult(error: string, cancelled: boolean): TurnResult {
  return { stopReason: cancelled ? 'cancelled' : 'error', isError: !cancelled, text: '', error, permissionDenials: [] };
}

/** Loose comparison of a stored turn preview with the text that was sent. */
function previewMatches(stored: string | undefined, text: string): boolean {
  if (!stored) return false;
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().replace(/…$/, '');
  const a = norm(stored);
  const b = norm(previewText(text));
  if (a === '' || b === '') return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** Ctrl+C handling while a turn or a slash command runs (see the module doc). */
interface InterruptScope {
  /** The reader's `'interrupt'` listener. */
  readonly listener: () => void;
  /** Presses counted so far. */
  readonly presses: number;
  /**
   * Resolves {@link ABANDONED} {@link ABANDON_AFTER_CLOSE_MS} after a forced stop of this scope
   * closed the session (never otherwise).
   */
  readonly abandoned: Promise<typeof ABANDONED>;
  /** The turn / command is over: no forced stop starts any more. */
  end(): void;
}

export class Repl implements ReplContext {
  readonly ctx: CliContext;
  readonly ws: WorkspaceContext;
  readonly settings: SettingsStore;
  readonly progName: string;
  private current!: KiroSession;
  private reader!: LineReader;
  private readonly renderer: TurnRenderer;
  private readonly spinner: Spinner;
  private readonly registry: CommandRegistry;
  private readonly ui: SessionUI;
  private readonly terminal: boolean;
  private readonly usageIndicator: boolean;
  private lastText: string | undefined;
  private readonly log: TranscriptEntry[] = [];
  private exitCode = 0;
  private quitting = false;
  private usagePct: number | undefined;
  private approvalChain: Promise<unknown> = Promise.resolve();
  private redirectText: string | undefined;
  private turnActive = false;
  /** An approval prompt is open: turn events are held back so they cannot break its line. */
  private approving = false;
  private deferred: SessionEvent[] = [];
  private sigHandler: (() => void) | undefined;
  /**
   * A session closed by a forced stop (second Ctrl+C); re-created at the next input.
   * `tangentParent` / `tangentId`: the stop hit tangent `tangentId` of main `tangentParent`.
   */
  private stoppedSession: { session: KiroSession; closing: Promise<void>; tangentParent?: string; tangentId?: string } | undefined;
  /** The running slash command's {@link ReplContext.commandSignal}. */
  private cmdSignal: AbortSignal | undefined;
  /** The controllers of every running slash command's signal (nested ones too): a fatal signal aborts them. */
  private readonly cmdAborts = new Set<AbortController>();
  /** Running slash commands (nested ones count): {@link nextPressSignal} waiters end with theirs. */
  private cmdDepth = 0;
  /**
   * The user's chat while a slash command runs: the session current when the outermost command
   * started, or the one `/chat new|resume|load` swapped in. A command may make sessions of its own
   * current meanwhile (`/spec` phase and task sessions, origin `spec`); see {@link userChat}.
   */
  private chatAtCommand: KiroSession | undefined;
  /** Outstanding {@link nextPressSignal}s with the command depth they were asked for at. */
  private readonly pressWaiters = new Map<AbortController, { depth: number; off: () => void }>();
  /** SIGHUP / SIGTERM (and Ctrl+C while the chat starts) handling; undefined in tests and on Windows. */
  private exits: ExitSignals | undefined;
  /** Every session this REPL opened (weakly: a closed one nothing else holds may go), for {@link closeOnSignal}. */
  private readonly opened = new Set<WeakRef<KiroSession>>();
  /** Session creations still running. */
  private readonly creating = new Set<Promise<unknown>>();

  constructor(
    private readonly opts: RunReplOptions,
    private readonly deps: ReplDeps,
  ) {
    this.ctx = opts.ctx;
    this.ws = opts.ctx.ws;
    this.settings = opts.ctx.settings;
    this.progName = opts.ctx.progName || 'kiro-claude';
    this.terminal = !!(opts.ctx.stdin as { isTTY?: boolean }).isTTY;
    setColorEnabled(colorEnabled(opts.ctx.stdout, this.ws.env));
    this.usageIndicator = this.settings.getBoolean('chat.enableContextUsageIndicator', false);
    const ascii = this.ws.env.KIRO_ASCII_MODE === '1' || !this.settings.getBoolean('chat.allowAsciiArt', true);
    this.renderer = new TurnRenderer((s) => this.rendererOut(s), {
      markdown: !this.settings.getBoolean('chat.disableMarkdownRendering', false),
      ...(this.wrapWidth() !== undefined ? { wrapWidth: this.wrapWidth()! } : {}),
      columns: this.columns,
      showThinking: this.settings.getBoolean('chat.showThinking', true),
      autoExpandToolOutput: this.settings.getBoolean('chat.autoExpandToolOutput', false),
      ascii,
      cwd: this.ws.cwd,
    });
    const animate = !!opts.ctx.stdout.isTTY && this.settings.getBoolean('chat.allowAnimations', true);
    this.spinner = new Spinner((s) => opts.ctx.stdout.write(s), animate);
    this.registry = new CommandRegistry(builtinCommands(), deps.extraCommands ?? []);
    this.ui = {
      requestApproval: (req, signal) => this.requestApproval(req, signal),
      notice: (level, message) => this.notice(level, message),
      confirmStopHook: (q) => this.confirmStopHook(q),
    };
  }

  // ───────────────────────────── ReplHost / ReplContext ─────────────────────────────

  get session(): KiroSession {
    return this.current;
  }

  get columns(): number {
    const cols = this.ctx.stdout.columns;
    return typeof cols === 'number' && cols > 0 ? cols : 80;
  }

  get lastAssistantText(): string | undefined {
    return this.lastText;
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.log;
  }

  get busy(): boolean {
    return this.turnActive;
  }

  get commandSignal(): AbortSignal | undefined {
    return this.cmdSignal;
  }

  /**
   * ReplContext.nextPressSignal: aborted by the next Ctrl+C after this call (one the reader reports
   * as `'interrupt'`, i.e. while no prompt reads a line, like the command signal), and by a fatal
   * signal; once aborted it stays so. It only signals: the press is handled as before (F0: an idle
   * session is never stopped). One asked for inside a slash command is dropped (never aborted)
   * when that command ends; outside a command it waits for the next press.
   */
  nextPressSignal(): AbortSignal {
    const ac = new AbortController();
    if (this.exits?.received || !this.reader) {
      if (this.exits?.received) ac.abort();
      return ac.signal;
    }
    const onPress = (): void => {
      this.dropPressWaiter(ac);
      ac.abort();
    };
    this.reader.on('interrupt', onPress);
    this.pressWaiters.set(ac, { depth: this.cmdDepth, off: () => this.reader.off('interrupt', onPress) });
    return ac.signal;
  }

  private dropPressWaiter(ac: AbortController): void {
    const w = this.pressWaiters.get(ac);
    if (!w) return;
    this.pressWaiters.delete(ac);
    w.off();
  }

  private wrapWidth(): number | undefined {
    const mode = this.opts.wrap ?? (this.settings.getBoolean('chat.disableWrap', false) ? 'never' : 'auto');
    if (mode === 'never') return undefined;
    if (mode === 'always') return this.columns;
    return this.ctx.stdout.isTTY ? this.columns : undefined;
  }

  /**
   * A fatal signal came in ({@link ExitSignals}), or kiro-claude dies of one the lifecycle
   * forwarder owns (claude/lifecycle.ts `dyingSignal()`, without the REPL's own handlers): from
   * then on the REPL prints nothing of its own (r5 P3/P4, g2/g3). What a command (a `/spec` flow
   * winding down as its sessions are closed) or a turn the close ended still reports is no longer
   * for the user, and may be wrong (a continuation start the signal cancelled is no Ctrl+C, a
   * restart refused as 'kiro-claude is exiting' no failure); no prompt is shown either (the line
   * reader is muted), a `!cmd` still running is not echoed (stdout nor stderr), no spinner is
   * started ({@link closeOnSignal} clears a running one) and headless prints nothing more. Only
   * the resume hint of a `/quit` whose close the signal came into is still printed ({@link run}).
   */
  private get silent(): boolean {
    return this.exits?.received !== undefined || dyingSignal() !== undefined;
  }

  write(text: string): void {
    if (this.silent) return;
    this.out(text);
  }

  private out(text: string): void {
    if (text === '') return;
    this.spinner.stop();
    this.ctx.stdout.write(text);
    this.renderer.track(text);
  }

  /** Raw output for the renderer (it tracks its own writes). */
  private rendererOut(text: string): void {
    this.spinner.stop();
    if (this.silent) return;
    this.ctx.stdout.write(text);
  }

  print(text: string): void {
    if (this.silent) return;
    this.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  async readAnswer(prompt: string = c.yellow('> ')): Promise<string | undefined> {
    this.spinner.stop();
    const r = await this.reader.read(prompt);
    this.renderer.freshLine();
    if (r.kind !== 'line') return undefined;
    return sanitizeUnicodeTags(r.text).trim();
  }

  async ask(question: string): Promise<string> {
    if (question) this.write(`${question}\n`);
    return (await this.readAnswer()) ?? '';
  }

  async confirm(question: string, defaultYes = false): Promise<boolean> {
    const q = /\[[yY]\/[nN]\]/.test(question) ? question : `${question} [y/n]`;
    this.write(`\n${q}\n\n`);
    const a = await this.readAnswer();
    if (a === undefined) return false;
    if (a === '') return defaultYes;
    return /^(y|yes)$/i.test(a);
  }

  async choose(question: string, options: string[]): Promise<number | undefined> {
    if (options.length === 0) return undefined;
    let s = `\n${question}\n`;
    options.forEach((o, i) => {
      s += `  ${String(i + 1).padStart(String(options.length).length)}. ${o}\n`;
    });
    this.write(`${s}\n`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = await this.readAnswer();
      if (a === undefined || a === '') return undefined;
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      const exact = options.findIndex((o) => o === a || o.split(/[ |]/)[0] === a);
      if (exact >= 0) return exact;
      this.write(`${c.red(`Invalid choice '${a}'. Enter a number between 1 and ${options.length}.`)}\n`);
    }
    return undefined;
  }

  replaceSession(next: KiroSession): void {
    this.current = next;
    this.usagePct = undefined;
  }

  baseSessionOptions(): ReplSessionOptions {
    const base: ReplSessionOptions = { ...this.opts.sessionOptions };
    delete base.resume;
    delete base.fork;
    base.agentName = this.current.agent.name;
    base.model = this.current.model;
    if (this.current.effort) base.effort = this.current.effort;
    else delete base.effort;
    return base;
  }

  createSession(opts: Partial<KiroSessionOptions>): Promise<KiroSession> {
    return this.opening(() =>
      this.deps.createSession({
        ...this.baseSessionOptions(),
        ...opts,
        ws: opts.ws ?? this.ws,
        origin: opts.origin ?? 'repl',
        interactive: opts.interactive ?? true,
        ui: opts.ui ?? this.ui,
      }),
    );
  }

  /**
   * Every session creation of this REPL (the chat, `/chat new|resume|load`, the spec runtime's
   * phase, continuation and task sessions, the forced-stop restart): it runs under the caller's
   * start signal (startSignal.ts; e.g. a command's Ctrl+C) and a fatal signal's ({@link ExitSignals}:
   * agentSpawn hooks still running are killed, nothing of the session stays), and what it opens is
   * remembered for {@link closeOnSignal}. Refused once a fatal signal came in.
   */
  private opening<T extends KiroSession>(create: () => Promise<T>): Promise<T> {
    if (this.exits?.received) return Promise.reject(new Error('kiro-claude is exiting'));
    const start = anySignal([currentStartSignal(), this.exits?.startSignal]);
    const p = withStartSignal(start.signal, create).then((s) => {
      this.remember(s);
      return s;
    });
    this.creating.add(p);
    const done = (): void => {
      this.creating.delete(p);
      start.dispose();
    };
    p.then(done, done);
    return p;
  }

  private remember(s: KiroSession): void {
    for (const r of this.opened) if (r.deref() === undefined) this.opened.delete(r);
    this.opened.add(new WeakRef(s));
  }

  async swapSession(next: KiroSession): Promise<void> {
    if (this.turnActive && next !== this.current) throw new Error(BUSY_MESSAGE);
    const old = this.current;
    this.replaceSession(next);
    // `/chat new|resume|load` inside a command: this is the user's chat now
    if (this.chatAtCommand) this.chatAtCommand = next;
    this.lastText = undefined;
    if (old && old !== next) {
      try {
        await old.close();
      } catch {
        // best effort
      }
    }
  }

  importSession(file: string): Promise<KiroSession> {
    if (!this.deps.importSessionExport) return Promise.reject(new Error('importing sessions is not available'));
    const base = this.baseSessionOptions();
    const importExport = this.deps.importSessionExport;
    return this.opening(() => importExport(file, { ...base, ws: this.ws, origin: 'repl', interactive: true, ui: this.ui }));
  }

  commands(): readonly SlashCommand[] {
    return this.registry.all() as SlashCommand[];
  }

  requestExit(code?: number): void {
    this.quitting = true;
    if (code !== undefined) this.exitCode = code;
  }

  forgetConversation(): void {
    this.lastText = undefined;
    this.log.length = 0;
  }

  async refreshUsage(): Promise<void> {
    if (!this.usageIndicator) return;
    // inside a command, a Ctrl+C during the refresh stops waiting for Claude Code's answer (K9):
    // the value is kept. Not a press before it, which the command signal also carries: one that
    // interrupted the command's turn, or one while Claude Code restarted, which changes nothing
    // (F0); the conversation the command leaves behind still gets its own value
    let press: AbortController | undefined;
    const onPress = (): void => press?.abort();
    if (this.cmdSignal) {
      press = new AbortController();
      this.reader.on('interrupt', onPress);
    }
    try {
      const u = await withTimeout(untilCancelled(press?.signal, () => this.current.usage()), USAGE_TIMEOUT_MS);
      if (u === CANCELLED) return;
      this.usagePct = u?.contextPercent;
    } finally {
      if (press) this.reader.off('interrupt', onPress);
    }
  }

  private childIo(): { inherit: boolean; out: (s: string) => void; err: (s: string) => void; cwd: string; env: NodeJS.ProcessEnv } {
    const inherit = this.terminal && !!this.ctx.stdout.isTTY && this.ctx.stdin === process.stdin;
    return {
      inherit,
      out: (s: string) => this.write(s),
      err: (s: string) => {
        // a `!cmd` still running at a fatal signal: its stderr is dropped like its stdout (write())
        if (this.silent) return;
        this.spinner.stop();
        this.ctx.stderr.write(s);
      },
      cwd: this.ws.cwd,
      env: this.ws.env,
    };
  }

  async openEditor(initial: string, opts: { suffix?: string; file?: string } = {}): Promise<EditorResult> {
    const io = this.childIo();
    if (io.inherit) this.reader.suspend();
    try {
      return await openEditor(initial, io, opts);
    } finally {
      if (io.inherit) this.reader.resume();
    }
  }

  async runBang(command: string): Promise<void> {
    const io = this.childIo();
    if (io.inherit) this.reader.suspend();
    try {
      const r = await runShellCommand(command, io);
      if (r.error) this.write(`\n${c.red(`Failed to execute command: ${r.error}`)}\n\n`);
      else if (r.code !== 0) this.write(`${c.yellow(`Self exited with status: ${exitStatusText(r.code, r.signal)}`)}\n`);
    } finally {
      if (io.inherit) this.reader.resume();
    }
  }

  // ───────────────────────────── SessionUI ─────────────────────────────

  requestApproval(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResponse> {
    const run = (): Promise<ApprovalResponse> => this.approvalFlow(req, signal);
    const p = this.approvalChain.then(run, run);
    this.approvalChain = p.catch(() => undefined);
    return p;
  }

  private bell(): void {
    if (!this.settings.getBoolean('chat.enableNotifications', false)) return;
    const term = this.ws.env.TERM ?? '';
    if (NOTIFY_TERMS.some((t) => term.startsWith(t))) this.write('\u0007');
  }

  private async approvalFlow(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResponse> {
    // a request queued behind an answer that quit the REPL is never shown
    if (signal.aborted || this.quitting) return { kind: 'cancelled' };
    this.spinner.stop();
    this.flushDeferred();
    this.renderer.showTool(req.call, false, true);
    this.bell();
    this.approving = true;
    try {
      for (;;) {
        // a command typed here (`/chat save-via-script …`, `!cmd`) may have outlived the request:
        // a Ctrl+C during it interrupted the turn, so the question is not asked again
        if (signal.aborted || this.quitting) return { kind: 'cancelled' };
        this.write(`\n${approvalQuestion()}\n\n`);
        let again = false;
        while (!again) {
          const r = await this.reader.read(this.promptString(), { signal, discardTypeahead: true });
          this.renderer.freshLine();
          if (r.kind === 'aborted') return { kind: 'cancelled' };
          if (r.kind !== 'line') {
            this.write('\n');
            return { kind: 'cancelled' };
          }
          const a = classifyApprovalInput(r.text);
          switch (a.kind) {
            case 'empty':
              continue;
            case 'command': {
              const res = await this.runSlash(a.text);
              if (res === 'quit' || this.quitting) {
                this.quitting = true;
                return { kind: 'cancelled' };
              }
              again = true;
              continue;
            }
            case 'shell':
              await this.runBang(a.command);
              again = true;
              continue;
            case 'prompt': {
              const text = this.expandAtPrompt(a.text) ?? a.text;
              this.redirectText = text;
              return { kind: 'redirect', text };
            }
            case 'answer':
              if (a.response.kind === 'redirect') this.redirectText = a.response.text;
              return a.response;
          }
        }
      }
    } finally {
      this.approving = false;
      this.flushDeferred();
      if (this.turnActive && !this.quitting && !this.silent) this.spinner.start();
    }
  }

  /** Render events held back while an approval prompt was open (in arrival order). */
  private flushDeferred(): void {
    const evs = this.deferred.splice(0);
    for (const ev of evs) this.renderer.handle(ev);
  }

  notice(level: 'info' | 'warn' | 'error', message: string): void {
    // a fatal signal: the sessions' notices (a SessionEnd hook during the grace) are not printed
    if (this.silent) return;
    // while a prompt (idle or approval) is shown, print above it so the input line survives
    if (!this.reader || !this.reader.reading) {
      this.spinner.stop();
      this.renderer.notice(level, message);
      return;
    }
    const styled = level === 'error' ? c.red(message) : level === 'warn' ? c.yellow(message) : c.gray(message);
    this.reader.printAbove(`${styled}\n`);
  }

  private async confirmStopHook(q: { hook: string; question: string; options: HookConfirmOption[] }): Promise<string | undefined> {
    const idx = await this.choose(q.question, q.options.map((o) => o.label));
    return idx === undefined ? undefined : q.options[idx]?.id;
  }

  // ───────────────────────────── prompt / input ─────────────────────────────

  promptString(): string {
    const s = this.current;
    return colorPrompt({
      agentName: s.agent.name,
      trustAll: s.trust.trustAll,
      tangent: s.tangent !== undefined,
      ...(this.usageIndicator && this.usagePct !== undefined ? { usagePercent: this.usagePct } : {}),
      planMode: s.planMode,
    });
  }

  private agentSkills(): SkillInfo[] {
    const a = this.current.agent;
    const uris = a.resources.filter((r): r is { kind: 'skill'; uri: string } => r.kind === 'skill').map((r) => r.uri);
    try {
      return discoverSkills(this.ws, uris, { includeDefaults: a.inheritDefaultResources });
    } catch {
      return [];
    }
  }

  private complete(line: string): [string[], string] {
    if (/^\/\S*$/.test(line)) {
      const names = new Set(this.registry.completionNames());
      for (const p of loadPrompts(this.ws)) names.add(`/${p.name}`);
      for (const s of this.agentSkills()) names.add(`/${s.name}`);
      const hits = [...names].filter((n) => n.startsWith(line)).sort();
      return [hits, line];
    }
    const m = /(?:^|\s)@([^\s"']*)$/.exec(line);
    if (m) {
      const partial = m[1]!;
      const dirPart = partial.includes('/') ? partial.slice(0, partial.lastIndexOf('/') + 1) : '';
      const base = partial.slice(dirPart.length);
      const dir = path.resolve(this.ws.cwd, dirPart || '.');
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      const hits = entries
        .filter((e) => e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.')))
        .map((e) => `@${dirPart}${e.name}${e.isDirectory() ? '/' : ''}`)
        .sort();
      if (!dirPart) for (const p of loadPrompts(this.ws)) if (p.name.startsWith(base)) hits.push(`@${p.name}`);
      return [hits, `@${partial}`];
    }
    return [[], line];
  }

  /** `@<prompt> args` ⇒ expanded prompt text, else undefined (01 §4.3 step 3). */
  private expandAtPrompt(text: string): string | undefined {
    const m = /^@([A-Za-z0-9_-]{1,50})(?=\s|$)/.exec(text);
    if (!m) return undefined;
    const p = findPrompt(loadPrompts(this.ws), m[1]!);
    if (!p) return undefined;
    const inv = parsePromptInvocation(text);
    const args = 'error' in inv ? [] : inv.args;
    return expandPrompt(p, args);
  }

  /** Process one input line (see module doc). */
  async submit(raw: string): Promise<void | 'quit'> {
    const text = sanitizeUnicodeTags(raw).trim();
    if (text === '') return;
    // Claude Code was stopped (second Ctrl+C): bring the session back first (not just to quit)
    if (this.stoppedSession && !this.isQuitCommand(text)) {
      // a Ctrl+C while the restarted session runs its agentSpawn hooks cancels its start (r5 P2)
      const press = new AbortController();
      const restarted = await withStartSignal(press.signal, () => this.restartStopped(press));
      if (restarted === 'failed') return 'quit';
      if (restarted === 'cancelled') return;
    }
    if (text.startsWith('/')) return this.runSlash(text);
    if (text.startsWith('!')) {
      await this.runBang(text.slice(1));
      return;
    }
    if (text.startsWith('@')) {
      const expanded = this.expandAtPrompt(text);
      if (expanded !== undefined) {
        if (expanded.trim() !== '') this.write(`\n${c.gray(expanded.trim())}\n\n`);
        return this.sendPrompt({ text: expanded });
      }
    }
    return this.sendPrompt({ text });
  }

  private isQuitCommand(text: string): boolean {
    const m = /^\/(\S+)\s*$/.exec(text);
    return !!m && this.registry.find(m[1]!)?.cmd.name === 'quit';
  }

  private async runSlash(text: string): Promise<void | 'quit'> {
    const m = /^\/(\S*)\s*([\s\S]*)$/.exec(text)!;
    const name = m[1]!;
    const raw = m[2]!.trim();
    if (name === '') {
      this.write(`${c.red('Unknown command: /')}\n`);
      return;
    }
    const entry = this.registry.find(name);
    if (entry) {
      // Free-text commands (/plan, /editor, /title, /chat new, /hooks run …) read `raw`; an
      // apostrophe ("I don't …") must not make them fail, so unbalanced quotes fall back to a
      // whitespace split (DECISION; Q's clap parser rejected such lines).
      const args = shlexSplit(raw) ?? raw.split(/\s+/).filter((w) => w !== '');
      if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
        this.write(formatCommandHelp(entry.cmd));
        return;
      }
      // Ctrl+C while the command runs outside a turn of its own (`/tangent merge`'s summary
      // turn, a Claude Code respawn) interrupts the session instead of waiting as type-ahead
      // for the next prompt (where it would count as an exit press); a turn the command starts
      // handles its own presses (runEvents). Any press aborts the command's signal.
      const cmdAbort = new AbortController();
      const outerSignal = this.cmdSignal;
      this.cmdSignal = cmdAbort.signal;
      this.cmdAborts.add(cmdAbort);
      if (this.cmdDepth++ === 0) this.chatAtCommand = this.current;
      const depth = this.cmdDepth;
      const onPress = (): void => cmdAbort.abort();
      const scope = this.interruptScope(undefined, () => !this.turnActive, { onlyWhenBusy: true });
      this.reader.on('interrupt', onPress);
      this.reader.on('interrupt', scope.listener);
      try {
        const r = await this.unlessAbandoned((entry.cmd as SlashCommand).run(args, raw, this), scope);
        if (r === ABANDONED) {
          this.write(`\n${c.red('Failed to execute command: Claude Code was stopped')}\n\n`);
          return this.quitting ? 'quit' : undefined;
        }
        if (r === 'quit') this.quitting = true;
        return this.quitting ? 'quit' : r;
      } catch (e) {
        this.write(`\n${c.red(`Failed to execute command: ${errText(e)}`)}\n\n`);
        return this.quitting ? 'quit' : undefined;
      } finally {
        scope.end();
        this.reader.off('interrupt', scope.listener);
        this.reader.off('interrupt', onPress);
        this.cmdSignal = outerSignal;
        this.cmdAborts.delete(cmdAbort);
        // next-press waiters asked for while this command ran end with it (no listener stays)
        for (const [ac, w] of [...this.pressWaiters]) if (w.depth >= depth) this.dropPressWaiter(ac);
        if (--this.cmdDepth === 0) this.chatAtCommand = undefined;
      }
    }
    // /<prompt> args (V3), prompts first (00 §2.2)
    const prompt = findPrompt(loadPrompts(this.ws), name);
    if (prompt) {
      const args = shlexSplit(raw) ?? raw.split(/\s+/).filter((w) => w !== '');
      const expanded = expandPrompt(prompt, args);
      if (expanded.trim() !== '') this.write(`\n${c.gray(expanded.trim())}\n\n`);
      return this.sendPrompt({ text: expanded });
    }
    // /<skill> args (inlined locally, 00 §2.2)
    const lname = name.toLowerCase();
    const skill = this.agentSkills().find((s) => s.name.toLowerCase() === lname || pluginSkillName(s.name) === lname);
    if (skill) {
      let body: string;
      try {
        body = expandSkillInvocation(skill, raw);
      } catch (e) {
        this.write(`\n${c.red(`Failed to execute command: ${errText(e)}`)}\n\n`);
        return;
      }
      return this.sendPrompt({ text: body });
    }
    // /<steering-name> (manual / auto steering)
    let steering;
    try {
      steering = loadSteering(this.ws).files.find(
        (f) => (f.inclusion === 'manual' || f.inclusion === 'auto') && f.name.toLowerCase() === lname,
      );
    } catch {
      steering = undefined;
    }
    if (steering) {
      // The steering file is injected through `steeringRefs`. The text keeps the reference as
      // `#steering:<name>` (same meaning for context/refs) because text starting with `/` would
      // reach Claude as one of ITS slash commands (`/cost`, `/init`, …, 00 §3.8) whenever the
      // session adds no context block in front of it (e.g. the file was already injected).
      const ref = /^[^\s"']+$/.test(steering.name) ? steering.name : `"${steering.name.replace(/"/g, '')}"`;
      return this.sendPrompt({ text: `#steering:${ref}${raw ? ` ${raw}` : ''}`, steeringRefs: [steering.name] });
    }
    this.write(`${c.red(`Unknown command: /${name}`)}\n`);
  }

  // ───────────────────────────── turns ─────────────────────────────

  /**
   * A turn is already running (a command typed at its `[y/n/t]` prompt wants another one):
   * refuse instead of nesting turns in one session; the tool stays pending.
   */
  private refuseNestedTurn(): TurnResult | undefined {
    if (!this.turnActive) return undefined;
    this.write(`${c.yellow(BUSY_MESSAGE)}\n`);
    return errorResult('a response is still running', false);
  }

  /**
   * Ctrl+C while a turn or slash command runs (see the module doc): the first press interrupts
   * the session; a second one runs `onSecond` and arms the forced stop. `active` limits the
   * scope (a command's scope ignores presses while a turn it started handles them).
   * `onlyWhenBusy` (a command's scope): the forced stop only closes a session that still has work
   * of its own in flight when the grace ends; an idle one (the command waits on another session)
   * is left open and the command is not abandoned (a later press may try again).
   */
  private interruptScope(onSecond?: () => void, active: () => boolean = () => true, o: { onlyWhenBusy?: boolean } = {}): InterruptScope {
    let presses = 0;
    let ended = false;
    let timer: NodeJS.Timeout | undefined;
    let resolveStopped!: () => void;
    const abandoned = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    }).then(
      () =>
        new Promise<typeof ABANDONED>((resolve) => {
          const t = setTimeout(() => resolve(ABANDONED), ABANDON_AFTER_CLOSE_MS);
          t.unref?.();
        }),
    );
    const listener = (): void => {
      if (ended || !active()) return;
      presses++;
      if (presses === 1) {
        void this.current.interrupt().catch(() => undefined);
        return;
      }
      onSecond?.();
      if (timer || this.stoppedSession) return;
      timer = setTimeout(() => {
        if (ended) return;
        // `busy` undefined (a session that does not report it): stop it, as before
        if (o.onlyWhenBusy && (!active() || this.current.busy === false)) {
          timer = undefined;
          return;
        }
        void this.forceStop().then(resolveStopped);
      }, FORCE_STOP_GRACE_MS);
      timer.unref?.();
    };
    return {
      listener,
      get presses() {
        return presses;
      },
      abandoned,
      end(): void {
        ended = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  /**
   * Stop Claude Code: close the current session (its child gets stdin EOF, SIGTERM after 2 s,
   * then SIGKILL; the stuck turn ends with it). The REPL keeps the closed session until the
   * next input re-creates it ({@link restartStopped}).
   */
  private forceStop(): Promise<void> {
    if (this.stoppedSession) return this.stoppedSession.closing;
    const session = this.current;
    this.notice('warn', 'Claude Code did not stop after the interrupt; stopping it.');
    const tangentParent = session.tangent?.parentId;
    const closing = withTimeout(session.close(), FORCE_CLOSE_TIMEOUT_MS).then(() => undefined);
    this.stoppedSession = { session, closing, ...(tangentParent ? { tangentParent, tangentId: session.id } : {}) };
    return closing;
  }

  /** `p`, or {@link ABANDONED} when a forced stop closed the session and `p` still did not settle. */
  private unlessAbandoned<T>(p: Promise<T>, scope: InterruptScope): Promise<T | typeof ABANDONED> {
    return Promise.race([p, scope.abandoned]);
  }

  /**
   * After a forced stop: re-create the stopped session under its id with `--resume` (agent,
   * model, effort, trust-all as they were; per-tool trust, context rules and plan mode come back
   * with the record), or a new one when closing dropped the record (no finished turn yet).
   * `'failed'` when that failed (the REPL then exits 1). A Ctrl+C while this runs (spawning
   * Claude Code takes a while) cancels the input it runs for (`'cancelled'`; the session is
   * still re-created) instead of waiting as type-ahead, where it would count as an exit press.
   * It also aborts `press`, the start signal the caller runs this under (startSignal.ts): while
   * the restarted session still runs its agentSpawn hooks (which may never end with timeout 0)
   * they are killed and the restart is cancelled; the stopped session stays the REPL's (the next
   * input restarts it again) and a notice says so (r5 P2).
   */
  private async restartStopped(press?: AbortController): Promise<'ok' | 'cancelled' | 'failed'> {
    const st = this.stoppedSession;
    if (!st) return 'ok';
    this.stoppedSession = undefined;
    let pressed = false;
    const onPress = (): void => {
      pressed = true;
      press?.abort();
    };
    this.reader.on('interrupt', onPress);
    try {
      await st.closing;
      // replaced meanwhile (e.g. a spec task session handed back): nothing to re-create
      if (this.current === st.session) {
        const old = st.session;
        let resumable = false;
        try {
          resumable = new SessionStore(sessionsDir(this.ws)).read(old.id) !== undefined;
        } catch {
          resumable = false;
        }
        // the trust as it was, never the launch `--trust-tools` again (applied over a record it
        // would re-trust a tool the user untrusted): all of it, session rules, revocations and
        // other agents' trust included, as `initialTrust` (also for a new conversation, whose
        // record closing dropped); trustAllTools / trustTools / untrustTools say the same to a
        // session that does not take initialTrust (test doubles)
        const revoked = resumable ? [] : (old.trust.revokedTools ?? []);
        let fresh: KiroSession | undefined;
        try {
          fresh = await this.createSession({
            initialTrust: { trust: old.trust, agent: old.agent.name },
            trustAllTools: old.trust.trustAll,
            trustTools: resumable ? [] : [...old.trust.allowedTools],
            ...(resumable ? { resume: { sessionId: old.id } } : {}),
          });
          if (revoked.length) fresh.untrustTools([...revoked]);
          // plan mode lived in the dropped record: the next prompt must not run with edits allowed
          if (!resumable && old.planMode) fresh.planMode = true;
          await fresh.start();
        } catch (e) {
          if (fresh) await fresh.close().catch(() => undefined);
          if (isSessionStartCancelled(e)) {
            // Ctrl+C during its agentSpawn hooks: nothing of the new session stays; the stopped one
            // is still the REPL's, so the next input tries again (or /quit leaves)
            this.stoppedSession = st;
            if (!this.exits?.received) this.write(`\n${c.yellow('Restart cancelled (Ctrl+C). Claude Code restarts with your next input.')}\n\n`);
            return 'cancelled';
          }
          this.write(`\n${c.red(`Failed to restart Claude Code: ${errText(e)}`)}\n\n`);
          this.requestExit(1);
          return 'failed';
        }
        this.replaceSession(fresh);
        if (this.chatAtCommand === st.session) this.chatAtCommand = fresh;
        // only when the record resumed is still the tangent the stop hit: a /tangent whose fork
        // was still starting fell back to its main record meanwhile (no tangent to announce)
        if (st.tangentParent && resumable && old.id === st.tangentId) {
          this.write(`${c.gray(`The tangent continues as its own conversation; the main one is saved as ${st.tangentParent} (/chat resume).`)}\n`);
        }
      }
    } finally {
      this.reader.off('interrupt', onPress);
    }
    if (pressed) {
      this.write('\n');
      return 'cancelled';
    }
    return 'ok';
  }

  /** Render a session event stream like a turn (Ctrl+C ⇒ interrupt, twice ⇒ stop Claude Code). */
  async runEvents(
    start: (signal: AbortSignal) => AsyncGenerator<SessionEvent, TurnResult>,
  ): Promise<{ result: TurnResult; seen: Set<SessionEvent['type']> }> {
    const busy = this.refuseNestedTurn();
    if (busy) return { result: busy, seen: new Set() };
    // SIGHUP / SIGTERM came in: the sessions are being closed; nothing more is sent (e.g. a spec
    // turn in a phase session whose start completed after the signal)
    if (this.exits?.received) return { result: errorResult('kiro-claude is exiting', true), seen: new Set() };
    // a turn run by a command typed at an approval prompt (whose own turn ended under it)
    const inApproval = this.approving;
    const ac = new AbortController();
    const scope = this.interruptScope(() => ac.abort());
    this.reader.on('interrupt', scope.listener);
    this.turnActive = true;
    this.renderer.beginTurn();
    this.spinner.start();
    const seen = new Set<SessionEvent['type']>();
    let result: TurnResult;
    try {
      const gen = start(ac.signal);
      for (;;) {
        const n = await this.unlessAbandoned(gen.next(), scope);
        if (n === ABANDONED) {
          void gen.return(errorResult('stopped', true)).catch(() => undefined);
          result = errorResult('Claude Code was stopped', true);
          break;
        }
        if (n.done) {
          result = n.value ?? errorResult('the turn ended without a result', scope.presses > 0);
          break;
        }
        seen.add(n.value.type);
        // held back while an approval prompt is shown; a turn run by a command typed at that
        // prompt renders as it comes (the prompt is not on screen while the command runs)
        if (this.approving && !inApproval) {
          this.deferred.push(n.value);
          continue;
        }
        this.spinner.stop();
        this.renderer.handle(n.value);
        if (n.value.type === 'tool_end' && !this.silent) this.spinner.start();
      }
    } catch (e) {
      result = errorResult(errText(e), scope.presses > 0 || ac.signal.aborted);
    } finally {
      scope.end();
      this.spinner.stop();
      this.reader.off('interrupt', scope.listener);
      this.turnActive = false;
      // an approval still open when the stream ended (withdrawn request): keep the order
      if (!this.approving) this.flushDeferred();
    }
    // ... and let it end first (it renders the held-back events): a command typed at it may
    // still run (a Ctrl+C during `/chat save-via-script …` interrupts the turn as well) and must
    // print before the turn's end and the next prompt. Not from a turn that command runs itself
    // (the approval waits for it).
    if (this.approving && !inApproval) await this.approvalChain;
    this.renderer.endTurn(result, { progName: this.progName });
    const text = this.renderer.assistantText || result.text || '';
    if (text.trim() !== '' && result.stopReason !== 'local_command') {
      this.lastText = text;
      this.log.push({ role: 'assistant', text, at: new Date().toISOString() });
    }
    if (result.authError) {
      this.exitCode = 1;
      this.quitting = true;
    }
    return { result, seen };
  }

  /** ReplHost.runTurn: one user turn with full rendering (+ the redirect follow-up). */
  async runTurn(input: PromptInput): Promise<TurnResult> {
    const busy = this.refuseNestedTurn();
    if (busy) return busy;
    let next: PromptInput | undefined = input;
    let result!: TurnResult;
    for (let guard = 0; next && guard < 16; guard++) {
      const cur: PromptInput = next;
      next = undefined;
      this.redirectText = undefined;
      this.log.push({ role: 'user', text: cur.text, at: new Date().toISOString() });
      ({ result } = await this.runEvents((signal) => this.current.prompt(cur, { signal })));
      if (this.quitting || this.stoppedSession) break;
      const redirect = this.redirectText as string | undefined;
      this.redirectText = undefined;
      if (redirect !== undefined) {
        const turns = this.current.record?.turns ?? [];
        const last = turns[turns.length - 1];
        if (!previewMatches(last?.preview, redirect)) next = { text: redirect };
      }
    }
    return result;
  }

  /** A user turn from the main prompt, with the follow-ups (plan handoff, usage, bell). */
  async sendPrompt(input: PromptInput): Promise<void | 'quit'> {
    const nested = this.turnActive;
    const result = await this.runTurn(input);
    if (this.quitting) return 'quit';
    if (nested) return; // refused (see refuseNestedTurn)
    await this.afterTurn(result);
    return this.quitting ? 'quit' : undefined;
  }

  private async afterTurn(result: TurnResult): Promise<void> {
    await this.refreshUsage();
    if (this.usageIndicator && this.usagePct !== undefined && this.usagePct >= 90) {
      this.write(
        `${c.yellow(c.bold('\n⚠️ This conversation is getting lengthy.\n'))}${c.yellow('To ensure continued smooth operation, please use /compact to summarize the conversation.')}\n\n`,
      );
    }
    this.bell();
    if (
      this.current.planMode &&
      !result.isError &&
      result.stopReason === 'end_turn' &&
      looksLikePlan(result.text || this.renderer.assistantText)
    ) {
      const yes = await this.confirm(PLAN_EXECUTE_QUESTION);
      if (yes) {
        this.current.planMode = false;
        this.write(`${c.cyan('Exited plan mode.')}\n\n`);
        await this.sendPrompt({ text: PLAN_EXECUTE_PROMPT });
      }
    }
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /**
   * The user's chat: the current session, unless a running command made one of its own sessions
   * current (`/spec` phase and task sessions, origin `spec`): then the session that command
   * started from ({@link chatAtCommand}). A continuation the flow handed over (origin `repl`) is the
   * chat as soon as it is current.
   */
  private userChat(): KiroSession | undefined {
    const cur = this.current as KiroSession | undefined;
    const chat = this.chatAtCommand;
    if (chat && cur && cur !== chat && cur.record?.origin === 'spec') return chat;
    return cur;
  }

  /** Sessions this REPL opened that may still be open (closing a closed one is a no-op). */
  private openedSessions(): KiroSession[] {
    const out = new Set<KiroSession>();
    for (const r of this.opened) {
      const s = r.deref();
      if (s) out.add(s);
      else this.opened.delete(r);
    }
    const cur = this.current as KiroSession | undefined;
    if (cur) out.add(cur);
    if (this.stoppedSession) out.add(this.stoppedSession.session);
    return [...out];
  }

  /**
   * SIGHUP / SIGTERM, or SIGINT while the chat starts or during the final close ({@link ExitSignals},
   * bounded by its grace; r5 P3, #6; from then on the REPL is {@link silent}): stop what runs (the running
   * commands' signals and next-press waiters are aborted: `/spec run` stops, hook commands are
   * killed; no session is created and no turn sent from now on), then close every session this REPL
   * opened that is still open: the user's chat first ({@link userChat}), once it is closed the
   * others together (`/spec` phase and task sessions, a forced-stop session still closing; sessions
   * still being created first settle: one whose agentSpawn hooks ran is cancelled by the signal),
   * each with its SessionEnd hooks, record and lock. Then the user's record is made the newest of them
   * ({@link makeNewest}): a phase record closed after it would otherwise be what `chat --resume`
   * opens.
   */
  private async closeOnSignal(): Promise<void> {
    // silent from now on: a spinner animating at the signal (a turn whose Claude is slow to stop)
    // is cleared now, not left drawing frames for the whole grace
    this.spinner.stop();
    for (const ac of [...this.cmdAborts]) ac.abort();
    for (const ac of [...this.pressWaiters.keys()]) {
      this.dropPressWaiter(ac);
      ac.abort();
    }
    const user = this.userChat();
    const closeOf = (s: KiroSession): Promise<void> => s.close().catch(() => undefined);
    // the user's chat first, on its own: its SessionEnd hooks, record and lock come before the rest
    // (an idle chat closes quickly; the grace is shared)
    if (user) await closeOf(user);
    await Promise.allSettled([...this.creating]);
    const others = this.openedSessions().filter((s) => s !== user);
    await Promise.all(others.map(closeOf));
    if (user && others.length > 0) this.makeNewest(user, others);
  }

  /**
   * After {@link closeOnSignal}: when a record of `others` (closed after the user's chat, so saved
   * later) is newer than the chat's, save the chat's record again as the newest, so `chat --resume`
   * (the newest record) reaches the user's conversation. Only a record nobody holds (no lock file:
   * the chat's close finished) is rewritten, unchanged but for `updatedAt`, and only under its
   * lock, taken for the read and the write (r5 g1): another kiro-claude opening the record meanwhile
   * either took the lock first (nothing is rewritten here) or is refused for those milliseconds
   * ('Session is active in another process'), so its writes are never overwritten with our copy.
   */
  private makeNewest(user: KiroSession, others: readonly KiroSession[]): void {
    let lock: { release(): void } | undefined;
    try {
      const store = new SessionStore(sessionsDir(this.ws));
      // a tangent's main conversation (chat --resume never opens a tangent)
      const id = user.tangent?.parentId ?? (user.resumeId ? user.resumeId() : user.id);
      if (!id) return;
      // a lock on disk is never taken over here: it may be ours (a close still running) or another process's
      if (!store.read(id) || store.lockInfo(id)) return;
      lock = store.acquireLock(id);
      const rec = store.read(id);
      if (!rec) return;
      let newest = 0;
      for (const o of others) {
        const r = o.id === id ? undefined : store.read(o.id);
        if (r) newest = Math.max(newest, Date.parse(r.updatedAt) || 0);
      }
      if ((Date.parse(rec.updatedAt) || 0) > newest) return;
      rec.updatedAt = new Date(Math.max(Date.now(), newest + 1)).toISOString();
      store.write(rec);
    } catch {
      // best effort: the records are all saved; only which one `chat --resume` opens is at stake
      // (the lock is held by another process now: it owns the record)
    } finally {
      lock?.release();
    }
  }

  private async modelDisplayName(): Promise<string> {
    const id = this.current.model || 'auto';
    const list = await withTimeout(this.current.listModels(), USAGE_TIMEOUT_MS);
    const e = list ? findModelEntry(list, id) : undefined;
    if (id === 'auto') return 'auto';
    return e ? `${e.displayName} (${e.kiroId})` : id;
  }

  private setupReader(): void {
    let history: string[] = [];
    let onHistory: ((e: string) => void) | undefined;
    if (this.terminal) {
      const file = historyFilePath(this.ws, this.settings.getString('chat.historyMode'), this.current.id);
      history = loadHistoryFile(file);
      onHistory = (e: string) => appendHistoryFile(file, e);
    }
    this.reader = new LineReader({
      input: this.ctx.stdin,
      output: this.ctx.stdout,
      terminal: this.terminal,
      history,
      ...(onHistory ? { onHistory } : {}),
      completer: (line: string) => this.complete(line),
      muted: () => this.silent,
    });
    this.reader.on('shift-tab', () => {
      this.current.planMode = !this.current.planMode;
      this.reader.updatePrompt(this.promptString());
    });
    if (this.deps.installSignalHandlers) {
      this.sigHandler = () => this.reader.ctrlC();
      process.on('SIGINT', this.sigHandler);
    }
  }

  private async loop(): Promise<void> {
    let ctrlC = false;
    const initial = this.opts.initialInput;
    if (initial !== undefined && initial.trim() !== '') {
      if ((await this.submit(initial)) === 'quit') return;
    }
    while (!this.quitting) {
      // SIGHUP / SIGTERM: the sessions are being closed; no prompt and no input from now on (input
      // typed during the grace is neither sent nor run as a command, r5 g2)
      if (this.exits?.received) return;
      const r = await this.reader.readInput(this.promptString(), { history: true });
      if (this.exits?.received) return;
      this.renderer.freshLine();
      if (r.kind === 'eof') return;
      if (r.kind === 'aborted') continue;
      if (r.kind === 'interrupt' || r.kind === 'ctrl-d') {
        if (ctrlC) return;
        ctrlC = true;
        this.write(exitHint());
        continue;
      }
      ctrlC = false;
      if ((await this.submit(r.text)) === 'quit') return;
    }
  }

  async run(): Promise<number> {
    // SIGHUP / SIGTERM, and Ctrl+C until the prompt is up and after /quit: close the session, then
    // die of the signal (ExitSignals, r4 #4, r5 #6)
    const exits = this.deps.installSignalHandlers && process.platform !== 'win32'
      ? new ExitSignals(() => this.closeOnSignal(), [this.ctx.stdin, this.ctx.stdout, this.ctx.stderr])
      : undefined;
    this.exits = exits;
    try {
      // under the signals' start signal (opening): a signal while its agentSpawn hooks run cancels it
      this.current = await this.opening(() =>
        this.deps.createSession({
          ...this.opts.sessionOptions,
          ws: this.ws,
          origin: 'repl',
          interactive: true,
          ui: this.ui,
        }),
      );
      await this.current.start();
    } catch (e) {
      if (exits?.received) return exits.die();
      exits?.dispose();
      this.write(`${c.red(errText(e))}\n`);
      // a half-started session may own a claude child and the session lock
      if (this.current) await this.current.close().catch(() => undefined);
      return 1;
    }
    if (exits?.received) return exits.die();
    exits?.ready();
    this.setupReader();
    try {
      const rnd = this.deps.random ?? Math.random;
      const tip = TIPS[Math.floor(rnd() * TIPS.length) % TIPS.length];
      this.write(
        formatGreeting({
          // a --resume that found nothing starts a fresh session (the session says so)
          resumed: this.opts.sessionOptions.resume !== undefined && ((this.current.record?.messageCount ?? 0) > 0 || (this.current.record?.turns?.length ?? 0) > 0),
          columns: this.columns,
          greetingEnabled: this.settings.getBoolean('chat.greeting.enabled', true),
          promptHints: this.settings.getBoolean('chat.enablePromptHints', true),
          ...(tip ? { tip } : {}),
          trustAll: this.current.trust.trustAll,
          modelName: await this.modelDisplayName(),
          ...(this.current.agent.welcomeMessage ? { welcomeMessage: this.current.agent.welcomeMessage } : {}),
          ascii: this.ws.env.KIRO_ASCII_MODE === '1' || !this.settings.getBoolean('chat.allowAsciiArt', true),
        }),
      );
      await this.refreshUsage();
      await this.loop();
    } catch (e) {
      this.write(`\n${c.red(`Error: ${errText(e)}`)}\n`);
      if (this.exitCode === 0) this.exitCode = 1;
    } finally {
      this.spinner.stop();
      if (this.sigHandler) process.off('SIGINT', this.sigHandler);
      // the final close: a Ctrl+C (line mode, `kill -INT`) now closes first like SIGTERM, then the
      // signal ends the process (ExitSignals.closing, r5 #6)
      exits?.closing();
      // a SIGHUP / SIGTERM is closing the session: the signal ends the process (the terminal may be gone)
      if (exits?.received) await exits.die();
      const s = this.current;
      try {
        await s.close();
      } catch {
        // best effort
      }
      // the record close() kept, never one it dropped (r4 #5/#9): an untouched spec-phase copy
      // names the record holding its conversation, a chat that never had a message none. The user
      // quit before any signal: the hint is printed even when one came in during this close.
      const id = s.resumeId ? s.resumeId() : s.id;
      this.out(id !== undefined ? `\n${resumeHint(this.progName, id)}\n` : '\n');
      exits?.dispose();
      this.reader.close();
    }
    return this.exitCode;
  }
}

/** How long a fatal signal waits for the sessions to close (repl/exitSignals.ts). */
export { SIGNAL_CLOSE_GRACE_MS } from './exitSignals.js';

/** Run the REPL with injected dependencies (repl/repl.ts wires the real ones). */
export async function runReplWith(opts: RunReplOptions, deps: ReplDeps): Promise<number> {
  return new Repl(opts, deps).run();
}
