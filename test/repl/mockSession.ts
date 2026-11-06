/**
 * Scriptable KiroSession double for REPL tests.
 *
 * Each `prompt()` / `compact()` call consumes the next scripted turn: a list of steps (a
 * SessionEvent to yield, an approval request to send through the UI, an arbitrary async
 * action, or a wait for `interrupt()`), then a TurnResult. Every method call is recorded in
 * `calls` so tests can assert what the REPL asked the session to do.
 */

import { EventEmitter } from 'node:events';
import { toKiroCall } from '../../src/policy/toolmap.js';
import { previewText } from '../../src/session/store.js';
import type {
  ApprovalRequest,
  ApprovalResponse,
  ContextReport,
  KiroAgent,
  KiroHook,
  KiroSession,
  KiroSessionOptions,
  KiroToolCall,
  McpStatusEntry,
  ModelEntry,
  PromptInput,
  SessionEvent,
  SessionRecord,
  SessionTrust,
  SessionUI,
  TodoItem,
  ToolListingEntry,
  TurnResult,
  UsageReport,
} from '../../src/types.js';

export type MockStep =
  | SessionEvent
  | { approval: KiroToolCall; requestId?: string; expect?: (r: ApprovalResponse) => void }
  | { run: (ctx: { session: MockSession; signal: AbortSignal }) => Promise<void> | void }
  | { waitInterrupt: true };

export interface MockTurn {
  steps?: MockStep[];
  result?: Partial<TurnResult>;
  /** Do not append a `record.turns` entry for this turn. */
  noRecord?: boolean;
}

export function agentOf(name = 'kiro_default', extra: Partial<KiroAgent> = {}): KiroAgent {
  return {
    name,
    format: 'builtin',
    scope: 'builtin',
    dialect: 'v3',
    tools: ['*'],
    excludedTools: [],
    mcpServers: {},
    includeMcpJson: true,
    useLegacyMcpJson: false,
    resources: [],
    hooks: [],
    permissions: [],
    allowedTools: [],
    toolsSettings: {},
    toolAliases: {},
    inheritDefaultResources: true,
    warnings: [],
    ...extra,
  };
}

/** A KiroToolCall built with the real policy/toolmap mapping. */
export function call(claudeName: string, input: Record<string, unknown>, toolUseId = 'toolu_1', cwd = '/work'): KiroToolCall {
  return toKiroCall(claudeName, input, { cwd, toolUseId });
}

export const MODELS: ModelEntry[] = [
  { kiroId: 'auto', displayName: 'Default (recommended)', description: 'Claude Code default', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true },
  { kiroId: 'claude-opus-5.5', claudeValue: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Complex work', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { kiroId: 'claude-haiku-4.5', claudeValue: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fast', supportedEffortLevels: null },
  { kiroId: 'claude-sonnet-4.6', claudeValue: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Routine', supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
];

let counter = 0;

export class MockSession extends EventEmitter implements KiroSession {
  readonly id: string;
  claudeSessionId: string | undefined;
  agent: KiroAgent;
  model: string;
  effort: string | undefined;
  readonly trust: SessionTrust = { trustAll: false, allowedTools: [], rules: [] };
  readonly interactive = true;
  record: SessionRecord;
  planMode = false;
  tangent: { name: string | null; parentId: string } | undefined;

  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly prompts: PromptInput[] = [];
  readonly approvals: ApprovalResponse[] = [];
  readonly turns: MockTurn[] = [];
  ui: SessionUI | undefined;
  opts: KiroSessionOptions | undefined;
  started = false;
  closed = false;
  interrupted = 0;
  private interruptWaiters: (() => void)[] = [];

  listing: ToolListingEntry[] = [
    { name: 'read', claudeName: 'Read', source: 'builtin', permission: 'trusted' },
    { name: 'shell', claudeName: 'Bash', source: 'builtin', permission: 'not trusted' },
    { name: 'write', claudeName: 'Write', source: 'builtin', permission: 'not trusted' },
    { name: '@github/create_issue', claudeName: 'mcp__github__create_issue', source: 'mcp', server: 'github', permission: 'not trusted' },
  ];
  usageReport: UsageReport = { model: 'auto', contextTokens: 12000, contextWindowTokens: 200000, contextPercent: 6, categories: [{ name: 'Messages', tokens: 12000 }] };
  mcp: McpStatusEntry[] = [{ name: 'github', status: 'connected', toolCount: 1 }];
  todoList: TodoItem[] = [];
  hookList: KiroHook[] = [];
  report: ContextReport = {
    agentEntries: [{ pattern: 'AGENTS.md', files: [{ path: '/work/AGENTS.md', tokens: 120 }] }],
    sessionEntries: [],
    steering: [{ path: '/work/.kiro/steering/style.md', inclusion: 'always', tokens: 40 }],
    hookOutputs: [],
    droppedFiles: [],
    totalTokens: 160,
    contextWindowTokens: 200000,
  };
  models: ModelEntry[] = MODELS;
  exportedTo: string | undefined;

  constructor(init: { id?: string; agent?: KiroAgent; model?: string; effort?: string } = {}) {
    super();
    this.id = init.id ?? `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
    this.claudeSessionId = this.id;
    this.agent = init.agent ?? agentOf();
    this.model = init.model ?? 'auto';
    this.effort = init.effort;
    const now = new Date().toISOString();
    this.record = {
      version: 1,
      kind: 'kiro-claude-session',
      origin: 'repl',
      sessionId: this.id,
      claudeSessionId: this.id,
      cwd: '/work',
      additionalDirectories: [],
      agent: this.agent.name,
      model: this.model,
      title: '',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      lastPreview: '',
      parentId: null,
      forkKind: 'main',
      tangentName: null,
      turns: [],
      contextRules: [],
      trust: this.trust,
      planMode: false,
    };
  }

  private rec(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  called(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  /** Queue scripted turns. */
  script(...turns: MockTurn[]): this {
    this.turns.push(...turns);
    return this;
  }

  async start(): Promise<void> {
    this.rec('start');
    this.started = true;
  }

  private async *play(turn: MockTurn | undefined, input: PromptInput | undefined, signal: AbortSignal): AsyncGenerator<SessionEvent, TurnResult> {
    for (const step of turn?.steps ?? []) {
      if ('type' in step) {
        yield step;
        continue;
      }
      if ('approval' in step) {
        const req: ApprovalRequest = { call: step.approval, requestId: step.requestId ?? 'req-1', reasons: ['needs approval'], agentName: this.agent.name };
        const r = await this.ui!.requestApproval(req, signal);
        this.approvals.push(r);
        step.expect?.(r);
        continue;
      }
      if ('run' in step) {
        await step.run({ session: this, signal });
        continue;
      }
      if ('waitInterrupt' in step) {
        if (this.interrupted === 0) await new Promise<void>((res) => this.interruptWaiters.push(res));
        return { stopReason: 'cancelled', isError: false, text: '', permissionDenials: [], ...(turn?.result ?? {}) };
      }
    }
    const text = turn?.result?.text ?? '';
    if (input && !turn?.noRecord) {
      this.record.turns.push({ userUuid: `u${this.record.turns.length + 1}`, assistantUuid: `a${this.record.turns.length + 1}`, preview: previewText(input.text), at: new Date().toISOString() });
      this.record.messageCount += 2;
    }
    return { stopReason: 'end_turn', isError: false, text, permissionDenials: [], ...(turn?.result ?? {}) };
  }

  prompt(input: PromptInput, opts: { signal?: AbortSignal } = {}): AsyncGenerator<SessionEvent, TurnResult> {
    this.rec('prompt', input);
    this.prompts.push(input);
    return this.play(this.turns.shift(), input, opts.signal ?? new AbortController().signal);
  }

  steer(text: string): void {
    this.rec('steer', text);
  }

  async interrupt(): Promise<void> {
    this.rec('interrupt');
    this.interrupted++;
    for (const w of this.interruptWaiters.splice(0)) w();
  }

  async swapAgent(name: string): Promise<void> {
    this.rec('swapAgent', name);
    this.agent = agentOf(name, { welcomeMessage: `Welcome from ${name}` });
  }

  async setModel(id: string): Promise<void> {
    this.rec('setModel', id);
    this.model = id;
  }

  async setEffort(level: string): Promise<void> {
    this.rec('setEffort', level);
    this.effort = level;
  }

  async listModels(): Promise<ModelEntry[]> {
    return this.models;
  }

  async addContext(globs: string[]): Promise<{ added: string[]; matched: Record<string, string[]> }> {
    this.rec('addContext', globs);
    for (const g of globs) this.report.sessionEntries.push({ pattern: g, files: [] });
    return { added: globs, matched: Object.fromEntries(globs.map((g) => [g, []])) };
  }

  async removeContext(globs: string[]): Promise<string[]> {
    this.rec('removeContext', globs);
    const removed = this.report.sessionEntries.filter((e) => globs.includes(e.pattern)).map((e) => e.pattern);
    this.report.sessionEntries = this.report.sessionEntries.filter((e) => !globs.includes(e.pattern));
    return removed;
  }

  async clearContext(): Promise<void> {
    this.rec('clearContext');
    this.report.sessionEntries = [];
  }

  async contextReport(): Promise<ContextReport> {
    return this.report;
  }

  async clear(): Promise<void> {
    this.rec('clear');
  }

  compact(instructions?: string): AsyncGenerator<SessionEvent, TurnResult> {
    this.rec('compact', instructions);
    return this.play(this.turns.shift() ?? { steps: [{ type: 'compaction', state: 'started' }, { type: 'compaction', state: 'finished', preTokens: 5000, postTokens: 800 }], result: { stopReason: 'local_command', localCommand: 'compact' } }, undefined, new AbortController().signal);
  }

  async enterTangent(name?: string): Promise<void> {
    this.rec('enterTangent', name);
    this.tangent = { name: name ?? null, parentId: this.id };
  }

  async exitTangent(mode: 'discard' | 'tail' | 'merge'): Promise<void> {
    this.rec('exitTangent', mode);
    this.tangent = undefined;
  }

  async rewind(turn: number): Promise<void> {
    this.rec('rewind', turn);
  }

  toolListing(): ToolListingEntry[] {
    return this.listing;
  }

  trustTools(names: string[]): void {
    this.rec('trustTools', names);
    this.trust.allowedTools.push(...names);
  }

  untrustTools(names: string[]): void {
    this.rec('untrustTools', names);
  }

  setTrustAll(on: boolean): void {
    this.rec('setTrustAll', on);
    this.trust.trustAll = on;
  }

  resetTrust(): void {
    this.rec('resetTrust');
    this.trust.trustAll = false;
    this.trust.allowedTools = [];
  }

  async usage(): Promise<UsageReport> {
    this.rec('usage');
    return this.usageReport;
  }

  async mcpStatus(): Promise<McpStatusEntry[]> {
    return this.mcp;
  }

  todos(): TodoItem[] {
    return this.todoList;
  }

  hooks(): readonly KiroHook[] {
    return this.hookList;
  }

  async runManualHook(name: string): Promise<string> {
    this.rec('runManualHook', name);
    return `output of ${name}`;
  }

  async exportTo(p: string, force: boolean): Promise<string> {
    this.rec('exportTo', p, force);
    this.exportedTo = p;
    const fs = await import('node:fs');
    fs.writeFileSync(p, JSON.stringify({ version: 1, kind: 'kiro-claude-export', session: this.record }));
    return p;
  }

  async close(): Promise<void> {
    this.rec('close');
    this.closed = true;
  }
}
