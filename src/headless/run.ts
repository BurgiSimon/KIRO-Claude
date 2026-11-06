/**
 * `chat --no-interactive` runner (01 §3, 00 §2.3 "Headless", 00 §2.5 "Headless output").
 *
 * Input (01 §3, Q `cli/chat/mod.rs:261-279`): when `input` is empty, stdin is read — but only
 * when stdin is not a TTY; the text is trimmed; still empty ⇒
 * `error: Input must be supplied when running in non-interactive mode`, exit 1. (Callers pass
 * the INPUT positional, or '' when it was absent; an explicitly empty INPUT therefore also
 * falls back to piped stdin — a harmless deviation from Q, which errors at once.)
 *
 * Local commands (`/usage`, `/tools`, …) are answered without a model turn (headless/local.ts);
 * `/usage` does not even create a session (08 KC-CLI-07).
 *
 * The session is created with `interactive: false` and a {@link SessionUI} that never asks: the
 * gate denies tools that need approval with Kiro V3's text (00 §8 C10) and the run continues;
 * should a request reach the UI anyway it is denied with the same text. Stop-hook confirm
 * pickers are dismissed.
 *
 * Output: headless/render.ts (text: assistant text on stdout, tool lines / warnings / hook
 * output on stderr; `stream-json`: normalized JSON lines on stdout).
 *
 * `--require-mcp-startup` (01 §3): after the session started, poll its MCP status until no
 * server is pending (≤ `mcp.noInteractiveTimeout`, default 30 s); any failed / needs-auth /
 * unknown status or the timeout ⇒ exit 3.
 *
 * Exit codes (00 §2.1): 0 success; 1 failure (start failure, `TurnResult.isError`, closed
 * stdout); 3 MCP startup; 130 interrupted (Ctrl+C). Authentication failures print
 * `You are not logged in, please log in with <prog> login` (00 §2.1, Q `cli/mod.rs:145-150`).
 * Ctrl+C interrupts the turn (first press) or closes the session (second press).
 */

import type { CliContext, KiroSession, SessionEvent, SessionUI, TurnResult } from '../types.js';
import { isAuthError } from '../claude/auth.js';
import { loadCreateSession, type CreateSessionFn, type FrontEndSessionOptions } from '../cli/entries.js';
import { readAll } from '../cli/io.js';
import { classifyHeadlessInput, expandSkillForSession } from './local.js';
import { JsonRenderer, TextRenderer, type HeadlessRenderer } from './render.js';

/** Text of a denied approval in non-interactive mode (Kiro V3, 00 §8 C10). */
export const HEADLESS_DENIAL =
  '[denied] tool permission approval is not supported in non-interactive mode. Use --trust-all-tools to auto-approve.';

export const NO_INPUT_ERROR = 'error: Input must be supplied when running in non-interactive mode';

export interface RunHeadlessOptions {
  ctx: CliContext;
  sessionOptions: FrontEndSessionOptions;
  input: string;
  outputFormat?: 'text' | 'stream-json';
  requireMcpStartup?: boolean;
  /** Session factory (default: session/kiroSession `createSession`). For tests and embedding. */
  createSession?: CreateSessionFn;
  /** Limit for `requireMcpStartup` (default setting `mcp.noInteractiveTimeout`, else 30 000 ms). */
  mcpStartupTimeoutMs?: number;
  /** Poll interval for `requireMcpStartup` (default 250 ms). */
  mcpPollMs?: number;
}

/** Message for an authentication failure (00 §2.1). */
export function notLoggedInMessage(progName: string): string {
  return `You are not logged in, please log in with ${progName} login`;
}

/** Read the task from stdin per 01 §3: only when stdin is not a TTY (and not already consumed). */
export async function readHeadlessStdin(stdin: NodeJS.ReadableStream & { isTTY?: boolean; readableEnded?: boolean; destroyed?: boolean }): Promise<string> {
  if (stdin.isTTY) return '';
  // `chat` reads piped stdin itself (cli/commands/chat.ts); an ended stream never emits 'end' again
  if (stdin.readableEnded || stdin.destroyed) return '';
  try {
    return await readAll(stdin);
  } catch {
    return '';
  }
}

const OK_MCP = new Set(['connected', 'running', 'ready', 'disabled']);
const PENDING_MCP = new Set(['pending', 'loading', 'starting', 'connecting']);

/** Wait for MCP servers (see module doc). Resolves with an error message, or undefined when all started. */
export async function waitForMcpStartup(session: KiroSession, timeoutMs: number, pollMs = 250): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let entries;
    try {
      entries = await session.mcpStatus();
    } catch (e) {
      return `error: could not read MCP server status: ${e instanceof Error ? e.message : String(e)}`;
    }
    const pending: string[] = [];
    for (const s of entries) {
      const st = s.status.toLowerCase();
      if (OK_MCP.has(st)) continue;
      if (PENDING_MCP.has(st)) {
        pending.push(s.name);
        continue;
      }
      if (st === 'needs-auth') return `error: MCP server '${s.name}' needs authentication`;
      return `error: MCP server '${s.name}' failed to start${s.error ? `: ${s.error}` : ` (status: ${s.status})`}`;
    }
    if (pending.length === 0) return undefined;
    if (Date.now() >= deadline) {
      return `error: MCP server${pending.length > 1 ? 's' : ''} ${pending.map((n) => `'${n}'`).join(', ')} did not start within ${Math.round(timeoutMs / 1000)} s`;
    }
    await new Promise((r) => setTimeout(r, Math.max(10, Math.min(pollMs, deadline - Date.now()))));
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run one non-interactive task (see module doc). */
export async function runHeadless(opts: RunHeadlessOptions): Promise<number> {
  const { ctx } = opts;
  const json = opts.outputFormat === 'stream-json';
  const renderer: HeadlessRenderer = json ? new JsonRenderer(ctx.stdout) : new TextRenderer(ctx.stdout, ctx.stderr);
  const fatal = (message: string): void => {
    renderer.error(message);
    if (json) ctx.stderr.write(`${message}\n`);
  };

  let input = opts.input;
  if (input.trim() === '') input = await readHeadlessStdin(ctx.stdin);
  input = input.trim();
  if (input === '') {
    fatal(NO_INPUT_ERROR);
    return 1;
  }

  const action = classifyHeadlessInput(input, ctx.ws, ctx.settings);
  if (action.kind === 'output') {
    renderer.local(action.command, action.text);
    renderer.finish();
    return 0;
  }
  if (action.kind === 'quit') {
    renderer.localDone(action.command);
    renderer.finish();
    return 0;
  }
  if (action.kind === 'error') {
    fatal(action.message);
    if (action.command) renderer.localFailed(action.command, action.message);
    return action.exitCode;
  }

  // A local command that needs a session (`/tools`, `/compact`, …) ends with a `result` line
  // even when the session or its MCP servers fail (stream-json; see headless/render.ts).
  const localCommand = action.kind === 'session-local' ? action.command : action.kind === 'compact' ? '/compact' : undefined;

  const ui: SessionUI = {
    requestApproval: async () => ({ kind: 'deny', message: HEADLESS_DENIAL }),
    notice: (level, message) => renderer.notice(level, message),
    confirmStopHook: async () => undefined,
  };

  let session: KiroSession | undefined;
  try {
    const create = opts.createSession ?? (await loadCreateSession());
    session = await create({ ...opts.sessionOptions, ws: ctx.ws, ui, interactive: false, origin: 'headless' });
    await session.start();
  } catch (e) {
    const msg = errText(e);
    // Session errors may carry their exit code (agent not found ⇒ 4, 01 §3).
    const code = typeof (e as { exitCode?: unknown }).exitCode === 'number' ? ((e as { exitCode: number }).exitCode) : 1;
    const message =
      isAuthError(msg) || /not logged in/i.test(msg)
        ? notLoggedInMessage(ctx.progName)
        : /^(error|Error)[: ]|^Failed to start session/.test(msg)
          ? msg
          : `error: ${msg}`;
    fatal(message);
    if (code === 4) fatal('stopping (exit 4)');
    if (localCommand) renderer.localFailed(localCommand, message);
    if (session) await session.close().catch(() => undefined);
    return code;
  }

  // Ctrl+C: first ⇒ interrupt the turn, second ⇒ close the session. Closed stdout ⇒ interrupt.
  // Closed stderr (tool lines, notices) ⇒ only diagnostics are lost: the turn goes on and its
  // answer still reaches stdout; the listener keeps a broken pipe from becoming an uncaught
  // error that would skip closing the session.
  let interrupted = false;
  let stdoutBroken = false;
  const s = session;
  const onSigint = (): void => {
    if (!interrupted) {
      interrupted = true;
      void s.interrupt().catch(() => undefined);
    } else {
      void s.close().catch(() => undefined);
    }
  };
  const onStdoutError = (e: NodeJS.ErrnoException): void => {
    if (stdoutBroken) return;
    stdoutBroken = true;
    if (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED') void s.interrupt().catch(() => undefined);
  };
  const onStderrError = (): void => undefined;
  process.on('SIGINT', onSigint);
  const stdoutEmitter = ctx.stdout as unknown as NodeJS.EventEmitter;
  if (typeof stdoutEmitter.on === 'function') stdoutEmitter.on('error', onStdoutError);
  const stderrEmitter = ctx.stderr as unknown as NodeJS.EventEmitter;
  if (typeof stderrEmitter.on === 'function') stderrEmitter.on('error', onStderrError);

  try {
    renderer.session({
      sessionId: s.id,
      agent: s.agent.name,
      model: s.model,
      ...(s.claudeSessionId ? { claudeSessionId: s.claudeSessionId } : {}),
    });

    if (opts.requireMcpStartup) {
      const timeout = opts.mcpStartupTimeoutMs ?? ctx.settings.getNumber('mcp.noInteractiveTimeout', 30_000);
      const problem = await waitForMcpStartup(s, timeout, opts.mcpPollMs);
      if (problem) {
        fatal(problem);
        if (localCommand) renderer.localFailed(localCommand, problem);
        return 3;
      }
    }

    if (action.kind === 'session-local') {
      let text: string;
      try {
        text = await action.run(s);
      } catch (e) {
        const message = `error: ${action.command}: ${errText(e)}`;
        fatal(message);
        renderer.localFailed(action.command, message);
        return 1;
      }
      renderer.local(action.command, text);
      return 0;
    }

    let gen: AsyncGenerator<SessionEvent, TurnResult>;
    if (action.kind === 'compact') {
      gen = s.compact(action.instructions);
    } else {
      let text = action.text;
      if (action.skill) text = expandSkillForSession(s, ctx.ws, action.skill.name, action.skill.rawArgs) ?? text;
      gen = s.prompt({ text });
    }

    let result: TurnResult;
    try {
      let step = await gen.next();
      while (!step.done) {
        renderer.event(step.value);
        step = await gen.next();
      }
      result = step.value;
    } catch (e) {
      const msg = errText(e);
      const message = isAuthError(msg) ? notLoggedInMessage(ctx.progName) : `error: ${msg}`;
      fatal(message);
      if (localCommand) renderer.localFailed(localCommand, message);
      return 1;
    }

    renderer.result(result, { sessionId: s.id });
    if (stdoutBroken) return 1;
    if (result.stopReason === 'cancelled' || (interrupted && result.isError)) {
      renderer.interrupted({ sessionId: s.id });
      return 130;
    }
    if (result.isError) {
      if (result.authError || isAuthError(result.error ?? '') || isAuthError(result.text)) fatal(notLoggedInMessage(ctx.progName));
      else fatal(`error: ${result.error || result.text || 'the request failed'}`);
      return 1;
    }
    return 0;
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (typeof stdoutEmitter.removeListener === 'function') stdoutEmitter.removeListener('error', onStdoutError);
    renderer.finish();
    await s.close().catch(() => undefined);
    // after close: SessionEnd hook warnings are written to stderr too
    if (typeof stderrEmitter.removeListener === 'function') stderrEmitter.removeListener('error', onStderrError);
  }
}
