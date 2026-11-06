/**
 * Glob matching in the four dialects kiro-claude needs, plus a filesystem walker.
 *
 * Dialects
 * --------
 * - `'globset'` — Rust `globset 0.4.17` with default options (06 §1.2, 02 §2.6): `*` and `?`
 *   DO match `/` (literal_separator = false); `**` handling via RecursivePrefix (`**​/x`),
 *   RecursiveSuffix (`x/**`, does not match `x` itself) and RecursiveZeroOrMore (`a/**​/b`
 *   matches `a/b`); a `**` not adjacent to `/` or the pattern edge is just two `*`;
 *   classes `[abc]`, `[a-z]`, `[!x]`/`[^x]` (unclosed `[` is an error); nestable `{a,b}`
 *   alternation with empty branches dropped; `\x` escapes (POSIX; a dangling `\` is an
 *   error). Used by Q/V2 `allowedTools`, hook matchers and `toolsSettings` path globs.
 *   The tokenizer is a TS port of the verified reference in 06 Appendix A.
 * - `'path'` — Rust `glob 0.3.3` `Pattern` with `require_literal_separator = true`, i.e. the
 *   dialect used for `file://` resources and steering (06 Appendix B, 06 §4.2, 02 §2.9):
 *   `*`, `?` and classes never match `/`; `**` must be an entire path component and matches
 *   zero or more directories (at the end of the pattern it matches everything below);
 *   `a**`, `**a`, `***` are errors; classes negate only with `!` (`^` is literal), `[]]`
 *   and `[!]]` include `]`, inverted ranges never match; NO braces and NO escapes (`\` is a
 *   literal character on POSIX). Dot-files are matched by wildcards.
 * - `'v3path'` — Kiro V3 permission path globs (02 §2.8): globset with
 *   `literal_separator = true` (so like `'path'` for `*`/`?`/`**`, but WITH `{a,b}` braces,
 *   `\` escapes, `[^x]` negation, and lenient `a**` = `a*`); classes never match `/`.
 *   Additionally a pattern without any wildcard (`*`, `?`, `[`) implicitly matches its
 *   children: `p` ≡ `p` OR `p/**` (trailing slashes ignored). The rule is applied to the
 *   pattern as a whole (`{src,lib}` matches `src/x`; `{src,*.md}` does not match `src/x`).
 * - `'wildcard'` — Kiro V3 shell / MCP / subagent / web match strings (02 §2.8): only `*`
 *   is special and matches any sequence (including spaces and `/`); everything else is
 *   literal. Matching uses a linear-time-ish iterative matcher (no regex backtracking), so
 *   huge shell commands are safe.
 *
 * Windows: for `'path'`/`'v3path'`, when `opts.windows` (default `process.platform ===
 * 'win32'`) is set, `\` in patterns and subjects is treated as `/` (and is not an escape),
 * mirroring the Rust crates' Windows defaults. Callers matching paths should pass
 * `/`-separated subjects on every platform (see `toPosixPath` in paths.ts).
 *
 * All regexes are anchored (`^…$`), use the `u` flag, and are cached by
 * {@link globMatch}. Invalid patterns make {@link globToRegExp} throw {@link GlobPatternError};
 * {@link globMatch} treats them as non-matching (Q skips invalid globs).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homeDir } from './paths.js';
import { log } from './log.js';

export type GlobDialect =
  /** Rust globset defaults (literal_separator=false). Q allowedTools / hook matchers / toolsSettings paths. */
  | 'globset'
  /** Rust `glob` crate: `*`,`?` never match `/`; `**` = whole components; no braces. Resources/steering. */
  | 'path'
  /** Kiro V3 permission path globs: like 'path' + braces + implicit children for literal patterns. */
  | 'v3path'
  /** Kiro V3 shell/mcp/subagent/web: only `*` is special (any sequence incl. `/`). */
  | 'wildcard';

export interface GlobMatchOptions {
  caseInsensitive?: boolean;
  /** Treat `\` as a path separator for 'path'/'v3path' (default: running on Windows). */
  windows?: boolean;
}

/** Invalid glob pattern. `pos` is the approximate code-point index of the problem. */
export class GlobPatternError extends Error {
  readonly pattern: string;
  readonly dialect: GlobDialect;
  readonly pos?: number;
  constructor(pattern: string, dialect: GlobDialect, reason: string, pos?: number) {
    super(`invalid ${dialect} glob ${JSON.stringify(pattern)}: ${reason}`);
    this.name = 'GlobPatternError';
    this.pattern = pattern;
    this.dialect = dialect;
    if (pos !== undefined) this.pos = pos;
  }
}

// ───────────────────────────── regex escaping ─────────────────────────────

/** Escape a literal for use outside a character class (valid with the `u` flag). */
function escLit(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

/** Escape a literal for use inside a character class (valid with the `u` flag). */
function escClass(ch: string): string {
  return /[\\\]\[^-]/.test(ch) ? `\\${ch}` : ch;
}

const ANY = '[\\s\\S]';

function cp(ch: string): number {
  return ch.codePointAt(0) ?? 0;
}

function classBody(ranges: ReadonlyArray<readonly [string, string]>): string {
  let out = '';
  for (const [a, b] of ranges) {
    if (a === b) out += escClass(a);
    else if (cp(a) < cp(b)) out += `${escClass(a)}-${escClass(b)}`;
    // inverted ranges never match (and would be a JS syntax error): skip
  }
  return out;
}

/** Character class that never matches `/` (literal-separator semantics). */
function sepSafeClass(negated: boolean, ranges: ReadonlyArray<readonly [string, string]>): string {
  const body = classBody(ranges);
  if (negated) return `[^${body}/]`;
  if (body === '') return '(?!)';
  return `(?!/)[${body}]`;
}

function plainClass(negated: boolean, ranges: ReadonlyArray<readonly [string, string]>): string {
  const body = classBody(ranges);
  if (body === '') return negated ? ANY : '(?!)';
  return `[${negated ? '^' : ''}${body}]`;
}

// ───────────────────────────── globset tokenizer ─────────────────────────────

type GsToken =
  | { t: 'lit'; c: string }
  | { t: 'any' }
  | { t: 'zom' }
  | { t: 'rpre' }
  | { t: 'rsuf' }
  | { t: 'rzom' }
  | { t: 'class'; negated: boolean; ranges: Array<[string, string]> }
  | { t: 'alt'; alts: GsToken[][] };

interface GsOptions {
  literalSeparator: boolean;
  backslashEscape: boolean;
}

/** Port of globset 0.4.17 `Parser` (default options), 06 Appendix A. */
function parseGlobset(glob: string, dialect: GlobDialect, o: GsOptions): GsToken[] {
  const chars = [...glob];
  let pos = 0;
  let prev: string | undefined;
  let cur: string | undefined;
  const bump = (): string | undefined => {
    prev = cur;
    cur = chars[pos++];
    return cur;
  };
  const peek = (): string | undefined => chars[pos];
  const branches: GsToken[][] = [[]];
  const altStack: number[] = [];
  const push = (t: GsToken): void => {
    branches[branches.length - 1]!.push(t);
  };
  const popTok = (): GsToken | undefined => branches[branches.length - 1]!.pop();
  const have = (): boolean => branches[branches.length - 1]!.length > 0;
  const isSep = (ch: string | undefined): boolean => ch === '/';
  const err = (reason: string): never => {
    throw new GlobPatternError(glob, dialect, reason, Math.max(0, pos - 1));
  };
  let ch: string | undefined;
  while ((ch = bump()) !== undefined) {
    if (ch === '?') push({ t: 'any' });
    else if (ch === '*') {
      const pv = prev;
      if (peek() !== '*') {
        push({ t: 'zom' });
        continue;
      }
      bump();
      if (!have()) {
        if (peek() !== undefined && !isSep(peek())) {
          push({ t: 'zom' });
          push({ t: 'zom' });
        } else {
          push({ t: 'rpre' });
          bump();
        }
        continue;
      }
      if (!(pv !== undefined && isSep(pv))) {
        if (branches.length <= 1 || (pv !== ',' && pv !== '{')) {
          push({ t: 'zom' });
          push({ t: 'zom' });
          continue;
        }
      }
      let isSuffix: boolean;
      const nx = peek();
      if (nx === undefined) {
        bump();
        isSuffix = true;
      } else if ((nx === ',' || nx === '}') && branches.length >= 2) {
        isSuffix = true;
      } else if (isSep(nx)) {
        bump();
        isSuffix = false;
      } else {
        push({ t: 'zom' });
        push({ t: 'zom' });
        continue;
      }
      const p = popTok();
      if (p && p.t === 'rpre') push({ t: 'rpre' });
      else if (p && p.t === 'rsuf') push({ t: 'rsuf' });
      else push({ t: isSuffix ? 'rsuf' : 'rzom' });
    } else if (ch === '[') {
      let negated = false;
      if (peek() === '!' || peek() === '^') {
        bump();
        negated = true;
      }
      const ranges: Array<[string, string]> = [];
      let first = true;
      let inRange = false;
      for (;;) {
        const d = bump();
        if (d === undefined) err('unclosed character class');
        if (d === ']') {
          if (first) ranges.push([']', ']']);
          else break;
        } else if (d === '-') {
          if (first) ranges.push(['-', '-']);
          else if (inRange) {
            const r = ranges[ranges.length - 1]!;
            r[1] = '-';
            if (cp(r[1]) < cp(r[0])) err('invalid character range');
            inRange = false;
          } else inRange = true;
        } else {
          if (inRange) {
            const r = ranges[ranges.length - 1]!;
            r[1] = d!;
            if (cp(r[1]) < cp(r[0])) err('invalid character range');
          } else ranges.push([d!, d!]);
          inRange = false;
        }
        first = false;
      }
      if (inRange) ranges.push(['-', '-']);
      push({ t: 'class', negated, ranges });
    } else if (ch === '{') {
      altStack.push(branches.length);
      branches.push([]);
    } else if (ch === '}') {
      if (!altStack.length) err('unopened alternate group');
      const start = altStack.pop()!;
      const alts = branches.splice(start);
      push({ t: 'alt', alts });
    } else if (ch === ',') {
      if (!altStack.length) push({ t: 'lit', c: ',' });
      else branches.push([]);
    } else if (ch === '\\' && o.backslashEscape) {
      const d = bump();
      if (d === undefined) err('dangling escape');
      push({ t: 'lit', c: d! });
    } else push({ t: 'lit', c: ch });
  }
  if (altStack.length) err('unclosed alternate group');
  return branches[0]!;
}

function globsetTokensToRegex(tokens: GsToken[], o: GsOptions): string {
  const one = o.literalSeparator ? '[^/]' : ANY;
  const conv = (toks: GsToken[]): string =>
    toks
      .map((tk): string => {
        switch (tk.t) {
          case 'lit':
            return escLit(tk.c);
          case 'any':
            return one;
          case 'zom':
            return `${one}*`;
          case 'rpre':
            return `(?:/?|${ANY}*/)`;
          case 'rsuf':
            return `/${ANY}*`;
          case 'rzom':
            return `(?:/|/${ANY}*/)`;
          case 'class':
            return o.literalSeparator ? sepSafeClass(tk.negated, tk.ranges) : plainClass(tk.negated, tk.ranges);
          case 'alt': {
            const parts = tk.alts.map(conv).filter((s) => s.length > 0);
            return parts.length ? `(?:${parts.join('|')})` : '';
          }
        }
      })
      .join('');
  if (tokens.length === 1 && tokens[0]!.t === 'rpre') return `${ANY}*`;
  return conv(tokens);
}

// ───────────────────────────── glob-crate tokenizer ─────────────────────────────

type PathToken =
  | { t: 'char'; c: string }
  | { t: 'any' }
  | { t: 'seq' }
  | { t: 'rec' }
  | { t: 'class'; negated: boolean; ranges: Array<[string, string]> };

/** Port of glob 0.3.3 `Pattern::new` (06 Appendix B). */
function parseGlobCrate(pattern: string, dialect: GlobDialect): PathToken[] {
  const chars = [...pattern];
  const tokens: PathToken[] = [];
  let i = 0;
  const err = (reason: string, at: number): never => {
    throw new GlobPatternError(pattern, dialect, reason, at);
  };
  while (i < chars.length) {
    const ch = chars[i]!;
    if (ch === '?') {
      tokens.push({ t: 'any' });
      i++;
    } else if (ch === '*') {
      const old = i;
      while (i < chars.length && chars[i] === '*') i++;
      const count = i - old;
      if (count > 2) err('wildcards are either regular `*` or recursive `**`', old + 2);
      if (count === 2) {
        if (i === 2 || chars[i - count - 1] === '/') {
          if (i < chars.length && chars[i] === '/') i++;
          else if (i !== chars.length) err('recursive wildcards must form a single path component', i);
        } else err('recursive wildcards must form a single path component', old - 1);
        const last = tokens[tokens.length - 1];
        if (!(last && last.t === 'rec')) tokens.push({ t: 'rec' });
      } else tokens.push({ t: 'seq' });
    } else if (ch === '[') {
      // `[!` needs at least one char before the closing `]`; `[` likewise.
      if (i + 4 <= chars.length && chars[i + 1] === '!') {
        const j = chars.slice(i + 3).indexOf(']');
        if (j >= 0) {
          tokens.push({ t: 'class', negated: true, ranges: parseCharSpecifiers(chars.slice(i + 2, i + 3 + j)) });
          i += j + 4;
          continue;
        }
      } else if (i + 3 <= chars.length && chars[i + 1] !== '!') {
        const j = chars.slice(i + 2).indexOf(']');
        if (j >= 0) {
          tokens.push({ t: 'class', negated: false, ranges: parseCharSpecifiers(chars.slice(i + 1, i + 2 + j)) });
          i += j + 3;
          continue;
        }
      }
      err('invalid range pattern', i);
    } else {
      tokens.push({ t: 'char', c: ch });
      i++;
    }
  }
  return tokens;
}

function parseCharSpecifiers(s: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  while (i < s.length) {
    if (i + 3 <= s.length && s[i + 1] === '-') {
      out.push([s[i]!, s[i + 2]!]);
      i += 3;
    } else {
      out.push([s[i]!, s[i]!]);
      i++;
    }
  }
  return out;
}

function globCrateTokensToRegex(tokens: PathToken[]): string {
  let out = '';
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k]!;
    switch (tk.t) {
      case 'char':
        out += escLit(tk.c);
        break;
      case 'any':
        out += '[^/]';
        break;
      case 'seq':
        out += '[^/]*';
        break;
      case 'rec':
        // Last token: swallow the rest. Otherwise: zero or more whole directories.
        out += k === tokens.length - 1 ? `${ANY}*` : `(?:${ANY}*/)?`;
        break;
      case 'class':
        out += sepSafeClass(tk.negated, tk.ranges);
        break;
    }
  }
  return out;
}

// ───────────────────────────── wildcard dialect ─────────────────────────────

function wildcardToRegex(pattern: string): string {
  return pattern
    .split('*')
    .map((part) => [...part].map(escLit).join(''))
    .join(`${ANY}*`);
}

/**
 * `*`-only wildcard match (iterative, greedy with backtracking to the last star):
 * O(n·m) worst case, no exponential regex behavior.
 */
export function wildcardMatch(pattern: string, subject: string, caseInsensitive = false): boolean {
  const p = caseInsensitive ? pattern.toLowerCase() : pattern;
  const s = caseInsensitive ? subject.toLowerCase() : subject;
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = si;
    } else if (pi < p.length && p[pi] === s[si]) {
      pi++;
      si++;
    } else if (star >= 0) {
      pi = star + 1;
      si = ++mark;
    } else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

// ───────────────────────────── public API ─────────────────────────────

function useWindows(opts?: GlobMatchOptions): boolean {
  return opts?.windows ?? process.platform === 'win32';
}

/** True if `s` contains an unescaped character that is special in `dialect` (default globset). */
export function hasGlobMeta(s: string, dialect: GlobDialect = 'globset'): boolean {
  switch (dialect) {
    case 'wildcard':
      return s.includes('*');
    case 'path':
      return /[*?[]/.test(s);
    case 'globset':
    case 'v3path': {
      const escapes = !(dialect === 'v3path' && process.platform === 'win32');
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\\' && escapes) {
          i++;
          continue;
        }
        if (ch === '*' || ch === '?' || ch === '[' || ch === '{') return true;
      }
      return false;
    }
  }
}

/** True if `s` contains an unescaped `*`, `?` or `[` (braces do not count). */
function hasWildcard(s: string, escapes: boolean): boolean {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && escapes) {
      i++;
      continue;
    }
    if (ch === '*' || ch === '?' || ch === '[') return true;
  }
  return false;
}

/** Regex source (unanchored body) for `pattern` in `dialect`. Throws GlobPatternError. */
function regexBody(pattern: string, dialect: GlobDialect, windows: boolean): string {
  switch (dialect) {
    case 'wildcard':
      return wildcardToRegex(pattern);
    case 'globset':
      return globsetTokensToRegex(parseGlobset(pattern, dialect, { literalSeparator: false, backslashEscape: true }), {
        literalSeparator: false,
        backslashEscape: true,
      });
    case 'path': {
      const p = windows ? pattern.replace(/\\/g, '/') : pattern;
      return globCrateTokensToRegex(parseGlobCrate(p, dialect));
    }
    case 'v3path': {
      const o: GsOptions = { literalSeparator: true, backslashEscape: !windows };
      let p = windows ? pattern.replace(/\\/g, '/') : pattern;
      if (p !== '' && !hasWildcard(p, o.backslashEscape)) {
        // Literal (possibly braced) pattern: also matches everything below it.
        p = p.replace(/\/+$/, '');
        if (p === '') return `/${ANY}*`; // pattern was "/" (or "///")
        const body = globsetTokensToRegex(parseGlobset(p, dialect, o), o);
        return `(?:${body})(?:/${ANY}*)?`;
      }
      return globsetTokensToRegex(parseGlobset(p, dialect, o), o);
    }
  }
}

/**
 * Compile `pattern` to an anchored RegExp (`^…$`, flags `u` and optionally `i`).
 * Throws {@link GlobPatternError} for invalid patterns.
 */
export function globToRegExp(pattern: string, dialect: GlobDialect, opts?: GlobMatchOptions): RegExp {
  const body = regexBody(pattern, dialect, useWindows(opts));
  return new RegExp(`^${body}$`, opts?.caseInsensitive ? 'iu' : 'u');
}

/** `undefined` if `pattern` is valid in `dialect`, else the error message. */
export function validateGlob(pattern: string, dialect: GlobDialect, opts?: GlobMatchOptions): string | undefined {
  try {
    globToRegExp(pattern, dialect, opts);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const CACHE_MAX = 512;
const cache = new Map<string, RegExp | null>();

function cachedRegExp(pattern: string, dialect: GlobDialect, opts?: GlobMatchOptions): RegExp | null {
  const key = `${dialect}\u0000${opts?.caseInsensitive ? 1 : 0}${useWindows(opts) ? 1 : 0}\u0000${pattern}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // refresh LRU position
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let re: RegExp | null;
  try {
    re = globToRegExp(pattern, dialect, opts);
  } catch {
    re = null;
  }
  cache.set(key, re);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return re;
}

/**
 * Match `subject` against `pattern` in `dialect`. Invalid patterns never match.
 * For 'path'/'v3path' on Windows (see {@link GlobMatchOptions.windows}) backslashes in the
 * subject are treated as `/`.
 */
export function globMatch(pattern: string, subject: string, dialect: GlobDialect, opts?: GlobMatchOptions): boolean {
  if (dialect === 'wildcard') return wildcardMatch(pattern, subject, opts?.caseInsensitive ?? false);
  const re = cachedRegExp(pattern, dialect, opts);
  if (!re) return false;
  const subj = (dialect === 'path' || dialect === 'v3path') && useWindows(opts) ? subject.replace(/\\/g, '/') : subject;
  return re.test(subj);
}

/**
 * Brace expansion with globset semantics (nestable, empty alternatives dropped, `[...]`
 * classes and `\` escapes respected): `"{a,b}/x"` → `["a/x", "b/x"]`,
 * `"{.kiro,~/.kiro}/agents/**"` → two patterns (handy before tilde expansion).
 * Throws {@link GlobPatternError} for unbalanced braces or more than `limit` results.
 */
export function expandBraces(pattern: string, opts: { escapes?: boolean; limit?: number } = {}): string[] {
  const escapes = opts.escapes ?? true;
  const limit = opts.limit ?? 4096;
  const chars = [...pattern];
  let pos = 0;
  const err = (reason: string): never => {
    throw new GlobPatternError(pattern, 'v3path', reason, pos);
  };
  const cross = (a: string[], b: string[]): string[] => {
    const out: string[] = [];
    for (const x of a) for (const y of b) out.push(x + y);
    if (out.length > limit) err(`brace expansion exceeds ${limit} alternatives`);
    return out;
  };
  // parseSeq: reads until ',' or '}' (when nested) or end; returns expansions of that sequence.
  const parseSeq = (nested: boolean): string[] => {
    let acc: string[] = [''];
    let lit = '';
    const flush = (): void => {
      if (lit) {
        acc = acc.map((x) => x + lit);
        lit = '';
      }
    };
    while (pos < chars.length) {
      const ch = chars[pos]!;
      if (ch === '\\' && escapes) {
        lit += ch + (chars[pos + 1] ?? '');
        pos += 2;
        continue;
      }
      if (ch === '[') {
        // copy a class verbatim (globset rules: leading `!`/`^`, then `]` allowed first)
        let j = pos + 1;
        if (chars[j] === '!' || chars[j] === '^') j++;
        if (chars[j] === ']') j++;
        while (j < chars.length && chars[j] !== ']') j++;
        if (j >= chars.length) {
          lit += chars.slice(pos).join('');
          pos = chars.length;
          continue;
        }
        lit += chars.slice(pos, j + 1).join('');
        pos = j + 1;
        continue;
      }
      if (ch === '{') {
        pos++;
        flush();
        const alts: string[] = [];
        for (;;) {
          const part = parseSeq(true);
          for (const p of part) if (p !== '') alts.push(p); // empty alternatives dropped (globset)
          if (pos >= chars.length) err('unclosed alternate group');
          const close = chars[pos];
          pos++;
          if (close === '}') break; // otherwise ','
        }
        acc = cross(acc, alts.length ? alts : ['']);
        continue;
      }
      if (nested && (ch === ',' || ch === '}')) {
        flush();
        return acc;
      }
      if (ch === '}' && !nested) err('unopened alternate group');
      lit += ch;
      pos++;
    }
    flush();
    return acc;
  };
  const out = parseSeq(false);
  return [...new Set(out)];
}

// ───────────────────────────── filesystem walker ─────────────────────────────

export interface WalkGlobOptions {
  /** Base directory for relative patterns. */
  cwd: string;
  /** Environment for `~` expansion. */
  env?: NodeJS.ProcessEnv;
  /** Only return regular files (symlinks to files count). Default true. */
  onlyFiles?: boolean;
  /** Directory names never entered by wildcard / `**` expansion. Default ['.git', 'node_modules']. */
  ignoreDirs?: string[];
  /** Stop after this many results. Default 10000. */
  maxResults?: number;
  /** Descend into symlinked directories (with loop protection). Default false. */
  followSymlinks?: boolean;
}

type Comp = { k: 'lit'; s: string } | { k: 're'; re: RegExp } | { k: 'rec' };

function statSafe(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

function lstatSafe(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

function realSafe(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Escape `s` so it matches itself literally in `dialect` (bracket classes, which every
 * dialect except `'wildcard'` understands: `*` → `[*]`, `?` → `[?]`, `[` → `[[]`, plus `{`,
 * `}` and — where it is an escape character — `\` for globset/v3path). Use it for literal
 * path prefixes (a workspace root such as `/Users/me/Projects [old]`) before appending a
 * pattern. `'wildcard'` has no escape syntax: `s` is returned unchanged.
 */
export function escapeGlob(s: string, dialect: GlobDialect = 'path', opts?: GlobMatchOptions): string {
  if (dialect === 'wildcard') return s;
  const braces = dialect === 'globset' || dialect === 'v3path';
  const backslash = dialect === 'globset' || (dialect === 'v3path' && !useWindows(opts));
  let out = '';
  for (const ch of s) {
    if (ch === '*' || ch === '?' || ch === '[' || (braces && (ch === '{' || ch === '}')) || (backslash && ch === '\\')) {
      out += `[${ch}]`;
    } else out += ch;
  }
  return out;
}

/**
 * Expand a `'path'`-dialect glob against the filesystem.
 *
 * - `pattern` may be absolute, `~`-prefixed or relative to `opts.cwd`. Only the pattern text
 *   is glob syntax: `opts.cwd` and the home directory substituted for `~` are literal, so a
 *   workspace under `Projects [old]/` works (for an absolute pattern built from such a path,
 *   escape the prefix with {@link escapeGlob}). Leading `..`/`.` components are applied to
 *   that base lexically, like `path.resolve`.
 * - Without glob meta (`*`, `?`, `[`) the result is `[abs]` when that path exists and passes
 *   the type filter (`onlyFiles`), else `[]`.
 * - Semantics equal {@link globMatch} in the `'path'` dialect applied to every entry below the
 *   literal prefix; in particular a trailing `**` matches every file below (the Rust walker
 *   only yields directories for it — deliberate deviation so `docs/**` is useful).
 * - A trailing `/` returns directories only (overrides `onlyFiles`).
 * - `ignoreDirs` apply to directories reached through wildcards or `**`, never to literal
 *   components written in the pattern.
 * - Results are absolute, de-duplicated and sorted; unreadable directories are skipped;
 *   invalid patterns yield `[]` (logged at debug). Never throws.
 */
export function walkGlob(pattern: string, opts: WalkGlobOptions): string[] {
  try {
    return walkGlobInner(pattern, opts);
  } catch (e) {
    log.debug('walkGlob failed', pattern, e);
    return [];
  }
}

function walkGlobInner(pattern: string, opts: WalkGlobOptions): string[] {
  const onlyFiles = opts.onlyFiles ?? true;
  const ignore = new Set(opts.ignoreDirs ?? ['.git', 'node_modules']);
  const max = opts.maxResults ?? 10000;
  const follow = opts.followSymlinks ?? false;
  const win = process.platform === 'win32';

  const requireDir = win ? /[\\/]$/.test(pattern) : pattern.endsWith('/');

  // Split into a literal base directory and the pattern text relative to it, so glob
  // characters in the cwd / home path are never interpreted.
  let base: string;
  let rel: string;
  if (pattern === '~' || pattern.startsWith('~/') || (win && pattern.startsWith('~\\'))) {
    base = homeDir(opts.env ?? process.env);
    rel = pattern.slice(2);
  } else if (path.isAbsolute(pattern)) {
    const r = path.parse(pattern).root;
    base = path.resolve(r);
    rel = pattern.slice(r.length);
  } else {
    base = path.resolve(opts.cwd);
    rel = pattern;
  }
  const root = path.parse(base).root;
  // Lexical normalization with provenance (mirrors path.resolve: `..` never climbs above root).
  const stack: Array<{ s: string; literal: boolean }> = base
    .slice(root.length)
    .split(win ? /[\\/]/ : '/')
    .filter((s) => s !== '')
    .map((s) => ({ s, literal: true }));
  for (const seg of rel.split(win ? /[\\/]/ : '/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      stack.pop();
      continue;
    }
    stack.push({ s: seg, literal: false });
  }
  const isMeta = (p: { s: string; literal: boolean }): boolean => !p.literal && hasGlobMeta(p.s, 'path');
  const abs = path.join(root, ...stack.map((p) => p.s));

  const typeOk = (p: string): boolean => {
    const st = statSafe(p);
    if (!st) return false;
    if (requireDir) return st.isDirectory();
    if (onlyFiles) return st.isFile();
    return true;
  };

  if (!stack.some(isMeta)) {
    return lstatSafe(abs) && typeOk(abs) ? [abs] : [];
  }

  let k = 0;
  while (k < stack.length && !isMeta(stack[k]!)) k++;
  const parts = stack.slice(k).map((p) => p.s);
  // Validate the pattern part first (errors like `a**` are reported, not half-walked).
  const verr = validateGlob(parts.join('/'), 'path', { windows: false });
  if (verr) {
    log.debug(`walkGlob: ${verr}`);
    return [];
  }
  const startDir = path.join(root, ...stack.slice(0, k).map((p) => p.s));
  const comps: Comp[] = parts.map((s): Comp => {
    if (s === '**') return { k: 'rec' };
    if (hasGlobMeta(s, 'path')) return { k: 're', re: globToRegExp(s, 'path', { windows: false }) };
    return { k: 'lit', s };
  });

  const results = new Set<string>();
  const full = (): boolean => results.size >= max;
  const consider = (p: string): void => {
    if (full()) return;
    if (typeOk(p)) results.add(p);
  };

  interface Entry {
    name: string;
    full: string;
    isDir: boolean;
  }
  const list = (dir: string, ancestors: ReadonlySet<string>): Entry[] => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return dirents.map((d) => {
      const fullPath = path.join(dir, d.name);
      let isDir = d.isDirectory();
      if (!isDir && d.isSymbolicLink() && follow) {
        const st = statSafe(fullPath);
        isDir = !!st && st.isDirectory() && !ancestors.has(realSafe(fullPath));
      }
      return { name: d.name, full: fullPath, isDir };
    });
  };

  const withDir = (ancestors: ReadonlySet<string>, dir: string): ReadonlySet<string> => {
    if (!follow) return ancestors;
    const s = new Set(ancestors);
    s.add(realSafe(dir));
    return s;
  };

  const allBelow = (dir: string, ancestors: ReadonlySet<string>): void => {
    for (const e of list(dir, ancestors)) {
      if (full()) return;
      if (e.isDir && ignore.has(e.name)) continue;
      consider(e.full);
      if (e.isDir) allBelow(e.full, withDir(ancestors, e.full));
    }
  };

  const visit = (dir: string, i: number, ancestors: ReadonlySet<string>): void => {
    if (full()) return;
    const comp = comps[i];
    if (comp === undefined) return;
    const last = i === comps.length - 1;
    if (comp.k === 'rec') {
      let j = i;
      while (comps[j + 1]?.k === 'rec') j++;
      if (j === comps.length - 1) {
        allBelow(dir, ancestors);
        return;
      }
      visit(dir, j + 1, ancestors); // zero directories
      for (const e of list(dir, ancestors)) {
        if (full()) return;
        if (e.isDir && !ignore.has(e.name)) visit(e.full, i, withDir(ancestors, e.full));
      }
      return;
    }
    if (comp.k === 'lit') {
      const child = path.join(dir, comp.s);
      if (last) {
        if (lstatSafe(child)) consider(child);
      } else {
        const st = statSafe(child);
        if (st && st.isDirectory()) visit(child, i + 1, withDir(ancestors, child));
      }
      return;
    }
    for (const e of list(dir, ancestors)) {
      if (full()) return;
      if (!comp.re.test(e.name)) continue;
      if (last) {
        if (!(e.isDir && ignore.has(e.name))) consider(e.full);
      } else if (e.isDir && !ignore.has(e.name)) {
        visit(e.full, i + 1, withDir(ancestors, e.full));
      }
    }
  };

  const st = statSafe(startDir);
  if (!st || !st.isDirectory()) return [];
  visit(startDir, 0, follow ? new Set([realSafe(startDir)]) : new Set());
  return [...results].sort();
}
