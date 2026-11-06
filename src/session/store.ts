/**
 * Session index store (00 §7, binding; 01 §6; KiroCrew contract 08 KC-FS-02, 08a §4.2).
 *
 * Location: `$KIRO_CLAUDE_SESSIONS_DIR`, else `<kiroHome>/sessions/cli` (00 §8 C6: one store
 * shared by REPL, headless and ACP; KiroCrew requires `sessions/cli/<sid>.json` to exist
 * before it sends `session/load`). One file per session, `<sessionId>.json`; the filename stem
 * is the id.
 *
 * File format: the {@link SessionRecord} fields, plus a kiro-cli-compatible envelope that
 * KiroCrew reads and may rewrite (08a §4.2): `session_id`, `created_at`, `updated_at`,
 * `session_state.{agent_name, permissions.filesystem.allowed_{read,write}_paths,
 * conversation_metadata}` and `kiro_claude.{claudeSessionId, model, effort}`. When reading, the
 * stem is the id and envelope values win over ours if a third party changed them (KiroCrew
 * session transfer rewrites the envelope under a new filename).
 *
 * Files without `"kind":"kiro-claude-session"` belong to real kiro-cli and are ignored by
 * {@link SessionStore.read}/{@link SessionStore.list} and never deleted.
 *
 * Writes are atomic (temp + rename), files 0600, the directory is created 0700.
 *
 * Locks: `<sid>.lock` = `{"pid":N,"started_at":"<iso>","host":"<hostname>"}` (the shape
 * KiroCrew understands, 08a §4.2), created exclusively (hard link of a fully written temp
 * file, so a lock is never observed half-written). An existing lock held by a live process of
 * this host other than us ⇒ `Failed to start session: Session is active in another process
 * (PID N)`; a lock from a dead PID, an unreadable lock, or one written by this process is
 * taken over. A lock written on another host cannot be checked and is treated as live
 * (DECISION). `release()` removes the lock only while it is still ours.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionRecord, SessionTurnRecord, WorkspaceContext } from '../types.js';
import { mkdirp, writeJsonAtomic } from '../util/fsx.js';
import { expandTilde, realpathSafe } from '../util/paths.js';

export const SESSION_KIND = 'kiro-claude-session';
/** Title length cap (00 §7: "first prompt ≤60 chars"). */
export const TITLE_MAX_CHARS = 60;
/** `lastPreview` / turn preview cap. */
export const PREVIEW_MAX_CHARS = 200;

/** `$KIRO_CLAUDE_SESSIONS_DIR` (absolute, `~` expanded) else `<kiroHome>/sessions/cli`. */
export function sessionsDir(ws: WorkspaceContext): string {
  const o = ws.env.KIRO_CLAUDE_SESSIONS_DIR;
  if (o && o.trim() !== '') return path.resolve(ws.cwd, expandTilde(o.trim(), ws.env));
  return path.join(ws.kiroHome, 'sessions', 'cli');
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** True when `id` can be used as a file stem in the store (no separators, no `..`). */
export function isSafeSessionId(id: string): boolean {
  return SAFE_ID_RE.test(id) && !id.includes('..');
}

function assertSafeId(id: string): void {
  if (!isSafeSessionId(id)) throw new Error(`Invalid session id: ${JSON.stringify(id)}`);
}

/** Collapse whitespace and cut to `max` characters (code points), ending with `…` when cut. */
export function previewText(s: string, max = PREVIEW_MAX_CHARS): string {
  const one = s.replace(/\s+/g, ' ').trim();
  const cps = [...one];
  if (cps.length <= max) return one;
  return `${cps.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const ORIGINS: readonly SessionRecord['origin'][] = ['repl', 'acp', 'headless', 'spec'];
const FORK_KINDS: readonly SessionRecord['forkKind'][] = ['main', 'tangent', 'rewind', 'spawn', 'compact'];

/** On-disk JSON for a record (record fields + kiro-cli envelope). */
export function toDiskJson(rec: SessionRecord): Record<string, unknown> {
  return {
    ...rec,
    session_id: rec.sessionId,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    session_state: {
      agent_name: rec.agent,
      permissions: { filesystem: { allowed_read_paths: [], allowed_write_paths: [] } },
      conversation_metadata: {},
    },
    kiro_claude: { claudeSessionId: rec.claudeSessionId, model: rec.model, effort: rec.effort ?? null },
  };
}

/** Parse on-disk JSON into a record; undefined for foreign / malformed files. */
export function fromDiskJson(raw: unknown, id: string): SessionRecord | undefined {
  if (!isObj(raw) || raw.kind !== SESSION_KIND) return undefined;
  const state = isObj(raw.session_state) ? raw.session_state : {};
  const kc = isObj(raw.kiro_claude) ? raw.kiro_claude : {};
  const now = new Date().toISOString();
  const createdAt = str(raw.created_at, str(raw.createdAt, now));
  const updatedAt = str(raw.updated_at, str(raw.updatedAt, createdAt));
  const origin = ORIGINS.includes(raw.origin as SessionRecord['origin']) ? (raw.origin as SessionRecord['origin']) : 'repl';
  const forkKind = FORK_KINDS.includes(raw.forkKind as SessionRecord['forkKind']) ? (raw.forkKind as SessionRecord['forkKind']) : 'main';
  const trustRaw = isObj(raw.trust) ? raw.trust : {};
  const turns: SessionTurnRecord[] = Array.isArray(raw.turns)
    ? raw.turns.filter(isObj).map((t) => {
        const turn: SessionTurnRecord = { userUuid: str(t.userUuid, ''), preview: str(t.preview, ''), at: str(t.at, '') };
        if (typeof t.assistantUuid === 'string') turn.assistantUuid = t.assistantUuid;
        return turn;
      })
    : [];
  const rec: SessionRecord = {
    version: 1,
    kind: SESSION_KIND,
    origin,
    sessionId: id,
    claudeSessionId: str(raw.claudeSessionId, str(kc.claudeSessionId, id)),
    cwd: str(raw.cwd, ''),
    additionalDirectories: strArr(raw.additionalDirectories),
    agent: str(state.agent_name, str(raw.agent, 'kiro_default')),
    model: str(raw.model, str(kc.model, 'auto')),
    title: str(raw.title, ''),
    createdAt,
    updatedAt,
    messageCount: typeof raw.messageCount === 'number' && Number.isFinite(raw.messageCount) ? raw.messageCount : turns.length,
    lastPreview: str(raw.lastPreview, ''),
    parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
    forkKind,
    tangentName: typeof raw.tangentName === 'string' ? raw.tangentName : null,
    turns,
    contextRules: Array.isArray(raw.contextRules)
      ? raw.contextRules.filter(isObj).filter((r) => typeof r.rule === 'string').map((r) => ({ rule: r.rule as string, origin: 'session' as const }))
      : [],
    trust: {
      trustAll: trustRaw.trustAll === true,
      allowedTools: strArr(trustRaw.allowedTools),
      rules: Array.isArray(trustRaw.rules) ? (trustRaw.rules.filter(isObj) as unknown as SessionRecord['trust']['rules']) : [],
    },
    planMode: raw.planMode === true,
  };
  const effort = typeof raw.effort === 'string' ? raw.effort : typeof kc.effort === 'string' ? kc.effort : undefined;
  if (effort !== undefined) rec.effort = effort;
  return rec;
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Newest `updatedAt` first; ties by `createdAt` (newest first), then id. */
export function compareSessionsNewestFirst(a: SessionRecord, b: SessionRecord): number {
  return timeOf(b.updatedAt) - timeOf(a.updatedAt) || timeOf(b.createdAt) - timeOf(a.createdAt) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
}

interface LockData {
  pid: number;
  started_at: string;
  host?: string;
}

function parseLock(text: string): LockData | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    if (!isObj(v) || typeof v.pid !== 'number' || !Number.isInteger(v.pid) || v.pid <= 0) return undefined;
    const l: LockData = { pid: v.pid, started_at: str(v.started_at, '') };
    if (typeof v.host === 'string') l.host = v.host;
    return l;
  } catch {
    return undefined;
  }
}

/** True when `pid` names a running process (EPERM counts as running). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock held by someone else that we must respect (see module doc). */
function heldByOther(l: LockData): boolean {
  if (l.host !== undefined && l.host !== os.hostname()) return true;
  if (l.pid === process.pid) return false;
  return pidAlive(l.pid);
}

function readText(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** Create `p` with `data` only if it does not exist (atomic content). */
function createExclusive(p: string, data: string): boolean {
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try {
    fs.linkSync(tmp, p);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // filesystems without hard links: fall back to O_EXCL create + write
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS' || code === 'EXDEV') {
      let fd: number;
      try {
        fd = fs.openSync(p, 'wx', 0o600);
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e2;
      }
      try {
        fs.writeSync(fd, data);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    }
    throw e;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

/** Last lock timestamp handed out by this process: `started_at` is unique per process. */
let lastLockTime = 0;
function uniqueLockTime(): string {
  const t = Math.max(Date.now(), lastLockTime + 1);
  lastLockTime = t;
  return new Date(t).toISOString();
}

export interface SessionLock {
  release(): void;
}

/** Persistent session index (see module doc). */
export class SessionStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  /** `<dir>/<id>.json` */
  pathFor(id: string): string {
    assertSafeId(id);
    return path.join(this.dir, `${id}.json`);
  }

  /** `<dir>/<id>.lock` */
  lockPathFor(id: string): string {
    assertSafeId(id);
    return path.join(this.dir, `${id}.lock`);
  }

  private ensureDir(): void {
    try {
      fs.statSync(this.dir);
    } catch {
      mkdirp(this.dir, 0o700);
    }
  }

  /**
   * Create, persist and return a new record. Ids are fresh UUIDs unless given;
   * `claudeSessionId` defaults to the session id (00 §2.5 "New session"); `cwd` is stored as
   * its realpath. Throws when `<id>.json` already exists (use {@link write} to replace).
   */
  create(init: Partial<SessionRecord> & Pick<SessionRecord, 'origin' | 'cwd' | 'agent' | 'model'>): SessionRecord {
    const now = new Date().toISOString();
    const sessionId = init.sessionId ?? randomUUID();
    assertSafeId(sessionId);
    if (fs.existsSync(path.join(this.dir, `${sessionId}.json`))) throw new Error(`Session ${sessionId} already exists`);
    const rec: SessionRecord = {
      version: 1,
      kind: SESSION_KIND,
      origin: init.origin,
      sessionId,
      claudeSessionId: init.claudeSessionId ?? sessionId,
      cwd: realpathSafe(init.cwd),
      additionalDirectories: [...(init.additionalDirectories ?? [])],
      agent: init.agent,
      model: init.model,
      title: init.title ?? '',
      createdAt: init.createdAt ?? now,
      updatedAt: init.updatedAt ?? now,
      messageCount: init.messageCount ?? 0,
      lastPreview: init.lastPreview ?? '',
      parentId: init.parentId ?? null,
      forkKind: init.forkKind ?? 'main',
      tangentName: init.tangentName ?? null,
      turns: (init.turns ?? []).map((t) => ({ ...t })),
      contextRules: (init.contextRules ?? []).map((r) => ({ ...r })),
      trust: {
        trustAll: init.trust?.trustAll ?? false,
        allowedTools: [...(init.trust?.allowedTools ?? [])],
        rules: (init.trust?.rules ?? []).map((r) => ({ ...r })),
      },
      planMode: init.planMode ?? false,
    };
    if (init.effort !== undefined) rec.effort = init.effort;
    this.persist(rec);
    return rec;
  }

  /** Read one record; undefined when missing, malformed, foreign, or the id is unsafe. */
  read(id: string): SessionRecord | undefined {
    if (!isSafeSessionId(id)) return undefined;
    const text = readText(path.join(this.dir, `${id}.json`));
    if (text === undefined) return undefined;
    try {
      return fromDiskJson(JSON.parse(text), id);
    } catch {
      return undefined;
    }
  }

  private persist(rec: SessionRecord): void {
    this.ensureDir();
    writeJsonAtomic(this.pathFor(rec.sessionId), toDiskJson(rec), { mode: 0o600 });
  }

  /** Persist `rec` atomically, setting `rec.updatedAt` to now (never moving it backwards). */
  write(rec: SessionRecord): void {
    assertSafeId(rec.sessionId);
    const now = new Date();
    const prev = timeOf(rec.updatedAt);
    rec.updatedAt = (prev > now.getTime() ? new Date(prev) : now).toISOString();
    this.persist(rec);
  }

  /**
   * All records (foreign files ignored), newest `updatedAt` first. With `cwd`, only records
   * whose cwd has the same realpath.
   */
  list(opts: { cwd?: string } = {}): SessionRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const want = opts.cwd !== undefined ? realpathSafe(opts.cwd) : undefined;
    const out: SessionRecord[] = [];
    for (const n of names) {
      if (!n.endsWith('.json') || n.startsWith('.')) continue;
      const id = n.slice(0, -5);
      const rec = this.read(id);
      if (!rec) continue;
      if (want !== undefined && rec.cwd !== want && realpathSafe(rec.cwd) !== want) continue;
      out.push(rec);
    }
    return out.sort(compareSessionsNewestFirst);
  }

  /** Newest resumable session for `cwd` (tangent sessions are skipped: they are temporary). */
  latest(cwd: string): SessionRecord | undefined {
    return this.list({ cwd }).find((r) => r.forkKind !== 'tangent');
  }

  /**
   * Delete our index file and its lock (never Claude transcripts, never foreign files, never a
   * lock held by another live process). True when an index file was removed.
   */
  delete(id: string): boolean {
    if (!isSafeSessionId(id)) return false;
    if (!this.read(id)) return false;
    try {
      fs.unlinkSync(this.pathFor(id));
    } catch {
      return false;
    }
    const lockPath = this.lockPathFor(id);
    const text = readText(lockPath);
    if (text !== undefined) {
      const l = parseLock(text);
      if (!l || !heldByOther(l)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      }
    }
    return true;
  }

  /** Current lock holder, if any (for diagnostics). */
  lockInfo(id: string): { pid: number; startedAt: string; host?: string; live: boolean } | undefined {
    const text = readText(this.lockPathFor(id));
    if (text === undefined) return undefined;
    const l = parseLock(text);
    if (!l) return undefined;
    return { pid: l.pid, startedAt: l.started_at, ...(l.host !== undefined ? { host: l.host } : {}), live: heldByOther(l) || l.pid === process.pid };
  }

  /** Take the single-process lock for a session (see module doc). */
  acquireLock(id: string): SessionLock {
    const lockPath = this.lockPathFor(id);
    this.ensureDir();
    const mine: LockData = { pid: process.pid, started_at: uniqueLockTime(), host: os.hostname() };
    const data = `${JSON.stringify(mine)}\n`;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (createExclusive(lockPath, data)) {
        let released = false;
        return {
          release: () => {
            if (released) return;
            released = true;
            const cur = readText(lockPath);
            const l = cur !== undefined ? parseLock(cur) : undefined;
            if (l && l.pid === mine.pid && l.started_at === mine.started_at) {
              try {
                fs.unlinkSync(lockPath);
              } catch {
                // ignore
              }
            }
          },
        };
      }
      const text = readText(lockPath);
      if (text === undefined) continue; // released meanwhile: retry
      const l = parseLock(text);
      if (l && heldByOther(l)) {
        throw new Error(`Failed to start session: Session is active in another process (PID ${l.pid})`);
      }
      // stale (dead pid), unreadable, or our own: take it over if it is still the same file
      if (readText(lockPath) === text) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // someone else removed it; retry
        }
      }
    }
    throw new Error(`Failed to start session: could not acquire the session lock ${lockPath}`);
  }

  /**
   * Record a finished turn: append `turn`, bump `messageCount` (one per user turn), set
   * `lastPreview` from `preview` and, for the first turn, `title` from the turn's preview
   * (≤ 60 chars, 00 §7). Mutates `rec`, persists it (updating `updatedAt`) and returns it.
   */
  appendTurn(rec: SessionRecord, turn: SessionTurnRecord, preview: string): SessionRecord {
    rec.turns.push({ ...turn, preview: previewText(turn.preview) });
    rec.messageCount += 1;
    rec.lastPreview = previewText(preview);
    if (!rec.title) rec.title = previewText(turn.preview || preview, TITLE_MAX_CHARS);
    this.write(rec);
    return rec;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local `YYYY-MM-DD HH:MM` for listings. */
export function formatListTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * `--list-sessions` output (01 §6; exact Kiro text UNVERIFIED, DECISION): plain = one line per
 * session `<id>  <YYYY-MM-DD HH:MM>  <N message(s)>  <title>` (newest first as given; title
 * falls back to the last preview, then `(untitled)`; tangents tagged `[tangent: <name>]`), or
 * `No saved chat sessions for this directory.`; json = compact array of summary rows.
 */
export function formatSessionList(records: SessionRecord[], format: 'plain' | 'json'): string {
  if (format === 'json') {
    return JSON.stringify(
      records.map((r) => ({
        sessionId: r.sessionId,
        title: r.title,
        cwd: r.cwd,
        agent: r.agent,
        model: r.model,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        messageCount: r.messageCount,
        lastPreview: r.lastPreview,
        parentId: r.parentId,
        forkKind: r.forkKind,
      })),
    );
  }
  if (records.length === 0) return 'No saved chat sessions for this directory.';
  const counts = records.map((r) => `${r.messageCount} ${r.messageCount === 1 ? 'message' : 'messages'}`);
  const cw = Math.max(...counts.map((c) => c.length));
  return records
    .map((r, i) => {
      const tag = r.forkKind === 'tangent' ? `[tangent${r.tangentName ? `: ${r.tangentName}` : ''}] ` : '';
      const title = r.title || r.lastPreview || '(untitled)';
      return `${r.sessionId}  ${formatListTime(r.updatedAt)}  ${counts[i]!.padEnd(cw)}  ${tag}${title}`.replace(/\s+$/, '');
    })
    .join('\n');
}
