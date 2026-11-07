/**
 * Verifier checks of the r4 spec fixes (r4-findings #0/#7), unit level over the spec test doubles.
 *
 * Plan mode the user turns on DURING a /spec flow (Shift+Tab while a checkpoint question is read:
 * the REPL toggles the session that is the chat's then, a phase session, and the prompt shows
 * `[plan]`) must not be dropped when the driver hands the chat its continuation, or its original
 * back. (r5 T2: a later phase session starts in the plan mode the chat then has.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { KiroSession } from '../../src/types.js';
import { SpecSessionDriver, createNewSpec, createReplRuntime, type SessionPort, type SpecRuntime } from '../../src/spec/workflow.js';
import { MockHost, MockSession, fakeModel, makeWs } from './helpers.js';

const rtOf = (host: MockHost): SpecRuntime => createReplRuntime(host, { openEditor: null });

/** Shift+Tab before the answers of the given choose() calls (1-based): toggles the chat's session. */
function shiftTabAt(host: MockHost, calls: number[]): void {
  const choose = host.choose.bind(host);
  let n = 0;
  host.choose = async (q, o) => {
    if (calls.includes(++n)) host.session.planMode = !host.session.planMode;
    return choose(q, o);
  };
}

test('R4 verify #0/#7: plan mode turned on at a /spec checkpoint (Shift+Tab) is not dropped by the hand-over', async () => {
  // `phases`: plan mode of each phase turn (r5 T2: the phase sessions after the toggle take it)
  const cases: { label: string; choose: string[]; at: number[]; phases: boolean[] }[] = [
    { label: 'at the requirements checkpoint, then Stop', choose: ['Stop here'], at: [1], phases: [false] },
    { label: 'at the requirements checkpoint, then approved through the tasks', choose: ['Approve and continue to design', 'Approve and continue to tasks', 'Approve tasks'], at: [1], phases: [false, true, true] },
    { label: 'at the tasks checkpoint, then approved', choose: ['Approve and continue to design', 'Approve and continue to tasks', 'Approve tasks'], at: [3], phases: [false, false, false] },
  ];
  for (const k of cases) {
    const w = makeWs();
    const phasePlan: boolean[] = [];
    const host = new MockHost(
      w.ctx,
      fakeModel({
        override: (_i, s) => {
          if (s.currentPhase) phasePlan.push(s.planMode);
          return undefined;
        },
      }),
    );
    try {
      await host.runTurn({ text: 'hello' });
      const original = host.session;
      assert.equal(original.planMode, false);
      host.chooseAnswers = [...k.choose];
      shiftTabAt(host, k.at);
      await createNewSpec(rtOf(host), { name: 'todo-export', kind: 'feature', description: 'Export todos as CSV' });
      assert.notEqual(host.session, original, k.label);
      assert.equal(host.session.planMode, true, `${k.label}: the plan mode the user turned on during the flow was dropped`);
      assert.deepEqual(phasePlan, k.phases, `${k.label}: the phase sessions did not take the chat's plan mode`);
    } finally {
      w.cleanup();
    }
  }
});

test('R4 verify #0/#7: without a toggle the hand-over keeps plan mode off; the original the host gets back takes a toggle too', async () => {
  // no toggle: off stays off (the fix must not put every continuation in plan mode)
  {
    const w = makeWs();
    const host = new MockHost(w.ctx, fakeModel());
    try {
      await host.runTurn({ text: 'hello' });
      host.chooseAnswers = ['Approve and continue to design', 'Stop here'];
      await createNewSpec(rtOf(host), { name: 'todo-export', kind: 'feature', description: 'Export todos as CSV' });
      assert.equal(host.session.planMode, false);
    } finally {
      w.cleanup();
    }
  }
  // the continuation cannot be made: the original comes back, in plan mode the user turned on
  {
    const w = makeWs();
    const host = new MockHost(w.ctx, fakeModel());
    try {
      await host.runTurn({ text: 'hello' });
      const original = host.session;
      const create = host.createSession.bind(host);
      let n = 0;
      host.createSession = async (o) => {
        if (++n === 2) throw new Error('fork failed');
        return create(o);
      };
      host.chooseAnswers = ['Stop here'];
      shiftTabAt(host, [1]);
      await createNewSpec(rtOf(host), { name: 'todo-export', kind: 'feature', description: 'Export todos as CSV' });
      assert.equal(host.session, original);
      assert.equal(original.planMode, true, 'the original came back without the plan mode turned on during the flow');
    } finally {
      w.cleanup();
    }
  }
  // driver level: a phase session in plan mode when no turn reached Claude (the original comes back)
  {
    const main = new MockSession({ origin: 'repl' }, () => ({ text: 'ok' }));
    let current: KiroSession = main;
    const port: SessionPort = {
      active: () => current,
      create: async (o) => new MockSession(o, () => ({ text: 'ok' })),
      activate: (s) => {
        current = s;
      },
      run: async () => ({ stopReason: 'cancelled', isError: false, text: '', permissionDenials: [] }),
    };
    const d = new SpecSessionDriver(port);
    await d.runTurn({ text: 'a' }, { name: 'requirements', allowedWritePaths: ['/a'] });
    assert.notEqual(current, main);
    current.planMode = true; // Shift+Tab while the phase session was the chat's
    await d.finish('keep');
    assert.equal(current, main);
    assert.equal(main.planMode, true);
    // the next flow of the same driver starts clean
    main.planMode = false;
    await d.runTurn({ text: 'b' }, { name: 'requirements', allowedWritePaths: ['/a'] });
    await d.finish('keep');
    assert.equal(current, main);
    assert.equal(main.planMode, false, 'a toggle of an earlier flow leaked into the next one');
  }
});

// ──────────────── #8 neighbour: a fork point that moved without a recorded turn ────────────────

/** Like KiroSessionImpl: a fork without a message yet answers its source until it gets a transcript. */
class PendingForkSession extends MockSession {
  pending: { from: string; at?: string } | undefined;
  constructor(o: ConstructorParameters<typeof MockSession>[0]) {
    super(o, () => ({ text: 'ok' }));
    if (o.fork) this.pending = { from: o.fork.fromClaudeSessionId, ...(o.fork.at ? { at: o.fork.at } : {}) };
  }
  override forkSource(): { from: string; at?: string } {
    return this.pending ?? { from: this.claudeSessionId! };
  }
}

test('R4 verify #8: a second flow from a continuation whose own Claude session got a transcript without a turn (/compact) forks that session, not the old point', async () => {
  const main = new PendingForkSession({ origin: 'repl' });
  let current: KiroSession = main;
  const made: { o: Parameters<SessionPort['create']>[0]; s: PendingForkSession }[] = [];
  const port: SessionPort = {
    active: () => current,
    create: async (o) => {
      const s = new PendingForkSession(o);
      made.push({ o, s });
      return s;
    },
    activate: (s) => {
      current = s;
    },
    run: async (s, input) => {
      const g = s.prompt(input);
      for (;;) {
        const n = await g.next();
        if (n.done) {
          (s as PendingForkSession).pending = undefined; // a turn completed: its own transcript now
          return n.value;
        }
      }
    },
  };
  const phase = { name: 'requirements', allowedWritePaths: ['/a'] };
  await port.run(main, { text: 'hello' });
  const d1 = new SpecSessionDriver(port);
  await d1.runTurn({ text: 'one' }, phase);
  await d1.finish('keep');
  const p1 = made[0]!.s;
  const cont = current as PendingForkSession;
  assert.equal(cont, made[1]!.s);
  assert.deepEqual(cont.forkSource(), { from: p1.claudeSessionId }, 'precondition: the continuation is a pending fork of P1');
  // control: no /compact, the second flow forks where the continuation starts (P1), parent = it
  {
    const d = new SpecSessionDriver(port);
    await d.runTurn({ text: 'two' }, phase);
    assert.deepEqual(made[2]!.o.fork, { fromClaudeSessionId: p1.claudeSessionId, kind: 'main', parentId: cont.id });
    await d.finish('close');
    current = cont;
  }
  // `/compact` in the continuation: its Claude session has a transcript now (no turn recorded)
  cont.pending = undefined;
  const d2 = new SpecSessionDriver(port);
  await d2.runTurn({ text: 'three' }, phase);
  assert.deepEqual(made[3]!.o.fork, { fromClaudeSessionId: cont.claudeSessionId, kind: 'main', parentId: cont.id }, 'the second flow forked the old point and dropped what the continuation compacted');
  await d2.finish('close');
});
