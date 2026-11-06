/**
 * Fixed entry points of the other Wave-2 modules (task RULES), loaded lazily.
 *
 * Lazy loading keeps the probe fast paths (`--version`, `chat --help`, `update`,
 * `chat --list-models`, `/usage`) free of the session engine (08 KC-BIN-05: cold start
 * < 300 ms, never spawn `claude`). The specifiers are computed strings, so the TypeScript build
 * of the CLI does not depend on modules that are developed separately; the types below restate
 * the binding signatures from the task RULES.
 */

import type { CliContext, KiroSession, KiroSessionOptions, SubcommandRunner } from '../types.js';
import { importOptional } from './io.js';

/** Session options the front ends pass on (RULES: runRepl / runHeadless). */
export type FrontEndSessionOptions = Omit<KiroSessionOptions, 'ui' | 'interactive' | 'origin' | 'ws'>;

/** src/repl/repl.ts `runRepl`. */
export type RunReplFn = (opts: {
  ctx: CliContext;
  sessionOptions: FrontEndSessionOptions;
  initialInput?: string;
  wrap?: 'always' | 'never' | 'auto';
}) => Promise<number>;

/** src/session/kiroSession.ts `createSession`. */
export type CreateSessionFn = (opts: KiroSessionOptions) => Promise<KiroSession>;

// Specifiers are relative to this file (src/cli/entries.ts).
const REPL = '../repl/repl.js';
const SESSION = '../session/kiroSession.js';
const ACP = '../acp/server.js';
const SPEC = '../spec/cli.js';
const CREW = '../crew/cli.js';

export function loadRunRepl(): Promise<RunReplFn> {
  return importOptional<RunReplFn>(REPL, 'runRepl', import.meta.url);
}

export function loadCreateSession(): Promise<CreateSessionFn> {
  return importOptional<CreateSessionFn>(SESSION, 'createSession', import.meta.url);
}

export function loadAcpCommand(): Promise<SubcommandRunner> {
  return importOptional<SubcommandRunner>(ACP, 'runAcpCommand', import.meta.url);
}

export function loadSpecCommand(): Promise<SubcommandRunner> {
  return importOptional<SubcommandRunner>(SPEC, 'runSpecCommand', import.meta.url);
}

export function loadCrewCommand(): Promise<SubcommandRunner> {
  return importOptional<SubcommandRunner>(CREW, 'runCrewCommand', import.meta.url);
}
