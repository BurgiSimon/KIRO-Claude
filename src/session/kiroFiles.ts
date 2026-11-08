/**
 * kiro-cli-compatible session files that KiroCrew reads, copies and replays
 * (08 §0 item 12, §2.4 KC-FS-02/03/04; 08a §4.2; 08a §9 #1).
 *
 * Directory: the session index directory (session/store.ts `sessionsDir`, normally
 * `$KIRO_HOME/sessions/cli`). Per session id (a UUID; the filename stem IS the id):
 *
 *  - `<sid>.json` — the kiro-cli snake_case envelope merged with our {@link SessionRecord}.
 *    Written by session/store.ts (`toDiskJson`, atomic temp+rename, 0600); {@link kiroCliEnvelope}
 *    exposes just the envelope part for callers/tests.
 *  - `<sid>.jsonl` — the **mandatory** journal (KiroCrew prunes session mappings whose journal
 *    is smaller than 10 bytes and never `session/load`s them). One JSON object per line,
 *    appended (one `write` per batch, file 0600, dir 0700) at each turn end:
 *      `{"version":1,"kind":"Prompt","timestamp":<iso>,"data":{"message_id","content":[blocks]}}`
 *      `{"version":1,"kind":"AssistantMessage","timestamp","data":{"message_id","content":[blocks]}}`
 *      `{"version":1,"kind":"ToolResults","timestamp","data":{"message_id","content":[{"kind":"toolResult","data":{"toolUseId","content":[blocks],"status":"success"|"error"}}]}}`
 *      `{"version":1,"kind":"Compaction","timestamp","data":{"messages_snapshot":[{"content":[blocks]}]}}`
 *    Blocks: `{"kind":"text","data":"…"}`; images (shape copied from KiroCrew's
 *    `test_session_image_repair.py::_image_block`, verified there against real transcripts):
 *    `{"kind":"image","data":{"format":"png","source":{"kind":"bytes","data":[<byte ints>]}}}`;
 *    tool uses inside an AssistantMessage: `{"kind":"toolUse","data":{"toolUseId","name","input"}}`
 *    (DECISION: the real kiro-cli shape is UNVERIFIED, 08a §9 #1; KiroCrew only reads `Prompt`
 *    text and counts records, so `AssistantMessage` mirrors `Prompt`'s `content[]` form).
 *    The Claude transcript stays the source of truth; this file is a mirror for KiroCrew
 *    (digest, analytics, transfer, `session/load` replay). Growth is capped (DECISION, see
 *    {@link JOURNAL_TOOL_RESULT_MAX_BYTES}): one tool result keeps ≤ 256 KiB of text plus a
 *    truncation marker, one record keeps ≤ 5 MiB of images and a text placeholder for the rest.
 *  - `<sid>.lock` — owned by session/store.ts.
 *
 * Readers ({@link readJournal}, {@link replayItems}, {@link journalHistoryText}) are used by
 * `session/load` replay (ACP) and to rebuild context when a Claude transcript is gone
 * (08a §4.2: an imported/transferred copy). A `Compaction` record replaces everything before it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionRecord } from '../types.js';
import { mkdirp } from '../util/fsx.js';
import { truncateBytes } from '../util/text.js';
import { toDiskJson } from './store.js';

/** KiroCrew keeps a session mapping only when `<sid>.jsonl` has at least this many bytes. */
export const JOURNAL_MIN_BYTES = 10;

/**
 * Journal size caps. KiroCrew never needs these bytes verbatim (08a §4.2 readers): its
 * tool-result side reader keeps ≤ 4000 characters per block and ≤ 8000 per result
 * (`client_tool_events._jsonl_tool_results`), the digest only counts image blocks, our
 * `session/load` replay caps tool text again, and the Claude transcript stays the source of
 * truth for the model. Without caps one `cat` of a big file or a pasted screenshot adds
 * megabytes per line (image bytes are stored as JSON integer arrays, ~3.6× their size).
 *
 * Text of ONE tool result kept in a `ToolResults` record (UTF-8 bytes; the marker is extra).
 */
export const JOURNAL_TOOL_RESULT_MAX_BYTES = 256 * 1024;
/** Raw image bytes kept per record; images that do not fit become a text placeholder. */
export const JOURNAL_IMAGE_MAX_BYTES_PER_RECORD = 5 * 1024 * 1024;

/**
 * Tool-result text as journaled: unchanged up to {@link JOURNAL_TOOL_RESULT_MAX_BYTES}, else its
 * head (cut on a UTF-8 character boundary) plus
 * `\n… [kiro-claude: tool output truncated in the session journal: <n> of <total> bytes omitted]`.
 */
export function capToolResultText(text: string, maxBytes = JOURNAL_TOOL_RESULT_MAX_BYTES): string {
  if (text.length * 3 <= maxBytes) return text;
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return text;
  const head = truncateBytes(text, maxBytes);
  const omitted = total - Buffer.byteLength(head, 'utf8');
  return `${head}\n… [kiro-claude: tool output truncated in the session journal: ${omitted} of ${total} bytes omitted]`;
}

export type JournalBlock =
  | { kind: 'text'; data: string }
  | { kind: 'image'; data: { format: string; source: { kind: 'bytes'; data: number[] } } }
  | { kind: 'toolUse'; data: { toolUseId: string; name: string; input: unknown } }
  | { kind: 'toolResult'; data: { toolUseId: string; content: JournalBlock[]; status: 'success' | 'error' } }
  | { kind: string; data: unknown };

export type JournalKind = 'Prompt' | 'AssistantMessage' | 'ToolResults' | 'Compaction';

export interface JournalRecord {
  version: 1;
  kind: JournalKind | string;
  timestamp: string;
  data: {
    message_id?: string;
    content?: JournalBlock[];
    messages_snapshot?: { content: JournalBlock[] }[];
    [k: string]: unknown;
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function sidPath(dir: string, sid: string, ext: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(sid) || sid.includes('..')) throw new Error(`Invalid session id: ${JSON.stringify(sid)}`);
  return path.join(dir, `${sid}${ext}`);
}

/** `<dir>/<sid>.jsonl` */
export function journalPath(dir: string, sid: string): string {
  return sidPath(dir, sid, '.jsonl');
}

/** `<dir>/<sid>.json` */
export function envelopePath(dir: string, sid: string): string {
  return sidPath(dir, sid, '.json');
}

/** Only the kiro-cli envelope keys of `<sid>.json` (08 KC-FS-02). */
export function kiroCliEnvelope(rec: SessionRecord): {
  session_id: string;
  cwd: string;
  created_at: string;
  updated_at: string;
  title: string;
  session_state: unknown;
  kind: string;
  kiro_claude: unknown;
} {
  const d = toDiskJson(rec);
  return {
    session_id: d.session_id as string,
    cwd: rec.cwd,
    created_at: d.created_at as string,
    updated_at: d.updated_at as string,
    title: rec.title,
    session_state: d.session_state,
    kind: rec.kind,
    kiro_claude: d.kiro_claude,
  };
}

// ───────────────────────────── record builders ─────────────────────────────

const MEDIA_FORMATS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** kiro-cli image block from base64 data (08a §4.2 shape). */
export function imageBlock(mediaType: string, dataBase64: string): JournalBlock {
  const bytes = Buffer.from(dataBase64, 'base64');
  return { kind: 'image', data: { format: imageFormat(mediaType), source: { kind: 'bytes', data: Array.from(bytes) } } };
}

export function textBlock(text: string): JournalBlock {
  return { kind: 'text', data: text };
}

interface RecordOpts {
  messageId?: string;
  timestamp?: string;
}

function base(kind: JournalKind, data: JournalRecord['data'], opts: RecordOpts): JournalRecord {
  return { version: 1, kind, timestamp: opts.timestamp ?? new Date().toISOString(), data };
}

function imageFormat(mediaType: string): string {
  return MEDIA_FORMATS[mediaType.toLowerCase()] ?? mediaType.replace(/^image\//i, '').toLowerCase();
}

/** Text block standing in for an image the journal does not keep (see {@link promptRecord}). */
export function omittedImageBlock(mediaType: string, bytes: number, maxBytes = JOURNAL_IMAGE_MAX_BYTES_PER_RECORD): JournalBlock {
  return textBlock(`[image not stored in the session journal: ${imageFormat(mediaType)}, ${bytes} bytes; images over ${maxBytes} bytes per message are not kept]`);
}

/**
 * `Prompt` record: the user's text (as typed) plus attached images, in order, while their raw
 * size stays within `maxImageBytes` (default {@link JOURNAL_IMAGE_MAX_BYTES_PER_RECORD}) for the
 * record; an image that does not fit is replaced by {@link omittedImageBlock} (the shape
 * KiroCrew's own image repair uses for a dropped image) and later ones that still fit are kept.
 */
export function promptRecord(
  text: string,
  opts: RecordOpts & { images?: { mediaType: string; dataBase64: string }[]; maxImageBytes?: number } = {},
): JournalRecord {
  const content: JournalBlock[] = [textBlock(text)];
  const max = opts.maxImageBytes ?? JOURNAL_IMAGE_MAX_BYTES_PER_RECORD;
  let used = 0;
  for (const img of opts.images ?? []) {
    const size = Buffer.byteLength(img.dataBase64, 'base64');
    if (used + size <= max) {
      content.push(imageBlock(img.mediaType, img.dataBase64));
      used += size;
    } else {
      content.push(omittedImageBlock(img.mediaType, size, max));
    }
  }
  return base('Prompt', { message_id: opts.messageId ?? randomUUID(), content }, opts);
}

/** `AssistantMessage` record (text and toolUse blocks of one assistant message). */
export function assistantRecord(content: JournalBlock[], opts: RecordOpts = {}): JournalRecord {
  return base('AssistantMessage', { message_id: opts.messageId ?? randomUUID(), content }, opts);
}

/** `ToolResults` record for one batch of tool results (each text capped, {@link capToolResultText}). */
export function toolResultsRecord(
  results: { toolUseId: string; text: string; isError: boolean }[],
  opts: RecordOpts = {},
): JournalRecord {
  return base(
    'ToolResults',
    {
      message_id: opts.messageId ?? randomUUID(),
      content: results.map((r) => ({
        kind: 'toolResult',
        data: { toolUseId: r.toolUseId, content: [textBlock(capToolResultText(r.text))], status: r.isError ? 'error' : 'success' },
      })),
    },
    opts,
  );
}

/** `Compaction` record; an empty `summary` marks a cleared conversation (`/clear`). */
export function compactionRecord(summary: string, opts: RecordOpts = {}): JournalRecord {
  return base('Compaction', { messages_snapshot: summary === '' ? [] : [{ content: [textBlock(summary)] }] }, opts);
}

// ───────────────────────────── I/O ─────────────────────────────

/**
 * Append records to `<dir>/<sid>.jsonl` with ONE write (so a crash never leaves half a batch
 * interleaved with another writer's lines). Creates the dir (0700) and the file (0600).
 * Returns the number of bytes written.
 */
export function appendJournal(dir: string, sid: string, records: readonly JournalRecord[]): number {
  if (records.length === 0) return 0;
  const p = journalPath(dir, sid);
  try {
    fs.statSync(dir);
  } catch {
    mkdirp(dir, 0o700);
  }
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const buf = Buffer.from(text, 'utf8');
  const fd = fs.openSync(p, 'a', 0o600);
  try {
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    try {
      fs.fsyncSync(fd);
    } catch {
      /* best effort */
    }
  } finally {
    fs.closeSync(fd);
  }
  return buf.length;
}

/** Parse journal text; malformed lines are skipped. */
export function parseJournal(text: string): JournalRecord[] {
  const out: JournalRecord[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (isObj(v) && typeof v.kind === 'string' && isObj(v.data)) {
        out.push({
          version: 1,
          kind: v.kind,
          timestamp: typeof v.timestamp === 'string' ? v.timestamp : '',
          data: v.data as JournalRecord['data'],
        });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Every record of `<dir>/<sid>.jsonl` (empty when missing). Used by ACP `session/load` replay. */
export function readJournal(dir: string, sid: string): JournalRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(journalPath(dir, sid), 'utf8');
  } catch {
    return [];
  }
  return parseJournal(text);
}

/** Raw journal text ('' when missing). */
export function readJournalText(dir: string, sid: string): string {
  try {
    return fs.readFileSync(journalPath(dir, sid), 'utf8');
  } catch {
    return '';
  }
}

/** Size of `<dir>/<sid>.jsonl` in bytes (0 when missing). */
export function journalSize(dir: string, sid: string): number {
  try {
    return fs.statSync(journalPath(dir, sid)).size;
  } catch {
    return 0;
  }
}

/**
 * `rec` (in the index directory `dir`) is a chat that never had a message, which Q never saves
 * (it saves a conversation only after a reply, 06 §6.1): a main record of the user's own (not a
 * tangent or rewind, not an ACP / KiroCrew session) with no turns, no message and no `Prompt` in
 * its journal. A chat cleared after a conversation keeps its record (its journal holds the prompts,
 * K4); one whose only action was `/clear` or `/compact` journals only a compaction marker. One
 * that holds context for its next line (a `/tangent merge` summary merged into it, a restored
 * history) is kept: a reopen delivers it. KiroSession's close drops such a record (unusedRecord;
 * also one a quit inside its tangent leaves in the tangent stack, r5 S4); the session index skips
 * one left behind by a process that died before its close (store.ts `list`, r4 #4).
 * `opts.tangent`: a tangent record by the same rules too (a tangent of such a chat, which holds
 * nothing either: KiroSession's close drops it with that chat, r5 g1).
 */
export function recordNeverUsed(dir: string, rec: SessionRecord, opts: { tangent?: boolean } = {}): boolean {
  if (!(rec.forkKind === 'main' || (opts.tangent === true && rec.forkKind === 'tangent')) || rec.origin === 'acp') return false;
  if (rec.turns.length > 0 || rec.messageCount > 0) return false;
  if (rec.pendingContext?.length || rec.pendingHistory !== undefined) return false;
  let text: string;
  try {
    const file = journalPath(dir, rec.sessionId);
    if (!fs.existsSync(file)) return true;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false; // an unsafe id or an unreadable journal: keep what may be a conversation
  }
  return !parseJournal(text).some((j) => j.kind === 'Prompt');
}

/** Records up to (excluding) the `(prompts + 1)`-th `Prompt` record. */
export function journalPrefix(records: readonly JournalRecord[], prompts: number): JournalRecord[] {
  const out: JournalRecord[] = [];
  let seen = 0;
  for (const r of records) {
    if (r.kind === 'Prompt') {
      if (seen >= prompts) break;
      seen++;
    }
    out.push(r);
  }
  return out;
}

/**
 * Records before the `Prompt` record whose `data.message_id` is `messageId` (every record when
 * none matches). Turn N+1's Prompt carries that turn's user uuid (`turns[N].userUuid`), so this is
 * the exact rewind cut even when steers added extra `Prompt` records or a `/clear` reset the
 * turn list (counting `Prompt` records, {@link journalPrefix}, is wrong in both cases).
 */
export function journalBeforeMessage(records: readonly JournalRecord[], messageId: string): JournalRecord[] {
  const i = records.findIndex((r) => r.kind === 'Prompt' && r.data.message_id === messageId);
  return i < 0 ? [...records] : records.slice(0, i);
}

/**
 * A compaction (a `Compaction` record) follows turn `index` (0-based) of `turns`: after the
 * `Prompt` record of that turn (by message id). False when no Prompt names the turn.
 */
export function compactedAfterTurn(records: readonly JournalRecord[], turns: readonly { userUuid: string }[], index: number): boolean {
  const id = turns[index]?.userUuid;
  if (id === undefined) return false;
  const i = records.findIndex((r) => r.kind === 'Prompt' && r.data.message_id === id);
  return i >= 0 && records.slice(i + 1).some((r) => r.kind === 'Compaction');
}

/** A `/clear` marker: a `Compaction` record with an empty snapshot (KiroSession.clear). */
function isClearMarker(r: JournalRecord): boolean {
  return r.kind === 'Compaction' && Array.isArray(r.data.messages_snapshot) && r.data.messages_snapshot.length === 0;
}

/**
 * The exchange of the turn whose `Prompt` has the message id `userUuid`: that prompt's text and
 * the text of the turn's last assistant message (steer prompts inside the turn skipped; the
 * turn ends at the next prompt of `turnIds`, or at the end). An automatic compaction inside the
 * turn (its `Compaction` record comes before the turn's answer, r6 #5) does not end it, nor does
 * a `/compact` after it (it adds no answer); a `/clear` marker does. What a `/tangent tail`
 * carries of a tangent rewound to that turn (KiroSession.rewind). Undefined when no `Prompt`
 * names the turn.
 */
export function turnExchange(records: readonly JournalRecord[], userUuid: string, turnIds: ReadonlySet<string> = new Set()): { user: string; assistant: string } | undefined {
  const i = records.findIndex((r) => r.kind === 'Prompt' && r.data.message_id === userUuid);
  if (i < 0) return undefined;
  let assistant = '';
  for (const r of records.slice(i + 1)) {
    if (r.kind === 'Prompt' && typeof r.data.message_id === 'string' && turnIds.has(r.data.message_id)) break;
    if (isClearMarker(r)) break;
    if (r.kind !== 'AssistantMessage') continue;
    const text = blocksText(r.data.content);
    if (text !== '') assistant = text;
  }
  return { user: blocksText(records[i]!.data.content), assistant };
}

/**
 * Copy `<from>.jsonl` to `<to>.jsonl` (replacing it), optionally keeping only the first
 * `prompts` user prompts, or only the records before the Prompt `beforeMessageId` (rewind).
 * Returns the number of records copied.
 */
export function copyJournal(dir: string, fromSid: string, toSid: string, opts: { prompts?: number; beforeMessageId?: string } = {}): number {
  let records = readJournal(dir, fromSid);
  if (opts.beforeMessageId !== undefined) records = journalBeforeMessage(records, opts.beforeMessageId);
  else if (opts.prompts !== undefined) records = journalPrefix(records, opts.prompts);
  writeJournalRecords(dir, toSid, records);
  return records.length;
}

/**
 * Copy the journal of a conversation forked at turn `index` (0-based) of `turns` (`/rewind`, or
 * a fork at a rewind point, `KiroSessionOptions.fork.at`): the records before the next turn's
 * `Prompt` (by message id, so steers and `/clear` markers do not shift the cut), at the last turn
 * every record, and in both cases without the compactions that followed the turn: they summarize
 * turns the journal holds verbatim before them, and a history restored from the cut starts at its
 * last compaction (journalHistoryText), so a trailing one would leave only a summary written
 * after turn N (Claude Code writes it without the messages it keeps verbatim, turn N's answer
 * among them, r6 #1). A compaction inside a turn (an automatic one, before the turn's answer) is
 * kept; a `/clear` marker cannot trail a turn (`/clear` resets the turn list). Nothing is written
 * when there is nothing to copy. Returns the number of records copied.
 */
export function copyJournalThroughTurn(dir: string, fromSid: string, toSid: string, turns: readonly { userUuid: string }[], index: number): number {
  const next = turns[index + 1];
  let records = readJournal(dir, fromSid);
  if (next) records = journalBeforeMessage(records, next.userUuid);
  while (records.length && records[records.length - 1]!.kind === 'Compaction') records.pop();
  if (records.length) writeJournalRecords(dir, toSid, records);
  return records.length;
}

/** Replace `<sid>.jsonl` with exactly `records` (atomic temp + rename, 0600). */
export function writeJournalRecords(dir: string, sid: string, records: readonly JournalRecord[]): void {
  writeJournalText(dir, sid, records.length ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
}

/** Replace `<sid>.jsonl` with `text` (atomic temp + rename, 0600). */
export function writeJournalText(dir: string, sid: string, text: string): void {
  const p = journalPath(dir, sid);
  try {
    fs.statSync(dir);
  } catch {
    mkdirp(dir, 0o700);
  }
  const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

// ───────────────────────────── replay ─────────────────────────────

export type ReplayItem =
  | { type: 'user'; text: string; images: { format: string; bytes: number }[]; timestamp: string }
  | { type: 'assistant'; text: string; timestamp: string }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown; timestamp: string }
  | { type: 'tool_result'; toolUseId: string; text: string; isError: boolean; timestamp: string }
  | { type: 'compaction'; summary: string; timestamp: string };

function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((b) => (isObj(b) && b.kind === 'text' && typeof b.data === 'string' ? b.data : ''))
    .filter((t) => t !== '')
    .join('\n');
}

/**
 * Flatten records into display items (ACP `session/load` replay). With `afterLastCompaction`
 * (default true) only items after the last `Compaction` are returned, the compaction itself
 * first (a cleared conversation yields an empty summary item, dropped).
 */
export function replayItems(records: readonly JournalRecord[], opts: { afterLastCompaction?: boolean } = {}): ReplayItem[] {
  let start = 0;
  if (opts.afterLastCompaction !== false) {
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i]!.kind === 'Compaction') {
        start = i;
        break;
      }
    }
  }
  const out: ReplayItem[] = [];
  for (const r of records.slice(start)) {
    const ts = r.timestamp;
    const content = Array.isArray(r.data.content) ? r.data.content : [];
    switch (r.kind) {
      case 'Prompt': {
        const images = content
          .filter((b): b is Extract<JournalBlock, { kind: 'image' }> => isObj(b) && b.kind === 'image' && isObj(b.data))
          .map((b) => {
            const d = b.data as { format?: unknown; source?: { data?: unknown } };
            return { format: typeof d.format === 'string' ? d.format : 'png', bytes: Array.isArray(d.source?.data) ? d.source!.data.length : 0 };
          });
        out.push({ type: 'user', text: blocksText(content), images, timestamp: ts });
        break;
      }
      case 'AssistantMessage': {
        let text = '';
        const flushText = (): void => {
          if (text !== '') out.push({ type: 'assistant', text, timestamp: ts });
          text = '';
        };
        for (const b of content) {
          if (!isObj(b)) continue;
          if (b.kind === 'text' && typeof b.data === 'string') text += (text ? '\n' : '') + b.data;
          else if (b.kind === 'toolUse' && isObj(b.data)) {
            flushText();
            const d = b.data as { toolUseId?: unknown; name?: unknown; input?: unknown };
            out.push({ type: 'tool_use', toolUseId: String(d.toolUseId ?? ''), name: String(d.name ?? ''), input: d.input ?? {}, timestamp: ts });
          }
        }
        flushText();
        break;
      }
      case 'ToolResults':
        for (const b of content) {
          if (!isObj(b) || b.kind !== 'toolResult' || !isObj(b.data)) continue;
          const d = b.data as { toolUseId?: unknown; content?: unknown; status?: unknown };
          out.push({ type: 'tool_result', toolUseId: String(d.toolUseId ?? ''), text: blocksText(d.content), isError: d.status === 'error', timestamp: ts });
        }
        break;
      case 'Compaction': {
        const snap = Array.isArray(r.data.messages_snapshot) ? r.data.messages_snapshot : [];
        const summary = snap.map((m) => (isObj(m) ? blocksText(m.content) : '')).filter((t) => t !== '').join('\n\n');
        if (summary !== '') out.push({ type: 'compaction', summary, timestamp: ts });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * The conversation as plain text (`User: …` / `Assistant: …`, summaries as `Summary: …`), cut
 * to the last `maxBytes` bytes; undefined when there is nothing to tell. Used to seed a fresh
 * Claude session when the original transcript is gone (08a §4.2 "rebuild context by replaying").
 */
export function journalHistoryText(records: readonly JournalRecord[], maxBytes = 48 * 1024): string | undefined {
  const lines: string[] = [];
  for (const it of replayItems(records)) {
    if (it.type === 'user' && it.text.trim() !== '') lines.push(`User: ${it.text.trim()}`);
    else if (it.type === 'assistant' && it.text.trim() !== '') lines.push(`Assistant: ${it.text.trim()}`);
    else if (it.type === 'compaction') lines.push(`Summary: ${it.summary.trim()}`);
  }
  if (lines.length === 0) return undefined;
  let text = lines.join('\n\n');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    // keep the most recent part
    const buf = Buffer.from(text, 'utf8');
    text = `…${buf.subarray(buf.length - maxBytes).toString('utf8').replace(/^�+/, '')}`;
  }
  return truncateBytes(text, maxBytes + 4);
}
