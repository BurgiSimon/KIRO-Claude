/**
 * `kiro-claude mcp add|remove|list|import|status` (01 §2.2, 02 §5; Q `cli/mcp.rs`, whose
 * behaviour and messages are reproduced with Kiro's file locations):
 *
 *  - `add --name <n> --command <cmd> [--args …]… [--env k=v,…]… [--timeout ms] [--disabled]
 *    [--force] [--scope workspace|global] [--agent <agent>]`: writes
 *    `{command, args, env, timeout, disabled}` (Q: `timeout` defaults to 120000) into the
 *    agent's file (`--agent`), the workspace `.kiro/settings/mcp.json` (`--scope workspace`) or
 *    the global `~/.kiro/settings/mcp.json` (default, as Q). `--args` accepts repeated flags,
 *    comma lists with `\,` escapes, or a JSON array (Q `parse_args`); `--env` takes `k=v,…`.
 *    Extension: `--url <url>` (instead of `--command`) adds a remote (http) server.
 *    Existing name without `--force` ⇒ Q's `MCP server '<n>' already exists in … Use --force to
 *    overwrite.`, exit 1;
 *  - `remove|rm --name <n> [--scope] [--agent]`: Q's `✓ Removed MCP server …` /
 *    `No MCP server named '<n>' found in …`;
 *  - `list [workspace|global]`: per scope its file and servers (`    • <name:<12> <command>`,
 *    ` (disabled)`), or `No MCP server configurations found.`; agent-defined servers are listed
 *    under their agent;
 *  - `import --file <f> [workspace|global] [--force]` (default workspace, as Q): copies every
 *    server of `<f>` (`{"mcpServers":{…}}`) into the scope file;
 *  - `status --name <n>`: the server's configuration in Q's layout, then a live check: a
 *    `claude` child is started with only that server (`--strict-mcp-config --mcp-config`) and
 *    its MCP status is read through the control protocol (no user turn, no model call).
 *
 * Q writes these messages to stderr (`Self::Mcp(args) => args.execute(os, &mut stderr())`);
 * kiro-claude does the same, except for `list` and `status`, whose output is data (stdout).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CliContext, KiroAgent, McpServerConfig } from '../../types.js';
import { buildChildEnv } from '../../claude/env.js';
import { ClaudeProcess } from '../../claude/process.js';
import { loadAgents } from '../../config/agents.js';
import { addMcpServer, loadMcpFile, mcpConfigPaths, readMcpFileRaw, removeMcpServer, toClaudeMcpConfig } from '../../config/mcp.js';
import { setOwn } from '../../config/diag.js';
import { parseJsonText, writeJsonAtomic } from '../../util/fsx.js';
import { expandTilde } from '../../util/paths.js';
import { missingRequired, type CommandDef, type SubcommandInfo } from '../args.js';
import { err, errorText, out, parseOrExit } from '../io.js';
import { locateClaude } from './auth.js';
import { VERBOSE_ARG } from './chatArgs.js';

export const MCP_DEFAULT_TIMEOUT_MS = 120_000;
const SCOPES = ['default', 'workspace', 'global'];
const MCP_SAFETY = 'To learn more about MCP safety, see https://kiro.dev/docs/mcp/security';

const SUBCOMMANDS: SubcommandInfo[] = [
  { name: 'add', about: 'Add or replace a configured server' },
  { name: 'remove', about: 'Remove a server from the MCP configuration', aliases: ['rm'] },
  { name: 'list', about: 'List configured servers' },
  { name: 'import', about: 'Import a server configuration from another file' },
  { name: 'status', about: 'Get the status of a configured server' },
];

export const MCP_DEF: CommandDef = { name: 'mcp', about: 'Model Context Protocol (MCP)', usage: '<COMMAND>', args: [VERBOSE_ARG], subcommands: SUBCOMMANDS };

const SCOPE_ARG = {
  id: 'scope',
  long: 'scope',
  kind: 'value' as const,
  valueName: 'SCOPE',
  possibleValues: SCOPES,
  help: 'Scope. This parameter is only meaningful in the absence of agent name.',
};

export const MCP_ADD_DEF: CommandDef = {
  name: 'mcp add',
  about: 'Add or replace a configured server',
  args: [
    { id: 'name', long: 'name', kind: 'value', valueName: 'NAME', help: 'Name for the server' },
    SCOPE_ARG,
    { id: 'command', long: 'command', kind: 'value', valueName: 'COMMAND', help: 'The command used to launch the server' },
    { id: 'url', long: 'url', kind: 'value', valueName: 'URL', help: 'URL of a remote (HTTP) server, instead of --command' },
    {
      id: 'args',
      long: 'args',
      kind: 'value',
      valueName: 'ARGS',
      multiple: true,
      allowHyphenValues: true,
      help: 'Arguments to pass to the command: repeated --args flags, a comma list with \\, escapes, or a JSON array',
    },
    { id: 'agent', long: 'agent', kind: 'value', valueName: 'AGENT', help: 'Add the server to this agent instead of an mcp.json file' },
    { id: 'env', long: 'env', kind: 'value', valueName: 'ENV', multiple: true, allowHyphenValues: true, help: 'Environment variables to use when launching the server (name=value,…)' },
    { id: 'timeout', long: 'timeout', kind: 'value', valueName: 'TIMEOUT', help: 'Server launch timeout, in milliseconds' },
    { id: 'disabled', long: 'disabled', kind: 'bool', help: 'Whether the server should be disabled (not loaded)' },
    { id: 'force', long: 'force', kind: 'bool', help: 'Overwrite an existing server with the same name' },
    VERBOSE_ARG,
  ],
};

export const MCP_REMOVE_DEF: CommandDef = {
  name: 'mcp remove',
  about: 'Remove a server from the MCP configuration',
  args: [
    { id: 'name', long: 'name', kind: 'value', valueName: 'NAME', help: 'Name of the server' },
    SCOPE_ARG,
    { id: 'agent', long: 'agent', kind: 'value', valueName: 'AGENT', help: 'Remove the server from this agent' },
    VERBOSE_ARG,
  ],
};

export const MCP_LIST_DEF: CommandDef = {
  name: 'mcp list',
  about: 'List configured servers',
  positionals: [{ id: 'scope', valueName: 'SCOPE', help: 'Only this scope (workspace or global)' }],
  args: [VERBOSE_ARG],
};

export const MCP_IMPORT_DEF: CommandDef = {
  name: 'mcp import',
  about: 'Import a server configuration from another file',
  positionals: [{ id: 'scope', valueName: 'SCOPE', help: 'Scope to import into (workspace, the default, or global)' }],
  args: [
    { id: 'file', long: 'file', kind: 'value', valueName: 'FILE', help: 'File with an "mcpServers" object' },
    { id: 'force', long: 'force', kind: 'bool', help: 'Overwrite an existing server with the same name' },
    VERBOSE_ARG,
  ],
};

export const MCP_STATUS_DEF: CommandDef = {
  name: 'mcp status',
  about: 'Get the status of a configured server',
  args: [
    { id: 'name', long: 'name', kind: 'value', valueName: 'NAME', help: 'Name of the server' },
    { id: 'no-check', long: 'no-check', kind: 'bool', help: 'Only show the configuration (do not start the server)' },
    VERBOSE_ARG,
  ],
};

/** Q `parse_args`: JSON array, comma list with `\,` escapes, or plain comma split. */
export function parseMcpArgs(arg: string): { args?: string[]; error?: string } {
  if (arg.trimStart().startsWith('[')) {
    try {
      const v = JSON.parse(arg) as unknown;
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return { args: v as string[] };
    } catch {
      // fall through
    }
    return { error: `Failed to parse arguments as JSON array. Expected format: '["arg1", "arg2", "arg,with,commas"]'` };
  }
  if (arg.includes('\\,')) {
    const out: string[] = [];
    let cur = '';
    for (let i = 0; i < arg.length; i++) {
      const ch = arg[i]!;
      if (ch === '\\') {
        const next = arg[i + 1];
        if (next === ',' || next === '\\') {
          cur += next;
          i++;
        } else cur += ch;
      } else if (ch === ',') {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur !== '' || out.length > 0) out.push(cur.trim());
    return { args: out };
  }
  return { args: arg.split(',').map((s) => s.trim()) };
}

/** Q `parse_env_vars`: `k=v,k2=v2`. */
export function parseMcpEnv(arg: string): { env?: Record<string, string>; error?: string } {
  const env: Record<string, string> = {};
  for (const pair of arg.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) return { error: `Failed to parse environment variables, invalid environment variable '${pair}'. Expected 'name=value'` };
    setOwn(env, pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return { env };
}

function scopePath(ctx: CliContext, scope: string | undefined, defaultScope: 'global' | 'workspace'): { file: string; label: 'workspace' | 'global' } {
  const paths = mcpConfigPaths(ctx.ws);
  const s = scope === 'workspace' || scope === 'global' ? scope : defaultScope;
  return s === 'workspace' ? { file: paths.workspace, label: 'workspace' } : { file: paths.global, label: 'global' };
}

function findAgentFile(ctx: CliContext, name: string): { agent?: KiroAgent; error?: string } {
  const { agents } = loadAgents(ctx.ws, { settings: ctx.settings });
  const a = agents.get(name);
  if (!a) return { error: `No agent with name ${name} found` };
  if (!a.path || a.format !== 'json') return { error: `Agent ${name} has no JSON config file to edit` };
  return { agent: a };
}

function readAgentJson(file: string): Record<string, unknown> {
  const v = parseJsonText<unknown>(fs.readFileSync(file, 'utf8'), file);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${file}: expected a JSON object`);
  return v as Record<string, unknown>;
}

async function runAdd(args: string[], ctx: CliContext): Promise<number> {
  const p = parseOrExit(MCP_ADD_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const name = p.value('name');
  const command = p.value('command');
  const url = p.value('url');
  const missing = [...(name === undefined ? ['--name <NAME>'] : []), ...(command === undefined && url === undefined ? ['--command <COMMAND>'] : [])];
  if (missing.length > 0) {
    err(ctx, missingRequired(MCP_ADD_DEF, ctx.progName, missing).message);
    return 2;
  }
  const argv: string[] = [];
  for (const a of p.valuesOf('args')) {
    const r = parseMcpArgs(a);
    if (r.error) {
      err(ctx, `error: ${r.error}`);
      return 1;
    }
    argv.push(...r.args!);
  }
  const env: Record<string, string> = {};
  for (const e of p.valuesOf('env')) {
    const r = parseMcpEnv(e);
    if (r.error) {
      err(ctx, `error: invalid value '${e}' for '--env <ENV>': ${r.error}\n\nFor more information, try '--help'.`);
      return 2;
    }
    Object.assign(env, r.env);
  }
  let timeout = MCP_DEFAULT_TIMEOUT_MS;
  const t = p.value('timeout');
  if (t !== undefined) {
    if (!/^\d+$/.test(t)) {
      err(ctx, `error: invalid value '${t}' for '--timeout <TIMEOUT>': invalid digit found in string\n\nFor more information, try '--help'.`);
      return 2;
    }
    timeout = Number(t);
  }
  const entry: Record<string, unknown> =
    url !== undefined && command === undefined
      ? { type: 'http', url, headers: {}, timeout, disabled: p.has('disabled') }
      : { command, args: argv, env, timeout, disabled: p.has('disabled') };
  const force = p.has('force');

  const agentName = p.value('agent');
  if (agentName !== undefined) {
    const f = findAgentFile(ctx, agentName);
    if (!f.agent) {
      err(ctx, `error: ${f.error}`);
      return 1;
    }
    const file = f.agent.path!;
    try {
      const raw = readAgentJson(file);
      const servers = (typeof raw.mcpServers === 'object' && raw.mcpServers !== null && !Array.isArray(raw.mcpServers) ? raw.mcpServers : {}) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(servers, name!) && !force) {
        err(ctx, `error: \nMCP server '${name}' already exists in agent ${agentName} (path ${file}). Use --force to overwrite.`);
        return 1;
      }
      setOwn(servers, name!, entry);
      raw.mcpServers = servers;
      writeJsonAtomic(file, raw);
    } catch (e) {
      err(ctx, `error: ${errorText(e)}`);
      return 1;
    }
    err(ctx, `✓ Added MCP server '${name}' to agent ${agentName}\n`);
    return 0;
  }
  const { file, label } = scopePath(ctx, p.value('scope'), 'global');
  try {
    addMcpServer(file, name!, entry, { force });
  } catch (e) {
    const msg = errorText(e);
    if (/already exists/.test(msg)) err(ctx, `error: \nMCP server '${name}' already exists in ${label} config (path ${file}). Use --force to overwrite.`);
    else err(ctx, `error: ${msg}`);
    return 1;
  }
  err(ctx, `✓ Added MCP server '${name}' to ${label} config in ${file}\n`);
  return 0;
}

async function runRemove(args: string[], ctx: CliContext): Promise<number> {
  const p = parseOrExit(MCP_REMOVE_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const name = p.value('name');
  if (name === undefined) {
    err(ctx, missingRequired(MCP_REMOVE_DEF, ctx.progName, ['--name <NAME>']).message);
    return 2;
  }
  const agentName = p.value('agent');
  if (agentName !== undefined) {
    const f = findAgentFile(ctx, agentName);
    if (!f.agent) {
      err(ctx, `error: ${f.error}`);
      return 1;
    }
    const file = f.agent.path!;
    try {
      const raw = readAgentJson(file);
      const servers = raw.mcpServers as Record<string, unknown> | undefined;
      if (!servers || typeof servers !== 'object' || !Object.prototype.hasOwnProperty.call(servers, name)) {
        err(ctx, `\nNo MCP server named '${name}' found in agent ${agentName}\n`);
        return 1;
      }
      delete servers[name];
      writeJsonAtomic(file, raw);
    } catch (e) {
      err(ctx, `error: ${errorText(e)}`);
      return 1;
    }
    err(ctx, `\n✓ Removed MCP server '${name}' from agent ${agentName}\n`);
    return 0;
  }
  const { file, label } = scopePath(ctx, p.value('scope'), 'global');
  let removed: boolean;
  try {
    removed = removeMcpServer(file, name);
  } catch (e) {
    err(ctx, `error: ${errorText(e)}`);
    return 1;
  }
  if (!removed) {
    err(ctx, `\nNo MCP server named '${name}' found in ${label} config (path ${file})\n`);
    return 1;
  }
  err(ctx, `\n✓ Removed MCP server '${name}' from ${label} config (path ${file})\n`);
  return 0;
}

function serverLine(name: string, s: McpServerConfig): string {
  const what = s.type === 'stdio' ? [s.command ?? '', ...s.args].join(' ').trim() : (s.url ?? '');
  return `    • ${name.padEnd(12)} ${what}${s.disabled ? ' (disabled)' : ''}`;
}

async function runList(args: string[], ctx: CliContext): Promise<number> {
  const p = parseOrExit(MCP_LIST_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const wantArg = p.pos('scope');
  if (wantArg !== undefined && !SCOPES.includes(wantArg)) {
    err(ctx, `error: invalid value '${wantArg}' for '[SCOPE]'\n  [possible values: ${SCOPES.join(', ')}]\n\nFor more information, try '--help'.`);
    return 2;
  }
  // `default` is the global file, as for `add` / `remove --scope default` (scopePath).
  const want = wantArg === 'default' ? 'global' : wantArg;
  const paths = mcpConfigPaths(ctx.ws);
  const sections: Array<{ label: string; file?: string; servers: Record<string, McpServerConfig>; agent?: string }> = [];
  const scopes: Array<['workspace' | 'global', string]> = [
    ['workspace', paths.workspace],
    ['global', paths.global],
  ];
  const warnings: string[] = [];
  for (const [label, file] of scopes) {
    if (want !== undefined && want !== label) continue;
    if (label === 'workspace' && path.resolve(file) === path.resolve(paths.global)) continue;
    const r = loadMcpFile(file, label, ctx.ws.env);
    for (const w of r.warnings) if (w.code !== 'mcp-env-unset') warnings.push(w.message);
    if (fs.existsSync(file)) sections.push({ label, file, servers: r.servers });
  }
  if (want === undefined || want === 'workspace' || want === 'global') {
    const { agents } = loadAgents(ctx.ws, { settings: ctx.settings });
    for (const a of agents.values()) {
      if (Object.keys(a.mcpServers).length === 0 || !a.path) continue;
      const scope = a.scope === 'workspace' ? 'workspace' : 'global';
      if (want !== undefined && want !== scope) continue;
      sections.push({ label: scope, agent: a.name, file: a.path, servers: a.mcpServers });
    }
  }
  for (const w of warnings) err(ctx, w);
  if (sections.length === 0) {
    out(ctx, 'No MCP server configurations found.\n');
    return 0;
  }
  const lines: string[] = [];
  for (const s of sections) {
    lines.push('', `${s.label === 'workspace' ? '📄 workspace' : '🌍 global'}${s.agent ? ` (agent ${s.agent})` : ''}:`, '', `  ${s.file}`);
    const names = Object.keys(s.servers).sort();
    if (names.length === 0) lines.push('    (empty)');
    for (const n of names) lines.push(serverLine(n, s.servers[n]!));
  }
  lines.push('');
  out(ctx, lines.join('\n'));
  return 0;
}

async function runImport(args: string[], ctx: CliContext): Promise<number> {
  const p = parseOrExit(MCP_IMPORT_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const src = p.value('file');
  if (src === undefined) {
    err(ctx, missingRequired(MCP_IMPORT_DEF, ctx.progName, ['--file <FILE>']).message);
    return 2;
  }
  const scopeArg = p.pos('scope');
  if (scopeArg !== undefined && !SCOPES.includes(scopeArg)) {
    err(ctx, `error: invalid value '${scopeArg}' for '[SCOPE]'\n  [possible values: ${SCOPES.join(', ')}]\n\nFor more information, try '--help'.`);
    return 2;
  }
  const { file, label } = scopePath(ctx, scopeArg, 'workspace');
  const srcPath = path.resolve(ctx.ws.cwd, expandTilde(src, ctx.ws.env));
  let source: Record<string, unknown>;
  let dest: ReturnType<typeof readMcpFileRaw>;
  try {
    if (!fs.existsSync(srcPath)) throw new Error(`${srcPath}: file not found`);
    source = readMcpFileRaw(srcPath).mcpServers;
    dest = readMcpFileRaw(file);
  } catch (e) {
    err(ctx, `error: ${errorText(e)}`);
    return 1;
  }
  if (!fs.existsSync(file)) err(ctx, `\n📁 Created MCP config in '${file}'`);
  let added = 0;
  for (const [name, cfg] of Object.entries(source)) {
    if (Object.prototype.hasOwnProperty.call(dest.mcpServers, name) && !p.has('force')) {
      err(ctx, `error: \nMCP server '${name}' already exists in ${file} (scope ${label}). Use --force to overwrite.\n`);
      return 1;
    }
    setOwn(dest.mcpServers, name, cfg);
    added++;
  }
  err(ctx, `\n${MCP_SAFETY}\n\n`);
  try {
    writeJsonAtomic(file, dest);
  } catch (e) {
    err(ctx, `error: ${errorText(e)}`);
    return 1;
  }
  err(ctx, `✓ Imported ${added} MCP server(s) into ${label === 'workspace' ? '📄 workspace' : '🌍 global'}\n`);
  return 0;
}

/** All configured definitions of a server: `[scope label, agent?, config]`. */
function findServerConfigs(ctx: CliContext, name: string): Array<{ scope: string; agent?: string; server: McpServerConfig }> {
  const out: Array<{ scope: string; agent?: string; server: McpServerConfig }> = [];
  const paths = mcpConfigPaths(ctx.ws);
  for (const [label, file] of [
    ['workspace', paths.workspace],
    ['global', paths.global],
  ] as const) {
    if (label === 'workspace' && path.resolve(file) === path.resolve(paths.global)) continue;
    const r = loadMcpFile(file, label, ctx.ws.env);
    const s = r.servers[name];
    if (s) out.push({ scope: label === 'workspace' ? '📄 workspace' : '🌍 global', server: s });
  }
  const { agents } = loadAgents(ctx.ws, { settings: ctx.settings });
  for (const a of agents.values()) {
    const s = Object.prototype.hasOwnProperty.call(a.mcpServers, name) ? a.mcpServers[name] : undefined;
    if (s) out.push({ scope: a.scope === 'workspace' ? '📄 workspace' : '🌍 global', agent: a.name, server: s });
  }
  return out;
}

/** Start `claude` with only `server` and read its MCP status (no user turn). */
export async function liveMcpStatus(ctx: CliContext, server: McpServerConfig, timeoutMs = 30_000): Promise<{ status: string; tools?: number; error?: string }> {
  const loc = await locateClaude(ctx);
  if (!loc.bin) return { status: 'unknown', error: loc.error ?? 'Claude Code not found' };
  const cfg = toClaudeMcpConfig([{ ...server, disabled: false }]);
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio', '--setting-sources', '', '--strict-mcp-config',
    '--mcp-config', JSON.stringify(cfg), '--tools', '', '--no-session-persistence',
  ];
  let proc: ClaudeProcess | undefined;
  try {
    proc = await ClaudeProcess.start({
      binary: loc.bin,
      args,
      cwd: ctx.ws.cwd,
      env: buildChildEnv(ctx.ws.env, { allowApiKey: ctx.settings.getBoolean('kiroClaude.allowApiKey', false) }),
      initialize: {},
      handlers: {
        onHookCallback: async () => ({}),
        onCanUseTool: async () => ({ behavior: 'deny', message: 'not available' }),
      },
      initializeTimeoutMs: timeoutMs,
    });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const st = await proc.mcpStatus();
      const e = st.mcpServers[0];
      if (!e) return { status: 'unknown', error: 'Claude Code did not report the server' };
      if (e.status !== 'pending' || Date.now() >= deadline) {
        return { status: e.status, ...(e.tools ? { tools: e.tools.length } : {}), ...(e.error ? { error: e.error } : {}) };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (e) {
    return { status: 'unknown', error: errorText(e) };
  } finally {
    await proc?.close().catch(() => undefined);
  }
}

async function runStatus(args: string[], ctx: CliContext): Promise<number> {
  const p = parseOrExit(MCP_STATUS_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const name = p.value('name');
  if (name === undefined) {
    err(ctx, missingRequired(MCP_STATUS_DEF, ctx.progName, ['--name <NAME>']).message);
    return 2;
  }
  const found = findServerConfigs(ctx, name);
  if (found.length === 0) {
    err(ctx, `error: No MCP server named '${name}' found in any agent\n`);
    return 1;
  }
  const lines: string[] = [];
  for (const f of found) {
    const s = f.server;
    const envText = Object.keys(s.env).length ? Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join(', ') : '(none)';
    lines.push(
      '',
      '─────────────',
      `Scope   : ${f.scope}`,
      `Agent   : ${f.agent ?? '(mcp.json)'}`,
      s.type === 'stdio' ? `Command : ${[s.command ?? '', ...s.args].join(' ').trim()}` : `URL     : ${s.url ?? ''}`,
      `Timeout : ${s.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS} ms`,
      `Disabled: ${s.disabled}`,
      `Env Vars: ${envText}`,
    );
  }
  out(ctx, lines.join('\n'));
  if (p.has('no-check')) return 0;
  const target = found[0]!.server;
  if (target.disabled) {
    out(ctx, '\nStatus  : disabled');
    return 0;
  }
  const r = await liveMcpStatus(ctx, target);
  out(ctx, `\nStatus  : ${r.status}${r.tools !== undefined ? ` (${r.tools} ${r.tools === 1 ? 'tool' : 'tools'})` : ''}${r.error ? ` — ${r.error}` : ''}`);
  return r.status === 'connected' ? 0 : 1;
}

/** `mcp` subcommand runner. */
export async function runMcpCommand(args: string[], ctx: CliContext): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'add':
      return runAdd(rest, ctx);
    case 'remove':
    case 'rm':
      return runRemove(rest, ctx);
    case 'list':
      return runList(rest, ctx);
    case 'import':
      return runImport(rest, ctx);
    case 'status':
      return runStatus(rest, ctx);
    case 'help': {
      // clap's generated `help [COMMAND]` subcommand (listed in the error above).
      const target = rest.find((a) => !a.startsWith('-'));
      if (target === undefined) return parseOrExit(MCP_DEF, ['--help'], ctx) as number;
      if (['add', 'remove', 'rm', 'list', 'import', 'status'].includes(target)) return runMcpCommand([target, '--help'], ctx);
      err(ctx, `error: unrecognized subcommand '${target}'\n\nUsage: ${ctx.progName} mcp <COMMAND>\n\nFor more information, try '--help'.`);
      return 2;
    }
    default: {
      if (sub === undefined || sub.startsWith('-')) {
        const p = parseOrExit(MCP_DEF, args, ctx);
        if (typeof p === 'number') return p;
        // `mcp` without a subcommand: clap prints help to stderr, exit 2.
        err(ctx, `error: '${ctx.progName} mcp' requires a subcommand but one was not provided\n  [subcommands: add, remove, list, import, status, help]\n\nUsage: ${ctx.progName} mcp <COMMAND>\n\nFor more information, try '--help'.`);
        return 2;
      }
      err(ctx, `error: unrecognized subcommand '${sub}'\n\nUsage: ${ctx.progName} mcp <COMMAND>\n\nFor more information, try '--help'.`);
      return 2;
    }
  }
}

