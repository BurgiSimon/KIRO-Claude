/**
 * THE GATE: kiro-claude's in-process PreToolUse / PostToolUse hook callbacks and the
 * `can_use_tool` answerer (00 §5, §3.3–§3.6, 07).
 *
 * Every Claude tool call (also auto-allowed reads and calls inside subagents, VERIFIED 07/R2)
 * reaches {@link Gate.preToolUse} through the `kiro_pre` hook callback registered by
 * {@link buildInitializeHooks}. The decision function is 00 §5.1:
 *
 *  1. Kiro `preToolUse` hooks (hooks().runPreToolUse). Blocked (exit 2) ⇒ deny
 *     `PreToolHook blocked the tool execution: <stderr>`; agent-action prompts become
 *     `additionalContext`; hook warnings go to deps.notify.
 *  2. Hard rules: tools kiro-claude never exposes ⇒ deny; Kiro-scope invariants (invariants.ts,
 *     incl. `.kiroignore`) deny ⇒ `Kiro does not allow this operation: <path>`; plan mode +
 *     mutating call ⇒ `Plan mode is read-only. Exit plan mode (/plan or Shift+Tab) to make
 *     changes.`; agent `tools` selection (P1 enforcement of `@srv/tool` partial selections,
 *     excluded MCP tools, `subagent/<name>` lists) ⇒ deny; spec phase: an `fs_write` outside
 *     the phase's allowed paths ⇒ `Spec phase <name>: only <paths> may be written now`, one
 *     inside them is auto-allowed unless policy denies (03 §1.11.3).
 *  3. Policy per agent — the session agent and, for calls inside a Claude subagent
 *     (`agent_type`), the matching Kiro agent too; the stricter verdict wins (deny > ask >
 *     allow). V2 agents: qengine.evaluateQ; V3 agents: capengine.evaluateCap over agent rules,
 *     user/workspace YAML, presets and session rules. An always-ask invariant turns allow
 *     into ask.
 *  4. deny ⇒ deps.onDenied(call, reasons) + `Tool use with <name> was rejected because the
 *     arguments supplied were forbidden`; allow ⇒ allow; ask ⇒ non-interactive sessions deny
 *     with the V3 headless text, interactive ones remember the call by `tool_use_id` and
 *     answer `ask`, which makes Claude send `can_use_tool`.
 *
 * {@link Gate.canUseTool} serializes approval prompts (one at a time), re-evaluates the static
 * policy first (a `t` answered for an earlier prompt may already cover a queued call; Kiro
 * policy is applied before asking, 05 §6.1) and maps answers per 00 §2.3: `y` ⇒ allow; `t` ⇒
 * session trust + allow; `n` ⇒ deny with `I deny this tool request. Ask a follow up question
 * clarifying the expected action`; other text ⇒ deny `interrupt:true` + `redirectText`;
 * cancelled ⇒ deny `interrupt:true`.
 *
 * {@link Gate.postToolUse} runs Kiro `postToolUse` hooks, the derived file hooks
 * (`PostFileCreate` when the Write/Edit/NotebookEdit target did not exist at PreToolUse,
 * else `PostFileSave`; 03 §2.5) and deps.onPostToolContext, and returns their text as
 * `additionalContext`. `PostFileDelete` (Bash + git status diff) is not derived here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HookCallbackOutput,
  HookInput,
  CanUseToolRequest,
  InitializeRequest,
  PermissionResult,
} from '../claude/protocol.js';
import type {
  ApprovalRequest,
  ApprovalResponse,
  GateDecision,
  HookRunContext,
  HookRunnerLike,
  HookWarning,
  KiroAgent,
  KiroToolCall,
  PermissionRule,
  PolicyVerdict,
  SessionTrust,
  ToolOutcome,
  WorkspaceContext,
} from '../types.js';
import { globMatch, hasGlobMeta } from '../util/glob.js';
import { expandTilde, isSubpath } from '../util/paths.js';
import { collectRules, evaluateCap, ruleAppliesTo, V3_DEFAULT_RULES } from './capengine.js';
import { checkInvariants } from './invariants.js';
import { canonicalizePath, canonicalizePattern } from './pathmatch.js';
import { effectiveAllowedTools, evaluateQ, toolSettings } from './qengine.js';
import { isToolInAllowlist, matchesAnyPattern } from './qmatch.js';
import {
  FILE_WRITE_TOOLS,
  NEVER_EXPOSE_TOOLS,
  claudeMcpName,
  isMcpToolSelected,
  isSubagentSelected,
  isAlwaysAllowedTool,
  normalizeV2Name,
  toKiroCall,
} from './toolmap.js';

// ───────────────────────────── exact strings ─────────────────────────────

/** Hook callback ids registered in `initialize` (00 §3.3). */
export const GATE_CALLBACK_IDS = Object.freeze({
  pre: 'kiro_pre',
  post: 'kiro_post',
  postFail: 'kiro_post_fail',
} as const);

/** V3 headless denial (00 §2.3 "Headless", §8 C10). */
export const NON_INTERACTIVE_DENY =
  '[denied] tool permission approval is not supported in non-interactive mode. Use --trust-all-tools to auto-approve.';
/** Plan-mode denial (00 §2.5). */
export const PLAN_MODE_DENY = 'Plan mode is read-only. Exit plan mode (/plan or Shift+Tab) to make changes.';
/** `n` at the approval prompt (06 §2.2). */
export const USER_DENY_MESSAGE = 'I deny this tool request. Ask a follow up question clarifying the expected action';
/** Rejection by free text / cancellation (06 §2.3). */
export const USER_CANCEL_MESSAGE = 'Tool use was cancelled by the user';
/** `permissionDecisionReason` for allow answers (00 §3.5). */
export const ALLOW_REASON = 'kiro';

/** Q denial sentence sent to the model for rule denials (06 §2.4). */
export function forbiddenMessage(toolName: string): string {
  return `Tool use with ${toolName} was rejected because the arguments supplied were forbidden`;
}

/** Q preToolUse block text (06 §3.7). */
export function hookBlockedMessage(stderr: string): string {
  return `PreToolHook blocked the tool execution: ${stderr}`;
}

/** Q printed denial block (06 §2.4), for UIs: `Command <tool> is rejected because …` + rule list. */
export function deniedRulesText(toolName: string, reasons: readonly string[]): string {
  return `Command ${toolName} is rejected because it matches one or more rules on the denied list:${reasons
    .map((r) => `\n  - ${r}`)
    .join('')}`;
}

/** Q `--trust-tools` warning for a non-native name without `@server/` (06 §1.1). */
export function trustToolsWarning(name: string): string {
  return `WARNING: --trust-tools arg for custom tool ${name} needs to be prepended with @{MCPSERVERNAME}/`;
}

/** `initialize.hooks` registering the gate (00 §3.3 exact). */
export function buildInitializeHooks(): InitializeRequest['hooks'] {
  return {
    PreToolUse: [{ hookCallbackIds: [GATE_CALLBACK_IDS.pre], timeout: 600, onFailure: 'block' }],
    PostToolUse: [{ hookCallbackIds: [GATE_CALLBACK_IDS.post], timeout: 600 }],
    PostToolUseFailure: [{ hookCallbackIds: [GATE_CALLBACK_IDS.postFail], timeout: 600 }],
  };
}

/** Q `NATIVE_TOOLS` (06 §1.1) plus Kiro 2.x built-in names — no `--trust-tools` warning for these. */
const NATIVE_TOOL_NAMES = new Set([
  'fs_read', 'fs_write', 'execute_bash', 'execute_cmd', 'use_aws', 'gh_issue', 'knowledge', 'thinking', 'todo_list',
  'delegate', 'introspect', 'glob', 'grep', 'web_fetch', 'web_search', 'use_subagent', 'skill', 'report_issue', 'code',
  'tool_search',
]);

/** A tool trusted again (`t`, `/tools trust`) is no longer revoked for the session. */
function unrevoke(t: SessionTrust, name: string): void {
  if (!t.revokedTools?.length) return;
  const norm = normalizeV2Name(name);
  t.revokedTools = t.revokedTools.filter((x) => x !== name && x !== norm);
}

// ───────────────────────────── deps ─────────────────────────────

export interface GateDeps {
  ws: WorkspaceContext;
  sessionId(): string;
  agent(): KiroAgent;
  resolveAgent(name: string): KiroAgent | undefined;
  hooks(): HookRunnerLike;
  trust: SessionTrust;
  interactive: boolean;
  v3Scopes(): { userRules: PermissionRule[]; workspaceRules: PermissionRule[]; presetRules: PermissionRule[] };
  /** Claude-normalized MCP server name → configured name. */
  mcpServerNames(): Record<string, string>;
  /** mcp.json `autoApprove` of a configured server. */
  mcpAutoApprove(server: string): string[];
  isIgnored?(p: string): boolean;
  planMode(): boolean;
  specPhase(): { name: string; allowedWritePaths: string[] } | undefined;
  /** Extra PostToolUse context for a successful call (e.g. fileMatch steering). */
  onPostToolContext?(call: KiroToolCall): string | undefined;
  notify(level: 'info' | 'warn' | 'error', msg: string): void;
  /** Called when policy denies a call (UIs print deniedRulesText). */
  onDenied?(call: KiroToolCall, reasons: string[]): void;
}

interface Inflight {
  call: KiroToolCall;
  reasons: string[];
  additionalContext?: string;
  /** Write targets → existed at PreToolUse. */
  existed?: Record<string, boolean>;
}

interface StaticEval {
  kind: 'allow' | 'ask' | 'deny';
  /** Text for the model (deny). */
  reason?: string;
  reasons: string[];
  /** Deny came from agent policy (rules / toolsSettings). */
  policyDeny?: boolean;
}

const SEVERITY = { allow: 0, ask: 1, deny: 2 } as const;
const MAX_INFLIGHT = 2000;

function inflightKey(toolUseId: string | undefined, claudeName: string, input: unknown): string {
  if (toolUseId) return `id:${toolUseId}`;
  let j = '';
  try {
    j = JSON.stringify(input) ?? '';
  } catch {
    j = '';
  }
  return `call:${claudeName}\u0000${j}`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function waitOrAbort(p: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => resolve(true);
    signal.addEventListener('abort', onAbort, { once: true });
    const done = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };
    p.then(done, done);
  });
}

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return (
    a.capability === b.capability &&
    a.effect === b.effect &&
    JSON.stringify(a.match ?? []) === JSON.stringify(b.match ?? []) &&
    JSON.stringify(a.exclude ?? []) === JSON.stringify(b.exclude ?? [])
  );
}

/** Session rule (V3) equivalent of a trusted V2 name, used by `t` / `/tools trust` / `--trust-tools`. */
export function sessionRuleForName(norm: string): PermissionRule | undefined {
  const rule = (capability: string, match?: string[]): PermissionRule => ({
    capability,
    ...(match ? { match } : {}),
    effect: 'allow',
    scope: 'session',
  });
  if (norm === '*' || norm === '@builtin' || norm === '@builtin/' || norm === '@builtin/*') return rule('builtin');
  if (norm.startsWith('@builtin/')) return sessionRuleForName(norm.slice('@builtin/'.length));
  if (norm === '@mcp') return rule('mcp');
  if (norm.startsWith('@')) {
    const rest = norm.slice(1);
    const i = rest.indexOf('/');
    const srv = i < 0 ? rest : rest.slice(0, i);
    const tool = i < 0 ? '' : rest.slice(i + 1);
    if (!srv) return undefined;
    return rule('mcp', [`${srv}/${tool === '' ? '*' : tool}`]);
  }
  switch (norm) {
    case 'fs_read':
    case 'glob':
    case 'grep':
      return rule('fs_read');
    case 'fs_write':
      return rule('fs_write');
    case 'execute_bash':
      return rule('shell');
    case 'web_fetch':
      return rule('web_fetch');
    case 'web_search':
      return rule('web_search');
    case 'use_subagent':
      return rule('subagent');
    case 'skill':
      return rule('skill');
    default:
      return undefined;
  }
}

// ───────────────────────────── the gate ─────────────────────────────

export class Gate {
  private readonly deps: GateDeps;
  private readonly inflight = new Map<string, Inflight>();
  private promptChain: Promise<void> = Promise.resolve();

  constructor(deps: GateDeps) {
    this.deps = deps;
  }

  /** The (mutable) session trust this gate reads and writes. */
  get trust(): SessionTrust {
    return this.deps.trust;
  }

  /** The KiroToolCall remembered for a tool_use_id (between PreToolUse and PostToolUse). */
  callFor(toolUseId: string): KiroToolCall | undefined {
    return this.inflight.get(inflightKey(toolUseId, '', undefined))?.call;
  }

  // ── PreToolUse ──

  async preToolUse(input: HookInput): Promise<{ call: KiroToolCall; decision: GateDecision; output: HookCallbackOutput }> {
    const call = this.callFromHookInput(input);
    const key = inflightKey(call.toolUseId, call.claudeName, call.input);
    const existed = this.snapshotExistence(call);
    let ctx: string | undefined;
    let decision: GateDecision;
    try {
      const h = await this.runPreHooks(call);
      ctx = h?.additionalContext ? h.additionalContext : undefined;
      if (h?.blocked) {
        decision = { kind: 'deny', reason: hookBlockedMessage(h.blockReason ?? ''), ...(ctx ? { additionalContext: ctx } : {}) };
      } else {
        const s = this.evaluateStatic(call);
        if (s.kind === 'deny') {
          if (s.policyDeny) this.safeOnDenied(call, s.reasons);
          decision = { kind: 'deny', reason: s.reason ?? forbiddenMessage(call.v2Name), ...(ctx ? { additionalContext: ctx } : {}) };
        } else if (s.kind === 'allow') {
          this.remember(key, { call, reasons: s.reasons, ...(ctx ? { additionalContext: ctx } : {}), ...(existed ? { existed } : {}) });
          decision = { kind: 'allow', ...(ctx ? { additionalContext: ctx } : {}) };
        } else if (!this.deps.interactive) {
          decision = { kind: 'deny', reason: NON_INTERACTIVE_DENY, ...(ctx ? { additionalContext: ctx } : {}) };
        } else {
          this.remember(key, { call, reasons: s.reasons, ...(ctx ? { additionalContext: ctx } : {}), ...(existed ? { existed } : {}) });
          decision = { kind: 'ask', reason: `kiro: approval required for ${call.kiro2Name}`, ...(ctx ? { additionalContext: ctx } : {}) };
        }
      }
    } catch (e) {
      this.deps.notify('error', `kiro-claude permission gate failed: ${errText(e)}`);
      if (this.deps.interactive) {
        this.remember(key, { call, reasons: [`gate error: ${errText(e)}`], ...(existed ? { existed } : {}) });
        decision = { kind: 'ask', reason: `kiro: approval required for ${call.kiro2Name}` };
      } else {
        decision = { kind: 'deny', reason: NON_INTERACTIVE_DENY };
      }
    }
    return { call, decision, output: Gate.toPreOutput(decision) };
  }

  /** Map a gate decision to the PreToolUse hook callback answer (00 §3.5). */
  static toPreOutput(d: GateDecision): HookCallbackOutput {
    const ctx = d.additionalContext ? { additionalContext: d.additionalContext } : {};
    switch (d.kind) {
      case 'allow':
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: ALLOW_REASON, ...ctx } };
      case 'deny':
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason, ...ctx } };
      case 'ask':
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: d.reason, ...ctx } };
    }
  }

  // ── PostToolUse ──

  async postToolUse(input: HookInput, failed = false): Promise<HookCallbackOutput> {
    const toolName = input.tool_name ?? '';
    const key = inflightKey(input.tool_use_id, toolName, input.tool_input ?? {});
    const inf = this.inflight.get(key);
    this.inflight.delete(key);
    const call = inf?.call ?? this.callFromHookInput(input);
    const ctx = this.hookCtx();
    const outcome: ToolOutcome = {
      success: !failed,
      ...(input.tool_response !== undefined ? { response: input.tool_response } : {}),
      ...(failed ? { error: typeof input.error === 'string' ? input.error : typeof input.tool_response === 'string' ? input.tool_response : 'Tool execution failed' } : {}),
      ...(typeof input.duration_ms === 'number' ? { durationMs: input.duration_ms } : {}),
    };
    const contexts: string[] = [];
    try {
      const r = await this.deps.hooks().runPostToolUse(ctx, call, outcome);
      this.warn(r.warnings);
      if (r.additionalContext) contexts.push(r.additionalContext);
    } catch (e) {
      this.deps.notify('warn', `postToolUse hooks failed: ${errText(e)}`);
    }
    if (!failed && FILE_WRITE_TOOLS.includes(call.claudeName)) {
      for (const subject of call.subjects) {
        const target = path.resolve(call.cwd || this.deps.ws.cwd, subject);
        const trigger = this.fileTrigger(call, target, inf?.existed, input.tool_response);
        try {
          const r = await this.deps.hooks().runFileHook(ctx, trigger, target, call);
          this.warn(r.warnings);
          if (r.additionalContext) contexts.push(r.additionalContext);
        } catch (e) {
          this.deps.notify('warn', `${trigger} hooks failed: ${errText(e)}`);
        }
      }
    }
    if (!failed && this.deps.onPostToolContext) {
      try {
        const extra = this.deps.onPostToolContext(call);
        if (extra) contexts.push(extra);
      } catch (e) {
        this.deps.notify('warn', `post-tool context failed: ${errText(e)}`);
      }
    }
    if (!contexts.length) return {};
    return {
      hookSpecificOutput: {
        hookEventName: failed ? 'PostToolUseFailure' : 'PostToolUse',
        additionalContext: contexts.join('\n\n'),
      },
    };
  }

  private fileTrigger(
    call: KiroToolCall,
    target: string,
    existed: Record<string, boolean> | undefined,
    response: unknown,
  ): 'PostFileCreate' | 'PostFileSave' {
    const known = existed?.[target];
    if (known !== undefined) return known ? 'PostFileSave' : 'PostFileCreate';
    if (call.claudeName === 'Write' && typeof response === 'object' && response !== null) {
      const t = (response as { type?: unknown }).type;
      if (t === 'create') return 'PostFileCreate';
    }
    return 'PostFileSave';
  }

  // ── can_use_tool ──

  /**
   * Answer a `can_use_tool` request. Prompts are serialized (one at a time); a request whose
   * `signal` aborts while waiting or prompting is denied with `interrupt: true`.
   */
  async canUseTool(
    req: CanUseToolRequest,
    ui: (r: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalResponse>,
    signal: AbortSignal,
  ): Promise<{ result: PermissionResult; redirectText?: string }> {
    const prev = this.promptChain;
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    this.promptChain = prev.then(() => mine);
    try {
      const aborted = await waitOrAbort(prev, signal);
      if (aborted || signal.aborted) return this.cancelled(req);
      return await this.answer(req, ui, signal);
    } finally {
      release();
    }
  }

  private cancelled(req: CanUseToolRequest): { result: PermissionResult } {
    this.inflight.delete(inflightKey(req.tool_use_id, req.tool_name, req.input));
    return { result: { behavior: 'deny', message: USER_CANCEL_MESSAGE, interrupt: true } };
  }

  private async answer(
    req: CanUseToolRequest,
    ui: (r: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalResponse>,
    signal: AbortSignal,
  ): Promise<{ result: PermissionResult; redirectText?: string }> {
    const input = req.input ?? {};
    const key = inflightKey(req.tool_use_id, req.tool_name, input);
    const inf = this.inflight.get(key);
    const call =
      inf?.call ??
      toKiroCall(req.tool_name, input, {
        cwd: this.deps.ws.cwd,
        ...(req.tool_use_id !== undefined ? { toolUseId: req.tool_use_id } : {}),
        ...(typeof req.agent_type === 'string' && req.agent_type
          ? { subagent: { ...(req.agent_id ? { id: req.agent_id } : {}), type: req.agent_type } }
          : {}),
        mcpServerNames: this.mcpNamesFor(req.mcp_server),
      });
    let s: StaticEval;
    try {
      s = this.evaluateStatic(call);
    } catch (e) {
      s = { kind: 'ask', reasons: [`gate error: ${errText(e)}`] };
    }
    if (s.kind === 'deny') {
      this.inflight.delete(key);
      if (s.policyDeny) this.safeOnDenied(call, s.reasons);
      return { result: { behavior: 'deny', message: s.reason ?? forbiddenMessage(call.v2Name) } };
    }
    if (s.kind === 'allow') return { result: { behavior: 'allow', updatedInput: input } };
    if (!this.deps.interactive) {
      this.inflight.delete(key);
      return { result: { behavior: 'deny', message: NON_INTERACTIVE_DENY } };
    }
    const request: ApprovalRequest = {
      call,
      requestId: typeof req.request_id === 'string' ? req.request_id : req.tool_use_id ?? '',
      reasons: s.reasons.length ? s.reasons : inf?.reasons ?? [],
      agentName: call.subagent?.type ?? this.safeAgentName(),
    };
    let resp: ApprovalResponse;
    try {
      resp = await ui(request, signal);
    } catch {
      resp = { kind: 'cancelled' };
    }
    if (signal.aborted) resp = { kind: 'cancelled' };
    switch (resp.kind) {
      case 'allow-once':
        return { result: { behavior: 'allow', updatedInput: input } };
      case 'allow-always':
        this.trustCall(call);
        return { result: { behavior: 'allow', updatedInput: input } };
      case 'deny':
        this.inflight.delete(key);
        return { result: { behavior: 'deny', message: resp.message ?? USER_DENY_MESSAGE } };
      case 'redirect':
        this.inflight.delete(key);
        return { result: { behavior: 'deny', message: USER_CANCEL_MESSAGE, interrupt: true }, redirectText: resp.text };
      default:
        this.inflight.delete(key);
        return { result: { behavior: 'deny', message: USER_CANCEL_MESSAGE, interrupt: true } };
    }
  }

  // ── hook callback dispatch ──

  /** Dispatch a `hook_callback` control request by `callback_id`. Unknown ids ⇒ `{}`. */
  async hookCallback(callbackId: string, input: HookInput): Promise<HookCallbackOutput> {
    switch (callbackId) {
      case GATE_CALLBACK_IDS.pre:
        return (await this.preToolUse(input)).output;
      case GATE_CALLBACK_IDS.post:
        return this.postToolUse(input, false);
      case GATE_CALLBACK_IDS.postFail:
        return this.postToolUse(input, true);
      default:
        return {};
    }
  }

  // ── trust helpers ──

  /** `t` / ACP allow_always: trust this tool for the session (V2 name + V3 session rule). */
  trustCall(call: KiroToolCall): void {
    const t = this.deps.trust;
    const name = call.mcp ? `@${call.mcp.server}/${call.mcp.tool}` : call.v2Name;
    unrevoke(t, name);
    if (!t.allowedTools.includes(name)) t.allowedTools.push(name);
    const rule = sessionRuleForName(name);
    if (rule && !t.rules.some((r) => sameRule(r, rule))) t.rules.push(rule);
  }

  /**
   * `/tools trust`, `--trust-tools`: normalize names (00 §4.3), append to session trust (and the
   * equivalent V3 session rule). Warns (Q text) for names that are neither native nor `@…`.
   * Empty names are ignored (`--trust-tools=` trusts nothing). Returns the normalized names.
   */
  trustTools(names: string[]): string[] {
    const t = this.deps.trust;
    const out: string[] = [];
    for (const raw of names) {
      const n = raw.trim();
      if (!n) continue;
      const norm = normalizeV2Name(n);
      if (!norm.startsWith('@') && !NATIVE_TOOL_NAMES.has(norm) && !norm.startsWith('mcp_')) {
        this.deps.notify('warn', trustToolsWarning(n));
      }
      unrevoke(t, norm);
      if (!t.allowedTools.includes(norm)) t.allowedTools.push(norm);
      const rule = sessionRuleForName(norm);
      if (rule && !t.rules.some((r) => sameRule(r, rule))) t.rules.push(rule);
      out.push(norm);
    }
    return out;
  }

  /**
   * `/tools untrust`: remove names from session trust (and their session rules), and revoke them
   * for the session when the agent's own allowedTools grants them (Q edits the in-memory agent,
   * 06 §1.1). Returns the names that were trusted.
   */
  untrustTools(names: string[]): string[] {
    const t = this.deps.trust;
    const agentAllowed = this.deps.agent().allowedTools ?? [];
    const removed: string[] = [];
    for (const raw of names) {
      const n = raw.trim();
      if (!n) continue;
      const norm = normalizeV2Name(n);
      const before = t.allowedTools.length;
      t.allowedTools = t.allowedTools.filter((x) => x !== norm && x !== n);
      const rule = sessionRuleForName(norm);
      const rulesBefore = t.rules.length;
      if (rule) t.rules = t.rules.filter((r) => !(r.scope === 'session' && sameRule(r, rule)));
      let revoked = false;
      if (agentAllowed.some((a) => a === n || a === norm || normalizeV2Name(a) === norm)) {
        const list = (t.revokedTools ??= []);
        if (!list.includes(norm)) {
          list.push(norm);
          revoked = true;
        }
      }
      if (t.allowedTools.length !== before || t.rules.length !== rulesBefore || revoked) removed.push(norm);
    }
    return removed;
  }

  /** `/tools trust-all`, `--trust-all-tools`. */
  setTrustAll(on: boolean): void {
    this.deps.trust.trustAll = on;
  }

  /** `/tools reset`: drop all session trust. */
  resetTrust(): void {
    const t = this.deps.trust;
    t.trustAll = false;
    t.allowedTools = [];
    t.rules = [];
    t.revokedTools = [];
  }

  /**
   * Permission label for `/tools` (06 §1.6 labels): `trusted`, `not trusted`, `denied`,
   * `trust working directory`, `read-only commands`, `trust read-only commands`,
   * `partially trusted`, `denied (plan mode)`.
   */
  describeTool(call: KiroToolCall): string {
    if (NEVER_EXPOSE_TOOLS.includes(call.claudeName)) return 'denied';
    if (this.deps.planMode() && call.mutating) return 'denied (plan mode)';
    const agent = this.deps.agent();
    return agent.dialect === 'v2' ? this.describeQ(call, agent) : this.describeV3(call, agent);
  }

  private describeQ(call: KiroToolCall, agent: KiroAgent): string {
    const t = this.trustFor(call);
    if (t.trustAll) return 'trusted';
    const allowed = effectiveAllowedTools(agent, t);
    if (call.mcp) {
      const auto = this.safeAutoApprove(call.mcp.server);
      return isToolInAllowlist(allowed, call.mcp.tool, call.mcp.server) || matchesAnyPattern(auto, call.mcp.tool) ? 'trusted' : 'not trusted';
    }
    const q = call.v2Name;
    const inAllow = (...ns: string[]): boolean => ns.some((n) => isToolInAllowlist(allowed, n));
    switch (q) {
      case 'fs_read':
      case 'glob':
      case 'grep': {
        if (inAllow(q, 'fs_read')) return 'trusted';
        const own = q === 'fs_read' ? undefined : toolSettings(agent, q);
        const s = own !== undefined ? own : toolSettings(agent, 'fs_read');
        return typeof s === 'object' && s !== null && (s as { allowReadOnly?: unknown }).allowReadOnly === true ? 'trusted' : 'trust working directory';
      }
      case 'execute_bash': {
        if (inAllow(q)) return 'trusted';
        const s = toolSettings(agent, 'execute_bash');
        return typeof s === 'object' && s !== null && (s as { autoAllowReadonly?: unknown }).autoAllowReadonly === true ? 'read-only commands' : 'not trusted';
      }
      case 'use_aws':
        return inAllow(q) ? 'trusted' : 'trust read-only commands';
      case 'todo_list':
      case 'tool_search':
      case 'skill':
        return 'trusted';
      default:
        return inAllow(q) ? 'trusted' : 'not trusted';
    }
  }

  private describeV3(call: KiroToolCall, agent: KiroAgent): string {
    if (isAlwaysAllowedTool(call.claudeName)) return 'trusted';
    const t = this.trustFor(call);
    const scopes = this.safeV3Scopes();
    const rules = collectRules({ agentRules: agent.permissions, ...scopes, sessionRules: t.rules, trustAll: t.trustAll }).filter(
      (r) => ruleAppliesTo(r, call) && this.ruleTargetsCall(r, call),
    );
    const wide = rules.filter((r) => !r.match?.length && !r.exclude?.length);
    if (wide.some((r) => r.effect === 'deny')) return 'denied';
    if (wide.some((r) => r.effect === 'ask' || r.effect === 'evaluate')) return 'not trusted';
    if (wide.some((r) => r.effect === 'allow')) return 'trusted';
    if (call.mcp && matchesAnyPattern(this.safeAutoApprove(call.mcp.server), call.mcp.tool)) return 'trusted';
    if (rules.some((r) => r.effect === 'allow')) return 'partially trusted';
    const defaults = V3_DEFAULT_RULES.filter((r) => ruleAppliesTo(r, call));
    if (call.capability === 'fs_read' && defaults.length) return 'trust working directory';
    if (call.capability === 'shell' && defaults.length) return 'read-only commands';
    if (defaults.some((r) => !r.match?.length && r.effect === 'allow')) return 'trusted';
    return 'not trusted';
  }

  /** For MCP calls, a capability-wide `mcp` rule targets every server; `srv/*` rules only that server. */
  private ruleTargetsCall(r: PermissionRule, call: KiroToolCall): boolean {
    if (!call.mcp || !r.match?.length) return true;
    return r.match.some((p) => p.startsWith(`${call.mcp!.server}/`) || p === '*' || p.startsWith('*'));
  }

  // ── static evaluation ──

  /** Everything after the preToolUse hooks (00 §5.1 steps 2–3). */
  private evaluateStatic(call: KiroToolCall): StaticEval {
    if (NEVER_EXPOSE_TOOLS.includes(call.claudeName)) {
      return { kind: 'deny', reason: `Tool ${call.claudeName} is not available in kiro-claude.`, reasons: ['not exposed'] };
    }
    const ws = this.deps.ws;
    const inv = checkInvariants(call, ws, this.deps.isIgnored ? { isIgnored: (p) => this.deps.isIgnored!(p) } : undefined);
    if (inv?.effect === 'deny') return { kind: 'deny', reason: inv.reason, reasons: [inv.reason] };
    if (this.deps.planMode() && call.mutating) return { kind: 'deny', reason: PLAN_MODE_DENY, reasons: [PLAN_MODE_DENY] };
    const sel = this.selectionDenial(call);
    if (sel) return { kind: 'deny', reason: sel, reasons: [sel] };
    let specAllowed = false;
    const phase = this.deps.specPhase();
    if (phase && call.capability === 'fs_write') {
      if (!this.specAllows(call, phase.allowedWritePaths)) {
        const paths = phase.allowedWritePaths.length ? phase.allowedWritePaths.join(', ') : '(nothing)';
        const reason = `Spec phase ${phase.name}: only ${paths} may be written now`;
        return { kind: 'deny', reason, reasons: [reason] };
      }
      specAllowed = true;
    }
    const { verdict, name } = this.evaluatePolicy(call);
    if (verdict.kind === 'deny') {
      return { kind: 'deny', reason: forbiddenMessage(name), reasons: verdict.reasons, policyDeny: true };
    }
    let kind: 'allow' | 'ask' = verdict.kind;
    let reasons = verdict.reasons;
    if (specAllowed && kind === 'ask') {
      kind = 'allow';
      reasons = [`spec phase ${phase!.name} may write this file`];
    }
    if (inv?.effect === 'ask') {
      kind = 'ask';
      reasons = [inv.reason, ...(verdict.kind === 'ask' ? verdict.reasons : [])];
    }
    return { kind, reasons };
  }

  private specAllows(call: KiroToolCall, allowedWritePaths: string[]): boolean {
    const ws = this.deps.ws;
    const base = ws.workspaceRoot || ws.cwd;
    return call.subjects.every((s) => {
      const c = canonicalizePath(s, call.cwd || ws.cwd, ws.env);
      return allowedWritePaths.some((e) => {
        if (hasGlobMeta(e, 'v3path')) {
          return globMatch(canonicalizePattern(e, base, ws.env, ws.home, 'v3path').pattern, c, 'v3path');
        }
        const abs = canonicalizePath(path.resolve(base, expandTilde(e, ws.env)), base, ws.env);
        return c === abs || isSubpath(c, abs);
      });
    });
  }

  /**
   * P1 enforcement of the agent's `tools` selection for MCP tools and subagents. Inside a
   * subagent the child Kiro agent's selection applies; a Claude built-in subagent type
   * (`general-purpose`, `Explore`, …) that is no Kiro agent inherits the parent's tools, so the
   * parent's selection applies to it.
   */
  private selectionDenial(call: KiroToolCall): string | undefined {
    let agent: KiroAgent | undefined;
    try {
      agent = call.subagent ? this.deps.resolveAgent(call.subagent.type) : undefined;
    } catch {
      agent = undefined;
    }
    if (!agent) {
      try {
        agent = this.deps.agent();
      } catch {
        agent = undefined;
      }
    }
    if (!agent) return undefined;
    if (call.mcp && !isMcpToolSelected(agent.tools, agent.excludedTools, call.mcp.server, call.mcp.tool)) {
      return `Tool @${call.mcp.server}/${call.mcp.tool} is not enabled for agent ${agent.name}`;
    }
    if (call.capability === 'subagent' && !call.mcp) {
      const name = call.subjects[0] ?? '';
      if (!isSubagentSelected(agent.tools, agent.excludedTools, name)) {
        return `Agent '${name}' is not available to agent ${agent.name}`;
      }
    }
    return undefined;
  }

  /** Parent agent and (inside a subagent) the child agent; the stricter verdict wins. */
  private evaluatePolicy(call: KiroToolCall): { verdict: PolicyVerdict; name: string } {
    const parent = this.deps.agent();
    const agents: KiroAgent[] = [parent];
    if (call.subagent) {
      let child: KiroAgent | undefined;
      try {
        child = this.deps.resolveAgent(call.subagent.type);
      } catch {
        child = undefined;
      }
      if (child && child !== parent && child.name !== parent.name) agents.push(child);
    }
    let worst: { verdict: PolicyVerdict; agent: KiroAgent } | undefined;
    for (const a of agents) {
      const v = this.evaluateFor(call, a);
      if (!worst || SEVERITY[v.kind] > SEVERITY[worst.verdict.kind]) worst = { verdict: v, agent: a };
      else if (SEVERITY[v.kind] === SEVERITY[worst.verdict.kind] && v.kind !== 'allow') {
        worst = { verdict: { kind: v.kind, reasons: [...new Set([...worst.verdict.reasons, ...v.reasons])] }, agent: worst.agent };
      }
    }
    const w = worst!;
    const name = w.agent.dialect === 'v3' ? call.v3Id ?? call.v2Name : call.v2Name;
    return { verdict: w.verdict, name };
  }

  private evaluateFor(call: KiroToolCall, agent: KiroAgent): PolicyVerdict {
    const ws = this.deps.ws;
    const trust = this.trustFor(call);
    const auto = call.mcp ? this.safeAutoApprove(call.mcp.server) : [];
    if (agent.dialect === 'v2') {
      return evaluateQ(call, agent, trust, ws, call.mcp ? { mcpAutoApprove: auto } : {});
    }
    const autoRules: PermissionRule[] =
      call.mcp && matchesAnyPattern(auto, call.mcp.tool)
        ? [{ capability: 'mcp', match: [`${call.mcp.server}/${call.mcp.tool}`], effect: 'allow', scope: 'workspace' }]
        : [];
    return evaluateCap(
      call,
      {
        agentRules: [...(agent.permissions ?? []), ...autoRules],
        ...this.safeV3Scopes(),
        sessionRules: trust.rules,
        trustAll: trust.trustAll,
      },
      ws,
    );
  }

  /** Session trust, plus V3-id spellings of MCP tools from `--trust-tools` (`mcp_srv_tool`). */
  private trustFor(call: KiroToolCall): SessionTrust {
    const t = this.deps.trust;
    if (!call.mcp || !call.v3Id || !t.allowedTools.includes(call.v3Id)) return t;
    const name = `@${call.mcp.server}/${call.mcp.tool}`;
    return {
      trustAll: t.trustAll,
      allowedTools: [...t.allowedTools, name],
      rules: [...t.rules, sessionRuleForName(name)!],
    };
  }

  // ── small helpers ──

  private callFromHookInput(input: HookInput): KiroToolCall {
    const sub = typeof input.agent_type === 'string' && input.agent_type ? input.agent_type : undefined;
    return toKiroCall(input.tool_name ?? '', (input.tool_input ?? {}) as Record<string, unknown>, {
      cwd: input.cwd || this.deps.ws.cwd,
      ...(input.tool_use_id !== undefined ? { toolUseId: input.tool_use_id } : {}),
      ...(sub ? { subagent: { ...(input.agent_id ? { id: input.agent_id } : {}), type: sub } } : {}),
      mcpServerNames: this.mcpNamesFor(input.mcp_server),
    });
  }

  private hookCtx(): HookRunContext {
    return { ws: this.deps.ws, sessionId: this.deps.sessionId() };
  }

  private async runPreHooks(call: KiroToolCall): Promise<{ blocked: boolean; blockReason?: string; additionalContext?: string } | undefined> {
    try {
      const r = await this.deps.hooks().runPreToolUse(this.hookCtx(), call);
      this.warn(r.warnings);
      return r;
    } catch (e) {
      this.deps.notify('warn', `preToolUse hooks failed: ${errText(e)}`);
      return undefined;
    }
  }

  private snapshotExistence(call: KiroToolCall): Record<string, boolean> | undefined {
    if (!FILE_WRITE_TOOLS.includes(call.claudeName)) return undefined;
    const out: Record<string, boolean> = {};
    for (const s of call.subjects) {
      const p = path.resolve(call.cwd || this.deps.ws.cwd, s);
      let e = false;
      try {
        e = fs.existsSync(p);
      } catch {
        e = false;
      }
      out[p] = e;
    }
    return out;
  }

  private remember(key: string, v: Inflight): void {
    this.inflight.delete(key);
    this.inflight.set(key, v);
    while (this.inflight.size > MAX_INFLIGHT) {
      const oldest = this.inflight.keys().next().value;
      if (oldest === undefined) break;
      this.inflight.delete(oldest);
    }
  }

  private warn(ws: readonly HookWarning[] | undefined): void {
    for (const w of ws ?? []) this.deps.notify('warn', w.message);
  }

  private safeOnDenied(call: KiroToolCall, reasons: string[]): void {
    try {
      this.deps.onDenied?.(call, reasons);
    } catch {
      /* UI callback errors never affect the decision */
    }
  }

  private safeMcpNames(): Record<string, string> {
    try {
      return this.deps.mcpServerNames() ?? {};
    } catch {
      return {};
    }
  }

  /**
   * deps.mcpServerNames(), plus the server named by Claude's `mcp_server.name` (hook /
   * can_use_tool input) when the map has no entry for its normalized form.
   */
  private mcpNamesFor(server: unknown): Record<string, string> {
    const names = this.safeMcpNames();
    const n = typeof server === 'object' && server !== null ? (server as { name?: unknown }).name : undefined;
    if (typeof n !== 'string' || n === '') return names;
    const key = claudeMcpName(n);
    return Object.prototype.hasOwnProperty.call(names, key) ? names : { ...names, [key]: n };
  }

  private safeAutoApprove(server: string): string[] {
    try {
      return this.deps.mcpAutoApprove(server) ?? [];
    } catch {
      return [];
    }
  }

  private safeV3Scopes(): { userRules: PermissionRule[]; workspaceRules: PermissionRule[]; presetRules: PermissionRule[] } {
    try {
      const s = this.deps.v3Scopes();
      return { userRules: s.userRules ?? [], workspaceRules: s.workspaceRules ?? [], presetRules: s.presetRules ?? [] };
    } catch {
      return { userRules: [], workspaceRules: [], presetRules: [] };
    }
  }

  private safeAgentName(): string {
    try {
      return this.deps.agent().name;
    } catch {
      return '';
    }
  }
}
