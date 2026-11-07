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
 *     Listeners are installed only while at least one child is tracked (or a group of (4) is
 *     being swept).
 *  4. Nor can the members of the claude child's group (`sweepMembers`: MCP servers and any
 *     command Claude Code runs in its group) outlive the child itself (review r5 H1): once the leader
 *     exited, gracefully on stdin EOF (ClaudeProcess.close(): `/quit`, the front ends'
 *     ExitSignals close, ACP shutdown, the end of a headless run) or not (a crash), members left
 *     in its group get {@link MEMBER_GRACE_MS} (SIGTERM after {@link MEMBER_TERM_AFTER_MS}) and
 *     are then SIGKILLed through {@link signalChild} (L1 below). close() waits for that
 *     ({@link membersSettled}); a fatal signal (3) or an exit (2) meanwhile SIGKILLs them at once.
 *     runShell's children do not sweep: background commands of a hook shell that exited by
 *     itself may be meant to outlive it. Nor does anything Claude Code starts in a session of
 *     its own (setsid), by design (it may be meant to outlive claude): with the real 2.1.319
 *     (VERIFIED, r5 verifier) that is every Bash tool command (claude → a wrapper shell leading a
 *     new session → the command, in a group of its own there), which claude itself kills on its
 *     exit or SIGTERM; one that ignores claude's SIGTERM outlives it, as under claude alone. Its
 *     MCP servers are in its group (also VERIFIED), so their grandchildren (a shell or `npx`
 *     wrapper's server) are swept here.
 *
 * Survivors include members of a group whose leader died of the signal while they handle or
 * ignore it (a hook program with a cleanup handler under runShell's shell, a trap, a nohup'd
 * command, a stuck MCP server in claude's group; review r4 #11): the leader's exit untracks
 * it, yet its members would otherwise run on with no timeout, re-parented to init. So the group
 * of every entry the signal reached is SIGKILLed with the survivors, through
 * {@link signalChild}, i.e. only while it is provably still ours (L1 below). Members share the
 * leaders' grace but get none of their own: once every leader is gone kiro-claude dies at once,
 * because until it dies the rest of it keeps running and reacts to the dead children (runShell
 * resolves after its pipe grace, the session respawns the claude child and sends it the prompt,
 * errors are reported). The process-'exit' sweep (2) also covers the signalled groups, should an
 * exit cut the grace short. {@link shutdownTrackedChildren} SIGKILLs such members too, and, as
 * main() has resolved by then, gives them the rest of its grace first.
 *
 * Dying (review r5 H2): from the forwarded signal (3) until its re-raise, {@link dyingSignal}
 * names it. Spawn sites check it, since nothing in kiro-claude may react to the children it is
 * killing: ClaudeProcess.start() starts no child (no respawn of the claude child the signal just
 * killed), a ClaudeProcess writes nothing more to its child (no prompt, no answer that lets a
 * tool run) and hands it no CLI request, runShell() starts no command and reports one the signal
 * ended as aborted (no hook failure). The state is set only when lifecycle owns the shutdown;
 * should another listener take the re-raised signal (a front end that started during the grace),
 * it is cleared again and that listener owns the shutdown from then on.
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
 * closed the handle), so the leader itself is never signalled by number. Node's view lags: libuv
 * reaps every exited child (waitpid) before it reports any of them, so in one child's `'exit'`
 * handler and the microtasks after it (a `process.exit()` that runs the exit hook below,
 * shutdownTrackedChildren() after main() resolved) a sibling may be reaped while its exitCode is
 * still null. On Linux, signalChild therefore also treats a child as reaped when /proc no longer
 * shows the process it saw at {@link trackChild} (gone, or another start time).
 *
 * The check-to-kill window (review r5 H3). The proof and the `kill(-pid)` are two steps, so a
 * reuse in between cannot be excluded: the last proving member exits, the group empties, and the
 * kernel hands that number out again to a process that makes itself a group leader, all after the
 * proof was read and before kill(2). The full /proc scan takes milliseconds on a busy host and the
 * proving member may have been read early in it, so the proof is re-read right before the kill
 * (one `/proc/<pgid>/stat` and one member's stat, microseconds); the window left is those reads.
 * A reuse inside it needs the cyclic allocator to come round to exactly that number within it,
 * i.e. in practice only a deliberately steered allocator (ns_last_pid, as the pid-reuse tests do).
 * There is no race-free primitive in reach: Node's core API (>= 18.17; checked against v22.23.4,
 * whose binary, embedding lib/, contains no "pidfd" at all) has no pidfd_open, pidfd_send_signal
 * or waitid(P_PIDFD); `process.kill()` and `child.kill()` are kill(2) by number; an fd on
 * `/proc/<pid>` (which pidfd_send_signal would accept) cannot be used for signalling from JS and
 * does not keep the number reserved; and the leader cannot be left unreaped (a zombie keeps its
 * number reserved) since libuv reaps every child on SIGCHLD. Closing the window would take a
 * native addon (no: zero runtime deps) or a sentinel process of ours leading each group for its
 * whole life (an extra process per child; a larger redesign, not done).
 */
import { spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';

/** POSIX: spawn children in their own process group and signal the group. */
export const PROCESS_GROUPS = process.platform !== 'win32';

/** SIGTERM → SIGKILL grace for probes, forwarded signals and shutdown. */
export const KILL_GRACE_MS = 1_000;

/** How often members left in a reaped leader's group are checked during the grace. */
const MEMBER_POLL_MS = 25;

/**
 * How long members left in a `sweepMembers` child's group (the claude child: MCP servers, tool
 * commands) get once the leader exited, before they are SIGKILLed (r5 H1). They are SIGTERMed
 * after {@link MEMBER_TERM_AFTER_MS} of it.
 */
export const MEMBER_GRACE_MS = 500;

/** Within {@link MEMBER_GRACE_MS}: members still there this long after the leader's exit are SIGTERMed. */
const MEMBER_TERM_AFTER_MS = 100;

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT'];

interface Tracked {
  child: ChildProcess;
  group: boolean;
  /** SIGTERM before SIGKILL on shutdown (session children); probes are just SIGKILLed. */
  graceful: boolean;
  /** Once the leader exited, SIGKILL what is left of its group after {@link MEMBER_GRACE_MS}. */
  sweepMembers: boolean;
  exited: Promise<void>;
}

const tracked = new Set<Tracked>();
/** `sweepMembers` entries whose leader exited and whose group is being swept (r5 H1). */
const lingering = new Set<Tracked>();
/** The sweep of each `sweepMembers` child, from its leader's exit ({@link membersSettled}). */
const sweeps = new WeakMap<ChildProcess, Promise<void>>();
const signalListeners = new Map<NodeJS.Signals, () => void>();
let exitHookInstalled = false;
let dying: NodeJS.Signals | undefined;
/** The entries a fatal signal was forwarded to: SIGKILLed with the survivors (r4 #11). */
let forwarded: readonly Tracked[] = [];
/** Counts fatal-signal episodes, so a grace's die() never runs for a later one. */
let dyingEpisode = 0;

/**
 * The fatal signal kiro-claude is dying of, while lifecycle forwards it to the children (from the
 * signal until the re-raise; module doc, r5 H2); undefined otherwise, also when another listener
 * owns the shutdown. Spawn sites check it: nothing new may start (a session must not respawn its
 * claude child, a hook must not run) and nothing may be sent to a dying child.
 */
export function dyingSignal(): NodeJS.Signals | undefined {
  return dying;
}

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
  const unreported = !childReaped(child) && reapedUnreported(child, pid);
  if (unreported || childReaped(child)) {
    if (!(group && PROCESS_GROUPS) || !exitedGroupIsOurs(child, pid, unreported)) return false;
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
 * at once. `sweepMembers` (a `group` child whose group's members must not outlive it: the claude
 * child) SIGKILLs what is left of the group once the leader exited, after up to
 * {@link MEMBER_GRACE_MS} (module doc, r5 H1; {@link membersSettled}).
 */
export function trackChild(child: ChildProcess, group: boolean = PROCESS_GROUPS, opts: { graceful?: boolean; sweepMembers?: boolean } = {}): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  // Who holds the pid now (it cannot have been reaped yet: libuv reaps in the event loop), so a
  // reap Node has not reported yet can be told from a live child (reapedUnreported).
  if (process.platform === 'linux' && procfsState().ok) {
    const start = procStartTicks(child.pid);
    if (start !== undefined && start !== null) spawnTicks.set(child, start);
  }
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
      if (entry.sweepMembers) {
        lingering.add(entry);
        sweeps.set(
          child,
          sweepGroup(entry).then(() => {
            lingering.delete(entry);
            removeListenersWhenIdle();
          }),
        );
      }
      resolve();
      removeListenersWhenIdle();
    });
  });
  entry = { child, group, graceful: opts.graceful ?? true, sweepMembers: opts.sweepMembers === true && group && PROCESS_GROUPS, exited };
  tracked.add(entry);
  installHooks();
}

/** Number of tracked live children (tests, diagnostics). */
export function trackedChildCount(): number {
  return tracked.size;
}

/**
 * Resolves once the sweep of a `sweepMembers` child's group after its leader exited has ended
 * (its members left, or were SIGKILLed after {@link MEMBER_GRACE_MS}); at once for any other
 * child, or one that has not exited. Never rejects.
 */
export function membersSettled(child: ChildProcess): Promise<void> {
  return sweeps.get(child) ?? Promise.resolve();
}

/**
 * r5 H1: what is left of `t`'s group once its leader exited (gracefully or not): members first
 * get {@link MEMBER_TERM_AFTER_MS} to leave on their own (they already got what the leader sent
 * them: stdin EOF, Claude Code's own shutdown of its MCP servers; or close()'s signal to the
 * whole group), then a SIGTERM, and are SIGKILLed once {@link MEMBER_GRACE_MS} has passed. Both
 * go through {@link signalChild}, i.e. only while the group is provably still ours (L1).
 */
async function sweepGroup(t: Tracked): Promise<void> {
  const start = performance.now();
  let termed = false;
  for (;;) {
    if (!membersLeft(t)) return;
    const elapsed = performance.now() - start;
    if (elapsed >= MEMBER_GRACE_MS) break;
    if (!termed && elapsed >= MEMBER_TERM_AFTER_MS) {
      termed = true;
      signalChild(t.child, 'SIGTERM', t.group);
      continue;
    }
    const next = (termed ? MEMBER_GRACE_MS : MEMBER_TERM_AFTER_MS) - elapsed;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(MEMBER_POLL_MS, next)));
  }
  signalChild(t.child, 'SIGKILL', t.group);
}

function removeListenersWhenIdle(): void {
  if (tracked.size === 0 && lingering.size === 0) removeSignalListeners();
}

/**
 * SIGTERM every tracked child group (SIGKILL for probes), wait up to `graceMs` for them to
 * exit (leaders, and members a leader that died of the SIGTERM left in its group), SIGKILL the
 * rest and wait (bounded) for their exit events. Resolves immediately when nothing is tracked.
 */
export async function shutdownTrackedChildren(graceMs: number = KILL_GRACE_MS): Promise<void> {
  if (tracked.size === 0 && lingering.size === 0) return;
  // groups still being swept after their leader's exit (r5 H1) are shut down like the others
  const entries = [...tracked, ...lingering];
  for (const t of entries) signalChild(t.child, t.graceful ? 'SIGTERM' : 'SIGKILL', t.group);
  if (await settleGroupsWithin(entries, graceMs)) return;
  // Every entry, not only those still tracked: a reaped leader's group is signalled only while
  // it is provably still ours (signalChild, L1), i.e. it holds members that survived.
  for (const t of entries) signalChild(t.child, 'SIGKILL', t.group);
  await settleWithin(entries, graceMs);
}

function settleWithin(entries: readonly Tracked[], ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void Promise.all(entries.map((t) => t.exited)).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * {@link settleWithin}, then (within the same `ms`) until no group of `entries` holds members
 * left behind by its leader ({@link membersLeft}). True when both happened in time.
 */
async function settleGroupsWithin(entries: readonly Tracked[], ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  if (!(await settleWithin(entries, ms))) return false;
  for (;;) {
    if (!entries.some(membersLeft)) return true;
    const left = deadline - performance.now();
    if (left <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(MEMBER_POLL_MS, left)));
  }
}

/**
 * Whether the process group of `t`, whose leader Node has reaped, still holds live members of
 * ours. `kill(-pid, 0)` delivers nothing (harmless even for a reused number) and answers
 * whether any process of that group exists that we may signal; one that does must still be
 * provably ours ({@link ownsExitedGroup}, L1). False for a leader not reaped yet (its own exit
 * is what {@link settleWithin} waits for) and without process groups.
 */
function membersLeft(t: Tracked): boolean {
  const pid = t.child.pid;
  if (pid === undefined || !(t.group && PROCESS_GROUPS) || !childReaped(t.child)) return false;
  try {
    process.kill(-pid, 0);
  } catch {
    return false; // ESRCH: empty; EPERM: nothing we could SIGKILL either
  }
  return exitedGroupIsOurs(t.child, pid);
}

function installHooks(): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      // `forwarded` is empty unless a fatal signal's grace was cut short by an exit; `lingering`
      // holds groups whose members' wait an exit cuts short (r5 H1).
      for (const t of new Set([...forwarded, ...tracked, ...lingering])) signalChild(t.child, 'SIGKILL', t.group);
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
  // groups still being swept after their leader's exit (r5 H1) too: die() SIGKILLs them at once
  const entries = [...tracked, ...lingering];
  forwarded = entries;
  for (const t of entries) signalChild(t.child, sig, t.group);
  // Leaders only: members get no grace of their own (module doc; the rest of kiro-claude would
  // react to the dead leaders meanwhile). die() SIGKILLs those left.
  const episode = ++dyingEpisode;
  // (unless a second signal's die() ran meanwhile and another listener took the re-raise)
  void settleWithin(entries, KILL_GRACE_MS).then(() => {
    if (dying !== undefined && episode === dyingEpisode) die(sig);
  });
}

function die(sig: NodeJS.Signals): void {
  // Every group the signal reached, not only leaders still tracked: a reaped leader's group is
  // SIGKILLed only while provably still ours (signalChild, L1), so survivors die, reuses do not.
  for (const t of new Set([...forwarded, ...tracked, ...lingering])) signalChild(t.child, 'SIGKILL', t.group);
  removeSignalListeners();
  // Re-raise with the default disposition (Node's own handler resets the terminal, then exits).
  process.kill(process.pid, sig);
  // Still alive: a listener added meanwhile (a front end that started during the grace) took the
  // signal and owns the shutdown now; kiro-claude is no longer dying of it here (r5 H2).
  dying = undefined;
  forwarded = [];
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

/** Raw /proc start time of each tracked child, read when it was tracked (Linux). */
const spawnTicks = new WeakMap<ChildProcess, number>();

/** Raw `/proc/<pid>/stat` start time; null when no such process (ENOENT/ESRCH); undefined when unknown. */
function procStartTicks(pid: number): number | null | undefined {
  let text: string;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, 'latin1');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ESRCH' ? null : undefined;
  }
  return parseProcStat(text)?.startTicks;
}

/**
 * Whether `child`, which Node still shows running, was already reaped by libuv (module doc): its
 * pid is gone (from /proc and for kill(pid, 0); /proc may hide a process, e.g. a setuid one
 * under hidepid), or held by a process that started at another time than the one seen at
 * {@link trackChild}. False when unknown (not tracked on Linux, /proc unreadable).
 */
function reapedUnreported(child: ChildProcess, pid: number): boolean {
  const start = spawnTicks.get(child);
  if (start === undefined) return false;
  const now = procStartTicks(pid);
  if (now === null) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  return now !== undefined && now !== start;
}

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

/**
 * `unreported`: libuv reaped the leader but its 'exit' (which records the exit time) has not run
 * yet; the reap happened before now, so now bounds the exit time.
 */
function exitedGroupIsOurs(child: ChildProcess, pgid: number, unreported = false): boolean {
  const table = readProcessTable('auto', pgid);
  const exitTick = exitTicks.get(child) ?? (unreported ? bootTicksNow() : undefined);
  if (table === undefined || !ownsExitedGroup(pgid, table, exitTick)) return false;
  // The scan reads one file per process (milliseconds on a busy host) and a member that proved the
  // group ours may have been read early in it: re-read just that proof, so the window before the
  // caller's kill(2) is one or two small reads (module doc, r5 H3). Not with the `ps` listing.
  return !procfsState().ok || reconfirmOwnership(pgid, table, exitTick);
}

/** `/proc/<pid>/stat`, parsed; undefined when gone or unreadable. */
function procStat(pid: number): ProcInfo | undefined {
  try {
    return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'latin1'));
  } catch {
    return undefined;
  }
}

/**
 * Re-checks, right now, what made {@link ownsExitedGroup} true for `table`: still no (readable)
 * process with pid `pgid`, and one of the proving members still alive in group and session
 * `pgid` with the same start time (when start times are usable). Linux /proc only.
 */
function reconfirmOwnership(pgid: number, table: readonly ProcInfo[], exitTick: number | undefined): boolean {
  if (procStat(pgid) !== undefined) return false;
  const withStart = procfsState().startTimes;
  for (const m of table) {
    if (m.pgid !== pgid || (m.sid !== undefined && m.sid !== pgid) || m.state === 'Z' || m.state === 'X') continue;
    if (!(m.startTicks === undefined || (exitTick !== undefined && m.startTicks <= exitTick))) continue;
    const now = procStat(m.pid);
    if (!now || now.pgid !== pgid || now.sid !== m.sid || now.state === 'Z' || now.state === 'X') continue;
    if (withStart && now.startTicks !== m.startTicks) continue;
    return true;
  }
  return false;
}
