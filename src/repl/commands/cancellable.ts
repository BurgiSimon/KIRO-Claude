/**
 * Waiting on Claude Code's answer to a control request (`get_context_usage`, `mcp_status`,
 * `set_model`) from a slash command, cancellable by Ctrl+C (K9).
 *
 * Such a request goes to the idle main session, whose {@link KiroSession.busy} does not count a
 * pending control request: a wedged or very slow Claude Code would hold `/usage`, `/mcp`, `/tools`
 * or `/model` for the control-request timeout (60 s) with Ctrl+C swallowed, because the forced
 * stop never closes an idle session (F0) and the first press's interrupt is a no-op on it. So the
 * command races the session call against its {@link ReplContext.commandSignal}, which every press
 * aborts: the command ends at once and Claude Code keeps running. The answer that comes later
 * settles the dropped promise only (a rejection, e.g. the request's timeout, is handled), so
 * nothing of it reaches later output.
 */

import type { KiroSession } from '../../types.js';
import { c } from '../../util/ansi.js';
import type { ReplContext } from '../types.js';

/** What {@link untilCancelled} resolves with when the command signal aborted first. */
export const CANCELLED: unique symbol = Symbol('cancelled');

/**
 * `start()`'s value, or {@link CANCELLED} as soon as `signal` aborts (without calling `start` when
 * it has already aborted). A rejection of `start()` before the abort is passed on; after it, it is
 * dropped.
 */
export function untilCancelled<T>(signal: AbortSignal | undefined, start: () => Promise<T>): Promise<T | typeof CANCELLED> {
  if (signal?.aborted) return Promise.resolve(CANCELLED);
  const p = start();
  if (!signal) return p;
  return new Promise<T | typeof CANCELLED>((resolve, reject) => {
    const onAbort = (): void => resolve(CANCELLED);
    signal.addEventListener('abort', onAbort, { once: true });
    // both handlers attached: a late rejection never becomes an unhandled one
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** {@link untilCancelled} for a call on the active session, with the command's signal. */
export function sessionCall<T>(r: ReplContext, call: (s: KiroSession) => Promise<T>): Promise<T | typeof CANCELLED> {
  const s = r.session;
  return untilCancelled(r.commandSignal, () => call(s));
}

/** The line a command cancelled while waiting on Claude Code prints (like `/hooks run`'s). */
export function cancelledLine(what: string): string {
  return `\n${c.gray(`${what} was cancelled.`)}\n\n`;
}
