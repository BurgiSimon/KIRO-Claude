/**
 * Dying of a fatal signal after closing the session(s), for both front ends: the interactive chat
 * (repl/core.ts) and `chat --no-interactive` (headless/run.ts).
 *
 * SIGHUP / SIGTERM during the whole run (a closed terminal tab, `kill`), and SIGINT while the
 * session starts (Claude Code initializing, agentSpawn hooks), during the final close (below)
 * and from the first SIGHUP / SIGTERM on (a SIGINT after one is a second signal, below); else
 * Ctrl+C belongs to the front end: the REPL's line reader, the headless interrupt handler.
 * Without this, claude/lifecycle.ts's forwarder kills kiro-claude before any session's close(),
 * which drops a chat that never had a message (Q saves a conversation only after a reply, r4
 * #4), saves the record and releases its lock, and runs SessionEnd hooks. Here the front end's
 * `close` callback closes what it opened (a start still running is cancelled through
 * {@link ExitSignals.startSignal}, startSignal.ts: agentSpawn hooks are killed and nothing of it
 * stays), then the signal is re-raised with these listeners removed, so kiro-claude still dies of
 * it (the forwarder ends any child left). The wait is bounded by {@link SIGNAL_CLOSE_GRACE_MS}
 * from the signal; a second signal re-raises at once: one more than
 * {@link DUPLICATE_SIGNAL_WINDOW_MS} after the first, or a different one inside it (a SIGINT
 * after a SIGHUP / SIGTERM, or one of them after a SIGINT). A repeat inside that window is the
 * same event delivered twice, not an impatient user: a terminal tab closing under an interactive
 * shell sends SIGHUP twice within a millisecond (the shell's hangup of its jobs, then the
 * kernel's to the old foreground group once the session leader exits; r5 #1), and a supervisor
 * may signal both the process and its group. So are a SIGHUP and a SIGTERM inside it, either
 * way round: closing the terminal of an interactive bash while kiro-claude is stopped (Ctrl+Z)
 * sends SIGHUP + SIGCONT (its hangup of the jobs), then SIGTERM + SIGCONT (its exit's termination
 * of stopped jobs) within microseconds, and a supervisor may send both.
 *
 * A SIGINT after a SIGHUP / SIGTERM is such a second signal also in the front end's main phase
 * (after {@link ExitSignals.ready}, r8 #6): from the first SIGHUP / SIGTERM on SIGINT is held
 * here again. The front end's own SIGINT listener, still installed there, runs first and does
 * nothing visible (both front ends are silent from the signal on): the REPL's ends its muted read
 * (its loop then awaits {@link ExitSignals.die}) or interrupts the turn being closed, headless's
 * interrupts a session that is already closing. In the interactive chat's terminal (raw mode from
 * its first prompt on) Ctrl+C is a key, which the muted reader drops, not a SIGINT; `kill -INT`
 * is one, and so is a Ctrl+C where the terminal is in cooked mode (headless, a chat whose input
 * is piped, a chat still starting, a `!cmd` or `$EDITOR` holding the terminal: they run in
 * kiro-claude's process group).
 *
 * SIGINT during the front end's final close ({@link ExitSignals.closing}: after `/quit` or the
 * end of a headless run the front end's own Ctrl+C handling is gone, r5 #6) is handled like
 * SIGTERM again: the close the front end started finishes (bounded by the grace), then
 * kiro-claude dies of SIGINT. A second press re-raises at once once the window has passed (one
 * inside it is the same press forwarded: an `npm` / `npx` wrapper), and so does a SIGHUP /
 * SIGTERM at any time.
 *
 * While the chat has handed the terminal to a child program ({@link ExitSignals.childOwnsTerminal},
 * r10 #0) SIGTTOU is caught too: a child in kiro-claude's process group that changes the terminal
 * mode from the background (vim or a `stty` trap at the SIGTERM of `kill %1`, after Ctrl+Z) makes
 * the kernel stop the whole group, kiro-claude included, before its close could run. After a fatal
 * signal that stop is dropped; otherwise kiro-claude stops itself as before. Meanwhile kiro-claude
 * changes no terminal mode and holds its own terminal output ({@link holdTerminalOutput}, which
 * the REPL also uses while it starts in the background, r10 #1), because a caught SIGTTOU makes
 * such a call of its own from the background restart forever. SIGTTIN is never caught: when the
 * REPL needs the terminal and is in the background (its hand-back after the child included, with
 * this guard still up) it stops itself with SIGTTIN at its default action (repl/input.ts
 * stopForTerminal, r11 #1/#2; SIGTSTP after a stop that came back at once, never caught either).
 *
 * A chat that never had a message and is left anyway (the grace ran out, a second signal, SIGKILL,
 * a crash) is dropped by the session index (store.ts `list`); any other record left stays listed,
 * and its stale lock is taken over when it is opened again. Not used on Windows (no POSIX
 * re-raise).
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
 * A repeat of the first signal this soon after it is a duplicate of it, and so is a SIGTERM after
 * a SIGHUP or the other way round (see the module doc): it does not cut the close short. Later, it
 * does.
 */
export const DUPLICATE_SIGNAL_WINDOW_MS = 500;
/** `b` right after `a` is the same event (see {@link DUPLICATE_SIGNAL_WINDOW_MS}). */
function sameEvent(b: NodeJS.Signals, a: NodeJS.Signals): boolean {
  const hangupOrTerm = (s: NodeJS.Signals): boolean => s === 'SIGHUP' || s === 'SIGTERM';
  return b === a || (hangupOrTerm(a) && hangupOrTerm(b));
}

/** After the re-raise: exit with the signal's status if the process is somehow still alive. */
const SIGNAL_EXIT_FALLBACK_MS = 5000;
/** At most this much output is held ({@link holdTerminalOutput}); more is dropped. */
const HELD_OUTPUT_MAX = 1 << 20;

/** The callback among a `write()` call's arguments (`write(chunk, cb)`, `write(chunk, encoding, cb)`). */
function writeCallback(args: readonly unknown[]): (() => void) | undefined {
  const cb = args.find((a, i) => i > 0 && typeof a === 'function');
  return cb as (() => void) | undefined;
}

/**
 * Hold what is written to those of `outputs` that are terminals (`isTTY`; a pipe is never held)
 * until the returned `release`: `release(true)` writes it in order, `release(false)` drops it
 * (write callbacks still called), and beyond {@link HELD_OUTPUT_MAX} writes are dropped. With
 * `hold`, a write is held only while `hold(stream)` says so, and one that is not held first writes
 * what was held, in order. The streams get their own `write` back at the release (an own property
 * as such, a prototype one by removing the stand-in). Used while a child owns the terminal
 * ({@link ExitSignals.childOwnsTerminal}, r10 #0: everything) and while the chat starts
 * (repl/core.ts, r10 #1: what it would write from the background, where a write with `stty
 * tostop` stopped it, SIGTTOU, and its SIGTERM listener then never ran).
 */
export function holdTerminalOutput(outputs: readonly unknown[], hold: (stream: unknown) => boolean = () => true): (flush: boolean) => void {
  const held: { write: (...a: unknown[]) => unknown; args: unknown[] }[] = [];
  let heldBytes = 0;
  const flushHeld = (): void => {
    heldBytes = 0;
    for (const h of held.splice(0)) {
      try {
        h.write(...h.args);
      } catch {
        // a hung-up terminal: nothing more reaches it
      }
    }
  };
  const restores: (() => void)[] = [];
  for (const o of new Set(outputs)) {
    const s = o as { isTTY?: unknown; write?: unknown } | null | undefined;
    if (!s || s.isTTY !== true || typeof s.write !== 'function') continue;
    const own = Object.prototype.hasOwnProperty.call(s, 'write');
    const write = s.write as (...a: unknown[]) => unknown;
    s.write = (...args: unknown[]): unknown => {
      if (!hold(s)) {
        flushHeld();
        return write.apply(s, args);
      }
      const chunk = args[0];
      const n = typeof chunk === 'string' || chunk instanceof Uint8Array ? chunk.length : 0;
      if (heldBytes + n <= HELD_OUTPUT_MAX) {
        heldBytes += n;
        held.push({ write: (...a) => write.apply(s, a), args });
      } else {
        const cb = writeCallback(args);
        if (cb) process.nextTick(cb);
      }
      return true;
    };
    restores.push(() => {
      if (own) s.write = write;
      else delete s.write;
    });
  }
  let live = true;
  return (flush: boolean): void => {
    if (!live) return;
    live = false;
    for (const r of restores) r();
    if (flush) {
      flushHeld();
      return;
    }
    for (const h of held.splice(0)) {
      const cb = writeCallback(h.args);
      if (cb) process.nextTick(cb);
    }
  };
}

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
  /** Releases the guard while a child owns the terminal ({@link childOwnsTerminal}). */
  private releaseChild: ((flush: boolean) => void) | undefined;

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

  /**
   * The session is up: SIGINT is the front end's from now on (until a SIGHUP / SIGTERM or the
   * final close, module doc); a signal closes what it opened.
   */
  ready(): void {
    this.started = true;
    // (a signal already received keeps SIGINT here: the front ends check it before this call)
    if (!this.received) this.off('SIGINT');
  }

  /**
   * The front end's final close begins and its own SIGINT handling is gone: a SIGINT now closes
   * (bounded by the grace) and then re-raises, like SIGTERM (module doc, r5 #6). Removed again by
   * {@link dispose}; nothing is re-armed once disposed.
   */
  closing(): void {
    this.holdSigint();
  }

  /**
   * SIGINT is handled here again ({@link closing}, and from the first SIGHUP / SIGTERM on: then a
   * SIGINT is a second signal, module doc, r8 #6); one listener at most, none once disposed.
   * Appended: a front end's own SIGINT listener, still there in its main phase, runs first.
   */
  private holdSigint(): void {
    if (this.disposed || this.reraised || this.listeners.has('SIGINT')) return;
    const l = (): void => this.onSignal('SIGINT');
    this.listeners.set('SIGINT', l);
    process.on('SIGINT', l);
  }

  /**
   * A child program gets the terminal (`$EDITOR`, `!cmd`: repl/core.ts openEditor / runBang, from
   * the reader's suspend() until handBack, r10 #0). It runs in kiro-claude's process group, so a
   * terminal mode change it makes from the background (`kill %1` of the job stopped with Ctrl+Z:
   * vim's deadly-signal path, a trap running `stty`; vim after `bg`) makes the kernel send SIGTTOU
   * to the whole group, and at its default action that stopped kiro-claude too, before (or during)
   * the close of the SIGTERM that came with the continue: the chat stayed stopped with its lock
   * until `fg`. Until the returned `release` (or {@link dispose}) SIGTTOU is caught here: once a
   * fatal signal is in it is dropped, so the close runs and the signal is re-raised; otherwise
   * kiro-claude stops itself two event-loop turns later (a fatal signal that came with the same
   * continue is dispatched first) as the default action did, but with SIGTSTP, so the listener
   * stays for the next continue (bash then reports 'Stopped' rather than 'Stopped (tty output)').
   *
   * A caught SIGTTOU is a hazard of its own: a terminal mode change (tcsetattr) or a write with
   * `stty tostop` that kiro-claude itself makes from the background gets SIGTTOU, the handler runs,
   * the call restarts (SA_RESTART) and gets it again, forever (100% CPU, no JS runs; r10 #0
   * verification). So while the guard is up kiro-claude must make no mode change (the caller's
   * reader is suspended and takes the terminal back only after `release`), and what is written to
   * `outputs` that are terminals (stdout, stderr; console and Node's own warnings included) is held:
   * `release(true)` (in the foreground) writes it in order, `release(false)` and {@link dispose}
   * drop it (callbacks still called), and beyond {@link HELD_OUTPUT_MAX} writes are dropped
   * ({@link holdTerminalOutput}). The listener
   * is removed at the release, by {@link dispose} (the re-raise, before any exit: Node's exit
   * restores the terminal mode through libuv's descriptor with SIGTTOU unblocked), and at an exit
   * or an uncaught exception (whose report is written to stderr). One guard at a time; none once
   * disposed (a no-op release is returned).
   */
  childOwnsTerminal(outputs: readonly unknown[]): (flush: boolean) => void {
    if (this.disposed || this.reraised || this.releaseChild || process.platform === 'win32') return () => undefined;
    const releaseOutput = holdTerminalOutput(outputs);
    let live = true;
    let deciding = false;
    const onTtou = (): void => {
      if (deciding) return;
      deciding = true;
      setImmediate(() =>
        setImmediate(() => {
          deciding = false;
          if (!live || this.received) return;
          try {
            process.kill(process.pid, 'SIGTSTP');
          } catch {
            // ignore
          }
        }),
      );
    };
    const release = (flush: boolean): void => {
      if (!live) return;
      live = false;
      if (this.releaseChild === release) this.releaseChild = undefined;
      process.removeListener('SIGTTOU', onTtou);
      process.removeListener('exit', onEnd);
      process.removeListener('uncaughtExceptionMonitor', onEnd);
      releaseOutput(flush);
    };
    const onEnd = (): void => release(false);
    process.on('SIGTTOU', onTtou);
    process.on('exit', onEnd);
    process.on('uncaughtExceptionMonitor', onEnd);
    this.releaseChild = release;
    return release;
  }

  /** Remove the listeners (the run ended). */
  dispose(): void {
    this.releaseChild?.(false);
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
      // the same event delivered twice (a closing tab's SIGHUPs, bash's SIGHUP then SIGTERM to a
      // stopped job): keep closing
      if (sameEvent(sig, this.received) && performance.now() - this.receivedAt < DUPLICATE_SIGNAL_WINDOW_MS) return;
      this.reraise(); // a second signal: stop waiting
      return;
    }
    this.received = sig;
    this.receivedAt = performance.now();
    // a SIGHUP / SIGTERM in the main phase: a SIGINT from now on is a second signal (r8 #6)
    this.holdSigint();
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
