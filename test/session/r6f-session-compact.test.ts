/**
 * r6 #4 (session group): a `/compact` the user interrupts while Claude compacts is cancelled, not
 * an error. Real claude 2.1.319 (captured with haiku) answers that interrupt with
 * `system/status` `{status:null, compact_result:'failed', compact_error:'API Error: Request was
 * aborted.'}`, `system/init`, a synthetic assistant frame `Compaction canceled.` with
 * `local_command_source`, then a result `subtype:'success'`, `is_error:false`,
 * `local_command:'compact'`, `num_turns:0` (the fake's interrupted /compact sends these frames).
 * KiroSession.compact() returns `stopReason:'cancelled'` with no error, and the compaction's end is
 * `compaction_failed` `{reason:'Compaction cancelled', cancelled:true}`.
 *
 * Polish: an automatic compaction Claude reports failed with its internal code `too_few_groups`
 * (its TUI: `Could not compact · try /compact`) is shown with a readable reason.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import type { SessionEvent, TurnResult } from '../../src/types.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, semantic, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = {
  turns: [{ repeat: true, match: '^fewgroups', steps: [{ autoCompact: 'failed', error: 'too_few_groups' }, { text: 'ANSWER after it' }] }],
  default: { steps: [{ text: 'ok {{historyCount}}' }] },
};

const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, ...over });

/** compact(), interrupted `delayMs` after its compaction started. */
async function interruptedCompact(s: KiroSessionImpl, delayMs = 200): Promise<{ events: SessionEvent[]; result: TurnResult }> {
  const gen = s.compact();
  const events: SessionEvent[] = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { events, result: n.value };
    events.push(n.value);
    if (n.value.type === 'compaction' && n.value.state === 'started') setTimeout(() => void s.interrupt(), delayMs);
  }
}

describe('r6 #4: an interrupted /compact (real 2.1.319 frames) is cancelled', () => {
  it('compact() interrupted while Claude compacts: stopReason cancelled, no error, compaction_failed cancelled', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_COMPACT_MS: '3000', FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'first' }));
      await drain(s.prompt({ text: 'second' }));
      const { events, result } = await interruptedCompact(s);
      const raw = events.flatMap((e) => (e.type === 'raw' ? [e.frame as Record<string, unknown>] : []));
      assert.ok(
        raw.some((f) => f.type === 'system' && f.compact_error === 'API Error: Request was aborted.'),
        'precondition: the fake sent the real frames',
      );
      assert.ok(raw.some((f) => f.type === 'result' && f.local_command === 'compact' && f.is_error === false), 'precondition: a success result with local_command');
      const info = JSON.stringify({ stopReason: result.stopReason, isError: result.isError, error: result.error });
      assert.equal(result.stopReason, 'cancelled', info);
      assert.equal(result.isError, false, info);
      assert.equal(result.error, undefined, info);
      assert.equal(result.text, '', "Claude's 'Compaction canceled.' is no answer");
      const ends = semantic(events).filter((e) => e.type === 'compaction_failed');
      assert.deepEqual(ends, [{ type: 'compaction_failed', reason: 'Compaction cancelled', cancelled: true }]);
      assert.ok(!semantic(events).some((e) => e.type === 'text_delta'), JSON.stringify(semantic(events)));
      assert.equal(s.record.turns.at(-1)?.compactUuid, undefined, 'nothing was compacted');
      // nothing compacted: the next turn still sees both earlier lines
      const next = await drain(s.prompt({ text: 'after' }));
      assert.match(next.result.text, /^ok 3\b/, next.result.text);
    } finally {
      await closeAll(s);
    }
  });

  it('control: a /compact that is not interrupted still compacts (success, no compaction_failed)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'first' }));
      const { events, result } = await drain(s.compact());
      assert.equal(result.stopReason, 'local_command');
      assert.equal(result.isError, false);
      assert.ok(!semantic(events).some((e) => e.type === 'compaction_failed'));
    } finally {
      await closeAll(s);
    }
  });

  it("control: a refused /compact keeps Claude's reason (not cancelled)", async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      await s.setEffort('high'); // only local-command entries: refused with a failed status
      const { events, result } = await drain(s.compact());
      assert.equal(result.isError, true);
      assert.equal(result.error, 'Not enough messages to compact.');
      assert.deepEqual(semantic(events).filter((e) => e.type === 'compaction_failed'), [{ type: 'compaction_failed', reason: 'Not enough messages to compact.' }]);
    } finally {
      await closeAll(s);
    }
  });
});

describe('r6 polish: compact_error too_few_groups', () => {
  it('an automatic compaction that fails with too_few_groups is reported with a readable reason', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb);
    try {
      const { events, result } = await drain(s.prompt({ text: 'fewgroups please' }));
      assert.equal(result.stopReason, 'end_turn');
      assert.deepEqual(semantic(events).filter((e) => e.type === 'compaction_failed'), [{ type: 'compaction_failed', reason: 'Not enough messages to compact.' }]);
    } finally {
      await closeAll(s);
    }
  });
});
