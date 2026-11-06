/**
 * /prompts [list [search] | details <name> | get <name> [args…] | create -n <name>
 * [--content <text>] [--global] | edit <name> [--global] | remove <name> [--global]]
 * (01 §5.9, 06 §8; file prompts from config/prompts: workspace `.kiro/prompts/` over global
 * `~/.kiro/prompts/`). `get` expands `${1}`…`${10}` / `$ARGUMENTS` / `${@}` (00 §8 C4), shows
 * the content (grey, Q) and sends it as a user turn. MCP prompts are not listed: Claude Code
 * owns the MCP connections (00 §2.2, P2).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROMPT_NAME_RE, expandPrompt, findPrompt, loadPrompts } from '../../config/prompts.js';
import type { PromptFile } from '../../types.js';
import { c } from '../../util/ansi.js';
import type { BuiltinCommand, ReplContext } from '../types.js';

const USAGE = [
  '/prompts [list [search]]                 List the saved prompts',
  '/prompts details <name>                  Show a prompt',
  '/prompts get <name> [args…]              Run a prompt (also @<name> or /<name>)',
  '/prompts create -n <name> [--content <text>] [--global]',
  '/prompts edit <name> [--global]',
  '/prompts remove <name> [--global]',
].join('\n');

/** Placeholders used by a prompt body (`${1}`…, `$ARGUMENTS`, `${@}`), in first-use order. */
export function promptArguments(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\$\{(10|[1-9])\}|\$ARGUMENTS\b|\$\{@\}/g)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

function promptsDir(r: ReplContext, global: boolean): string {
  return global ? path.join(r.ws.kiroHome, 'prompts') : path.join(r.ws.workspaceRoot, '.kiro', 'prompts');
}

/** /prompts list text. */
export function formatPromptList(prompts: readonly PromptFile[], columns: number): string {
  if (prompts.length === 0) {
    return `\nNo prompts available.\n\nCreate one with ${c.green('/prompts create -n <name>')}, or add .kiro/prompts/<name>.md\n\n`;
  }
  const nw = Math.max(20, ...prompts.map((p) => p.name.length + 4));
  const dw = Math.max(20, Math.min(50, ...prompts.map((p) => (p.description ?? '').length + 2)));
  let s = `\n${c.bold(`${'Prompt'.padEnd(nw)}${'Description'.padEnd(dw)}Arguments`)}\n${'▔'.repeat(Math.max(40, Math.min(columns, 100)))}\n`;
  for (const scope of ['workspace', 'global'] as const) {
    const list = prompts.filter((p) => p.scope === scope);
    if (list.length === 0) continue;
    s += `${c.bold(scope === 'workspace' ? 'Local (.kiro/prompts):' : 'Global (~/.kiro/prompts):')}\n`;
    for (const p of list) {
      const d = (p.description ?? '').slice(0, dw - 2);
      s += `- ${p.name.padEnd(nw - 2)}${c.gray(d.padEnd(dw))}${promptArguments(p.body).join(', ')}\n`;
    }
    s += '\n';
  }
  s += `${prompts.length} ${prompts.length === 1 ? 'prompt' : 'prompts'}\n\n`;
  return s;
}

/** Expand prompt `name` with `args`, show it (grey) and send it. */
export async function runPrompt(r: ReplContext, p: PromptFile, args: string[]): Promise<void | 'quit'> {
  const text = expandPrompt(p, args);
  if (text.trim() !== '') r.write(`\n${c.gray(text.trim())}\n\n`);
  return r.sendPrompt({ text });
}

function flagsOf(args: string[]): { global: boolean; name?: string; content?: string; rest: string[] } {
  const out: { global: boolean; name?: string; content?: string; rest: string[] } = { global: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--global' || a === '-g') out.global = true;
    else if (a === '-n' || a === '--name') out.name = args[++i];
    else if (a.startsWith('--name=')) out.name = a.slice(7);
    else if (a === '--content' || a === '-c') out.content = args[++i];
    else if (a.startsWith('--content=')) out.content = a.slice(10);
    else out.rest.push(a);
  }
  return out;
}

export const promptsCommand: BuiltinCommand = {
  name: 'prompts',
  summary: 'View and run saved prompts',
  usage: USAGE,
  async run(args, _raw, r) {
    const sub = args[0] ?? 'list';
    const rest = args.slice(1);
    const prompts = loadPrompts(r.ws);
    switch (sub) {
      case 'list': {
        const q = rest.join(' ').toLowerCase();
        const list = q ? prompts.filter((p) => p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q)) : prompts;
        r.write(formatPromptList(list, r.columns));
        return;
      }
      case 'details': {
        const p = rest[0] ? findPrompt(prompts, rest[0]) : undefined;
        if (!p) {
          r.write(`\n${c.red(`Prompt ${rest[0] ?? ''} not found. Use /prompts list to see available prompts.`)}\n\n`);
          return;
        }
        const argsUsed = promptArguments(p.body);
        let s = `\n${c.bold(p.name)}\n`;
        s += `${c.gray('Source:')} ${p.scope === 'workspace' ? 'local' : 'global'} (${p.path})\n`;
        if (p.description) s += `${c.gray('Description:')} ${p.description}\n`;
        s += `${c.gray('Arguments:')} ${argsUsed.length ? argsUsed.join(', ') : 'none'}\n\n${p.body.replace(/\s+$/, '')}\n\n`;
        r.write(s);
        return;
      }
      case 'get': {
        const name = rest[0];
        const p = name ? findPrompt(prompts, name) : undefined;
        if (!p) {
          r.write(`\n${c.red(`Prompt ${name ?? ''} not found. Use /prompts list to see available prompts.`)}\n\n`);
          return;
        }
        return runPrompt(r, p, rest.slice(1));
      }
      case 'create': {
        const f = flagsOf(rest);
        const name = f.name ?? f.rest[0];
        if (!name || !PROMPT_NAME_RE.test(name)) {
          r.write(`\n${c.red(`Invalid prompt name '${name ?? ''}'. Names may contain letters, digits, '-' and '_' (at most 50 characters).`)}\n\n`);
          return;
        }
        const dir = promptsDir(r, f.global);
        const file = path.join(dir, `${name}.md`);
        if (fs.existsSync(file)) {
          r.write(`\n${c.red(`Prompt '${name}' already exists at ${file}.`)}\n\n`);
          return;
        }
        let content = f.content;
        if (content === undefined) {
          const res = await r.openEditor('', { suffix: '.md' });
          if (!res.ok) {
            r.write(`\n${c.red(`Error opening editor: ${res.error}`)}\n\n`);
            return;
          }
          content = res.text;
        }
        if (content.trim() === '') {
          r.write(`\n${c.yellow('Empty content, prompt not created.')}\n\n`);
          return;
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`);
        r.write(`\n${c.green(`✔ Created prompt '${name}' at ${file}`)}\n\n`);
        return;
      }
      case 'edit':
      case 'remove':
      case 'rm': {
        const f = flagsOf(rest);
        const name = f.rest[0];
        // names are validated like `create` (06 §8.2) so `../x` can never leave the prompts dir
        const file = name && PROMPT_NAME_RE.test(name) ? path.join(promptsDir(r, f.global), `${name}.md`) : '';
        if (!name || !file || !fs.existsSync(file)) {
          r.write(`\n${c.red(`Prompt ${name ?? ''} not found${f.global ? ' in ~/.kiro/prompts' : ' in .kiro/prompts'}.`)}\n\n`);
          return;
        }
        if (sub === 'edit') {
          const res = await r.openEditor('', { file });
          r.write(res.ok ? `\n${c.green(`✔ Updated prompt '${name}'`)}\n\n` : `\n${c.red(`Error opening editor: ${res.error}`)}\n\n`);
          return;
        }
        fs.rmSync(file);
        r.write(`\n${c.green(`✔ Removed prompt '${name}'`)}\n\n`);
        return;
      }
      case 'help':
        r.write(`\n${USAGE}\n\n`);
        return;
      default:
        r.write(`${c.red(`Unknown subcommand: /prompts ${sub}`)}\n\n${USAGE}\n\n`);
    }
  },
};
