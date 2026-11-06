/**
 * KiroSession: one live Kiro conversation backed by one `claude` child (00 §1 invariant 1).
 *
 * Sources: 00 §1 (invariants), §2 (decision tables: §2.2 context, §2.3 tools/approvals, §2.4
 * hooks, §2.5 models/sessions/conversation commands), §3 (wire), §5 (gate), §6 (context), §7
 * (session index); 04 (protocol details); 08 §2.4–2.6 and 08a §4 (KiroCrew session files,
 * env passthrough, `KIRO_CLAUDE_FORCE_MODEL`, effort from `chat.modelDefaults`, agents read
 * fresh from `$KIRO_HOME/agents` at every spawn).
 *
 * Lifecycle
 *  - {@link createSession} resolves the session record (new / `resume` latest-for-cwd or by id
 *    / `fork` / import), the agent (`--agent` > saved agent > `chat.defaultAgent` >
 *    `kiro_default`; a missing `--agent` is fatal for non-interactive sessions, exit 4), the
 *    model (`--model` > saved > agent `model` > `chat.defaultModel` > `auto`; an invalid
 *    explicit id is fatal, others warn and fall back) and the effort (`--effort` > saved >
 *    `chat.modelDefaults.<model>.output_config.effort`), takes the session lock and starts.
 *  - {@link KiroSessionImpl.start}: SessionStart (agentSpawn) hooks run BEFORE the child is
 *    spawned; their outputs go into the system-prompt file, agent-action prompts are prepended
 *    to the first user turn. Then session/launch `buildLaunch` + `ClaudeProcess.start`.
 *  - Respawns (agent swap, `/context` edits, `/clear` with changed hook output, tangent, rewind,
 *    a crashed child) always re-read the agents and pass `--resume` (or `--fork-session`) with
 *    `--system-prompt-snapshot off`. A session that never produced a transcript is restarted
 *    with `--session-id` instead (VERIFIED with claude 2.1.318: `--resume` of a session with no
 *    messages fails with `No conversation found`); each mode falls back to the other on the
 *    CLI's `already in use` / `No conversation found` start errors, and a lost transcript is
 *    replaced by the `<sid>.jsonl` journal as context (08a §4.2).
 *
 * Tool calls: the gate (policy/gate) answers every PreToolUse `hook_callback`; that is also
 * where `tool_start` (with `trusted` = allowed without asking) or `tool_denied` is emitted, so
 * the UI shows the call before any approval prompt. `can_use_tool` → `gate.canUseTool` with
 * `ui.requestApproval` (serialized); a redirect answer queues its text as the next user turn,
 * run inside the same `prompt()` after the interrupted turn. Results (`user` tool_result
 * frames) emit `tool_end` (a gate-denied call gets no `tool_end`). Todos are tracked from
 * TaskCreate / TaskUpdate inputs and results (00 §2.5 `/todos`).
 *
 * Turn text (00 §6.2): `/name args` / `@name args` prompt files (config/prompts), `/<skill> args`
 * inlined (config/skills), userPromptSubmit hooks, `@` and `#` references (context/refs),
 * conditional steering (context/userTurn SteeringActivator), pending context (first-turn hook
 * prompts, tangent tail/merge, restored history), the plan-mode block, then composeUserTurn.
 *
 * Streaming: `text_delta` / `thinking_delta` from `stream_event`s (top level only); a complete
 * `text` block is emitted only for messages that streamed no deltas (dedupe by message id).
 * Subagent text (frames with `parent_tool_use_id`) is never emitted as assistant text.
 *
 * After each turn ending normally, Stop hooks may request continuation turns (≤ 3, enforced by
 * the hook runner) and `confirm` pickers (`ui.confirmStopHook`). Every turn updates the session
 * index (`turns[]` with the last top-level assistant uuid, for `/rewind`) and appends the
 * KiroCrew journal (`Prompt` / `AssistantMessage` / `ToolResults` / `Compaction`).
 *
 * Diagnostics: configuration, hook and gate messages go to `ui.notice`; `notice` events carry
 * turn-scoped messages from Claude (API-key billing, rate-limit rejection). Every event is
 * yielded by the running `prompt()` / `compact()` generator AND emitted as `'event'`, except the
 * conversation events (text, tools, todos) of internal local turns (`/effort`, `/clear`, the
 * hidden tangent-summary turn), which are silent (their `session_id` / notices still go out).
 *
 * Review decisions (DECISION unless tagged):
 *  - ACP sessions (`origin: 'acp'`) send prompt text verbatim: no `@path` / `#` provider
 *    expansion and no prompt-text steering activation (08 KC-ACP-06, 08a §4.4); `/prompt`,
 *    `@prompt` and `/<skill>` invocations still expand.
 *  - A record copied under a new stem by someone else (KiroCrew peer transfer, 08a §4.2; see
 *    store `copiedFrom`) forks its Claude session on resume instead of sharing the transcript.
 *  - Forks (tangent / rewind / copies) stay "pending" until a turn completes in them: a respawn
 *    before that re-forks the source rather than resuming an id Claude may not have written yet.
 *  - Rewind cuts the journal before the next turn's `Prompt` (by message id), so steers and
 *    `/clear` markers do not shift it.
 *  - `--trust-all-tools` is per invocation: resuming without it clears `trust.trustAll`.
 *  - `KIRO_CLAUDE_FORCE_MODEL` also pins Claude subagents (`CLAUDE_CODE_SUBAGENT_MODEL[_FORCE]`);
 *    `toolSearch.*` settings map to `ENABLE_TOOL_SEARCH` (08 KC-FS-05, see {@link toolSearchEnv}).
 *  - After `close()` nothing is written any more (the lock is released).
 *
 * Library code: never writes to stdout/stderr.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isAuthError } from '../claude/auth.js';
import { findClaudeBinary, probeCapabilities, type ClaudeBinary, type ClaudeCapabilities } from '../claude/binary.js';
import { buildChildEnv } from '../claude/env.js';
import { ClaudeProcess, ClaudeProcessError, type ClaudeHandlers } from '../claude/process.js';
import {
  toolResults,
  toolResultText,
  type AssistantFrame,
  type ClaudeFrame,
  type ContextUsage,
  type McpStatus,
  type ModelInfo,
  type RateLimitFrame,
  type ResultFrame,
  type StreamEventFrame,
  type UserContentBlock,
  type UserFrame,
} from '../claude/protocol.js';
import { findTranscript, rewriteTranscriptSessionId, transcriptPath } from '../claude/transcript.js';
import { loadAgents, selectAgent } from '../config/agents.js';
import { allHooksFor } from '../config/hooks.js';
import { loadKiroIgnore, type KiroIgnore } from '../config/kiroignore.js';
import { loadPermissionScopes } from '../config/permissionsYaml.js';
import { expandPrompt, findPrompt, loadPrompts, parsePromptInvocation } from '../config/prompts.js';
import { expandFileSpec } from '../config/resources.js';
import { openSettings } from '../config/settings.js';
import { expandSkillInvocation, pluginSkillName } from '../config/skills.js';
import { expandFileRefs } from '../config/steering.js';
import { expandAtRefs, expandHashRefs, type AtRefsResult, type HashRefsResult } from '../context/refs.js';
import { estimateTokens } from '../context/tokens.js';
import { composeUserTurn, SteeringActivator } from '../context/userTurn.js';
import { HookRunner } from '../hooks/runner.js';
import {
  AUTO_MODEL_ID,
  buildModelList,
  claudeToKiroModelId,
  contextWindowFor,
  DEFAULT_MODEL_WINDOW,
  findModelEntry,
  kiroToClaudeModel,
  readModelCache,
  writeModelCache,
} from '../models/models.js';
import { presetRules as capPresetRules } from '../policy/capengine.js';
import { deniedRulesText, Gate, GATE_CALLBACK_IDS } from '../policy/gate.js';
import { BUILTIN_CLAUDE_TOOLS, claudeMcpName, isTodoTool, SKILL_CLAUDE_TOOL, toKiroCall } from '../policy/toolmap.js';
import type {
  ContextReport,
  GateDecision,
  KiroAgent,
  KiroHook,
  KiroSession,
  KiroSessionOptions,
  KiroToolCall,
  McpStatusEntry,
  ModelEntry,
  PermissionRule,
  PromptFile,
  PromptInput,
  SessionEvent,
  SessionRecord,
  SessionTrust,
  SessionUI,
  SettingsStore,
  TodoItem,
  ToolListingEntry,
  TurnResult,
  UsageReport,
  WorkspaceContext,
} from '../types.js';
import { mkdirp, writeFileAtomic } from '../util/fsx.js';
import { log } from '../util/log.js';
import { runtimeDir as baseRuntimeDir } from '../util/paths.js';
import {
  appendJournal,
  assistantRecord,
  compactionRecord,
  copyJournal,
  journalHistoryText,
  journalPath,
  parseJournal,
  promptRecord,
  readJournal,
  readJournalText,
  toolResultsRecord,
  writeJournalRecords,
  writeJournalText,
  type JournalBlock,
  type JournalRecord,
} from './kiroFiles.js';
import { buildLaunch, EFFORT_LEVELS, type LaunchResult } from './launch.js';
import { fromDiskJson, SESSION_KIND, SessionStore, sessionsDir, type SessionLock } from './store.js';

// ───────────────────────────── exact strings / constants ─────────────────────────────

/** 01 §3 `--resume` without a saved session. */
export const NO_SAVED_SESSIONS = 'No saved chat sessions for this directory. Starting a new session.';

/** Prefix block of every user turn in plan mode (00 §2.5, 03 §5.4 formats). */
export const PLAN_MODE_BLOCK = [
  '<kiro-plan-mode>',
  'You are in Kiro plan mode (read-only): research and plan, but do not write files, run commands or call MCP tools.',
  '1. If the request is ambiguous, first ask structured questions in this format:',
  '[1]: <question>',
  'a. <option>',
  'b. <option>',
  '(Answer with "1=a, 2=b" or provide your own answers)',
  '2. Research the codebase as needed.',
  '3. Then produce the plan in this format:',
  '**Implementation Plan - <Title>**',
  '**Problem Statement:** <one paragraph>',
  '**Requirements:**',
  '- <requirement>',
  '**Task Breakdown:**',
  'Task 1: <title>',
  '- <step>',
  '- Demo: <what works after this task>',
  '</kiro-plan-mode>',
].join('\n');

/** Hidden turn asked in a tangent before `/tangent merge` (01 §5.11 "summarize tangent"). */
export const TANGENT_SUMMARY_PROMPT =
  'Summarize the findings of this side conversation (tangent) for the main conversation: the question explored, ' +
  'what you found and any conclusions or decisions, in a few short paragraphs. Do not use tools.';

/** `tool_end.output` cap (characters). */
export const TOOL_OUTPUT_MAX_CHARS = 4000;

/** Max time a new turn waits for a still-running CLI turn (e.g. a late steer) to finish. */
const WAIT_IDLE_MS = 120_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Conversation events suppressed while an internal local turn runs (see `publish`). */
const SILENT_IN_LOCAL_TURNS: ReadonlySet<SessionEvent['type']> = new Set<SessionEvent['type']>([
  'text',
  'text_delta',
  'thinking_delta',
  'tool_start',
  'tool_denied',
  'tool_end',
  'todo_update',
  'subagent',
]);

// ───────────────────────────── errors ─────────────────────────────

/** `--agent` / `/agent swap` names an agent that does not exist (non-interactive: exit 4). */
export class AgentNotFoundError extends Error {
  readonly agentName: string;
  readonly exitCode = 4;
  readonly reason?: string;
  constructor(agentName: string, reason?: string) {
    super(reason ? `Error: no agent with name ${agentName} found (${reason})` : `Error: no agent with name ${agentName} found`);
    this.name = 'AgentNotFoundError';
    this.agentName = agentName;
    if (reason !== undefined) this.reason = reason;
  }
}

/** `--resume-id` / ACP `session/load` of an unknown session id (exit 1). */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  readonly exitCode = 1;
  constructor(sessionId: string) {
    super(`No saved chat session with id ${sessionId}`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

/** Explicit `--model` that is not a Claude model (01 §3: exit 1). */
export class ModelNotFoundError extends Error {
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = 'ModelNotFoundError';
  }
}

// ───────────────────────────── helpers ─────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Per-turn event queue drained by the `prompt()` generator. */
class EventSink {
  private readonly q: SessionEvent[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  push(ev: SessionEvent): void {
    if (this.closed) return;
    this.q.push(ev);
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  async *drain(): AsyncGenerator<SessionEvent, void> {
    for (;;) {
      const ev = this.q.shift();
      if (ev) {
        yield ev;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

type LaunchMode = { kind: 'new' } | { kind: 'resume' } | { kind: 'fork'; from: string; at?: string };

interface TurnState {
  kind: 'prompt' | 'local' | 'compact';
  userText: string;
  userUuid: string;
  /** Text of the latest top-level assistant message. */
  assistantText: string;
  lastMsgId?: string;
  assistantUuid?: string;
  streamMsgId?: string;
  streamed: Set<string>;
  streamedThinking: Set<string>;
  authError: boolean;
  journal: JournalRecord[];
  curAssistant?: { id: string; content: JournalBlock[] };
  lastToolBatch?: JournalRecord;
  compactPending: boolean;
  compactSummary?: string;
  /** Steer prompts sent mid-turn, journaled after the tool results they were injected behind. */
  pendingSteer: JournalRecord[];
}

/** Effort from `chat.modelDefaults.<model>.output_config.effort` (08 KC-FS-05). */
export function modelDefaultEffort(settings: SettingsStore, kiroModel: string, claudeValue?: string): string | undefined {
  const ids = [kiroModel, ...(claudeValue ? [claudeValue, claudeToKiroModelId(claudeValue)] : [])];
  for (const id of ids) {
    const flat = settings.get(`chat.modelDefaults.${id}.output_config.effort`);
    if (typeof flat === 'string' && flat.trim() !== '') return flat.trim();
  }
  const obj = settings.get('chat.modelDefaults');
  if (isObj(obj)) {
    for (const id of ids) {
      const m = Object.prototype.hasOwnProperty.call(obj, id) ? obj[id] : undefined;
      if (isObj(m) && isObj(m.output_config) && typeof m.output_config.effort === 'string' && m.output_config.effort.trim() !== '') {
        return m.output_config.effort.trim();
      }
    }
  }
  return undefined;
}

/**
 * Kiro `toolSearch.enabled` / `toolSearch.minPct` (KiroCrew's per-spawn cli.json overlay, 08
 * KC-FS-05, 08a §4.1) ⇒ Claude's `ENABLE_TOOL_SEARCH` (`false`, or `auto:<pct>`; both spellings
 * are in the 2.1.318 binary). UNVERIFIED that Kiro's minPct means the same threshold as Claude's
 * `auto:N` (DECISION: pass it through). Claude turns tool search off by itself when `ToolSearch`
 * is not in `--tools`, so this only matters for agents that select `tool_search`.
 */
export function toolSearchEnv(settings: SettingsStore): string | undefined {
  const enabled = settings.get('toolSearch.enabled');
  if (enabled === false || enabled === 'false') return 'false';
  if (enabled === true || enabled === 'true') {
    const pct = settings.get('toolSearch.minPct');
    const n = typeof pct === 'number' ? pct : typeof pct === 'string' && pct.trim() !== '' ? Number(pct) : NaN;
    if (Number.isFinite(n) && n >= 0 && n <= 100) return `auto:${n}`;
  }
  return undefined;
}

function restoredHistoryBlock(history: string): string {
  return [
    '<kiro-restored-history>',
    'Claude Code could not restore the previous conversation of this session. This is its record as kept by Kiro; continue from it.',
    '',
    history,
    '</kiro-restored-history>',
  ].join('\n');
}

function truncateChars(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… (${s.length - max} more characters)`;
}

/** Cached binary + capabilities per (explicit path, $KIRO_CLAUDE_BIN, PATH). */
const binaryCache = new Map<string, Promise<{ binary: ClaudeBinary; caps: ClaudeCapabilities }>>();

async function resolveClaude(explicitPath: string | undefined, env: NodeJS.ProcessEnv): Promise<{ binary: ClaudeBinary; caps: ClaudeCapabilities }> {
  const key = JSON.stringify([explicitPath ?? '', env.KIRO_CLAUDE_BIN ?? '', env.PATH ?? '', env.KIRO_HOME ?? '', env.HOME ?? '']);
  let p = binaryCache.get(key);
  if (!p) {
    p = (async () => {
      const binary = await findClaudeBinary({ ...(explicitPath ? { explicitPath } : {}), env });
      const caps = await probeCapabilities(binary, { env });
      return { binary, caps };
    })();
    binaryCache.set(key, p);
    p.catch(() => binaryCache.delete(key));
  }
  return p;
}

/** Options accepted by {@link KiroSessionImpl} beyond the shared contract (tests / embedding). */
export interface KiroSessionInternalOptions extends KiroSessionOptions {
  settings?: SettingsStore;
  binary?: ClaudeBinary;
  caps?: ClaudeCapabilities;
}

interface Preset {
  rec: SessionRecord;
  mode: LaunchMode;
  pendingContext?: string[];
}

// ───────────────────────────── the session ─────────────────────────────

export class KiroSessionImpl extends EventEmitter implements KiroSession {
  readonly interactive: boolean;
  readonly ws: WorkspaceContext;
  readonly settings: SettingsStore;
  readonly store: SessionStore;

  private readonly opts: KiroSessionInternalOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly ui: SessionUI;
  private readonly runtimeDirPath: string;
  private readonly trustState: SessionTrust;
  private readonly gate: Gate;

  private rec: SessionRecord;
  private lock: SessionLock | undefined;
  private tangentStack: { rec: SessionRecord; lock: SessionLock | undefined; pendingFork?: Extract<LaunchMode, { kind: 'fork' }> }[] = [];
  private agents: Map<string, KiroAgent>;
  private currentAgent: KiroAgent;
  private hookRunner: HookRunner;
  private kiroIgnore: KiroIgnore;
  private prompts: PromptFile[];
  private activator: SteeringActivator;
  private v3: { userRules: PermissionRule[]; workspaceRules: PermissionRule[]; presetRules: PermissionRule[] } = {
    userRules: [],
    workspaceRules: [],
    presetRules: [],
  };

  private binary: ClaudeBinary | undefined;
  private caps: ClaudeCapabilities | undefined;
  private proc: ClaudeProcess | undefined;
  private launch: LaunchResult | undefined;
  private liveModels: ModelInfo[] | undefined;
  private initialMode: LaunchMode;
  private historyKnown: boolean;

  private spawnOutputs: string[] = [];
  private firstTurnPrompts: string[] = [];
  private pendingContext: string[] = [];
  private queuedSteer: string[] = [];
  private redirects: string[] = [];
  private pendingEffort: string | undefined;

  private startPromise: Promise<void> | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  /** Last Claude session id reported with a `session_id` event (or known at construction). */
  private announcedClaudeId: string | undefined;
  /** close()/abandon() finished: the lock is released, nothing may be written any more. */
  private finalized = false;
  /**
   * The last spawn forked a Claude session (tangent / rewind / transferred copy) and no turn has
   * completed in it yet: Claude may not have written the forked transcript, so a respawn forks
   * again instead of resuming an id that may not exist (`already in use` falls back to resume).
   */
  private pendingFork: Extract<LaunchMode, { kind: 'fork' }> | undefined;
  private turnBusy = false;
  private turn: TurnState | undefined;
  private sink: EventSink | undefined;
  private turnAbort: AbortController | undefined;

  private readonly todoMap = new Map<string, TodoItem>();
  private readonly toolCalls = new Map<string, KiroToolCall>();
  private readonly toolUses = new Map<string, { name: string; input: Record<string, unknown> }>();
  private readonly announced = new Set<string>();
  private readonly deniedIds = new Map<string, string>();
  private readonly policyReasons = new Map<string, string[]>();
  private readonly durations = new Map<string, number>();
  private lastRateLimit: UsageReport['rateLimit'] | undefined;
  /** Streaming dedupe state for CLI-initiated turns (no TurnState). */
  private bgStream: { streamMsgId?: string; streamed: Set<string> } = { streamed: new Set() };
  /** Claude MCP tool names from the last `mcp_status` (tool listing before the first turn). */
  private mcpStatusTools: { proc: ClaudeProcess; names: string[] } | undefined;
  private sessionCostUsd: number | undefined;
  private contextWindow: number | undefined;
  private compacting = false;
  private apiKeyWarned = false;
  private forceModelWarned = false;
  private lastExchange: { user: string; assistant: string } | undefined;
  private readonly noticed = new Set<string>();
  private readonly fresh: boolean;

  private constructor(opts: KiroSessionInternalOptions, init: {
    settings: SettingsStore;
    store: SessionStore;
    rec: SessionRecord;
    lock: SessionLock | undefined;
    agents: Map<string, KiroAgent>;
    agent: KiroAgent;
    mode: LaunchMode;
    pendingContext?: string[];
    /** The record was created by this call (deleted again if starting fails). */
    fresh?: boolean;
  }) {
    super();
    this.opts = opts;
    this.ws = opts.ws;
    this.env = opts.env ?? opts.ws.env;
    this.ui = opts.ui;
    this.interactive = opts.interactive;
    this.settings = init.settings;
    this.store = init.store;
    this.rec = init.rec;
    this.lock = init.lock;
    this.agents = init.agents;
    this.currentAgent = init.agent;
    this.initialMode = init.mode;
    this.fresh = init.fresh === true;
    this.historyKnown = init.mode.kind !== 'new';
    if (init.pendingContext) this.pendingContext.push(...init.pendingContext);
    this.trustState = this.rec.trust;
    this.announcedClaudeId = this.rec.claudeSessionId;
    // unique per object: a second in-process session for the same id (the lock lets this process
    // take its own lock over) must not delete the files a live child still reads (plugin dir)
    this.runtimeDirPath = path.join(baseRuntimeDir(this.env), `session-${this.rec.sessionId}-${randomUUID().slice(0, 8)}`);
    this.hookRunner = new HookRunner(allHooksFor(this.ws, this.currentAgent));
    this.kiroIgnore = loadKiroIgnore(this.ws);
    this.prompts = loadPrompts(this.ws);
    this.activator = new SteeringActivator([], this.ws);
    this.gate = new Gate({
      ws: this.ws,
      sessionId: () => this.rec.sessionId,
      agent: () => this.currentAgent,
      resolveAgent: (n) => this.agents.get(n),
      hooks: () => this.hookRunner,
      trust: this.trustState,
      interactive: this.interactive,
      v3Scopes: () => this.v3,
      mcpServerNames: () => this.launch?.mcpNameMap ?? {},
      mcpAutoApprove: (server) => this.launch?.allMcpServers.find((s) => s.name === server)?.autoApprove ?? [],
      isIgnored: (p) => this.kiroIgnore.isIgnored(p),
      planMode: () => this.rec.planMode,
      specPhase: () => this.opts.specPhase,
      onPostToolContext: (call) => this.postToolSteering(call),
      notify: (level, msg) => this.uiNotice(level, msg),
      onDenied: (call, reasons) => {
        if (call.toolUseId) this.policyReasons.set(call.toolUseId, reasons);
      },
    });
    if (opts.trustAllTools) this.gate.setTrustAll(true);
    if (opts.trustTools?.length) this.gate.trustTools(opts.trustTools);
  }

  // ── construction ──

  /** Resolve record, agent, model and effort, take the lock and start (see module doc). */
  static async create(opts: KiroSessionInternalOptions, preset?: Preset): Promise<KiroSessionImpl> {
    const ws = opts.ws;
    const env = opts.env ?? ws.env;
    const settings = opts.settings ?? openSettings(ws);
    const store = new SessionStore(sessionsDir(ws));
    const loaded = loadAgents(ws, { settings });
    const notices: { level: 'info' | 'warn'; message: string }[] = [];
    for (const w of loaded.warnings) {
      if (w.code === 'agent-conflict' || w.code === 'agent-duplicate') notices.push({ level: 'warn', message: w.message });
    }

    // record + launch mode
    let rec: SessionRecord | undefined = preset?.rec;
    let mode: LaunchMode = preset?.mode ?? { kind: 'new' };
    if (!preset && opts.resume) {
      if ('latest' in opts.resume) {
        rec = store.latest(ws.cwd);
        if (!rec) notices.push({ level: 'info', message: NO_SAVED_SESSIONS });
      } else {
        rec = store.read(opts.resume.sessionId);
        if (!rec) throw new SessionNotFoundError(opts.resume.sessionId);
      }
      if (rec) mode = rec.turns.length > 0 || rec.messageCount > 0 ? { kind: 'resume' } : { kind: 'new' };
    }
    // A record copied under a new id by someone else (KiroCrew peer transfer, 08a §4.2) still
    // names the original's Claude session: fork it (or start fresh) so the two never share one
    // Claude transcript. Persisted only once the child is up, so a failed start changes nothing.
    let transferred = false;
    if (rec && !preset && store.copiedFrom(rec.sessionId) !== undefined) {
      transferred = true;
      const from = rec.claudeSessionId;
      rec.claudeSessionId = randomUUID();
      if (mode.kind === 'resume') mode = { kind: 'fork', from };
      log.debug(`session ${rec.sessionId} is a copy of ${store.copiedFrom(rec.sessionId)}; forking Claude session ${from}`);
    }

    // agent
    const requested = opts.agentName?.trim() ? opts.agentName.trim() : undefined;
    let agent: KiroAgent | undefined;
    if (requested) {
      agent = loaded.agents.get(requested);
      if (!agent) {
        const failed = loaded.failed.get(requested);
        if (!opts.interactive) throw new AgentNotFoundError(requested, failed?.message);
        if (failed) notices.push({ level: 'warn', message: failed.message });
      }
    }
    if (!agent && rec && !requested) {
      agent = loaded.agents.get(rec.agent);
      if (!agent) notices.push({ level: 'warn', message: `Agent ${rec.agent} of the saved session is no longer available.` });
    }
    if (!agent) {
      const sel = selectAgent(ws, loaded.agents, settings, requested, { interactive: opts.interactive });
      for (const w of sel.warnings) notices.push({ level: 'warn', message: w.message });
      agent = sel.agent;
    }
    for (const w of agent.warnings) notices.push({ level: 'warn', message: w.message });

    // model
    const live = readModelCache(env)?.models;
    let model: string;
    if (opts.model?.trim()) {
      const m = kiroToClaudeModel(opts.model.trim(), live);
      if (m.error) throw new ModelNotFoundError(m.error);
      model = opts.model.trim();
    } else if (rec && !preset && rec.model) {
      model = rec.model;
    } else if (preset) {
      model = preset.rec.model;
    } else {
      model = AUTO_MODEL_ID;
      const candidates: { id: string | undefined; what: string }[] = [
        { id: agent.model, what: `agent ${agent.name}` },
        { id: settings.getString('chat.defaultModel'), what: 'chat.defaultModel' },
      ];
      for (const c of candidates) {
        if (!c.id || c.id.trim() === '') continue;
        const m = kiroToClaudeModel(c.id.trim(), live);
        if (m.error) {
          notices.push({ level: 'warn', message: `${m.error} (from ${c.what}); falling back.` });
          continue;
        }
        model = c.id.trim();
        break;
      }
    }

    // effort
    let effort: string | undefined = opts.effort?.trim() || undefined;
    if (!effort && rec?.effort) effort = rec.effort;
    if (!effort) effort = modelDefaultEffort(settings, model, kiroToClaudeModel(model, live).value);
    if (effort && !EFFORT_LEVELS.includes(effort.toLowerCase())) {
      notices.push({ level: 'warn', message: `Unknown effort level '${effort}' (expected ${EFFORT_LEVELS.join(', ')}); ignored.` });
      effort = undefined;
    }
    if (effort) effort = effort.toLowerCase();

    // fork (tangent / rewind / chat load from a Claude session)
    if (!preset && opts.fork) {
      const parent = opts.fork.parentId ? store.read(opts.fork.parentId) : undefined;
      rec = store.create({
        origin: opts.origin,
        cwd: ws.cwd,
        agent: agent.name,
        model,
        ...(effort ? { effort } : {}),
        claudeSessionId: randomUUID(),
        parentId: opts.fork.parentId ?? null,
        forkKind: opts.fork.kind,
        additionalDirectories: opts.additionalDirectories ?? parent?.additionalDirectories ?? [],
        ...(parent ? { title: parent.title, contextRules: parent.contextRules } : {}),
      });
      mode = { kind: 'fork', from: opts.fork.fromClaudeSessionId, ...(opts.fork.at ? { at: opts.fork.at } : {}) };
    }

    let lock: SessionLock | undefined;
    let fresh = !!preset || (!!opts.fork && !preset);
    if (rec) {
      lock = store.acquireLock(rec.sessionId);
      rec.agent = agent.name;
      rec.model = model;
      if (effort) rec.effort = effort;
      else delete rec.effort;
      if (opts.additionalDirectories) rec.additionalDirectories = [...opts.additionalDirectories];
      if (rec.origin !== opts.origin && !preset && !opts.resume) rec.origin = opts.origin;
      // `--trust-all-tools` / `/tools trust-all` is per invocation (Q/Kiro launch flag): a resumed
      // session never silently auto-approves every tool because an earlier run did. Per-tool
      // trust (`t`, `/tools trust`, ACP allow_always) stays with the session (00 §5.4).
      if (rec.trust.trustAll && !opts.trustAllTools) rec.trust.trustAll = false;
    } else {
      rec = store.create({
        origin: opts.origin,
        cwd: ws.cwd,
        agent: agent.name,
        model,
        ...(effort ? { effort } : {}),
        additionalDirectories: opts.additionalDirectories ?? [],
      });
      fresh = true;
      lock = store.acquireLock(rec.sessionId);
    }

    let s: KiroSessionImpl;
    try {
      s = new KiroSessionImpl(opts, {
        settings,
        store,
        rec,
        lock,
        agents: loaded.agents,
        agent,
        mode,
        fresh,
        ...(preset?.pendingContext ? { pendingContext: preset.pendingContext } : {}),
      });
    } catch (e) {
      // config that throws while wiring the session must not leave the lock (or a new record) behind
      if (fresh && !preset) store.delete(rec.sessionId);
      lock?.release();
      throw e;
    }
    for (const n of notices) s.uiNotice(n.level, n.message, true);
    try {
      if (!transferred) s.persist();
      await s.start();
    } catch (e) {
      await s.abandon();
      throw e;
    }
    return s;
  }

  // ── KiroSession accessors ──

  get id(): string {
    return this.rec.sessionId;
  }

  get claudeSessionId(): string | undefined {
    return this.rec.claudeSessionId;
  }

  get agent(): KiroAgent {
    return this.currentAgent;
  }

  get model(): string {
    return this.rec.model || AUTO_MODEL_ID;
  }

  get effort(): string | undefined {
    return this.rec.effort;
  }

  get trust(): SessionTrust {
    return this.trustState;
  }

  get record(): SessionRecord {
    return this.rec;
  }

  get planMode(): boolean {
    return this.rec.planMode;
  }

  set planMode(on: boolean) {
    if (this.rec.planMode === on) return;
    this.rec.planMode = on;
    this.persist();
  }

  get tangent(): { name: string | null; parentId: string } | undefined {
    if (this.tangentStack.length === 0) return undefined;
    return { name: this.rec.tangentName, parentId: this.rec.parentId ?? this.tangentStack[this.tangentStack.length - 1]!.rec.sessionId };
  }

  /** The live Claude child (undefined before start / after close). */
  get process(): ClaudeProcess | undefined {
    return this.proc;
  }

  /** The last launch (argv, files, tool selection). */
  get lastLaunch(): LaunchResult | undefined {
    return this.launch;
  }

  /** The private directory holding the generated launch files. */
  get runtimeDir(): string {
    return this.runtimeDirPath;
  }

  // ── start / spawn ──

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The session is closed'));
    if (!this.startPromise) {
      this.startPromise = this.doStart().catch((e: unknown) => {
        this.startPromise = undefined;
        throw e;
      });
    }
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (this.opts.binary && this.opts.caps) {
      this.binary = this.opts.binary;
      this.caps = this.opts.caps;
    } else if (!this.binary || !this.caps) {
      const explicit = this.opts.claudePath ?? this.settings.getString('kiroClaude.claudePath');
      if (this.opts.binary) {
        this.binary = this.opts.binary;
        this.caps = await probeCapabilities(this.opts.binary, { env: this.env });
      } else {
        const r = await resolveClaude(explicit, this.env);
        this.binary = r.binary;
        this.caps = r.caps;
      }
    }
    await this.runSessionStartHooks();
    await this.spawn(this.initialMode);
    this.persist();
  }

  private reloadConfig(): void {
    try {
      const r = loadAgents(this.ws, { settings: this.settings });
      this.agents = r.agents;
      const fresh = r.agents.get(this.currentAgent.name);
      if (fresh) this.currentAgent = fresh;
    } catch (e) {
      this.uiNotice('warn', `Failed to reload agents: ${errText(e)}`);
    }
    this.kiroIgnore = loadKiroIgnore(this.ws);
    this.prompts = loadPrompts(this.ws);
    try {
      const ps = loadPermissionScopes(this.ws);
      for (const w of ps.warnings) this.uiNotice('warn', w.message, true);
      this.v3 = {
        userRules: ps.user,
        workspaceRules: ps.workspace,
        presetRules: ps.presets.flatMap((id) => capPresetRules(id) ?? []),
      };
    } catch (e) {
      this.uiNotice('warn', `Failed to load permissions: ${errText(e)}`, true);
    }
  }

  private async runSessionStartHooks(): Promise<void> {
    try {
      const r = await this.hookRunner.runSessionStart({ ws: this.ws, sessionId: this.rec.sessionId });
      this.spawnOutputs = r.outputs;
      this.firstTurnPrompts = [...r.agentPrompts];
      for (const w of r.warnings) this.uiNotice('warn', w.message);
    } catch (e) {
      this.uiNotice('warn', `agentSpawn hooks failed: ${errText(e)}`);
    }
  }

  private contextWindowGuess(): number {
    if (this.contextWindow) return this.contextWindow;
    const cache = readModelCache(this.env);
    const w = cache?.contextWindows?.[this.model];
    if (w && w > 0) return w;
    if (this.model === AUTO_MODEL_ID) return contextWindowFor(this.liveModels?.find((m) => m.value === 'default')?.resolvedModel ?? '') ?? DEFAULT_MODEL_WINDOW;
    return contextWindowFor(this.model) ?? DEFAULT_MODEL_WINDOW;
  }

  private buildLaunchFor(mode: LaunchMode): LaunchResult {
    const live = this.liveModels ?? readModelCache(this.env)?.models;
    return buildLaunch({
      ws: this.ws,
      settings: this.settings,
      agent: this.currentAgent,
      allAgents: this.agents,
      binary: this.binary!,
      caps: this.caps!,
      claudeSessionId: this.rec.claudeSessionId,
      ...(mode.kind === 'resume' ? { resume: { claudeSessionId: this.rec.claudeSessionId } } : {}),
      ...(mode.kind === 'fork' ? { resume: { claudeSessionId: mode.from, fork: true, ...(mode.at ? { at: mode.at } : {}) } } : {}),
      model: this.model,
      ...(this.rec.effort ? { effort: this.rec.effort } : {}),
      sessionContextGlobs: this.rec.contextRules.map((r) => r.rule),
      agentSpawnOutputs: this.spawnOutputs,
      ...(this.opts.extraMcpServers ? { extraMcpServers: this.opts.extraMcpServers } : {}),
      additionalDirectories: this.rec.additionalDirectories,
      contextWindowTokens: this.contextWindowGuess(),
      runtimeDir: this.runtimeDirPath,
      ...(live ? { liveModels: live } : {}),
      env: this.env,
    });
  }

  private childEnv(): NodeJS.ProcessEnv {
    const allowApiKey = this.opts.allowApiKey ?? this.settings.getBoolean('kiroClaude.allowApiKey', false);
    const extra: Record<string, string | undefined> = { KIRO_API_KEY: undefined };
    if (this.rec.effort) extra.CLAUDE_CODE_EFFORT_LEVEL = undefined;
    // KIRO_CLAUDE_FORCE_MODEL (08 KC-ENV-04: "all result.modelUsage keys are <forced>"): Claude
    // subagents must not pick their own model either (per-call `model` / agent `model`); both
    // variables are read by claude 2.1.318 (SUBAGENT_MODEL_FORCE ignores the per-call model).
    const forced = this.env.KIRO_CLAUDE_FORCE_MODEL?.trim();
    if (forced) {
      extra.CLAUDE_CODE_SUBAGENT_MODEL = forced;
      extra.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
    }
    const ts = toolSearchEnv(this.settings);
    if (ts !== undefined && this.env.ENABLE_TOOL_SEARCH === undefined) extra.ENABLE_TOOL_SEARCH = ts;
    return buildChildEnv(this.env, { allowApiKey, extra });
  }

  private handlers(): ClaudeHandlers {
    return {
      onHookCallback: async (req) => {
        const id = req.callback_id;
        const input = (isObj(req.input) ? req.input : {}) as typeof req.input;
        if (id === GATE_CALLBACK_IDS.pre) {
          const r = await this.gate.preToolUse(input);
          this.onPreDecision(r.call, r.decision);
          return r.output;
        }
        if ((id === GATE_CALLBACK_IDS.post || id === GATE_CALLBACK_IDS.postFail) && typeof input.tool_use_id === 'string' && typeof input.duration_ms === 'number') {
          this.durations.set(input.tool_use_id, input.duration_ms);
        }
        return this.gate.hookCallback(id, input);
      },
      onCanUseTool: async (req, ctx) => {
        const ac = new AbortController();
        const abort = (): void => ac.abort();
        if (ctx.signal.aborted) ac.abort();
        ctx.signal.addEventListener('abort', abort, { once: true });
        const turnSignal = this.turnAbort?.signal;
        if (turnSignal?.aborted) ac.abort();
        turnSignal?.addEventListener('abort', abort, { once: true });
        try {
          const r = await this.gate.canUseTool(req, (ar, sig) => this.ui.requestApproval(ar, sig), ac.signal);
          if (r.redirectText !== undefined && r.redirectText.trim() !== '') this.redirects.push(r.redirectText);
          return r.result;
        } finally {
          ctx.signal.removeEventListener('abort', abort);
          turnSignal?.removeEventListener('abort', abort);
        }
      },
      onOtherControlRequest: () => undefined,
    };
  }

  /** Spawn the child for `mode`, with the start-error fallbacks of the module doc. */
  private async spawn(mode: LaunchMode, attempt = 0): Promise<void> {
    this.reloadConfig();
    const launch = this.buildLaunchFor(mode);
    for (const w of launch.warnings) this.uiNotice('warn', w, true);
    let proc: ClaudeProcess;
    try {
      proc = await ClaudeProcess.start({
        binary: this.binary!,
        args: launch.args,
        cwd: this.ws.cwd,
        env: this.childEnv(),
        initialize: launch.initialize,
        handlers: this.handlers(),
        logger: { debug: (m) => log.debug(m), warn: (m) => log.warn(m) },
      });
    } catch (e) {
      const text = e instanceof ClaudeProcessError ? `${e.message}\n${e.stderr}` : errText(e);
      if (attempt < 2) {
        // a (re-)fork whose target id already has a transcript: Claude wrote the fork, resume it
        if ((mode.kind === 'new' || mode.kind === 'fork') && /already in use/i.test(text)) {
          log.debug(`session ${this.rec.claudeSessionId} already has a transcript; resuming it`);
          this.historyKnown = true;
          return this.spawn({ kind: 'resume' }, attempt + 1);
        }
        if ((mode.kind === 'resume' || mode.kind === 'fork') && /No conversation found/i.test(text)) {
          const history = journalHistoryText(readJournal(this.store.dir, this.rec.sessionId));
          if (mode.kind === 'fork') this.rec.claudeSessionId = this.rec.claudeSessionId || randomUUID();
          if (history) {
            this.pendingContext.push(restoredHistoryBlock(history));
            this.uiNotice('warn', 'Claude Code could not find the saved conversation; starting a new one with the saved history as context.');
          }
          this.historyKnown = false;
          return this.spawn({ kind: 'new' }, attempt + 1);
        }
      }
      throw e;
    }
    this.proc = proc;
    this.launch = launch;
    this.pendingFork = mode.kind === 'fork' ? mode : undefined;
    this.activator = new SteeringActivator(launch.conditionalSteering, this.ws, {
      expandRefs: (b, d) => expandFileRefs(b, d, this.ws, this.kiroIgnore),
    });
    if (mode.kind !== 'new') this.historyKnown = true;
    this.updateClaudeSessionId(launch.sessionId ?? this.rec.claudeSessionId);
    proc.on('frame', (f) => this.onFrame(f));
    proc.on('stderr', (chunk) => log.debug(`claude stderr: ${chunk.trimEnd()}`));
    proc.on('exit', (info) => {
      if (this.proc === proc && !this.closed) log.debug(`claude exited (code ${info.code}, signal ${info.signal})`);
    });
    const models = proc.initializeResponse.models;
    if (Array.isArray(models) && models.length) {
      this.liveModels = models;
      writeModelCache({ models }, this.env);
    }
  }

  /**
   * Where a new fork of the current conversation must start: the current Claude session, or,
   * while the current one is itself an unmaterialized fork, that fork's own source.
   */
  private forkSource(): { from: string; at?: string } {
    if (this.pendingFork) return { from: this.pendingFork.from, ...(this.pendingFork.at ? { at: this.pendingFork.at } : {}) };
    return { from: this.rec.claudeSessionId };
  }

  private defaultMode(): LaunchMode {
    if (this.pendingFork) return this.pendingFork;
    return this.historyKnown || this.rec.turns.length > 0 ? { kind: 'resume' } : { kind: 'new' };
  }

  private async closeProc(): Promise<void> {
    const p = this.proc;
    this.proc = undefined;
    if (!p) return;
    p.removeAllListeners('frame');
    try {
      await p.close();
    } catch {
      /* ignore */
    }
  }

  /** Close and respawn the child (config changed). No-op before start. */
  private async restart(opts: { sessionStart?: boolean; mode?: LaunchMode } = {}): Promise<void> {
    if (!this.startPromise) return;
    await this.startPromise;
    await this.closeProc();
    if (opts.sessionStart) await this.runSessionStartHooks();
    await this.spawn(opts.mode ?? this.defaultMode());
    this.persist();
  }

  private async ensureProcess(): Promise<void> {
    await this.start();
    if (this.proc && this.proc.running) return;
    if (this.proc) this.uiNotice('warn', 'Claude Code exited unexpectedly; restarting it.');
    await this.closeProc();
    await this.spawn(this.defaultMode());
    this.persist();
  }

  private async waitIdle(): Promise<void> {
    const proc = this.proc;
    if (!proc || !proc.busy) return;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        proc.off('frame', check);
        proc.off('exit', done);
        if (timer) clearTimeout(timer);
        resolve();
      };
      const check = (): void => {
        if (!proc.busy) done();
      };
      proc.on('frame', check);
      proc.on('exit', done);
      timer = setTimeout(done, WAIT_IDLE_MS);
    });
  }

  private assertIdle(what = 'this'): void {
    if (this.closed) throw new Error('The session is closed');
    if (this.turnBusy) throw new Error(`Cannot do ${what} while a turn is running`);
  }

  // ── notices / events / persistence ──

  private uiNotice(level: 'info' | 'warn' | 'error', message: string, once = false): void {
    if (once) {
      const key = `${level}\u0000${message}`;
      if (this.noticed.has(key)) return;
      this.noticed.add(key);
    }
    try {
      this.ui.notice(level, message);
    } catch {
      /* UI errors never break the session */
    }
  }

  private publish(ev: SessionEvent): void {
    // Internal local turns (`/effort`, `/clear`, the hidden tangent-summary turn) are silent:
    // only their side effects (new session id, notices, compaction, raw frames) are reported.
    if (this.turn?.kind === 'local' && SILENT_IN_LOCAL_TURNS.has(ev.type)) return;
    try {
      this.emit('event', ev);
    } catch (e) {
      log.debug(`session event listener threw: ${errText(e)}`);
    }
    this.sink?.push(ev);
  }

  private persist(): void {
    if (this.finalized) return;
    try {
      this.rec.trust = this.trustState;
      this.store.write(this.rec);
    } catch (e) {
      this.uiNotice('warn', `Failed to save the session index: ${errText(e)}`, true);
    }
  }

  /**
   * Track the Claude session id. `session_id` is published whenever the id the session talks to
   * changes — `/clear`, but also a tangent / rewind / copy fork and the return from a tangent,
   * whose ids are chosen before the spawn.
   */
  private updateClaudeSessionId(id: string): void {
    if (!id) return;
    if (id !== this.rec.claudeSessionId) {
      this.rec.claudeSessionId = id;
      this.persist();
    }
    if (id !== this.announcedClaudeId) {
      this.announcedClaudeId = id;
      this.publish({ type: 'session_id', claudeSessionId: id });
    }
  }

  // ── frame handling ──

  private onFrame(frame: ClaudeFrame): void {
    const f = frame as Record<string, unknown>;
    this.publish({ type: 'raw', frame });
    const t = this.turn;
    try {
      switch (f.type) {
        case 'system':
          this.onSystem(f, t);
          break;
        case 'stream_event':
          this.onStream(frame as StreamEventFrame, t);
          break;
        case 'assistant':
          this.onAssistant(frame as AssistantFrame, t);
          break;
        case 'user':
          this.onUser(frame as UserFrame, t);
          break;
        case 'result':
          this.onResult(frame as ResultFrame);
          break;
        case 'conversation_reset':
          if (typeof f.new_conversation_id === 'string') this.updateClaudeSessionId(f.new_conversation_id);
          break;
        case 'rate_limit_event':
          this.onRateLimit(frame as RateLimitFrame);
          break;
        default:
          break;
      }
    } catch (e) {
      log.warn(`failed to process a Claude frame: ${errText(e)}`);
    }
  }

  private onSystem(f: Record<string, unknown>, t: TurnState | undefined): void {
    switch (f.subtype) {
      case 'init': {
        if (typeof f.session_id === 'string') this.updateClaudeSessionId(f.session_id);
        const src = f.apiKeySource;
        if (!this.apiKeyWarned && typeof src === 'string' && src !== 'none') {
          this.apiKeyWarned = true;
          this.publish({
            type: 'notice',
            level: 'warn',
            message: `Claude Code is authenticating with ${src} (API billing), not your Claude subscription login.`,
          });
        }
        break;
      }
      case 'status':
        if (f.status === 'compacting' && !this.compacting) {
          this.compacting = true;
          this.publish({ type: 'compaction', state: 'started' });
        }
        break;
      case 'compact_boundary': {
        this.compacting = false;
        const md = isObj(f.compact_metadata) ? f.compact_metadata : {};
        this.publish({
          type: 'compaction',
          state: 'finished',
          ...(typeof md.pre_tokens === 'number' ? { preTokens: md.pre_tokens } : {}),
          ...(typeof md.post_tokens === 'number' ? { postTokens: md.post_tokens } : {}),
        });
        if (t) t.compactPending = true;
        break;
      }
      default:
        break;
    }
  }

  private onStream(f: StreamEventFrame, t: TurnState | undefined): void {
    if (f.parent_tool_use_id) return;
    const ev = f.event;
    // CLI-initiated (background) turns have no TurnState: dedupe their text with bgStream
    const st = t ?? this.bgStream;
    if (ev.type === 'message_start') {
      const id = isObj(ev.message) && typeof ev.message.id === 'string' ? ev.message.id : undefined;
      if (t) t.streamMsgId = id;
      else this.bgStream.streamMsgId = id;
      return;
    }
    if (ev.type !== 'content_block_delta' || !ev.delta) return;
    const msgId = st.streamMsgId;
    if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string' && ev.delta.text !== '') {
      if (msgId) st.streamed.add(msgId);
      this.publish({ type: 'text_delta', text: ev.delta.text, ...(msgId ? { messageId: msgId } : {}) });
    } else if (ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string' && ev.delta.thinking !== '') {
      if (t && msgId) t.streamedThinking.add(msgId);
      else if (!t && msgId) this.bgStream.streamed.add(`thinking:${msgId}`);
      this.publish({ type: 'thinking_delta', text: ev.delta.thinking });
    }
  }

  private flushAssistant(t: TurnState): void {
    if (t.curAssistant && t.curAssistant.content.length) {
      t.journal.push(assistantRecord(t.curAssistant.content, { messageId: t.curAssistant.id }));
      t.lastToolBatch = undefined;
    }
    t.curAssistant = undefined;
  }

  private onAssistant(f: AssistantFrame, t: TurnState | undefined): void {
    const content = Array.isArray(f.message?.content) ? f.message.content : [];
    const parent = f.parent_tool_use_id ?? null;
    for (const b of content) {
      if (isObj(b) && b.type === 'tool_use' && typeof b.id === 'string') {
        this.toolUses.set(b.id, { name: String(b.name ?? ''), input: isObj(b.input) ? b.input : {} });
      }
    }
    if (parent) return; // subagent output is not assistant text
    if (!t) {
      // background turn: still show its text (unless it was streamed already)
      const id = typeof f.message?.id === 'string' ? f.message.id : undefined;
      if (id && this.bgStream.streamed.has(id)) return;
      for (const b of content) if (isObj(b) && b.type === 'text' && typeof b.text === 'string' && b.text !== '') this.publish({ type: 'text', text: b.text });
      return;
    }
    if (typeof f.uuid === 'string') t.assistantUuid = f.uuid;
    if (f.error === 'authentication_failed') t.authError = true;
    const msgId = typeof f.message?.id === 'string' ? f.message.id : f.uuid ?? randomUUID();
    if (t.lastMsgId !== msgId) {
      t.lastMsgId = msgId;
      t.assistantText = '';
    }
    if (!t.curAssistant || t.curAssistant.id !== msgId) {
      this.flushAssistant(t);
      t.curAssistant = { id: msgId, content: [] };
    }
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        t.assistantText += b.text;
        if (b.text !== '') t.curAssistant.content.push({ kind: 'text', data: b.text });
        if (!t.streamed.has(msgId) && b.text !== '') this.publish({ type: 'text', text: b.text });
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        if (!t.streamedThinking.has(msgId) && b.thinking !== '') this.publish({ type: 'thinking_delta', text: b.thinking });
      } else if (b.type === 'tool_use' && typeof b.id === 'string') {
        t.curAssistant.content.push({ kind: 'toolUse', data: { toolUseId: b.id, name: String(b.name ?? ''), input: isObj(b.input) ? b.input : {} } });
      }
    }
  }

  private callForToolUse(id: string): KiroToolCall {
    const known = this.toolCalls.get(id);
    if (known) return known;
    const use = this.toolUses.get(id);
    const call = toKiroCall(use?.name ?? 'unknown', use?.input ?? {}, {
      cwd: this.ws.cwd,
      toolUseId: id,
      mcpServerNames: this.launch?.mcpNameMap ?? {},
    });
    this.toolCalls.set(id, call);
    return call;
  }

  private onPreDecision(call: KiroToolCall, decision: GateDecision): void {
    const id = call.toolUseId;
    if (id) this.toolCalls.set(id, call);
    if (decision.kind === 'deny') {
      const reasons = id ? this.policyReasons.get(id) : undefined;
      const reason = reasons && reasons.length ? deniedRulesText(call.v2Name, reasons) : decision.reason;
      if (id) {
        this.deniedIds.set(id, reason);
        this.announced.add(id);
      }
      this.publish({ type: 'tool_denied', ...(id ? { toolUseId: id } : {}), call, reason });
      return;
    }
    if (id && this.announced.has(id)) return;
    if (id) this.announced.add(id);
    this.announceStart(call, decision.kind === 'allow');
  }

  private announceStart(call: KiroToolCall, trusted: boolean): void {
    const id = call.toolUseId ?? '';
    this.publish({ type: 'tool_start', toolUseId: id, call, trusted });
    if (call.claudeName === 'Agent' || call.claudeName === 'Task') {
      const type = typeof call.input.subagent_type === 'string' && call.input.subagent_type ? call.input.subagent_type : 'general-purpose';
      const desc = typeof call.input.description === 'string' ? call.input.description : undefined;
      this.publish({ type: 'subagent', state: 'started', agentType: type, ...(desc ? { description: desc } : {}), ...(id ? { toolUseId: id } : {}) });
    }
  }

  private onUser(f: UserFrame, t: TurnState | undefined): void {
    if (t?.compactPending && f.isSynthetic === true) {
      const c = f.message?.content;
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.map((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
            : '';
      t.compactPending = false;
      t.compactSummary = text;
      this.flushAssistant(t);
      t.journal.push(compactionRecord(text));
      t.lastToolBatch = undefined;
      return;
    }
    const results = toolResults(f);
    if (results.length === 0) return;
    const topLevel = !f.parent_tool_use_id;
    if (t && topLevel) this.flushAssistant(t);
    const batch: { toolUseId: string; text: string; isError: boolean }[] = [];
    for (const b of results) {
      const id = b.tool_use_id;
      const isError = b.is_error === true;
      const text = toolResultText(b);
      if (topLevel) batch.push({ toolUseId: id, text, isError });
      if (this.deniedIds.has(id)) continue; // gate denial: tool_denied was emitted instead
      const call = this.callForToolUse(id);
      if (!this.announced.has(id)) {
        this.announced.add(id);
        this.announceStart(call, false);
      }
      const response = results.length === 1 ? f.tool_use_result : undefined;
      const duration = this.durations.get(id);
      this.publish({
        type: 'tool_end',
        toolUseId: id,
        call,
        isError,
        output: truncateChars(text, TOOL_OUTPUT_MAX_CHARS),
        ...(duration !== undefined ? { durationMs: duration } : {}),
        ...(response !== undefined ? { response } : {}),
      });
      if (!isError) this.trackTodos(call, response, text);
      if (call.claudeName === 'Agent' || call.claudeName === 'Task') {
        const type = typeof call.input.subagent_type === 'string' && call.input.subagent_type ? call.input.subagent_type : 'general-purpose';
        this.publish({ type: 'subagent', state: 'finished', agentType: type, toolUseId: id });
      }
    }
    if (t && batch.length) {
      const last = t.journal[t.journal.length - 1];
      if (t.lastToolBatch && last === t.lastToolBatch) {
        const rec = toolResultsRecord(batch);
        (t.lastToolBatch.data.content ??= []).push(...(rec.data.content ?? []));
      } else {
        const rec = toolResultsRecord(batch);
        t.journal.push(rec);
        t.lastToolBatch = rec;
      }
      // a steer is injected at the tool boundary: after these results (00 §8 C13, R6)
      if (t.pendingSteer.length) {
        t.journal.push(...t.pendingSteer.splice(0));
        t.lastToolBatch = undefined;
      }
    }
  }

  private trackTodos(call: KiroToolCall, response: unknown, text: string): void {
    if (!isTodoTool(call.claudeName)) return;
    const input = call.input;
    let changed = false;
    if (call.claudeName === 'TaskCreate') {
      let id: string | undefined;
      let subject = typeof input.subject === 'string' ? input.subject : '';
      if (isObj(response) && isObj(response.task)) {
        if (response.task.id !== undefined) id = String(response.task.id);
        if (typeof response.task.subject === 'string') subject = response.task.subject;
      }
      if (id === undefined) {
        const m = /#(\w+)/.exec(text);
        id = m ? m[1]! : String(this.todoMap.size + 1);
      }
      this.todoMap.set(id, { id, subject, status: 'pending' });
      changed = true;
    } else if (call.claudeName === 'TaskUpdate') {
      const id = input.taskId !== undefined ? String(input.taskId) : undefined;
      if (id !== undefined) {
        const cur = this.todoMap.get(id) ?? { id, subject: '', status: 'pending' as const };
        if (typeof input.subject === 'string') cur.subject = input.subject;
        const st = input.status;
        if (st === 'pending' || st === 'in_progress' || st === 'completed' || st === 'deleted') cur.status = st;
        if (cur.status === 'deleted') this.todoMap.delete(id);
        else this.todoMap.set(id, cur);
        changed = true;
      }
    }
    if (changed) this.publish({ type: 'todo_update', todos: this.todos() });
  }

  private onResult(f: ResultFrame): void {
    if (typeof f.total_cost_usd === 'number') this.sessionCostUsd = f.total_cost_usd;
    if (isObj(f.modelUsage)) {
      // modelUsage also lists subagent models: the session's window is the main model's
      // (system/init.model), else the largest one reported
      const mainModel = this.proc?.lastInit?.model;
      const windows: Record<string, number> = {};
      let main: number | undefined;
      let largest: number | undefined;
      for (const [m, u] of Object.entries(f.modelUsage)) {
        if (isObj(u) && typeof u.contextWindow === 'number' && u.contextWindow > 0) {
          windows[claudeToKiroModelId(m)] = u.contextWindow;
          if (m === mainModel) main = u.contextWindow;
          if (largest === undefined || u.contextWindow > largest) largest = u.contextWindow;
        }
      }
      if (main ?? largest) this.contextWindow = main ?? largest;
      if (Object.keys(windows).length) {
        if (this.model === AUTO_MODEL_ID && this.contextWindow) windows[AUTO_MODEL_ID] = this.contextWindow;
        writeModelCache({ contextWindows: windows }, this.env);
      }
    }
  }

  private onRateLimit(f: RateLimitFrame): void {
    const info = isObj(f.rate_limit_info) ? f.rate_limit_info : {};
    const status = typeof info.status === 'string' ? info.status : 'unknown';
    let utilization: number | undefined;
    let window: string | undefined = typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined;
    if (isObj(info.unifiedWindows)) {
      for (const [name, w] of Object.entries(info.unifiedWindows)) {
        if (isObj(w) && typeof w.utilization === 'number' && (utilization === undefined || w.utilization > utilization)) {
          utilization = w.utilization;
          window = name;
        }
      }
    }
    const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : undefined;
    this.lastRateLimit = { status, ...(resetsAt !== undefined ? { resetsAt } : {}), ...(utilization !== undefined ? { utilization } : {}), ...(window ? { window } : {}) };
    this.publish({ type: 'rate_limit', status, ...(resetsAt !== undefined ? { resetsAt } : {}), ...(utilization !== undefined ? { utilization } : {}) });
    if (status === 'rejected') {
      const when = resetsAt ? ` It resets at ${new Date(resetsAt * 1000).toISOString()}.` : '';
      this.publish({ type: 'notice', level: 'error', message: `Claude usage limit reached${window ? ` (${window})` : ''}.${when}` });
    }
  }

  private postToolSteering(call: KiroToolCall): string | undefined {
    if (call.capability !== 'fs_read' && call.capability !== 'fs_write') return undefined;
    const parts: string[] = [];
    for (const s of call.subjects) {
      const t = this.activator.forToolPath(path.resolve(call.cwd || this.ws.cwd, s));
      if (t) parts.push(t);
    }
    return parts.length ? parts.join('\n\n') : undefined;
  }

  // ── turns ──

  private newTurnState(kind: TurnState['kind'], userText: string): TurnState {
    return {
      kind,
      userText,
      userUuid: randomUUID(),
      assistantText: '',
      streamed: new Set(),
      streamedThinking: new Set(),
      authError: false,
      journal: [],
      compactPending: false,
      pendingSteer: [],
    };
  }

  private toTurnResult(t: TurnState, result: ResultFrame | undefined, failure: unknown, aborted: boolean): TurnResult {
    const denials = (result?.permission_denials ?? []).map((d) => {
      const call = typeof d.tool_use_id === 'string' ? this.toolCalls.get(d.tool_use_id) : undefined;
      const reason = typeof d.tool_use_id === 'string' ? this.deniedIds.get(d.tool_use_id) : undefined;
      return { toolName: call?.kiro2Name ?? String(d.tool_name ?? ''), ...(reason ? { reason } : {}) };
    });
    if (!result) {
      const stderr = failure instanceof ClaudeProcessError ? failure.stderr : '';
      const msg = failure ? errText(failure) : 'Claude Code ended the turn without a result';
      return {
        stopReason: aborted ? 'cancelled' : 'error',
        isError: !aborted,
        text: t.assistantText,
        ...(aborted ? {} : { error: stderr.trim() ? `${msg}\n${stderr.trim().split('\n').slice(-5).join('\n')}` : msg }),
        ...(t.authError || isAuthError(stderr) ? { authError: true } : {}),
        ...(this.rec.claudeSessionId ? { claudeSessionId: this.rec.claudeSessionId } : {}),
        permissionDenials: denials,
      };
    }
    const terminal = typeof result.terminal_reason === 'string' ? result.terminal_reason : '';
    const cancelled = aborted || result.synthetic === true || terminal === 'aborted_tools' || terminal === 'aborted_streaming' || terminal === 'cancelled';
    let stopReason: TurnResult['stopReason'];
    if (typeof result.local_command === 'string' && result.local_command) stopReason = 'local_command';
    else if (cancelled) stopReason = 'cancelled';
    else if (result.subtype === 'error_max_turns' || terminal === 'max_turns') stopReason = 'max_turns';
    else if (result.stop_reason === 'refusal') stopReason = 'refusal';
    else if (result.is_error) stopReason = 'error';
    else stopReason = 'end_turn';
    const authError = t.authError || isAuthError(result);
    const isError = result.is_error === true && stopReason !== 'cancelled';
    const text = typeof result.result === 'string' ? result.result : t.assistantText;
    const out: TurnResult = { stopReason, isError, text, permissionDenials: denials };
    if (isError) {
      const errs = Array.isArray(result.errors) ? result.errors.filter((e) => typeof e === 'string' && e.trim() !== '') : [];
      out.error = errs.length ? errs.join('\n') : text || terminal || 'Claude Code reported an error';
    }
    if (authError) out.authError = true;
    const u = result.usage;
    if (isObj(u)) {
      out.usage = {
        inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
        outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
        cacheReadTokens: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0,
        cacheCreationTokens: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0,
      };
    }
    if (typeof result.total_cost_usd === 'number') out.costUsd = result.total_cost_usd;
    const sid = typeof result.session_id === 'string' && result.session_id ? result.session_id : this.rec.claudeSessionId;
    if (sid) out.claudeSessionId = sid;
    if (typeof result.num_turns === 'number') out.numTurns = result.num_turns;
    if (typeof result.local_command === 'string' && result.local_command) out.localCommand = result.local_command;
    return out;
  }

  private recordTurn(t: TurnState, tr: TurnResult, wrote: { journal: boolean }): void {
    // after close() the lock is gone (another process may own the session): write nothing
    if (this.finalized) return;
    if (t.kind !== 'local') this.pendingFork = undefined;
    if (t.kind === 'prompt' && tr.stopReason !== 'local_command') {
      try {
        this.store.appendTurn(
          this.rec,
          { userUuid: t.userUuid, ...(t.assistantUuid ? { assistantUuid: t.assistantUuid } : {}), preview: t.userText, at: new Date().toISOString() },
          tr.text || t.userText,
        );
      } catch (e) {
        this.uiNotice('warn', `Failed to save the session index: ${errText(e)}`, true);
      }
      this.historyKnown = true;
      this.lastExchange = { user: t.userText, assistant: tr.text };
    } else {
      this.persist();
    }
    if (!wrote.journal && (t.kind === 'prompt' || t.kind === 'compact') && t.journal.length) {
      wrote.journal = true;
      try {
        appendJournal(this.store.dir, this.rec.sessionId, t.journal);
      } catch (e) {
        this.uiNotice('warn', `Failed to write the session journal: ${errText(e)}`, true);
      }
    }
  }

  /** One Claude turn: send `content`, stream mapped events, return the mapped result. */
  private async *runTurn(content: string | UserContentBlock[], kind: TurnState['kind'], userText: string, images?: { mediaType: string; dataBase64: string }[]): AsyncGenerator<SessionEvent, TurnResult> {
    await this.ensureProcess();
    if (this.pendingEffort && kind !== 'local') {
      const lvl = this.pendingEffort;
      this.pendingEffort = undefined;
      await this.runLocal(`/effort ${lvl}`).catch((e: unknown) => this.uiNotice('warn', `Failed to set effort: ${errText(e)}`));
    }
    await this.waitIdle();
    const proc = this.proc!;
    const t = this.newTurnState(kind, userText);
    if (kind === 'prompt') t.journal.push(promptRecord(userText, { ...(images?.length ? { images } : {}), messageId: t.userUuid }));
    const signal = this.turnAbort?.signal;
    let gen: AsyncGenerator<ClaudeFrame, ResultFrame>;
    try {
      gen = proc.turn(content, { uuid: t.userUuid, ...(signal ? { signal } : {}) });
    } catch (e) {
      return this.toTurnResult(t, undefined, e, signal?.aborted === true);
    }
    const sink = new EventSink();
    this.turn = t;
    this.sink = sink;
    let result: ResultFrame | undefined;
    let failure: unknown;
    const pump = (async (): Promise<void> => {
      try {
        for (;;) {
          const r = await gen.next();
          if (r.done) {
            result = r.value;
            return;
          }
        }
      } catch (e) {
        failure = e;
      } finally {
        sink.close();
      }
    })();
    const wrote = { journal: false };
    let tr: TurnResult | undefined;
    let finished = false;
    try {
      for await (const ev of sink.drain()) yield ev;
      await pump;
      finished = true;
    } finally {
      if (!finished) {
        // the consumer stopped iterating: stop the turn so the process stays usable
        try {
          await proc.interrupt();
        } catch {
          /* ignore */
        }
        await pump;
      }
      this.flushAssistant(t);
      if (t.pendingSteer.length) t.journal.push(...t.pendingSteer.splice(0));
      this.turn = undefined;
      this.sink = undefined;
      tr = this.toTurnResult(t, result, failure, signal?.aborted === true);
      if (result) this.recordTurn(t, tr, wrote);
      this.toolCalls.clear();
      this.toolUses.clear();
      this.announced.clear();
      this.deniedIds.clear();
      this.policyReasons.clear();
      this.durations.clear();
    }
    return tr!;
  }

  /** Run a local slash command (`/effort`, `/clear`) silently; returns its result. */
  private async runLocal(text: string): Promise<TurnResult> {
    const gen = this.runTurn(text, 'local', text);
    for (;;) {
      const r = await gen.next();
      if (r.done) return r.value;
    }
  }

  // ── turn composition ──

  /** `/name args` / `@name args` prompt files and `/<skill> args` (00 §2.2, §8 C4). */
  private expandInvocation(text: string): { text: string; images: { mediaType: string; dataBase64: string }[]; blocks: string[]; warnings: string[] } {
    const trimmed = text.trimStart();
    const res = { text, images: [] as { mediaType: string; dataBase64: string }[], blocks: [] as string[], warnings: [] as string[] };
    if (trimmed.startsWith('/')) {
      const inv = parsePromptInvocation(trimmed);
      if (!('error' in inv) && /^[A-Za-z0-9_-]+$/.test(inv.name)) {
        const p = findPrompt(this.prompts, inv.name);
        if (p) {
          res.text = expandPrompt(p, inv.args);
          return res;
        }
        const lower = inv.name.toLowerCase();
        const skill = this.launch?.skills.find((s) => s.name.toLowerCase() === lower || pluginSkillName(s.name) === lower);
        if (skill) {
          try {
            res.text = expandSkillInvocation(skill, inv.rawArgs);
          } catch (e) {
            res.warnings.push(`Failed to read skill ${skill.name}: ${errText(e)}`);
          }
          return res;
        }
      }
    }
    return res;
  }

  private async composeTurn(input: PromptInput, signal?: AbortSignal): Promise<{ content: string | UserContentBlock[]; userText: string; images: { mediaType: string; dataBase64: string }[] }> {
    const inv = this.expandInvocation(input.text);
    for (const w of inv.warnings) this.uiNotice('warn', w);
    let text = inv.text;
    // ACP clients (KiroCrew) send fully composed text — operating contract, memory, lessons,
    // replayed history — that must reach Claude verbatim (08 KC-ACP-06, 08a §4.4): no `@path` /
    // `#` provider expansion (an old `#git diff` or `@file` in replayed history must not run or
    // inline again) and no prompt-text steering activation. Prompt / skill invocations still expand.
    const verbatim = this.opts.origin === 'acp';
    let at: AtRefsResult = { text, blocks: [], images: [], warnings: [] };
    if (!verbatim) {
      // @prompt invocation (V2) and @file references
      at = expandAtRefs(text, { cwd: this.ws.cwd, prompts: this.prompts });
      if (at.promptExpansion) {
        const p = findPrompt(this.prompts, at.promptExpansion.name);
        if (p) text = expandPrompt(p, at.promptExpansion.args);
        at = expandAtRefs(text, { cwd: this.ws.cwd });
      }
    } else {
      const pm = /^@([A-Za-z0-9_-]{1,50})(?=\s|$)/.exec(text.trimStart());
      if (pm && findPrompt(this.prompts, pm[1]!)) {
        const r = expandAtRefs(text, { cwd: this.ws.cwd, prompts: this.prompts });
        const p = r.promptExpansion ? findPrompt(this.prompts, r.promptExpansion.name) : undefined;
        if (p && r.promptExpansion) text = expandPrompt(p, r.promptExpansion.args);
      }
    }
    for (const w of at.warnings) this.uiNotice('warn', w);
    if (this.queuedSteer.length) {
      text = [text, ...this.queuedSteer.splice(0)].filter((s) => s.trim() !== '').join('\n\n');
    }
    let hookOutputs: string[] = [];
    let hookPrompts: string[] = [];
    if (!input.skipPromptHooks) {
      try {
        const r = await this.hookRunner.runUserPromptSubmit({ ws: this.ws, sessionId: this.rec.sessionId, prompt: text, ...(signal ? { signal } : {}) });
        hookOutputs = r.outputs;
        hookPrompts = r.agentPrompts;
        for (const w of r.warnings) this.uiNotice('warn', w.message);
      } catch (e) {
        this.uiNotice('warn', `userPromptSubmit hooks failed: ${errText(e)}`);
      }
    }
    const hash: HashRefsResult = verbatim
      ? { blocks: [], steeringNames: [], notices: [] }
      : await expandHashRefs(text, {
          ws: this.ws,
          steering: this.launch?.steering ?? [],
          expandRefs: (b, d) => expandFileRefs(b, d, this.ws, this.kiroIgnore),
        });
    for (const n of hash.notices) this.uiNotice('info', n);
    const steeringBlocks = [
      ...this.activator.forNames(input.steeringRefs ?? []),
      ...this.activator.forNames(hash.steeringNames),
      ...(verbatim ? [] : this.activator.forPrompt(text)),
    ];
    const extraContext: string[] = [
      ...this.firstTurnPrompts.splice(0),
      ...this.pendingContext.splice(0),
      ...(this.rec.planMode ? [PLAN_MODE_BLOCK] : []),
      ...(input.extraContext ?? []),
    ];
    const images = [...(input.images ?? []), ...at.images.map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64 }))];
    const content = composeUserTurn({
      text,
      hookOutputs,
      agentPrompts: hookPrompts,
      steeringBlocks,
      refBlocks: [...at.blocks, ...hash.blocks],
      extraContext,
      images,
    });
    if (content === '' || (Array.isArray(content) && content.length === 0)) throw new Error('Cannot send an empty prompt');
    return { content, userText: input.text, images };
  }

  async *prompt(input: PromptInput, opts: { signal?: AbortSignal } = {}): AsyncGenerator<SessionEvent, TurnResult> {
    await this.start();
    this.assertIdle('a new prompt');
    this.turnBusy = true;
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    if (opts.signal?.aborted) abort.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    this.turnAbort = abort;
    this.redirects = [];
    try {
      let composed = await this.composeTurn(input, abort.signal);
      let res = yield* this.runTurn(composed.content, 'prompt', composed.userText, composed.images);
      let continuations = 0;
      for (;;) {
        if (abort.signal.aborted || this.closed) break;
        const redirect = this.redirects.shift();
        if (redirect !== undefined) {
          composed = await this.composeTurn({ text: redirect }, abort.signal);
          res = yield* this.runTurn(composed.content, 'prompt', composed.userText, composed.images);
          continuations = 0;
          continue;
        }
        if (res.stopReason !== 'end_turn') break;
        const cont = await this.runStopHooks(res.text, continuations, abort.signal);
        if (cont === undefined || abort.signal.aborted) break;
        continuations++;
        composed = await this.composeTurn({ text: cont, skipPromptHooks: true }, abort.signal);
        res = yield* this.runTurn(composed.content, 'prompt', composed.userText, composed.images);
      }
      return res;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      if (this.turnAbort === abort) this.turnAbort = undefined;
      this.turnBusy = false;
      this.redirects = [];
    }
  }

  /** Stop hooks after a normal turn end; returns continuation text or undefined. */
  private async runStopHooks(assistantText: string, continuations: number, signal: AbortSignal): Promise<string | undefined> {
    const ctx = { ws: this.ws, sessionId: this.rec.sessionId, assistantText, hookDrivenContinuations: continuations, signal };
    let r;
    try {
      r = await this.hookRunner.runStop(ctx);
    } catch (e) {
      this.uiNotice('warn', `stop hooks failed: ${errText(e)}`);
      return undefined;
    }
    for (const w of r.warnings) this.uiNotice('warn', w.message);
    const parts: string[] = [];
    if (r.continueWith) parts.push(r.continueWith);
    let confirm = r.confirm;
    let guard = 0;
    while (confirm && guard++ < 16 && !signal.aborted) {
      let choice: string | undefined;
      if (this.interactive && this.ui.confirmStopHook) {
        try {
          choice = await this.ui.confirmStopHook(confirm);
        } catch {
          choice = undefined;
        }
      }
      const next = await this.hookRunner.resolveStopConfirm(ctx, confirm.hook, choice);
      for (const w of next.warnings) this.uiNotice('warn', w.message);
      if (next.continueWith) parts.push(next.continueWith);
      confirm = next.confirm;
    }
    const text = [...new Set(parts)].join('\n\n');
    return text.trim() === '' ? undefined : text;
  }

  steer(text: string): void {
    if (text.trim() === '') return;
    const proc = this.proc;
    if (this.turn && this.turn.kind === 'prompt' && proc?.running && proc.busy) {
      try {
        const uuid = proc.sendUserMessage(text, { priority: 'next' });
        this.turn.pendingSteer.push(promptRecord(text, { messageId: uuid }));
        return;
      } catch (e) {
        log.debug(`steer failed, queueing: ${errText(e)}`);
      }
    }
    this.queuedSteer.push(text);
  }

  async interrupt(): Promise<void> {
    this.redirects = [];
    const ac = this.turnAbort;
    if (ac && !ac.signal.aborted) {
      ac.abort();
      return;
    }
    if (this.proc?.running && this.proc.busy) {
      try {
        await this.proc.interrupt();
      } catch {
        /* ignore */
      }
    }
  }

  // ── agents / models / effort ──

  async swapAgent(name: string): Promise<void> {
    await this.start();
    this.assertIdle('/agent swap');
    const r = loadAgents(this.ws, { settings: this.settings });
    const target = r.agents.get(name);
    if (!target) throw new AgentNotFoundError(name, r.failed.get(name)?.message);
    this.agents = r.agents;
    this.currentAgent = target;
    this.rec.agent = target.name;
    for (const w of target.warnings) this.uiNotice('warn', w.message, true);
    if (target.model && target.model.trim() !== '') {
      const m = kiroToClaudeModel(target.model, this.liveModels);
      if (m.error) this.uiNotice('warn', `${m.error} (from agent ${target.name}); keeping ${this.model}.`);
      else this.rec.model = target.model;
    }
    this.hookRunner = new HookRunner(allHooksFor(this.ws, target));
    this.todoMap.clear();
    await this.restart({ sessionStart: true });
  }

  async setModel(kiroModelId: string): Promise<void> {
    await this.start();
    const id = kiroModelId.trim();
    const m = kiroToClaudeModel(id, this.liveModels);
    if (m.error) throw new ModelNotFoundError(m.error);
    const entry = findModelEntry(buildModelList(this.liveModels), id);
    const kiroId = entry?.kiroId ?? (m.value === undefined ? AUTO_MODEL_ID : claudeToKiroModelId(id));
    const changed = kiroId !== this.rec.model;
    this.rec.model = kiroId;
    if (changed) this.contextWindow = undefined;
    if (this.env.KIRO_CLAUDE_FORCE_MODEL?.trim()) {
      if (!this.forceModelWarned) {
        this.forceModelWarned = true;
        log.warn(`KIRO_CLAUDE_FORCE_MODEL is set; model ${kiroId} is recorded but not applied`);
      }
      this.persist();
      return;
    }
    if (this.proc?.running) await this.proc.setModel(m.value ?? null);
    this.persist();
  }

  async setEffort(level: string): Promise<void> {
    await this.start();
    const l = level.trim().toLowerCase();
    if (!EFFORT_LEVELS.includes(l)) throw new Error(`Invalid effort level '${level}'. Valid levels: ${EFFORT_LEVELS.join(', ')}`);
    const entry = findModelEntry(await this.listModels(), this.model);
    if (entry && entry.supportedEffortLevels === null) throw new Error(`Model ${this.model} does not support effort levels`);
    if (entry && Array.isArray(entry.supportedEffortLevels) && !entry.supportedEffortLevels.includes(l)) {
      throw new Error(`Model ${this.model} does not support effort '${l}'. Supported: ${entry.supportedEffortLevels.join(', ')}`);
    }
    this.rec.effort = l;
    this.persist();
    if (this.turnBusy || !this.proc?.running) {
      this.pendingEffort = l;
      return;
    }
    const r = await this.runLocal(`/effort ${l}`);
    if (r.isError) throw new Error(r.error ?? `Failed to set effort to ${l}`);
  }

  async listModels(): Promise<ModelEntry[]> {
    const cache = readModelCache(this.env);
    const live = this.liveModels ?? cache?.models;
    return buildModelList(live && live.length ? live : undefined, cache?.contextWindows);
  }

  // ── context ──

  async addContext(globs: string[]): Promise<{ added: string[]; matched: Record<string, string[]> }> {
    this.assertIdle('/context add');
    const added: string[] = [];
    const matched: Record<string, string[]> = {};
    for (const raw of globs) {
      const g = raw.trim();
      if (!g) continue;
      matched[g] = expandFileSpec(g, this.ws).paths;
      if (this.rec.contextRules.some((r) => r.rule === g) || added.includes(g)) continue;
      added.push(g);
    }
    if (added.length) {
      for (const g of added) this.rec.contextRules.push({ rule: g, origin: 'session' });
      this.persist();
      await this.restart();
    }
    return { added, matched };
  }

  async removeContext(globs: string[]): Promise<string[]> {
    this.assertIdle('/context rm');
    const want = new Set(globs.map((g) => g.trim()).filter((g) => g !== ''));
    const removed = this.rec.contextRules.filter((r) => want.has(r.rule)).map((r) => r.rule);
    if (removed.length) {
      this.rec.contextRules = this.rec.contextRules.filter((r) => !want.has(r.rule));
      this.persist();
      await this.restart();
    }
    return removed;
  }

  async clearContext(): Promise<void> {
    this.assertIdle('/context clear');
    if (this.rec.contextRules.length === 0) return;
    this.rec.contextRules = [];
    this.persist();
    await this.restart();
  }

  async contextReport(): Promise<ContextReport> {
    await this.start();
    const l = this.launch;
    const sp = l?.systemPrompt;
    const tokensOf = new Map((sp?.included ?? []).map((f) => [f.path, f.tokens]));
    const group = (groups: { pattern: string; paths: string[] }[]): ContextReport['agentEntries'] =>
      groups.map((g) => ({ pattern: g.pattern, files: g.paths.filter((p) => tokensOf.has(p)).map((p) => ({ path: p, tokens: tokensOf.get(p)! })) }));
    const agentEntries = group(l?.resources ?? []);
    const agentsMd = (sp?.included ?? []).filter((f) => f.origin === 'agents-md');
    if (agentsMd.length) agentEntries.push({ pattern: 'AGENTS.md', files: agentsMd.map((f) => ({ path: f.path, tokens: f.tokens })) });
    const steering: ContextReport['steering'] = [];
    for (const f of sp?.included ?? []) if (f.origin === 'steering') steering.push({ path: f.path, inclusion: 'always', tokens: f.tokens });
    for (const f of l?.conditionalSteering ?? []) steering.push({ path: f.path, inclusion: f.inclusion, tokens: estimateTokens(f.body) });
    return {
      agentEntries,
      sessionEntries: group(l?.sessionContext ?? []),
      steering,
      hookOutputs: this.spawnOutputs.map((o) => ({ tokens: estimateTokens(o) })),
      droppedFiles: sp?.dropped ?? [],
      totalTokens: sp?.totalTokens ?? 0,
      contextWindowTokens: this.contextWindowGuess(),
    };
  }

  // ── conversation commands ──

  async clear(): Promise<void> {
    await this.start();
    this.assertIdle('/clear');
    this.turnBusy = true;
    try {
      const before = this.rec.claudeSessionId;
      const r = await this.runLocal('/clear');
      const sid = this.proc?.sessionId;
      if (sid && sid !== this.rec.claudeSessionId) this.updateClaudeSessionId(sid);
      if (r.isError && this.rec.claudeSessionId === before) throw new Error(r.error ?? 'Failed to clear the conversation');
    } finally {
      this.turnBusy = false;
    }
    this.rec.turns = [];
    this.todoMap.clear();
    this.activator.reset();
    this.lastExchange = undefined;
    this.historyKnown = false;
    this.pendingFork = undefined;
    try {
      appendJournal(this.store.dir, this.rec.sessionId, [compactionRecord('')]);
    } catch {
      /* best effort */
    }
    this.hookRunner.clearCache();
    const prev = JSON.stringify(this.spawnOutputs);
    await this.runSessionStartHooks();
    if (JSON.stringify(this.spawnOutputs) !== prev) await this.restart();
    this.persist();
  }

  async *compact(instructions?: string): AsyncGenerator<SessionEvent, TurnResult> {
    await this.start();
    this.assertIdle('/compact');
    this.turnBusy = true;
    const abort = new AbortController();
    this.turnAbort = abort;
    try {
      const text = instructions && instructions.trim() ? `/compact ${instructions.trim()}` : '/compact';
      return yield* this.runTurn(text, 'compact', text);
    } finally {
      if (this.turnAbort === abort) this.turnAbort = undefined;
      this.turnBusy = false;
    }
  }

  private forkRecord(kind: 'tangent' | 'rewind', extra: Partial<SessionRecord>): SessionRecord {
    const r = this.rec;
    const rec = this.store.create({
      origin: r.origin,
      cwd: r.cwd,
      agent: r.agent,
      model: r.model,
      ...(r.effort ? { effort: r.effort } : {}),
      claudeSessionId: randomUUID(),
      additionalDirectories: r.additionalDirectories,
      title: r.title,
      parentId: r.sessionId,
      forkKind: kind,
      contextRules: r.contextRules,
      planMode: r.planMode,
      lastPreview: r.lastPreview,
      ...extra,
    });
    rec.trust = this.trustState;
    return rec;
  }

  async enterTangent(name?: string): Promise<void> {
    await this.start();
    this.assertIdle('/tangent');
    if (this.rec.turns.length === 0 && !this.historyKnown) throw new Error("Can't branch an empty chat.");
    const parent = this.rec;
    const parentLock = this.lock;
    const src = this.forkSource();
    const tangent = this.forkRecord('tangent', {
      tangentName: name && name.trim() ? name.trim() : null,
      turns: parent.turns,
      messageCount: parent.messageCount,
    });
    let lock: SessionLock | undefined;
    try {
      lock = this.store.acquireLock(tangent.sessionId);
      copyJournal(this.store.dir, parent.sessionId, tangent.sessionId);
    } catch (e) {
      lock?.release();
      this.dropRecord(tangent.sessionId);
      throw e;
    }
    this.tangentStack.push({ rec: parent, lock: parentLock, ...(this.pendingFork ? { pendingFork: this.pendingFork } : {}) });
    this.rec = tangent;
    this.lock = lock;
    try {
      await this.restart({ mode: { kind: 'fork', ...src } });
    } catch (e) {
      // back to the parent; the tangent never started, so it leaves nothing behind
      this.tangentStack.pop();
      this.rec = parent;
      this.lock = parentLock;
      lock.release();
      this.dropRecord(tangent.sessionId);
      await this.restart().catch(() => undefined);
      throw e;
    }
  }

  async exitTangent(mode: 'discard' | 'tail' | 'merge'): Promise<void> {
    await this.start();
    this.assertIdle('/tangent');
    const top = this.tangentStack[this.tangentStack.length - 1];
    if (!top) {
      if (mode === 'tail') throw new Error('You need to be in tangent mode to use tail.');
      if (mode === 'merge') throw new Error('Already on the root session — nothing to merge into');
      throw new Error('Not in a tangent conversation.');
    }
    const tangent = this.rec;
    const ownTurns = tangent.turns.length - top.rec.turns.length;
    let carry: string | undefined;
    if (mode === 'merge') {
      if (ownTurns <= 0) throw new Error('Nothing to merge yet — this conversation has no findings of its own');
      this.turnBusy = true;
      let summary: TurnResult;
      try {
        const gen = this.runTurn(TANGENT_SUMMARY_PROMPT, 'local', TANGENT_SUMMARY_PROMPT);
        for (;;) {
          const r = await gen.next();
          if (r.done) {
            summary = r.value;
            break;
          }
        }
      } finally {
        this.turnBusy = false;
      }
      if (summary!.isError || !summary!.text.trim()) throw new Error(`Merge cancelled — ${summary!.error ?? 'the tangent produced no summary'}`);
      carry = `<tangent-summary${tangent.tangentName ? ` name="${tangent.tangentName}"` : ''}>\nSummary of a side conversation (tangent) the user had:\n${summary!.text.trim()}\n</tangent-summary>`;
    } else if (mode === 'tail' && ownTurns > 0 && this.lastExchange) {
      carry = `<tangent-tail${tangent.tangentName ? ` name="${tangent.tangentName}"` : ''}>\nThe last exchange of a side conversation (tangent) the user had:\nUser: ${this.lastExchange.user}\nAssistant: ${this.lastExchange.assistant}\n</tangent-tail>`;
    }
    this.persist();
    this.tangentStack.pop();
    const lock = this.lock;
    this.rec = top.rec;
    this.lock = top.lock;
    this.rec.trust = this.trustState;
    lock?.release();
    this.lastExchange = undefined;
    if (carry) this.pendingContext.push(carry);
    this.historyKnown = this.rec.turns.length > 0;
    this.pendingFork = top.pendingFork;
    await this.restart({ mode: top.pendingFork ?? (this.rec.turns.length > 0 ? { kind: 'resume' } : { kind: 'new' }) });
  }

  async rewind(turn: number): Promise<void> {
    await this.start();
    this.assertIdle('/rewind');
    const turns = this.rec.turns;
    if (!Number.isInteger(turn) || turn < 1 || turn > turns.length) {
      throw new Error(turns.length ? `Invalid turn ${turn}: choose 1-${turns.length}` : 'Nothing to rewind: this conversation has no turns');
    }
    const target = turns[turn - 1]!;
    if (!target.assistantUuid) throw new Error(`Turn ${turn} has no assistant message to rewind to`);
    const old = this.rec;
    const oldLock = this.lock;
    const src = this.forkSource();
    const rec = this.forkRecord('rewind', {
      turns: turns.slice(0, turn),
      messageCount: turn,
      tangentName: old.tangentName,
      lastPreview: target.preview,
    });
    let lock: SessionLock | undefined;
    try {
      lock = this.store.acquireLock(rec.sessionId);
      // cut before the next turn's Prompt (steer prompts and /clear markers do not shift it);
      // rewinding to the last turn drops trailing compactions (the fork's history is uncompacted)
      const next = turns[turn];
      if (next) copyJournal(this.store.dir, old.sessionId, rec.sessionId, { beforeMessageId: next.userUuid });
      else {
        const recs = readJournal(this.store.dir, old.sessionId);
        while (recs.length && recs[recs.length - 1]!.kind === 'Compaction') recs.pop();
        writeJournalRecords(this.store.dir, rec.sessionId, recs);
      }
    } catch (e) {
      lock?.release();
      this.dropRecord(rec.sessionId);
      throw e;
    }
    this.rec = rec;
    this.lock = lock;
    try {
      await this.restart({ mode: { kind: 'fork', from: src.from, at: target.assistantUuid } });
    } catch (e) {
      this.rec = old;
      this.lock = oldLock;
      lock.release();
      this.dropRecord(rec.sessionId);
      await this.restart().catch(() => undefined);
      throw e;
    }
    // the old session stays on disk untouched; it is no longer active here (unless it is a tangent parent)
    if (!this.tangentStack.some((s) => s.rec === old)) oldLock?.release();
    this.todoMap.clear();
  }

  // ── tools / trust ──

  toolListing(): ToolListingEntry[] {
    const init = this.proc?.lastInit;
    let names: string[];
    if (init && Array.isArray(init.tools)) names = init.tools.filter((n): n is string => typeof n === 'string');
    else {
      // no turn yet (ACP asks for `tools` right after session/new, 08 KC-ACP-05): built-ins from
      // the launch, MCP tools from the last mcp_status of this child
      names = [...(this.launch?.toolSelection.claudeTools ?? [])];
      if (this.mcpStatusTools && this.mcpStatusTools.proc === this.proc) names.push(...this.mcpStatusTools.names);
    }
    const order = [...BUILTIN_CLAUDE_TOOLS, SKILL_CLAUDE_TOOL];
    const rank = (n: string): number => {
      const c = n === 'Task' ? 'Agent' : n;
      const i = order.indexOf(c);
      return c.startsWith('mcp__') ? 10_000 : i >= 0 ? i : 1_000;
    };
    names = [...names].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
    const out: ToolListingEntry[] = [];
    const seen = new Set<string>();
    for (const raw of names) {
      const claudeName = raw === 'Task' ? 'Agent' : raw;
      if (claudeName === 'TaskStop' || claudeName === 'TaskOutput') continue;
      const call = toKiroCall(claudeName, {}, { cwd: this.ws.cwd, mcpServerNames: this.launch?.mcpNameMap ?? {} });
      const name = call.mcp ? `@${call.mcp.server}/${call.mcp.tool}` : call.kiro2Name;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        claudeName,
        source: call.mcp ? 'mcp' : 'builtin',
        ...(call.mcp ? { server: call.mcp.server } : {}),
        permission: this.gate.describeTool(call),
      });
    }
    return out;
  }

  trustTools(names: string[]): void {
    this.gate.trustTools(names);
    this.persist();
  }

  untrustTools(names: string[]): void {
    this.gate.untrustTools(names);
    this.persist();
  }

  setTrustAll(on: boolean): void {
    this.gate.setTrustAll(on);
    this.persist();
  }

  resetTrust(): void {
    this.gate.resetTrust();
    this.persist();
  }

  // ── info ──

  async usage(): Promise<UsageReport> {
    let cu: ContextUsage | undefined;
    if (this.proc?.running && !this.turnBusy) {
      try {
        cu = await this.proc.getContextUsage();
      } catch {
        cu = undefined;
      }
    }
    const report: UsageReport = { model: this.model };
    if (cu && typeof cu.totalTokens === 'number') report.contextTokens = cu.totalTokens;
    const win = cu && typeof cu.maxTokens === 'number' && cu.maxTokens > 0 ? cu.maxTokens : this.contextWindow;
    if (win) report.contextWindowTokens = win;
    if (cu && typeof cu.percentage === 'number') report.contextPercent = cu.percentage;
    if (cu && Array.isArray(cu.categories)) {
      report.categories = cu.categories.filter((c) => isObj(c) && typeof c.name === 'string').map((c) => ({ name: c.name, tokens: typeof c.tokens === 'number' ? c.tokens : 0 }));
    }
    if (this.sessionCostUsd !== undefined) report.sessionCostUsd = this.sessionCostUsd;
    if (this.lastRateLimit) report.rateLimit = { ...this.lastRateLimit };
    return report;
  }

  async mcpStatus(): Promise<McpStatusEntry[]> {
    await this.start();
    let st: McpStatus | undefined;
    if (this.proc?.running) {
      try {
        st = await this.proc.mcpStatus();
      } catch {
        st = undefined;
      }
    }
    const map = this.launch?.mcpNameMap ?? {};
    const out: McpStatusEntry[] = [];
    const seen = new Set<string>();
    if (st && this.proc) {
      const disallowed = new Set(this.launch?.toolSelection.disallowedTools ?? []);
      const names: string[] = [];
      for (const s of st.mcpServers ?? []) {
        if (!isObj(s) || typeof s.name !== 'string' || !Array.isArray(s.tools)) continue;
        for (const t of s.tools) {
          if (!isObj(t) || typeof t.name !== 'string' || t.name === '') continue;
          const full = t.name.startsWith('mcp__') ? t.name : `mcp__${s.name}__${claudeMcpName(t.name)}`;
          if (!disallowed.has(full)) names.push(full);
        }
      }
      this.mcpStatusTools = { proc: this.proc, names };
    }
    for (const s of st?.mcpServers ?? []) {
      if (!isObj(s) || typeof s.name !== 'string') continue;
      const name = Object.prototype.hasOwnProperty.call(map, s.name) ? map[s.name]! : s.name;
      seen.add(name);
      out.push({
        name,
        status: typeof s.status === 'string' ? s.status : 'unknown',
        ...(Array.isArray(s.tools) ? { toolCount: s.tools.length } : {}),
        ...(typeof s.error === 'string' ? { error: s.error } : {}),
      });
    }
    for (const s of this.launch?.mcpServers ?? []) if (!seen.has(s.name)) out.push({ name: s.name, status: st ? 'unknown' : 'pending' }), seen.add(s.name);
    for (const s of this.launch?.allMcpServers ?? []) if (s.disabled && !seen.has(s.name)) out.push({ name: s.name, status: 'disabled' }), seen.add(s.name);
    return out;
  }

  todos(): TodoItem[] {
    return [...this.todoMap.values()].map((t) => ({ ...t }));
  }

  hooks(): readonly KiroHook[] {
    return this.hookRunner.hooks;
  }

  async runManualHook(name: string): Promise<string> {
    const r = await this.hookRunner.runManual({ ws: this.ws, sessionId: this.rec.sessionId }, name);
    for (const w of r.warnings) this.uiNotice('warn', w.message);
    if (!r.found) throw new Error(`No manual hook named ${name}`);
    if (r.agentPrompt !== undefined) {
      this.pendingContext.push(r.agentPrompt);
      return r.agentPrompt;
    }
    return r.output ?? '';
  }

  // ── export / close ──

  async exportTo(p: string, force: boolean): Promise<string> {
    const abs = path.resolve(this.ws.cwd, p);
    if (!force && fs.existsSync(abs)) throw new Error(`File at ${p} already exists. To overwrite, use -f or --force`);
    const t = findTranscript(this.rec.claudeSessionId, { cwd: this.ws.cwd, env: this.env });
    let transcript = '';
    if (t) {
      try {
        transcript = fs.readFileSync(t, 'utf8');
      } catch {
        transcript = '';
      }
    }
    const data = {
      version: 1,
      kind: 'kiro-claude-export',
      exportedAt: new Date().toISOString(),
      session: { ...this.rec, trust: { ...this.trustState } },
      claudeTranscript: transcript,
      kiroJournal: readJournalText(this.store.dir, this.rec.sessionId),
    };
    writeFileAtomic(abs, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    return abs;
  }

  /** Release everything without SessionEnd hooks (failed creation). */
  private async abandon(): Promise<void> {
    this.closed = true;
    await this.closeProc();
    if (this.fresh && this.rec.turns.length === 0 && this.rec.messageCount === 0) this.dropRecord(this.rec.sessionId);
    this.finalized = true;
    this.lock?.release();
    this.lock = undefined;
    for (const s of this.tangentStack) s.lock?.release();
    this.tangentStack = [];
    this.cleanupRuntime();
  }

  /** Delete a record this session created and never used: index file, lock and journal. */
  private dropRecord(sid: string): void {
    try {
      this.store.delete(sid);
      fs.rmSync(journalPath(this.store.dir, sid), { force: true });
    } catch {
      /* ignore */
    }
  }

  private cleanupRuntime(): void {
    try {
      fs.rmSync(this.runtimeDirPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  close(): Promise<void> {
    // idempotent: concurrent callers all wait for the same shutdown
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.turnAbort?.abort();
    let started = false;
    try {
      if (this.startPromise) {
        await this.startPromise;
        started = true;
      }
    } catch {
      started = false;
    }
    if (started) {
      try {
        const r = await this.hookRunner.runSessionEnd({ ws: this.ws, sessionId: this.rec.sessionId });
        for (const w of r.warnings) this.uiNotice('warn', w.message);
      } catch (e) {
        this.uiNotice('warn', `SessionEnd hooks failed: ${errText(e)}`);
      }
    }
    await this.closeProc();
    const empty = this.rec.turns.length === 0 && this.rec.messageCount === 0 && this.rec.forkKind === 'main' && this.rec.origin !== 'acp';
    if (empty && this.tangentStack.length === 0) {
      // Q saves a conversation only after a reply: never leave an empty chat in the index
      this.dropRecord(this.rec.sessionId);
    } else {
      this.persist();
    }
    this.finalized = true;
    this.lock?.release();
    this.lock = undefined;
    for (const s of this.tangentStack) {
      try {
        this.store.write(s.rec);
      } catch {
        /* ignore */
      }
      s.lock?.release();
    }
    this.tangentStack = [];
    this.cleanupRuntime();
  }
}

// ───────────────────────────── entry points ─────────────────────────────

/** Create (or resume / fork) a session and start it (see module doc). */
export async function createSession(opts: KiroSessionOptions): Promise<KiroSession> {
  return KiroSessionImpl.create(opts);
}

/**
 * `/chat load <path>` (00 §2.5): read our export (`{version:1, kind:"kiro-claude-export",
 * session, claudeTranscript, kiroJournal}`; `<path>.json` is tried too), write the transcript
 * under a fresh Claude session id with every `sessionId` rewritten into
 * `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<cwd>/<uuid>.jsonl` and resume it (UNVERIFIED that
 * rewriting suffices; fallback: fork the original transcript when it still exists, else a
 * fresh session seeded with the exported journal as context). Trust is not carried over
 * (V3 behaviour); session context rules are.
 */
export async function importSessionExport(p: string, opts: Omit<KiroSessionOptions, 'resume' | 'fork'>): Promise<KiroSession> {
  const ws = opts.ws;
  const env = opts.env ?? ws.env;
  const abs = path.resolve(ws.cwd, p);
  let text: string | undefined;
  let lastErr: unknown;
  for (const candidate of abs.toLowerCase().endsWith('.json') ? [abs] : [abs, `${abs}.json`]) {
    try {
      text = fs.readFileSync(candidate, 'utf8');
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (text === undefined) throw new Error(`Failed to import from ${p}: ${errText(lastErr)}`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to import from ${p}: ${errText(e)}`);
  }
  if (!isObj(data) || data.kind !== 'kiro-claude-export' || !isObj(data.session)) {
    throw new Error(`Failed to import from ${p}: not a kiro-claude session export`);
  }
  const srcId = typeof data.session.sessionId === 'string' && data.session.sessionId ? data.session.sessionId : 'imported';
  const exported = fromDiskJson({ ...data.session, kind: SESSION_KIND }, srcId);
  if (!exported) throw new Error(`Failed to import from ${p}: malformed session record`);
  const transcript = typeof data.claudeTranscript === 'string' ? data.claudeTranscript : '';
  const journal = typeof data.kiroJournal === 'string' ? data.kiroJournal : '';
  const store = new SessionStore(sessionsDir(ws));
  const claudeId = randomUUID();
  let mode: LaunchMode;
  let keepTurns = true;
  let writtenTranscript: string | undefined;
  const pendingContext: string[] = [];
  if (transcript.trim() !== '') {
    const dest = transcriptPath(claudeId, ws.cwd, env);
    mkdirp(path.dirname(dest), 0o700);
    writeFileAtomic(dest, rewriteTranscriptSessionId(transcript, claudeId), { mode: 0o600 });
    writtenTranscript = dest;
    mode = { kind: 'resume' };
  } else if (UUID_RE.test(exported.claudeSessionId) && findTranscript(exported.claudeSessionId, { cwd: exported.cwd || ws.cwd, env })) {
    // (the id comes from an untrusted file: only a UUID may name a transcript path)
    mode = { kind: 'fork', from: exported.claudeSessionId };
  } else {
    mode = { kind: 'new' };
    keepTurns = false;
    const history = journalHistoryText(parseJournal(journal));
    if (history) pendingContext.push(restoredHistoryBlock(history));
  }
  const cleanup = (sid?: string): void => {
    try {
      if (sid) {
        store.delete(sid);
        fs.rmSync(journalPath(store.dir, sid), { force: true });
      }
      if (writtenTranscript) fs.rmSync(writtenTranscript, { force: true });
    } catch {
      /* best effort */
    }
  };
  let rec: SessionRecord;
  try {
    rec = store.create({
      origin: opts.origin,
      cwd: ws.cwd,
      agent: opts.agentName?.trim() || exported.agent,
      model: opts.model?.trim() || exported.model,
      ...(opts.effort?.trim() ? { effort: opts.effort.trim() } : exported.effort ? { effort: exported.effort } : {}),
      claudeSessionId: claudeId,
      title: exported.title,
      additionalDirectories: opts.additionalDirectories ?? exported.additionalDirectories,
      contextRules: exported.contextRules,
      lastPreview: exported.lastPreview,
      ...(keepTurns ? { turns: exported.turns, messageCount: exported.messageCount } : {}),
    });
  } catch (e) {
    cleanup();
    throw e;
  }
  if (journal.trim() !== '') {
    try {
      writeJournalText(store.dir, rec.sessionId, journal.endsWith('\n') ? journal : `${journal}\n`);
    } catch {
      /* best effort */
    }
  }
  try {
    return await KiroSessionImpl.create(
      { ...opts, ...(opts.agentName ? {} : { agentName: rec.agent }) },
      { rec, mode, ...(pendingContext.length ? { pendingContext } : {}) },
    );
  } catch (e) {
    // nothing of a failed import stays behind: index file, journal, re-keyed transcript
    cleanup(rec.sessionId);
    throw e;
  }
}
