/**
 * Q CLI read-only shell command detection (`toolsSettings.execute_bash.autoAllowReadonly`,
 * 02 §2.7; algorithm `requires_acceptance` from `Q:cli/chat/tools/execute/mod.rs`, 06 §1.4.1,
 * ported from 06 Appendix A).
 *
 * A command needs acceptance (is NOT auto-allowed) when it:
 *  - contains `\n` or `\r`;
 *  - cannot be split by Rust `shlex` 1.3.0 (unbalanced quote, trailing `\`) — comments ON,
 *    so `ls # ; rm x` is just `ls`;
 *  - has a word (quotes removed) containing any of `<(`, `$(`, `` ` ``, `>`, `&&`, `||`, `&`,
 *    `;`, `$`, newline, `\r`, `IFS`;
 *  - has a word that contains `|` but is not exactly `|` (`a|b`, quoted `'x|y'`);
 *  - has a pipeline segment `find … -exec|-delete|-ok|-fprint|-fls…` (substring match, so
 *    `-execdir`, `-okdir`, `-fprintf` count) or `grep … -P|--perl-regexp`.
 * Otherwise `allowedCommands` (anchored Rust regex against the FULL original command) can
 * approve it, and finally every pipeline segment must start with a read-only command
 * (`ls cat echo pwd which head tail find grep dir type`) when `allowReadOnly` is set.
 * An empty command needs no acceptance (Q: empty ⇒ Allow).
 */

import { shlexSplit } from '../util/shlex.js';
import { anchoredRustRegex } from './rustregex.js';

/** Q `READONLY_COMMANDS` (execute/mod.rs:40-42). */
export const READONLY_COMMANDS: readonly string[] = Object.freeze([
  'ls', 'cat', 'echo', 'pwd', 'which', 'head', 'tail', 'find', 'grep', 'dir', 'type',
]);

/** Substrings that make a word dangerous (checked on unquoted words). */
export const DANGEROUS_PATTERNS: readonly string[] = Object.freeze([
  '<(', '$(', '`', '>', '&&', '||', '&', ';', '$', '\n', '\r', 'IFS',
]);

const FIND_DANGEROUS = ['-exec', '-delete', '-ok', '-fprint', '-fls'];

/**
 * Q `requires_acceptance(cmd, allowedCommands, allowReadOnly)`: `true` when the user must
 * approve the command (06 §1.4.1, faithful).
 */
export function requiresAcceptance(
  cmd: string,
  allowedCommands: readonly string[] | undefined,
  allowReadOnly: boolean,
): boolean {
  if (cmd.includes('\n') || cmd.includes('\r')) return true;
  const args = shlexSplit(cmd, { comments: true });
  if (args === null) return true;
  if (args.some((a) => DANGEROUS_PATTERNS.some((p) => a.includes(p)))) return true;
  const pipeline: string[][] = [];
  let cur: string[] = [];
  for (const a of args) {
    if (a === '|') {
      if (cur.length) pipeline.push(cur);
      cur = [];
    } else if (a.includes('|')) return true;
    else cur.push(a);
  }
  if (cur.length) pipeline.push(cur);
  for (const c of pipeline) {
    if (c[0] === 'find' && c.some((a) => FIND_DANGEROUS.some((x) => a.includes(x)))) return true;
    if (c[0] === 'grep' && c.some((a) => a.includes('-P') || a.includes('--perl-regexp'))) return true;
  }
  // allowedCommands match the FULL original command, only after the checks above; invalid
  // allow regexes are ignored.
  if ((allowedCommands ?? []).some((p) => anchoredRustRegex(p)?.test(cmd) ?? false)) return false;
  for (const c of pipeline) {
    if (!allowReadOnly || !READONLY_COMMANDS.includes(c[0]!)) return true;
  }
  return false;
}

/** True when Q's `autoAllowReadonly` would auto-approve `cmd` (no allow-list involved). */
export function isReadonlyCommand(cmd: string): boolean {
  return !requiresAcceptance(cmd, undefined, true);
}
