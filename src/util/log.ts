/**
 * File logger. stdout is protocol in headless/ACP modes (00 §2.1 "Logs"), so this logger
 * NEVER writes to stdout or stderr and NEVER throws.
 *
 *  - File: `$KIRO_CHAT_LOG_FILE`, else `<$XDG_RUNTIME_DIR | $TMPDIR | /tmp>/kiro-log/kiro-claude.log`
 *    (01 §9, 05 §2.4; `os.tmpdir()` stands in for `/tmp` on Windows). The directory is
 *    created lazily (0700) on the first enabled log call; the file is opened once in append
 *    mode (0600). The default location lives in a shared temp dir, so it is only used when
 *    the `kiro-log` directory is a real directory owned by us (group/other bits are cleared)
 *    and the file is opened with O_NOFOLLOW: a symlink planted by another user is never
 *    followed. Otherwise `kiro-log-<uid>` next to it is tried (same checks). Explicit paths
 *    (`$KIRO_CHAT_LOG_FILE`, `opts.file`, the `file` setter) are used as given. Any failure
 *    silently disables file output.
 *  - Level: `$KIRO_LOG_LEVEL` (`error|warn|info|debug|trace`, case-insensitive), default `warn`;
 *    changeable at runtime via `setLevel` (e.g. from `-v` counts, see {@link levelFromVerbosity}).
 *  - Line format: `<ISO-8601 time> <LEVEL> <message>`; arguments are joined with spaces,
 *    strings verbatim, Errors as their stack, other values via `util.inspect` on one line.
 *    Embedded newlines are kept but continuation lines are indented by two spaces.
 *  - A log file larger than 10 MiB at open time is rotated to `<file>.old`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspect } from 'node:util';
import { mkdirp } from './fsx.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

const ROTATE_BYTES = 10 * 1024 * 1024;

/** `O_NOFOLLOW` where the platform has it (not on Windows). */
const NOFOLLOW: number | undefined = (fs.constants as Record<string, number | undefined>).O_NOFOLLOW;

/**
 * True when `dir` is a real directory (not a symlink) that only we can write: owned by the
 * current uid, with group/other permission bits cleared (tightened to 0700 when needed).
 * Always true on platforms without uids (Windows temp dirs are per-user).
 */
function privateDirOk(dir: string): boolean {
  if (typeof process.getuid !== 'function') return true;
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid()) return false;
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
    return true;
  } catch {
    return false;
  }
}

/** Parse a level name (case-insensitive); `undefined` when not a valid level. */
export function parseLogLevel(s: string | undefined): LogLevel | undefined {
  if (!s) return undefined;
  const l = s.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(l) ? (l as LogLevel) : undefined;
}

/**
 * Map a `-v` count to a level: 0 ⇒ `base`, 1 ⇒ info, 2 ⇒ debug, ≥3 ⇒ trace (never lowers
 * verbosity below `base`).
 */
export function levelFromVerbosity(count: number, base: LogLevel = 'warn'): LogLevel {
  const wanted: LogLevel = count <= 0 ? base : count === 1 ? 'info' : count === 2 ? 'debug' : 'trace';
  return RANK[wanted] >= RANK[base] ? wanted : base;
}

/** Default log file path for an environment (see module doc). */
export function defaultLogFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.KIRO_CHAT_LOG_FILE;
  if (explicit && explicit.trim() !== '') return path.resolve(explicit);
  const base =
    (env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR) && env.XDG_RUNTIME_DIR) ||
    (env.TMPDIR && path.isAbsolute(env.TMPDIR) && env.TMPDIR) ||
    (process.platform === 'win32' ? os.tmpdir() : '/tmp');
  return path.join(base, 'kiro-log', 'kiro-claude.log');
}

/** Render log arguments into one message string. */
export function formatLogArgs(args: readonly unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      try {
        return inspect(a, { depth: 4, breakLength: Infinity, maxStringLength: 10_000, maxArrayLength: 200 });
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

/** Format one complete log line (including the trailing newline). */
export function formatLogLine(level: LogLevel, args: readonly unknown[], now: Date = new Date()): string {
  const msg = formatLogArgs(args).replace(/\r?\n/g, '\n  ');
  return `${now.toISOString()} ${level.toUpperCase()} ${msg}\n`;
}

export interface Logger {
  error(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  info(...a: unknown[]): void;
  debug(...a: unknown[]): void;
  trace(...a: unknown[]): void;
  setLevel(l: LogLevel): void;
  /** Current threshold; assignable (invalid values are ignored). */
  level: LogLevel;
  /** Log file path; assignable (closes the current file, reopens lazily). */
  file: string;
  /** Whether a message at `l` would be written. */
  enabled(l: LogLevel): boolean;
  /** Close the file descriptor (it is reopened on the next write). */
  close(): void;
}

export interface LoggerOptions {
  env?: NodeJS.ProcessEnv;
  file?: string;
  level?: LogLevel;
  /** Clock override for tests. */
  now?: () => Date;
}

/** Create an independent logger. The shared instance is {@link log}. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const env = opts.env ?? process.env;
  let level: LogLevel | undefined = opts.level;
  let file: string | undefined = opts.file;
  let fd: number | undefined;
  let broken = false;
  /** Set once `logger.file` is assigned: the caller chose the path, no shared-dir checks. */
  let fileOverridden = false;
  const now = opts.now ?? (() => new Date());

  const getLevel = (): LogLevel => {
    if (level === undefined) level = parseLogLevel(env.KIRO_LOG_LEVEL) ?? 'warn';
    return level;
  };
  const getFile = (): string => {
    if (file === undefined) {
      try {
        file = defaultLogFile(env);
      } catch {
        file = path.join(os.tmpdir(), 'kiro-log', 'kiro-claude.log');
      }
    }
    return file;
  };

  /**
   * Open `p` for appending. `shared` (the default location under a world-writable temp dir):
   * the directory must be a real directory owned by us (group/other bits are removed) and the
   * file is opened with O_NOFOLLOW, so a symlink planted by another user is never followed.
   */
  const tryOpen = (p: string, shared: boolean): number | undefined => {
    try {
      const dir = path.dirname(p);
      mkdirp(dir, 0o700);
      if (shared && !privateDirOk(dir)) return undefined;
      try {
        const st = fs.lstatSync(p);
        if (st.isFile() && st.size > ROTATE_BYTES) fs.renameSync(p, `${p}.old`);
      } catch {
        // missing or not rotatable: fine
      }
      if (shared && NOFOLLOW !== undefined) {
        const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW;
        const d = fs.openSync(p, flags, 0o600);
        try {
          if (!fs.fstatSync(d).isFile()) throw new Error('not a regular file');
        } catch (e) {
          fs.closeSync(d);
          throw e;
        }
        return d;
      }
      return fs.openSync(p, 'a', 0o600);
    } catch {
      return undefined;
    }
  };

  const open = (): number | undefined => {
    if (fd !== undefined) return fd;
    if (broken) return undefined;
    const p = getFile();
    const explicitEnv = env.KIRO_CHAT_LOG_FILE !== undefined && env.KIRO_CHAT_LOG_FILE.trim() !== '';
    const isDefault = !explicitEnv && opts.file === undefined && !fileOverridden;
    fd = tryOpen(p, isDefault);
    if (fd === undefined && isDefault) {
      // Shared /tmp/kiro-log owned by someone else: use a per-user sibling.
      const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
      const alt = path.join(path.dirname(path.dirname(p)), `kiro-log-${uid}`, path.basename(p));
      fd = tryOpen(alt, true);
      if (fd !== undefined) file = alt;
    }
    if (fd === undefined) broken = true;
    return fd;
  };

  const write = (l: LogLevel, args: unknown[]): void => {
    try {
      if (RANK[l] > RANK[getLevel()]) return;
      const d = open();
      if (d === undefined) return;
      fs.writeSync(d, formatLogLine(l, args, now()));
    } catch {
      // Never throw from logging. A failing descriptor disables further writes.
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } catch {
        // ignore
      }
      fd = undefined;
      broken = true;
    }
  };

  const logger: Logger = {
    error: (...a: unknown[]) => write('error', a),
    warn: (...a: unknown[]) => write('warn', a),
    info: (...a: unknown[]) => write('info', a),
    debug: (...a: unknown[]) => write('debug', a),
    trace: (...a: unknown[]) => write('trace', a),
    setLevel(l: LogLevel): void {
      const v = parseLogLevel(l);
      if (v) level = v;
    },
    get level(): LogLevel {
      return getLevel();
    },
    set level(l: LogLevel) {
      const v = parseLogLevel(l);
      if (v) level = v;
    },
    get file(): string {
      return getFile();
    },
    set file(p: string) {
      logger.close();
      file = path.resolve(p);
      fileOverridden = true;
      broken = false;
    },
    enabled(l: LogLevel): boolean {
      return RANK[l] <= RANK[getLevel()];
    },
    close(): void {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      fd = undefined;
    },
  };
  return logger;
}

/** The process-wide logger (configuration read lazily from `process.env`). */
export const log: Logger = createLogger();
