/**
 * Fixtures for hooks tests: hand-built KiroToolCall values (mirroring the 00 §4.1 master table,
 * without importing policy/), hooks with dialect defaults, and temp workspaces.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Capability, HookTrigger, KiroHook, KiroToolCall, WorkspaceContext } from '../../src/types.js';

interface Row {
  v3Id?: string;
  tag?: string;
  capability: Capability;
  kiro2Name: string;
  v2Name: string;
}

const ROWS: Record<string, Row> = {
  Read: { v3Id: 'read_file', tag: 'read', capability: 'fs_read', kiro2Name: 'read', v2Name: 'fs_read' },
  Glob: { v3Id: 'file_search', tag: 'read', capability: 'fs_read', kiro2Name: 'glob', v2Name: 'glob' },
  Grep: { v3Id: 'grep_search', tag: 'read', capability: 'fs_read', kiro2Name: 'grep', v2Name: 'grep' },
  Write: { v3Id: 'fs_write', tag: 'write', capability: 'fs_write', kiro2Name: 'write', v2Name: 'fs_write' },
  Edit: { v3Id: 'str_replace', tag: 'write', capability: 'fs_write', kiro2Name: 'write', v2Name: 'fs_write' },
  MultiEdit: { v3Id: 'str_replace', tag: 'write', capability: 'fs_write', kiro2Name: 'write', v2Name: 'fs_write' },
  NotebookEdit: { v3Id: 'fs_write', tag: 'write', capability: 'fs_write', kiro2Name: 'write', v2Name: 'fs_write' },
  Bash: { v3Id: 'execute_bash', tag: 'shell', capability: 'shell', kiro2Name: 'shell', v2Name: 'execute_bash' },
  WebFetch: { v3Id: 'web_fetch', tag: 'web', capability: 'web_fetch', kiro2Name: 'web_fetch', v2Name: 'web_fetch' },
  WebSearch: { v3Id: 'remote_web_search', tag: 'web', capability: 'web_search', kiro2Name: 'web_search', v2Name: 'web_search' },
  Agent: { v3Id: 'invoke_sub_agent', tag: 'subagent', capability: 'subagent', kiro2Name: 'subagent', v2Name: 'use_subagent' },
  Task: { v3Id: 'invoke_sub_agent', tag: 'subagent', capability: 'subagent', kiro2Name: 'subagent', v2Name: 'use_subagent' },
  Skill: { v3Id: 'disclose_context', tag: 'context', capability: 'skill', kiro2Name: 'skill', v2Name: 'skill' },
};

/** A KiroToolCall for a Claude tool (00 §4.1), cwd `/ws` by default. */
export function mkCall(claudeName: string, input: Record<string, unknown> = {}, cwd = '/ws'): KiroToolCall {
  const base = { claudeName, input, cwd, subjects: [] as string[], parseable: true, summary: '', toolUseId: 'toolu_1' };
  if (claudeName.startsWith('mcp__')) {
    const rest = claudeName.slice(5);
    const i = rest.indexOf('__');
    const server = rest.slice(0, i);
    const tool = rest.slice(i + 2);
    const body = `${server}_${tool}`.replace(/[\s-]/g, '_').replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
    return {
      ...base,
      v2Name: `@${server}/${tool}`,
      kiro2Name: `@${server}/${tool}`,
      v3Id: `mcp_${body}`.slice(0, 64),
      tags: ['@mcp', `@${server}`, `@${server}/${tool}`],
      capability: 'mcp',
      mcp: { server, tool },
      mutating: true,
      displayName: tool,
    };
  }
  if (/^Task[A-Z]/.test(claudeName)) {
    return { ...base, v2Name: 'todo_list', kiro2Name: 'todo_list', tags: ['@builtin'], capability: 'utility', mutating: false, displayName: 'todo_list' };
  }
  const row = ROWS[claudeName];
  if (!row) {
    return { ...base, v2Name: claudeName, kiro2Name: claudeName, tags: ['@builtin'], capability: 'utility', mutating: false, displayName: claudeName };
  }
  const cap = row.capability;
  return {
    ...base,
    v2Name: row.v2Name,
    kiro2Name: row.kiro2Name,
    ...(row.v3Id ? { v3Id: row.v3Id } : {}),
    tags: [...(row.tag ? [row.tag] : []), '@builtin'],
    capability: cap,
    mutating: cap === 'fs_write' || cap === 'shell' || cap === 'mcp' || cap === 'subagent',
    displayName: row.kiro2Name,
  };
}

const V2_KEYS: Partial<Record<HookTrigger, string>> = {
  SessionStart: 'agentSpawn',
  UserPromptSubmit: 'userPromptSubmit',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  Stop: 'stop',
};

let seq = 0;

/** A V2 (agent object-form) command hook with Q defaults. */
export function v2Hook(trigger: HookTrigger, command: string, extra: Partial<KiroHook> = {}): KiroHook {
  const key = V2_KEYS[trigger] ?? trigger;
  return {
    dialect: 'v2',
    source: 'agent',
    name: `${key}-${seq++}`,
    trigger,
    rawTrigger: key,
    action: { type: 'command', command },
    timeoutMs: 30_000,
    maxOutputBytes: 10_240,
    cacheTtlSec: 0,
    enabled: true,
    agentName: 'test-agent',
    ...extra,
  };
}

/** A V3 (v1 file / array form) hook with V3 defaults. `action` may be a command string or `{prompt}`. */
export function v3Hook(trigger: HookTrigger, action: string | { prompt: string }, extra: Partial<KiroHook> = {}): KiroHook {
  return {
    dialect: 'v3',
    source: 'workspace-file',
    name: `${trigger}-hook-${seq++}`,
    trigger,
    rawTrigger: trigger,
    action: typeof action === 'string' ? { type: 'command', command: action } : { type: 'agent', prompt: action.prompt },
    timeoutMs: 60_000,
    maxOutputBytes: 10_240,
    cacheTtlSec: 0,
    enabled: true,
    ...extra,
  };
}

/** Fresh temp workspace (`<tmp>/ws` with `.kiro/`); `cwd` = workspace root unless `sub` is given. */
export function mkWs(sub?: string): WorkspaceContext & { dir: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-hooks-')));
  const root = path.join(dir, 'ws');
  fs.mkdirSync(path.join(root, '.kiro'), { recursive: true });
  const cwd = sub ? path.join(root, sub) : root;
  fs.mkdirSync(cwd, { recursive: true });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, KIRO_HOME: path.join(home, '.kiro') };
  delete env.USER_PROMPT;
  return { dir, cwd, workspaceRoot: root, kiroHome: path.join(home, '.kiro'), home, env };
}

export function rmWs(ws: { dir: string }): void {
  fs.rmSync(ws.dir, { recursive: true, force: true });
}

/** Shell-quote for embedding test paths in hook commands. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
