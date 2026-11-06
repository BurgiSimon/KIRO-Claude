/**
 * /tools [list] | trust <names…> | untrust <names…> | trust-all | reset | schema, and the
 * deprecated /acceptall (01 §5.8, 06 §1.7 / §5.8 exact strings).
 *
 * The listing comes from KiroSession.toolListing() (Claude `init.tools` mapped to Kiro names
 * with policy labels): bold `Tool<pad>Permission` header, a `▔` rule, `Built-in:` then one
 * `<server> (MCP):` group per server (sorted), rows `- <name><pad><label>`; servers still
 * starting are listed under `Servers loading (…)`. Trust changes only touch the adapter's
 * session trust (00 §5.4). Names are checked against the listing (Kiro name, Claude name, or a
 * Kiro 2.x alias such as `fs_read`).
 */

import { normalizeV2Name } from '../../policy/toolmap.js';
import type { ToolListingEntry } from '../../types.js';
import { c } from '../../util/ansi.js';
import { trustAllWarning } from '../prompt.js';
import type { BuiltinCommand, ReplContext } from '../types.js';

const USAGE = [
  '/tools                    Show the tools and their permission',
  '/tools trust <names…>     Trust tools for this session (no confirmation)',
  '/tools untrust <names…>   Ask before running these tools again',
  '/tools trust-all          Trust all tools (same as --trust-all-tools)',
  '/tools reset              Reset all tools to the agent-defined permissions',
  '/tools schema             Show the tool list as JSON',
].join('\n');

const NO_TOOLS_DOC = 'https://kiro.dev/docs/cli/custom-agents/configuration-reference';

function quoteList(names: readonly string[]): string {
  return names.map((n) => `'${n}'`).join(', ');
}

/** Whether `name` refers to `e`. */
export function toolNameMatches(name: string, e: ToolListingEntry): boolean {
  if (name === e.name || name === e.claudeName) return true;
  if (e.source === 'mcp' && e.server) {
    const tool = e.name.startsWith('@') ? e.name.slice(e.name.indexOf('/') + 1) : e.name;
    if (name === `@${e.server}/${tool}` || name === `@${e.server}`) return true;
  }
  const n = normalizeV2Name(name);
  return n === normalizeV2Name(e.name);
}

/** /tools listing text. */
export function formatToolListing(list: readonly ToolListingEntry[], columns: number, pending: readonly string[] = []): string {
  if (list.length === 0 && pending.length === 0) {
    return `\n${c.yellow('No tools are currently enabled.')}\n\nRefer to the documentation for how to add tools to your agent: ${c.green(NO_TOOLS_DOC)}\n\n`;
  }
  const nameW = Math.max(20, ...list.map((e) => e.name.length + 6));
  let s = `\n${c.bold(`${'Tool'.padEnd(nameW)}Permission`)}\n${'▔'.repeat(Math.max(20, Math.min(columns, 120)))}\n`;
  const builtin = list.filter((e) => e.source === 'builtin').sort((a, b) => (a.name < b.name ? -1 : 1));
  const servers = [...new Set(list.filter((e) => e.source === 'mcp').map((e) => e.server ?? ''))].sort();
  const row = (e: ToolListingEntry): string => {
    const label = e.permission === 'trusted' ? c.green(e.permission) : e.permission === 'denied' ? c.red(e.permission) : e.permission;
    return `- ${e.name.padEnd(nameW - 2)}${label}\n`;
  };
  if (builtin.length) {
    s += `${c.bold('Built-in:')}\n`;
    for (const e of builtin) s += row(e);
    s += '\n';
  }
  for (const srv of servers) {
    s += `${c.bold(`${srv} (MCP):`)}\n`;
    for (const e of list.filter((x) => x.source === 'mcp' && (x.server ?? '') === srv).sort((a, b) => (a.name < b.name ? -1 : 1))) s += row(e);
    s += '\n';
  }
  if (pending.length) {
    s += `${c.bold('Servers loading (Some of these might need auth. See /mcp for details)')}\n`;
    for (const p of pending) s += `- ${p}\n`;
    s += '\n';
  }
  return s;
}

function trustAll(r: ReplContext): void {
  r.session.setTrustAll(true);
  r.write(`\n${trustAllWarning()}`);
}

function split(r: ReplContext, names: string[]): { valid: string[]; invalid: string[] } {
  const list = r.session.toolListing();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const n of names) (list.some((e) => toolNameMatches(n, e)) ? valid : invalid).push(n);
  return { valid, invalid };
}

export const toolsCommand: BuiltinCommand = {
  name: 'tools',
  summary: 'View tools and permissions',
  usage: USAGE,
  async run(args, _raw, r) {
    const sub = args[0] ?? 'list';
    const names = args.slice(1);
    switch (sub) {
      case 'list': {
        let pending: string[] = [];
        try {
          pending = (await r.session.mcpStatus()).filter((m) => m.status === 'pending').map((m) => m.name);
        } catch {
          pending = [];
        }
        r.write(formatToolListing(r.session.toolListing(), r.columns, pending));
        return;
      }
      case 'trust': {
        if (names.length === 0) {
          r.write(`\n${c.red('Usage: /tools trust <names…>')}\n\n`);
          return;
        }
        const { valid, invalid } = split(r, names);
        if (invalid.length) {
          r.write(
            `\n${c.red(invalid.length === 1 ? `Cannot trust '${invalid[0]}', it does not exist.` : `Cannot trust ${quoteList(invalid)}, they do not exist.`)}\n`,
          );
        }
        if (valid.length) {
          r.session.trustTools(valid);
          r.write(
            `\n${c.green(
              valid.length === 1
                ? `Tool '${valid[0]}' is now trusted. I will ${c.bold('not')} ask for confirmation before running this tool.`
                : `Tools ${quoteList(valid)} are now trusted. I will ${c.bold('not')} ask for confirmation before running these tools.`,
            )}\n`,
          );
        }
        r.write('\n');
        return;
      }
      case 'untrust': {
        if (names.length === 0) {
          r.write(`\n${c.red('Usage: /tools untrust <names…>')}\n\n`);
          return;
        }
        const { valid, invalid } = split(r, names);
        if (invalid.length) {
          r.write(
            `\n${c.red(invalid.length === 1 ? `Cannot untrust '${invalid[0]}', it does not exist.` : `Cannot untrust ${quoteList(invalid)}, they do not exist.`)}\n`,
          );
        }
        if (valid.length) {
          r.session.untrustTools(valid);
          r.write(
            `\n${valid.length === 1 ? `Tool '${valid[0]}' is set to per-request confirmation.` : `Tools ${quoteList(valid)} are set to per-request confirmation.`}\n`,
          );
        }
        r.write('\n');
        return;
      }
      case 'trust-all':
        trustAll(r);
        return;
      case 'reset':
        r.session.resetTrust();
        r.write(`\n${c.green('Reset all tools to the permission levels as defined in agent.')}\n\n`);
        return;
      case 'schema':
        r.write(`\n${JSON.stringify(r.session.toolListing(), null, 2)}\n\n`);
        return;
      case 'help':
        r.write(`\n${USAGE}\n\n`);
        return;
      default:
        r.write(`${c.red(`Unknown subcommand: /tools ${sub}`)}\n\n${USAGE}\n\n`);
    }
  },
};

export const acceptAllCommand: BuiltinCommand = {
  name: 'acceptall',
  hidden: true,
  summary: 'Deprecated: use /tools trust-all',
  async run(_args, _raw, r) {
    r.write(`\n${c.yellow('/acceptall is deprecated. Use /tools trust-all instead.')}\n`);
    trustAll(r);
  },
};
