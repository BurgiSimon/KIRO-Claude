/**
 * Path canonicalization and path-glob construction for the permission engines.
 *
 * Q / Kiro 2.x (06 §1.5): `canonicalizes_path(s)` = shellexpand (`~`, `$VAR`, `${VAR}`; unknown
 * variables left as written) → join with the process cwd when relative → `realpath` when the
 * path exists, else lexical normalization (`.` dropped, `..` pops). Deviation recommended by
 * 06 §1.5 and adopted here: a path that does not exist is resolved through its deepest
 * existing ancestor (util/paths.realpathDeep), so `/tmp/new` and `/private/tmp` agree on macOS.
 *
 * Patterns are canonicalized the same way, with one improvement over Q: text that does not
 * come from the user's pattern (the cwd / workspace root a relative pattern is joined to, the
 * home directory substituted for `~`, the values of `$VAR`s) is treated as LITERAL and escaped
 * with util/glob.escapeGlob, so a workspace under `Projects [old]/` still works. The literal
 * leading components (everything before the first component containing glob syntax) are
 * resolved with realpathDeep; the remaining components are kept as pattern text.
 *
 * {@link gitignoreGlobs} reproduces Q `build_gitignore_glob_set`: every entry `c` adds the globs
 * `c` and `c/**` (so `~/temp` also matches everything below it).
 */

import * as path from 'node:path';
import { escapeGlob, type GlobDialect } from '../util/glob.js';
import { expandTilde, realpathDeep } from '../util/paths.js';

/** A run of characters that is either literal (from expansion) or user pattern text. */
interface Piece {
  text: string;
  literal: boolean;
}

/** Characters that make a pattern component non-literal (incl. escapes and braces). */
const META = new Set(['*', '?', '[', '{', '}', '\\']);

/** shellexpand-style expansion into literal / pattern pieces. */
function expandPieces(p: string, env: NodeJS.ProcessEnv, home: string): Piece[] {
  const out: Piece[] = [];
  let rest = p;
  if (rest === '~' || rest.startsWith('~/')) {
    out.push({ text: home, literal: true });
    rest = rest.slice(1);
  }
  let buf = '';
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i]!;
    if (ch === '$') {
      const tail = rest.slice(i);
      const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(tail) ?? /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(tail);
      const v = m ? env[m[1]!] : undefined;
      if (m && v !== undefined) {
        if (buf) out.push({ text: buf, literal: false });
        buf = '';
        out.push({ text: v, literal: true });
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  if (buf) out.push({ text: buf, literal: false });
  return out;
}

interface Comp {
  chars: string[];
  lits: boolean[];
}

function compText(c: Comp): string {
  return c.chars.join('');
}

function compHasMeta(c: Comp): boolean {
  return c.chars.some((ch, k) => !c.lits[k] && META.has(ch));
}

export interface CanonicalPattern {
  /** Glob pattern in the requested dialect (literal prefix escaped). */
  pattern: string;
  /** True when the user-written part contains no glob syntax (pattern is a plain path). */
  literal: boolean;
  /** Canonical literal prefix (unescaped absolute path). */
  prefix: string;
}

/**
 * Canonicalize a path pattern: expand `~`/`$VAR`, join relative patterns to `base`, normalize
 * `.`/`..`, realpath the literal prefix, escape it for `dialect`, keep the rest as pattern text.
 */
export function canonicalizePattern(
  p: string,
  base: string,
  env: NodeJS.ProcessEnv,
  home: string,
  dialect: GlobDialect,
): CanonicalPattern {
  let pieces = expandPieces(p, env, home);
  const first = pieces[0];
  if (!first || !first.text.startsWith('/')) {
    pieces = [{ text: `${base}/`, literal: true }, ...pieces];
  }
  // split into components, tracking per-character literal-ness
  const comps: Comp[] = [];
  let cur: Comp = { chars: [], lits: [] };
  for (const pc of pieces) {
    for (const ch of pc.text) {
      if (ch === '/') {
        comps.push(cur);
        cur = { chars: [], lits: [] };
      } else {
        cur.chars.push(ch);
        cur.lits.push(pc.literal);
      }
    }
  }
  comps.push(cur);
  // lexical normalization
  const norm: Comp[] = [];
  for (const c of comps) {
    const t = compText(c);
    if (t === '' || t === '.') continue;
    if (t === '..' && !compHasMeta(c)) {
      norm.pop();
      continue;
    }
    norm.push(c);
  }
  let k = 0;
  while (k < norm.length && !compHasMeta(norm[k]!)) k++;
  const prefix = realpathDeep(`/${norm.slice(0, k).map(compText).join('/')}`);
  const rest = norm.slice(k).map((c) =>
    c.chars.map((ch, idx) => (c.lits[idx] ? escapeGlob(ch, dialect) : ch)).join(''),
  );
  const escPrefix = escapeGlob(prefix, dialect);
  const pattern = rest.length === 0 ? escPrefix : `${escPrefix === '/' ? '' : escPrefix}/${rest.join('/')}`;
  return { pattern, literal: rest.length === 0, prefix };
}

/** Canonical absolute form of a tool path (tilde expanded, resolved against `cwd`, realpathDeep). */
export function canonicalizePath(p: string, cwd: string, env: NodeJS.ProcessEnv): string {
  return realpathDeep(path.resolve(cwd, expandTilde(p, env)));
}

/**
 * Q `build_gitignore_glob_set` entries for one rule: the canonical pattern `c` and `c/**`.
 * Returns two globset-dialect patterns (index-aligned with Q's doubled labels).
 */
export function gitignoreGlobs(p: string, base: string, env: NodeJS.ProcessEnv, home: string): [string, string] {
  const c = canonicalizePattern(p, base, env, home, 'globset').pattern;
  const trimmed = c.replace(/\/+$/, '');
  return [c, `${trimmed}/**`];
}

/** Globset patterns for a literal directory (the cwd auto-allow of Q `fs_read`). */
export function literalDirGlobs(dir: string): [string, string] {
  const c = escapeGlob(realpathDeep(dir), 'globset');
  const trimmed = c.replace(/\/+$/, '');
  return [c, `${trimmed}/**`];
}
