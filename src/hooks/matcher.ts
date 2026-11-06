/**
 * Hook matchers for both dialects and for file triggers.
 *
 * V2 / Q (`matchesV2`, 06 §3.6, `Q:cli/chat/cli/hooks.rs:55-85`, 02 §7.1), subject = Q tool name
 * (`call.v2Name`: `fs_read`, `execute_bash`, `@git/status`):
 *   1. no matcher ⇒ match; `"*"` ⇒ match;
 *   2. `"@builtin"` ⇒ the tool is not MCP (MCP = starts with `@` but not `@builtin`);
 *   3. MCP tool `@server/tool` and matcher === `@server` ⇒ match;
 *   4. Q `matchesAnyPattern([matcher], name)`: exact equality, or — only when the matcher contains
 *      `*` or `?` — a globset glob (`*`/`?` cross `/`; e.g. `fs_*`, `@git/<star>`, `@git-<star>/<star>`);
 *   5. Kiro 2.x additions: aliases (`fsRead`, `fsWrite`, `execute_cmd`, `executeCmd`, `aws`,
 *      `agent_crew`, `todo`, `task`) and groups (`read` = fs_read, grep, glob, code, introspect,
 *      tool_search; `write` = fs_write, code; `shell` = execute_bash; `web` = web_fetch,
 *      web_search; `subagent` = use_subagent) (02 §7.1, KD:cli/v3/hooks-migration).
 *
 * V3 (`matchesV3`, 02 §7.4), subjects = the V3 tool id (`read_file`, `execute_bash`,
 * `mcp_srv_tool`; for calls without a V3 id — Claude Task* todo tools, unknown tools — the Q
 * name is used, DECISION) plus its tags (`read`, `write`, `shell`, `web`, `subagent`, `context`,
 * `@builtin`, `@mcp`, `@srv`, `@srv/tool`):
 *   - no matcher / `""` / `"*"` ⇒ match;
 *   - matcher contains a regex metachar `\ ^ $ ( ) [ ] { } | +` ⇒ unanchored regex against the
 *     tool id(s) only;
 *   - otherwise a selector: equal to the id or a tag (case-insensitive for `@…` sources), or
 *     `*`/`?` wildcards against id and tags, or — also — an unanchored regex against the id
 *     (so `read` matches any id containing `read`, `.*invoke_sub_agent.*` works);
 *   - `execute_bash` and `execute_pwsh` match each other; an `Agent` call also answers to
 *     `subagent/<subagent_type>` (V3 per-agent dispatch id, DECISION).
 *   - Legacy IDE `toolTypes` (03 §2.6) may name IDE tools: with `{ideAliases:true}` the ids also
 *     include `fsWrite`/`fsAppend`/`strReplace` for writes, `readFile`, `fileSearch`, … and the bare
 *     MCP tool name.
 *
 * Regexes follow Rust `regex` syntax; {@link compileHookRegex} translates the common differences
 * (leading `(?flags)`, `\A`, `\z`, `(?P<name>…)`). Invalid regexes never match.
 *
 * File triggers (`matchesFileHook`, 03 §2.3): a V3 `matcher` is an unanchored regex tested against
 * both the workspace-relative POSIX path and the absolute path (match on either; which one Kiro
 * uses is UNVERIFIED). Legacy `when.patterns` are globs (`kind: 'glob'`, DECISION 00 §9 #14):
 * workspace-relative, `glob`-crate path dialect after brace expansion, and a glob without `/`
 * matches the basename; relative globs never match files outside the workspace root (only
 * absolute globs can). A V3 matcher that is not a valid regex (e.g. `*.ts`) falls back to glob.
 */

import * as path from 'node:path';
import type { KiroHook, KiroToolCall, WorkspaceContext } from '../types.js';
import { expandBraces, globMatch } from '../util/glob.js';
import { toPosixPath } from '../util/paths.js';

// ───────────────────────────── regex helper ─────────────────────────────

const regexCache = new Map<string, RegExp | null>();
const REGEX_CACHE_MAX = 512;

/**
 * Compile a Rust-`regex`-style pattern to an unanchored JS RegExp; `null` when invalid.
 * Translations: leading `(?i)`/`(?s)`/`(?m)` (flags), `\A` ⇒ `^`, `\z` ⇒ `$`, `(?P<n>` ⇒ `(?<n>`.
 */
export function compileHookRegex(src: string): RegExp | null {
  const hit = regexCache.get(src);
  if (hit !== undefined) return hit;
  let re: RegExp | null = null;
  let s = src;
  let flags = '';
  const lead = /^\(\?([imsxU]+)\)/.exec(s);
  if (lead) {
    for (const f of lead[1]!) if ('ims'.includes(f) && !flags.includes(f)) flags += f;
    s = s.slice(lead[0].length);
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length) {
      const nx = s[i + 1]!;
      if (nx === 'A') out += '^';
      else if (nx === 'z') out += '$';
      else out += ch + nx;
      i++;
      continue;
    }
    if (ch === '(' && s.startsWith('(?P<', i)) {
      out += '(?<';
      i += 3;
      continue;
    }
    out += ch;
  }
  try {
    re = new RegExp(out, `${flags}u`);
  } catch {
    try {
      re = new RegExp(out, flags);
    } catch {
      re = null;
    }
  }
  regexCache.set(src, re);
  if (regexCache.size > REGEX_CACHE_MAX) {
    const oldest = regexCache.keys().next().value;
    if (oldest !== undefined) regexCache.delete(oldest);
  }
  return re;
}

// ───────────────────────────── V2 / Q ─────────────────────────────

/** Kiro 2.x tool groups accepted as hook matchers (02 §7.1). */
export const V2_MATCHER_GROUPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  read: ['fs_read', 'grep', 'glob', 'code', 'introspect', 'tool_search'],
  write: ['fs_write', 'code'],
  shell: ['execute_bash'],
  web: ['web_fetch', 'web_search'],
  subagent: ['use_subagent'],
});

/** Kiro 2.x single-tool aliases (00 §4.3). */
export const V2_MATCHER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  fsRead: 'fs_read',
  fsWrite: 'fs_write',
  execute_cmd: 'execute_bash',
  executeCmd: 'execute_bash',
  aws: 'use_aws',
  agent_crew: 'use_subagent',
  todo: 'todo_list',
  task: 'todo_list',
});

/** Q `matchesAnyPattern` for one pattern: exact, else globset glob when `*`/`?` present (06 §1.2). */
export function qPatternMatches(pattern: string, text: string): boolean {
  if (pattern === text) return true;
  if (pattern.includes('*') || pattern.includes('?')) return globMatch(pattern, text, 'globset');
  return false;
}

function isQMcpName(name: string): boolean {
  return name.startsWith('@') && !name.startsWith('@builtin');
}

/** Q `hook_matches_tool` on a Q tool name (06 Appendix A `hookMatchesTool`) — no Kiro 2.x aliases. */
export function qHookMatchesTool(matcher: string | undefined | null, toolName: string): boolean {
  if (matcher === undefined || matcher === null) return true;
  if (matcher === '*') return true;
  if (matcher === '@builtin') return !isQMcpName(toolName);
  if (isQMcpName(toolName)) {
    const server = toolName.slice(1).split('/')[0];
    if (matcher === `@${server}`) return true;
  }
  return qPatternMatches(matcher, toolName);
}

/** V2 hook matcher (see module doc) against `call.v2Name`. */
export function matchesV2(matcher: string | undefined, call: KiroToolCall): boolean {
  const name = call.v2Name;
  if (qHookMatchesTool(matcher, name)) return true;
  if (matcher === undefined) return true;
  if (isQMcpName(name)) return false;
  const group = Object.prototype.hasOwnProperty.call(V2_MATCHER_GROUPS, matcher) ? V2_MATCHER_GROUPS[matcher] : undefined;
  if (group && group.includes(name)) return true;
  const alias = Object.prototype.hasOwnProperty.call(V2_MATCHER_ALIASES, matcher) ? V2_MATCHER_ALIASES[matcher] : undefined;
  return alias !== undefined && alias === name;
}

// ───────────────────────────── V3 ─────────────────────────────

/** Regex metacharacters that make a V3 matcher a regex (02 §7.4). */
export const V3_REGEX_META = /[\\^$()[\]{}|+]/;

/** IDE (0.x) tool names per V3 id, for legacy `toolTypes` regexes (03 §2.6). */
const IDE_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  read_file: ['readFile', 'readMultipleFiles'],
  list_directory: ['listDirectory'],
  file_search: ['fileSearch'],
  grep_search: ['grepSearch'],
  fs_write: ['fsWrite', 'fsAppend', 'strReplace'],
  str_replace: ['strReplace', 'fsWrite', 'fsAppend'],
  execute_bash: ['executeBash', 'executePwsh'],
  web_fetch: ['webFetch'],
  remote_web_search: ['webSearch', 'remoteWebSearch'],
  invoke_sub_agent: ['invokeSubAgent', 'use_subagent'],
});

/** Primary V3 id used for matching and payloads (`v3Id`, else the Q name; DECISION). */
export function v3ToolId(call: KiroToolCall): string {
  return call.v3Id ?? call.v2Name;
}

/** All ids a V3 matcher is tested against (see module doc). */
export function v3MatchIds(call: KiroToolCall, opts: { ideAliases?: boolean } = {}): string[] {
  const id = v3ToolId(call);
  const ids = [id];
  if (id === 'execute_bash') ids.push('execute_pwsh');
  else if (id === 'execute_pwsh') ids.push('execute_bash');
  if (id === 'invoke_sub_agent') {
    const t = call.input.subagent_type;
    ids.push(`subagent/${typeof t === 'string' && t !== '' ? t : 'general-purpose'}`);
  }
  if (opts.ideAliases) {
    for (const a of IDE_ALIASES[id] ?? []) if (!ids.includes(a)) ids.push(a);
    if (call.mcp && !ids.includes(call.mcp.tool)) ids.push(call.mcp.tool);
  }
  return ids;
}

function wildcardRegex(sel: string): RegExp {
  const body = sel.replace(/[.+^${}()|[\]\\/]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 's');
}

/** V3 hook matcher (02 §7.4, see module doc). */
export function matchesV3(matcher: string | undefined, call: KiroToolCall, opts: { ideAliases?: boolean } = {}): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  const ids = v3MatchIds(call, opts);
  if (V3_REGEX_META.test(matcher)) {
    const re = compileHookRegex(matcher);
    return re !== null && ids.some((id) => re.test(id));
  }
  // Selector.
  if (ids.includes(matcher) || call.tags.includes(matcher)) return true;
  if (matcher.startsWith('@')) {
    const lower = matcher.toLowerCase();
    if (call.tags.some((t) => t.toLowerCase() === lower)) return true;
  }
  if (matcher.includes('*') || matcher.includes('?')) {
    const w = wildcardRegex(matcher);
    if (ids.some((id) => w.test(id)) || call.tags.some((t) => w.test(t))) return true;
  }
  const re = compileHookRegex(matcher);
  return re !== null && ids.some((id) => re.test(id));
}

/** Any-of over legacy `when.toolTypes` entries (03 §2.3), with IDE aliases. Empty ⇒ match. */
export function matchesToolTypes(toolTypes: readonly string[], call: KiroToolCall): boolean {
  const list = toolTypes.filter((t) => t.trim() !== '');
  if (list.length === 0) return true;
  return list.some((t) => matchesV3(t.trim(), call, { ideAliases: true }));
}

// ───────────────────────────── file triggers ─────────────────────────────

/** Absolute and workspace-relative POSIX forms of `filePath`. */
export function filePathForms(filePath: string, ws: Pick<WorkspaceContext, 'cwd' | 'workspaceRoot'>): { abs: string; rel: string } {
  const abs = path.resolve(ws.cwd, filePath);
  const rel = toPosixPath(path.relative(ws.workspaceRoot, abs));
  return { abs: toPosixPath(abs), rel };
}

/** `rel` (from {@link filePathForms}) names a path outside the workspace root. */
function isOutsideWorkspace(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel);
}

/** Absolute glob (POSIX `/…` or Windows `C:/…`) after `\` ⇒ `/` normalization. */
function isAbsoluteGlob(g: string): boolean {
  return g.startsWith('/') || /^[A-Za-z]:\//.test(g);
}

/**
 * One legacy glob against a file (see module doc). Relative globs are workspace-relative, so
 * they never match files outside the workspace root (the IDE only reports workspace files);
 * absolute globs are tested against the absolute path. Case-insensitive on Windows.
 */
function fileGlobMatches(glob: string, forms: { abs: string; rel: string }): boolean {
  let alts: string[];
  try {
    alts = expandBraces(glob.trim());
  } catch {
    alts = [glob.trim()];
  }
  const opts = { windows: false, caseInsensitive: process.platform === 'win32' };
  const outside = isOutsideWorkspace(forms.rel);
  for (let g of alts) {
    g = g.replace(/\\/g, '/');
    if (g === '') continue;
    if (isAbsoluteGlob(g)) {
      if (globMatch(g, forms.abs, 'path', opts)) return true;
      // `/src/*.ts` may also mean "anchored at the workspace root" (gitignore style).
      if (!g.startsWith('/')) continue;
    }
    if (outside) continue;
    g = g.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (g === '') continue;
    if (!g.includes('/')) {
      const base = forms.rel.slice(forms.rel.lastIndexOf('/') + 1);
      if (globMatch(g, base, 'path', opts)) return true;
    } else if (globMatch(g, forms.rel, 'path', opts)) return true;
  }
  return false;
}

/**
 * File-trigger matcher. `kind: 'regex'` (V3 `matcher`, default): unanchored regex against the
 * relative or absolute path, falling back to glob semantics when the regex is invalid.
 * `kind: 'glob'` (legacy `when.patterns` entry): see module doc. No matcher ⇒ match.
 */
export function matchesFileHook(
  matcher: string | undefined,
  filePath: string,
  ws: Pick<WorkspaceContext, 'cwd' | 'workspaceRoot'>,
  kind: 'regex' | 'glob' = 'regex',
): boolean {
  if (matcher === undefined || matcher.trim() === '') return true;
  const forms = filePathForms(filePath, ws);
  if (kind === 'regex') {
    const re = compileHookRegex(matcher);
    if (re) return re.test(forms.rel) || re.test(forms.abs);
  }
  return fileGlobMatches(matcher, forms);
}

/** Any-of over legacy globs (`when.patterns`); empty list ⇒ match. */
export function matchesFileGlobs(globs: readonly string[], filePath: string, ws: Pick<WorkspaceContext, 'cwd' | 'workspaceRoot'>): boolean {
  const list = globs.filter((g) => g.trim() !== '');
  if (list.length === 0) return true;
  return list.some((g) => matchesFileHook(g, filePath, ws, 'glob'));
}

// ───────────────────────────── per hook ─────────────────────────────

/**
 * Optional list fields config/hooks.ts keeps on legacy hooks (`LoadedKiroHook`): the original
 * `when.toolTypes` / `when.patterns`. Read structurally so this module does not depend on config/.
 */
function stringList(hook: KiroHook, field: 'toolTypes' | 'filePatterns'): string[] | undefined {
  const v = (hook as unknown as Record<string, unknown>)[field];
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) return undefined;
  return v as string[];
}

/**
 * Does `hook` (a PreToolUse / PostToolUse hook) apply to `call`? Legacy `toolTypes` lists ⇒
 * any-of with IDE aliases; V2 ⇒ {@link matchesV2}; V3 ⇒ {@link matchesV3} (IDE aliases for
 * legacy-ide hooks).
 */
export function hookMatchesCall(hook: KiroHook, call: KiroToolCall): boolean {
  const tt = stringList(hook, 'toolTypes');
  if (tt) return matchesToolTypes(tt, call);
  if (hook.dialect === 'v2') return matchesV2(hook.matcher, call);
  return matchesV3(hook.matcher, call, { ideAliases: hook.source === 'legacy-ide' });
}

/**
 * Does a file-trigger `hook` apply to `filePath`? Legacy `filePatterns` ⇒ globs
 * ({@link matchesFileGlobs}); otherwise the `matcher` as a regex ({@link matchesFileHook}).
 */
export function hookMatchesFile(hook: KiroHook, filePath: string, ws: Pick<WorkspaceContext, 'cwd' | 'workspaceRoot'>): boolean {
  const pats = stringList(hook, 'filePatterns');
  if (pats) return matchesFileGlobs(pats, filePath, ws);
  return matchesFileHook(hook.matcher, filePath, ws, 'regex');
}
