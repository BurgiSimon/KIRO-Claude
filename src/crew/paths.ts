/**
 * Paths used by `kiro-claude crew` (08-kirocrew-integration §3.1, DECISION).
 *
 * | Name | Default | Override |
 * |---|---|---|
 * | crew state dir `$CS` | `${XDG_DATA_HOME:-$HOME/.local/share}/kiro-claude/crew` | `KIRO_CLAUDE_CREW_HOME` |
 * | shim | `$CS/bin/kiro-claude` | — |
 * | state file | `$CS/crew.json` (0600) | — |
 * | gateway run files | `$CS/run/gateway.out`, `gateway.err`, `ready.json`, `token` | — |
 * | members adapter | `$CS/node/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js` | — |
 * | KiroCrew checkout | `--dir` → `$KIRO_CLAUDE_CREW_DIR` → `<package root>/vendor/KiroCrew` (git checkout whose `.gitmodules` names it) → `$CS/KiroCrew` | `--dir`, `KIRO_CLAUDE_CREW_DIR` |
 * | KiroCrew data home | `$KIROCREW_HOME` or `~/.kiro/crew` (never set by us) | user's `KIROCREW_HOME` |
 * | identity store | fixed anchors: Linux `~/.local/share/kiro-cli/data.sqlite3`, macOS `~/Library/Application Support/kiro-cli/data.sqlite3` | none |
 *
 * Guards (08 §3.1, V9, KC-BIN-02): the shim must not live under a directory KiroCrew hides from
 * its probes ({@link probeHiddenDirs}); the checkout must not be inside a linked git worktree
 * ({@link inLinkedGitWorktree}, a port of KiroCrew's `_in_linked_git_worktree`) nor under the
 * system temp dir without `--allow-tmp`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { homeDir, isSubpath, realpathDeep, realpathSafe } from '../util/paths.js';
import { CLAUDE_AGENT_ACP, KIROCREW_SUBMODULE_PATH } from './pin.js';

/** `$CS`: the crew state dir. */
export function crewStateDir(env: NodeJS.ProcessEnv): string {
  const override = env.KIRO_CLAUDE_CREW_HOME;
  if (override && override.trim() && path.isAbsolute(override.trim())) return path.resolve(override.trim());
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() && path.isAbsolute(xdg.trim()) ? xdg.trim() : path.join(homeDir(env), '.local', 'share');
  return path.join(base, 'kiro-claude', 'crew');
}

/** Every file and directory under `$CS` the crew commands use. */
export interface CrewPaths {
  stateDir: string;
  binDir: string;
  shim: string;
  stateFile: string;
  runDir: string;
  gatewayOut: string;
  gatewayErr: string;
  readyFile: string;
  tokenFile: string;
  setupLog: string;
  cacheDir: string;
  npmCache: string;
  pipCache: string;
  membersPrefix: string;
  membersPackageDir: string;
  membersAdapter: string;
  /** `$CS/KiroCrew` (checkout used when kiro-claude is not a git checkout, e.g. npm installs). */
  ownCheckout: string;
}

export function crewPaths(env: NodeJS.ProcessEnv): CrewPaths {
  const cs = crewStateDir(env);
  const runDir = path.join(cs, 'run');
  const membersPrefix = path.join(cs, 'node');
  const membersPackageDir = path.join(membersPrefix, 'node_modules', ...CLAUDE_AGENT_ACP.name.split('/'));
  return {
    stateDir: cs,
    binDir: path.join(cs, 'bin'),
    shim: path.join(cs, 'bin', 'kiro-claude'),
    stateFile: path.join(cs, 'crew.json'),
    runDir,
    gatewayOut: path.join(runDir, 'gateway.out'),
    gatewayErr: path.join(runDir, 'gateway.err'),
    readyFile: path.join(runDir, 'ready.json'),
    tokenFile: path.join(runDir, 'token'),
    setupLog: path.join(runDir, 'setup.log'),
    cacheDir: path.join(cs, 'cache'),
    npmCache: path.join(cs, 'cache', 'npm'),
    pipCache: path.join(cs, 'cache', 'pip'),
    membersPrefix,
    membersPackageDir,
    membersAdapter: path.join(membersPackageDir, ...CLAUDE_AGENT_ACP.entry.split('/')),
    ownCheckout: path.join(cs, 'KiroCrew'),
  };
}

/** KiroCrew's data home: `$KIROCREW_HOME` (absolute) or `~/.kiro/crew`. */
export function kirocrewHome(env: NodeJS.ProcessEnv): string {
  const h = env.KIROCREW_HOME;
  if (h && h.trim() && path.isAbsolute(h.trim())) return path.resolve(h.trim());
  return path.join(homeDir(env), '.kiro', 'crew');
}

/** KiroCrew's `config.json` (nested JSON; `agent.acp_backend` is `{"agent":{"acp_backend":…}}`). */
export function kirocrewConfigFile(env: NodeJS.ProcessEnv): string {
  return path.join(kirocrewHome(env), 'config.json');
}

/**
 * kiro-cli's identity store (08 §3.1, §3.5): a FIXED, home-anchored path that KiroCrew reads
 * without consulting any environment variable (SRC `identity_stores.IDENTITY_STORE_ROOTS`).
 */
export function identityStorePath(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  if (platform === 'win32') return path.join(home, 'AppData', 'Local', 'kiro-cli', 'data.sqlite3');
  return path.join(home, '.local', 'share', 'kiro-cli', 'data.sqlite3');
}

/**
 * Directories KiroCrew hides from every `kiro-cli` probe (V5; KC-BIN-02). The shim and `$CS` must
 * not be inside any of them.
 */
export function probeHiddenDirs(env: NodeJS.ProcessEnv): string[] {
  const home = homeDir(env);
  const dirs = [
    path.join(home, '.kiro', 'crew'),
    path.join(home, '.kirocrew'),
    path.join(home, '.local', 'share', 'kiro-cli'),
    path.join(home, 'Library', 'Application Support', 'kiro-cli'),
    path.join(home, '.aws'),
  ];
  const kh = env.KIROCREW_HOME;
  if (kh && kh.trim() && path.isAbsolute(kh.trim())) dirs.unshift(path.resolve(kh.trim()));
  return dirs;
}

/** The probe-hidden directory containing `p`, if any (checks the path as given and its realpath). */
export function hiddenDirContaining(p: string, env: NodeJS.ProcessEnv): string | undefined {
  const candidates = [path.resolve(p), realpathDeep(p)];
  for (const dir of probeHiddenDirs(env)) {
    const dirs = [dir, realpathDeep(dir)];
    for (const c of candidates) for (const d of dirs) if (isSubpath(c, d)) return dir;
  }
  return undefined;
}

/**
 * Port of KiroCrew's `_in_linked_git_worktree` (SRC `config/paths.py:1182-1213`): walk up from
 * `p`; the nearest `.git` decides. A directory means an ordinary clone; a file whose `gitdir:`
 * pointer has a `/worktrees/` segment means a linked worktree (a submodule of a worktree points
 * at `…/worktrees/<n>/modules/…`, which counts too — V9).
 */
export function inLinkedGitWorktree(p: string): boolean {
  let cur = path.resolve(p);
  for (;;) {
    const marker = path.join(cur, '.git');
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(marker);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory()) return false;
    if (st?.isFile()) {
      let head: string;
      try {
        head = fs.readFileSync(marker, 'utf8').slice(0, 4096);
      } catch {
        return false;
      }
      return head.startsWith('gitdir:') && head.replace(/\\/g, '/').includes('/worktrees/');
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/** True when `p` is the system temp dir or inside it (raw and realpath forms are compared). */
export function isUnderTmp(p: string, tmpdir: string = os.tmpdir()): boolean {
  const a = [path.resolve(p), realpathDeep(p)];
  const b = [path.resolve(tmpdir), realpathDeep(tmpdir)];
  return a.some((x) => b.some((y) => isSubpath(x, y)));
}

/**
 * The kiro-claude package root: the nearest ancestor of `fromDir` (default: this module's dir)
 * holding a `package.json` whose `name` is `kiro-claude`. `undefined` when not found (e.g. a
 * build in an unrelated out dir).
 */
export function findPackageRoot(fromDir: string = moduleDir()): string | undefined {
  let cur = path.resolve(fromDir);
  for (;;) {
    const pj = path.join(cur, 'package.json');
    try {
      const data = JSON.parse(fs.readFileSync(pj, 'utf8')) as { name?: unknown };
      if (data && data.name === 'kiro-claude') return cur;
    } catch {
      // not here
    }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * kiro-claude's JS entry for the shim (08 §3.4: `realpath(fileURLToPath(import.meta.url))` of the
 * bin). This module is `<out>/src/crew/paths.js`, so the bin is `<out>/src/bin/kiro-claude.js`.
 */
export function defaultEntryPath(): string {
  return realpathSafe(path.resolve(moduleDir(), '..', 'bin', 'kiro-claude.js'));
}

/** True when `root` is a git checkout whose `.gitmodules` declares `vendor/KiroCrew`. */
export function isSubmoduleCheckout(root: string): boolean {
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, '.gitmodules'), 'utf8');
  } catch {
    return false;
  }
  return text.split(/\r?\n/).some((line) => {
    const m = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    return !!m && m[1]!.replace(/\\/g, '/').replace(/\/+$/, '') === KIROCREW_SUBMODULE_PATH;
  });
}

export type CheckoutSource = 'flag' | 'env' | 'submodule' | 'state-dir';

export interface CheckoutLocation {
  dir: string;
  source: CheckoutSource;
  /** Set for `submodule`: the kiro-claude checkout containing it. */
  superproject?: string;
}

/** §3.1 checkout resolution order. `flagDir` is `--dir`/`--source` (resolved against `cwd`). */
export function resolveCheckout(opts: {
  flagDir?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  packageRoot?: string | null;
}): CheckoutLocation {
  if (opts.flagDir) return { dir: path.resolve(opts.cwd, opts.flagDir), source: 'flag' };
  const envDir = opts.env.KIRO_CLAUDE_CREW_DIR;
  if (envDir && envDir.trim()) return { dir: path.resolve(opts.cwd, envDir.trim()), source: 'env' };
  const root = opts.packageRoot;
  if (root && isSubmoduleCheckout(root)) {
    return { dir: path.join(root, ...KIROCREW_SUBMODULE_PATH.split('/')), source: 'submodule', superproject: root };
  }
  return { dir: crewPaths(opts.env).ownCheckout, source: 'state-dir' };
}

/** `<dir>/bin/kirocrew` — the launcher every crew command runs (V16). */
export function kirocrewLauncher(dir: string): string {
  return path.join(dir, 'bin', 'kirocrew');
}

/** Free bytes at the filesystem holding `p` (nearest existing ancestor); `undefined` if unknown. */
export function freeBytesAt(p: string): number | undefined {
  let cur = path.resolve(p);
  for (;;) {
    if (fs.existsSync(cur)) break;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  try {
    const st = fs.statfsSync(cur);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return undefined;
  }
}
