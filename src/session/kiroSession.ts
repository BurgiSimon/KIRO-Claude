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
 *  - {@link createSession} resolves the session record (new / `resume` latest-for-cwd — never an
 *    ACP / KiroCrew session, store `latestResumable` — or by id / `fork` / import), the agent
 *    (`--agent` > saved agent > `chat.defaultAgent` > `kiro_default`; a missing `--agent` is
 *    fatal for non-interactive sessions, exit 4), the model (`--model` > saved > agent `model` >
 *    `chat.defaultModel` > `auto`; an invalid explicit id is fatal, others warn and fall back)
 *    and the effort (`--effort` > saved >
 *    `chat.modelDefaults.<model>.output_config.effort`), takes the session lock and starts. Any
 *    failure (lock, spawn, `initialize` timeout or error, auth) releases the lock, removes a
 *    record this call created and the runtime dir; ClaudeProcess kills a child it started.
 *  - {@link KiroSessionImpl.start}: SessionStart (agentSpawn) hooks run BEFORE the child is
 *    spawned; their outputs go into the system-prompt file, agent-action prompts are prepended
 *    to the first user turn. Then session/launch `buildLaunch` + `ClaudeProcess.start`. The hooks
 *    (also those `/clear` and `/agent swap` run again, BEFORE they change anything) are killed by
 *    `interrupt()`, `close()` and, for a start, the creator's start signal (startSignal.ts): the
 *    start, `/clear` or swap is then cancelled (`SessionStartCancelledError`) and nothing changed
 *    (K3). They run while the session is idle (`busy` false).
 *  - Respawns (agent swap, `/context` edits, `/clear` with changed hook output, tangent, rewind,
 *    a crashed child) always re-read the agents and pass `--resume` (or `--fork-session`) with
 *    `--system-prompt-snapshot off`. A session that never produced a transcript (also one that
 *    fell back to a fresh Claude session and has had no turn since, though its record carries
 *    turns) is restarted with `--session-id` instead (VERIFIED with claude 2.1.318: `--resume` of a session with no
 *    messages fails with `No conversation found`); each mode falls back to the other on the
 *    CLI's `already in use` / `No conversation found` start errors, and a lost transcript is
 *    replaced by the `<sid>.jsonl` journal as context (08a §4.2); so is a fork at a message the
 *    source transcript does not hold (`No message found with message.uuid`: a `/rewind` to a
 *    turn saved before such a fallback). A fork made by `create({ fork })` (a spec-phase session
 *    or continuation) gets a copy of its parent's journal, cut at a rewind point `at`, like a
 *    tangent / rewind does, so that fallback restores the parent's history (S1), and its record
 *    carries the parent's turns and message count, cut the same way (K1): `/tangent`, `/rewind N`
 *    and a reopen's pin see the conversation it continues (VERIFIED with claude 2.1.319: a
 *    `--fork-session` transcript keeps its source's message uuids, and a fork of it at one of them
 *    cuts there). Closed before anything of its own (a line of the user's sent to Claude, a
 *    tangent carry) it is dropped like an empty chat (no duplicate of its parent in the index); a
 *    line Claude dropped unread (S2) is nothing of its own.
 *
 * Tool calls: the gate (policy/gate) answers every PreToolUse `hook_callback`; that is also
 * where `tool_start` (with `trusted` = allowed without asking) or `tool_denied` is emitted, so
 * the UI shows the call before any approval prompt. `can_use_tool` → `gate.canUseTool` with
 * `ui.requestApproval` (serialized); a redirect answer queues its text as the next user turn,
 * run inside the same `prompt()` after the interrupted turn. Results (`user` tool_result
 * frames) emit `tool_end` (a gate-denied call gets no `tool_end`). An Agent call's `subagent`
 * `started` waits until the call may run (an asked call: its approval), and a call denied at the
 * prompt is no subagent at all. Todos are tracked from TaskCreate / TaskUpdate inputs and
 * results (00 §2.5 `/todos`).
 *
 * Turn text (00 §6.2): `/name args` / `@name args` prompt files (config/prompts), `/<skill> args`
 * inlined (config/skills), userPromptSubmit hooks, `@` and `#` references (context/refs),
 * conditional steering (context/userTurn SteeringActivator), pending context (first-turn hook
 * prompts; the restored history of a record whose transcript was lost, kept on that record
 * (`SessionRecord.pendingHistory`, G2: saved with it across a quit, copied into a tangent or a
 * `create({ fork })` of the whole conversation, R4 #1); a
 * tangent tail/merge carry queued on the record it returned into, `SessionRecord.pendingContext`,
 * copied into any fork of that record made before it spoke again: a tangent (F9), a spec-phase
 * session or continuation (G1)), the plan-mode block, then composeUserTurn. The restored history
 * and the carry leave their queue only once the line is written to Claude (so a session closed
 * before that saves the record with its carry, G5); first-turn prompts are given back when Claude
 * never gets the line (cancelled or failed before the send), and all of it when Claude dropped
 * the line before starting it, or when the child died with the line unread (no `started`, no
 * output, not in its transcript: S4). A dropped line is no turn (no turn record, no journal, S2).
 * A child that died since the last turn is respawned before a line is composed, and a line whose
 * child died while it was composed is composed again with the block that respawn's fallback
 * queued, so the restored history always goes with the line it is context for (R4 #6). While it
 * is pending, a `/effort` is queued for that line (only in that record) and a `/compact` has
 * nothing to compact (Claude's fresh session holds no message yet: it fails, below; one that
 * still compacted would summarize none of the conversation, so it journals no `Compaction`).
 * A local command Claude reports as failed (its synthetic assistant frame's
 * `local_command_outcome` `failed` under a result that says success; VERIFIED 2.1.319:
 * "Error: No messages to compact" for `/compact` of a session with no messages) is an error
 * TurnResult with that text as its error, published as no assistant text (r5 #8). So is a
 * `/compact` whose compaction Claude reports failed (`system/status` `compact_result: 'failed'`
 * under a result that says success; VERIFIED 2.1.319: "Not enough messages to compact." for a
 * session holding only local-command entries, e.g. after an `/effort` or a refused `/compact`),
 * and the session's compacting state ends with that status (the next compaction is reported
 * from its start).
 * `prompt()`'s result carries the usage of all its Claude turns (redirects, continuations).
 *
 * Streaming: `text_delta` / `thinking_delta` from `stream_event`s (top level only); a complete
 * `text` block is emitted only for messages that streamed no deltas (dedupe by message id).
 * Subagent text (frames with `parent_tool_use_id`) is never emitted as assistant text.
 *
 * After each turn ending normally, Stop hooks may request continuation turns (≤ 3, enforced by
 * the hook runner) and `confirm` pickers (`ui.confirmStopHook`); a continuation's (or redirect's)
 * answer starts a new paragraph (`\n\n` before its first text when text came last, so no front
 * end glues two answers together; the journal and TurnResult keep the real text). Every turn
 * updates the session index (`turns[]` with the last top-level assistant uuid, for `/rewind`)
 * and appends the KiroCrew journal (`Prompt` / `AssistantMessage` / `ToolResults` / `Compaction`).
 *
 * Diagnostics: configuration, hook and gate messages go to `ui.notice`; `notice` events carry
 * turn-scoped messages from Claude (API-key billing). A rate-limit rejection is the `rate_limit`
 * event alone (the front ends word it); an `authentication_failed` assistant frame publishes no
 * text (Claude's `/login` advice is no answer; `TurnResult.authError` makes the front ends print
 * Kiro's not-logged-in text). Every event is
 * yielded by the running `prompt()` / `compact()` generator AND emitted as `'event'`, except the
 * conversation events (text, tools, todos) of internal local turns (`/effort`, `/clear`, the
 * hidden tangent-summary turn), which are silent (their `session_id` / notices still go out).
 *
 * Review decisions (DECISION unless tagged):
 *  - ACP sessions (`origin: 'acp'`) send prompt text verbatim: no `@path` / `#` provider
 *    expansion and no prompt-text steering activation (08 KC-ACP-06, 08a §4.4); `/prompt`,
 *    `@prompt` and `/<skill>` invocations still expand.
 *  - A record copied under a new stem by someone else (KiroCrew peer transfer, 08a §4.2; see
 *    store `copiedFrom`) forks its Claude session on resume instead of sharing the transcript,
 *    at the copied record's last turn (`--resume-session-at`): the original may have run on.
 *  - Forks (tangent / rewind / copies) stay "pending" until a turn completes in them: a respawn
 *    before that re-forks the source rather than resuming an id Claude may not have written yet.
 *    The source is saved on the record (`pendingFork`), so a resume after a quit forks it again
 *    too (S3), at the record's own last turn when it names no point (the source, e.g. main after
 *    a quit inside a fresh tangent, may have been resumed and continued since; after a trailing
 *    `/compact`, at the compaction: `SessionTurnRecord.compactUuid`, r5 S2); `already in use`
 *    (VERIFIED 2.1.319: checked before the source) resumes the fork, a lost source or message
 *    falls back to the journal.
 *  - `/rewind N` forks at turn N's answer even when a `/compact` followed it (Kiro restores a
 *    turn's own history, not a later summary of it): Claude serves that uuid only when the
 *    compaction kept it verbatim (the last answer of a chat with two turns or more, VERIFIED
 *    2.1.319), else the journal cut at turn N is restored as history.
 *  - Rewind cuts the journal before the next turn's `Prompt` (by message id), so steers and
 *    `/clear` markers do not shift it.
 *  - `--trust-all-tools` is per invocation: resuming without it clears `trust.trustAll`.
 *  - `/clear` resets the message count with the turns (K4): the saved conversation is the cleared
 *    one, which has no messages (Q/Kiro save the current history). The record stays in the index
 *    (its journal holds what was cleared); only a record that never had a conversation is dropped.
 *  - Per-tool trust belongs to the agent it was granted under (Q `Agents`: the active agent's
 *    allowedTools); `/agent swap` and a resume with another `--agent` park it in
 *    `trust.byAgent` and restore the target's, so `/tools` and the gate show the active agent's.
 *    The agent is session state, not part of a tangent: a swap inside one also names the new
 *    agent on the records the tangent returns to (they share the trust object). So is plan mode
 *    (Kiro's plan mode is the planner agent): `/plan` on or off inside a tangent is saved at once
 *    on the records the tangent returns to, and leaving the tangent (`/tangent`, tail, merge, a
 *    `/spec new` leaving an empty one) keeps the state the user last set (r5 #0).
 *  - A respawn that finishes after `close()` closes its new child and fails ("The session is
 *    closed"): no child outlives its session (ACP terminate during `session/set_mode`).
 *  - `KIRO_CLAUDE_FORCE_MODEL` also pins Claude subagents (`CLAUDE_CODE_SUBAGENT_MODEL[_FORCE]`);
 *    `toolSearch.*` settings map to `ENABLE_TOOL_SEARCH` (08 KC-FS-05, see {@link toolSearchEnv}).
 *  - After `close()` nothing is written any more (the lock is released).
 *  - r5 S5: a `/tangent` from a conversation that fell back to a fresh Claude session and has had
 *    no turn since starts the tangent fresh with the restored history (nothing to fork), and the
 *    return starts the parent fresh again; the `/tangent merge` summary request carries the
 *    tangent's restored history when its transcript was lost; `/rewind` out of an untouched
 *    `create({ fork })` copy drops that copy (nothing pending of its own) only while its parent
 *    record still exists and holds every one of its turns (the rewind record then names that
 *    parent; a /spec continuation outlives its
 *    parent phase record: it is then the only record of the spec turns and is kept, r5 #2); a
 *    `set_model` Claude
 *    refuses (an error answer) leaves the model as it was, saved, while one that got no answer
 *    (the child died or was restarted, a timeout) keeps the user's choice for the next child; a local command line (`/effort`) Claude wrote into a pending
 *    fork ends its pending state (`forkSource()` is then the fork itself);
 *    a quit inside a tangent drops a main that never had a message (S4), and each tangent of it
 *    that never had a message either (r5 g1).
 *  - `/rewind N` to a turn a compaction followed falls back on the journal cut at turn N when
 *    Claude no longer serves that turn's answer; its warning says the conversation was compacted
 *    after that turn (r5 g2).
 *  - The `/tangent merge` summary request carries the tangent carries queued on the tangent's
 *    record (a nested tangent's merge or tail: part of its history), settled like a prompt line's
 *    (r5 #4). A `/tangent tail` carries the tangent's own last exchange: the one it had when a
 *    tangent nested in it was entered, after the return from that one; turn N's (from the
 *    journal) after a `/rewind N` inside it, never a turn rewound away. A carry queued on the
 *    tangent stays on its record with a tail, as with a plain `/tangent` (a reopen delivers it).
 *  - While kiro-claude dies of a forwarded fatal signal (claude/lifecycle `dyingSignal()`, r5 H2)
 *    a respawn starts nothing and says nothing: spawn() refuses before any launch file or warning,
 *    ensureProcess() prints no "restarting it", restart() closes the child and returns quietly
 *    (the mode is kept for the next line's child, should the session outlive the signal).
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
import { dyingSignal } from '../claude/lifecycle.js';
import { ClaudeControlError, ClaudeProcess, ClaudeProcessError, type ClaudeHandlers } from '../claude/process.js';
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
import { cloneTrust, deniedRulesText, Gate, GATE_CALLBACK_IDS } from '../policy/gate.js';
import { BUILTIN_CLAUDE_TOOLS, claudeMcpName, isTodoTool, SKILL_CLAUDE_TOOL, toKiroCall } from '../policy/toolmap.js';
import type {
  AgentSpawnHookResult,
  AgentTrust,
  ContextReport,
  GateDecision,
  KiroAgent,
  KiroHook,
  KiroSession,
  KiroSessionOptions,
  KiroToolCall,
  ManualHookRun,
  McpStatusEntry,
  ModelEntry,
  PermissionRule,
  PromptFile,
  PromptInput,
  SessionEvent,
  SessionRecord,
  SessionTrust,
  SessionTurnRecord,
  SessionUI,
  SettingsStore,
  TodoItem,
  ToolListingEntry,
  TurnResult,
  TurnUsage,
  UsageReport,
  WorkspaceContext,
} from '../types.js';
import { mkdirp, writeFileAtomic } from '../util/fsx.js';
import { log } from '../util/log.js';
import { runtimeDir as baseRuntimeDir } from '../util/paths.js';
import {
  appendJournal,
  assistantRecord,
  compactedAfterTurn,
  compactionRecord,
  copyJournal,
  copyJournalThroughTurn,
  journalHistoryText,
  journalPath,
  journalSize,
  parseJournal,
  promptRecord,
  readJournal,
  readJournalText,
  recordNeverUsed,
  toolResultsRecord,
  turnExchange,
  writeJournalText,
  type JournalBlock,
  type JournalRecord,
} from './kiroFiles.js';
import { buildLaunch, EFFORT_LEVELS, type LaunchResult } from './launch.js';
import { currentStartSignal, outsideStartSignal, SessionStartCancelledError } from './startSignal.js';
import { fromDiskJson, isClaudeUuid, SESSION_KIND, SessionStore, sessionsDir, type SessionLock } from './store.js';

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

/**
 * Local commands whose line Claude writes into the session's transcript (VERIFIED 2.1.319 as the
 * only line of a new session, of a resumed one and of a fork that had no line yet); `/clear` starts
 * a new session instead.
 */
const RECORDED_LOCAL_COMMANDS: ReadonlySet<string> = new Set(['effort', 'model', 'cost', 'usage', 'context', 'compact']);

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
  /** The message the compaction this turn ran kept verbatim (its `preserved_segment` tail). */
  compactKept?: { anchor: string; tail: string };
  /**
   * Where Claude resumes the compacted conversation of a `/compact` this turn ran: the message
   * the compaction kept verbatim, else its summary (recordTurn: `SessionTurnRecord.compactUuid`).
   */
  compactUuid?: string;
  /** Steer prompts sent mid-turn, journaled when Claude starts them (see onSteerLifecycle). */
  pendingSteer: JournalRecord[];
  /** The queued context this turn's line carries (composeTurn), settled by runTurn / close. */
  queued?: QueuedContext;
  /**
   * Claude showed it read this turn's line: its `command_lifecycle` `started` / `completed`, or
   * any other output while the turn ran (a `queued` alone is not reading it). Until then a child
   * that dies has not delivered what the line carries (S4).
   */
  lineSeen: boolean;
  /**
   * The text of a local command Claude reported as failed (its synthetic assistant frame's
   * `local_command_outcome.kind` `failed`, VERIFIED 2.1.319: `/compact` of a session with no
   * messages, "Error: No messages to compact", under a result that says success): the turn's
   * error (toTurnResult), never assistant text (r5 #8).
   */
  localCommandError?: string;
  /**
   * A `/compact` turn whose compaction Claude reported failed (`system/status`
   * `compact_result: 'failed'`): the synthetic frame with the reason that follows is not an
   * answer either (VERIFIED 2.1.319, "Not enough messages to compact.", r5 #8 verifier).
   */
  compactRefused?: boolean;
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

/**
 * Claude Code's own per-server MCP start-up limit when `MCP_TIMEOUT` is unset (VERIFIED in the
 * claude 2.1.319 binary: `MCP_TIMEOUT > 0 ? min(MCP_TIMEOUT, 2^31-1) : 30000`).
 */
const CLAUDE_MCP_TIMEOUT_DEFAULT_MS = 30_000;

/**
 * Kiro settings that map onto Claude Code environment variables (names VERIFIED in the claude
 * 2.1.318/2.1.319 binary): `chat.disableAutoCompaction` ⇒ `DISABLE_AUTO_COMPACT=1` (a manual
 * `/compact` keeps working, as in Kiro), the MCP start-up wait (ms) ⇒ `MCP_TIMEOUT` (ms) and
 * `api.timeout` (s) ⇒ `API_TIMEOUT_MS`. Only explicitly set values are passed — Kiro's defaults
 * (5 s MCP start-up) differ from Claude's — and a variable already in the environment wins.
 *
 * `MCP_TIMEOUT` is a hard per-server limit (a slower server is marked failed), so which Kiro
 * setting feeds it depends on the session (06 §2.5): a non-interactive run waits up to
 * `mcp.noInteractiveTimeout` and goes on without the servers still loading, so that value is
 * passed as is; in interactive (and ACP) sessions `mcp.initTimeout` only bounds how long Kiro
 * waits before the prompt while servers keep loading in the background (01 §5.8 "Servers
 * loading"), so it may raise Claude's own 30 s limit but never shorten it into a failure.
 */
export function claudeSettingsEnv(settings: Pick<SettingsStore, 'get'>, opts: { interactive?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const dac = settings.get('chat.disableAutoCompaction');
  if (dac === true || dac === 'true') out.DISABLE_AUTO_COMPACT = '1';
  const positive = (key: string): number | undefined => {
    const v = settings.get(key);
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const interactive = opts.interactive !== false;
  const mcp = positive(interactive ? 'mcp.initTimeout' : 'mcp.noInteractiveTimeout');
  if (mcp !== undefined && (!interactive || mcp > CLAUDE_MCP_TIMEOUT_DEFAULT_MS)) out.MCP_TIMEOUT = String(Math.round(mcp));
  const api = positive('api.timeout');
  if (api !== undefined) out.API_TIMEOUT_MS = String(Math.round(api * 1000));
  return out;
}

/** Token counts of two Claude turns added up (either may be missing). */
export function addTurnUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): TurnUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/**
 * The result of a prompt that ran `next` after `prev` (a redirect or Stop-hook continuation):
 * `next`'s answer, stop reason and (cumulative) cost, with the usage, `numTurns` and permission
 * denials of both (F6; ClaudeProcess `mergeResults` does the same for one CLI turn).
 */
export function mergeTurnResults(prev: TurnResult, next: TurnResult): TurnResult {
  const out: TurnResult = { ...next, permissionDenials: [...prev.permissionDenials, ...next.permissionDenials] };
  const usage = addTurnUsage(prev.usage, next.usage);
  if (usage) out.usage = usage;
  if (prev.numTurns !== undefined || next.numTurns !== undefined) out.numTurns = (prev.numTurns ?? 0) + (next.numTurns ?? 0);
  return out;
}

/**
 * Make `to` the agent the flat per-tool trust fields belong to (`/agent swap`, a resume with
 * another `--agent`): park `from`'s allowedTools / rules / revokedTools in `byAgent` and restore
 * `to`'s entry (empty when it never had one). Q keeps every agent in memory and `t`,
 * `/tools trust|untrust` and `--trust-tools` change the ACTIVE agent only; trust-all stays
 * session-wide (06 §1.1, §1.7). Mutates `t` in place: the gate holds a reference to it.
 */
export function switchAgentTrust(t: SessionTrust, from: string, to: string): void {
  if (from === to) return;
  const saved: Record<string, AgentTrust> = t.byAgent ?? {};
  const own = (n: string): boolean => Object.prototype.hasOwnProperty.call(saved, n);
  const cur: AgentTrust = { allowedTools: t.allowedTools, rules: t.rules, ...(t.revokedTools?.length ? { revokedTools: t.revokedTools } : {}) };
  if (cur.allowedTools.length || cur.rules.length || cur.revokedTools) {
    Object.defineProperty(saved, from, { value: cur, enumerable: true, writable: true, configurable: true });
  } else if (own(from)) delete saved[from];
  const next = own(to) ? saved[to] : undefined;
  if (own(to)) delete saved[to];
  t.allowedTools = next ? [...next.allowedTools] : [];
  t.rules = next ? next.rules.map((r) => ({ ...r })) : [];
  if (next?.revokedTools?.length) t.revokedTools = [...next.revokedTools];
  else delete t.revokedTools;
  if (Object.keys(saved).length) t.byAgent = saved;
  else delete t.byAgent;
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

/**
 * The turn of `turns` a fork at `at` ends with: the one whose assistant uuid `at` is (a rewind
 * point, a fork point), a turn cancelled before any answer whose user uuid `at` is (the point
 * {@link forkPointFor} pins such a last turn at, r4 #10: Claude keeps the history through that
 * line), or the turn a `/compact` followed whose pin `at` is (`compactUuid`, r5 S2: the compacted
 * conversation holds nothing after that turn). -1 when `at` is none of them.
 */
function forkCutIndex(turns: readonly SessionTurnRecord[], at: string): number {
  return turns.findIndex((t) => t.assistantUuid === at || t.compactUuid === at || (!isClaudeUuid(t.assistantUuid) && t.userUuid === at));
}

/**
 * The journal of a new fork of `parent`'s conversation (`KiroSessionOptions.fork`, S1): all of it,
 * or, for a fork at a rewind point (`at` = a turn's assistant uuid; {@link forkCutIndex}), the
 * records up to that turn. An `at` that is none of the parent's turns copies nothing: the cut is
 * unknown, and rewound turns must not come back as history (G2).
 */
function copyForkJournal(dir: string, parent: SessionRecord, toSid: string, at: string | undefined): void {
  if (at === undefined) {
    if (journalSize(dir, parent.sessionId) > 0) copyJournal(dir, parent.sessionId, toSid);
    return;
  }
  const i = forkCutIndex(parent.turns, at);
  if (i >= 0) copyJournalThroughTurn(dir, parent.sessionId, toSid, parent.turns, i);
}

/**
 * The history a new fork of `parent`'s conversation carries on its record
 * (`KiroSessionOptions.fork`, K1), as a tangent / rewind record does: all its turns and its
 * message count, or, for a fork at a rewind point (`at` = a turn's assistant uuid; {@link
 * forkCutIndex}), the turns up to that one. An `at` that is none of the parent's turns carries
 * none, like the journal copy ({@link copyForkJournal}): the cut is unknown, and rewound turns must
 * not come back.
 */
function forkHistory(parent: SessionRecord, at: string | undefined): Pick<SessionRecord, 'turns' | 'messageCount' | 'lastPreview'> | undefined {
  if (at === undefined) return { turns: parent.turns, messageCount: parent.messageCount, lastPreview: parent.lastPreview };
  const i = forkCutIndex(parent.turns, at);
  if (i < 0) return undefined;
  return { turns: parent.turns.slice(0, i + 1), messageCount: i + 1, lastPreview: parent.turns[i]!.preview };
}

/**
 * Where a fork of a SAVED record's conversation starts when the record does not name a point (a
 * pending fork resumed after a quit, S3; a transferred copy, 08a §4.2; an import without a
 * transcript, K2): its own last turn's assistant message. Its source can have been resumed and
 * continued since (main after a quit inside a fresh tangent; the original of a copy, which
 * KiroCrew copied record and journal of at one moment, may have run on or be mid-turn; the
 * session an export was made of): a fork of the whole source would lend it those later turns, so
 * a record with turns never forks it (r4 #10). A last turn cancelled before any answer (ACP
 * `session/cancel`: the turn has only its user line) is pinned at that line, whose uuid Claude
 * stamps on its user entry; a fork at a user entry keeps the history through that unanswered line
 * (both VERIFIED 2.1.319); else at the newest earlier answer. A record whose
 * history ends with a `/compact` is pinned where Claude resumes the compacted conversation (the
 * last turn's `compactUuid`: the message the compaction kept verbatim, else its summary, r5 S2):
 * Claude loads a transcript from its last compact boundary and refuses an older uuid it did not
 * keep (`No message found`, VERIFIED 2.1.319), so a pin at the turn itself would fall back on the
 * journal; at the compaction it is a fork of the conversation as saved. A source that has been
 * compacted again since refuses that pin too: the journal fallback, never the later turns.
 * Undefined (the whole source) only for a record with no turn holding a UUID (an argv value from
 * a copied file must be one). A source that does not hold the message (Claude: `No message
 * found`) falls back on the journal (spawn).
 */
function forkPointFor(turns: readonly SessionTurnRecord[]): string | undefined {
  const last = turns[turns.length - 1];
  if (!last) return undefined;
  if (isClaudeUuid(last.compactUuid)) return last.compactUuid;
  if (isClaudeUuid(last.assistantUuid)) return last.assistantUuid;
  if (isClaudeUuid(last.userUuid)) return last.userUuid;
  for (let i = turns.length - 2; i >= 0; i--) {
    const at = turns[i]!.assistantUuid;
    if (isClaudeUuid(at)) return at;
  }
  return undefined;
}

/** {@link forkPointFor} of a record in the session index. */
function recordForkPoint(rec: SessionRecord): string | undefined {
  return forkPointFor(rec.turns);
}

/**
 * A frame that shows Claude is working on (or answered) the running turn's line `uuid`: anything
 * but a `command_lifecycle` of another line that is not a `started` (the previous line's late
 * `completed`), or this line's own `queued` / `cancelled`.
 */
function lineActivity(f: Record<string, unknown>, uuid: string): boolean {
  if (f.type !== 'command_lifecycle') return true;
  if (f.command_uuid === uuid) return f.state !== 'queued' && f.state !== 'cancelled';
  return f.state === 'started';
}

/**
 * The user line `uuid` is part of the Claude conversation `claudeSessionId`: its transcript holds
 * a `user` entry with that uuid (Claude stamps the uuid the host sent, VERIFIED 2.1.319). An
 * unreadable transcript counts as holding it (never deliver its context twice).
 */
function lineInTranscript(claudeSessionId: string, uuid: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  const file = claudeSessionId ? findTranscript(claudeSessionId, { cwd, env }) : undefined;
  if (!file) return false;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return true;
  }
  for (const line of text.split('\n')) {
    if (!line.includes(uuid)) continue;
    try {
      const o = JSON.parse(line) as unknown;
      if (isObj(o) && o.type === 'user' && o.uuid === uuid) return true;
    } catch {
      /* a torn last line */
    }
  }
  return false;
}

/** A record created by a failed start: its index file and journal (never a lock it does not hold). */
function removeRecordFiles(store: SessionStore, sid: string): void {
  try {
    store.delete(sid);
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(journalPath(store.dir, sid), { force: true });
  } catch {
    /* ignore */
  }
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
      // SessionOptions.claudePath / kiroClaude.claudePath rank below $KIRO_CLAUDE_BIN (claude/binary.ts, 08 KC-ENV-05).
      const binary = await findClaudeBinary({ ...(explicitPath ? { settingPath: explicitPath } : {}), env });
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
  /** Time the `claude` child gets to answer `initialize` (ClaudeProcess default 60 s). */
  initializeTimeoutMs?: number;
  /**
   * Cancels this session's start (session/startSignal.ts, K3): its agentSpawn hooks are killed and
   * the creation rejects with `SessionStartCancelledError`, leaving nothing behind. Defaults to
   * the signal of an enclosing `withStartSignal`.
   */
  startSignal?: AbortSignal;
}

interface Preset {
  /** The record to open (its `pendingHistory`: an import without a usable transcript). */
  rec: SessionRecord;
  mode: LaunchMode;
}

/** The queued context one composed user line carries (composeTurn → runTurn). */
interface QueuedContext {
  /**
   * Right before the line is written (the child is up): the line composed again when the record's
   * pending restored history is no longer the one it carries (the child died while the line was
   * composed and its respawn fell back to a fresh Claude session, R4 #6); undefined otherwise.
   * `sent` / `unsent` then settle the block the new line carries.
   */
  recompose(): string | UserContentBlock[] | undefined;
  /** The line was written to Claude: the context it carries leaves its queues. */
  sent(): void;
  /** Claude never got the line, or dropped it before starting it: the context is queued again. */
  unsent(): void;
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
  /**
   * The records a tangent returns into; `fresh`: that one's Claude session had fallen back to a
   * fresh session with no turn since (`claudeNew`), so the return starts it fresh again (r5 S5);
   * `lastExchange`: that one's last exchange, which a `/tangent tail` of it carries after the
   * return from a tangent nested in it (r5 verifier).
   */
  private tangentStack: {
    rec: SessionRecord;
    lock: SessionLock | undefined;
    pendingFork?: Extract<LaunchMode, { kind: 'fork' }>;
    fresh?: true;
    lastExchange?: { user: string; assistant: string };
  }[] = [];
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
  /**
   * The live Claude session was started as a new conversation (`--session-id`) and has had no
   * completed turn: Claude has no transcript of it yet, so a respawn starts it new again, also
   * when the record carries turns (a fork or import that fell back to its journal: K1, K2); a
   * `--resume` of it would fail and fall back a second time.
   */
  private claudeNew = false;

  private spawnOutputs: string[] = [];
  private firstTurnPrompts: string[] = [];
  // A record whose Claude transcript is gone (a resume / fork fell back to a fresh Claude session,
  // an import without a usable transcript) sends its saved history with its next line: the
  // `<kiro-restored-history>` block is kept on the record (`SessionRecord.pendingHistory`, saved
  // with it, R4 #1) until that line is written. It belongs to that record's conversation (G2):
  // `/clear` drops it, a tangent / `create({ fork })` of the whole conversation gets a copy (a
  // fork at a rewind point never: its own fallback cuts the journal), a respawn's fallback for the
  // same record keeps it (one copy).
  private queuedSteer: string[] = [];
  private redirects: string[] = [];
  /**
   * A `/effort` level setEffort queued for the next prompt line, and the record it was set in: a
   * record left since (a tangent, a rewind, its parent) never gets it (its child starts with its
   * own saved `--effort`), so a tangent's level stays the tangent's.
   */
  private pendingEffort: { rec: SessionRecord; level: string } | undefined;

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
  /** The launch mode a restart() during a fatal signal did not start (restart, r5 H2). */
  private deferredMode: LaunchMode | undefined;
  /** While `/rewind N` forks: N, when a compaction followed turn N (the fallback's warning, r5 g2). */
  private rewindCompacted: number | undefined;
  private turnBusy = false;
  /**
   * The record `create({ fork })` made (a spec-phase session or continuation) while it has nothing
   * of its own: a copy of its parent's conversation, turns included (K1). Closed like that it is
   * dropped like an empty chat, so the index never holds a duplicate of the parent. A user line
   * sent to Claude (also one never answered: the REPL's forced stop re-creates the session from
   * this record) or a tangent carry merged into it ends that; a line Claude drops unread (S2)
   * does not.
   */
  private untouchedFork: SessionRecord | undefined;
  /** close() dropped the record (unusedRecord); `copyOf`: the parent of an untouched copy ({@link resumeId}). */
  private droppedOnClose: { copyOf: string | undefined } | undefined;
  /** SessionStart (agentSpawn) hooks in flight: interrupt() / close() abort them (K3). */
  private hookAbort: AbortController | undefined;
  /** The creator's start signal (startSignal.ts): cancels the start only. */
  private readonly startSignal: AbortSignal | undefined;
  /**
   * Paragraph break between the answers of one `prompt()` (a Stop-hook continuation or redirect
   * turn): `tail` = the end of the assistant text published since the last tool event, `pending`
   * = the next text starts a new turn's answer. Set only while `prompt()` runs.
   */
  private textJoin: { tail: string; pending: boolean } | undefined;
  private turn: TurnState | undefined;
  private sink: EventSink | undefined;
  private turnAbort: AbortController | undefined;

  private readonly todoMap = new Map<string, TodoItem>();
  private readonly toolCalls = new Map<string, KiroToolCall>();
  private readonly toolUses = new Map<string, { name: string; input: Record<string, unknown> }>();
  private readonly announced = new Set<string>();
  /** `subagent` `started` of Agent calls awaiting approval, by tool_use_id (announceStart). */
  private readonly heldSubagents = new Map<string, SessionEvent>();
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
    /** The record was created by this call (deleted again if starting fails). */
    fresh?: boolean;
    /** `rec` is a fork `create({ fork })` made ({@link untouchedFork}). */
    forkCopy?: boolean;
    startSignal?: AbortSignal;
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
    if (init.forkCopy) this.untouchedFork = init.rec;
    this.startSignal = init.startSignal;
    this.historyKnown = init.mode.kind !== 'new';
    // KiroSessionOptions.initialTrust: the trust of the chat this session continues, as the chat
    // has it (a /spec phase, continuation or task session, the forced-stop restart), replaces the
    // record's own and the launch flags' (applied below otherwise); per-tool trust is the agent's
    if (opts.initialTrust) {
      const t = cloneTrust(opts.initialTrust.trust);
      switchAgentTrust(t, opts.initialTrust.agent ?? this.currentAgent.name, this.currentAgent.name);
      this.rec.trust = t;
    }
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
      mcpAutoApprove: (server, claudeTool) => {
        // the server that actually runs the call (by its Claude name), else the configured one
        const own = this.launch?.mcpAutoApprove;
        if (own && claudeTool?.startsWith('mcp__')) {
          let best: string | undefined;
          for (const c of Object.keys(own)) if (claudeTool.startsWith(`mcp__${c}__`) && (best === undefined || c.length > best.length)) best = c;
          if (best !== undefined) return own[best]!;
        }
        return this.launch?.allMcpServers.find((s) => s.name === server)?.autoApprove ?? [];
      },
      isIgnored: (p) => this.kiroIgnore.isIgnored(p),
      planMode: () => this.rec.planMode,
      specPhase: () => this.opts.specPhase,
      onPostToolContext: (call) => this.postToolSteering(call),
      notify: (level, msg) => this.uiNotice(level, msg),
      onDenied: (call, reasons) => {
        if (call.toolUseId) this.policyReasons.set(call.toolUseId, reasons);
      },
    });
    if (!opts.initialTrust) {
      if (opts.trustAllTools) this.gate.setTrustAll(true);
      if (opts.trustTools?.length) this.gate.trustTools(opts.trustTools);
    }
  }

  // ── construction ──

  /** Resolve record, agent, model and effort, take the lock and start (see module doc). */
  static create(opts: KiroSessionInternalOptions, preset?: Preset): Promise<KiroSessionImpl> {
    // the creator's start signal (startSignal.ts), read once: nothing of the session runs inside it
    const startSignal = opts.startSignal ?? currentStartSignal();
    return outsideStartSignal(() => KiroSessionImpl.build(opts, preset, startSignal));
  }

  private static async build(opts: KiroSessionInternalOptions, preset: Preset | undefined, startSignal: AbortSignal | undefined): Promise<KiroSessionImpl> {
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
        // the user's own latest chat: never a KiroCrew / ACP-client session (store doc)
        rec = store.latestResumable(ws.cwd);
        if (!rec) notices.push({ level: 'info', message: NO_SAVED_SESSIONS });
      } else {
        rec = store.read(opts.resume.sessionId);
        if (!rec) throw new SessionNotFoundError(opts.resume.sessionId);
      }
      if (rec) {
        // a fork that never completed a turn (S3): its own Claude id may have no transcript yet
        // (Claude writes a fork's transcript with its first message), so fork its source again;
        // `already in use` (Claude did write it) resumes it, a lost source falls back (spawn); at
        // the record's own last turn, not wherever the source has moved since (recordForkPoint)
        if (rec.pendingFork) {
          const at = rec.pendingFork.at ?? recordForkPoint(rec);
          mode = { kind: 'fork', from: rec.pendingFork.from, ...(at ? { at } : {}) };
        } else mode = rec.turns.length > 0 || rec.messageCount > 0 ? { kind: 'resume' } : { kind: 'new' };
      }
    }
    // A record copied under a new id by someone else (KiroCrew peer transfer, 08a §4.2) still
    // names the original's Claude session: fork it (or start fresh) so the two never share one
    // Claude transcript. Persisted only once the child is up (as every saved record), so a failed
    // start changes nothing.
    if (rec && !preset && store.copiedFrom(rec.sessionId) !== undefined) {
      const from = rec.claudeSessionId;
      rec.claudeSessionId = randomUUID();
      // at the copied record's last turn: the original may have run on since it was copied
      if (mode.kind === 'resume') {
        const at = recordForkPoint(rec);
        mode = { kind: 'fork', from, ...(at ? { at } : {}) };
      }
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
    let forkParent: SessionRecord | undefined;
    if (!preset && opts.fork) {
      const parent = opts.fork.parentId ? store.read(opts.fork.parentId) : undefined;
      forkParent = parent;
      // the parent's conversation is this fork's history: its record carries the parent's turns
      // (K1), consistent with the journal copy below, so `/tangent`, `/rewind N` and the pin of a
      // pending fork reopened after a quit (recordForkPoint) see them
      const carried = parent ? forkHistory(parent, opts.fork.at) : undefined;
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
        ...(carried ?? {}),
        // a carry merged into the parent is part of its history (01 §5.11, 06 §6.4) but not yet
        // of its Claude transcript: this fork (a spec phase / continuation, SpecSessionDriver)
        // gets its own copy, like a tangent (F9); the parent keeps its copy, delivered once (G1)
        ...(parent?.pendingContext?.length ? { pendingContext: [...parent.pendingContext] } : {}),
        // so is the parent's restored history still waiting for its next line (R4 #1): the fork
        // source may have a transcript by now that lacks it (Claude writes a fresh session's
        // transcript for a local command), so the fork succeeds without a fallback; a fork that
        // falls back keeps this copy (one block). Not for a fork at a rewind point (an `at` other
        // than the parent's own fork point): the history runs past it, and that fork's fallback
        // restores its own cut journal (G2)
        ...(parent?.pendingHistory !== undefined && (opts.fork.at === undefined || opts.fork.at === parent.pendingFork?.at) ? { pendingHistory: parent.pendingHistory } : {}),
      });
      mode = { kind: 'fork', from: opts.fork.fromClaudeSessionId, ...(opts.fork.at ? { at: opts.fork.at } : {}) };
    }

    let lock: SessionLock | undefined;
    let fresh = !!preset || (!!opts.fork && !preset);
    const created = !rec;
    if (!rec) {
      rec = store.create({
        origin: opts.origin,
        cwd: ws.cwd,
        agent: agent.name,
        model,
        ...(effort ? { effort } : {}),
        additionalDirectories: opts.additionalDirectories ?? [],
      });
      fresh = true;
    }
    try {
      lock = store.acquireLock(rec.sessionId);
      // the parent's journal is this fork's history too, as for a tangent / rewind (S1): when the
      // fork source has no transcript (the parent fell back to a fresh Claude session and has not
      // spoken since, or it is gone) the fork restores it from here (spawn's fallback) instead of
      // starting empty; it is also what `/chat save` and a later fallback of the fork read
      if (forkParent && opts.fork) copyForkJournal(store.dir, forkParent, rec.sessionId, opts.fork.at);
    } catch (e) {
      lock?.release();
      // a record this call created (new session, fork) must not outlive the failed start (nor its
      // journal); a preset (import) record is removed by its caller
      if (fresh && !preset) removeRecordFiles(store, rec.sessionId);
      throw e;
    }
    if (!created) {
      // the saved per-tool trust belongs to the saved agent (`--agent` may name another one)
      switchAgentTrust(rec.trust, rec.agent, agent.name);
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
        ...(!preset && opts.fork ? { forkCopy: true } : {}),
        ...(startSignal ? { startSignal } : {}),
      });
    } catch (e) {
      // config that throws while wiring the session must not leave the lock (or a new record) behind
      if (fresh && !preset) removeRecordFiles(store, rec.sessionId);
      lock?.release();
      throw e;
    }
    for (const n of notices) s.uiNotice(n.level, n.message, true);
    try {
      // a saved record (resume, transferred copy) is written only once the child is up (the
      // start persists), so a start that fails or is cancelled (K3: Ctrl+C during `/chat resume`'s
      // agentSpawn hooks) leaves it as it was, its place in the session lists included
      if (fresh) s.persist();
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
    // plan mode is session state, not part of a tangent's checkpoint (Kiro's plan mode is the
    // planner agent, and the agent is session state, Q 06 §6.4; see swapAgent): the conversations
    // a tangent returns to get the state the user last set, saved now (a quit or a crash inside
    // the tangent must not leave the main conversation with fewer restrictions, r5 #0)
    for (const f of this.tangentStack) {
      if (f.rec.planMode === on) continue;
      f.rec.planMode = on;
      this.writeStacked(f.rec);
    }
    if (this.rec.planMode === on) return;
    this.rec.planMode = on;
    this.persist();
  }

  get tangent(): { name: string | null; parentId: string } | undefined {
    if (this.tangentStack.length === 0) return undefined;
    return { name: this.rec.tangentName, parentId: this.rec.parentId ?? this.tangentStack[this.tangentStack.length - 1]!.rec.sessionId };
  }

  /** KiroSession.busy: a turn runs, or Claude Code has not answered a user line yet. */
  get busy(): boolean {
    return this.turnBusy || !!this.proc?.busy;
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
    // the creator's start signal (K3) cancels the start until its agentSpawn hooks are done (they
    // may run for long, or forever with timeout 0); not the spawn of Claude Code after them, which
    // cannot stop half way and ends within the initialize timeout (a press then is no failure, F0)
    const signal = this.startSignal;
    const hooks = await this.sessionStartHooks(this.hookRunner, signal);
    if (hooks === 'cancelled' || signal?.aborted) throw this.closed ? new Error('The session is closed') : new SessionStartCancelledError();
    this.applySessionStart(hooks);
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

  /**
   * Run `runner`'s SessionStart (agentSpawn) hooks (K3). `signal` (the creator's start signal),
   * {@link interrupt} and {@link close} kill the commands still running, with their process groups
   * (also a hook with timeout 0 or one that ignores SIGTERM): `'cancelled'`, and nothing of the run
   * may be applied. `'failed'`: the runner threw (warned; the previous outputs stay). Runs while
   * the session is idle (`busy` false: a Ctrl+C never force-stops Claude Code for it, F0).
   */
  private async sessionStartHooks(runner: HookRunner, signal?: AbortSignal): Promise<AgentSpawnHookResult | 'failed' | 'cancelled'> {
    if (signal?.aborted || this.closed) return 'cancelled';
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    this.hookAbort = ac;
    try {
      const r = await runner.runSessionStart({ ws: this.ws, sessionId: this.rec.sessionId, signal: ac.signal });
      return ac.signal.aborted ? 'cancelled' : r;
    } catch (e) {
      if (ac.signal.aborted) return 'cancelled';
      this.uiNotice('warn', `agentSpawn hooks failed: ${errText(e)}`);
      return 'failed';
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.hookAbort === ac) this.hookAbort = undefined;
    }
  }

  /** The outputs (system prompt) and first-turn prompts of a completed SessionStart run. */
  private applySessionStart(r: AgentSpawnHookResult | 'failed'): void {
    if (r === 'failed') return;
    this.spawnOutputs = r.outputs;
    this.firstTurnPrompts = [...r.agentPrompts];
    for (const w of r.warnings) this.uiNotice('warn', w.message);
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
    for (const [k, v] of Object.entries(claudeSettingsEnv(this.settings, { interactive: this.interactive }))) if (this.env[k] === undefined) extra[k] = v;
    return buildChildEnv(this.env, { allowApiKey, extra });
  }

  /** A signal aborted by `outer` or by the current turn's abort (if a turn is running). */
  private turnLinkedSignal(outer: AbortSignal): { signal: AbortSignal; dispose(): void } {
    const ac = new AbortController();
    const abort = (): void => ac.abort();
    if (outer.aborted) ac.abort();
    outer.addEventListener('abort', abort, { once: true });
    const turnSignal = this.turnAbort?.signal;
    if (turnSignal?.aborted) ac.abort();
    turnSignal?.addEventListener('abort', abort, { once: true });
    return {
      signal: ac.signal,
      dispose: () => {
        outer.removeEventListener('abort', abort);
        turnSignal?.removeEventListener('abort', abort);
      },
    };
  }

  private handlers(): ClaudeHandlers {
    return {
      // Both callbacks are cancelled by Claude's control_cancel_request (ctx.signal) and by the
      // turn's own abort (interrupt / ACP session/cancel / close), so a Kiro hook command or an
      // approval prompt never outlives the turn that asked for it.
      onHookCallback: async (req, ctx) => {
        const link = this.turnLinkedSignal(ctx.signal);
        try {
          const id = req.callback_id;
          const input = (isObj(req.input) ? req.input : {}) as typeof req.input;
          if (id === GATE_CALLBACK_IDS.pre) {
            const r = await this.gate.preToolUse(input, link.signal);
            this.onPreDecision(r.call, r.decision);
            return r.output;
          }
          if ((id === GATE_CALLBACK_IDS.post || id === GATE_CALLBACK_IDS.postFail) && typeof input.tool_use_id === 'string' && typeof input.duration_ms === 'number') {
            this.durations.set(input.tool_use_id, input.duration_ms);
          }
          return await this.gate.hookCallback(id, input, link.signal);
        } finally {
          link.dispose();
        }
      },
      onCanUseTool: async (req, ctx) => {
        const link = this.turnLinkedSignal(ctx.signal);
        try {
          const r = await this.gate.canUseTool(req, (ar, sig) => this.ui.requestApproval(ar, sig), link.signal);
          if (r.redirectText !== undefined && r.redirectText.trim() !== '') this.redirects.push(r.redirectText);
          // an asked Agent call becomes a subagent once it is allowed to run (F7)
          if (r.result.behavior === 'allow' && req.tool_use_id !== undefined) this.releaseSubagent(req.tool_use_id);
          return r.result;
        } finally {
          link.dispose();
        }
      },
      onOtherControlRequest: () => undefined,
    };
  }

  /** Spawn the child for `mode`, with the start-error fallbacks of the module doc. */
  private async spawn(mode: LaunchMode, attempt = 0): Promise<void> {
    // a respawn (agent swap / ACP set_mode, /context, /clear, a crashed child) racing close():
    // no launch files written into a removed runtime dir, no child for a closed session
    if (this.closed) throw new Error('The session is closed');
    // kiro-claude dies of a forwarded fatal signal (claude/lifecycle `dyingSignal()`, r5 H2):
    // ClaudeProcess.start refuses a child; refused here first, before any launch file or warning
    const dying = dyingSignal();
    if (dying) throw new ClaudeProcessError(`kiro-claude is shutting down (${dying}); Claude Code was not started`);
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
        ...(this.opts.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: this.opts.initializeTimeoutMs } : {}),
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
        // a fork at a message the source transcript does not hold (a /rewind to a turn saved
        // before a fallback to a fresh Claude session: its uuid named the lost transcript) is
        // refused the same way (VERIFIED 2.1.319: `No message found with message.uuid of: <uuid>`,
        // exit 1): the record's journal, already cut at that turn, is its history (G2)
        if (
          (mode.kind === 'resume' || mode.kind === 'fork') &&
          (/No conversation found/i.test(text) || (mode.kind === 'fork' && mode.at !== undefined && /No message found with message\.uuid/i.test(text)))
        ) {
          const history = journalHistoryText(readJournal(this.store.dir, this.rec.sessionId));
          if (mode.kind === 'fork') this.rec.claudeSessionId = this.rec.claudeSessionId || randomUUID();
          // this record's (G2), saved with it until its line is written (R4 #1). A block still
          // pending from an earlier fallback of the same record (a respawn before the first line,
          // a reopen, a copy a tangent / fork got) is kept: one copy, and it holds at least what
          // the journal does (a `/compact` meanwhile summarized a Claude session that never had it)
          if (history && this.rec.pendingHistory === undefined) this.rec.pendingHistory = restoredHistoryBlock(history);
          if (this.rec.pendingHistory !== undefined) {
            // a /rewind to a turn a compaction followed: that turn is not lost, it was summarized
            const n = this.rewindCompacted;
            this.uiNotice(
              'warn',
              n !== undefined && mode.kind === 'fork' && mode.at !== undefined && /No message found with message\.uuid/i.test(text)
                ? `The conversation was compacted after turn ${n}, so Claude Code no longer holds that turn as it was; starting a new conversation with the saved history up to turn ${n} as context.`
                : 'Claude Code could not find the saved conversation; starting a new one with the saved history as context.',
            );
          }
          this.historyKnown = false;
          return this.spawn({ kind: 'new' }, attempt + 1);
        }
      }
      throw e;
    }
    if (this.closed) {
      // close() ran while the child was starting: it found no child to close, so close this one
      await proc.close().catch(() => undefined);
      this.cleanupRuntime();
      throw new Error('The session is closed');
    }
    this.proc = proc;
    this.launch = launch;
    this.deferredMode = undefined;
    this.claudeNew = mode.kind === 'new';
    this.setPendingFork(mode.kind === 'fork' ? mode : undefined);
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
   * KiroSession.forkSource: where a new fork of the current conversation must start: the current
   * Claude session, or, while the current one is itself an unmaterialized fork, that fork's own
   * source.
   */
  forkSource(): { from: string; at?: string } {
    // (a fork a local command line wrote is no longer pending: recordTurn, r5 S5)
    if (this.pendingFork) return { from: this.pendingFork.from, ...(this.pendingFork.at ? { at: this.pendingFork.at } : {}) };
    return { from: this.rec.claudeSessionId };
  }

  /**
   * The current conversation is a fork without a completed turn (`mode`), or no longer one. Kept
   * on the record too (`SessionRecord.pendingFork`, S3), so a resume after a quit forks the source
   * again; the caller persists.
   */
  private setPendingFork(mode: Extract<LaunchMode, { kind: 'fork' }> | undefined): void {
    this.pendingFork = mode;
    if (mode) this.rec.pendingFork = { from: mode.from, ...(mode.at ? { at: mode.at } : {}) };
    else delete this.rec.pendingFork;
  }

  private defaultMode(): LaunchMode {
    if (this.deferredMode) return this.deferredMode;
    if (this.pendingFork) return this.pendingFork;
    return this.historyKnown || (this.rec.turns.length > 0 && !this.claudeNew) ? { kind: 'resume' } : { kind: 'new' };
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

  /**
   * Close and respawn the child (config changed). No-op before start. While kiro-claude dies of a
   * forwarded fatal signal (r5 H2) it closes the child and returns quietly: no new child, no error
   * for the command (the process ends within the grace). The mode is kept for the child the next
   * line starts (ensureProcess), should the session outlive the signal (another listener took
   * over the shutdown): a fork stays pending, saved on the record.
   */
  private async restart(opts: { mode?: LaunchMode } = {}): Promise<void> {
    if (!this.startPromise) return;
    await this.startPromise;
    await this.closeProc();
    const mode = opts.mode ?? this.defaultMode();
    if (dyingSignal()) {
      this.deferredMode = mode;
      if (mode.kind === 'fork') this.setPendingFork(mode);
      this.persist();
      return;
    }
    await this.spawn(mode);
    this.persist();
  }

  /**
   * A child for the next line: the running one, else a respawn (with a notice when the child
   * died). While kiro-claude dies of a forwarded fatal signal nothing is started and no notice is
   * printed: the respawn is refused quietly (spawn throws; r5 H2).
   */
  private async ensureProcess(): Promise<void> {
    await this.start();
    if (this.proc && this.proc.running) return;
    if (this.proc && !dyingSignal()) this.uiNotice('warn', 'Claude Code exited unexpectedly; restarting it.');
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
    const j = this.textJoin;
    if (j) {
      if ((ev.type === 'text_delta' || ev.type === 'text') && ev.text !== '') {
        if (j.pending) {
          // a continuation turn's answer is a new paragraph, not glued onto the last one; done
          // here so the generator and the live 'event' stream (ACP) carry the same text
          j.pending = false;
          const sep = '\n'.repeat(Math.max(0, 2 - /\n*$/.exec(j.tail)![0].length));
          if (sep) ev = { ...ev, text: sep + ev.text };
        }
        j.tail = (j.tail + ev.text).slice(-2);
      } else if (ev.type === 'tool_start' || ev.type === 'tool_denied' || ev.type === 'tool_end') {
        // front ends render a tool as its own block: that is the boundary already
        j.tail = '';
        j.pending = false;
      }
    }
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

  /** Save a record of the tangent stack (its lock is ours; it shares this session's trust). */
  private writeStacked(rec: SessionRecord): void {
    if (this.finalized) return;
    try {
      this.store.write(rec);
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
    if (t && !t.lineSeen && lineActivity(f, t.userUuid)) t.lineSeen = true;
    try {
      // the subagent of an asked Agent call is running although no approval was seen: list it
      if (typeof f.parent_tool_use_id === 'string' && this.heldSubagents.size) this.releaseSubagent(f.parent_tool_use_id);
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
        case 'command_lifecycle':
          this.onSteerLifecycle(f, t);
          break;
        default:
          break;
      }
    } catch (e) {
      log.warn(`failed to process a Claude frame: ${errText(e)}`);
    }
  }

  /**
   * A steer is journaled where Claude reads it: on its `command_lifecycle` `started` (right after
   * the tool results of the boundary it is folded in at, or after the prompt's own result when it
   * runs as a turn of its own — VERIFIED 2.1.319). A steer Claude drops (`cancelled`, e.g. by the
   * cancel_queued interrupt of an aborted turn) never reached the model and is not journaled.
   */
  private onSteerLifecycle(f: Record<string, unknown>, t: TurnState | undefined): void {
    if (!t || typeof f.command_uuid !== 'string' || (f.state !== 'started' && f.state !== 'cancelled')) return;
    const i = t.pendingSteer.findIndex((r) => r.data.message_id === f.command_uuid);
    if (i < 0) return;
    const [rec] = t.pendingSteer.splice(i, 1);
    if (f.state !== 'started') return;
    // read after the prompt's result, in a turn of its own: its answer is a new paragraph, not
    // glued onto the one before (folded in at a boundary, the tool already broke the text)
    if (this.textJoin) this.textJoin.pending = this.textJoin.tail !== '';
    this.flushAssistant(t);
    rec!.timestamp = new Date().toISOString();
    t.journal.push(rec!);
    t.lastToolBatch = undefined;
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
        } else if (f.status !== 'compacting' && f.compact_result === 'failed') {
          // the compaction ended without a boundary (refused, interrupted): the next one is
          // reported from its start. A `/compact` Claude refused (VERIFIED 2.1.319: a session
          // holding only local-command entries, "Not enough messages to compact.", under a result
          // that says success) fails with that reason (toTurnResult; an interrupted one is
          // cancelled all the same)
          this.compacting = false;
          if (t && t.kind === 'compact') {
            const why = typeof f.compact_error === 'string' ? f.compact_error.trim() : '';
            t.localCommandError ??= why || 'Compaction failed';
            t.compactRefused = true;
          }
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
        if (t) {
          t.compactPending = true;
          const ps = isObj(md.preserved_segment) ? md.preserved_segment : undefined;
          if (ps && isClaudeUuid(ps.anchor_uuid) && isClaudeUuid(ps.tail_uuid)) t.compactKept = { anchor: ps.anchor_uuid, tail: ps.tail_uuid };
          else delete t.compactKept;
        }
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
    const outcome = f.local_command_outcome;
    if (isObj(outcome) && outcome.kind === 'failed') {
      // a local command Claude reports as failed: its text is the turn's error, no answer
      const said = content.map((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
      const source = typeof f.local_command_source === 'string' ? f.local_command_source.replace(/<\/?local-command-std(?:err|out)>/g, '') : '';
      t.localCommandError = (said.trim() || source.trim() || 'Claude Code reported an error').trim();
      return;
    }
    // the reason of a compaction Claude refused, as its local command's output: the turn's
    // error already (onSystem), no answer
    if (t.compactRefused && typeof f.local_command_source === 'string') return;
    if (typeof f.uuid === 'string') t.assistantUuid = f.uuid;
    if (f.error === 'authentication_failed') {
      // Claude's synthetic "Not logged in · Please run /login" is no answer (and names a command
      // kiro-claude does not have): the front ends print Kiro's not-logged-in text for authError
      t.authError = true;
      return;
    }
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
    this.announceStart(call, decision.kind === 'allow', decision.kind === 'ask');
  }

  /**
   * `tool_start`, and `subagent` `started` for an Agent call. A call the gate asks about is shown
   * at once, but its subagent is held until the call may run (F7: kiro-cli lists a subagent only
   * once it is spawned, KiroCrew turns every roster entry into an Activity card): the approval
   * (onCanUseTool), else the first frame of that subagent; a call denied at the prompt is never a
   * subagent (onUser drops it).
   */
  private announceStart(call: KiroToolCall, trusted: boolean, askPending = false): void {
    const id = call.toolUseId ?? '';
    this.publish({ type: 'tool_start', toolUseId: id, call, trusted });
    if (call.claudeName === 'Agent' || call.claudeName === 'Task') {
      const type = typeof call.input.subagent_type === 'string' && call.input.subagent_type ? call.input.subagent_type : 'general-purpose';
      const desc = typeof call.input.description === 'string' ? call.input.description : undefined;
      const task = typeof call.input.prompt === 'string' && call.input.prompt.trim() ? call.input.prompt : undefined;
      const ev: SessionEvent = { type: 'subagent', state: 'started', agentType: type, ...(desc ? { description: desc } : {}), ...(id ? { toolUseId: id } : {}), ...(task ? { prompt: task } : {}) };
      if (askPending && id) this.heldSubagents.set(id, ev);
      else this.publish(ev);
    }
  }

  /** Publish the held `subagent` `started` of an asked Agent call (see announceStart). */
  private releaseSubagent(toolUseId: string): void {
    const ev = this.heldSubagents.get(toolUseId);
    if (!ev) return;
    this.heldSubagents.delete(toolUseId);
    this.publish(ev);
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
      // a compaction of a Claude session that does not hold the conversation yet (its restored
      // history is still pending: a `/compact` right after a fallback, R4 #1) summarizes none of
      // it: no marker, so the journal keeps the conversation the pending block delivers with the
      // next line, and a later fallback restores it (not the summary of nothing); nor a pin
      if (this.rec.pendingHistory === undefined) {
        t.journal.push(compactionRecord(text));
        // Claude resumes the compacted conversation from its last compact boundary: at the
        // message the compaction kept verbatim (relinked after this summary, its anchor), else at
        // the summary itself; a fork at the boundary would lose the summary (VERIFIED 2.1.319, r5
        // S2). recordTurn saves it on the last turn of a `/compact` (SessionTurnRecord.compactUuid)
        const kept = t.compactKept && t.compactKept.anchor === f.uuid ? t.compactKept.tail : undefined;
        t.compactUuid = kept ?? (isClaudeUuid(f.uuid) ? f.uuid : undefined);
      }
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
        // still held: never allowed to run (denied / cancelled at the prompt) — no subagent; one
        // that ran without an approval we saw is listed now, then finished
        if (this.heldSubagents.has(id) && isError) this.heldSubagents.delete(id);
        else {
          this.releaseSubagent(id);
          const type = typeof call.input.subagent_type === 'string' && call.input.subagent_type ? call.input.subagent_type : 'general-purpose';
          this.publish({ type: 'subagent', state: 'finished', agentType: type, toolUseId: id, isError, ...(isError ? { error: truncateChars(text, 500) } : {}) });
        }
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
      // steers are journaled when Claude starts them (onSteerLifecycle), not at this boundary
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
    // one message per rejection (00 §3.9 rate_limit_event row): the front ends render a
    // `rate_limit` with status 'rejected' themselves (REPL, headless; ACP maps it to its error),
    // so no extra `notice` here
    this.publish({ type: 'rate_limit', status, ...(resetsAt !== undefined ? { resetsAt } : {}), ...(utilization !== undefined ? { utilization } : {}) });
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
      lineSeen: false,
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
    // a local command Claude reported as failed under a result that says success (r5 #8)
    const localFailure = stopReason === 'local_command' ? t.localCommandError : undefined;
    const isError = (result.is_error === true && stopReason !== 'cancelled') || localFailure !== undefined;
    const text = typeof result.result === 'string' ? result.result : t.assistantText;
    const out: TurnResult = { stopReason, isError, text, permissionDenials: denials };
    if (localFailure !== undefined) out.error = this.localFailureText(t, localFailure);
    else if (isError) {
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

  /**
   * The error of a failed local command (TurnResult.error; the front ends put their own "error"
   * before it, so Claude's `Error: ` prefix goes). A `/compact` of a fresh Claude session whose
   * restored history is still pending (R4 #1) fails for lack of messages although the record
   * shows a conversation: the reason is given.
   */
  private localFailureText(t: TurnState, text: string): string {
    const msg = text.replace(/^error:\s*/i, '').trim() || text;
    if (t.kind === 'compact' && this.rec.pendingHistory !== undefined && /\b(?:no|not enough) messages\b/i.test(msg)) {
      return `${msg.replace(/\.$/, '')}: Claude Code gets the restored conversation with your next message, so it has nothing to compact yet`;
    }
    return msg;
  }

  private recordTurn(t: TurnState, tr: TurnResult, wrote: { journal: boolean }): void {
    // after close() the lock is gone (another process may own the session): write nothing
    if (this.finalized) return;
    if (t.kind !== 'local') {
      this.setPendingFork(undefined);
      this.claudeNew = false; // Claude has a transcript of it now
      // a turn of its own: no longer a mere copy of its parent (K1)
      if (this.untouchedFork === this.rec) this.untouchedFork = undefined;
    } else if (tr.stopReason === 'local_command' && !tr.isError && tr.localCommand !== undefined && RECORDED_LOCAL_COMMANDS.has(tr.localCommand)) {
      // a local command line Claude ran writes the session's transcript, a pending fork's copied
      // history included (VERIFIED 2.1.319 for /effort, /model, /cost, /context): the fork is
      // written, so it is no longer pending: forkSource() is the fork itself, a respawn or a
      // reopen resumes it (r5 S5); nothing of its own for K1 (untouchedFork stays)
      if (this.pendingFork) this.setPendingFork(undefined);
    }
    // a `/compact` (not an auto-compaction inside a prompt turn: its summary may cover that turn's
    // own line) saves where Claude resumes the compacted conversation on the turn it followed: the
    // pin of a fork of this record at its last turn (forkPointFor, r5 S2)
    const lastTurn = this.rec.turns.length - 1;
    if (t.kind === 'compact' && t.compactUuid !== undefined && lastTurn >= 0) {
      this.rec.turns[lastTurn] = { ...this.rec.turns[lastTurn]!, compactUuid: t.compactUuid };
    }
    if (t.kind === 'prompt' && tr.stopReason !== 'local_command') {
      // an auth failure's text is Claude's "Please run /login", not an answer (session lists, tail)
      const answer = tr.authError ? '' : tr.text;
      try {
        this.store.appendTurn(
          this.rec,
          { userUuid: t.userUuid, ...(t.assistantUuid ? { assistantUuid: t.assistantUuid } : {}), preview: t.userText, at: new Date().toISOString() },
          answer || t.userText,
        );
      } catch (e) {
        this.uiNotice('warn', `Failed to save the session index: ${errText(e)}`, true);
      }
      this.historyKnown = true;
      this.lastExchange = { user: t.userText, assistant: answer };
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

  /**
   * One Claude turn: send `content`, stream mapped events, return the mapped result. `queued`
   * (from composeTurn) settles the queued context `content` carries: `sent` once the line is
   * written (it leaves its queue only then, G5); `unsent` when Claude never gets the line (the
   * turn was aborted or the child could not be (re)started before it was written) or dropped it
   * before starting it (synthetic result) (F1).
   */
  private async *runTurn(
    content: string | UserContentBlock[],
    kind: TurnState['kind'],
    userText: string,
    images?: { mediaType: string; dataBase64: string }[],
    queued?: QueuedContext,
  ): AsyncGenerator<SessionEvent, TurnResult> {
    let sent = false;
    let proc!: ClaudeProcess;
    let t!: TurnState;
    let signal: AbortSignal | undefined;
    let gen!: AsyncGenerator<ClaudeFrame, ResultFrame>;
    /** The untouched create({ fork }) copy this turn's line made the user's own (K1). */
    let touched: SessionRecord | undefined;
    try {
      await this.ensureProcess();
      const effort = this.pendingEffort;
      if (effort && kind !== 'local') {
        this.pendingEffort = undefined;
        // only in the record it was set in (another one's child runs at its own saved level)
        if (effort.rec === this.rec) {
          await this.runLocal(`/effort ${effort.level}`).catch((e: unknown) => this.uiNotice('warn', `Failed to set effort: ${errText(e)}`));
        }
      }
      await this.waitIdle();
      proc = this.proc!;
      // the child is up for the line now: a restored-history block its respawn's fallback queued
      // after the line was composed (the child died meanwhile) goes into this line (R4 #6)
      const recomposed = queued?.recompose();
      if (recomposed !== undefined) content = recomposed;
      t = this.newTurnState(kind, userText);
      if (queued) t.queued = queued;
      if (kind === 'prompt') t.journal.push(promptRecord(userText, { ...(images?.length ? { images } : {}), messageId: t.userUuid }));
      signal = this.turnAbort?.signal;
      try {
        gen = proc.turn(content, { uuid: t.userUuid, ...(signal ? { signal } : {}) });
        sent = true; // proc.turn writes the line synchronously
      } catch (e) {
        return this.toTurnResult(t, undefined, e, signal?.aborted === true);
      }
      // a line of the user's reached Claude in an untouched create({ fork }) copy (the continuation
      // a /spec flow handed over): it is the user's conversation now, kept on close also when no
      // result comes (the REPL's forced stop re-creates the session from it; dropped, the chat
      // would restart empty), K1
      if (kind !== 'local' && this.untouchedFork === this.rec) {
        touched = this.rec;
        this.untouchedFork = undefined;
      }
      queued?.sent();
    } finally {
      if (!sent) queued?.unsent();
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
      // steers whose `started` was never seen: journaled when the result answers them (a CLI
      // without lifecycle frames), dropped otherwise (cancelled / never read by the model)
      const answered = new Set(result ? [...(result.user_message_uuids ?? []), ...(result.user_message_uuid ? [result.user_message_uuid] : [])] : []);
      for (const rec of t.pendingSteer.splice(0)) if (answered.has(String(rec.data.message_id))) t.journal.push(rec);
      this.turn = undefined;
      this.sink = undefined;
      tr = this.toTurnResult(t, result, failure, signal?.aborted === true);
      if (result?.synthetic === true) {
        // dropped by Claude before it started (S2): the model never read the line, so it is no
        // turn of this conversation: no turn record or journal entry, and a fork without a turn
        // stays one (pendingFork: a respawn or a fork of it starts at its source); its context
        // is queued again
        queued?.unsent();
        if (touched && this.rec === touched) this.untouchedFork = touched; // still a mere copy
      } else if (result) this.recordTurn(t, tr, wrote);
      else if (!proc.running) this.settleUnreadLine(t);
      this.toolCalls.clear();
      this.toolUses.clear();
      this.announced.clear();
      this.heldSubagents.clear();
      this.deniedIds.clear();
      this.policyReasons.clear();
      this.durations.clear();
    }
    return tr!;
  }

  /**
   * The child is gone and Claude never answered `t`'s line (S4): when it showed no sign of having
   * read it either (no `started`, no output) and its transcript does not hold it, the line died
   * in the pipe, so the context it carried (restored history, tangent carry, first-turn prompts)
   * is queued again for the next line. A line Claude did read keeps it delivered (no copy twice).
   */
  private settleUnreadLine(t: TurnState): void {
    if (!t.queued || t.lineSeen) return;
    if (lineInTranscript(this.rec.claudeSessionId, t.userUuid, this.ws.cwd, this.env)) return;
    t.queued.unsent();
  }

  /**
   * A hidden line (the `/tangent merge` summary request) with the current record's restored
   * history when one is pending and the tangent carries queued on it (a nested tangent's merge or
   * tail, r5 #4: part of its history), in composeTurn's order and settled like a composed prompt
   * line's: they leave the record once the line is written, come back when Claude dropped it
   * unread, and a block the respawn before the write queued (the child died and its transcript was
   * lost) goes into the line with the carries (`recompose`, R4 #6), so the model has the
   * conversation it is asked about (r5 S5).
   */
  private hiddenLine(text: string): { content: string | UserContentBlock[]; queued: QueuedContext } {
    const rec = this.rec;
    let restored = rec.pendingHistory;
    const carried = [...(rec.pendingContext ?? [])];
    let state: 'composed' | 'sent' | 'settled' = 'composed';
    const compose = (): string | UserContentBlock[] =>
      restored === undefined && carried.length === 0
        ? text
        : composeUserTurn({ text, hookOutputs: [], agentPrompts: [], steeringBlocks: [], refBlocks: [], extraContext: [...(restored !== undefined ? [restored] : []), ...carried] });
    const save = (): void => {
      if (rec === this.rec) this.persist();
    };
    const queued: QueuedContext = {
      recompose: () => {
        if (state !== 'composed' || rec.pendingHistory === restored) return undefined;
        restored = rec.pendingHistory;
        return compose();
      },
      sent: () => {
        if (state !== 'composed') return;
        state = 'sent';
        let changed = false;
        if (restored !== undefined && rec.pendingHistory === restored) {
          delete rec.pendingHistory;
          changed = true;
        }
        if (carried.length) {
          const left = [...(rec.pendingContext ?? [])];
          for (const c of carried) {
            const i = left.indexOf(c);
            if (i >= 0) left.splice(i, 1);
          }
          if (left.length) rec.pendingContext = left;
          else delete rec.pendingContext;
          changed = true;
        }
        if (changed) save();
      },
      unsent: () => {
        if (state === 'settled') return;
        const wasSent = state === 'sent';
        state = 'settled';
        if (!wasSent) return; // nothing left its queue
        let changed = false;
        if (restored !== undefined && rec.pendingHistory === undefined) {
          rec.pendingHistory = restored;
          changed = true;
        }
        if (carried.length) {
          rec.pendingContext = [...carried, ...(rec.pendingContext ?? [])];
          changed = true;
        }
        if (changed) save();
      },
    };
    return { content: compose(), queued };
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

  private async composeTurn(
    input: PromptInput,
    signal?: AbortSignal,
  ): Promise<{ content: string | UserContentBlock[]; userText: string; images: { mediaType: string; dataBase64: string }[]; queued: QueuedContext }> {
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
    // Queued context for this line (runTurn settles it, F1). First-turn prompts are taken now and
    // given back by `unsent` when Claude never gets the line. The record's restored history (G2,
    // `pendingHistory`) and tangent carry stay queued on the record until the line is written
    // (`sent`): a prompt cancelled, or a session closed (the REPL's forced stop: close() saves the
    // record, G5), before that keeps them; a block a respawn's fallback queued for this record
    // while the line was composed is put into it before it is written (`recompose`, R4 #6).
    const rec = this.rec;
    const firstTurn = this.firstTurnPrompts.splice(0);
    let restored = rec.pendingHistory;
    const carried = [...(rec.pendingContext ?? [])];
    let state: 'composed' | 'sent' | 'settled' = 'composed';
    const queued: QueuedContext = {
      recompose: () => {
        if (state !== 'composed' || rec.pendingHistory === restored) return undefined;
        // the line's block (where composeUserTurn puts it: after the first-turn prompts) becomes
        // the record's current one
        const i = restored !== undefined ? extraContext.indexOf(restored) : -1;
        const now = rec.pendingHistory;
        extraContext.splice(i >= 0 ? i : firstTurn.length, i >= 0 ? 1 : 0, ...(now !== undefined ? [now] : []));
        restored = now;
        return composeUserTurn(turnInput);
      },
      sent: () => {
        if (state !== 'composed') return;
        state = 'sent';
        let save = false;
        if (restored !== undefined && rec.pendingHistory === restored) {
          delete rec.pendingHistory;
          save = true;
        }
        if (carried.length) {
          const left = [...(rec.pendingContext ?? [])];
          for (const c of carried) {
            const i = left.indexOf(c);
            if (i >= 0) left.splice(i, 1);
          }
          if (left.length) rec.pendingContext = left;
          else delete rec.pendingContext;
          save = true;
        }
        // saved now: a fork of this record (spec driver, G1) must not get a delivered carry or
        // history, nor a reopen of it the history again (R4 #1)
        if (save && rec === this.rec) this.persist();
      },
      unsent: () => {
        if (state === 'settled') return;
        const wasSent = state === 'sent';
        state = 'settled';
        this.firstTurnPrompts.unshift(...firstTurn);
        if (!wasSent) return; // the rest never left its queue
        // Claude dropped the line before starting it: the model never read any of it
        let save = false;
        if (restored !== undefined && rec.pendingHistory === undefined) {
          rec.pendingHistory = restored;
          save = true;
        }
        if (carried.length) {
          rec.pendingContext = [...carried, ...(rec.pendingContext ?? [])];
          save = true;
        }
        if (save && rec === this.rec) this.persist();
      },
    };
    const extraContext: string[] = [
      ...firstTurn,
      ...(restored !== undefined ? [restored] : []),
      ...carried,
      ...(this.rec.planMode ? [PLAN_MODE_BLOCK] : []),
      ...(input.extraContext ?? []),
    ];
    const images = [...(input.images ?? []), ...at.images.map((i) => ({ mediaType: i.mediaType, dataBase64: i.dataBase64 }))];
    const turnInput = {
      text,
      hookOutputs,
      agentPrompts: hookPrompts,
      steeringBlocks,
      refBlocks: [...at.blocks, ...hash.blocks],
      extraContext,
      images,
    };
    const content = composeUserTurn(turnInput);
    if (content === '' || (Array.isArray(content) && content.length === 0)) {
      queued.unsent();
      throw new Error('Cannot send an empty prompt');
    }
    return { content, userText: input.text, images, queued };
  }

  /**
   * Compose a line of `prompt()` (the first one, a redirect, a Stop-hook continuation) for the
   * child that will get it: a child that died since the last turn is respawned FIRST, so the
   * restored history its fallback queues (the transcript is gone too) goes into this very line,
   * the one it is context for, and the line's steering / skills are those of that child (R4 #6).
   */
  private async composeLine(input: PromptInput, signal: AbortSignal): ReturnType<KiroSessionImpl['composeTurn']> {
    await this.ensureProcess();
    return this.composeTurn(input, signal);
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
    const join = { tail: '', pending: false };
    this.textJoin = join;
    try {
      let composed = await this.composeLine(input, abort.signal);
      let res = yield* this.runTurn(composed.content, 'prompt', composed.userText, composed.images, composed.queued);
      // the prompt's result covers every Claude turn it ran (F6, like ClaudeProcess mergeResults
      // for a steer answered in a turn of its own); text and stop reason are the last turn's
      let total = res;
      let continuations = 0;
      for (;;) {
        if (abort.signal.aborted || this.closed) break;
        const redirect = this.redirects.shift();
        if (redirect !== undefined) {
          composed = await this.composeLine({ text: redirect }, abort.signal);
          join.pending = join.tail !== '';
          res = yield* this.runTurn(composed.content, 'prompt', composed.userText, composed.images, composed.queued);
          total = mergeTurnResults(total, res);
          continuations = 0;
          continue;
        }
        if (res.stopReason !== 'end_turn') break;
        const cont = await this.runStopHooks(res.text, continuations, abort.signal);
        if (cont === undefined || abort.signal.aborted) break;
        continuations++;
        composed = await this.composeLine({ text: cont, skipPromptHooks: true }, abort.signal);
        join.pending = join.tail !== '';
        res = yield* this.runTurn(composed.content, 'prompt', composed.userText, composed.images, composed.queued);
        total = mergeTurnResults(total, res);
      }
      return total;
    } finally {
      if (this.textJoin === join) this.textJoin = undefined;
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

  steer(text: string): { uuid: string; withdraw(): Promise<boolean> } | void {
    if (text.trim() === '') return;
    const proc = this.proc;
    if (this.turn && this.turn.kind === 'prompt' && proc?.running && proc.busy) {
      try {
        // ClaudeProcess keeps the running turn open until Claude has answered this line
        const uuid = proc.sendUserMessage(text, { priority: 'next' });
        this.turn.pendingSteer.push(promptRecord(text, { messageId: uuid }));
        // until Claude reads it, it can be taken back (its `cancelled` drops the journal record)
        return { uuid, withdraw: () => proc.cancelQueuedMessage(uuid) };
      } catch (e) {
        log.debug(`steer failed, queueing: ${errText(e)}`);
      }
    }
    this.queuedSteer.push(text);
  }

  async interrupt(): Promise<void> {
    this.redirects = [];
    // agentSpawn hooks of /clear or /agent swap (K3): killed, the command is cancelled
    this.hookAbort?.abort();
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
    // the target's agentSpawn hooks first, while the current agent's child still runs: an
    // interrupt (Ctrl+C, ACP session/cancel) or close() that cancels them cancels the swap, and
    // nothing has changed yet (K3)
    const runner = new HookRunner(allHooksFor(this.ws, target));
    const hooks = await this.sessionStartHooks(runner);
    if (hooks === 'cancelled') {
      if (this.closed) throw new Error('The session is closed');
      throw new SessionStartCancelledError(`/agent swap was cancelled while the agentSpawn hooks of ${target.name} ran; still using agent ${this.currentAgent.name}.`);
    }
    this.assertIdle('/agent swap');
    this.agents = r.agents;
    // per-tool trust is the active agent's (Q Agents::trust_tools); trust-all stays session-wide
    switchAgentTrust(this.trustState, this.currentAgent.name, target.name);
    this.currentAgent = target;
    this.rec.agent = target.name;
    // the agent is session state, not part of a tangent's checkpoint (Q, 06 §6.4): the
    // conversations a tangent returns to run on it too, and their records (which share this
    // trust, whose per-tool part is the active agent's) must name it
    for (const f of this.tangentStack) f.rec.agent = target.name;
    for (const w of target.warnings) this.uiNotice('warn', w.message, true);
    if (target.model && target.model.trim() !== '') {
      const m = kiroToClaudeModel(target.model, this.liveModels);
      if (m.error) this.uiNotice('warn', `${m.error} (from agent ${target.name}); keeping ${this.model}.`);
      else this.rec.model = target.model;
    }
    this.hookRunner = runner;
    this.todoMap.clear();
    this.applySessionStart(hooks);
    await this.restart();
  }

  async setModel(kiroModelId: string): Promise<void> {
    await this.start();
    const id = kiroModelId.trim();
    const m = kiroToClaudeModel(id, this.liveModels);
    if (m.error) throw new ModelNotFoundError(m.error);
    const entry = findModelEntry(buildModelList(this.liveModels), id);
    const kiroId = entry?.kiroId ?? (m.value === undefined ? AUTO_MODEL_ID : claudeToKiroModelId(id));
    const changed = kiroId !== this.rec.model;
    const rec = this.rec;
    const prev = { model: rec.model, contextWindow: this.contextWindow };
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
    if (this.proc?.running) {
      try {
        await this.proc.setModel(m.value ?? null);
      } catch (e) {
        // Claude refused the switch (an error answer, also one the REPL stopped waiting for, r5
        // S5): the model stays what it was, in memory as on disk (a turn may have saved the record
        // meanwhile; a respawn's `--model`). A request that failed without an answer (the child
        // died or was restarted, a timeout) refused nothing: the session keeps the user's choice,
        // which the next child starts with (r5 verify)
        const refused = e instanceof ClaudeControlError && !e.timedOut;
        if (refused && rec.model === kiroId) {
          rec.model = prev.model;
          if (this.rec === rec) {
            this.contextWindow = prev.contextWindow;
            this.persist();
          }
        }
        throw e;
      }
    }
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
    // queued for the next prompt line (runTurn writes it right before that line) while a turn
    // runs, while the child is down (a respawn gets `--effort` anyway) and while a restored
    // history is pending: Claude writes a fresh session's transcript for a local command line, so
    // the history's own line stays the conversation's first (R4 #1)
    if (this.turnBusy || !this.proc?.running || this.rec.pendingHistory !== undefined) {
      this.pendingEffort = { rec: this.rec, level: l };
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
    // Q's /clear empties the hook cache: the agentSpawn hooks run again. First, while nothing has
    // changed yet: an interrupt (Ctrl+C, ACP session/cancel) or close() that cancels them cancels
    // the whole /clear (K3); their outputs apply once the conversation is cleared. They run on a
    // runner of their own (an empty cache, as after the clear), so a cancelled /clear leaves this
    // session's cache (per-prompt hooks' `cache_ttl_seconds`) as it was; a SessionStart result is
    // never read from the session's cache (every run here starts empty)
    const hooks = await this.sessionStartHooks(new HookRunner([...this.hookRunner.hooks]));
    if (hooks === 'cancelled') {
      if (this.closed) throw new Error('The session is closed');
      throw new SessionStartCancelledError('/clear was cancelled while the agentSpawn hooks ran; the conversation was not cleared.');
    }
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
    this.hookRunner.clearCache();
    this.rec.turns = [];
    // the cleared conversation has no messages (Q/Kiro: `/clear` empties the history the saved
    // conversation and its message count describe, K4); the record stays in the index (unusedRecord)
    this.rec.messageCount = 0;
    delete this.rec.pendingContext; // a tangent carry for the conversation just cleared
    delete this.rec.pendingHistory; // and its restored history (G2; saved below)
    this.todoMap.clear();
    this.activator.reset();
    this.lastExchange = undefined;
    this.historyKnown = false;
    this.setPendingFork(undefined); // a new conversation: nothing to fork again (S3)
    try {
      appendJournal(this.store.dir, this.rec.sessionId, [compactionRecord('')]);
    } catch {
      /* best effort */
    }
    const prev = JSON.stringify(this.spawnOutputs);
    this.applySessionStart(hooks);
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
      // a carry merged into the parent is part of its history (V3 injects it as a prompt turn,
      // 01 §5.11; Q re-appends the tail entry, 06 §6.4), which this fork does not contain yet:
      // the tangent's first turn gets its own copy; the parent keeps its copy, delivered once (F9)
      ...(parent.pendingContext?.length ? { pendingContext: [...parent.pendingContext] } : {}),
      // so is the parent's restored history still waiting for its next line (R4 #1): the fork
      // source may have a transcript without it by now (Claude writes a fresh session's
      // transcript for a local command), so the fork succeeds without a fallback; a fork that
      // falls back keeps this copy (one block); the parent keeps its own copy
      ...(parent.pendingHistory !== undefined ? { pendingHistory: parent.pendingHistory } : {}),
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
    // the parent fell back to a fresh Claude session and has had no turn since: Claude has no
    // transcript of it to fork (`No conversation found`: the fallback, and its warning, a second
    // time), so the tangent starts fresh with the parent's restored history copied above, and the
    // return starts the parent fresh again (r5 S5)
    const fresh = this.claudeNew && !this.pendingFork;
    this.tangentStack.push({
      rec: parent,
      lock: parentLock,
      ...(this.pendingFork ? { pendingFork: this.pendingFork } : {}),
      ...(fresh ? { fresh: true as const } : {}),
      ...(this.lastExchange ? { lastExchange: this.lastExchange } : {}),
    });
    this.rec = tangent;
    this.lock = lock;
    try {
      await this.restart({ mode: fresh ? { kind: 'new' } : { kind: 'fork', ...src } });
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
      // the hidden summary turn is interruptible like any turn (Ctrl+C / ACP cancel during
      // `/tangent merge`), also before Claude has started working on it
      const abort = new AbortController();
      this.turnAbort = abort;
      let summary: TurnResult;
      try {
        // with the tangent's restored history when its transcript was lost (r5 S5)
        const line = this.hiddenLine(TANGENT_SUMMARY_PROMPT);
        const gen = this.runTurn(line.content, 'local', TANGENT_SUMMARY_PROMPT, undefined, line.queued);
        for (;;) {
          const r = await gen.next();
          if (r.done) {
            summary = r.value;
            break;
          }
        }
      } finally {
        if (this.turnAbort === abort) this.turnAbort = undefined;
        this.turnBusy = false;
      }
      if (summary!.stopReason === 'cancelled') throw new Error('Merge cancelled — interrupted');
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
    // plan mode is session state like the agent (the planMode setter names it on this record
    // too): the state the user last set holds after the return, also when leaving is not the
    // user's own `/tangent` (a `/spec new` leaving an empty tangent, T4), r5 #0
    if (this.rec.planMode !== tangent.planMode) {
      this.rec.planMode = tangent.planMode;
      this.persist();
    }
    lock?.release();
    // a restored history still pending in the tangent stays on its record (saved above: a reopen
    // of the tangent by id sends it); it is never sent from here (the record is left)
    // the conversation returned to has its own last exchange again (a tangent nested in another
    // one: the outer tangent's `/tangent tail` carries it, not nothing)
    this.lastExchange = top.lastExchange;
    if (carry) {
      // the parent's own queue, saved with its record: it reaches THIS conversation even after a
      // quit or another tangent / spec fork opened first (which gets a copy of its own, F9 / G1),
      // and survives a prompt Claude never received (composeTurn: it leaves the record only once
      // the line is written)
      (this.rec.pendingContext ??= []).push(carry);
      // something of its own: an untouched create({ fork }) copy is kept with it on close (K1)
      if (this.untouchedFork === this.rec) this.untouchedFork = undefined;
      this.persist();
    }
    // (a parent whose fresh Claude session has no transcript yet starts fresh again, enterTangent)
    this.historyKnown = !top.fresh && this.rec.turns.length > 0;
    this.setPendingFork(top.pendingFork);
    await this.restart({ mode: top.pendingFork ?? (!top.fresh && this.rec.turns.length > 0 ? { kind: 'resume' } : { kind: 'new' }) });
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
      // rewinding to the last turn drops trailing compactions (the journal keeps turn N's own
      // history; Claude's fork at its answer is compacted when the compaction kept that answer)
      copyJournalThroughTurn(this.store.dir, old.sessionId, rec.sessionId, turns, turn - 1);
    } catch (e) {
      lock?.release();
      this.dropRecord(rec.sessionId);
      throw e;
    }
    this.rec = rec;
    this.lock = lock;
    // a compaction followed turn N: Claude serves its answer only when the compaction kept it
    // verbatim, so the fork may fall back on the journal cut at turn N (see the module doc); the
    // fallback's warning says so (r5 g2)
    let compacted = turns.slice(turn - 1).some((t) => t.compactUuid !== undefined);
    if (!compacted) {
      try {
        compacted = compactedAfterTurn(readJournal(this.store.dir, old.sessionId), turns, turn - 1);
      } catch {
        /* no journal: the generic warning */
      }
    }
    this.rewindCompacted = compacted ? turn : undefined;
    try {
      await this.restart({ mode: { kind: 'fork', from: src.from, at: target.assistantUuid } });
    } catch (e) {
      this.rec = old;
      this.lock = oldLock;
      lock.release();
      this.dropRecord(rec.sessionId);
      await this.restart().catch(() => undefined);
      throw e;
    } finally {
      this.rewindCompacted = undefined;
    }
    // the last exchange is turn N's now (a `/tangent tail` of a tangent rewound inside carries it,
    // never a turn rewound away): from the journal cut at turn N, else none
    if (turn < turns.length) {
      let ex: { user: string; assistant: string } | undefined;
      try {
        ex = turnExchange(readJournal(this.store.dir, rec.sessionId), target.userUuid, new Set(turns.map((t) => t.userUuid)));
      } catch {
        ex = undefined;
      }
      this.lastExchange = ex;
    }
    // the old session stays on disk untouched; it is no longer active here (unless it is a tangent
    // parent); its restored history (the turns rewound away included) is never sent from here
    // (G2): it stays pending on the old record only (a reopen of that record by id sends it)
    const parentOfTangent = this.tangentStack.some((s) => s.rec === old);
    // ...unless it is an untouched create({ fork }) copy (a /spec continuation that never spoke,
    // K1): nothing of its own, its parent holds that conversation and the rewind record the one
    // continued here, so it would stay behind as a pending duplicate (r5 S5); dropped while its
    // lock is still ours. Not while it holds a carry or restored history the rewind does not take
    // (G1 / G2: a reopen of it by id still delivers them), nor unless its parent record still
    // exists and holds every one of its turns: the continuation a /spec flow hands over outlives
    // its parent (the phase record discardSuperseded removed) and is then the only record of the
    // spec turns (r5 #2)
    if (this.untouchedFork === old && !parentOfTangent && !old.pendingContext?.length && old.pendingHistory === undefined && this.parentHolds(old)) {
      this.untouchedFork = undefined;
      this.dropRecord(old.sessionId);
      // the rewind record names the record that holds what it was cut from, never a dropped one
      rec.parentId = old.parentId;
      this.persist();
    }
    if (!parentOfTangent) oldLock?.release();
    this.todoMap.clear();
  }

  /** `rec`'s parent record still exists and holds every one of `rec`'s turns (by user uuid). */
  private parentHolds(rec: SessionRecord): boolean {
    if (!rec.parentId) return false;
    let parent: SessionRecord | undefined;
    try {
      parent = this.store.read(rec.parentId);
    } catch {
      return false;
    }
    if (!parent) return false;
    const held = new Set(parent.turns.map((t) => t.userUuid));
    return rec.turns.every((t) => held.has(t.userUuid));
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

  /**
   * What ran, from HookRunner.runManual's own pick (a Manual hook: exact name, then
   * case-insensitive), so the caller never decides from a same-named hook of another trigger or
   * file (F5). Its warnings (disabled, timed out, failed to start) are shown as notices.
   * `o.signal` (the REPL's command signal: Ctrl+C) kills a running command hook's process group,
   * also one with `timeout` 0 or that ignores SIGTERM: `cancelled` (G3/G4).
   */
  async runManualHook(name: string, o: { signal?: AbortSignal } = {}): Promise<ManualHookRun> {
    const r = await this.hookRunner.runManual({ ws: this.ws, sessionId: this.rec.sessionId, ...(o.signal ? { signal: o.signal } : {}) }, name);
    for (const w of r.warnings) this.uiNotice('warn', w.message);
    if (!r.found) return { kind: 'not-found' };
    if (r.aborted) return { kind: 'cancelled' };
    // an agent action's prompt is sent by the caller as its own user turn (03 §2.5); queuing it
    // here would hide it in front of whatever unrelated message comes next
    if (r.agentPrompt !== undefined) return { kind: 'agent', prompt: r.agentPrompt };
    if (r.output === undefined && r.exitCode === undefined) {
      // nothing ran: runManual answers a disabled hook with its warning only (F11); a command
      // that timed out or failed to start is still a command with no output
      const manual = this.hookRunner.hooks.filter((h) => h.trigger === 'Manual');
      const hook = manual.find((h) => h.name === name) ?? manual.find((h) => h.name.toLowerCase() === name.toLowerCase());
      if (hook && !hook.enabled) return { kind: 'disabled' };
    }
    return { kind: 'command', output: r.output ?? '' };
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

  /**
   * The current record holds no conversation of its own, so closing never leaves it in the index
   * (Q saves a conversation only after a reply): a main conversation that never had a message (no
   * turns, no messages and no prompt in its journal: a cleared one keeps its record, K4, a chat
   * whose only action was `/clear` or `/compact` does not), or a copy `create({ fork })` made that
   * never got anything of its own (its turns are its parent's, K1).
   * Tangents, rewinds and ACP / KiroCrew sessions are always kept. So is the continuation a
   * `/spec` flow hands to the chat (origin `repl`, SpecSessionDriver.finish): it is the user's
   * conversation, spec turns included, and `chat --resume` must reach it after a quit (r4 #5); only
   * a spec-phase copy (origin `spec`) is the duplicate.
   */
  private unusedRecord(): boolean {
    const r = this.rec;
    if (r.forkKind !== 'main' || r.origin === 'acp') return false;
    if (this.untouchedFork === r && r.origin === 'spec') return true;
    return recordNeverUsed(this.store.dir, r);
  }

  /**
   * The id `chat --resume-id` reopens this conversation with (KiroSession.resumeId): this
   * record's, unless close() dropped it (unusedRecord) — then the parent record of an untouched
   * spec-phase copy (it holds the same conversation) while that still exists, else undefined
   * (a chat that never had a message leaves nothing to resume).
   */
  resumeId(): string | undefined {
    const d = this.droppedOnClose;
    if (!d) return this.rec.sessionId;
    return d.copyOf && this.store.read(d.copyOf) ? d.copyOf : undefined;
  }

  /** Release everything without SessionEnd hooks (failed creation). */
  private async abandon(): Promise<void> {
    this.closed = true;
    this.hookAbort?.abort();
    await this.closeProc();
    // a record this call created never started: none of it stays (a fork's carries its parent's turns)
    if (this.fresh && (this.untouchedFork === this.rec || (this.rec.turns.length === 0 && this.rec.messageCount === 0))) this.dropRecord(this.rec.sessionId);
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
    // agentSpawn hooks still running (a start, /clear, /agent swap): nothing needs their output now
    this.hookAbort?.abort();
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
    // a line written just before this close (the REPL's forced stop) that the child never read:
    // what it carried goes back on the record saved below (S4; the turn's own end may come later)
    if (this.turn) this.settleUnreadLine(this.turn);
    // a quit inside a tangent of a main that never had a message (a chat whose only actions
    // were local commands: a /tangent needs a Claude conversation, not a message): main is
    // dropped like the current record would be, while its lock is still ours (r5 S4; the store's
    // prune of a left-behind record needs a stale lock, which this one would not have), and so is
    // each tangent of it that never had a message either, the current one included (r5 g1)
    const stackUnused: boolean[] = [];
    let below = true;
    for (const s of this.tangentStack) {
      below = below && recordNeverUsed(this.store.dir, s.rec, { tangent: stackUnused.length > 0 });
      stackUnused.push(below);
    }
    const unusedTangent = this.tangentStack.length > 0 && below && recordNeverUsed(this.store.dir, this.rec, { tangent: true });
    if ((this.unusedRecord() && this.tangentStack.length === 0) || unusedTangent) {
      // Q saves a conversation only after a reply: never leave an empty chat in the index
      this.droppedOnClose = { copyOf: this.untouchedFork === this.rec ? (this.rec.parentId ?? undefined) : undefined };
      this.dropRecord(this.rec.sessionId);
    } else {
      this.persist();
    }
    this.finalized = true;
    this.lock?.release();
    this.lock = undefined;
    for (const [i, s] of this.tangentStack.entries()) {
      if (stackUnused[i]) this.dropRecord(s.rec.sessionId);
      else {
        try {
          this.store.write(s.rec);
        } catch {
          /* ignore */
        }
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
 * rewriting suffices). An export without a transcript is opened by a reopen's rules (K2, see
 * {@link KiroSessionImpl.create}): a fork that had no message yet (`pendingFork`: Claude writes a
 * fork's transcript only with its first message) forks its source again, at its own point or the
 * record's last turn ({@link forkPointFor}); otherwise the exported Claude session, when it still
 * exists, is forked at the record's last turn (it may have run on since the export); otherwise a
 * fresh session gets the exported journal as context. An exported restored history still pending
 * (`pendingHistory`) is kept in every case (instead of the journal's, R4 #1). The record keeps
 * its turns in every case (a reopen does too): the journal is their history when Claude has none.
 * Trust is not carried
 * over (V3 behaviour); session context rules and plan mode are.
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
  let writtenTranscript: string | undefined;
  // the exported record's restored history still waiting for its next line (R4 #1): in neither
  // the exported transcript (which may hold only local commands of the fresh Claude session) nor
  // a fork of its Claude session, so the import keeps it; with no transcript at all it is the
  // history (one block: it holds at least what the journal does, see spawn's fallback)
  let pendingHistory = exported.pendingHistory;
  // (ids come from an untrusted file: only a UUID may name a transcript path)
  const hasTranscript = (id: string | undefined): id is string => !!id && UUID_RE.test(id) && !!findTranscript(id, { cwd: exported.cwd || ws.cwd, env });
  const pin = (): string | undefined => forkPointFor(exported.turns);
  if (transcript.trim() !== '') {
    const dest = transcriptPath(claudeId, ws.cwd, env);
    mkdirp(path.dirname(dest), 0o700);
    writeFileAtomic(dest, rewriteTranscriptSessionId(transcript, claudeId), { mode: 0o600 });
    writtenTranscript = dest;
    mode = { kind: 'resume' };
  } else if (exported.pendingFork && hasTranscript(exported.pendingFork.from)) {
    // a fork without a message (its own id has no transcript): fork its source again (S3)
    const at = exported.pendingFork.at ?? pin();
    mode = { kind: 'fork', from: exported.pendingFork.from, ...(at ? { at } : {}) };
  } else if (hasTranscript(exported.claudeSessionId)) {
    // at the exported record's last turn: the original may have run on since the export
    const at = pin();
    mode = { kind: 'fork', from: exported.claudeSessionId, ...(at ? { at } : {}) };
  } else {
    mode = { kind: 'new' };
    const history = pendingHistory === undefined ? journalHistoryText(parseJournal(journal)) : undefined;
    if (history) pendingHistory = restoredHistoryBlock(history);
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
      turns: exported.turns,
      messageCount: exported.messageCount,
      // a session saved in plan mode comes back in it: the gate keeps denying mutating tools (r4 #0)
      planMode: exported.planMode,
      // a tangent carry still waiting for this conversation's next prompt (F8): it is in neither
      // the transcript nor the journal; in mode 'new' it follows the restored-history block
      ...(exported.pendingContext?.length ? { pendingContext: exported.pendingContext } : {}),
      ...(pendingHistory !== undefined ? { pendingHistory } : {}),
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
      { rec, mode },
    );
  } catch (e) {
    // nothing of a failed import stays behind: index file, journal, re-keyed transcript
    cleanup(rec.sessionId);
    throw e;
  }
}
