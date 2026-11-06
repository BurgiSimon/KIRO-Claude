/**
 * History replay for `session/load` (research 05 §4.4 step 4, §7.12; 08 KC-ACP-10, KC-FS-03).
 *
 * Primary source: the kiro-cli-compatible session journal `<sessions dir>/<sid>.jsonl` that the
 * session module appends after every turn (08 §0 item 12, 08a §4.2 record shapes, verified by
 * KiroCrew's tests):
 *
 *   {"version":1,"kind":"Prompt","timestamp":…,"data":{"message_id":…,"content":[{"kind":"text","data":"…"},{"kind":"image","data":{"format":"png","source":{"kind":"bytes","data":[…]}}}]}}
 *   {"version":1,"kind":"AssistantMessage",…,"data":{"message_id":…,"content":[{"kind":"text","data":"…"}, …]}}
 *   {"version":1,"kind":"ToolResults",…,"data":{"message_id":…,"content":[{"kind":"toolResult","data":{"toolUseId":…,"content":[{"kind":"text"|"json","data":…}],"status":"success"|"error"}}]}}
 *   {"version":1,"kind":"Compaction",…}
 *
 * Tool uses inside `AssistantMessage.content` are read leniently (`kind` `toolUse`/`tool_use`
 * with `data.{toolUseId|id, name, input|args}` — the exact kiro-cli spelling is UNVERIFIED).
 * Replay starts after the last `Compaction` record (what the model still knows; an empty one
 * marks `/clear`); a compaction summary is replayed as one `agent_message_chunk`
 * `Conversation summary:\n<summary>` (DECISION). Unknown kinds are skipped.
 *
 * Fallback (no journal, or an empty one): the Claude transcript
 * `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<sanitized cwd>/<claudeSid>.jsonl` (05 §4.4), skipping
 * sidechain / meta / synthetic lines, local-command echoes and interrupt markers (05 §7.12).
 *
 * Every replayed update carries `_meta.kiro.replay = true` (V3 convention, 05 §4.4).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { findTranscript, readTranscript } from '../claude/transcript.js';
import { toKiroCall } from '../policy/toolmap.js';
import { parseJsonl } from '../claude/transcript.js';
import { capText, describeToolCall, stripToolUseError, toolCallUpdate, type ToolDescriptor } from './mapping.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** `<dir>/<sid>.jsonl`. */
export function journalPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.jsonl`);
}

/** Parsed journal records (bad lines skipped); `[]` when the file is missing. */
export function readJournalRecords(file: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return parseJsonl(text).filter(isObj);
}

function withReplayMeta(u: Record<string, unknown>): Record<string, unknown> {
  const m = isObj(u._meta) ? { ...u._meta } : {};
  const kiro = isObj(m.kiro) ? { ...m.kiro } : {};
  kiro.replay = true;
  m.kiro = kiro;
  return { ...u, _meta: m };
}

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** A journal image block ⇒ ACP image content (bytes array or base64 string sources). */
function journalImage(data: unknown): Record<string, unknown> | undefined {
  if (!isObj(data)) return undefined;
  const format = str(data.format) ?? 'png';
  const src = isObj(data.source) ? data.source : undefined;
  if (!src) return undefined;
  let b64: string | undefined;
  if (Array.isArray(src.data) && src.data.every((x) => typeof x === 'number')) b64 = Buffer.from(src.data as number[]).toString('base64');
  else if (typeof src.data === 'string') b64 = src.data;
  if (!b64) return undefined;
  return { type: 'image', mimeType: IMAGE_MIME[format.toLowerCase()] ?? `image/${format}`, data: b64 };
}

function jsonText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (isObj(v) && typeof v.stdout === 'string') {
    const err = typeof v.stderr === 'string' && v.stderr ? `\n${v.stderr}` : '';
    return `${v.stdout}${err}`;
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

interface ReplayState {
  cwd: string;
  tools: Map<string, ToolDescriptor>;
  updates: Record<string, unknown>[];
}

function emitToolUse(st: ReplayState, id: string, name: string, input: Record<string, unknown>): void {
  if (!id || st.tools.has(id)) return;
  const call = toKiroCall(name, input, { cwd: st.cwd, toolUseId: id });
  const d = describeToolCall(call, { cwd: st.cwd, toolCallId: id });
  st.tools.set(id, d);
  st.updates.push(toolCallUpdate(d));
}

function emitToolResult(st: ReplayState, id: string, text: string, failed: boolean): void {
  if (!id) return;
  const content = text ? [{ type: 'content', content: { type: 'text', text: capText(text) } }] : undefined;
  const d = st.tools.get(id);
  if (!d) {
    st.updates.push({
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: 'Tool',
      kind: 'other',
      status: failed ? 'failed' : 'completed',
      ...(content ? { content } : {}),
    });
    return;
  }
  st.updates.push({
    sessionUpdate: 'tool_call_update',
    toolCallId: id,
    kind: d.updateKind,
    status: failed ? 'failed' : 'completed',
    title: d.title,
    ...(content ? { content } : {}),
  });
}

/** Replay updates from journal records (see module doc). */
export function replayFromJournal(records: readonly Record<string, unknown>[], cwd: string): Record<string, unknown>[] {
  const st: ReplayState = { cwd, tools: new Map(), updates: [] };
  let start = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]!.kind === 'Compaction') {
      start = i;
      break;
    }
  }
  for (const rec of records.slice(start)) {
    const data = isObj(rec.data) ? rec.data : undefined;
    const content = data && Array.isArray(data.content) ? data.content.filter(isObj) : [];
    const messageId = data ? str(data.message_id) : undefined;
    switch (rec.kind) {
      case 'Prompt':
        for (const c of content) {
          if (c.kind === 'text' && typeof c.data === 'string' && c.data !== '') {
            st.updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: c.data }, ...(messageId ? { messageId } : {}) });
          } else if (c.kind === 'image') {
            const img = journalImage(c.data);
            if (img) st.updates.push({ sessionUpdate: 'user_message_chunk', content: img, ...(messageId ? { messageId } : {}) });
          }
        }
        break;
      case 'AssistantMessage':
        for (const c of content) {
          if (c.kind === 'text' && typeof c.data === 'string' && c.data !== '') {
            st.updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: c.data }, ...(messageId ? { messageId } : {}) });
          } else if ((c.kind === 'thinking' || c.kind === 'reasoning') && typeof c.data === 'string' && c.data !== '') {
            st.updates.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: c.data } });
          } else if ((c.kind === 'toolUse' || c.kind === 'tool_use') && isObj(c.data)) {
            const id = str(c.data.toolUseId) ?? str(c.data.id) ?? '';
            const name = str(c.data.name) ?? 'tool';
            const input = isObj(c.data.input) ? c.data.input : isObj(c.data.args) ? c.data.args : {};
            emitToolUse(st, id, name, input);
          }
        }
        if (content.length === 0 && typeof data?.text === 'string' && data.text !== '') {
          st.updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: data.text } });
        }
        break;
      case 'ToolResults':
        for (const c of content) {
          if (c.kind !== 'toolResult' || !isObj(c.data)) continue;
          const id = str(c.data.toolUseId) ?? '';
          const parts = Array.isArray(c.data.content) ? c.data.content.filter(isObj) : [];
          const text = parts
            .map((p) => (p.kind === 'text' ? String(p.data ?? '') : p.kind === 'json' ? jsonText(p.data) : ''))
            .filter((t) => t !== '')
            .join('\n');
          emitToolResult(st, id, text, c.data.status === 'error' || c.data.status === 'failed');
        }
        break;
      case 'Compaction': {
        const snap = data && Array.isArray(data.messages_snapshot) ? data.messages_snapshot.filter(isObj) : [];
        const summary = snap
          .map((m) => (Array.isArray(m.content) ? m.content.filter(isObj).map((b) => (b.kind === 'text' && typeof b.data === 'string' ? b.data : '')).filter((t) => t !== '').join('\n') : ''))
          .filter((t) => t !== '')
          .join('\n\n');
        if (summary) st.updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Conversation summary:\n${summary}` } });
        break;
      }
      default:
        break;
    }
  }
  return st.updates.map(withReplayMeta);
}

const LOCAL_ECHO_RE = /^\s*<(local-command-stdout|local-command-stderr|command-name|command-message|command-args)>/;
const INTERRUPT_RE = /^\s*\[Request interrupted by user/;

/** Replay updates from Claude transcript lines (fallback; see module doc). */
export function replayFromTranscript(lines: readonly unknown[], cwd: string): Record<string, unknown>[] {
  const st: ReplayState = { cwd, tools: new Map(), updates: [] };
  const userText = (t: string): void => {
    if (t === '' || LOCAL_ECHO_RE.test(t) || INTERRUPT_RE.test(t)) return;
    st.updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: t } });
  };
  for (const line of lines) {
    if (!isObj(line)) continue;
    if (line.isSidechain === true || line.isMeta === true || line.isSynthetic === true || line.isCompactSummary === true) continue;
    const msg = isObj(line.message) ? line.message : undefined;
    if (!msg) continue;
    if (line.type === 'user') {
      if (typeof msg.content === 'string') {
        userText(msg.content);
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content.filter(isObj)) {
        if (b.type === 'text' && typeof b.text === 'string') userText(b.text);
        else if (b.type === 'image' && isObj(b.source) && b.source.type === 'base64' && typeof b.source.data === 'string') {
          st.updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: str(b.source.media_type) ?? 'image/png', data: b.source.data } });
        } else if (b.type === 'tool_result') {
          const id = str(b.tool_use_id) ?? '';
          let text = '';
          if (typeof b.content === 'string') text = b.content;
          else if (Array.isArray(b.content)) {
            text = b.content
              .filter(isObj)
              .map((x) => (x.type === 'text' && typeof x.text === 'string' ? x.text : ''))
              .filter((x) => x !== '')
              .join('\n');
          }
          emitToolResult(st, id, stripToolUseError(text), b.is_error === true);
        }
      }
    } else if (line.type === 'assistant') {
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content.filter(isObj)) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') {
          if (msg.model === '<synthetic>') continue;
          st.updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: b.text } });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking !== '') {
          st.updates.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: b.thinking } });
        } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          emitToolUse(st, b.id, b.name, isObj(b.input) ? b.input : {});
        }
      }
    }
  }
  return st.updates.map(withReplayMeta);
}

/**
 * Replay updates for a session: journal first, Claude transcript as fallback. `[]` when there
 * is no history at all.
 */
export function buildReplay(opts: {
  sessionsDir: string;
  sessionId: string;
  claudeSessionId?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): { updates: Record<string, unknown>[]; source: 'journal' | 'transcript' | 'none' } {
  const records = readJournalRecords(journalPath(opts.sessionsDir, opts.sessionId));
  if (records.some((r) => r.kind === 'Prompt' || r.kind === 'AssistantMessage' || r.kind === 'ToolResults')) {
    return { updates: replayFromJournal(records, opts.cwd), source: 'journal' };
  }
  if (opts.claudeSessionId) {
    const file = findTranscript(opts.claudeSessionId, { cwd: opts.cwd, env: opts.env });
    if (file) {
      try {
        const updates = replayFromTranscript(readTranscript(file), opts.cwd);
        return { updates, source: 'transcript' };
      } catch {
        // unreadable transcript: no replay
      }
    }
  }
  return { updates: [], source: 'none' };
}
