/**
 * Kiro-scope invariants (02 §2.8 "Kiro-scope invariants", 00 §2.3) and `.kiroignore` (02 §6.4).
 * Applied by the gate for BOTH agent dialects (00 §2.3 DECISION: a safety deviation for V2),
 * before any policy evaluation; no rule or trust setting can lift them.
 *
 * Writes (capability `fs_write`: Write, Edit, MultiEdit, NotebookEdit) are always DENIED to:
 *  - `<kiroHome>/settings/**` and any `.kiro/settings/**` (workspace settings, at any depth);
 *  - `<kiroHome>/workspace-roots/**`;
 *  - any `.kiroignore`;
 *  - `<kiroHome>/powers/installed/<name>/mcp.json`;
 *  - Kiro state dirs `<kiroHome>/{sandbox-state,web-session,cloud-cache,sandbox-curl}/**`, plus the
 *    adapter's own state `<kiroHome>/sessions/**` and `<kiroHome>/kiro-claude/**` (DECISION).
 * Writes always ASK (even when a rule or trust allows them) for:
 *  - `.git/**`, `.vscode/**` (any depth), `**​/*.code-workspace`;
 *  - `{.kiro,<kiroHome>}/{agents,hooks,workflows,powers}/**`.
 * `<kiroHome>` checks are done for both `ws.kiroHome` and `<home>/.kiro`.
 * Reads (`fs_read`: Read, and Glob/Grep search roots) of paths ignored by `.kiroignore`
 * (`opts.isIgnored`, supplied by the caller) are DENIED; result filtering of Glob/Grep is not
 * possible (best effort, 00 §2.3).
 *
 * Deny reason: `Kiro does not allow this operation: <path>` (00 §5.1).
 */

import * as path from 'node:path';
import type { KiroToolCall, WorkspaceContext } from '../types.js';
import { isSubpath, realpathDeep } from '../util/paths.js';
import { canonicalizePath } from './pathmatch.js';

export interface InvariantResult {
  effect: 'deny' | 'ask';
  reason: string;
}

const DENY_STATE_DIRS = ['settings', 'workspace-roots', 'sandbox-state', 'web-session', 'cloud-cache', 'sandbox-curl', 'sessions', 'kiro-claude'];
const ASK_KIRO_DIRS = ['agents', 'hooks', 'workflows', 'powers'];

function kiroRoots(ws: WorkspaceContext): string[] {
  const roots = new Set<string>();
  for (const r of [ws.kiroHome, path.join(ws.home, '.kiro')]) {
    if (!r) continue;
    roots.add(path.resolve(r));
    roots.add(realpathDeep(r));
  }
  return [...roots];
}

function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s !== '');
}

function hasSegmentPair(segs: string[], a: string, bs: readonly string[]): boolean {
  for (let i = 0; i + 1 < segs.length; i++) if (segs[i] === a && bs.includes(segs[i + 1]!)) return true;
  return false;
}

/** Deny check for one canonical write target. */
export function isDeniedWritePath(p: string, ws: WorkspaceContext): boolean {
  const segs = segments(p);
  if (segs[segs.length - 1] === '.kiroignore') return true;
  if (hasSegmentPair(segs, '.kiro', ['settings'])) return true;
  for (const root of kiroRoots(ws)) {
    for (const d of DENY_STATE_DIRS) if (isSubpath(p, path.join(root, d))) return true;
    const installed = path.join(root, 'powers', 'installed');
    if (isSubpath(p, installed)) {
      const rel = path.relative(installed, p).split(path.sep);
      if (rel.length === 2 && rel[1] === 'mcp.json') return true;
    }
  }
  return false;
}

/** Always-ask check for one canonical write target. */
export function isAlwaysAskWritePath(p: string, ws: WorkspaceContext): boolean {
  const segs = segments(p);
  if (segs.includes('.git') || segs.includes('.vscode')) return true;
  if ((segs[segs.length - 1] ?? '').endsWith('.code-workspace')) return true;
  if (hasSegmentPair(segs, '.kiro', ASK_KIRO_DIRS)) return true;
  for (const root of kiroRoots(ws)) {
    for (const d of ASK_KIRO_DIRS) if (isSubpath(p, path.join(root, d))) return true;
  }
  return false;
}

/** Hard rules that no policy or trust can override (see module doc). */
export function checkInvariants(
  call: KiroToolCall,
  ws: WorkspaceContext,
  opts?: { isIgnored?: (p: string) => boolean },
): InvariantResult | undefined {
  const cwd = call.cwd || ws.cwd;
  if (call.capability === 'fs_write') {
    const targets = call.subjects.map((s) => ({ raw: path.resolve(cwd, s), canon: canonicalizePath(s, cwd, ws.env) }));
    for (const t of targets) {
      if (isDeniedWritePath(t.canon, ws) || isDeniedWritePath(t.raw, ws)) {
        return { effect: 'deny', reason: `Kiro does not allow this operation: ${t.raw}` };
      }
    }
    for (const t of targets) {
      if (isAlwaysAskWritePath(t.canon, ws) || isAlwaysAskWritePath(t.raw, ws)) {
        return { effect: 'ask', reason: `Kiro always asks before writing to ${t.raw}` };
      }
    }
    return undefined;
  }
  if (call.capability === 'fs_read' && opts?.isIgnored) {
    for (const s of call.subjects) {
      const raw = path.resolve(cwd, s);
      let ignored = false;
      try {
        ignored = opts.isIgnored(raw) || opts.isIgnored(canonicalizePath(s, cwd, ws.env));
      } catch {
        ignored = false;
      }
      if (ignored) return { effect: 'deny', reason: `Kiro does not allow this operation: ${raw}` };
    }
  }
  return undefined;
}
