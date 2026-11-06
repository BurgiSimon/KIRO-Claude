/**
 * Helpers for session/ tests: an isolated HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs, a
 * recording SessionUI, the fake Claude binary + capabilities, and fake-claude log readers.
 * Never touches the real ~/.kiro, ~/.claude or ~/.cache.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { probeCapabilities, type ClaudeCapabilities } from '../../src/claude/binary.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import type {
  ApprovalRequest,
  ApprovalResponse,
  HookConfirmOption,
  KiroSession,
  SessionEvent,
  SessionUI,
  TurnResult,
  WorkspaceContext,
} from '../../src/types.js';
import { fakeBinary, fakeClaudePath, fakeEnv, readJsonl, type FakeScript } from '../claude/helpers.js';

export { fakeBinary, fakeClaudePath, readJsonl };
export type { FakeScript };

export interface Sandbox {
  root: string;
  home: string;
  kiroHome: string;
  cwd: string;
  claudeConfig: string;
  logFile: string;
  env: NodeJS.ProcessEnv;
  ws: WorkspaceContext;
  sessionsDir: string;
  /** Rebuild `ws` (e.g. after changing env). */
  refresh(extraEnv?: Record<string, string | undefined>): WorkspaceContext;
  /** Write a file relative to the workspace (or absolute). */
  write(rel: string, content: string): string;
  /** Write `<kiroHome>/agents/<name>.json` (global) or `<cwd>/.kiro/agents/<name>.json`. */
  agent(name: string, body: Record<string, unknown>, scope?: 'global' | 'workspace'): string;
  /** Every fake-claude log event. */
  log(): Array<Record<string, unknown>>;
  /** argv of every fake-claude process started (in order). */
  starts(): string[][];
  /** Parsed stdin lines the fakes received. */
  stdin(): Array<Record<string, unknown>>;
  /** User lines (type user) the fakes received. */
  userLines(): Array<Record<string, unknown>>;
}

export function mkSandbox(opts: { script?: FakeScript; env?: Record<string, string | undefined> } = {}): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-session-')));
  const home = path.join(root, 'home');
  const kiroHome = path.join(home, '.kiro');
  const cwd = path.join(root, 'proj');
  const claudeConfig = path.join(root, 'claude-config');
  const runtime = path.join(root, 'run');
  for (const d of [home, kiroHome, path.join(cwd, '.kiro'), claudeConfig, runtime, path.join(root, 'cache')]) fs.mkdirSync(d, { recursive: true });
  fs.chmodSync(runtime, 0o700);
  const logFile = path.join(root, 'fake.log');
  let env: NodeJS.ProcessEnv = fakeEnv({
    HOME: home,
    USERPROFILE: home,
    KIRO_HOME: kiroHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_RUNTIME_DIR: runtime,
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    FAKE_CLAUDE_LOG: logFile,
    KIRO_CLAUDE_SESSIONS_DIR: undefined,
    KIRO_CLAUDE_FORCE_MODEL: undefined,
    ASBX_KIRO_MANDATORY_MCPS: undefined,
    KIRO_AGENT_CONFIG_DIR: undefined,
    CLAUDE_CODE_EFFORT_LEVEL: undefined,
    ANTHROPIC_API_KEY: undefined,
    ...(opts.script ? { FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(opts.script) } : {}),
    ...opts.env,
  });
  const sb: Sandbox = {
    root,
    home,
    kiroHome,
    cwd,
    claudeConfig,
    logFile,
    env,
    ws: createWorkspaceContext(cwd, env),
    sessionsDir: path.join(kiroHome, 'sessions', 'cli'),
    refresh(extraEnv = {}) {
      env = { ...env };
      for (const [k, v] of Object.entries(extraEnv)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
      sb.env = env;
      sb.ws = createWorkspaceContext(cwd, env);
      return sb.ws;
    },
    write(rel, content) {
      const p = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return p;
    },
    agent(name, body, scope = 'global') {
      const dir = scope === 'global' ? path.join(kiroHome, 'agents') : path.join(cwd, '.kiro', 'agents');
      const p = path.join(dir, `${name}.json`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ name, ...body }, null, 2));
      return p;
    },
    log: () => readJsonl(logFile),
    starts: () => readJsonl(logFile).filter((e) => e.event === 'start').map((e) => e.argv as string[]),
    stdin: () => readJsonl(logFile).filter((e) => e.event === 'stdin' && e.line).map((e) => e.line as Record<string, unknown>),
    userLines: () => readJsonl(logFile).filter((e) => e.event === 'stdin' && (e.line as { type?: string } | undefined)?.type === 'user').map((e) => e.line as Record<string, unknown>),
  };
  return sb;
}

let capsPromise: Promise<ClaudeCapabilities> | undefined;
/** Capabilities of the fake (probed once per test process into a private cache dir). */
export function fakeCaps(): Promise<ClaudeCapabilities> {
  capsPromise ??= probeCapabilities(fakeBinary(), { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kc-caps-')), env: fakeEnv() });
  return capsPromise;
}

export interface RecordingUI extends SessionUI {
  notices: { level: string; message: string }[];
  approvals: ApprovalRequest[];
  /** Answers handed out in order (default allow-once). */
  answers: Array<ApprovalResponse | ((r: ApprovalRequest, s: AbortSignal) => Promise<ApprovalResponse>)>;
  confirms: { hook: string; question: string; options: HookConfirmOption[] }[];
  confirmAnswer?: string;
}

export function recordingUI(): RecordingUI {
  const ui: RecordingUI = {
    notices: [],
    approvals: [],
    answers: [],
    confirms: [],
    notice(level, message) {
      ui.notices.push({ level, message });
    },
    async requestApproval(r, signal) {
      ui.approvals.push(r);
      const a = ui.answers.shift();
      if (typeof a === 'function') return a(r, signal);
      return a ?? { kind: 'allow-once' };
    },
    async confirmStopHook(q) {
      ui.confirms.push(q);
      return ui.confirmAnswer;
    },
  };
  return ui;
}

/** Drain a prompt()/compact() generator. */
export async function drain(gen: AsyncGenerator<SessionEvent, TurnResult>): Promise<{ events: SessionEvent[]; result: TurnResult }> {
  const events: SessionEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { events, result: r.value };
    events.push(r.value);
  }
}

/** Events without `raw`. */
export function semantic(events: SessionEvent[]): SessionEvent[] {
  return events.filter((e) => e.type !== 'raw');
}

/** Value following `flag` in argv (undefined when absent). */
export function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Close quietly. */
export async function closeAll(...sessions: Array<KiroSession | undefined>): Promise<void> {
  for (const s of sessions) await s?.close().catch(() => undefined);
}
