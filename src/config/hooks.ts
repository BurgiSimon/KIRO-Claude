/**
 * Kiro hook definitions from every source, normalized to {@link KiroHook} (02 §7, 03 §2,
 * 00 §2.4). This module only loads; hooks/ runs them.
 *
 * Sources and dialects:
 *  - Agent `hooks` **object** form (Q / Kiro 2.x, 02 §7.1) ⇒ dialect `v2`: keys are camelCase
 *    triggers (`agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop`), values
 *    arrays of `{command, timeout_ms?, max_output_size?, cache_ttl_seconds?, matcher?}`.
 *    Defaults: timeout 30000 ms, output 10240 bytes, cache 0 s (02 App. B). Name
 *    `<trigger>-<index>`; `rawTrigger` = the key as written (V2 payload `hook_event_name`).
 *  - Agent `hooks` **array** form and v1 files `{version:"v1", hooks:[…]}` (02 §7.2) ⇒ dialect
 *    `v3`: `{name, trigger, matcher?, action:{type:"command"|"agent", command|prompt},
 *    timeout? (s, default 60, 0 = none), enabled? (default true), confirm? (Stop command
 *    hooks only)}`; output cap 10240 bytes (02 §9 UNVERIFIED ⇒ 10240).
 *  - Legacy IDE files `.kiro/hooks/*.kiro.hook` (03 §2.2–2.3) ⇒ dialect `v3`, source
 *    `legacy-ide`: `when.type` mapped per the 03 §2.3 table; `askAgent` ⇒ agent action,
 *    `runCommand` ⇒ command action; `rawTrigger` is the converted V3 trigger name.
 *    Their matchers are lists; a {@link KiroHook} has a single `matcher` string, so:
 *      - `when.toolTypes` with one entry ⇒ that entry verbatim (V3 selector/regex rules,
 *        02 §7.4); several ⇒ one unanchored regex alternation where category tags are
 *        expanded to their V3 tool ids ({@link toolTypesToMatcher});
 *      - `when.patterns` (workspace-relative globs, matched against the basename when they
 *        contain no `/`, 03 §2.3) ⇒ one regex ({@link fileGlobsToRegex}) usable as a v1 file
 *        matcher (unanchored regex tested against relative and absolute paths).
 *    The original lists are kept on the object as `toolTypes` / `filePatterns`
 *    ({@link LoadedKiroHook}) for runners that want exact list semantics.
 *    A v1 file entry written with `when`/`then` (a docs variant, 03 §2.1) is converted the same way.
 *
 * A hook whose `matcher` is present but not a string (e.g. a list) is dropped with a
 * `hook-invalid` warning rather than treated as match-all (Q rejects the whole agent;
 * running a preToolUse hook for every tool would be the worse failure). `null` = no matcher.
 *
 * Trigger aliases are matched case-insensitively ignoring `_`/`-` (`agentSpawn`,
 * `AgentSpawn`, `sessionStart`, `promptSubmit`, `agentStop`, `fileEdited`, `userTriggered`,
 * legacy profile `conversation_start` / `per_prompt`, …).
 *
 * Order ({@link allHooksFor}, 00 §2.4): global files, workspace files, agent, legacy; array
 * order within a file; files sorted by name.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigWarning, HookConfirmOption, HookTrigger, KiroAgent, KiroHook, WorkspaceContext } from '../types.js';
import { parseJsonText } from '../util/fsx.js';
import { jsonErrorMessage, ownValue } from './diag.js';
import { workspaceKiroDir } from './workspace.js';

/** A loaded hook plus the original legacy matcher lists (see module doc). */
export interface LoadedKiroHook extends KiroHook {
  description?: string;
  /** Legacy `.kiro.hook` `when.toolTypes` (any-of; V3 selectors or regexes). */
  toolTypes?: string[];
  /** Legacy `.kiro.hook` `when.patterns` (workspace-relative globs). */
  filePatterns?: string[];
}

export const V2_DEFAULT_TIMEOUT_MS = 30_000;
export const V2_DEFAULT_MAX_OUTPUT = 10_240;
export const V3_DEFAULT_TIMEOUT_S = 60;
export const V3_DEFAULT_MAX_OUTPUT = 10_240;

const TRIGGER_ALIASES: Record<string, HookTrigger> = {
  sessionstart: 'SessionStart',
  agentspawn: 'SessionStart',
  conversationstart: 'SessionStart',
  userpromptsubmit: 'UserPromptSubmit',
  promptsubmit: 'UserPromptSubmit',
  perprompt: 'UserPromptSubmit',
  pretooluse: 'PreToolUse',
  posttooluse: 'PostToolUse',
  stop: 'Stop',
  agentstop: 'Stop',
  sessionend: 'SessionEnd',
  postfilecreate: 'PostFileCreate',
  filecreated: 'PostFileCreate',
  filecreate: 'PostFileCreate',
  postfilesave: 'PostFileSave',
  fileedited: 'PostFileSave',
  filesaved: 'PostFileSave',
  filesave: 'PostFileSave',
  postfiledelete: 'PostFileDelete',
  filedeleted: 'PostFileDelete',
  filedelete: 'PostFileDelete',
  pretaskexec: 'PreTaskExec',
  pretaskexecution: 'PreTaskExec',
  posttaskexec: 'PostTaskExec',
  posttaskexecution: 'PostTaskExec',
  manual: 'Manual',
  usertriggered: 'Manual',
};

/** Canonical trigger for a configured trigger string (aliases, any case), else undefined. */
export function normalizeHookTrigger(raw: string): HookTrigger | undefined {
  return ownValue(TRIGGER_ALIASES, raw.toLowerCase().replace(/[^a-z]/g, ''));
}

/** Triggers allowed in the V2 object form (Q `hooks` keys). */
const V2_TRIGGERS: ReadonlySet<HookTrigger> = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonNegInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

// ───────────────────────────── V2 object form ─────────────────────────────

function normalizeV2(raw: Record<string, unknown>, agentName: string, sourcePath: string | undefined, warnings: ConfigWarning[]): LoadedKiroHook[] {
  const out: LoadedKiroHook[] = [];
  for (const [key, list] of Object.entries(raw)) {
    const trigger = normalizeHookTrigger(key);
    if (!trigger) {
      warnings.push({ code: 'hook-trigger', message: `Agent '${agentName}': unknown hook trigger '${key}' (ignored)`, path: sourcePath });
      continue;
    }
    if (!V2_TRIGGERS.has(trigger)) {
      warnings.push({
        code: 'hook-trigger',
        message: `Agent '${agentName}': trigger '${key}' is only supported in the array hook format (ignored)`,
        path: sourcePath,
      });
      continue;
    }
    if (!Array.isArray(list)) {
      warnings.push({ code: 'hook-invalid', message: `Agent '${agentName}': hooks.${key} must be an array`, path: sourcePath });
      continue;
    }
    list.forEach((h, i) => {
      if (!isPlainObject(h) || typeof h.command !== 'string' || h.command.trim() === '') {
        warnings.push({ code: 'hook-invalid', message: `Agent '${agentName}': hooks.${key}[${i}] needs a "command" string`, path: sourcePath });
        return;
      }
      const timeout = h.timeout_ms === undefined ? V2_DEFAULT_TIMEOUT_MS : nonNegInt(h.timeout_ms);
      const maxOut = h.max_output_size === undefined ? V2_DEFAULT_MAX_OUTPUT : nonNegInt(h.max_output_size);
      const ttl = h.cache_ttl_seconds === undefined ? 0 : nonNegInt(h.cache_ttl_seconds);
      if (timeout === undefined || maxOut === undefined || ttl === undefined) {
        warnings.push({
          code: 'hook-invalid',
          message: `Agent '${agentName}': hooks.${key}[${i}] has an invalid timeout_ms/max_output_size/cache_ttl_seconds (defaults used)`,
          path: sourcePath,
        });
      }
      if (h.matcher !== undefined && h.matcher !== null && typeof h.matcher !== 'string') {
        // Dropping the hook is safer than running it for every tool (Q rejects the whole
        // agent: `matcher` is an Option<String>).
        warnings.push({
          code: 'hook-invalid',
          message: `Agent '${agentName}': hooks.${key}[${i}].matcher must be a string (hook ignored)`,
          path: sourcePath,
        });
        return;
      }
      const hook: LoadedKiroHook = {
        dialect: 'v2',
        source: 'agent',
        name: `${key}-${i}`,
        trigger,
        rawTrigger: key,
        action: { type: 'command', command: h.command },
        timeoutMs: timeout ?? V2_DEFAULT_TIMEOUT_MS,
        maxOutputBytes: maxOut ?? V2_DEFAULT_MAX_OUTPUT,
        cacheTtlSec: ttl ?? 0,
        enabled: h.enabled !== false && h.disabled !== true,
        agentName,
      };
      if (typeof h.matcher === 'string') hook.matcher = h.matcher;
      if (typeof h.description === 'string') hook.description = h.description;
      if (sourcePath) hook.sourcePath = sourcePath;
      out.push(hook);
    });
  }
  return out;
}

// ───────────────────────────── V3 array / v1 file entries ─────────────────────────────

function parseConfirm(v: unknown, label: string, sourcePath: string | undefined, warnings: ConfigWarning[]): KiroHook['confirm'] | undefined {
  if (!isPlainObject(v)) {
    warnings.push({ code: 'hook-invalid', message: `${label}: "confirm" must be an object (ignored)`, path: sourcePath });
    return undefined;
  }
  const options: HookConfirmOption[] = [];
  if (Array.isArray(v.options)) {
    for (const o of v.options) {
      if (isPlainObject(o) && typeof o.id === 'string') {
        options.push({ id: o.id, label: typeof o.label === 'string' ? o.label : o.id, run: o.run === true });
      } else {
        warnings.push({ code: 'hook-invalid', message: `${label}: confirm.options entries need an "id"`, path: sourcePath });
      }
    }
  }
  const out: NonNullable<KiroHook['confirm']> = { question: typeof v.question === 'string' ? v.question : '', options };
  if (typeof v.confirmCommand === 'string' && v.confirmCommand.trim() !== '') out.confirmCommand = v.confirmCommand;
  return out;
}

function normalizeV3Entry(
  h: unknown,
  index: number,
  source: KiroHook['source'],
  label: string,
  agentName: string | undefined,
  sourcePath: string | undefined,
  warnings: ConfigWarning[],
): LoadedKiroHook | undefined {
  if (!isPlainObject(h)) {
    warnings.push({ code: 'hook-invalid', message: `${label}[${index}] must be an object`, path: sourcePath });
    return undefined;
  }
  if (h.when !== undefined || h.then !== undefined) {
    const lh = convertLegacyHook(h, `${label}[${index}]`, sourcePath, warnings);
    if (!lh) return undefined;
    lh.source = source;
    if (agentName) lh.agentName = agentName;
    return lh;
  }
  const rawTrigger = typeof h.trigger === 'string' ? h.trigger : undefined;
  const trigger = rawTrigger ? normalizeHookTrigger(rawTrigger) : undefined;
  if (!rawTrigger || !trigger) {
    warnings.push({
      code: 'hook-trigger',
      message: `${label}[${index}]: ${rawTrigger ? `unknown trigger '${rawTrigger}'` : 'missing "trigger"'} (ignored)`,
      path: sourcePath,
    });
    return undefined;
  }
  let action: KiroHook['action'] | undefined;
  const a = h.action;
  if (isPlainObject(a)) {
    if (a.type === 'command' && typeof a.command === 'string' && a.command.trim() !== '') action = { type: 'command', command: a.command };
    else if (a.type === 'agent' && typeof a.prompt === 'string' && a.prompt.trim() !== '') action = { type: 'agent', prompt: a.prompt };
  } else if (a === undefined && typeof h.command === 'string' && h.command.trim() !== '') {
    // Lenient: `{trigger, command}` without an action wrapper.
    action = { type: 'command', command: h.command };
  }
  if (!action) {
    warnings.push({
      code: 'hook-invalid',
      message: `${label}[${index}]: "action" must be {"type":"command","command":…} or {"type":"agent","prompt":…} (ignored)`,
      path: sourcePath,
    });
    return undefined;
  }
  let name = typeof h.name === 'string' && h.name.trim() !== '' ? h.name : undefined;
  if (!name) {
    name = `${rawTrigger}-${index}`;
    warnings.push({ code: 'hook-invalid', message: `${label}[${index}]: missing "name" (using '${name}')`, path: sourcePath });
  }
  let timeoutS = V3_DEFAULT_TIMEOUT_S;
  if (h.timeout !== undefined) {
    if (typeof h.timeout === 'number' && Number.isFinite(h.timeout) && h.timeout >= 0) timeoutS = h.timeout;
    else warnings.push({ code: 'hook-invalid', message: `${label}[${index}]: "timeout" must be a number of seconds (default used)`, path: sourcePath });
  }
  const hook: LoadedKiroHook = {
    dialect: 'v3',
    source,
    name,
    trigger,
    rawTrigger,
    action,
    timeoutMs: Math.round(timeoutS * 1000),
    maxOutputBytes: V3_DEFAULT_MAX_OUTPUT,
    cacheTtlSec: 0,
    enabled: h.enabled !== false,
  };
  if (h.matcher !== undefined && h.matcher !== null && typeof h.matcher !== 'string') {
    // A hook whose matcher cannot be understood is dropped rather than run for every tool.
    warnings.push({ code: 'hook-invalid', message: `${label}[${index}]: "matcher" must be a string (hook ignored)`, path: sourcePath });
    return undefined;
  }
  if (typeof h.matcher === 'string' && h.matcher !== '') hook.matcher = h.matcher;
  if (typeof h.description === 'string') hook.description = h.description;
  if (h.confirm !== undefined) {
    if (trigger === 'Stop' && action.type === 'command') {
      const c = parseConfirm(h.confirm, `${label}[${index}]`, sourcePath, warnings);
      if (c) hook.confirm = c;
    } else {
      warnings.push({ code: 'hook-invalid', message: `${label}[${index}]: "confirm" is only supported on Stop command hooks (ignored)`, path: sourcePath });
    }
  }
  if (sourcePath) hook.sourcePath = sourcePath;
  if (agentName) hook.agentName = agentName;
  return hook;
}

/**
 * Normalize an agent's `hooks` field: object form ⇒ v2 hooks, array form ⇒ v3 hooks
 * (see module doc). `undefined`/`null` ⇒ no hooks.
 */
export function normalizeAgentHooks(raw: unknown, agentName: string, sourcePath?: string): { hooks: KiroHook[]; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  if (raw === undefined || raw === null) return { hooks: [], warnings };
  if (Array.isArray(raw)) {
    const hooks: KiroHook[] = [];
    raw.forEach((h, i) => {
      const k = normalizeV3Entry(h, i, 'agent', `Agent '${agentName}': hooks`, agentName, sourcePath, warnings);
      if (k) hooks.push(k);
    });
    return { hooks, warnings };
  }
  if (isPlainObject(raw)) return { hooks: normalizeV2(raw, agentName, sourcePath, warnings), warnings };
  warnings.push({ code: 'hook-invalid', message: `Agent '${agentName}': "hooks" must be an object or an array`, path: sourcePath });
  return { hooks: [], warnings };
}

// ───────────────────────────── legacy `.kiro.hook` ─────────────────────────────

const LEGACY_WHEN: Record<string, HookTrigger> = {
  agentspawn: 'SessionStart',
  sessionstart: 'SessionStart',
  promptsubmit: 'UserPromptSubmit',
  userpromptsubmit: 'UserPromptSubmit',
  agentstop: 'Stop',
  stop: 'Stop',
  pretooluse: 'PreToolUse',
  posttooluse: 'PostToolUse',
  filecreated: 'PostFileCreate',
  fileedited: 'PostFileSave',
  filedeleted: 'PostFileDelete',
  pretaskexecution: 'PreTaskExec',
  posttaskexecution: 'PostTaskExec',
  usertriggered: 'Manual',
};

/** V3 tool ids per category tag (02 §2.4 tag table, 00 §4.1). */
const TAG_IDS: Record<string, string[]> = {
  read: ['read_file', 'list_directory', 'file_search', 'grep_search', 'code', 'introspect'],
  write: ['fs_write', 'fs_append', 'str_replace', 'delete_file', 'code'],
  shell: ['execute_bash', 'execute_pwsh'],
  web: ['web_fetch', 'remote_web_search'],
  subagent: ['invoke_sub_agent', 'use_subagent'],
  context: ['disclose_context'],
};

const REGEX_META = /[\\^$()[\]{}|+]/;

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/**
 * Combine legacy `toolTypes` into one V3 matcher (02 §7.4). One entry ⇒ verbatim. Several
 * ⇒ an unanchored regex alternation: tags become `^(?:id|…)$`, `*` ⇒ `.*`, `@builtin` ⇒
 * `^(?!mcp_)`, `@mcp` ⇒ `^mcp_`, `@<srv>` ⇒ `^mcp_<srv>_`, `subagent` adds `^subagent/`,
 * regex entries are kept, plain ids are matched as substrings (V3 selectors also compile as
 * unanchored regexes).
 */
export function toolTypesToMatcher(toolTypes: readonly string[]): string | undefined {
  const list = toolTypes.map((t) => t.trim()).filter((t) => t !== '');
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  const parts: string[] = [];
  for (const t of list) {
    const lower = t.toLowerCase();
    const tagIds = ownValue(TAG_IDS, lower);
    if (t === '*') parts.push('.*');
    else if (tagIds) {
      parts.push(`^(?:${tagIds.map(escapeRegex).join('|')})$`);
      if (lower === 'subagent') parts.push('^subagent/');
    } else if (lower === '@builtin') parts.push('^(?!mcp_)');
    else if (lower === '@mcp') parts.push('^mcp_');
    else if (t.startsWith('@')) {
      const srv = t.slice(1).split('/')[0] ?? '';
      const fused = srv.replace(/[\s-]/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
      parts.push(`^mcp_${escapeRegex(fused)}_`);
    } else if (REGEX_META.test(t) || t.includes('*') || t.includes('?') || t.includes('.')) parts.push(`(?:${t})`);
    else parts.push(escapeRegex(t));
  }
  return parts.join('|');
}

function globBody(glob: string): string {
  let out = '';
  let i = 0;
  const g = glob.replace(/\\/g, '/');
  while (i < g.length) {
    const ch = g[i]!;
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const atStart = i === 0 || g[i - 1] === '/';
        const atEnd = i + 2 === g.length || g[i + 2] === '/';
        if (atStart && atEnd) {
          if (i + 2 === g.length) {
            out += '.*';
            i += 2;
          } else {
            out += '(?:.*/)?';
            i += 3; // `**/`
          }
          continue;
        }
        out += '[^/]*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i++;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (ch === '[') {
      const close = g.indexOf(']', i + 2);
      if (close > 0) {
        let body = g.slice(i + 1, close);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, '\\\\')}]`;
        i = close + 1;
        continue;
      }
      out += '\\[';
      i++;
      continue;
    }
    if (ch === '{') {
      const close = g.indexOf('}', i);
      if (close > 0) {
        out += `(?:${g
          .slice(i + 1, close)
          .split(',')
          .map((alt) => globBody(alt))
          .join('|')})`;
        i = close + 1;
        continue;
      }
    }
    out += escapeRegex(ch);
    i++;
  }
  return out;
}

/**
 * Convert legacy `when.patterns` globs to one regex source (03 §2.3): patterns without `/`
 * match the basename anywhere (`(?:^|/)name$`), others are anchored to the workspace-relative
 * path (`^src/…$`, a leading `/` or `./` is dropped). `**` = any directories, `*`/`?` stay
 * within one component, `{a,b}` and `[…]` supported.
 */
export function fileGlobsToRegex(globs: readonly string[]): string | undefined {
  const parts: string[] = [];
  for (const raw of globs) {
    let g = raw.trim();
    if (g === '') continue;
    g = g.replace(/^\.\//, '');
    const anchored = g.replace(/\/+$/, '').includes('/');
    g = g.replace(/^\/+/, '');
    parts.push(anchored ? `^${globBody(g)}$` : `(?:^|/)${globBody(g)}$`);
  }
  return parts.length ? parts.join('|') : undefined;
}

function stringArray(v: unknown): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return undefined;
}

/** Convert one legacy `.kiro.hook` object (03 §2.2–2.3); `undefined` + warning when unusable. */
export function convertLegacyHook(raw: unknown, label: string, sourcePath: string | undefined, warnings: ConfigWarning[]): LoadedKiroHook | undefined {
  if (!isPlainObject(raw)) {
    warnings.push({ code: 'hook-invalid', message: `${label}: legacy hook must be a JSON object`, path: sourcePath });
    return undefined;
  }
  const when = isPlainObject(raw.when) ? raw.when : undefined;
  const then = isPlainObject(raw.then) ? raw.then : isPlainObject(raw.action) ? raw.action : undefined;
  const whenType = when && typeof when.type === 'string' ? when.type : undefined;
  const trigger = whenType ? (ownValue(LEGACY_WHEN, whenType.toLowerCase().replace(/[^a-z]/g, '')) ?? normalizeHookTrigger(whenType)) : undefined;
  if (!trigger) {
    warnings.push({
      code: 'hook-trigger',
      message: `${label}: ${whenType ? `unknown when.type '${whenType}'` : 'missing when.type'} (ignored)`,
      path: sourcePath,
    });
    return undefined;
  }
  let action: KiroHook['action'] | undefined;
  const tt = then && typeof then.type === 'string' ? then.type.toLowerCase() : undefined;
  if (then && (tt === 'askagent' || tt === 'agent') && typeof then.prompt === 'string' && then.prompt.trim() !== '') {
    action = { type: 'agent', prompt: then.prompt };
  } else if (then && (tt === 'runcommand' || tt === 'command') && typeof then.command === 'string' && then.command.trim() !== '') {
    action = { type: 'command', command: then.command };
  }
  if (!action) {
    warnings.push({
      code: 'hook-invalid',
      message: `${label}: "then" must be {"type":"askAgent","prompt":…} or {"type":"runCommand","command":…} (ignored)`,
      path: sourcePath,
    });
    return undefined;
  }
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : sourcePath ? path.basename(sourcePath).replace(/\.kiro\.hook$/, '') : label;
  const timeoutRaw = (then && then.timeout) ?? raw.timeout;
  const timeoutS = typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw >= 0 ? timeoutRaw : V3_DEFAULT_TIMEOUT_S;
  const hook: LoadedKiroHook = {
    dialect: 'v3',
    source: 'legacy-ide',
    name,
    trigger,
    rawTrigger: trigger,
    action,
    timeoutMs: Math.round(timeoutS * 1000),
    maxOutputBytes: V3_DEFAULT_MAX_OUTPUT,
    cacheTtlSec: 0,
    enabled: raw.enabled !== false,
  };
  if (typeof raw.description === 'string') hook.description = raw.description;
  const isFile = trigger === 'PostFileCreate' || trigger === 'PostFileSave' || trigger === 'PostFileDelete';
  const isTool = trigger === 'PreToolUse' || trigger === 'PostToolUse';
  if (when && isFile) {
    const pats = stringArray(when.patterns);
    if (pats && pats.length) {
      hook.filePatterns = pats;
      const m = fileGlobsToRegex(pats);
      if (m) hook.matcher = m;
    }
  } else if (when && isTool) {
    const tts = stringArray(when.toolTypes);
    if (tts && tts.length) {
      hook.toolTypes = tts;
      const m = toolTypesToMatcher(tts);
      if (m) hook.matcher = m;
    }
  }
  if (sourcePath) hook.sourcePath = sourcePath;
  return hook;
}

// ───────────────────────────── standalone files ─────────────────────────────

function listFiles(dir: string, suffix: string, exclude?: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(suffix) && !(exclude && n.endsWith(exclude)) && !n.startsWith('._'))
    .sort()
    .map((n) => path.join(dir, n))
    .filter((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

function readJson(p: string, warnings: ConfigWarning[]): unknown {
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    warnings.push({ code: 'hook-file', message: `Failed to read ${p}: ${e instanceof Error ? e.message : String(e)}`, path: p });
    return undefined;
  }
  try {
    return parseJsonText(text, p);
  } catch (e) {
    warnings.push({ code: 'invalid-json', message: jsonErrorMessage(e, p), path: p });
    return undefined;
  }
}

/** Load one v1 hook file (`{version:"v1", hooks:[…]}`; a bare legacy hook object is converted). */
export function loadHookFile(p: string, source: 'workspace-file' | 'global-file'): { hooks: KiroHook[]; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const data = readJson(p, warnings);
  if (data === undefined) return { hooks: [], warnings };
  if (isPlainObject(data) && (data.when !== undefined || data.then !== undefined) && data.hooks === undefined) {
    const h = convertLegacyHook(data, path.basename(p), p, warnings);
    if (h) h.source = source;
    return { hooks: h ? [h] : [], warnings };
  }
  if (!isPlainObject(data) || !Array.isArray(data.hooks)) {
    warnings.push({ code: 'hook-file', message: `${p}: expected {"version":"v1","hooks":[…]}`, path: p });
    return { hooks: [], warnings };
  }
  if (data.version !== undefined && data.version !== 'v1') {
    warnings.push({ code: 'hook-file', message: `${p}: unsupported hook file version ${JSON.stringify(data.version)} (loading as v1)`, path: p });
  }
  const hooks: KiroHook[] = [];
  data.hooks.forEach((h, i) => {
    const k = normalizeV3Entry(h, i, source, `${path.basename(p)}: hooks`, undefined, p, warnings);
    if (k) hooks.push(k);
  });
  return { hooks, warnings };
}

/**
 * Standalone hook files in definition order: global `<kiroHome>/hooks/*.json`, workspace
 * `.kiro/hooks/*.json`, then workspace `.kiro/hooks/*.kiro.hook` (legacy, converted).
 */
export function loadHookFiles(ws: WorkspaceContext): { hooks: KiroHook[]; warnings: ConfigWarning[] } {
  const r = loadHookFileGroups(ws);
  return { hooks: [...r.global, ...r.workspace, ...r.legacy], warnings: r.warnings };
}

/** Like {@link loadHookFiles} but keeps the three groups apart. */
export function loadHookFileGroups(ws: WorkspaceContext): { global: KiroHook[]; workspace: KiroHook[]; legacy: KiroHook[]; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const global: KiroHook[] = [];
  const workspace: KiroHook[] = [];
  const legacy: KiroHook[] = [];
  for (const p of listFiles(path.join(ws.kiroHome, 'hooks'), '.json')) {
    const r = loadHookFile(p, 'global-file');
    global.push(...r.hooks);
    warnings.push(...r.warnings);
  }
  const wk = workspaceKiroDir(ws);
  if (wk) {
    const dir = path.join(wk, 'hooks');
    for (const p of listFiles(dir, '.json')) {
      const r = loadHookFile(p, 'workspace-file');
      workspace.push(...r.hooks);
      warnings.push(...r.warnings);
    }
    for (const p of listFiles(dir, '.kiro.hook')) {
      const data = readJson(p, warnings);
      if (data === undefined) continue;
      const h = convertLegacyHook(data, path.basename(p), p, warnings);
      if (h) legacy.push(h);
    }
  }
  return { global, workspace, legacy, warnings };
}

/** Every hook that applies to a session running `agent`, in definition order (00 §2.4). */
export function allHooksFor(ws: WorkspaceContext, agent: Pick<KiroAgent, 'hooks'>): KiroHook[] {
  const r = loadHookFileGroups(ws);
  return [...r.global, ...r.workspace, ...agent.hooks, ...r.legacy];
}
