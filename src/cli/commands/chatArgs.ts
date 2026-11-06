/**
 * `kiro-claude chat` argument definition (01 §3, 08 §0 item 10 / §2.2 KC-CLI-03), kept in its
 * own module so cli/main.ts can recognise chat flags given at the root (no subcommand ⇒ chat,
 * 01 §1) without loading the chat implementation.
 *
 * KiroCrew parses `chat --help` (08 KC-CLI-03): the `--agent-engine <ENGINE>` block must carry
 * `[possible values: v1, v2]` before the next `\n      --` and the whole text must not contain
 * the substring `v3` anywhere — so `--v3` / `--v2` are hidden and no help string mentions it.
 * Accepted-and-ignored flags (UI/engine selection, 01 §3 "accept & ignore") are hidden.
 */

import type { ArgDef, CommandDef } from '../args.js';

/** `-v, --verbose...` (global in Kiro's clap definition). */
export const VERBOSE_ARG: ArgDef = { id: 'verbose', long: 'verbose', short: 'v', kind: 'count', help: 'Increase logging verbosity' };

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const OUTPUT_FORMATS = ['plain', 'json', 'json-pretty'];

export const CHAT_ABOUT = 'AI assistant in your terminal';

export const CHAT_DEF: CommandDef = {
  name: 'chat',
  about: CHAT_ABOUT,
  positionals: [{ id: 'input', valueName: 'INPUT', help: 'The first question to ask' }],
  args: [
    {
      id: 'resume',
      long: 'resume',
      short: 'r',
      kind: 'bool',
      help: 'Resumes the most recent conversation from this directory',
      conflictsWith: ['resume-id', 'resume-picker', 'sessions'],
    },
    { id: 'resume-picker', long: 'resume-picker', kind: 'bool', help: 'Pick a saved conversation from this directory to resume', conflictsWith: ['resume-id'] },
    { id: 'resume-id', long: 'resume-id', kind: 'value', valueName: 'ID', help: 'Resume the conversation with this session id' },
    { id: 'list-sessions', long: 'list-sessions', kind: 'bool', help: 'List the saved conversations of this directory and exit' },
    { id: 'delete-session', long: 'delete-session', kind: 'value', valueName: 'ID', help: 'Delete a saved conversation and exit' },
    { id: 'agent', long: 'agent', aliases: ['profile'], kind: 'value', valueName: 'AGENT', help: 'Agent to use for this chat' },
    { id: 'model', long: 'model', kind: 'value', valueName: 'MODEL', help: 'Model to use (overrides the agent model and chat.defaultModel)' },
    { id: 'effort', long: 'effort', kind: 'value', valueName: 'LEVEL', possibleValues: EFFORT_LEVELS, help: 'Initial reasoning effort' },
    {
      id: 'trust-all-tools',
      long: 'trust-all-tools',
      short: 'a',
      kind: 'bool',
      help: 'Allows the model to use any tool to run commands without asking for confirmation',
    },
    {
      id: 'trust-tools',
      long: 'trust-tools',
      kind: 'value',
      valueName: 'TOOL_NAMES',
      help: "Trust only this set of tools. Example: trust some tools: '--trust-tools=fs_read,fs_write', trust no tools: '--trust-tools='",
    },
    {
      id: 'no-interactive',
      long: 'no-interactive',
      aliases: ['non-interactive'],
      kind: 'bool',
      help: 'Run one task without user input and print the response to stdout; tools that need approval are denied unless --trust-all-tools is used',
    },
    {
      id: 'output-format',
      long: 'output-format',
      kind: 'value',
      valueName: 'FORMAT',
      possibleValues: ['text', 'stream-json'],
      help: 'Output format of --no-interactive runs',
    },
    {
      id: 'require-mcp-startup',
      long: 'require-mcp-startup',
      kind: 'bool',
      help: 'With --no-interactive: exit with code 3 when an MCP server fails to start',
    },
    { id: 'list-models', long: 'list-models', kind: 'bool', help: 'List the available models and exit' },
    {
      id: 'format',
      long: 'format',
      short: 'f',
      kind: 'value',
      valueName: 'FORMAT',
      possibleValues: OUTPUT_FORMATS,
      help: 'Output format of --list-models and --list-sessions',
    },
    { id: 'wrap', long: 'wrap', short: 'w', kind: 'value', valueName: 'WRAP', possibleValues: ['always', 'never', 'auto'], help: 'Line wrapping of rendered output' },
    {
      id: 'agent-engine',
      long: 'agent-engine',
      kind: 'value',
      valueName: 'ENGINE',
      possibleValues: ['v1', 'v2'],
      help: 'Agent harness (accepted for compatibility; kiro-claude has one engine)',
      conflictsWith: ['v2', 'v3'],
    },
    {
      id: 'use-api-key',
      long: 'use-api-key',
      kind: 'bool',
      help: 'Let ANTHROPIC_API_KEY and cloud-provider settings reach Claude Code (default: your Claude subscription login)',
    },
    { id: 'trust-workspace', long: 'trust-workspace', kind: 'bool', help: 'Trust the current workspace for this launch (accepted for compatibility)' },
    VERBOSE_ARG,
    // hidden, accepted and ignored (01 §1.1, §3)
    { id: 'v2', long: 'v2', kind: 'bool', hidden: true, conflictsWith: ['v3', 'legacy-ui'] },
    { id: 'v3', long: 'v3', kind: 'bool', hidden: true, conflictsWith: ['legacy-ui'] },
    { id: 'tui', long: 'tui', kind: 'bool', hidden: true },
    { id: 'classic', long: 'classic', kind: 'bool', hidden: true },
    { id: 'legacy-ui', long: 'legacy-ui', kind: 'bool', hidden: true },
    { id: 'sessions', long: 'sessions', kind: 'bool', hidden: true },
    // hidden, not supported (exit 1 with a message)
    { id: 'cloud', long: 'cloud', kind: 'bool', hidden: true },
    { id: 'repo', long: 'repo', kind: 'value', valueName: 'REPOS', hidden: true },
    { id: 'sandbox', long: 'sandbox', kind: 'bool', hidden: true },
  ],
};

/** Long (`--x`) and short (`-x`) spellings of chat options that take a separate value. */
export function chatValueFlags(): { long: Set<string>; short: Set<string> } {
  const long = new Set<string>();
  const short = new Set<string>();
  for (const a of CHAT_DEF.args) {
    if (a.kind !== 'value' || a.optionalValue) continue;
    if (a.long !== undefined) long.add(a.long);
    for (const al of a.aliases ?? []) long.add(al);
    if (a.short !== undefined) short.add(a.short);
  }
  return { long, short };
}
