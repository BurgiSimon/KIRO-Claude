/**
 * Pure translation helpers between kiro-claude's session layer and ACP (research 05 §4.5.1,
 * §5, §6.1, §7.3–§7.7, corrected by 08 §2.5; frame shapes checked against KiroCrew's captured
 * kiro-cli corpus `test/fixtures/acp_frames/kiro/*.jsonl`).
 *
 * Tool frames (05 §5.2, §7.3; 08 KC-ACP-11):
 *  - `tool_call` carries `title`, `kind` (none for MCP tools), `status:"pending"`, `rawInput`
 *    (Claude input, plus `__tool_use_purpose` from Bash `description`), optional
 *    `locations` / `content` (diffs for edits, the prompt for subagents) and
 *    `_meta.kiro.toolName` (+ `mcpServerName` for MCP tools) — KiroCrew reads tool identity
 *    ONLY from that meta on the `tool_call` frame — and `_meta.claudeCode.toolName`.
 *  - results: shell output first as a content-only `tool_call_update` (as kiro-cli does), then
 *    the final update with `status` and a kiro `rawOutput` envelope (`{"items":[{"Json":{
 *    "exit_status","stdout","stderr"}}]}` for shell, `{"items":[{"Text":…}]}` for files and
 *    text, `{"items":[{"Json":{"content":[…]}}]}` for MCP, the full todo snapshot for
 *    `todo_list`); MCP results use `kind:"other"`.
 *  - a denied call ends with the kiro-cli denial frame: `status:"failed"`, `title:<toolName>`,
 *    text `User denied tool execution`, `_meta.kiro.toolCallFailureReason:"permission_denied"`.
 *  - every tool frame (call, updates, denial) carries the same `_meta` identity ({@link toolMeta}).
 *
 * Titles follow the captured kiro-cli wording where one exists (`Running: <cmd>`,
 * `Reading <rel>:<line>`, `Creating <rel>`, `Searching for '<pattern>'`,
 * `Running: @<srv>/<tool>`); the others are UNVERIFIED (05 §11 item 6) and follow 05 §7.3.
 * One function ({@link toolCallTitle}) computes them from the call alone, for live frames and
 * `session/load` replay alike.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KiroAgent, KiroToolCall, McpServerConfig, ModelEntry, PromptInput, TodoItem, TurnResult, TurnUsage } from '../types.js';
import { isTodoTool } from '../policy/toolmap.js';
import { AUTH_ERROR_TEXT } from '../claude/auth.js';
import { CLAUDE_ALIASES, findModelEntry } from '../models/models.js';
import { ErrorCodes, RpcError, internalError, invalidParams } from './jsonrpc.js';

// ───────────────────────────── constants ─────────────────────────────

/** kiro-cli's exact three permission options (05 §6.1, `[KCF:session]`). */
export const KIRO_PERMISSION_OPTIONS: ReadonlyArray<{ optionId: string; name: string; kind: string }> = Object.freeze([
  Object.freeze({ optionId: 'allow_once', name: 'Yes', kind: 'allow_once' }),
  Object.freeze({ optionId: 'allow_always', name: 'Always', kind: 'allow_always' }),
  Object.freeze({ optionId: 'reject_once', name: 'No', kind: 'reject_once' }),
]);

/** Text of kiro-cli's denial frame and what the model is told (05 §5.2, §6.1). */
export const USER_DENIED_TEXT = 'User denied tool execution';
/** Text the model sees when the client cancelled a pending permission request (05 §6.1). */
export const CANCELLED_TEXT = 'Cancelled by user';
/** Claude `--effort` levels (05 §2.2). */
export const EFFORT_LEVELS: readonly string[] = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_NAMES: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
/** Per-field cap on tool output text placed in frames (the transport caps whole frames at 10 MiB). */
export const MAX_TOOL_TEXT_CHARS = 512 * 1024;

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export type ToolCallContent =
  | { type: 'content'; content: { type: 'text'; text: string } }
  | { type: 'diff'; path: string; oldText: string | null; newText: string };

export interface ToolLocation {
  path: string;
  line?: number;
}

/** Everything needed to render one tool call's frames. */
export interface ToolDescriptor {
  toolCallId: string;
  claudeName: string;
  title: string;
  /** `kind` on the `tool_call` frame (undefined for MCP tools, as kiro-cli). */
  kind?: ToolKind;
  /** `kind` on result updates (`other` for MCP). */
  updateKind: ToolKind;
  /** `_meta.kiro.toolName`. */
  kiroToolName: string;
  /** `_meta.kiro.mcpServerName` for MCP tools. */
  mcpServerName?: string;
  rawInput: Record<string, unknown>;
  locations?: ToolLocation[];
  content?: ToolCallContent[];
  /** `_meta.claudeCode.parentToolUseId` for calls made inside a Claude subagent. */
  parentToolUseId?: string;
  family: 'shell' | 'read' | 'write' | 'edit' | 'search' | 'fetch' | 'subagent' | 'todo' | 'mcp' | 'other';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Cap a text field (see {@link MAX_TOOL_TEXT_CHARS}). */
export function capText(s: string, max = MAX_TOOL_TEXT_CHARS): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} characters]`;
}

function oneLine(s: string, max = 500): string {
  const t = s.replace(/\s*\n\s*/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function jsonClone<T>(v: T): T {
  try {
    return JSON.parse(JSON.stringify(v)) as T;
  } catch {
    return v;
  }
}

/** `cwd`-relative display path when inside `cwd`, else the absolute path. */
export function displayPath(p: string, cwd: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel === '') return '.';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return abs;
}

function absOf(p: string | undefined, cwd: string): string | undefined {
  if (p === undefined || p === '') return undefined;
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/** `_meta.kiro.toolName` for a call (05 §7.3 column 5; 00 §4.1 "ACP toolName"). */
export function kiroToolNameOf(call: Pick<KiroToolCall, 'claudeName' | 'kiro2Name' | 'mcp'>): string {
  if (call.mcp) return call.mcp.tool;
  const n = call.claudeName;
  if (n === 'Agent' || n === 'Task') return 'use_subagent';
  if (isTodoTool(n)) return 'todo_list';
  if (n === 'ToolSearch') return 'tool_search';
  if (n === 'PowerShell') return 'shell';
  return call.kiro2Name || n;
}

export interface DescribeOptions {
  cwd: string;
  /** Overrides `call.toolUseId`. */
  toolCallId?: string;
  parentToolUseId?: string;
  /**
   * File-system probes for a `Write` diff's `oldText` (the current file text). Omit to avoid
   * touching the disk (replay): `oldText` is then null. Titles never depend on them
   * ({@link toolCallTitle}).
   */
  fs?: { exists(p: string): boolean; read(p: string): string | undefined };
  /**
   * Read the current file text for a `Write` diff's `oldText` (default true when `fs` is given).
   * The server passes false for calls the gate already denied: their frames must not carry the
   * contents of a file the agent may not touch (e.g. a `deniedPaths` target), only existence.
   */
  readContent?: boolean;
}

/**
 * Default probes used for live tool calls: existence + read of regular files ≤ 1 MiB. A symlink
 * is never read for the preview (its target may be a file the path rules would refuse).
 */
export const LIVE_FS: NonNullable<DescribeOptions['fs']> = {
  exists: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  read: (p) => {
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.size > 1024 * 1024) return undefined;
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/**
 * The `title` of a tool call (05 §7.3 wording; 05 §11 item 6 for the uncaptured ones). It is a
 * pure function of the call (tool name + input) and `cwd`, and it is the ONLY title source: the
 * live `tool_call`, the permission request, result / denial updates and `session/load` replay all
 * go through it, so one call carries one title everywhere.
 *
 * `Write` is always `Creating <rel>` (DECISION): Claude's `Write` is Kiro's `fs_write` `create`
 * command (00 §4.1 rawInput row), and kiro-cli titles by command — `Creating <file>` is the only
 * captured wording (`[KCF:side-read-only-live]`). Whether the file already existed is not part of
 * the title: replay cannot know it, and a title that changed with it gave one call two titles
 * (`Creating` live, `Writing` on replay). Existence still decides the diff's `oldText`.
 */
export function toolCallTitle(call: Pick<KiroToolCall, 'claudeName' | 'input' | 'cwd' | 'mcp'>, cwd: string): string {
  const base = call.cwd || cwd;
  const input = isObj(call.input) ? call.input : {};
  const name = call.claudeName;
  const rel = (p: unknown): string | undefined => {
    const abs = absOf(str(p), base);
    return abs ? displayPath(abs, base) : undefined;
  };
  if (call.mcp) return `Running: @${call.mcp.server}/${call.mcp.tool}`;
  if (name.startsWith('mcp__')) return `Running: ${name}`;
  if (isTodoTool(name)) {
    const id = str(input.taskId) ?? (num(input.taskId) !== undefined ? String(input.taskId) : undefined);
    switch (name) {
      case 'TaskCreate':
        return `Create task: ${oneLine(str(input.subject) ?? '')}`.trimEnd();
      case 'TaskUpdate': {
        const st = str(input.status);
        return `Update task${id ? ` #${id}` : ''}${st ? `: ${st}` : ''}`;
      }
      case 'TaskList':
        return 'List tasks';
      case 'TaskGet':
        return `Get task${id ? ` #${id}` : ''}`;
      case 'TodoWrite':
        return 'Update TODOs';
      default:
        return name;
    }
  }
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `Running: ${oneLine(str(input.command) ?? '', 1000)}`;
    case 'Read': {
      const r = rel(input.file_path);
      return r !== undefined ? `Reading ${r}:${Math.max(1, num(input.offset) ?? 1)}` : 'Reading';
    }
    case 'Write': {
      const r = rel(input.file_path);
      return r !== undefined ? `Creating ${r}` : 'Creating';
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const r = rel(str(input.file_path) ?? str(input.notebook_path));
      return r !== undefined ? `Editing ${r}` : 'Editing';
    }
    case 'Grep':
      return `Searching for '${oneLine(str(input.pattern) ?? '')}'`;
    case 'Glob':
      return `Finding '${oneLine(str(input.pattern) ?? '')}'`;
    case 'WebFetch':
      return `Fetching ${oneLine(str(input.url) ?? '')}`;
    case 'WebSearch':
      return `Searching the web for "${oneLine(str(input.query) ?? '')}"`;
    case 'Agent':
    case 'Task': {
      const desc = str(input.description);
      const type = str(input.subagent_type);
      return desc ? oneLine(desc) : type ? `Subagent: ${type}` : 'Subagent';
    }
    case 'Skill':
      return `Load skill: ${oneLine(str(input.skill) ?? '')}`;
    case 'ToolSearch':
      return `Searching tools: ${oneLine(str(input.query) ?? '')}`;
    default:
      return name;
  }
}

/** Describe one tool call for ACP (05 §7.3); the title comes from {@link toolCallTitle}. */
export function describeToolCall(call: KiroToolCall, opts: DescribeOptions): ToolDescriptor {
  const cwd = call.cwd || opts.cwd;
  const input = isObj(call.input) ? call.input : {};
  const name = call.claudeName;
  const toolCallId = opts.toolCallId ?? call.toolUseId ?? '';
  const rawInput: Record<string, unknown> = {};
  const purpose = name === 'Bash' || name === 'PowerShell' ? str(input.description) : undefined;
  if (purpose) rawInput.__tool_use_purpose = purpose;
  Object.assign(rawInput, jsonClone(input));

  const d: ToolDescriptor = {
    toolCallId,
    claudeName: name,
    title: toolCallTitle(call, opts.cwd),
    kind: 'other',
    updateKind: 'other',
    kiroToolName: kiroToolNameOf(call),
    rawInput,
    family: 'other',
    ...(opts.parentToolUseId ? { parentToolUseId: opts.parentToolUseId } : {}),
  };
  const setKind = (k: ToolKind): void => {
    d.kind = k;
    d.updateKind = k;
  };

  if (call.mcp) {
    d.mcpServerName = call.mcp.server;
    delete d.kind;
    d.updateKind = 'other';
    d.family = 'mcp';
    return d;
  }
  if (name.startsWith('mcp__')) {
    delete d.kind;
    d.family = 'mcp';
    return d;
  }
  if (isTodoTool(name)) {
    setKind('think');
    d.family = 'todo';
    return d;
  }

  switch (name) {
    case 'Bash':
    case 'PowerShell':
      setKind('execute');
      d.family = 'shell';
      break;
    case 'Read': {
      setKind('read');
      d.family = 'read';
      const abs = absOf(str(input.file_path), cwd);
      if (abs) d.locations = [{ path: abs, line: Math.max(1, num(input.offset) ?? 1) }];
      break;
    }
    case 'Write': {
      setKind('edit');
      d.family = 'write';
      const abs = absOf(str(input.file_path), cwd);
      if (abs) {
        d.locations = [{ path: abs, line: 1 }];
        const exists = opts.fs?.exists(abs) ?? false;
        const oldText = exists && opts.fs && opts.readContent !== false ? opts.fs.read(abs) ?? null : null;
        d.content = [{ type: 'diff', path: abs, oldText, newText: capText(str(input.content) ?? '') }];
      }
      break;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      setKind('edit');
      d.family = 'edit';
      const abs = absOf(str(input.file_path) ?? str(input.notebook_path), cwd);
      if (abs) {
        d.locations = [{ path: abs }];
        if (name === 'Edit') {
          d.content = [{ type: 'diff', path: abs, oldText: capText(str(input.old_string) ?? ''), newText: capText(str(input.new_string) ?? '') }];
        } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
          d.content = input.edits
            .filter(isObj)
            .map((e) => ({ type: 'diff' as const, path: abs, oldText: capText(str(e.old_string) ?? ''), newText: capText(str(e.new_string) ?? '') }));
        } else if (name === 'NotebookEdit' && typeof input.new_source === 'string') {
          d.content = [{ type: 'diff', path: abs, oldText: null, newText: capText(input.new_source) }];
        }
      }
      break;
    }
    case 'Grep':
    case 'Glob': {
      setKind('search');
      d.family = 'search';
      const abs = absOf(str(input.path), cwd);
      if (abs) d.locations = [{ path: abs }];
      break;
    }
    case 'WebFetch':
    case 'WebSearch':
      setKind('fetch');
      d.family = 'fetch';
      break;
    case 'Agent':
    case 'Task': {
      setKind('think');
      d.family = 'subagent';
      const prompt = str(input.prompt);
      if (prompt) d.content = [{ type: 'content', content: { type: 'text', text: capText(prompt) } }];
      break;
    }
    default:
      setKind('other');
  }
  return d;
}

/**
 * `_meta` identity carried by every tool frame: `kiro.toolName` (+ `kiro.mcpServerName`) and
 * `claudeCode.toolName` (+ `claudeCode.parentToolUseId` inside subagents). kiro-cli itself puts
 * it only on `tool_call` and denial frames; repeating the same identity on every update is
 * harmless for KiroCrew (a frame asserting an identity is believed as it stands) and lets
 * clients that missed the `tool_call` still classify the result (DECISION, task brief).
 */
export function toolMeta(d: ToolDescriptor, extraKiro: Record<string, unknown> = {}): Record<string, unknown> {
  return meta(d, extraKiro);
}

function meta(d: ToolDescriptor, extraKiro: Record<string, unknown> = {}): Record<string, unknown> {
  const kiro: Record<string, unknown> = { toolName: d.kiroToolName };
  if (d.mcpServerName !== undefined) kiro.mcpServerName = d.mcpServerName;
  Object.assign(kiro, extraKiro);
  const claudeCode: Record<string, unknown> = { toolName: d.claudeName };
  if (d.parentToolUseId) claudeCode.parentToolUseId = d.parentToolUseId;
  return { kiro, claudeCode };
}

/** The `tool_call` update (05 §5.2; status `pending`). */
export function toolCallUpdate(d: ToolDescriptor, extraKiroMeta: Record<string, unknown> = {}): Record<string, unknown> {
  const u: Record<string, unknown> = { sessionUpdate: 'tool_call', toolCallId: d.toolCallId, title: d.title };
  if (d.kind !== undefined) u.kind = d.kind;
  u.status = 'pending';
  if (d.content?.length) u.content = d.content;
  if (d.locations?.length) u.locations = d.locations;
  u.rawInput = d.rawInput;
  u._meta = meta(d, extraKiroMeta);
  return u;
}

/** The `toolCall` object of a `session/request_permission` (kiro-cli sends id, title, rawInput). */
export function permissionToolCall(d: ToolDescriptor): Record<string, unknown> {
  return { toolCallId: d.toolCallId, title: d.title, rawInput: d.rawInput };
}

function textContent(text: string): ToolCallContent {
  return { type: 'content', content: { type: 'text', text } };
}

/** Strip Claude's `<tool_use_error>…</tool_use_error>` wrapper (05 §7.3). */
export function stripToolUseError(s: string): string {
  const m = /^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/.exec(s);
  return m ? m[1]!.trim() : s;
}

/** Remove `cat -n` line prefixes and `<system-reminder>` blocks from Claude Read output. */
export function stripReadDecorations(s: string): string {
  const noReminder = s.replace(/\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '\n').replace(/\n+$/, '');
  const lines = noReminder.split('\n');
  if (lines.length > 0 && lines.every((l) => l === '' || /^\s*\d+[\t→]/.test(l))) {
    return lines.map((l) => l.replace(/^\s*\d+[\t→]/, '')).join('\n');
  }
  return noReminder;
}

/** Text blocks of an MCP / Claude content array joined with newlines. */
function blocksText(blocks: unknown[]): string {
  return blocks
    .filter(isObj)
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : b.type === 'image' ? '[image]' : ''))
    .filter((t) => t !== '')
    .join('\n');
}

/** Kiro `todo_list` snapshot envelope (05 §5.2). */
export function todoSnapshot(todos: readonly TodoItem[]): Record<string, unknown> {
  return {
    items: [
      {
        Json: {
          description: 'Tasks',
          tasks: todos.filter((t) => t.status !== 'deleted').map((t) => ({ id: t.id, task_description: t.subject, completed: t.status === 'completed' })),
        },
      },
    ],
  };
}

/** Standard ACP `plan` update from todos (05 §7.4). */
export function planUpdate(todos: readonly TodoItem[]): Record<string, unknown> {
  return {
    sessionUpdate: 'plan',
    entries: todos
      .filter((t) => t.status !== 'deleted')
      .map((t) => ({ content: t.subject, priority: 'medium', status: t.status === 'deleted' ? 'completed' : t.status })),
  };
}

function exitCodeOf(text: string): number | undefined {
  const m = /exit code[:\s]+(\d+)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

export interface ToolResultInput {
  isError: boolean;
  /** Short text rendering of the result. */
  output: string;
  /** Structured Claude `tool_use_result` / `tool_response`. */
  response?: unknown;
  /** Current todo snapshot (todo tools). */
  todos?: readonly TodoItem[];
}

/**
 * Result updates for a finished call: for shell a content-only update first (kiro-cli order,
 * `[KCF:session]`), then the final update with status, kind, title, rawInput and rawOutput.
 */
export function toolResultUpdates(d: ToolDescriptor, r: ToolResultInput): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const resp = r.response;
  const base = (status: 'completed' | 'failed'): Record<string, unknown> => ({
    sessionUpdate: 'tool_call_update',
    toolCallId: d.toolCallId,
    kind: d.updateKind,
    status,
    title: d.title,
    _meta: meta(d),
  });

  if (d.family === 'shell') {
    let stdout = '';
    let stderr = '';
    if (isObj(resp)) {
      stdout = str(resp.stdout) ?? '';
      stderr = str(resp.stderr) ?? '';
    }
    let code = r.isError ? 1 : 0;
    if (!isObj(resp) || (stdout === '' && stderr === '')) {
      const text = stripToolUseError(typeof resp === 'string' ? resp : r.output);
      if (r.isError) {
        code = exitCodeOf(text) ?? 1;
        stderr = text.replace(/^(Error:\s*)?Exit code \d+\s*\n?/i, '');
      } else if (!/^\(Bash completed with no output\)$/.test(text.trim())) {
        stdout = text;
      }
    } else if (r.isError) {
      code = exitCodeOf(str(resp.returnCodeInterpretation) ?? '') ?? 1;
    }
    stdout = capText(stdout);
    stderr = capText(stderr);
    const shown = stdout && stderr ? `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${stderr}` : stdout || stderr;
    if (shown) out.push({ sessionUpdate: 'tool_call_update', toolCallId: d.toolCallId, content: [textContent(shown)], _meta: meta(d) });
    out.push({
      ...base(r.isError ? 'failed' : 'completed'),
      rawInput: d.rawInput,
      rawOutput: { items: [{ Json: { exit_status: `exit status: ${code}`, stdout, stderr } }] },
    });
    return out;
  }

  if (r.isError) {
    const text = capText(stripToolUseError(typeof resp === 'string' && resp ? resp : r.output) || 'Tool failed');
    out.push({ ...base('failed'), content: [textContent(text)], rawInput: d.rawInput, rawOutput: { items: [{ Text: text }] } });
    return out;
  }

  switch (d.family) {
    case 'read': {
      let text: string | undefined;
      if (isObj(resp) && isObj(resp.file) && typeof resp.file.content === 'string') text = resp.file.content;
      else if (isObj(resp) && resp.type === 'image') text = '[image]';
      text = capText(text ?? stripReadDecorations(r.output));
      const u: Record<string, unknown> = { ...base('completed') };
      if (d.locations) u.locations = d.locations;
      out.push({ ...u, content: [textContent(text)], rawInput: d.rawInput, rawOutput: { items: [{ Text: text }] } });
      return out;
    }
    case 'write':
    case 'edit': {
      // keep the diff shown on the tool_call (content absent = unchanged)
      const text = capText(r.output || 'Done');
      out.push({ ...base('completed'), rawInput: d.rawInput, rawOutput: { items: [{ Text: text }] } });
      return out;
    }
    case 'mcp': {
      let blocks: unknown[] | undefined;
      if (Array.isArray(resp)) blocks = resp;
      else if (isObj(resp) && Array.isArray(resp.content)) blocks = resp.content;
      if (!blocks || blocks.length === 0) blocks = [{ type: 'text', text: r.output }];
      blocks = jsonClone(blocks).map((b) => (isObj(b) && typeof b.text === 'string' ? { ...b, text: capText(b.text) } : b));
      const text = blocksText(blocks);
      const u: Record<string, unknown> = { ...base('completed') };
      if (text) u.content = [textContent(text)];
      out.push({ ...u, rawInput: d.rawInput, rawOutput: { items: [{ Json: { content: blocks } }] } });
      return out;
    }
    case 'todo': {
      const u: Record<string, unknown> = { ...base('completed') };
      if (r.output) u.content = [textContent(capText(r.output))];
      out.push({ ...u, rawInput: d.rawInput, rawOutput: todoSnapshot(r.todos ?? []) });
      return out;
    }
    default: {
      let text = r.output;
      if (d.family === 'subagent') text = stripSubagentTrailer(text);
      text = capText(text);
      const u: Record<string, unknown> = { ...base('completed') };
      if (text) u.content = [textContent(text)];
      out.push({ ...u, rawInput: d.rawInput, rawOutput: { items: [{ Text: text }] } });
      return out;
    }
  }
}

/** Drop trailing `agentId: …` / `<usage>…</usage>` lines of a subagent report (05 §7.3). */
export function stripSubagentTrailer(s: string): string {
  return s
    .replace(/\s*<usage>[\s\S]*?<\/usage>\s*$/, '')
    .replace(/\s*agentId:\s*\S+(?:\s*\([^)]*\))?\s*$/, '')
    .trimEnd();
}

/**
 * kiro-cli's denial frame (05 §5.2, `[KCF:side-read-only-live]`): failed, title = tool name,
 * text, rawInput, `_meta.kiro.toolCallFailureReason:"permission_denied"`.
 */
export function deniedUpdate(d: ToolDescriptor, text: string = USER_DENIED_TEXT): Record<string, unknown> {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: d.toolCallId,
    kind: d.updateKind,
    status: 'failed',
    title: d.kiroToolName,
    content: [textContent(capText(text))],
    rawInput: d.rawInput,
    _meta: meta(d, { toolCallFailureReason: 'permission_denied' }),
  };
}

/** A call that never finished (turn cancelled / crashed): failed, no output. */
export function abandonedUpdate(d: ToolDescriptor): Record<string, unknown> {
  return { sessionUpdate: 'tool_call_update', toolCallId: d.toolCallId, kind: d.updateKind, status: 'failed', title: d.title, _meta: meta(d) };
}

/** `status:"in_progress"` after an allowed permission request (05 §6.1 step 6). */
export function inProgressUpdate(d: ToolDescriptor): Record<string, unknown> {
  return { sessionUpdate: 'tool_call_update', toolCallId: d.toolCallId, status: 'in_progress', _meta: meta(d) };
}

// ───────────────────────────── permission trust options (P2) ─────────────────────────────

/** Rust `regex::escape` (kiro-cli builds its `allowedCommands` patterns with it). */
export function rustRegexEscape(s: string): string {
  return s.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, (c) => `\\${c}`);
}

/**
 * `session/request_permission._meta.trustOptions` (05 §6.1, `[KCF:session]`,
 * `[KCF:side-read-only-live]`): shell ⇒ Full / Partial / Base command; writes ⇒ Specific paths /
 * Complete directory. The Partial rule (first two words) is inferred from the captures
 * (UNVERIFIED for longer commands). undefined for other tools.
 */
export function trustOptionsFor(d: ToolDescriptor, cwd: string): Record<string, unknown>[] | undefined {
  if (d.family === 'shell') {
    const cmd = (str(d.rawInput.command) ?? '').trim();
    if (!cmd || cmd.includes('\n')) return undefined;
    const words = cmd.split(/\s+/);
    const out: Record<string, unknown>[] = [{ label: 'Full command', display: cmd, setting_key: 'allowedCommands', patterns: [rustRegexEscape(cmd)] }];
    if (words.length >= 2) {
      const partial = words.slice(0, 2).join(' ');
      out.push({ label: 'Partial command', display: `${partial} *`, setting_key: 'allowedCommands', patterns: [`${rustRegexEscape(partial)}( .*)?`] });
    }
    out.push({ label: 'Base command', display: `${words[0]} *`, setting_key: 'allowedCommands', patterns: [`${rustRegexEscape(words[0]!)}( .*)?`] });
    return out;
  }
  if (d.family === 'write' || d.family === 'edit') {
    const abs = d.locations?.[0]?.path;
    if (!abs) return undefined;
    const dir = path.dirname(abs);
    return [
      { label: 'Specific paths', display: displayPath(abs, cwd), setting_key: 'runtime_write_paths', patterns: [abs] },
      { label: 'Complete directory', display: dir, setting_key: 'runtime_write_paths', patterns: [dir] },
    ];
  }
  return undefined;
}

// ───────────────────────────── turn results ─────────────────────────────

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/**
 * `TurnResult` (+ the raw Claude `result` frame when known) ⇒ ACP stop reason (05 §7.6);
 * undefined means the turn failed and must end with a JSON-RPC error ({@link turnErrorToRpc}).
 */
export function mapStopReason(r: TurnResult, rawResult?: Record<string, unknown>): AcpStopReason | undefined {
  const maxTokens = rawResult?.stop_reason === 'max_tokens';
  switch (r.stopReason) {
    case 'cancelled':
      return 'cancelled';
    case 'refusal':
      return 'refusal';
    case 'max_turns':
      return 'max_turn_requests';
    case 'local_command':
      return 'end_turn';
    case 'error':
      if (!r.isError) return maxTokens ? 'max_tokens' : 'end_turn';
      return undefined;
    case 'end_turn':
    default:
      if (r.isError) return undefined;
      return maxTokens ? 'max_tokens' : 'end_turn';
  }
}

/** `PromptResponse.usage` (05 §7.7; unstable ACP schema). */
export function promptUsage(u: TurnUsage | undefined): Record<string, number> | undefined {
  if (!u) return undefined;
  const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  return {
    totalTokens: total,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cachedReadTokens: u.cacheReadTokens,
    cachedWriteTokens: u.cacheCreationTokens,
  };
}

export interface TurnErrorHints {
  /** Last `rate_limit` event status seen during the turn (+ window type from the raw frame). */
  rateLimit?: { status: string; rateLimitType?: string };
  /** Claude assistant frame `error` (authentication_failed, rate_limit, overloaded, …). */
  assistantError?: string;
  /** Kiro model id in use (for `Invalid model ID`). */
  model?: string;
}

/** The KiroCrew-classifiable auth error message (08 KC-AUTH-04, 08a §2.6). */
export const AUTH_ERROR_MESSAGE = 'Not logged in to Claude Code (HTTP 401): run kiro-claude login';

/**
 * A failed turn as a JSON-RPC error whose text KiroCrew's transport-error classifier
 * recognizes (08a §2.6): auth ⇒ `-32000` with `HTTP 401`; usage limits, throttling, overload
 * and unknown models get KiroCrew's phrasings; everything else `-32603` with Claude's text.
 */
export function turnErrorToRpc(r: TurnResult, hints: TurnErrorHints = {}): RpcError {
  const detail = (r.error || r.text || '').trim();
  if (r.authError || hints.assistantError === 'authentication_failed' || (detail && AUTH_ERROR_TEXT.test(detail))) {
    return new RpcError(
      ErrorCodes.AUTH_REQUIRED,
      AUTH_ERROR_MESSAGE,
      `Claude Code is not logged in. Run \`claude auth login\` (or \`kiro-claude login\`).${detail ? ` (${detail})` : ''}`,
    );
  }
  const suffix = detail ? ` (${detail})` : '';
  if (hints.rateLimit?.status === 'rejected') {
    const t = (hints.rateLimit.rateLimitType ?? '').toLowerCase();
    const phrase = t.includes('five') || t.includes('5') ? "You've hit your 5-hour limit" : t.includes('seven') || t.includes('week') ? "You've hit your weekly usage limit" : "You've hit your usage limit";
    return internalError(`Claude usage limit reached: ${phrase}${suffix}`);
  }
  switch (hints.assistantError) {
    case 'rate_limit':
      return internalError(`rate limit exceeded, please try again${suffix}`);
    case 'overloaded':
    case 'server_error':
      return internalError(`API Error: 529 overloaded_error${suffix}`);
    case 'model_not_found':
      return internalError(`Invalid model ID: ${hints.model ?? 'unknown'}${suffix}`);
    default:
      break;
  }
  return internalError(detail || 'Claude Code turn failed');
}

// ───────────────────────────── prompt content ─────────────────────────────

function basenameOfUri(uri: string): string {
  const noQuery = uri.replace(/[?#].*$/, '');
  const seg = noQuery.split('/').filter((s) => s !== '');
  const last = seg[seg.length - 1] ?? uri;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** XML attribute escaping for the `<context ref="…">` wrapper (a uri must not end the attribute). */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function linkText(uri: string, name?: string): string {
  if (uri.startsWith('file://') || uri.startsWith('zed://')) return `[@${name || basenameOfUri(uri)}](${uri})`;
  return uri;
}

/**
 * ACP `ContentBlock[]` ⇒ {@link PromptInput} (05 §4.5.1): text verbatim; images (base64) as
 * images, http(s) image URIs as text; `resource_link` ⇒ `[@name](uri)` for `file://`/`zed://`,
 * else the uri; embedded text `resource` ⇒ link in place + `<context ref="uri">` block at the
 * end; embedded image blobs ⇒ images; other blobs and audio are skipped (noted in `skipped`).
 * Text pieces are joined with newlines.
 */
export function promptToInput(blocks: unknown): { input: PromptInput; skipped: string[] } {
  const parts: string[] = [];
  const contexts: string[] = [];
  const images: { mediaType: string; dataBase64: string }[] = [];
  const skipped: string[] = [];
  const list = Array.isArray(blocks) ? blocks : [];
  for (const b of list) {
    if (!isObj(b)) continue;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string') parts.push(b.text);
        break;
      case 'image': {
        const data = str(b.data);
        const mime = str(b.mimeType) ?? 'image/png';
        if (data) images.push({ mediaType: mime, dataBase64: data });
        else if (str(b.uri)) parts.push(str(b.uri)!);
        break;
      }
      case 'resource_link': {
        const uri = str(b.uri);
        if (uri) parts.push(linkText(uri, str(b.name)));
        break;
      }
      case 'resource': {
        const res = isObj(b.resource) ? b.resource : undefined;
        const uri = res ? str(res.uri) : undefined;
        if (!res || !uri) break;
        if (typeof res.text === 'string') {
          parts.push(linkText(uri));
          contexts.push(`\n<context ref="${escapeAttr(uri)}">\n${res.text}\n</context>`);
        } else if (typeof res.blob === 'string') {
          const mime = str(res.mimeType) ?? '';
          if (mime.startsWith('image/')) images.push({ mediaType: mime, dataBase64: res.blob });
          else skipped.push(`resource ${uri} (${mime || 'binary'})`);
        }
        break;
      }
      case 'audio':
        skipped.push('audio');
        break;
      default:
        skipped.push(String(b.type));
    }
  }
  let text = parts.join('\n');
  if (contexts.length) text += contexts.join('');
  const input: PromptInput = { text };
  if (images.length) input.images = images;
  return { input, skipped };
}

// ───────────────────────────── MCP servers ─────────────────────────────

function nameValueList(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(v)) {
    for (const e of v) {
      if (isObj(e) && typeof e.name === 'string' && e.name !== '') out[e.name] = typeof e.value === 'string' ? e.value : String(e.value ?? '');
    }
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  }
  return out;
}

/**
 * `session/new|load.mcpServers` ⇒ {@link McpServerConfig}s (05 §4.3 schema, §4.3.2 step 3):
 * stdio `{name, command, args, env:[{name,value}]}` (no `type` or `type:"stdio"`), http/sse
 * `{type, name, url, headers:[{name,value}]}`. Values are used verbatim (KiroCrew's per-session
 * tokens must reach the server unchanged, 08 KC-ENV-02). Malformed entries are skipped and
 * reported in `warnings`; a non-array is an invalid-params error. Missing ⇒ `[]` (lenient,
 * 05 §4.3).
 */
export function acpMcpServersToConfigs(list: unknown): { servers: McpServerConfig[]; warnings: string[] } {
  if (list === undefined || list === null) return { servers: [], warnings: [] };
  if (!Array.isArray(list)) throw invalidParams('mcpServers must be an array');
  const servers: McpServerConfig[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    if (!isObj(e) || typeof e.name !== 'string' || e.name.trim() === '') {
      warnings.push('skipped an MCP server without a name');
      continue;
    }
    const name = e.name;
    const t = typeof e.type === 'string' ? e.type.toLowerCase() : 'stdio';
    const base = { name, args: [] as string[], env: {} as Record<string, string>, headers: {} as Record<string, string>, disabled: false, autoApprove: [] as string[], disabledTools: [] as string[], origin: 'agent' as const };
    let server: McpServerConfig | undefined;
    if (t === 'http' || t === 'sse') {
      if (typeof e.url !== 'string' || e.url === '') {
        warnings.push(`skipped MCP server '${name}': ${t} servers need a url`);
        continue;
      }
      server = { ...base, type: t, url: e.url, headers: nameValueList(e.headers) };
    } else if (t === 'stdio') {
      if (typeof e.command !== 'string' || e.command === '') {
        warnings.push(`skipped MCP server '${name}': stdio servers need a command`);
        continue;
      }
      server = {
        ...base,
        type: 'stdio',
        command: e.command,
        args: Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : [],
        env: nameValueList(e.env),
      };
    } else {
      warnings.push(`skipped MCP server '${name}': unsupported type '${String(e.type)}'`);
      continue;
    }
    if (seen.has(name)) {
      // last one wins, like a JSON object
      const i = servers.findIndex((s) => s.name === name);
      if (i >= 0) servers.splice(i, 1);
    }
    seen.add(name);
    servers.push(server);
  }
  return { servers, warnings };
}

// ───────────────────────────── modes / models / config options ─────────────────────────────

/** `modes` state: every loadable agent, `currentModeId` = the session's agent (05 §4.3.1). */
export function modeState(agents: Iterable<Pick<KiroAgent, 'name' | 'description'>>, currentId: string): Record<string, unknown> {
  const availableModes: Record<string, unknown>[] = [];
  let hasCurrent = false;
  for (const a of agents) {
    if (a.name === currentId) hasCurrent = true;
    availableModes.push({ id: a.name, name: a.name, ...(a.description ? { description: a.description } : {}) });
  }
  if (!hasCurrent) availableModes.unshift({ id: currentId, name: currentId });
  return { currentModeId: currentId, availableModes };
}

/** kiro-cli legacy `models` state; `currentModelId` always listed (05 §4.3.1). */
export function modelState(entries: readonly ModelEntry[], currentId: string): Record<string, unknown> {
  const availableModels = entries.map((e) => ({
    modelId: e.kiroId,
    name: e.kiroId === 'auto' ? 'auto' : e.displayName || e.kiroId,
    description: e.description ?? '',
  }));
  if (!availableModels.some((m) => m.modelId === currentId)) availableModels.push({ modelId: currentId, name: currentId, description: '' });
  return { currentModelId: currentId, availableModels };
}

/** Standard ACP `configOptions` (model + effort selects; 05 §4.3.1). */
export function configOptions(entries: readonly ModelEntry[], currentModel: string, effort: string | undefined): Record<string, unknown>[] {
  const models = entries.map((e) => ({ value: e.kiroId, name: e.kiroId === 'auto' ? 'auto' : e.displayName || e.kiroId }));
  if (!models.some((m) => m.value === currentModel)) models.push({ value: currentModel, name: currentModel });
  const eff = effort && EFFORT_LEVELS.includes(effort) ? effort : 'medium';
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: currentModel, options: models },
    {
      id: 'effortLevel',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: eff,
      options: EFFORT_LEVELS.map((l) => ({ value: l, name: EFFORT_NAMES[l] ?? l })),
    },
  ];
}

/**
 * Resolve a client model id against the advertised list (08 KC-ACP-08: anything else is
 * `Invalid model ID: <id>`). Accepts Kiro ids, Claude values, display names and Claude
 * aliases (05 §7.10). Returns the id to pass to `KiroSession.setModel`.
 */
export function resolveModelId(entries: readonly ModelEntry[], id: string): string | undefined {
  const t = id.trim();
  if (t === '') return undefined;
  const e = findModelEntry(entries, t);
  if (e) return e.kiroId;
  const lower = t.toLowerCase();
  const base = lower.endsWith('[1m]') ? lower.slice(0, -4) : lower;
  if (CLAUDE_ALIASES.includes(base)) return lower;
  return undefined;
}

/** The KiroCrew-classifiable unknown-model error (08 KC-ACP-08). */
export function invalidModelError(id: string): RpcError {
  return new RpcError(ErrorCodes.INVALID_PARAMS, `Invalid model ID: ${id}`, `Invalid model ID: ${id}`);
}

/** Context percentage from a raw Claude `result` frame (05 §5.3 fallback). */
export function contextFromResult(raw: Record<string, unknown> | undefined): { used: number; size: number } | undefined {
  if (!raw) return undefined;
  const u = isObj(raw.usage) ? raw.usage : undefined;
  if (!u) return undefined;
  const used =
    (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) + (num(u.output_tokens) ?? 0);
  let size: number | undefined;
  if (isObj(raw.modelUsage)) {
    for (const v of Object.values(raw.modelUsage)) {
      if (isObj(v) && num(v.contextWindow)) size = Math.max(size ?? 0, num(v.contextWindow)!);
    }
  }
  if (!size) return undefined;
  return { used, size };
}
