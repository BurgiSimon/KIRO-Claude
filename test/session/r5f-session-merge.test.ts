/**
 * r5 #4 (session group): `/tangent merge` of a tangent whose record holds a nested tangent's carry
 * (a T2 merge or tail queued on T1, `pendingContext`: part of T1's history) sends the summary
 * request WITH that carry, as a composed line would (composeTurn), and settles it the same way:
 * delivered, it leaves T1's record; a line Claude dropped unread gives it back.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import type { ClaudeProcess } from '../../src/claude/process.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = {
  turns: [{ repeat: true, match: 'Summarize the findings', steps: [{ text: 'SUMMARY of {{historyUserTexts}}' }] }],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};

const open = (sb: Sandbox): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env: sb.env } as KiroSessionInternalOptions);
const read = (sb: Sandbox, id: string): SessionRecord | undefined => new SessionStore(sb.sessionsDir).read(id);
const text = (l: Record<string, unknown>): string => {
  const c = (l.message as { content: unknown }).content;
  return typeof c === 'string' ? c : JSON.stringify(c);
};

/** Claude drops the next user line before starting it (`queued` then `cancelled`, S2). */
function dropNextUserLine(proc: ClaudeProcess): void {
  const p = proc as unknown as { writeLine(o: unknown): void; handleLine(l: string): void };
  p.writeLine = function (this: unknown, o: unknown): void {
    const m = o as { type?: string; uuid?: string };
    if (m?.type !== 'user' || typeof m.uuid !== 'string') return Object.getPrototypeOf(p).writeLine.call(p, o);
    delete (p as { writeLine?: unknown }).writeLine; // once
    const u = m.uuid;
    setImmediate(() => {
      for (const state of ['queued', 'cancelled']) p.handleLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: u, state, uuid: randomUUID(), session_id: '' }));
    });
  };
}

/** main → T1 (a line) → T2 (a line with the finding) → T2 left with `nestedExit`: the carry waits on T1. */
async function nested(sb: Sandbox, nestedExit: 'merge' | 'tail'): Promise<{ s: KiroSessionImpl; t1Id: string; mainId: string }> {
  const s = await open(sb);
  const mainId = s.id;
  await drain(s.prompt({ text: 'main line' }));
  await s.enterTangent('t1');
  const t1Id = s.id;
  await drain(s.prompt({ text: 't1 line' }));
  await s.enterTangent('t2');
  await drain(s.prompt({ text: 't2 line ZEBRA_FINDING' }));
  await s.exitTangent(nestedExit);
  assert.equal(s.id, t1Id, 'precondition: back in T1');
  assert.match(JSON.stringify(read(sb, t1Id)?.pendingContext ?? []), /ZEBRA_FINDING/, 'precondition: the nested carry waits on T1');
  return { s, t1Id, mainId };
}

describe('r5 #4: the outer /tangent merge carries the nested tangent\'s carry', () => {
  for (const nestedExit of ['merge', 'tail'] as const) {
    it(`T2 ${nestedExit}, then T1 merged right away: the summary request holds the carry, main gets the findings, T1 keeps no copy`, async () => {
      const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
      let s: KiroSessionImpl | undefined;
      try {
        let t1Id: string;
        let mainId: string;
        ({ s, t1Id, mainId } = await nested(sb, nestedExit));
        await s.exitTangent('merge');
        assert.equal(s.id, mainId);
        const req = sb.userLines().map(text).filter((c) => c.includes('Summarize the findings')).at(-1) ?? '';
        assert.match(req, /ZEBRA_FINDING/, `the T1 summary request lacks the T2 carry: ${req.slice(0, 300)}`);
        assert.equal(read(sb, t1Id)?.pendingContext, undefined, 'the delivered carry stays queued on T1');
        assert.match(JSON.stringify(s.record.pendingContext ?? []), /ZEBRA_FINDING/, "main's carry lacks the nested findings");
        await drain(s.prompt({ text: 'main next' }));
        assert.match(text(sb.userLines().at(-1)!), /ZEBRA_FINDING/);
      } finally {
        await closeAll(s);
      }
    });
  }

  it('a summary request Claude dropped unread gives the carry back to T1 (the merge is cancelled, T1 stays)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    let s: KiroSessionImpl | undefined;
    try {
      let t1Id: string;
      ({ s, t1Id } = await nested(sb, 'merge'));
      dropNextUserLine(s.process!);
      await assert.rejects(s.exitTangent('merge'), /Merge cancelled/);
      assert.equal(s.id, t1Id, 'still in T1');
      assert.match(JSON.stringify(read(sb, t1Id)?.pendingContext ?? []), /ZEBRA_FINDING/, 'the carry the model never read is lost');
      await s.exitTangent('merge');
      const req = sb.userLines().map(text).filter((c) => c.includes('Summarize the findings')).at(-1) ?? '';
      assert.equal(req.split('ZEBRA_FINDING').length - 1 >= 1, true, req.slice(0, 300));
      assert.equal(read(sb, t1Id)?.pendingContext, undefined);
    } finally {
      await closeAll(s);
    }
  });
});
