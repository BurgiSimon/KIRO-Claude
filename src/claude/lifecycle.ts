/**
 * Lifecycle of every `claude` child kiro-claude spawns (capability/auth probes in binary.ts and
 * auth.ts, the headless session child in process.ts), and of Kiro hook commands (util/process.ts
 * `runShell`, tracked so they cannot outlive kiro-claude either). Interactive
 * `claude auth login|logout` (stdio inherited, needs the terminal) is deliberately NOT covered.
 *
 * Process groups (POSIX only, {@link PROCESS_GROUPS}): children are spawned `detached` — Node
 * makes them leaders of a new process group (and session) — and are NOT unref'd. A terminal
 * Ctrl+C sends SIGINT to the terminal's foreground process group; with the child outside it,
 * only kiro-claude receives it and interrupts the turn itself (the child used to be killed
 * directly in pipe mode). Kill signals go to the whole group (`kill(-pid)`), so grandchildren
 * that inherited our pipes (shell wrappers, tool commands) go too. On Windows `detached` would
 * open a console window, so children are spawned normally and `child.kill()` is used.
 *
 * A tracked child cannot outlive kiro-claude:
 *  1. claude exits on stdin EOF, and our end of its stdin closes when we die;
 *  2. on process `'exit'` every live tracked group is SIGKILLed (synchronous; the graceful
 *     stdin-EOF → SIGTERM → SIGKILL shutdown of ClaudeProcess.close() has normally run long
 *     before, so this only catches leaks and abrupt exits);
 *  3. on SIGTERM / SIGHUP / SIGINT that nothing else in kiro-claude handles (our listener is
 *     the only one, so without it Node would terminate right now), the signal is forwarded to
 *     every tracked group, survivors are SIGKILLed after {@link KILL_GRACE_MS}, and the signal
 *     is re-raised with our listeners removed, so kiro-claude still dies of it (default
 *     disposition, exit status unchanged). When another listener exists (ACP server, REPL,
 *     headless runner, crew runner) it owns the shutdown and (2) still applies at exit.
 *     Listeners are installed only while at least one child is tracked.
 *
 * {@link shutdownTrackedChildren} is the graceful variant for the executable entry (src/bin):
 * after main() resolved, a child still running was abandoned (e.g. a probe left behind by
 * whoami's 20 s cap) and must neither hold the process open nor survive it.
 *
 * Pid reuse (review L1). Pids are handed out cyclically (pid_max is often 32768), and a pid
 * number stays reserved only while some process uses it as its pid, process group id or session
 * id. While our leader is alive or a zombie, `kill(-pid)` can only reach our group. Once Node
 * has reaped it (`'exit'` emitted, `exitCode`/`signalCode` set) the number stays ours only while
 * members of the group live; when the group is empty it can become the pid, group and session
 * of an unrelated process anywhere in the pid namespace (any detached spawn, `setsid`, a job of
 * a job-control shell such as a `node --test` started from bash), and a late `kill(-pid)` would
 * kill that group. Several paths kill after the exit on purpose, to end members that hold our
 * pipes (runCaptured's finish(), runShell's timeout/abort during its pipe grace,
 * ClaudeProcess.close() while the exit is drained), so {@link signalChild} signals a reaped
 * leader's group only when {@link ownsExitedGroup} proves it is still ours: no process has that
 * pid, and a member of that group and session (Node's `detached` is setsid(), so ours are both)
 * started no later than the leader's exit (Linux /proc, start times in clock ticks). A group
 * whose members all started after the exit is not signalled (it may be a reuse). Without
 * /proc, the POSIX `ps -A -o pid=,pgid=` listing is used for the first two checks; if neither
 * is available the post-exit kill is skipped. `child.kill()` is a no-op after the reap (Node
 * closed the handle), so the leader itself is never signalled by number.
 */
import { spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';

/** POSIX: spawn children in their own process group and signal the group. */
export const PROCESS_GROUPS = process.platform !== 'win32';

/** SIGTERM → SIGKILL grace for probes, forwarded signals and shutdown. */
export const KILL_GRACE_MS = 1_000;

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT'];

interface Tracked {
  child: ChildProcess;
  group: boolean;
  /** SIGTERM before SIGKILL on shutdown (session children); probes are just SIGKILLed. */
  graceful: boolean;
  exited: Promise<void>;
}

const tracked = new Set<Tracked>();
const signalListeners = new Map<NodeJS.Signals, () => void>();
let exitHookInstalled = false;
let dying: NodeJS.Signals | undefined;

/** Extra `spawn()` options for a tracked child (`detached` on POSIX). */
export function groupSpawnOptions(): { detached?: boolean } {
  return PROCESS_GROUPS ? { detached: true } : {};
}

/** True once Node reaped `child` (`'exit'` emitted): its pid is no longer reserved for it. */
export function childReaped(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Sends `signal` to `child`'s process group (`group`, POSIX) or to the child alone. Never
 * throws; returns false when nothing was signalled (already gone). After the child was reaped
 * only its group can be signalled, and only while it is provably still ours (module doc, L1).
 */
export function signalChild(child: ChildProcess, signal: NodeJS.Signals, group: boolean = PROCESS_GROUPS): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (childReaped(child)) {
    if (!(group && PROCESS_GROUPS) || !exitedGroupIsOurs(child, pid)) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  if (group && PROCESS_GROUPS) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      /* group gone (ESRCH) or not ours: fall back to the leader */
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/**
 * Registers a spawned child (spawned with {@link groupSpawnOptions} when `group`) until it
 * exits. A child whose spawn failed (no pid) is ignored. `graceful: false` marks a stateless
 * probe (`--version`, `--help`, `auth status`) that {@link shutdownTrackedChildren} may SIGKILL
 * at once.
 */
export function trackChild(child: ChildProcess, group: boolean = PROCESS_GROUPS, opts: { graceful?: boolean } = {}): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  // When the leader exits, before any other 'exit' listener: members that started by then
  // prove a later group kill still targets our group (ownsExitedGroup).
  if (group && PROCESS_GROUPS && process.platform === 'linux') {
    child.prependOnceListener('exit', () => {
      const ticks = bootTicksNow();
      if (ticks !== undefined) exitTicks.set(child, ticks);
    });
  }
  let entry!: Tracked;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      tracked.delete(entry);
      resolve();
      if (tracked.size === 0) removeSignalListeners();
    });
  });
  entry = { child, group, graceful: opts.graceful ?? true, exited };
  tracked.add(entry);
  installHooks();
}

/** Number of tracked live children (tests, diagnostics). */
export function trackedChildCount(): number {
  return tracked.size;
}

/**
 * SIGTERM every tracked child group (SIGKILL for probes), wait up to `graceMs` for them to
 * exit, SIGKILL the rest and wait (bounded) for their exit events. Resolves immediately when
 * nothing is tracked.
 */
export async function shutdownTrackedChildren(graceMs: number = KILL_GRACE_MS): Promise<void> {
  if (tracked.size === 0) return;
  const entries = [...tracked];
  for (const t of entries) signalChild(t.child, t.graceful ? 'SIGTERM' : 'SIGKILL', t.group);
  if (await settleWithin(entries, graceMs)) return;
  for (const t of entries) if (tracked.has(t)) signalChild(t.child, 'SIGKILL', t.group);
  await settleWithin(entries, graceMs);
}

function settleWithin(entries: Tracked[], ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void Promise.all(entries.map((t) => t.exited)).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function installHooks(): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const t of tracked) signalChild(t.child, 'SIGKILL', t.group);
    });
  }
  // Only POSIX children escape the terminal's signals; on Windows they share the console.
  if (!PROCESS_GROUPS || signalListeners.size > 0) return;
  for (const sig of FORWARDED_SIGNALS) {
    const listener = (): void => onSignal(sig);
    signalListeners.set(sig, listener);
    // Prepended: we must run before a `process.once` listener removes itself, or we would
    // count no other handler and cut a graceful shutdown (ACP server, 05 §2.5) short.
    process.prependListener(sig, listener);
  }
}

function removeSignalListeners(): void {
  for (const [sig, listener] of signalListeners) process.removeListener(sig, listener);
  signalListeners.clear();
}

function onSignal(sig: NodeJS.Signals): void {
  // A second signal while we wait for the children: stop waiting.
  if (dying) {
    die(dying);
    return;
  }
  // Someone else (ACP server, REPL, headless runner…) handles it and owns the shutdown.
  if (process.listenerCount(sig) > 1) return;
  dying = sig;
  const entries = [...tracked];
  for (const t of entries) signalChild(t.child, sig, t.group);
  void settleWithin(entries, KILL_GRACE_MS).then(() => die(sig));
}

function die(sig: NodeJS.Signals): void {
  for (const t of tracked) signalChild(t.child, 'SIGKILL', t.group);
  removeSignalListeners();
  // Re-raise with the default disposition (Node's own handler resets the terminal, then exits).
  process.kill(process.pid, sig);
}

/* ------------------------------------------------------------------------------------------ */
/* Group ownership after the leader was reaped (L1)                                            */
/* ------------------------------------------------------------------------------------------ */

/** One process as the post-exit ownership check sees it. */
export interface ProcInfo {
  pid: number;
  pgid: number;
  /** Session id (Linux /proc only). */
  sid?: number;
  /** One-letter state (Linux /proc only); `Z`/`X` are dead. */
  state?: string;
  /** Start time in clock ticks since boot (Linux /proc only, when usable). */
  startTicks?: number;
}

/** Linux clock ticks per second of /proc start times (USER_HZ, 100 on every current arch). */
const USER_HZ = 100;

/** When each tracked group leader exited, in clock ticks since boot (Linux). */
const exitTicks = new WeakMap<ChildProcess, number>();

/** Current time in clock ticks since boot (`/proc/uptime`), or undefined. */
function bootTicksNow(): number | undefined {
  try {
    const m = /^(\d+)\.(\d{2})/.exec(fs.readFileSync('/proc/uptime', 'latin1'));
    return m ? Number(m[1]) * USER_HZ + Number(m[2]) : undefined;
  } catch {
    return undefined;
  }
}

/** Parses `/proc/<pid>/stat` (the comm field may contain spaces and parentheses). */
export function parseProcStat(text: string): ProcInfo | undefined {
  const close = text.lastIndexOf(')');
  if (close < 0) return undefined;
  const pid = Number.parseInt(text, 10);
  // After ") ": state(3) ppid(4) pgrp(5) session(6) … starttime(22) → indices 0, 1, 2, 3, 19.
  const f = text.slice(close + 2).split(' ');
  const pgid = Number.parseInt(f[2] ?? '', 10);
  const sid = Number.parseInt(f[3] ?? '', 10);
  const start = Number.parseInt(f[19] ?? '', 10);
  if (!Number.isInteger(pid) || !Number.isInteger(pgid) || !Number.isInteger(sid)) return undefined;
  return { pid, pgid, sid, state: f[0] ?? '', ...(Number.isInteger(start) ? { startTicks: start } : {}) };
}

let procfs: { ok: boolean; startTimes: boolean } | undefined;

/**
 * Whether /proc describes our own pid namespace, and whether its start times are in the
 * {@link USER_HZ} ticks of /proc/uptime (checked once against our own start).
 */
function procfsState(): { ok: boolean; startTimes: boolean } {
  if (procfs) return procfs;
  procfs = { ok: false, startTimes: false };
  if (process.platform !== 'linux') return procfs;
  try {
    const self = parseProcStat(fs.readFileSync('/proc/self/stat', 'latin1'));
    if (!self || self.pid !== process.pid) return procfs;
    // Our own start, from /proc/uptime and Node's (monotonic) uptime: never earlier than the
    // real one (a suspend only makes it later), while ticks of another rate would be far off.
    const now = bootTicksNow();
    const expected = now === undefined ? undefined : now - process.uptime() * USER_HZ;
    const startTimes = self.startTicks !== undefined && expected !== undefined && self.startTicks >= 0 && self.startTicks <= expected + 5 * USER_HZ;
    procfs = { ok: true, startTimes };
  } catch {
    /* no procfs */
  }
  return procfs;
}

/**
 * The process table: Linux /proc when it describes our pid namespace (`source` 'auto' or
 * 'proc'), else the POSIX `ps -A -o pid=,pgid=` listing ('auto' or 'ps'). `pgid` adds
 * `/proc/<pgid>` even when that number is a thread (threads are not listed but share the pid
 * space). Undefined when unavailable. Exported for tests.
 */
export function readProcessTable(source: 'auto' | 'proc' | 'ps' = 'auto', pgid?: number): ProcInfo[] | undefined {
  if (source !== 'ps' && procfsState().ok) {
    const withStart = procfsState().startTimes;
    const read = (name: string): ProcInfo | undefined => {
      try {
        const p = parseProcStat(fs.readFileSync(`/proc/${name}/stat`, 'latin1'));
        if (p && !withStart) delete p.startTicks;
        return p;
      } catch {
        return undefined; // gone meanwhile
      }
    };
    let names: string[];
    try {
      names = fs.readdirSync('/proc');
    } catch {
      return undefined;
    }
    const out: ProcInfo[] = [];
    for (const name of names) {
      const c = name.charCodeAt(0);
      if (c < 48 || c > 57) continue;
      const p = read(name);
      if (p) out.push(p);
    }
    if (pgid !== undefined && !out.some((p) => p.pid === pgid)) {
      const p = read(String(pgid));
      if (p) out.push(p);
    }
    return out;
  }
  if (source === 'proc' || process.platform === 'win32') return undefined;
  try {
    const r = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'pgid='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    if (r.status !== 0 || typeof r.stdout !== 'string') return undefined;
    const out: ProcInfo[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) out.push({ pid: Number(m[1]), pgid: Number(m[2]) });
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether process group `pgid`, whose leader we spawned (as a session leader) and Node has
 * reaped, is still ours, judged from the current process `table` and the leader's exit time
 * (`exitTick`, clock ticks since boot; undefined when unknown). Pure; exported for tests.
 *
 * Our group keeps its number reserved for as long as any member lives, so: if any process now
 * has pid `pgid`, the number was handed out again and the group (if any) is not ours. Otherwise
 * a member of group and session `pgid` that started no later than the leader's exit proves the
 * group never emptied, hence is ours (a reused group's members all start after our exit). With
 * start times or sessions unknown (`ps`), membership alone is taken. A group with only dead
 * (zombie) members is not worth signalling.
 */
export function ownsExitedGroup(pgid: number, table: readonly ProcInfo[], exitTick: number | undefined): boolean {
  if (table.some((p) => p.pid === pgid)) return false;
  const members = table.filter((p) => p.pgid === pgid && (p.sid === undefined || p.sid === pgid));
  if (!members.some((p) => p.state !== 'Z' && p.state !== 'X')) return false;
  return members.some((p) => p.startTicks === undefined || (exitTick !== undefined && p.startTicks <= exitTick));
}

function exitedGroupIsOurs(child: ChildProcess, pgid: number): boolean {
  const table = readProcessTable('auto', pgid);
  return table !== undefined && ownsExitedGroup(pgid, table, exitTicks.get(child));
}
