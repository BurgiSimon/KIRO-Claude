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
 * KiroCrew understands, 08a §4.2; it reads `pid` only), plus on Linux `"boot_id"` (this boot's
 * `/proc/sys/kernel/random/boot_id`) and `"start_ticks"` (the writer's start time, field 22 of
 * `/proc/self/stat`), which tie the lock to the process that wrote it. Created exclusively (hard
 * link of a fully written temp file, so a lock is never observed half-written). An existing lock
 * held by a live process of this host other than us ⇒ `Failed to start session: Session is active
 * in another process (PID N)`; a lock from a dead PID, an unreadable lock, or one written by this
 * process is taken over (one of this process is replaced in one step, a rename over it, so that
 * the name is never free while it changes hands: ACP loadFresh hands its lock to the session it
 * starts; r12g verify). A lock written on another host cannot be checked and is treated as live
 * (DECISION). `release()` removes the lock only while it is still ours. The takeover is race-free
 * (r12g S2): the openers that judged the same lock stale claim it first (an exclusive
 * `.<sid>.lock.takeover-<hash>` file; "Stale-lock takeover" below), only the claim's owner removes
 * it (by rename, put back with link() when what it moved is not that stale lock), and the
 * exclusive create then gives the session to exactly one opener; the others get the error above.
 * `delete()` removes a stale lock the same way.
 *
 * Hung-up holder (r12 #1, DECISION): a chat stopped for good with a hangup or kill pending keeps
 * its lock until it is continued, since a stopped process runs no handler. Under `sudo` with
 * `use_pty`, closing the terminal of a chat stopped in the background (Ctrl+Z, or the chat's own
 * stop after `bg`, `&`, a `!cmd` that ended there) leaves it so: sudo passes the SIGHUP on but never
 * continues the command once the user's terminal is gone, as for any program it runs. So when the
 * holder is such a process ({@link hungUpLockHolder}: Linux; this host and boot; state `T`, a
 * job-control stop, never a ptrace stop `t`; SIGHUP or SIGTERM pending in `/proc/<pid>/status`
 * SigPnd or ShdPnd; our real and effective uid; its start time the lock's `start_ticks`, so a
 * reused pid or a lock without these fields is never signalled; and the lock file a regular file
 * of our effective uid, not a symbolic link, since anyone can read those facts of any process),
 * {@link SessionStore.acquireLock} sends it SIGCONT (nothing else), which lets the pending signal close it as at a hangup (its
 * SessionEnd hooks run, its record is saved, its lock released, within its 2 s close grace), and
 * waits for that, blocking, up to {@link HUNG_UP_HOLDER_WAIT_MS}, before it takes the lock as for a
 * dead holder. A holder that is still running then keeps the error. Any other live holder (a chat
 * stopped by Ctrl+Z in a terminal still open: nothing pending) is never touched. The lock it
 * returns then says so ({@link SessionLock.continuedHolder}): what the holder saved at its close
 * is newer than a record read before the lock (KiroSessionImpl.build reads it again, r12g S1).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentTrust, SessionRecord, SessionTurnRecord, WorkspaceContext } from '../types.js';
import { mkdirp, writeJsonAtomic } from '../util/fsx.js';
import { log } from '../util/log.js';
import { expandTilde, realpathSafe } from '../util/paths.js';
// (kiroFiles.ts imports this module too: both only call each other's functions, never at load)
import { recordNeverUsed } from './kiroFiles.js';

export const SESSION_KIND = 'kiro-claude-session';
/** Title length cap (00 §7: "first prompt ≤60 chars"). */
export const TITLE_MAX_CHARS = 60;
/** `lastPreview` / turn preview cap. */
export const PREVIEW_MAX_CHARS = 200;
/**
 * Cap of a record's `pendingHistory` read from a file (a record, a `/chat load` export, r5 S3):
 * the block kiro-claude builds holds at most 48 KB of journal history (kiroFiles
 * `journalHistoryText`) inside its `<kiro-restored-history>` wrapper, which this leaves room for.
 */
export const PENDING_HISTORY_MAX_BYTES = 49 * 1024;

/** `$KIRO_CLAUDE_SESSIONS_DIR` (absolute, `~` expanded) else `<kiroHome>/sessions/cli`. */
export function sessionsDir(ws: WorkspaceContext): string {
  const o = ws.env.KIRO_CLAUDE_SESSIONS_DIR;
  if (o && o.trim() !== '') return path.resolve(ws.cwd, expandTilde(o.trim(), ws.env));
  return path.join(ws.kiroHome, 'sessions', 'cli');
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** A Claude Code session / message id. */
const CLAUDE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a Claude Code session / message id (a UUID): safe as a `--resume*` argv value. */
export function isClaudeUuid(s: unknown): s is string {
  return typeof s === 'string' && CLAUDE_UUID_RE.test(s);
}

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

/** Own-property assignment (agent names come from files: never touch the prototype). */
function setOwn<T>(o: Record<string, T>, k: string, v: T): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** One validated per-agent trust entry (SessionTrust.byAgent value). */
function agentTrustFrom(v: unknown): AgentTrust | undefined {
  if (!isObj(v)) return undefined;
  const out: AgentTrust = {
    allowedTools: strArr(v.allowedTools),
    rules: Array.isArray(v.rules) ? (v.rules.filter(isObj) as unknown as AgentTrust['rules']) : [],
  };
  if (Array.isArray(v.revokedTools)) out.revokedTools = strArr(v.revokedTools);
  return out;
}

/** `trust.byAgent` from disk (absent in older records ⇒ undefined). */
function byAgentFrom(v: unknown): Record<string, AgentTrust> | undefined {
  if (!isObj(v)) return undefined;
  const out: Record<string, AgentTrust> = {};
  for (const [name, entry] of Object.entries(v)) {
    const t = agentTrustFrom(entry);
    if (t && name !== '') setOwn(out, name, t);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Deep copy of `trust.byAgent` for a new record. */
function copyByAgent(v: Record<string, AgentTrust> | undefined): Record<string, AgentTrust> | undefined {
  if (!v) return undefined;
  const out: Record<string, AgentTrust> = {};
  for (const [name, t] of Object.entries(v)) {
    setOwn(out, name, { allowedTools: [...t.allowedTools], rules: t.rules.map((r) => ({ ...r })), ...(t.revokedTools ? { revokedTools: [...t.revokedTools] } : {}) });
  }
  return Object.keys(out).length ? out : undefined;
}

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

const RESTORED_OPEN = '<kiro-restored-history>';
const RESTORED_CLOSE = '</kiro-restored-history>';

/** The last `max` bytes of `s`, cut at a character boundary. */
function utf8Tail(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  let start = buf.length - Math.max(0, max);
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++; // never start inside a character
  return buf.subarray(start).toString('utf8');
}

/**
 * A `pendingHistory` no larger than {@link PENDING_HISTORY_MAX_BYTES} (r5 S3): as the journal
 * history is cut when kiro-claude builds the block, the most recent part is kept (`…` marks the
 * cut), inside the block's `<kiro-restored-history>` wrapper and explanation when it has them.
 * A block kiro-claude built is returned unchanged.
 */
export function capPendingHistory(text: string, max = PENDING_HISTORY_MAX_BYTES): string {
  if (text.length * 3 <= max || Buffer.byteLength(text, 'utf8') <= max) return text;
  let head = '';
  let tail = '';
  let body = text;
  const t = text.trimEnd();
  if (t.startsWith(RESTORED_OPEN) && t.endsWith(RESTORED_CLOSE)) {
    const end = t.indexOf('\n\n', RESTORED_OPEN.length);
    head = end >= 0 && end < 1024 ? t.slice(0, end + 2) : `${RESTORED_OPEN}\n`;
    tail = `\n${RESTORED_CLOSE}`;
    body = t.slice(head.length, t.length - RESTORED_CLOSE.length).replace(/\n$/, '');
  }
  const room = max - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8') - Buffer.byteLength('…', 'utf8');
  return `${head}…${utf8Tail(body, Math.max(0, room))}${tail}`;
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
        // a `--resume-session-at` value (a fork's pin, r5 S2): a UUID only
        if (isClaudeUuid(t.compactUuid)) turn.compactUuid = t.compactUuid;
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
      ...(Array.isArray(trustRaw.revokedTools) ? { revokedTools: strArr(trustRaw.revokedTools) } : {}),
    },
    planMode: raw.planMode === true,
  };
  const byAgent = byAgentFrom(trustRaw.byAgent);
  if (byAgent) rec.trust.byAgent = byAgent;
  const pending = strArr(raw.pendingContext).filter((s) => s.trim() !== '');
  if (pending.length) rec.pendingContext = pending;
  // context text like pendingContext (sent to Claude with the next line, R4 #1): a non-blank
  // string, no larger than a block kiro-claude builds (a hand-edited record, a crafted export, r5 S3)
  if (typeof raw.pendingHistory === 'string' && raw.pendingHistory.trim() !== '') rec.pendingHistory = capPendingHistory(raw.pendingHistory);
  // ids that become `--resume` / `--resume-session-at` argv values: UUIDs only (a copied record
  // file is not trusted to name a flag)
  const pf = raw.pendingFork;
  if (isObj(pf) && typeof pf.from === 'string' && CLAUDE_UUID_RE.test(pf.from) && (pf.at === undefined || (typeof pf.at === 'string' && CLAUDE_UUID_RE.test(pf.at)))) {
    rec.pendingFork = { from: pf.from, ...(typeof pf.at === 'string' ? { at: pf.at } : {}) };
  }
  const effort = typeof raw.effort === 'string' ? raw.effort : typeof kc.effort === 'string' ? kc.effort : undefined;
  if (effort !== undefined) rec.effort = effort;
  return rec;
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Origins `chat --resume` (the newest session for the directory) never picks. Kiro's `--resume`
 * continues the user's own latest chat; a session an ACP client started (KiroCrew: persistent
 * channel / dashboard sessions) belongs to that client, which resumes it itself with
 * `session/load` (08a §4.2), so an interactive resume must not take it over. Such sessions are
 * still listed (`--list-sessions`) and open by id (`--resume-id`, `session/load`).
 */
export const LATEST_RESUME_SKIPPED_ORIGINS: readonly SessionRecord['origin'][] = Object.freeze(['acp'] as const);

/** True when `chat --resume` may pick `rec` as the latest session: no tangent, no skipped origin. */
export function isLatestResumeCandidate(rec: SessionRecord): boolean {
  return rec.forkKind !== 'tangent' && !LATEST_RESUME_SKIPPED_ORIGINS.includes(rec.origin);
}

/** Newest `updatedAt` first; ties by `createdAt` (newest first), then id. */
export function compareSessionsNewestFirst(a: SessionRecord, b: SessionRecord): number {
  return timeOf(b.updatedAt) - timeOf(a.updatedAt) || timeOf(b.createdAt) - timeOf(a.createdAt) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
}

interface LockData {
  pid: number;
  started_at: string;
  host?: string;
  /** This boot's id (`/proc/sys/kernel/random/boot_id`) when the lock was written (Linux). */
  boot_id?: string;
  /** The writer's start time, field 22 of `/proc/<pid>/stat` (clock ticks since boot; Linux). */
  start_ticks?: number;
}

function parseLock(text: string): LockData | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    if (!isObj(v) || typeof v.pid !== 'number' || !Number.isInteger(v.pid) || v.pid <= 0) return undefined;
    const l: LockData = { pid: v.pid, started_at: str(v.started_at, '') };
    if (typeof v.host === 'string') l.host = v.host;
    if (typeof v.boot_id === 'string' && v.boot_id !== '') l.boot_id = v.boot_id;
    if (typeof v.start_ticks === 'number' && Number.isSafeInteger(v.start_ticks) && v.start_ticks >= 0) l.start_ticks = v.start_ticks;
    return l;
  } catch {
    return undefined;
  }
}

/** `<root>/<pid>/stat`: the pid it names, its state (field 3) and start time (field 22); undefined when unreadable. */
function procStat(root: string, pid: number | 'self'): { pid: number; state: string; start: number } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, String(pid), 'stat'), 'latin1');
  } catch {
    return undefined;
  }
  const close = text.lastIndexOf(')');
  if (close < 0) return undefined;
  // after ") ": state(3) ppid(4) … starttime(22) → indices 0 … 19 (the comm field may hold spaces)
  const f = text.slice(close + 2).split(' ');
  const p = Number.parseInt(text, 10);
  const start = Number(f[19]);
  if (!Number.isInteger(p) || !f[0] || !Number.isSafeInteger(start)) return undefined;
  return { pid: p, state: f[0], start };
}

/** `<root>/sys/kernel/random/boot_id`, undefined when unreadable. */
function bootId(root: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, 'sys', 'kernel', 'random', 'boot_id'), 'latin1').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** This process's `boot_id` / `start_ticks` for its locks (read once); null off Linux or when /proc is not ours. */
let ownIdentity: { boot_id: string; start_ticks: number } | null | undefined;
function lockIdentity(): { boot_id: string; start_ticks: number } | Record<string, never> {
  if (ownIdentity === undefined) {
    ownIdentity = null;
    if (process.platform === 'linux') {
      const self = procStat('/proc', 'self');
      const boot = bootId('/proc');
      if (self && self.pid === process.pid && boot) ownIdentity = { boot_id: boot, start_ticks: self.start };
    }
  }
  return ownIdentity ?? {};
}

/**
 * What {@link hungUpLockHolder} reads: the proc file system (default `/proc`) and our real and
 * effective user ids (default this process's). A seam for tests.
 */
export interface LockProcView {
  procRoot?: string;
  uid?: number;
  euid?: number;
}

/** SIGHUP (1) and SIGTERM (15) in a `/proc/<pid>/status` signal mask: bits 0 and 14. */
const HANGUP_OR_TERM_BITS = (1 << 0) | (1 << 14);

/**
 * How long an open waits for a hung-up holder it continued to close and give up its lock
 * ({@link SessionStore.acquireLock}): the chat's close grace (2 s, `SIGNAL_CLOSE_GRACE_MS`) and a
 * margin. A blocking wait (the lock is taken synchronously).
 */
export const HUNG_UP_HOLDER_WAIT_MS = 3000;
const HUNG_UP_POLL_MS = 20;

/**
 * True when lock `text` is held by a process that is stopped for good with a hangup or a kill
 * pending and that we may continue so it closes (module doc, "Hung-up holder"): Linux; the lock
 * names this host, this boot and the holder's start time (so the pid is the process that wrote it,
 * not a reused one); /proc describes our own pid namespace; the process is in state `T` (a
 * job-control stop; a ptrace stop `t` is never touched); SIGHUP or SIGTERM is pending (SigPnd or
 * ShdPnd); its real and effective uid are ours. Anything unreadable ⇒ false. (Before it acts,
 * acquireLock also requires the lock file itself to be ours, {@link ownLockFile}.)
 */
export function hungUpLockHolder(text: string, view: LockProcView = {}): boolean {
  const l = parseLock(text);
  return l !== undefined && hungUpHolder(l, view);
}

function hungUpHolder(l: LockData, view: LockProcView = {}): boolean {
  if (process.platform !== 'linux') return false;
  if (l.host !== os.hostname() || l.pid === process.pid || l.boot_id === undefined || l.start_ticks === undefined) return false;
  const root = view.procRoot ?? '/proc';
  const uid = view.uid ?? process.getuid?.();
  const euid = view.euid ?? process.geteuid?.();
  if (uid === undefined || euid === undefined) return false;
  if (procStat(root, 'self')?.pid !== process.pid || bootId(root) !== l.boot_id) return false;
  const st = procStat(root, l.pid);
  if (!st || st.pid !== l.pid || st.state !== 'T' || st.start !== l.start_ticks) return false;
  let status: string;
  try {
    status = fs.readFileSync(path.join(root, String(l.pid), 'status'), 'latin1');
  } catch {
    return false;
  }
  const ids = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
  if (!ids || Number(ids[1]) !== uid || Number(ids[2]) !== euid) return false;
  let bits = 0;
  let masks = 0;
  for (const m of status.matchAll(/^(?:SigPnd|ShdPnd):\s*([0-9a-fA-F]+)\s*$/gm)) {
    bits |= Number.parseInt(m[1]!.slice(-4), 16);
    masks++;
  }
  return masks > 0 && (bits & HANGUP_OR_TERM_BITS) !== 0;
}

/** A hung-up holder this open continued: its pid, its start time, and how long we wait for it. */
interface Continued {
  pid: number;
  start: number;
  until: number;
}

/**
 * Whether `pid` is still the process that started at `start` and has not exited (a zombie has).
 * An entry that cannot be read counts as running while the pid exists (never a live holder's lock
 * taken for a gone one).
 */
function stillRunning(pid: number, start: number): boolean {
  const st = procStat('/proc', pid);
  if (!st) return pidAlive(pid);
  return st.start === start && st.state !== 'Z' && st.state !== 'X';
}

/** Lock `l` was written by the process `c` names (it may take its lock again while it closes). */
function writtenBy(l: LockData, c: Continued): boolean {
  return l.pid === c.pid && l.start_ticks === c.start && l.host === os.hostname();
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // ignore
  }
}

/** Until the lock file no longer reads `text`, the holder has exited, or `c.until` (a blocking poll). */
function waitForHolder(lockPath: string, text: string, c: Continued): void {
  for (;;) {
    const left = c.until - Date.now();
    if (left <= 0 || readText(lockPath) !== text || !stillRunning(c.pid, c.start)) return;
    sleepSync(Math.min(HUNG_UP_POLL_MS, left));
  }
}

/**
 * The lock file at `lockPath` is a regular file (not a symbolic link) owned by our effective uid
 * that still reads `text`, read through one descriptor (owner and content of the same file). Its
 * pid, boot id and start time are facts anyone can read of any process, so only a lock we (our
 * uid) wrote ties them to the process that wrote it (r12 #1 verification: a lock another user
 * could write, in a session index of theirs that root opens under `sudo -E`, named any of our
 * stopped processes).
 */
function ownLockFile(lockPath: string, text: string): boolean {
  const euid = process.geteuid?.();
  if (euid === undefined) return false;
  let fd: number | undefined;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    return st.isFile() && st.uid === euid && fs.readFileSync(fd, 'utf8') === text;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * The hung-up holder of lock `text` ({@link hungUpLockHolder}, in a lock file of ours,
 * {@link ownLockFile}), continued with SIGCONT and waited for ({@link waitForHolder}); undefined
 * (nothing sent) when the holder is not one.
 */
function continueHungUp(lockPath: string, text: string, l: LockData): Continued | undefined {
  if (!hungUpHolder(l) || !ownLockFile(lockPath, text)) return undefined;
  try {
    process.kill(l.pid, 'SIGCONT');
  } catch {
    return undefined;
  }
  log.warn(`session lock ${path.basename(lockPath)}: PID ${l.pid} is stopped with a hangup or kill pending; sent it SIGCONT so that it closes`);
  const c: Continued = { pid: l.pid, start: l.start_ticks!, until: Date.now() + HUNG_UP_HOLDER_WAIT_MS };
  waitForHolder(lockPath, text, c);
  return c;
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

/**
 * Create `p` with `data` only if it does not exist (atomic content). The temp file's name keeps at
 * most 160 characters of `p`'s, so it stays within the 255-byte name limit also for a takeover
 * claim of the longest session id (`.<200-char id>.lock.takeover-<k>`, 240; r12g verify).
 */
function createExclusive(p: string, data: string): boolean {
  const tmp = path.join(path.dirname(p), `.${path.basename(p).slice(0, 160)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
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

function unlinkQuiet(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    // gone already
  }
}

/**
 * Put the lock `data` in place of a lock of this process at `lockPath` in one step (a written temp
 * file renamed over it): the name is never free, so no other open can take the session in between
 * (a removal and a create, as for a stale lock, would leave it free for a moment). False when it
 * could not be done (the caller then takes the lock over as a stale one).
 */
function replaceOwnLock(lockPath: string, data: string): boolean {
  const tmp = path.join(path.dirname(lockPath), `.${path.basename(lockPath).slice(0, 160)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, lockPath);
    return true;
  } catch {
    unlinkQuiet(tmp);
    return false;
  }
}

/*
 * Stale-lock takeover (r12g S2, DECISION). Removing a stale lock and creating ours cannot be one
 * step, so the openers that judged the same lock text stale first claim it:
 * `.<sid>.lock.takeover-<k>`, created exclusively like a lock (our pid, host, boot and start time),
 * `k` a hash of the stale text. Only the claim's owner removes the stale lock; the others wait for
 * that, reading the claim (it is created only while absent), and look at the lock again (the
 * exclusive create then decides who owns the session). A claim
 * whose writer is gone (it died in the middle of a takeover) is passed: the next claim's name is a
 * hash of `k` and that claim's text, which every opener derives alike, so there is still one owner
 * at a time. The stale text is unique (pid, started_at) and never comes back once it is gone from
 * the lock path, so every claim on it is garbage then and removed by the owner.
 */
/** How long an open waits for another opener's takeover of the same stale lock. */
const TAKEOVER_WAIT_MS = 1000;
const TAKEOVER_POLL_MS = 2;
/**
 * Claims of gone claimants passed before giving up (each one a process that died in a takeover).
 * Past it nobody would ever remove the stale lock (every open of the session failing for good), so
 * it only bounds the walk (r12g verify: it was 4).
 */
const TAKEOVER_MAX_CLAIMS = 64;
/** A claim that cannot be parsed and is older than this is a gone claimant's (one is written at once). */
const UNREAD_CLAIM_STALE_MS = 10_000;

function claimKey(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 24);
}

/**
 * The writer of the claim `text` at `claimPath` can no longer act: our own (a takeover of ours
 * that threw: none runs now), a dead pid, a pid now another process's or a zombie (its start time
 * on this boot), a claim of an earlier boot, or an unparsable claim older than
 * {@link UNREAD_CLAIM_STALE_MS}. A claim of another host cannot be checked and is left to it.
 */
function claimantGone(text: string, claimPath: string): boolean {
  const cl = parseLock(text);
  if (!cl) {
    try {
      return Date.now() - fs.statSync(claimPath).mtimeMs > UNREAD_CLAIM_STALE_MS;
    } catch {
      return false;
    }
  }
  if (cl.host !== os.hostname()) return false;
  if (cl.pid === process.pid) return true;
  if (!pidAlive(cl.pid)) return true;
  const boot = (lockIdentity() as { boot_id?: string }).boot_id;
  if (boot === undefined || cl.boot_id === undefined || cl.start_ticks === undefined) return false;
  if (cl.boot_id !== boot) return true;
  const st = procStat('/proc', cl.pid);
  return st !== undefined && st.pid === cl.pid && (st.start !== cl.start_ticks || st.state === 'Z' || st.state === 'X');
}

/**
 * Under a takeover claim: remove `lockPath` if it still reads `text`. By rename to a name of ours,
 * which moves exactly the file then there; when that is not `text` (a third party removed the stale
 * lock and a new opener's lock took the name meanwhile: KiroCrew removes a dead holder's lock
 * itself), it is put back with link(), which never replaces a lock. True when `text` is no longer
 * at `lockPath`.
 */
function removeIfStill(lockPath: string, text: string): boolean {
  let cur: string;
  try {
    cur = fs.readFileSync(lockPath, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT';
  }
  if (cur !== text) return true;
  const aside = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${process.pid}.${randomBytes(6).toString('hex')}.stale`);
  try {
    fs.renameSync(lockPath, aside);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT';
  }
  if (readText(aside) !== text) {
    try {
      fs.linkSync(aside, lockPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // a filesystem without hard links: moved back unless yet another lock took the name
      if (code !== 'EEXIST' && !fs.existsSync(lockPath)) {
        try {
          fs.renameSync(aside, lockPath);
          return true;
        } catch {
          // fall through
        }
      }
      log.warn(`session lock ${path.basename(lockPath)}: could not put back the lock of an open that took its name while its stale lock was removed (${code ?? String(e)})`);
    }
  }
  unlinkQuiet(aside);
  return true;
}

/**
 * Take the stale lock `text` off `lockPath`, race-free (see "Stale-lock takeover" above).
 * Undefined: look at the lock again (we removed it, the claim's owner did, or it was replaced).
 * Otherwise another opener still holds the claim at the end of a bounded wait
 * ({@link TAKEOVER_WAIT_MS}): the session is about to be its own (`claimant`, when parsable).
 */
function takeOverStale(lockPath: string, text: string): { claimant?: LockData } | undefined {
  const dir = path.dirname(lockPath);
  const mine = `${JSON.stringify({ pid: process.pid, started_at: uniqueLockTime(), host: os.hostname(), ...lockIdentity() })}\n`;
  const until = Date.now() + TAKEOVER_WAIT_MS;
  const passed: string[] = [];
  let key = claimKey(text);
  while (passed.length < TAKEOVER_MAX_CLAIMS) {
    const claim = path.join(dir, `.${path.basename(lockPath)}.takeover-${key}`);
    // created only while absent: a wait polls with reads, not a temp file written every poll (each
    // one left behind by a SIGKILL that lands there; r12g verify)
    if (readText(claim) === undefined && createExclusive(claim, mine)) {
      let gone = false;
      try {
        gone = removeIfStill(lockPath, text);
      } finally {
        for (const p of gone ? [...passed, claim] : [claim]) unlinkQuiet(p);
      }
      return undefined;
    }
    const ct = readText(claim);
    if (ct === undefined) return undefined;
    if (claimantGone(ct, claim)) {
      passed.push(claim);
      key = claimKey(`${key}\n${ct}`);
      continue;
    }
    if (readText(lockPath) !== text) return undefined;
    if (Date.now() >= until) {
      const claimant = parseLock(ct);
      return claimant ? { claimant } : {};
    }
    sleepSync(TAKEOVER_POLL_MS);
  }
  return undefined;
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
  /**
   * This lock was taken after a hung-up holder that {@link SessionStore.acquireLock} continued had
   * closed (module doc, "Hung-up holder"): what that holder saved at its close (the turn it was
   * running, settled as interrupted; a line Claude never read put back; its title, trust, plan
   * mode) is newer than anything read before the lock was taken, so a record read then must be
   * read again (KiroSessionImpl.build re-reads it under the lock in every case, r12g S1).
   */
  readonly continuedHolder: boolean;
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
   * its realpath. `trust` (byAgent included) and the other nested fields are deep-copied, so a
   * fork record is written with the session's trust and fork from the start (r7 #1). Throws when
   * `<id>.json` already exists (use {@link write} to replace).
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
        ...(init.trust?.revokedTools ? { revokedTools: [...init.trust.revokedTools] } : {}),
      },
      planMode: init.planMode ?? false,
    };
    const byAgent = copyByAgent(init.trust?.byAgent);
    if (byAgent) rec.trust.byAgent = byAgent;
    if (init.pendingContext?.length) rec.pendingContext = [...init.pendingContext];
    if (init.pendingHistory !== undefined && init.pendingHistory.trim() !== '') rec.pendingHistory = init.pendingHistory;
    if (init.effort !== undefined) rec.effort = init.effort;
    if (init.pendingFork) rec.pendingFork = { from: init.pendingFork.from, ...(init.pendingFork.at ? { at: init.pendingFork.at } : {}) };
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

  /**
   * The id a record file gives itself (our `sessionId` key) when it differs from its filename
   * stem, i.e. the file is a copy made by someone else: KiroCrew's peer session transfer rewrites
   * the kiro-cli envelope under a new sid filename but keeps our keys (08a §4.2). Undefined for
   * our own files (and for missing / foreign / unsafe ones).
   */
  copiedFrom(id: string): string | undefined {
    if (!isSafeSessionId(id)) return undefined;
    const text = readText(path.join(this.dir, `${id}.json`));
    if (text === undefined) return undefined;
    try {
      const raw = JSON.parse(text) as unknown;
      if (!isObj(raw) || raw.kind !== SESSION_KIND) return undefined;
      return typeof raw.sessionId === 'string' && raw.sessionId !== '' && raw.sessionId !== id ? raw.sessionId : undefined;
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
   * whose cwd has the same realpath. A chat that never had a message and was left behind by a
   * process that died before closing it ({@link leftBehindUnused}) is no saved session: it is
   * removed instead of listed, so `chat --resume`, `--list-sessions` and the `/chat resume`
   * picker never offer it over the last real conversation (r4 #4).
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
      if (this.leftBehindUnused(rec)) {
        this.removeLeftBehind(id);
        continue;
      }
      out.push(rec);
    }
    return out.sort(compareSessionsNewestFirst);
  }

  /**
   * `rec` is a chat that never had a message (kiroFiles.ts {@link recordNeverUsed}: never an ACP
   * session, a tangent, or a record with turns, messages or a journaled prompt) whose lock is
   * still on disk but names a process of this host that is gone. Its process died before its
   * close(), which drops such a record (a Ctrl+C / SIGHUP / SIGTERM the lifecycle forwarder
   * turned into a death, SIGKILL, a crash). A record with no lock (closed, or one another
   * process is creating) or a live lock (a chat starting or waiting at its first prompt) is kept.
   */
  private leftBehindUnused(rec: SessionRecord): boolean {
    if (rec.turns.length > 0 || rec.messageCount > 0 || rec.forkKind !== 'main' || rec.origin === 'acp') return false;
    const text = readText(this.lockPathFor(rec.sessionId));
    if (text === undefined) return false;
    const l = parseLock(text);
    if (!l || l.pid === process.pid || heldByOther(l)) return false;
    return recordNeverUsed(this.dir, rec);
  }

  /** Remove a {@link leftBehindUnused} record: index file, its stale lock and its journal. */
  private removeLeftBehind(id: string): void {
    try {
      if (this.delete(id)) fs.rmSync(path.join(this.dir, `${id}.jsonl`), { force: true });
    } catch {
      /* best effort: it is skipped either way */
    }
  }

  /**
   * Newest session of any origin for `cwd` (tangent sessions are skipped: they are temporary).
   * `chat --resume` must use {@link latestResumable} instead.
   */
  latest(cwd: string): SessionRecord | undefined {
    return this.list({ cwd }).find((r) => r.forkKind !== 'tangent');
  }

  /**
   * What `chat --resume` continues: the newest {@link isLatestResumeCandidate} session for
   * `cwd` (never a tangent, never an ACP / KiroCrew session).
   */
  latestResumable(cwd: string): SessionRecord | undefined {
    return this.list({ cwd }).find(isLatestResumeCandidate);
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
      // removed only while it still reads `text` (an open may take it over meanwhile: its lock stays)
      if (!l || !heldByOther(l)) takeOverStale(lockPath, text);
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

  /**
   * Take the single-process lock for a session (see module doc). A hung-up holder (module doc) is
   * continued once and waited for, blocking, up to {@link HUNG_UP_HOLDER_WAIT_MS}, also while it
   * takes its lock again for a moment as it closes (the chat's record made the newest); once it has
   * exited, a lock it left is taken over as a dead holder's. Two opens racing for it: one gets the
   * lock, the other the 'Session is active in another process' error; so for any number of opens
   * taking over the same stale lock (takeOverStale), one of them naming the opener that still holds
   * the takeover claim after {@link TAKEOVER_WAIT_MS} when that one is slow. `continuedHolder` on
   * the lock: it was taken after a continued holder's close.
   */
  acquireLock(id: string): SessionLock {
    const lockPath = this.lockPathFor(id);
    this.ensureDir();
    const mine: LockData = { pid: process.pid, started_at: uniqueLockTime(), host: os.hostname(), ...lockIdentity() };
    const data = `${JSON.stringify(mine)}\n`;
    let continued: Continued | undefined;
    const taken = (): SessionLock => {
      let released = false;
      return {
        continuedHolder: continued !== undefined,
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
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      if (createExclusive(lockPath, data)) return taken();
      const text = readText(lockPath);
      if (text === undefined) continue; // released meanwhile: retry
      const l = parseLock(text);
      if (l && heldByOther(l)) {
        const active = new Error(`Failed to start session: Session is active in another process (PID ${l.pid})`);
        if (continued && writtenBy(l, continued)) {
          // the holder we continued, still closing: wait on (a wait is no attempt; `until` bounds
          // it); once it has exited (a zombie too) its lock is stale
          if (stillRunning(continued.pid, continued.start)) {
            if (Date.now() >= continued.until) throw active;
            waitForHolder(lockPath, text, continued);
            attempt--;
            continue;
          }
        } else if (!continued && (continued = continueHungUp(lockPath, text, l))) {
          attempt--;
          continue;
        } else {
          throw active;
        }
      }
      // a lock of this process (another lock object of ours: ACP loadFresh hands the lock it read
      // the record under to the session it starts): replaced in one step, so that no other process
      // finds the name free meanwhile (r12g verify; only this process writes or removes it)
      if (l?.pid === process.pid && replaceOwnLock(lockPath, data)) return taken();
      // stale (dead pid), unreadable, or our own: take it over, race-free (takeOverStale); an
      // opener still taking the same stale lock over at the end of the wait owns the session
      const busy = takeOverStale(lockPath, text);
      if (busy?.claimant) throw new Error(`Failed to start session: Session is active in another process (PID ${busy.claimant.pid})`);
      if (busy) break;
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
