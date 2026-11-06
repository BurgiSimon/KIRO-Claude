/**
 * Path helpers: home / Kiro home resolution, tilde expansion, workspace-root discovery,
 * containment checks and the private runtime directory.
 *
 * Semantics (with research references):
 *  - `KIRO_HOME` (02 §1.1, 01 §9): honored only when it is an absolute path that is not a
 *    filesystem root, not the home directory and not an ancestor of the home directory;
 *    otherwise `<home>/.kiro`.
 *  - Workspace root (02 §1.3, 00 §2.2 "Agent discovery"): if the cwd itself contains a `.kiro`
 *    or `.amazonq` directory it is the root; otherwise walk up to the nearest ancestor that
 *    contains a `.kiro` **directory**, but never return the home directory itself or any of its
 *    ancestors (home `.kiro` is user-level config, not a workspace). Nothing found ⇒ cwd.
 *  - `runtimeDir` is the per-user private directory (0700) for transient files such as the
 *    generated system-prompt file (00 §6.1): `<$XDG_RUNTIME_DIR | tmpdir>/kiro-claude-<uid>`.
 *    If that path exists but is not a directory owned by the current user (a squatter in a
 *    shared /tmp), a fresh `mkdtemp` directory is used instead.
 *
 * Every function takes an optional `env` so tests (and callers working for another
 * environment) never need to mutate `process.env`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdirp } from './fsx.js';

/** User home directory: `$HOME`, else `$USERPROFILE`, else `os.homedir()`. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  const h = env.HOME;
  if (h && h.trim() !== '') return path.resolve(h);
  const up = env.USERPROFILE;
  if (up && up.trim() !== '') return path.resolve(up);
  return os.homedir();
}

/** True when `p` is a filesystem root (`/`, `C:\`). */
function isFsRoot(p: string): boolean {
  const r = path.resolve(p);
  return path.dirname(r) === r;
}

/**
 * Kiro's global configuration root: `$KIRO_HOME` when usable (see module doc), else
 * `<home>/.kiro`.
 */
export function kiroHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = homeDir(env);
  const kh = env.KIRO_HOME;
  if (kh && path.isAbsolute(kh)) {
    const r = path.resolve(kh);
    const isHomeOrAncestor = isSubpath(home, r); // r == home, or home is inside r
    if (!isFsRoot(r) && !isHomeOrAncestor) return r;
  }
  return path.join(home, '.kiro');
}

/**
 * Expand a leading `~` (`~`, `~/x`, and `~\x` on Windows). `~user` forms are left unchanged.
 */
export function expandTilde(p: string, env: NodeJS.ProcessEnv = process.env): string {
  if (p === '~') return homeDir(env);
  if (p.startsWith('~/') || (process.platform === 'win32' && p.startsWith('~\\'))) {
    return path.join(homeDir(env), p.slice(2));
  }
  return p;
}

/** `path.resolve(base, expandTilde(p))`. */
export function resolvePath(p: string, base: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(base, expandTilde(p, env));
}

function isDirSafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Nearest workspace root for `cwd` (see module doc). Returns `path.resolve(cwd)` when no
 * ancestor qualifies.
 */
export function findWorkspaceRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const start = path.resolve(cwd);
  const home = homeDir(env);
  // The cwd itself is a workspace when it has `.kiro/` or a legacy `.amazonq/` (02 §1.3) —
  // unless it is home (or above home), whose `.kiro` is the user-level config.
  const startIsHomeOrAbove = isSubpath(home, start);
  if (!startIsHomeOrAbove && (isDirSafe(path.join(start, '.kiro')) || isDirSafe(path.join(start, '.amazonq')))) {
    return start;
  }
  let d = start;
  for (;;) {
    // Once we reach home or one of its ancestors every further ancestor is excluded too.
    if (isSubpath(home, d)) break;
    if (isDirSafe(path.join(d, '.kiro'))) return d;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return start;
}

/** `fs.realpathSync.native(p)`, or `path.resolve(p)` when that fails (e.g. path missing). */
export function realpathSafe(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Like {@link realpathSafe}, but for a path that does not exist, resolve symlinks in its
 * deepest existing ancestor and append the remaining components (e.g. macOS
 * `/tmp/new-file` → `/private/tmp/new-file`; the deviation recommended in 06 §1.5).
 */
export function realpathDeep(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    // fall through
  }
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = path.dirname(cur);
    rest.unshift(path.basename(cur));
    if (parent === cur) return abs;
    cur = parent;
    try {
      const real = fs.realpathSync.native(cur);
      return path.join(real, ...rest);
    } catch {
      // keep climbing
    }
  }
}

/**
 * True when `child` equals `parent` or lies inside it (lexically, after `path.resolve`).
 * On Windows the comparison is case-insensitive (via `path.relative`).
 */
export function isSubpath(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // different drive on Windows
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

function userTag(env: NodeJS.ProcessEnv): string {
  if (typeof process.getuid === 'function') {
    try {
      return String(process.getuid());
    } catch {
      // fall through
    }
  }
  let name = '';
  try {
    name = os.userInfo().username;
  } catch {
    name = env.USER || env.USERNAME || '';
  }
  name = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return name || 'user';
}

const runtimeDirCache = new Map<string, string>();

/** Base directory for transient per-user files: `$XDG_RUNTIME_DIR` (absolute) or the tmpdir. */
function runtimeBase(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg && path.isAbsolute(xdg)) return xdg;
  const t = env.TMPDIR;
  if (t && path.isAbsolute(t)) return t;
  return os.tmpdir();
}

function ownedPrivateDir(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      try {
        fs.chmodSync(p, 0o700);
      } catch {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Private per-user runtime directory `<XDG_RUNTIME_DIR || tmpdir>/kiro-claude-<uid or user>`,
 * created with mode 0700. Never throws: on failure it falls back to a `mkdtemp` directory, and
 * as a last resort returns the computed path without creating it. The result is cached per
 * base directory for the life of the process.
 */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = runtimeBase(env);
  const cached = runtimeDirCache.get(base);
  if (cached && ownedPrivateDir(cached)) return cached;
  const wanted = path.join(base, `kiro-claude-${userTag(env)}`);
  let result = wanted;
  try {
    mkdirp(wanted, 0o700);
    if (!ownedPrivateDir(wanted)) {
      result = fs.mkdtempSync(path.join(base, `kiro-claude-${userTag(env)}-`));
      fs.chmodSync(result, 0o700);
    }
  } catch {
    try {
      result = fs.mkdtempSync(path.join(os.tmpdir(), `kiro-claude-${userTag(env)}-`));
    } catch {
      result = wanted;
    }
  }
  runtimeDirCache.set(base, result);
  return result;
}

/** `<kiroHome>/kiro-claude`: adapter-owned persistent data (caches etc.). Not created here. */
export function kiroClaudeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kiroHome(env), 'kiro-claude');
}

/** Convert Windows separators to `/` (no-op on POSIX paths). Useful before glob matching. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
