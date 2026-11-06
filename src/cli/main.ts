/**
 * kiro-claude command-line front end (01 §1–3, 00 §2.1, 08 §2.2).
 *
 * `main(argv)` (argv = process.argv.slice(2)):
 *  - root flags before the subcommand: `-v`/`--verbose` (count; raises the file log level,
 *    util/log levelFromVerbosity — logs never go to stdout), `-h`/`--help` (root help),
 *    `-V`/`--version` (`kiro-claude 0.1.0 (kiro-cli 1.26.0)`, 08 KC-CLI-01 — the fast path
 *    loads nothing else; with `-v` also `Claude Code <version> (<path>)`, 01 §1.1),
 *    `--help-all` (help of every subcommand);
 *  - no subcommand ⇒ `chat`, and chat flags are accepted at the root (`kiro-claude --agent x`,
 *    `kiro-claude --resume-id <id>`, `kiro-claude "question"`) (01 §1);
 *  - `help [COMMAND]` prints the root help or the help of COMMAND;
 *  - subcommands: chat, agent, mcp, settings (alias setting), login, logout, whoami, doctor,
 *    update, version, issue, diagnostic (alias diagnostics), acp (src/acp/server.ts),
 *    spec (src/spec/cli.ts), crew (src/crew/cli.ts); `profile` and Kiro desktop/AWS commands
 *    (`inline`, `translate`, `integrations`, …) print a "not supported in kiro-claude" message,
 *    exit 1. Subcommand modules are imported lazily so probes stay fast (08 KC-BIN-05);
 *  - the program name in messages is `kiro-cli` when invoked through a `kiro-cli*`-named link,
 *    else `kiro-claude` (types CliContext.progName);
 *  - the CliContext is built from createWorkspaceContext + openSettings (no file is read until a
 *    command needs it).
 *
 * Exit codes: the subcommand's; clap usage errors 2; uncaught errors print `error: <msg>`
 * (Q `main.rs`) and exit 1.
 */

import * as path from 'node:path';
import type { CliContext, SubcommandRunner } from '../types.js';
import { createWorkspaceContext } from '../config/workspace.js';
import { openSettings } from '../config/settings.js';
import { levelFromVerbosity, log } from '../util/log.js';
import { versionLine } from '../version.js';
import { UsageError, renderHelp, type CommandDef } from './args.js';
import { CHAT_ABOUT, CHAT_DEF, chatValueFlags } from './commands/chatArgs.js';
import { loadAcpCommand, loadCrewCommand, loadSpecCommand } from './entries.js';

interface Entry {
  name: string;
  aliases?: string[];
  about: string;
  hidden?: boolean;
  load: () => Promise<SubcommandRunner>;
}

/** Subcommand table (help order). */
export const COMMANDS: readonly Entry[] = [
  { name: 'chat', about: CHAT_ABOUT, load: async () => (await import('./commands/chat.js')).runChatCommand },
  { name: 'agent', about: 'Manage agents', load: async () => (await import('./commands/agent.js')).runAgentCommand },
  { name: 'mcp', about: 'Model Context Protocol (MCP)', load: async () => (await import('./commands/mcp.js')).runMcpCommand },
  { name: 'settings', aliases: ['setting'], about: 'Customize appearance & behavior', load: async () => (await import('./commands/settings.js')).runSettingsCommand },
  { name: 'spec', about: 'Kiro specs: requirements, design and tasks', load: loadSpecCommand },
  { name: 'login', about: 'Sign in to Claude Code (claude auth login)', load: async () => (await import('./commands/auth.js')).runLoginCommand },
  { name: 'logout', about: 'Sign out of Claude Code (claude auth logout)', load: async () => (await import('./commands/auth.js')).runLogoutCommand },
  { name: 'whoami', about: 'Print info about the current login session', load: async () => (await import('./commands/auth.js')).runWhoamiCommand },
  { name: 'doctor', about: 'Check the kiro-claude and Claude Code setup', load: async () => (await import('./commands/doctor.js')).runDoctorCommand },
  { name: 'diagnostic', aliases: ['diagnostics'], about: 'Run diagnostic tests', load: async () => (await import('./commands/misc.js')).runDiagnosticCommand },
  { name: 'issue', about: 'Create a new GitHub issue', load: async () => (await import('./commands/misc.js')).runIssueCommand },
  { name: 'update', about: 'Update kiro-claude (no-op: use your package manager)', load: async () => (await import('./commands/version.js')).runUpdateCommand },
  { name: 'version', about: 'Show version information', load: async () => (await import('./commands/version.js')).runVersionCommand },
  { name: 'acp', about: 'Run as an Agent Client Protocol (ACP) agent over stdio', load: loadAcpCommand },
  { name: 'crew', about: 'Run KiroCrew on Claude Code', load: loadCrewCommand },
  { name: 'profile', about: 'Not applicable (Claude Code login)', hidden: true, load: async () => (await import('./commands/misc.js')).runProfileCommand },
];

/** Kiro commands recognized but not supported (01 §2: desktop/AWS features). */
export const NOT_SUPPORTED: readonly string[] = [
  'inline', 'translate', 'integrations', 'autocomplete', 'theme', 'dashboard', 'uninstall', 'voice-serve', 'voice-cloud-setup',
];

export const ROOT_ABOUT = 'Kiro CLI on your installed Claude Code: every model call runs on your Claude Code login';

export const ROOT_DEF: CommandDef = {
  name: '',
  about: ROOT_ABOUT,
  args: [
    { id: 'verbose', long: 'verbose', short: 'v', kind: 'count', help: 'Increase logging verbosity' },
    { id: 'help-all', long: 'help-all', kind: 'bool', help: 'Print help for all subcommands' },
    { id: 'help', long: 'help', short: 'h', kind: 'bool', help: 'Print help' },
    { id: 'version', long: 'version', short: 'V', kind: 'bool', help: 'Print version' },
  ],
  subcommands: [
    ...COMMANDS.map((c) => ({ name: c.name, about: c.about, ...(c.hidden ? { hidden: true } : {}) })),
    { name: 'help', about: 'Print this message or the help of the given subcommand(s)' },
  ],
  afterHelp: [
    'Without a command, kiro-claude starts `chat`; chat options are accepted here too',
    '(e.g. `kiro-claude --agent my-agent`, `kiro-claude --resume`).',
    '',
    `Not supported in kiro-claude: ${NOT_SUPPORTED.join(', ')}, profile.`,
  ].join('\n'),
};

/** I/O and environment for {@link runCli} (defaults: the real process). */
export interface CliIo {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Path the program was invoked as (default `process.argv[1]`). */
  argv1?: string;
}

/** `kiro-cli` when invoked through a `kiro-cli*`-named link, else `kiro-claude`. */
export function progNameFrom(argv1: string | undefined): string {
  if (!argv1) return 'kiro-claude';
  const base = path.basename(argv1).replace(/\.(m?js|cjs|ts|cmd|exe|bat|ps1)$/i, '');
  return base.startsWith('kiro-cli') ? 'kiro-cli' : 'kiro-claude';
}

/** Build the {@link CliContext} for a command invocation. */
export function createCliContext(io: CliIo, verbosity: number): CliContext {
  const env = io.env ?? process.env;
  const ws = createWorkspaceContext(io.cwd, env);
  return {
    ws,
    settings: openSettings(ws),
    stdin: io.stdin ?? process.stdin,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    progName: progNameFrom(io.argv1 ?? process.argv[1]),
    verbosity,
  };
}

function findCommand(name: string): Entry | undefined {
  return COMMANDS.find((c) => c.name === name || (c.aliases ?? []).includes(name));
}

/** Result of the root pre-scan (exported for tests). */
export interface RootScan {
  verbose: number;
  help?: 'short' | 'long';
  version: boolean;
  helpAll: boolean;
  /** Subcommand name as typed (undefined ⇒ chat by default). */
  command?: string;
  /** Arguments for the subcommand (for chat by default: every non-root token). */
  args: string[];
  /** Chat flags seen before an explicit subcommand. */
  chatFlags: string[];
}

/** Separate root flags, the subcommand and its arguments (see module doc). */
export function scanRoot(argv: readonly string[]): RootScan {
  const r: RootScan = { verbose: 0, version: false, helpAll: false, args: [], chatFlags: [] };
  const values = chatValueFlags();
  let i = 0;
  while (i < argv.length) {
    const t = argv[i]!;
    if (t === '--') break;
    if (t === '--verbose' || /^-v+$/.test(t)) {
      r.verbose += t === '--verbose' ? 1 : t.length - 1;
      i++;
      continue;
    }
    if (t === '-h' || t === '--help') {
      r.help ??= t === '-h' ? 'short' : 'long';
      i++;
      continue;
    }
    if (t === '-V' || t === '--version') {
      r.version = true;
      i++;
      continue;
    }
    if (t === '--help-all') {
      r.helpAll = true;
      i++;
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      r.chatFlags.push(t);
      i++;
      if (t.startsWith('--')) {
        if (!t.includes('=') && values.long.has(t.slice(2)) && i < argv.length) r.chatFlags.push(argv[i++]!);
      } else {
        // short cluster: a value flag consumes the rest of the token or the next token
        for (let k = 1; k < t.length; k++) {
          if (values.short.has(t[k]!)) {
            if (k === t.length - 1 && i < argv.length) r.chatFlags.push(argv[i++]!);
            break;
          }
        }
      }
      continue;
    }
    // first positional
    if (findCommand(t) || NOT_SUPPORTED.includes(t) || t === 'help') {
      r.command = t;
      r.args = argv.slice(i + 1);
      return r;
    }
    break;
  }
  r.args = [...r.chatFlags, ...argv.slice(i)];
  r.chatFlags = [];
  return r;
}

async function helpAll(ctx: CliContext): Promise<number> {
  ctx.stdout.write(renderHelp(ROOT_DEF, ctx.progName, 'long'));
  for (const c of COMMANDS) {
    if (c.hidden) continue;
    ctx.stdout.write(`\n${'─'.repeat(10)} ${ctx.progName} ${c.name} ${'─'.repeat(10)}\n\n`);
    try {
      const run = await c.load();
      await run(['--help'], ctx);
    } catch (e) {
      ctx.stdout.write(`(${e instanceof Error ? e.message : String(e)})\n`);
    }
  }
  return 0;
}

/** Run the CLI with explicit I/O (tests, embedding). See module doc. */
export async function runCli(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const scan = scanRoot(argv);
  if (scan.version && scan.verbose === 0) {
    // KiroCrew probe fast path (08 KC-CLI-01 / KC-BIN-05): one line, nothing else loaded.
    (io.stdout ?? process.stdout).write(`${versionLine()}\n`);
    return 0;
  }
  const ctx = createCliContext(io, scan.verbose);
  if (scan.verbose > 0) log.setLevel(levelFromVerbosity(scan.verbose, log.level));
  try {
    // `-v --version`: also the backing Claude Code version (01 §1.1).
    if (scan.version) return await (await import('./commands/version.js')).runVersionCommand([], ctx);
    if (scan.help) {
      ctx.stdout.write(renderHelp(ROOT_DEF, ctx.progName, scan.help));
      return 0;
    }
    if (scan.helpAll) return await helpAll(ctx);
    const name = scan.command;
    if (name === undefined) {
      const chat = findCommand('chat')!;
      return await (await chat.load())(scan.args, ctx);
    }
    if (scan.chatFlags.length > 0 && name !== 'chat') {
      ctx.stderr.write(
        `error: unexpected argument '${scan.chatFlags[0]}' found\n\nUsage: ${ctx.progName} [OPTIONS] [COMMAND]\n\nFor more information, try '--help'.\n`,
      );
      return 2;
    }
    if (NOT_SUPPORTED.includes(name)) {
      const { unsupportedMessage } = await import('./commands/misc.js');
      ctx.stderr.write(`${unsupportedMessage(name)}\n`);
      return 1;
    }
    if (name === 'help') {
      const target = scan.args.find((a) => !a.startsWith('-'));
      if (target === undefined) {
        ctx.stdout.write(renderHelp(ROOT_DEF, ctx.progName, 'long'));
        return 0;
      }
      const c = findCommand(target);
      if (!c) {
        ctx.stderr.write(`error: unrecognized subcommand '${target}'\n\nUsage: ${ctx.progName} [OPTIONS] [COMMAND]\n\nFor more information, try '--help'.\n`);
        return 2;
      }
      return await (await c.load())(['--help'], ctx);
    }
    const entry = findCommand(name)!;
    const args = name === 'chat' ? [...scan.chatFlags, ...scan.args] : scan.args;
    const run = await entry.load();
    return await run(args, ctx);
  } catch (e) {
    // A clap-style usage error escaping a (delegated) command keeps its text and exit code 2.
    if (e instanceof UsageError) {
      ctx.stderr.write(`${e.message}\n`);
      return e.exitCode;
    }
    const msg = e instanceof Error ? e.message : String(e);
    ctx.stderr.write(`error: ${msg}\n`);
    log.error('command failed:', e);
    return 1;
  }
}

/** Entry point used by src/bin/kiro-claude.ts. */
export async function main(argv: string[]): Promise<number> {
  // A closed stdout (`kiro-claude --help | head -1`) must not crash the process.
  const ignoreEpipe = (e: NodeJS.ErrnoException): void => {
    if (e.code !== 'EPIPE') throw e;
  };
  process.stdout.on('error', ignoreEpipe);
  return runCli(argv);
}

// Re-exported so `kiro-claude chat --help` text can be produced without a CliContext.
export { CHAT_DEF };
