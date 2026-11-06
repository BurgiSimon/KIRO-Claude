/**
 * The interactive chat REPL (Classic-style line REPL with Kiro command names; 01 §4–§5,
 * 06 §2 / §5 / §6, 00 §2.3–§2.5).
 *
 * Flow: create + start the KiroSession (`origin: 'repl'`, interactive, this REPL as its
 * SessionUI) → greeting → optional initial input → read/dispatch loop → on exit print
 * `To resume this session: <prog> chat --resume-id <id>` and close the session (exit 0;
 * 1 when the session could not start or Claude reported an auth failure).
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
 * Ctrl+C during a turn ⇒ `session.interrupt()`; a second Ctrl+C aborts the prompt's signal.
 * At the idle prompt the first Ctrl+C / Ctrl+D prints Q's hint, the second exits.
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
import { loadPrompts, findPrompt, expandPrompt, parsePromptInvocation } from '../config/prompts.js';
import { discoverSkills, expandSkillInvocation, pluginSkillName } from '../config/skills.js';
import { loadSteering } from '../config/steering.js';
import { findModelEntry } from '../models/models.js';
import { previewText } from '../session/store.js';
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
import { builtinCommands } from './commands/index.js';
import { PLAN_EXECUTE_PROMPT, PLAN_EXECUTE_QUESTION, looksLikePlan } from './commands/plan.js';
import { openEditor, runShellCommand } from './external.js';
import { LineReader, appendHistoryFile, historyFilePath, loadHistoryFile, sanitizeUnicodeTags } from './input.js';
import { BUSY_MESSAGE, TIPS, approvalQuestion, colorPrompt, exitHint, formatGreeting, resumeHint } from './prompt.js';
import { CommandRegistry, formatCommandHelp } from './registry.js';
import { Spinner, TurnRenderer } from './render.js';
import type { EditorResult, ReplContext, ReplDeps, ReplSessionOptions, RunReplOptions, TranscriptEntry } from './types.js';

const USAGE_TIMEOUT_MS = 2000;
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

  private wrapWidth(): number | undefined {
    const mode = this.opts.wrap ?? (this.settings.getBoolean('chat.disableWrap', false) ? 'never' : 'auto');
    if (mode === 'never') return undefined;
    if (mode === 'always') return this.columns;
    return this.ctx.stdout.isTTY ? this.columns : undefined;
  }

  write(text: string): void {
    if (text === '') return;
    this.spinner.stop();
    this.ctx.stdout.write(text);
    this.renderer.track(text);
  }

  /** Raw output for the renderer (it tracks its own writes). */
  private rendererOut(text: string): void {
    this.spinner.stop();
    this.ctx.stdout.write(text);
  }

  print(text: string): void {
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
    return this.deps.createSession({
      ...this.baseSessionOptions(),
      ...opts,
      ws: opts.ws ?? this.ws,
      origin: opts.origin ?? 'repl',
      interactive: opts.interactive ?? true,
      ui: opts.ui ?? this.ui,
    });
  }

  async swapSession(next: KiroSession): Promise<void> {
    if (this.turnActive && next !== this.current) throw new Error(BUSY_MESSAGE);
    const old = this.current;
    this.replaceSession(next);
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
    return this.deps.importSessionExport(file, { ...base, ws: this.ws, origin: 'repl', interactive: true, ui: this.ui });
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
    const u = await withTimeout(this.current.usage(), USAGE_TIMEOUT_MS);
    this.usagePct = u?.contextPercent;
  }

  private childIo(): { inherit: boolean; out: (s: string) => void; err: (s: string) => void; cwd: string; env: NodeJS.ProcessEnv } {
    const inherit = this.terminal && !!this.ctx.stdout.isTTY && this.ctx.stdin === process.stdin;
    return {
      inherit,
      out: (s: string) => this.write(s),
      err: (s: string) => {
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
      if (this.turnActive && !this.quitting) this.spinner.start();
    }
  }

  /** Render events held back while an approval prompt was open (in arrival order). */
  private flushDeferred(): void {
    const evs = this.deferred.splice(0);
    for (const ev of evs) this.renderer.handle(ev);
  }

  notice(level: 'info' | 'warn' | 'error', message: string): void {
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
      try {
        const r = await (entry.cmd as SlashCommand).run(args, raw, this);
        if (r === 'quit') this.quitting = true;
        return this.quitting ? 'quit' : r;
      } catch (e) {
        this.write(`\n${c.red(`Failed to execute command: ${errText(e)}`)}\n\n`);
        return this.quitting ? 'quit' : undefined;
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

  /** Render a session event stream like a turn (Ctrl+C ⇒ interrupt, twice ⇒ abort). */
  async runEvents(
    start: (signal: AbortSignal) => AsyncGenerator<SessionEvent, TurnResult>,
  ): Promise<{ result: TurnResult; seen: Set<SessionEvent['type']> }> {
    const busy = this.refuseNestedTurn();
    if (busy) return { result: busy, seen: new Set() };
    const ac = new AbortController();
    let interrupts = 0;
    const onInterrupt = (): void => {
      interrupts++;
      if (interrupts === 1) void this.current.interrupt().catch(() => undefined);
      else ac.abort();
    };
    this.reader.on('interrupt', onInterrupt);
    this.turnActive = true;
    this.renderer.beginTurn();
    this.spinner.start();
    const seen = new Set<SessionEvent['type']>();
    let result: TurnResult;
    try {
      const gen = start(ac.signal);
      for (;;) {
        const n = await gen.next();
        if (n.done) {
          result = n.value ?? errorResult('the turn ended without a result', interrupts > 0);
          break;
        }
        seen.add(n.value.type);
        if (this.approving) {
          this.deferred.push(n.value);
          continue;
        }
        this.spinner.stop();
        this.renderer.handle(n.value);
        if (n.value.type === 'tool_end') this.spinner.start();
      }
    } catch (e) {
      result = errorResult(errText(e), interrupts > 0 || ac.signal.aborted);
    } finally {
      this.spinner.stop();
      this.reader.off('interrupt', onInterrupt);
      this.turnActive = false;
      // an approval still open when the stream ended (withdrawn request): keep the order
      if (!this.approving) this.flushDeferred();
    }
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
      if (this.quitting) break;
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
      const r = await this.reader.readInput(this.promptString(), { history: true });
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
    try {
      this.current = await this.deps.createSession({
        ...this.opts.sessionOptions,
        ws: this.ws,
        origin: 'repl',
        interactive: true,
        ui: this.ui,
      });
      await this.current.start();
    } catch (e) {
      this.write(`${c.red(errText(e))}\n`);
      // a half-started session may own a claude child and the session lock
      if (this.current) await this.current.close().catch(() => undefined);
      return 1;
    }
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
      this.write(`\n${resumeHint(this.progName, this.current.id)}\n`);
      try {
        await this.current.close();
      } catch {
        // best effort
      }
      this.reader.close();
    }
    return this.exitCode;
  }
}

/** Run the REPL with injected dependencies (repl/repl.ts wires the real ones). */
export async function runReplWith(opts: RunReplOptions, deps: ReplDeps): Promise<number> {
  return new Repl(opts, deps).run();
}
