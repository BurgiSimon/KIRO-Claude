/**
 * /context show [--expand] | add [-f|--force] <paths…> | remove|rm <paths…> | clear
 * (01 §5.3, 06 §4.6 Classic exact strings; data from KiroSession.contextReport()).
 *
 * `add` validates each path unless `--force` (Q: `Error: Invalid path '<p>': <reason>. Use
 * --force to add anyway.`) using config/resources `expandFileSpec` (relative paths resolve
 * against the workspace root, 02 §2.9), rejects duplicates of session rules, then hands the
 * rules to the session (which respawns Claude with the new context).
 */

import * as fs from 'node:fs';
import { expandFileSpec } from '../../config/resources.js';
import { contextFilesLimit } from '../../context/tokens.js';
import type { ContextReport } from '../../types.js';
import { c } from '../../util/ansi.js';
import type { BuiltinCommand, ReplContext } from '../types.js';

const NOTE = 'Note: Context modifications via slash command is temporary.';

const USAGE = [
  '/context show [--expand]       Show the context rules and the files they match',
  '/context add [-f|--force] <paths…>  Add rules (files, directories, globs) for this session',
  '/context rm <paths…>           Remove session rules',
  '/context clear                 Remove all session rules',
].join('\n');

function matchCount(n: number): string {
  return c.green(`(${n} ${n === 1 ? 'match' : 'matches'})`);
}

/** /context show text (06 §4.6 layout). */
export function formatContextReport(rep: ContextReport, agentName: string, expand: boolean): string {
  let s = `\n${c.magenta(c.bold(`👤 Agent (${agentName}):`))}\n`;
  if (rep.agentEntries.length === 0) s += `    ${c.gray('<none>')}\n`;
  for (const e of rep.agentEntries) s += `    ${e.pattern} ${matchCount(e.files.length)}\n`;
  const conditional = rep.steering.filter((f) => f.inclusion !== 'always');
  if (conditional.length > 0) {
    s += `\n${c.magenta(c.bold('📝 Steering (loaded when referenced):'))}\n`;
    for (const f of conditional) s += `    ${f.path} ${c.gray(`(${f.inclusion})`)}\n`;
  }
  s += `\n${c.magenta(c.bold('💬 Session (temporary):'))}\n`;
  if (rep.sessionEntries.length === 0) s += `    ${c.gray('<none>')}\n`;
  for (const e of rep.sessionEntries) s += `    ${e.pattern} ${matchCount(e.files.length)}\n`;
  s += '\n';

  const files: { icon: string; path: string; tokens: number }[] = [];
  const seen = new Set<string>();
  const push = (icon: string, p: string, tokens: number): void => {
    if (seen.has(p)) return;
    seen.add(p);
    files.push({ icon, path: p, tokens });
  };
  for (const f of rep.steering) if (f.inclusion === 'always') push('👤', f.path, f.tokens);
  for (const e of rep.agentEntries) for (const f of e.files) push('👤', f.path, f.tokens);
  for (const e of rep.sessionEntries) for (const f of e.files) push('💬', f.path, f.tokens);

  if (files.length === 0) s += `${c.gray('No files in the current directory matched the rules above.')}\n\n`;
  else {
    s += `${c.green(c.bold(`${files.length} matched file${files.length === 1 ? '' : 's'} in use:`))}\n`;
    for (const f of files) {
      s += `${f.icon} ${f.path} ${c.gray(`(~${f.tokens} tkns)`)}\n`;
      if (expand) {
        let body = '';
        try {
          body = fs.readFileSync(f.path, 'utf8');
        } catch (e) {
          body = `<could not read: ${e instanceof Error ? e.message : String(e)}>`;
        }
        s += `${c.gray(body)}\n\n`;
      }
    }
    if (expand) s += '▔▔▔\n\n';
  }
  for (const h of rep.hookOutputs) s += `🔧 ${c.gray(`Hook output (~${h.tokens} tkns)`)}\n`;
  // Q prints the total only when something matched (06 §4.6)
  if (files.length > 0 || rep.hookOutputs.length > 0) s += `\nTotal: ~${rep.totalTokens} tokens\n\n`;
  if (rep.droppedFiles.length > 0) {
    const limit = contextFilesLimit(rep.contextWindowTokens);
    s += `${c.yellow(
      `Total token count exceeds limit: ${limit}. The following files will be automatically dropped when interacting with Kiro. Consider removing them. `,
    )}\n\n`;
    for (const p of rep.droppedFiles.slice(0, 10)) s += `${p}\n`;
    if (rep.droppedFiles.length > 10) s += `(${rep.droppedFiles.length - 10} more files)\n`;
    s += '\n';
  }
  return s;
}

async function show(r: ReplContext, expand: boolean): Promise<void> {
  const rep = await r.session.contextReport();
  r.write(formatContextReport(rep, r.session.agent.name, expand));
}

export const contextCommand: BuiltinCommand = {
  name: 'context',
  summary: 'Manage context files for the chat session',
  usage: USAGE,
  async run(args, _raw, r) {
    const sub = args[0] ?? 'show';
    const rest = args.slice(1);
    switch (sub) {
      case 'show':
        await show(r, rest.includes('--expand') || rest.includes('-e'));
        return;
      case 'add': {
        const force = rest.includes('-f') || rest.includes('--force');
        const paths = rest.filter((a) => a !== '-f' && a !== '--force');
        if (paths.length === 0) {
          r.write(`\n${c.red('Error: No paths specified. Usage: /context add [-f|--force] <paths…>')}\n\n`);
          return;
        }
        const rep = await r.session.contextReport();
        const existing = new Set(rep.sessionEntries.map((e) => e.pattern));
        for (const p of paths) {
          if (existing.has(p)) {
            r.write(`\n${c.red(`Error: Rule '${p}' already exists.`)}\n\n`);
            return;
          }
          if (!force) {
            const res = expandFileSpec(p, r.ws);
            const hasGlob = /[*?[]/.test(p);
            const reason = res.error ?? (res.paths.length === 0 ? (hasGlob ? `No files found matching glob pattern '${p}'` : `Path '${p}' does not exist`) : undefined);
            if (reason) {
              r.write(`\n${c.red(`Error: Invalid path '${p}': ${reason}. Use --force to add anyway.`)}\n\n`);
              return;
            }
          }
        }
        await r.session.addContext(paths);
        await r.refreshUsage();
        r.write(`\n${c.green(`Added ${paths.length} path(s) to context.`)}\n${NOTE}\n\n`);
        return;
      }
      case 'rm':
      case 'remove': {
        if (rest.length === 0) {
          r.write(`\n${c.red('Error: No paths specified. Usage: /context rm <paths…>')}\n\n`);
          return;
        }
        const removed = await r.session.removeContext(rest);
        if (removed.length === 0) {
          r.write(`\n${c.red('Error: None of the specified paths were found in the context')}\n\n`);
          return;
        }
        await r.refreshUsage();
        // Q prints the number of arguments, not the number removed (06 §4.6).
        r.write(`\n${c.green(`Removed ${rest.length} path(s) from context.`)}\n\n${NOTE}\n\n`);
        return;
      }
      case 'clear':
        await r.session.clearContext();
        await r.refreshUsage();
        r.write(`\n${c.green('Cleared context')}\n${NOTE}\n\n`);
        return;
      case 'hooks':
        r.write('\nThe /context hooks command is deprecated. Use /hooks to see the hooks of the current agent.\n\n');
        return;
      case 'help':
        r.write(`\n${USAGE}\n\n`);
        return;
      default:
        r.write(`${c.red(`Unknown subcommand: /context ${sub}`)}\n\n${USAGE}\n\n`);
    }
  },
};
