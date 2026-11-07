/**
 * Shared helpers of the round-5 "signals" fix tests (r5f-signals*.test.ts in test/headless and
 * test/repl): an isolated temp root (HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs, the fake
 * claude with transcript persistence), the built `kiro-claude` as a child process, SessionEnd
 * hooks, and what a run leaves behind (session locks, runtime dirs).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { fakeClaudePath } from '../claude/helpers.js';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Root {
  root: string;
  home: string;
  ws: string;
  sessions: string;
  runDir: string;
  env(extra?: Record<string, string>): NodeJS.ProcessEnv;
  /** `<id>.lock` files left in the session index. */
  locks(): string[];
  /** Session runtime dirs left under XDG_RUNTIME_DIR. */
  runtimeLeft(): string[];
  /** The session index's `.json` records. */
  records(): { sessionId: string; origin?: string; updatedAt?: string }[];
  cleanup(): void;
}

export function mkRoot(script: unknown): Root {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r5f-sig-')));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'proj');
  for (const d of [home, path.join(ws, '.kiro', 'hooks'), path.join(root, 'cache')]) fs.mkdirSync(d, { recursive: true });
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir, { mode: 0o700 });
  const sessions = path.join(home, '.kiro', 'sessions', 'cli');
  return {
    root,
    home,
    ws,
    sessions,
    runDir,
    env(extra = {}) {
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (!/^(FAKE_CLAUDE_|KIRO|CLAUDE|XDG_|PTYHUP_)/.test(k) && v !== undefined) env[k] = v;
      return {
        ...env,
        HOME: home,
        KIRO_HOME: path.join(home, '.kiro'),
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        XDG_RUNTIME_DIR: runDir,
        XDG_CACHE_HOME: path.join(root, 'cache'),
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_DATA_HOME: path.join(root, 'data'),
        KIRO_CHAT_LOG_FILE: path.join(root, 'kiro.log'),
        KIRO_CLAUDE_BIN: fakeClaudePath(),
        FAKE_CLAUDE_PERSIST: '1',
        FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script),
        NO_COLOR: '1',
        ...extra,
      };
    },
    locks() {
      return fs.existsSync(sessions) ? fs.readdirSync(sessions).filter((f) => f.endsWith('.lock')) : [];
    },
    runtimeLeft() {
      const out: string[] = [];
      for (const d of fs.readdirSync(runDir)) {
        const p = path.join(runDir, d);
        if (!fs.statSync(p).isDirectory()) continue;
        for (const e of fs.readdirSync(p)) if (e.startsWith('session-')) out.push(e);
      }
      return out;
    },
    records() {
      if (!fs.existsSync(sessions)) return [];
      return fs
        .readdirSync(sessions)
        .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf8')) as { sessionId: string; origin?: string; updatedAt?: string });
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A workspace SessionEnd hook running `command` (timeout 0: never cut short by the hook runner). */
export function sessionEndHook(r: Root, command: string): void {
  fs.writeFileSync(
    path.join(r.ws, '.kiro', 'hooks', 'end.json'),
    JSON.stringify({ version: 'v1', hooks: [{ name: 'end', trigger: 'SessionEnd', timeout: 0, action: { type: 'command', command } }] }),
  );
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface Cli {
  child: ChildProcess;
  /** stdout + stderr so far, ANSI sequences removed. */
  o(): string;
  /** stdout so far (raw). */
  out(): string;
  /** stderr so far (raw). */
  err(): string;
  exit: Promise<Exit>;
  line(s: string): void;
  kill(sig: NodeJS.Signals): void;
  waitFor(re: RegExp, from?: number, ms?: number): Promise<void>;
  /** SIGKILL the child (only this one) if it is still running: a test that failed early. */
  dispose(): void;
}

/**
 * The built CLI over the fake claude, cwd the root's workspace. `nodeArgs` go before the script;
 * `script` replaces the built bin (an embedder script, which gets `args`).
 */
export function cli(r: Root, args: string[], opts: { stdin?: 'pipe' | 'ignore'; env?: Record<string, string>; nodeArgs?: string[]; script?: string } = {}): Cli {
  const argv = [...(opts.nodeArgs ?? []), opts.script ?? builtBin(), ...args];
  const child = spawn(process.execPath, argv, { cwd: r.ws, env: r.env(opts.env), stdio: [opts.stdin ?? 'pipe', 'pipe', 'pipe'] });
  let all = '';
  let out = '';
  let err = '';
  child.stdout!.on('data', (d: Buffer) => {
    out += d.toString();
    all += d.toString();
  });
  child.stderr!.on('data', (d: Buffer) => {
    err += d.toString();
    all += d.toString();
  });
  // a line typed after the child died (a test of the grace) must not fail this process with EPIPE
  child.stdin?.on('error', () => undefined);
  const exit = new Promise<Exit>((res) => child.on('exit', (code, signal) => res({ code, signal })));
  const o = (): string => all.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return {
    child,
    o,
    out: () => out,
    err: () => err,
    exit,
    line: (s) => child.stdin!.write(`${s}\n`),
    kill: (sig) => {
      child.kill(sig);
    },
    dispose: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
    async waitFor(re, from = 0, ms = 20_000) {
      const t0 = Date.now();
      while (!re.test(o().slice(from))) {
        if (Date.now() - t0 > ms) {
          child.kill('SIGKILL');
          throw new Error(`timeout waiting for ${re}\n--- out:\n${o().slice(from)}`);
        }
        await sleep(10);
      }
    },
  };
}

/** Wait until `file` exists (a hook's marker). */
export async function waitFile(file: string, what: string, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

/** Whether `pid` is gone (polls up to `ms`). */
export async function gone(pid: number, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() - t0 > ms) return false;
    await sleep(25);
  }
}
