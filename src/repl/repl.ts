/**
 * `kiro-claude chat` interactive entry point (fixed Wave-2 signature).
 *
 * Wires the real dependencies into repl/core.ts: session/kiroSession.ts `createSession` /
 * `importSessionExport` and the spec module's slash commands (`/spec`). Everything else (input,
 * rendering, commands) lives in the other repl/ modules; see core.ts for the behavior.
 */

import { createSession, importSessionExport } from '../session/kiroSession.js';
import { specSlashCommands } from '../spec/slash.js';
import type { CliContext } from '../types.js';
import { runReplWith } from './core.js';
import type { ReplSessionOptions } from './types.js';

export { runReplWith } from './core.js';
export type { ReplDeps, RunReplOptions } from './types.js';

/** Run the interactive chat until the user quits; resolves with the process exit code. */
export function runRepl(opts: {
  ctx: CliContext;
  sessionOptions: ReplSessionOptions;
  initialInput?: string;
  wrap?: 'always' | 'never' | 'auto';
}): Promise<number> {
  return runReplWith(opts, {
    createSession,
    importSessionExport,
    extraCommands: specSlashCommands,
    installSignalHandlers: true,
  });
}
