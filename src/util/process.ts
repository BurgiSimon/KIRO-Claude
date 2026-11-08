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
 *    A timeout or abort during the pipe grace (after the shell exited) still kills members
 *    left in the group, but never a group id that may have been reused (review L1).
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
 *  - `timeoutMs` counts only the time kiro-claude was running ({@link runningTimeout}, r8 #0/#1):
 *    the child goes on while kiro-claude is stopped (its own Ctrl+Z, `kill -TSTP`, `kill -STOP`),
 *    but the stop is not counted against its timeout, and a child that exited meanwhile is
 *    reported with its exit status (a hook's block stays a block), never as timed out; also
 *    after several stops back to back (stopped again while it handled a continue, r9 #0).
 *  - While kiro-claude dies of a fatal signal that claude/lifecycle.ts forwards (`dyingSignal()`,
 *    review r5 H2) no command is started (`aborted`, `error` "kiro-claude is shutting down"),
 *    and a run that a signal ended meanwhile is `aborted` too, not a failure: the hook runner
 *    reports neither (a run that exited by itself keeps its exit code, a block included).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { utf8SafePrefixLength } from './text.js';
import { log } from './log.js';
// claude/lifecycle.ts imports only node: built-ins, so this adds no import cycle.
import { childReaped, dyingSignal, signalChild, trackChild } from '../claude/lifecycle.js';

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
  /**
   * True when the run was cancelled through `opts.signal`, or by kiro-claude dying of a fatal
   * signal (it was not started, or that signal ended it; r5 H2).
   */
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

/**
 * Kill a child and (Unix) its whole process group / (Windows) its process tree. After the child
 * was reaped its pid may name another process: on Unix the group is signalled only while it is
 * provably still ours (claude/lifecycle.ts signalChild, review L1); on Windows nothing is done
 * (`taskkill /T` needs the parent alive to find the tree anyway).
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWin) {
    if (childReaped(child)) return;
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
  signalChild(child, signal, true);
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

// ───────────────────────── running time: stops are not counted (r8 #0/#1) ─────────────────────────

/** Heartbeat of the stop clock while a {@link runningTimeout} is armed. */
const BEAT_MS = 100;
/** A beat this much later than the one before saw a gap: a stop (if a SIGCONT confirms it) or a blocked loop. */
const GAP_MS = 2 * BEAT_MS;
/** How many turns in a row a {@link runningTimeout} expiry may be put off (see there). */
const MAX_REDEFERS = 10;

const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6;

/**
 * The stop clock: how much time kiro-claude has spent stopped (SIGSTOP / SIGTSTP until SIGCONT),
 * while at least one {@link runningTimeout} is armed. Nothing can see a stop begin (SIGSTOP cannot
 * be caught, and SIGTSTP is the terminal's), so an unref'd heartbeat records when the event loop
 * last ran; a SIGCONT then confirms the gap since then as a stop. Credited is the gap less one
 * heartbeat interval: never more than the stop (the stop began at most one interval after the
 * last beat, unless the loop was blocked right before it). A gap without a SIGCONT (a blocked
 * event loop, a slow machine) is never credited, nor one the loop ran on after before a SIGCONT
 * came (a blocked loop, then a short or stray stop: only the stop counts). Every stop is
 * credited, also two back to back with no beat between them (r9 #0: one ended by the SIGCONT
 * whose dispatch the next one interrupted), see {@link onSigcont}.
 */
const stopClock = {
  /** The stops credited while the clock runs (process.hrtime ms; `from` = `to` less the credit). */
  stops: [] as { from: number; to: number }[],
  /** When the event loop was last seen running (a beat, a SIGCONT, the clock's start). */
  aliveAt: 0,
  /**
   * The gap the latest beat saw, if it saw one (it may be the stop that the SIGCONT handled next
   * ends). Every beat replaces it: once the loop has run on after a gap, that gap was a blocked
   * loop, never the stop a later SIGCONT ends (r8 verification).
   */
  gap: undefined as { from: number; to: number } | undefined,
  users: 0,
  beat: undefined as NodeJS.Timeout | undefined,
};

function onBeat(): void {
  const now = nowMs();
  stopClock.gap = now - stopClock.aliveAt > GAP_MS ? { from: stopClock.aliveAt, to: now } : undefined;
  stopClock.aliveAt = now;
}

/** Credit the gap `from`..`to` (no beat ran in it) as stopped time, less one heartbeat interval. */
function creditStop(from: number, to: number): void {
  const credit = to - from - BEAT_MS;
  if (credit > 0) stopClock.stops.push({ from: to - credit, to });
}

/**
 * SIGCONT: kiro-claude continues. Its handler runs in the poll phase, after the timers phase
 * that may already have run a beat (which saw the gap and moved `aliveAt`). Both that gap (only
 * the latest beat's: no beat ran since it) and the span since `aliveAt` are credited: the span
 * is under a heartbeat after a single stop (nothing more is credited), and is a second stop when
 * kiro-claude was stopped again before this listener ran, by an earlier SIGCONT listener (a
 * terminal mode change from the background stops it with SIGTTOU) or by another stop back to back
 * (r9 #0: before, only the longer of the two counted, and a hook that exited 2 during the second
 * stop was killed as timed out). The listener is prepended ({@link joinStopClock}), so the first
 * stop is credited before any other listener runs; the sum covers a listener added in front of it.
 */
function onSigcont(): void {
  const now = nowMs();
  const g = stopClock.gap;
  if (g && g.to === stopClock.aliveAt) creditStop(g.from, g.to);
  creditStop(stopClock.aliveAt, now);
  stopClock.gap = undefined;
  stopClock.aliveAt = now;
}

/** Stopped time credited after `since` (a stop that began before it counts from `since` on). */
function stoppedSince(since: number): number {
  let ms = 0;
  for (const s of stopClock.stops) if (s.to > since) ms += s.to - Math.max(s.from, since);
  return ms;
}

function joinStopClock(): void {
  if (stopClock.users++ > 0) return;
  stopClock.aliveAt = nowMs();
  stopClock.gap = undefined;
  stopClock.beat = setInterval(onBeat, BEAT_MS);
  stopClock.beat.unref();
  // no job control on Windows: nothing stops kiro-claude there. Prepended: it credits the stop
  // before another SIGCONT listener (the terminal reader's) runs, which might stop it again
  if (!isWin) process.prependListener('SIGCONT', onSigcont);
}

function leaveStopClock(): void {
  if (--stopClock.users > 0) return;
  stopClock.users = 0;
  stopClock.stops = [];
  if (stopClock.beat) clearInterval(stopClock.beat);
  stopClock.beat = undefined;
  if (!isWin) process.removeListener('SIGCONT', onSigcont);
}

/** A {@link runningTimeout}; `clear()` cancels it (idempotent). */
export interface RunningTimer {
  clear(): void;
}

/**
 * Like `setTimeout(onExpire, ms)`, for deadlines that must count only the time kiro-claude was
 * running (r8 #0/#1): hook command timeouts (runShell) and Claude Code's control requests
 * (claude/process.ts). Children and Claude Code run in process groups of their own and go on while
 * kiro-claude is stopped (its own Ctrl+Z, `kill -TSTP`, `kill -STOP`), but the monotonic clock of
 * `setTimeout` counts the stop, and at SIGCONT libuv runs expired timers before the poll phase
 * that delivers what happened meanwhile (a child's exit, an answer in a pipe). So:
 *  - the expiry is decided one event-loop turn after the timer fired (`setImmediate`): what
 *    arrived during a stop is handled first, and `onExpire` re-checks its own state. When that
 *    turn took longer than a heartbeat (kiro-claude was stopped or blocked again after the timer
 *    fired, e.g. inside a SIGCONT listener: r9 #0) the decision moves one more turn on, so that
 *    the poll phase first delivers what was queued meanwhile (that stop's SIGCONT, a child's
 *    exit, an answer); at most {@link MAX_REDEFERS} times in a row, so a loop blocked in every
 *    turn still decides;
 *  - stopped time ({@link stopClock}) is not counted: when a stop was credited since the timer
 *    was armed, it is re-armed for the running time left, so a genuinely hung child still expires
 *    after `ms` of running time. Without a stop the expiry is the plain timer's (one turn later).
 * `onExpire` gets the time (process.hrtime, ms) at which the timer fired, so a caller can tell
 * what arrived in that last turn. `ms` is clamped ({@link clampTimerMs}).
 */
export function runningTimeout(ms: number, onExpire: (firedAt: number) => void): RunningTimer {
  const total = clampTimerMs(ms);
  const start = nowMs();
  joinStopClock();
  let timer: NodeJS.Timeout | undefined;
  let immediate: NodeJS.Immediate | undefined;
  let done = false;
  const end = (): void => {
    if (done) return;
    done = true;
    leaveStopClock();
  };
  const arm = (delay: number): void => {
    timer = setTimeout(() => {
      timer = undefined;
      const firedAt = nowMs();
      /** When the decision was (last) put off by a turn. */
      let deferredAt = firedAt;
      let redefers = 0;
      const decide = (): void => {
        immediate = undefined;
        if (done) return;
        const now = nowMs();
        // no poll phase since it was deferred, and a stop or block in between (r9 #0): one more turn
        if (now - deferredAt > BEAT_MS && redefers < MAX_REDEFERS) {
          redefers++;
          deferredAt = now;
          immediate = setImmediate(decide);
          return;
        }
        const stopped = stoppedSince(start);
        if (stopped > 0) {
          const left = total - (now - start - stopped);
          if (left >= 1) return arm(left);
        }
        end();
        onExpire(firedAt);
      };
      immediate = setImmediate(decide);
    }, clampTimerMs(delay));
  };
  arm(total);
  return {
    clear() {
      if (timer) clearTimeout(timer);
      if (immediate) clearImmediate(immediate);
      timer = undefined;
      immediate = undefined;
      end();
    },
  };
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
    let timer: RunningTimer | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error?: string): void => {
      if (settled) return;
      settled = true;
      timer?.clear();
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
      // ended by a signal while kiro-claude dies of one (forwarded to it, or its group's SIGKILL)
      if (signal !== null && !timedOut && dyingSignal() !== undefined) aborted = true;
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
    const dying = dyingSignal();
    if (dying) {
      aborted = true;
      finish(null, null, `kiro-claude is shutting down (${dying})`);
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
    /** When the shell's exit was seen (process.hrtime ms), for the timeout below. */
    let exitSeenAt: number | undefined;
    child.on('exit', (code, sig) => {
      exitCode = code;
      exitSignal = sig;
      exitSeenAt = nowMs();
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
      // Running time only (r8 #0/#1): a stop of kiro-claude is not counted, and an exit seen in the
      // turn after the timer fired (the shell exited while kiro-claude was stopped) keeps its
      // status. An exit seen before (the pipe grace) still lets the timeout kill the group's
      // members that hold the pipes (L1). Values beyond ~24.8 days are clamped.
      timer = runningTimeout(opts.timeoutMs, (firedAt) => {
        if (settled) return;
        if (exitSeenAt !== undefined && exitSeenAt >= firedAt) return;
        timedOut = true;
        killProcessTree(child, 'SIGKILL');
      });
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
