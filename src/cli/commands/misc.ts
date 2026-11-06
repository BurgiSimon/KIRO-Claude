/**
 * Small subcommands (01 §2, §2.7–2.8; Q `cli/issue.rs`, `os/diagnostics.rs`):
 *
 * - `issue [--force/-f] [DESCRIPTION...]` prints the prefilled new-issue URL of the kiro-claude
 *   repository (title = description; body = environment summary, no secrets). It does not open
 *   a browser (task spec).
 * - `diagnostic` (alias `diagnostics`) `[--format plain|json|json-pretty] [--force]` prints an
 *   environment summary in Q's sections (`system-info`, `environment` with `in-ssh` / `in-ci` /
 *   `in-wsl` / `in-codespaces` only when true, `env-vars`) plus `kiro-claude-details` and
 *   `claude-code`. DECISION (task spec): the default format is pretty JSON; `plain` renders Q's
 *   TOML layout. Secrets never appear: only allow-listed variables are reported, any variable
 *   whose name looks secret is shown as `<set>`, and `/<username>` is replaced by `/USER`
 *   (Q behaviour).
 * - `profile`: `Profiles are not applicable: kiro-claude uses your Claude Code login`, exit 1.
 * - Kiro desktop/AWS commands with no Claude Code equivalent (`inline`, `translate`,
 *   `integrations`, `autocomplete`, `theme`, `dashboard`, `uninstall`, `voice-serve`,
 *   `voice-cloud-setup`) ⇒ `error: '<cmd>' is not supported in kiro-claude …`, exit 1.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import type { CliContext } from '../../types.js';
import { getAuthStatus } from '../../claude/auth.js';
import { apiKeyOverrides } from '../../claude/env.js';
import { KIRO_CLAUDE_VERSION, KIRO_CLI_COMPAT_VERSION } from '../../version.js';
import type { CommandDef } from '../args.js';
import { err, out, parseOrExit } from '../io.js';
import { authEnv, locateClaude } from './auth.js';
import { OUTPUT_FORMATS, VERBOSE_ARG } from './chatArgs.js';

export const REPO_URL = 'https://github.com/BurgiSimon/KIRO-Claude';

/** Kiro commands kiro-claude recognizes but does not implement. */
export const UNSUPPORTED_COMMANDS: readonly string[] = [
  'inline', 'translate', 'integrations', 'autocomplete', 'theme', 'dashboard', 'uninstall', 'voice-serve', 'voice-cloud-setup',
];

export function unsupportedMessage(cmd: string): string {
  return `error: '${cmd}' is not supported in kiro-claude (a Kiro desktop/AWS feature with no Claude Code equivalent)`;
}

export const PROFILE_MESSAGE = 'Profiles are not applicable: kiro-claude uses your Claude Code login';

export const ISSUE_DEF: CommandDef = {
  name: 'issue',
  about: 'Create a new GitHub issue',
  positionals: [{ id: 'description', valueName: 'DESCRIPTION', multiple: true, help: 'Issue description' }],
  args: [{ id: 'force', long: 'force', short: 'f', kind: 'bool', help: 'Force issue creation' }, VERBOSE_ARG],
};

export const DIAGNOSTIC_DEF: CommandDef = {
  name: 'diagnostic',
  about: 'Run diagnostic tests',
  args: [
    { id: 'format', long: 'format', short: 'f', kind: 'value', valueName: 'FORMAT', possibleValues: OUTPUT_FORMATS, defaultValue: 'json-pretty', help: 'The format of the output' },
    { id: 'force', long: 'force', kind: 'bool', help: 'Force limited diagnostic output' },
    VERBOSE_ARG,
  ],
};

const REPORTED_VARS = [
  'SHELL', 'DISPLAY', 'PATH', 'TERM', 'ZDOTDIR', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'XDG_SESSION_TYPE',
  'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'NO_COLOR', 'FORCE_COLOR',
  'EDITOR', 'PAGER', 'LANG', 'TMPDIR',
];
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION/i;

function username(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

/** Replace `/<username>` with `/USER` (Q). */
export function sanitizeUser(s: string, user = username()): string {
  return user ? s.split(`/${user}`).join('/USER') : s;
}

/** `scheme://user:pass@host` ⇒ `scheme://<redacted>@host` (credentials embedded in URLs). */
export function redactUrlCredentials(s: string): string {
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1<redacted>@');
}

/** Allow-listed environment variables with secrets masked (see module doc). */
export function diagnosticEnvVars(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v === undefined) continue;
    const wanted = REPORTED_VARS.includes(k) || k.startsWith('KIRO_') || k.startsWith('KIROCREW_') || k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN' || k === 'CLAUDE_CODE_OAUTH_TOKEN' || k.startsWith('CLAUDE_CODE_USE_');
    if (!wanted) continue;
    out[k] = SECRET_NAME.test(k) ? '<set>' : sanitizeUser(redactUrlCredentials(v));
  }
  return out;
}

function osDescription(): string {
  if (process.platform === 'linux') {
    try {
      const text = fs.readFileSync('/etc/os-release', 'utf8');
      const m = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(text);
      if (m) return `${m[1]} (Linux ${os.release()})`;
    } catch {
      // fall through
    }
  }
  return `${os.type()} ${os.release()}`;
}

/** Build the diagnostics object (see module doc). */
export async function collectDiagnostics(ctx: CliContext): Promise<Record<string, unknown>> {
  const env = ctx.ws.env;
  const cpus = os.cpus();
  const environment: Record<string, unknown> = {
    cwd: sanitizeUser(ctx.ws.cwd),
    'workspace-root': sanitizeUser(ctx.ws.workspaceRoot),
    'kiro-home': sanitizeUser(ctx.ws.kiroHome),
    'cli-path': sanitizeUser(process.argv[1] ?? ''),
    'install-method': process.argv[1]?.includes('node_modules') ? 'npm' : 'source',
  };
  if (env.SSH_CLIENT || env.SSH_CONNECTION || env.SSH_TTY) environment['in-ssh'] = true;
  if (env.CI) environment['in-ci'] = true;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) environment['in-wsl'] = true;
  if (env.CODESPACES) environment['in-codespaces'] = true;

  const claude: Record<string, unknown> = {};
  const loc = await locateClaude(ctx);
  if (loc.bin) {
    claude.path = sanitizeUser(loc.bin.path);
    claude.version = loc.bin.version;
    try {
      const st = await getAuthStatus(loc.bin, authEnv(ctx));
      claude['logged-in'] = st.loggedIn;
      if (st.authMethod) claude['auth-method'] = st.authMethod;
      if (st.apiProvider) claude['api-provider'] = st.apiProvider;
      if (st.subscriptionType) claude['subscription-type'] = st.subscriptionType;
    } catch (e) {
      claude['auth-error'] = e instanceof Error ? e.message : String(e);
    }
  } else {
    claude.error = sanitizeUser(loc.error ?? 'not found');
  }
  const overrides = apiKeyOverrides(env);
  if (overrides.length > 0) claude['api-key-overrides'] = overrides;

  return {
    'kiro-claude-details': { version: KIRO_CLAUDE_VERSION, 'kiro-cli-compat': KIRO_CLI_COMPAT_VERSION, node: process.version },
    'system-info': {
      os: osDescription(),
      arch: process.arch,
      chip: cpus[0]?.model?.trim() || null,
      'total-cores': cpus.length,
      memory: `${(os.totalmem() / 2 ** 30).toFixed(2)} GB`,
    },
    environment,
    'claude-code': claude,
    'env-vars': diagnosticEnvVars(env),
  };
}

function tomlValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  if (v === null || v === undefined) return '""';
  return JSON.stringify(v);
}

/** Q's TOML rendering of the diagnostics. */
export function diagnosticsToml(d: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [section, body] of Object.entries(d)) {
    if (lines.length) lines.push('');
    lines.push(`[${section}]`);
    for (const [k, v] of Object.entries((body as Record<string, unknown>) ?? {})) {
      if (v === null || v === undefined) continue;
      lines.push(`${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${tomlValue(v)}`);
    }
  }
  return lines.join('\n');
}

export async function runDiagnosticCommand(args: string[], ctx: CliContext): Promise<number> {
  const p = parseOrExit(DIAGNOSTIC_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const format = (p.value('format') ?? 'json-pretty') as 'plain' | 'json' | 'json-pretty';
  const d = await collectDiagnostics(ctx);
  if (format === 'plain') out(ctx, diagnosticsToml(d));
  else out(ctx, format === 'json' ? JSON.stringify(d) : JSON.stringify(d, null, 2));
  return 0;
}

/** URL of a prefilled GitHub issue. */
export function issueUrl(title: string, body: string): string {
  const q = new URLSearchParams();
  if (title) q.set('title', title);
  if (body) q.set('body', body);
  const qs = q.toString();
  return `${REPO_URL}/issues/new${qs ? `?${qs}` : ''}`;
}

export async function runIssueCommand(args: string[], ctx: CliContext): Promise<number> {
  const p = parseOrExit(ISSUE_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const title = p.posAll('description').join(' ').trim();
  const body = [
    '### Description',
    '',
    title || '<describe the problem>',
    '',
    '### Environment',
    '',
    `- kiro-claude ${KIRO_CLAUDE_VERSION} (kiro-cli ${KIRO_CLI_COMPAT_VERSION})`,
    `- Node ${process.version} on ${process.platform} ${process.arch}`,
    '',
    `Attach the output of \`${ctx.progName} diagnostic\` if relevant.`,
  ].join('\n');
  out(ctx, issueUrl(title, body));
  return 0;
}

export async function runProfileCommand(_args: string[], ctx: CliContext): Promise<number> {
  err(ctx, PROFILE_MESSAGE);
  return 1;
}
