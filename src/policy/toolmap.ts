/**
 * Claude Code ⇄ Kiro tool mapping (00 §4.1 master table, §4.2 selectors, §4.3 names).
 *
 * {@link toKiroCall} describes one Claude tool call in Kiro terms: V2/Q name (`fs_read`,
 * `execute_bash`, `@srv/tool`), Kiro 2.x name (`read`, `shell`), V3 id (`read_file`,
 * `invoke_sub_agent`, `mcp_srv_tool`), V3 tags, permission capability and policy subjects.
 *
 * | Claude | V3 id | tags | capability / subject | 2.x name | Q name | display |
 * |---|---|---|---|---|---|---|
 * | Read | read_file | read | fs_read / abs file_path | read | fs_read | read |
 * | Glob | file_search | read | fs_read / path ?? cwd (+ pattern root) | glob | glob | glob |
 * | Grep | grep_search | read | fs_read / path ?? cwd | grep | grep | grep |
 * | Write | fs_write | write | fs_write / abs file_path | write | fs_write | write |
 * | Edit, MultiEdit | str_replace | write | fs_write / abs file_path | write | fs_write | write |
 * | NotebookEdit | fs_write | write | fs_write / abs notebook_path | write | fs_write | write |
 * | Bash | execute_bash | shell | shell / each sub-command | shell | execute_bash | shell |
 * | WebFetch | web_fetch | web | web_fetch / url | web_fetch | web_fetch | web_fetch |
 * | WebSearch | remote_web_search | web | web_search / query | web_search | web_search | web_search |
 * | Agent, Task | invoke_sub_agent | subagent | subagent / subagent_type | subagent | use_subagent | subagent |
 * | Task* (TaskCreate…) | — | — | utility (always allowed) | todo_list | todo_list | todo_list |
 * | Skill | disclose_context | context | skill / skill name | skill | skill | skill |
 * | mcp__srv__tool | mcp_srv_tool | @mcp, @srv, @srv/tool | mcp / srv/tool | @srv/tool | @srv/tool | tool |
 * | mcp__… that cannot be split | — | @mcp | mcp / name without `mcp__` | <claude name> | <claude name> | <claude name> |
 * | anything else | — | — | utility | <claude name> | <claude name> | <claude name> |
 *
 * Every non-MCP call also carries the tag `@builtin`. Agent calls carry tag `subagent` (the V2
 * `tool_tags` of `use_subagent`; V3 `subagent/<name>` tools have that tag too) — DECISION.
 * Shell subjects come from util/shlex.splitCompoundCommand (raw segments, quotes kept; the
 * capability engine normalizes them for matching); an unsplittable command yields the whole
 * command as the only subject and `parseable: false`.
 *
 * {@link expandToolSelectors} turns an agent's `tools` / `excludedTools` into the `claude`
 * argv pieces (`--tools`, `--mcp-config` servers, `--disallowedTools`, `--agents` filter).
 */

import * as path from 'node:path';
import type { Capability, KiroToolCall } from '../types.js';
import { expandTilde } from '../util/paths.js';
import { splitCompoundCommand } from '../util/shlex.js';
import { matchesAnyPattern } from './qmatch.js';

/** The `@builtin` / `*` expansion (00 §4.2), in canonical `--tools` order (Skill is added separately). */
export const BUILTIN_CLAUDE_TOOLS: readonly string[] = Object.freeze([
  'Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Agent',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
]);

/** Claude's skill tool; exposed only when at least one Kiro skill is loaded. */
export const SKILL_CLAUDE_TOOL = 'Skill';

/** Claude todo tools (`todo_list` family). */
export const TODO_CLAUDE_TOOLS: readonly string[] = Object.freeze(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

/**
 * Claude tools kiro-claude never passes in `--tools` (they would bypass Kiro semantics: Claude's
 * own plan mode, interactive questions, worktrees, schedulers, messaging). `ToolSearch` is exposed
 * only when an agent selects Kiro's `tool_search` (KiroCrew's specs do; 08 KC-SPEC-02).
 */
export const NEVER_EXPOSE_TOOLS: readonly string[] = Object.freeze([
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
  'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'PushNotification', 'SendMessage',
  'TeamCreate', 'TeamDelete',
]);

const CANONICAL_ORDER = [...BUILTIN_CLAUDE_TOOLS, SKILL_CLAUDE_TOOL, 'ToolSearch'];

interface Row {
  v3Id?: string;
  tag?: string;
  capability: Capability;
  kiro2Name: string;
  v2Name: string;
  display: string;
}

const ROWS: Record<string, Row> = {
  Read: { v3Id: 'read_file', tag: 'read', capability: 'fs_read', kiro2Name: 'read', v2Name: 'fs_read', display: 'read' },
  Glob: { v3Id: 'file_search', tag: 'read', capability: 'fs_read', kiro2Name: 'glob', v2Name: 'glob', display: 'glob' },
  Grep: { v3Id: 'grep_search', tag: 'read', capability: 'fs_read', kiro2Name: 'grep', v2Name: 'grep', display: 'grep' },
  Write: { v3Id: 'fs_write', tag: 'write', capability: 'fs_write', kiro2Name: 'write', v2Name: 'fs_write', display: 'write' },
  Edit: { v3Id: 'str_replace', tag: 'write', capability: 'fs_write', kiro2Name: 'write', v2Name: 'fs_write', display: 'write' },
  MultiEdit: { v3Id: 'str_replace', tag: 'write', capability: 'fs_write', kiro2Name: 'write', v2Name: 'fs_write', display: 'write' },
  NotebookEdit: { v3Id: 'fs_write', tag: 'write', capability: 'fs_write', kiro2Name: 'write', v2Name: 'fs_write', display: 'write' },
  Bash: { v3Id: 'execute_bash', tag: 'shell', capability: 'shell', kiro2Name: 'shell', v2Name: 'execute_bash', display: 'shell' },
  WebFetch: { v3Id: 'web_fetch', tag: 'web', capability: 'web_fetch', kiro2Name: 'web_fetch', v2Name: 'web_fetch', display: 'web_fetch' },
  WebSearch: { v3Id: 'remote_web_search', tag: 'web', capability: 'web_search', kiro2Name: 'web_search', v2Name: 'web_search', display: 'web_search' },
  Agent: { v3Id: 'invoke_sub_agent', tag: 'subagent', capability: 'subagent', kiro2Name: 'subagent', v2Name: 'use_subagent', display: 'subagent' },
  Task: { v3Id: 'invoke_sub_agent', tag: 'subagent', capability: 'subagent', kiro2Name: 'subagent', v2Name: 'use_subagent', display: 'subagent' },
  ToolSearch: { capability: 'utility', kiro2Name: 'tool_search', v2Name: 'tool_search', display: 'tool_search' },
  Skill: { v3Id: 'disclose_context', tag: 'context', capability: 'skill', kiro2Name: 'skill', v2Name: 'skill', display: 'skill' },
};

const TODO_ROW: Row = { capability: 'utility', kiro2Name: 'todo_list', v2Name: 'todo_list', display: 'todo_list' };

/** Claude tools that write a file named by their input (file hooks, invariants). */
export const FILE_WRITE_TOOLS: readonly string[] = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`, `TaskStop`, `TaskOutput`, … and the legacy `TodoWrite`. */
export function isTodoTool(claudeName: string): boolean {
  return /^Task[A-Z][A-Za-z]*$/.test(claudeName) || claudeName === 'TodoWrite';
}

/**
 * Tools every agent may use without a permission check: the todo tools and `ToolSearch`
 * (Kiro `tool_search`), which only loads deferred tool schemas and runs nothing.
 */
export function isAlwaysAllowedTool(claudeName: string): boolean {
  return isTodoTool(claudeName) || claudeName === 'ToolSearch';
}

/** Claude's MCP name normalization: characters outside `[A-Za-z0-9_-]` become `_` (TYPED). */
export function claudeMcpName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * V3 tool id of an MCP tool (00 §4.1, 02 §3.3): `mcp_` + lowercase(`<srv>_<tool>` with
 * whitespace and `-` → `_`, other characters outside `[A-Za-z0-9_]` dropped), at most 64 chars.
 */
export function v3IdForMcp(server: string, tool: string): string {
  const body = `${server}_${tool}`
    .replace(/[\s-]/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .toLowerCase();
  return `mcp_${body}`.slice(0, 64);
}

const V2_ALIASES: Record<string, string> = {
  // Kiro 2.x aliases (00 §4.3)
  read: 'fs_read',
  fsRead: 'fs_read',
  write: 'fs_write',
  fsWrite: 'fs_write',
  shell: 'execute_bash',
  execute_cmd: 'execute_bash',
  executeCmd: 'execute_bash',
  aws: 'use_aws',
  subagent: 'use_subagent',
  agent_crew: 'use_subagent',
  todo: 'todo_list',
  task: 'todo_list',
  // V3 tool ids (00 §4.1 column 2) so V3-style `--trust-tools` names work too
  read_file: 'fs_read',
  list_directory: 'fs_read',
  str_replace: 'fs_write',
  fs_append: 'fs_write',
  delete_file: 'fs_write',
  file_search: 'glob',
  grep_search: 'grep',
  remote_web_search: 'web_search',
  invoke_sub_agent: 'use_subagent',
  execute_pwsh: 'execute_bash',
  disclose_context: 'skill',
};

/**
 * Normalize a Kiro 2.x / V3 tool name to the Q name the V2 engine evaluates (00 §4.3):
 * `read|fsRead→fs_read`, `write|fsWrite→fs_write`, `shell|execute_cmd|executeCmd→execute_bash`,
 * `aws→use_aws`, `subagent|agent_crew→use_subagent`, `todo|task→todo_list`; V3 ids map via the
 * master table (`read_file→fs_read`, `str_replace→fs_write`, `file_search→glob`, …);
 * `glob`, `grep`, `web_fetch`, `web_search`, `@…` and unknown names are kept. `@builtin/<x>`
 * normalizes `<x>`.
 */
export function normalizeV2Name(name: string): string {
  if (name.startsWith('@builtin/')) {
    const rest = name.slice('@builtin/'.length);
    return rest === '' || rest === '*' ? name : `@builtin/${normalizeV2Name(rest)}`;
  }
  if (name.startsWith('@')) return name;
  return Object.prototype.hasOwnProperty.call(V2_ALIASES, name) ? V2_ALIASES[name]! : name;
}

export interface ToKiroCallContext {
  cwd: string;
  toolUseId?: string;
  subagent?: { id?: string; type: string };
  /** Claude-normalized MCP server name → configured Kiro server name. */
  mcpServerNames?: Record<string, string>;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function absPath(p: string | undefined, cwd: string): string {
  return path.resolve(cwd, expandTilde(p ?? ''));
}

function oneLine(s: string, max = 200): string {
  const first = s.split(/\r?\n/)[0] ?? '';
  const multi = first.length !== s.length;
  const t = first.length > max ? `${first.slice(0, max - 1)}…` : first;
  return multi ? `${t} …` : t;
}

function jsonSummary(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? '';
  } catch {
    s = '';
  }
  return oneLine(s);
}

const GLOB_META = /[*?[\]{}]/;

/**
 * Directory a Glob `pattern` actually searches when that differs from the search root: the
 * literal leading components of `pattern` resolved against `searchRoot` (an absolute
 * `/etc/**`, a `~/…` or `../…` pattern escapes the root; `private/**` narrows it). It becomes
 * an extra fs_read subject (DECISION; 00 §4.1 lists only `path ?? cwd`), so that
 * `Glob {pattern: "/etc/**"}` is not judged as a search of the cwd and deny rules /
 * `.kiroignore` entries for a subdirectory apply to patterns that point into it. Extra
 * subjects only make the verdict stricter (every subject must pass).
 */
export function globPatternRoot(pattern: string, searchRoot: string): string | undefined {
  if (pattern === '') return undefined;
  const expanded = expandTilde(pattern);
  // Only the PATTERN's own components are glob syntax: the search root is literal (a workspace
  // under `proj [old]/` must not look like a pattern that escapes to its parent).
  const comps = expanded.split('/');
  const lit: string[] = [];
  for (const c of comps) {
    if (GLOB_META.test(c)) break;
    lit.push(c);
  }
  const root = path.resolve(searchRoot);
  const litPath = lit.join('/');
  const base = path.isAbsolute(expanded) && litPath === '' ? '/' : path.resolve(root, litPath || '.');
  // a fully literal pattern names a file (its directory is what is searched) unless it ends
  // with `/`, which names the directory itself
  const prefix = lit.length === comps.length && !expanded.endsWith('/') ? path.dirname(base) : base;
  return prefix === root ? undefined : prefix;
}

/** Split `mcp__<srv>__<tool>` (first `__` after the prefix; known server names win). */
export function splitMcpName(
  claudeName: string,
  mcpServerNames?: Record<string, string>,
): { claudeServer: string; tool: string } | undefined {
  if (!claudeName.startsWith('mcp__')) return undefined;
  const rest = claudeName.slice(5);
  let best: string | undefined;
  for (const k of Object.keys(mcpServerNames ?? {})) {
    if (rest.startsWith(`${k}__`) && (best === undefined || k.length > best.length)) best = k;
  }
  if (best !== undefined) return { claudeServer: best, tool: rest.slice(best.length + 2) };
  const i = rest.indexOf('__');
  if (i <= 0) return undefined;
  return { claudeServer: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/** Describe one Claude tool call in Kiro terms (00 §4.1). Pure except for `~` expansion. */
export function toKiroCall(claudeName: string, input: Record<string, unknown>, ctx: ToKiroCallContext): KiroToolCall {
  const cwd = ctx.cwd;
  const base = {
    claudeName,
    input,
    cwd,
    ...(ctx.toolUseId !== undefined ? { toolUseId: ctx.toolUseId } : {}),
    ...(ctx.subagent ? { subagent: { ...ctx.subagent } } : {}),
  };

  const mcp = splitMcpName(claudeName, ctx.mcpServerNames);
  if (mcp) {
    const names = ctx.mcpServerNames;
    // own properties only: a server called `constructor` must not resolve to Object.prototype's
    const mapped = names && Object.prototype.hasOwnProperty.call(names, mcp.claudeServer) ? names[mcp.claudeServer] : undefined;
    const server = typeof mapped === 'string' && mapped !== '' ? mapped : mcp.claudeServer;
    const tool = mcp.tool;
    return {
      ...base,
      v2Name: `@${server}/${tool}`,
      kiro2Name: `@${server}/${tool}`,
      v3Id: v3IdForMcp(server, tool),
      tags: ['@mcp', `@${server}`, `@${server}/${tool}`],
      capability: 'mcp',
      subjects: [`${server}/${tool}`],
      parseable: true,
      mcp: { server, tool },
      mutating: true,
      displayName: tool,
      summary: jsonSummary(input),
    };
  }

  if (isTodoTool(claudeName)) {
    const subject = str(input.subject) ?? str(input.taskId) ?? '';
    return {
      ...base,
      v2Name: TODO_ROW.v2Name,
      kiro2Name: TODO_ROW.kiro2Name,
      tags: ['@builtin'],
      capability: 'utility',
      subjects: [],
      parseable: true,
      mutating: false,
      displayName: TODO_ROW.display,
      summary: oneLine(subject),
    };
  }

  if (claudeName.startsWith('mcp__')) {
    // An MCP-shaped name that cannot be split (`mcp__srv`, `mcp____x`): never a harmless utility
    // tool — treat it as an unidentified MCP call (asks by default, denied in plan mode).
    return {
      ...base,
      v2Name: claudeName,
      kiro2Name: claudeName,
      tags: ['@mcp'],
      capability: 'mcp',
      subjects: [claudeName.slice('mcp__'.length)],
      parseable: true,
      mutating: true,
      displayName: claudeName,
      summary: jsonSummary(input),
    };
  }

  const row = Object.prototype.hasOwnProperty.call(ROWS, claudeName) ? ROWS[claudeName] : undefined;
  if (!row) {
    return {
      ...base,
      v2Name: claudeName,
      kiro2Name: claudeName,
      tags: ['@builtin'],
      capability: 'utility',
      subjects: [],
      parseable: true,
      mutating: false,
      displayName: claudeName,
      summary: jsonSummary(input),
    };
  }

  let subjects: string[] = [];
  let parseable = true;
  let summary = '';
  switch (claudeName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const p = absPath(str(input.file_path), cwd);
      subjects = [p];
      summary = p;
      break;
    }
    case 'NotebookEdit': {
      const p = absPath(str(input.notebook_path), cwd);
      subjects = [p];
      summary = p;
      break;
    }
    case 'Glob':
    case 'Grep': {
      const p = absPath(str(input.path) ?? cwd, cwd);
      subjects = [p];
      const pat = str(input.pattern) ?? '';
      if (claudeName === 'Glob') {
        const escape = globPatternRoot(pat, p);
        if (escape !== undefined) subjects.push(escape);
      }
      summary = oneLine(str(input.path) ? `${pat} in ${p}` : pat);
      break;
    }
    case 'Bash': {
      const cmd = str(input.command) ?? '';
      const parts = splitCompoundCommand(cmd);
      if (parts === null) {
        parseable = false;
        subjects = [cmd];
      } else {
        subjects = parts.length ? parts : [cmd.trim()];
      }
      summary = oneLine(cmd);
      break;
    }
    case 'WebFetch': {
      const u = str(input.url) ?? '';
      subjects = [u];
      summary = oneLine(u);
      break;
    }
    case 'WebSearch': {
      const q = str(input.query) ?? '';
      subjects = [q];
      summary = oneLine(q);
      break;
    }
    case 'Agent':
    case 'Task': {
      const t = str(input.subagent_type) || 'general-purpose';
      subjects = [t];
      const d = str(input.description);
      summary = oneLine(d ? `${t}: ${d}` : t);
      break;
    }
    case 'Skill': {
      const raw = str(input.skill) ?? '';
      const name = raw.startsWith('kiro:') ? raw.slice(5) : raw;
      subjects = [name];
      summary = oneLine(name);
      break;
    }
  }
  const cap = row.capability;
  return {
    ...base,
    v2Name: row.v2Name,
    kiro2Name: row.kiro2Name,
    ...(row.v3Id !== undefined ? { v3Id: row.v3Id } : {}),
    tags: [...(row.tag ? [row.tag] : []), '@builtin'],
    capability: cap,
    subjects,
    parseable,
    mutating: cap === 'fs_write' || cap === 'shell' || cap === 'mcp' || cap === 'subagent',
    displayName: row.display,
    summary,
  };
}

/**
 * Classic display label (06 §5.4, 01 §4.7): `<displayName>` for built-ins,
 * `<tool> from mcp server <server>` for MCP tools. With `trusted`, the ` (trusted)` marker is
 * placed where Classic prints it — BEFORE the server part:
 * `<displayName>[ (trusted)][ from mcp server <server>]` (uncoloured; UIs colour the parts).
 */
export function toolDisplay(call: KiroToolCall, trusted = false): string {
  const mark = trusted ? ' (trusted)' : '';
  if (call.mcp) return `${call.mcp.tool}${mark} from mcp server ${call.mcp.server}`;
  return `${call.displayName}${mark}`;
}

// ───────────────────────────── selector expansion (00 §4.2) ─────────────────────────────

const READ_GROUP = ['Read', 'Glob', 'Grep'];
const WRITE_GROUP = ['Write', 'Edit', 'NotebookEdit'];

/** Built-in selectors (V2 names, Kiro 2.x aliases, V3 tags and ids) → Claude tools. */
const BUILTIN_SELECTORS: Record<string, readonly string[]> = {
  read: READ_GROUP,
  fs_read: READ_GROUP,
  fsRead: READ_GROUP,
  read_file: ['Read'],
  list_directory: ['Glob'],
  file_search: ['Glob'],
  glob: ['Glob'],
  grep_search: ['Grep'],
  grep: ['Grep'],
  write: WRITE_GROUP,
  fs_write: WRITE_GROUP,
  fsWrite: WRITE_GROUP,
  str_replace: WRITE_GROUP,
  fs_append: WRITE_GROUP,
  delete_file: WRITE_GROUP,
  shell: ['Bash'],
  execute_bash: ['Bash'],
  execute_cmd: ['Bash'],
  executeCmd: ['Bash'],
  execute_pwsh: ['Bash'],
  web: ['WebFetch', 'WebSearch'],
  web_fetch: ['WebFetch'],
  remote_web_search: ['WebSearch'],
  web_search: ['WebSearch'],
  tool_search: ['ToolSearch'],
  subagent: ['Agent'],
  invoke_sub_agent: ['Agent'],
  use_subagent: ['Agent'],
  agent_crew: ['Agent'],
  todo_list: TODO_CLAUDE_TOOLS,
  todo: TODO_CLAUDE_TOOLS,
  task: TODO_CLAUDE_TOOLS,
  skill: [SKILL_CLAUDE_TOOL],
  disclose_context: [SKILL_CLAUDE_TOOL],
  context: [SKILL_CLAUDE_TOOL],
};

/** Selectors that start any subagent (`invoke_sub_agent` can start every agent). */
const ALL_SUBAGENT_SELECTORS = new Set(['subagent', 'invoke_sub_agent', 'use_subagent', 'agent_crew']);

/** Kiro tools with no Claude equivalent: selecting them exposes nothing (warn). */
const IGNORED_SELECTORS = new Set(['code', 'introspect', 'session', 'report']);
const UNSUPPORTED_SELECTORS = new Set([
  'knowledge', 'use_aws', 'aws', 'thinking', 'delegate', 'report_issue',
  'gh_issue', 'goal', 'spec', '@powers',
]);

export interface McpServerSelectorInfo {
  /** Configured (Kiro) server name. */
  name: string;
  /** Claude-normalized server name (as in `mcp__<claudeName>__<tool>`). */
  claudeName: string;
  disabledTools: string[];
}

export interface ToolSelectorInput {
  tools: string[];
  excludedTools: string[];
  skillsLoaded: boolean;
  mcpServers: McpServerSelectorInfo[];
  agentNames: string[];
}

export interface ToolSelection {
  /** `--tools` list (canonical order; never contains NEVER_EXPOSE_TOOLS). */
  claudeTools: string[];
  /** Configured MCP server names to include in `--mcp-config`. */
  mcpServers: string[];
  /** `--disallowedTools` entries (`mcp__<srv>__<tool>`). */
  disallowedTools: string[];
  /** Agents allowed through the `Agent` tool (`--agents` filter); [] when Agent is not exposed. */
  subagents: 'all' | string[];
  warnings: string[];
  /** server → selected tool names/patterns, for servers selected only via `@srv/tool`. */
  partialMcp: Record<string, string[]>;
}

interface SelState {
  builtins: Set<string>;
  allMcp: boolean;
  servers: Set<string>;
  mcpTools: Map<string, Set<string>>;
  subagentsAll: boolean;
  subagentNames: Set<string>;
}

function emptyState(): SelState {
  return {
    builtins: new Set(),
    allMcp: false,
    servers: new Set(),
    mcpTools: new Map(),
    subagentsAll: false,
    subagentNames: new Set(),
  };
}

function serversMatching(pat: string, servers: McpServerSelectorInfo[]): McpServerSelectorInfo[] {
  return servers.filter((s) => s.name === pat || s.claudeName === pat || ((pat.includes('*') || pat.includes('?')) && matchesAnyPattern([pat], s.name)));
}

function expandSelectors(
  selectors: string[],
  servers: McpServerSelectorInfo[],
  warnings: string[],
  what: 'tools' | 'excludedTools',
): SelState {
  const st = emptyState();
  const addBuiltins = (names: readonly string[]): void => {
    for (const n of names) st.builtins.add(n);
  };
  const one = (raw: string): void => {
    const sel = raw.trim();
    if (sel === '') return;
    if (sel === '*') {
      addBuiltins(BUILTIN_CLAUDE_TOOLS);
      st.builtins.add(SKILL_CLAUDE_TOOL);
      st.allMcp = true;
      st.subagentsAll = true;
      return;
    }
    if (sel === '@builtin' || sel === '@builtin/' || sel === '@builtin/*') {
      addBuiltins(BUILTIN_CLAUDE_TOOLS);
      st.builtins.add(SKILL_CLAUDE_TOOL);
      st.subagentsAll = true;
      return;
    }
    if (sel.startsWith('@builtin/')) {
      one(sel.slice('@builtin/'.length));
      return;
    }
    if (sel === '@mcp') {
      st.allMcp = true;
      return;
    }
    if (IGNORED_SELECTORS.has(sel)) return;
    if (UNSUPPORTED_SELECTORS.has(sel)) {
      warnings.push(`Tool '${sel}' in ${what} is not available in kiro-claude and was ignored`);
      return;
    }
    if (sel.startsWith('@')) {
      const rest = sel.slice(1);
      const slash = rest.indexOf('/');
      const srvPat = slash < 0 ? rest : rest.slice(0, slash);
      const toolPat = slash < 0 ? '' : rest.slice(slash + 1);
      const hits = serversMatching(srvPat, servers);
      if (!hits.length) {
        warnings.push(`MCP server '${srvPat}' referenced by '${sel}' in ${what} is not configured`);
        return;
      }
      for (const s of hits) {
        if (toolPat === '' || toolPat === '*') st.servers.add(s.name);
        else {
          let set = st.mcpTools.get(s.name);
          if (!set) st.mcpTools.set(s.name, (set = new Set()));
          set.add(toolPat);
        }
      }
      return;
    }
    if (sel.startsWith('subagent/')) {
      const name = sel.slice('subagent/'.length);
      if (name === '*' || name === '') {
        st.subagentsAll = true;
        st.builtins.add('Agent');
      } else {
        st.subagentNames.add(name);
        // Excluding one agent must not hide the Agent tool for the others.
        if (what === 'tools') st.builtins.add('Agent');
      }
      return;
    }
    const group = Object.prototype.hasOwnProperty.call(BUILTIN_SELECTORS, sel) ? BUILTIN_SELECTORS[sel] : undefined;
    if (group) {
      addBuiltins(group);
      if (ALL_SUBAGENT_SELECTORS.has(sel)) st.subagentsAll = true;
      return;
    }
    warnings.push(`Unknown tool '${sel}' in ${what} was ignored`);
  };
  for (const s of selectors) one(s);
  return st;
}

/**
 * Expand Kiro `tools` / `excludedTools` selectors into Claude argv pieces (00 §4.2).
 *
 * - `*` = all built-ins (+ `Skill` when skills are loaded) + all MCP servers + any subagent;
 *   `@builtin` = built-ins only; `@mcp` = all MCP servers; `@srv` / `@srv/` / `@srv/*` = whole
 *   server (server globs like `@git-*` allowed); `@srv/tool` = that server, restricted to the
 *   named tools (reported in `partialMcp`; the gate denies the others);
 *   `subagent/<name>` = `Agent` restricted to the named agents.
 * - `excludedTools` uses the same expansion and is subtracted: built-ins removed, whole servers
 *   omitted, single MCP tools become `--disallowedTools mcp__<srv>__<tool>`, `subagent/<n>`
 *   removed from the subagent list. Each server's `disabledTools` are disallowed too.
 * - `tools: []` (or absent ⇒ [] per the loader) exposes nothing. NEVER_EXPOSE_TOOLS never appear.
 */
export function expandToolSelectors(input: ToolSelectorInput): ToolSelection {
  const warnings: string[] = [];
  const inc = expandSelectors(input.tools, input.mcpServers, warnings, 'tools');
  const exc = expandSelectors(input.excludedTools, input.mcpServers, warnings, 'excludedTools');

  const never = new Set(NEVER_EXPOSE_TOOLS);
  const claudeTools = CANONICAL_ORDER.filter(
    (t) =>
      inc.builtins.has(t) &&
      !exc.builtins.has(t) &&
      !never.has(t) &&
      (t !== SKILL_CLAUDE_TOOL || input.skillsLoaded),
  );

  const included = input.mcpServers.filter((s) => {
    const selected = inc.allMcp || inc.servers.has(s.name) || inc.mcpTools.has(s.name);
    const removed = exc.allMcp || exc.servers.has(s.name);
    return selected && !removed;
  });

  const partialMcp: Record<string, string[]> = {};
  const disallowed: string[] = [];
  for (const s of included) {
    if (!inc.allMcp && !inc.servers.has(s.name)) {
      const tools = inc.mcpTools.get(s.name);
      if (tools) partialMcp[s.name] = [...tools];
    }
    const excludedTools = exc.mcpTools.get(s.name);
    for (const t of excludedTools ?? []) {
      if (t.includes('*') || t.includes('?')) continue; // enforced by the gate
      disallowed.push(`mcp__${s.claudeName}__${claudeMcpName(t)}`);
    }
    for (const t of s.disabledTools) disallowed.push(`mcp__${s.claudeName}__${claudeMcpName(t)}`);
  }

  let subagents: 'all' | string[];
  if (!claudeTools.includes('Agent') || exc.subagentsAll) subagents = [];
  else if (inc.subagentsAll) {
    subagents = exc.subagentNames.size ? input.agentNames.filter((n) => !exc.subagentNames.has(n)) : 'all';
  } else {
    subagents = [...inc.subagentNames].filter((n) => !exc.subagentNames.has(n));
  }
  if (Array.isArray(subagents)) {
    for (const n of subagents) {
      if (!input.agentNames.includes(n)) warnings.push(`Agent '${n}' referenced by 'subagent/${n}' was not found`);
    }
  }

  return {
    claudeTools,
    mcpServers: included.map((s) => s.name),
    disallowedTools: [...new Set(disallowed)],
    subagents,
    warnings: [...new Set(warnings)],
    partialMcp,
  };
}

/**
 * Whether an MCP tool call is permitted by an agent's selectors (the gate's P1 enforcement of
 * `@srv/tool` partial selection and of `excludedTools`, 00 §2.3). Servers the selectors do not
 * mention at all are not judged here (they were not passed to Claude in the first place).
 */
export function isMcpToolSelected(tools: string[], excludedTools: string[], server: string, tool: string): boolean {
  const info: McpServerSelectorInfo[] = [{ name: server, claudeName: claudeMcpName(server), disabledTools: [] }];
  const w: string[] = [];
  const inc = expandSelectors(tools, info, w, 'tools');
  const exc = expandSelectors(excludedTools, info, w, 'excludedTools');
  if (exc.allMcp || exc.servers.has(server)) return false;
  const excTools = exc.mcpTools.get(server);
  if (excTools && matchesAnyPattern(excTools, tool)) return false;
  if (inc.allMcp || inc.servers.has(server)) return true;
  const incTools = inc.mcpTools.get(server);
  if (incTools) return matchesAnyPattern(incTools, tool);
  return true;
}

/** Whether `name` may be started through the `Agent` tool under these selectors. */
export function isSubagentSelected(tools: string[], excludedTools: string[], name: string): boolean {
  const sel = expandToolSelectors({ tools, excludedTools, skillsLoaded: false, mcpServers: [], agentNames: [name] });
  if (!sel.claudeTools.includes('Agent')) return false;
  return sel.subagents === 'all' || sel.subagents.includes(name);
}
