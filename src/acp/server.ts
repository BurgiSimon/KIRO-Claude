/**
 * `kiro-claude acp` — an Agent Client Protocol server that is a drop-in for `kiro-cli acp`
 * (the kiro-cli v2 ACP dialect KiroCrew drives, as a superset of standard ACP v1 for Zed and
 * JetBrains). Binding references: research 05 (whole file) as corrected by 08 §0, §2.2,
 * §2.5–2.7 and §6; golden transcripts 08b §4 and KiroCrew's captured kiro-cli corpus.
 *
 * Launch surface (05 §2.1, 08 KC-CLI-02/10): `--agent`, `--model`, `--effort`,
 * `-a/--trust-all-tools`, `--trust-tools`, `--agent-engine v1|v2` (accepted, ignored; `v3`
 * exits 2 with a clap-style error), `--auth-method cli|client` (ignored), `--login`, `-v`,
 * `-h`. {@link ACP_HELP_TEXT} is the 05 §2.2 text verbatim (no `v3` anywhere).
 *
 * Process model (05 §1 items 9–10, 08 KC-ACP-15): one server serves many ACP sessions; each is
 * one {@link KiroSession} (`createSession` with origin `acp`, interactive, and this server's
 * permission bridge as UI) backed by its own `claude` child, spawned eagerly at `session/new`
 * (08 KC-ACP-02). Session files (`<sid>.json` + `<sid>.jsonl`) are written by the session
 * module; `session/load` replays the journal (see ./replay.ts). Per session, operations that
 * touch the conversation (`prompt`, `set_mode`, `set_model`, `set_config_option`,
 * `commands/execute`) run one at a time in arrival order (05 §3); `session/cancel`,
 * `_session/steer[/clear]` and `_kiro.dev/session/terminate` act immediately. A `session/cancel`
 * also answers `cancelled` for prompts received before it that have not started their turn yet
 * (queued, or waiting for the child to start); `$/cancel_request` cancels only its own prompt.
 * Concurrent `session/load`s of one id share one session; a session that finishes creating
 * after shutdown began is closed instead of registered (no orphaned `claude` child or lock).
 *
 * Cancelling commands and starts (C3). The 05 §4.6 "no turn running: ignore" leaves a Kiro
 * command (`commands/execute`, or one sent as prompt text) out, so a command waiting for Claude
 * Code (`usage()`: get_context_usage, `mcpStatus()` and the MCP init wait: mcp_status, the model
 * listing) is cancelled by `session/cancel`, its own `$/cancel_request` and the session's close
 * (the connection closing): it answers at once (`{success:false,message:"Command cancelled"}`, or
 * `stopReason:"cancelled"` as prompt text) and whatever its wait yields later is dropped (no MCP
 * notification, no message chunk). For `/clear` and an agent swap the cancel also interrupts the
 * session, which kills the agentSpawn hooks they run first (K3: it answers cancelled, nothing
 * changed; as prompt text: its message, then `stopReason:"cancelled"`, KC-ACP-07, never
 * `end_turn`); other commands that change state (`/model x`, `/effort x`) are not interrupted: they
 * finish and answer what they did. A command withdrawn by `$/cancel_request` while still queued
 * never runs. A `commands/execute compact` is cancelled by the same three: its compaction turn is
 * interrupted (status `failed`) and it answers `Command cancelled` once its status and metadata
 * frames are out (nothing of it follows the answer); a compaction Claude finished before the
 * cancel reached it (its compact_boundary seen) is `completed` and answers success. A mode change
 * (`session/set_mode`, `set_config_option` `mode`) is cancelled only by its own
 * `$/cancel_request` (`session/cancel` leaves it alone, 05 §4.6): queued, it never runs; during
 * the target agent's agentSpawn hooks they are killed (K3) and it answers `-32800`, the agent
 * unchanged; past them it finishes and answers what it did. Every session start
 * (`session/new|load`, the stuck-cancel restart) runs under a start signal
 * (session/startSignal.ts) that shutdown (stdin EOF, a signal) and the request's own cancel
 * abort: a start still running its agentSpawn hooks is cancelled, its hooks killed, and no record
 * or lock of it stays behind.
 *
 * Ordering (05 §3): every update a request produces is written before its response, except
 * where kiro-cli does otherwise: `/compact` answers `end_turn` first and then sends the
 * compaction status frames (05 §4.5.4); `session/new|load` answers first and then reports MCP
 * servers, a `_kiro.dev/metadata` and `available_commands_update` (08b §4.4); `_session/steer`
 * answers `{queued:true}` before its `AgentExecutionUserMessageQueued` notification.
 *
 * Compaction status (05 §4.5.4, §7.11; r5x X2): a manual `/compact` sends `started`, then
 * `completed{summary}` or `failed` with the reason. An automatic compaction inside a prompt turn
 * sends `started` when Claude starts it, `completed{summary}` once its summary is seen, or
 * `failed` when it did not compact: Claude reported it failed (the session's
 * `compaction_failed`), or it is still open when the turn ends (`Compaction cancelled` for a
 * cancelled turn). Every `started` gets its end before the prompt response, and the response is
 * what Claude answered (a failed compaction does not fail the turn). A `failed` frame carries the
 * reason in `summary` (05 §4.5.4) and also in `reason`, the key KiroCrew reads for the notice of
 * a failure inside a turn (KC acp/compaction_errors.py; kiro-cli sends no reason, so this is an
 * addition). An automatic compaction's `failed` goes out just before the session's next frame of
 * the turn, or before the response when nothing follows ({@link AcpServer.flushCompactionFailure});
 * a frame that answers the client (a steer queued or cleared) does not count. A compaction Claude
 * never ends is ended by the session at Claude's next output, so its `failed` precedes the answer.
 *
 * Permission flow (05 §6.1, 08 KC-ACP-11/12): the gate inside the session asks this server's
 * `requestApproval`; it makes sure the `tool_call` frame went out first, sends
 * `session/request_permission` with kiro-cli's three options and maps the outcome:
 * `allow_once` ⇒ allow-once, `allow_always` ⇒ allow-always (session trust), `reject_once` ⇒
 * deny with `User denied tool execution` and a failed update carrying
 * `toolCallFailureReason:"permission_denied"`, `cancelled` / failure ⇒ cancelled / deny.
 * Frames of a call the gate denied never carry the target file's current text (a `Write` diff's
 * `oldText` is read only for calls that may run), so a `deniedPaths` file cannot leak through
 * the client.
 *
 * Steering (05 §4.13): steers are held here and written to the session at the next tool
 * boundary — observed on the session's synchronous `'event'` stream, where Claude is still busy.
 * Claude (priority `next`) reads a line written there at the FOLLOWING tool boundary, or, after
 * the last tool, in a turn of its own right after the prompt's result, which the session keeps
 * inside the same prompt (VERIFIED 2.1.319, review C3). Injection is therefore reported as
 * `AgentExecutionSteeringInjected` when Claude starts the line (its `command_lifecycle`
 * `started`, right after the tool result update of the boundary that read it, as kiro-cli
 * reports it). Until then a written steer is still pending: `_session/steer/clear` drops the held
 * entries AND withdraws those from Claude's queue (control `cancel_async_message`), naming all of
 * them in one `AgentExecutionUserMessageCleared`. A steer still held when the turn ends is sent as
 * a continuation inside the same prompt request. Steers of a cancelled or failed turn — held, or
 * written but never started (the session's interrupt drops them from Claude's queue, review C2)
 * — are reported with `AgentExecutionUserMessageCleared`.
 *
 * Subagents (`_kiro.dev/subagent/list_update`, review C4): the current roster, one entry per
 * running Claude subagent in the shape KiroCrew reads (`sessionId` = the Agent tool use id,
 * `sessionName`, `agentName`/`role`, `initialQuery` = the task, `status {type,message}` with
 * `working` / `completed` / `failed`), with the parent's `sessionId` on top.
 *
 * Library rule: only JSON-RPC frames go to `ctx.stdout`; logs go to the log file
 * (`$KIRO_CHAT_LOG_FILE`, util/log) and a few warnings to `ctx.stderr`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type {
  ApprovalRequest,
  ApprovalResponse,
  CliContext,
  KiroAgent,
  KiroSession,
  KiroSessionOptions,
  KiroToolCall,
  McpStatusEntry,
  ModelEntry,
  PromptInput,
  SessionEvent,
  SessionUI,
  SubcommandRunner,
  TodoItem,
  ToolListingEntry,
  TurnResult,
  WorkspaceContext,
} from '../types.js';
import { KIRO_CLI_COMPAT_VERSION, KIRO_CLAUDE_VERSION } from '../version.js';
import { createWorkspaceContext } from '../config/workspace.js';
import { openSettings } from '../config/settings.js';
import { agentDirs, loadAgents, selectAgent, type LoadAgentsResult } from '../config/agents.js';
import { claudeServerName } from '../config/mcp.js';
import { expandPrompt, findPrompt, loadPrompts, parsePromptInvocation } from '../config/prompts.js';
import { buildModelList } from '../models/models.js';
import { SessionStore, isSafeSessionId, sessionsDir } from '../session/store.js';
import { isSessionStartCancelled, withStartSignal } from '../session/startSignal.js';
import { toKiroCall } from '../policy/toolmap.js';
import { findClaudeBinary } from '../claude/binary.js';
import { runAuthCommand } from '../claude/auth.js';
import { buildChildEnv } from '../claude/env.js';
import { createLogger, levelFromVerbosity, parseLogLevel, type Logger } from '../util/log.js';
import { ErrorCodes, JsonRpcConnection, RpcError, internalError, invalidParams, methodNotFound, respondThen, type RequestContext } from './jsonrpc.js';
import {
  CANCELLED_TEXT,
  EFFORT_LEVELS,
  KIRO_PERMISSION_OPTIONS,
  LIVE_FS,
  USER_DENIED_TEXT,
  abandonedUpdate,
  acpMcpServersToConfigs,
  configOptions,
  contextFromResult,
  deniedUpdate,
  describeToolCall,
  inProgressUpdate,
  invalidModelError,
  mapStopReason,
  modeState,
  modelState,
  permissionToolCall,
  planUpdate,
  promptToInput,
  promptUsage,
  resolveModelId,
  stripToolUseError,
  sumTurnUsage,
  toolCallUpdate,
  toolMeta,
  toolResultUpdates,
  trustOptionsFor,
  turnErrorToRpc,
  type ToolDescriptor,
} from './mapping.js';
import {
  argString,
  availableCommandsUpdate,
  contextText,
  helpText,
  invalidEffortResult,
  isAcpCommand,
  kiroMcpStatus,
  mcpResult,
  normalizeEffort,
  parseCommandParam,
  parseSlashText,
  toolsResult,
  usageText,
  ACP_COMMANDS,
  type CommandResult,
} from './commands.js';
import { buildReplay } from './replay.js';

// ───────────────────────────── help / flags ─────────────────────────────

/**
 * `kiro-claude acp --help` (05 §2.2 verbatim; 08 KC-CLI-02). KiroCrew parses the
 * `--agent-engine` block up to the next `\n      --` for `[possible values: …]` and treats any
 * `v3` substring as "this binary offers KAS", so the text must never contain it.
 */
export const ACP_HELP_TEXT = `Run kiro-claude as an Agent Client Protocol (ACP) agent over stdio

Usage: kiro-claude acp [OPTIONS]

Options:
      --agent-engine <ENGINE>
          Agent harness (accepted for compatibility; kiro-claude has one engine)

          [possible values: v1, v2]

      --auth-method <METHOD>
          Accepted for compatibility; Claude Code owns authentication

          [possible values: cli, client]

      --login
          Sign in to Claude Code in this terminal, then exit

      --agent <AGENT>
          Agent to start sessions with

      --model <MODEL>
          Model for new sessions

      --effort <LEVEL>
          Initial reasoning effort

          [possible values: low, medium, high, xhigh, max]

  -a, --trust-all-tools
          Allow every tool without confirmation

      --trust-tools <TOOLS>
          Comma-separated tools to allow without confirmation

  -v, --verbose...
          Increase logging verbosity

  -h, --help
          Print help
`;

const USAGE_LINE = 'Usage: kiro-claude acp [OPTIONS]';
const MORE_INFO = "For more information, try '--help'.";

/** Parsed `acp` flags. */
export interface AcpFlags {
  agent?: string;
  model?: string;
  effort?: string;
  trustAllTools: boolean;
  trustTools: string[];
  agentEngine?: string;
  authMethod?: string;
  login: boolean;
  verbose: number;
  help: boolean;
}

export type AcpFlagParse = { ok: true; flags: AcpFlags } | { ok: false; exitCode: number; stderr: string };

const VALUE_FLAGS: Record<string, { key: 'agent' | 'model' | 'effort' | 'trustTools' | 'agentEngine' | 'authMethod'; metavar: string; possible?: readonly string[] }> = {
  '--agent': { key: 'agent', metavar: '<AGENT>' },
  '--model': { key: 'model', metavar: '<MODEL>' },
  '--effort': { key: 'effort', metavar: '<LEVEL>', possible: EFFORT_LEVELS },
  '--trust-tools': { key: 'trustTools', metavar: '<TOOLS>' },
  '--agent-engine': { key: 'agentEngine', metavar: '<ENGINE>', possible: ['v1', 'v2'] },
  '--auth-method': { key: 'authMethod', metavar: '<METHOD>', possible: ['cli', 'client'] },
  '--authMethod': { key: 'authMethod', metavar: '<METHOD>', possible: ['cli', 'client'] },
};

function clapError(msg: string, withUsage = false): string {
  return `error: ${msg}\n\n${withUsage ? `${USAGE_LINE}\n\n` : ''}${MORE_INFO}\n`;
}

/** Parse `acp` arguments clap-style (05 §2.1; 08 KC-CLI-10 for `v3`). */
export function parseAcpFlags(args: readonly string[]): AcpFlagParse {
  const flags: AcpFlags = { trustAllTools: false, trustTools: [], login: false, verbose: 0, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      if (i + 1 < args.length) return { ok: false, exitCode: 2, stderr: clapError(`unexpected argument '${args[i + 1]}' found`, true) };
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(0, eq) : a;
      const spec = VALUE_FLAGS[name];
      if (spec) {
        let value: string | undefined;
        if (eq >= 0) value = a.slice(eq + 1);
        else if (i + 1 < args.length && !(args[i + 1]!.startsWith('-') && args[i + 1] !== '-')) value = args[++i];
        if (value === undefined) {
          return { ok: false, exitCode: 2, stderr: clapError(`a value is required for '${name === '--authMethod' ? '--auth-method' : name} ${spec.metavar}' but none was supplied`) };
        }
        if (spec.possible && !spec.possible.includes(value)) {
          const flagName = name === '--authMethod' ? '--auth-method' : name;
          const head = `error: invalid value '${value}' for '${flagName} ${spec.metavar}'\n  [possible values: ${spec.possible.join(', ')}]\n\n`;
          if (spec.key === 'agentEngine' && value === 'v3') {
            return { ok: false, exitCode: 2, stderr: `${head}kiro-claude has no v3 (KAS) agent engine.\n` };
          }
          return { ok: false, exitCode: 2, stderr: `${head}${MORE_INFO}\n` };
        }
        if (spec.key === 'trustTools') {
          flags.trustTools.push(...value.split(',').map((s) => s.trim()).filter((s) => s !== ''));
        } else {
          flags[spec.key] = value;
        }
        continue;
      }
      if (eq >= 0) return { ok: false, exitCode: 2, stderr: clapError(`unexpected argument '${a}' found`, true) };
      switch (a) {
        case '--trust-all-tools':
          flags.trustAllTools = true;
          continue;
        case '--login':
          flags.login = true;
          continue;
        case '--verbose':
          flags.verbose++;
          continue;
        case '--help':
          flags.help = true;
          continue;
        default:
          return { ok: false, exitCode: 2, stderr: clapError(`unexpected argument '${a}' found`, true) };
      }
    }
    if (a.startsWith('-') && a.length > 1) {
      for (const ch of a.slice(1)) {
        if (ch === 'a') flags.trustAllTools = true;
        else if (ch === 'v') flags.verbose++;
        else if (ch === 'h') flags.help = true;
        else return { ok: false, exitCode: 2, stderr: clapError(`unexpected argument '-${ch}' found`, true) };
      }
      continue;
    }
    return { ok: false, exitCode: 2, stderr: clapError(`unexpected argument '${a}' found`, true) };
  }
  return { ok: true, flags };
}

// ───────────────────────────── server ─────────────────────────────

/** Creates one KiroSession (default: `createSession` from src/session/kiroSession.ts). */
export type SessionFactory = (opts: KiroSessionOptions) => Promise<KiroSession>;

/**
 * `createSession` from the fixed Wave-2 entry point src/session/kiroSession.ts, loaded lazily so
 * `acp --help` and flag errors never load the engine (08 KC-BIN-05: fast probes).
 */
export const defaultSessionFactory: SessionFactory = async (opts) => {
  const mod = await import('../session/kiroSession.js');
  return mod.createSession(opts);
};

export interface AcpServerTimings {
  /** After `session/cancel`, answer `cancelled` at the latest after this (05 §4.6 step 5). */
  cancelGraceMs: number;
  /** Max wait for MCP servers to leave `pending` (08 KC-ACP-05: 30 s). */
  mcpWaitMs: number;
  /** MCP status poll interval. */
  mcpPollMs: number;
  /** Per-session close budget at shutdown / terminate (05 §2.5: 5 s). */
  closeTimeoutMs: number;
  /** Max wait for `usage()` when computing `_kiro.dev/metadata`. */
  usageTimeoutMs: number;
}

const DEFAULT_TIMINGS: AcpServerTimings = { cancelGraceMs: 10_000, mcpWaitMs: 30_000, mcpPollMs: 250, closeTimeoutMs: 5_000, usageTimeoutMs: 5_000 };

export interface AcpServerOptions {
  ctx: CliContext;
  flags?: Partial<AcpFlags>;
  /** Defaults to `ctx.stdin` / `ctx.stdout`. */
  input?: Readable;
  output?: Writable;
  createSession?: SessionFactory;
  logger?: Logger;
  timings?: Partial<AcpServerTimings>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const d = {} as Deferred<T>;
  d.settled = false;
  d.promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  d.resolve = (v) => {
    if (d.settled) return;
    d.settled = true;
    resolve(v);
  };
  d.reject = (e) => {
    if (d.settled) return;
    d.settled = true;
    reject(e);
  };
  return d;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.());

/** `p`, or undefined after `ms`; a rejection arriving after the timeout is swallowed (never unhandled). */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  p.catch(() => undefined);
  try {
    return await Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A command's wait was cancelled (`session/cancel`, `$/cancel_request`, the connection closing:
 * {@link AcpServer.cancelOp}); the command answers at once and drops whatever comes later (C3).
 */
class OpCancelledError extends Error {
  constructor() {
    super('Command cancelled');
    this.name = 'OpCancelledError';
  }
}

/** {@link AcpServer.runOp}'s answer for a cancelled command. */
const CANCELLED_OP: unique symbol = Symbol('cancelled-op');

/**
 * `p`, or an {@link OpCancelledError} as soon as `signal` aborts. A late settlement of `p` is
 * dropped (a rejection is swallowed, never unhandled): nothing waits for it any more.
 */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  p.catch(() => undefined);
  if (signal.aborted) return Promise.reject(new OpCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new OpCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** `sleep(ms)` that ends early (resolves) when `signal` aborts. */
function sleepUnless(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    t.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/** One signal that aborts when any of `signals` does (Node 18 has no `AbortSignal.any`); `dispose` unlinks. */
function eitherSignal(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const ac = new AbortController();
  const live = signals.filter((x): x is AbortSignal => x !== undefined);
  const onAbort = (): void => ac.abort();
  for (const x of live) {
    if (x.aborted) {
      ac.abort();
      break;
    }
    x.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: ac.signal, dispose: () => live.forEach((x) => x.removeEventListener('abort', onAbort)) };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

const sessionNotFound = (): RpcError => internalError('Session not found');

/** Per-turn bookkeeping. */
class TurnCtx {
  readonly abort = new AbortController();
  cancelled = false;
  detached = false;
  rawResult: Record<string, unknown> | undefined;
  assistantError: string | undefined;
  rateLimit: { status: string; rateLimitType?: string } | undefined;
  /** Auto-compaction finished but the summary has not been seen yet. */
  compactionPending = false;
  compactionSummary: string | undefined;
  compactionStarted = false;
  /**
   * The reason of an auto-compaction that failed (the session's `compaction_failed`), whose
   * `failed` status waits for the session's next frame or the turn's end (r5x X2, see
   * {@link AcpServer.flushCompactionFailure}).
   */
  compactionFailure: string | undefined;
  /** A manual compaction's compact_boundary was seen: Claude compacted the conversation. */
  compacted = false;
  readonly startedAt = Date.now();
  cancelTimer: NodeJS.Timeout | undefined;
  readonly cancelGrace = deferred<void>();
  /** Tool boundaries (`tool_end` / `tool_denied` ids) seen on the session's live `'event'` stream. */
  readonly liveBoundaries = new Set<string>();
  /**
   * Steers written at a live tool boundary to a session that did not say which Claude line they
   * became, announced once the generator reaches that boundary.
   */
  readonly liveInjected = new Map<string, { id: string; text: string }>();
  /**
   * Steers written to Claude (by user line uuid) that Claude has not started yet; `withdraw`
   * takes one back (`_session/steer/clear`), `clearing` while that is in flight.
   */
  readonly written = new Map<string, WrittenSteer>();
  /** The last two characters of answer text sent to the client since the last tool block. */
  textTail = '';
  /** The next answer text starts a new paragraph (a held-steer continuation's reply). */
  breakPending = false;

  /** `text` as sent to the client: a held-steer continuation's reply is its own paragraph. */
  joinText(text: string): string {
    if (this.breakPending) {
      this.breakPending = false;
      const sep = '\n'.repeat(Math.max(0, 2 - /\n*$/.exec(this.textTail)![0].length));
      text = sep + text;
    }
    this.textTail = (this.textTail + text).slice(-2);
    return text;
  }

  /** A tool block was sent: the client renders it as its own block, the text boundary is there. */
  toolBlock(): void {
    this.textTail = '';
    this.breakPending = false;
  }
}

/** A steer written to Claude and not read yet (see {@link TurnCtx.written}). */
interface WrittenSteer {
  ids: string[];
  text: string;
  withdraw: () => Promise<boolean>;
  clearing?: boolean;
}

/** One `_kiro.dev/subagent/list_update` roster entry (KiroCrew shape, see module doc). */
interface SubagentEntry {
  sessionId: string;
  sessionName: string;
  agentName: string;
  role: string;
  initialQuery: string;
  status: { type: 'working' | 'completed' | 'failed'; message: string };
}

/** One ACP session (see module doc). */
class AcpSessionState {
  ready: Promise<void> = Promise.resolve();
  startError: unknown;
  turn: TurnCtx | undefined;
  closed = false;
  steers: { id: string; text: string }[] = [];
  readonly tools = new Map<string, ToolDescriptor>();
  readonly finalized = new Set<string>();
  readonly denied = new Map<string, string>();
  readonly parentOf = new Map<string, string>();
  readonly subagents = new Map<string, SubagentEntry>();
  /** Ids for subagent events that carry no tool use id. */
  subagentSeq = 0;
  readonly mcpReported = new Set<string>();
  todos: TodoItem[] = [];
  manualCompaction = false;
  /**
   * Bumped by every `session/cancel`: a prompt that was received before the bump and has not
   * started its turn yet (queued behind another prompt, or waiting for the child to start) is
   * answered `cancelled` without running (05 §4.6, 08 KC-ACP-07).
   */
  cancelEpoch = 0;
  /** JSON-RPC id of the `session/prompt` whose job is running (for `$/cancel_request`). */
  activePrompt: string | number | undefined;
  /**
   * The command running in this session's queue (`commands/execute`, or a Kiro command sent as
   * prompt text): aborted by `session/cancel`, its own `$/cancel_request` and the session's close,
   * which end its waits for Claude Code at once (C3, {@link AcpServer.cancelOp}). `interrupt`:
   * the cancel also interrupts the session (a `/clear` or agent swap: kills its agentSpawn hooks).
   */
  op: { abort: AbortController; interrupt: boolean } | undefined;
  /** Listener on the session's synchronous `'event'` stream (see {@link AcpServer.onLiveEvent}). */
  liveListener: ((ev: SessionEvent) => void) | undefined;
  /**
   * Claude MCP server name ⇒ Kiro server name (`kc_mcp` ⇒ `kc.mcp`), learned from the session's
   * MCP status / tool listing and from the calls it maps itself. Used where this server builds a
   * call from a raw Claude name: subagent inner calls and `session/load` replay.
   */
  readonly mcpNames = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly id: string,
    /** Replaced (same id) when a stuck `claude` child is torn down after a cancel (05 §4.6 step 5). */
    public session: KiroSession,
    readonly ws: WorkspaceContext,
    /** The options this session was created with (`session/new|load`), for re-creating it. */
    readonly createOpts: KiroSessionOptions,
  ) {}

  /** Run `job` after every earlier queued job (errors do not break the chain). */
  enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Await `start()`; a failed start is reported to every later operation. */
  async whenReady(): Promise<void> {
    try {
      await this.ready;
    } catch (e) {
      throw internalError(`Failed to start the session: ${errMessage(e)}`);
    }
  }
}

/** The ACP server (see module doc). */
export class AcpServer {
  readonly conn: JsonRpcConnection;
  private readonly ctx: CliContext;
  private readonly flags: AcpFlags;
  private readonly factory: SessionFactory;
  private readonly log: Logger;
  private readonly timings: AcpServerTimings;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessions = new Map<string, AcpSessionState>();
  /** In-flight `session/prompt` request id ⇒ session id (for `$/cancel_request`). */
  private readonly promptRequests = new Map<string | number, string>();
  private clientInfo: Record<string, unknown> | undefined;
  private clientCapabilities: Record<string, unknown> | undefined;
  private stopping = false;
  /** `session/load`s still creating their session, by id (a second load waits and re-attaches). */
  private readonly loading = new Map<string, Promise<unknown>>();
  /** Session closes still running (awaited by {@link serve} before it returns). */
  private readonly closing = new Set<Promise<void>>();
  /**
   * Aborted when shutdown begins (stdin EOF, {@link stop}): the start signal of every session this
   * server creates (session/startSignal.ts, K3). A start still running its agentSpawn hooks then is
   * cancelled (the hooks are killed, the fresh record removed, the lock released) instead of
   * finishing into a session nobody uses (C3).
   */
  private readonly stopAbort = new AbortController();
  /** Session creations still running (awaited by {@link serve} before it returns). */
  private readonly creating = new Set<Promise<unknown>>();

  constructor(opts: AcpServerOptions) {
    this.ctx = opts.ctx;
    this.flags = { trustAllTools: false, trustTools: [], login: false, verbose: 0, help: false, ...opts.flags };
    this.factory = opts.createSession ?? defaultSessionFactory;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.env = { ...opts.ctx.ws.env };
    // never forwarded to Claude children (08 KC-ENV-01)
    delete this.env.KIRO_API_KEY;
    this.log =
      opts.logger ??
      createLogger({
        env: opts.ctx.ws.env,
        level: parseLogLevel(opts.ctx.ws.env.KIRO_LOG_LEVEL) ?? levelFromVerbosity((opts.ctx.verbosity ?? 0) + this.flags.verbose),
      });
    this.conn = new JsonRpcConnection({
      input: opts.input ?? opts.ctx.stdin,
      output: opts.output ?? opts.ctx.stdout,
      onRequest: (m, p, c) => this.onRequest(m, p, c),
      onNotification: (m, p) => this.onNotification(m, p),
      logger: this.log,
    });
  }

  /** `initialize.clientCapabilities` of the connected client (fs/terminal are never used, 05 §6.2). */
  get client(): { info?: Record<string, unknown>; capabilities?: Record<string, unknown> } {
    return { ...(this.clientInfo ? { info: this.clientInfo } : {}), ...(this.clientCapabilities ? { capabilities: this.clientCapabilities } : {}) };
  }

  /** Live ACP session ids. */
  get sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Serve until the input ends (or {@link stop}), then shut every session down. */
  async serve(): Promise<void> {
    this.log.info(`acp: kiro-claude ${KIRO_CLAUDE_VERSION} serving (agent=${this.flags.agent ?? '-'}, client app=${this.env.KIRO_CLI_CLIENT_APPLICATION ?? '-'})`);
    if (this.flags.authMethod) this.log.info(`acp: --auth-method ${this.flags.authMethod} ignored (Claude Code owns authentication)`);
    if (this.flags.agentEngine) this.log.debug(`acp: --agent-engine ${this.flags.agentEngine} accepted (single engine)`);
    this.warnAboutSandbox();
    await this.conn.start();
    await this.shutdown();
    // let cancelled prompts and other in-flight requests write their answers (stdout may still be read)
    const end = Date.now() + 2000;
    while (!this.conn.closed && this.conn.inFlightRequestIds.length > 0 && Date.now() < end) await sleep(10);
    this.conn.close();
    // a creation cancelled by the stop signal leaves nothing (bounded: a spawn of Claude Code
    // already under way ends within its initialize timeout, and is then closed by its handler)
    if (this.creating.size > 0) await withTimeout(Promise.allSettled([...this.creating]), this.timings.closeTimeoutMs);
    // sessions that finished creating after shutdown began are closed by their handlers
    while (this.closing.size > 0) await Promise.allSettled([...this.closing]);
  }

  /** Stop serving (signal handlers): closes the connection; {@link serve} then shuts down. */
  stop(): void {
    this.stopAbort.abort();
    this.conn.close();
  }

  /**
   * `this.factory(opts)` under the start signal (session/startSignal.ts): the server's stop
   * signal and, for `session/new|load`, the request's own (`$/cancel_request`, the connection
   * closing). A cancelled start leaves nothing behind (C3). For a request (`rpc`) a failure is a
   * JSON-RPC error (a cancelled start: `Server is shutting down` / `Request cancelled`); without
   * it the factory's own error is passed on.
   */
  private async createUnderStop(opts: KiroSessionOptions, request?: AbortSignal, rpc = true): Promise<KiroSession> {
    const start = eitherSignal([this.stopAbort.signal, request]);
    const job = withStartSignal(start.signal, () => this.factory(opts));
    this.creating.add(job);
    try {
      return await job;
    } catch (e) {
      if (!rpc) throw e;
      if (isSessionStartCancelled(e) || (start.signal.aborted && !(e instanceof RpcError))) {
        if (this.stopping || this.stopAbort.signal.aborted) throw internalError('Server is shutting down');
        throw new RpcError(ErrorCodes.REQUEST_CANCELLED, 'Request cancelled', errMessage(e));
      }
      if (e instanceof RpcError) throw e;
      throw internalError(errMessage(e));
    } finally {
      start.dispose();
      this.creating.delete(job);
      job.catch(() => undefined);
    }
  }

  /** Cancel turns and close every session (≤ closeTimeoutMs each, in parallel). */
  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.stopAbort.abort();
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((st) => this.closeSession(st)));
  }

  /**
   * A session finished creating while the server is shutting down (stdin EOF / SIGTERM during
   * `session/new|load`): close it (child, lock) instead of registering it, and fail the request.
   */
  private async discardLate(session: KiroSession): Promise<never> {
    await this.closeLate(session);
    throw internalError('Server is shutting down');
  }

  /** Close a session nobody will use (tracked so {@link serve} waits for it). */
  private async closeLate(session: KiroSession): Promise<void> {
    const p = (async () => {
      try {
        await withTimeout(session.close(), this.timings.closeTimeoutMs);
      } catch (e) {
        this.log.warn('acp: closing a late session failed:', e);
      }
    })();
    this.closing.add(p);
    try {
      await p;
    } finally {
      this.closing.delete(p);
    }
  }

  private warnAboutSandbox(): void {
    // 05 §2.6: KiroCrew skips its own sandbox when kiro-cli claims an internal one.
    try {
      const p = path.join(this.ctx.ws.kiroHome, 'settings', 'amazon-internal.json');
      const v = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
      if (isObj(v) && v.sandbox === true) {
        const msg = `kiro-claude acp: warning: ${p} sets "sandbox": true, but kiro-claude has no internal sandbox; KiroCrew may skip its own sandbox for this backend.\n`;
        this.ctx.stderr.write(msg);
        this.log.warn(msg.trim());
      }
    } catch {
      // absent / unreadable: nothing to warn about
    }
  }

  // ───────────── dispatch ─────────────

  private onRequest(method: string, params: unknown, rc: RequestContext): unknown {
    const p = isObj(params) ? params : {};
    this.log.debug(`acp: ← ${method}`);
    switch (method) {
      case 'initialize':
        return this.initialize(p);
      case 'authenticate':
        return {};
      case 'session/new':
        return this.sessionNew(p, rc);
      case 'session/load':
        return this.sessionLoad(p, rc);
      case 'session/prompt':
        return this.sessionPrompt(p, rc);
      case 'session/cancel':
        this.cancel(str(p.sessionId));
        return {};
      case 'session/set_mode':
        return this.setMode(p, rc);
      case 'session/set_model':
        return this.setModel(p);
      case 'session/set_config_option':
        return this.setConfigOption(p, rc);
      case 'session/list':
        return this.sessionList(p);
      case 'session/close':
      case '_kiro.dev/session/terminate':
      case '_session/terminate':
        return this.terminate(str(p.sessionId));
      case '_kiro.dev/commands/execute':
        return this.commandsExecute(p, rc);
      case '_kiro.dev/commands/options':
        return this.commandsOptions(p);
      case '_session/steer':
        return this.steer(p);
      case '_session/steer/clear':
        return this.steerClear(p);
      default:
        throw methodNotFound(method);
    }
  }

  private onNotification(method: string, params: unknown): void {
    const p = isObj(params) ? params : {};
    switch (method) {
      case 'session/cancel':
        this.cancel(str(p.sessionId));
        return;
      case '$/cancel_request': {
        // A queued prompt is cancelled through its request signal (aborted by the transport);
        // only the running one needs its turn interrupted (05 §4.14).
        const rid = p.requestId;
        if (typeof rid === 'string' || typeof rid === 'number') {
          const sid = this.promptRequests.get(rid);
          const st = sid !== undefined ? this.sessions.get(sid) : undefined;
          if (st && st.activePrompt === rid) this.cancelTurn(st);
        }
        return;
      }
      case '_session/terminate':
        void this.terminate(str(p.sessionId));
        return;
      default:
        this.log.debug(`acp: ignored notification ${method}`);
    }
  }

  private update(sessionId: string, update: Record<string, unknown>): void {
    this.flushCompactionFailure(sessionId);
    this.conn.notify('session/update', { sessionId, update });
  }

  /**
   * `release` false: a frame that answers the client during the turn (a steer queued or cleared),
   * not one of Claude's: it does not release a held compaction failure (r5x X2 verifier: sent
   * with it during Claude's silence after the failure, it would start KiroCrew's 60 s
   * post-failure clock there).
   */
  private kiroUpdate(sessionId: string, update: Record<string, unknown>, release = true): void {
    if (release) this.flushCompactionFailure(sessionId);
    this.conn.notify('_kiro.dev/session/update', { sessionId, update });
  }

  /** `_kiro.dev/compaction/status` `failed`: the reason in `summary` (05 §4.5.4) and `reason`. */
  private notifyCompactionFailed(sessionId: string, reason: string): void {
    this.conn.notify('_kiro.dev/compaction/status', { sessionId, status: { type: 'failed' }, summary: reason, reason });
  }

  /**
   * r5x X2: the `failed` status of an auto-compaction that failed inside a prompt turn goes out
   * just before the session's next frame of that turn (or at its end, {@link settleAutoCompaction}),
   * not when Claude reports it. KiroCrew reads a `failed` inside a turn as the start of a 60 s
   * post-failure budget: no frame for 60 s (and no tool in flight) and it ends the turn itself as
   * `error: compaction failed`, resetting the session (KC acp/client_turn.py,
   * acp/session_handle_dispatch.py `_COMPACTION_FAILED_TURN_BUDGET`). Claude goes on after a failed
   * auto-compaction, and the request that follows can be silent for a long time (a long context,
   * API retries); sent with the frame that ends that silence, the failure never makes KiroCrew
   * abandon a turn that is still running. The order stays what happened: what came before the
   * failure, the failure, the answer after it (the dashboard drops text streamed before a
   * compaction terminal and keeps the text after it, KC dashboard/chat_turn/session_events.py).
   */
  private flushCompactionFailure(sessionId: string): void {
    const turn = this.sessions.get(sessionId)?.turn;
    const reason = turn?.compactionFailure;
    if (turn === undefined || reason === undefined) return;
    turn.compactionFailure = undefined;
    this.notifyCompactionFailed(sessionId, reason);
  }

  private getSession(sessionId: unknown): AcpSessionState {
    const id = str(sessionId);
    const st = id !== undefined ? this.sessions.get(id) : undefined;
    if (!st || st.closed) throw sessionNotFound();
    return st;
  }

  // ───────────── initialize ─────────────

  /** 05 §4.1 as corrected by 08 KC-ACP-01 (static, fast; `agentInfo.version` = compat version). */
  private initialize(p: Record<string, unknown>): Record<string, unknown> {
    if (isObj(p.clientInfo)) this.clientInfo = p.clientInfo;
    if (isObj(p.clientCapabilities)) this.clientCapabilities = p.clientCapabilities;
    this.log.info(`acp: initialize from ${str(this.clientInfo?.name) ?? 'unknown client'} (protocolVersion ${JSON.stringify(p.protocolVersion)})`);
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {}, close: {} },
      },
      authMethods: [],
      agentInfo: { name: 'kiro-claude', title: `kiro-claude ${KIRO_CLAUDE_VERSION} (Claude Code)`, version: KIRO_CLI_COMPAT_VERSION },
    };
  }

  // ───────────── session creation ─────────────

  private sessionWs(cwd: unknown): WorkspaceContext {
    if (typeof cwd !== 'string' || cwd === '' || !path.isAbsolute(cwd)) throw invalidParams('cwd must be an absolute path');
    try {
      if (!fs.statSync(cwd).isDirectory()) throw invalidParams(`cwd is not a directory: ${cwd}`);
    } catch (e) {
      if (e instanceof RpcError) throw e;
      throw invalidParams(`cwd does not exist: ${cwd}`);
    }
    return createWorkspaceContext(cwd, this.env);
  }

  /**
   * Resolve the agent for a new/loaded session: the requested one (process `--agent`, V3
   * `_meta.kiro.modeId`, or the stored agent) must exist — a missing or broken spec is an error
   * naming the file, never a silent fallback (08 KC-ACP-02, Guard A2) — else `chat.defaultAgent`,
   * else `kiro_default`.
   */
  private resolveAgent(ws: WorkspaceContext, requested: string | undefined): { name: string; loaded: LoadAgentsResult } {
    const settings = openSettings(ws);
    const loaded = loadAgents(ws, { settings });
    if (requested) {
      const found = loaded.agents.get(requested);
      // a type error (`agent validate` rejects it, KC-CLI-09) is a broken spec too
      const typeError = found?.warnings.find((w) => w.code === 'invalid-field' || w.code === 'invalid-agent');
      if (found && typeError) throw internalError(`Failed to load agent '${requested}'${found.path ? ` from ${found.path}` : ''}: ${typeError.message}`);
      if (found) return { name: requested, loaded };
      const failed = loaded.failed.get(requested);
      if (failed) {
        throw internalError(`Failed to load agent '${requested}'${failed.path ? ` from ${failed.path}` : ''}: ${failed.message}`);
      }
      const dirs = agentDirs(ws);
      throw internalError(
        `Agent '${requested}' not found: no ${path.join(dirs.workspace, `${requested}.json`)} or ${path.join(dirs.global, `${requested}.json`)} (or .md)`,
      );
    }
    const sel = selectAgent(ws, loaded.agents, settings, undefined);
    return { name: sel.agent.name, loaded };
  }

  private makeUi(holder: { st?: AcpSessionState }): SessionUI {
    return {
      requestApproval: (req, signal) => this.requestApproval(holder.st, req, signal),
      notice: (level, message) => {
        if (level === 'error') this.log.error(`acp[${holder.st?.id ?? '-'}]: ${message}`);
        else if (level === 'warn') this.log.warn(`acp[${holder.st?.id ?? '-'}]: ${message}`);
        else this.log.info(`acp[${holder.st?.id ?? '-'}]: ${message}`);
      },
    };
  }

  private baseSessionOptions(ws: WorkspaceContext, ui: SessionUI, p: Record<string, unknown>): KiroSessionOptions {
    const o: KiroSessionOptions = { ws, origin: 'acp', interactive: true, ui, env: this.env };
    if (this.flags.trustAllTools) o.trustAllTools = true;
    if (this.flags.trustTools.length) o.trustTools = [...this.flags.trustTools];
    if (Array.isArray(p.additionalDirectories)) {
      const dirs = p.additionalDirectories.filter((d): d is string => typeof d === 'string' && path.isAbsolute(d));
      if (dirs.length) o.additionalDirectories = dirs;
    }
    return o;
  }

  private async listModels(st: AcpSessionState): Promise<ModelEntry[]> {
    try {
      const m = await withTimeout(st.session.listModels(), 3000);
      if (m && m.length) return m;
    } catch (e) {
      this.log.debug('acp: listModels failed:', e);
    }
    return buildModelList();
  }

  private async sessionState(st: AcpSessionState, agents?: Iterable<KiroAgent>): Promise<Record<string, unknown>> {
    const list = agents ?? loadAgents(st.ws, { settings: openSettings(st.ws) }).agents.values();
    const entries = await this.listModels(st);
    return {
      modes: modeState(list, st.session.agent.name),
      models: modelState(entries, st.session.model),
      configOptions: configOptions(entries, st.session.model, st.session.effort),
    };
  }

  /** `session/new` (05 §4.3, 08 KC-ACP-02). */
  private async sessionNew(p: Record<string, unknown>, rc: RequestContext): Promise<unknown> {
    const ws = this.sessionWs(p.cwd);
    const { servers, warnings } = acpMcpServersToConfigs(p.mcpServers);
    for (const w of warnings) this.log.warn(`acp: ${w}`);
    const kmeta = isObj(p._meta) && isObj(p._meta.kiro) ? p._meta.kiro : {};
    const { name, loaded } = this.resolveAgent(ws, str(kmeta.modeId) ?? this.flags.agent);
    const holder: { st?: AcpSessionState } = {};
    const opts = this.baseSessionOptions(ws, this.makeUi(holder), p);
    opts.agentName = name;
    const model = str(kmeta.modelId) ?? this.flags.model;
    if (model) opts.model = model;
    const effort = normalizeEffort(str(kmeta.effortLevel)) ?? this.flags.effort;
    if (effort) opts.effort = effort;
    if (servers.length) opts.extraMcpServers = servers;
    const session = await this.createUnderStop(opts, rc.signal);
    if (this.stopping) return this.discardLate(session);
    const st = new AcpSessionState(session.id, session, ws, opts);
    holder.st = st;
    this.attachLive(st);
    this.sessions.set(st.id, st);
    // eager spawn (08 KC-ACP-02): the child starts while we answer
    st.ready = session.start();
    st.ready.catch((e) => {
      st.startError = e;
      this.log.error(`acp[${st.id}]: start failed:`, e);
    });
    const state = await this.sessionState(st, loaded.agents.values());
    this.log.info(`acp: session/new ${st.id} agent=${st.session.agent.name} cwd=${ws.cwd}`);
    return respondThen({ sessionId: st.id, ...state }, () => this.afterSessionStart(st, 0));
  }

  /** After `session/new|load`: MCP reports, `_kiro.dev/metadata`, available commands (08b §4.4). */
  private async afterSessionStart(st: AcpSessionState, pct: number | undefined): Promise<void> {
    try {
      await st.ready;
    } catch {
      return;
    }
    if (st.closed) return;
    await this.reportMcp(st);
    if (st.closed) return;
    let percent = pct;
    if (percent === undefined) percent = (await this.contextNumbers(st)).pct ?? 0;
    this.conn.notify('_kiro.dev/metadata', { sessionId: st.id, contextUsagePercentage: percent });
    this.update(st.id, availableCommandsUpdate(loadPrompts(st.ws)));
  }

  /**
   * `_kiro.dev/mcp/server_initialized` / `server_init_failure` once per server as soon as
   * Claude reports it connected / failed (08 KC-ACP-04); polls while servers are pending. With
   * `signal` (a command's, C3) an abort ends the wait at once with {@link OpCancelledError}, and
   * an answer that arrives after it reports nothing.
   */
  private async reportMcp(st: AcpSessionState, signal?: AbortSignal): Promise<McpStatusEntry[]> {
    const deadline = Date.now() + this.timings.mcpWaitMs;
    let last: McpStatusEntry[] = [];
    for (;;) {
      if (st.closed) return last;
      try {
        last = await untilAborted(st.session.mcpStatus(), signal);
      } catch (e) {
        if (e instanceof OpCancelledError) throw e;
        this.log.debug('acp: mcpStatus failed:', e);
        return last;
      }
      this.learnMcpNames(st, last);
      let pending = false;
      for (const s of last) {
        const k = kiroMcpStatus(s.status);
        if (k === 'loading') {
          pending = true;
          continue;
        }
        if (st.mcpReported.has(s.name) || k === 'disabled') continue;
        st.mcpReported.add(s.name);
        if (k === 'running') this.conn.notify('_kiro.dev/mcp/server_initialized', { sessionId: st.id, serverName: s.name });
        else {
          const error = s.error ?? (s.status === 'needs-auth' ? 'needs authentication; run `claude mcp` to authenticate' : `status: ${s.status}`);
          this.conn.notify('_kiro.dev/mcp/server_init_failure', { sessionId: st.id, serverName: s.name, error });
        }
      }
      if (!pending || Date.now() >= deadline) return last;
      await sleepUnless(this.timings.mcpPollMs, signal);
      if (signal?.aborted) throw new OpCancelledError();
    }
  }

  /** Learn the exact Claude ⇄ Kiro MCP server pair of a call the session mapped itself. */
  private learnMcpCall(st: AcpSessionState, call: KiroToolCall): void {
    if (!call.mcp) return;
    const claude = claudeMcpServerOf(call.claudeName, call.mcp.tool);
    if (claude !== undefined) st.mcpNames.set(claude, call.mcp.server);
  }

  /**
   * Refresh {@link AcpSessionState.mcpNames}: exact pairs from the session's tool listing; for
   * servers without a listed tool yet, Claude's name rule (`[^A-Za-z0-9_-]` ⇒ `_`) applied to the
   * Kiro names in `statuses` where that is unambiguous (colliding names get numeric suffixes
   * assigned in launch order, which only the exact sources know).
   */
  private learnMcpNames(st: AcpSessionState, statuses?: readonly McpStatusEntry[]): void {
    let listing: ToolListingEntry[] = [];
    try {
      listing = st.session.toolListing();
    } catch (e) {
      this.log.debug('acp: toolListing failed:', e);
    }
    for (const e of listing) {
      if (e.source !== 'mcp' || !e.server || !e.name.startsWith(`@${e.server}/`)) continue;
      const claude = claudeMcpServerOf(e.claudeName, e.name.slice(e.server.length + 2));
      if (claude !== undefined) st.mcpNames.set(claude, e.server);
    }
    if (!statuses) return;
    const kiroNames = new Set(statuses.map((s) => s.name));
    const byClaude = new Map<string, string[]>();
    for (const n of kiroNames) {
      const c = claudeServerName(n);
      if (c !== n) byClaude.set(c, [...(byClaude.get(c) ?? []), n]);
    }
    for (const [c, kiro] of byClaude) {
      if (kiro.length === 1 && !kiroNames.has(c) && !st.mcpNames.has(c)) st.mcpNames.set(c, kiro[0]!);
    }
  }

  /**
   * `session/load` (05 §4.4, 08 KC-ACP-10): replay, then respond with modes/models. A load of a
   * session that is live in this process re-attaches (no new child, still replays); a load that
   * arrives while another load of the same id is still starting waits for it and re-attaches,
   * so one ACP session id never gets two `claude` children.
   */
  private async sessionLoad(p: Record<string, unknown>, rc: RequestContext): Promise<unknown> {
    const sessionId = str(p.sessionId);
    if (!sessionId) throw invalidParams('sessionId is required');
    const ws = this.sessionWs(p.cwd);
    const inflight = this.loading.get(sessionId);
    if (inflight) await inflight.catch(() => undefined);
    const live = this.sessions.get(sessionId);
    if (live && !live.closed) {
      return live.enqueue(async () => {
        if (live.closed) throw sessionNotFound();
        await live.whenReady();
        this.replay(live, live.session.claudeSessionId ?? live.session.record.claudeSessionId);
        const state = await this.sessionState(live);
        return respondThen(state, () => this.afterSessionStart(live, undefined));
      });
    }
    if (!isSafeSessionId(sessionId)) throw internalError('Session not found');
    const job = this.loadFresh(sessionId, ws, p, rc.signal);
    this.loading.set(sessionId, job);
    try {
      return await job;
    } finally {
      if (this.loading.get(sessionId) === job) this.loading.delete(sessionId);
    }
  }

  private async loadFresh(sessionId: string, ws: WorkspaceContext, p: Record<string, unknown>, request: AbortSignal): Promise<unknown> {
    const dir = sessionsDir(ws);
    const rec = new SessionStore(dir).read(sessionId);
    if (!rec) throw internalError('Session not found');
    const { servers, warnings } = acpMcpServersToConfigs(p.mcpServers);
    for (const w of warnings) this.log.warn(`acp: ${w}`);
    // the process --agent wins (KiroCrew's Guard A2 compares currentModeId with it); else the stored agent
    const { name, loaded } = this.resolveAgent(ws, this.flags.agent ?? (rec.agent || undefined));
    const holder: { st?: AcpSessionState } = {};
    const opts = this.baseSessionOptions(ws, this.makeUi(holder), p);
    opts.agentName = name;
    opts.resume = { sessionId };
    if (rec.model) opts.model = rec.model;
    if (rec.effort) opts.effort = rec.effort;
    if (!opts.additionalDirectories && rec.additionalDirectories.length) opts.additionalDirectories = [...rec.additionalDirectories];
    if (servers.length) opts.extraMcpServers = servers;
    const session = await this.createUnderStop(opts, request);
    if (this.stopping) return this.discardLate(session);
    if (session.id !== sessionId) this.log.warn(`acp: session/load ${sessionId}: the session module answered id ${session.id}; keeping the client's id`);
    const st = new AcpSessionState(sessionId, session, ws, opts);
    holder.st = st;
    this.attachLive(st);
    st.ready = session.start();
    try {
      await st.ready;
    } catch (e) {
      // e.g. "Session is active in another process" — KiroCrew retries on that text
      if (st.liveListener) session.off('event', st.liveListener);
      try {
        await withTimeout(session.close(), this.timings.closeTimeoutMs);
      } catch {
        // ignore
      }
      throw internalError(errMessage(e));
    }
    // MCP server names for the replayed calls, mapped as the live path maps them (`kc_mcp` ⇒ `kc.mcp`)
    try {
      this.learnMcpNames(st, await withTimeout(session.mcpStatus(), this.timings.usageTimeoutMs));
    } catch (e) {
      this.log.debug('acp: mcpStatus before replay failed:', e);
    }
    if (this.stopping) {
      if (st.liveListener) session.off('event', st.liveListener);
      return this.discardLate(session);
    }
    this.sessions.set(st.id, st);
    this.replay(st, session.claudeSessionId ?? rec.claudeSessionId);
    const state = await this.sessionState(st, loaded.agents.values());
    this.log.info(`acp: session/load ${st.id} agent=${st.session.agent.name}`);
    return respondThen(state, () => this.afterSessionStart(st, undefined));
  }

  private replay(st: AcpSessionState, claudeSessionId: string | undefined): void {
    this.learnMcpNames(st);
    const { updates, source } = buildReplay({
      sessionsDir: sessionsDir(st.ws),
      sessionId: st.id,
      ...(claudeSessionId ? { claudeSessionId } : {}),
      cwd: st.ws.cwd,
      env: this.env,
      mcpServerNames: Object.fromEntries(st.mcpNames),
    });
    this.log.debug(`acp: replaying ${updates.length} updates from ${source} for ${st.id}`);
    for (const u of updates) this.update(st.id, u);
  }

  // ───────────── list / terminate ─────────────

  /** `session/list` (05 §4.10, P2): our session index, newest first, 50 per page. */
  private sessionList(p: Record<string, unknown>): Record<string, unknown> {
    const store = new SessionStore(sessionsDir(this.ctx.ws));
    const cwd = str(p.cwd);
    const recs = store.list(cwd && path.isAbsolute(cwd) ? { cwd } : {});
    const offset = Math.max(0, Number.parseInt(str(p.cursor) ?? '0', 10) || 0);
    const page = recs.slice(offset, offset + 50);
    const out: Record<string, unknown> = {
      sessions: page.map((r) => ({ sessionId: r.sessionId, cwd: r.cwd, ...(r.title ? { title: r.title } : {}), updatedAt: r.updatedAt })),
    };
    if (offset + 50 < recs.length) out.nextCursor = String(offset + 50);
    return out;
  }

  /** `_kiro.dev/session/terminate` (05 §4.11, 08 KC-ACP-09): evict, keep files, idempotent. */
  private async terminate(sessionId: string | undefined): Promise<Record<string, unknown>> {
    if (!sessionId) return {};
    const st = this.sessions.get(sessionId);
    if (!st) return {};
    this.sessions.delete(sessionId);
    await this.closeSession(st);
    this.log.info(`acp: terminated ${sessionId}`);
    return {};
  }

  private async closeSession(st: AcpSessionState): Promise<void> {
    if (st.closed) return;
    st.closed = true;
    // a command waiting for Claude Code answers now (C3), not when the child is gone
    st.op?.abort.abort();
    const turn = st.turn;
    if (turn) {
      turn.cancelled = true;
      turn.abort.abort();
      try {
        await withTimeout(st.session.interrupt(), 1000);
      } catch {
        // ignore
      }
    }
    st.steers = [];
    try {
      await withTimeout(st.session.close(), this.timings.closeTimeoutMs);
    } catch (e) {
      this.log.warn(`acp[${st.id}]: close failed:`, e);
    }
    if (st.liveListener) st.session.off('event', st.liveListener);
  }

  // ───────────── modes / models / config ─────────────

  private async swapTo(st: AcpSessionState, modeId: string): Promise<void> {
    const agents = loadAgents(st.ws, { settings: openSettings(st.ws) });
    const target = agents.agents.get(modeId);
    if (!target) throw internalError(`Mode '${modeId}' not found`);
    // a spec with type errors is rejected here too, like on session/new (`agent validate`, KC-CLI-09)
    const typeError = target.warnings.find((w) => w.code === 'invalid-field' || w.code === 'invalid-agent');
    if (typeError) throw internalError(`Failed to load agent '${modeId}'${target.path ? ` from ${target.path}` : ''}: ${typeError.message}`);
    const switched = modeId !== st.session.agent.name;
    if (switched) {
      try {
        await st.session.swapAgent(modeId);
      } catch (e) {
        throw internalError(`Failed to switch to agent '${modeId}': ${errMessage(e)}`);
      }
      st.mcpReported.clear();
    }
    this.update(st.id, { sessionUpdate: 'current_mode_update', currentModeId: st.session.agent.name });
    if (switched) this.conn.notify('_kiro.dev/agent/switched', { sessionId: st.id, agentName: st.session.agent.name });
  }

  /**
   * A mode change (`session/set_mode`, `set_config_option` `mode`) under its request's own signal
   * (`$/cancel_request`, the connection closing). Withdrawn before it starts, it never runs. While
   * the target agent's agentSpawn hooks run (the swap's first step, nothing changed yet), the abort
   * interrupts the session, which kills them (K3): the swap is cancelled and it answers `-32800`
   * with the agent unchanged. A swap past its hooks (the session's restart) is not stopped: it
   * finishes and answers what it did. Either way the answer says which agent later prompts run
   * on; none runs on a half-switched one. `session/cancel` leaves a mode change alone (05 §4.6:
   * it cancels prompt turns and commands).
   */
  private async swapUnder(st: AcpSessionState, modeId: string, request: AbortSignal): Promise<void> {
    if (request.aborted || st.closed) throw new RpcError(ErrorCodes.REQUEST_CANCELLED, 'Request cancelled');
    const before = st.session.agent.name;
    const onAbort = (): void => {
      if (!st.turn && !st.closed) st.session.interrupt().catch((e) => this.log.warn(`acp[${st.id}]: interrupt failed:`, e));
    };
    request.addEventListener('abort', onAbort, { once: true });
    try {
      await this.swapTo(st, modeId);
    } catch (e) {
      if (request.aborted && st.session.agent.name === before) {
        throw new RpcError(ErrorCodes.REQUEST_CANCELLED, 'Request cancelled', e instanceof RpcError && typeof e.data === 'string' ? e.data : errMessage(e));
      }
      throw e;
    } finally {
      request.removeEventListener('abort', onAbort);
    }
  }

  /** `session/set_mode` (05 §4.7, 08 KC-ACP-03); cancelled by its own `$/cancel_request` ({@link swapUnder}). */
  private setMode(p: Record<string, unknown>, rc: RequestContext): Promise<unknown> {
    const st = this.getSession(p.sessionId);
    const modeId = str(p.modeId);
    if (!modeId) throw invalidParams('modeId is required');
    return st.enqueue(async () => {
      if (st.closed) throw sessionNotFound();
      await st.whenReady();
      const before = st.session.agent.name;
      await this.swapUnder(st, modeId, rc.signal);
      if (before === st.session.agent.name) return {};
      return respondThen({}, async () => {
        await this.reportMcp(st);
        this.update(st.id, availableCommandsUpdate(loadPrompts(st.ws)));
      });
    });
  }

  private async applyModel(st: AcpSessionState, modelId: string): Promise<void> {
    const entries = await this.listModels(st);
    const id = resolveModelId(entries, modelId);
    if (!id) throw invalidModelError(modelId);
    try {
      await st.session.setModel(id);
    } catch (e) {
      throw new RpcError(-32602, `Invalid model ID: ${modelId}`, errMessage(e));
    }
    this.update(st.id, { sessionUpdate: 'config_option_update', configOptions: configOptions(entries, st.session.model, st.session.effort) });
  }

  private async applyEffort(st: AcpSessionState, level: string): Promise<void> {
    await st.session.setEffort(level);
    const entries = await this.listModels(st);
    this.update(st.id, { sessionUpdate: 'config_option_update', configOptions: configOptions(entries, st.session.model, st.session.effort ?? level) });
  }

  /** `session/set_model` (05 §4.8, 08 KC-ACP-08). */
  private setModel(p: Record<string, unknown>): Promise<unknown> {
    const st = this.getSession(p.sessionId);
    const modelId = str(p.modelId);
    if (!modelId) throw invalidParams('modelId is required');
    return st.enqueue(async () => {
      if (st.closed) throw sessionNotFound();
      await st.whenReady();
      await this.applyModel(st, modelId);
      return {};
    });
  }

  /** `session/set_config_option` (05 §4.9); a `mode` change is cancelled like `set_mode` ({@link swapUnder}). */
  private setConfigOption(p: Record<string, unknown>, rc: RequestContext): Promise<unknown> {
    const st = this.getSession(p.sessionId);
    const configId = str(p.configId);
    if (!configId) throw invalidParams('configId is required');
    return st.enqueue(async () => {
      if (st.closed) throw sessionNotFound();
      await st.whenReady();
      const value = p.value;
      switch (configId) {
        case 'model':
          if (typeof value !== 'string') throw invalidParams('model value must be a string');
          await this.applyModel(st, value);
          break;
        case 'effortLevel':
        case 'effort':
        case 'reasoning_effort':
        case 'thought_level': {
          const level = normalizeEffort(str(value));
          if (!level) throw invalidParams(`Invalid effort level: ${String(value)}`);
          await this.applyEffort(st, level);
          break;
        }
        case 'mode':
          if (typeof value !== 'string') throw invalidParams('mode value must be a string');
          await this.swapUnder(st, value, rc.signal);
          break;
        default:
          throw invalidParams(`Unknown config option: ${configId}`);
      }
      const entries = await this.listModels(st);
      return { configOptions: configOptions(entries, st.session.model, st.session.effort) };
    });
  }

  // ───────────── commands ─────────────

  /** `_kiro.dev/commands/execute` (05 §4.12, 08 KC-ACP-05). */
  private commandsExecute(p: Record<string, unknown>, rc: RequestContext): Promise<unknown> {
    const st = this.getSession(p.sessionId);
    const cmd = parseCommandParam(p.command);
    if (!cmd) return Promise.resolve({ success: false, message: 'Unknown command: /' });
    if (cmd.name === 'compact') {
      // cancelled like a runOp command (C3), with its compaction turn interrupted (runCompaction);
      // it answers after the compaction's frames, so nothing of it follows the answer
      return st.enqueue(async () => {
        if (st.closed) throw sessionNotFound();
        await st.whenReady();
        // withdrawn while it was queued (`$/cancel_request`), or its session closed: it never runs
        if (rc.signal.aborted || st.closed) return { success: false, message: 'Command cancelled' };
        const r = await this.runCompaction(st, argString(cmd.args, 'value', 'instructions'), undefined, rc.signal);
        if (r.ok) return { success: true, message: 'Conversation compacted' };
        return { success: false, message: r.cancelled ? 'Command cancelled' : r.reason || 'Compaction failed' };
      });
    }
    return st.enqueue(async () => {
      if (st.closed) throw sessionNotFound();
      await st.whenReady();
      const r = await this.runOp(st, rc.signal, cmd.name, (signal) => this.runCommand(st, cmd.name, cmd.args, signal));
      return r === CANCELLED_OP ? { success: false, message: 'Command cancelled' } : r;
    });
  }

  /**
   * Run `job` as the session's command ({@link AcpSessionState.op}, C3): `session/cancel`, the
   * request's `$/cancel_request` (`request`) and the session's close abort its signal, which ends
   * its waits for Claude Code (`usage()`, `mcpStatus()`, the MCP init wait) at once. For `/clear`
   * and an agent swap (`name`) the cancel also interrupts the session, which kills the agentSpawn
   * hooks they run first (K3: the command is then cancelled with nothing changed), as a REPL
   * Ctrl+C does. Commands that change state otherwise (`/model x`, `/effort x`) are not
   * interrupted: they finish and answer what they did. Returns {@link CANCELLED_OP} for a
   * cancelled wait; whatever its wait would have produced later is dropped.
   */
  private async runOp<T>(st: AcpSessionState, request: AbortSignal | undefined, name: string, job: (signal: AbortSignal) => Promise<T>): Promise<T | typeof CANCELLED_OP> {
    // withdrawn while it was queued (`$/cancel_request`), or its session closed: it never runs
    if (request?.aborted || st.closed) return CANCELLED_OP;
    const op = { abort: new AbortController(), interrupt: name === 'clear' || name === 'agent' };
    st.op = op;
    const onRequestAbort = (): void => this.cancelOp(st);
    request?.addEventListener('abort', onRequestAbort, { once: true });
    try {
      return await job(op.abort.signal);
    } catch (e) {
      if (e instanceof OpCancelledError) return CANCELLED_OP;
      throw e;
    } finally {
      request?.removeEventListener('abort', onRequestAbort);
      if (st.op === op) st.op = undefined;
    }
  }

  /** Cancel the session's running command, if any ({@link runOp}). */
  private cancelOp(st: AcpSessionState): void {
    const op = st.op;
    if (!op || op.abort.signal.aborted) return;
    op.abort.abort();
    // the agentSpawn hooks of a /clear or agent swap (K3)
    if (op.interrupt && !st.turn && !st.closed) st.session.interrupt().catch((e) => this.log.warn(`acp[${st.id}]: interrupt failed:`, e));
  }

  /** `_kiro.dev/commands/options` (P2; shape UNVERIFIED, 05 §4.12). */
  private commandsOptions(p: Record<string, unknown>): Record<string, unknown> {
    const st = this.getSession(p.sessionId);
    const partial = (str(p.partial) ?? str(p.query) ?? '').replace(/^\//, '').toLowerCase();
    const all = [...ACP_COMMANDS.map((c) => ({ name: c.name, description: c.description })), ...loadPrompts(st.ws).map((x) => ({ name: x.name, description: `Prompt: ${x.description ?? x.name}` }))];
    return { options: all.filter((o) => o.name.toLowerCase().startsWith(partial)) };
  }

  private async waitForMcp(st: AcpSessionState, signal?: AbortSignal): Promise<McpStatusEntry[]> {
    return this.reportMcp(st, signal);
  }

  /**
   * Run a Kiro command against a session (queued by the caller). `signal` (the command's,
   * {@link runOp}) cancels its waits for Claude Code: {@link OpCancelledError}.
   */
  private async runCommand(st: AcpSessionState, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CommandResult> {
    const value = argString(args, 'value');
    switch (name) {
      case 'effort': {
        const raw = argString(args, 'level', 'value', 'effort');
        const level = normalizeEffort(raw);
        if (!level) return invalidEffortResult(raw);
        // a session refusal (e.g. a model without effort levels) is a command failure, not a
        // JSON-RPC error (05 §4.12: commands answer {success:false} and never error)
        try {
          await this.applyEffort(st, level);
        } catch (e) {
          return { success: false, message: errMessage(e) };
        }
        return { success: true, message: `Effort set to ${level}` };
      }
      case 'clear':
        try {
          await st.session.clear();
        } catch (e) {
          return { success: false, message: errMessage(e) };
        }
        this.conn.notify('_kiro.dev/clear/status', { sessionId: st.id, status: 'completed' });
        return { success: true, message: 'Conversation cleared' };
      case 'model': {
        const id = argString(args, 'value', 'model', 'modelId');
        const entries = id ? await this.listModels(st) : await untilAborted(this.listModels(st), signal);
        if (!id) {
          const lines = entries.map((e) => `${e.kiroId === st.session.model ? '*' : ' '} ${e.kiroId}${e.displayName && e.kiroId !== 'auto' ? ` (${e.displayName})` : ''}`);
          return { success: true, message: `Current model: ${st.session.model}\n${lines.join('\n')}`, data: { model: { id: st.session.model } } };
        }
        try {
          await this.applyModel(st, id);
        } catch (e) {
          return { success: false, message: e instanceof RpcError ? e.message : errMessage(e) };
        }
        return { success: true, message: `Model set to ${st.session.model}`, data: { model: { id: st.session.model } } };
      }
      case 'agent': {
        let target = argString(args, 'name', 'agent');
        if (!target && value) {
          const words = value.split(/\s+/);
          if (words[0] === 'swap' || words[0] === 'set') target = words[1];
          else if (words[0] !== 'list') target = words[0];
        }
        if (!target) {
          const agents = [...loadAgents(st.ws, { settings: openSettings(st.ws) }).agents.keys()];
          const lines = agents.map((a) => `${a === st.session.agent.name ? '*' : ' '} ${a}`);
          return { success: true, message: lines.join('\n'), data: { agent: { name: st.session.agent.name } } };
        }
        try {
          const before = st.session.agent.name;
          await this.swapTo(st, target);
          if (before !== st.session.agent.name) {
            void this.reportMcp(st)
              .then(() => this.update(st.id, availableCommandsUpdate(loadPrompts(st.ws))))
              .catch((e) => this.log.debug('acp: post-swap report failed:', e));
          }
        } catch (e) {
          return { success: false, message: e instanceof RpcError && typeof e.data === 'string' ? e.data : errMessage(e) };
        }
        return { success: true, message: `Agent changed to ${st.session.agent.name}`, data: { agent: { name: st.session.agent.name } } };
      }
      case 'mcp':
        return mcpResult(await this.waitForMcp(st, signal));
      case 'tools':
        await this.waitForMcp(st, signal);
        return toolsResult(st.session.toolListing());
      case 'context':
        try {
          return { success: true, message: contextText(await untilAborted(st.session.contextReport(), signal)) };
        } catch (e) {
          if (e instanceof OpCancelledError) throw e;
          return { success: false, message: errMessage(e) };
        }
      case 'usage':
        try {
          return { success: true, message: usageText(await untilAborted(st.session.usage(), signal)) };
        } catch (e) {
          if (e instanceof OpCancelledError) throw e;
          return { success: false, message: errMessage(e) };
        }
      case 'help':
        return { success: true, message: helpText(loadPrompts(st.ws)) };
      default:
        return { success: false, message: `Unknown command: /${name}` };
    }
  }

  // ───────────── steering ─────────────

  /** `_session/steer` (05 §4.13, 08 KC-ACP-17). */
  private steer(p: Record<string, unknown>): unknown {
    const st = this.getSession(p.sessionId);
    let text = str(p.message);
    if (text === undefined && Array.isArray(p.prompt)) text = promptToInput(p.prompt).input.text;
    if (text === undefined && Array.isArray(p.content)) text = promptToInput(p.content).input.text;
    if (!text || text.trim() === '' || !st.turn || st.turn.cancelled || st.manualCompaction) return { queued: false };
    const id = `steer-${randomHex32()}`;
    st.steers.push({ id, text });
    const content = st.steers.map((s) => s.text).join('\n\n');
    return respondThen({ queued: true }, () => {
      this.kiroUpdate(st.id, { sessionUpdate: 'AgentExecutionUserMessageQueued', messageId: id, content }, false);
    });
  }

  /**
   * `_session/steer/clear` (05 §4.13): drops every steer the turn has not read yet — the held ones,
   * and those written to Claude that it has not started (withdrawn from its queue) — and names
   * exactly those in ONE `AgentExecutionUserMessageCleared`, as kiro-cli does (KiroCrew resends the
   * dropped steers it did not mean to take back). A written steer Claude already took in is
   * reported `AgentExecutionSteeringInjected` first.
   */
  private steerClear(p: Record<string, unknown>): unknown {
    const st = this.getSession(p.sessionId);
    const dropped = st.steers.map((s) => s.id);
    st.steers = [];
    const turn = st.turn;
    // (a cancelled turn's interrupt already drops them from Claude's queue; its end reports them)
    const written = turn && !turn.cancelled ? [...turn.written].filter(([, w]) => !w.clearing) : [];
    if (dropped.length === 0 && written.length === 0) return { cleared: true };
    for (const [, w] of written) w.clearing = true;
    const report = (ids: string[]): void => {
      if (ids.length && !st.closed) this.kiroUpdate(st.id, { sessionUpdate: 'AgentExecutionUserMessageCleared', messageIds: ids }, false);
    };
    return respondThen({ cleared: true }, () => {
      if (written.length === 0) return report(dropped);
      type Outcome = [uuid: string, w: WrittenSteer, dropped: boolean | undefined];
      const withdrawals = written.map(([uuid, w]) => w.withdraw().then((ok): Outcome => [uuid, w, ok], (): Outcome => [uuid, w, undefined]));
      void Promise.all(withdrawals).then((res) => {
        const ids = [...dropped];
        for (const [uuid, w, ok] of res) {
          if (turn!.written.get(uuid) !== w) continue; // reported meanwhile (started, or the turn ended)
          if (ok === undefined || (!ok && turn!.cancelled)) {
            // no answer (the child is gone), or not queued any more because a cancel dropped it:
            // its `command_lifecycle` or the turn's end reports it
            w.clearing = false;
            continue;
          }
          turn!.written.delete(uuid);
          if (ok) ids.push(...w.ids);
          else if (!st.closed) this.kiroUpdate(st.id, { sessionUpdate: 'AgentExecutionSteeringInjected', messageId: w.ids[w.ids.length - 1]!, content: w.text });
        }
        report(ids);
      });
    });
  }

  /**
   * The session emits every event as `'event'` synchronously when the Claude frame arrives,
   * while `prompt()` yields them later (the consumer lags behind the child). Held steers are
   * therefore written at the LIVE tool boundary: Claude is still busy there (a model call always
   * follows a tool result), so the session sends the line with priority `next` and the running
   * prompt answers it (at a later boundary or in a turn of its own, module doc). Written later,
   * the session could find Claude idle and hold the text for the next prompt instead (05 §4.13,
   * 00 §2.5 steer row).
   */
  private attachLive(st: AcpSessionState): void {
    const l = (ev: SessionEvent): void => {
      try {
        this.onLiveEvent(st, ev);
      } catch (e) {
        this.log.warn(`acp[${st.id}]: live event handling failed:`, e);
      }
    };
    st.liveListener = l;
    st.session.on('event', l);
  }

  private onLiveEvent(st: AcpSessionState, ev: SessionEvent): void {
    const turn = st.turn;
    if (!turn || turn.cancelled || turn.detached || st.closed || st.manualCompaction) return;
    const id = ev.type === 'tool_end' ? ev.toolUseId : ev.type === 'tool_denied' ? ev.toolUseId : undefined;
    if (!id) return;
    turn.liveBoundaries.add(id);
    if (st.steers.length === 0) return;
    const batch = st.steers;
    st.steers = [];
    const text = batch.map((x) => x.text).join('\n\n');
    let line: ReturnType<KiroSession['steer']>;
    try {
      line = st.session.steer(text);
    } catch (e) {
      this.log.warn(`acp[${st.id}]: steer failed:`, e);
      st.steers = [...batch, ...st.steers];
      return;
    }
    // announced when Claude starts the line (onRaw), or at this boundary when its uuid is unknown
    if (line) turn.written.set(line.uuid, { ids: batch.map((x) => x.id), text, withdraw: line.withdraw });
    else turn.liveInjected.set(id, { id: batch[batch.length - 1]!.id, text });
  }

  /** At a tool boundary reached by the generator: announce a live injection, or inject now. */
  private afterBoundary(st: AcpSessionState, turn: TurnCtx, toolUseId: string | undefined): void {
    if (toolUseId && turn.liveBoundaries.has(toolUseId)) {
      const inj = turn.liveInjected.get(toolUseId);
      if (inj) {
        turn.liveInjected.delete(toolUseId);
        this.kiroUpdate(st.id, { sessionUpdate: 'AgentExecutionSteeringInjected', messageId: inj.id, content: inj.text });
      }
      return;
    }
    // sessions without a live event stream: inject at the generator's boundary
    this.injectSteers(st);
  }

  /** Write held steers into the running turn (tool boundary); returns whether any were sent. */
  private injectSteers(st: AcpSessionState): boolean {
    const turn = st.turn;
    if (st.steers.length === 0 || !turn || turn.cancelled) return false;
    const batch = st.steers;
    st.steers = [];
    const text = batch.map((s) => s.text).join('\n\n');
    let line: ReturnType<KiroSession['steer']>;
    try {
      line = st.session.steer(text);
    } catch (e) {
      this.log.warn(`acp[${st.id}]: steer failed:`, e);
      return false;
    }
    if (line) turn.written.set(line.uuid, { ids: batch.map((x) => x.id), text, withdraw: line.withdraw });
    else this.kiroUpdate(st.id, { sessionUpdate: 'AgentExecutionSteeringInjected', messageId: batch[batch.length - 1]!.id, content: text });
    return true;
  }

  /**
   * `command_lifecycle` of a steer written to Claude: `started` ⇒ injected (Claude reads it now);
   * `cancelled` ⇒ dropped unread (an interrupt with `cancel_queued`).
   */
  private onSteerLifecycle(st: AcpSessionState, turn: TurnCtx, frame: Record<string, unknown>): void {
    const uuid = str(frame.command_uuid);
    const w = uuid ? turn.written.get(uuid) : undefined;
    if (!uuid || !w) return;
    if (frame.state === 'started') {
      turn.written.delete(uuid);
      this.kiroUpdate(st.id, { sessionUpdate: 'AgentExecutionSteeringInjected', messageId: w.ids[w.ids.length - 1]!, content: w.text });
    } else if (frame.state === 'cancelled' && !w.clearing) {
      // (a clear in flight reports it, with the rest it dropped)
      turn.written.delete(uuid);
      this.kiroUpdate(st.id, { sessionUpdate: 'AgentExecutionUserMessageCleared', messageIds: w.ids });
    }
  }

  // ───────────── cancel ─────────────

  /**
   * `session/cancel` (05 §4.6): interrupt the running turn and cancel every prompt received
   * before this point that has not started yet (see {@link AcpSessionState.cancelEpoch}).
   */
  private cancel(sessionId: string | undefined): void {
    if (!sessionId) return;
    const st = this.sessions.get(sessionId);
    if (!st) return;
    st.cancelEpoch++;
    this.cancelTurn(st);
    // a command waiting for Claude Code (or running a /clear's agentSpawn hooks) answers now (C3)
    this.cancelOp(st);
  }

  /** Interrupt the running turn (if any); the prompt then answers `cancelled`. */
  private cancelTurn(st: AcpSessionState): void {
    const turn = st.turn;
    if (!turn || turn.cancelled) return;
    turn.cancelled = true;
    turn.abort.abort();
    st.session.interrupt().catch((e) => this.log.warn(`acp[${st.id}]: interrupt failed:`, e));
    turn.cancelTimer = setTimeout(() => turn.cancelGrace.resolve(), this.timings.cancelGraceMs);
    turn.cancelTimer.unref?.();
  }

  // ───────────── permission bridge ─────────────

  /** {@link SessionUI.requestApproval} for ACP sessions (05 §6.1). */
  private async requestApproval(st: AcpSessionState | undefined, req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalResponse> {
    if (!st || st.closed) return { kind: 'cancelled' };
    const toolUseId = req.call.toolUseId ?? req.requestId;
    const d = this.ensureToolCall(st, req.call, toolUseId);
    const trustOptions = trustOptionsFor(d, st.ws.cwd);
    const params: Record<string, unknown> = {
      sessionId: st.id,
      toolCall: permissionToolCall(d),
      options: KIRO_PERMISSION_OPTIONS.map((o) => ({ ...o })),
      ...(trustOptions ? { _meta: { trustOptions } } : {}),
    };
    let answer: unknown;
    try {
      answer = await this.conn.request('session/request_permission', params, { signal }).promise;
    } catch (e) {
      if (signal.aborted || st.turn?.cancelled) {
        st.denied.set(toolUseId, CANCELLED_TEXT);
        return { kind: 'cancelled' };
      }
      this.log.warn(`acp[${st.id}]: permission request failed:`, e);
      st.denied.set(toolUseId, 'Permission request failed');
      return { kind: 'deny', message: 'Permission request failed' };
    }
    const outcome = isObj(answer) && isObj(answer.outcome) ? answer.outcome : undefined;
    if (outcome?.outcome === 'cancelled') {
      st.denied.set(toolUseId, CANCELLED_TEXT);
      return { kind: 'cancelled' };
    }
    const optionId = outcome?.outcome === 'selected' ? str(outcome.optionId) : undefined;
    switch (optionId) {
      case 'allow_once':
        this.update(st.id, inProgressUpdate(d));
        return { kind: 'allow-once' };
      case 'allow_always':
        this.update(st.id, inProgressUpdate(d));
        return { kind: 'allow-always' };
      case 'reject_once':
      case 'reject_always':
        st.denied.set(toolUseId, USER_DENIED_TEXT);
        return { kind: 'deny', message: USER_DENIED_TEXT };
      default:
        this.log.warn(`acp[${st.id}]: unexpected permission answer: ${JSON.stringify(answer)}`);
        st.denied.set(toolUseId, 'Permission request failed');
        return { kind: 'deny', message: 'Permission request failed' };
    }
  }

  // ───────────── tool frames ─────────────

  /**
   * Emit the `tool_call` frame once per id. `readContent:false` (gate-denied calls) keeps the
   * current text of a `Write` target out of the diff: a denied path's contents never leave the
   * machine through the client (KiroCrew logs and relays tool frames).
   */
  private ensureToolCall(st: AcpSessionState, call: KiroToolCall, toolUseId: string, readContent = true): ToolDescriptor {
    const have = st.tools.get(toolUseId);
    if (have) return have;
    const parent = st.parentOf.get(toolUseId);
    const d = describeToolCall(call, { cwd: st.ws.cwd, toolCallId: toolUseId, fs: LIVE_FS, readContent, ...(parent ? { parentToolUseId: parent } : {}) });
    st.tools.set(toolUseId, d);
    this.update(st.id, toolCallUpdate(d));
    return d;
  }

  private minimalDescriptor(st: AcpSessionState, toolUseId: string): ToolDescriptor {
    const call = toKiroCall('tool', {}, { cwd: st.ws.cwd, toolUseId });
    return this.ensureToolCall(st, call, toolUseId);
  }

  private finishTool(st: AcpSessionState, toolUseId: string, call: KiroToolCall | undefined, r: { isError: boolean; output: string; response?: unknown }): void {
    if (st.finalized.has(toolUseId)) return;
    const d = st.tools.get(toolUseId) ?? (call ? this.ensureToolCall(st, call, toolUseId) : this.minimalDescriptor(st, toolUseId));
    st.finalized.add(toolUseId);
    const denial = st.denied.get(toolUseId);
    if (denial !== undefined && r.isError) {
      this.update(st.id, deniedUpdate(d, denial));
      return;
    }
    let todos: TodoItem[] | undefined;
    if (d.family === 'todo') {
      try {
        todos = st.session.todos();
      } catch {
        todos = st.todos;
      }
      if (!todos || todos.length === 0) todos = st.todos;
    }
    for (const u of toolResultUpdates(d, { ...r, ...(todos ? { todos } : {}) })) this.update(st.id, u);
  }

  private onEvent(st: AcpSessionState, turn: TurnCtx, ev: SessionEvent): void {
    if (turn.detached || st.closed) return;
    switch (ev.type) {
      case 'text_delta':
      case 'text':
        if (ev.text) this.update(st.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: turn.joinText(ev.text) } });
        return;
      case 'thinking_delta':
        if (ev.text) this.update(st.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ev.text } });
        return;
      case 'tool_start':
        turn.toolBlock();
        this.learnMcpCall(st, ev.call);
        this.ensureToolCall(st, ev.call, ev.toolUseId);
        return;
      case 'tool_denied': {
        turn.toolBlock();
        this.learnMcpCall(st, ev.call);
        const id = ev.toolUseId ?? ev.call.toolUseId;
        if (!id || st.finalized.has(id)) return;
        const d = this.ensureToolCall(st, ev.call, id, false);
        st.finalized.add(id);
        this.update(st.id, deniedUpdate(d, st.denied.get(id) ?? (stripToolUseError(ev.reason) || USER_DENIED_TEXT)));
        this.afterBoundary(st, turn, id);
        return;
      }
      case 'tool_end':
        turn.toolBlock();
        if (ev.call) this.learnMcpCall(st, ev.call);
        this.finishTool(st, ev.toolUseId, ev.call, { isError: ev.isError, output: ev.output, response: ev.response });
        this.afterBoundary(st, turn, ev.toolUseId);
        return;
      case 'todo_update':
        st.todos = ev.todos.map((t) => ({ ...t }));
        this.update(st.id, planUpdate(st.todos));
        return;
      case 'compaction':
        if (st.manualCompaction) {
          if (ev.state === 'finished') turn.compacted = true;
          return;
        }
        if (ev.state === 'started') {
          this.flushCompactionFailure(st.id);
          turn.compactionStarted = true;
          this.conn.notify('_kiro.dev/compaction/status', { sessionId: st.id, status: { type: 'started' }, summary: null });
        } else if (turn.compactionSummary !== undefined) {
          this.finishAutoCompaction(st, turn);
        } else {
          turn.compactionPending = true;
        }
        return;
      case 'compaction_failed':
        // a manual one is reported from its turn's result (runCompaction); an auto-compaction's
        // `failed` goes out before the session's next frame (flushCompactionFailure); one that
        // was never reported started has nothing to end
        if (st.manualCompaction || !turn.compactionStarted) return;
        turn.compactionStarted = false;
        turn.compactionPending = false;
        turn.compactionSummary = undefined;
        turn.compactionFailure = ev.reason;
        return;
      case 'subagent': {
        // The list is the CURRENT one: KiroCrew reads kiro-cli's as a full snapshot rebuilt on every
        // change, where terminated children vanish from the next update (KC
        // acp/runtime_frame_accounting.py `_snapshot_subagent_sessions`), keyed by each entry's
        // `sessionId` (dashboard/chat_turn/native_cards.py `_native_subagent_sync`,
        // acp/session_handle_native_children.py `_note_native_roster`). DECISION: a finished
        // subagent is reported once as `completed` / `failed`, then dropped; whatever is still
        // listed when the turn ends is dropped by endTurn.
        let id = ev.toolUseId;
        if (!id && ev.state !== 'started') id = [...st.subagents.values()].find((x) => x.agentName === ev.agentType && x.status.type === 'working')?.sessionId;
        id ??= `${ev.agentType}-${++st.subagentSeq}`;
        const known = st.subagents.get(id);
        const status: SubagentEntry['status'] =
          ev.state === 'started'
            ? { type: 'working', message: '' }
            : ev.isError
              ? { type: 'failed', message: stripToolUseError(ev.error ?? '').trim().slice(0, 500) }
              : { type: 'completed', message: '' };
        st.subagents.set(id, {
          sessionId: id,
          sessionName: known?.sessionName ?? (ev.description || ev.agentType),
          agentName: ev.agentType,
          role: ev.agentType,
          initialQuery: known?.initialQuery ?? (ev.prompt || ev.description || ev.agentType),
          status,
        });
        this.notifySubagents(st);
        if (ev.state !== 'started') st.subagents.delete(id);
        return;
      }
      case 'rate_limit':
        turn.rateLimit = { status: ev.status, ...(turn.rateLimit?.rateLimitType ? { rateLimitType: turn.rateLimit.rateLimitType } : {}) };
        return;
      case 'notice':
        this.log[ev.level === 'error' ? 'error' : ev.level === 'warn' ? 'warn' : 'info'](`acp[${st.id}]: ${ev.message}`);
        return;
      case 'raw':
        this.onRaw(st, turn, ev.frame);
        return;
      default:
        return;
    }
  }

  private finishAutoCompaction(st: AcpSessionState, turn: TurnCtx): void {
    turn.compactionPending = false;
    turn.compactionStarted = false;
    this.conn.notify('_kiro.dev/compaction/status', { sessionId: st.id, status: { type: 'completed' }, summary: turn.compactionSummary ?? '' });
    turn.compactionSummary = undefined;
  }

  /**
   * At the end of a prompt turn, before its response (r5x X2): an auto-compaction finished whose
   * summary was not seen is `completed`; one still open ends `failed` (`Compaction cancelled` for
   * a cancelled turn, else `Claude Code did not finish the compaction`: the session publishes its
   * own end first whenever it can, so this is for a turn whose events stopped, e.g. a child that
   * never answered the cancel); a held failure goes out. KiroCrew waits for the end of every
   * `started` ("the provider layer guarantees a terminal arrives", KC
   * dashboard/chat_turn/session_events.py). Nothing for a closed session.
   */
  private settleAutoCompaction(st: AcpSessionState, turn: TurnCtx): void {
    if (turn.compactionPending || (turn.compactionStarted && turn.compactionSummary !== undefined)) this.finishAutoCompaction(st, turn);
    else if (turn.compactionStarted) {
      turn.compactionStarted = false;
      turn.compactionFailure ??= turn.cancelled || st.closed ? 'Compaction cancelled' : 'Claude Code did not finish the compaction';
    }
    const reason = turn.compactionFailure;
    turn.compactionFailure = undefined;
    if (reason !== undefined && !st.closed) this.notifyCompactionFailed(st.id, reason);
  }

  /** Raw Claude frames: result/usage hints, subagent tool frames, compaction summaries. */
  private onRaw(st: AcpSessionState, turn: TurnCtx, frame: unknown): void {
    if (!isObj(frame)) return;
    switch (frame.type) {
      case 'result':
        turn.rawResult = frame;
        return;
      case 'command_lifecycle':
        this.onSteerLifecycle(st, turn, frame);
        return;
      case 'rate_limit_event': {
        const info = isObj(frame.rate_limit_info) ? frame.rate_limit_info : {};
        const status = str(info.status) ?? turn.rateLimit?.status ?? 'unknown';
        const type = str(info.rateLimitType);
        turn.rateLimit = { status, ...(type ? { rateLimitType: type } : {}) };
        return;
      }
      case 'assistant': {
        if (typeof frame.error === 'string') turn.assistantError = frame.error;
        const parent = str(frame.parent_tool_use_id);
        const msg = isObj(frame.message) ? frame.message : undefined;
        if (!parent || !msg || !Array.isArray(msg.content)) return;
        // inner tool calls of a Claude subagent: reported under this (the parent) session (08 KC-ACP-21)
        for (const b of msg.content.filter(isObj)) {
          if (b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
          st.parentOf.set(b.id, parent);
          const have = st.tools.get(b.id);
          if (have) {
            if (!have.parentToolUseId) {
              have.parentToolUseId = parent;
              this.update(st.id, { sessionUpdate: 'tool_call_update', toolCallId: b.id, _meta: toolMeta(have) });
            }
            continue;
          }
          // MCP names as the session maps them (Claude `kc_mcp` ⇒ Kiro `kc.mcp`)
          const call = toKiroCall(b.name, isObj(b.input) ? b.input : {}, { cwd: st.ws.cwd, toolUseId: b.id, mcpServerNames: Object.fromEntries(st.mcpNames) });
          this.ensureToolCall(st, call, b.id);
        }
        return;
      }
      case 'user': {
        const msg = isObj(frame.message) ? frame.message : undefined;
        if (!msg) return;
        if (frame.isSynthetic === true && (turn.compactionStarted || turn.compactionPending || st.manualCompaction)) {
          const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.filter(isObj).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n') : '';
          if (text) {
            turn.compactionSummary = extractSummary(text);
            if (turn.compactionPending) this.finishAutoCompaction(st, turn);
          }
          return;
        }
        const parent = str(frame.parent_tool_use_id);
        if (!parent || !Array.isArray(msg.content)) return;
        for (const b of msg.content.filter(isObj)) {
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          if (!st.tools.has(b.tool_use_id) || st.finalized.has(b.tool_use_id)) continue;
          let text = '';
          if (typeof b.content === 'string') text = b.content;
          else if (Array.isArray(b.content)) text = b.content.filter(isObj).map((x) => (typeof x.text === 'string' ? x.text : '')).join('\n');
          this.finishTool(st, b.tool_use_id, undefined, { isError: b.is_error === true, output: text, ...(frame.tool_use_result !== undefined ? { response: frame.tool_use_result } : {}) });
        }
        return;
      }
      default:
        return;
    }
  }

  // ───────────── prompt ─────────────

  /** `session/prompt` (05 §4.5, 08 KC-ACP-06). */
  private sessionPrompt(p: Record<string, unknown>, rc: RequestContext): Promise<unknown> {
    const st = this.getSession(p.sessionId);
    const blocks = Array.isArray(p.prompt) ? p.prompt : Array.isArray(p.content) ? p.content : undefined;
    if (!blocks) throw invalidParams('prompt must be an array of content blocks');
    const { input, skipped } = promptToInput(blocks);
    if (skipped.length) this.log.info(`acp[${st.id}]: skipped prompt content: ${skipped.join(', ')}`);
    const done = deferred<unknown>();
    this.promptRequests.set(rc.id, st.id);
    const epoch = st.cancelEpoch;
    const cancelledBeforeStart = (): boolean => st.cancelEpoch !== epoch || rc.signal.aborted;
    st.enqueue(async () => {
      if (st.closed) throw sessionNotFound();
      if (cancelledBeforeStart()) return done.resolve({ stopReason: 'cancelled' });
      st.activePrompt = rc.id;
      try {
        await st.whenReady();
        // a cancel that arrived while the child was still starting
        if (cancelledBeforeStart()) return done.resolve({ stopReason: 'cancelled' });
        await this.handlePrompt(st, input, (r) => done.resolve(r), rc.signal);
      } finally {
        if (st.activePrompt === rc.id) st.activePrompt = undefined;
      }
    })
      .catch((e) => done.reject(e))
      .finally(() => {
        this.promptRequests.delete(rc.id);
        done.reject(internalError('prompt finished without a response'));
      });
    return done.promise;
  }

  private async handlePrompt(st: AcpSessionState, input: PromptInput, respond: (r: unknown) => void, request?: AbortSignal): Promise<void> {
    const slash = input.images?.length ? undefined : parseSlashText(input.text);
    if (slash) {
      if (slash.name === 'compact') {
        this.update(st.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Compacting conversation...\n' } });
        await this.runCompaction(st, argString(slash.args, 'value'), respond);
        return;
      }
      if (isAcpCommand(slash.name)) {
        let opSignal: AbortSignal | undefined;
        const res = await this.runOp(st, request, slash.name, (signal) => {
          opSignal = signal;
          return this.runCommand(st, slash.name, slash.args, signal);
        });
        // cancelled (C3): `cancelled`, and nothing of what its wait would have produced
        if (res === CANCELLED_OP || st.closed) {
          respond({ stopReason: 'cancelled' });
          return;
        }
        const text = res.message ?? (res.success ? 'Done.' : 'Failed.');
        this.update(st.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.endsWith('\n') ? text : `${text}\n` } });
        // a command the cancel stopped (a /clear or agent swap whose agentSpawn hooks it killed:
        // nothing changed, its text says so) is a cancelled prompt (05 §4.6, KC-ACP-07); one that
        // finished all the same answers what it did
        respond({ stopReason: opSignal?.aborted && !res.success ? 'cancelled' : 'end_turn' });
        return;
      }
      const prompt = findPrompt(loadPrompts(st.ws), slash.name);
      if (prompt) {
        const inv = parsePromptInvocation(input.text);
        input = { ...input, text: expandPrompt(prompt, 'args' in inv ? inv.args : []) };
      }
    }
    if (input.text.trim() === '' && !input.images?.length) {
      respond({ stopReason: 'end_turn' });
      return;
    }
    await this.runTurn(st, input, respond);
  }

  private async drain(st: AcpSessionState, turn: TurnCtx, gen: AsyncGenerator<SessionEvent, TurnResult>): Promise<TurnResult> {
    for (;;) {
      const r = await gen.next();
      if (r.done) return r.value;
      try {
        this.onEvent(st, turn, r.value);
      } catch (e) {
        this.log.warn(`acp[${st.id}]: event mapping failed:`, e);
      }
    }
  }

  private failOpenTools(st: AcpSessionState): void {
    for (const [id, d] of st.tools) {
      if (st.finalized.has(id)) continue;
      st.finalized.add(id);
      const denial = st.denied.get(id);
      this.update(st.id, denial !== undefined ? deniedUpdate(d, denial) : abandonedUpdate(d));
    }
  }

  private beginTurn(st: AcpSessionState): TurnCtx {
    const turn = new TurnCtx();
    st.turn = turn;
    st.tools.clear();
    st.finalized.clear();
    st.denied.clear();
    st.parentOf.clear();
    return turn;
  }

  private endTurn(st: AcpSessionState, turn: TurnCtx): void {
    if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
    if (st.turn === turn) st.turn = undefined;
    // written live but their boundary never reached the generator (e.g. a detached turn)
    for (const inj of turn.liveInjected.values()) {
      if (!st.closed) this.kiroUpdate(st.id, { sessionUpdate: 'AgentExecutionSteeringInjected', messageId: inj.id, content: inj.text });
    }
    turn.liveInjected.clear();
    // written to Claude but never started (cancelled / failed turn): Claude never read them
    const unread = [...turn.written.values()].flatMap((w) => w.ids);
    turn.written.clear();
    if (unread.length && !st.closed) this.kiroUpdate(st.id, { sessionUpdate: 'AgentExecutionUserMessageCleared', messageIds: unread });
    this.dropSteers(st);
    // subagents cannot outlive the turn (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, claude/env): a
    // listed one whose finish was never seen (cancelled / failed turn) is dropped from the list
    if (st.subagents.size > 0) {
      st.subagents.clear();
      if (!st.closed) this.notifySubagents(st);
    }
  }

  private notifySubagents(st: AcpSessionState): void {
    this.flushCompactionFailure(st.id);
    this.conn.notify('_kiro.dev/subagent/list_update', { sessionId: st.id, subagents: [...st.subagents.values()] });
  }

  /** Steers never injected (cancelled / failed turn) are dropped and reported as cleared. */
  private dropSteers(st: AcpSessionState): void {
    if (st.steers.length === 0) return;
    const ids = st.steers.map((x) => x.id);
    st.steers = [];
    if (!st.closed) this.kiroUpdate(st.id, { sessionUpdate: 'AgentExecutionUserMessageCleared', messageIds: ids });
  }

  /**
   * One prompt turn (plus held-steer continuations); answers through `respond` (a
   * `PromptResponse`) or throws the JSON-RPC error. Returns only when the session can take the
   * next queued operation: the turn is over, or — after a cancel the child never answered — the
   * stuck session was replaced ({@link replaceStuckSession}).
   */
  private async runTurn(st: AcpSessionState, input: PromptInput, respond: (r: unknown) => void): Promise<void> {
    const turn = this.beginTurn(st);
    let result: TurnResult | undefined;
    let failure: unknown;
    const work = (async (): Promise<TurnResult> => {
      let r = await this.drain(st, turn, st.session.prompt(input, { signal: turn.abort.signal }));
      // the response's usage covers every Claude turn of this request (F6): KiroSession.prompt
      // sums its own redirect / Stop-hook continuations, the held-steer ones are added here
      let usage = r.usage;
      while (!turn.cancelled && !st.closed && !r.isError && st.steers.length > 0) {
        // steers still held at the end of the turn: continue inside this prompt request
        const batch = st.steers;
        st.steers = [];
        const text = batch.map((s) => s.text).join('\n\n');
        this.kiroUpdate(st.id, { sessionUpdate: 'AgentExecutionSteeringInjected', messageId: batch[batch.length - 1]!.id, content: text });
        // its reply is a new paragraph, not glued onto the answer before it
        turn.breakPending = turn.textTail !== '';
        r = await this.drain(st, turn, st.session.prompt({ text, skipPromptHooks: true }, { signal: turn.abort.signal }));
        usage = sumTurnUsage(usage, r.usage);
      }
      return usage ? { ...r, usage } : r;
    })();
    try {
      const raced = await Promise.race([work, turn.cancelGrace.promise.then(() => undefined)]);
      if (raced === undefined) {
        // 05 §4.6 step 5: no result within the grace period after cancel — answer now, then
        // restart the child with --resume (the stuck turn would block this session's queue forever)
        this.log.warn(`acp[${st.id}]: no result ${this.timings.cancelGraceMs} ms after cancel; answering cancelled and restarting Claude Code`);
        this.settleAutoCompaction(st, turn);
        this.failOpenTools(st);
        turn.detached = true;
        this.endTurn(st, turn);
        respond({ stopReason: 'cancelled' });
        await this.replaceStuckSession(st, work);
        return;
      }
      result = raced;
    } catch (e) {
      failure = e;
    }
    this.settleAutoCompaction(st, turn);
    this.failOpenTools(st);
    this.endTurn(st, turn);
    if (st.closed || turn.cancelled) {
      respond({ stopReason: 'cancelled' });
      return;
    }
    if (failure !== undefined) {
      if (failure instanceof RpcError) throw failure;
      throw internalError(errMessage(failure));
    }
    const r = result!;
    const stop = mapStopReason(r, turn.rawResult);
    if (stop === undefined) {
      throw turnErrorToRpc(r, {
        ...(turn.rateLimit ? { rateLimit: turn.rateLimit } : {}),
        ...(turn.assistantError ? { assistantError: turn.assistantError } : {}),
        model: st.session.model,
      });
    }
    if (stop === 'refusal') {
      // 05 §5.3: before the prompt response
      this.conn.notify('_kiro.dev/metadata', {
        sessionId: st.id,
        stopReason: 'CONTENT_FILTERED',
        refusal: { category: 'OTHER', explanation: r.text || 'The model declined to respond.', recommendedModel: null },
        modelId: st.session.model,
      });
    }
    await this.emitTurnMetadata(st, turn, Date.now() - turn.startedAt);
    const usage = promptUsage(r.usage);
    respond({ stopReason: stop, ...(usage ? { usage } : {}) });
  }

  /**
   * 05 §4.6 step 5: the child produced no result within the grace period after a cancel. Close
   * the session (stdin EOF, then SIGTERM / SIGKILL: the child dies and the stuck turn ends) and
   * re-create it under the SAME ACP / Kiro session id with `resume` of its persisted record and
   * the options it was created with (cwd, client MCP servers, additional directories,
   * `--trust-all-tools`, the permission bridge), carrying the agent / model / effort it has now
   * (`set_mode` / `set_model` / effort changes included) and the record's own per-tool trust
   * (never the launch `--trust-tools` again, F2). The new child starts eagerly; the session
   * queue then continues with it. A failed re-creation is reported by every later operation on
   * the session (`Failed to start the session: …`), like a failed start.
   */
  private async replaceStuckSession(st: AcpSessionState, stuck: Promise<unknown>): Promise<void> {
    const old = st.session;
    if (st.liveListener) old.off('event', st.liveListener);
    st.liveListener = undefined;
    try {
      await withTimeout(old.close(), this.timings.closeTimeoutMs);
    } catch (e) {
      this.log.warn(`acp[${st.id}]: closing the stuck session failed:`, e);
    }
    // the stuck generator ends once its child is gone (bounded: never block the queue on it again)
    await withTimeout(stuck.catch(() => undefined), this.timings.closeTimeoutMs);
    if (st.closed || this.stopping) return;
    const opts: KiroSessionOptions = { ...st.createOpts, resume: { sessionId: st.id }, agentName: old.agent.name, model: old.model };
    delete opts.fork;
    // the resumed record carries every agent's per-tool trust (what `--trust-tools` gave the
    // launch agent, allow_always grants, `byAgent`); the launch flag applied again would trust
    // the tool for the agent active NOW (e.g. one `set_mode` switched to) — as REPL restartStopped
    delete opts.trustTools;
    if (old.effort) opts.effort = old.effort;
    else delete opts.effort;
    if (old.trust.trustAll) opts.trustAllTools = true;
    let fresh: KiroSession;
    try {
      fresh = await this.createUnderStop(opts, undefined, false);
    } catch (e) {
      this.log.error(`acp[${st.id}]: re-creating the session after a stuck cancel failed:`, e);
      st.startError = e;
      st.ready = Promise.reject(e);
      st.ready.catch(() => undefined);
      return;
    }
    if (st.closed || this.stopping) {
      await this.closeLate(fresh);
      return;
    }
    if (fresh.id !== st.id) this.log.warn(`acp[${st.id}]: the re-created session answered id ${fresh.id}; keeping the client's id`);
    st.session = fresh;
    this.attachLive(st);
    st.ready = fresh.start();
    st.ready.catch((e) => {
      st.startError = e;
      this.log.error(`acp[${st.id}]: restart failed:`, e);
    });
    await st.ready.catch(() => undefined);
    this.log.info(`acp[${st.id}]: Claude Code restarted (--resume) after an unanswered cancel`);
  }

  /**
   * `used` / `size` / percentage for `usage_update` and `_kiro.dev/metadata`, asked fresh after
   * every turn (`get_context_usage` through `session.usage()`, nothing cached here; the result
   * frame only fills gaps). Measured with claude 2.1.318: `totalTokens` is the sum of Claude's
   * own categories, where `Messages` is the API-measured context minus Claude's ESTIMATE of the
   * system prompt + tools, clamped at 0 (e.g. estimate 11236, measured 10981 ⇒ no `Messages`,
   * total 11236). While that estimate exceeds the measured context (large tool / MCP sets early in
   * a conversation), Claude reports the same total after every turn — the number is Claude's, and
   * it is passed through unchanged so `used`, `contextUsagePercentage` and `/usage` agree.
   */
  private async contextNumbers(st: AcpSessionState, raw?: Record<string, unknown>): Promise<{ pct?: number; used?: number; size?: number }> {
    let pct: number | undefined;
    let used: number | undefined;
    let size: number | undefined;
    try {
      const u = await withTimeout(st.session.usage(), this.timings.usageTimeoutMs);
      if (u) {
        if (typeof u.contextPercent === 'number' && Number.isFinite(u.contextPercent)) pct = u.contextPercent;
        if (typeof u.contextTokens === 'number') used = u.contextTokens;
        if (typeof u.contextWindowTokens === 'number' && u.contextWindowTokens > 0) size = u.contextWindowTokens;
      }
    } catch (e) {
      this.log.debug('acp: usage() failed:', e);
    }
    if (used === undefined || size === undefined) {
      const c = contextFromResult(raw);
      if (c) {
        used ??= c.used;
        size ??= c.size;
      }
    }
    if (pct === undefined && used !== undefined && size) pct = (used / size) * 100;
    return { ...(pct !== undefined ? { pct } : {}), ...(used !== undefined ? { used } : {}), ...(size !== undefined ? { size } : {}) };
  }

  /**
   * `_kiro.dev/metadata` + `usage_update` after a turn (05 §5.3, §7.7; 08 KC-ACP-13/18).
   * `turnDurationMs` is the prompt request's own duration (`wallMs`): a raw result's
   * `duration_ms` covers only the last of its Claude turns (held-steer / Stop-hook continuation,
   * a steer answered in a turn of its own) (F6).
   */
  private async emitTurnMetadata(st: AcpSessionState, turn: TurnCtx, wallMs: number): Promise<void> {
    const n = await this.contextNumbers(st, turn.rawResult);
    const effort = st.session.effort;
    this.conn.notify('_kiro.dev/metadata', {
      sessionId: st.id,
      contextUsagePercentage: n.pct ?? 0,
      turnDurationMs: Math.round(wallMs),
      // shape as captured from kiro-cli 2.35 (`support` spellings other than "unavailable" UNVERIFIED, 05 §11 item 7)
      reasoning: { support: 'unavailable', ...(effort ? { effort } : {}), effortLevels: [...EFFORT_LEVELS] },
    });
    if (n.used !== undefined && n.size) this.update(st.id, { sessionUpdate: 'usage_update', used: n.used, size: n.size });
  }

  /**
   * `/compact` (05 §4.5.4, 08 KC-ACP-14): with `respond` (prompt path) answer `end_turn` first,
   * then `compaction/status` started → completed{summary} | failed{reason}, then
   * `_kiro.dev/metadata`. A compaction Claude refuses (VERIFIED 2.1.319: "No messages to compact"
   * for a session with no messages, a failed local command) is `failed` with Claude's message.
   * `request` (a `commands/execute compact`'s own signal: `$/cancel_request`) interrupts the
   * compaction turn like `session/cancel` and the session's close do (C3). A cancelled compaction
   * is `failed` (`cancelled`), unless Claude finished it first (its compact_boundary was seen):
   * then it is `completed`, as it happened, also when the child then never ends. One the child
   * never ends is reported after the grace period and the stuck session is replaced before the
   * metadata ({@link replaceStuckSession}), as for a prompt turn. Returns once every frame of it
   * is out.
   */
  private async runCompaction(
    st: AcpSessionState,
    instructions: string | undefined,
    respond: ((r: unknown) => void) | undefined,
    request?: AbortSignal,
  ): Promise<{ ok: boolean; cancelled: boolean; reason: string }> {
    if (respond) {
      respond({ stopReason: 'end_turn' });
      // the response is written from a promise callback: let it go out before the status frames
      await new Promise<void>((r) => setImmediate(r));
    }
    this.conn.notify('_kiro.dev/compaction/status', { sessionId: st.id, status: { type: 'started' }, summary: null });
    const turn = this.beginTurn(st);
    st.manualCompaction = true;
    // the request withdrawn while it runs: interrupt this compaction's turn (C3)
    const onRequestAbort = (): void => {
      if (st.turn === turn) this.cancelTurn(st);
    };
    request?.addEventListener('abort', onRequestAbort, { once: true });
    let ok = false;
    let reason = '';
    let stuck: Promise<unknown> | undefined;
    try {
      const work = this.drain(st, turn, st.session.compact(instructions));
      const r = await Promise.race([work, turn.cancelGrace.promise.then(() => undefined)]);
      if (r === undefined) {
        // 05 §4.6 step 5, as for a prompt turn: a cancelled compaction the child never ends
        this.log.warn(`acp[${st.id}]: compaction still running ${this.timings.cancelGraceMs} ms after cancel; restarting Claude Code`);
        turn.detached = true;
        stuck = work;
        // Claude compacted before it stopped answering (its boundary seen): that compaction
        // happened (Claude's transcript holds it), whatever the stuck child does next
        ok = turn.compacted;
        if (!ok) reason = 'Compaction cancelled';
      } else {
        // a cancel that came after Claude compacted (its boundary seen) changed nothing
        ok = !r.isError && (turn.compacted || (r.stopReason !== 'cancelled' && !turn.cancelled));
        if (!ok) reason = r.error || (turn.cancelled || r.stopReason === 'cancelled' ? 'Compaction cancelled' : 'Compaction failed');
      }
    } catch (e) {
      reason = errMessage(e);
    } finally {
      request?.removeEventListener('abort', onRequestAbort);
      st.manualCompaction = false;
      this.failOpenTools(st);
      this.endTurn(st, turn);
    }
    // cancelled by `session/cancel`, the request's own `$/cancel_request` or the session's close
    const cancelled = !ok && (turn.cancelled || st.closed);
    if (st.closed) return { ok, cancelled, reason };
    if (ok) this.conn.notify('_kiro.dev/compaction/status', { sessionId: st.id, status: { type: 'completed' }, summary: turn.compactionSummary ?? '' });
    else this.notifyCompactionFailed(st.id, reason);
    if (stuck) {
      await this.replaceStuckSession(st, stuck);
      if (st.closed) return { ok, cancelled, reason };
    }
    const n = await this.contextNumbers(st, turn.rawResult);
    this.conn.notify('_kiro.dev/metadata', { sessionId: st.id, contextUsagePercentage: n.pct ?? 0 });
    return { ok, cancelled, reason };
  }
}

/** `mcp__<claude server>__<tool>` ⇒ `<claude server>`; undefined for any other shape. */
function claudeMcpServerOf(claudeName: string, tool: string): string | undefined {
  const suffix = `__${tool}`;
  if (tool === '' || !claudeName.startsWith('mcp__') || !claudeName.endsWith(suffix) || claudeName.length <= 'mcp__'.length + suffix.length) return undefined;
  return claudeName.slice('mcp__'.length, claudeName.length - suffix.length);
}

function randomHex32(): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** The summary part of Claude's synthetic compaction message. */
export function extractSummary(text: string): string {
  const i = text.indexOf('Summary:');
  if (i >= 0 && i < 600) return text.slice(i + 'Summary:'.length).trim();
  return text.trim();
}

// ───────────────────────────── subcommand ─────────────────────────────

/** Extra knobs for tests (the CLI passes none). */
export interface RunAcpOptions {
  createSession?: SessionFactory;
  timings?: Partial<AcpServerTimings>;
  logger?: Logger;
  /** Called with the server once it is serving. */
  onServer?: (s: AcpServer) => void;
}

/** `kiro-claude acp …` with injectable dependencies (see {@link runAcpCommand}). */
export async function runAcp(args: string[], ctx: CliContext, opts: RunAcpOptions = {}): Promise<number> {
  const parsed = parseAcpFlags(args);
  if (!parsed.ok) {
    ctx.stderr.write(parsed.stderr);
    return parsed.exitCode;
  }
  const flags = parsed.flags;
  if (flags.help) {
    ctx.stdout.write(ACP_HELP_TEXT);
    return 0;
  }
  if (flags.login) {
    try {
      const settingPath = ctx.settings.getString('kiroClaude.claudePath');
      // same precedence as chat: $KIRO_CLAUDE_BIN > kiroClaude.claudePath > PATH (claude/binary.ts)
      const bin = await findClaudeBinary({ ...(settingPath ? { settingPath } : {}), env: ctx.ws.env });
      return await runAuthCommand(bin, 'login', ['--claudeai'], buildChildEnv(ctx.ws.env));
    } catch (e) {
      ctx.stderr.write(`error: ${errMessage(e)}\n`);
      return 1;
    }
  }
  const server = new AcpServer({
    ctx,
    flags,
    ...(opts.createSession ? { createSession: opts.createSession } : {}),
    ...(opts.timings ? { timings: opts.timings } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  let exitCode = 0;
  const realProcess = (ctx.stdin as unknown) === process.stdin;
  const onTerm = (): void => {
    exitCode = 143;
    server.stop();
  };
  const onInt = (): void => {
    exitCode = 130;
    server.stop();
  };
  // a closed terminal or a parent that hangs up: shut down cleanly (sessions closed, runtime dirs removed)
  const onHup = (): void => {
    exitCode = 129;
    server.stop();
  };
  if (realProcess) {
    process.once('SIGTERM', onTerm);
    process.once('SIGINT', onInt);
    if (process.platform !== 'win32') process.once('SIGHUP', onHup);
  }
  opts.onServer?.(server);
  try {
    await server.serve();
  } finally {
    if (realProcess) {
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGHUP', onHup);
      // after SIGTERM the parent may keep our stdin open: release it so the process can exit (05 §2.5)
      try {
        process.stdin.destroy();
      } catch {
        // ignore
      }
    }
  }
  return exitCode;
}

/** `kiro-claude acp` (the fixed Wave-2 entry point used by cli/main.ts). */
export const runAcpCommand: SubcommandRunner = (args, ctx) => runAcp(args, ctx);
