/**
 * `ClaudeProcess`: one headless Claude Code child driven over NDJSON (stream-json) plus the
 * control protocol.
 *
 * Sources: 00-synthesis §1 invariant 6 (protocol hygiene), §3.1 (spawn/shutdown), §3.3
 * (initialize first), §3.4 (user line), §3.5–3.6 (hook_callback / can_use_tool answers), §3.7
 * (host control requests), §3.9 (frames); 04 §4–§8 and §16 (implementation checklist).
 *
 * Wire behaviour (all binding):
 * - Every write is exactly one `JSON.stringify(obj) + "\n"` passed to a single `stdin.write`
 *   call, so lines can never interleave. A single malformed line kills the CLI (VERIFIED 04 e11),
 *   hence nothing but `JSON.stringify` output is ever written.
 * - The `initialize` control_request is the FIRST line written; {@link ClaudeProcess.start}
 *   resolves when its control_response arrives (it precedes any `system/init`) and rejects with
 *   {@link ClaudeProcessError} (including the stderr tail) when the child exits first, the
 *   response is an error, or `initializeTimeoutMs` (default 60 s) elapses.
 * - stdout is split on `\n` (CR stripped, partial lines buffered, UTF-8 safe). Non-JSON lines
 *   and JSON values without a string `type` are reported through `'protocolError'` and skipped.
 * - CLI → host `control_request`s are answered exactly once: `hook_callback` →
 *   `handlers.onHookCallback`, `can_use_tool` → `handlers.onCanUseTool`, anything else →
 *   `handlers.onOtherControlRequest` or `{subtype:"error", error:"Unsupported control request
 *   subtype: <x>"}`. A handler that throws/rejects, or whose result cannot be serialised
 *   (BigInt, cycles), is answered with `{subtype:"error", error:<message>}`. A `control_cancel_request` aborts the matching handler's AbortSignal and
 *   the request is then NOT answered (00 §3.6). A request that arrives after stdin was closed
 *   (`close()`, EPIPE, exit) cannot be answered at all and is not handed to the handlers.
 * - Host → CLI requests ({@link ClaudeProcess.request}) are matched by `request_id`; an
 *   `error` subtype rejects with {@link ClaudeControlError}.
 * - Every other frame (including unknown types) is emitted as `'frame'`; `keep_alive` is
 *   swallowed. `sessionId` is tracked from `system/init` and `conversation_reset` (seeded from
 *   `--session-id` / `--resume` in argv).
 * - When the child exits, pending host requests reject, pending handler signals abort, and a
 *   running {@link ClaudeProcess.turn} throws {@link ClaudeProcessError}. No `'frame'` is emitted
 *   after `'exit'` (late output from a grandchild holding the pipe open is dropped).
 *
 * Turn bookkeeping: each user line's uuid is "pending" until a `result` lists it in
 * `user_message_uuids`/`user_message_uuid` (a result without uuid info settles the oldest
 * pending line) or a `command_lifecycle` frame reports it `completed`/`cancelled`. `busy` is
 * true while anything is pending. `turn()` ends at the first result that lists its uuid (or that
 * carries no uuid info at all), or with a synthetic error result when its line is `cancelled`
 * before it ever `started` (no result can follow). Aborting a turn whose line is still queued
 * interrupts again once the line reports `started` (the default `interrupt` keeps queued sends,
 * 04 §8). Known limitation: a CLI-initiated background turn whose result has no uuid info,
 * arriving while our line is still queued, is taken as ours.
 *
 * Shutdown ({@link ClaudeProcess.close}): end stdin → wait `graceMs` (default 2000) → SIGTERM →
 * 2 s → SIGKILL. Idempotent.
 *
 * Library code never writes to stdout; diagnostics go to the optional `logger`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { resolveSpawn, type ClaudeBinary } from './binary.js';
import type {
  CanUseToolRequest,
  ClaudeFrame,
  ContextUsage,
  HookCallbackOutput,
  HookCallbackRequest,
  InitializeRequest,
  InitializeResponse,
  McpStatus,
  PermissionResult,
  ResultFrame,
  SystemInitFrame,
  UserContentBlock,
  UserInputLine,
} from './protocol.js';

/* ------------------------------------------------------------------------------------------ */
/* Public types                                                                                */
/* ------------------------------------------------------------------------------------------ */

export interface HandlerContext {
  /** Aborted when the CLI withdraws the request (`control_cancel_request`) or the child exits. */
  signal: AbortSignal;
  /** The CLI's `request_id`. */
  requestId: string;
}

export interface ClaudeHandlers {
  onHookCallback(req: HookCallbackRequest, ctx: HandlerContext): Promise<HookCallbackOutput>;
  onCanUseTool(req: CanUseToolRequest, ctx: HandlerContext): Promise<PermissionResult>;
  /**
   * Any other CLI-originated control request (`elicitation`, `mcp_message`, …). Return
   * `undefined` (not a promise) to decline: the CLI then gets
   * `Unsupported control request subtype: <x>`.
   */
  onOtherControlRequest?(
    subtype: string,
    request: Record<string, unknown>,
    ctx: HandlerContext,
  ): Promise<unknown> | undefined;
}

/** Minimal logger interface (structurally compatible with the project logger). */
export interface ClaudeLogger {
  debug?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
}

export interface ClaudeStartOptions {
  binary: ClaudeBinary;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  initialize: InitializeRequest;
  handlers: ClaudeHandlers;
  /** Default 60000. */
  initializeTimeoutMs?: number;
  /** Default timeout of {@link ClaudeProcess.request} (ms, 0 = none). Default 60000. */
  requestTimeoutMs?: number;
  logger?: ClaudeLogger;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class ClaudeProcessError extends Error {
  /** Tail of the child's stderr (≤ 64 KiB). */
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  constructor(message: string, info: { stderr?: string; exitCode?: number | null; signal?: NodeJS.Signals | null } = {}) {
    super(message);
    this.name = 'ClaudeProcessError';
    this.stderr = info.stderr ?? '';
    this.exitCode = info.exitCode ?? null;
    this.signal = info.signal ?? null;
  }
}

/** A host control request answered with `subtype:"error"` (or timed out). */
export class ClaudeControlError extends Error {
  readonly subtype: string;
  readonly timedOut: boolean;
  constructor(message: string, subtype: string, timedOut = false) {
    super(message);
    this.name = 'ClaudeControlError';
    this.subtype = subtype;
    this.timedOut = timedOut;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                                           */
/* ------------------------------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Uuids of the user lines a `result` (or other frame) answers. */
export function resultUserUuids(frame: Record<string, unknown>): string[] {
  const out: string[] = [];
  const list = frame.user_message_uuids;
  if (Array.isArray(list)) for (const u of list) if (typeof u === 'string') out.push(u);
  const one = frame.user_message_uuid;
  if (typeof one === 'string' && !out.includes(one)) out.push(one);
  return out;
}

/** True when `result` completes the user line `uuid` (see module doc). */
export function resultMatchesUuid(result: Record<string, unknown>, uuid: string): boolean {
  const list = resultUserUuids(result);
  return list.length === 0 || list.includes(uuid);
}

/** Session id implied by argv: `--session-id X`, or `--resume X` without `--fork-session`. */
export function sessionIdFromArgs(args: readonly string[]): string | undefined {
  let sessionId: string | undefined;
  let resume: string | undefined;
  let fork = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : undefined;
    const next = (): string | undefined => inline ?? (args[i + 1] !== undefined && !args[i + 1]!.startsWith('-') ? args[++i] : undefined);
    if (name === '--session-id') sessionId = next();
    else if (name === '--resume' || name === '-r') resume = next();
    else if (name === '--fork-session') fork = true;
  }
  if (sessionId) return sessionId;
  if (resume && !fork) return resume;
  return undefined;
}

/**
 * Incremental NDJSON line splitter: feeds bytes, returns complete lines (without `\n`/`\r\n`),
 * keeps the partial tail, decodes UTF-8 safely across chunk boundaries.
 *
 * Linear time: only the NEW chunk is scanned for `\n`; pieces of an unfinished line are kept in
 * a list and joined once when its newline arrives. (Rescanning an accumulated buffer on every
 * chunk was quadratic: a 32 MiB `tool_use_result` line arriving in 64 KiB pipe chunks took ~7 s.)
 *
 * A string chunk is taken as already-decoded text; any incomplete UTF-8 sequence still pending
 * from earlier Buffer chunks can never complete then, so it is flushed (as U+FFFD) first to keep
 * the text in order.
 */
export class LineSplitter {
  private decoder = new StringDecoder('utf8');
  /** Pieces of the current, not yet terminated line. */
  private parts: string[] = [];
  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === 'string' ? this.decoder.end() + chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let start = 0;
    let nl = text.indexOf('\n');
    while (nl !== -1) {
      let line = text.slice(start, nl);
      if (this.parts.length > 0) {
        this.parts.push(line);
        line = this.parts.join('');
        this.parts = [];
      }
      lines.push(stripCr(line));
      start = nl + 1;
      nl = text.indexOf('\n', start);
    }
    if (start < text.length) this.parts.push(start === 0 ? text : text.slice(start));
    return lines;
  }
  /** Remaining partial line (if any) at end of stream; the splitter is reusable afterwards. */
  end(): string[] {
    const tail = this.decoder.end();
    if (tail) this.parts.push(tail);
    const rest = stripCr(this.parts.join(''));
    this.parts = [];
    return rest.length > 0 ? [rest] : [];
  }
}

function stripCr(s: string): string {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function validatePermissionResult(v: unknown): PermissionResult | string {
  if (!isObj(v)) return 'can_use_tool handler returned no PermissionResult';
  if (v.behavior === 'allow') {
    if (v.updatedInput !== undefined && !isObj(v.updatedInput)) return 'updatedInput must be an object';
    return v as PermissionResult;
  }
  if (v.behavior === 'deny') {
    if (typeof v.message !== 'string') return "deny result requires a string 'message'";
    return v as PermissionResult;
  }
  return `invalid PermissionResult behavior: ${String(v.behavior)}`;
}

const STDERR_TAIL_MAX = 64 * 1024;
const DEFAULT_INIT_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const EXIT_DRAIN_MS = 1_000;
const KILL_AFTER_TERM_MS = 2_000;

/* ------------------------------------------------------------------------------------------ */
/* ClaudeProcess                                                                               */
/* ------------------------------------------------------------------------------------------ */

interface PendingHostRequest {
  subtype: string;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer?: NodeJS.Timeout;
}

interface CliRequestEntry {
  controller: AbortController;
  done: boolean;
}

interface TurnState {
  uuid: string;
  queue: ClaudeFrame[];
  result?: ResultFrame;
  error?: Error;
  wake?: () => void;
  /** Detaches the abort listener; idempotent (runs on result/error and in the generator's finally). */
  cleanup?: () => void;
  /** Last `command_lifecycle` state reported for this line (`queued`, `started`, …). */
  lifecycle?: string;
  /** The caller aborted while the line was not yet running: interrupt again once it starts. */
  abortOnStart?: boolean;
  aborted?: boolean;
}

/** Events emitted by {@link ClaudeProcess}. */
export type ClaudeProcessEvents = {
  /** Every non-control frame (unknown types included), in arrival order. */
  frame: [frame: ClaudeFrame];
  /** Raw stderr text chunks. */
  stderr: [chunk: string];
  /** Child exited and its output was fully processed. */
  exit: [info: ExitInfo];
  /** A stdout line that is not a JSON object with a string `type` (skipped). */
  protocolError: [err: Error, rawLine: string];
};

export class ClaudeProcess extends EventEmitter<ClaudeProcessEvents> {
  private readonly child: ChildProcess;
  private readonly handlers: ClaudeHandlers;
  private readonly logger: ClaudeLogger;
  private readonly binaryPath: string;
  private readonly requestTimeoutMs: number;
  private readonly splitter = new LineSplitter();
  private readonly pendingHost = new Map<string, PendingHostRequest>();
  private readonly cliRequests = new Map<string, CliRequestEntry>();
  private pendingUuids: string[] = [];
  private activeTurn: TurnState | undefined;
  private seq = 0;
  private stdinClosed = false;
  private stdoutEnded = false;
  private stderrEnded = false;
  private exitSeen = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private spawnError: Error | undefined;
  private exitTimer: NodeJS.Timeout | undefined;
  private finalized = false;
  private _exitInfo: ExitInfo | undefined;
  private _stderrTail = '';
  private _sessionId: string | undefined;
  private _lastInit: SystemInitFrame | undefined;
  private _initializeResponse: InitializeResponse = {};
  private closePromise: Promise<ExitInfo> | undefined;
  private resolveExited!: (info: ExitInfo) => void;
  /** Resolves (never rejects) once the child has exited and all output was processed. */
  readonly exited: Promise<ExitInfo>;

  private constructor(opts: ClaudeStartOptions) {
    super();
    this.handlers = opts.handlers;
    this.logger = opts.logger ?? {};
    this.binaryPath = opts.binary.path;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this._sessionId = sessionIdFromArgs(opts.args);
    this.exited = new Promise<ExitInfo>((r) => (this.resolveExited = r));

    const spec = resolveSpawn(opts.binary.path, opts.args);
    this.logger.debug?.(`spawning claude: ${spec.command} ${spec.args.map((a) => JSON.stringify(a)).join(' ')}`);
    this.child = spawn(spec.command, spec.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });

    this.child.on('error', (err) => {
      if (this.child.pid === undefined && !this.spawnError) {
        this.spawnError = err;
        this.stdinClosed = true;
        this.exitSeen = true;
        this.stdoutEnded = true;
        this.stderrEnded = true;
        // 'close' may or may not follow a spawn failure; finalize on the next tick either way.
        setImmediate(() => this.finalize());
      } else {
        this.logger.warn?.(`claude child error: ${err.message}`);
      }
    });
    this.child.on('exit', (code, signal) => {
      this.exitSeen = true;
      this.exitCode = code;
      this.exitSignal = signal;
      this.stdinClosed = true;
      // A grandchild holding a pipe open must not delay exit handling forever.
      if (!this.maybeFinalize()) this.exitTimer = setTimeout(() => this.finalize(), EXIT_DRAIN_MS);
    });
    this.child.on('close', () => this.finalize());

    const stdin = this.child.stdin!;
    stdin.on('error', (err) => {
      // EPIPE etc.: the child is going away; exit handling does the rest.
      this.stdinClosed = true;
      this.logger.debug?.(`claude stdin error: ${err.message}`);
    });
    const stdout = this.child.stdout!;
    stdout.on('data', (chunk: Buffer) => {
      // After finalize ('exit' emitted, waiters released) output is dropped: it can only come
      // from a grandchild that inherited the pipe after the drain deadline (EXIT_DRAIN_MS).
      if (this.finalized) return;
      for (const line of this.splitter.push(chunk)) this.handleLine(line);
    });
    stdout.on('end', () => {
      if (!this.finalized) for (const line of this.splitter.end()) this.handleLine(line);
      this.stdoutEnded = true;
      this.maybeFinalize();
    });
    stdout.on('error', (err) => this.logger.debug?.(`claude stdout error: ${err.message}`));
    const stderr = this.child.stderr!;
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string) => {
      this._stderrTail = (this._stderrTail + chunk).slice(-STDERR_TAIL_MAX);
      this.emit('stderr', chunk);
    });
    stderr.on('end', () => {
      this.stderrEnded = true;
      this.maybeFinalize();
    });
    stderr.on('error', () => undefined);
  }

  /**
   * Spawns the CLI, writes `initialize` as the first line and resolves once it is answered.
   * @throws ClaudeProcessError (child exited first, initialize error, or timeout — the child is
   *         killed in the latter two cases).
   */
  static async start(opts: ClaudeStartOptions): Promise<ClaudeProcess> {
    // Node reports a missing cwd as `spawn <binary> ENOENT`, which would blame the binary.
    let cwdOk = false;
    try {
      cwdOk = fs.statSync(opts.cwd).isDirectory();
    } catch {
      /* missing */
    }
    if (!cwdOk) throw new ClaudeProcessError(`Working directory does not exist: ${opts.cwd}`);
    let proc: ClaudeProcess;
    try {
      proc = new ClaudeProcess(opts);
    } catch (e) {
      // spawn() throws synchronously for invalid arguments (e.g. NUL bytes in argv/env).
      throw new ClaudeProcessError(`Failed to start Claude Code (${opts.binary.path}): ${errorMessage(e)}`);
    }
    try {
      const resp = await proc.request<InitializeResponse>('initialize', { ...opts.initialize }, {
        timeoutMs: opts.initializeTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
      });
      proc._initializeResponse = isObj(resp) ? (resp as InitializeResponse) : {};
      return proc;
    } catch (e) {
      if (!proc._exitInfo) await proc.close({ graceMs: 0 }).catch(() => undefined);
      if (e instanceof ClaudeProcessError) throw e;
      throw new ClaudeProcessError(`Claude Code failed to initialize: ${errorMessage(e)}`, {
        stderr: proc._stderrTail,
        exitCode: proc._exitInfo?.code ?? null,
        signal: proc._exitInfo?.signal ?? null,
      });
    }
  }

  /* --------------------------------------------------------------------------------------- */
  /* Accessors                                                                                */
  /* --------------------------------------------------------------------------------------- */

  get initializeResponse(): InitializeResponse {
    return this._initializeResponse;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Current Claude session id (changes after `/clear`). */
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /** Most recent `system/init` frame (one per turn). */
  get lastInit(): SystemInitFrame | undefined {
    return this._lastInit;
  }

  /** True while a sent user line has not been answered by a `result`. */
  get busy(): boolean {
    return this.pendingUuids.length > 0;
  }

  /** Set once the child has exited (and output was drained). */
  get exitInfo(): ExitInfo | undefined {
    return this._exitInfo;
  }

  get running(): boolean {
    return !this._exitInfo && !this.stdinClosed;
  }

  /** Last ≤ 64 KiB of the child's stderr. */
  get stderrTail(): string {
    return this._stderrTail;
  }

  /* --------------------------------------------------------------------------------------- */
  /* Sending                                                                                  */
  /* --------------------------------------------------------------------------------------- */

  private notRunningError(): ClaudeProcessError {
    return new ClaudeProcessError('Claude Code process is not running', {
      stderr: this._stderrTail,
      exitCode: this._exitInfo?.code ?? null,
      signal: this._exitInfo?.signal ?? null,
    });
  }

  /** Writes one NDJSON line. Throws if stdin is closed or `obj` cannot be serialised. */
  private writeLine(obj: unknown): void {
    if (this.stdinClosed || this._exitInfo) throw this.notRunningError();
    const line = JSON.stringify(obj);
    if (typeof line !== 'string') throw new TypeError('control-protocol message is not JSON-serialisable');
    this.child.stdin!.write(line + '\n');
  }

  /** Best-effort write used for answers to CLI requests (dropped if the child is gone). */
  private tryWrite(obj: unknown): boolean {
    try {
      this.writeLine(obj);
      return true;
    } catch (e) {
      this.logger.debug?.(`dropping write to claude: ${errorMessage(e)}`);
      return false;
    }
  }

  /**
   * Writes one user line (00 §3.4) and returns its uuid. `priority` is only meaningful while a
   * turn runs (`next` = inject at the next tool boundary, `later` = own turn after the result).
   */
  sendUserMessage(
    content: string | UserContentBlock[],
    opts: { uuid?: string; priority?: 'now' | 'next' | 'later' } = {},
  ): string {
    const uuid = opts.uuid ?? randomUUID();
    if (!isUuid(uuid)) throw new TypeError(`user message uuid must be a UUID, got ${JSON.stringify(uuid)}`);
    if (this.pendingUuids.includes(uuid)) throw new TypeError(`user message uuid ${uuid} is already pending`);
    if (typeof content !== 'string' && (!Array.isArray(content) || content.length === 0)) {
      throw new TypeError('user message content must be a string or a non-empty array of content blocks');
    }
    const line: UserInputLine = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
      uuid,
      ...(opts.priority ? { priority: opts.priority } : {}),
    };
    this.pendingUuids.push(uuid);
    try {
      this.writeLine(line);
    } catch (e) {
      this.pendingUuids = this.pendingUuids.filter((u) => u !== uuid);
      throw e;
    }
    return uuid;
  }

  /**
   * Sends `content` and yields every non-control frame until (and including) the `result` that
   * answers it; returns that result. Throws synchronously if a turn is already running.
   * Aborting `signal` sends a control `interrupt` (and another one when a line that was still
   * queued starts); the turn then still ends with the CLI's (`error_during_execution`) result, or
   * a synthetic one if the CLI cancels the queued line. If the child exits mid-turn the generator throws
   * {@link ClaudeProcessError} after yielding the frames received before the exit.
   */
  turn(
    content: string | UserContentBlock[],
    opts: { uuid?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<ClaudeFrame, ResultFrame> {
    const running = this.activeTurn && !this.activeTurn.result && !this.activeTurn.error;
    if (this.busy || running) throw new Error('Claude Code is busy: a turn is already running');
    const signal = opts.signal;
    if (signal?.aborted) {
      const reason: unknown = signal.reason;
      throw reason instanceof Error ? reason : new Error('The turn was aborted before it started');
    }
    const state: TurnState = { uuid: opts.uuid ?? randomUUID(), queue: [] };
    this.activeTurn = state;
    try {
      this.sendUserMessage(content, { uuid: state.uuid });
    } catch (e) {
      this.activeTurn = undefined;
      throw e;
    }
    const onAbort = (): void => {
      if (state.aborted || state.result || state.error) return;
      state.aborted = true;
      // Not known to be running yet (queued behind a CLI-initiated turn, or no lifecycle frame
      // seen): this interrupt stops whatever runs now, and the default interrupt keeps queued
      // sends (04 §8), so interrupt again when our line reports `started`.
      if (state.lifecycle === undefined || state.lifecycle === 'queued') state.abortOnStart = true;
      this.interruptInBackground();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    state.cleanup = () => signal?.removeEventListener('abort', onAbort);
    return this.iterateTurn(state);
  }

  private async *iterateTurn(state: TurnState): AsyncGenerator<ClaudeFrame, ResultFrame> {
    try {
      for (;;) {
        const f = state.queue.shift();
        if (f) {
          yield f;
          if (f === state.result) return state.result;
          continue;
        }
        if (state.error) throw state.error;
        await new Promise<void>((resolve) => (state.wake = resolve));
        state.wake = undefined;
      }
    } finally {
      state.cleanup?.();
      if (this.activeTurn === state) this.activeTurn = undefined;
    }
  }

  /**
   * Generic host → CLI control request (00 §3.7). Resolves with `response.response`; rejects with
   * {@link ClaudeControlError} on an `error` answer or timeout (`timeoutMs`, default
   * `requestTimeoutMs`; 0 = wait forever) and with {@link ClaudeProcessError} if the child exits.
   */
  request<T = unknown>(subtype: string, payload: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (this.stdinClosed || this._exitInfo) return Promise.reject(this.notRunningError());
    const id = `req_${++this.seq}_${randomUUID().slice(0, 8)}`;
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingHostRequest = { subtype, resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pendingHost.get(id) !== entry) return;
          this.pendingHost.delete(id);
          reject(new ClaudeControlError(`Control request '${subtype}' timed out after ${timeoutMs} ms`, subtype, true));
        }, timeoutMs);
      }
      this.pendingHost.set(id, entry);
      try {
        this.writeLine({ type: 'control_request', request_id: id, request: { ...payload, subtype } });
      } catch (e) {
        this.pendingHost.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(e as Error);
      }
    });
  }

  /** Control `interrupt` (VERIFIED: running tools are stopped, turn ends `error_during_execution`). */
  async interrupt(): Promise<void> {
    await this.request('interrupt');
  }

  private interruptInBackground(): void {
    this.interrupt().catch((e) => this.logger.debug?.(`interrupt failed: ${errorMessage(e)}`));
  }

  /** Control `set_model`; `null` (or `"default"`) resets to the default model. */
  setModel(model: string | null): Promise<unknown> {
    return this.request('set_model', { model });
  }

  getContextUsage(): Promise<ContextUsage> {
    return this.request<ContextUsage>('get_context_usage', { detail: 'summary' });
  }

  mcpStatus(): Promise<McpStatus> {
    return this.request<McpStatus>('mcp_status');
  }

  getSettings(): Promise<unknown> {
    return this.request('get_settings');
  }

  /**
   * Graceful shutdown: end stdin, wait `graceMs` (default 2000), SIGTERM, wait 2 s, SIGKILL.
   * Idempotent; resolves with the exit status.
   */
  close(opts: { graceMs?: number } = {}): Promise<ExitInfo> {
    if (this.closePromise) return this.closePromise;
    const graceMs = Math.max(0, opts.graceMs ?? 2000);
    this.closePromise = (async (): Promise<ExitInfo> => {
      if (this._exitInfo) return this._exitInfo;
      if (!this.stdinClosed) {
        this.stdinClosed = true;
        try {
          this.child.stdin?.end();
        } catch {
          /* ignore */
        }
      }
      if (await this.waitExited(graceMs)) return this._exitInfo!;
      this.kill('SIGTERM');
      if (await this.waitExited(KILL_AFTER_TERM_MS)) return this._exitInfo!;
      this.kill('SIGKILL');
      if (await this.waitExited(KILL_AFTER_TERM_MS + EXIT_DRAIN_MS)) return this._exitInfo!;
      // The OS did not report an exit (should not happen); stop waiting.
      this.finalize();
      return this._exitInfo!;
    })();
    return this.closePromise;
  }

  private kill(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      /* already gone */
    }
  }

  private waitExited(ms: number): Promise<boolean> {
    if (this._exitInfo) return Promise.resolve(true);
    if (ms <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      void this.exited.then(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  /* --------------------------------------------------------------------------------------- */
  /* Reading                                                                                  */
  /* --------------------------------------------------------------------------------------- */

  private handleLine(line: string): void {
    if (line.trim() === '') return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      this.emitProtocolError(new Error(`Non-JSON line from claude: ${errorMessage(e)}`), line);
      return;
    }
    if (!isObj(msg) || typeof msg.type !== 'string') {
      this.emitProtocolError(new Error('JSON line from claude has no string "type"'), line);
      return;
    }
    try {
      this.dispatch(msg, line);
    } catch (e) {
      // A throwing 'frame' listener must not break the reader loop.
      this.logger.warn?.(`error while handling claude frame: ${errorMessage(e)}`);
      this.emitProtocolError(new Error(`Frame handler threw: ${errorMessage(e)}`), line);
    }
  }

  private emitProtocolError(err: Error, line: string): void {
    this.logger.debug?.(`${err.message}: ${line.slice(0, 200)}`);
    try {
      this.emit('protocolError', err, line);
    } catch (e) {
      this.logger.warn?.(`protocolError listener threw: ${errorMessage(e)}`);
    }
  }

  private dispatch(msg: Record<string, unknown>, line: string): void {
    switch (msg.type) {
      case 'control_response':
        this.handleControlResponse(msg, line);
        return;
      case 'control_request':
        this.handleCliRequest(msg, line);
        return;
      case 'control_cancel_request':
        this.handleCancel(msg);
        return;
      case 'keep_alive':
        return;
      default:
        this.handleFrame(msg as ClaudeFrame);
    }
  }

  private handleControlResponse(msg: Record<string, unknown>, line: string): void {
    const r = msg.response;
    if (!isObj(r) || typeof r.request_id !== 'string') {
      this.emitProtocolError(new Error('control_response without response.request_id'), line);
      return;
    }
    const entry = this.pendingHost.get(r.request_id);
    if (!entry) {
      this.logger.debug?.(`ignoring control_response for unknown/expired request ${r.request_id}`);
      return;
    }
    this.pendingHost.delete(r.request_id);
    if (entry.timer) clearTimeout(entry.timer);
    if (r.subtype === 'error') {
      entry.reject(new ClaudeControlError(typeof r.error === 'string' ? r.error : 'Control request failed', entry.subtype));
    } else {
      entry.resolve(r.response);
    }
  }

  private respond(requestId: string, payload: { response: unknown } | { error: string }): void {
    if ('response' in payload) {
      const msg = { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: payload.response } };
      let serialisable: boolean;
      let why = '';
      try {
        serialisable = typeof JSON.stringify(msg) === 'string';
      } catch (e) {
        serialisable = false;
        why = `: ${errorMessage(e)}`;
      }
      if (serialisable) {
        this.tryWrite(msg);
        return;
      }
      // A BigInt/circular handler result must not leave the CLI waiting forever (can_use_tool
      // has no timeout): answer with an error instead (00 §1 invariant 6).
      this.logger.warn?.(`answer to control_request ${requestId} is not JSON-serialisable${why}`);
      payload = { error: `handler result is not JSON-serialisable${why}` };
    }
    this.tryWrite({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: payload.error } });
  }

  private handleCliRequest(msg: Record<string, unknown>, line: string): void {
    const id = msg.request_id;
    if (typeof id !== 'string' || id === '') {
      this.emitProtocolError(new Error('control_request without request_id'), line);
      return;
    }
    const req = msg.request;
    if (!isObj(req) || typeof req.subtype !== 'string') {
      this.respond(id, { error: 'Malformed control request: missing request.subtype' });
      return;
    }
    if (this.cliRequests.has(id)) {
      this.logger.debug?.(`duplicate control_request ${id} ignored`);
      return;
    }
    const subtype = req.subtype;
    if (this.stdinClosed || this._exitInfo) {
      // stdin is closed (close() called, EPIPE, or the child exited): an answer can never be
      // delivered, so do not run the gate / Kiro hooks / a permission prompt for it.
      this.logger.debug?.(`control_request ${id} (${subtype}) arrived after stdin closed; not handled`);
      return;
    }
    const entry: CliRequestEntry = { controller: new AbortController(), done: false };
    const ctx: HandlerContext = { signal: entry.controller.signal, requestId: id };

    let pending: Promise<unknown> | undefined;
    let kind: 'hook' | 'permission' | 'other' = 'other';
    try {
      if (subtype === 'hook_callback') {
        kind = 'hook';
        pending = this.handlers.onHookCallback(req as unknown as HookCallbackRequest, ctx);
      } else if (subtype === 'can_use_tool') {
        kind = 'permission';
        pending = this.handlers.onCanUseTool(req as unknown as CanUseToolRequest, ctx);
      } else {
        pending = this.handlers.onOtherControlRequest?.(subtype, req, ctx);
      }
    } catch (e) {
      pending = Promise.reject(e);
    }
    if (pending === undefined) {
      this.respond(id, { error: `Unsupported control request subtype: ${subtype}` });
      return;
    }
    this.cliRequests.set(id, entry);
    const finish = (payload: { response: unknown } | { error: string }): void => {
      if (entry.done) return;
      entry.done = true;
      if (this.cliRequests.get(id) === entry) this.cliRequests.delete(id);
      if (entry.controller.signal.aborted) return; // cancelled or child gone: never answer
      this.respond(id, payload);
    };
    Promise.resolve(pending).then(
      (value) => {
        if (kind === 'permission') {
          const checked = validatePermissionResult(value);
          if (typeof checked === 'string') finish({ error: checked });
          else finish({ response: checked });
        } else if (kind === 'hook') {
          finish({ response: isObj(value) ? value : {} });
        } else {
          finish({ response: value ?? {} });
        }
      },
      (err) => finish({ error: errorMessage(err) }),
    );
  }

  private handleCancel(msg: Record<string, unknown>): void {
    const id = msg.request_id;
    if (typeof id !== 'string') return;
    const entry = this.cliRequests.get(id);
    if (!entry) return;
    this.cliRequests.delete(id);
    entry.controller.abort(new Error(`Control request ${id} was cancelled by Claude Code`));
  }

  private settleUuid(uuid: string): void {
    const i = this.pendingUuids.indexOf(uuid);
    if (i >= 0) this.pendingUuids.splice(i, 1);
  }

  private handleFrame(frame: ClaudeFrame): void {
    const f = frame as Record<string, unknown>;
    if (f.type === 'system' && f.subtype === 'init') {
      if (typeof f.session_id === 'string' && f.session_id) this._sessionId = f.session_id;
      this._lastInit = frame as SystemInitFrame;
    } else if (f.type === 'conversation_reset') {
      if (typeof f.new_conversation_id === 'string' && f.new_conversation_id) this._sessionId = f.new_conversation_id;
    } else if (f.type === 'result') {
      const uuids = resultUserUuids(f);
      if (uuids.length > 0) for (const u of uuids) this.settleUuid(u);
      else this.pendingUuids.shift();
    } else if (f.type === 'command_lifecycle') {
      if ((f.state === 'completed' || f.state === 'cancelled') && typeof f.command_uuid === 'string') {
        this.settleUuid(f.command_uuid);
      }
    }

    const turn = this.activeTurn;
    if (turn && !turn.result && !turn.error) {
      turn.queue.push(frame);
      if (f.type === 'result' && resultMatchesUuid(f, turn.uuid)) {
        turn.result = frame as ResultFrame;
        turn.cleanup?.();
      } else if (f.type === 'command_lifecycle' && f.command_uuid === turn.uuid && typeof f.state === 'string') {
        this.onTurnLifecycle(turn, f.state);
      }
      turn.wake?.();
    }
    this.emit('frame', frame);
  }

  /**
   * Lifecycle of the active turn's own line: a deferred abort is delivered on `started`; a line
   * `cancelled` before it ever started will never get a `result`, so the turn ends with a
   * synthetic one (`synthetic:true`, `is_error:true`, `terminal_reason:"cancelled"`; yielded by
   * {@link turn} but not emitted as a `'frame'`). A `cancelled` after `started` waits for the
   * real result of the running turn.
   */
  private onTurnLifecycle(turn: TurnState, state: string): void {
    const before = turn.lifecycle;
    turn.lifecycle = state;
    if (state === 'started' && turn.abortOnStart) {
      turn.abortOnStart = false;
      this.interruptInBackground();
    } else if (state === 'cancelled' && before !== 'started') {
      const synthetic: ResultFrame = {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: '',
        num_turns: 0,
        terminal_reason: 'cancelled',
        session_id: this._sessionId ?? '',
        user_message_uuids: [turn.uuid],
        synthetic: true,
      };
      turn.queue.push(synthetic);
      turn.result = synthetic;
      turn.cleanup?.();
    }
  }

  /* --------------------------------------------------------------------------------------- */
  /* Exit                                                                                     */
  /* --------------------------------------------------------------------------------------- */

  /** Finalizes once the child exited and both output pipes are drained. */
  private maybeFinalize(): boolean {
    if (this.exitSeen && this.stdoutEnded && this.stderrEnded) {
      this.finalize();
      return true;
    }
    return false;
  }

  private finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    if (this.exitTimer) clearTimeout(this.exitTimer);
    this.stdinClosed = true;
    if (!this.stdoutEnded) {
      this.stdoutEnded = true;
      for (const line of this.splitter.end()) this.handleLine(line);
    }
    const info: ExitInfo = { code: this.exitCode, signal: this.exitSignal };
    this._exitInfo = info;

    const err = this.exitError(info);
    for (const [id, entry] of this.pendingHost) {
      this.pendingHost.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    for (const [id, entry] of this.cliRequests) {
      this.cliRequests.delete(id);
      entry.controller.abort(err);
    }
    this.pendingUuids = [];
    const turn = this.activeTurn;
    if (turn && !turn.result && !turn.error) {
      turn.error = err;
      turn.cleanup?.();
      turn.wake?.();
    }
    try {
      this.emit('exit', info);
    } catch (e) {
      this.logger.warn?.(`exit listener threw: ${errorMessage(e)}`);
    }
    this.resolveExited(info);
  }

  private exitError(info: ExitInfo): ClaudeProcessError {
    let message: string;
    if (this.spawnError) {
      message = `Failed to start Claude Code (${this.binaryPath}): ${this.spawnError.message}`;
    } else {
      const how = info.signal ? `signal ${info.signal}` : `exit code ${info.code}`;
      const lastErr = this._stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
      message = `Claude Code exited (${how})${lastErr ? `: ${lastErr}` : ''}`;
    }
    return new ClaudeProcessError(message, { stderr: this._stderrTail, exitCode: info.code, signal: info.signal });
  }
}
