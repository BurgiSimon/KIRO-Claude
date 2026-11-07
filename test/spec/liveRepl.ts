/**
 * The real runRepl (session/kiroSession createSession, the spec slash commands) driving
 * test/fixtures/fake-claude.mjs, for the spec end-to-end tests (test/repl/spec-r4-*.test.ts).
 * Everything lives in a temp root: HOME, KIRO_HOME, CLAUDE_CONFIG_DIR, XDG_RUNTIME_DIR,
 * XDG_CACHE_HOME; never the real ~/.kiro, ~/.claude, ~/.cache.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { openSettings } from '../../src/config/settings.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { runRepl } from '../../src/repl/repl.js';
import type { CliContext } from '../../src/types.js';
import { stripAnsi } from '../../src/util/ansi.js';
import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';
import { startTicksOf } from '../claude/pid-reuse-helpers.js';
import { tempEnv, type TempEnv } from '../repl/harness.js';
import { DESIGN_MD, REQ_MD, TASKS_MD } from './helpers.js';

export interface LiveRepl {
  t: TempEnv;
  kiroHome: string;
  /** Output so far, ANSI stripped. */
  o(): string;
  exit: Promise<number>;
  /** The exit code once runRepl returned. */
  ended(): number | undefined;
  line(s: string): void;
  /** Write `s` to the REPL's stdin as is (keys such as Shift+Tab, `\x1b[Z`). */
  raw(s: string): void;
  ctrlC(): void;
  /** Wait until the output after `from` matches; returns it. */
  waitFor(re: RegExp, ms?: number, from?: number): Promise<string>;
  /** Type `line`, wait until the output after it matches `re`; returns that output. */
  send(line: string, re: RegExp, ms?: number): Promise<string>;
  /** Contents of the user lines kiro-claude wrote to the fake's stdin. */
  userLines(): string[];
  /** Number of fake claude processes started so far. */
  starts(): number;
  /** /quit (when still running), wait for the exit, kill `pids` still alive, remove the temp root. */
  close(pids?: Iterable<{ pid: number; ticks: number | undefined }>): Promise<void>;
}

export interface LiveReplOptions {
  tty?: boolean;
  sessionOptions?: Record<string, unknown>;
  /** Write files (hooks, specs) before the REPL starts. */
  before?(t: TempEnv, kiroHome: string): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The todo-export spec with all three documents. */
export function seedTodoExport(wsDir: string): string {
  const dir = path.join(wsDir, '.kiro', 'specs', 'todo-export');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'requirements.md'), REQ_MD);
  fs.writeFileSync(path.join(dir, 'design.md'), DESIGN_MD);
  fs.writeFileSync(path.join(dir, 'tasks.md'), TASKS_MD);
  return dir;
}

/** A global (KIRO_HOME) v1 hooks file. */
export function writeGlobalHook(kiroHome: string, file: string, hook: Record<string, unknown>): void {
  fs.mkdirSync(path.join(kiroHome, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(kiroHome, 'hooks', file), JSON.stringify({ version: 'v1', hooks: [hook] }));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait for a hook's pid file; returns the pid and its start ticks (for a safe cleanup kill). */
export async function waitForPidFile(file: string, ms = 20_000): Promise<{ pid: number; ticks: number | undefined }> {
  const t0 = Date.now();
  for (;;) {
    const v = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    if (/^\d+$/.test(v)) {
      const pid = Number(v);
      return { pid, ticks: startTicksOf(pid) };
    }
    if (Date.now() - t0 > ms) throw new Error(`no pid in ${file} after ${ms} ms`);
    await sleep(25);
  }
}

export async function waitGone(pid: number, ms = 2000): Promise<boolean> {
  const t0 = Date.now();
  while (pidAlive(pid) && Date.now() - t0 < ms) await sleep(25);
  return !pidAlive(pid);
}

/** `script`: the fake's script (FAKE_CLAUDE_SCRIPT_JSON), or a function of the temp env (absolute paths). */
export function liveRepl(script: unknown, o: LiveReplOptions = {}): LiveRepl {
  const t = tempEnv();
  if (typeof script === 'function') script = (script as (t: TempEnv) => unknown)(t);
  const kiroHome = path.join(t.home, '.kiro');
  const runDir = path.join(t.root, 'run');
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(t.root, 'cache'), { recursive: true });
  const logFile = path.join(t.root, 'fake.log');
  o.before?.(t, kiroHome);
  const env = fakeEnv({
    ...t.env,
    KIRO_HOME: kiroHome,
    XDG_RUNTIME_DIR: runDir,
    XDG_CACHE_HOME: path.join(t.root, 'cache'),
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script),
    FAKE_CLAUDE_LOG: logFile,
    FAKE_CLAUDE_PERSIST: '1',
    KIRO_CLAUDE_BIN: fakeClaudePath(),
  });
  const ws = createWorkspaceContext(t.wsDir, env);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  if (o.tty) {
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
    Object.assign(stdout, { isTTY: true, columns: 100 });
  }
  let out = '';
  stdout.on('data', (d: Buffer) => (out += d.toString()));
  const ctx: CliContext = {
    ws,
    settings: openSettings(ws),
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    progName: 'kiro-claude',
    verbosity: 0,
  };
  let code: number | undefined;
  const exit = runRepl({ ctx, sessionOptions: { env, claudePath: fakeClaudePath(), ...(o.sessionOptions ?? {}) } }).then((c) => {
    code = c;
    return c;
  });
  const NL = o.tty ? '\r' : '\n';
  const strip = (): string => stripAnsi(out);
  const log = (): Record<string, unknown>[] =>
    fs.existsSync(logFile)
      ? fs
          .readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  const r: LiveRepl = {
    t,
    kiroHome,
    o: strip,
    exit,
    ended: () => code,
    line: (s) => {
      stdin.write(`${s}${NL}`);
    },
    raw: (s) => {
      stdin.write(s);
    },
    ctrlC: () => {
      stdin.write(o.tty ? '\u0003' : '\u0003\n');
    },
    async waitFor(re, ms = 20_000, from = 0) {
      const t0 = Date.now();
      while (!re.test(strip().slice(from))) {
        if (Date.now() - t0 > ms) throw new Error(`timeout ${ms} ms waiting for ${re}\n--- out:\n${strip().slice(from)}`);
        await sleep(25);
      }
      return strip().slice(from);
    },
    async send(s, re, ms = 20_000) {
      const from = strip().length;
      r.line(s);
      return r.waitFor(re, ms, from);
    },
    userLines: () =>
      log()
        .filter((e) => e.event === 'stdin' && (e.line as { type?: string } | undefined)?.type === 'user')
        .map((e) => {
          const c = (e.line as { message?: { content?: unknown } }).message?.content;
          return typeof c === 'string' ? c : JSON.stringify(c ?? '');
        }),
    starts: () => log().filter((e) => e.event === 'start').length,
    async close(pids = []) {
      for (const p of pids) {
        if (p.ticks !== undefined && startTicksOf(p.pid) === p.ticks) {
          try {
            process.kill(-p.pid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
      }
      if (code === undefined) {
        stdin.write(`/quit${NL}`);
        stdin.end();
        await Promise.race([exit.catch(() => undefined), sleep(25_000)]);
      }
      t.cleanup();
    },
  };
  return r;
}
