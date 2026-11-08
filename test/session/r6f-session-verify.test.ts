/**
 * r6 verifier (session group): the fixes for r6 #0, #1, #4 and #5 reached from other entry points
 * than the ones the findings named.
 * - #0: a `/rewind` inside a tangent replaces the tangent's record (a rewind record, not in the
 *   stack); a trust change after it is still saved at once on the main record under it. An
 *   `/agent swap` in a nested tangent names the agent on every record under it, the returns keep
 *   it, and swapping back in main restores the trust parked for the previous agent.
 * - #1 + #5 together: turn 2 compacted automatically inside it (journaled before its answer), a
 *   `/compact` after it, a third turn, then `/rewind 2` inside a tangent: the cut journal keeps the
 *   compaction inside turn 2 and drops the one that followed it; the tail carries turn 2's answer,
 *   and with Claude's transcript lost the restored history holds that answer and no turn rewound
 *   away.
 * - #4: an interrupted `/compact` inside a tangent (real 2.1.319 frames, from the fake) is
 *   cancelled, journals nothing and adds no turn; the next `/compact` compacts and the next prompt
 *   answers (no compaction state left open).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { readJournal } from '../../src/session/kiroFiles.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionEvent, SessionRecord, TurnResult } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, semantic, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

/** A turn Claude compacts automatically at its start (status, boundary, summary), then answers. */
const autoCompactTurn = (match: string, answer: string): unknown => ({
  repeat: true,
  match,
  steps: [
    { frame: { type: 'system', subtype: 'status', status: 'compacting' } },
    { frame: { type: 'system', subtype: 'status', status: null, compact_result: 'success' } },
    { frame: { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 50000, post_tokens: 1000 } } },
    {
      frame: {
        type: 'user',
        message: { role: 'user', content: 'This session is being continued from a previous conversation. Summary: AUTO-SUMMARY' },
        isSynthetic: true,
        parent_tool_use_id: null,
        uuid: randomUUID(),
      },
    },
    { text: answer },
  ],
});

const SCRIPT = {
  turns: [autoCompactTurn('^bravo', 'BRAVO-ANSWER')],
  default: { steps: [{ text: 'ANSWER[{{userText}}]' }] },
};

function sandbox(env: Record<string, string> = {}): Sandbox {
  const sb = mkSandbox({ script: SCRIPT as never, env: { FAKE_CLAUDE_PERSIST: '1', ...env } });
  sb.agent('strict', { description: 'strict', tools: ['*'], allowedTools: [] });
  sb.refresh();
  return sb;
}

const open = (sb: Sandbox, ui: RecordingUI = recordingUI(), over: Partial<KiroSessionInternalOptions> = {}): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, ...over });
const say = (s: KiroSessionImpl, text: string): Promise<{ events: SessionEvent[]; result: TurnResult }> => drain(s.prompt({ text }));
const read = (sb: Sandbox, id: string): SessionRecord => {
  const r = new SessionStore(sb.sessionsDir).read(id);
  assert.ok(r, `record ${id} exists`);
  return r;
};
const kinds = (sb: Sandbox, id: string): string => readJournal(sb.sessionsDir, id).map((r) => r.kind).join(',');

describe('r6 verify #0: trust and agent saved on the records under a tangent, other entry points', () => {
  it('a /rewind inside the tangent, then /tools untrust: main\'s record on disk has the revocation at once', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      const mainId = s.id;
      await say(s, 'hello');
      s.trustTools(['execute_bash']);
      await s.enterTangent('side');
      const tangentId = s.id;
      await say(s, 'one');
      await say(s, 'two');
      await s.rewind(2);
      assert.notEqual(s.id, tangentId, 'precondition: the rewind replaced the tangent record');
      s.untrustTools(['execute_bash']);
      assert.deepEqual(read(sb, mainId).trust.allowedTools, [], "main's record still trusts the tool revoked after a rewind inside the tangent");
      assert.deepEqual(read(sb, s.id).trust.allowedTools, [], 'the rewind record too');
    } finally {
      await closeAll(s);
    }
  });

  it('/agent swap in a nested tangent: every record under it names the agent; back in main a swap back restores the parked trust', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      const mainId = s.id;
      await say(s, 'hello');
      s.trustTools(['execute_bash']);
      await s.enterTangent('outer');
      const outerId = s.id;
      await say(s, 'outer line');
      await s.enterTangent('inner');
      await s.swapAgent('strict');
      for (const [id, label] of [[mainId, 'main'], [outerId, 'outer']] as const) {
        const r = read(sb, id);
        assert.equal(r.agent, 'strict', `${label} names the agent at once`);
        assert.deepEqual(r.trust.allowedTools, [], `${label}: strict's per-tool trust`);
        assert.deepEqual(r.trust.byAgent?.['kiro_default']?.allowedTools, ['execute_bash'], `${label}: kiro_default's trust parked`);
      }
      await s.exitTangent('discard');
      await s.exitTangent('discard');
      assert.equal(s.id, mainId);
      assert.equal(s.agent.name, 'strict', 'the returns keep the agent');
      await s.swapAgent('kiro_default');
      assert.deepEqual(read(sb, mainId).trust.allowedTools, ['execute_bash'], "kiro_default's parked trust is back");
    } finally {
      await closeAll(s);
    }
  });
});

describe('r6 verify #1 + #5: an automatic compaction inside turn N and a /compact after it', () => {
  for (const lost of [false, true]) {
    it(`/rewind 2 inside a tangent keeps the compaction inside turn 2, drops the one after it, and the tail carries turn 2's answer${lost ? " (Claude's transcript lost)" : ''}`, async () => {
      const sb = sandbox();
      const s = await open(sb);
      try {
        await say(s, 'alpha');
        await s.enterTangent('side');
        const r = await say(s, 'bravo');
        assert.equal(r.result.text, 'BRAVO-ANSWER', 'precondition: the auto-compacted turn answered');
        assert.equal((await drain(s.compact())).result.isError, false, 'precondition: compacted');
        await say(s, 'charlie');
        assert.equal(kinds(sb, s.id), 'Prompt,AssistantMessage,Prompt,Compaction,AssistantMessage,Compaction,Prompt,AssistantMessage', 'precondition: the journal');
        if (lost) fs.rmSync(path.join(sb.env.CLAUDE_CONFIG_DIR!, 'projects'), { recursive: true, force: true });
        await s.rewind(2);
        assert.equal(kinds(sb, s.id), 'Prompt,AssistantMessage,Prompt,Compaction,AssistantMessage', 'the cut journal');
        if (lost) {
          const pending = s.record.pendingHistory ?? '';
          assert.match(pending, /Assistant: BRAVO-ANSWER/, pending);
          assert.doesNotMatch(pending, /charlie/, 'a turn rewound away came back');
        }
        await s.exitTangent('tail');
        const carry = s.record.pendingContext?.[0] ?? '';
        assert.match(carry, /User: bravo\nAssistant: BRAVO-ANSWER\n/, carry);
      } finally {
        await closeAll(s);
      }
    });
  }
});

describe('r6 verify polish: the other internal codes of a failed compaction read as sentences', () => {
  // claude 2.1.319 (binary strings): an automatic compaction reports its failure reason as the
  // internal code (`too_few_groups`, `exhausted`, `media_unstrippable`); a typed /compact throws
  // Claude's text for it instead ("Not enough messages to compact.", "Compaction failed ·
  // conversation could not be reduced below the context limit", "Compaction failed · attached
  // media exceeds size limits"), whose own "Compaction failed ·" the chat must not repeat
  const CASES: [string, string][] = [
    ['exhausted', 'The conversation could not be reduced below the context limit.'],
    ['media_unstrippable', 'Attached media exceeds size limits.'],
    ['Compaction failed · conversation could not be reduced below the context limit', 'The conversation could not be reduced below the context limit.'],
    ['Compaction failed · attached media exceeds size limits', 'Attached media exceeds size limits.'],
    ['Compaction failed · something new', 'something new'],
    // a text that names an Object.prototype member is just a text
    ['constructor', 'constructor'],
  ];
  for (const [error, reason] of CASES) {
    it(`compact_error ${JSON.stringify(error)} → ${JSON.stringify(reason)}`, async () => {
      const sb = mkSandbox({ script: { turns: [{ repeat: true, match: '^go', steps: [{ autoCompact: 'failed', error }, { text: 'ANSWER after it' }] }], default: { steps: [{ text: 'ok' }] } } as never });
      const s = await open(sb);
      try {
        const { events, result } = await say(s, 'go');
        assert.equal(result.stopReason, 'end_turn');
        assert.deepEqual(semantic(events).filter((e) => e.type === 'compaction_failed'), [{ type: 'compaction_failed', reason }]);
      } finally {
        await closeAll(s);
      }
    });
  }
});

describe('r6 verify #4: an interrupted /compact leaves nothing open', () => {
  it('inside a tangent: cancelled, nothing journaled, no turn; the next /compact compacts and the next prompt answers', async () => {
    const sb = sandbox({ FAKE_CLAUDE_COMPACT_MS: '3000' });
    const s = await open(sb);
    try {
      await say(s, 'alpha');
      await say(s, 'beta');
      await s.enterTangent('side');
      await say(s, 'gamma');
      const turns = s.record.turns.length;
      const before = kinds(sb, s.id);
      const gen = s.compact();
      const events: SessionEvent[] = [];
      let result: TurnResult;
      for (;;) {
        const n = await gen.next();
        if (n.done) {
          result = n.value;
          break;
        }
        events.push(n.value);
        if (n.value.type === 'compaction' && n.value.state === 'started') setTimeout(() => void s.interrupt(), 100);
      }
      const info = JSON.stringify({ stopReason: result.stopReason, isError: result.isError, error: result.error });
      assert.equal(result.stopReason, 'cancelled', info);
      assert.equal(result.isError, false, info);
      assert.deepEqual(semantic(events).filter((e) => e.type === 'compaction_failed'), [{ type: 'compaction_failed', reason: 'Compaction cancelled', cancelled: true }]);
      assert.equal(kinds(sb, s.id), before, 'the interrupted /compact journaled something');
      assert.equal(s.record.turns.length, turns, 'the interrupted /compact added a turn');
      // a later compaction runs to its end (the fake still takes FAKE_CLAUDE_COMPACT_MS)
      const again = await drain(s.compact());
      assert.equal(again.result.isError, false, JSON.stringify(again.result));
      assert.equal(again.result.stopReason, 'local_command');
      assert.ok(again.events.some((e) => e.type === 'compaction' && e.state === 'finished'), 'the next compaction finished');
      assert.ok(!semantic(again.events).some((e) => e.type === 'compaction_failed'), JSON.stringify(semantic(again.events)));
      assert.equal((await say(s, 'delta')).result.text, 'ANSWER[delta]');
    } finally {
      await closeAll(s);
    }
  });
});
