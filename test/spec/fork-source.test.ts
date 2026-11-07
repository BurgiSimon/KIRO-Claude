/**
 * `forkSource()` is part of the KiroSession contract (src/types.ts): the spec driver
 * (src/spec/workflow.ts forkPointOf) asks every session where a fork of its conversation starts,
 * instead of reading a TS-private KiroSessionImpl method duck-typed. Typed through `KiroSession`
 * here, so this file does not compile while the method is private or missing from the contract.
 * The runtime checks: the real session answers its own Claude session, a /tangent or /rewind just
 * entered (a fork without a message yet) answers that fork's source, and every test double
 * implements it.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { before, describe, it } from 'node:test';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import type { KiroSession, KiroSessionOptions } from '../../src/types.js';
import { MockSession as AcpMockSession, createWorld } from '../acp/mockSession.js';
import { MockSession as HeadlessMockSession } from '../headless/mockSession.js';
import { MockSession as ReplMockSession } from '../repl/mockSession.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI } from '../session/helpers.js';
import { MockSession as SpecMockSession, fakeModel } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

/** The contract's answer, read through the interface (not the class). */
const sourceOf = (s: KiroSession): { from: string; at?: string } | undefined => s.forkSource();

describe('KiroSession.forkSource (contract)', () => {
  it('the real session: its own Claude session; a /tangent or /rewind without a message yet: that fork\'s source', async () => {
    const sb = mkSandbox({ script: { default: { steps: [{ text: 'ok' }] } }, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const opts: KiroSessionInternalOptions = { ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env: sb.env };
    const s: KiroSession = await KiroSessionImpl.create(opts);
    try {
      await drain(s.prompt({ text: 'first' }));
      const main = s.claudeSessionId!;
      assert.deepEqual(sourceOf(s), { from: main });

      await s.enterTangent('side');
      assert.notEqual(s.claudeSessionId, main, 'the tangent is a Claude session of its own');
      assert.deepEqual(sourceOf(s), { from: main }, 'a tangent without a message yet forks from main');
      await drain(s.prompt({ text: 'in tangent' }));
      assert.deepEqual(sourceOf(s), { from: s.claudeSessionId }, 'once it got a message, from itself');
      await s.exitTangent('discard');
      assert.deepEqual(sourceOf(s), { from: main });

      const at = s.record.turns[0]!.assistantUuid;
      assert.ok(at, 'precondition: turn 1 has an assistant uuid');
      await s.rewind(1);
      assert.deepEqual(sourceOf(s), { from: main, at }, 'a rewind without a message yet forks main at turn 1');
    } finally {
      await closeAll(s);
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('every KiroSession test double implements it: its own Claude session', () => {
    const sb = mkSandbox();
    try {
      const opts = { ws: sb.ws, env: sb.env, origin: 'repl', interactive: true } as KiroSessionOptions;
      const doubles: KiroSession[] = [
        new ReplMockSession(),
        new AcpMockSession(createWorld(), opts),
        new HeadlessMockSession(opts, {}, { created: [], started: 0, closed: 0, prompts: [], compacts: [], interrupts: 0, mcpCalls: 0, sessions: [] }),
        new SpecMockSession({}, fakeModel()),
      ];
      for (const d of doubles) {
        assert.ok(d.claudeSessionId, d.constructor.name);
        assert.deepEqual(sourceOf(d), { from: d.claudeSessionId }, d.constructor.name);
      }
    } finally {
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });
});
