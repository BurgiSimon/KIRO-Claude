/**
 * Cancelling the start of a session its creator is waiting for (K3).
 *
 * A session's start runs its SessionStart (agentSpawn) hooks before Claude Code is spawned. A
 * hook can take long (V2 default timeout 30 s, V3 60 s, 0 = never), and while it runs the
 * session does not exist yet for its creator (`createSession` / `importSessionExport` resolve
 * only once it started), so its `interrupt()` cannot be called. The creator cancels it with a
 * start signal instead:
 *
 *  - explicitly: `KiroSessionInternalOptions.startSignal` (session/kiroSession.ts);
 *  - or for every session created inside `fn`: {@link withStartSignal}. The REPL's `/chat new`,
 *    `/chat resume` and `/chat load` (repl/commands/chat.ts `activate`) pass their command signal
 *    (aborted by Ctrl+C) this way, through the REPL's own `createSession` / `importSession`, which
 *    take no signal of their own.
 *
 * When the signal aborts before the session's agentSpawn hooks are done, the hook commands still
 * running are killed (with their process groups), Claude Code is never spawned, the creation
 * rejects with {@link SessionStartCancelledError} and nothing of the session stays behind (a
 * record the creation made is removed, the lock is released). Once the hooks are done the start
 * goes on: the spawn of Claude Code cannot stop half way and ends within its initialize timeout
 * (the REPL treats a press then as no failure, F0).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const ambient = new AsyncLocalStorage<AbortSignal>();

/**
 * Run `fn` with `signal` as the start signal of the sessions it creates (see the module doc).
 * Only `fn`'s own asynchronous work sees it; without a signal `fn` just runs.
 */
export function withStartSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  return signal ? ambient.run(signal, fn) : fn();
}

/** The start signal set by an enclosing {@link withStartSignal} (undefined outside one). */
export function currentStartSignal(): AbortSignal | undefined {
  return ambient.getStore();
}

/**
 * Run `fn` outside any {@link withStartSignal}: a session reads its start signal once and creates
 * its child process, timers and listeners in here, so none of them carries the signal on (where a
 * session created later from one of their callbacks would take it as its own).
 */
export function outsideStartSignal<T>(fn: () => T): T {
  return ambient.exit(fn);
}

/**
 * A session's start, `/clear` or `/agent swap` was cancelled (start signal, `interrupt()`,
 * `close()`) while its agentSpawn hooks ran; nothing was changed.
 */
export class SessionStartCancelledError extends Error {
  readonly cancelled = true;
  constructor(message = 'The session start was cancelled while its agentSpawn hooks ran.') {
    super(message);
    this.name = 'SessionStartCancelledError';
  }
}

/** `e` is a {@link SessionStartCancelledError} (also one from another copy of this module). */
export function isSessionStartCancelled(e: unknown): e is SessionStartCancelledError {
  return e instanceof SessionStartCancelledError || (e instanceof Error && e.name === 'SessionStartCancelledError');
}
