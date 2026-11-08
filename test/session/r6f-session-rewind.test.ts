/**
 * r6 (session group), `/rewind N` across a compaction:
 * #1 the fallback (Claude Code no longer holds turn N's answer) restores turn N's own history, for
 *    an earlier turn too: the journal cut at turn N drops the compactions that followed it (they
 *    summarize turns the journal holds verbatim before them), as the last-turn cut already did, so
 *    the restored history is not only a later summary written without turn N's answer.
 * #5 turnExchange (what a `/tangent tail` of a tangent rewound to turn N carries) reads past an
 *    automatic compaction inside turn N (journaled before the turn's answer).
 * #6 the documented behaviour (docs/ARCHITECTURE.md, Sessions > Rewind): a rewind to the turn the
 *    compaction followed forks the compacted conversation when Claude Code kept that turn's answer
 *    verbatim (the last answer of a chat with two turns or more); otherwise (one turn before the
 *    compaction) it starts a new conversation with the saved history up to turn N, and says so.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import {
  assistantRecord,
  compactionRecord,
  copyJournalThroughTurn,
  promptRecord,
  readJournal,
  turnExchange,
  writeJournalRecords,
  type JournalRecord,
} from '../../src/session/kiroFiles.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = { default: { steps: [{ text: 'ANSWER[{{userText}}]' }] } };
const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, ...over });
const say = (s: KiroSessionImpl, text: string): Promise<unknown> => drain(s.prompt({ text }));
const compact = async (s: KiroSessionImpl): Promise<void> => {
  assert.equal((await drain(s.compact())).result.isError, false, 'precondition: compacted');
};
const kinds = (sb: Sandbox, id: string): string => readJournal(sb.sessionsDir, id).map((r) => r.kind).join(',');
const warns = (ui: RecordingUI): string[] => ui.notices.filter((n) => n.level === 'warn').map((n) => n.message);

describe('r6 #1: the /rewind N fallback after a compaction restores turn N itself', () => {
  it('two compactions, /rewind 2 (the turn the first one followed): the history holds turn 2 and its answer', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const ui = recordingUI();
    const s = await open(sb, {}, ui);
    try {
      await say(s, 'alpha');
      await say(s, 'beta');
      await compact(s); // keeps beta's answer verbatim
      await say(s, 'gamma');
      await compact(s); // keeps only gamma's answer: beta's uuid is no longer served
      await s.rewind(2);
      assert.ok(warns(ui).some((m) => /compacted after turn 2/.test(m)), `precondition: the fork fell back on the journal: ${JSON.stringify(warns(ui))}`);
      assert.equal(kinds(sb, s.id), 'Prompt,AssistantMessage,Prompt,AssistantMessage', 'the cut journal keeps the compaction that followed turn 2');
      const pending = s.record.pendingHistory ?? '';
      assert.match(pending, /User: beta/, pending);
      assert.match(pending, /ANSWER\[beta\]/, "turn 2's answer is missing from the restored history");
      assert.doesNotMatch(pending, /gamma/, 'a turn rewound away came back');
    } finally {
      await closeAll(s);
    }
  });

  it("Claude's transcript lost: /rewind 2 after alpha, beta, /compact, gamma restores beta's answer", async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s1 = await open(sb);
    let id: string;
    try {
      await say(s1, 'alpha');
      await say(s1, 'beta');
      await compact(s1);
      await say(s1, 'gamma');
      id = s1.id;
    } finally {
      await closeAll(s1);
    }
    fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });
    const s2 = await open(sb, { resume: { sessionId: id } });
    try {
      await s2.rewind(2);
      assert.notEqual(s2.id, id, 'a rewind record');
      const pending = s2.record.pendingHistory ?? '';
      assert.match(pending, /User: beta/, pending);
      assert.match(pending, /ANSWER\[beta\]/, pending);
      assert.doesNotMatch(pending, /gamma/, pending);
      const { result } = await drain(s2.prompt({ text: 'after' }));
      assert.equal(result.isError, false);
    } finally {
      await closeAll(s2);
    }
  });

  it('copyJournalThroughTurn: the compactions after an earlier turn are dropped, those inside a turn kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r6f-journal-'));
    try {
      const recs: JournalRecord[] = [
        promptRecord('one', { messageId: 'u1' }),
        assistantRecord([{ kind: 'text', data: 'A1' }]),
        promptRecord('two', { messageId: 'u2' }),
        compactionRecord('auto summary inside turn two'),
        assistantRecord([{ kind: 'text', data: 'A2' }]),
        compactionRecord('summary after two'),
        compactionRecord('a second /compact'),
        promptRecord('three', { messageId: 'u3' }),
        assistantRecord([{ kind: 'text', data: 'A3' }]),
        compactionRecord('summary after three'),
      ];
      writeJournalRecords(dir, 'src', recs);
      const turns = [{ userUuid: 'u1' }, { userUuid: 'u2' }, { userUuid: 'u3' }];
      const cut = (i: number): string => {
        copyJournalThroughTurn(dir, 'src', `to${i}`, turns, i);
        return readJournal(dir, `to${i}`).map((r) => r.kind).join(',');
      };
      assert.equal(cut(1), 'Prompt,AssistantMessage,Prompt,Compaction,AssistantMessage');
      assert.equal(cut(2), 'Prompt,AssistantMessage,Prompt,Compaction,AssistantMessage,Compaction,Compaction,Prompt,AssistantMessage');
      assert.equal(cut(0), 'Prompt,AssistantMessage');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a fork at an earlier rewind point (create({ fork })) gets the same cut', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let parentTurns: { assistantUuid?: string }[] = [];
    let parentId = '';
    let from = '';
    try {
      await say(s, 'alpha');
      await say(s, 'beta');
      await compact(s);
      await say(s, 'gamma');
      parentTurns = s.record.turns;
      parentId = s.id;
      from = s.forkSource().from;
    } finally {
      await closeAll(s);
    }
    const at = parentTurns[1]!.assistantUuid!;
    const f = await open(sb, { origin: 'spec', fork: { fromClaudeSessionId: from, at, kind: 'main', parentId } });
    try {
      assert.equal(kinds(sb, f.id), 'Prompt,AssistantMessage,Prompt,AssistantMessage');
    } finally {
      await closeAll(f);
    }
  });
});

// ── #5 ──

const autoCompactTurn = (match: string, answer: string): Record<string, unknown> => ({
  repeat: true,
  match,
  steps: [
    { frame: { type: 'system', subtype: 'status', status: 'compacting' } },
    { frame: { type: 'system', subtype: 'status', status: null, compact_result: 'success' } },
    { frame: { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 50000, post_tokens: 1000 } } },
    { frame: { type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: earlier talk' }, isSynthetic: true, parent_tool_use_id: null, uuid: randomUUID() } },
    { text: answer },
  ],
});

describe('r6 #5: /tangent tail after /rewind N carries turn N\'s answer when an auto-compaction ran inside turn N', () => {
  async function tailAfterRewind(script: Record<string, unknown>): Promise<{ answer: string; kinds: string; carry: string[] }> {
    const sb = mkSandbox({ script, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      await say(s, 'alpha');
      await s.enterTangent('side');
      const { result } = await drain(s.prompt({ text: 'bravo' }));
      await say(s, 'charlie');
      const k = kinds(sb, s.id);
      await s.rewind(2);
      await s.exitTangent('tail');
      return { answer: result.text, kinds: k, carry: s.record.pendingContext ?? [] };
    } finally {
      await closeAll(s);
    }
  }

  it('control: no compaction', async () => {
    const out = await tailAfterRewind({ turns: [], default: { steps: [{ text: 'reply to {{userText}}' }] } });
    assert.match(out.carry[0] ?? '', /User: bravo\nAssistant: reply to bravo\n/);
  });

  it('auto-compaction inside turn 2 (journaled before its answer): the tail still carries the answer', async () => {
    const out = await tailAfterRewind({ turns: [autoCompactTurn('^bravo', 'BRAVO-ANSWER')], default: { steps: [{ text: 'reply to {{userText}}' }] } });
    assert.equal(out.answer, 'BRAVO-ANSWER');
    assert.equal(out.kinds, 'Prompt,AssistantMessage,Prompt,Compaction,AssistantMessage,Prompt,AssistantMessage', 'precondition: the journal order');
    assert.match(out.carry[0] ?? '', /User: bravo\nAssistant: BRAVO-ANSWER\n/, JSON.stringify(out.carry));
  });

  it('unit: turnExchange reads past a Compaction inside the turn, and ends at the next turn', () => {
    const p2 = promptRecord('bravo', { messageId: 'u2' });
    const c = compactionRecord('summary');
    const a = assistantRecord([{ kind: 'text', data: 'BRAVO-ANSWER' }]);
    const p3 = promptRecord('charlie', { messageId: 'u3' });
    const a3 = assistantRecord([{ kind: 'text', data: 'CHARLIE-ANSWER' }]);
    assert.deepEqual(turnExchange([p2, c, a, p3, a3], 'u2', new Set(['u2', 'u3'])), { user: 'bravo', assistant: 'BRAVO-ANSWER' });
    // a /compact after the turn adds no answer
    assert.deepEqual(turnExchange([p2, a, compactionRecord('later')], 'u2', new Set(['u2'])), { user: 'bravo', assistant: 'BRAVO-ANSWER' });
  });
});

// ── #6: the documented behaviour ──

describe('r6 #6: /rewind to the turn a /compact followed (docs/ARCHITECTURE.md, Rewind)', () => {
  it('the last answer of a chat with two turns, kept verbatim: forks the compacted conversation, no warning', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const ui = recordingUI();
    const s = await open(sb, {}, ui);
    try {
      await say(s, 'alpha');
      await say(s, 'beta');
      await compact(s);
      const target = s.record.turns[1]!.assistantUuid;
      await s.rewind(2);
      assert.deepEqual(warns(ui), []);
      const last = sb.starts().at(-1)!;
      assert.ok(last.includes('--fork-session'), JSON.stringify(last));
      assert.equal(flagValue(last, '--resume-session-at'), target, "the fork is at the turn's own answer");
      assert.equal(s.record.pendingHistory, undefined, 'no restored history');
    } finally {
      await closeAll(s);
    }
  });

  for (const second of [false, true]) {
    it(`a single turn before the compaction (nothing kept verbatim)${second ? ', a second turn after it' : ''}: a new conversation with turn 1's saved history, and the warning`, async () => {
      const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
      const ui = recordingUI();
      const s = await open(sb, {}, ui);
      try {
        await say(s, 'one');
        await compact(s);
        if (second) await say(s, 'two');
        await s.rewind(1);
        assert.ok(
          warns(ui).some((m) => /The conversation was compacted after turn 1, .*starting a new conversation with the saved history up to turn 1 as context/.test(m)),
          JSON.stringify(warns(ui)),
        );
        const last = sb.starts().at(-1)!;
        assert.ok(!last.includes('--fork-session') && !last.includes('--resume'), `a fresh conversation: ${JSON.stringify(last)}`);
        const pending = s.record.pendingHistory ?? '';
        assert.match(pending, /User: one/, pending);
        assert.match(pending, /ANSWER\[one\]/, pending);
        assert.doesNotMatch(pending, /two/, pending);
      } finally {
        await closeAll(s);
      }
    });
  }
});
