/**
 * Workspace context: where kiro-claude runs and where Kiro's two configuration roots live.
 *
 * Semantics (02 §1.1–1.3, 00 §2.1–2.2):
 *  - `cwd` is the realpath of the process (or given) working directory.
 *  - `workspaceRoot` is the nearest ancestor with a `.kiro/` directory (cwd itself also
 *    qualifies with a legacy `.amazonq/`), never `$HOME` or above; nothing found ⇒ cwd
 *    (util/paths.findWorkspaceRoot, UNVERIFIED walk-up, 00 §2.2 decision).
 *  - `kiroHome` is `$KIRO_HOME` when usable, else `~/.kiro` (02 §1.1).
 *
 * The workspace `.kiro` directory can coincide with the global root (running from `$HOME`,
 * or `KIRO_HOME=<ws>/.kiro`). Q never loads the workspace agents dir when cwd is home
 * (06 §7.2 `local = cwd === home ? [] : …`); every loader in config/ uses
 * {@link workspaceKiroDir}, which returns `undefined` in that case, so nothing (agents,
 * hooks, steering, …) is loaded twice.
 */

import * as path from 'node:path';
import type { WorkspaceContext } from '../types.js';
import { findWorkspaceRoot, homeDir, kiroHome, realpathSafe } from '../util/paths.js';

/** Build the {@link WorkspaceContext} for `cwd` (default `process.cwd()`) and `env` (default `process.env`). */
export function createWorkspaceContext(cwd?: string, env?: NodeJS.ProcessEnv): WorkspaceContext {
  const e = env ?? process.env;
  const realCwd = realpathSafe(path.resolve(cwd ?? process.cwd()));
  const root = realpathSafe(findWorkspaceRoot(realCwd, e));
  return {
    cwd: realCwd,
    workspaceRoot: root,
    kiroHome: kiroHome(e),
    home: homeDir(e),
    env: e,
  };
}

/** True when two paths name the same location (realpath comparison). */
export function samePath(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  return realpathSafe(a) === realpathSafe(b);
}

/**
 * `<workspaceRoot>/.kiro`, or `undefined` when that directory is the global Kiro root
 * itself (see module doc). The directory need not exist.
 */
export function workspaceKiroDir(ws: WorkspaceContext): string | undefined {
  const d = path.join(ws.workspaceRoot, '.kiro');
  if (samePath(d, ws.kiroHome)) return undefined;
  if (samePath(ws.workspaceRoot, ws.home)) return undefined;
  return d;
}

/** `<workspaceRoot>/.amazonq` (legacy Q CLI workspace dir), `undefined` when the root is home. */
export function workspaceAmazonqDir(ws: WorkspaceContext): string | undefined {
  if (samePath(ws.workspaceRoot, ws.home)) return undefined;
  return path.join(ws.workspaceRoot, '.amazonq');
}

/** `~/.aws/amazonq` (legacy Q CLI global dir). */
export function legacyGlobalDir(ws: WorkspaceContext): string {
  return path.join(ws.home, '.aws', 'amazonq');
}
