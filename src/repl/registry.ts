/**
 * Slash-command registry: built-ins (repl/commands) first, then commands contributed by other
 * modules (spec/slash.ts). Names and aliases match case-insensitively; a contributed command
 * never shadows a built-in. `/help` output follows Q's layout (01 §5.0: one line per command,
 * then a `Tips` footer; `/help <cmd>` and `/<cmd> --help` print the usage).
 */

import type { SlashCommand } from '../types.js';
import { c } from '../util/ansi.js';
import type { BuiltinCommand } from './types.js';

export interface RegistryEntry {
  cmd: SlashCommand | BuiltinCommand;
  builtin: boolean;
}

export class CommandRegistry {
  private readonly entries: RegistryEntry[] = [];
  private readonly byName = new Map<string, RegistryEntry>();

  constructor(builtins: readonly BuiltinCommand[], extra: readonly SlashCommand[] = []) {
    for (const b of builtins) this.add({ cmd: b, builtin: true });
    for (const e of extra) this.add({ cmd: e, builtin: false });
  }

  private add(e: RegistryEntry): void {
    const keys = [e.cmd.name, ...(e.cmd.aliases ?? [])].map((k) => k.toLowerCase().replace(/^\//, ''));
    if (keys.some((k) => this.byName.get(k)?.builtin)) {
      // never shadow a built-in; still register the non-clashing aliases
      const free = keys.filter((k) => !this.byName.has(k));
      if (free.length === 0) return;
      for (const k of free) this.byName.set(k, e);
      this.entries.push(e);
      return;
    }
    for (const k of keys) if (!this.byName.has(k)) this.byName.set(k, e);
    this.entries.push(e);
  }

  find(name: string): RegistryEntry | undefined {
    return this.byName.get(name.toLowerCase().replace(/^\//, ''));
  }

  /** All commands in registration order. */
  all(): (SlashCommand | BuiltinCommand)[] {
    return this.entries.map((e) => e.cmd);
  }

  /** `/name` strings (names and aliases) for completion. */
  completionNames(): string[] {
    return [...this.byName.keys()].map((k) => `/${k}`).sort();
  }
}

function isHidden(cmd: SlashCommand | BuiltinCommand): boolean {
  return (cmd as BuiltinCommand).hidden === true;
}

/** `/help` text (see module doc). */
export function formatHelp(cmds: readonly (SlashCommand | BuiltinCommand)[]): string {
  const visible = cmds.filter((x) => !isHidden(x));
  const label = (x: SlashCommand | BuiltinCommand): string => `/${x.name}`;
  const w = Math.max(14, ...visible.map((x) => label(x).length + 2));
  let s = `\n${c.cyan(c.bold('Commands:'))}\n`;
  for (const x of visible) {
    const al = x.aliases && x.aliases.length ? c.gray(` (aliases: ${x.aliases.map((a) => `/${a}`).join(', ')})`) : '';
    s += `${c.bold(label(x).padEnd(w))}${c.gray(x.summary)}${al}\n`;
  }
  s += `\n${c.cyan(c.bold('Tips:'))}\n`;
  const tips: [string, string][] = [
    ['!{command}', 'Quickly execute a command in your current session'],
    ['Ctrl(^) + j', 'Insert new-line to provide multi-line prompt'],
    ['', 'Alternatively, [Alt(⌥) + Enter(⏎)]'],
    ['Ctrl(^) + c', 'Interrupt the response; at the prompt press it twice to exit'],
    ['Shift(⇧) + Tab', 'Toggle plan mode'],
    ['@<file|dir>', 'Add a file or directory listing to your message'],
    ['@<prompt> [args]', 'Run a saved prompt (also /<prompt> [args])'],
    ['/<skill> [args]', 'Run a skill from .kiro/skills or ~/.kiro/skills'],
  ];
  const tw = 22;
  for (const [k, v] of tips) s += `${c.bold(k.padEnd(tw))}${c.gray(v)}\n`;
  s += '\n';
  return s;
}

/** `/help <cmd>` / `/<cmd> --help` text. */
export function formatCommandHelp(cmd: SlashCommand | BuiltinCommand): string {
  let s = `\n${c.bold(`/${cmd.name}`)} ${c.gray('—')} ${cmd.summary}\n`;
  if (cmd.aliases && cmd.aliases.length) s += `${c.gray('Aliases:')} ${cmd.aliases.map((a) => `/${a}`).join(', ')}\n`;
  if (cmd.usage) s += `\n${c.cyan('Usage:')}\n${cmd.usage.replace(/^/gm, '  ')}\n`;
  return `${s}\n`;
}
