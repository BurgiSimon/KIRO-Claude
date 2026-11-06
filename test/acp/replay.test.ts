/** `session/load` history replay from the journal and the Claude transcript (05 §4.4, §7.12). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildReplay, journalPath, readJournalRecords, replayFromJournal, replayFromTranscript } from '../../src/acp/replay.js';
import { transcriptPath } from '../../src/claude/transcript.js';
import { tmpEnv } from './helpers.js';

const rec = (kind: string, content: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, kind, timestamp: '2026-11-06T12:00:00Z', data: { message_id: `m-${kind}`, content, ...extra } });

test('journal records ⇒ user/agent chunks, tool frames, replay meta (08a §4.2 shapes)', () => {
  const records = [
    rec('Prompt', [{ kind: 'text', data: 'run echo hi' }, { kind: 'image', data: { format: 'png', source: { kind: 'bytes', data: [137, 80, 78, 71] } } }]),
    rec('AssistantMessage', [
      { kind: 'text', data: 'Running it.' },
      { kind: 'toolUse', data: { id: 'toolu_a', name: 'Bash', args: { command: 'echo hi' } } },
    ]),
    rec('ToolResults', [
      { kind: 'toolResult', data: { toolUseId: 'toolu_a', content: [{ kind: 'json', data: { stdout: 'hi\n', stderr: '' } }], status: 'success' } },
      { kind: 'toolResult', data: { toolUseId: 'toolu_unknown', content: [{ kind: 'text', data: 'boom' }], status: 'error' } },
    ]),
    rec('AssistantMessage', [{ kind: 'text', data: 'It printed hi.' }]),
    { kind: 'Nonsense' },
  ];
  const u = replayFromJournal(records, '/work');
  assert.deepEqual(
    u.map((x) => x.sessionUpdate),
    ['user_message_chunk', 'user_message_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'tool_call', 'agent_message_chunk'],
  );
  assert.deepEqual(u[0], { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'run echo hi' }, messageId: 'm-Prompt', _meta: { kiro: { replay: true } } });
  assert.deepEqual((u[1] as any).content, { type: 'image', mimeType: 'image/png', data: Buffer.from([137, 80, 78, 71]).toString('base64') });
  assert.equal((u[3] as any).title, 'Running: echo hi');
  assert.deepEqual((u[3] as any)._meta.kiro, { toolName: 'shell', replay: true });
  assert.equal((u[4] as any).status, 'completed');
  assert.equal((u[4] as any).content[0].content.text, 'hi\n');
  assert.equal((u[5] as any).status, 'failed');
  assert.equal((u[5] as any).toolCallId, 'toolu_unknown');
  assert.ok(u.every((x) => (x as any)._meta.kiro.replay === true));
});

test('journal replay starts after the last Compaction (/clear ⇒ empty, /compact ⇒ summary chunk)', () => {
  const cleared = replayFromJournal([rec('Prompt', [{ kind: 'text', data: 'old' }]), { version: 1, kind: 'Compaction', data: { messages_snapshot: [] } }, rec('Prompt', [{ kind: 'text', data: 'new' }])], '/w');
  assert.deepEqual(cleared.map((u) => (u as any).content.text), ['new']);
  const compacted = replayFromJournal(
    [
      rec('Prompt', [{ kind: 'text', data: 'old' }]),
      { version: 1, kind: 'Compaction', data: { messages_snapshot: [{ content: [{ kind: 'text', data: 'the summary' }] }] } },
      rec('Prompt', [{ kind: 'text', data: 'after' }]),
      rec('AssistantMessage', [{ kind: 'toolUse', data: { toolUseId: 'toolu_s', name: 'Read', input: { file_path: '/w/a' } } }]),
    ],
    '/w',
  );
  assert.deepEqual(
    compacted.map((u) => [u.sessionUpdate, (u as any).content?.text ?? (u as any).title]),
    [
      ['agent_message_chunk', 'Conversation summary:\nthe summary'],
      ['user_message_chunk', 'after'],
      ['tool_call', 'Reading a:1'],
    ],
  );
});

test('Claude transcript fallback skips sidechain/meta/synthetic, local-command echoes and interrupts', () => {
  const lines = [
    { type: 'user', message: { role: 'user', content: 'remember CODE-7' } },
    { type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'OK' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: '/work/a.txt' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', content: [{ type: 'text', text: 'A' }] }] } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'inner' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
    { type: 'user', isSynthetic: true, message: { role: 'user', content: 'summary' } },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
    { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
    { type: 'system', subtype: 'compact_boundary' },
    'junk',
  ];
  const u = replayFromTranscript(lines, '/work');
  assert.deepEqual(
    u.map((x) => [x.sessionUpdate, (x as any).content?.text ?? (x as any).title ?? (x as any).content?.[0]?.content?.text]),
    [
      ['user_message_chunk', 'remember CODE-7'],
      ['agent_thought_chunk', 'hmm'],
      ['agent_message_chunk', 'OK'],
      ['tool_call', 'Reading a.txt:1'],
      ['tool_call_update', 'Reading a.txt:1'],
    ],
  );
  assert.equal((u[4] as any).content[0].content.text, 'A');
});

test('buildReplay prefers the journal, falls back to the transcript, else none', () => {
  const t = tmpEnv();
  const dir = path.join(t.kiroHome, 'sessions', 'cli');
  fs.mkdirSync(dir, { recursive: true });
  const sid = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual(buildReplay({ sessionsDir: dir, sessionId: sid, claudeSessionId: sid, cwd: t.work, env: t.env }), { updates: [], source: 'none' });
  // transcript only
  const tp = transcriptPath(sid, t.work, t.env);
  fs.mkdirSync(path.dirname(tp), { recursive: true });
  fs.writeFileSync(tp, `${JSON.stringify({ type: 'user', sessionId: sid, message: { role: 'user', content: 'from transcript' } })}\n`);
  const a = buildReplay({ sessionsDir: dir, sessionId: sid, claudeSessionId: sid, cwd: t.work, env: t.env });
  assert.equal(a.source, 'transcript');
  assert.equal((a.updates[0] as any).content.text, 'from transcript');
  // a journal with only a Compaction record does not count
  fs.writeFileSync(journalPath(dir, sid), `${JSON.stringify(rec('Compaction', []))}\n`);
  assert.equal(buildReplay({ sessionsDir: dir, sessionId: sid, claudeSessionId: sid, cwd: t.work, env: t.env }).source, 'transcript');
  fs.appendFileSync(journalPath(dir, sid), `not json\n${JSON.stringify(rec('Prompt', [{ kind: 'text', data: 'from journal' }]))}\n`);
  assert.equal(readJournalRecords(journalPath(dir, sid)).length, 2);
  const b = buildReplay({ sessionsDir: dir, sessionId: sid, claudeSessionId: sid, cwd: t.work, env: t.env });
  assert.equal(b.source, 'journal');
  assert.equal((b.updates[0] as any).content.text, 'from journal');
});
