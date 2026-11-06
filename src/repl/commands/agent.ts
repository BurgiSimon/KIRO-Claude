/**
 * /agent list | swap|switch [name] | set-default [name] | schema | create|generate <name> … |
 * edit [name] (01 §5.5, 06 §7.6/§7.9).
 *
 *  - `list`: Q `* <active>` (green) / `  <other>`, plus the description (grey);
 *  - `swap`: KiroSession.swapAgent (respawn with `--resume`, 00 §2.5); without a name a picker;
 *  - `set-default`: `chat.defaultAgent` in the global settings, Q text
 *    `✓ Default agent set to '<n>'. This will take effect the next time <prog> chat is launched.`;
 *  - `create <name> [-D <desc>] [-d workspace|global|<path>] [-f <from>]`: writes
 *    config/agents `agentCreateTemplate` (or a copy of `--from`'s file) to
 *    `<dir>/<name>.json` (default: global, Q), opens `$EDITOR` when set, validates the JSON
 *    (Q `Post write validation failed …`), prints `📁 Created agent <n> '<path>'`. AI-assisted
 *    generation is not available: `generate` is an alias of `create`;
 *  - `edit`: `$EDITOR` on the agent file (built-ins cannot be edited).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AGENT_SCHEMA, BUILTIN_AGENT_NAMES, agentCreateTemplate, agentDirs, loadAgents } from '../../config/agents.js';
import type { KiroAgent } from '../../types.js';
import { c } from '../../util/ansi.js';
import { notSupported } from '../prompt.js';
import type { BuiltinCommand, ReplContext } from '../types.js';

const USAGE = [
  '/agent list                     List the available agents',
  '/agent swap [name]              Switch to another agent (keeps the conversation)',
  '/agent set-default [name]       Default agent for new chat sessions',
  '/agent create <name> [-D <description>] [-d workspace|global|<path>] [-f <from-agent>]',
  '/agent edit [name]              Edit an agent file in $EDITOR',
  '/agent schema                   Print the agent JSON schema',
].join('\n');

function agents(r: ReplContext): Map<string, KiroAgent> {
  return loadAgents(r.ws, { settings: r.settings }).agents;
}

async function pickAgent(r: ReplContext, question: string, list: KiroAgent[]): Promise<string | undefined> {
  const idx = await r.choose(
    question,
    list.map((a) => `${a.name}${a.name === r.session.agent.name ? ' (active)' : ''}${a.description ? ` | ${a.description}` : ''}`),
  );
  return idx === undefined ? undefined : list[idx]!.name;
}

function parseFlags(args: string[], spec: Record<string, string>): { flags: Record<string, string>; positional: string[]; error?: string } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(0, eq) : a;
      const name = spec[key];
      if (!name) return { flags, positional, error: `unexpected argument '${a}'` };
      if (name === 'manual') {
        flags.manual = 'true';
        continue;
      }
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) return { flags, positional, error: `a value is required for '${key}'` };
      flags[name] = v;
    } else positional.push(a);
  }
  return { flags, positional };
}

async function create(args: string[], r: ReplContext): Promise<void> {
  const p = parseFlags(args, {
    '-D': 'description',
    '--description': 'description',
    '-d': 'directory',
    '--directory': 'directory',
    '-f': 'from',
    '--from': 'from',
    '-n': 'name',
    '--name': 'name',
    '-m': 'mcp',
    '--mcp-server': 'mcp',
    '--manual': 'manual',
  });
  if (p.error) {
    r.write(`\n${c.red(`error: ${p.error}`)}\n\n${USAGE}\n\n`);
    return;
  }
  const name = p.flags.name ?? p.positional[0];
  if (!name) {
    r.write(`\n${c.red('error: the agent name is required')}\nUsage: /agent create <name> [-D <description>] [-d workspace|global|<path>] [-f <from-agent>]\n\n`);
    return;
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(name) || name.includes('..') || name.split('/').some((seg) => seg === '')) {
    r.write(`\n${c.red(`Invalid agent name '${name}'.`)}\n\n`);
    return;
  }
  const dirs = agentDirs(r.ws);
  const d = p.flags.directory ?? 'global';
  const dir = d === 'global' ? dirs.global : d === 'workspace' ? dirs.workspace : path.join(path.resolve(r.ws.cwd, d), '.kiro', 'agents');
  const file = path.join(dir, `${name}.json`);
  if (fs.existsSync(file)) {
    r.write(`\n${c.red(`Agent with name ${name} already exists. Aborting`)}\n\n`);
    return;
  }
  let content: Record<string, unknown>;
  if (p.flags.from) {
    const src = agents(r).get(p.flags.from);
    if (!src) {
      r.write(`\n${c.red(`Error: no agent with name ${p.flags.from} found`)}\n\n`);
      return;
    }
    if (src.path && src.format === 'json') {
      try {
        content = JSON.parse(fs.readFileSync(src.path, 'utf8')) as Record<string, unknown>;
      } catch (e) {
        r.write(`\n${c.red(`Failed to read ${src.path}: ${e instanceof Error ? e.message : String(e)}`)}\n\n`);
        return;
      }
      content.name = name;
    } else {
      content = agentCreateTemplate(name, {
        ...(src.description ? { description: src.description } : {}),
        ...(src.prompt ? { prompt: src.prompt } : {}),
        tools: src.tools.length ? src.tools : ['*'],
      });
    }
    if (p.flags.description !== undefined) content.description = p.flags.description;
  } else {
    content = agentCreateTemplate(name, p.flags.description !== undefined ? { description: p.flags.description } : {});
  }
  // nested names (`team/planner`, 02 §2.1 path-relative stems) need their sub directory
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
  if ((r.ws.env.EDITOR ?? '').trim() !== '') {
    const res = await r.openEditor('', { file });
    if (!res.ok) {
      r.write(`\nError opening editor: ${res.error}\n\n`);
    } else {
      try {
        JSON.parse(res.text);
      } catch (e) {
        r.write(
          `\n${c.red(`Post write validation failed for agent '${name}' at path: ${file}. Malformed config detected: ${e instanceof Error ? e.message : String(e)}`)}\n\n`,
        );
        return;
      }
    }
  }
  r.write(`\n📁 Created agent ${name} '${file}'\n\n`);
}

async function edit(args: string[], r: ReplContext): Promise<void> {
  const name = args[0] ?? r.session.agent.name;
  const a = agents(r).get(name);
  if (!a) {
    r.write(`\n${c.red(`Error: no agent with name ${name} found`)}\n\n`);
    return;
  }
  if (!a.path || BUILTIN_AGENT_NAMES.includes(a.name) && a.format === 'builtin') {
    r.write(`\n${c.red(`The built-in agent ${name} cannot be edited.`)}\n\n`);
    return;
  }
  const before = fs.readFileSync(a.path, 'utf8');
  const res = await r.openEditor('', { file: a.path });
  if (!res.ok) {
    r.write(`\nError opening editor: ${res.error}\n\n`);
    return;
  }
  if (a.format === 'json') {
    try {
      JSON.parse(res.text);
    } catch (e) {
      fs.writeFileSync(a.path, before); // never keep a broken edit (Q: original never overwritten)
      r.write(
        `\n${c.red(`Post write validation failed for agent '${name}' at path: ${a.path}. Malformed config detected: ${e instanceof Error ? e.message : String(e)}`)}\n\n`,
      );
      return;
    }
  }
  r.write(`\n✔ Updated agent ${name} '${a.path}'\n`);
  if (name === r.session.agent.name) r.write(`Run /agent swap ${name} to reload it in this session.\n`);
  r.write('\n');
}

export const agentCommand: BuiltinCommand = {
  name: 'agent',
  summary: 'Manage agents',
  usage: USAGE,
  async run(args, _raw, r) {
    const sub = args[0] ?? 'list';
    const rest = args.slice(1);
    switch (sub) {
      case 'list': {
        const all = [...agents(r).values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const w = Math.max(...all.map((a) => a.name.length));
        let s = '\n';
        for (const a of all) {
          const active = a.name === r.session.agent.name;
          const name = active ? c.green(`* ${a.name.padEnd(w)}`) : `  ${a.name.padEnd(w)}`;
          s += `${name}${a.description ? `    ${c.gray(a.description)}` : ''}\n`;
        }
        r.write(`${s}\n`);
        return;
      }
      case 'swap':
      case 'switch': {
        const all = agents(r);
        let name: string | undefined = rest[0];
        if (!name) {
          name = await pickAgent(r, 'Choose one of the following agents', [...all.values()]);
          if (!name) return;
        }
        const target = all.get(name);
        if (!target) {
          r.write(`\n${c.red(`Error: no agent with name ${name} found`)}\n\n`);
          return;
        }
        if (name === r.session.agent.name) {
          r.write(`\nAlready using agent ${name}.\n\n`);
          return;
        }
        await r.session.swapAgent(name);
        await r.refreshUsage();
        r.write(`\n✔ Switched to agent ${c.green(name)}\n\n`);
        const wm = r.session.agent.welcomeMessage ?? target.welcomeMessage;
        if (wm && wm.trim()) r.write(`${wm.trim()}\n\n`);
        return;
      }
      case 'set-default': {
        const all = agents(r);
        let name: string | undefined = rest[0] === '-n' || rest[0] === '--name' ? rest[1] : rest[0];
        if (!name) {
          name = await pickAgent(r, 'Choose the default agent', [...all.values()]);
          if (!name) return;
        }
        if (!all.has(name)) {
          r.write(`\n${c.red(`Error: no agent with name ${name} found`)}\n\n`);
          return;
        }
        r.settings.set('chat.defaultAgent', name, 'global');
        r.write(`\n${c.green(`✓ Default agent set to '${name}'. This will take effect the next time ${r.progName} chat is launched.`)}\n\n`);
        return;
      }
      case 'schema':
        r.write(`\n${JSON.stringify(AGENT_SCHEMA, null, 2)}\n\n`);
        return;
      case 'create':
      case 'generate':
        await create(rest, r);
        return;
      case 'edit':
        await edit(rest, r);
        return;
      case 'help':
        r.write(`\n${USAGE}\n\n`);
        return;
      case 'delete':
      case 'rename':
      case 'set':
        r.write(`${c.yellow(notSupported(`agent ${sub}`))}\n`);
        return;
      default:
        r.write(`${c.red(`Unknown subcommand: /agent ${sub}`)}\n\n${USAGE}\n\n`);
    }
  },
};
