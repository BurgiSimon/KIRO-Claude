/**
 * `kiro-claude agent [SUBCOMMAND] [AGENT_NAME] [OPTIONS]` (01 §2.1, 06 §7.2–7.7, 08 KC-CLI-09).
 *
 *  - `list` (default): Q's layout `<name padded>    <dir of the file | **No path found**>`,
 *    written to stderr like Q (`root_command_args.rs:91-114`);
 *  - `create <name> [-d workspace|global|<dir>] [-f <template agent>]` (legacy `--name/-n`):
 *    writes `<dir>/<name>.json` (default global agents dir) from the Kiro template
 *    (config/agents agentCreateTemplate) or a copy of `--from` (a Markdown agent is copied to
 *    `<name>.md` with only its front matter `name` set, {@link renameMarkdownAgent}), opens `$EDITOR`, re-validates
 *    (`Post write validation failed for agent '<n>' at path: <p>. Malformed config detected:
 *    <e>`), prints `\n📁 Created agent <n> '<path>'\n`; existing ⇒
 *    `Agent with name <n> already exists. Aborting`;
 *  - `edit [name] [--path <file>]`: edits a temporary copy in `$EDITOR`; the original is replaced
 *    only when the edited text validates as if stored at the original path (relative `file://`
 *    prompts resolve next to it) (01 §5.5); built-ins cannot be edited;
 *  - `validate --path <file>` (08 KC-CLI-09): our loader (JSON and Markdown); accepted ⇒ no
 *    output, exit 0; rejected ⇒ stdout `Error: Json supplied at <path> is invalid: <reason>`
 *    (`Markdown agent supplied at …` for .md), exit 1. Type errors of known fields reject;
 *    unknown fields do not (02 §2.1: warn, never fail — KiroCrew specs may carry newer keys);
 *  - `set-default <name>` (legacy `-n`): writes global `chat.defaultAgent`, prints
 *    `✓ Default agent set to '<n>'. This will take effect the next time <prog> chat is launched.`;
 *  - `schema`: the agent JSON schema;
 *  - `migrate [--force]`: copy legacy `~/.aws/amazonq/cli-agents/*.json` into the Kiro global
 *    agents dir (06 §7.7 messages; without `--force` only Q's warning, exit 0);
 *  - `upgrade`: not supported (V2 agents run unchanged in kiro-claude), exit 1;
 *  - `help [SUBCOMMAND]`: clap's generated help subcommand.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliContext, ConfigWarning, KiroAgent } from '../../types.js';
import {
  AGENT_SCHEMA,
  DEFAULT_AGENT_NAME,
  agentCreateTemplate,
  agentDirs,
  agentLocation,
  loadAgentFile,
  loadAgents,
  parseAgent,
} from '../../config/agents.js';
import { legacyGlobalDir } from '../../config/workspace.js';
import { resolvePlainScalar } from '../../util/yaml.js';
import { mkdirp } from '../../util/fsx.js';
import { missingRequired, type CommandDef, type SubcommandInfo } from '../args.js';
import { err, errorText, openInEditor, out, parseOrExit } from '../io.js';
import { VERBOSE_ARG } from './chatArgs.js';

const SUBCOMMANDS: SubcommandInfo[] = [
  { name: 'list', about: 'List the available agents' },
  { name: 'create', about: 'Create an agent config' },
  { name: 'edit', about: 'Edit an existing agent config' },
  { name: 'validate', about: 'Validate an agent config file' },
  { name: 'set-default', about: 'Set the default agent for new chat sessions' },
  { name: 'schema', about: 'Print the agent config JSON schema' },
  { name: 'migrate', about: 'Copy legacy Amazon Q agents into the Kiro agents directory' },
];

export const AGENT_DEF: CommandDef = {
  name: 'agent',
  about: 'Manage agents',
  args: [VERBOSE_ARG],
  subcommands: SUBCOMMANDS,
};

const NAME_POS = { id: 'name', valueName: 'NAME' };

export const AGENT_CREATE_DEF: CommandDef = {
  name: 'agent create',
  about: 'Create an agent config',
  positionals: [{ ...NAME_POS, help: 'Name of the agent' }],
  args: [
    { id: 'legacy-name', long: 'name', short: 'n', kind: 'value', valueName: 'NAME', hidden: true },
    { id: 'directory', long: 'directory', short: 'd', kind: 'value', valueName: 'DIRECTORY', help: 'Where to create the agent: workspace, global (default) or a directory path' },
    { id: 'from', long: 'from', short: 'f', kind: 'value', valueName: 'FROM', help: 'Copy the config of this existing agent' },
    { id: 'no-edit', long: 'no-edit', kind: 'bool', help: 'Do not open $EDITOR after writing the file' },
    VERBOSE_ARG,
  ],
};

export const AGENT_EDIT_DEF: CommandDef = {
  name: 'agent edit',
  about: 'Edit an existing agent config',
  positionals: [{ ...NAME_POS, help: 'Name of the agent (default: the default agent)' }],
  args: [
    { id: 'legacy-name', long: 'name', short: 'n', kind: 'value', valueName: 'NAME', hidden: true },
    { id: 'path', long: 'path', kind: 'value', valueName: 'PATH', help: 'Edit this agent file' },
    VERBOSE_ARG,
  ],
};

export const AGENT_VALIDATE_DEF: CommandDef = {
  name: 'agent validate',
  about: 'Validate an agent config file',
  args: [{ id: 'path', long: 'path', short: 'p', kind: 'value', valueName: 'PATH', help: 'Path of the agent config file' }, VERBOSE_ARG],
};

export const AGENT_SET_DEFAULT_DEF: CommandDef = {
  name: 'agent set-default',
  about: 'Set the default agent for new chat sessions',
  positionals: [{ ...NAME_POS, help: 'Name of the agent' }],
  args: [{ id: 'legacy-name', long: 'name', short: 'n', kind: 'value', valueName: 'NAME', hidden: true }, VERBOSE_ARG],
};

export const AGENT_SCHEMA_DEF: CommandDef = { name: 'agent schema', about: 'Print the agent config JSON schema', args: [VERBOSE_ARG] };

export const AGENT_MIGRATE_DEF: CommandDef = {
  name: 'agent migrate',
  about: 'Copy legacy Amazon Q agents into the Kiro agents directory',
  args: [{ id: 'force', long: 'force', kind: 'bool', help: 'Overwrite agents with the same name' }, VERBOSE_ARG],
};

export const AGENT_LIST_DEF: CommandDef = { name: 'agent list', about: 'List the available agents', args: [VERBOSE_ARG] };

/** Q-style `agent list` lines. */
export function formatAgentList(agents: ReadonlyMap<string, KiroAgent>): string {
  const names = [...agents.keys()];
  if (names.length === 0) return '';
  const w = Math.max(...names.map((n) => n.length));
  return names.map((n) => `${n.padEnd(w)}    ${agentLocation(agents.get(n)!)}`).join('\n');
}

/** Reason text out of a loader warning (`… is invalid: <reason>`, `… malformed at /x: <e>`). */
function reasonOf(w: ConfigWarning): string {
  const m = /is invalid: ([\s\S]*)$/.exec(w.message);
  if (m) return m[1]!;
  const n = /is malformed at (\/[\s\S]*)$/.exec(w.message);
  if (n) return n[1]!;
  return w.message;
}

/**
 * Validate an agent file with our loader (08 KC-CLI-09). Returns undefined when accepted, else
 * the full `Error: … is invalid: …` line.
 *
 * `opts.text` validates that content as if it were stored at `file` (review fix: `agent edit`
 * edits a temporary copy, and a relative `file://` prompt must resolve next to the real file,
 * not next to the copy).
 */
export function validateAgentFileText(file: string, ctx: Pick<CliContext, 'ws' | 'settings'>, opts: { text?: string } = {}): string | undefined {
  const isMd = file.toLowerCase().endsWith('.md');
  const label = isMd ? 'Markdown agent' : 'Json';
  const meta = { scope: 'global' as const, ws: ctx.ws, settings: ctx.settings };
  const r =
    opts.text !== undefined ? parseAgent(opts.text, { ...meta, path: file, format: isMd ? 'md' : 'json' }) : loadAgentFile(file, meta);
  if (!r.agent) {
    const w = r.warnings.find((x) => x.code !== 'unknown-field' && x.code !== 'invalid-field' && x.code !== 'tools-missing') ?? r.warnings[0];
    if (w && /is invalid: /.test(w.message)) return `Error: ${w.message}`;
    return `Error: ${label} supplied at ${file} is invalid: ${w ? reasonOf(w) : 'could not be loaded'}`;
  }
  const typeError = r.warnings.find((x) => x.code === 'invalid-field' || x.code === 'invalid-agent');
  if (typeError) return `Error: ${label} supplied at ${file} is invalid: ${reasonOf(typeError)}`;
  return undefined;
}

function nameArg(p: { pos(id: string): string | undefined; value(id: string): string | undefined }): string | undefined {
  return p.pos('name') ?? p.value('legacy-name');
}

function safeName(name: string): boolean {
  return name.trim() !== '' && !name.split(/[\\/]/).some((s) => s === '..' || s === '.' || s === '') && !path.isAbsolute(name);
}

/** `name` as a YAML scalar: plain when YAML reads it back as that string, else double-quoted. */
function yamlName(name: string): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) && !/^(?:y|n|yes|no|on|off|true|false|null)$/i.test(name);
  return plain && resolvePlainScalar(name) === name ? name : JSON.stringify(name);
}

/**
 * Set the `name` of a Markdown agent (`agent create --from`): only the YAML front matter
 * changes, the body (the prompt) is kept byte for byte. An existing top-level `name:` line (plus
 * its indented continuation lines) is replaced; without one, `name:` is added as the first key;
 * text without front matter gets one. BOM and line endings are kept.
 */
export function renameMarkdownAgent(text: string, name: string): string {
  const bom = text.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const src = text.slice(bom.length);
  const line = `name: ${yamlName(name)}`;
  const open = /^---[ \t]*(\r?\n)/.exec(src);
  if (open) {
    const nl = open[1]!;
    // the closing delimiter: the first later line that is exactly `---` or `...` (util/frontmatter.ts)
    const lines = src.slice(open[0].length).split(/(?<=\n)/);
    let close = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^(?:---|\.\.\.)[ \t]*\r?\n?$/.test(lines[i]!)) {
        close = i;
        break;
      }
    }
    if (close >= 0) {
      const fm = lines.slice(0, close);
      const at = fm.findIndex((l) => /^(["']?)name\1[ \t]*:(?:[ \t]|\r?\n?$)/.test(l));
      if (at >= 0) {
        // the value's continuation: indented lines, blank lines between them (block scalars)
        let end = at + 1;
        for (let i = at + 1; i < fm.length; i++) {
          if (/^[ \t]+\S/.test(fm[i]!)) end = i + 1;
          else if (!/^\s*$/.test(fm[i]!)) break;
        }
        const eol = /\r?\n$/.exec(fm[at]!)?.[0] ?? nl;
        fm.splice(at, end - at, `${line}${eol}`);
      } else {
        fm.unshift(`${line}${nl}`);
      }
      return bom + open[0] + fm.join('') + lines.slice(close).join('');
    }
  }
  const nl = /\r\n/.test(src) ? '\r\n' : '\n';
  return `${bom}---${nl}${line}${nl}---${nl}${src}`;
}

function resolveCreateDir(ctx: CliContext, dir: string | undefined): string {
  if (dir === undefined || dir === 'global') return agentDirs(ctx.ws).global;
  if (dir === 'workspace') return path.join(ctx.ws.workspaceRoot, '.kiro', 'agents');
  return path.resolve(ctx.ws.cwd, dir);
}

function runList(args: string[], ctx: CliContext): number {
  const p = parseOrExit(AGENT_LIST_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const { agents, warnings } = loadAgents(ctx.ws, { settings: ctx.settings });
  for (const w of warnings) if (w.code === 'agent-conflict' || w.code === 'agent-duplicate' || w.code === 'invalid-json') err(ctx, w.message);
  const text = formatAgentList(agents);
  if (text) err(ctx, text);
  return 0;
}

function runCreate(args: string[], ctx: CliContext): number {
  const p = parseOrExit(AGENT_CREATE_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const name = nameArg(p);
  if (name === undefined) {
    err(ctx, missingRequired(AGENT_CREATE_DEF, ctx.progName, ['<NAME>']).message);
    return 2;
  }
  if (!safeName(name)) {
    err(ctx, `error: invalid agent name '${name}'`);
    return 1;
  }
  const dir = resolveCreateDir(ctx, p.value('directory'));
  const loaded = loadAgents(ctx.ws, { settings: ctx.settings });
  let content: string;
  let ext = '.json';
  const from = p.value('from');
  if (from !== undefined) {
    const src = loaded.agents.get(from);
    if (!src) {
      err(ctx, `error: no agent with name ${from} found`);
      return 1;
    }
    if (src.path && src.format === 'json') {
      try {
        const raw = JSON.parse(fs.readFileSync(src.path, 'utf8')) as Record<string, unknown>;
        raw.name = name;
        content = `${JSON.stringify(raw, null, 2)}\n`;
      } catch (e) {
        err(ctx, `error: cannot read ${src.path}: ${errorText(e)}`);
        return 1;
      }
    } else if (src.path && src.format === 'md') {
      ext = '.md';
      let text: string;
      try {
        text = fs.readFileSync(src.path, 'utf8');
      } catch (e) {
        err(ctx, `error: cannot read ${src.path}: ${errorText(e)}`);
        return 1;
      }
      content = renameMarkdownAgent(text, name);
    } else {
      const t = agentCreateTemplate(name, {
        ...(src.description !== undefined ? { description: src.description } : {}),
        ...(src.prompt !== undefined ? { prompt: src.prompt } : {}),
        tools: src.tools,
      });
      content = `${JSON.stringify(t, null, 2)}\n`;
    }
  } else {
    content = `${JSON.stringify(agentCreateTemplate(name), null, 2)}\n`;
  }
  const file = path.join(dir, `${name}${ext}`);
  const sameDir = [...loaded.agents.values()].some((a) => a.name === name && a.path !== undefined && path.dirname(a.path) === path.dirname(file));
  if (fs.existsSync(file) || sameDir) {
    err(ctx, `Agent with name ${name} already exists. Aborting`);
    return 1;
  }
  try {
    mkdirp(path.dirname(file));
    fs.writeFileSync(file, content);
  } catch (e) {
    err(ctx, `error: cannot write ${file}: ${errorText(e)}`);
    return 1;
  }
  if (!p.has('no-edit')) {
    const r = openInEditor(file, ctx.ws.env);
    if (r.error) err(ctx, `error: could not open editor: ${r.error}`);
  }
  const problem = validateAgentFileText(file, ctx);
  if (problem) {
    err(ctx, `Post write validation failed for agent '${name}' at path: ${file}. Malformed config detected: ${problem.replace(/^Error: /, '')}`);
    return 1;
  }
  out(ctx, `\n📁 Created agent ${name} '${file}'\n`);
  return 0;
}

function runEdit(args: string[], ctx: CliContext): number {
  const p = parseOrExit(AGENT_EDIT_DEF, args, ctx);
  if (typeof p === 'number') return p;
  let file = p.value('path');
  let name = nameArg(p);
  if (file === undefined) {
    name ??= ctx.settings.getString('chat.defaultAgent') || DEFAULT_AGENT_NAME;
    const { agents } = loadAgents(ctx.ws, { settings: ctx.settings });
    const a = agents.get(name);
    if (!a) {
      err(ctx, `error: no agent with name ${name} found`);
      return 1;
    }
    if (!a.path || a.scope === 'builtin') {
      err(ctx, `error: ${name} is a built-in agent and cannot be edited`);
      return 1;
    }
    file = a.path;
  } else {
    file = path.resolve(ctx.ws.cwd, file);
    if (!fs.existsSync(file)) {
      err(ctx, `error: agent file not found: ${file}`);
      return 1;
    }
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-claude-agent-'));
  const tmp = path.join(tmpDir, path.basename(file));
  try {
    fs.copyFileSync(file, tmp);
    const before = fs.readFileSync(tmp, 'utf8');
    const r = openInEditor(tmp, ctx.ws.env);
    if (r.error) {
      err(ctx, `error: could not open editor: ${r.error}`);
      return 1;
    }
    const after = fs.readFileSync(tmp, 'utf8');
    if (after === before) {
      out(ctx, `No changes made to ${file}`);
      return 0;
    }
    // Validate the edited text as if it already were `file` (relative file:// prompts).
    const problem = validateAgentFileText(file, ctx, { text: after });
    if (problem) {
      err(ctx, `Post write validation failed for agent '${name ?? path.basename(file)}' at path: ${file}. Malformed config detected: ${problem.replace(/^Error: /, '')}`);
      err(ctx, `The original file was not changed.`);
      return 1;
    }
    fs.writeFileSync(file, after);
    out(ctx, `\n✏️  Edited agent ${name ?? path.basename(file)} '${file}'\n`);
    return 0;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runValidate(args: string[], ctx: CliContext): number {
  const p = parseOrExit(AGENT_VALIDATE_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const file = p.value('path');
  if (file === undefined) {
    err(ctx, missingRequired(AGENT_VALIDATE_DEF, ctx.progName, ['--path <PATH>']).message);
    return 2;
  }
  const abs = path.resolve(ctx.ws.cwd, file);
  const problem = validateAgentFileText(abs, ctx);
  if (problem) {
    out(ctx, problem.replace(abs, file));
    return 1;
  }
  return 0;
}

function runSetDefault(args: string[], ctx: CliContext): number {
  const p = parseOrExit(AGENT_SET_DEFAULT_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const name = nameArg(p);
  if (name === undefined) {
    err(ctx, missingRequired(AGENT_SET_DEFAULT_DEF, ctx.progName, ['<NAME>']).message);
    return 2;
  }
  const { agents } = loadAgents(ctx.ws, { settings: ctx.settings });
  if (!agents.has(name)) {
    err(ctx, `error: no agent with name ${name} found`);
    return 1;
  }
  try {
    ctx.settings.set('chat.defaultAgent', name, 'global');
  } catch (e) {
    err(ctx, `error: ${errorText(e)}`);
    return 1;
  }
  out(ctx, `✓ Default agent set to '${name}'. This will take effect the next time ${ctx.progName} chat is launched.`);
  return 0;
}

function runMigrate(args: string[], ctx: CliContext): number {
  const p = parseOrExit(AGENT_MIGRATE_DEF, args, ctx);
  if (typeof p === 'number') return p;
  if (!p.has('force')) {
    err(ctx, 'WARNING: manual migrate is potentially destructive to existing agent configs with name collision. Use --force to run');
    return 0;
  }
  const src = path.join(legacyGlobalDir(ctx.ws), 'cli-agents');
  const dst = agentDirs(ctx.ws).global;
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(src)
      .filter((n) => n.toLowerCase().endsWith('.json') && !n.startsWith('.'))
      .sort();
  } catch {
    files = [];
  }
  if (files.length === 0) {
    out(ctx, 'Info: Migration was not performed. Nothing to migrate');
    return 0;
  }
  let n = 0;
  try {
    mkdirp(dst);
    for (const f of files) {
      const from = path.join(src, f);
      if (!fs.statSync(from).isFile()) continue;
      fs.copyFileSync(from, path.join(dst, f));
      n++;
    }
  } catch (e) {
    err(ctx, `Error: Migration did not happen for the following reason: ${errorText(e)}`);
    return 1;
  }
  out(ctx, `✓ Success: Profile migration successful. Migrated ${n} agent(s)`);
  return 0;
}

/** `agent` subcommand runner. */
export async function runAgentCommand(args: string[], ctx: CliContext): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case undefined:
      return runList([], ctx);
    case 'list':
      return runList(rest, ctx);
    case 'create':
      return runCreate(rest, ctx);
    case 'edit':
      return runEdit(rest, ctx);
    case 'validate':
      return runValidate(rest, ctx);
    case 'set-default':
      return runSetDefault(rest, ctx);
    case 'schema': {
      const p = parseOrExit(AGENT_SCHEMA_DEF, rest, ctx);
      if (typeof p === 'number') return p;
      out(ctx, JSON.stringify(AGENT_SCHEMA, null, 2));
      return 0;
    }
    case 'migrate':
      return runMigrate(rest, ctx);
    case 'upgrade':
      err(ctx, 'error: agent upgrade is not supported in kiro-claude: agents in the 2.x format run unchanged');
      return 1;
    case 'help': {
      // clap's generated `help [COMMAND]` subcommand.
      const target = rest.find((a) => !a.startsWith('-'));
      if (target === undefined) return parseOrExit(AGENT_DEF, ['--help'], ctx) as number;
      if (SUBCOMMANDS.some((s) => s.name === target)) return runAgentCommand([target, '--help'], ctx);
      err(ctx, `error: unrecognized subcommand '${target}'\n\nUsage: ${ctx.progName} agent [OPTIONS] [COMMAND]\n\nFor more information, try '--help'.`);
      return 2;
    }
    default: {
      if (sub.startsWith('-')) {
        const p = parseOrExit(AGENT_DEF, args, ctx);
        if (typeof p === 'number') return p;
        return runList([], ctx);
      }
      err(ctx, `error: unrecognized subcommand '${sub}'\n\nUsage: ${ctx.progName} agent [OPTIONS] [COMMAND]\n\nFor more information, try '--help'.`);
      return 2;
    }
  }
}

