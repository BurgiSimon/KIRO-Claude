/**
 * `kiro-claude version [--changelog[=all|x.y.z]]` and `kiro-claude update` (01 §2.6, §2;
 * 08 KC-CLI-01/08; Q `cli/mod.rs` `print_version`).
 *
 * - `version` prints the `--version` line (`kiro-claude 0.1.0 (kiro-cli 1.26.0)`, src/version.ts);
 *   with `-v` it also runs `claude --version` and prints `Claude Code <version> (<path>)`.
 *   `--changelog` (current version), `--changelog=all`, `--changelog=x.y.z` use Q's output:
 *   `Changelog for version X:` / `Version <v> (<date>)` / `  - Added|Fixed|Changed: <text>`,
 *   or `No changelog information available for version X.`
 * - `update` (08 KC-CLI-08, P0 for KiroCrew's unattended auto-update): a fast no-op that never
 *   reads stdin, never touches the network and never fails on unknown flags: stdout
 *   `kiro-claude is updated by its installer; nothing to do. Update Claude Code with: claude update`
 *   (exact), plus a stderr hint for npm / source installs; exit 0.
 */

import type { CliContext } from '../../types.js';
import { KIRO_CLAUDE_VERSION, versionLine } from '../../version.js';
import type { CommandDef } from '../args.js';
import { err, out, parseOrExit } from '../io.js';
import { locateClaude } from './auth.js';
import { VERBOSE_ARG } from './chatArgs.js';

export interface ChangelogEntry {
  version: string;
  date: string;
  changes: { type: 'added' | 'fixed' | 'changed'; description: string }[];
}

/** Bundled changelog (newest first). */
export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: '0.1.0',
    date: '2026-11-06',
    changes: [
      { type: 'added', description: 'Kiro CLI command surface (chat, agent, mcp, settings, login/logout/whoami, spec, acp) running on the installed Claude Code' },
      { type: 'added', description: 'Kiro agents, steering, hooks, prompts, skills and MCP configuration with Kiro semantics' },
      { type: 'added', description: 'kiro-cli compatible ACP server and KiroCrew integration (kiro-claude crew)' },
    ],
  },
];

export const VERSION_DEF: CommandDef = {
  name: 'version',
  about: 'Show version information',
  args: [
    {
      id: 'changelog',
      long: 'changelog',
      kind: 'value',
      valueName: 'CHANGELOG',
      optionalValue: true,
      missingValue: '',
      help: 'Show the changelog (use --changelog=all for all versions, or --changelog=x.x.x for a specific version)',
    },
    VERBOSE_ARG,
  ],
};

export const UPDATE_DEF: CommandDef = {
  name: 'update',
  about: 'Update kiro-claude (no-op: use your package manager)',
  args: [
    { id: 'non-interactive', long: 'non-interactive', short: 'y', kind: 'bool', help: 'Accepted for compatibility' },
    { id: 'check', long: 'check', kind: 'bool', help: 'Accepted for compatibility' },
    { id: 'force', long: 'force', kind: 'bool', help: 'Accepted for compatibility' },
    VERBOSE_ARG,
  ],
};

export const UPDATE_TEXT = 'kiro-claude is updated by its installer; nothing to do. Update Claude Code with: claude update';
export const UPDATE_HINT =
  'To update kiro-claude itself: npm install -g kiro-claude@latest (npm install), or git pull && npm ci && npm run build (source checkout).';

const TYPE_LABEL: Record<string, string> = { added: 'Added', fixed: 'Fixed', changed: 'Changed' };

function entryLines(e: ChangelogEntry): string[] {
  const lines = [`Version ${e.version} (${e.date})`];
  if (e.changes.length === 0) lines.push('  No changes recorded for this version.');
  for (const c of e.changes) lines.push(`  - ${TYPE_LABEL[c.type] ?? c.type}: ${c.description}`);
  lines.push('');
  return lines;
}

/** Q's changelog output for `--changelog[=value]`. */
export function changelogText(value: string, entries: readonly ChangelogEntry[] = CHANGELOG): string {
  if (value === 'all') {
    if (entries.length === 0) return 'No changelog information available.';
    return ['Changelog for all versions:', ...entries.flatMap(entryLines)].join('\n');
  }
  const v = value === '' ? KIRO_CLAUDE_VERSION : value;
  const e = entries.find((x) => x.version === v);
  if (!e) return `No changelog information available for version ${v}.`;
  return [`Changelog for version ${v}:`, ...entryLines(e)].join('\n');
}

export async function runVersionCommand(args: string[], ctx: CliContext): Promise<number> {
  const p = parseOrExit(VERSION_DEF, args, ctx);
  if (typeof p === 'number') return p;
  if (p.has('changelog')) {
    out(ctx, changelogText(p.value('changelog') ?? ''));
    return 0;
  }
  out(ctx, versionLine());
  if (ctx.verbosity + p.count('verbose') > 0) {
    const loc = await locateClaude(ctx);
    if (loc.bin) out(ctx, `Claude Code ${loc.bin.version} (${loc.bin.path})`);
    else err(ctx, `Claude Code: not found (${loc.error})`);
  }
  return 0;
}

/** `update`: never fails (unknown flags are ignored), only `--help` is honoured. */
export async function runUpdateCommand(args: string[], ctx: CliContext): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    const p = parseOrExit(UPDATE_DEF, args, ctx);
    if (typeof p === 'number') return p;
  }
  out(ctx, UPDATE_TEXT);
  err(ctx, UPDATE_HINT);
  return 0;
}
