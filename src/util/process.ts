/**
 * Run shell commands for hooks, `!cmd`, `#git diff` and similar adapter-side work.
 *
 * Semantics (06 §3.3 hook execution, 00 §2.4 "Timeout ⇒ kill child (SIGKILL)"):
 *  - Unix: `bash -c <command>` when `bash` is on PATH (looked up in `opts.env.PATH`, falling
 *    back to `process.env.PATH`), else `/bin/sh -c`. Windows: `%ComSpec%` (default `cmd.exe`)
 *    `/d /s /c "<command>"` — Node's own `shell: true` convention for `cmd /C`.
 *    `opts.shell` overrides the program (`cmd`/`powershell`/`pwsh` get their own flags,
 *    anything else gets `-c`).
 *  - The child runs in its own process group on Unix (`detached`), so a timeout or abort
 *    SIGKILLs the whole group (grandchildren included). On Windows `taskkill /T /F` is used.
 *  - A running child cannot outlive kiro-claude (review C12): being in its own group and
 *    session, it gets neither the terminal's signals nor our death, and the timeout timer dies
 *    with us. So it is registered with claude/lifecycle.ts as a non-graceful group child until
 *    it exits: the process-`'exit'` sweep SIGKILLs its group, a fatal SIGTERM/SIGHUP/SIGINT
 *    nothing else handles is forwarded to it first, and `shutdownTrackedChildren()` (run.ts,
 *    once main() resolved) SIGKILLs it at once. Background grandchildren left behind by a shell
 *    that already exited are not tracked (they may be meant to outlive the hook).
 *  - stdin: `opts.stdin` is written and the pipe closed; without it stdin is closed at once
 *    (EOF). EPIPE from children that do not read stdin is ignored.
 *  - stdout/stderr are captured (UTF-8) up to `maxOutputBytes` each (default 1 MiB, cut on a
 *    character boundary); excess output is drained and dropped, `truncated` reports it.
 *  - The promise resolves when the shell exits and its output pipes close. If a background
 *    grandchild keeps the pipes open after the shell exited, we stop waiting after a short
 *    grace period (default 500 ms) and resolve with what was captured.
 *  - Never rejects: spawn failures (e.g. missing cwd or shell) resolve with `exitCode: null`
 *    and `error` set.
 *  - `timeoutMs` / `closeGraceMs` above 2^31-1 ms are clamped ({@link clampTimerMs}); Node
 *    would otherwise fire such timers after 1 ms and print a warning on stderr.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { utf8SafePrefixLength } from './text.js';
import { log } from './log.js';
// claude/lifecycle.ts has no runtime imports, so this adds no import cycle.
import { trackChild } from '../claude/lifecycle.js';

export interface ShellResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** Spawn error message, if the process could not be started. */
  error?: string;
  /** Which streams exceeded `maxOutputBytes`. */
  truncated?: { stdout: boolean; stderr: boolean };
  /** True when the run was cancelled through `opts.signal`. */
  aborted?: boolean;
}

export interface RunShellOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  /** 0 or undefined = no timeout. */
  timeoutMs?: number;
  /** Per stream; default 1 MiB. */
  maxOutputBytes?: number;
  /** Override the shell program. */
  shell?: string;
  /** Cancel the run (kills the process group). */
  signal?: AbortSignal;
  /** How long to wait for pipes to close after the shell exited (default 500 ms). */
  closeGraceMs?: number;
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024;
const isWin = process.platform === 'win32';

const whichCache = new Map<string, string | null>();

/**
 * Find an executable on `PATH` (honoring `PATHEXT` on Windows). Absolute or relative paths
 * containing a separator are checked directly. Returns `undefined` when not found.
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? process.env.PATH ?? '';
  const key = `${name}\u0000${pathVar}`;
  const cached = whichCache.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const exts = isWin ? ['', ...(env.PATHEXT ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  const check = (p: string): boolean => {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return false;
      if (!isWin) fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  let found: string | undefined;
  if (name.includes('/') || (isWin && name.includes('\\'))) {
    for (const ext of exts) {
      if (check(name + ext)) {
        found = path.resolve(name + ext);
        break;
      }
    }
  } else {
    outer: for (const dir of pathVar.split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of exts) {
        const p = path.join(dir, name + ext);
        if (check(p)) {
          found = p;
          break outer;
        }
      }
    }
  }
  whichCache.set(key, found ?? null);
  return found;
}

/** Program and argv used to run `command` (exported for tests and diagnostics). */
export function shellInvocation(
  command: string,
  opts: { env?: NodeJS.ProcessEnv; shell?: string } = {},
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  const env = opts.env ?? process.env;
  if (opts.shell) {
    const base = path.basename(opts.shell).toLowerCase().replace(/\.exe$/, '');
    if (base === 'cmd') return { file: opts.shell, args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
    if (base === 'powershell' || base === 'pwsh') {
      return { file: opts.shell, args: ['-NoProfile', '-NonInteractive', '-Command', command], windowsVerbatimArguments: false };
    }
    return { file: opts.shell, args: ['-c', command], windowsVerbatimArguments: false };
  }
  if (isWin) {
    const comspec = env.ComSpec || env.COMSPEC || process.env.ComSpec || 'cmd.exe';
    return { file: comspec, args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
  }
  const bash = findExecutable('bash', env) ?? (env !== process.env ? findExecutable('bash', process.env) : undefined);
  return { file: bash ?? '/bin/sh', args: ['-c', command], windowsVerbatimArguments: false };
}

/**
 * Bounded output buffer. Keeps up to `max + 4` bytes so that, when truncating to `max`, we can
 * see whether the byte at `max` continues a multi-byte character and back off to a boundary.
 */
class Capture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private total = 0;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    this.total += chunk.length;
    const limit = this.max + 4;
    if (this.size >= limit) return;
    const part = chunk.length > limit - this.size ? chunk.subarray(0, limit - this.size) : chunk;
    this.chunks.push(part);
    this.size += part.length;
  }
  get truncated(): boolean {
    return this.total > this.max;
  }
  text(): string {
    const buf = Buffer.concat(this.chunks, this.size);
    if (buf.length <= this.max) return buf.toString('utf8');
    return buf.subarray(0, utf8SafePrefixLength(buf, this.max)).toString('utf8');
  }
}

/** Kill a child and (Unix) its whole process group / (Windows) its process tree. */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWin) {
    try {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on('error', () => undefined);
    } catch {
      // ignore
    }
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** Longest delay `setTimeout` honours; larger values fire after 1 ms (with a stderr warning). */
const MAX_TIMER_MS = 0x7fffffff;

/** Clamp a delay to what `setTimeout` supports (pure; exported for tests). */
export function clampTimerMs(ms: number): number {
  if (!Number.isFinite(ms)) return ms > 0 ? MAX_TIMER_MS : 0;
  return Math.min(Math.max(0, ms), MAX_TIMER_MS);
}

function hrMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/** Run `command` through the platform shell (see module doc). Never rejects. */
export function runShell(command: string, opts: RunShellOptions): Promise<ShellResult> {
  const start = process.hrtime.bigint();
  const max = Math.max(0, opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT);
  const out = new Capture(max);
  const err = new Capture(max);
  const graceMs = clampTimerMs(opts.closeGraceMs ?? 500);

  return new Promise<ShellResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      const res: ShellResult = {
        exitCode,
        signal,
        stdout: out.text(),
        stderr: err.text(),
        timedOut,
        durationMs: Math.round(hrMs(start) * 1000) / 1000,
      };
      if (error !== undefined) res.error = error;
      if (out.truncated || err.truncated) res.truncated = { stdout: out.truncated, stderr: err.truncated };
      if (aborted) res.aborted = true;
      resolve(res);
    };

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      if (child) killProcessTree(child, 'SIGKILL');
    };

    if (opts.signal?.aborted) {
      aborted = true;
      finish(null, null, 'aborted before start');
      return;
    }

    const inv = shellInvocation(command, { env: opts.env, shell: opts.shell });
    try {
      child = spawn(inv.file, inv.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !isWin,
        windowsHide: true,
        windowsVerbatimArguments: inv.windowsVerbatimArguments,
      });
    } catch (e) {
      finish(null, null, e instanceof Error ? e.message : String(e));
      return;
    }

    // Until it exits (no pid = spawn failed: nothing to track). SIGKILL on our exit/shutdown.
    trackChild(child, !isWin, { graceful: false });

    child.on('error', (e: Error) => {
      log.debug('runShell spawn error', command, e.message);
      finish(null, null, e.message);
    });
    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.stderr?.on('data', (b: Buffer) => err.push(b));
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);

    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    child.on('exit', (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      // Background grandchildren may keep our pipes open: don't wait for them forever.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode, exitSignal);
      }, graceMs);
    });
    child.on('close', (code, sig) => finish(code ?? exitCode, sig ?? exitSignal));

    if (child.stdin) {
      child.stdin.on('error', () => undefined); // EPIPE: child did not read stdin
      try {
        if (opts.stdin !== undefined && opts.stdin !== '') child.stdin.end(opts.stdin);
        else child.stdin.end();
      } catch {
        // ignore
      }
    }

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      // Values beyond ~24.8 days are clamped (Node would otherwise fire after 1 ms).
      timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killProcessTree(child, 'SIGKILL');
      }, clampTimerMs(opts.timeoutMs));
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
