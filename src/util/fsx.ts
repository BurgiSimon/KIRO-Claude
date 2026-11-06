/**
 * Synchronous filesystem conveniences.
 *
 *  - Existence/type probes never throw.
 *  - {@link readJsonFile} is strict JSON (after stripping a UTF-8 BOM). On a syntax error it
 *    throws {@link JsonFileError} carrying the file path and a 1-based line/column computed by
 *    our own JSON scanner ({@link findJsonErrorOffset}), so locations do not depend on the
 *    V8 error-message format of the running Node version.
 *  - {@link writeFileAtomic} writes a temp file in the target directory (fsync'ed, optional
 *    exact mode via fchmod) and renames it over the target, creating parent directories as
 *    needed. Used for settings, the session index (00 §7 "Atomic writes (temp + rename)") and
 *    any file another process may read concurrently. When no mode is given, an existing
 *    target's permission bits are preserved. A symlinked target is written through (the
 *    link survives; see {@link resolveWriteTarget}).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/** True if `p` exists (following symlinks). Never throws. */
export function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** True if `p` is (a symlink to) a regular file. Never throws. */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True if `p` is (a symlink to) a directory. Never throws. */
export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

/**
 * Read a UTF-8 text file; `undefined` when it does not exist (`ENOENT`, `ENOTDIR`) or is a
 * directory (`EISDIR`). Other errors (e.g. `EACCES`) are thrown.
 */
export function readTextIfExists(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
    throw e;
  }
}

/** Error thrown for malformed JSON files. `line`/`column` are 1-based when known. */
export class JsonFileError extends Error {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  /** The underlying parser message (without location). */
  readonly reason: string;

  constructor(filePath: string, reason: string, line?: number, column?: number) {
    const loc = line !== undefined ? ` at line ${line} column ${column ?? 1}` : '';
    super(`${filePath}: invalid JSON: ${reason}${loc}`);
    this.name = 'JsonFileError';
    this.path = filePath;
    this.reason = reason;
    if (line !== undefined) this.line = line;
    if (column !== undefined) this.column = column;
  }
}

/** 1-based line and column (in UTF-16 code units) of character offset `pos` in `text`. */
export function positionToLineColumn(text: string, pos: number): { line: number; column: number } {
  const p = Math.max(0, Math.min(pos, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < p; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: p - lineStart + 1 };
}

/**
 * Offset of the first JSON syntax error in `text` (RFC 8259), or `-1` if `text` is valid.
 * An unexpected end of input reports `text.length`.
 */
export function findJsonErrorOffset(text: string): number {
  let i = 0;
  const n = text.length;
  class Fail {
    constructor(readonly at: number) {}
  }
  const ws = (): void => {
    while (i < n) {
      const ch = text.charCodeAt(i);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) i++;
      else break;
    }
  };
  const fail = (at = i): never => {
    throw new Fail(at);
  };
  const lit = (word: string): void => {
    if (text.startsWith(word, i)) i += word.length;
    else {
      // report the first mismatching character
      let k = 0;
      while (k < word.length && i + k < n && text[i + k] === word[k]) k++;
      fail(i + k);
    }
  };
  const str = (): void => {
    i++; // opening quote
    for (;;) {
      if (i >= n) fail(n);
      const ch = text.charCodeAt(i);
      if (ch === 0x22) {
        i++;
        return;
      }
      if (ch < 0x20) fail();
      if (ch === 0x5c) {
        const e = text[i + 1];
        if (e === undefined) fail(n);
        if (e === 'u') {
          for (let k = 2; k < 6; k++) {
            const h = text[i + k];
            if (h === undefined) fail(n);
            if (!/[0-9a-fA-F]/.test(h!)) fail(i + k);
          }
          i += 6;
        } else if ('"\\/bfnrt'.includes(e!)) {
          i += 2;
        } else fail(i + 1);
      } else i++;
    }
  };
  const num = (): void => {
    if (text[i] === '-') i++;
    if (text[i] === '0') i++;
    else if (text[i] !== undefined && text[i]! >= '1' && text[i]! <= '9') {
      while (text[i] !== undefined && text[i]! >= '0' && text[i]! <= '9') i++;
    } else fail(i >= n ? n : i);
    if (text[i] === '.') {
      i++;
      if (!(text[i] !== undefined && text[i]! >= '0' && text[i]! <= '9')) fail(i >= n ? n : i);
      while (text[i] !== undefined && text[i]! >= '0' && text[i]! <= '9') i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (!(text[i] !== undefined && text[i]! >= '0' && text[i]! <= '9')) fail(i >= n ? n : i);
      while (text[i] !== undefined && text[i]! >= '0' && text[i]! <= '9') i++;
    }
  };
  const value = (depth: number): void => {
    if (depth > 10000) fail();
    ws();
    if (i >= n) fail(n);
    const ch = text[i];
    if (ch === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (i >= n) fail(n);
        if (text[i] !== '"') fail();
        str();
        ws();
        if (i >= n) fail(n);
        if (text[i] !== ':') fail();
        i++;
        value(depth + 1);
        ws();
        if (i >= n) fail(n);
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return;
        }
        fail();
      }
    }
    if (ch === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        value(depth + 1);
        ws();
        if (i >= n) fail(n);
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return;
        }
        fail();
      }
    }
    if (ch === '"') return str();
    if (ch === 't') return lit('true');
    if (ch === 'f') return lit('false');
    if (ch === 'n') return lit('null');
    if (ch === '-' || (ch! >= '0' && ch! <= '9')) return num();
    fail();
  };
  try {
    value(0);
    ws();
    if (i < n) fail();
    return -1;
  } catch (e) {
    if (e instanceof Fail) return e.at;
    return i; // stack overflow or similar: best effort
  }
}

function stripBomStr(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Parse JSON text that came from `filePath` (for error reporting). Exported for callers that
 * already hold the text. Throws {@link JsonFileError}.
 */
export function parseJsonText<T = unknown>(text: string, filePath: string): T {
  const src = stripBomStr(text);
  try {
    return JSON.parse(src) as T;
  } catch (e) {
    let reason = e instanceof Error ? e.message : String(e);
    // Drop V8's own location suffixes; we compute our own.
    reason = reason
      .replace(/\s*\(line \d+ column \d+\)\s*$/, '')
      .replace(/\s+in JSON at position \d+.*$/, '')
      .replace(/,\s*"[\s\S]*" is not valid JSON$/, '');
    const off = findJsonErrorOffset(src);
    if (off < 0) throw new JsonFileError(filePath, reason);
    const { line, column } = positionToLineColumn(src, off);
    throw new JsonFileError(filePath, reason, line, column);
  }
}

/**
 * Read and parse a JSON file (UTF-8, BOM tolerated). Filesystem errors (ENOENT, EACCES, …)
 * propagate unchanged; syntax errors throw {@link JsonFileError}.
 */
export function readJsonFile<T = unknown>(p: string): T {
  const text = fs.readFileSync(p, 'utf8');
  return parseJsonText<T>(text, p);
}

/** Like {@link readJsonFile}, but `undefined` when the file does not exist. */
export function readJsonIfExists<T = unknown>(p: string): T | undefined {
  const text = readTextIfExists(p);
  if (text === undefined) return undefined;
  return parseJsonText<T>(text, p);
}

/**
 * Loop-safe `mkdir -p`: finds the deepest existing ancestor, then creates each missing
 * component with a plain `mkdir`. (Node's `mkdirSync({ recursive: true })` spins forever on
 * filesystems that answer `mkdir` with ENOENT for an existing parent, e.g. procfs.) Throws the
 * underlying error (ENOTDIR when a component is a file, EACCES, …).
 */
export function mkdirp(p: string, mode?: number): void {
  const target = path.resolve(p);
  const missing: string[] = [];
  let cur = target;
  for (;;) {
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(cur);
    } catch (e) {
      const code = errCode(e);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    }
    if (st) {
      if (!st.isDirectory()) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, mkdir '${cur}'`), { code: 'ENOTDIR', path: cur });
      }
      break;
    }
    missing.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const d of missing.reverse()) {
    try {
      if (mode === undefined) fs.mkdirSync(d);
      else fs.mkdirSync(d, mode);
    } catch (e) {
      if (errCode(e) === 'EEXIST' && isDirectory(d)) continue;
      throw e;
    }
  }
}

/** `mkdir -p` (mode applies to directories created by this call). See {@link mkdirp}. */
export function ensureDir(p: string, mode?: number): void {
  mkdirp(p, mode);
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // ignore
  }
}

/**
 * Follow `p` through symbolic links (relative link targets resolve against the link's
 * directory) to the path that should actually be replaced. A dangling link yields its
 * (missing) target; a loop or an unreadable link stops at the last path reached.
 */
export function resolveWriteTarget(p: string): string {
  let cur = path.resolve(p);
  for (let hops = 0; hops < 40; hops++) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return cur;
    }
    if (!st.isSymbolicLink()) return cur;
    let link: string;
    try {
      link = fs.readlinkSync(cur);
    } catch {
      return cur;
    }
    cur = path.resolve(path.dirname(cur), link);
  }
  return cur;
}

/**
 * Atomically replace `p` with `data`: write `<dir>/.<name>.<pid>.<rand>.tmp`, fsync, rename.
 * Parent directories are created. `opts.mode` sets the exact permission bits of the result;
 * without it an existing file's bits are kept (new files get the default 0666 & ~umask).
 * If `p` is a symbolic link, the file it points to is replaced and the link is kept
 * (dotfile setups often symlink `~/.kiro/settings/*.json`).
 */
export function writeFileAtomic(p: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  const target = resolveWriteTarget(p);
  const dir = path.dirname(target);
  mkdirp(dir);
  let mode = opts.mode;
  if (mode === undefined) {
    try {
      mode = fs.statSync(target).mode & 0o7777;
    } catch {
      mode = undefined;
    }
  }
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', mode ?? 0o666);
    // write() may be partial: loop until every byte is on disk.
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
    if (mode !== undefined && process.platform !== 'win32') {
      try {
        fs.fchmodSync(fd, mode);
      } catch {
        // best effort (e.g. filesystems without chmod)
      }
    }
    try {
      fs.fsyncSync(fd);
    } catch {
      // some filesystems do not support fsync; the rename is still atomic
    }
    fs.closeSync(fd);
    fd = undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, target);
        break;
      } catch (e) {
        const code = errCode(e);
        // Windows: the target may be briefly locked by another reader/AV scanner.
        if (process.platform === 'win32' && attempt < 5 && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
          sleepSync(20 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw e;
  }
}

/** Atomically write `JSON.stringify(value, null, 2) + '\n'`. */
export function writeJsonAtomic(p: string, value: unknown, opts: { mode?: number } = {}): void {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new TypeError(`writeJsonAtomic: value is not JSON-serializable (${typeof value})`);
  writeFileAtomic(p, `${text}\n`, opts);
}
