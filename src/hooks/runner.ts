/**
 * The Kiro hook runner: executes every Kiro hook itself (00 §1 invariant 4, §2.4; 02 §7;
 * 03 §2.5; 06 §3).
 *
 * Execution of one command hook (06 §3.3):
 *  - `bash -c <command>` (util/process.runShell; `opts.shell` overrides), stdin = the payload JSON
 *    on one line without a trailing newline (payload.ts), env = `ws.env` (+ `USER_PROMPT`).
 *  - cwd: V3 hooks run "in project root" (`ws.workspaceRoot`, 02 §7.2); V2 / Q hooks inherit the
 *    process cwd (`ws.cwd`, 02 §7.1). The payload `cwd` is always `ws.cwd`.
 *  - `USER_PROMPT` (≤ 4096 UTF-8 bytes, control characters except `\n\r\t` removed) is set exactly
 *    when the payload carries `prompt`: UserPromptSubmit, and V2 agentSpawn when a prompt is
 *    pending (Q passes it, 02 §7.1).
 *  - Timeout `timeoutMs` (0 = none): the whole process group is SIGKILLed (grandchildren too) and
 *    the run is a failure (`command timed out after N ms`) that never blocks. Spawn failures:
 *    `failed to execute command: <e>`. A child killed by a signal has exit code -1.
 *  - Output: Q keeps ONE stream — stdout on exit 0, stderr otherwise — truncated to
 *    `maxOutputBytes` on a character boundary plus ` ... truncated` when something was cut.
 *  - File triggers: `{{filePath}}` in the command is replaced by the absolute path quoted for the
 *    shell context it appears in ({@link substituteFilePath}): bare ⇒ `shellQuote`, inside `"…"`
 *    ⇒ `\`-escaped, inside `'…'` ⇒ `'\''` splices — so the IDE idiom `eslint "{{filePath}}"`
 *    works for any path (cmd / PowerShell shells get their own quoting). In agent prompts the
 *    raw path is substituted.
 *  - Limits: a non-finite or negative `maxOutputBytes` falls back to 10240 and a non-finite or
 *    negative `timeoutMs` to the dialect default (V2 30000, V3 60000; `Infinity` = none), so a
 *    malformed hook can neither swallow its output nor capture without bound.
 *  - Agent actions (`type: "agent"`) are never executed: their prompts are returned for the
 *    session to inject (per trigger, see below).
 *
 * Running a trigger (06 §3.4, 00 §2.4 / C9): enabled hooks of the trigger whose matcher matches
 * (tool triggers: matcher.ts `hookMatchesCall`; file triggers: `hookMatchesFile`; other triggers
 * ignore matchers) all start concurrently; results are aggregated in definition order, so the
 * first blocking hook in definition order wins and joined texts are deterministic (`\n\n`).
 *
 * Cache (06 §3.5): only exit-0 results are cached. SessionStart results are cached for this
 * runner's lifetime (keyed by hook identity — Q runs agentSpawn once; failed ones re-run).
 * Other triggers: hooks with `cacheTtlSec > 0` (V2 `cache_ttl_seconds`) are cached for that many
 * seconds keyed by (hook identity, payload) — DEVIATION from Q, which keys by hook only (a cached
 * PreToolUse result must not leak to a different tool call). `clearCache()` = Q `/clear`.
 *
 * Exit-code semantics per trigger (02 §7.1, §7.6; 03 §2.4–2.5; 00 §2.4):
 *
 * | Trigger | exit 0 | exit 2 | other non-zero / timeout | agent action |
 * |---|---|---|---|---|
 * | SessionStart | stdout ⇒ `outputs` | warning | warning | `agentPrompts` |
 * | UserPromptSubmit | stdout ⇒ `outputs` | warning; V3: note (output + exit code) ⇒ `outputs` | same as exit 2 | `agentPrompts` |
 * | PreToolUse | — | **block**, `blockReason` = stderr; warning | warning, never blocks | `additionalContext` |
 * | PostToolUse | — | warning | warning | `additionalContext` |
 * | Stop (V2) | — | warning | warning | n/a |
 * | Stop (V3) | stdout `{"decision":"block","reason"}` ⇒ continue | warning, finished | exit 1 ⇒ continue; others warning | continue with prompt |
 * | SessionEnd | — | warning | warning (5 s cap) | ignored |
 * | PostFile* | — | warning | warning | `File <p> was saved. <prompt>` (suppressed at hookDepth ≥ 1) |
 * | PreTaskExec | — | **block** | warning | `agentPrompts` |
 * | PostTaskExec | — | warning | warning | `agentPrompts` |
 *
 * Warnings use Q's strings (format.ts): `✗ agentSpawn "<cmd>" failed with exit code: N, stderr: …)`
 * (printed for exit 2 too) and `✗ <cmd> failed after <s.ss> s: <err>`. Aborted runs (ctx.signal)
 * produce no warning.
 *
 * Stop continuation (V3): the reason (or `Continue working; the stop hook requested more work.`)
 * becomes `continueWith`; several requests are joined with `\n\n` (duplicates dropped). At most
 * {@link MAX_HOOK_CONTINUATIONS} consecutive continuations (`ctx.hookDrivenContinuations`); beyond
 * that a warning replaces the continuation. Hooks still run.
 *
 * Stop `confirm` (02 §7.6): such a hook is not run directly. Its `confirmCommand` (optional) runs
 * first with the Stop payload: stdout `{"skip":true}` ⇒ skipped this turn; `{"question","options"}`
 * ⇒ replaces the static ones; non-zero / timeout / invalid JSON ⇒ static fallback. The result's
 * `confirm` asks the UI for a choice; the session reports it with {@link HookRunner.resolveStopConfirm}
 * (an option with `run: true` runs the command with V3 Stop semantics). Several confirm hooks are
 * queued in definition order (each resolve returns the next). A confirm without options gets
 * `Yes` (run) / `No` (DECISION).
 *
 * Library code: never prints (util/log for debug).
 */

import * as path from 'node:path';
import type {
  AgentSpawnHookResult,
  HookConfirmOption,
  HookRunContext,
  HookRunnerLike,
  HookTrigger,
  HookWarning,
  KiroHook,
  KiroToolCall,
  PostToolHookResult,
  PreToolHookResult,
  StopHookResult,
  ToolOutcome,
  UserPromptHookResult,
} from '../types.js';
import { runShell } from '../util/process.js';
import { shellQuote } from '../util/shlex.js';
import { byteLength, sanitizeControlChars, truncateBytes } from '../util/text.js';
import { log } from '../util/log.js';
import {
  DEFAULT_STOP_CONTINUE_TEXT,
  MAX_HOOK_CONTINUATIONS,
  TRUNCATED_SUFFIX,
  formatContinuationLimitWarning,
  formatFileHookContext,
  formatHookWarning,
  formatPromptHookErrorNote,
  formatPromptHookExitNote,
  hookSpawnError,
  hookTimeoutError,
} from './format.js';
import { hookMatchesCall, hookMatchesFile } from './matcher.js';
import { buildPayload, hookEventName, type HookEvent, type HookTaskInfo } from './payload.js';

/** Max bytes of `USER_PROMPT` (06 §3.3). */
export const USER_PROMPT_MAX_BYTES = 4096;

/** SessionEnd hooks are best effort with a 5 s cap (03 §2.5). */
export const SESSION_END_CAP_MS = 5000;

/** stdout kept for JSON decisions (Stop, confirmCommand) beyond `maxOutputBytes`. */
const DECISION_CAPTURE_BYTES = 64 * 1024;

/** File-trigger command/prompt template (03 §2.2, KD:ide/whats-new-v1/hooks). */
export const FILE_PATH_TEMPLATE = '{{filePath}}';

/** Fallback output cap for malformed hooks (02 §7.1 / App. B default). */
const DEFAULT_MAX_OUTPUT_BYTES = 10_240;
/** Fallback timeouts for malformed hooks: V2 `timeout_ms` 30000, V3 `timeout` 60 s (02 §7). */
const DEFAULT_TIMEOUT_MS = { v2: 30_000, v3: 60_000 } as const;

/** Effective output cap: finite, non-negative integer, else the default. */
export function effectiveMaxOutputBytes(hook: Pick<KiroHook, 'maxOutputBytes'>): number {
  const m = hook.maxOutputBytes;
  return typeof m === 'number' && Number.isFinite(m) && m >= 0 ? Math.floor(m) : DEFAULT_MAX_OUTPUT_BYTES;
}

/** Effective timeout (0 = none): `Infinity` ⇒ 0; NaN / negative ⇒ the dialect default. */
export function effectiveTimeoutMs(hook: Pick<KiroHook, 'timeoutMs' | 'dialect'>): number {
  const t = hook.timeoutMs;
  if (t === Number.POSITIVE_INFINITY) return 0;
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : DEFAULT_TIMEOUT_MS[hook.dialect];
}

/** How `{{filePath}}` is quoted: POSIX shells, Windows `cmd`, PowerShell. */
export type FilePathQuoteStyle = 'posix' | 'cmd' | 'pwsh';

/** Quote style for the shell the runner uses (`opts.shell` override, else the platform shell). */
export function quoteStyleForShell(shell: string | undefined, platform: NodeJS.Platform = process.platform): FilePathQuoteStyle {
  if (shell) {
    const base = shell.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
    if (base === 'cmd') return 'cmd';
    if (base === 'powershell' || base === 'pwsh') return 'pwsh';
    return 'posix';
  }
  return platform === 'win32' ? 'cmd' : 'posix';
}

function quoteInContext(p: string, ctx: 'none' | 'single' | 'double', style: FilePathQuoteStyle): string {
  if (style === 'posix') {
    if (ctx === 'single') return p.replace(/'/g, `'\\''`);
    if (ctx === 'double') return p.replace(/[\\"$`]/g, '\\$&');
    return shellQuote(p);
  }
  if (style === 'pwsh') {
    if (ctx === 'single') return p.replace(/'/g, "''");
    if (ctx === 'double') return p.replace(/[`"$]/g, '`$&');
    return `'${p.replace(/'/g, "''")}'`;
  }
  // cmd: no escaping inside "…"; bare paths with separators/metachars get double quotes.
  if (ctx !== 'none') return p;
  return /[\s&|<>^()%!,;=]/.test(p) ? `"${p}"` : p;
}

/**
 * Replace every `{{filePath}}` in `command` with `filePath`, quoted for the quoting context the
 * placeholder sits in (03 §2.5 "shell-quoted"): outside quotes the whole path is quoted; inside
 * a quoted string only the characters special there are escaped, so `"{{filePath}}"`,
 * `'{{filePath}}'` and bare `{{filePath}}` all yield exactly one argument equal to the path.
 * The quote state is tracked with POSIX rules (`\` escapes outside and inside `"…"`, nothing is
 * special inside `'…'`); `cmd` only tracks `"…"`, PowerShell `'…'`/`"…"` with `` ` `` escapes.
 */
export function substituteFilePath(command: string, filePath: string, style: FilePathQuoteStyle = 'posix'): string {
  if (!command.includes(FILE_PATH_TEMPLATE)) return command;
  let out = '';
  let ctx: 'none' | 'single' | 'double' = 'none';
  const esc = style === 'posix' ? '\\' : style === 'pwsh' ? '`' : undefined;
  let i = 0;
  while (i < command.length) {
    if (command.startsWith(FILE_PATH_TEMPLATE, i)) {
      out += quoteInContext(filePath, ctx, style);
      i += FILE_PATH_TEMPLATE.length;
      continue;
    }
    const ch = command[i]!;
    if (ctx === 'single') {
      if (ch === "'") ctx = 'none';
    } else if (esc !== undefined && ch === esc && i + 1 < command.length && !command.startsWith(FILE_PATH_TEMPLATE, i + 1)) {
      out += ch + command[i + 1]!;
      i += 2;
      continue;
    } else if (ctx === 'double') {
      if (ch === '"') ctx = 'none';
    } else if (ch === '"') {
      ctx = 'double';
    } else if (ch === "'" && style !== 'cmd') {
      ctx = 'single';
    }
    out += ch;
    i++;
  }
  return out;
}

/** Q `USER_PROMPT` sanitizer: truncate to 4096 bytes, drop control chars except `\n\r\t`. */
export function sanitizeUserPrompt(prompt: string): string {
  return sanitizeControlChars(truncateBytes(prompt, USER_PROMPT_MAX_BYTES));
}

/** Q output truncation: `truncate_safe(raw, max) + " ... truncated"` when cut (06 §3.3). */
export function truncateHookOutput(raw: string, maxBytes: number, alreadyCut = false): string {
  const max = Math.max(0, Math.floor(maxBytes));
  if (!alreadyCut && byteLength(raw) <= max) return raw;
  return truncateBytes(raw, max) + TRUNCATED_SUFFIX;
}

/** Parse a V3 Stop hook's stdout: `{"decision":"block","reason"?}` (02 §7.6). */
export function parseStopDecision(stdout: string): { block: boolean; reason?: string } {
  const t = stdout.trim();
  if (!t.startsWith('{')) return { block: false };
  try {
    const v = JSON.parse(t) as unknown;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (o.decision === 'block') {
        return typeof o.reason === 'string' && o.reason.trim() !== '' ? { block: true, reason: o.reason } : { block: true };
      }
    }
  } catch {
    // not JSON
  }
  return { block: false };
}

/** Parse a `confirmCommand` stdout (02 §7.6). `undefined` ⇒ use the static question/options. */
export function parseConfirmCommandOutput(
  stdout: string,
): { skip: true } | { skip: false; question?: string; options?: HookConfirmOption[] } | undefined {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o.skip === true) return { skip: true };
  const out: { skip: false; question?: string; options?: HookConfirmOption[] } = { skip: false };
  if (typeof o.question === 'string') out.question = o.question;
  if (Array.isArray(o.options)) {
    const opts: HookConfirmOption[] = [];
    for (const x of o.options) {
      if (typeof x === 'object' && x !== null && typeof (x as Record<string, unknown>).id === 'string') {
        const r = x as Record<string, unknown>;
        opts.push({ id: r.id as string, label: typeof r.label === 'string' ? r.label : (r.id as string), run: r.run === true });
      }
    }
    if (opts.length) out.options = opts;
  }
  if (out.question === undefined && out.options === undefined) return undefined;
  return out;
}

/** Default options for a `confirm` block without any (DECISION). */
export const DEFAULT_CONFIRM_OPTIONS: readonly HookConfirmOption[] = Object.freeze([
  { id: 'yes', label: 'Yes', run: true },
  { id: 'no', label: 'No', run: false },
]);

/** Outcome of one hook run (exported for diagnostics and tests). */
export interface HookRunResult {
  hook: KiroHook;
  /** `agent`: not executed; `cached`: served from cache (exit 0); `exit`: ran; `error`: timeout/spawn error/abort. */
  kind: 'agent' | 'cached' | 'exit' | 'error';
  exitCode?: number;
  /** Q output: stdout on exit 0, else stderr; truncated. */
  output: string;
  /** Truncated stdout / stderr. */
  stdout: string;
  stderr: string;
  /** stdout up to 64 KiB (for JSON decisions). */
  rawStdout: string;
  error?: string;
  aborted?: boolean;
  durationMs: number;
  /** Agent action prompt. */
  prompt?: string;
  /** The command actually run (after `{{filePath}}` substitution). */
  command?: string;
}

export interface HookRunnerOptions {
  /** Clock (ms) for cache expiry. */
  now?: () => number;
  /** Shell program override (default bash, else /bin/sh). */
  shell?: string;
  /** SessionEnd per-hook timeout cap (default {@link SESSION_END_CAP_MS}). */
  sessionEndCapMs?: number;
}

interface RunOneOptions {
  /** `session`: SessionStart cache (no expiry); `ttl`: `cacheTtlSec`; `none`. */
  cache: 'session' | 'ttl' | 'none';
  /** Upper bound for the timeout (0/none ⇒ the cap). */
  timeoutCapMs?: number;
  /** Command override (template substitution, confirmCommand). */
  command?: string;
  signal?: AbortSignal;
}

interface PendingConfirm {
  hook: KiroHook;
  question: string;
  options: HookConfirmOption[];
}

type FileTrigger = 'PostFileCreate' | 'PostFileSave' | 'PostFileDelete';

function hookIdentity(h: KiroHook): string {
  return JSON.stringify([
    h.dialect,
    h.source,
    h.sourcePath ?? '',
    h.agentName ?? '',
    h.name,
    h.trigger,
    h.rawTrigger,
    h.matcher ?? null,
    h.action,
    h.timeoutMs,
    h.maxOutputBytes,
    h.cacheTtlSec,
  ]);
}

function isSuccess(r: HookRunResult): boolean {
  return (r.kind === 'exit' || r.kind === 'cached') && r.exitCode === 0;
}

function joinUnique(parts: readonly string[]): string | undefined {
  const seen: string[] = [];
  for (const p of parts) if (!seen.includes(p)) seen.push(p);
  return seen.length ? seen.join('\n\n') : undefined;
}

export class HookRunner implements HookRunnerLike {
  readonly hooks: readonly KiroHook[];
  private readonly now: () => number;
  private readonly shell: string | undefined;
  private readonly sessionEndCapMs: number;
  private readonly cache = new Map<string, { output: string; stdout: string; expiresAt: number }>();
  private pending: PendingConfirm[] = [];

  constructor(hooks: KiroHook[], opts: HookRunnerOptions = {}) {
    this.hooks = Object.freeze([...hooks]);
    this.now = opts.now ?? Date.now;
    this.shell = opts.shell;
    this.sessionEndCapMs = opts.sessionEndCapMs ?? SESSION_END_CAP_MS;
  }

  /** Forget cached results (Q `/clear`: agentSpawn hooks re-run on the next request). */
  clearCache(): void {
    this.cache.clear();
  }

  /** Stop-hook confirmations still waiting for a UI answer, in definition order. */
  get pendingConfirms(): { hook: string; question: string; options: HookConfirmOption[] }[] {
    return this.pending.map((p) => ({ hook: p.hook.name, question: p.question, options: p.options.map((o) => ({ ...o })) }));
  }

  // ───────────────────────────── core ─────────────────────────────

  /** Enabled hooks of `trigger` (definition order) passing `pred`. */
  private select(trigger: HookTrigger, pred?: (h: KiroHook) => boolean): KiroHook[] {
    return this.hooks.filter((h) => h.enabled && h.trigger === trigger && (!pred || pred(h)));
  }

  /** Run (or serve from cache) one hook. Never rejects. */
  async runHook(hook: KiroHook, event: HookEvent, opts: RunOneOptions = { cache: 'none' }): Promise<HookRunResult> {
    if (hook.action.type === 'agent') {
      return { hook, kind: 'agent', prompt: hook.action.prompt, output: '', stdout: '', stderr: '', rawStdout: '', durationMs: 0 };
    }
    const command = opts.command ?? hook.action.command;
    const payload = buildPayload(hook, event);
    const stdin = JSON.stringify(payload);

    const cacheMode = opts.cache === 'ttl' && !(hook.cacheTtlSec > 0) ? 'none' : opts.cache;
    const key = cacheMode === 'none' ? undefined : `${cacheMode}\u0000${hookIdentity(hook)}${cacheMode === 'ttl' ? `\u0000${command}\u0000${stdin}` : ''}`;
    if (key !== undefined) {
      const hit = this.cache.get(key);
      if (hit && this.now() < hit.expiresAt) {
        return { hook, kind: 'cached', exitCode: 0, output: hit.output, stdout: hit.stdout, stderr: '', rawStdout: hit.stdout, durationMs: 0, command };
      }
      if (hit) this.cache.delete(key);
    }

    const env: NodeJS.ProcessEnv = { ...event.ws.env };
    if (typeof payload.prompt === 'string') env.USER_PROMPT = sanitizeUserPrompt(payload.prompt);
    else delete env.USER_PROMPT;

    let timeoutMs = effectiveTimeoutMs(hook);
    if (opts.timeoutCapMs !== undefined) timeoutMs = timeoutMs === 0 ? opts.timeoutCapMs : Math.min(timeoutMs, opts.timeoutCapMs);
    const max = effectiveMaxOutputBytes(hook);
    const cwd = hook.dialect === 'v2' ? event.ws.cwd : event.ws.workspaceRoot;

    const res = await runShell(command, {
      cwd,
      env,
      stdin,
      timeoutMs,
      maxOutputBytes: Math.max(max, DECISION_CAPTURE_BYTES),
      ...(this.shell ? { shell: this.shell } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const base = { hook, durationMs: res.durationMs, command };
    if (res.aborted) {
      return { ...base, kind: 'error', aborted: true, error: 'aborted', output: '', stdout: '', stderr: '', rawStdout: '' };
    }
    const stdout = truncateHookOutput(res.stdout, max, res.truncated?.stdout ?? false);
    const stderr = truncateHookOutput(res.stderr, max, res.truncated?.stderr ?? false);
    if (res.timedOut) {
      return { ...base, kind: 'error', error: hookTimeoutError(timeoutMs), output: '', stdout, stderr, rawStdout: res.stdout };
    }
    if (res.error !== undefined && res.exitCode === null) {
      return { ...base, kind: 'error', error: hookSpawnError(res.error), output: '', stdout, stderr, rawStdout: res.stdout };
    }
    const exitCode = res.exitCode ?? -1;
    const output = exitCode === 0 ? stdout : stderr;
    if (exitCode === 0 && key !== undefined) {
      const expiresAt = cacheMode === 'session' ? Number.POSITIVE_INFINITY : this.now() + hook.cacheTtlSec * 1000;
      this.cache.set(key, { output, stdout, expiresAt });
    }
    return { ...base, kind: 'exit', exitCode, output, stdout, stderr, rawStdout: res.stdout };
  }

  /** Run hooks concurrently; results in definition order. */
  private runAll(hooks: readonly KiroHook[], event: HookEvent, opts: RunOneOptions, commandFor?: (h: KiroHook) => string | undefined): Promise<HookRunResult[]> {
    return Promise.all(
      hooks.map((h) => {
        const command = commandFor?.(h);
        return this.runHook(h, event, command !== undefined ? { ...opts, command } : opts);
      }),
    );
  }

  /** Q warning for a failed run (undefined for success, agent actions, aborts). */
  warningFor(r: HookRunResult): HookWarning | undefined {
    if (r.hook.action.type !== 'command') return undefined;
    return this.warningForCommand(r, r.hook.action.command);
  }

  private warningForCommand(r: HookRunResult, command: string): HookWarning | undefined {
    if (r.kind === 'error') {
      if (r.aborted) return undefined;
      return {
        hook: r.hook.name,
        message: formatHookWarning({ trigger: hookEventName(r.hook), command, error: r.error ?? 'unknown error', durationMs: r.durationMs }),
      };
    }
    if (r.kind === 'exit' && r.exitCode !== 0) {
      return { hook: r.hook.name, message: formatHookWarning({ trigger: hookEventName(r.hook), command, exitCode: r.exitCode ?? -1, output: r.output }) };
    }
    return undefined;
  }

  private warnings(results: readonly HookRunResult[]): HookWarning[] {
    const out: HookWarning[] = [];
    for (const r of results) {
      const w = this.warningFor(r);
      if (w) out.push(w);
    }
    return out;
  }

  private event(trigger: HookTrigger, ctx: HookRunContext, extra: Partial<HookEvent> = {}): HookEvent {
    return { trigger, ws: ctx.ws, sessionId: ctx.sessionId, ...extra };
  }

  private opts(cache: RunOneOptions['cache'], ctx: HookRunContext, extra: Partial<RunOneOptions> = {}): RunOneOptions {
    return { cache, ...(ctx.signal ? { signal: ctx.signal } : {}), ...extra };
  }

  // ───────────────────────────── triggers ─────────────────────────────

  async runSessionStart(ctx: HookRunContext): Promise<AgentSpawnHookResult> {
    const hooks = this.select('SessionStart');
    const ev = this.event('SessionStart', ctx, ctx.prompt !== undefined ? { prompt: ctx.prompt } : {});
    const results = await this.runAll(hooks, ev, this.opts('session', ctx));
    return {
      outputs: results.filter((r) => isSuccess(r) && r.output !== '').map((r) => r.output),
      agentPrompts: results.filter((r) => r.kind === 'agent').map((r) => r.prompt!),
      warnings: this.warnings(results),
    };
  }

  async runUserPromptSubmit(ctx: HookRunContext & { prompt: string }): Promise<UserPromptHookResult> {
    const hooks = this.select('UserPromptSubmit');
    const results = await this.runAll(hooks, this.event('UserPromptSubmit', ctx, { prompt: ctx.prompt }), this.opts('ttl', ctx));
    const outputs: string[] = [];
    const agentPrompts: string[] = [];
    for (const r of results) {
      if (r.kind === 'agent') agentPrompts.push(r.prompt!);
      else if (isSuccess(r)) {
        if (r.output !== '') outputs.push(r.output);
      } else if (r.hook.dialect === 'v3' && !r.aborted) {
        // V3 CLI: never blocks; output + exit code forwarded as context (02 §7.6, 03 §2.4).
        const label = hookEventName(r.hook);
        if (r.kind === 'exit') {
          outputs.push(formatPromptHookExitNote(label, r.hook.name, r.exitCode ?? -1, r.stderr.trim() !== '' ? r.stderr : r.stdout));
        } else {
          outputs.push(formatPromptHookErrorNote(label, r.hook.name, r.error ?? 'unknown error'));
        }
      }
    }
    return { outputs, agentPrompts, warnings: this.warnings(results) };
  }

  async runPreToolUse(ctx: HookRunContext, call: KiroToolCall): Promise<PreToolHookResult> {
    const hooks = this.select('PreToolUse', (h) => hookMatchesCall(h, call));
    const results = await this.runAll(hooks, this.event('PreToolUse', ctx, { call }), this.opts('ttl', ctx));
    const res: PreToolHookResult = { blocked: false, warnings: this.warnings(results) };
    const blocker = results.find((r) => r.kind === 'exit' && r.exitCode === 2);
    if (blocker) {
      res.blocked = true;
      res.blockReason = blocker.output;
    }
    const ctxText = joinUnique(results.filter((r) => r.kind === 'agent').map((r) => r.prompt!));
    if (ctxText !== undefined) res.additionalContext = ctxText;
    return res;
  }

  async runPostToolUse(ctx: HookRunContext, call: KiroToolCall, outcome: ToolOutcome): Promise<PostToolHookResult> {
    const hooks = this.select('PostToolUse', (h) => hookMatchesCall(h, call));
    const results = await this.runAll(hooks, this.event('PostToolUse', ctx, { call, outcome }), this.opts('ttl', ctx));
    const res: PostToolHookResult = { warnings: this.warnings(results) };
    const ctxText = joinUnique(results.filter((r) => r.kind === 'agent').map((r) => r.prompt!));
    if (ctxText !== undefined) res.additionalContext = ctxText;
    return res;
  }

  /** V3 Stop semantics for one result: continuation text, or undefined. */
  private stopContinuation(r: HookRunResult): string | undefined {
    if (r.kind === 'agent') return r.prompt;
    if (r.hook.dialect !== 'v3') return undefined;
    if (r.kind === 'cached' || (r.kind === 'exit' && r.exitCode === 0)) {
      const d = parseStopDecision(r.rawStdout);
      return d.block ? (d.reason ?? DEFAULT_STOP_CONTINUE_TEXT) : undefined;
    }
    if (r.kind === 'exit' && r.exitCode === 1) {
      return parseStopDecision(r.rawStdout).reason ?? DEFAULT_STOP_CONTINUE_TEXT;
    }
    return undefined;
  }

  /** Warnings for Stop results: V3 exit 1 is a continuation request, not a failure. */
  private stopWarnings(results: readonly HookRunResult[]): HookWarning[] {
    return this.warnings(results.filter((r) => !(r.hook.dialect === 'v3' && r.kind === 'exit' && r.exitCode === 1)));
  }

  private finishStop(continuations: string[], warnings: HookWarning[], hookDrivenContinuations: number): StopHookResult {
    const res: StopHookResult = { warnings };
    const text = joinUnique(continuations);
    if (text !== undefined) {
      if (hookDrivenContinuations >= MAX_HOOK_CONTINUATIONS) {
        warnings.push({ hook: 'Stop', message: formatContinuationLimitWarning(MAX_HOOK_CONTINUATIONS) });
      } else {
        res.continueWith = text;
      }
    }
    const next = this.pending[0];
    if (next) res.confirm = { hook: next.hook.name, question: next.question, options: next.options.map((o) => ({ ...o })) };
    return res;
  }

  /** Resolve the question/options of a `confirm` hook (runs `confirmCommand`); undefined ⇒ skipped. */
  private async prepareConfirm(hook: KiroHook, ev: HookEvent, ctx: HookRunContext, warnings: HookWarning[]): Promise<PendingConfirm | undefined> {
    const conf = hook.confirm!;
    let question = conf.question;
    let options = conf.options.map((o) => ({ ...o }));
    if (conf.confirmCommand) {
      const r = await this.runHook(hook, ev, this.opts('none', ctx, { command: conf.confirmCommand }));
      if (r.kind === 'exit' && r.exitCode === 0) {
        const parsed = parseConfirmCommandOutput(r.rawStdout);
        if (parsed?.skip) return undefined;
        if (parsed) {
          if (parsed.question !== undefined) question = parsed.question;
          if (parsed.options !== undefined) options = parsed.options;
        }
      } else if (!r.aborted) {
        log.debug('hooks: confirmCommand failed, using static confirm', hook.name, r.error ?? r.exitCode);
        const w = this.warningForCommand(r, conf.confirmCommand);
        if (w) warnings.push(w);
      } else {
        return undefined;
      }
    }
    if (options.length === 0) options = DEFAULT_CONFIRM_OPTIONS.map((o) => ({ ...o }));
    return { hook, question, options };
  }

  async runStop(ctx: HookRunContext & { assistantText?: string; hookDrivenContinuations: number }): Promise<StopHookResult> {
    const hooks = this.select('Stop');
    const isConfirm = (h: KiroHook): boolean => h.dialect === 'v3' && h.action.type === 'command' && h.confirm !== undefined;
    const ev = this.event('Stop', ctx);
    type Entry = { r: HookRunResult } | { confirm: PendingConfirm | undefined; warnings: HookWarning[] };
    // Everything starts concurrently; aggregation below follows definition order (00 §2.4).
    const entries = await Promise.all(
      hooks.map(async (h): Promise<Entry> => {
        if (!isConfirm(h)) return { r: await this.runHook(h, ev, this.opts('ttl', ctx)) };
        const w: HookWarning[] = [];
        return { confirm: await this.prepareConfirm(h, ev, ctx, w), warnings: w };
      }),
    );
    const continuations: string[] = [];
    const warnings: HookWarning[] = [];
    const pending: PendingConfirm[] = [];
    for (const e of entries) {
      if ('r' in e) {
        const c = this.stopContinuation(e.r);
        if (c !== undefined) continuations.push(c);
        warnings.push(...this.stopWarnings([e.r]));
      } else {
        warnings.push(...e.warnings);
        if (e.confirm) pending.push(e.confirm);
      }
    }
    this.pending = pending;
    return this.finishStop(continuations, warnings, ctx.hookDrivenContinuations);
  }

  /**
   * Answer a pending Stop `confirm` (not part of HookRunnerLike). `optionId` undefined ⇒ dismissed.
   * An option with `run: true` runs the hook's command with V3 Stop semantics. The returned
   * result carries the next pending confirm, if any.
   */
  async resolveStopConfirm(
    ctx: HookRunContext & { hookDrivenContinuations: number },
    hookName: string,
    optionId: string | undefined,
  ): Promise<StopHookResult> {
    const idx = this.pending.findIndex((p) => p.hook.name === hookName);
    if (idx < 0) return this.finishStop([], [], ctx.hookDrivenContinuations);
    const [entry] = this.pending.splice(idx, 1);
    const opt = optionId === undefined ? undefined : entry!.options.find((o) => o.id === optionId);
    const continuations: string[] = [];
    let warnings: HookWarning[] = [];
    if (opt?.run) {
      const r = await this.runHook(entry!.hook, this.event('Stop', ctx), this.opts('none', ctx));
      const c = this.stopContinuation(r);
      if (c !== undefined) continuations.push(c);
      warnings = this.stopWarnings([r]);
    }
    return this.finishStop(continuations, warnings, ctx.hookDrivenContinuations);
  }

  async runSessionEnd(ctx: HookRunContext): Promise<{ warnings: HookWarning[] }> {
    const hooks = this.select('SessionEnd', (h) => h.action.type === 'command');
    const results = await this.runAll(hooks, this.event('SessionEnd', ctx), this.opts('none', ctx, { timeoutCapMs: this.sessionEndCapMs }));
    return { warnings: this.warnings(results) };
  }

  async runFileHook(
    ctx: HookRunContext & { hookDepth?: number },
    trigger: FileTrigger,
    filePath: string,
    call: KiroToolCall,
  ): Promise<PostToolHookResult> {
    const abs = path.resolve(ctx.ws.cwd, filePath);
    const hooks = this.select(trigger, (h) => hookMatchesFile(h, abs, ctx.ws));
    const style = quoteStyleForShell(this.shell);
    const results = await this.runAll(hooks, this.event(trigger, ctx, { filePath: abs, call }), this.opts('ttl', ctx), (h) =>
      h.action.type === 'command' && h.action.command.includes(FILE_PATH_TEMPLATE) ? substituteFilePath(h.action.command, abs, style) : undefined,
    );
    const res: PostToolHookResult = { warnings: this.warnings(results) };
    if ((ctx.hookDepth ?? 0) < 1) {
      const texts = results
        .filter((r) => r.kind === 'agent')
        .map((r) => formatFileHookContext(trigger, abs, r.prompt!.split(FILE_PATH_TEMPLATE).join(abs)));
      const t = joinUnique(texts);
      if (t !== undefined) res.additionalContext = t;
    }
    return res;
  }

  async runTaskHook(
    ctx: HookRunContext,
    trigger: 'PreTaskExec' | 'PostTaskExec',
    task: HookTaskInfo,
  ): Promise<{ blocked: boolean; blockReason?: string; agentPrompts: string[]; warnings: HookWarning[] }> {
    const hooks = this.select(trigger);
    const results = await this.runAll(hooks, this.event(trigger, ctx, { task }), this.opts('ttl', ctx));
    const res: { blocked: boolean; blockReason?: string; agentPrompts: string[]; warnings: HookWarning[] } = {
      blocked: false,
      agentPrompts: results.filter((r) => r.kind === 'agent').map((r) => r.prompt!),
      warnings: this.warnings(results),
    };
    if (trigger === 'PreTaskExec') {
      const blocker = results.find((r) => r.kind === 'exit' && r.exitCode === 2);
      if (blocker) {
        res.blocked = true;
        res.blockReason = blocker.output;
      }
    }
    return res;
  }

  /**
   * Run a `Manual` hook by name (adapter extension `/hooks run <name>`, 03 §2.5). Exact name first,
   * then case-insensitive. Command ⇒ `output` (stdout on exit 0, else stderr) + `exitCode`; agent
   * action ⇒ `agentPrompt` (the session sends it as a user turn); disabled ⇒ warning.
   */
  async runManual(
    ctx: HookRunContext,
    name: string,
  ): Promise<{ found: boolean; output?: string; exitCode?: number; agentPrompt?: string; warnings: HookWarning[] }> {
    const manual = this.hooks.filter((h) => h.trigger === 'Manual');
    const hook = manual.find((h) => h.name === name) ?? manual.find((h) => h.name.toLowerCase() === name.toLowerCase());
    if (!hook) return { found: false, warnings: [] };
    if (!hook.enabled) return { found: true, warnings: [{ hook: hook.name, message: `Hook "${hook.name}" is disabled.` }] };
    if (hook.action.type === 'agent') return { found: true, agentPrompt: hook.action.prompt, warnings: [] };
    const r = await this.runHook(hook, this.event('Manual', ctx), this.opts('none', ctx));
    const out: { found: boolean; output?: string; exitCode?: number; agentPrompt?: string; warnings: HookWarning[] } = {
      found: true,
      warnings: this.warnings([r]),
    };
    if (r.kind === 'exit' || r.kind === 'cached') {
      out.output = r.output;
      if (r.exitCode !== undefined) out.exitCode = r.exitCode;
    }
    return out;
  }
}
