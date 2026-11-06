/**
 * `.kiroignore` (02 §6.4): gitignore-syntax list of paths the agent must not read.
 *
 * Sources: the global `<kiroHome>/settings/kiroignore` first, then `<workspaceRoot>/.kiroignore`
 * (later lines win, as in git). Nested `.kiroignore` files in subdirectories and git's
 * `core.excludesfile` are NOT read (documented simplification: root file only).
 *
 * Supported gitignore subset:
 *  - blank lines and `#` comments; `\#` / `\!` escape a leading `#` / `!`; trailing
 *    unescaped spaces are trimmed;
 *  - `!pattern` re-includes (last matching line wins);
 *  - a trailing `/` matches directories only (the final path component is `stat`ed;
 *    ancestors are directories by definition);
 *  - a pattern containing `/` (other than a trailing one) is anchored to the root, a
 *    leading `/` is dropped; otherwise it matches the name at any depth;
 *  - `*`, `?`, `[...]` (with `!`/`^` negation) never cross `/`; `**` as a whole component:
 *    leading `**​/` = any directories, trailing `/**` = everything inside, `/**​/` = zero or
 *    more directories; any other `**` behaves like `*`;
 *  - like git, a file below an ignored directory cannot be re-included.
 *
 * `isIgnored(abs)` is `false` for paths outside the workspace root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkspaceContext } from '../types.js';
import { readTextIfExists } from '../util/fsx.js';
import { toPosixPath } from '../util/paths.js';

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

export interface KiroIgnore {
  isIgnored(absPath: string): boolean;
  /** Effective (non-comment) pattern lines, global first. */
  patterns: string[];
}

function escapeRe(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

/** Compile a gitignore glob body (no leading `!`, no trailing `/`) to a regex source. */
function compileBody(p: string): string {
  let out = '';
  let i = 0;
  while (i < p.length) {
    const ch = p[i]!;
    if (ch === '\\' && i + 1 < p.length) {
      out += escapeRe(p[i + 1]!);
      i += 2;
      continue;
    }
    if (ch === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/';
        const after = p[i + 2];
        if (atStart && (after === undefined || after === '/')) {
          if (after === undefined) {
            out += '.*';
            i += 2;
          } else {
            out += '(?:[^/]*/)*';
            i += 3;
          }
          continue;
        }
        while (p[i] === '*') i++;
        out += '[^/]*';
        continue;
      }
      out += '[^/]*';
      i++;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      if (p[j] === '!' || p[j] === '^') j++;
      if (p[j] === ']') j++;
      while (j < p.length && p[j] !== ']') j++;
      if (j < p.length) {
        let body = p.slice(i + 1, j);
        let neg = false;
        if (body.startsWith('!') || body.startsWith('^')) {
          neg = true;
          body = body.slice(1);
        }
        body = body.replace(/\\/g, '\\\\').replace(/\//g, '');
        out += neg ? `[^/${body}]` : `[${body}]`;
        i = j + 1;
        continue;
      }
      out += '\\[';
      i++;
      continue;
    }
    out += escapeRe(ch);
    i++;
  }
  return out;
}

/** Parse one line into a rule; `undefined` for blanks, comments and invalid patterns. */
export function parseIgnoreLine(line: string): { rule: Rule; text: string } | undefined {
  let l = line.replace(/\r$/, '');
  // Trim trailing spaces unless escaped.
  l = l.replace(/(?<!\\)[ \t]+$/, '');
  if (l === '' || l.startsWith('#')) return undefined;
  let negate = false;
  if (l.startsWith('!')) {
    negate = true;
    l = l.slice(1);
  } else if (l.startsWith('\\#') || l.startsWith('\\!')) {
    l = l.slice(1);
  }
  let dirOnly = false;
  if (l.endsWith('/')) {
    dirOnly = true;
    l = l.replace(/\/+$/, '');
  }
  if (l === '') return undefined;
  const anchored = l.includes('/');
  l = l.replace(/^\/+/, '');
  if (l === '') return undefined;
  const body = compileBody(l);
  let re: RegExp;
  try {
    re = new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`);
  } catch {
    return undefined;
  }
  return { rule: { re, negate, dirOnly }, text: line.trim() };
}

/** Build a matcher from pattern text (exported for tests and the gate). */
export function compileKiroIgnore(text: string, root: string): KiroIgnore {
  const rules: Rule[] = [];
  const patterns: string[] = [];
  for (const line of text.split('\n')) {
    const r = parseIgnoreLine(line);
    if (!r) continue;
    rules.push(r.rule);
    patterns.push(r.text);
  }
  const rootAbs = path.resolve(root);
  const verdict = (rel: string, isDir: boolean): boolean | undefined => {
    let v: boolean | undefined;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) v = !r.negate;
    }
    return v;
  };
  const isDirPath = (abs: string): boolean => {
    try {
      return fs.statSync(abs).isDirectory();
    } catch {
      return false;
    }
  };
  return {
    patterns,
    isIgnored(absPath: string): boolean {
      if (rules.length === 0) return false;
      const abs = path.resolve(absPath);
      const relNative = path.relative(rootAbs, abs);
      if (relNative === '' || relNative.startsWith('..') || path.isAbsolute(relNative)) return false;
      const parts = toPosixPath(relNative).split('/').filter((s) => s !== '');
      for (let i = 1; i < parts.length; i++) {
        if (verdict(parts.slice(0, i).join('/'), true) === true) return true;
      }
      return verdict(parts.join('/'), isDirPath(abs)) === true;
    },
  };
}

/** Load the global and workspace-root ignore files for `ws` (see module doc). */
export function loadKiroIgnore(ws: WorkspaceContext): KiroIgnore {
  const texts: string[] = [];
  for (const p of [path.join(ws.kiroHome, 'settings', 'kiroignore'), path.join(ws.workspaceRoot, '.kiroignore')]) {
    try {
      const t = readTextIfExists(p);
      if (t !== undefined) texts.push(t);
    } catch {
      // unreadable ignore file: treat as absent
    }
  }
  return compileKiroIgnore(texts.join('\n'), ws.workspaceRoot);
}
