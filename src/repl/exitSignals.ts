/**
 * Dying of a fatal signal after closing the session(s), for both front ends: the interactive chat
 * (repl/core.ts) and `chat --no-interactive` (headless/run.ts).
 *
 * SIGHUP / SIGTERM during the whole run (a closed terminal tab, `kill`), and SIGINT while the
 * session starts (Claude Code initializing, agentSpawn hooks) and during the final close
 * (below); in between Ctrl+C belongs to the front end: the REPL's line reader, the headless
 * interrupt handler. Without this, claude/lifecycle.ts's
 * forwarder kills kiro-claude before any session's close(), which drops a chat that never had a
 * message (Q saves a conversation only after a reply, r4 #4), saves the record and releases its
 * lock, and runs SessionEnd hooks. Here the front end's `close` callback closes what it opened (a
 * start still running is cancelled through {@link ExitSignals.startSignal}, startSignal.ts:
 * agentSpawn hooks are killed and nothing of it stays), then the signal is re-raised with these
 * listeners removed, so kiro-claude still dies of it (the forwarder ends any child left). The
 * wait is bounded by {@link SIGNAL_CLOSE_GRACE_MS} from the signal; a second signal re-raises at
 * once: a different one, or the same one more than {@link DUPLICATE_SIGNAL_WINDOW_MS} after the
 * first. A repeat inside that window is the same event delivered twice, not an impatient user: a
 * terminal tab closing under an interactive shell sends SIGHUP twice within a millisecond (the
 * shell's hangup of its jobs, then the kernel's to the old foreground group once the session
 * leader exits; r5 #1), and a supervisor may signal both the process and its group.
 *
 * SIGINT during the front end's final close ({@link ExitSignals.closing}: after `/quit` or the
 * end of a headless run the front end's own Ctrl+C handling is gone, r5 #6) is handled like
 * SIGTERM again: the close the front end started finishes (bounded by the grace), then
 * kiro-claude dies of SIGINT; a second press re-raises at once.
 *
 * A record left anyway (the grace ran out, SIGKILL, a crash) is skipped by the session index
 * (store.ts `list`). Not used on Windows (no POSIX re-raise).
 *
 * A hung-up terminal also fails reads and writes (EIO): the line reader takes an input error for
 * end of input (repl/input.ts) and cli/main.ts ignores EIO on stdout / stderr, so neither crashes
 * kiro-claude before the close (r5 #1). That end of input reaches the REPL a moment before Node
 * dispatches the hangup's SIGHUP, so the REPL waits for it ({@link ExitSignals.awaitSignal},
 * bounded by {@link DUPLICATE_SIGNAL_WINDOW_MS}) instead of quitting first (r6 #3).
 */

import * as os from 'node:os';
import { performance } from 'node:perf_hooks';

/**
 * How long a SIGHUP / SIGTERM (or a SIGINT while the session starts or during the final close)
 * waits for the close before the signal is re-raised anyway.
 */
export const SIGNAL_CLOSE_GRACE_MS = 2000;
/**
 * A repeat of the first signal this soon after it is a duplicate of it (see the module doc): it
 * does not cut the close short. Later, it does.
 */
export const DUPLICATE_SIGNAL_WINDOW_MS = 500;
/** After the re-raise: exit with the signal's status if the process is somehow still alive. */
const SIGNAL_EXIT_FALLBACK_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

/** See the module doc. */
export class ExitSignals {
  /** The first signal received. */
  received: NodeJS.Signals | undefined;
  /** When {@link received} came in (`performance.now()`). */
  private receivedAt = 0;
  private readonly startAbort = new AbortController();
  private readonly listeners = new Map<NodeJS.Signals, () => void>();
  private started = false;
  private reraised = false;
  private disposed = false;
  private grace: NodeJS.Timeout | undefined;
  private dying: Promise<never> | undefined;
  /** The {@link awaitSignal} calls still waiting. */
  private readonly waiters = new Set<() => void>();

  constructor(
    /** Close everything the front end opened (a session still being created is its own business). */
    private readonly close: () => Promise<void>,
    /** stdin / stdout / stderr: a hung-up terminal fails their reads and writes (EIO). */
    private readonly streams: readonly unknown[],
  ) {
    for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
      const l = (): void => this.onSignal(sig);
      this.listeners.set(sig, l);
      process.on(sig, l);
    }
  }

  /** Aborted when a signal comes in: the start signal of every session created from now on. */
  get startSignal(): AbortSignal {
    return this.startAbort.signal;
  }

  /** The session is up: SIGINT is the front end's from now on; a signal closes what it opened. */
  ready(): void {
    this.started = true;
    this.off('SIGINT');
  }

  /**
   * The front end's final close begins and its own SIGINT handling is gone: a SIGINT now closes
   * (bounded by the grace) and then re-raises, like SIGTERM (module doc, r5 #6). Removed again by
   * {@link dispose}; nothing is re-armed once disposed.
   */
  closing(): void {
    if (this.disposed || this.reraised || this.listeners.has('SIGINT')) return;
    const l = (): void => this.onSignal('SIGINT');
    this.listeners.set('SIGINT', l);
    process.on('SIGINT', l);
  }

  /** Remove the listeners (the run ended). */
  dispose(): void {
    this.disposed = true;
    for (const sig of [...this.listeners.keys()]) this.off(sig);
    if (this.grace) clearTimeout(this.grace);
    this.grace = undefined;
    this.wake();
  }

  /**
   * Resolves at the first signal, at once when one was already received or the listeners are
   * gone ({@link dispose}), else after `ms`. Its timer keeps the event loop alive meanwhile, so a
   * signal that is on its way is still dispatched to these listeners. A hung-up terminal ends the
   * input (EOF / EIO) a moment before Node dispatches the SIGHUP that comes with it: the front end
   * waits here before it takes that end of input for a quit (repl/core.ts, r6 #3).
   */
  awaitSignal(ms: number): Promise<void> {
    if (this.received || this.disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  /**
   * Close (bounded), then re-raise the signal received. Never resolves: the signal ends the
   * process. The front end awaits it wherever it would otherwise go on (print, return a status).
   */
  die(): Promise<never> {
    this.dying ??= (async () => {
      await withTimeout(this.close().catch(() => undefined), SIGNAL_CLOSE_GRACE_MS);
      this.reraise();
      return new Promise<never>(() => undefined);
    })();
    return this.dying;
  }

  private onSignal(sig: NodeJS.Signals): void {
    if (this.received) {
      // the same event delivered twice (a closing tab's SIGHUPs): keep closing
      if (sig === this.received && performance.now() - this.receivedAt < DUPLICATE_SIGNAL_WINDOW_MS) return;
      this.reraise(); // a second signal: stop waiting
      return;
    }
    this.received = sig;
    this.receivedAt = performance.now();
    const noop = (): void => undefined;
    for (const st of this.streams) (st as { on?: (e: string, f: () => void) => void } | undefined)?.on?.('error', noop);
    this.startAbort.abort();
    this.grace = setTimeout(() => this.reraise(), SIGNAL_CLOSE_GRACE_MS);
    this.wake();
    // while the first session is created, the front end calls die() once its creation settles
    if (this.started) void this.die();
  }

  private off(sig: NodeJS.Signals): void {
    const l = this.listeners.get(sig);
    if (l) process.off(sig, l);
    this.listeners.delete(sig);
  }

  private reraise(): void {
    const sig = this.received;
    if (this.reraised || !sig) return;
    this.reraised = true;
    this.dispose();
    // claude/lifecycle.ts's forwarder (while children are tracked) or the default disposition ends
    // the process; should anything else swallow the signal, exit with its status
    setTimeout(() => process.exit(128 + (os.constants.signals[sig] ?? 15)), SIGNAL_EXIT_FALLBACK_MS);
    process.kill(process.pid, sig);
  }
}

/**
 * One signal aborted when any of `signals` is (AbortSignal.any needs Node 20.3); `dispose()`
 * removes the listeners. undefined when none is given; the signal itself when only one is.
 */
export function anySignal(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal | undefined; dispose(): void } {
  const list = [...new Set(signals.filter((s): s is AbortSignal => s !== undefined))];
  if (list.length <= 1) return { signal: list[0], dispose: () => undefined };
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  for (const s of list) {
    if (s.aborted) {
      ac.abort();
      break;
    }
  }
  if (!ac.signal.aborted) for (const s of list) s.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ac.signal,
    dispose: () => {
      for (const s of list) s.removeEventListener('abort', onAbort);
    },
  };
}
