/**
 * Test helpers for the ACP server: isolated temp environments, agent files, and a scripted
 * ACP client that drives `runAcp` over in-memory streams and records every frame.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import type { CliContext } from '../../src/types.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { openSettings } from '../../src/config/settings.js';
import { runAcp, type AcpServer, type AcpServerTimings, type SessionFactory } from '../../src/acp/server.js';
import { createLogger } from '../../src/util/log.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { removeOnExit } from '../tmpdirs.js';

export interface TmpEnv {
  root: string;
  home: string;
  kiroHome: string;
  claudeConfig: string;
  work: string;
  env: NodeJS.ProcessEnv;
}

/** A fresh HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / work dir; nothing real is touched. */
export function tmpEnv(extra: Record<string, string | undefined> = {}): TmpEnv {
  const root = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-acp-'))));
  const home = path.join(root, 'home');
  const kiroHome = path.join(home, '.kiro');
  const claudeConfig = path.join(home, '.claude');
  const work = path.join(root, 'work');
  for (const d of [home, kiroHome, claudeConfig, work]) fs.mkdirSync(d, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    KIRO_HOME: kiroHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    KIRO_CHAT_LOG_FILE: path.join(root, 'acp.log'),
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    TMPDIR: path.join(root, 'tmp'),
    ...extra,
  };
  fs.mkdirSync(env.TMPDIR!, { recursive: true });
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return { root, home, kiroHome, claudeConfig, work, env };
}

/** Write `<dir>/agents/<name>.json` (dir = a KIRO_HOME or a workspace `.kiro`). */
export function writeAgent(kiroDir: string, name: string, spec: Record<string, unknown>): string {
  const dir = path.join(kiroDir, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ name, ...spec }, null, 2));
  return file;
}

export type Frame = Record<string, any>;

/** Answers agent → client requests (default: allow once). */
export type PermissionResponder = (req: Frame) => unknown | Promise<unknown> | undefined;

export interface StartClientOptions {
  args?: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  createSession?: SessionFactory;
  timings?: Partial<AcpServerTimings>;
  /** Default answer to `session/request_permission`. */
  onPermission?: PermissionResponder;
}

/**
 * A scripted ACP client over in-memory stdio. `frames` holds every agent → client line in
 * order (parsed); `raw` the exact text. Throws (in `nonJson`) if anything but JSON appears.
 */
export class TestClient {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly frames: Frame[] = [];
  readonly raw: string[] = [];
  readonly nonJson: string[] = [];
  stderrText = '';
  exitCode: number | undefined;
  readonly exited: Promise<number>;
  server: AcpServer | undefined;
  onPermission: PermissionResponder;
  private nextId = 1;
  private buf = '';
  private waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void; from: number }> = [];

  constructor(opts: StartClientOptions) {
    this.onPermission = opts.onPermission ?? (() => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }));
    const ws = createWorkspaceContext(opts.cwd, opts.env);
    const ctx: CliContext = {
      ws,
      settings: openSettings(ws),
      stdin: this.stdin as unknown as NodeJS.ReadStream,
      stdout: this.stdout as unknown as NodeJS.WriteStream,
      stderr: this.stderr as unknown as NodeJS.WriteStream,
      progName: 'kiro-claude',
      verbosity: 0,
    };
    this.stderr.on('data', (c: Buffer) => (this.stderrText += c.toString('utf8')));
    this.stdout.on('data', (c: Buffer) => this.onData(c.toString('utf8')));
    this.exited = runAcp(opts.args ?? [], ctx, {
      ...(opts.createSession ? { createSession: opts.createSession } : {}),
      timings: { mcpPollMs: 10, usageTimeoutMs: 500, ...opts.timings },
      logger: createLogger({ env: opts.env, level: 'debug', file: opts.env.KIRO_CHAT_LOG_FILE ?? path.join(os.tmpdir(), 'kc-acp-test.log') }),
      onServer: (s) => (this.server = s),
    }).then((c) => {
      this.exitCode = c;
      return c;
    });
  }

  private onData(s: string): void {
    this.buf += s;
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.raw.push(line);
      let f: Frame;
      try {
        f = JSON.parse(line) as Frame;
      } catch {
        this.nonJson.push(line);
        nl = this.buf.indexOf('\n');
        continue;
      }
      this.frames.push(f);
      this.onFrame(f);
      nl = this.buf.indexOf('\n');
    }
  }

  private onFrame(f: Frame): void {
    if (typeof f.method === 'string' && f.id !== undefined && f.id !== null) {
      if (f.method === 'session/request_permission') {
        void Promise.resolve(this.onPermission(f)).then((result) => {
          if (result === undefined) return; // test answers manually
          this.send({ jsonrpc: '2.0', id: f.id, result });
        });
      }
    }
    const idx = this.frames.length - 1;
    for (const w of [...this.waiters]) {
      if (idx >= w.from && w.pred(f)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(f);
      }
    }
  }

  send(msg: unknown): void {
    this.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  sendRaw(line: string): void {
    this.stdin.write(line);
  }

  /** Answer an agent → client request. */
  respond(id: unknown, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  /** Send a request; resolves with the whole response frame. */
  request(method: string, params: unknown = {}, timeoutMs = 10_000): Promise<Frame> {
    const id = this.nextId++;
    const p = this.waitFor((f) => f.id === id && f.method === undefined && ('result' in f || 'error' in f), timeoutMs, `response to ${method}#${id}`, this.frames.length);
    this.send({ jsonrpc: '2.0', id, method, params });
    return p;
  }

  /** `request` that asserts success and returns `result`. */
  async call(method: string, params: unknown = {}, timeoutMs = 10_000): Promise<any> {
    const r = await this.request(method, params, timeoutMs);
    if (r.error) throw new Error(`${method} failed: ${JSON.stringify(r.error)}`);
    return r.result;
  }

  notify(method: string, params: unknown = {}): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Wait for a frame (at index ≥ `from`, default: any already received) matching `pred`. */
  waitFor(pred: (f: Frame) => boolean, timeoutMs = 10_000, what = 'frame', from = 0): Promise<Frame> {
    for (let i = from; i < this.frames.length; i++) if (pred(this.frames[i]!)) return Promise.resolve(this.frames[i]!);
    return new Promise<Frame>((resolve, reject) => {
      const w = { pred, resolve: (f: Frame) => (clearTimeout(t), resolve(f)), from };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timed out waiting for ${what}; frames:\n${this.raw.slice(-30).join('\n')}`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /** `session/update` payloads (optionally of one kind / session). */
  updates(kind?: string, sessionId?: string): Frame[] {
    return this.frames
      .filter((f) => f.method === 'session/update' && (!sessionId || f.params?.sessionId === sessionId))
      .map((f) => f.params.update as Frame)
      .filter((u) => !kind || u.sessionUpdate === kind);
  }

  /** Notifications with `method`. */
  notifications(method: string): Frame[] {
    return this.frames.filter((f) => f.method === method && f.id === undefined);
  }

  /** Index of the first frame matching `pred` (−1 when none). */
  indexOf(pred: (f: Frame) => boolean): number {
    return this.frames.findIndex(pred);
  }

  async initialize(params: Record<string, unknown> = KIROCREW_INITIALIZE): Promise<any> {
    return this.call('initialize', params);
  }

  /** Close stdin and wait for the server to exit. */
  async close(timeoutMs = 10_000): Promise<number> {
    this.stdin.end();
    let t: NodeJS.Timeout | undefined;
    const r = await Promise.race([
      this.exited,
      new Promise<number>((_, rej) => (t = setTimeout(() => rej(new Error('server did not exit')), timeoutMs))),
    ]);
    if (t) clearTimeout(t);
    return r;
  }
}

/** KiroCrew's exact `initialize` params (08b §4.4). */
export const KIROCREW_INITIALIZE = Object.freeze({
  clientInfo: { name: 'kirocrew', version: '0.13.0' },
  protocolVersion: '2025-08-22',
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {}, url: {} } },
});

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `pred()` holds. */
export async function until(pred: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/**
 * KiroCrew's `chat_agent_engines` parser (KC kiro_cli.py:360-378, 05 §2.2): text after
 * `--agent-engine` up to the next `\n      --`, then `[possible values: …]`.
 */
export function kiroCrewAgentEngines(help: string): string[] | undefined {
  const i = help.indexOf('--agent-engine');
  if (i < 0) return undefined;
  const rest = help.slice(i);
  const end = rest.indexOf('\n      --', 1);
  const block = end >= 0 ? rest.slice(0, end) : rest;
  const m = /\[possible values:\s*([^\]]*)\]/.exec(block);
  if (!m) return undefined;
  return m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
}
