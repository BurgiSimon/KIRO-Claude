/**
 * A small clap-like argument parser and help renderer (zero dependencies).
 *
 * Kiro CLI is a clap (Rust) program and clients parse its output (01 §1–3, 08 §2.2): KiroCrew
 * reads `chat --help` looking for the `--agent-engine` block and its `[possible values: …]`
 * line, and treats clap usage errors as exit 2. This module reproduces the parts of clap 4's
 * behaviour those clients and users see:
 *
 * Parsing ({@link parseArgs}):
 *  - long flags `--name`, `--name=value`, `--name value`; short flags `-a`, clusters `-abc`,
 *    `-fVALUE`, `-f VALUE`; count flags (`-vvv`); repeated values (`multiple`);
 *  - a value that starts with `-` is not taken as a value unless the flag allows hyphen values
 *    (clap's default), except a lone `-`;
 *  - an option whose value is optional (`optionalValue`, clap `num_args 0..=1` +
 *    `default_missing_value`) takes `=value` or, like clap, a following token that does not
 *    start with `-` (`requireEquals` restricts it to `=`);
 *  - possible-values validation (case-sensitive), conflicts, repeated single-use flags;
 *  - positionals in order (the last may be `multiple`); everything after `--` is positional
 *    (or `trailing` when the command keeps raw passthrough);
 *  - `-h` ⇒ short help, `--help` ⇒ long help, returned as `help` (callers print and exit 0).
 *
 * Errors ({@link UsageError}, exit code 2) use clap's wording:
 * ```
 * error: unexpected argument '--x' found
 *
 *   tip: a similar argument exists: '--agent'
 *
 * Usage: kiro-claude chat [OPTIONS] [INPUT]
 *
 * For more information, try '--help'.
 * ```
 * plus `error: invalid value 'v3' for '--agent-engine <ENGINE>'\n  [possible values: v1, v2]`,
 * `error: a value is required for '--agent <AGENT>' but none was supplied`,
 * `error: the argument '--a' cannot be used multiple times`,
 * `error: the argument '--a' cannot be used with '--b'`,
 * `error: unexpected value 'x' for '--flag' found; no more were expected`,
 * `error: the following required arguments were not provided:\n  <NAME>`.
 *
 * Help ({@link renderHelp}): `-h` uses clap's one-line layout (left column padded, possible
 * values appended `[possible values: …]`); `--help` uses clap's long "next line" layout (help
 * text indented 10 spaces on the line below the flag, a blank line before
 * `[possible values: …]` and between entries), which is the layout of 05 §2.2 that KiroCrew
 * parses. Hidden flags and hidden subcommands are omitted. No line wrapping (clap without the
 * `wrap_help` feature).
 */

export type ArgKind = 'bool' | 'count' | 'value';

/** One option (flag) of a command. */
export interface ArgDef {
  /** Key in the parse result. */
  id: string;
  /** Long name without dashes. */
  long?: string;
  /** Single-character short name without dash. */
  short?: string;
  /** Hidden extra long names (e.g. `non-interactive`, `profile`). */
  aliases?: string[];
  /** Hidden extra short names. */
  shortAliases?: string[];
  kind: ArgKind;
  /** Placeholder for help/errors (`AGENT` ⇒ `<AGENT>`). Defaults to the upper-cased id. */
  valueName?: string;
  /** Allow the flag several times (values accumulate). */
  multiple?: boolean;
  /** Accepted values (validated, shown in help). */
  possibleValues?: string[];
  /**
   * Value is optional (clap `num_args(0..=1)` + `default_missing_value`, e.g. Q's
   * `--changelog[=all]`): `--x=v`, or `--x v` when the next token does not start with `-`
   * (clap is greedy here); a bare flag ⇒ `missingValue`.
   */
  optionalValue?: boolean;
  /** With `optionalValue`: the value is only taken through `=` (clap `require_equals`). */
  requireEquals?: boolean;
  /** Value used when an `optionalValue` flag appears without `=` (default ''). */
  missingValue?: string;
  /** Accept values that start with `-` (`--args -y`). */
  allowHyphenValues?: boolean;
  /** Shown as `[default: x]` in help (not applied by the parser). */
  defaultValue?: string;
  help?: string;
  /** Extra paragraph(s) for `--help` only. */
  longHelp?: string;
  hidden?: boolean;
  /** Ids this flag cannot be combined with. */
  conflictsWith?: string[];
}

/** A positional argument. */
export interface PositionalDef {
  id: string;
  valueName: string;
  required?: boolean;
  multiple?: boolean;
  help?: string;
  /** Hidden from help. */
  hidden?: boolean;
}

/** A subcommand listed in help (parsing of subcommands is done by the caller). */
export interface SubcommandInfo {
  name: string;
  about: string;
  aliases?: string[];
  hidden?: boolean;
}

/** One command (or subcommand) definition. */
export interface CommandDef {
  /** Path after the program name, e.g. `chat`, `agent create` ('' for the root). */
  name: string;
  about?: string;
  /** Extra text for `--help` only (placed after `about`). */
  longAbout?: string;
  args: ArgDef[];
  positionals?: PositionalDef[];
  subcommands?: SubcommandInfo[];
  /** Usage suffix override (default derived: `[OPTIONS] [ARGS]` / `[COMMAND]`). */
  usage?: string;
  /** Text printed after the options. */
  afterHelp?: string;
  /** Keep tokens after `--` in `trailing` instead of treating them as positionals. */
  rawTrailing?: boolean;
  /** Help flag `-h, --help` (default true). */
  helpFlag?: boolean;
}

/** Result of {@link parseArgs}. */
export interface ParsedArgs {
  /** `'short'` for `-h`, `'long'` for `--help` (parsing stopped there). */
  help?: 'short' | 'long';
  /** Values per option id (value options; optionalValue flags record their value). */
  readonly values: Map<string, string[]>;
  /** Occurrence counts per bool/count option id. */
  readonly counts: Map<string, number>;
  /** Positional values per positional id. */
  readonly positionals: Map<string, string[]>;
  /** Tokens after `--` when the command keeps raw passthrough. */
  readonly trailing: string[];
  /** Option ids in the order they appeared. */
  readonly order: string[];
  has(id: string): boolean;
  value(id: string): string | undefined;
  valuesOf(id: string): string[];
  count(id: string): number;
  pos(id: string): string | undefined;
  posAll(id: string): string[];
}

/** A clap-style usage error (exit code 2). `message` is the full text to print on stderr. */
export class UsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Placeholder of a value option: `<AGENT>`. */
export function valuePlaceholder(a: ArgDef): string {
  return `<${a.valueName ?? a.id.toUpperCase().replace(/-/g, '_')}>`;
}

/** How clap names an option in errors: `--agent <AGENT>`, `--trust-all-tools`, `-a`. */
export function argDisplay(a: ArgDef): string {
  const name = a.long !== undefined ? `--${a.long}` : `-${a.short ?? ''}`;
  if (a.kind !== 'value') return name;
  return a.optionalValue ? `${name} [${valuePlaceholder(a).slice(1, -1)}]` : `${name} ${valuePlaceholder(a)}`;
}

function positionalDisplay(p: PositionalDef): string {
  const core = p.required ? `<${p.valueName}>` : `[${p.valueName}]`;
  return p.multiple ? `${core}...` : core;
}

/** `Usage: <bin> <name> [OPTIONS] [INPUT]` */
export function usageLine(def: CommandDef, bin: string): string {
  if (def.usage !== undefined) return `Usage: ${[bin, def.name, def.usage].filter((s) => s !== '').join(' ')}`;
  const parts = [bin];
  if (def.name) parts.push(def.name);
  const visibleOpts = def.args.some((a) => !a.hidden) || def.helpFlag !== false;
  if (visibleOpts) parts.push('[OPTIONS]');
  for (const p of def.positionals ?? []) if (!p.hidden) parts.push(positionalDisplay(p));
  if ((def.subcommands ?? []).some((s) => !s.hidden)) parts.push('[COMMAND]');
  return `Usage: ${parts.join(' ')}`;
}

const MORE_INFO = "For more information, try '--help'.";

function usageError(def: CommandDef, bin: string, head: string, opts: { usage?: boolean; tip?: string } = {}): UsageError {
  const lines = [`error: ${head}`];
  if (opts.tip) lines.push('', `  tip: ${opts.tip}`);
  if (opts.usage !== false) lines.push('', usageLine(def, bin));
  lines.push('', MORE_INFO);
  return new UsageError(lines.join('\n'));
}

/** Jaro similarity (strsim::jaro), used for "a similar argument exists" tips (clap: > 0.7). */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(b.length - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = true;
      bm[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  return (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
}

/** Best candidate with jaro similarity > 0.7, if any. */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let score = 0.7;
  for (const c of candidates) {
    const s = jaro(input, c);
    if (s > score) {
      score = s;
      best = c;
    }
  }
  return best;
}

class Parsed implements ParsedArgs {
  help?: 'short' | 'long';
  readonly values = new Map<string, string[]>();
  readonly counts = new Map<string, number>();
  readonly positionals = new Map<string, string[]>();
  readonly trailing: string[] = [];
  readonly order: string[] = [];
  has(id: string): boolean {
    return this.values.has(id) || (this.counts.get(id) ?? 0) > 0;
  }
  value(id: string): string | undefined {
    const v = this.values.get(id);
    return v === undefined ? undefined : v[v.length - 1];
  }
  valuesOf(id: string): string[] {
    return [...(this.values.get(id) ?? [])];
  }
  count(id: string): number {
    return this.counts.get(id) ?? 0;
  }
  pos(id: string): string | undefined {
    return this.positionals.get(id)?.[0];
  }
  posAll(id: string): string[] {
    return [...(this.positionals.get(id) ?? [])];
  }
}

function withHelp(def: CommandDef): ArgDef[] {
  if (def.helpFlag === false || def.args.some((a) => a.id === 'help')) return def.args;
  return [...def.args, { id: 'help', long: 'help', short: 'h', kind: 'bool', help: 'Print help' }];
}

/**
 * Parse `argv` against `def` (see module doc). `bin` is the program name used in usage lines
 * (`kiro-claude`). Throws {@link UsageError}.
 */
export function parseArgs(def: CommandDef, argv: readonly string[], bin: string): ParsedArgs {
  const args = withHelp(def);
  const byLong = new Map<string, ArgDef>();
  const byShort = new Map<string, ArgDef>();
  for (const a of args) {
    if (a.long !== undefined) byLong.set(a.long, a);
    for (const al of a.aliases ?? []) byLong.set(al, a);
    if (a.short !== undefined) byShort.set(a.short, a);
    for (const s of a.shortAliases ?? []) byShort.set(s, a);
  }
  const out = new Parsed();
  const positionalTokens: string[] = [];
  const seenSingle = new Set<string>();

  const record = (a: ArgDef, value: string | undefined): void => {
    if (a.id === 'help') return;
    if (!a.multiple && a.kind !== 'count') {
      if (seenSingle.has(a.id)) throw usageError(def, bin, `the argument '${argDisplay(a)}' cannot be used multiple times`);
      seenSingle.add(a.id);
    }
    out.order.push(a.id);
    if (a.kind === 'value') {
      const v = value ?? a.missingValue ?? '';
      if (a.possibleValues && !(a.optionalValue && value === undefined) && !a.possibleValues.includes(v)) {
        throw new UsageError(
          [`error: invalid value '${v}' for '${argDisplay(a)}'`, `  [possible values: ${a.possibleValues.join(', ')}]`, '', MORE_INFO].join('\n'),
        );
      }
      const list = out.values.get(a.id) ?? [];
      list.push(v);
      out.values.set(a.id, list);
    } else {
      out.counts.set(a.id, (out.counts.get(a.id) ?? 0) + 1);
    }
  };

  const missingValue = (a: ArgDef): UsageError => {
    const lines = [`error: a value is required for '${argDisplay(a)}' but none was supplied`];
    if (a.possibleValues) lines.push(`  [possible values: ${a.possibleValues.join(', ')}]`);
    lines.push('', MORE_INFO);
    return new UsageError(lines.join('\n'));
  };

  const takesNext = (a: ArgDef, next: string | undefined): boolean => {
    if (next === undefined) return false;
    if (next === '-' || !next.startsWith('-') || next === '') return true;
    return a.allowHyphenValues === true;
  };

  const unexpected = (tok: string): UsageError => {
    let tip: string | undefined;
    if (tok.startsWith('--')) {
      const name = tok.slice(2).split('=')[0] ?? '';
      const visible = args.filter((a) => !a.hidden && a.long !== undefined).map((a) => a.long!);
      const s = suggest(name, visible);
      if (s) tip = `a similar argument exists: '--${s}'`;
    }
    return usageError(def, bin, `unexpected argument '${tok}' found`, tip ? { tip } : {});
  };

  let i = 0;
  let afterDashDash = false;
  while (i < argv.length) {
    const tok = argv[i]!;
    i++;
    if (afterDashDash) {
      if (def.rawTrailing) out.trailing.push(tok);
      else positionalTokens.push(tok);
      continue;
    }
    if (tok === '--') {
      afterDashDash = true;
      continue;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      const a = byLong.get(name);
      if (!a) throw unexpected(tok);
      if (a.id === 'help') {
        out.help = 'long';
        return out;
      }
      if (a.kind !== 'value') {
        if (eq >= 0) throw usageError(def, bin, `unexpected value '${tok.slice(eq + 1)}' for '${argDisplay(a)}' found; no more were expected`);
        record(a, undefined);
        continue;
      }
      if (eq >= 0) {
        record(a, tok.slice(eq + 1));
        continue;
      }
      if (a.optionalValue) {
        const next = argv[i];
        if (!a.requireEquals && next !== undefined && next !== '' && !next.startsWith('-')) {
          i++;
          record(a, next);
        } else record(a, undefined);
        continue;
      }
      const next = argv[i];
      if (!takesNext(a, next)) throw missingValue(a);
      i++;
      record(a, next);
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1) {
      // short flag or cluster
      for (let k = 1; k < tok.length; k++) {
        const ch = tok[k]!;
        const a = byShort.get(ch);
        if (!a) throw unexpected(k === 1 ? tok.slice(0, 2) : `-${ch}`);
        if (a.id === 'help') {
          out.help = 'short';
          return out;
        }
        if (a.kind !== 'value') {
          record(a, undefined);
          continue;
        }
        let rest = tok.slice(k + 1);
        if (rest.startsWith('=')) rest = rest.slice(1);
        if (rest !== '') {
          record(a, rest);
        } else if (a.optionalValue) {
          const next = argv[i];
          if (!a.requireEquals && next !== undefined && next !== '' && !next.startsWith('-')) {
            i++;
            record(a, next);
          } else record(a, undefined);
        } else {
          const next = argv[i];
          if (!takesNext(a, next)) throw missingValue(a);
          i++;
          record(a, next);
        }
        break;
      }
      continue;
    }
    positionalTokens.push(tok);
  }

  // positionals
  const pdefs = def.positionals ?? [];
  let pi = 0;
  for (const p of pdefs) {
    if (pi >= positionalTokens.length) break;
    if (p.multiple) {
      out.positionals.set(p.id, positionalTokens.slice(pi));
      pi = positionalTokens.length;
    } else {
      out.positionals.set(p.id, [positionalTokens[pi]!]);
      pi++;
    }
  }
  if (pi < positionalTokens.length) throw usageError(def, bin, `unexpected argument '${positionalTokens[pi]}' found`);
  const missing = pdefs.filter((p) => p.required && !out.positionals.has(p.id));
  if (missing.length > 0) {
    throw usageError(def, bin, `the following required arguments were not provided:\n${missing.map((p) => `  ${positionalDisplay(p)}`).join('\n')}`);
  }

  // conflicts
  for (const a of args) {
    if (!a.conflictsWith || !out.has(a.id)) continue;
    for (const other of a.conflictsWith) {
      if (!out.has(other)) continue;
      const o = args.find((x) => x.id === other)!;
      // Name them in the order the user wrote them.
      const [first, second] = out.order.indexOf(a.id) < out.order.indexOf(other) ? [a, o] : [o, a];
      throw usageError(def, bin, `the argument '${argDisplay(first)}' cannot be used with '${argDisplay(second)}'`);
    }
  }
  return out;
}

/** Error for a required option that was not given (clap wording). */
export function missingRequired(def: CommandDef, bin: string, items: string[]): UsageError {
  return usageError(def, bin, `the following required arguments were not provided:\n${items.map((s) => `  ${s}`).join('\n')}`);
}

/** Build a clap-style usage error with the command's usage line. */
export function commandError(def: CommandDef, bin: string, head: string): UsageError {
  return usageError(def, bin, head);
}

// ───────────────────────────── help ─────────────────────────────

function optionLeft(a: ArgDef): string {
  const shortPart = a.short !== undefined ? `-${a.short}${a.long !== undefined ? ', ' : ''}` : '    ';
  let longPart = a.long !== undefined ? `--${a.long}` : '';
  if (a.kind === 'value') longPart += a.optionalValue ? ` [${valuePlaceholder(a)}]` : ` ${valuePlaceholder(a)}`;
  if (a.kind === 'count' || (a.multiple && a.kind !== 'value')) longPart += '...';
  return `  ${shortPart}${longPart}`;
}

function shortHelpText(a: ArgDef, help: string): string {
  const extras: string[] = [];
  if (a.defaultValue !== undefined) extras.push(`[default: ${a.defaultValue}]`);
  if (a.possibleValues) extras.push(`[possible values: ${a.possibleValues.join(', ')}]`);
  return [help, ...extras].filter((s) => s !== '').join(' ');
}

/**
 * Render help for `def` (see module doc). `mode` `short` ⇒ `-h` layout, `long` ⇒ `--help`
 * layout. Ends with a newline.
 */
export function renderHelp(def: CommandDef, bin: string, mode: 'short' | 'long'): string {
  const hasLongExtras = def.args.some((a) => a.longHelp !== undefined) || def.longAbout !== undefined;
  const args = withHelp(def)
    .filter((a) => !a.hidden)
    .map((a) =>
      a.id === 'help' && a.help === 'Print help' && hasLongExtras
        ? { ...a, help: mode === 'short' ? "Print help (see more with '--help')" : "Print help (see a summary with '-h')" }
        : a,
    );
  const lines: string[] = [];
  if (def.about) {
    lines.push(def.about);
    if (mode === 'long' && def.longAbout) lines.push('', def.longAbout);
    lines.push('');
  }
  lines.push(usageLine(def, bin));

  const subs = (def.subcommands ?? []).filter((s) => !s.hidden);
  if (subs.length > 0) {
    lines.push('', 'Commands:');
    const w = Math.max(...subs.map((s) => s.name.length));
    for (const s of subs) lines.push(`  ${s.name.padEnd(w)}  ${s.about}`.replace(/\s+$/, ''));
  }

  const pos = (def.positionals ?? []).filter((p) => !p.hidden);
  const optLefts = args.map(optionLeft);
  const posLefts = pos.map((p) => `  ${positionalDisplay(p)}`);
  const width = Math.max(0, ...optLefts.map((s) => s.length), ...posLefts.map((s) => s.length));

  if (mode === 'short') {
    if (pos.length > 0) {
      lines.push('', 'Arguments:');
      pos.forEach((p, k) => lines.push(`${posLefts[k]!.padEnd(width)}  ${p.help ?? ''}`.replace(/\s+$/, '')));
    }
    if (args.length > 0) {
      lines.push('', 'Options:');
      args.forEach((a, k) => lines.push(`${optLefts[k]!.padEnd(width)}  ${shortHelpText(a, a.help ?? '')}`.replace(/\s+$/, '')));
    }
  } else {
    const ind = ' '.repeat(10);
    const block = (left: string, help: string | undefined, longHelp: string | undefined, a?: ArgDef): string[] => {
      const b = [left];
      const text = [help, longHelp].filter((s): s is string => s !== undefined && s !== '').join('\n\n');
      if (text) for (const l of text.split('\n')) b.push(l === '' ? '' : `${ind}${l}`);
      if (a?.defaultValue !== undefined) {
        if (text) b.push('');
        b.push(`${ind}[default: ${a.defaultValue}]`);
      }
      if (a?.possibleValues) {
        if (text || a.defaultValue !== undefined) b.push('');
        b.push(`${ind}[possible values: ${a.possibleValues.join(', ')}]`);
      }
      return b;
    };
    if (pos.length > 0) {
      lines.push('', 'Arguments:');
      pos.forEach((p, k) => {
        if (k > 0) lines.push('');
        lines.push(...block(posLefts[k]!, p.help, undefined));
      });
    }
    if (args.length > 0) {
      lines.push('', 'Options:');
      args.forEach((a, k) => {
        if (k > 0) lines.push('');
        lines.push(...block(optLefts[k]!, a.help, a.longHelp, a));
      });
    }
  }
  if (def.afterHelp) lines.push('', def.afterHelp);
  return `${lines.join('\n')}\n`;
}
