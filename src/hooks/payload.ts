/**
 * Hook stdin payloads in both dialects (00 §2.4, §4.4; 02 §7.1, §7.5; 03 §1.7.3, §2.5).
 *
 * V2 (agent object-form hooks; Q / Kiro 2.x), key order as Q writes it (06 §3.3):
 *   `{"hook_event_name":"<camelCase trigger>","cwd":"<cwd>"[,"prompt"][,"tool_name":<Q name>,
 *     "tool_tags":[…],"tool_input":<Q shape>[,"tool_response"]]}` — no `session_id`.
 *   `hook_event_name` is the canonical camelCase Q trigger (`agentSpawn`, `userPromptSubmit`,
 *   `preToolUse`, `postToolUse`, `stop`); `prompt` is added whenever the runner passes a pending
 *   prompt (Q passes it to agentSpawn too); `tool_tags` is the Kiro 2.x harness addition
 *   (KD:cli/v3/hooks-migration) = the call's tags (`["read","@builtin"]`, `["@mcp","@srv",…]`).
 *
 * V3 (v1 files, agent array form, legacy `.kiro.hook`):
 *   `{"hook_event_name":"<trigger as configured>","cwd","session_id"[,"prompt" (UserPromptSubmit
 *     only)][,"tool_name":<V3 id>,"tool_input":<V3 shape>[,"tool_response"]]}`;
 *   file triggers add `"file_path":<abs>,"tool_name":<V3 id>` (03 §2.5, UNVERIFIED ⇒ DECISION);
 *   task triggers add `spec_name, spec_dir, task_id, task_title, task_optional[, task_status]`
 *   (03 §1.7.3, DECISION).
 *
 * `cwd` is the session cwd (`ws.cwd`; Q writes `process.cwd()`).
 *
 * Tool inputs (00 §4.4; shapes marked UNVERIFIED there are DECISIONS):
 *
 * | Claude | V2 `tool_input` | V3 `tool_input` |
 * |---|---|---|
 * | Read | `{operations:[{mode:"Line",path,start_line:offset??1,end_line:limit?start+limit-1:-1}]}` | `{path}` |
 * | Glob / Grep | `{path:path??cwd,pattern}` | `{pattern,path:path??cwd}` |
 * | Write | `{command:"create",path,file_text}` | `{path,content}` |
 * | Edit (MultiEdit: first edit) | `{command:"str_replace",path,old_str,new_str}` | `{path,old_str,new_str}` |
 * | NotebookEdit | `{command:"insert"\|"str_replace",path,new_str}` (DECISION) | `{path,content}` (DECISION) |
 * | Bash | `{command[,summary:description]}` | `{command}` |
 * | WebFetch / WebSearch | `{url}` / `{query}` | same |
 * | Agent (Task) | `{agent_name:subagent_type??"general-purpose",task:prompt}` | same |
 * | MCP, Task* todo tools, Skill, others | raw input | raw input |
 *
 * Paths are absolute (resolved against the call's cwd, `~` expanded).
 *
 * `tool_response` (both dialects, Q shape, 06 §3.7): success `{"success":true,"result":[item]}`,
 * failure `{"success":false,"error":["An error occurred processing the tool: \n<error>"]}`. Items:
 * Bash `{"exit_status":"0","stdout","stderr"}` (Claude reports no exit code; success ⇒ `"0"`),
 * Read `file.content` (string), everything else the response itself when it is a string, else
 * `JSON.stringify(response)`.
 */

import * as path from 'node:path';
import type { HookTrigger, KiroHook, KiroToolCall, ToolOutcome, WorkspaceContext } from '../types.js';
import { expandTilde } from '../util/paths.js';
import { v3ToolId } from './matcher.js';

/** Spec task described to task hooks (03 §1.7.3). */
export interface HookTaskInfo {
  specName: string;
  taskId: string;
  title: string;
  /** Default `<workspaceRoot>/.kiro/specs/<specName>`. */
  specDir?: string;
  optional?: boolean;
  /** PostTaskExec only. */
  status?: 'completed' | 'failed' | 'interrupted';
}

/** Everything a payload can be built from. */
export interface HookEvent {
  trigger: HookTrigger;
  ws: WorkspaceContext;
  sessionId: string;
  prompt?: string;
  call?: KiroToolCall;
  outcome?: ToolOutcome;
  /** File triggers: the affected file (absolute or relative to `ws.cwd`). */
  filePath?: string;
  task?: HookTaskInfo;
}

/** Canonical camelCase Q trigger names (02 §7.1). */
export const V2_EVENT_NAMES: Readonly<Partial<Record<HookTrigger, string>>> = Object.freeze({
  SessionStart: 'agentSpawn',
  UserPromptSubmit: 'userPromptSubmit',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  Stop: 'stop',
});

/** `hook_event_name` for a hook: V2 ⇒ canonical camelCase, V3 ⇒ trigger as configured. */
export function hookEventName(hook: Pick<KiroHook, 'dialect' | 'trigger' | 'rawTrigger'>): string {
  if (hook.dialect === 'v2') return V2_EVENT_NAMES[hook.trigger] ?? (hook.rawTrigger || hook.trigger);
  return hook.rawTrigger || hook.trigger;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function absPath(p: string | undefined, cwd: string): string {
  if (p === undefined || p === '') return '';
  return path.resolve(cwd, expandTilde(p));
}

function firstEdit(input: Record<string, unknown>): { old: string; new: string } {
  if (Array.isArray(input.edits) && input.edits.length > 0) {
    const e = input.edits[0] as Record<string, unknown> | undefined;
    if (e && typeof e === 'object') return { old: str(e.old_string) ?? '', new: str(e.new_string) ?? '' };
  }
  return { old: str(input.old_string) ?? '', new: str(input.new_string) ?? '' };
}

function agentInput(input: Record<string, unknown>): Record<string, unknown> {
  const t = str(input.subagent_type);
  return { agent_name: t !== undefined && t !== '' ? t : 'general-purpose', task: str(input.prompt) ?? '' };
}

function searchPath(call: KiroToolCall): string {
  const p = str(call.input.path);
  return p !== undefined && p !== '' ? absPath(p, call.cwd) : call.cwd;
}

/** V2 / Q `tool_input` for a Claude call (see module table). */
export function toV2ToolInput(call: KiroToolCall): Record<string, unknown> {
  const input = call.input ?? {};
  switch (call.claudeName) {
    case 'Read': {
      // 00 §4.4: `end_line: limit ? offset+limit-1 : -1` — a missing / zero / negative limit
      // means "to the end of the file" (-1), never an end before the start.
      const start = num(input.offset) ?? 1;
      const limit = num(input.limit);
      return {
        operations: [
          { mode: 'Line', path: absPath(str(input.file_path), call.cwd), start_line: start, end_line: limit !== undefined && limit > 0 ? start + limit - 1 : -1 },
        ],
      };
    }
    case 'Glob':
    case 'Grep':
      return { path: searchPath(call), pattern: str(input.pattern) ?? '' };
    case 'Write':
      return { command: 'create', path: absPath(str(input.file_path), call.cwd), file_text: str(input.content) ?? '' };
    case 'Edit':
    case 'MultiEdit': {
      const e = firstEdit(input);
      return { command: 'str_replace', path: absPath(str(input.file_path), call.cwd), old_str: e.old, new_str: e.new };
    }
    case 'NotebookEdit':
      return {
        command: input.edit_mode === 'insert' ? 'insert' : 'str_replace',
        path: absPath(str(input.notebook_path), call.cwd),
        new_str: str(input.new_source) ?? '',
      };
    case 'Bash': {
      const out: Record<string, unknown> = { command: str(input.command) ?? '' };
      const d = str(input.description);
      if (d !== undefined) out.summary = d;
      return out;
    }
    case 'WebFetch':
      return { url: str(input.url) ?? '' };
    case 'WebSearch':
      return { query: str(input.query) ?? '' };
    case 'Agent':
    case 'Task':
      return agentInput(input);
    default:
      return { ...input };
  }
}

/** V3 `tool_input` for a Claude call (see module table). */
export function toV3ToolInput(call: KiroToolCall): Record<string, unknown> {
  const input = call.input ?? {};
  switch (call.claudeName) {
    case 'Read':
      return { path: absPath(str(input.file_path), call.cwd) };
    case 'Glob':
    case 'Grep':
      return { pattern: str(input.pattern) ?? '', path: searchPath(call) };
    case 'Write':
      return { path: absPath(str(input.file_path), call.cwd), content: str(input.content) ?? '' };
    case 'Edit':
    case 'MultiEdit': {
      const e = firstEdit(input);
      return { path: absPath(str(input.file_path), call.cwd), old_str: e.old, new_str: e.new };
    }
    case 'NotebookEdit':
      return { path: absPath(str(input.notebook_path), call.cwd), content: str(input.new_source) ?? '' };
    case 'Bash':
      return { command: str(input.command) ?? '' };
    case 'WebFetch':
      return { url: str(input.url) ?? '' };
    case 'WebSearch':
      return { query: str(input.query) ?? '' };
    case 'Agent':
    case 'Task':
      return agentInput(input);
    default:
      return { ...input };
  }
}

/** Q prefix of a tool error block (06 §3.7). */
export const TOOL_ERROR_PREFIX = 'An error occurred processing the tool: \n';

function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Kiro/Q `tool_response` for a finished call (see module doc). */
export function toKiroToolResponse(call: KiroToolCall, outcome: ToolOutcome): Record<string, unknown> {
  const r = outcome.response;
  if (!outcome.success) {
    const err = outcome.error ?? textOf(r);
    return { success: false, error: [TOOL_ERROR_PREFIX + err] };
  }
  let item: unknown;
  switch (call.claudeName) {
    case 'Bash':
      if (isObj(r)) item = { exit_status: '0', stdout: str(r.stdout) ?? '', stderr: str(r.stderr) ?? '' };
      else item = { exit_status: '0', stdout: textOf(r), stderr: '' };
      break;
    case 'Read':
      if (isObj(r) && isObj(r.file) && typeof r.file.content === 'string') item = r.file.content;
      else item = textOf(r);
      break;
    default:
      item = textOf(r);
  }
  return { success: true, result: [item] };
}

const FILE_TRIGGERS: ReadonlySet<HookTrigger> = new Set(['PostFileCreate', 'PostFileSave', 'PostFileDelete']);
const TASK_TRIGGERS: ReadonlySet<HookTrigger> = new Set(['PreTaskExec', 'PostTaskExec']);
const TOOL_TRIGGERS: ReadonlySet<HookTrigger> = new Set(['PreToolUse', 'PostToolUse']);

/** Build the stdin JSON object for `hook` (see module doc). */
export function buildPayload(hook: KiroHook, event: HookEvent): Record<string, unknown> {
  const v2 = hook.dialect === 'v2';
  const p: Record<string, unknown> = { hook_event_name: hookEventName(hook), cwd: event.ws.cwd };
  if (!v2) p.session_id = event.sessionId;
  if (event.prompt !== undefined && (v2 || event.trigger === 'UserPromptSubmit')) p.prompt = event.prompt;

  if (FILE_TRIGGERS.has(event.trigger) && event.filePath !== undefined) {
    p.file_path = path.resolve(event.ws.cwd, event.filePath);
    if (event.call) p.tool_name = v2 ? event.call.v2Name : v3ToolId(event.call);
    return p;
  }

  if (TASK_TRIGGERS.has(event.trigger) && event.task) {
    const t = event.task;
    p.spec_name = t.specName;
    p.spec_dir = t.specDir ?? path.join(event.ws.workspaceRoot, '.kiro', 'specs', t.specName);
    p.task_id = t.taskId;
    p.task_title = t.title;
    p.task_optional = t.optional ?? false;
    if (event.trigger === 'PostTaskExec' && t.status !== undefined) p.task_status = t.status;
    return p;
  }

  if (event.call && (TOOL_TRIGGERS.has(event.trigger) || event.outcome !== undefined)) {
    const call = event.call;
    if (v2) {
      p.tool_name = call.v2Name;
      p.tool_tags = [...call.tags];
      p.tool_input = toV2ToolInput(call);
    } else {
      p.tool_name = v3ToolId(call);
      p.tool_input = toV3ToolInput(call);
    }
    if (event.outcome !== undefined && event.trigger !== 'PreToolUse') p.tool_response = toKiroToolResponse(call, event.outcome);
  }
  return p;
}
