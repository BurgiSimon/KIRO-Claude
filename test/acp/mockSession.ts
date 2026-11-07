/**
 * A scripted in-memory {@link KiroSession} for ACP server tests. It mimics what the session
 * module does at the boundaries the ACP server sees: SessionEvents from `prompt()`, approvals
 * through `ui.requestApproval` (with Kiro-like policy: read-only tools and `allowedTools` /
 * session trust skip the question; `tools: []` agents never call tools), the session index
 * file and the `<sid>.jsonl` journal, resume of a stored conversation (`world.histories`
 * stands in for Claude's transcript), steering, interrupts, compaction and agent swaps.
 *
 * Script steps (`MockTurn.steps`):
 *  { text } | { thinking } | { tool: MockTool } | { todos } | { raw } | { sleepMs } |
 *  { result: Partial<TurnResult> } | { subagent } | { compaction: true }
 * Text templates: `{{history}}` (earlier user texts, ` | `), `{{steers}}` (steers received
 * this turn), `{{user}}` (this prompt's text).
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  ApprovalResponse,
  ContextReport,
  KiroAgent,
  KiroHook,
  KiroSession,
  KiroSessionOptions,
  McpStatusEntry,
  ModelEntry,
  PromptInput,
  SessionEvent,
  SessionRecord,
  SessionTrust,
  TodoItem,
  ToolListingEntry,
  TurnResult,
  UsageReport,
} from '../../src/types.js';
import { loadAgents } from '../../src/config/agents.js';
import { openSettings } from '../../src/config/settings.js';
import { buildModelList } from '../../src/models/models.js';
import { SessionStore, sessionsDir } from '../../src/session/store.js';
import { toKiroCall, normalizeV2Name } from '../../src/policy/toolmap.js';

export interface MockTool {
  name: string;
  input?: Record<string, unknown>;
  id?: string;
  /** Text result (default `ok`). */
  result?: string;
  response?: unknown;
  isError?: boolean;
  /** Interruptible run time. */
  durationMs?: number;
  /** Override the policy decision. */
  permission?: 'allow' | 'ask' | 'deny';
  /** Inside a Claude subagent: emit raw frames only (no tool_start/tool_end events). */
  parentToolUseId?: string;
}

export type MockStep =
  | { text: string; chunks?: string[] }
  | { thinking: string }
  | { tool: MockTool }
  | { todos: TodoItem[] }
  | { raw: Record<string, unknown> }
  | { sleepMs: number }
  | { result: Partial<TurnResult> }
  | { subagent: { state: 'started' | 'finished'; agentType: string; toolUseId?: string; description?: string; prompt?: string; isError?: boolean; error?: string } }
  | { compaction: true };

export interface MockTurn {
  match?: RegExp;
  steps: MockStep[];
}

export interface MockWorld {
  turns: MockTurn[];
  /** Conversation history per session id (what `--resume` would restore). */
  histories: Map<string, string[]>;
  sessions: MockSession[];
  created: KiroSessionOptions[];
  /** Calls made on sessions: `start`, `swapAgent:x`, `setModel:x`, `setEffort:x`, `clear`, `compact`, `interrupt`, `close`, `steer:<text>` */
  calls: string[];
  /** MCP status override (default: every configured server `connected`). */
  mcp?: McpStatusEntry[];
  /** Make `start()` fail with this message. */
  startError?: string;
  toolListing?: ToolListingEntry[];
  /** What `steer()` returns (default: nothing, i.e. the line's uuid is unknown to the server). */
  steerLine?: (text: string) => { uuid: string; withdraw(): Promise<boolean> } | void;
}

export function createWorld(turns: MockTurn[] = []): MockWorld {
  return { turns, histories: new Map(), sessions: [], created: [], calls: [] };
}

export function mockFactory(world: MockWorld): (opts: KiroSessionOptions) => Promise<KiroSession> {
  return async (opts) => {
    world.created.push(opts);
    const s = new MockSession(world, opts);
    world.sessions.push(s);
    return s;
  };
}

const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Skill']);

function fallbackAgent(name: string): KiroAgent {
  return {
    name,
    format: 'builtin',
    scope: 'builtin',
    dialect: 'v2',
    tools: ['*'],
    excludedTools: [],
    mcpServers: {},
    includeMcpJson: false,
    useLegacyMcpJson: false,
    resources: [],
    hooks: [],
    permissions: [],
    allowedTools: [],
    toolsSettings: {},
    toolAliases: {},
    inheritDefaultResources: true,
    warnings: [],
  };
}

export class MockSession extends EventEmitter implements KiroSession {
  readonly id: string;
  claudeSessionId: string | undefined;
  agent: KiroAgent;
  model: string;
  effort: string | undefined;
  readonly trust: SessionTrust;
  readonly interactive: boolean;
  record: SessionRecord;
  planMode = false;
  readonly tangent = undefined;
  closed = false;
  started = false;
  steers: string[] = [];
  private todoList: TodoItem[] = [];
  private current: AbortController | undefined;
  private readonly store: SessionStore;
  private readonly journal: string;
  private readonly world: MockWorld;
  readonly opts: KiroSessionOptions;
  turnCount = 0;

  constructor(world: MockWorld, opts: KiroSessionOptions) {
    super();
    this.world = world;
    this.opts = opts;
    this.interactive = opts.interactive;
    this.store = new SessionStore(sessionsDir(opts.ws));
    const resumeId = opts.resume && 'sessionId' in opts.resume ? opts.resume.sessionId : undefined;
    const existing = resumeId ? this.store.read(resumeId) : undefined;
    if (resumeId && !existing) throw new Error(`No saved session with id ${resumeId}`);
    this.agent = this.findAgent(opts.agentName ?? existing?.agent ?? 'kiro_default');
    this.model = opts.model ?? existing?.model ?? 'auto';
    this.effort = opts.effort ?? existing?.effort;
    this.trust = { trustAll: opts.trustAllTools === true, allowedTools: [...(opts.trustTools ?? []).map(normalizeV2Name)], rules: [] };
    if (existing) {
      this.id = existing.sessionId;
      this.record = existing;
      this.claudeSessionId = existing.claudeSessionId;
      // "Claude --resume": rebuild the conversation from disk only (works across processes)
      const texts: string[] = [];
      try {
        for (const line of fs.readFileSync(path.join(sessionsDir(opts.ws), `${this.id}.jsonl`), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const r = JSON.parse(line) as { kind?: string; data?: { content?: Array<{ kind: string; data: unknown }> } };
          if (r.kind === 'Prompt') for (const c of r.data?.content ?? []) if (c.kind === 'text') texts.push(String(c.data));
        }
      } catch {
        // no journal
      }
      world.histories.set(this.id, texts);
    } else {
      this.record = this.store.create({ origin: opts.origin, cwd: opts.ws.cwd, agent: this.agent.name, model: this.model, ...(this.effort ? { effort: this.effort } : {}) });
      this.id = this.record.sessionId;
      this.claudeSessionId = this.id;
      world.histories.set(this.id, []);
    }
    this.journal = path.join(sessionsDir(opts.ws), `${this.id}.jsonl`);
  }

  private findAgent(name: string): KiroAgent {
    const loaded = loadAgents(this.opts.ws, { settings: openSettings(this.opts.ws) });
    return loaded.agents.get(name) ?? fallbackAgent(name);
  }

  private journalAppend(kind: string, content: unknown[]): void {
    fs.appendFileSync(this.journal, `${JSON.stringify({ version: 1, kind, timestamp: new Date().toISOString(), data: { message_id: randomUUID(), content } })}\n`);
  }

  async start(): Promise<void> {
    this.world.calls.push('start');
    if (this.world.startError) throw new Error(this.world.startError);
    this.started = true;
  }

  private history(): string[] {
    return this.world.histories.get(this.id) ?? [];
  }

  private allowedByPolicy(claudeName: string, kiroName: string, v2Name: string): boolean {
    if (this.trust.trustAll) return true;
    if (READ_ONLY.has(claudeName)) return true;
    const allowed = [...this.agent.allowedTools, ...this.trust.allowedTools];
    for (const a of allowed) {
      if (a === kiroName || a === v2Name || normalizeV2Name(a) === v2Name) return true;
      if (v2Name.startsWith('@') && (a === v2Name.split('/')[0] || a === v2Name)) return true;
    }
    return false;
  }

  private sleep(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(false);
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);
      const onAbort = (): void => {
        clearTimeout(t);
        resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private fill(s: string, user: string): string {
    return s.replace(/\{\{history\}\}/g, this.history().join(' | ')).replace(/\{\{steers\}\}/g, this.steers.join(' | ')).replace(/\{\{user\}\}/g, user);
  }

  /** Like the real session: every event is emitted as `'event'` and yielded. */
  async *prompt(input: PromptInput, opts: { signal?: AbortSignal } = {}): AsyncGenerator<SessionEvent, TurnResult> {
    const g = this.promptInner(input, opts);
    for (;;) {
      const r = await g.next();
      if (r.done) return r.value;
      this.emit('event', r.value);
      yield r.value;
    }
  }

  private async *promptInner(input: PromptInput, opts: { signal?: AbortSignal } = {}): AsyncGenerator<SessionEvent, TurnResult> {
    if (!this.started) throw new Error('session not started');
    const ac = new AbortController();
    this.current = ac;
    opts.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    const signal = ac.signal;
    this.turnCount++;
    const turn = this.world.turns.find((t) => !t.match || t.match.test(input.text)) ?? { steps: [{ text: 'ok' }] };
    const toolsAllowed = this.agent.tools.length > 0;
    let finalText = '';
    let override: Partial<TurnResult> = {};
    let cancelled = false;
    this.journalAppend('Prompt', [{ kind: 'text', data: input.text }]);
    const toolResults: unknown[] = [];
    try {
      for (const step of turn.steps) {
        if (signal.aborted) {
          cancelled = true;
          break;
        }
        if ('text' in step) {
          const text = this.fill(step.text, input.text);
          for (const c of step.chunks ?? [text]) {
            yield { type: 'text_delta', text: this.fill(c, input.text) };
          }
          finalText += text;
        } else if ('thinking' in step) {
          yield { type: 'thinking_delta', text: step.thinking };
        } else if ('todos' in step) {
          this.todoList = step.todos.map((t) => ({ ...t }));
          yield { type: 'todo_update', todos: this.todoList.map((t) => ({ ...t })) };
        } else if ('raw' in step) {
          yield { type: 'raw', frame: step.raw };
        } else if ('sleepMs' in step) {
          if (!(await this.sleep(step.sleepMs, signal))) {
            cancelled = true;
            break;
          }
        } else if ('result' in step) {
          override = { ...override, ...step.result };
        } else if ('subagent' in step) {
          yield { type: 'subagent', ...step.subagent };
        } else if ('compaction' in step) {
          yield { type: 'compaction', state: 'started' };
          yield { type: 'compaction', state: 'finished', preTokens: 5000, postTokens: 1000 };
          yield { type: 'raw', frame: { type: 'user', isSynthetic: true, message: { role: 'user', content: 'This session is being continued.\n\nSummary:\nauto summary' } } };
        } else if ('tool' in step) {
          if (!toolsAllowed) continue;
          const t = step.tool;
          const id = t.id ?? `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
          const input2 = t.input ?? {};
          if (t.parentToolUseId) {
            yield { type: 'raw', frame: { type: 'assistant', parent_tool_use_id: t.parentToolUseId, message: { content: [{ type: 'tool_use', id, name: t.name, input: input2 }] } } };
            yield {
              type: 'raw',
              frame: { type: 'user', parent_tool_use_id: t.parentToolUseId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: t.result ?? 'ok', is_error: t.isError === true }] } },
            };
            continue;
          }
          const call = toKiroCall(t.name, input2, { cwd: this.opts.ws.cwd, toolUseId: id, mcpServerNames: {} });
          const ask = t.permission ? t.permission === 'ask' : !this.allowedByPolicy(t.name, call.kiro2Name, call.v2Name);
          // like the real session (onPreDecision): a gate denial emits tool_denied INSTEAD of tool_start
          if (t.permission !== 'deny') yield { type: 'tool_start', toolUseId: id, call, trusted: !ask };
          if (t.permission === 'deny') {
            yield { type: 'tool_denied', toolUseId: id, call, reason: 'Tool use denied by agent policy' };
            toolResults.push({ kind: 'toolResult', data: { toolUseId: id, content: [{ kind: 'text', data: 'denied' }], status: 'error' } });
            continue;
          }
          let resp: ApprovalResponse = { kind: 'allow-once' };
          if (ask) {
            resp = await this.opts.ui.requestApproval({ call, requestId: randomUUID(), reasons: ['not trusted'], agentName: this.agent.name }, signal);
          }
          if (resp.kind === 'allow-always') this.trust.allowedTools.push(call.v2Name);
          if (resp.kind === 'deny') {
            yield { type: 'tool_end', toolUseId: id, call, isError: true, output: resp.message ?? 'denied' };
            toolResults.push({ kind: 'toolResult', data: { toolUseId: id, content: [{ kind: 'text', data: resp.message ?? 'denied' }], status: 'error' } });
            continue;
          }
          if (resp.kind === 'cancelled' || resp.kind === 'redirect') {
            yield { type: 'tool_end', toolUseId: id, call, isError: true, output: 'The user doesn\'t want to proceed with this tool use.' };
            cancelled = true;
            break;
          }
          if (t.durationMs && !(await this.sleep(t.durationMs, signal))) {
            yield { type: 'tool_end', toolUseId: id, call, isError: true, output: 'interrupted' };
            cancelled = true;
            break;
          }
          const output = this.fill(t.result ?? 'ok', input.text);
          yield { type: 'tool_end', toolUseId: id, call, isError: t.isError === true, output, ...(t.response !== undefined ? { response: t.response } : {}) };
          toolResults.push({ kind: 'toolResult', data: { toolUseId: id, content: [{ kind: 'text', data: output }], status: t.isError ? 'error' : 'success' } });
        }
      }
    } finally {
      this.current = undefined;
    }
    if (toolResults.length) this.journalAppend('ToolResults', toolResults);
    if (cancelled || signal.aborted) {
      return { stopReason: 'cancelled', isError: false, text: '', permissionDenials: [] };
    }
    this.history().push(input.text);
    this.journalAppend('AssistantMessage', [{ kind: 'text', data: finalText }]);
    this.store.appendTurn(this.record, { userUuid: randomUUID(), preview: input.text, at: new Date().toISOString() }, finalText);
    return {
      stopReason: 'end_turn',
      isError: false,
      text: finalText,
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 40 },
      permissionDenials: [],
      ...override,
    };
  }

  steer(text: string): { uuid: string; withdraw(): Promise<boolean> } | void {
    this.world.calls.push(`steer:${text}`);
    this.steers.push(text);
    return this.world.steerLine?.(text);
  }

  async interrupt(): Promise<void> {
    this.world.calls.push('interrupt');
    this.current?.abort();
  }

  async swapAgent(name: string): Promise<void> {
    this.world.calls.push(`swapAgent:${name}`);
    this.agent = this.findAgent(name);
    this.record.agent = name;
  }

  async setModel(id: string): Promise<void> {
    this.world.calls.push(`setModel:${id}`);
    this.model = id;
  }

  async setEffort(level: string): Promise<void> {
    this.world.calls.push(`setEffort:${level}`);
    this.effort = level;
  }

  async listModels(): Promise<ModelEntry[]> {
    return buildModelList();
  }

  async addContext(globs: string[]): Promise<{ added: string[]; matched: Record<string, string[]> }> {
    return { added: globs, matched: {} };
  }
  async removeContext(globs: string[]): Promise<string[]> {
    return globs;
  }
  async clearContext(): Promise<void> {}
  async contextReport(): Promise<ContextReport> {
    return { agentEntries: [], sessionEntries: [], steering: [], hookOutputs: [], droppedFiles: [], totalTokens: 100, contextWindowTokens: 200_000 };
  }

  async clear(): Promise<void> {
    this.world.calls.push('clear');
    this.world.histories.set(this.id, []);
    this.claudeSessionId = randomUUID();
  }

  async *compact(instructions?: string): AsyncGenerator<SessionEvent, TurnResult> {
    this.world.calls.push(`compact${instructions ? `:${instructions}` : ''}`);
    yield { type: 'compaction', state: 'started' };
    yield { type: 'raw', frame: { type: 'system', subtype: 'compact_boundary' } };
    yield { type: 'compaction', state: 'finished', preTokens: 9000, postTokens: 2000 };
    yield {
      type: 'raw',
      frame: { type: 'user', isSynthetic: true, message: { role: 'user', content: `This session is being continued from a previous conversation.\n\nSummary:\n${this.history().join('\n') || 'nothing yet'}` } },
    };
    this.compacted = true;
    return { stopReason: 'local_command', isError: false, text: '', localCommand: 'compact', permissionDenials: [] };
  }
  compacted = false;

  async enterTangent(): Promise<void> {}
  async exitTangent(): Promise<void> {}
  async rewind(): Promise<void> {}
  forkSource(): { from: string; at?: string } | undefined {
    return this.claudeSessionId ? { from: this.claudeSessionId } : undefined;
  }

  toolListing(): ToolListingEntry[] {
    if (this.world.toolListing) return this.world.toolListing;
    if (this.agent.tools.length === 0) return [];
    const out: ToolListingEntry[] = [
      { name: 'read', claudeName: 'Read', source: 'builtin', permission: 'trusted' },
      { name: 'shell', claudeName: 'Bash', source: 'builtin', permission: 'not trusted' },
    ];
    for (const s of [...Object.keys(this.agent.mcpServers), ...(this.opts.extraMcpServers ?? []).map((m) => m.name)]) {
      out.push({ name: `@${s}/do_thing`, claudeName: `mcp__${s}__do_thing`, source: 'mcp', server: s, permission: 'not trusted' });
    }
    return out;
  }
  trustTools(names: string[]): void {
    this.trust.allowedTools.push(...names);
  }
  untrustTools(names: string[]): void {
    this.trust.allowedTools = this.trust.allowedTools.filter((n) => !names.includes(n));
  }
  setTrustAll(on: boolean): void {
    this.trust.trustAll = on;
  }
  resetTrust(): void {
    this.trust.allowedTools = [];
  }

  async usage(): Promise<UsageReport> {
    const tokens = this.compacted ? 2000 : 1000 * Math.max(1, this.turnCount);
    return { contextTokens: tokens, contextWindowTokens: 200_000, contextPercent: (tokens / 200_000) * 100, model: this.model };
  }

  async mcpStatus(): Promise<McpStatusEntry[]> {
    if (this.world.mcp) return this.world.mcp;
    const names = new Set([...Object.keys(this.agent.mcpServers), ...(this.opts.extraMcpServers ?? []).map((m) => m.name)]);
    return [...names].map((name) => ({ name, status: 'connected', toolCount: 1 }));
  }

  todos(): TodoItem[] {
    return this.todoList.map((t) => ({ ...t }));
  }
  hooks(): readonly KiroHook[] {
    return [];
  }
  async runManualHook(): Promise<import('../../src/types.js').ManualHookRun> {
    return { kind: 'not-found' };
  }
  async exportTo(p: string): Promise<string> {
    return p;
  }
  async close(): Promise<void> {
    this.world.calls.push('close');
    this.closed = true;
    this.current?.abort();
  }
}
