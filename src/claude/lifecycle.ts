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
 */
import type { ChildProcess } from 'node:child_process';

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

/**
 * Sends `signal` to `child`'s process group (`group`, POSIX) or to the child alone. Never
 * throws; returns false when nothing was signalled (already gone).
 */
export function signalChild(child: ChildProcess, signal: NodeJS.Signals, group: boolean = PROCESS_GROUPS): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
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
