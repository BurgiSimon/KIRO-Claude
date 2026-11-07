/**
 * Locating the installed Claude Code CLI and probing what it supports.
 *
 * Sources: 00-synthesis §2.1 ("Locate Claude": `$KIRO_CLAUDE_BIN`, PATH, `/opt/claude-code/bin/claude`;
 * preflight `claude --version`), ARCHITECTURE.md "Compatibility probe" (`--version` + `--help`
 * parsed once per version and cached), 04 §3 (flag table: which flags are hidden from `--help`
 * but accepted by 2.1.318).
 *
 * Discovery order ({@link findClaudeBinary}), highest precedence first:
 *   1. `opts.explicitPath`: a path given on the command line (`crew setup --claude-bin`, or the
 *      path `crew setup` recorded in crew.json),
 *   2. `$KIRO_CLAUDE_BIN` — the KiroCrew shim exports it (08 KC-ENV-05), so it must beat the
 *      user's setting: KiroCrew's agents run the claude the gateway was set up with,
 *   3. `opts.settingPath`: the `kiroClaude.claudePath` setting (global settings only, see
 *      config/settings CLAUDE_LAUNCH_KEYS),
 *   4. `claude` on `PATH` (honouring `PATHEXT` on Windows),
 *   5. well-known install locations (`~/.claude/local/claude`, `~/.local/bin/claude`,
 *      `/opt/claude-code/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`).
 * Every candidate is verified by running `<bin> --version` (15 s timeout) and parsing a semver,
 * and must be at least {@link MIN_CLAUDE_VERSION} (00 §2.1 "require 2.1.x+").
 * A configured binary (1, 2 or 3: only the highest one present is considered) that does not
 * work is an ERROR — we never silently fall back to a different `claude` (that could run real
 * model calls when a test double or a specific install was requested).
 *
 * Spawning ({@link resolveSpawn}): `.js/.mjs/.cjs` paths run under the current Node executable
 * (used by the fake-claude test double, works on every OS); Windows `.cmd/.bat` shims are
 * unwrapped to their Node script when they are npm shims, else run through `cmd.exe /d /s /c`
 * with cmd-safe quoting.
 *
 * Capabilities ({@link probeCapabilities}): option names are parsed from the option-definition
 * lines of `--help` and cached as JSON per version under
 * `<KIRO_HOME|~/.kiro>/kiro-claude/cache/claude-<version>.json`. Some flags the adapter relies
 * on are hidden from `--help` (04 §3); {@link HIDDEN_FLAGS} adds them from the version where
 * they were verified.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { KILL_GRACE_MS, PROCESS_GROUPS, groupSpawnOptions, signalChild, trackChild } from './lifecycle.js';

export class ClaudeNotFoundError extends Error {
  /** Every candidate that was tried, with the reason it was rejected. */
  readonly tried: string[];
  constructor(message: string, tried: string[] = []) {
    super(message);
    this.name = 'ClaudeNotFoundError';
    this.tried = tried;
  }
}

export interface ClaudeBinary {
  /** Absolute path of the executable (or of a `.mjs` script run under Node). */
  path: string;
  /** Parsed semver, e.g. `2.1.318`. */
  version: string;
  /** Raw first line of `--version`, e.g. `2.1.318 (Claude Code)`. */
  rawVersion: string;
}

export interface ClaudeCapabilities {
  version: string;
  flags: ReadonlySet<string>;
  /** Accepts `--flag` or `flag`. */
  has(flag: string): boolean;
}

/** Flags hidden from `--help` but accepted (04 §3), with the first version they are assumed for. */
export const HIDDEN_FLAGS: ReadonlyArray<{ flag: string; since: string }> = Object.freeze([
  // Required by the adapter (enables can_use_tool); the spec treats it as present from 2.0.
  { flag: '--permission-prompt-tool', since: '2.0.0' },
  // VERIFIED accepted on 2.1.318 although absent from --help (04 §3 table, 00 §3.1, 00 §3.10 R4).
  { flag: '--append-system-prompt-file', since: '2.1.318' },
  { flag: '--system-prompt-file', since: '2.1.318' },
  { flag: '--resume-session-at', since: '2.1.318' },
  { flag: '--max-turns', since: '2.1.318' },
]);

/**
 * Oldest Claude Code accepted by {@link findClaudeBinary} (00 §2.1: "Preflight `claude --version`
 * (require 2.1.x+)"); the control-protocol features the adapter relies on (initialize hook
 * callbacks, `can_use_tool` over stdio) were verified on 2.1.318.
 */
export const MIN_CLAUDE_VERSION = '2.1.0';

export const VERSION_TIMEOUT_MS = 15_000;
export const HELP_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------------------------------ */
/* Versions                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Extracts `x.y.z[-pre][+build]` from `--version` output (`2.1.318 (Claude Code)` ⇒ `2.1.318`). */
export function parseVersion(output: string): string | undefined {
  const m = /(?:^|[^\d.])v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(output);
  return m ? m[1] : undefined;
}

function splitVersion(v: string): { nums: number[]; pre: string[] } {
  const clean = v.trim().replace(/^v/i, '').split('+')[0] ?? '';
  const dash = clean.indexOf('-');
  const core = dash >= 0 ? clean.slice(0, dash) : clean;
  const pre = dash >= 0 ? clean.slice(dash + 1).split('.').filter(Boolean) : [];
  const nums = core.split('.').map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return { nums, pre };
}

/**
 * Semver-style comparison: numeric segments (missing ⇒ 0), a pre-release sorts before the
 * release (`2.1.0-beta < 2.1.0`), pre-release identifiers compared numerically when both are
 * numbers, else lexically; build metadata ignored. Returns -1, 0 or 1.
 */
export function compareVersions(a: string, b: string): number {
  const va = splitVersion(a);
  const vb = splitVersion(b);
  const len = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = va.nums[i] ?? 0;
    const y = vb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  if (va.pre.length === 0) return 1;
  if (vb.pre.length === 0) return -1;
  const plen = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < plen; i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/* ------------------------------------------------------------------------------------------ */
/* Spawning                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface SpawnSpec {
  command: string;
  args: string[];
  /** Set for the `cmd.exe /c` fallback (arguments are pre-quoted). */
  windowsVerbatimArguments?: boolean;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quotes one argument for `cmd.exe /c` (algorithm of qntm.org/cmd, as used by cross-spawn). */
export function quoteCmdArg(arg: string, doubleEscapeMeta = true): string {
  let a = String(arg);
  a = a.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, '$1$1');
  a = `"${a}"`;
  a = a.replace(CMD_META, '^$1');
  if (doubleEscapeMeta) a = a.replace(CMD_META, '^$1');
  return a;
}

/** Target script of an npm `.cmd` shim (`"%dp0%\node_modules\…\cli.js"`), if recognisable. */
export function npmShimTarget(cmdPath: string, contents: string): string | undefined {
  const m = /"%~?dp0%?\\([^"%]+?\.(?:c|m)?js)"/i.exec(contents);
  if (!m || !m[1]) return undefined;
  return path.join(path.dirname(cmdPath), m[1].replace(/\\/g, path.sep));
}

/**
 * How to spawn `binPath` with `args` without a shell (see module doc).
 * `platform` is injectable for tests.
 */
export function resolveSpawn(binPath: string, args: readonly string[], platform: NodeJS.Platform = process.platform): SpawnSpec {
  const ext = path.extname(binPath).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath, args: [binPath, ...args] };
  }
  if (platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    try {
      const target = npmShimTarget(binPath, fs.readFileSync(binPath, 'utf8'));
      if (target && fs.existsSync(target)) return { command: process.execPath, args: [target, ...args] };
    } catch {
      /* fall through to cmd.exe */
    }
    const line = [binPath.replace(CMD_META, '^$1'), ...args.map((a) => quoteCmdArg(a))].join(' ');
    return {
      command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: binPath, args: [...args] };
}

export interface CaptureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn error (ENOENT, EACCES, …) if the process could not be started. */
  error?: NodeJS.ErrnoException;
}

const MAX_CAPTURE = 4 * 1024 * 1024;

/**
 * After the child exited, how long its stdout/stderr may stay open (a grandchild that inherited
 * them, e.g. a shell wrapper's background process) before we stop reading and resolve.
 */
export const CAPTURE_DRAIN_MS = 250;

/**
 * Runs `binPath args` (via {@link resolveSpawn}), stdin ignored, capturing stdout/stderr.
 * Never rejects: spawn errors and timeouts are reported in the result.
 *
 * Hang-proof (claude/lifecycle.ts): the child leads its own process group on POSIX; on timeout
 * the group gets SIGTERM, then SIGKILL after {@link KILL_GRACE_MS}. The
 * promise settles on the child's exit (plus at most {@link CAPTURE_DRAIN_MS} for the pipes), not
 * on its pipes closing, so a grandchild holding them cannot stall it; the pipes are destroyed
 * and every timer cleared when it settles, so nothing keeps the event loop alive afterwards.
 */
export function runCaptured(
  binPath: string,
  args: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const spec = resolveSpawn(binPath, args);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killing = false;
    let settled = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    // Declared before `finish`: spawn() can throw synchronously (NUL bytes, empty command), and
    // `finish` then runs before the timers exist (a `const` here was a TDZ ReferenceError that
    // made this "never rejects" function reject).
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    const group = PROCESS_GROUPS;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (child) {
        // We gave up on it: whatever of its group is still around (a SIGTERM-ignoring
        // grandchild) is not waited for — kill it now rather than after the grace. The child
        // has exited by now, so signalChild only signals the group while it is provably still
        // ours (its pid may have been reused, lifecycle.ts L1).
        if (killing) signalChild(child, 'SIGKILL', group);
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolve({ code, signal, stdout, stderr, timedOut, ...(spawnError ? { error: spawnError } : {}) });
    };
    const kill = (): void => {
      if (settled || killing || !child) return;
      killing = true;
      signalChild(child, 'SIGTERM', group);
      killTimer = setTimeout(() => {
        if (child) signalChild(child, 'SIGKILL', group);
      }, KILL_GRACE_MS);
    };
    try {
      child = spawn(spec.command, spec.args, {
        env: opts.env ?? process.env,
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        ...groupSpawnOptions(),
      });
    } catch (e) {
      spawnError = e as NodeJS.ErrnoException;
      finish(null, null);
      return;
    }
    trackChild(child, group, { graceful: false });
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += d;
    });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += d;
    });
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    child.on('error', (e) => {
      // Only a failed spawn (no pid) ends the run here; a failed kill() is not fatal.
      if (child?.pid !== undefined) return;
      spawnError = e as NodeJS.ErrnoException;
      finish(null, null);
    });
    child.on('exit', (code, signal) => {
      // The child is gone: its timeout no longer applies (a grandchild holding the pipes during
      // the drain must not turn a clean exit into `timedOut` and get its group killed).
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      drainTimer = setTimeout(() => finish(code, signal), CAPTURE_DRAIN_MS);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Discovery                                                                                   */
/* ------------------------------------------------------------------------------------------ */

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  if (process.platform === 'win32') {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    if (key) return env[key];
  }
  return undefined;
}

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a command name on `PATH` like `which` (with `PATHEXT` on Windows). Names containing a
 * path separator are not searched. Returns an absolute path or undefined.
 */
export function whichSync(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!name || name.includes('/') || (platform === 'win32' && name.includes('\\'))) return undefined;
  const pathVar = envGet(env, 'PATH') ?? '';
  const delim = platform === 'win32' ? ';' : path.delimiter;
  const exts =
    platform === 'win32'
      ? ['', ...(envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
  for (const dir of pathVar.split(delim)) {
    if (!dir) continue;
    for (const ext of exts) {
      // On Windows a bare name without extension is only accepted if it already has one.
      if (platform === 'win32' && ext === '' && !path.extname(name)) continue;
      const candidate = path.resolve(dir, name + ext);
      if (platform === 'win32' ? fs.existsSync(candidate) && fs.statSync(candidate).isFile() : isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Well-known install locations, most specific first. */
export function wellKnownLocations(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = homeDir(env);
  if (platform === 'win32') {
    const out: string[] = [];
    for (const base of [path.join(home, '.claude', 'local'), path.join(home, '.local', 'bin')]) {
      out.push(path.join(base, 'claude.exe'), path.join(base, 'claude.cmd'));
    }
    const appData = envGet(env, 'APPDATA');
    if (appData) out.push(path.join(appData, 'npm', 'claude.cmd'));
    return out;
  }
  return [
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/claude-code/bin/claude',
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
}

/** Runs `<bin> --version` and parses it; throws a descriptive Error on failure. */
export async function verifyClaudeBinary(binPath: string, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeBinary> {
  const r = await runCaptured(binPath, ['--version'], { env, timeoutMs: VERSION_TIMEOUT_MS });
  if (r.error) throw new Error(`cannot execute ${binPath}: ${r.error.code ?? r.error.message}`);
  if (r.timedOut) throw new Error(`${binPath} --version timed out after ${VERSION_TIMEOUT_MS / 1000}s`);
  const rawVersion = (r.stdout.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
  const version = parseVersion(rawVersion) ?? parseVersion(r.stdout);
  if (r.code !== 0 || !version) {
    const detail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' | ');
    throw new Error(`${binPath} --version failed (exit ${r.code ?? r.signal})${detail ? `: ${detail}` : ''}`);
  }
  return { path: binPath, version, rawVersion };
}

function resolveConfigured(value: string, env: NodeJS.ProcessEnv): string {
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homeDir(env), value.slice(2));
  if (!value.includes('/') && !value.includes('\\')) return whichSync(value, env) ?? value;
  return path.resolve(value);
}

function tooOld(bin: ClaudeBinary, minVersion: string | null): string | undefined {
  if (!minVersion || compareVersions(bin.version, minVersion) >= 0) return undefined;
  return `Claude Code ${bin.version} is too old (kiro-claude needs ${minVersion} or newer; run \`claude update\`)`;
}

/**
 * Finds and verifies the installed Claude Code CLI (see module doc for the order: explicit
 * command-line path > `$KIRO_CLAUDE_BIN` > `kiroClaude.claudePath` setting > PATH > well-known).
 * `minVersion` (default {@link MIN_CLAUDE_VERSION}, `null` disables) rejects older installs: an
 * explicitly configured one is an error, a discovered one is skipped in favour of later
 * candidates.
 * @throws ClaudeNotFoundError when nothing works (message lists what was tried).
 */
export async function findClaudeBinary(
  opts: {
    /** A path given on the command line (beats `$KIRO_CLAUDE_BIN` and the setting). */
    explicitPath?: string;
    /** The `kiroClaude.claudePath` setting (below `$KIRO_CLAUDE_BIN`). */
    settingPath?: string;
    env?: NodeJS.ProcessEnv;
    minVersion?: string | null;
  } = {},
): Promise<ClaudeBinary> {
  const env = opts.env ?? process.env;
  const minVersion = opts.minVersion === undefined ? MIN_CLAUDE_VERSION : opts.minVersion;
  const tried: string[] = [];

  const configured: Array<{ value: string; source: string }> = [];
  // Precedence (module doc): command line > $KIRO_CLAUDE_BIN (KiroCrew shim) > setting.
  if (opts.explicitPath) configured.push({ value: opts.explicitPath, source: 'configured path' });
  const fromEnv = envGet(env, 'KIRO_CLAUDE_BIN');
  if (fromEnv && fromEnv.trim()) configured.push({ value: fromEnv.trim(), source: '$KIRO_CLAUDE_BIN' });
  if (opts.settingPath && opts.settingPath.trim()) {
    configured.push({ value: opts.settingPath.trim(), source: 'setting kiroClaude.claudePath' });
  }
  if (configured.length > 0) {
    const { value, source } = configured[0]!;
    const p = resolveConfigured(value, env);
    let bin: ClaudeBinary;
    try {
      bin = await verifyClaudeBinary(p, env);
    } catch (e) {
      tried.push(`${p} (${source}): ${(e as Error).message}`);
      throw new ClaudeNotFoundError(
        `Claude Code CLI from ${source} is not usable: ${(e as Error).message}`,
        tried,
      );
    }
    const old = tooOld(bin, minVersion);
    if (old) {
      tried.push(`${p} (${source}): ${old}`);
      throw new ClaudeNotFoundError(`Claude Code CLI from ${source} is not usable: ${old}`, tried);
    }
    return bin;
  }

  const candidates: string[] = [];
  const onPath = whichSync('claude', env);
  if (onPath) candidates.push(onPath);
  else tried.push("'claude' not found on PATH");
  for (const p of wellKnownLocations(env)) if (!candidates.includes(p)) candidates.push(p);

  for (const p of candidates) {
    if (!fs.existsSync(p)) {
      if (p !== onPath) tried.push(`${p}: not found`);
      continue;
    }
    let bin: ClaudeBinary;
    try {
      bin = await verifyClaudeBinary(p, env);
    } catch (e) {
      tried.push(`${p}: ${(e as Error).message}`);
      continue;
    }
    const old = tooOld(bin, minVersion);
    if (!old) return bin;
    tried.push(`${p}: ${old}`);
  }
  throw new ClaudeNotFoundError(
    'Claude Code CLI (claude) was not found. Install it (https://code.claude.com) and run `claude auth login`, ' +
      'or set KIRO_CLAUDE_BIN to its path.',
    tried,
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Capabilities                                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * Option names from commander-style `--help` output. Only option-definition lines (indented by
 * 1–4 spaces and starting with `-`) count, so flags merely mentioned inside descriptions
 * (`--all`, `--permission-prompt-tool`, `--append-system-prompt[-file]`) are not picked up.
 * Falls back to a loose `--token` scan when no definition line is recognised.
 */
export function parseHelpFlags(helpText: string): Set<string> {
  const flags = new Set<string>();
  for (const rawLine of helpText.split(/\r?\n/)) {
    const m = /^ {1,4}((?:-{1,2}[A-Za-z0-9][\w-]*(?:,\s*|\s+|$))+)/.exec(rawLine);
    if (!m || !m[1]) continue;
    for (const t of m[1].matchAll(/--[A-Za-z0-9][\w-]*/g)) flags.add(t[0]);
  }
  if (flags.size === 0) {
    for (const t of helpText.matchAll(/(?:^|[\s,[(])(--[A-Za-z][\w-]*)/g)) if (t[1]) flags.add(t[1]);
  }
  return flags;
}

export function makeCapabilities(version: string, flags: Iterable<string>): ClaudeCapabilities {
  const set = new Set<string>();
  for (const f of flags) set.add(f.startsWith('--') ? f : `--${f}`);
  for (const h of HIDDEN_FLAGS) if (compareVersions(version, h.since) >= 0) set.add(h.flag);
  const frozen: ReadonlySet<string> = set;
  return {
    version,
    flags: frozen,
    has(flag: string): boolean {
      return set.has(flag.startsWith('--') ? flag : `--${flag}`);
    },
  };
}

/** `<KIRO_HOME|~/.kiro>/kiro-claude/cache` (`KIRO_HOME` honoured only when absolute, 02 §1.1). */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const kh = env.KIRO_HOME;
  const kiroHome = kh && path.isAbsolute(kh) ? kh : path.join(homeDir(env), '.kiro');
  return path.join(kiroHome, 'kiro-claude', 'cache');
}

export function capabilityCachePath(cacheDir: string, version: string): string {
  return path.join(cacheDir, `claude-${version.replace(/[^\w.+-]/g, '_')}.json`);
}

interface CacheFile {
  version: string;
  flags: string[];
  probedAt?: string;
}

function readCache(file: string, version: string): string[] | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CacheFile>;
    if (parsed && parsed.version === version && Array.isArray(parsed.flags) && parsed.flags.every((f) => typeof f === 'string')) {
      return parsed.flags;
    }
  } catch {
    /* missing or corrupt: re-probe */
  }
  return undefined;
}

function writeCache(file: string, data: CacheFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch {
    /* cache is best effort */
  }
}

/**
 * Flags supported by `bin` (from `--help`, cached per version; see module doc).
 * A failing `--help` yields only the hidden flags (and is not cached).
 */
export async function probeCapabilities(
  bin: ClaudeBinary,
  opts: { cacheDir?: string; env?: NodeJS.ProcessEnv; refresh?: boolean } = {},
): Promise<ClaudeCapabilities> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir(opts.env);
  const file = capabilityCachePath(cacheDir, bin.version);
  if (!opts.refresh) {
    const cached = readCache(file, bin.version);
    if (cached) return makeCapabilities(bin.version, cached);
  }
  const r = await runCaptured(bin.path, ['--help'], { env: opts.env ?? process.env, timeoutMs: HELP_TIMEOUT_MS });
  if (r.error || r.timedOut || r.code !== 0) return makeCapabilities(bin.version, []);
  const flags = [...parseHelpFlags(r.stdout)].sort();
  if (flags.length > 0) writeCache(file, { version: bin.version, flags, probedAt: new Date().toISOString() });
  return makeCapabilities(bin.version, flags);
}
