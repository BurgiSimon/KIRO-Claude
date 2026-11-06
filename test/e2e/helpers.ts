/**
 * Helpers for the opt-in end-to-end suite (test/e2e/cli-real.test.ts) that drives the BUILT
 * kiro-claude CLI as a child process against the REAL `claude` on PATH, with the user's
 * existing Claude Code login (model calls bill the user's subscription).
 *
 * Isolation: kiro-claude state goes to `KIRO_HOME=<temp>/kiro-home`, the project is a temp dir
 * (`git init`) used as cwd. HOME and CLAUDE_CONFIG_DIR are deliberately NOT overridden (that
 * would hide the login). Inherited `KIRO_*` / `FAKE_CLAUDE_*` variables (e.g. a
 * `KIRO_CLAUDE_BIN` pointing at the fake) are dropped so the real binary is used.
 *
 * Environment knobs: `KIRO_CLAUDE_E2E=1` (run at all), `KIRO_CLAUDE_E2E_MODEL` (default
 * `haiku`), `KIRO_CLAUDE_E2E_KEEP=1` (keep temp dirs and the Claude transcripts of the temp
 * projects for debugging; they are printed as test diagnostics).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { whichSync } from '../../src/claude/binary.js';
import { claudeProjectsDir, sanitizeProjectDir } from '../../src/claude/transcript.js';
import { stripAnsi } from '../../src/util/ansi.js';

export const E2E = process.env.KIRO_CLAUDE_E2E === '1';
export const SKIP_REASON = 'set KIRO_CLAUDE_E2E=1 to run (real Claude Code model calls on your account)';
export const MODEL = (process.env.KIRO_CLAUDE_E2E_MODEL ?? '').trim() || 'haiku';
export const KEEP = process.env.KIRO_CLAUDE_E2E_KEEP === '1';

/** The built CLI next to this compiled file: `<outDir>/test/e2e/helpers.js` ⇒ `<outDir>/src/bin/kiro-claude.js`. */
export const CLI_PATH = fileURLToPath(new URL('../../src/bin/kiro-claude.js', import.meta.url));

/**
 * One e2e case. Without `KIRO_CLAUDE_E2E=1` the body never runs: the test is reported as
 * skipped (`t.skip(SKIP_REASON)`).
 */
export function e2eTest(name: string, timeoutMs: number, fn: (t: TestContext) => Promise<void>): void {
  test(name, { timeout: timeoutMs }, async (t) => {
    if (!E2E) {
      t.skip(SKIP_REASON);
      return;
    }
    await fn(t);
  });
}

/** The caller's environment minus kiro-claude / fake-claude overrides, plus `extra`. */
export function e2eEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // KIRO_CLAUDE_BIN, KIRO_CLAUDE_SESSIONS_DIR, KIRO_AGENT_CONFIG_DIR, KIRO_HOME, FAKE_CLAUDE_* …
    if (/^(KIRO_|FAKE_CLAUDE_)/i.test(k)) continue;
    if (k === 'FORCE_COLOR') continue;
    env[k] = v;
  }
  env.NO_COLOR = '1';
  return { ...env, ...extra };
}

/** Absolute path of the real `claude` on PATH (never the fake, never `$KIRO_CLAUDE_BIN`). */
export function realClaudePath(): string {
  const p = whichSync('claude', e2eEnv());
  assert.ok(p, 'KIRO_CLAUDE_E2E=1 but no `claude` on PATH (install Claude Code and log in)');
  return fs.realpathSync(p);
}

export interface E2EProject {
  /** Unique temp root (realpath). */
  root: string;
  /** cwd of every run: `<root>/project`, a fresh git repository. */
  project: string;
  /** `KIRO_HOME` of every run. */
  kiroHome: string;
  /** kiro-claude log file (`KIRO_CHAT_LOG_FILE`). */
  logFile: string;
  /** Env for the CLI child (see module doc). */
  env: NodeJS.ProcessEnv;
  /** Random marker unique to this project (for codewords etc.). */
  token: string;
  /** Write `<project>/<rel>` (parent dirs created). */
  write(rel: string, content: string): string;
  /** Write a workspace V2 agent `<project>/.kiro/agents/<name>.json`. */
  agent(name: string, spec: Record<string, unknown>): string;
  /** Remove the temp root and the Claude transcripts of the project (unless KIRO_CLAUDE_E2E_KEEP=1). */
  cleanup(): void;
}

/** A fresh temp project + KIRO_HOME; registers cleanup on `t` when given. */
export function makeProject(t?: TestContext, extraEnv: Record<string, string> = {}): E2EProject {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-e2e-')));
  const project = path.join(root, 'project');
  const kiroHome = path.join(root, 'kiro-home');
  const logFile = path.join(root, 'kiro-claude.log');
  fs.mkdirSync(project, { recursive: true });
  // an (empty) global agents dir keeps the legacy ~/.aws/amazonq/cli-agents out of the run
  fs.mkdirSync(path.join(kiroHome, 'agents'), { recursive: true });
  const git = spawnSync('git', ['init', '-q'], { cwd: project, stdio: 'ignore' });
  if (git.status !== 0) t?.diagnostic('git init failed (continuing without a repository)');
  const token = path.basename(root).replace(/^kc-e2e-/, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'E2E';
  const env = e2eEnv({ KIRO_HOME: kiroHome, KIRO_CHAT_LOG_FILE: logFile, ...extraEnv });
  const p: E2EProject = {
    root,
    project,
    kiroHome,
    logFile,
    env,
    token,
    write(rel, content) {
      const file = path.join(project, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    },
    agent(name, spec) {
      return p.write(path.join('.kiro', 'agents', `${name}.json`), JSON.stringify({ name, ...spec }, null, 2));
    },
    cleanup() {
      if (KEEP) {
        t?.diagnostic(`kept ${root}`);
        return;
      }
      removeClaudeProjectDir(project, root);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  t?.after(() => p.cleanup());
  return p;
}

/**
 * The real claude writes transcripts for the temp project to
 * `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<sanitized cwd>/`. Remove exactly that directory, and
 * only when its name carries this run's unique temp-root name (never anything else there).
 */
function removeClaudeProjectDir(project: string, root: string): void {
  try {
    const projects = claudeProjectsDir(e2eEnv());
    const dir = path.join(projects, sanitizeProjectDir(project));
    if (path.dirname(dir) !== projects) return;
    if (!path.basename(dir).includes(sanitizeProjectDir(path.basename(root)))) return;
    if (!/^kc-e2e-/.test(path.basename(root))) return;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ─────────────────────────────── running the CLI ───────────────────────────────

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Tail of the output for assertion messages (never the environment). */
export function describeRun(r: { code?: number | null; stdout: string; stderr: string }, max = 4000): string {
  const tail = (s: string): string => (s.length > max ? `…${s.slice(-max)}` : s);
  return `exit ${String(r.code)}\n--- stdout ---\n${tail(stripAnsi(r.stdout))}\n--- stderr ---\n${tail(stripAnsi(r.stderr))}`;
}

/** Run `kiro-claude <args>` to completion (stdin closed); SIGTERM, then SIGKILL, at `timeoutMs`. */
export function runCli(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killHard(child);
    }, opts.timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), timedOut });
    });
  });
}

function killHard(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 5000).unref();
}

/** A long-running CLI child with piped stdio (REPL line mode). */
export class CliProc {
  readonly child: ChildProcess;
  stdout = '';
  stderr = '';
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private waiters: Array<{ check: () => boolean; resolve: () => void }> = [];

  constructor(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(process.execPath, [CLI_PATH, ...args], { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      this.stdout += stripAnsi(d);
      this.poke();
    });
    this.child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      this.stderr += stripAnsi(d);
      this.poke();
    });
    this.child.stdin!.on('error', () => undefined); // EPIPE after exit
    this.exited = new Promise((resolve) => {
      this.child.on('close', (code, signal) => {
        resolve({ code, signal });
        this.poke();
      });
    });
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Re-evaluate pending waits (on output, on exit, or after the caller changed something). */
  poke(): void {
    for (const w of [...this.waiters]) {
      if (w.check()) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  }

  /**
   * Resolve when `cond()` holds (checked on every output chunk, on exit, and every `pollMs` for
   * conditions on the file system); reject with the output tail after `timeoutMs` or when the
   * process exits first.
   */
  waitUntil(cond: () => boolean, what: string, timeoutMs: number, pollMs = 250): Promise<void> {
    return new Promise((resolve, reject) => {
      let poll: NodeJS.Timeout | undefined;
      const done = (err?: Error): void => {
        clearTimeout(timer);
        if (poll) clearInterval(poll);
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        if (err) reject(err);
        else resolve();
      };
      const w = {
        check: (): boolean => {
          if (cond()) return true;
          if (!this.alive) {
            setImmediate(() => done(new Error(`process exited while waiting for ${what}\n${describeRun({ code: this.child.exitCode, stdout: this.stdout, stderr: this.stderr })}`)));
          }
          return false;
        },
        resolve: () => done(),
      };
      const timer = setTimeout(() => done(new Error(`timed out after ${timeoutMs} ms waiting for ${what}\n${describeRun({ code: null, stdout: this.stdout, stderr: this.stderr })}`)), timeoutMs);
      if (w.check()) {
        done();
        return;
      }
      this.waiters.push(w);
      poll = setInterval(() => this.poke(), pollMs);
    });
  }

  write(line: string): void {
    this.child.stdin!.write(line.endsWith('\n') ? line : `${line}\n`);
  }

  end(): void {
    this.child.stdin!.end();
  }

  kill(): void {
    killHard(this.child);
  }
}

// ─────────────────────────────── ACP client ───────────────────────────────

export type Frame = Record<string, any>;

/**
 * A minimal JSON-RPC 2.0 client for `kiro-claude acp` over the child's stdio. Every
 * agent → client line is parsed into `frames` (non-JSON lines go to `nonJson`).
 * `session/request_permission` is answered by `onPermission` (default: the `allow_once`
 * option); any other agent → client request gets a "method not found" error.
 */
export class AcpClient {
  readonly child: ChildProcess;
  readonly frames: Frame[] = [];
  readonly nonJson: string[] = [];
  readonly permissionRequests: Frame[] = [];
  stderr = '';
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  onPermission: (req: Frame) => unknown = (req) => {
    const opts: Frame[] = Array.isArray(req.params?.options) ? req.params.options : [];
    const pick = opts.find((o) => o.kind === 'allow_once') ?? opts.find((o) => o.optionId === 'allow_once');
    return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
  };
  private nextId = 1;
  private buf = '';
  private waiters: Array<{ pred: (f: Frame) => boolean; from: number; resolve: (f: Frame) => void }> = [];
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  constructor(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(process.execPath, [CLI_PATH, 'acp', ...args], { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.setEncoding('utf8').on('data', (d: string) => this.onData(d));
    this.child.stderr!.setEncoding('utf8').on('data', (d: string) => (this.stderr += d));
    this.child.stdin!.on('error', () => undefined);
    this.exited = new Promise((resolve) => {
      this.child.on('close', (code, signal) => {
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      });
    });
  }

  private onData(d: string): void {
    this.buf += d;
    for (let nl = this.buf.indexOf('\n'); nl !== -1; nl = this.buf.indexOf('\n')) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (line.trim() === '') continue;
      let f: Frame;
      try {
        f = JSON.parse(line) as Frame;
      } catch {
        this.nonJson.push(line);
        continue;
      }
      this.frames.push(f);
      this.onFrame(f, this.frames.length - 1);
    }
  }

  private onFrame(f: Frame, idx: number): void {
    if (typeof f.method === 'string' && f.id !== undefined && f.id !== null) {
      if (f.method === 'session/request_permission') {
        this.permissionRequests.push(f);
        void Promise.resolve(this.onPermission(f)).then((result) => this.send({ jsonrpc: '2.0', id: f.id, result }));
      } else {
        this.send({ jsonrpc: '2.0', id: f.id, error: { code: -32601, message: `Method not found: ${f.method}` } });
      }
    }
    for (const w of [...this.waiters]) {
      if (idx >= w.from && w.pred(f)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(f);
      }
    }
  }

  send(msg: unknown): void {
    if (this.child.stdin!.writable) this.child.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  /** Recent traffic for assertion messages. */
  describe(): string {
    const frames = this.frames.slice(-25).map((f) => {
      const s = JSON.stringify(f);
      return s.length > 600 ? `${s.slice(0, 600)}…` : s;
    });
    const err = stripAnsi(this.stderr);
    return `exit ${JSON.stringify(this.exitInfo ?? null)}\n--- last frames ---\n${frames.join('\n')}\n--- stderr ---\n${err.length > 3000 ? `…${err.slice(-3000)}` : err}`;
  }

  /** Wait for a frame at index ≥ `from` matching `pred`. */
  waitFor(pred: (f: Frame) => boolean, what: string, timeoutMs: number, from = 0): Promise<Frame> {
    for (let i = from; i < this.frames.length; i++) if (pred(this.frames[i]!)) return Promise.resolve(this.frames[i]!);
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        from,
        resolve: (f: Frame) => {
          clearTimeout(timer);
          resolve(f);
        },
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}\n${this.describe()}`));
      }, timeoutMs);
      void this.exited.then(() => {
        const i = this.waiters.indexOf(w);
        if (i < 0) return;
        this.waiters.splice(i, 1);
        clearTimeout(timer);
        reject(new Error(`acp process exited while waiting for ${what}\n${this.describe()}`));
      });
      this.waiters.push(w);
    });
  }

  /** Send a request; resolves with `{ response, from, to }` (frame index range of the exchange). */
  async request(method: string, params: unknown, timeoutMs: number): Promise<{ response: Frame; from: number; to: number }> {
    const id = this.nextId++;
    const from = this.frames.length;
    const p = this.waitFor((f) => f.id === id && f.method === undefined && ('result' in f || 'error' in f), `response to ${method}#${id}`, timeoutMs, from);
    this.send({ jsonrpc: '2.0', id, method, params });
    const response = await p;
    return { response, from, to: this.frames.indexOf(response) };
  }

  /** `request` that asserts success. */
  async call(method: string, params: unknown, timeoutMs: number): Promise<{ result: any; from: number; to: number }> {
    const { response, from, to } = await this.request(method, params, timeoutMs);
    assert.ok(!response.error, `${method} failed: ${JSON.stringify(response.error)}\n${this.describe()}`);
    return { result: response.result, from, to };
  }

  /** `session/update` payloads for `sessionId` within frame indexes [from, to). */
  updates(sessionId: string, from = 0, to = this.frames.length): Frame[] {
    return this.frames
      .slice(from, to)
      .filter((f) => f.method === 'session/update' && f.params?.sessionId === sessionId && f.params?.update)
      .map((f) => f.params.update as Frame);
  }

  /** Concatenated text of the `kind` chunks (`agent_message_chunk` / `user_message_chunk`) in the range. */
  chunkText(sessionId: string, kind: string, from = 0, to = this.frames.length): string {
    return this.updates(sessionId, from, to)
      .filter((u) => u.sessionUpdate === kind && u.content?.type === 'text')
      .map((u) => String(u.content.text))
      .join('');
  }

  /** Close stdin and wait for the process to exit (killed after `timeoutMs`). */
  async endAndWait(timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
    this.child.stdin!.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killHard(this.child);
    }, timeoutMs);
    const r = await this.exited;
    clearTimeout(timer);
    return { ...r, timedOut };
  }

  kill(): void {
    killHard(this.child);
  }
}

/** POSIX single-quote a string for `sh`. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
