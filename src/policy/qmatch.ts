/**
 * Q CLI pattern primitives (06 §1.2, §1.3, §3.6; 06 Appendix A reference code).
 *
 * - {@link matchesAnyPattern}: `Q:util/pattern_matching.rs`. Exact string equality first; a
 *   pattern is treated as a glob only when it contains `*` or `?`, in the Rust `globset 0.4.17`
 *   default dialect (`*` and `?` DO match `/`; invalid globs are skipped). Implemented with
 *   util/glob's `'globset'` dialect, which is a port of the verified Appendix A tokenizer.
 * - {@link isToolInAllowlist}: `Q:util/tool_permission_checker.rs`. Native tools match non-`@`
 *   entries and `@builtin`, `@builtin/`, `@builtin/*`, `@builtin/<pat>`; MCP tools match only
 *   `@`-entries, first against `@<server>` then `@<server>/<tool>` (tool = host name).
 * - {@link hookMatchesTool}: Q hook `matcher` semantics (06 §3.6).
 */

import { globMatch } from '../util/glob.js';

/** Q `matches_any_pattern`: exact match, else globset glob when the pattern has `*` or `?`. */
export function matchesAnyPattern(patterns: Iterable<string>, text: string): boolean {
  for (const p of patterns) {
    if (p === text) return true;
    if ((p.includes('*') || p.includes('?')) && globMatch(p, text, 'globset')) return true;
  }
  return false;
}

/**
 * Q `is_tool_in_allowlist`. `serverName === undefined` ⇒ native (built-in) tool; otherwise an
 * MCP tool whose host (unsanitized) name is `toolName`.
 */
export function isToolInAllowlist(allowed: Iterable<string>, toolName: string, serverName?: string): boolean {
  const list = [...allowed];
  if (serverName === undefined) {
    for (const n of list) if (n === '@builtin' || n === '@builtin/' || n === '@builtin/*') return true;
    const pats = list.flatMap((p) =>
      !p.startsWith('@') ? [p] : p.startsWith('@builtin/') ? [p.slice('@builtin/'.length)] : [],
    );
    return matchesAnyPattern(pats, toolName);
  }
  const pats = list.filter((p) => p.startsWith('@'));
  if (matchesAnyPattern(pats, `@${serverName}`)) return true;
  return matchesAnyPattern(pats, `@${serverName}/${toolName}`);
}

/**
 * Q hook matcher (06 §3.6, Appendix A `hookMatchesTool`): `undefined`/`*` match everything;
 * `@builtin` matches native tools; `@server` matches that server's tools; else
 * {@link matchesAnyPattern}. `toolName` is a Q name (`fs_write`, `@git/status`).
 */
export function hookMatchesTool(matcher: string | undefined | null, toolName: string): boolean {
  const isMcp = (s: string): boolean => !s.startsWith('@builtin') && s.startsWith('@');
  if (matcher === undefined || matcher === null) return true;
  if (matcher === '*') return true;
  if (matcher === '@builtin') return !isMcp(toolName);
  if (isMcp(toolName)) {
    const server = toolName.slice(1).split('/')[0];
    if (matcher === `@${server}`) return true;
  }
  return matchesAnyPattern([matcher], toolName);
}
