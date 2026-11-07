/**
 * Round 5, group spec-policy, T1 (REPL half): the forced-stop restart (core.ts restartStopped)
 * starts the new session from the stopped one's whole trust (KiroSessionOptions.initialTrust),
 * closing the known gap "a forced-stop restart without a record carries only allowedTools /
 * revokedTools / plan mode": V3 session rules, the other agents' trust (`byAgent`) and trust-all
 * come back too, whether the record is resumed or a new conversation starts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { SessionTrust } from '../../src/types.js';
import { startRepl } from './harness.js';
import { MockSession } from './mockSession.js';

async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A session whose first turn ignores the interrupt: the second Ctrl+C makes the REPL stop it. */
function stuckSession(press: () => void): MockSession {
  return new MockSession().script({
    steps: [
      { run: press },
      {
        run: async ({ session }) => {
          await until(() => session.interrupted > 0);
          press();
          await until(() => session.closed);
        },
      },
    ],
    noRecord: true,
  });
}

function trustOfChat(): SessionTrust {
  return {
    trustAll: true,
    allowedTools: ['fs_write'],
    rules: [{ capability: 'fs_write', match: ['src/**'], effect: 'allow', scope: 'session' }],
    revokedTools: ['execute_bash'],
    byAgent: { reviewer: { allowedTools: ['@git/status'], rules: [{ capability: 'mcp', match: ['git/status'], effect: 'allow', scope: 'session' }] } },
  };
}

for (const resumable of [false, true]) {
  test(`r5 T1: a forced-stop restart (${resumable ? 'record resumed' : 'new conversation'}) starts from the stopped session's whole trust: rules, other agents', revocations, trust-all`, { timeout: 20_000 }, async () => {
    let run!: ReturnType<typeof startRepl>;
    const s = stuckSession(() => run.send('\u0003'));
    Object.assign(s.trust, trustOfChat());
    const next = new MockSession().script({ result: { text: 'second answer' } });
    run = startRepl({ session: s, input: ['long task'], keepOpen: true, nextSession: () => next, sessionOptions: { trustTools: ['shell'] } });
    if (resumable) {
      const { SessionStore, sessionsDir } = await import('../../src/session/store.js');
      new SessionStore(sessionsDir(run.ws)).write({ ...s.record, turns: [{ userUuid: 'u0', assistantUuid: 'a0', preview: 'earlier', at: new Date().toISOString() }], messageCount: 1 });
    }
    await run.waitFor(/stopping it\.\n[\s\S]*> $/, 5000);
    run.send('next');
    await run.waitFor('second answer', 5000);
    const o = run.created[1]!;
    assert.deepEqual(o.resume, resumable ? { sessionId: s.id } : undefined);
    assert.deepEqual(o.initialTrust, { trust: trustOfChat(), agent: s.agent.name }, 'the restart did not carry the whole trust');
    run.send('/quit');
    assert.equal(await run.exit, 0);
    run.t.cleanup();
  });
}
