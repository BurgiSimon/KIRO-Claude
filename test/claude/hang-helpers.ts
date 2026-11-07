/**
 * Helpers for the lifecycle suites (hang-proof probes, process groups, terminal signals):
 * scriptable "hanging claude" doubles, process liveness checks and an async spawn that records
 * timing. Everything lives in temp dirs; nothing touches the real ~/.kiro or ~/.claude.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startTicksOf } from './pid-reuse-helpers.js';

export const isWin = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

/** Built module path next to this compiled test (`<out>/test/claude/x.js` → `<out>/src/<rel>`). */
export function builtModule(rel: string): string {
  return fileURLToPath(new URL(`../../src/${rel}`, import.meta.url));
}

export interface HangFakeOptions {
  /** `all`: every invocation hangs; `auth`: `--version` answers, everything else hangs. */
  mode: 'all' | 'auth';
  /** Delay before `--version` answers in `auth` mode. */
  versionDelayMs?: number;
  /** Ignore SIGTERM (fake and grandchild), so only SIGKILL stops them. */
  ignoreTerm?: boolean;
  /** Spawn a grandchild that inherits stdout/stderr (like a shell wrapper running `sleep`). */
  grandchild?: boolean;
}

/**
 * Writes a fake `claude` (.mjs, run under node by resolveSpawn) that hangs as configured and
 * appends its own pid and its grandchild's pid to `<dir>/pids` (one per line).
 */
export function writeHangFake(dir: string, opts: HangFakeOptions): { bin: string; pidFile: string } {
  const bin = path.join(dir, `hang-claude-${opts.mode}.mjs`);
  const pidFile = path.join(dir, `pids-${opts.mode}`);
  const src = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const pidFile = ${JSON.stringify(pidFile)};
const ignoreTerm = ${opts.ignoreTerm ? 'true' : 'false'};
const grandchild = ${opts.grandchild ? 'true' : 'false'};
const a = process.argv.slice(2);
function hang() {
  if (ignoreTerm) process.on('SIGTERM', () => {});
  fs.appendFileSync(pidFile, process.pid + '\\n');
  if (grandchild) {
    const code = (ignoreTerm ? "process.on('SIGTERM', () => {});" : '') + 'setInterval(() => {}, 1e6);';
    const g = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'inherit', 'inherit'] });
    fs.appendFileSync(pidFile, g.pid + '\\n');
  }
  setInterval(() => {}, 1e6);
}
if (a[0] === '--version' && ${JSON.stringify(opts.mode)} === 'auth') {
  setTimeout(() => process.stdout.write('2.1.318 (Claude Code)\\n', () => process.exit(0)), ${opts.versionDelayMs ?? 0});
} else {
  hang();
}
`;
  fs.writeFileSync(bin, src);
  return { bin, pidFile };
}

/**
 * Start time (Linux /proc clock ticks) of each pid when {@link readPids} first listed it, or
 * null when it was already gone then, so {@link reap} never SIGKILLs a process that reused the
 * number later (pid_max may be 32768).
 */
const seenStart = new Map<number, number | null>();

export function readPids(pidFile: string): number[] {
  let pids: number[];
  try {
    pids = fs
      .readFileSync(pidFile, 'utf8')
      .split('\n')
      .map((l) => Number.parseInt(l, 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
  if (isLinux) {
    for (const p of pids) {
      if (!seenStart.has(p)) seenStart.set(p, startTicksOf(p) ?? null);
    }
  }
  return pids;
}

/** True while `pid` exists and is not a zombie (zombies of orphans may linger in containers). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (isLinux) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      return state !== 'Z' && state !== 'X';
    } catch {
      return false;
    }
  }
  return true;
}

/** Process group id of `pid` (Linux, /proc), or undefined. */
export function pgidOf(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // fields[0] = state, [1] = ppid, [2] = pgrp
    return Number.parseInt(fields[2] ?? '', 10);
  } catch {
    return undefined;
  }
}

/** Polls until every pid is gone; resolves false after `ms`. */
export async function waitDead(pids: number[], ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (pids.every((p) => !alive(p))) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Best-effort SIGKILL of leftovers so a failing test does not leak processes. On Linux a pid
 * listed by {@link readPids} is killed only while it is still the process first listed (one
 * that was already gone then, or has a new start time, is a reuse); other pids (e.g. read from
 * a driver's output while running) are killed if they run.
 */
export function reap(pids: number[]): void {
  for (const p of pids) {
    if (isLinux) {
      const start = startTicksOf(p);
      const seen = seenStart.get(p);
      if (start === undefined || (seen !== undefined && seen !== start)) continue; // gone, or reused
    }
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

export interface AsyncRun {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Resolves with the exit status and elapsed ms (rejects never; `killedByTest` after `capMs`). */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number; killedByTest: boolean }>;
}

/** Spawns `node <args>`; the test kills it (SIGKILL) after `capMs` so a hang fails instead of stalling. */
export function spawnNode(args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; capMs: number; detached?: boolean }): AsyncRun {
  const t0 = Date.now();
  const child = spawn(process.execPath, args, {
    env: opts.env ?? process.env,
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: opts.detached ?? false,
  });
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => (out += d));
  child.stderr!.on('data', (d: string) => (err += d));
  let killedByTest = false;
  const cap = setTimeout(() => {
    killedByTest = true;
    try {
      if (opts.detached && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }, opts.capMs);
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number; killedByTest: boolean }>((resolve) => {
    child.on('exit', (code, signal) => {
      clearTimeout(cap);
      // Read what is left in the pipes (they may be held by leaked grandchildren: do not wait long).
      setTimeout(() => resolve({ code, signal, ms: Date.now() - t0, killedByTest }), 50);
    });
  });
  return { child, stdout: () => out, stderr: () => err, done };
}

/** Resolves with the first stdout JSON line of `run` that satisfies `pred`. */
export async function waitForLine(run: AsyncRun, pred: (o: Record<string, unknown>) => boolean, ms = 10_000): Promise<Record<string, unknown>> {
  const end = Date.now() + ms;
  for (;;) {
    for (const l of run.stdout().split('\n')) {
      if (!l.trim().startsWith('{')) continue;
      try {
        const o = JSON.parse(l) as Record<string, unknown>;
        if (pred(o)) return o;
      } catch {
        /* partial line */
      }
    }
    if (Date.now() > end) throw new Error(`timed out waiting for a driver line; stdout=${run.stdout()} stderr=${run.stderr()}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
