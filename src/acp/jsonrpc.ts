/**
 * Newline-delimited JSON-RPC 2.0 over a byte-stream pair — the ACP stdio transport
 * (research 05 §3, 08 KC-ACP-16).
 *
 * Framing: one UTF-8 JSON object per line, `\n` delimited (`\r\n` tolerated), blank lines
 * skipped. A line that is not JSON gets `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,…}}`
 * and the connection keeps going. Inbound lines are limited to {@link MAX_INBOUND_LINE_BYTES}
 * (32 MiB, the ACP SDK default); a longer line is discarded and answered with a parse error.
 *
 * Output: every frame goes through {@link JsonRpcConnection.send}, a single synchronous writer
 * (`JSON.stringify(msg) + "\n"`), so frames never interleave and are written in call order —
 * the server relies on that to put `session/update` notifications before the response that
 * ends the operation (05 §3). Nothing but JSON-RPC frames is ever written to the output.
 * Outbound frames are capped at {@link MAX_FRAME_BYTES} (10 MiB, 08 KC-ACP-16): an oversized
 * frame has its longest strings truncated until it fits; if it still does not fit, a response
 * becomes a `-32603` error and a notification is dropped (logged).
 *
 * Messages: request `{jsonrpc,id,method,params}`, notification `{jsonrpc,method,params}`,
 * response `{jsonrpc,id,result}` / `{jsonrpc,id,error:{code,message,data?}}`. Ids are echoed
 * exactly. Our own (agent → client) requests use UUID string ids like kiro-cli (05 §3).
 * Unknown request methods ⇒ `-32601`; unknown notifications are ignored (05 §4.15).
 *
 * Error codes (05 §3, ACP SDK `ErrorCode`): see {@link ErrorCodes}. kiro-cli puts the human
 * detail in `data` as a string (`{"code":-32603,"message":"Internal error","data":"Session not
 * found"}`); {@link internalError} builds exactly that shape.
 */

import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

export type JsonRpcId = string | number | null;

/** JSON-RPC / ACP error codes (05 §3). */
export const ErrorCodes = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  REQUEST_CANCELLED: -32800,
  AUTH_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,
});

/** 10 MiB: no outbound frame is ever larger (08 KC-ACP-16). */
export const MAX_FRAME_BYTES = 10 * 1024 * 1024;
/** 32 MiB: inbound line limit (ACP SDK `DEFAULT_MAX_MESSAGE_BYTES`, 05 §3). */
export const MAX_INBOUND_LINE_BYTES = 32 * 1024 * 1024;

/** An error answered as a JSON-RPC error object. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
  toJSON(): { code: number; message: string; data?: unknown } {
    return { code: this.code, message: this.message, ...(this.data !== undefined ? { data: this.data } : {}) };
  }
}

/** `{"code":-32603,"message":"Internal error","data":"<detail>"}` (kiro-cli shape). */
export function internalError(detail: string): RpcError {
  return new RpcError(ErrorCodes.INTERNAL_ERROR, 'Internal error', detail);
}

/** `{"code":-32602,"message":"Invalid params","data":"<detail>"}`. */
export function invalidParams(detail: string): RpcError {
  return new RpcError(ErrorCodes.INVALID_PARAMS, 'Invalid params', detail);
}

/** `{"code":-32601,"message":"Method not found","data":"<method>"}` (05 §4.15). */
export function methodNotFound(method: string): RpcError {
  return new RpcError(ErrorCodes.METHOD_NOT_FOUND, 'Method not found', method);
}

/**
 * A request-handler result that also wants frames written right AFTER the response (e.g. the
 * `_kiro.dev/mcp/server_initialized` notifications that follow a `session/new` answer).
 */
export class ResultThen {
  constructor(
    readonly result: unknown,
    readonly after: () => void | Promise<void>,
  ) {}
}

/** Answer `result`, then run `after` (its errors are logged, never answered). */
export function respondThen(result: unknown, after: () => void | Promise<void>): ResultThen {
  return new ResultThen(result, after);
}

export interface RequestContext {
  id: Exclude<JsonRpcId, null>;
  method: string;
  /** Aborted when the client sends `$/cancel_request` for this id or the connection closes. */
  signal: AbortSignal;
}

export type RequestHandler = (method: string, params: unknown, ctx: RequestContext) => unknown;
export type NotificationHandler = (method: string, params: unknown) => void | Promise<void>;

export interface JsonRpcLogger {
  error(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  debug(...a: unknown[]): void;
}

export interface JsonRpcConnectionOptions {
  input: Readable;
  output: Writable;
  onRequest: RequestHandler;
  onNotification?: NotificationHandler;
  logger?: JsonRpcLogger;
  /** Override for tests. */
  maxFrameBytes?: number;
  /** Override for tests. */
  maxInboundLineBytes?: number;
  /** Id generator for outgoing requests (default `randomUUID`). */
  newId?: () => string;
}

interface PendingOutgoing {
  method: string;
  resolve(v: unknown): void;
  reject(e: Error): void;
  cleanup(): void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isValidId(v: unknown): v is string | number {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

/** Truncate every string longer than `limit` characters (recursively, new object). */
function truncateStrings(v: unknown, limit: number): unknown {
  if (typeof v === 'string') {
    if (v.length <= limit) return v;
    return `${v.slice(0, limit)}\n… [truncated ${v.length - limit} characters]`;
  }
  if (Array.isArray(v)) return v.map((x) => truncateStrings(x, limit));
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = truncateStrings(x, limit);
    return out;
  }
  return v;
}

/**
 * Serialize `msg` so the line (without `\n`) is at most `maxBytes` UTF-8 bytes, truncating long
 * strings when needed. `undefined` when it cannot be made to fit.
 */
export function serializeBounded(msg: unknown, maxBytes: number = MAX_FRAME_BYTES): string | undefined {
  let s = JSON.stringify(msg);
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  // A string of N chars is at most 3N bytes in UTF-8 (+ escaping); shrink until it fits.
  let limit = Math.max(1024, Math.floor(maxBytes / 4));
  for (let i = 0; i < 12 && limit >= 64; i++) {
    s = JSON.stringify(truncateStrings(msg, limit));
    if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
    limit = Math.floor(limit / 4);
  }
  return undefined;
}

/** One JSON-RPC peer over newline-delimited JSON (see module doc). */
export class JsonRpcConnection {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly onRequest: RequestHandler;
  private readonly onNotification: NotificationHandler | undefined;
  private readonly logger: JsonRpcLogger | undefined;
  private readonly maxFrameBytes: number;
  private readonly maxInboundLineBytes: number;
  private readonly newId: () => string;

  private readonly pendingOut = new Map<string | number, PendingOutgoing>();
  private readonly incoming = new Map<string | number, AbortController>();
  private readonly decoder = new StringDecoder('utf8');
  private parts: string[] = [];
  private partBytes = 0;
  private discarding = false;
  private _closed = false;
  private _inputEnded = false;
  private endedResolve: (() => void) | undefined;
  private readonly ended: Promise<void>;
  private started = false;

  constructor(opts: JsonRpcConnectionOptions) {
    this.input = opts.input;
    this.output = opts.output;
    this.onRequest = opts.onRequest;
    this.onNotification = opts.onNotification;
    this.logger = opts.logger;
    this.maxFrameBytes = opts.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.maxInboundLineBytes = opts.maxInboundLineBytes ?? MAX_INBOUND_LINE_BYTES;
    this.newId = opts.newId ?? randomUUID;
    this.ended = new Promise<void>((r) => {
      this.endedResolve = r;
    });
  }

  /** True once the output failed (EPIPE) or {@link close} was called: nothing is written any more. */
  get closed(): boolean {
    return this._closed;
  }

  /** True once the input reached EOF (the output stays usable until {@link close}). */
  get inputEnded(): boolean {
    return this._inputEnded;
  }

  /** Ids of incoming requests whose handler has not answered yet. */
  get inFlightRequestIds(): Array<string | number> {
    return [...this.incoming.keys()];
  }

  /**
   * Start reading. Resolves when the input ends (EOF/close/error) or the output breaks.
   * At input EOF our pending outgoing requests are rejected (nobody can answer them any more)
   * but the output stays open, so handlers still running can write their answers until the
   * owner calls {@link close}.
   */
  start(): Promise<void> {
    if (this.started) return this.ended;
    this.started = true;
    this.input.on('data', this.dataListener);
    this.input.once('end', this.endListener);
    this.input.once('close', this.endListener);
    this.input.once('error', this.errorListener);
    this.output.on('error', (e: NodeJS.ErrnoException) => {
      this.logger?.warn('acp: stdout error:', e.code ?? e.message);
      this.close();
    });
    return this.ended;
  }

  /** Resolves when the connection is done (see {@link start}). */
  done(): Promise<void> {
    return this.ended;
  }

  private readonly dataListener = (chunk: Buffer | string): void => this.onData(chunk);
  private readonly endListener = (): void => this.finishInput();
  private readonly errorListener = (e: unknown): void => {
    this.logger?.warn('acp: stdin error:', e);
    this.finishInput();
  };

  /**
   * Stop: no more output; stop reading (listeners removed, input paused so a still-open stdin
   * does not keep the process alive); reject pending outgoing requests; abort incoming handlers'
   * signals. Idempotent.
   */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.input.removeListener('data', this.dataListener);
    this.input.removeListener('end', this.endListener);
    this.input.removeListener('close', this.endListener);
    this.input.removeListener('error', this.errorListener);
    this.input.on('error', () => undefined);
    try {
      this.input.pause();
    } catch {
      // ignore
    }
    this.rejectPendingOut('Connection closed');
    for (const c of this.incoming.values()) c.abort();
    this.endedResolve?.();
  }

  private rejectPendingOut(why: string): void {
    for (const [id, p] of [...this.pendingOut]) {
      this.pendingOut.delete(id);
      p.cleanup();
      p.reject(new RpcError(ErrorCodes.REQUEST_CANCELLED, why));
    }
  }

  private finishInput(): void {
    if (this._inputEnded || this._closed) return;
    this._inputEnded = true;
    const tail = this.decoder.end();
    if (tail) this.appendPart(tail);
    if (this.parts.length > 0 && !this.discarding) {
      const line = this.parts.join('');
      this.parts = [];
      this.partBytes = 0;
      this.handleLine(line);
    }
    this.rejectPendingOut('Input closed');
    this.endedResolve?.();
  }

  private appendPart(s: string): void {
    if (this.discarding) return;
    this.parts.push(s);
    this.partBytes += Buffer.byteLength(s, 'utf8');
    if (this.partBytes > this.maxInboundLineBytes) {
      this.parts = [];
      this.partBytes = 0;
      this.discarding = true;
    }
  }

  private onData(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let start = 0;
    let nl = text.indexOf('\n');
    while (nl !== -1) {
      const piece = text.slice(start, nl);
      if (this.discarding) {
        this.discarding = false;
        this.parts = [];
        this.partBytes = 0;
        this.writeFrame({ jsonrpc: '2.0', id: null, error: { code: ErrorCodes.PARSE_ERROR, message: 'Parse error', data: 'Message too large' } });
      } else {
        this.appendPart(piece);
        if (this.discarding) {
          this.discarding = false;
          this.writeFrame({ jsonrpc: '2.0', id: null, error: { code: ErrorCodes.PARSE_ERROR, message: 'Parse error', data: 'Message too large' } });
        } else {
          const line = this.parts.join('');
          this.parts = [];
          this.partBytes = 0;
          this.handleLine(line);
        }
      }
      start = nl + 1;
      nl = text.indexOf('\n', start);
    }
    if (start < text.length) this.appendPart(start === 0 ? text : text.slice(start));
  }

  private handleLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.logger?.warn('acp: unparseable input line');
      this.writeFrame({ jsonrpc: '2.0', id: null, error: { code: ErrorCodes.PARSE_ERROR, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(msg)) {
      // ACP never batches; answer each element on its own line.
      if (msg.length === 0) {
        this.writeFrame({ jsonrpc: '2.0', id: null, error: { code: ErrorCodes.INVALID_REQUEST, message: 'Invalid Request' } });
        return;
      }
      for (const m of msg) this.dispatch(m);
      return;
    }
    this.dispatch(msg);
  }

  private dispatch(msg: unknown): void {
    if (!isObj(msg)) {
      this.writeFrame({ jsonrpc: '2.0', id: null, error: { code: ErrorCodes.INVALID_REQUEST, message: 'Invalid Request' } });
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
    if (typeof msg.method === 'string') {
      if (hasId) {
        if (!isValidId(msg.id)) {
          this.writeFrame({ jsonrpc: '2.0', id: null, error: { code: ErrorCodes.INVALID_REQUEST, message: 'Invalid Request', data: 'invalid id' } });
          return;
        }
        this.handleRequest(msg.id, msg.method, msg.params);
      } else {
        this.handleNotification(msg.method, msg.params);
      }
      return;
    }
    if (hasId && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
      this.handleResponse(msg);
      return;
    }
    const id = hasId && isValidId(msg.id) ? msg.id : null;
    this.writeFrame({ jsonrpc: '2.0', id, error: { code: ErrorCodes.INVALID_REQUEST, message: 'Invalid Request' } });
  }

  private handleRequest(id: string | number, method: string, params: unknown): void {
    const controller = new AbortController();
    // A duplicate in-flight id is a client bug; the newer request still gets an answer.
    this.incoming.set(id, controller);
    const ctx: RequestContext = { id, method, signal: controller.signal };
    let out: unknown;
    try {
      out = this.onRequest(method, params, ctx);
    } catch (e) {
      this.finishRequest(id, controller, undefined, e);
      return;
    }
    Promise.resolve(out).then(
      (v) => this.finishRequest(id, controller, v, undefined),
      (e) => this.finishRequest(id, controller, undefined, e),
    );
  }

  private finishRequest(id: string | number, controller: AbortController, value: unknown, err: unknown): void {
    if (this.incoming.get(id) === controller) this.incoming.delete(id);
    if (err !== undefined) {
      if (!this.writeFrame({ jsonrpc: '2.0', id, error: toErrorObject(err, this.logger) }) && !this._closed) {
        this.writeFrame({ jsonrpc: '2.0', id, error: { code: ErrorCodes.INTERNAL_ERROR, message: 'Internal error' } });
      }
      return;
    }
    let after: (() => void | Promise<void>) | undefined;
    let result = value;
    if (value instanceof ResultThen) {
      result = value.result;
      after = value.after;
    }
    this.writeResponse(id, result === undefined ? {} : result);
    if (after) {
      try {
        Promise.resolve(after()).catch((e) => this.logger?.warn('acp: post-response work failed:', e));
      } catch (e) {
        this.logger?.warn('acp: post-response work failed:', e);
      }
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === '$/cancel_request') {
      const rid = isObj(params) ? params.requestId : undefined;
      if (isValidId(rid)) this.incoming.get(rid)?.abort();
      // Also forwarded so the server can treat it as session/cancel (05 §4.14).
    }
    if (!this.onNotification) return;
    try {
      Promise.resolve(this.onNotification(method, params)).catch((e) => this.logger?.warn(`acp: notification ${method} failed:`, e));
    } catch (e) {
      this.logger?.warn(`acp: notification ${method} failed:`, e);
    }
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as string | number;
    const p = isValidId(id) ? this.pendingOut.get(id) : undefined;
    if (!p) {
      this.logger?.debug('acp: response for unknown request id', id);
      return;
    }
    this.pendingOut.delete(id);
    p.cleanup();
    if (Object.prototype.hasOwnProperty.call(msg, 'error') && msg.error !== undefined && msg.error !== null) {
      const e = isObj(msg.error) ? msg.error : {};
      const code = typeof e.code === 'number' ? e.code : ErrorCodes.INTERNAL_ERROR;
      const message = typeof e.message === 'string' ? e.message : 'Unknown error';
      p.reject(new RpcError(code, message, e.data));
      return;
    }
    p.resolve(msg.result);
  }

  /** Send a notification. Returns false when nothing was written (closed or oversized). */
  notify(method: string, params?: unknown): boolean {
    return this.writeFrame({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  /**
   * Send a request to the client; resolves with its `result`, rejects with an {@link RpcError}
   * for an error answer. With `signal`: on abort the request is withdrawn with
   * `$/cancel_request` (05 §4.14) and the promise rejects with `-32800`; a later answer is
   * ignored.
   */
  request(method: string, params?: unknown, opts: { signal?: AbortSignal; id?: string } = {}): { id: string; promise: Promise<unknown> } {
    const id = opts.id ?? this.newId();
    const promise = new Promise<unknown>((resolve, reject) => {
      if (this._closed || this._inputEnded) {
        reject(new RpcError(ErrorCodes.REQUEST_CANCELLED, 'Connection closed'));
        return;
      }
      const signal = opts.signal;
      const onAbort = (): void => {
        if (!this.pendingOut.has(id)) return;
        this.pendingOut.delete(id);
        this.notify('$/cancel_request', { requestId: id });
        reject(new RpcError(ErrorCodes.REQUEST_CANCELLED, 'Request cancelled'));
      };
      if (signal?.aborted) {
        reject(new RpcError(ErrorCodes.REQUEST_CANCELLED, 'Request cancelled'));
        return;
      }
      this.pendingOut.set(id, {
        method,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      const ok = this.writeFrame({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      if (!ok) {
        this.pendingOut.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(new RpcError(ErrorCodes.INTERNAL_ERROR, 'Internal error', 'request could not be written'));
      }
    });
    return { id, promise };
  }

  /** Ids of our requests still waiting for the client. */
  get pendingRequestIds(): string[] {
    return [...this.pendingOut.keys()].map(String);
  }

  private writeResponse(id: string | number, result: unknown): void {
    if (!this.writeFrame({ jsonrpc: '2.0', id, result })) {
      if (!this._closed) {
        const data = this.lastWriteFailure === 'unserializable' ? 'Response could not be serialized' : 'Response too large';
        this.writeFrame({ jsonrpc: '2.0', id, error: { code: ErrorCodes.INTERNAL_ERROR, message: 'Internal error', data } });
      }
    }
  }

  /** Why the last {@link writeFrame} returned false (for the fallback error answer). */
  private lastWriteFailure: 'oversized' | 'unserializable' | undefined;

  /**
   * The single writer (see module doc). Never throws: a frame that cannot be serialized
   * (BigInt, cycle) or made small enough is dropped and logged, and the caller sees `false`.
   */
  private writeFrame(frame: Record<string, unknown>): boolean {
    if (this._closed) return false;
    let line: string | undefined;
    try {
      line = serializeBounded(frame, this.maxFrameBytes);
    } catch (e) {
      this.lastWriteFailure = 'unserializable';
      this.logger?.error(`acp: dropped a frame that cannot be serialized (${String(frame.method ?? `response ${String(frame.id)}`)}):`, e instanceof Error ? e.message : e);
      return false;
    }
    if (line === undefined) {
      this.lastWriteFailure = 'oversized';
      this.logger?.error(`acp: dropped an oversized frame (${String(frame.method ?? `response ${String(frame.id)}`)})`);
      return false;
    }
    try {
      this.output.write(`${line}\n`);
    } catch (e) {
      this.logger?.warn('acp: write failed:', e);
      this.close();
      return false;
    }
    return true;
  }
}

function toErrorObject(err: unknown, logger?: JsonRpcLogger): { code: number; message: string; data?: unknown } {
  if (err instanceof RpcError) return err.toJSON();
  const msg = err instanceof Error ? err.message || err.name : typeof err === 'string' ? err : 'Internal error';
  logger?.debug('acp: handler error:', err);
  return { code: ErrorCodes.INTERNAL_ERROR, message: 'Internal error', data: msg };
}
