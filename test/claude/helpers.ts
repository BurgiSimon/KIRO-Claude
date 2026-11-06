/**
 * Shared helpers for tests that drive the fake Claude Code CLI (test/fixtures/fake-claude.mjs).
 * Other suites may import these (`../claude/helpers.js`). See test/fixtures/README.md.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ClaudeBinary } from '../../src/claude/binary.js';
import { ClaudeProcess, type ClaudeHandlers, type ClaudeStartOptions } from '../../src/claude/process.js';
import type { ClaudeFrame, InitializeRequest, ResultFrame } from '../../src/claude/protocol.js';

/**
 * Absolute path of fake-claude.mjs. Works from the source tree, from `dist/`, and from a build
 * in an unrelated out dir (falls back to walking up from `process.cwd()`); `$KIRO_CLAUDE_FAKE`
 * overrides.
 */
export function fakeClaudePath(): string {
  if (process.env.KIRO_CLAUDE_FAKE) return path.resolve(process.env.KIRO_CLAUDE_FAKE);
  const rel = path.join('test', 'fixtures', 'fake-claude.mjs');
  const starts = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = start;
    for (;;) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(`cannot locate ${rel}; run tests from the repository root or set KIRO_CLAUDE_FAKE`);
}

export function fakeBinary(): ClaudeBinary {
  return { path: fakeClaudePath(), version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' };
}

/** Minimal headless argv (00 §3.1 subset). */
export const STREAM_ARGS: readonly string[] = Object.freeze([
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-prompt-tool',
  'stdio',
]);

export function mkTmp(prefix = 'kc-claude-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface FakeScript {
  turns?: Array<{ match?: string; flags?: string; repeat?: boolean; steps: unknown[] }>;
  default?: { steps: unknown[] };
}

export interface StartFakeOptions {
  script?: FakeScript;
  args?: string[];
  env?: Record<string, string | undefined>;
  handlers?: Partial<ClaudeHandlers>;
  initialize?: InitializeRequest;
  cwd?: string;
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface FakeHandle {
  proc: ClaudeProcess;
  logFile: string;
  dir: string;
  log(): Array<Record<string, unknown>>;
  /** stdin lines the fake received (parsed). */
  stdinLines(): Array<Record<string, unknown>>;
}

/** Default handlers: allow every tool, no hook decision. */
export const allowAllHandlers: ClaudeHandlers = {
  onHookCallback: async () => ({}),
  onCanUseTool: async (req) => ({ behavior: 'allow', updatedInput: req.input }),
};

export function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Environment for the fake: inherits PATH etc., never the parent's FAKE_CLAUDE_* settings. */
export function fakeEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('FAKE_CLAUDE_') && v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Starts a ClaudeProcess on the fake with a script; logs go to a temp dir. */
export async function startFake(opts: StartFakeOptions = {}): Promise<FakeHandle> {
  const dir = mkTmp();
  const logFile = path.join(dir, 'fake.log');
  const env = fakeEnv({
    FAKE_CLAUDE_LOG: logFile,
    ...(opts.script ? { FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(opts.script) } : {}),
    ...opts.env,
  });
  const start: ClaudeStartOptions = {
    binary: fakeBinary(),
    args: [...STREAM_ARGS, ...(opts.args ?? [])],
    cwd: opts.cwd ?? dir,
    env,
    initialize: opts.initialize ?? {},
    handlers: { ...allowAllHandlers, ...opts.handlers },
    ...(opts.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: opts.initializeTimeoutMs } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  };
  const proc = await ClaudeProcess.start(start);
  return {
    proc,
    logFile,
    dir,
    log: () => readJsonl(logFile),
    stdinLines: () =>
      readJsonl(logFile)
        .filter((e) => e.event === 'stdin' && e.line)
        .map((e) => e.line as Record<string, unknown>),
  };
}

/** Drains a turn generator: every yielded frame plus the returned result. */
export async function collectTurn(
  gen: AsyncGenerator<ClaudeFrame, ResultFrame>,
): Promise<{ frames: ClaudeFrame[]; result: ResultFrame }> {
  const frames: ClaudeFrame[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { frames, result: r.value };
    frames.push(r.value);
  }
}

/** Resolves when `pred` becomes true (polling), rejects after `ms`. */
export async function waitFor(pred: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
