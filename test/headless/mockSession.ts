/**
 * A scripted KiroSession double for the headless and chat suites (the real session module is
 * developed separately; see task RULES).
 */
import { EventEmitter } from 'node:events';

import type {
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
  TodoItem,
  ToolListingEntry,
  TurnResult,
  UsageReport,
} from '../../src/types.js';
import type { CreateSessionFn } from '../../src/cli/entries.js';

export interface MockScript {
  events?: SessionEvent[];
  result?: Partial<TurnResult>;
  /** Throw from start(). */
  startError?: Error;
  /** Throw from the prompt generator after the events. */
  promptError?: Error;
  /** Successive mcpStatus() answers (last one repeats). */
  mcp?: McpStatusEntry[][];
  tools?: ToolListingEntry[];
  models?: ModelEntry[];
  hooks?: KiroHook[];
  context?: ContextReport;
  agent?: Partial<KiroAgent>;
  model?: string;
  /** Delay before each event (ms). */
  eventDelayMs?: number;
}

export interface MockCalls {
  created: KiroSessionOptions[];
  started: number;
  closed: number;
  prompts: PromptInput[];
  compacts: Array<string | undefined>;
  interrupts: number;
  mcpCalls: number;
  sessions: MockSession[];
}

export function baseAgent(over: Partial<KiroAgent> = {}): KiroAgent {
  return {
    name: 'kiro_default',
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
    ...over,
  };
}

export function call(over: Partial<KiroToolCall> = {}): KiroToolCall {
  return {
    claudeName: 'Bash',
    input: { command: 'ls -la', description: 'List files' },
    v2Name: 'execute_bash',
    kiro2Name: 'shell',
    v3Id: 'execute_bash',
    tags: ['shell', '@builtin'],
    capability: 'shell',
    subjects: ['ls -la'],
    parseable: true,
    mutating: true,
    displayName: 'shell',
    summary: 'I will run the following shell command: ls -la',
    cwd: '/tmp',
    ...over,
  };
}

export class MockSession extends EventEmitter implements KiroSession {
  readonly id = '11111111-2222-4333-8444-555555555555';
  readonly claudeSessionId = '11111111-2222-4333-8444-555555555555';
  readonly agent: KiroAgent;
  readonly model: string;
  readonly effort: string | undefined = undefined;
  readonly trust: SessionTrust = { trustAll: false, allowedTools: [], rules: [] };
  readonly interactive = false;
  planMode = false;
  readonly tangent = undefined;
  readonly record = {} as SessionRecord;
  private mcpIdx = 0;

  constructor(
    readonly opts: KiroSessionOptions,
    private readonly script: MockScript,
    private readonly calls: MockCalls,
  ) {
    super();
    this.agent = baseAgent(script.agent);
    this.model = script.model ?? opts.model ?? 'auto';
  }

  async start(): Promise<void> {
    this.calls.started++;
    if (this.script.startError) throw this.script.startError;
  }

  private async *run(): AsyncGenerator<SessionEvent, TurnResult> {
    for (const e of this.script.events ?? []) {
      if (this.script.eventDelayMs) await new Promise((r) => setTimeout(r, this.script.eventDelayMs));
      yield e;
    }
    if (this.script.promptError) throw this.script.promptError;
    return {
      stopReason: 'end_turn',
      isError: false,
      text: '',
      permissionDenials: [],
      ...this.script.result,
    };
  }

  prompt(input: PromptInput): AsyncGenerator<SessionEvent, TurnResult> {
    this.calls.prompts.push(input);
    return this.run();
  }

  compact(instructions?: string): AsyncGenerator<SessionEvent, TurnResult> {
    this.calls.compacts.push(instructions);
    return this.run();
  }

  steer(): void {}
  async interrupt(): Promise<void> {
    this.calls.interrupts++;
  }
  async swapAgent(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async listModels(): Promise<ModelEntry[]> {
    return this.script.models ?? [
      { kiroId: 'auto', displayName: 'Default (recommended)', isDefault: true },
      { kiroId: 'claude-haiku-5.5', claudeValue: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest' },
    ];
  }
  async addContext(): Promise<{ added: string[]; matched: Record<string, string[]> }> {
    return { added: [], matched: {} };
  }
  async removeContext(): Promise<string[]> {
    return [];
  }
  async clearContext(): Promise<void> {}
  async contextReport(): Promise<ContextReport> {
    return (
      this.script.context ?? {
        agentEntries: [{ pattern: 'file://AGENTS.md', files: [{ path: '/w/AGENTS.md', tokens: 12 }] }],
        sessionEntries: [],
        steering: [{ path: '/w/.kiro/steering/a.md', inclusion: 'always', tokens: 5 }],
        hookOutputs: [],
        droppedFiles: [],
        totalTokens: 17,
        contextWindowTokens: 1000,
      }
    );
  }
  async clear(): Promise<void> {}
  async enterTangent(): Promise<void> {}
  async exitTangent(): Promise<void> {}
  async rewind(): Promise<void> {}
  forkSource(): { from: string; at?: string } {
    return { from: this.claudeSessionId };
  }
  resumeId(): string | undefined {
    return this.id;
  }
  toolListing(): ToolListingEntry[] {
    return (
      this.script.tools ?? [
        { name: 'shell', claudeName: 'Bash', source: 'builtin', permission: 'not trusted' },
        { name: 'read', claudeName: 'Read', source: 'builtin', permission: 'trusted' },
        { name: '@fetch/get', claudeName: 'mcp__fetch__get', source: 'mcp', server: 'fetch', permission: 'not trusted' },
      ]
    );
  }
  trustTools(): void {}
  untrustTools(): void {}
  setTrustAll(): void {}
  resetTrust(): void {}
  async usage(): Promise<UsageReport> {
    return { model: this.model };
  }
  async mcpStatus(): Promise<McpStatusEntry[]> {
    this.calls.mcpCalls++;
    const list = this.script.mcp ?? [[]];
    const v = list[Math.min(this.mcpIdx, list.length - 1)] ?? [];
    this.mcpIdx++;
    return v;
  }
  todos(): TodoItem[] {
    return [];
  }
  hooks(): readonly KiroHook[] {
    return this.script.hooks ?? [];
  }
  async runManualHook(): Promise<import('../../src/types.js').ManualHookRun> {
    return { kind: 'not-found' };
  }
  async exportTo(p: string): Promise<string> {
    return p;
  }
  async close(): Promise<void> {
    this.calls.closed++;
  }
}

/** A session factory plus a record of everything the runner did with it. */
export function mockFactory(script: MockScript = {}): { create: CreateSessionFn; calls: MockCalls } {
  const calls: MockCalls = { created: [], started: 0, closed: 0, prompts: [], compacts: [], interrupts: 0, mcpCalls: 0, sessions: [] };
  const create: CreateSessionFn = async (opts) => {
    calls.created.push(opts);
    const s = new MockSession(opts, script, calls);
    calls.sessions.push(s);
    return s;
  };
  return { create, calls };
}
