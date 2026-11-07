/**
 * Round 5, group spec-policy, verifier (unit level over the spec test doubles; the task-session
 * halves end to end: test/repl/r5-spec-policy-verify-e2e.test.ts).
 *
 *  - When a flow hands no continuation over (the continuation fork failed, its start was
 *    cancelled, no turn reached Claude), the chat gets its original session back. A restriction
 *    the user added while a phase session was the chat's (`/tools untrust`, trust-all turned off,
 *    typed at a phase turn's approval prompt) must hold for that original too; trust the phase
 *    session gained (`t`) is not copied back.
 *  - The same for a `/spec run` task session: restrictions carry back to the chat (also plan mode,
 *    which then stops the run before the next task).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { KiroSession, KiroSessionOptions } from '../../src/types.js';
import { cloneTrust } from '../../src/policy/gate.js';
import { createNewSpec, createReplRuntime, runSpecTasks, type SpecRuntime } from '../../src/spec/workflow.js';
import { DESIGN_MD, MockHost, MockSession, REQ_MD, TASKS_MD, fakeModel, makeWs, writeSpec, type FakeModelOptions, type ModelScript } from './helpers.js';

const rtOf = (host: MockHost): SpecRuntime => createReplRuntime(host, { openEditor: null });
const REQ = /^Phase: REQUIREMENTS/;

/** A MockSession that starts from `initialTrust` and whose trust methods change its trust (as the gate's do). */
class GateTrustSession extends MockSession {
  constructor(opts: Partial<KiroSessionOptions>, script: ModelScript, hooks: import('../../src/types.js').KiroHook[] = []) {
    super(opts, script, hooks);
    if (opts.initialTrust) Object.assign(this.trust, cloneTrust(opts.initialTrust.trust));
  }
  override trustTools(names: string[] = []): void {
    for (const n of names) if (!this.trust.allowedTools.includes(n)) this.trust.allowedTools.push(n);
  }
  override untrustTools(names: string[] = []): void {
    this.trust.allowedTools = this.trust.allowedTools.filter((n) => !names.includes(n));
  }
  override setTrustAll(on = false): void {
    this.trust.trustAll = on;
  }
}

function setup(o: FakeModelOptions = {}): { w: ReturnType<typeof makeWs>; host: MockHost } {
  const w = makeWs();
  const script = fakeModel(o);
  const initial = new GateTrustSession({ origin: 'repl' }, script);
  const host = new MockHost(w.ctx, script, { initial });
  host.sessionClass = GateTrustSession;
  return { w, host };
}

test('r5 verify: the original the chat gets back (the continuation fork failed) keeps a `/tools untrust` / trust-all off made in a phase turn; a `t` is not copied back', async () => {
  const { w, host } = setup({
    override: (i, s) => {
      if (REQ.test(i.text)) {
        // typed at the phase turn's approval prompt (the phase session is the chat's then)
        (s as KiroSession).untrustTools(['execute_bash']);
        (s as KiroSession).setTrustAll(false);
        (s as KiroSession).trustTools(['fs_write']); // a `t` answer
      }
      return undefined;
    },
  });
  try {
    await host.runTurn({ text: 'hello' });
    const original = host.session;
    original.trustTools(['execute_bash', '@git/status']);
    original.setTrustAll(true);
    const create = host.createSession.bind(host);
    let n = 0;
    host.createSession = async (o) => {
      if (++n === 2) throw new Error('fork failed'); // the continuation
      return create(o);
    };
    host.chooseAnswers = ['Stop here'];
    await createNewSpec(rtOf(host), { name: 'todo-export', kind: 'feature', description: 'Export todos as CSV' });
    assert.equal(host.session, original, 'the chat has its original session back');
    assert.equal(original.trust.trustAll, false, 'trust-all the user turned off in the phase turn is on again');
    assert.deepEqual(original.trust.allowedTools, ['@git/status'], 'the tool the user untrusted in the phase turn is trusted again');
  } finally {
    w.cleanup();
  }
});

test('r5 verify: a /spec run task session hands the chat back with the restrictions the user added in it; plan mode stops the run', async () => {
  const { w, host } = setup({
    override: (i, s) => {
      if (/Execute Task: 1\.1/.test(i.text)) {
        (s as KiroSession).untrustTools(['execute_bash']);
        (s as KiroSession).trustTools(['fs_write']);
        s.planMode = true; // Shift+Tab while the task session is the chat's
      }
      return undefined;
    },
  });
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const chat = host.session as KiroSession;
    chat.trustTools(['execute_bash', '@git/status']);
    const before = host.created.length;
    const r = await runSpecTasks(rtOf(host), 'todo-export', { kind: 'ids', ids: ['1.1', '2.1'], includeOptional: true });
    assert.equal(host.created.length - before, 1, 'task 2.1 started after the user turned plan mode on');
    assert.equal(r.status, 'stopped', JSON.stringify(r));
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.status]), [['1.1', 'completed']]);
    assert.match(host.text, /Plan mode is read-only: running spec tasks implements code[\s\S]*then run \/spec run todo-export again\./);
    assert.equal(host.session, chat);
    assert.equal(chat.planMode, true, 'the chat came back out of the plan mode the user turned on');
    assert.deepEqual(chat.trust.allowedTools, ['@git/status'], 'the chat trusts the tool again the user untrusted in the task');
  } finally {
    w.cleanup();
  }
});

test('r5 verify: a revocation in task 1 holds for task 2 (it starts from the chat it was handed back to)', async () => {
  const { w, host } = setup({
    override: (i, s) => {
      if (/Execute Task: 1\.1/.test(i.text)) (s as KiroSession).untrustTools(['execute_bash']);
      return undefined;
    },
  });
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    host.session.trustTools(['execute_bash']);
    const before = host.created.length;
    const r = await runSpecTasks(rtOf(host), 'todo-export', { kind: 'ids', ids: ['1.1', '2.1'], includeOptional: true });
    assert.equal(r.status, 'completed', JSON.stringify(r));
    const made = host.created.slice(before);
    assert.equal(made.length, 2);
    assert.deepEqual(made[0]!.initialTrust?.trust.allowedTools, ['execute_bash']);
    assert.deepEqual(made[1]!.initialTrust?.trust.allowedTools, [], 'task 2.1 started with the tool the user untrusted in task 1.1');
  } finally {
    w.cleanup();
  }
});
