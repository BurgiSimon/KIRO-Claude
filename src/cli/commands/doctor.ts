/**
 * `kiro-claude doctor [--all] [--strict]`: checks that kiro-claude can run on this machine
 * (task spec; Kiro 3.0 retired its own `doctor` in favour of `diagnostic` / `issue`, 01 §2, so
 * this is an adapter command with Kiro's name).
 *
 * Checks, in order (each line `✓` ok, `⚠` warning, `✗` problem, `ℹ` hint):
 *  1. kiro-claude version and Node runtime (Node ≥ 18.17);
 *  2. the Claude Code binary (claude/binary findClaudeBinary: `$KIRO_CLAUDE_BIN`,
 *     `kiroClaude.claudePath`, PATH, well-known locations) and its version;
 *  3. the capability probe (claude/binary probeCapabilities): flags the session needs;
 *  4. sign-in (`claude auth status`), with API-key / cloud-provider overrides
 *     (claude/env apiKeyOverrides): kiro-claude removes them from the `claude` environment
 *     unless `kiroClaude.allowApiKey` is set, so they are a warning either way; `KIRO_API_KEY`
 *     is ignored (01 §2.4);
 *  5. configuration warnings: settings files, agents (load failures, conflicts, field errors),
 *     MCP files and agent MCP servers, steering, hooks;
 *  6. MCP command availability: every enabled stdio server's `command` must be on PATH;
 *  7. a hint for the KiroCrew integration: `<prog> crew doctor`.
 *
 * Exit 0 when no `✗` was printed (`--strict`: no `⚠` either), else 1. Output goes to stdout.
 */

import * as path from 'node:path';
import type { CliContext, ConfigWarning, McpServerConfig } from '../../types.js';
import { probeCapabilities } from '../../claude/binary.js';
import { getAuthStatus } from '../../claude/auth.js';
import { apiKeyOverrides } from '../../claude/env.js';
import { loadAgents } from '../../config/agents.js';
import { loadHookFileGroups } from '../../config/hooks.js';
import { loadMcpFile, mcpConfigPaths } from '../../config/mcp.js';
import { loadSteering } from '../../config/steering.js';
import { workspaceKiroDir } from '../../config/workspace.js';
import { findExecutable } from '../../util/process.js';
import { versionLine } from '../../version.js';
import type { CommandDef } from '../args.js';
import { out, parseOrExit } from '../io.js';
import { authEnv, locateClaude } from './auth.js';
import { VERBOSE_ARG } from './chatArgs.js';

export const DOCTOR_DEF: CommandDef = {
  name: 'doctor',
  about: 'Check the kiro-claude and Claude Code setup',
  args: [
    { id: 'all', long: 'all', short: 'a', kind: 'bool', help: 'Show every configuration warning (default: the first 5 per area)' },
    { id: 'strict', long: 'strict', short: 's', kind: 'bool', help: 'Treat warnings as problems (non-zero exit)' },
    VERBOSE_ARG,
  ],
};

/** Claude flags the session relies on (00 §3.1); missing ones are reported. */
export const REQUIRED_CLAUDE_FLAGS: readonly string[] = [
  '--print',
  '--input-format',
  '--output-format',
  '--verbose',
  '--permission-prompt-tool',
  '--include-partial-messages',
  '--permission-mode',
  '--setting-sources',
  '--mcp-config',
  '--strict-mcp-config',
  '--tools',
  '--append-system-prompt-file',
  '--session-id',
  '--resume',
  '--fork-session',
  '--model',
];
/** Flags used when available (older builds degrade). */
export const OPTIONAL_CLAUDE_FLAGS: readonly string[] = ['--system-prompt-snapshot', '--effort', '--resume-session-at', '--plugin-dir', '--agents', '--add-dir', '--disallowedTools'];

type Mark = '✓' | '⚠' | '✗' | 'ℹ';

interface Report {
  lines: string[];
  problems: number;
  warnings: number;
}

function line(r: Report, mark: Mark, text: string): void {
  if (mark === '✗') r.problems++;
  if (mark === '⚠') r.warnings++;
  r.lines.push(`${mark} ${text}`);
}

function nodeOk(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  if (!m) return true;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 18 || (major === 18 && minor >= 17);
}

function listWarnings(r: Report, area: string, warnings: readonly ConfigWarning[], all: boolean): void {
  if (warnings.length === 0) {
    line(r, '✓', `${area}: no problems found`);
    return;
  }
  line(r, '⚠', `${area}: ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
  const shown = all ? warnings : warnings.slice(0, 5);
  for (const w of shown) r.lines.push(`    - ${w.message}`);
  if (shown.length < warnings.length) r.lines.push(`    … ${warnings.length - shown.length} more (use --all)`);
}

/** Run every check and return the report (exported for tests). */
export async function runDoctorChecks(ctx: CliContext, opts: { all?: boolean } = {}): Promise<Report> {
  const r: Report = { lines: [], problems: 0, warnings: 0 };
  const env = ctx.ws.env;
  const all = opts.all === true;

  // 1. runtime
  line(r, nodeOk(process.version) ? '✓' : '✗', `${versionLine()} on Node ${process.version} (${process.platform} ${process.arch})${nodeOk(process.version) ? '' : ' — Node 18.17 or newer is required'}`);

  // 2–3. Claude Code
  const loc = await locateClaude(ctx);
  if (!loc.bin) {
    line(r, '✗', `Claude Code: ${loc.error}`);
  } else {
    line(r, '✓', `Claude Code ${loc.bin.version} at ${loc.bin.path}`);
    try {
      const caps = await probeCapabilities(loc.bin, { env });
      const missing = REQUIRED_CLAUDE_FLAGS.filter((f) => !caps.has(f));
      const optional = OPTIONAL_CLAUDE_FLAGS.filter((f) => !caps.has(f));
      if (missing.length > 0) line(r, '✗', `Claude Code lacks flags kiro-claude needs: ${missing.join(', ')} (update Claude Code: claude update)`);
      else line(r, '✓', 'Claude Code supports the headless protocol kiro-claude uses');
      if (optional.length > 0) line(r, '⚠', `Claude Code lacks optional flags: ${optional.join(', ')} (some features degrade)`);
    } catch (e) {
      line(r, '⚠', `Could not probe Claude Code capabilities: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 4. sign-in
    try {
      const st = await getAuthStatus(loc.bin, authEnv(ctx));
      if (st.loggedIn) {
        line(r, '✓', `Logged in to Claude Code${st.authMethod ? ` (${st.authMethod})` : ''}${st.email ? ` as ${st.email}` : ''}`);
      } else {
        line(r, '✗', `Not logged in to Claude Code. Run "${ctx.progName} login" (claude auth login).`);
      }
    } catch (e) {
      line(r, '✗', `Could not query the Claude Code login: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const overrides = apiKeyOverrides(env);
  if (overrides.length > 0) {
    const allowed = ctx.settings.getBoolean('kiroClaude.allowApiKey', false);
    line(
      r,
      '⚠',
      allowed
        ? `${overrides.join(', ')} ${overrides.length === 1 ? 'is' : 'are'} set and kiroClaude.allowApiKey is true: Claude Code will bill that API key / provider instead of your subscription`
        : `${overrides.join(', ')} ${overrides.length === 1 ? 'is' : 'are'} set: kiro-claude removes ${overrides.length === 1 ? 'it' : 'them'} from the claude environment so your subscription is used (set kiroClaude.allowApiKey true to use ${overrides.length === 1 ? 'it' : 'them'})`,
    );
  }
  if (env.KIRO_API_KEY) line(r, '⚠', 'KIRO_API_KEY is set but ignored: kiro-claude uses your Claude Code login');

  // 5. configuration
  listWarnings(r, `Settings (${ctx.settings.pathFor('chat.defaultModel', 'global')})`, (ctx.settings as { warnings?: ConfigWarning[] }).warnings ?? [], all);
  const agents = loadAgents(ctx.ws, { settings: ctx.settings });
  const failedMessages = new Set([...agents.failed.values()].map((w) => w.message));
  const agentWarnings = agents.warnings.filter((w) => !failedMessages.has(w.message) && (w.code !== 'tools-missing' || all));
  listWarnings(r, `Agents (${agents.agents.size} loaded)`, agentWarnings, all);
  for (const [name, w] of agents.failed) line(r, '✗', `Agent '${name}' could not be loaded: ${w.message}`);

  const paths = mcpConfigPaths(ctx.ws);
  const mcpWarnings: ConfigWarning[] = [];
  const servers: McpServerConfig[] = [];
  const files: Array<[string, 'workspace' | 'global']> = [[paths.global, 'global']];
  if (workspaceKiroDir(ctx.ws)) files.unshift([paths.workspace, 'workspace']);
  for (const [file, origin] of files) {
    const res = loadMcpFile(file, origin, env);
    mcpWarnings.push(...res.warnings);
    servers.push(...Object.values(res.servers));
  }
  for (const a of agents.agents.values()) servers.push(...Object.values(a.mcpServers));
  listWarnings(r, `MCP configuration (${servers.length} server${servers.length === 1 ? '' : 's'})`, mcpWarnings, all);

  // 6. MCP commands
  const checked = new Set<string>();
  for (const s of servers) {
    if (s.disabled || s.type !== 'stdio' || !s.command) continue;
    const key = `${s.name}\u0000${s.command}`;
    if (checked.has(key)) continue;
    checked.add(key);
    const cmd = s.command;
    const found = findExecutable(cmd, { ...env, PATH: env.PATH ?? process.env.PATH });
    const where = s.sourcePath ? ` (${path.basename(path.dirname(s.sourcePath)) === 'agents' ? 'agent ' : ''}${s.sourcePath})` : '';
    if (found) line(r, '✓', `MCP server '${s.name}': ${cmd} found`);
    else line(r, '✗', `MCP server '${s.name}': command '${cmd}' not found on PATH${where}`);
  }

  const steering = loadSteering(ctx.ws);
  listWarnings(r, `Steering (${steering.files.length} file${steering.files.length === 1 ? '' : 's'})`, steering.warnings, all);
  const hooks = loadHookFileGroups(ctx.ws);
  const hookCount = hooks.global.length + hooks.workspace.length + hooks.legacy.length;
  listWarnings(r, `Hooks (${hookCount} in hook files)`, hooks.warnings, all);

  // 7. KiroCrew
  line(r, 'ℹ', `KiroCrew: run '${ctx.progName} crew doctor' to check the KiroCrew integration`);
  return r;
}

export async function runDoctorCommand(args: string[], ctx: CliContext): Promise<number> {
  const p = parseOrExit(DOCTOR_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const r = await runDoctorChecks(ctx, { all: p.has('all') });
  for (const l of r.lines) out(ctx, l);
  out(ctx);
  const strict = p.has('strict');
  const bad = r.problems + (strict ? r.warnings : 0);
  if (bad === 0) out(ctx, r.warnings > 0 ? `No problems found (${r.warnings} warning${r.warnings === 1 ? '' : 's'}).` : 'No problems found.');
  else out(ctx, `Found ${bad} problem${bad === 1 ? '' : 's'}.`);
  return bad === 0 ? 0 : 1;
}
