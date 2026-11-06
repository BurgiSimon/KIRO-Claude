/**
 * Basic slash commands (01 §5.1–§5.2): /help, /quit (/exit, /q), /clear, /session-id, /issue,
 * /knowledge (stub), /profile (deprecated), /copy, /title, /settings, and the stubs for Kiro
 * commands kiro-claude does not implement (01 §10 item 6 text).
 */

import { c } from '../../util/ansi.js';
import { notSupported, ISSUES_URL } from '../prompt.js';
import { formatCommandHelp, formatHelp } from '../registry.js';
import type { BuiltinCommand } from '../types.js';

const CLEAR_QUESTION = 'Are you sure? This will erase the conversation history and context from hooks for the current session. [y/n]:';

export const helpCommand: BuiltinCommand = {
  name: 'help',
  summary: 'Show the list of commands (/help <command> for details)',
  usage: '/help [command]',
  async run(args, _raw, r) {
    const want = args[0]?.replace(/^\//, '');
    if (want) {
      const lw = want.toLowerCase();
      const cmd = r.commands().find((x) => x.name.toLowerCase() === lw || (x.aliases ?? []).some((a) => a.toLowerCase() === lw));
      if (!cmd) {
        r.write(`${c.red(`Unknown command: /${want}`)}\n`);
        return;
      }
      r.write(formatCommandHelp(cmd));
      return;
    }
    r.write(formatHelp(r.commands()));
  },
};

export const quitCommand: BuiltinCommand = {
  name: 'quit',
  aliases: ['exit', 'q'],
  summary: 'Quit the application',
  async run() {
    return 'quit';
  },
};

export const clearCommand: BuiltinCommand = {
  name: 'clear',
  summary: 'Clear the conversation history',
  usage: '/clear',
  async run(_args, _raw, r) {
    // 01 §5.2 / 06 §6.7 (Classic exact; y and n in green, the rest grey)
    const head = CLEAR_QUESTION.slice(0, CLEAR_QUESTION.indexOf('[') + 1);
    const q = `${c.gray(head)}${c.green('y')}${c.gray('/')}${c.green('n')}${c.gray(']:')}`;
    r.write(`\n${q}\n\n`);
    const ans = await r.readAnswer();
    if (ans === undefined) {
      r.write('\n');
      return;
    }
    if (ans.trim().toLowerCase() !== 'y') return;
    await r.session.clear();
    await r.refreshUsage();
    r.write(`\n${c.green('Conversation history cleared.')}\n\n`);
  },
};

export const sessionIdCommand: BuiltinCommand = {
  name: 'session-id',
  summary: 'Print the current session ID',
  async run(_args, _raw, r) {
    r.print(r.session.id);
  },
};

export const issueCommand: BuiltinCommand = {
  name: 'issue',
  aliases: ['feedback'],
  summary: 'Report an issue with kiro-claude',
  async run(_args, _raw, r) {
    r.write(`\nTo report an issue or send feedback, open: ${c.blue(ISSUES_URL)}\n\n`);
  },
};

export const knowledgeCommand: BuiltinCommand = {
  name: 'knowledge',
  summary: 'Knowledge bases (not supported in kiro-claude)',
  async run(_args, _raw, r) {
    r.write(`${c.yellow(notSupported('knowledge'))}\n`);
  },
};

export const profileCommand: BuiltinCommand = {
  name: 'profile',
  hidden: true,
  summary: 'Deprecated: use /agent',
  async run(_args, _raw, r) {
    // Q cli/chat/cli/mod.rs deprecation text; Kiro's agent docs replace the Q migration URL.
    r.write('\nThis command has been deprecated. Use /agent instead.\nSee https://kiro.dev/docs/cli/custom-agents/ for more detail\n\n');
  },
};

export const copyCommand: BuiltinCommand = {
  name: 'copy',
  summary: 'Copy the last response to the clipboard (OSC 52)',
  async run(_args, _raw, r) {
    const text = r.lastAssistantText;
    if (!text) {
      r.write('\nNo assistant message found to copy.\n\n');
      return;
    }
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    if (b64.length > 100 * 1024) {
      r.write(`\n${c.yellow('The last response is too large to copy through the terminal (over 100 KB).')}\n\n`);
      return;
    }
    r.write(`\u001b]52;c;${b64}\u0007`);
    r.write(`\n${c.green('✔ Copied the last response to the clipboard.')}\n\n`);
  },
};

export const titleCommand: BuiltinCommand = {
  name: 'title',
  summary: 'Set the terminal title (kiro: <text>)',
  usage: '/title <text>\n/title --clear',
  async run(args, raw, r) {
    if (args[0] === '--clear') {
      r.write('\u001b]0;\u0007');
      return;
    }
    const t = raw.trim().slice(0, 60);
    if (!t) {
      r.write(`${c.red('Usage: /title <text> | /title --clear')}\n`);
      return;
    }
    r.write(`\u001b]0;kiro: ${t}\u0007`);
  },
};

export const settingsCommand: BuiltinCommand = {
  name: 'settings',
  summary: 'Show the effective settings',
  usage: '/settings',
  async run(args, _raw, r) {
    if (args.length > 0) {
      r.write(`${c.yellow(notSupported(`settings ${args[0]}`))}\nUse ${r.progName} settings <key> <value> to change a setting.\n`);
      return;
    }
    const all = r.settings.list('effective');
    const keys = Object.keys(all);
    if (keys.length === 0) {
      r.write(`\nNo settings are configured.\nUse ${r.progName} settings <key> <value> to change a setting.\n\n`);
      return;
    }
    const w = Math.max(...keys.map((k) => k.length));
    let s = '\n';
    for (const k of keys) s += `${c.bold(k.padEnd(w))}  ${JSON.stringify(all[k])}\n`;
    s += `\nUse ${r.progName} settings <key> <value> to change a setting.\n\n`;
    r.write(s);
  },
};

/** Kiro commands without a kiro-claude implementation (hidden from /help). */
export const STUB_COMMANDS: readonly string[] = [
  'fullscreen',
  'upgrade-agent',
  'spawn',
  'checkpoint',
  'guide',
  'paste',
  'permissions',
  'config',
  'powers',
  'theme',
  'code',
  'experiment',
  'logdump',
  'autonomous',
  'sandbox',
  'workflow',
  'goal',
  'changelog',
  'voice',
  'memories',
  'repo',
  'disconnect',
  'verbosity',
  'subscribe',
  'stats',
];

export function stubCommands(): BuiltinCommand[] {
  return STUB_COMMANDS.map((name) => ({
    name,
    hidden: true,
    summary: 'Not supported in kiro-claude',
    async run(_args, _raw, r) {
      r.write(`${c.yellow(notSupported(name))}\n`);
    },
  }));
}

export const basicCommands: BuiltinCommand[] = [
  quitCommand,
  clearCommand,
  helpCommand,
  sessionIdCommand,
  issueCommand,
  knowledgeCommand,
  profileCommand,
  copyCommand,
  titleCommand,
  settingsCommand,
];
