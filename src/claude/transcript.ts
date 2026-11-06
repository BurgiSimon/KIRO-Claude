/**
 * Claude Code transcript files (`.jsonl`) — locating, reading and re-keying them.
 *
 * Sources: 00-synthesis §3.10 (transcript path `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<abs cwd
 * with every [^A-Za-z0-9] → '-'>/<sessionId>.jsonl`, VERIFIED), §2.5 rows `/chat save|load`
 * (load = copy the transcript under a fresh uuid with every `sessionId` rewritten, then
 * `--resume <uuid>`; UNVERIFIED that rewriting suffices) and 04 §12. Real 2.1.318 transcripts
 * carry `sessionId` only at the top level of each line (checked on every transcript of this
 * machine during review); see {@link rewriteTranscriptSessionId} for the nested rule.
 *
 * The directory name is matched exactly first and, because newer Claude Code builds may shorten
 * very long project names, {@link findTranscript} falls back to scanning every project dir.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** `$CLAUDE_CONFIG_DIR` when set (non-empty), else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir && dir.trim() !== '') return path.resolve(dir);
  return path.join(homeDir(env), '.claude');
}

/** `<config dir>/projects`. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(claudeConfigDir(env), 'projects');
}

/** Claude Code's project directory name for `cwd`: every char outside `[A-Za-z0-9]` ⇒ `-`. */
export function sanitizeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Session ids are UUIDs in practice; refuse anything that could escape the projects dir. */
function safeSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) && !id.includes('..');
}

/** Expected transcript path for a session started in `cwd` (the file may not exist). */
export function transcriptPath(sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(claudeProjectsDir(env), sanitizeProjectDir(cwd), `${sessionId}.jsonl`);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds `<sessionId>.jsonl`: first under the project dir of `cwd` (as given, then its realpath),
 * then by scanning `projects/*`. Returns the absolute path or `undefined`.
 */
export function findTranscript(sessionId: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string | undefined {
  if (!safeSessionId(sessionId)) return undefined;
  const env = opts.env ?? process.env;
  const projects = claudeProjectsDir(env);
  const file = `${sessionId}.jsonl`;
  if (opts.cwd) {
    const cwds = [path.resolve(opts.cwd)];
    try {
      const real = fs.realpathSync(opts.cwd);
      if (!cwds.includes(real)) cwds.push(real);
    } catch {
      /* cwd may no longer exist */
    }
    for (const c of cwds) {
      const p = path.join(projects, sanitizeProjectDir(c), file);
      if (isFile(p)) return p;
    }
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(projects, e.name, file);
    if (isFile(p)) return p;
  }
  return undefined;
}

/** Parses JSONL text; blank and unparseable lines are skipped. */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

/** Reads and parses a transcript file (bad lines skipped). Throws if the file cannot be read. */
export function readTranscript(file: string): unknown[] {
  return parseJsonl(fs.readFileSync(file, 'utf8'));
}

const SESSION_KEYS: readonly string[] = ['sessionId', 'session_id'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Copy of `value` with session-id fields replaced: at depth 0 every string `sessionId` /
 * `session_id`; deeper only fields whose value is one of `oldIds` (the transcript's own ids), so
 * tool inputs/outputs that merely use a key named `session_id` (e.g. an MCP tool's parameter)
 * keep their data. Objects are built without a prototype so a JSON `"__proto__"` key stays an
 * ordinary property instead of being swallowed by the `Object.prototype.__proto__` setter.
 */
function rewriteValue(value: unknown, newId: string, oldIds: ReadonlySet<string>, depth: number, state: { changed: boolean }): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteValue(v, newId, oldIds, depth + 1, state));
  if (isPlainObject(value)) {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) {
      if (SESSION_KEYS.includes(k) && typeof v === 'string' && (depth === 0 || oldIds.has(v))) {
        if (v !== newId) state.changed = true;
        out[k] = newId;
      } else {
        out[k] = rewriteValue(v, newId, oldIds, depth + 1, state);
      }
    }
    return out;
  }
  return value;
}

const NOT_JSON = Symbol('not-json');

/**
 * Re-keys a transcript (00 §2.5 `/chat load`): on every JSON line, the top-level string
 * `sessionId` / `session_id` is replaced by `newSessionId`, and so is any NESTED field of that
 * name whose value is one of the transcript's top-level session ids (e.g. a recorded hook input);
 * nested fields holding other values belong to tool data and are left alone.
 * Lines that need no change, lines that are not JSON, blank lines and the line-ending style
 * (LF / CRLF, trailing newline) are preserved byte-for-byte.
 */
export function rewriteTranscriptSessionId(jsonlText: string, newSessionId: string): string {
  const parts = jsonlText.split('\n');
  const parsed: unknown[] = parts.map((part) => {
    const line = part.endsWith('\r') ? part.slice(0, -1) : part;
    if (line.trim() === '') return NOT_JSON;
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return NOT_JSON;
    }
  });
  const oldIds = new Set<string>();
  for (const v of parsed) {
    if (!isPlainObject(v)) continue;
    for (const k of SESSION_KEYS) if (typeof v[k] === 'string') oldIds.add(v[k] as string);
  }
  return parts
    .map((part, i) => {
      const value = parsed[i];
      if (value === NOT_JSON) return part;
      const state = { changed: false };
      const rewritten = rewriteValue(value, newSessionId, oldIds, 0, state);
      if (!state.changed) return part;
      return JSON.stringify(rewritten) + (part.endsWith('\r') ? '\r' : '');
    })
    .join('\n');
}
