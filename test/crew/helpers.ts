/**
 * Helpers for the `kiro-claude crew` tests: a temp HOME, a temp PATH holding fake `git`,
 * `python3`, `npm`, `make`, `node`, `xdg-open` wrappers (test/crew/fixtures/fake-tool.mjs), a fake
 * KiroCrew checkout template whose `bin/kirocrew` is the fake KiroCrew CLI, a CliContext with
 * captured output, and CrewDeps pointing at the fakes. Nothing here touches the real HOME.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { CliContext, SettingsStore } from '../../src/types.js';
import type { CrewDeps } from '../../src/crew/context.js';
import { createCrewCommand } from '../../src/crew/cli.js';
import { KIROCREW_PIN } from '../../src/crew/pin.js';

/** Locates a file under the source tree (works from src, dist/ and private out dirs). */
export function sourcePath(rel: string): string {
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
  throw new Error(`cannot locate ${rel}; run the tests from the repository root`);
}

export const FAKE_TOOL = (): string => sourcePath(path.join('test', 'crew', 'fixtures', 'fake-tool.mjs'));
export const FAKE_ENTRY = (): string => sourcePath(path.join('test', 'crew', 'fixtures', 'fake-entry.mjs'));
export const FAKE_CLAUDE = (): string => sourcePath(path.join('test', 'fixtures', 'fake-claude.mjs'));

/** A real Python 3 with sqlite3 for the identity-stub scripts, or undefined. */
export function realPython(): string | undefined {
  for (const p of ['/usr/local/bin/python3.13', '/usr/bin/python3.12', '/usr/local/bin/python3', '/usr/bin/python3']) {
    if (!fs.existsSync(p)) continue;
    const r = spawnSync(p, ['-I', '-c', 'import sqlite3,sys;print(sys.version_info[:2] >= (3, 8))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return p;
  }
  return undefined;
}

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Writes `#!/bin/sh` → `exec node fake-tool.mjs <tool> "$@"` at `file`. */
export function writeWrapper(file: string, tool: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nFAKE_SELF="$0"; export FAKE_SELF\nexec ${q(process.execPath)} ${q(FAKE_TOOL())} ${tool} "$@"\n`, { mode: 0o755 });
}

export interface Call {
  tool: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  umask?: number;
  pid: number;
}

export interface FakeEnv {
  root: string;
  home: string;
  bin: string;
  log: string;
  /** Fake KiroCrew source tree copied into checkouts by the fake git. */
  template: string;
  /** Crew state dir under the fake HOME. */
  cs: string;
  env: NodeJS.ProcessEnv;
  calls(): Call[];
  callsOf(tool: string): Call[];
  /** A pre-made checkout at the pin (as if fetched), optionally built. */
  makeCheckout(dir: string, opts?: { built?: boolean; head?: string }): string;
  cleanup(): void;
}

export function makeFakeEnv(opts: { tools?: string[]; extraEnv?: NodeJS.ProcessEnv } = {}): FakeEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-crew-'));
  const home = path.join(root, 'h');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.jsonl');
  const template = path.join(root, 'template');
  fs.mkdirSync(home, { recursive: true });
  const tools = opts.tools ?? ['git', 'python3', 'npm', 'make', 'node', 'xdg-open', 'open'];
  for (const t of tools) {
    const kind = t.startsWith('python') ? 'python' : t === 'xdg-open' ? 'open' : t;
    writeWrapper(path.join(bin, t), kind);
  }
  // Fake KiroCrew template.
  writeWrapper(path.join(template, 'bin', 'kirocrew'), 'kirocrew');
  fs.mkdirSync(path.join(template, 'website'), { recursive: true });
  fs.writeFileSync(path.join(template, 'website', 'package.json'), '{"name":"kirocrew-website"}\n');
  fs.writeFileSync(path.join(template, 'pyproject.toml'), '[project]\nname = "kirocrew"\nversion = "0.13.0"\n');
  fs.writeFileSync(path.join(template, 'LICENSE'), 'Apache-2.0\n');

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: bin,
    LANG: 'C.UTF-8',
    FAKE_LOG: log,
    FAKE_PIN: KIROCREW_PIN.commit,
    FAKE_KC_TEMPLATE: template,
    ...(realPython() ? { FAKE_REAL_PYTHON: realPython() } : {}),
    ...opts.extraEnv,
  };
  const fe: FakeEnv = {
    root,
    home,
    bin,
    log,
    template,
    cs: path.join(home, '.local', 'share', 'kiro-claude', 'crew'),
    env,
    calls() {
      try {
        return fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Call);
      } catch {
        return [];
      }
    },
    callsOf(tool) {
      return fe.calls().filter((c) => c.tool === tool);
    },
    makeCheckout(dir, o = {}) {
      fs.cpSync(template, dir, { recursive: true });
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'FAKE_HEAD'), `${o.head ?? KIROCREW_PIN.commit}\n`);
      if (o.built) {
        for (const t of ['python', 'pip', 'kirocrew']) writeWrapper(path.join(dir, '.venv', 'bin', t), t);
        fs.mkdirSync(path.join(dir, 'src', 'kiro_crew', 'static', 'dist'), { recursive: true });
      }
      return dir;
    },
    cleanup() {
      // Kill any fake gateway (and gateway child) still running: the file outlives a gateway that
      // was killed, so its pid is signalled only while it still has the recorded start time (K8).
      for (const f of [...findFiles(root, 'fake-gateway.json'), ...findFiles(root, 'fake-gateway-child.json')]) {
        try {
          const { pid, start } = JSON.parse(fs.readFileSync(f, 'utf8')) as { pid: number; start?: number };
          if (stillRunsAs(pid, start)) process.kill(pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return fe;
}

/**
 * A copy of an already set-up fake environment (its HOME and checkouts) under a new root, with
 * crew.json's absolute paths rewritten — much faster than rerunning setup for every test.
 */
export function cloneFakeEnv(base: FakeEnv, opts: { extraEnv?: NodeJS.ProcessEnv } = {}): FakeEnv {
  const fe = makeFakeEnv({ extraEnv: opts.extraEnv });
  for (const name of fs.readdirSync(base.root)) {
    if (['bin', 'template', 'calls.jsonl'].includes(name)) continue;
    fs.rmSync(path.join(fe.root, name), { recursive: true, force: true });
    fs.cpSync(path.join(base.root, name), path.join(fe.root, name), { recursive: true });
  }
  const stateFile = path.join(fe.cs, 'crew.json');
  if (fs.existsSync(stateFile)) {
    fs.writeFileSync(stateFile, fs.readFileSync(stateFile, 'utf8').split(base.root).join(fe.root), { mode: 0o600 });
  }
  return fe;
}

/** Start time of a process (`/proc/<pid>/stat` field 22, clock ticks since boot); undefined when gone or without /proc. */
export function procStart(pid: number): number | undefined {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const v = Number(s.slice(s.lastIndexOf(')') + 1).trim().split(/\s+/)[19]);
    return Number.isInteger(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `pid` still runs the process recorded with start time `start` (not a later one reusing the pid,
 * nor a zombie). Without /proc (no start time recorded) only liveness can be checked.
 */
export function stillRunsAs(pid: number, start: number | undefined): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== 'linux') {
    try {
      process.kill(pid, 0);
      return start === undefined;
    } catch {
      return false;
    }
  }
  try {
    if (fs.readFileSync(`/proc/${pid}/cmdline`).length === 0) return false; // a zombie
  } catch {
    return false;
  }
  return start !== undefined && procStart(pid) === start;
}

function findFiles(dir: string, name: string, depth = 6): string[] {
  const out: string[] = [];
  if (depth < 0) return out;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(p, name, depth - 1));
    else if (e.name === name) out.push(p);
  }
  return out;
}

export interface Captured {
  ctx: CliContext;
  stdout(): string;
  stderr(): string;
}

const stubSettings = {
  get: () => undefined,
  getString: () => undefined,
  getBoolean: (_k: string, f: boolean) => f,
  getNumber: (_k: string, f: number) => f,
  set: () => undefined,
  delete: () => [],
  list: () => ({}),
  pathFor: () => '',
} as unknown as SettingsStore;

export function makeCtx(env: NodeJS.ProcessEnv, cwd: string): Captured {
  const out = new PassThrough();
  const err = new PassThrough();
  let o = '';
  let e = '';
  out.on('data', (b: Buffer) => (o += b.toString('utf8')));
  err.on('data', (b: Buffer) => (e += b.toString('utf8')));
  const stdin = Readable.from([]) as unknown as NodeJS.ReadStream;
  const home = env.HOME!;
  const ctx: CliContext = {
    ws: { cwd, workspaceRoot: cwd, kiroHome: path.join(home, '.kiro'), home, env },
    settings: stubSettings,
    stdin,
    stdout: out as unknown as NodeJS.WriteStream,
    stderr: err as unknown as NodeJS.WriteStream,
    progName: 'kiro-claude',
    verbosity: 0,
  };
  return { ctx, stdout: () => o, stderr: () => e };
}

/** CrewDeps for tests: fake entry, fixed claude, fast polling, no package root. */
export function testDeps(fe: FakeEnv, overrides: Partial<CrewDeps> = {}): Partial<CrewDeps> {
  const claude = FAKE_CLAUDE();
  return {
    packageRoot: null,
    nodePath: process.execPath,
    entryPath: FAKE_ENTRY(),
    findClaude: async ({ explicitPath }) => ({ path: explicitPath ?? claude, version: '2.1.318' }),
    claudeAuth: async () => ({ loggedIn: true, detail: 'claude.ai' }),
    startTimeoutMs: 15_000,
    pollMs: 50,
    killGraceMs: 1_000,
    now: () => new Date('2026-11-06T12:00:00.000Z'),
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Runs `kiro-claude crew <args>` against the fake environment. */
export async function crew(fe: FakeEnv, args: string[], o: { cwd?: string; deps?: Partial<CrewDeps>; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...fe.env, ...o.env };
  const cap = makeCtx(env, o.cwd ?? fe.home);
  const deps = testDeps(fe, o.deps);
  const code = await createCrewCommand(deps)(args, cap.ctx);
  return { code, stdout: cap.stdout(), stderr: cap.stderr() };
}

/** Free TCP port on 127.0.0.1. */
export async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}
