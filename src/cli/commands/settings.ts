/**
 * `kiro-claude settings [SUBCOMMAND] [OPTIONS] [KEY] [VALUE]` (alias `setting`) with Kiro / Q
 * semantics (01 §2.3, Q `cli/settings.rs:81-290`), over config/settings.ts.
 *
 *  - `settings <KEY>`: string values raw, others pretty JSON; missing ⇒
 *    `error: No value associated with <key>` exit 1 (json formats print `null`, exit 0);
 *  - `settings <KEY> <VALUE>`: VALUE parsed as JSON, else stored as a string; unknown keys are
 *    accepted with a warning (01 §2.3 "Port"); global-only keys reject `--workspace`;
 *  - `settings --delete <GLOB>`: 0 matches ⇒ `error: No settings found matching <glob>` exit 1;
 *    1 ⇒ `Removing "<key>"`; several ⇒ ``Removing `<key>` `` per key; without KEY or with VALUE
 *    ⇒ Q's `the argument '--delete' requires a <KEY>` / `cannot be used with '[VALUE]'`, exit 1;
 *  - `settings` alone does nothing (Q), exit 0;
 *  - `settings list [--all]`: plain `<key> = <JSON value>` per line, or the map as JSON;
 *    `--all` lists every known setting (`<key>` / `  Description: …` / `  Current: …|not set`
 *    / blank; JSON: `[{"key","description","current_value"}]`);
 *  - `settings open`: `$EDITOR` on the scope's cli.json (created as `{}` when missing);
 *  - scope: `--global` (default for writes) / `--workspace`; reads without a scope flag use the
 *    effective (workspace over global) value.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CliContext, SettingsScope } from '../../types.js';
import { SETTINGS_SCHEMA, SettingsError } from '../../config/settings.js';
import { ownValue } from '../../config/diag.js';
import { mkdirp } from '../../util/fsx.js';
import { c } from '../../util/ansi.js';
import type { CommandDef } from '../args.js';
import { err, errorText, openInEditor, out, parseOrExit } from '../io.js';
import { OUTPUT_FORMATS, VERBOSE_ARG } from './chatArgs.js';

const SCOPE_ARGS = [
  { id: 'global', long: 'global', kind: 'bool' as const, help: 'Use the global settings file (~/.kiro/settings/cli.json)', conflictsWith: ['workspace'] },
  { id: 'workspace', long: 'workspace', kind: 'bool' as const, help: 'Use the workspace settings file (.kiro/settings/cli.json)' },
];
const FORMAT_ARG = {
  id: 'format',
  long: 'format',
  short: 'f',
  kind: 'value' as const,
  valueName: 'FORMAT',
  possibleValues: OUTPUT_FORMATS,
  defaultValue: 'plain',
  help: 'Output format',
};

export const SETTINGS_DEF: CommandDef = {
  name: 'settings',
  about: 'Customize appearance & behavior',
  usage: '[OPTIONS] [KEY] [VALUE] [COMMAND]',
  positionals: [
    { id: 'key', valueName: 'KEY', help: 'Key of the setting' },
    { id: 'value', valueName: 'VALUE', help: 'Value of the setting (parsed as JSON when possible, else a string)' },
  ],
  subcommands: [
    { name: 'open', about: 'Open the settings file in $EDITOR' },
    { name: 'list', about: 'List configured settings (--all: every known setting)' },
  ],
  args: [
    { id: 'delete', long: 'delete', short: 'd', kind: 'bool', help: 'Delete the settings whose keys match KEY (a glob)' },
    FORMAT_ARG,
    ...SCOPE_ARGS,
    VERBOSE_ARG,
  ],
};

export const SETTINGS_LIST_DEF: CommandDef = {
  name: 'settings list',
  about: 'List configured settings',
  args: [{ id: 'all', long: 'all', short: 'a', kind: 'bool', help: 'List every known setting with its description' }, FORMAT_ARG, ...SCOPE_ARGS, VERBOSE_ARG],
};

export const SETTINGS_OPEN_DEF: CommandDef = {
  name: 'settings open',
  about: 'Open the settings file in $EDITOR',
  args: [...SCOPE_ARGS, VERBOSE_ARG],
};

type Format = 'plain' | 'json' | 'json-pretty';

function scopeOf(p: { has(id: string): boolean }): SettingsScope | undefined {
  if (p.has('workspace')) return 'workspace';
  if (p.has('global')) return 'global';
  return undefined;
}

function jsonText(v: unknown, format: Format): string {
  return format === 'json-pretty' ? JSON.stringify(v, null, 2) : JSON.stringify(v);
}

function lookup(ctx: CliContext, key: string, scope: SettingsScope | undefined): unknown {
  if (scope === undefined) return ctx.settings.get(key);
  return ownValue(ctx.settings.list(scope), key);
}

function runList(ctx: CliContext, args: string[]): number {
  const p = parseOrExit(SETTINGS_LIST_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const format = (p.value('format') ?? 'plain') as Format;
  const scope = scopeOf(p);
  if (p.has('all')) {
    const keys = Object.keys(SETTINGS_SCHEMA).sort();
    if (format !== 'plain') {
      const rows = keys.map((k) => ({ key: k, description: SETTINGS_SCHEMA[k]!.description, current_value: lookup(ctx, k, scope) ?? null }));
      out(ctx, jsonText(rows, format));
      return 0;
    }
    const lines: string[] = [];
    for (const k of keys) {
      const v = lookup(ctx, k, scope);
      lines.push(c.bold(c.cyan(k)), `  Description: ${SETTINGS_SCHEMA[k]!.description}`, `  Current: ${v === undefined ? 'not set' : JSON.stringify(v)}`, '');
    }
    ctx.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''));
    return 0;
  }
  const map = ctx.settings.list(scope ?? 'effective');
  if (format !== 'plain') {
    out(ctx, jsonText(map, format));
    return 0;
  }
  for (const [k, v] of Object.entries(map)) out(ctx, `${k} = ${JSON.stringify(v)}`);
  return 0;
}

function runOpen(ctx: CliContext, args: string[]): number {
  const p = parseOrExit(SETTINGS_OPEN_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const file = ctx.settings.pathFor('chat.defaultModel', scopeOf(p) ?? 'global');
  try {
    if (!fs.existsSync(file)) {
      mkdirp(path.dirname(file));
      fs.writeFileSync(file, '{}\n');
    }
  } catch (e) {
    err(ctx, `error: cannot create ${file}: ${errorText(e)}`);
    return 1;
  }
  const r = openInEditor(file, ctx.ws.env);
  if (r.error) {
    err(ctx, `error: could not open editor: ${r.error}`);
    return 1;
  }
  return r.code === 0 ? 0 : 1;
}

/** `settings` subcommand runner (see module doc). */
export async function runSettingsCommand(args: string[], ctx: CliContext): Promise<number> {
  // The first positional selects a subcommand (`list`, hidden `all`, `open`).
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === '--') {
      i = args.length;
      break;
    }
    if (a === '-f' || a === '--format') i += 2;
    else if (a.startsWith('-')) i += 1;
    else break;
  }
  const first = args[i];
  if (first === 'list' || first === 'all') return runList(ctx, [...args.slice(0, i), ...args.slice(i + 1)]);
  if (first === 'open') return runOpen(ctx, [...args.slice(0, i), ...args.slice(i + 1)]);
  const p = parseOrExit(SETTINGS_DEF, args, ctx);
  if (typeof p === 'number') return p;
  const format = (p.value('format') ?? 'plain') as Format;
  const scope = scopeOf(p);
  const key = p.pos('key');
  const value = p.pos('value');

  if (p.has('delete')) {
    if (key === undefined) {
      err(ctx, `error: the argument '--delete' requires a <KEY>\n Usage: ${ctx.progName} settings --delete <KEY>`);
      return 1;
    }
    if (value !== undefined) {
      err(ctx, `error: the argument '--delete' cannot be used with '[VALUE]'\n Usage: ${ctx.progName} settings --delete ${key}`);
      return 1;
    }
    let deleted: string[];
    try {
      deleted = ctx.settings.delete(key, scope ?? 'global');
    } catch (e) {
      err(ctx, `error: ${errorText(e)}`);
      return 1;
    }
    if (deleted.length === 0) {
      err(ctx, `error: No settings found matching ${key}`);
      return 1;
    }
    if (deleted.length === 1) out(ctx, `Removing "${deleted[0]}"`);
    else for (const k of deleted) out(ctx, `Removing \`${k}\``);
    return 0;
  }

  // Q: `settings` without a key does nothing (exit 0).
  if (key === undefined) return 0;

  if (value === undefined) {
    const v = lookup(ctx, key, scope);
    if (format !== 'plain') {
      out(ctx, jsonText(v ?? null, format));
      return 0;
    }
    if (v === undefined) {
      err(ctx, `error: No value associated with ${key}`);
      return 1;
    }
    out(ctx, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    return 0;
  }

  if (ownValue(SETTINGS_SCHEMA, key) === undefined) err(ctx, `WARNING: '${key}' is not a known setting; storing it anyway`);
  try {
    ctx.settings.set(key, value, scope ?? 'global');
  } catch (e) {
    err(ctx, `error: ${e instanceof SettingsError ? e.message : errorText(e)}`);
    return 1;
  }
  return 0;
}
