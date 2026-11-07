/**
 * Fixtures for spec/ tests: temp workspaces, synthetic spec documents in the 2026 Kiro format,
 * a scriptable mock KiroSession, a mock ReplHost (scripted ask/confirm/choose answers), a mock
 * SettingsStore and a recording HookRunnerLike. Never touches the real ~/.kiro or ~/.claude.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  HookRunnerLike,
  KiroAgent,
  KiroHook,
  KiroSession,
  KiroSessionOptions,
  PromptInput,
  ReplHost,
  SessionEvent,
  SessionRecord,
  SettingsStore,
  TurnResult,
  WorkspaceContext,
} from '../../src/types.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';

// ───────────────────────────── workspace ─────────────────────────────

export interface Ws {
  root: string;
  home: string;
  proj: string;
  specs: string;
  ctx: WorkspaceContext;
  cleanup(): void;
}

export function makeWs(prefix = 'kc-spec-'): Ws {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  const specs = path.join(proj, '.kiro', 'specs');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(specs, { recursive: true });
  const env: NodeJS.ProcessEnv = { HOME: home, KIRO_HOME: path.join(home, '.kiro'), PATH: process.env.PATH ?? '' };
  const ctx = createWorkspaceContext(proj, env);
  return { root, home, proj, specs, ctx, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Write a spec folder with the given documents (and optional raw `.config.kiro`). */
export function writeSpec(w: Ws, name: string, docs: Partial<Record<'requirements' | 'bugfix' | 'design' | 'tasks' | 'config', string>>): string {
  const dir = path.join(w.specs, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(docs)) {
    if (v === undefined) continue;
    fs.writeFileSync(path.join(dir, k === 'config' ? '.config.kiro' : `${k}.md`), v);
  }
  return dir;
}

/** The real Kiro example spec (research 03 KR:), when available. */
export function exampleSpecDir(): string | undefined {
  const cands = [
    process.env.KIRO_CLAUDE_SPEC_EXAMPLE_DIR,
    '/tmp/claude-0/-home-user-KIRO-Claude/f64cc4b7-1ba3-542d-b0c3-8274814eaa7b/scratchpad/ext/kiro/.kiro/specs/github-issue-automation',
  ];
  for (const c of cands) if (c && fs.existsSync(path.join(c, 'tasks.md'))) return c;
  return undefined;
}

// ───────────────────────────── synthetic documents (2026 format) ─────────────────────────────

export const REQ_MD = `# Requirements Document

## Introduction

Todo export lets users download their todo list as CSV.

## Glossary

- **Exporter**: The module that serializes todos
- **Todo_Store**: The persistence layer holding todos

## Requirements

### Requirement 1: CSV export

**User Story:** As a user, I want to export my todos as CSV, so that I can open them in a spreadsheet.

#### Acceptance Criteria

1. WHEN the user requests an export, THE Exporter SHALL write one CSV row per todo
2. IF the Todo_Store is empty, THEN THE Exporter SHALL write only the header row

### Requirement 2: Escaping

**User Story:** As a user, I want commas in titles preserved, so that data is not corrupted.

#### Acceptance Criteria

1. THE Exporter SHALL quote fields that contain commas, quotes or newlines

**Note:** RFC 4180 quoting.
`;

export const DESIGN_MD = `# Design Document: Todo Export

## Overview

A pure \`toCsv\` function.

## Architecture

\`\`\`mermaid
graph TD
  A[UI] --> B[Exporter]
\`\`\`

## Components and Interfaces

### 1. Exporter

## Data Models

## Correctness Properties

A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.

### Property 1: Row count

*For any* list of todos, the CSV has one row per todo plus a header.

**Validates: Requirements 1.1, 1.2**

### Property 2: Round trip

*For any* title, parsing the quoted field returns the title.

**Validates: Requirements 2.1**

## Error Handling

## Testing Strategy
`;

export const TASKS_MD = `# Implementation Plan: Todo Export

## Overview

Build the exporter test-first.

## Tasks

- [ ] 1. Implement the exporter
  - [ ] 1.1 Create \`src/export.ts\` with \`toCsv(todos)\`
    - Header row first
    - _Requirements: 1.1, 1.2_
  - [ ]* 1.2 Write property test for row count
    - **Property 1: Row count**
    - **Validates: Requirements 1.1, 1.2**
- [ ] 2. Implement escaping
  - [ ] 2.1 Quote special characters in \`src/export.ts\`
    - _Requirements: 2.1_
  - [ ]* 2.2 Write property test for round trip
    - **Property 2: Round trip**
    - **Validates: Requirements 2.1**
- [ ] 3. Checkpoint - Export works
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with \`*\` are optional and can be skipped for faster MVP

## Task Dependency Graph

\`\`\`json
{"waves":[{"id":0,"tasks":["1.1","1.2"]},{"id":1,"tasks":["2.1","2.2"]}]}
\`\`\`
`;

export const BUGFIX_MD = `# Bugfix Requirements Document

## Introduction

Saving twice drops the first edit.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the user saves twice THEN the system discards the first edit

1.2 WHEN autosave runs during a save THEN the system writes a stale copy

### Expected Behavior (Correct)

2.1 WHEN the user saves twice THEN the system SHALL keep both edits

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the user saves once THEN the system SHALL CONTINUE TO write the file
`;

export const BUGFIX_TASKS_MD = `# Implementation Plan

## Tasks

- [ ] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Double save keeps edits
  - _Requirements: 1.1, 1.2, 2.1_
- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - _Requirements: 3.1_
- [ ] 3. Fix for double save
  - [ ] 3.1 Implement the fix in \`save()\`
    - _Requirements: 2.1_
  - [ ] 3.2 Verify bug condition exploration test now passes
  - [ ] 3.3 Verify preservation tests still pass
- [ ] 4. Checkpoint - Ensure all tests pass
`;

// ───────────────────────────── settings ─────────────────────────────

export function mockSettings(values: Record<string, unknown> = {}): SettingsStore {
  const data = { ...values };
  return {
    get: (k) => data[k],
    getString: (k) => (typeof data[k] === 'string' ? (data[k] as string) : undefined),
    getBoolean: (k, f) => (typeof data[k] === 'boolean' ? (data[k] as boolean) : f),
    getNumber: (k, f) => (typeof data[k] === 'number' ? (data[k] as number) : f),
    set: (k, v) => {
      data[k] = v;
    },
    delete: () => [],
    list: () => ({ ...data }),
    pathFor: () => '/dev/null',
  };
}

// ───────────────────────────── mock session ─────────────────────────────

export interface TurnSpec {
  text?: string;
  stopReason?: TurnResult['stopReason'];
  isError?: boolean;
  error?: string;
  events?: SessionEvent[];
}

/** The "model": decides what a turn does (writes files, returns text). */
export type ModelScript = (input: PromptInput, s: MockSession) => TurnSpec | Promise<TurnSpec>;

export function mockAgent(name = 'kiro_default', hooks: KiroHook[] = []): KiroAgent {
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
    hooks,
    permissions: [],
    allowedTools: [],
    toolsSettings: {},
    toolAliases: {},
    inheritDefaultResources: true,
    warnings: [],
  };
}

let sessionCounter = 0;

export class MockSession extends EventEmitter implements KiroSession {
  readonly id: string;
  claudeSessionId: string | undefined;
  readonly agent: KiroAgent;
  readonly model = 'auto';
  readonly effort: string | undefined = undefined;
  readonly trust = { trustAll: false, allowedTools: [] as string[], rules: [] };
  readonly interactive: boolean;
  readonly record: SessionRecord;
  planMode = false;
  readonly tangent = undefined;
  readonly prompts: PromptInput[] = [];
  /** specPhase in effect for each prompt (index-aligned with prompts). */
  readonly phasesSeen: (KiroSessionOptions['specPhase'] | undefined)[] = [];
  closed = false;
  started = false;
  interrupted = 0;
  currentPhase: KiroSessionOptions['specPhase'] | undefined;

  constructor(
    readonly opts: Partial<KiroSessionOptions>,
    private readonly script: ModelScript,
    private readonly hookList: KiroHook[] = [],
  ) {
    super();
    this.id = `sess-${++sessionCounter}`;
    this.claudeSessionId = `claude-${sessionCounter}`;
    this.agent = mockAgent('kiro_default', hookList);
    this.interactive = opts.interactive ?? true;
    this.currentPhase = opts.specPhase;
    this.record = {
      version: 1,
      kind: 'kiro-claude-session',
      origin: opts.origin ?? 'repl',
      sessionId: this.id,
      claudeSessionId: this.claudeSessionId,
      cwd: '/',
      additionalDirectories: [],
      agent: 'kiro_default',
      model: 'auto',
      title: '',
      createdAt: '',
      updatedAt: '',
      messageCount: 0,
      lastPreview: '',
      parentId: null,
      forkKind: 'main',
      tangentName: null,
      turns: [],
      contextRules: [],
      trust: { trustAll: false, allowedTools: [], rules: [] },
      planMode: false,
    };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async *prompt(input: PromptInput): AsyncGenerator<SessionEvent, TurnResult> {
    if (this.closed) throw new Error(`${this.id} is closed`);
    this.prompts.push(input);
    this.phasesSeen.push(this.currentPhase ? { name: this.currentPhase.name, allowedWritePaths: [...this.currentPhase.allowedWritePaths] } : undefined);
    const r = await this.script(input, this);
    for (const e of r.events ?? []) yield e;
    const out: TurnResult = {
      stopReason: r.stopReason ?? 'end_turn',
      isError: r.isError ?? false,
      text: r.text ?? '',
      permissionDenials: [],
    };
    if (r.error) out.error = r.error;
    return out;
  }

  steer(): void {}
  async interrupt(): Promise<void> {
    this.interrupted++;
  }
  async swapAgent(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async listModels() {
    return [];
  }
  async addContext() {
    return { added: [], matched: {} };
  }
  async removeContext() {
    return [];
  }
  async clearContext(): Promise<void> {}
  async contextReport() {
    return { agentEntries: [], sessionEntries: [], steering: [], hookOutputs: [], droppedFiles: [], totalTokens: 0, contextWindowTokens: 200000 };
  }
  async clear(): Promise<void> {}
  // eslint-disable-next-line require-yield
  async *compact(): AsyncGenerator<SessionEvent, TurnResult> {
    return { stopReason: 'local_command', isError: false, text: '', permissionDenials: [] };
  }
  async enterTangent(): Promise<void> {}
  async exitTangent(): Promise<void> {}
  async rewind(): Promise<void> {}
  toolListing() {
    return [];
  }
  trustTools(): void {}
  untrustTools(): void {}
  setTrustAll(): void {}
  resetTrust(): void {}
  async usage() {
    return { model: 'auto' };
  }
  async mcpStatus() {
    return [];
  }
  todos() {
    return [];
  }
  hooks(): readonly KiroHook[] {
    return this.hookList;
  }
  async runManualHook(): Promise<import('../../src/types.js').ManualHookRun> {
    return { kind: 'not-found' };
  }
  async exportTo(p: string): Promise<string> {
    return p;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A MockSession that supports the optional in-place `setSpecPhase` extension. */
export class SettableSession extends MockSession {
  readonly phaseChanges: (KiroSessionOptions['specPhase'] | undefined)[] = [];
  setSpecPhase(p: KiroSessionOptions['specPhase'] | undefined): void {
    this.currentPhase = p;
    this.phaseChanges.push(p);
  }
}

// ───────────────────────────── the fake model ─────────────────────────────

export interface FakeModelOptions {
  requirements?: string;
  design?: string;
  tasks?: string;
  bugfix?: string;
  /** Per-task final text (default `TASK_RESULT: completed`). */
  taskText?: Record<string, string | TurnSpec>;
  /** Analysis turn output. */
  analysis?: string;
  /** Called for every turn first; return a TurnSpec to override. */
  override?: (input: PromptInput, s: MockSession) => TurnSpec | undefined;
  log?: string[];
}

/**
 * Behaves like a cooperative model: drafts the document named by the phase instruction — but
 * only when the session's spec phase allows that path (simulating the gate), so a missing
 * restriction shows up as an unwritten document.
 */
export function fakeModel(o: FakeModelOptions = {}): ModelScript {
  return (input, s) => {
    o.log?.push(input.text.split('\n')[0]!);
    const ov = o.override?.(input, s);
    if (ov) return ov;
    const t = input.text;
    const allowed = (p: string): boolean => !!s.currentPhase && s.currentPhase.allowedWritePaths.includes(p);
    const write = (p: string, content: string): TurnSpec => {
      if (!allowed(p)) return { text: `denied: Spec phase ${s.currentPhase?.name ?? '(none)'}: only ${(s.currentPhase?.allowedWritePaths ?? []).join(', ')} may be written now` };
      fs.writeFileSync(p, content);
      return { text: `Wrote ${path.basename(p)}. Please review.` };
    };
    let m: RegExpExecArray | null;
    if ((m = /Create or update (\S+\/requirements\.md)/.exec(t))) return write(m[1]!, o.requirements ?? REQ_MD);
    if ((m = /Create or update (\S+\/design\.md)/.exec(t))) return write(m[1]!, o.design ?? DESIGN_MD);
    if ((m = /Create or update (\S+\/tasks\.md)/.exec(t))) return write(m[1]!, o.tasks ?? TASKS_MD);
    if ((m = /Create or update (\S+\/bugfix\.md)/.exec(t))) return write(m[1]!, o.bugfix ?? BUGFIX_MD);
    if ((m = /then write (\S+\/design\.md)/.exec(t))) return write(m[1]!, o.design ?? DESIGN_MD);
    if ((m = /^Write (\S+\/tasks\.md)/m.exec(t))) return write(m[1]!, o.tasks ?? BUGFIX_TASKS_MD);
    if ((m = /^Revise (\S+\.md)/.exec(t))) {
      const p = m[1]!;
      if (!allowed(p)) return { text: 'denied' };
      fs.appendFileSync(p, '\n<!-- revised -->\n');
      return { text: 'Revised.' };
    }
    if (/^Analyze /.test(t)) return { text: o.analysis ?? '{"findings":[]}' };
    if ((m = /^Update (\S+\.md) to resolve/.exec(t))) {
      const p = m[1]!;
      if (!allowed(p)) return { text: 'denied' };
      fs.appendFileSync(p, '\n3. THE Exporter SHALL use UTF-8\n');
      return { text: 'Updated.' };
    }
    if (/^Quick Spec/.test(t)) return { text: '[1]: CSV or TSV?\na. CSV (recommended)\nb. TSV' };
    if ((m = /Execute Task: (\S+)/.exec(t))) {
      const spec = o.taskText?.[m[1]!];
      if (spec && typeof spec === 'object') return spec;
      return { text: spec ?? `Implemented ${m[1]}.\nTASK_RESULT: completed` };
    }
    if ((m = /^Compare (\S+\/tasks\.md)/.exec(t))) {
      const p = m[1]!;
      if (!allowed(p)) return { text: 'denied' };
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'));
      return { text: 'Marked 1.1 done.' };
    }
    return { text: 'ok' };
  };
}

// ───────────────────────────── mock REPL host ─────────────────────────────

/** A scripted answer for choose(): an index, an option label (prefix match), or undefined (cancel). */
export type ChooseAnswer = number | string | undefined;

export class MockHost implements ReplHost {
  readonly ws: WorkspaceContext;
  readonly settings: SettingsStore;
  session: KiroSession;
  readonly printed: string[] = [];
  readonly asked: string[] = [];
  readonly chosen: { question: string; options: string[] }[] = [];
  readonly created: Partial<KiroSessionOptions>[] = [];
  readonly sessions: MockSession[] = [];
  readonly replaced: KiroSession[] = [];
  askAnswers: string[] = [];
  confirmAnswers: boolean[] = [];
  chooseAnswers: ChooseAnswer[] = [];
  /** Session class used by createSession. */
  sessionClass: typeof MockSession = MockSession;

  constructor(
    ws: WorkspaceContext,
    readonly script: ModelScript,
    opts: { settings?: SettingsStore; initial?: MockSession; hooks?: KiroHook[] } = {},
  ) {
    this.ws = ws;
    this.settings = opts.settings ?? mockSettings();
    this.hookList = opts.hooks ?? [];
    this.session = opts.initial ?? new MockSession({ origin: 'repl' }, script, this.hookList);
    if (this.session instanceof MockSession) this.sessions.push(this.session);
  }

  private readonly hookList: KiroHook[];

  get text(): string {
    return this.printed.join('\n');
  }

  print(text: string): void {
    this.printed.push(text);
  }

  async ask(question: string): Promise<string> {
    this.asked.push(question);
    return this.askAnswers.shift() ?? '';
  }

  async confirm(_q: string, defaultYes?: boolean): Promise<boolean> {
    const a = this.confirmAnswers.shift();
    return a ?? defaultYes ?? false;
  }

  async choose(question: string, options: string[]): Promise<number | undefined> {
    this.chosen.push({ question, options: [...options] });
    if (this.chooseAnswers.length === 0) throw new Error(`unexpected choose(${JSON.stringify(question)}) options=${JSON.stringify(options)}`);
    const a = this.chooseAnswers.shift();
    if (a === undefined || typeof a === 'number') return a;
    const i = options.findIndex((o) => o === a || o.startsWith(a));
    if (i < 0) throw new Error(`choose(${JSON.stringify(question)}): no option ${JSON.stringify(a)} in ${JSON.stringify(options)}`);
    return i;
  }

  async runTurn(input: PromptInput): Promise<TurnResult> {
    const gen = this.session.prompt(input);
    for (;;) {
      const n = await gen.next();
      if (n.done) return n.value;
    }
  }

  replaceSession(next: KiroSession): void {
    this.replaced.push(next);
    this.session = next;
  }

  async createSession(opts: Partial<KiroSessionOptions>): Promise<KiroSession> {
    this.created.push(opts);
    const s = new this.sessionClass(opts, this.script, this.hookList);
    this.sessions.push(s);
    return s;
  }
}

// ───────────────────────────── hooks ─────────────────────────────

export interface RecordedTaskHook {
  trigger: 'PreTaskExec' | 'PostTaskExec';
  task: Record<string, unknown>;
  sessionId: string;
}

export function recordingHooks(
  opts: {
    block?: (taskId: string) => string | undefined;
    preAgentPrompts?: string[];
    postAgentPrompts?: string[];
  } = {},
): HookRunnerLike & { calls: RecordedTaskHook[] } {
  const calls: RecordedTaskHook[] = [];
  const none = { warnings: [] };
  return {
    calls,
    hooks: [],
    runSessionStart: async () => ({ outputs: [], agentPrompts: [], warnings: [] }),
    runUserPromptSubmit: async () => ({ outputs: [], agentPrompts: [], warnings: [] }),
    runPreToolUse: async () => ({ blocked: false, warnings: [] }),
    runPostToolUse: async () => none,
    runStop: async () => none,
    runSessionEnd: async () => none,
    runFileHook: async () => none,
    runManual: async () => ({ found: false, warnings: [] }),
    async runTaskHook(ctx, trigger, task) {
      calls.push({ trigger, task: { ...task }, sessionId: ctx.sessionId });
      if (trigger === 'PreTaskExec') {
        const reason = opts.block?.(task.taskId);
        if (reason !== undefined) return { blocked: true, blockReason: reason, agentPrompts: [], warnings: [{ hook: 'pre', message: `hook warning for ${task.taskId}` }] };
        return { blocked: false, agentPrompts: opts.preAgentPrompts ?? [], warnings: [] };
      }
      return { blocked: false, agentPrompts: opts.postAgentPrompts ?? [], warnings: [] };
    },
  };
}

/** A KiroHook of a task trigger (so createReplRuntime enables task hooks). */
export function taskHook(trigger: 'PreTaskExec' | 'PostTaskExec'): KiroHook {
  return {
    dialect: 'v3',
    source: 'workspace-file',
    name: trigger,
    trigger,
    rawTrigger: trigger,
    action: { type: 'command', command: 'true' },
    timeoutMs: 60000,
    maxOutputBytes: 10240,
    cacheTtlSec: 0,
    enabled: true,
  };
}

export function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}
