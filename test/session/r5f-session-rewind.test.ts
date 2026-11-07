/**
 * r5 #2 (session group): `/rewind` out of an untouched `create({ fork })` copy drops that copy only
 * while its parent record still exists and holds every one of its turns. The continuation a /spec
 * flow hands over outlives its parent (SpecSessionDriver.finish → discardSuperseded removes the
 * phase record it was forked from), so it is the only record of the spec turns: it is kept, also
 * after a local `/effort` in it. A copy whose parent holds it all is still dropped (r5 S5).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { journalPath } from '../../src/session/kiroFiles.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = { default: { steps: [{ text: 'hist={{historyUserTexts}}' }] } };

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env };
}
const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}): Promise<KiroSessionImpl> => KiroSessionImpl.create({ ...baseOptions(sb), ...over });
const read = (sb: Sandbox, id: string): SessionRecord | undefined => new SessionStore(sb.sessionsDir).read(id);

/**
 * main (2 turns) → a spec phase session (origin spec, one turn of its own) → the continuation
 * forked from it (origin repl, untouched), then the phase record removed as discardSuperseded
 * does: the continuation is the only record of the 3-turn conversation.
 */
async function handedOver(sb: Sandbox): Promise<{ main: KiroSessionImpl; cont: KiroSessionImpl; phaseId: string }> {
  const main = await open(sb);
  await drain(main.prompt({ text: 'alpha ALPHA_1' }));
  await drain(main.prompt({ text: 'beta BETA_2' }));
  const phase = await open(sb, { origin: 'spec', fork: { fromClaudeSessionId: main.forkSource().from, kind: 'main', parentId: main.id } });
  await drain(phase.prompt({ text: 'spec SPEC_3' }));
  const phaseId = phase.id;
  const cont = await open(sb, { fork: { fromClaudeSessionId: phase.forkSource().from, kind: 'main', parentId: phaseId } });
  await phase.close();
  new SessionStore(sb.sessionsDir).delete(phaseId);
  fs.rmSync(journalPath(sb.sessionsDir, phaseId), { force: true });
  assert.equal(cont.record.turns.length, 3, "precondition: the continuation carries the phase's turns (K1)");
  assert.equal(read(sb, phaseId), undefined, 'precondition: its parent record is gone');
  return { main, cont, phaseId };
}

describe('r5 #2: /rewind in an untouched /spec continuation keeps it', () => {
  for (const effort of [false, true]) {
    it(`its parent record was removed${effort ? ', after a local /effort in it' : ''}: the continuation and its journal stay, the rewind continues from turn 1`, async () => {
      const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
      let main: KiroSessionImpl | undefined;
      let cont: KiroSessionImpl | undefined;
      try {
        ({ main, cont } = await handedOver(sb));
        const contId = cont.id;
        if (effort) await cont.setEffort('high');
        await cont.rewind(1);
        assert.notEqual(cont.id, contId);
        const kept = read(sb, contId);
        assert.ok(kept, 'the only record of the spec turns was deleted by /rewind');
        assert.equal(kept.turns.length, 3);
        assert.ok(fs.existsSync(journalPath(sb.sessionsDir, contId)), 'its journal is kept');
        assert.equal(cont.record.parentId, contId, 'the rewind record names a record that exists');
        const { result } = await drain(cont.prompt({ text: 'after rewind' }));
        assert.equal(result.text, 'hist=alpha ALPHA_1 | after rewind');
      } finally {
        await closeAll(cont, main);
      }
    });
  }

  it('a copy whose parent still holds all of its turns is still dropped (no duplicate, r5 S5)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const main = await open(sb);
    let cont: KiroSessionImpl | undefined;
    try {
      await drain(main.prompt({ text: 'alpha ALPHA_1' }));
      await drain(main.prompt({ text: 'beta BETA_2' }));
      cont = await open(sb, { fork: { fromClaudeSessionId: main.forkSource().from, kind: 'main', parentId: main.id } });
      const contId = cont.id;
      await cont.rewind(1);
      assert.equal(read(sb, contId), undefined);
      assert.ok(read(sb, main.id));
    } finally {
      await closeAll(cont, main);
    }
  });
});
