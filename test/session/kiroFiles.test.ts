import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  JOURNAL_MIN_BYTES,
  appendJournal,
  assistantRecord,
  compactionRecord,
  copyJournal,
  envelopePath,
  imageBlock,
  journalHistoryText,
  journalPath,
  journalPrefix,
  journalSize,
  kiroCliEnvelope,
  parseJournal,
  promptRecord,
  readJournal,
  readJournalText,
  replayItems,
  toolResultsRecord,
  writeJournalRecords,
} from '../../src/session/kiroFiles.js';
import { SessionStore } from '../../src/session/store.js';

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-kirofiles-')));
}

const TS = '2026-11-06T10:00:00.000Z';

describe('kiroFiles: record shapes (08a §4.2)', () => {
  it('Prompt record mirrors kiro-cli: version, kind, timestamp, data.message_id, content[] text block', () => {
    const r = promptRecord('hello', { messageId: 'm1', timestamp: TS });
    assert.deepEqual(r, { version: 1, kind: 'Prompt', timestamp: TS, data: { message_id: 'm1', content: [{ kind: 'text', data: 'hello' }] } });
  });

  it('image blocks use the verified {kind:image, data:{format, source:{kind:bytes, data:[ints]}}} shape', () => {
    const b = imageBlock('image/png', Buffer.from([137, 80, 78, 71]).toString('base64'));
    assert.deepEqual(b, { kind: 'image', data: { format: 'png', source: { kind: 'bytes', data: [137, 80, 78, 71] } } });
    assert.equal((imageBlock('image/jpeg', '') as { data: { format: string } }).data.format, 'jpeg');
    assert.equal((imageBlock('image/webp', '') as { data: { format: string } }).data.format, 'webp');
    const p = promptRecord('see', { images: [{ mediaType: 'image/gif', dataBase64: Buffer.from([1, 2]).toString('base64') }], timestamp: TS });
    assert.equal(p.data.content!.length, 2);
    assert.deepEqual(p.data.content![1], { kind: 'image', data: { format: 'gif', source: { kind: 'bytes', data: [1, 2] } } });
  });

  it('AssistantMessage, ToolResults and Compaction records', () => {
    const a = assistantRecord([{ kind: 'text', data: 'hi' }, { kind: 'toolUse', data: { toolUseId: 't1', name: 'Bash', input: { command: 'ls' } } }], { messageId: 'msg', timestamp: TS });
    assert.equal(a.kind, 'AssistantMessage');
    assert.equal(a.data.message_id, 'msg');
    assert.equal(a.data.content!.length, 2);
    const tr = toolResultsRecord([{ toolUseId: 't1', text: 'out', isError: false }, { toolUseId: 't2', text: 'bad', isError: true }], { timestamp: TS });
    assert.deepEqual(tr.data.content, [
      { kind: 'toolResult', data: { toolUseId: 't1', content: [{ kind: 'text', data: 'out' }], status: 'success' } },
      { kind: 'toolResult', data: { toolUseId: 't2', content: [{ kind: 'text', data: 'bad' }], status: 'error' } },
    ]);
    assert.equal(typeof tr.data.message_id, 'string');
    assert.deepEqual(compactionRecord('sum', { timestamp: TS }), {
      version: 1,
      kind: 'Compaction',
      timestamp: TS,
      data: { messages_snapshot: [{ content: [{ kind: 'text', data: 'sum' }] }] },
    });
    assert.deepEqual(compactionRecord('', { timestamp: TS }).data, { messages_snapshot: [] });
  });

  it('timestamps default to now (ISO)', () => {
    const r = promptRecord('x');
    assert.ok(!Number.isNaN(Date.parse(r.timestamp)));
    assert.match(r.data.message_id!, /^[0-9a-f-]{36}$/);
  });
});

describe('kiroFiles: journal I/O', () => {
  it('appendJournal creates <sid>.jsonl (0600, dir 0700), one JSON object per line, ≥10 bytes', () => {
    const dir = path.join(tmp(), 'sessions', 'cli');
    const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const n = appendJournal(dir, sid, [promptRecord('a', { timestamp: TS }), assistantRecord([{ kind: 'text', data: 'b' }], { timestamp: TS })]);
    assert.ok(n >= JOURNAL_MIN_BYTES);
    const p = journalPath(dir, sid);
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[2], '');
    assert.equal(JSON.parse(lines[0]!).kind, 'Prompt');
    appendJournal(dir, sid, [toolResultsRecord([{ toolUseId: 't', text: 'x', isError: false }])]);
    assert.deepEqual(readJournal(dir, sid).map((r) => r.kind), ['Prompt', 'AssistantMessage', 'ToolResults']);
    assert.equal(journalSize(dir, sid), fs.statSync(p).size);
    assert.equal(appendJournal(dir, sid, []), 0);
  });

  it('readJournal: missing ⇒ []; malformed lines skipped', () => {
    const dir = tmp();
    assert.deepEqual(readJournal(dir, 'nope'), []);
    assert.equal(readJournalText(dir, 'nope'), '');
    fs.writeFileSync(path.join(dir, 'x.jsonl'), '{"version":1,"kind":"Prompt","timestamp":"t","data":{"content":[]}}\nnot json\n[1]\n{"kind":"X"}\n');
    const r = readJournal(dir, 'x');
    assert.equal(r.length, 1);
    assert.equal(r[0]!.kind, 'Prompt');
    assert.equal(parseJournal('').length, 0);
  });

  it('rejects unsafe ids', () => {
    assert.throws(() => journalPath('/d', '../x'), /Invalid session id/);
    assert.throws(() => envelopePath('/d', 'a/b'), /Invalid session id/);
  });

  it('journalPrefix / copyJournal keep the first N prompts with their replies', () => {
    const dir = tmp();
    const recs = [
      promptRecord('p1'),
      assistantRecord([{ kind: 'text', data: 'a1' }]),
      promptRecord('p2'),
      assistantRecord([{ kind: 'text', data: 'a2' }]),
      toolResultsRecord([{ toolUseId: 't', text: 'r', isError: false }]),
      promptRecord('p3'),
    ];
    assert.deepEqual(journalPrefix(recs, 2).map((r) => r.kind), ['Prompt', 'AssistantMessage', 'Prompt', 'AssistantMessage', 'ToolResults']);
    assert.deepEqual(journalPrefix(recs, 0), []);
    writeJournalRecords(dir, 'src', recs);
    assert.equal(copyJournal(dir, 'src', 'dst', { prompts: 1 }), 2);
    assert.deepEqual(readJournal(dir, 'dst').map((r) => r.kind), ['Prompt', 'AssistantMessage']);
    assert.equal(copyJournal(dir, 'src', 'all'), 6);
    assert.equal(fs.statSync(journalPath(dir, 'all')).mode & 0o777, 0o600);
    assert.equal(copyJournal(dir, 'missing', 'empty'), 0);
    assert.equal(readJournalText(dir, 'empty'), '');
  });
});

describe('kiroFiles: replay', () => {
  const recs = [
    promptRecord('old question', { timestamp: '1' }),
    assistantRecord([{ kind: 'text', data: 'old answer' }], { timestamp: '2' }),
    compactionRecord('the summary', { timestamp: '3' }),
    promptRecord('q', { timestamp: '4', images: [{ mediaType: 'image/png', dataBase64: Buffer.from([1, 2, 3]).toString('base64') }] }),
    assistantRecord([{ kind: 'text', data: 'let me look' }, { kind: 'toolUse', data: { toolUseId: 't1', name: 'Read', input: { file_path: '/a' } } }], { timestamp: '5' }),
    toolResultsRecord([{ toolUseId: 't1', text: 'contents', isError: false }], { timestamp: '6' }),
    assistantRecord([{ kind: 'text', data: 'done' }], { timestamp: '7' }),
  ];

  it('replayItems starts at the last compaction and flattens tool uses / results', () => {
    assert.deepEqual(replayItems(recs), [
      { type: 'compaction', summary: 'the summary', timestamp: '3' },
      { type: 'user', text: 'q', images: [{ format: 'png', bytes: 3 }], timestamp: '4' },
      { type: 'assistant', text: 'let me look', timestamp: '5' },
      { type: 'tool_use', toolUseId: 't1', name: 'Read', input: { file_path: '/a' }, timestamp: '5' },
      { type: 'tool_result', toolUseId: 't1', text: 'contents', isError: false, timestamp: '6' },
      { type: 'assistant', text: 'done', timestamp: '7' },
    ]);
    assert.equal(replayItems(recs, { afterLastCompaction: false })[0]!.type, 'user');
  });

  it('a cleared conversation (empty Compaction) replays as nothing before new prompts', () => {
    const r = [promptRecord('a'), assistantRecord([{ kind: 'text', data: 'b' }]), compactionRecord(''), promptRecord('c')];
    assert.deepEqual(replayItems(r).map((i) => i.type), ['user']);
  });

  it('journalHistoryText renders User/Assistant/Summary and keeps the newest part', () => {
    assert.equal(journalHistoryText(recs), 'Summary: the summary\n\nUser: q\n\nAssistant: let me look\n\nAssistant: done');
    assert.equal(journalHistoryText([]), undefined);
    const long = [promptRecord('x'.repeat(5000)), assistantRecord([{ kind: 'text', data: 'END' }])];
    const t = journalHistoryText(long, 100)!;
    assert.ok(Buffer.byteLength(t) <= 104);
    assert.ok(t.startsWith('…'));
    assert.ok(t.endsWith('Assistant: END'));
  });
});

describe('kiroFiles: <sid>.json envelope (08 KC-FS-02)', () => {
  it('store writes the kiro-cli snake_case envelope; kiroCliEnvelope exposes it', () => {
    const root = tmp();
    const store = new SessionStore(path.join(root, 'sessions', 'cli'));
    fs.mkdirSync(path.join(root, 'proj'));
    const rec = store.create({ origin: 'acp', cwd: path.join(root, 'proj'), agent: 'kirocrew', model: 'auto', effort: 'high', title: 'T' });
    const disk = JSON.parse(fs.readFileSync(envelopePath(store.dir, rec.sessionId), 'utf8')) as Record<string, unknown>;
    assert.equal(disk.session_id, rec.sessionId);
    assert.equal(disk.kind, 'kiro-claude-session');
    assert.deepEqual(disk.session_state, {
      agent_name: 'kirocrew',
      permissions: { filesystem: { allowed_read_paths: [], allowed_write_paths: [] } },
      conversation_metadata: {},
    });
    const env = kiroCliEnvelope(rec);
    assert.equal(env.session_id, rec.sessionId);
    assert.equal(env.cwd, rec.cwd);
    assert.equal(env.title, 'T');
    assert.deepEqual(env.kiro_claude, { claudeSessionId: rec.claudeSessionId, model: 'auto', effort: 'high' });
    assert.equal(fs.statSync(envelopePath(store.dir, rec.sessionId)).mode & 0o777, 0o600);
  });
});
