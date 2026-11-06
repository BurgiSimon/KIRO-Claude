/**
 * Q / Kiro 2.x permission engine for V2 agents (06 §1.2–§1.6, 02 §2.6–§2.7, 00 §4.3).
 *
 * Inputs: the agent's `allowedTools` + session `allowedTools` (names normalized with
 * toolmap.normalizeV2Name, raw spellings kept too), `toolsSettings` (keys may be Kiro 2.x
 * aliases: `shell` ≡ `execute_bash`, `read` ≡ `fs_read`, …), and session `trustAll`.
 *
 * Per-tool evaluators (Q name of the call):
 *  - `execute_bash` (06 §1.4.1): no settings ⇒ allowlisted ? Allow : (non-empty ⇒ Ask).
 *    With settings: `deniedCommands` FIRST (anchored Rust regex `\A…\z`; an invalid deny regex
 *    denies every command with reason `\A.*\z`) — beats allowedTools, `t` and trust-all; then
 *    allowlisted ⇒ Allow; then readonly.requiresAcceptance (allowedCommands + autoAllowReadonly)
 *    ⇒ Ask, or Deny `not in allowed commands list` with `denyByDefault`.
 *  - `fs_read` (06 §1.4.2): settings evaluated even when absent; the cwd is ALWAYS allowed;
 *    deniedPaths ⇒ Deny (reasons = the original strings, repeated per matching glob); else
 *    Allow when allowlisted, `allowReadOnly`, or inside an allowedPath (gitignore-style,
 *    06 §1.5, globset dialect so `*` crosses `/`).
 *  - `glob` / `grep` (Claude Glob/Grep; 00 §4.3 DECISION): the fs_read evaluator on the call
 *    subjects (`path ?? cwd`, plus the literal root of a Glob pattern such as `/etc/**`, see
 *    toolmap.globPatternRoot) with `toolsSettings.glob|grep` when present, else
 *    `toolsSettings.fs_read`; allowlisted when the allowlist matches the Q name or `fs_read`.
 *  - `fs_write` (06 §1.4.3): no settings ⇒ allowlisted ? Allow : Ask; else deniedPaths ⇒ Deny,
 *    allowlisted or allowedPaths ⇒ Allow, else Ask (no cwd auto-allow).
 *  - `web_fetch` (02 §2.7, Kiro 2.x): `blocked` regexes first (invalid ⇒ deny all), then
 *    allowlisted, then `trusted` regexes (invalid ⇒ skipped) ⇒ Allow, else Ask.
 *  - `use_subagent` (02 §2.7): `availableAgents` globs (absent = all; not listed ⇒ Deny), then
 *    allowlisted or `trustedAgents` ⇒ Allow, else Ask.
 *  - MCP `@srv/tool` (06 §1.4): `isToolInAllowlist(allowed, tool, server)` or the server's
 *    mcp.json `autoApprove` (`"*"` = all tools) ⇒ Allow, else Ask.
 *  - `todo_list` ⇒ always Allow (06 §1.4). `skill` ⇒ Allow (DECISION: loading a skill's
 *    instructions is read-only; anything it runs is gated separately). `use_aws` has no Claude
 *    tool; {@link evalUseAws} is provided for completeness. Anything else ⇒ allowlisted ? Allow : Ask.
 * Malformed settings for a tool ⇒ Ask (06 §1.1). Finally (06 §1.6): Deny always wins;
 * `trustAll` turns every non-Deny result into Allow.
 */

import type { KiroAgent, KiroToolCall, PolicyVerdict, SessionTrust, WorkspaceContext } from '../types.js';
import { globMatch } from '../util/glob.js';
import { canonicalizePath, gitignoreGlobs, literalDirGlobs } from './pathmatch.js';
import { isToolInAllowlist, matchesAnyPattern } from './qmatch.js';
import { requiresAcceptance } from './readonly.js';
import { anchoredRustRegex } from './rustregex.js';
import { normalizeV2Name } from './toolmap.js';

export interface QEvalOptions {
  /** mcp.json `autoApprove` of the call's MCP server (configured name). */
  mcpAutoApprove?: string[];
}

const allow = (...reasons: string[]): PolicyVerdict => ({ kind: 'allow', reasons });
const ask = (...reasons: string[]): PolicyVerdict => ({ kind: 'ask', reasons });
const deny = (reasons: string[]): PolicyVerdict => ({ kind: 'deny', reasons });

/** toolsSettings keys accepted per Q tool (canonical first). */
const SETTINGS_KEYS: Record<string, string[]> = {
  execute_bash: ['execute_bash', 'shell', 'execute_cmd', 'executeCmd'],
  fs_read: ['fs_read', 'read', 'fsRead'],
  fs_write: ['fs_write', 'write', 'fsWrite'],
  glob: ['glob'],
  grep: ['grep'],
  use_aws: ['use_aws', 'aws'],
  web_fetch: ['web_fetch'],
  use_subagent: ['use_subagent', 'subagent', 'agent_crew'],
};

/** Raw `toolsSettings` value for a Q tool name (alias keys accepted), or undefined. */
export function toolSettings(agent: Pick<KiroAgent, 'toolsSettings'>, qName: string): unknown {
  const ts = agent.toolsSettings ?? {};
  const keys = Object.prototype.hasOwnProperty.call(SETTINGS_KEYS, qName) ? SETTINGS_KEYS[qName]! : [qName];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(ts, k)) return ts[k];
  }
  return undefined;
}

/**
 * Effective allow list: agent + session entries, raw and alias-normalized. Agent entries revoked
 * this session (`/tools untrust`, {@link SessionTrust.revokedTools}) are left out; session
 * entries always count.
 */
export function effectiveAllowedTools(
  agent: Pick<KiroAgent, 'allowedTools'>,
  trust: Pick<SessionTrust, 'allowedTools'> & Partial<Pick<SessionTrust, 'revokedTools'>>,
): string[] {
  const revoked = new Set(trust.revokedTools ?? []);
  const out = new Set<string>();
  const add = (n: string): void => {
    out.add(n);
    out.add(normalizeV2Name(n));
  };
  for (const n of agent.allowedTools ?? []) if (!revoked.has(n) && !revoked.has(normalizeV2Name(n))) add(n);
  for (const n of trust.allowedTools ?? []) add(n);
  return [...out];
}

// ───────────────────────────── settings parsing (serde-like) ─────────────────────────────

type Parsed<T> = { ok: true; value: T } | { ok: false };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strList(o: Record<string, unknown>, k: string): string[] | undefined | null {
  if (!Object.prototype.hasOwnProperty.call(o, k)) return undefined;
  const v = o[k];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null;
  return v as string[];
}

function bool(o: Record<string, unknown>, k: string): boolean | undefined | null {
  if (!Object.prototype.hasOwnProperty.call(o, k)) return undefined;
  const v = o[k];
  return typeof v === 'boolean' ? v : null;
}

function parseSettings<L extends string, B extends string>(
  raw: unknown,
  lists: readonly L[],
  bools: readonly B[],
): Parsed<{ [K in L]: string[] | undefined } & { [K in B]: boolean }> {
  if (!isObj(raw)) return { ok: false };
  const out: Record<string, unknown> = {};
  for (const k of lists) {
    const v = strList(raw, k);
    if (v === null) return { ok: false };
    out[k] = v;
  }
  for (const k of bools) {
    const v = bool(raw, k);
    if (v === null) return { ok: false };
    out[k] = v ?? false;
  }
  return { ok: true, value: out as { [K in L]: string[] | undefined } & { [K in B]: boolean } };
}

// ───────────────────────────── execute_bash ─────────────────────────────

/** Q `execute_bash` evaluator (06 §1.4.1). `allowed` = effective allowedTools. */
export function evalExecuteBash(cmd: string, allowed: readonly string[], rawSettings: unknown): PolicyVerdict {
  const inAllow = isToolInAllowlist(allowed, 'execute_bash');
  if (rawSettings === undefined) {
    if (inAllow) return allow('execute_bash is trusted');
    return requiresAcceptance(cmd, undefined, false) ? ask('execute_bash is not trusted') : allow('empty command');
  }
  const p = parseSettings(rawSettings, ['allowedCommands', 'deniedCommands'] as const, ['denyByDefault', 'autoAllowReadonly'] as const);
  if (!p.ok) return ask('invalid toolsSettings for execute_bash');
  const s = p.value;
  const denied: string[] = [];
  for (const dc of s.deniedCommands ?? []) {
    const re = anchoredRustRegex(dc);
    if (re === null) denied.push('\\A.*\\z'); // invalid regex ⇒ deny everything
    else if (re.test(cmd)) denied.push(`\\A${dc}\\z`);
  }
  if (denied.length) return deny(denied);
  if (inAllow) return allow('execute_bash is trusted');
  if (requiresAcceptance(cmd, s.allowedCommands ?? [], s.autoAllowReadonly)) {
    return s.denyByDefault ? deny(['not in allowed commands list']) : ask('command is not in the allowed commands list');
  }
  return allow('command is allowed by toolsSettings');
}

// ───────────────────────────── path evaluators ─────────────────────────────

interface GlobRule {
  glob: string;
  label: string;
}

function ruleGlobs(entries: readonly string[], ws: WorkspaceContext): GlobRule[] {
  const out: GlobRule[] = [];
  for (const e of entries) {
    const [a, b] = gitignoreGlobs(e, ws.cwd, ws.env, ws.home);
    out.push({ glob: a, label: e }, { glob: b, label: e });
  }
  return out;
}

function hits(rules: GlobRule[], subject: string): string[] {
  return rules.filter((r) => globMatch(r.glob, subject, 'globset')).map((r) => r.label);
}

/**
 * Q `fs_read` evaluator for one or more paths (06 §1.4.2). `inAllow` is the allowlist result;
 * `rawSettings` the (possibly absent) settings object, evaluated even when absent.
 */
export function evalFsReadPaths(
  paths: readonly string[],
  inAllow: boolean,
  rawSettings: unknown,
  ws: WorkspaceContext,
  toolLabel = 'fs_read',
): PolicyVerdict {
  const p = parseSettings(rawSettings ?? {}, ['allowedPaths', 'deniedPaths'] as const, ['allowReadOnly'] as const);
  if (!p.ok) return ask(`invalid toolsSettings for ${toolLabel}`);
  const s = p.value;
  const allowRules = ruleGlobs(s.allowedPaths ?? [], ws);
  const [c1, c2] = literalDirGlobs(ws.cwd); // cwd ALWAYS auto-allowed for reads
  allowRules.push({ glob: c1, label: ws.cwd }, { glob: c2, label: ws.cwd });
  const denyRules = ruleGlobs(s.deniedPaths ?? [], ws);
  const denyReasons: string[] = [];
  const outside: string[] = [];
  for (const raw of paths) {
    const c = canonicalizePath(raw, ws.cwd, ws.env);
    const d = hits(denyRules, c);
    if (d.length) {
      denyReasons.push(...d);
      continue;
    }
    if (!inAllow && !s.allowReadOnly && !allowRules.some((r) => globMatch(r.glob, c, 'globset'))) outside.push(c);
  }
  if (denyReasons.length) return deny(denyReasons);
  if (outside.length) return ask(...outside.map((o) => `${o} is outside the trusted paths for ${toolLabel}`));
  return allow(`${toolLabel} is allowed for this path`);
}

/** Q `fs_write` evaluator (06 §1.4.3). */
export function evalFsWritePath(filePath: string, inAllow: boolean, rawSettings: unknown, ws: WorkspaceContext): PolicyVerdict {
  if (rawSettings === undefined) return inAllow ? allow('fs_write is trusted') : ask('fs_write is not trusted');
  const p = parseSettings(rawSettings, ['allowedPaths', 'deniedPaths'] as const, [] as const);
  if (!p.ok) return ask('invalid toolsSettings for fs_write');
  const s = p.value;
  const c = canonicalizePath(filePath, ws.cwd, ws.env);
  const d = hits(ruleGlobs(s.deniedPaths ?? [], ws), c);
  if (d.length) return deny(d);
  if (inAllow) return allow('fs_write is trusted');
  if (ruleGlobs(s.allowedPaths ?? [], ws).some((r) => globMatch(r.glob, c, 'globset'))) return allow('path is in allowedPaths');
  return ask(`${c} is not in the allowed paths for fs_write`);
}

// ───────────────────────────── other evaluators ─────────────────────────────

/** Kiro 2.x `web_fetch` evaluator (`trusted` / `blocked` anchored regexes). */
export function evalWebFetch(url: string, inAllow: boolean, rawSettings: unknown): PolicyVerdict {
  if (rawSettings === undefined) return inAllow ? allow('web_fetch is trusted') : ask('web_fetch is not trusted');
  const p = parseSettings(rawSettings, ['trusted', 'blocked'] as const, [] as const);
  if (!p.ok) return ask('invalid toolsSettings for web_fetch');
  const denied: string[] = [];
  for (const b of p.value.blocked ?? []) {
    const re = anchoredRustRegex(b);
    if (re === null || re.test(url)) denied.push(b);
  }
  if (denied.length) return deny(denied);
  if (inAllow) return allow('web_fetch is trusted');
  if ((p.value.trusted ?? []).some((t) => anchoredRustRegex(t)?.test(url) ?? false)) return allow('URL is trusted');
  return ask('URL is not trusted');
}

/** Kiro 2.x `use_subagent` evaluator (`availableAgents` / `trustedAgents` globs). */
export function evalSubagent(agentName: string, inAllow: boolean, rawSettings: unknown): PolicyVerdict {
  if (rawSettings === undefined) return inAllow ? allow('use_subagent is trusted') : ask('use_subagent is not trusted');
  const p = parseSettings(rawSettings, ['availableAgents', 'trustedAgents'] as const, [] as const);
  if (!p.ok) return ask('invalid toolsSettings for use_subagent');
  const { availableAgents, trustedAgents } = p.value;
  if (availableAgents !== undefined && !matchesAnyPattern(availableAgents, agentName)) {
    return deny([`${agentName} is not in availableAgents`]);
  }
  if (inAllow) return allow('use_subagent is trusted');
  if (trustedAgents && matchesAnyPattern(trustedAgents, agentName)) return allow('agent is trusted');
  return ask(`agent ${agentName} is not trusted`);
}

/** Q `use_aws` evaluator (06 §1.4.4); no Claude tool maps to it, kept for completeness. */
export function evalUseAws(
  t: { service_name: string; operation_name: string },
  inAllow: boolean,
  rawSettings: unknown,
): PolicyVerdict {
  if (rawSettings === undefined) return inAllow ? allow('use_aws is trusted') : ask('use_aws is not trusted');
  const p = parseSettings(rawSettings, ['allowedServices', 'deniedServices'] as const, ['autoAllowReadonly'] as const);
  if (!p.ok) return ask('invalid toolsSettings for use_aws');
  const s = p.value;
  if ((s.deniedServices ?? []).includes(t.service_name)) return deny([t.service_name]);
  if (inAllow || (s.allowedServices ?? []).includes(t.service_name)) return allow('service is allowed');
  if (s.autoAllowReadonly && ['get', 'describe', 'list', 'ls', 'search', 'batch_get'].some((op) => t.operation_name.startsWith(op))) {
    return allow('read-only operation');
  }
  return ask('use_aws is not trusted');
}

// ───────────────────────────── dispatcher ─────────────────────────────

/** Raw evaluator result (before trust-all) for a call under a V2 agent. */
export function evaluateQRaw(
  call: KiroToolCall,
  agent: KiroAgent,
  trust: SessionTrust,
  ws: WorkspaceContext,
  opts: QEvalOptions = {},
): PolicyVerdict {
  const allowed = effectiveAllowedTools(agent, trust);
  if (call.mcp) {
    const { server, tool } = call.mcp;
    if (isToolInAllowlist(allowed, tool, server)) return allow(`@${server}/${tool} is trusted`);
    if (opts.mcpAutoApprove && matchesAnyPattern(opts.mcpAutoApprove, tool)) return allow(`${tool} is auto-approved by mcp.json`);
    return ask(`@${server}/${tool} is not trusted`);
  }
  const q = call.v2Name;
  const inAllow = (...names: string[]): boolean => names.some((n) => isToolInAllowlist(allowed, n));
  switch (q) {
    case 'execute_bash':
      return evalExecuteBash(typeof call.input.command === 'string' ? call.input.command : '', allowed, toolSettings(agent, 'execute_bash'));
    case 'fs_read':
      return evalFsReadPaths(call.subjects, inAllow('fs_read'), toolSettings(agent, 'fs_read'), ws, 'fs_read');
    case 'glob':
    case 'grep': {
      const own = toolSettings(agent, q);
      return evalFsReadPaths(call.subjects, inAllow(q, 'fs_read'), own !== undefined ? own : toolSettings(agent, 'fs_read'), ws, q);
    }
    case 'fs_write': {
      const raw = toolSettings(agent, 'fs_write');
      const ia = inAllow('fs_write');
      let worst: PolicyVerdict = allow('fs_write is allowed');
      for (const s of call.subjects) {
        const r = evalFsWritePath(s, ia, raw, ws);
        if (r.kind === 'deny') return r;
        if (r.kind === 'ask') worst = r;
      }
      return worst;
    }
    case 'web_fetch':
      return evalWebFetch(call.subjects[0] ?? '', inAllow('web_fetch'), toolSettings(agent, 'web_fetch'));
    case 'web_search':
      return inAllow('web_search') ? allow('web_search is trusted') : ask('web_search is not trusted');
    case 'use_subagent':
      return evalSubagent(call.subjects[0] ?? '', inAllow('use_subagent'), toolSettings(agent, 'use_subagent'));
    case 'todo_list':
      return allow('todo_list is always allowed');
    case 'tool_search':
      return allow('tool_search is always allowed');
    case 'skill':
      return allow('skills are always allowed');
    default:
      return inAllow(q) ? allow(`${q} is trusted`) : ask(`${q} is not trusted`);
  }
}

/**
 * Q decision for one call under a V2 agent (06 §1.6): the evaluator result, except that
 * `trust.trustAll` turns Ask into Allow (Deny always wins).
 */
export function evaluateQ(
  call: KiroToolCall,
  agent: KiroAgent,
  trust: SessionTrust,
  ws: WorkspaceContext,
  opts: QEvalOptions = {},
): PolicyVerdict {
  const r = evaluateQRaw(call, agent, trust, ws, opts);
  if (r.kind === 'deny') return r;
  if (trust.trustAll && r.kind === 'ask') return allow('all tools are trusted (trust-all)');
  return r;
}
