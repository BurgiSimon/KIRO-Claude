/**
 * Shared resolution of `file://` / `skill://` resource specs (02 §2.9, 06 §4.2).
 *
 *  - The scheme is stripped; `file:///abs` ⇒ `/abs`.
 *  - `~/.kiro` and `~/.kiro/…` map onto the Kiro home (`$KIRO_HOME` when set, 02 §1.1);
 *    other `~/…` expand to the home directory.
 *  - Relative specs resolve against the workspace root (adapter DECISION, 02 §2.9; Q used
 *    the process cwd).
 *  - The returned `{cwd, pattern}` pair keeps the base directory literal (glob characters in
 *    the workspace or home path are never interpreted) for util/glob.walkGlob.
 */

import * as path from 'node:path';
import type { WorkspaceContext } from '../types.js';
import { hasGlobMeta } from '../util/glob.js';
import { expandTilde } from '../util/paths.js';

/** Strip `<scheme>://` (case-insensitive) from `uri`; `undefined` when it has another scheme. */
export function stripScheme(uri: string, scheme: 'file' | 'skill'): string | undefined {
  const prefix = `${scheme}://`;
  if (uri.slice(0, prefix.length).toLowerCase() !== prefix) return undefined;
  return uri.slice(prefix.length);
}

/** Literal base + pattern text for a resource spec (see module doc). */
export function resolveSpec(spec: string, ws: WorkspaceContext): { cwd: string; pattern: string; abs: string; glob: boolean } {
  let cwd: string;
  let pattern: string;
  if (spec === '~/.kiro' || spec.startsWith('~/.kiro/')) {
    cwd = ws.kiroHome;
    pattern = spec.slice('~/.kiro'.length).replace(/^\/+/, '') || '.';
  } else if (spec === '~' || spec.startsWith('~/')) {
    cwd = ws.home;
    pattern = spec.slice(1).replace(/^\/+/, '') || '.';
  } else if (path.isAbsolute(spec)) {
    const root = path.parse(spec).root;
    cwd = root;
    pattern = spec.slice(root.length) || '.';
  } else {
    cwd = ws.workspaceRoot;
    pattern = spec.replace(/^\.\/+/, '') || '.';
  }
  const abs = path.resolve(cwd, expandTilde(pattern, ws.env));
  return { cwd, pattern, abs, glob: hasGlobMeta(pattern, 'path') };
}
