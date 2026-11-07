/**
 * r5 #0 (session group): plan mode is session state, not part of a tangent's checkpoint (Kiro's
 * plan mode is the planner agent, and the agent is session state, Q 06 §6.4). `/plan` on (or off)
 * inside a tangent holds after leaving it — plain `/tangent`, tail, merge — in nested tangents
 * too, and it is saved at once on the records the tangent returns to, so a quit (or a crash)
 * inside the tangent never leaves the main conversation with fewer restrictions than the user set.
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

// ('run it' first: the line after a merge also carries the summary request's text)
const SCRIPT = {
  turns: [
    { repeat: true, match: 'run it', steps: [{ tool: { name: 'Bash', input: { command: 'touch made.txt', description: 'touch' } } }, { text: 'TOOL-SAID {{lastToolResult}} END' }] },
    { repeat: true, match: 'Summarize the findings', steps: [{ text: 'SUMMARY of {{historyUserTexts}}' }] },
  ],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, trustAllTools: true };
}
const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}): Promise<KiroSessionImpl> => KiroSessionImpl.create({ ...baseOptions(sb), ...over });
const read = (sb: Sandbox, id: string): SessionRecord | undefined => new SessionStore(sb.sessionsDir).read(id);

/** The Bash result the model saw for a "run it" line (denied in plan mode). */
async function bashSaid(s: KiroSessionImpl): Promise<string> {
  const { result } = await drain(s.prompt({ text: 'run it' }));
  return /TOOL-SAID ([\s\S]*?) END/.exec(result.text)?.[1] ?? result.text;
}

describe('r5 #0: plan mode turned on inside a tangent holds after leaving it', () => {
  for (const mode of ['discard', 'tail', 'merge'] as const) {
    it(`/tangent ${mode === 'discard' ? '' : mode}: back in main, plan mode is still on (the gate denies Bash) and main's record says so`, async () => {
      const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
      const s = await open(sb);
      try {
        const mainId = s.id;
        await drain(s.prompt({ text: 'main line' }));
        await s.enterTangent('side');
        if (mode !== 'discard') await drain(s.prompt({ text: 'tangent line' }));
        s.planMode = true;
        assert.equal(read(sb, mainId)?.planMode, true, "saved at once on the record the tangent returns to (a quit or crash keeps it)");
        await s.exitTangent(mode);
        assert.equal(s.id, mainId, 'precondition: back in main');
        assert.equal(s.planMode, true, 'plan mode the user turned on was dropped by leaving the tangent');
        assert.equal(read(sb, mainId)?.planMode, true);
        assert.match(await bashSaid(s), /Plan mode is read-only/, 'the gate let Bash run after the user turned plan mode on');
      } finally {
        await closeAll(s);
      }
    });
  }

  it('both directions: plan mode turned off inside the tangent stays off after leaving it (the state the user last set)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'main line' }));
      s.planMode = true;
      await s.enterTangent('side');
      assert.equal(s.planMode, true, 'precondition: the tangent starts in plan mode');
      s.planMode = false;
      assert.equal(read(sb, mainId)?.planMode, false);
      await s.exitTangent('discard');
      assert.equal(s.planMode, false);
    } finally {
      await closeAll(s);
    }
  });

  it('nested tangents: /plan in T2 holds in T1 and in main', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'main line' }));
      await s.enterTangent('t1');
      const t1Id = s.id;
      await drain(s.prompt({ text: 't1 line' }));
      await s.enterTangent('t2');
      s.planMode = true;
      assert.equal(read(sb, mainId)?.planMode, true);
      assert.equal(read(sb, t1Id)?.planMode, true);
      await s.exitTangent('discard');
      assert.equal(s.id, t1Id);
      assert.equal(s.planMode, true, 'T1 lost plan mode');
      await s.exitTangent('discard');
      assert.equal(s.id, mainId);
      assert.equal(s.planMode, true, 'main lost plan mode');
      assert.match(await bashSaid(s), /Plan mode is read-only/);
    } finally {
      await closeAll(s);
    }
  });

  it('a quit inside the tangent, then `chat --resume`: main is resumed in plan mode', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    const mainId = s.id;
    let r: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'main line' }));
      await s.enterTangent('side');
      s.planMode = true;
      await s.close();
      r = await open(sb, { resume: { latest: true } });
      assert.equal(r.id, mainId, 'precondition: --resume opens main, never a tangent');
      assert.equal(r.planMode, true, 'plan mode the user turned on inside the tangent was lost by the quit');
      assert.match(await bashSaid(r), /Plan mode is read-only/);
    } finally {
      await closeAll(r, s);
    }
  });
});
