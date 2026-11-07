/**
 * Round-5 verifier of the session group's fixes (r5 #0, #2, #4): other entry points.
 *  - Nested tangents (#4's neighbourhood): main -> T1 (a line) -> T2 -> back to T1 -> `/tangent
 *    tail`: the tail is T1's own last exchange. Leaving T2 used to forget it, so the tail carried
 *    nothing although the REPL says "with last conversation entry preserved".
 *  - `/rewind` inside a tangent, then `/tangent tail`: the tail is the turn rewound to, from the
 *    journal; it used to be the last exchange seen, which the rewind had removed from the
 *    conversation, so main got a turn the user had rewound away.
 *  - `/tangent root` out of a nested tangent keeps plan mode set in it (#0; control).
 *  - #2 / r5 S5: a `/rewind` that drops an untouched copy its parent holds names that parent as
 *    the rewind record's parent, never the dropped copy.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = {
  turns: [{ repeat: true, match: 'Summarize the findings', steps: [{ text: 'SUMMARY of {{historyUserTexts}}' }] }],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env };
}
const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui?: RecordingUI): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ...baseOptions(sb, ui), ...over });
const read = (sb: Sandbox, id: string): SessionRecord | undefined => new SessionStore(sb.sessionsDir).read(id);

describe('r5 verifier: tangents, tails and rewinds', () => {
  it('nested: T2 left, then T1 tail carries T1\'s own last exchange', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'main line' }));
      await s.enterTangent('t1');
      await drain(s.prompt({ text: 't1 line T1_LAST' }));
      await s.enterTangent('t2');
      await drain(s.prompt({ text: 't2 line' }));
      await s.exitTangent('discard');
      await s.exitTangent('tail');
      assert.equal(s.id, mainId);
      assert.match(JSON.stringify(read(sb, mainId)?.pendingContext ?? []), /User: t1 line T1_LAST/, 'the tail carried nothing');
    } finally {
      await closeAll(s);
    }
  });

  it('/rewind inside a tangent, then /tangent tail: the tail is the turn rewound to, never one rewound away', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'main line' }));
      await s.enterTangent('t1');
      await drain(s.prompt({ text: 't1 A_KEEP' }));
      await drain(s.prompt({ text: 't1 B_GONE' }));
      await s.rewind(2);
      await s.exitTangent('tail');
      assert.equal(s.id, mainId);
      const carry = JSON.stringify(read(sb, mainId)?.pendingContext ?? []);
      assert.match(carry, /User: t1 A_KEEP\\nAssistant: hist=main line \| t1 A_KEEP\\n/, carry);
      assert.doesNotMatch(carry, /B_GONE/, 'main got the turn the user rewound away');
    } finally {
      await closeAll(s);
    }
  });

  it('/tangent root from T2 keeps plan mode', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'main line' }));
      await s.enterTangent('t1');
      await drain(s.prompt({ text: 't1 line' }));
      await s.enterTangent('t2');
      s.planMode = true;
      await s.exitTangent('discard');
      await s.exitTangent('discard');
      assert.equal(s.id, mainId);
      assert.equal(s.planMode, true);
      assert.equal(read(sb, mainId)?.planMode, true);
    } finally {
      await closeAll(s);
    }
  });

  it('rewind of an untouched copy its parent holds: the rewind record names a record that exists', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const main = await open(sb);
    let cont: KiroSessionImpl | undefined;
    try {
      await drain(main.prompt({ text: 'one' }));
      await drain(main.prompt({ text: 'two' }));
      const mainId = main.id;
      const src = main.forkSource();
      await main.close();
      cont = await open(sb, { fork: { fromClaudeSessionId: src.from, kind: 'main', parentId: mainId } });
      const contId = cont.id;
      await cont.rewind(1);
      assert.equal(read(sb, contId), undefined, 'precondition: the copy was dropped (its parent holds it)');
      const pid = cont.record.parentId;
      assert.ok(pid && read(sb, pid), `the rewind record's parentId ${pid} names a record that is gone`);
    } finally {
      await closeAll(cont, main);
    }
  });
});
