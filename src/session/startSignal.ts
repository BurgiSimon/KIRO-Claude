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
 *  - or for every session created inside `fn`: {@link withStartSignal} (the session reads it once,
 *    when it is created). The sources, by module:
 *     - repl/core.ts `Repl.opening()`: every session the REPL creates (the chat, `/chat
 *       new|resume|load`, the spec runtime's sessions, the forced-stop restart) starts under the
 *       caller's start signal combined with the fatal-signal one, `ExitSignals.startSignal`
 *       (repl/exitSignals.ts: SIGHUP / SIGTERM, or SIGINT while the chat starts or during its
 *       final close), so a signal cancels a start that is still running its agentSpawn hooks.
 *     - repl/core.ts `submit()`: the restart after a forced stop (second Ctrl+C) runs under a
 *       press signal of its own; a Ctrl+C while the restarted session runs its agentSpawn hooks
 *       cancels the restart (r5 P2).
 *     - repl/commands/chat.ts `activate`: `/chat new`, `/chat resume` and `/chat load` pass their
 *       command signal (aborted by Ctrl+C).
 *     - spec/workflow.ts: the REPL spec runtime's phase sessions and continuation
 *       (`createUnderPress`) start under the command's Ctrl+C signal or, once a press has aborted
 *       it, under the next press (ReplContext.nextPressSignal, r5 P1); a task session of `/spec
 *       run` or `kiro-claude spec run` (`executeTask`) under the run's Ctrl+C signal.
 *     - headless/run.ts: the `chat --no-interactive` session under `ExitSignals.startSignal`.
 *     - acp/server.ts `createUnderStop`: `session/new`, `session/load` and the restart after a
 *       stuck cancel, under the server's stop signal (stdin EOF, a signal) and, for a request, its
 *       own `$/cancel_request` or the connection closing.
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
