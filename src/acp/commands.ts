/**
 * Kiro slash commands served over ACP: `_kiro.dev/commands/execute`, `_kiro.dev/commands/options`
 * and slash-prefixed `session/prompt` text (research 05 §4.5.2, §4.12, §7.8; 08 KC-ACP-05).
 *
 * This module holds the pure parts (parsing, result payloads, texts); the server runs them
 * against the live session. Result shapes are the ones KiroCrew reads:
 *  - `mcp`   ⇒ `{"success":true,"message":"N MCP servers","data":{"servers":[{"name","status":
 *              "running"|"failed"|"loading"|"disabled","toolCount","error"}]}}` (Claude
 *              `connected` ⇒ `running`, `pending` ⇒ `loading`, `needs-auth` ⇒ `failed`; the
 *              session's `stopped`, no Claude Code child to start it until the next prompt, ⇒
 *              `failed` with that reason as `error`, r11 #4)
 *  - `tools` ⇒ `{"success":true,"message":"N tools","data":{"tools":[{"name":"<kiro name>",
 *              "source":"builtin"|"mcp:<server>"}]}}`
 *  - `effort`⇒ `{"success":true,"message":"Effort set to <level>"}` (captured kiro-cli text)
 *  - `agent` ⇒ `data.agent.name`; anything unknown ⇒ `{"success":false,"message":"Unknown
 *              command: /<name>"}` (never forwarded to the model).
 * Reply texts other than `effort` are UNVERIFIED (05 §11 item 1) and follow 05 §4.12.
 */

import type { ContextReport, McpStatusEntry, PromptFile, ToolListingEntry, UsageReport } from '../types.js';
import { EFFORT_LEVELS } from './mapping.js';

export interface CommandResult {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

export interface ParsedCommand {
  name: string;
  args: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Split `/name rest` text into a command (`args = {value: rest}` when there is a rest, 05 §4.12). */
export function parseSlashText(text: string): ParsedCommand | undefined {
  const t = text.trim();
  if (!t.startsWith('/')) return undefined;
  const body = t.slice(1);
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!m) return undefined;
  const rest = (m[2] ?? '').trim();
  return { name: m[1]!, args: rest ? { value: rest } : {} };
}

/**
 * `_kiro.dev/commands/execute` `command`: the object form `{command, args}` (what KiroCrew
 * sends) or the legacy string form `"/name args"`.
 */
export function parseCommandParam(command: unknown): ParsedCommand | undefined {
  if (typeof command === 'string') return parseSlashText(command.trim().startsWith('/') ? command : `/${command}`);
  if (isObj(command)) {
    const raw = typeof command.command === 'string' ? command.command : typeof command.name === 'string' ? command.name : '';
    const name = raw.trim().replace(/^\//, '');
    if (!name) return undefined;
    const args = isObj(command.args) ? command.args : typeof command.args === 'string' && command.args !== '' ? { value: command.args } : {};
    // `"/model x"` passed as the command name
    const sp = /^(\S+)\s+([\s\S]+)$/.exec(name);
    if (sp && Object.keys(args).length === 0) return { name: sp[1]!, args: { value: sp[2]!.trim() } };
    return { name, args };
  }
  return undefined;
}

/** First string among `args[keys…]`. */
export function argString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/** Kiro commands handled locally in ACP mode (prompt path and commands/execute). */
export const ACP_COMMANDS: ReadonlyArray<{ name: string; description: string; hint?: string }> = Object.freeze([
  { name: 'compact', description: 'Compact the conversation history into a summary', hint: '[instructions]' },
  { name: 'clear', description: 'Clear the conversation history' },
  { name: 'model', description: 'Show or change the model', hint: '[model id]' },
  { name: 'agent', description: 'Show or swap the agent', hint: '[swap] <agent name>' },
  { name: 'effort', description: 'Set the reasoning effort', hint: '<low|medium|high|xhigh|max>' },
  { name: 'tools', description: 'List the tools available to the agent' },
  { name: 'mcp', description: 'Show MCP server status' },
  { name: 'context', description: 'Show context files and token usage' },
  { name: 'usage', description: 'Show context window usage' },
  { name: 'help', description: 'Show the available commands' },
]);

const COMMAND_NAMES = new Set(ACP_COMMANDS.map((c) => c.name));

/** True for a Kiro command name served locally. */
export function isAcpCommand(name: string): boolean {
  return COMMAND_NAMES.has(name);
}

/** `available_commands_update` (05 §7.8): Kiro commands + Kiro prompts (`Prompt: …`). */
export function availableCommandsUpdate(prompts: readonly PromptFile[]): Record<string, unknown> {
  const list: Record<string, unknown>[] = ACP_COMMANDS.map((c) => ({ name: c.name, description: c.description, ...(c.hint ? { input: { hint: c.hint } } : {}) }));
  const seen = new Set(ACP_COMMANDS.map((c) => c.name));
  for (const p of prompts) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    list.push({ name: p.name, description: `Prompt: ${p.description ?? p.name}`, input: { hint: '[arguments]' } });
  }
  return { sessionUpdate: 'available_commands_update', availableCommands: list };
}

/** `/help` text (Claude's `/help` is unavailable headless, 05 §4.5.2). */
export function helpText(prompts: readonly PromptFile[] = []): string {
  const width = Math.max(...ACP_COMMANDS.map((c) => c.name.length + (c.hint ? c.hint.length + 1 : 0))) + 2;
  const lines = ['kiro-claude (Kiro CLI on Claude Code) — commands:', ''];
  for (const c of ACP_COMMANDS) lines.push(`  /${`${c.name}${c.hint ? ` ${c.hint}` : ''}`.padEnd(width)}${c.description}`);
  if (prompts.length) {
    lines.push('', 'Prompts:');
    for (const p of prompts) lines.push(`  /${p.name.padEnd(width)}${p.description ?? ''}`.trimEnd());
  }
  lines.push('', 'Anything else is sent to the agent.');
  return `${lines.join('\n')}\n`;
}

/** Claude MCP status ⇒ the status words KiroCrew reads (08 KC-ACP-05). */
export function kiroMcpStatus(status: string): 'running' | 'failed' | 'loading' | 'disabled' {
  switch (status) {
    case 'connected':
    case 'running':
      return 'running';
    case 'pending':
    case 'loading':
    case 'connecting':
      return 'loading';
    case 'disabled':
      return 'disabled';
    default:
      return 'failed';
  }
}

/** `/mcp` result (08 KC-ACP-05). */
export function mcpResult(entries: readonly McpStatusEntry[]): CommandResult {
  const servers = entries.map((e) => ({
    name: e.name,
    status: kiroMcpStatus(e.status),
    ...(typeof e.toolCount === 'number' ? { toolCount: e.toolCount } : {}),
    ...(e.error ? { error: e.error } : {}),
  }));
  const lines = servers.map((s) => `${s.name}: ${s.status}${'toolCount' in s ? ` (${String(s.toolCount)} tools)` : ''}`);
  const head = `${servers.length} MCP server${servers.length === 1 ? '' : 's'}`;
  return { success: true, message: lines.length ? `${head}\n${lines.join('\n')}` : head, data: { servers } };
}

/** `/tools` result (08 KC-ACP-05): MCP rows are named by their tool and sourced `mcp:<server>`. */
export function toolsResult(entries: readonly ToolListingEntry[]): CommandResult {
  const tools = entries.map((e) => {
    if (e.source === 'mcp') {
      const server = e.server ?? '';
      let name = e.name;
      const prefix = `@${server}/`;
      if (server && name.startsWith(prefix)) name = name.slice(prefix.length);
      else if (e.claudeName.startsWith('mcp__')) name = e.claudeName.split('__').slice(2).join('__') || name;
      return { name, source: `mcp:${server}`, permission: e.permission };
    }
    // Claude's MCP tool-search loader under the kiro-cli name KiroCrew keys MCP deferral on
    // (`TOOL_SEARCH_LOADER_TOOL = "tool_search"`; also `_meta.kiro.toolName`, 05 §7.3)
    const name = e.claudeName === 'ToolSearch' ? 'tool_search' : e.name;
    return { name, source: 'builtin', permission: e.permission };
  });
  const lines = tools.map((t) => `${t.name} (${t.source}): ${t.permission}`);
  const head = `${tools.length} tool${tools.length === 1 ? '' : 's'}`;
  return { success: true, message: lines.length ? `${head}\n${lines.join('\n')}` : head, data: { tools } };
}

/** Effort validation; undefined when invalid. */
export function normalizeEffort(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const l = v.trim().toLowerCase();
  return EFFORT_LEVELS.includes(l) ? l : undefined;
}

export function invalidEffortResult(v: string | undefined): CommandResult {
  return {
    success: false,
    message: v ? `Invalid effort level: ${v}. Valid levels: ${EFFORT_LEVELS.join(', ')}` : `Specify an effort level: ${EFFORT_LEVELS.join(', ')}`,
  };
}

/** `/context` text. */
export function contextText(r: ContextReport): string {
  const lines: string[] = [];
  const pct = r.contextWindowTokens > 0 ? ((r.totalTokens / r.contextWindowTokens) * 100).toFixed(1) : '0.0';
  lines.push(`Context files: ~${r.totalTokens} tokens (${pct}% of ${r.contextWindowTokens})`);
  for (const e of [...r.agentEntries, ...r.sessionEntries]) {
    lines.push(`  ${e.pattern}`);
    for (const f of e.files) lines.push(`    ${f.path} (~${f.tokens} tokens)`);
  }
  for (const s of r.steering) lines.push(`  steering ${s.path} [${s.inclusion}] (~${s.tokens} tokens)`);
  if (r.droppedFiles.length) lines.push(`Dropped (over the context-file limit): ${r.droppedFiles.join(', ')}`);
  return lines.join('\n');
}

/** `/usage` text. */
export function usageText(u: UsageReport): string {
  const lines = [`Model: ${u.model}`];
  if (u.contextTokens !== undefined && u.contextWindowTokens) {
    const pct = u.contextPercent ?? (u.contextTokens / u.contextWindowTokens) * 100;
    lines.push(`Context: ${u.contextTokens} / ${u.contextWindowTokens} tokens (${pct.toFixed(1)}%)`);
  }
  for (const c of u.categories ?? []) lines.push(`  ${c.name}: ${c.tokens}`);
  if (u.rateLimit) lines.push(`Rate limit: ${u.rateLimit.status}${u.rateLimit.utilization !== undefined ? ` (${Math.round(u.rateLimit.utilization * 100)}% used)` : ''}`);
  lines.push('Claude Code subscription usage is not reported as Kiro credits.');
  return lines.join('\n');
}
