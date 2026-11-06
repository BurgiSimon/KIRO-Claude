/**
 * Shared cross-module contracts for kiro-claude.
 *
 * Every type that crosses a module boundary lives here so modules can be implemented
 * (and tested) independently. Behavior is specified in docs/ARCHITECTURE.md and in the
 * research reference (00-synthesis.md); section references like "00 §5.1" point there.
 *
 * Conventions
 *  - "Claude name": a Claude Code tool name (Read, Bash, mcp__srv__tool, ...).
 *  - "V2 name" / "Q name": Kiro 2.x / Amazon Q CLI tool name (fs_read, execute_bash, @srv/tool).
 *  - "V3 id": Kiro CLI 3.x tool id (read_file, execute_bash, mcp_srv_tool).
 *  - Paths are absolute unless a field says otherwise.
 */

import type { EventEmitter } from 'node:events';

// ───────────────────────────── Environment / workspace ─────────────────────────────

/** Where we are running. Built once per command invocation and passed around. */
export interface WorkspaceContext {
  /** process cwd (realpath). */
  cwd: string;
  /** Nearest ancestor with a `.kiro/` dir (util/paths.findWorkspaceRoot), else cwd. */
  workspaceRoot: string;
  /** $KIRO_HOME or ~/.kiro. */
  kiroHome: string;
  /** User home directory. */
  home: string;
  env: NodeJS.ProcessEnv;
}

/** A user-facing diagnostic produced while loading config (never fatal unless stated). */
export interface ConfigWarning {
  /** Short stable code, e.g. 'agent-conflict', 'unknown-field', 'invalid-json'. */
  code: string;
  message: string;
  path?: string;
}

// ───────────────────────────── Settings (cli.json) ─────────────────────────────

export type SettingsScope = 'global' | 'workspace';

/**
 * Kiro settings: flat dotted keys in `<kiroHome>/settings/cli.json` (global) and
 * `<workspaceRoot>/.kiro/settings/cli.json` (workspace overrides). Adapter-only keys use
 * the prefix `kiroClaude.` and are stored in `<kiroHome>/settings/kiro-claude.json`
 * (global) / `.kiro/settings/kiro-claude.json` (workspace) so real kiro-cli never sees them.
 */
export interface SettingsStore {
  /** Effective value (workspace over global), undefined when unset. */
  get(key: string): unknown;
  getString(key: string): string | undefined;
  getBoolean(key: string, fallback: boolean): boolean;
  getNumber(key: string, fallback: number): number;
  /** Value parsed as JSON when possible, else stored as string (Kiro semantics). */
  set(key: string, value: unknown, scope?: SettingsScope): void;
  /** Delete keys matching a glob (e.g. `chat.*`); returns deleted keys. */
  delete(pattern: string, scope?: SettingsScope): string[];
  /** All effective key/values (merged), sorted by key. */
  list(scope?: SettingsScope | 'effective'): Record<string, unknown>;
  /** File path backing a key in a scope (cli.json or kiro-claude.json). */
  pathFor(key: string, scope: SettingsScope): string;
}

// ───────────────────────────── MCP ─────────────────────────────

export type McpOrigin = 'agent' | 'workspace' | 'global' | 'legacy-workspace' | 'legacy-global';

/** Normalized Kiro MCP server entry (02 §5.2). Env/header values are already substituted. */
export interface McpServerConfig {
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  /** Kiro `timeout` (ms) if given. */
  timeoutMs?: number;
  disabled: boolean;
  /** Kiro `autoApprove` tool names (treated as allowed by the gate). */
  autoApprove: string[];
  /** Kiro `disabledTools` (hidden from the model). */
  disabledTools: string[];
  origin: McpOrigin;
  /** File the entry came from (for agent: the agent file). */
  sourcePath?: string;
}

// ───────────────────────────── Permissions (V3) ─────────────────────────────

export type Capability =
  | 'fs_read' | 'fs_write' | 'shell' | 'web_fetch' | 'web_search' | 'mcp' | 'subagent'
  | 'skill' | 'power' | 'context' | 'diagnostics' | 'sandbox_network' | 'utility';

export type RuleEffect = 'allow' | 'ask' | 'deny' | 'evaluate';

/** V3 permission rule (02 §2.8). `capability` may also be a meta capability: all|builtin|filesystem. */
export interface PermissionRule {
  capability: string;
  match?: string[];
  exclude?: string[];
  effect: RuleEffect;
  /** Where the rule came from (for /tools and denial messages). */
  scope?: 'kiro' | 'user' | 'workspace' | 'agent' | 'session' | 'preset';
}

// ───────────────────────────── Hooks ─────────────────────────────

export type HookTrigger =
  | 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionEnd'
  | 'PostFileCreate' | 'PostFileSave' | 'PostFileDelete' | 'PreTaskExec' | 'PostTaskExec' | 'Manual';

export type HookDialect = 'v2' | 'v3';

export interface HookConfirmOption { id: string; label: string; run: boolean }

/** Normalized hook from any source (02 §7, 03 §2). */
export interface KiroHook {
  dialect: HookDialect;
  source: 'agent' | 'workspace-file' | 'global-file' | 'legacy-ide';
  /** Display name (v2: `<trigger>-<index>`, v3: `name`). */
  name: string;
  trigger: HookTrigger;
  /** Trigger string as written in config (echoed in V3 `hook_event_name`). */
  rawTrigger: string;
  matcher?: string;
  action: { type: 'command'; command: string } | { type: 'agent'; prompt: string };
  /** 0 = no timeout. v2: timeout_ms ?? 30000; v3: (timeout ?? 60) * 1000. */
  timeoutMs: number;
  /** v2: max_output_size ?? 10240; v3: 10240. */
  maxOutputBytes: number;
  /** v2 only; agentSpawn output is cached for the session regardless. */
  cacheTtlSec: number;
  enabled: boolean;
  confirm?: { question: string; confirmCommand?: string; options: HookConfirmOption[] };
  /** File the hook was defined in. */
  sourcePath?: string;
  /** Agent name when source === 'agent'. */
  agentName?: string;
}

// ───────────────────────────── Agents ─────────────────────────────

export type AgentResource =
  | { kind: 'file'; uri: string }
  | { kind: 'skill'; uri: string }
  | { kind: 'knowledgeBase'; source: string; name: string; description?: string };

/**
 * Fully loaded Kiro agent (02 §2). `dialect` decides the permission engine and hook payloads:
 * agent has `permissions` ⇒ 'v3', else 'v2' (00 §2.2 "Agent dialect").
 */
export interface KiroAgent {
  name: string;
  /** Agent file path; undefined for built-ins. */
  path?: string;
  format: 'json' | 'md' | 'builtin';
  scope: 'workspace' | 'global' | 'builtin';
  dialect: 'v2' | 'v3';
  description?: string;
  /** Resolved prompt text (file:// already read). */
  prompt?: string;
  model?: string;
  welcomeMessage?: string;
  /** Visibility selectors exactly as configured (02 §2.4); absent in file ⇒ [] + warning. */
  tools: string[];
  excludedTools: string[];
  /** Agent's own mcpServers. */
  mcpServers: Record<string, McpServerConfig>;
  /** Include ~/.kiro/settings/mcp.json + workspace mcp.json (Kiro `includeMcpJson`). */
  includeMcpJson: boolean;
  /** Q `useLegacyMcpJson`. */
  useLegacyMcpJson: boolean;
  resources: AgentResource[];
  hooks: KiroHook[];
  /** V3 agent-scope rules (empty for v2). */
  permissions: PermissionRule[];
  /** V2 fields (empty defaults for v3). */
  allowedTools: string[];
  toolsSettings: Record<string, Record<string, unknown>>;
  toolAliases: Record<string, string>;
  keyboardShortcut?: string;
  /** Whether default resources (steering, skills, AGENTS.md) are added (00 §2.2, C5). */
  inheritDefaultResources: boolean;
  warnings: ConfigWarning[];
}

// ───────────────────────────── Steering, prompts, skills ─────────────────────────────

export type SteeringInclusion = 'always' | 'fileMatch' | 'manual' | 'auto';

export interface SteeringFile {
  path: string;
  scope: 'global' | 'workspace' | 'legacy';
  /** File stem, used for `#name` / `/name` references. */
  name: string;
  inclusion: SteeringInclusion;
  /** fileMatch patterns (front matter `fileMatchPattern`: string or string[]). */
  fileMatchPatterns: string[];
  description?: string;
  /** Body with front matter stripped (file refs NOT yet expanded). */
  body: string;
}

export interface PromptFile {
  name: string;
  path: string;
  scope: 'workspace' | 'global';
  body: string;
  description?: string;
}

export interface SkillInfo {
  name: string;
  description?: string;
  /** Directory containing SKILL.md. */
  dir: string;
  skillFile: string;
  scope: 'workspace' | 'global' | 'resource';
}

// ───────────────────────────── Tool calls (policy ⇄ hooks ⇄ UI) ─────────────────────────────

/**
 * One Claude tool call described in Kiro terms (built by policy/toolmap.toKiroCall, 00 §4.1).
 * Used by the gate, the hook runner (payload building) and the UIs (display).
 */
export interface KiroToolCall {
  claudeName: string;
  toolUseId?: string;
  /** Claude tool input, unmodified. */
  input: Record<string, unknown>;
  /** Q / V2 hook name (fs_read, execute_bash, use_subagent, todo_list, @srv/tool). */
  v2Name: string;
  /** Kiro 2.x display/policy name (read, write, shell, ...; `@srv/tool` for MCP). */
  kiro2Name: string;
  /** V3 tool id (read_file, str_replace, execute_bash, mcp_srv_tool, ...); undefined when V3 has none. */
  v3Id?: string;
  /** V3 tags (read, write, shell, web, ...) plus '@builtin' or '@mcp', '@<srv>', '@<srv>/<tool>'. */
  tags: string[];
  capability: Capability;
  /**
   * Policy subjects: absolute paths (fs_*), each sub-command (shell, split by util/shlex.splitCompoundCommand,
   * or the whole command when unparseable), URL (web_fetch), query (web_search), `srv/tool` (mcp),
   * agent name (subagent), skill name (skill).
   */
  subjects: string[];
  /** For shell: false when the command could not be split. */
  parseable: boolean;
  mcp?: { server: string; tool: string };
  /** Mutating capability (fs_write, shell, mcp, subagent). */
  mutating: boolean;
  /** Classic display name used in "🛠️  Using tool: <displayName>". */
  displayName: string;
  /** One-line human summary (e.g. command, path) for UIs. */
  summary: string;
  /** Working directory of the call (Claude hook input cwd). */
  cwd: string;
  /** Set when the call runs inside a Claude subagent (hook input agent_type/agent_id). */
  subagent?: { id?: string; type: string };
}

// ───────────────────────────── Hook runner contract ─────────────────────────────

export interface HookWarning {
  hook: string;
  message: string;
}

export interface HookRunContext {
  ws: WorkspaceContext;
  /** Kiro session id (V3 payload `session_id`). */
  sessionId: string;
  /** Pending user prompt when known (sets `prompt` field and USER_PROMPT env). */
  prompt?: string;
  signal?: AbortSignal;
}

/** Result of SessionStart/agentSpawn hooks. */
export interface AgentSpawnHookResult {
  /** Successful (exit 0, non-empty) outputs in definition order. */
  outputs: string[];
  /** Agent-action prompts to prepend to the first user turn. */
  agentPrompts: string[];
  warnings: HookWarning[];
}

export interface UserPromptHookResult {
  /** Outputs to wrap as context for this user message (exit 0 outputs; v3 non-zero output+code note). */
  outputs: string[];
  /** Agent-action prompts appended to the user text. */
  agentPrompts: string[];
  warnings: HookWarning[];
}

export interface PreToolHookResult {
  blocked: boolean;
  /** stderr of the first blocking hook (definition order) when blocked. */
  blockReason?: string;
  /** Agent-action prompts ⇒ additionalContext. */
  additionalContext?: string;
  warnings: HookWarning[];
}

export interface PostToolHookResult {
  additionalContext?: string;
  warnings: HookWarning[];
}

export interface StopHookResult {
  /** When set, the session must send this text as a new user turn (V3 decision:block / exit 1, or agent action). */
  continueWith?: string;
  /** Pending `confirm` UI request from a Stop hook (REPL shows a picker). */
  confirm?: { hook: string; question: string; options: HookConfirmOption[] };
  warnings: HookWarning[];
}

/** Claude tool response normalized for hook payloads (00 §4.4). */
export interface ToolOutcome {
  success: boolean;
  /** Claude `tool_response` (PostToolUse) or error text (PostToolUseFailure). */
  response?: unknown;
  error?: string;
  durationMs?: number;
}

/** Implemented by hooks/runner.ts; consumed by policy/gate.ts and session/kiroSession.ts. */
export interface HookRunnerLike {
  /** All hooks this runner knows about (for /hooks). */
  readonly hooks: readonly KiroHook[];
  runSessionStart(ctx: HookRunContext): Promise<AgentSpawnHookResult>;
  runUserPromptSubmit(ctx: HookRunContext & { prompt: string }): Promise<UserPromptHookResult>;
  runPreToolUse(ctx: HookRunContext, call: KiroToolCall): Promise<PreToolHookResult>;
  runPostToolUse(ctx: HookRunContext, call: KiroToolCall, outcome: ToolOutcome): Promise<PostToolHookResult>;
  runStop(ctx: HookRunContext & { assistantText?: string; hookDrivenContinuations: number }): Promise<StopHookResult>;
  runSessionEnd(ctx: HookRunContext): Promise<{ warnings: HookWarning[] }>;
  runFileHook(
    ctx: HookRunContext,
    trigger: 'PostFileCreate' | 'PostFileSave' | 'PostFileDelete',
    filePath: string,
    call: KiroToolCall,
  ): Promise<PostToolHookResult>;
  runTaskHook(
    ctx: HookRunContext,
    trigger: 'PreTaskExec' | 'PostTaskExec',
    task: { specName: string; taskId: string; title: string },
  ): Promise<{ blocked: boolean; blockReason?: string; agentPrompts: string[]; warnings: HookWarning[] }>;
  /** Run a Manual hook by name (/hooks run <name>). */
  runManual(ctx: HookRunContext, name: string): Promise<{ found: boolean; output?: string; warnings: HookWarning[] }>;
}

// ───────────────────────────── Gate / approvals ─────────────────────────────

/** Adapter-held session trust (00 §5.4). Mutated by `t`, /tools trust, --trust-tools, ACP allow_always. */
export interface SessionTrust {
  trustAll: boolean;
  /** V2 names / `@srv[/tool]` selectors added this session. */
  allowedTools: string[];
  /** V3 session rules. */
  rules: PermissionRule[];
}

export type PolicyVerdict =
  | { kind: 'allow'; reasons: string[] }
  | { kind: 'ask'; reasons: string[] }
  | { kind: 'deny'; reasons: string[] };

/** What the gate answers to the PreToolUse hook_callback. */
export type GateDecision =
  | { kind: 'allow'; additionalContext?: string }
  | { kind: 'deny'; reason: string; additionalContext?: string }
  | { kind: 'ask'; reason: string; additionalContext?: string };

/** Shown to the user when Claude sends can_use_tool after a gate `ask`. */
export interface ApprovalRequest {
  call: KiroToolCall;
  /** Claude's can_use_tool request id (for correlation in UIs). */
  requestId: string;
  /** Why approval is needed (gate reasons). */
  reasons: string[];
  /** Agent being run when inside a subagent. */
  agentName: string;
}

export type ApprovalResponse =
  /** y */
  | { kind: 'allow-once' }
  /** t / ACP allow_always: add session trust for this tool then allow. */
  | { kind: 'allow-always' }
  /** n: model receives Kiro's denial text (or `message`). */
  | { kind: 'deny'; message?: string }
  /** Any other typed text: cancel the tool + interrupt, then send `text` as the next user turn. */
  | { kind: 'redirect'; text: string }
  /** Ctrl+C / ACP cancelled: deny with interrupt. */
  | { kind: 'cancelled' };

// ───────────────────────────── Session index ─────────────────────────────

export interface SessionTurnRecord {
  userUuid: string;
  /** uuid of the last assistant frame of the turn (for /rewind via --resume-session-at). */
  assistantUuid?: string;
  preview: string;
  at: string;
}

/** Persisted session index record (00 §7). */
export interface SessionRecord {
  version: 1;
  kind: 'kiro-claude-session';
  origin: 'repl' | 'acp' | 'headless' | 'spec';
  sessionId: string;
  claudeSessionId: string;
  cwd: string;
  additionalDirectories: string[];
  agent: string;
  model: string;
  effort?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastPreview: string;
  parentId: string | null;
  forkKind: 'main' | 'tangent' | 'rewind' | 'spawn' | 'compact';
  tangentName: string | null;
  turns: SessionTurnRecord[];
  contextRules: { rule: string; origin: 'session' }[];
  trust: SessionTrust;
  planMode: boolean;
}

// ───────────────────────────── Models ─────────────────────────────

export interface ModelEntry {
  /** Kiro-style id shown to users (claude-sonnet-5.5, auto). */
  kiroId: string;
  /** Value passed to Claude (--model / set_model); undefined for auto. */
  claudeValue?: string;
  displayName: string;
  description?: string;
  contextWindowTokens?: number;
  supportedEffortLevels?: string[] | null;
  isDefault?: boolean;
}

// ───────────────────────────── KiroSession (orchestrator) ─────────────────────────────

/** Normalized events emitted while a turn runs; consumed by REPL, headless, ACP, spec. */
export type SessionEvent =
  | { type: 'text_delta'; text: string; messageId?: string }
  | { type: 'thinking_delta'; text: string }
  /** Complete text block (emitted only when no deltas were streamed for it). */
  | { type: 'text'; text: string }
  | { type: 'tool_start'; toolUseId: string; call: KiroToolCall; trusted: boolean }
  | { type: 'tool_denied'; toolUseId?: string; call: KiroToolCall; reason: string }
  | {
      type: 'tool_end';
      toolUseId: string;
      call?: KiroToolCall;
      isError: boolean;
      /** Short text rendering of the result (truncated). */
      output: string;
      durationMs?: number;
    }
  | { type: 'todo_update'; todos: TodoItem[] }
  | { type: 'compaction'; state: 'started' | 'finished'; preTokens?: number; postTokens?: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'subagent'; state: 'started' | 'finished'; agentType: string; description?: string; toolUseId?: string }
  | { type: 'rate_limit'; status: string; resetsAt?: number; utilization?: number }
  | { type: 'session_id'; claudeSessionId: string }
  /** Any Claude frame, for UIs that want raw access (ACP/debug). */
  | { type: 'raw'; frame: unknown };

export interface TodoItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface TurnResult {
  stopReason: 'end_turn' | 'cancelled' | 'error' | 'max_turns' | 'refusal' | 'local_command';
  isError: boolean;
  /** Final assistant text of the turn (Claude result.result). */
  text: string;
  /** Error description when isError. */
  error?: string;
  authError?: boolean;
  usage?: TurnUsage;
  /** Cumulative list-price estimate reported by Claude (not what a subscription pays). */
  costUsd?: number;
  claudeSessionId?: string;
  numTurns?: number;
  localCommand?: string;
  permissionDenials: { toolName: string; reason?: string }[];
}

export interface PromptInput {
  /** Raw user text (after REPL-level command handling). */
  text: string;
  /** Extra content blocks (images). */
  images?: { mediaType: string; dataBase64: string }[];
  /** Skip userPromptSubmit hooks (e.g. hook-driven continuations, spec internal turns). */
  skipPromptHooks?: boolean;
  /** Extra context blocks prepended verbatim (e.g. spec instructions). */
  extraContext?: string[];
  /** Steering names explicitly referenced (#name / /name) — usually derived by context/refs. */
  steeringRefs?: string[];
}

/** UI callbacks a KiroSession needs. REPL, headless and ACP each implement this. */
export interface SessionUI {
  /** Ask the user to approve a tool call (only called in interactive sessions). */
  requestApproval(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResponse>;
  /** Hook warnings, config warnings, informational lines. */
  notice(level: 'info' | 'warn' | 'error', message: string): void;
  /** Stop-hook confirm picker; return the chosen option id or undefined to dismiss. */
  confirmStopHook?(q: { hook: string; question: string; options: HookConfirmOption[] }): Promise<string | undefined>;
}

export interface KiroSessionOptions {
  ws: WorkspaceContext;
  origin: SessionRecord['origin'];
  /** Interactive sessions may ask; non-interactive ones deny instead (00 §2.3 Headless). */
  interactive: boolean;
  ui: SessionUI;
  agentName?: string;
  model?: string;
  effort?: string;
  trustAllTools?: boolean;
  /** Names from --trust-tools (normalized by policy). */
  trustTools?: string[];
  /** Resume an existing kiro-claude session id, or the newest for this cwd. */
  resume?: { sessionId: string } | { latest: true };
  /** Fork from a Claude session (tangent / rewind / chat load). */
  fork?: { fromClaudeSessionId: string; at?: string; kind: SessionRecord['forkKind']; parentId?: string };
  /** Spec phase write restriction (00 §5.1 specPhase). */
  specPhase?: { name: string; allowedWritePaths: string[] };
  /** Additional `--add-dir` directories. */
  additionalDirectories?: string[];
  /** Explicit claude binary path (else discovery). */
  claudePath?: string;
  /** Allow ANTHROPIC_API_KEY etc. to reach the child (default false = subscription). */
  allowApiKey?: boolean;
}

/**
 * One live Kiro conversation backed by one `claude` child process (00 §1 invariant 1).
 * Implemented by session/kiroSession.ts. Events are also emitted as 'event' (SessionEvent).
 */
export interface KiroSession extends EventEmitter {
  readonly id: string;
  readonly claudeSessionId: string | undefined;
  readonly agent: KiroAgent;
  /** Kiro-style model id ('auto' when unset). */
  readonly model: string;
  readonly effort: string | undefined;
  readonly trust: SessionTrust;
  readonly interactive: boolean;
  readonly record: SessionRecord;
  planMode: boolean;
  readonly tangent: { name: string | null; parentId: string } | undefined;

  /** Spawn claude, run SessionStart hooks, compose the system prompt. Idempotent. */
  start(): Promise<void>;
  /** Run one user turn (plus Stop-hook continuations). Yields events, returns the final result. */
  prompt(input: PromptInput, opts?: { signal?: AbortSignal }): AsyncGenerator<SessionEvent, TurnResult>;
  /** Inject text into the running turn at the next tool boundary (priority "next"). */
  steer(text: string): void;
  /** Interrupt the running turn (control interrupt) and cancel pending approvals. */
  interrupt(): Promise<void>;

  swapAgent(name: string): Promise<void>;
  setModel(kiroModelId: string): Promise<void>;
  setEffort(level: string): Promise<void>;
  listModels(): Promise<ModelEntry[]>;

  /** /context: session-scoped context globs (respawn with --resume). */
  addContext(globs: string[]): Promise<{ added: string[]; matched: Record<string, string[]> }>;
  removeContext(globs: string[]): Promise<string[]>;
  clearContext(): Promise<void>;
  contextReport(): Promise<ContextReport>;

  /** /clear (local Claude command; new Claude session id). */
  clear(): Promise<void>;
  /** /compact [instructions] */
  compact(instructions?: string): AsyncGenerator<SessionEvent, TurnResult>;
  /** /tangent: enter (fork) or exit back to the parent. */
  enterTangent(name?: string): Promise<void>;
  exitTangent(mode: 'discard' | 'tail' | 'merge'): Promise<void>;
  /** /rewind N: fork at turn N (1-based). */
  rewind(turn: number): Promise<void>;

  /** Tool listing for /tools. */
  toolListing(): ToolListingEntry[];
  trustTools(names: string[]): void;
  untrustTools(names: string[]): void;
  setTrustAll(on: boolean): void;
  resetTrust(): void;

  usage(): Promise<UsageReport>;
  mcpStatus(): Promise<McpStatusEntry[]>;
  todos(): TodoItem[];
  hooks(): readonly KiroHook[];
  runManualHook(name: string): Promise<string>;

  /** /chat save; returns the written path. */
  exportTo(path: string, force: boolean): Promise<string>;
  /** Close the claude child (stdin end → SIGTERM), run SessionEnd hooks, release the session lock. */
  close(): Promise<void>;
}

export interface ContextReport {
  agentEntries: { pattern: string; files: { path: string; tokens: number }[] }[];
  sessionEntries: { pattern: string; files: { path: string; tokens: number }[] }[];
  steering: { path: string; inclusion: SteeringInclusion; tokens: number }[];
  hookOutputs: { tokens: number }[];
  droppedFiles: string[];
  totalTokens: number;
  contextWindowTokens: number;
}

export interface ToolListingEntry {
  /** Kiro display name (read, write, shell, @srv/tool ...). */
  name: string;
  claudeName: string;
  source: 'builtin' | 'mcp';
  server?: string;
  /** Effective permission label: 'trusted' | 'not trusted' | 'denied' | 'read-only commands' | ... */
  permission: string;
}

export interface UsageReport {
  contextTokens?: number;
  contextWindowTokens?: number;
  contextPercent?: number;
  categories?: { name: string; tokens: number }[];
  sessionCostUsd?: number;
  rateLimit?: { status: string; resetsAt?: number; utilization?: number; window?: string };
  model: string;
}

export interface McpStatusEntry {
  name: string;
  status: string;
  toolCount?: number;
  error?: string;
}

// ───────────────────────────── REPL extension contract ─────────────────────────────

/**
 * What a slash command can do with the running REPL (implemented by repl/repl.ts).
 * Lets modules such as spec/ contribute commands without depending on REPL internals.
 */
export interface ReplHost {
  readonly ws: WorkspaceContext;
  readonly settings: SettingsStore;
  /** The active session (may be replaced by replaceSession). */
  readonly session: KiroSession;
  /** Write a line (or block) to the terminal (stdout). */
  print(text: string): void;
  /** Ask a free-form question; resolves with the trimmed answer ('' on empty). */
  ask(question: string): Promise<string>;
  /** Ask y/n; resolves true for y/yes. */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  /** Pick one option; resolves with its index or undefined when cancelled. */
  choose(question: string, options: string[]): Promise<number | undefined>;
  /** Run a user turn with full REPL rendering (streaming text, tool lines, approvals). */
  runTurn(input: PromptInput): Promise<TurnResult>;
  /** Swap the active session (e.g. a spec task child session); the old one is NOT closed. */
  replaceSession(next: KiroSession): void;
  /** Create a new session sharing this REPL's UI (approvals render in the REPL). */
  createSession(opts: Partial<KiroSessionOptions>): Promise<KiroSession>;
}

export interface SlashCommand {
  /** Without the leading slash, e.g. 'spec'. */
  name: string;
  aliases?: string[];
  /** One-line description for /help. */
  summary: string;
  /** Usage line(s) for `/help <name>` and `/<name> --help`. */
  usage?: string;
  /** args = shlex-split words after the command; raw = text after the command. Return 'quit' to exit the REPL. */
  run(args: string[], raw: string, host: ReplHost): Promise<void | 'quit'>;
}
