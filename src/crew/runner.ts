/**
 * Injectable process seams for `kiro-claude crew` (task requirement: every external command goes
 * through a runner so tests can use fakes).
 *
 * - {@link CrewRunner}: run a program to completion (captured, optionally tee'd to a log file,
 *   or with the terminal passed through for `crew exec` / `start --foreground`), and spawn the
 *   detached gateway (08 §3.8: `setsid … </dev/null >gateway.out 2>gateway.err`; Node's
 *   `detached: true` calls `setsid()` on POSIX, and every fd of the child points at a file so
 *   callers piping our output never hang — 08b §2.2).
 * - {@link CrewSys}: clock, sleep, signals, liveness, the `/proc` scan used by `crew stop` to
 *   reap orphaned `kiro-claude acp` processes and retire the gateway's tree (a process is told
 *   apart from a later one that reuses its pid by its start time, and {@link CrewSys.kill} signals
 *   a pid only while it reads back that start time), and free-disk queries.
 *
 * Programs are spawned without a shell (argv arrays), so paths with spaces need no quoting.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { freeBytesAt } from './paths.js';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 0/undefined = no timeout. The child is SIGKILLed on timeout. */
  timeoutMs?: number;
  /** Written to the child's stdin, which is then closed. Without it stdin is `/dev/null`. */
  input?: string;
  /** Append everything the child writes (stdout and stderr) to this file. */
  logFile?: string;
  /**
   * `capture` (default): stdout/stderr are captured. `inherit`: the child talks to the given
   * streams (the real terminal when they are the process's own), nothing is captured.
   */
  stdio?: 'capture' | 'inherit';
  streams?: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream };
  /** Capture limit per stream (default 4 MiB; the tail is kept). */
  maxCaptureBytes?: number;
  /**
   * While the child runs, pass SIGTERM/SIGHUP sent to us on to it and ignore SIGINT (the child
   * gets the terminal's Ctrl+C itself), so `crew exec` / `start --foreground` never orphan it.
   */
  forwardSignals?: boolean;
}

export interface RunResult {
  /** Exit code; `null` when killed by a signal or not started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn failure (e.g. `ENOENT`). */
  error?: string;
  durationMs: number;
}

export interface DetachedOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutFile: string;
  stderrFile: string;
}

export interface CrewRunner {
  run(file: string, args: readonly string[], opts?: RunOptions): Promise<RunResult>;
  /** Start `file args` in its own session with stdin `/dev/null`; returns its pid. Throws when it cannot start. */
  spawnDetached(file: string, args: readonly string[], opts: DetachedOptions): { pid: number };
}

export interface ProcessInfo {
  pid: number;
  argv: string[];
  /** Environment, when readable (`/proc/<pid>/environ`). */
  env?: Record<string, string>;
  /** Parent pid and process group, when known (`/proc/<pid>/stat`). */
  ppid?: number;
  pgid?: number;
  /**
   * Start time in clock ticks since boot (`/proc/<pid>/stat` field 22), when known: with the pid it
   * names one process, so a later process that reuses the pid is not taken for it.
   */
  startTime?: number;
}

export interface CrewSys {
  platform: NodeJS.Platform;
  pid: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  isAlive(pid: number): boolean;
  /**
   * Signals `pid` only while it still is the process it was identified as: `startTime` is the
   * start time {@link listProcesses} / {@link startTime} gave for it then, and the pid's start
   * time is read again right before the signal (K8: a pid kept for seconds or minutes may name
   * another process by now). Undefined counts as a value: the process showed no start time (not
   * Linux, or a stat this user cannot read), and a pid that shows one now is another process.
   * Returns false when nothing was signalled (another process, gone, or not permitted).
   */
  kill(pid: number, signal: NodeJS.Signals, startTime: number | undefined): boolean;
  /** Linux `/proc` scan; empty elsewhere. */
  listProcesses(): ProcessInfo[];
  /** {@link ProcessInfo.startTime} of `pid`; undefined when it does not exist or is unknown (not Linux). */
  startTime(pid: number): number | undefined;
  /** {@link ProcessInfo.pgid} of `pid`; undefined when it does not exist or is unknown (not Linux). */
  processGroup(pid: number): number | undefined;
  /**
   * This boot's id (`/proc/sys/kernel/random/boot_id`), undefined when unknown (not Linux): a start
   * time counts clock ticks since boot, so a pid and start time recorded before a reboot can name
   * a process of a later boot.
   */
  bootId(): string | undefined;
  freeBytes(p: string): number | undefined;
  tmpdir(): string;
}

const DEFAULT_CAPTURE = 4 * 1024 * 1024;

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly limit: number) {}
  push(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      const first = this.chunks.shift()!;
      this.size -= first.length;
    }
  }
  text(): string {
    const all = Buffer.concat(this.chunks);
    return (all.length > this.limit ? all.subarray(all.length - this.limit) : all).toString('utf8');
  }
}

function isProcessStream(s: unknown, fd: 0 | 1 | 2): boolean {
  if (fd === 0) return s === process.stdin;
  if (fd === 1) return s === process.stdout;
  return s === process.stderr;
}

/** The real runner (node:child_process). */
export const defaultRunner: CrewRunner = {
  run(file, args, opts = {}) {
    const started = Date.now();
    return new Promise<RunResult>((resolve) => {
      const inherit = opts.stdio === 'inherit';
      const streams = opts.streams ?? {};
      const stdinSpec = opts.input !== undefined ? 'pipe' : inherit && isProcessStream(streams.stdin, 0) ? 'inherit' : 'ignore';
      const outSpec = inherit && (streams.stdout === undefined || isProcessStream(streams.stdout, 1)) ? 'inherit' : 'pipe';
      const errSpec = inherit && (streams.stderr === undefined || isProcessStream(streams.stderr, 2)) ? 'inherit' : 'pipe';
      let child;
      try {
        child = spawn(file, [...args], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: [stdinSpec, outSpec, errSpec],
          windowsHide: true,
        });
      } catch (e) {
        resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: (e as Error).message, durationMs: 0 });
        return;
      }
      const limit = opts.maxCaptureBytes ?? DEFAULT_CAPTURE;
      const out = new TailBuffer(limit);
      const err = new TailBuffer(limit);
      let logFd: number | undefined;
      if (opts.logFile) {
        try {
          logFd = fs.openSync(opts.logFile, 'a', 0o600);
        } catch {
          logFd = undefined;
        }
      }
      const tee = (b: Buffer): void => {
        if (logFd !== undefined) {
          try {
            fs.writeSync(logFd, b);
          } catch {
            // best effort
          }
        }
      };
      child.stdout?.on('data', (b: Buffer) => {
        if (inherit && streams.stdout) streams.stdout.write(b);
        else out.push(b);
        tee(b);
      });
      child.stderr?.on('data', (b: Buffer) => {
        if (inherit && streams.stderr) streams.stderr.write(b);
        else err.push(b);
        tee(b);
      });
      if (opts.input !== undefined && child.stdin) {
        child.stdin.on('error', () => undefined);
        child.stdin.end(opts.input);
      }
      // The two kills below go through Node's process handle, never a pid kept by number: while
      // the handle is open libuv has not reaped the child, so its pid (alive or a zombie) cannot
      // name another process; libuv reaps it and closes the handle in one uninterrupted run
      // (uv__wait_children: waitpid, then the exit callback that sets `_handle = null`), and
      // after that `child.kill()` signals nothing. Only JS running inside another child's exit
      // callback could see a reaped child whose handle is still open, and these kills run from a
      // timer and a signal handler, never from there (K8).
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, opts.timeoutMs);
      }
      const forwarded: Array<[NodeJS.Signals, () => void]> = [];
      if (opts.forwardSignals) {
        for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as NodeJS.Signals[]) {
          const h = (): void => {
            if (sig === 'SIGINT') return;
            try {
              child.kill(sig);
            } catch {
              // already gone
            }
          };
          process.on(sig, h);
          forwarded.push([sig, h]);
        }
      }
      let spawnError: string | undefined;
      child.on('error', (e: NodeJS.ErrnoException) => {
        spawnError = e.code ? `${e.code}: ${e.message}` : e.message;
      });
      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        for (const [sig, h] of forwarded) process.removeListener(sig, h);
        if (logFd !== undefined) {
          try {
            fs.closeSync(logFd);
          } catch {
            // ignore
          }
        }
        resolve({
          code: spawnError ? null : code,
          signal,
          stdout: out.text(),
          stderr: err.text(),
          timedOut,
          error: spawnError,
          durationMs: Date.now() - started,
        });
      });
    });
  },

  spawnDetached(file, args, opts) {
    const outFd = fs.openSync(opts.stdoutFile, 'w', 0o600);
    const errFd = fs.openSync(opts.stderrFile, 'w', 0o600);
    try {
      // The open mode only applies to new files; stdout carries the READY line's dashboard token.
      for (const fd of [outFd, errFd]) {
        try {
          fs.fchmodSync(fd, 0o600);
        } catch {
          // best effort (filesystems without chmod)
        }
      }
      const child = spawn(file, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
      });
      child.on('error', () => undefined);
      if (child.pid === undefined) throw new Error(`cannot start ${file}`);
      child.unref();
      return { pid: child.pid };
    } finally {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    }
  },
};

function readProcFile(pid: number, name: string): Buffer | undefined {
  try {
    return fs.readFileSync(`/proc/${pid}/${name}`);
  } catch {
    return undefined;
  }
}

/**
 * `ppid`, `pgid` and, when the line has it, `startTime` (field 22) from a `/proc/<pid>/stat` line
 * (the comm field may hold spaces and parens).
 */
export function parseProcStat(text: string): { ppid: number; pgid: number; startTime?: number } | undefined {
  const close = text.lastIndexOf(')');
  if (close < 0) return undefined;
  const f = text.slice(close + 1).trim().split(/\s+/); // field 3 (state), 4 (ppid), 5 (pgrp) … 22 (starttime)
  const ppid = Number(f[1]);
  const pgid = Number(f[2]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return undefined;
  const startTime = f[19] !== undefined ? Number(f[19]) : NaN;
  return Number.isInteger(startTime) ? { ppid, pgid, startTime } : { ppid, pgid };
}

/** Parse a NUL-separated `/proc/<pid>/environ` buffer. */
export function parseEnviron(buf: Buffer): Record<string, string> {
  const env: Record<string, string> = {};
  for (const part of buf.toString('utf8').split('\0')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    env[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return env;
}

export const defaultSys: CrewSys = {
  platform: process.platform,
  pid: process.pid,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
    // A zombie still answers signal 0; treat it as gone (Linux only).
    const stat = readProcFile(pid, 'stat');
    if (stat) {
      const s = stat.toString('utf8');
      const state = s.slice(s.lastIndexOf(')') + 2, s.lastIndexOf(')') + 3);
      if (state === 'Z' || state === 'X') return false;
    }
    return true;
  },
  kill(pid, signal, startTime) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    // Read as late as possible; what is left is the microseconds to the kill(2) below, which no
    // pidfd-free Node API can close.
    if (defaultSys.startTime(pid) !== startTime) return false;
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  },
  listProcesses() {
    if (process.platform !== 'linux') return [];
    let names: string[];
    try {
      names = fs.readdirSync('/proc');
    } catch {
      return [];
    }
    const out: ProcessInfo[] = [];
    for (const n of names) {
      if (!/^\d+$/.test(n)) continue;
      const pid = Number(n);
      const cmd = readProcFile(pid, 'cmdline');
      if (!cmd || cmd.length === 0) continue;
      const argv = cmd.toString('utf8').split('\0');
      if (argv[argv.length - 1] === '') argv.pop();
      const envBuf = readProcFile(pid, 'environ');
      const stat = readProcFile(pid, 'stat');
      const ids = stat ? parseProcStat(stat.toString('utf8')) : undefined;
      out.push({ pid, argv, env: envBuf ? parseEnviron(envBuf) : undefined, ...(ids ?? {}) });
    }
    return out;
  },
  startTime(pid) {
    if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return undefined;
    const stat = readProcFile(pid, 'stat');
    return stat ? parseProcStat(stat.toString('utf8'))?.startTime : undefined;
  },
  processGroup(pid) {
    if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return undefined;
    const stat = readProcFile(pid, 'stat');
    return stat ? parseProcStat(stat.toString('utf8'))?.pgid : undefined;
  },
  bootId() {
    if (process.platform !== 'linux') return undefined;
    try {
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  },
  freeBytes: (p) => freeBytesAt(p),
  tmpdir: () => os.tmpdir(),
};

/** One-line rendering of a command for messages (`npm ci --no-audit …`). */
export function formatCommand(file: string, args: readonly string[]): string {
  const q = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return [file, ...args].map(q).join(' ');
}

/** Last `n` non-empty lines of `text`. */
export function lastLines(text: string, n: number): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - n));
}
