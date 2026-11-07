/**
 * Round 5, group spec-policy (scratchpad r4f-gaps.md), unit level over the spec test doubles; the
 * same items end to end through the real runRepl and the fake claude are in
 * test/repl/r5-spec-policy-e2e.test.ts, the KiroSessionImpl half of T1 in
 * test/spec/r5-spec-policy-session.test.ts.
 *
 *  - T1: every session a /spec flow creates (phase sessions, the continuation, `/spec run` task
 *    sessions) starts from the chat's trust as it is (KiroSessionOptions.initialTrust), never the
 *    launch flags again; a trust change made while a phase session is the chat's reaches the next
 *    phase session and the continuation.
 *  - T2: the phase sessions of a plan-mode chat run in plan mode (the prompt shows the true state);
 *    their turns say the phase documents may still be written; the continuation (or the original
 *    the chat gets back) takes the plan mode the chat shows at the end of the flow.
 *  - T3: `/spec run` in plan mode is refused (no box, no task session); the CLI has no plan mode.
 *  - T4: inside a tangent the /spec forms that run spec turns are refused before anything changes;
 *    `/spec run`, list, status, view still work.
 *  - T5: the records of a flow's phase sessions that a later session holds in full are removed when
 *    the flow ends (the continuation holds them all; without one, the last phase session a turn
 *    reached); nothing else is removed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { KiroSession, KiroSessionOptions, SessionTrust } from '../../src/types.js';
import { cloneTrust } from '../../src/policy/gate.js';
import { SessionStore, sessionsDir } from '../../src/session/store.js';
import { journalPath } from '../../src/session/kiroFiles.js';
import { specSlashCommands } from '../../src/spec/slash.js';
import {
  PLAN_MODE_RUN_REFUSED,
  SPEC_IN_TANGENT_ERROR,
  SPEC_IN_TANGENT_REFUSED,
  SPEC_TANGENT_LEFT,
  SpecSessionDriver,
  createNewSpec,
  createReplRuntime,
  discardSpecRecord,
  runSpecTasks,
  type SessionPort,
  type SpecRuntime,
} from '../../src/spec/workflow.js';
import { DESIGN_MD, MockHost, MockSession, REQ_MD, TASKS_MD, fakeModel, makeWs, read, writeSpec, type FakeModelOptions, type ModelScript, type Ws } from './helpers.js';

const rtOf = (host: MockHost): SpecRuntime => createReplRuntime(host, { openEditor: null });
const FEATURE = (rt: SpecRuntime, name = 'todo-export'): ReturnType<typeof createNewSpec> => createNewSpec(rt, { name, kind: 'feature', description: 'Export todos as CSV' });
const REQ = /^Phase: REQUIREMENTS/;

/** A MockSession that starts from `initialTrust` the way KiroSessionImpl does. */
class TrustingSession extends MockSession {
  constructor(opts: Partial<KiroSessionOptions>, script: ModelScript, hooks: import('../../src/types.js').KiroHook[] = []) {
    super(opts, script, hooks);
    if (opts.initialTrust) Object.assign(this.trust, cloneTrust(opts.initialTrust.trust));
  }
}

/** A MockSession whose `tangent` says it is in a tangent of `parentId`. */
class TangentSession extends MockSession {
  override readonly tangent = { name: 'side', parentId: 'main-1' } as unknown as undefined;
}

function setup(o: FakeModelOptions = {}, initial?: MockSession): { w: Ws; host: MockHost } {
  const w = makeWs();
  const script = fakeModel(o);
  const host = new MockHost(w.ctx, script, initial ? { initial } : {});
  host.sessionClass = TrustingSession;
  return { w, host };
}

/** The chat's trust after `--trust-tools=shell` + `/tools untrust shell` + a trusted @git tool. */
function chatTrust(): SessionTrust {
  return {
    trustAll: false,
    allowedTools: ['@git/status'],
    rules: [{ capability: 'mcp', match: ['git/status'], effect: 'allow', scope: 'session' }],
    revokedTools: ['execute_bash'],
    byAgent: { reviewer: { allowedTools: ['fs_write'], rules: [] } },
  };
}

function setTrust(s: KiroSession, t: SessionTrust): void {
  Object.assign(s.trust, cloneTrust(t));
}

async function slash(host: MockHost, line: string): Promise<void> {
  const words = line.split(/\s+/).filter(Boolean);
  await specSlashCommands[0]!.run(words, line, host);
}

// ───────────────────────────── T1 ─────────────────────────────

test('r5 T1: phase sessions, the continuation and task sessions start from the chat\'s trust as it is, never the launch flags', async () => {
  const { w, host } = setup();
  try {
    await host.runTurn({ text: 'hello' });
    const chat = host.session;
    setTrust(chat, chatTrust());
    host.chooseAnswers = ['Approve and continue to design', 'Stop here'];
    await FEATURE(rtOf(host));
    const made = host.created;
    assert.equal(made.length, 3, 'two phase sessions and the continuation');
    for (const [i, o] of made.entries()) {
      assert.deepEqual(o.initialTrust, { trust: chatTrust(), agent: 'kiro_default' }, `session ${i} did not start from the chat's trust`);
    }
    // the snapshot is a copy: the chat's own trust object is not shared with the new sessions
    assert.notEqual(made[0]!.initialTrust!.trust, chat.trust);
    assert.deepEqual(host.session.trust, chatTrust(), 'the continuation holds the chat\'s trust');

    // /spec run: every task session starts from the chat's trust (the continuation's now)
    const cont = host.session;
    cont.trust.allowedTools.push('fs_read');
    const before = host.created.length;
    const r = await runSpecTasks(rtOf(host), 'todo-export', { kind: 'ids', ids: ['1.1'], includeOptional: true });
    assert.equal(r.status, 'error', 'design approved, tasks not drafted yet');
    // a spec that has tasks
    writeSpec(w, 'other', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const r2 = await runSpecTasks(rtOf(host), 'other', { kind: 'ids', ids: ['1.1'], includeOptional: true });
    assert.equal(r2.status, 'completed', JSON.stringify(r2));
    const task = host.created.slice(before);
    assert.equal(task.length, 1);
    assert.equal(task[0]!.origin, 'spec');
    assert.deepEqual(task[0]!.initialTrust, { trust: { ...chatTrust(), allowedTools: ['@git/status', 'fs_read'] }, agent: 'kiro_default' });
    assert.equal(host.session, cont, 'the chat is back on its session after the task');
  } finally {
    w.cleanup();
  }
});

test('r5 T1: a trust change made while a phase session is the chat\'s (a `t` answer) reaches the next phase session and the continuation', async () => {
  const { w, host } = setup({
    override: (i, s) => {
      // the user answers `t` for a shell call during the requirements drafting turn
      if (REQ.test(i.text)) s.trust.allowedTools.push('execute_bash');
      return undefined;
    },
  });
  try {
    await host.runTurn({ text: 'hello' });
    host.chooseAnswers = ['Approve and continue to design', 'Stop here'];
    await FEATURE(rtOf(host));
    assert.deepEqual(host.created[0]!.initialTrust!.trust.allowedTools, [], 'the first phase session starts from the chat');
    assert.deepEqual(host.created[1]!.initialTrust!.trust.allowedTools, ['execute_bash'], 'the design phase session lost the `t` of the requirements one');
    assert.deepEqual(host.created[2]!.initialTrust!.trust.allowedTools, ['execute_bash'], 'the continuation lost it');
    assert.deepEqual(host.session.trust.allowedTools, ['execute_bash']);
  } finally {
    w.cleanup();
  }
});

test('r5 T1: the CLI driver chains the trust from one phase session to the next (no chat: the first starts from the launch flags)', async () => {
  const made: Partial<KiroSessionOptions>[] = [];
  let current: KiroSession | undefined;
  const script: ModelScript = () => ({ text: 'ok' });
  const port: SessionPort = {
    active: () => current,
    create: async (o) => {
      made.push(o);
      return new TrustingSession(o, script);
    },
    activate: (s) => {
      current = s;
    },
    run: async (s, input) => {
      const g = s.prompt(input);
      for (;;) {
        const n = await g.next();
        if (n.done) return n.value;
      }
    },
  };
  const d = new SpecSessionDriver(port);
  await d.runTurn({ text: 'a' }, { name: 'requirements', allowedWritePaths: ['/r'] });
  current!.trust.allowedTools.push('fs_write');
  await d.runTurn({ text: 'b' }, { name: 'design', allowedWritePaths: ['/d'] });
  await d.finish('close');
  assert.equal(made[0]!.initialTrust, undefined, 'nothing to continue: the launch flags apply');
  assert.deepEqual(made[1]!.initialTrust?.trust.allowedTools, ['fs_write']);
});

// ───────────────────────────── T2 ─────────────────────────────

test('r5 T2: the phase sessions of a plan-mode chat run in plan mode, and their turns say the phase documents may be written', async () => {
  const seen: { phase: string | undefined; plan: boolean; block: boolean }[] = [];
  const { w, host } = setup({
    override: (i, s) => {
      seen.push({ phase: s.currentPhase?.name, plan: s.planMode, block: (i.extraContext ?? []).some((b) => b.startsWith('<kiro-spec-plan-mode>')) });
      return undefined;
    },
  });
  try {
    await host.runTurn({ text: 'hello' });
    host.session.planMode = true;
    const activated: boolean[] = [];
    const replace = host.replaceSession.bind(host);
    host.replaceSession = (s) => {
      activated.push(s.planMode);
      replace(s);
    };
    host.chooseAnswers = ['Approve and continue to design', 'Stop here'];
    await FEATURE(rtOf(host));
    const phases = seen.filter((x) => x.phase);
    assert.deepEqual(phases.map((x) => [x.phase, x.plan, x.block]), [
      ['requirements', true, true],
      ['design', true, true],
    ]);
    // the requirements turn names its document in the block
    const reqPrompt = host.sessions.find((s) => s.opts.specPhase?.name === 'requirements')!.prompts[0]!;
    const block = reqPrompt.extraContext!.find((b) => b.startsWith('<kiro-spec-plan-mode>'))!;
    assert.ok(block.includes(path.join(w.specs, 'todo-export', 'requirements.md')), block);
    // every session the chat was handed showed plan mode from the start (prompt `[plan]`)
    assert.deepEqual(activated, [true, true, true]);
    assert.equal(host.session.planMode, true);
    assert.ok(fs.existsSync(path.join(w.specs, 'todo-export', 'requirements.md')));
  } finally {
    w.cleanup();
  }
  // a chat without plan mode: no block, no plan mode
  {
    const seen2: boolean[] = [];
    const { w: w2, host: h2 } = setup({ override: (i, s) => (seen2.push(s.planMode || (i.extraContext ?? []).some((b) => b.includes('kiro-spec-plan-mode'))), undefined) });
    try {
      h2.chooseAnswers = ['Stop here'];
      await FEATURE(rtOf(h2));
      assert.deepEqual(seen2, [false]);
    } finally {
      w2.cleanup();
    }
  }
});

test('r5 T2: Shift+Tab at a checkpoint toggles the phase session the chat shows; the next phase session and the continuation follow it (either way)', async () => {
  for (const startPlan of [true, false]) {
    const plans: boolean[] = [];
    const { w, host } = setup({ override: (_i, s) => (s.currentPhase ? (plans.push(s.planMode), undefined) : undefined) });
    try {
      await host.runTurn({ text: 'hello' });
      host.session.planMode = startPlan;
      const choose = host.choose.bind(host);
      let n = 0;
      host.choose = async (q, o) => {
        if (++n === 1) host.session.planMode = !host.session.planMode; // Shift+Tab at the requirements checkpoint
        return choose(q, o);
      };
      host.chooseAnswers = ['Approve and continue to design', 'Stop here'];
      await FEATURE(rtOf(host));
      assert.deepEqual(plans, [startPlan, !startPlan], `start ${startPlan}: the design phase session did not take the toggled plan mode`);
      assert.equal(host.session.planMode, !startPlan, `start ${startPlan}: the continuation does not show the plan mode the chat showed`);
    } finally {
      w.cleanup();
    }
  }
});

test('r5 T2: the original the chat gets back (no turn reached Claude, the continuation fork failed) takes the plan mode the chat showed', async () => {
  const { w, host } = setup();
  try {
    await host.runTurn({ text: 'hello' });
    const original = host.session;
    original.planMode = true;
    const create = host.createSession.bind(host);
    let n = 0;
    host.createSession = async (o) => {
      if (++n === 2) throw new Error('fork failed');
      return create(o);
    };
    const choose = host.choose.bind(host);
    host.choose = async (q, o) => {
      host.session.planMode = false; // Shift+Tab: the user leaves plan mode at the checkpoint
      return choose(q, o);
    };
    host.chooseAnswers = ['Stop here'];
    await FEATURE(rtOf(host));
    assert.equal(host.session, original);
    assert.equal(original.planMode, false, 'the chat shows `> ` at the checkpoint: it comes back that way');
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── T3 ─────────────────────────────

test('r5 T3: /spec run in plan mode is refused: no box changes, no task session, how to leave plan mode', async () => {
  const { w, host } = setup();
  try {
    const dir = writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const tasksBefore = read(path.join(dir, 'tasks.md'));
    host.session.planMode = true;
    const r = await runSpecTasks(rtOf(host), 'todo-export', { kind: 'scope', includeOptional: false });
    assert.equal(r.status, 'error');
    assert.equal(r.outcomes.length, 0);
    assert.ok(r.message?.startsWith(PLAN_MODE_RUN_REFUSED), r.message);
    assert.match(host.text, /Plan mode is read-only: running spec tasks implements code[\s\S]*Exit plan mode \(\/plan or Shift\+Tab\), then run \/spec run todo-export again\./);
    assert.equal(host.created.length, 0, 'a task session was started');
    assert.equal(read(path.join(dir, 'tasks.md')), tasksBefore, 'tasks.md changed');
    // the slash command and the step-through menu take the same path
    await slash(host, 'run todo-export --all');
    host.chooseAnswers = ['Run next task'];
    await slash(host, 'todo-export');
    assert.equal(host.created.length, 0);
    assert.equal(host.text.match(/Plan mode is read-only: running spec tasks/g)?.length, 3);
    // out of plan mode it runs
    host.session.planMode = false;
    const ok = await runSpecTasks(rtOf(host), 'todo-export', { kind: 'ids', ids: ['1.1'], includeOptional: true });
    assert.equal(ok.status, 'completed');
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── T4 ─────────────────────────────

test('r5 T4: inside a tangent the /spec forms that run spec turns are refused before anything changes; run, list, view still work', async () => {
  const w = makeWs();
  const tangent = new TangentSession({ origin: 'repl' }, fakeModel());
  const host = new MockHost(w.ctx, fakeModel(), { initial: tangent });
  try {
    writeSpec(w, 'pending', { requirements: REQ_MD }); // awaiting requirements approval
    writeSpec(w, 'ready', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD }); // in execution
    for (const line of ['new fresh-spec --type feature --workflow requirements-first a csv export', 'approve pending', 'revise pending make it shorter', 'analyze pending', 'sync ready', 'pending']) {
      const n = host.printed.length;
      await slash(host, line);
      const out = host.printed.slice(n).join('\n');
      assert.ok(out.includes(SPEC_IN_TANGENT_REFUSED), `/spec ${line} was not refused in a tangent:\n${out}`);
    }
    assert.equal(fs.existsSync(path.join(w.specs, 'fresh-spec')), false, 'the spec folder was created');
    assert.equal(host.created.length, 0, 'a session was created');
    assert.equal(host.session, tangent);
    assert.equal(tangent.prompts.length, 0);
    // what runs no spec turn works in a tangent
    let n = host.printed.length;
    await slash(host, 'list');
    await slash(host, 'view pending');
    assert.ok(!host.printed.slice(n).join('\n').includes(SPEC_IN_TANGENT_REFUSED));
    n = host.printed.length;
    const r = await runSpecTasks(rtOf(host), 'ready', { kind: 'ids', ids: ['1.1'], includeOptional: true });
    assert.equal(r.status, 'completed', host.printed.slice(n).join('\n'));
    assert.equal(host.session, tangent, 'the tangent is the chat again after the task');
    // a spec in task execution steps through its tasks (the menu), no refusal
    n = host.printed.length;
    host.chooseAnswers = ['Stop'];
    await slash(host, 'ready');
    assert.ok(!host.printed.slice(n).join('\n').includes(SPEC_IN_TANGENT_REFUSED));
    // backstop: a spec turn the runtime is asked for in a tangent (step-through "Review tasks.md")
    const rt = rtOf(host);
    const t = await rt.runSpecTurn({ text: 'x' }, { name: 'tasks', allowedWritePaths: ['/t'] });
    assert.equal(t.isError, true);
    assert.equal(t.error, SPEC_IN_TANGENT_ERROR);
    assert.equal(host.session, tangent);
    assert.ok(host.created.every((o) => !o.specPhase), 'a phase session was forked from the tangent');
  } finally {
    w.cleanup();
  }
});

/** A tangent just entered (no message of its own): a pending fork of main; exitTangent returns to main. */
class FreshTangentSession extends MockSession {
  inTangent = true;
  exits: (string | undefined)[] = [];
  constructor(opts: Partial<KiroSessionOptions>, script: ModelScript) {
    super(opts, script);
    // MockSession's `tangent` is an own field: replace it with the live state
    Object.defineProperty(this, 'tangent', { get: () => (this.inTangent ? { name: null, parentId: 'main-rec' } : undefined), configurable: true });
  }
  override forkSource(): { from: string; at?: string } {
    return this.inTangent ? { from: 'claude-main' } : { from: this.claudeSessionId! };
  }
  override async exitTangent(mode?: 'discard' | 'tail' | 'merge'): Promise<void> {
    this.exits.push(mode);
    this.inTangent = false;
  }
}

test('r5 T4: a tangent with no message of its own is left first (notice), and the flow continues the main conversation (G0); a nested one is refused', async () => {
  for (const nested of [false, true]) {
    const w = makeWs();
    const store = new SessionStore(sessionsDir(w.ctx));
    store.write({ ...new MockSession({}, fakeModel()).record, sessionId: 'main-rec', forkKind: nested ? 'tangent' : 'main' });
    const fresh = new FreshTangentSession({ origin: 'repl' }, fakeModel());
    const host = new MockHost(w.ctx, fakeModel(), { initial: fresh });
    try {
      host.chooseAnswers = ['Stop here'];
      await slash(host, 'new fresh-spec --type feature --workflow requirements-first a csv export');
      if (nested) {
        assert.ok(host.text.includes(SPEC_IN_TANGENT_REFUSED), host.text);
        assert.deepEqual(fresh.exits, [], 'a nested tangent was left');
        assert.equal(host.created.length, 0);
        continue;
      }
      assert.deepEqual(fresh.exits, ['discard']);
      assert.ok(host.text.includes(SPEC_TANGENT_LEFT), host.text);
      assert.ok(!host.text.includes(SPEC_IN_TANGENT_REFUSED));
      // the phase session forked main's conversation (the chat, back on main), the flow ran
      assert.equal(host.created[0]!.fork?.parentId, fresh.id);
      assert.ok(fs.existsSync(path.join(w.specs, 'fresh-spec', 'requirements.md')));
      assert.equal(host.session.tangent, undefined);
    } finally {
      w.cleanup();
    }
  }
});

// ───────────────────────────── T5 ─────────────────────────────

/** A host whose forks carry their parent record's turns (K1) and whose records are on disk. */
class RecordingHost extends MockHost {
  readonly store: SessionStore;
  constructor(w: Ws, script: ModelScript) {
    super(w.ctx, script);
    this.sessionClass = TrustingSession;
    this.store = new SessionStore(sessionsDir(w.ctx));
    this.save(this.session as MockSession);
  }
  save(s: MockSession): void {
    this.store.write(s.record);
    fs.writeFileSync(journalPath(this.store.dir, s.id), '{"version":1,"kind":"Prompt"}\n');
  }
  override async createSession(opts: Partial<KiroSessionOptions>): Promise<KiroSession> {
    const s = (await super.createSession(opts)) as MockSession;
    const parent = opts.fork?.parentId ? this.sessions.find((x) => x.id === opts.fork!.parentId) : undefined;
    if (parent) s.record.turns.push(...parent.record.turns.map((t) => ({ ...t })));
    s.record.parentId = parent?.id ?? null;
    this.save(s);
    // like kiroSession: closing saves the record (with the turns it got)
    const close = s.close.bind(s);
    s.close = async () => {
      await close();
      this.store.write(s.record);
    };
    return s;
  }
  ids(): string[] {
    return this.store.list({}).map((r) => r.sessionId).sort();
  }
}

test('r5 T5: after a flow only the chat\'s records stay: the continuation holds every phase record, which is removed (index, journal)', async () => {
  const w = makeWs();
  const host = new RecordingHost(w, fakeModel());
  try {
    await host.runTurn({ text: 'hello' });
    host.save(host.session as MockSession);
    const main = host.session;
    host.chooseAnswers = ['Approve and continue to design', 'Approve and continue to tasks', 'Stop here'];
    await FEATURE(rtOf(host));
    const cont = host.session as MockSession;
    const phases = host.sessions.filter((s) => s.opts.specPhase);
    assert.equal(phases.length, 3);
    assert.deepEqual(host.ids(), [main.id, cont.id].sort(), 'the phase records the continuation holds are still listed');
    for (const p of phases) assert.equal(fs.existsSync(journalPath(host.store.dir, p.id)), false, `${p.id}'s journal stayed`);
    // the continuation holds the whole spec conversation
    assert.ok(cont.record.turns.length >= 4, JSON.stringify(cont.record.turns));
    // a second flow from the continuation: the first continuation stays (the conversation as it was
    // before the second flow, like main before the first), the second flow's phase records go
    host.chooseAnswers = ['Stop here'];
    await FEATURE(rtOf(host), 'second-spec');
    assert.deepEqual(host.ids(), [main.id, cont.id, host.session.id].sort());
  } finally {
    w.cleanup();
  }
});

test('r5 T5: without a continuation the last phase record a turn reached stays (it holds the earlier ones); a record it does not hold stays too', async () => {
  // CLI-like: finish('close')
  {
    const w = makeWs();
    const host = new RecordingHost(w, fakeModel());
    try {
      const discarded: string[] = [];
      let current: KiroSession | undefined;
      const port: SessionPort = {
        active: () => current,
        create: (o) => host.createSession(o),
        activate: (s) => {
          current = s;
        },
        run: async (s, input) => {
          const g = s.prompt(input);
          for (;;) {
            const n = await g.next();
            if (n.done) return n.value;
          }
        },
        discard: (s) => {
          discarded.push(s.id);
          discardSpecRecord(w.ctx, s.id);
        },
      };
      const d = new SpecSessionDriver(port, { phaseOptions: { origin: 'spec' } });
      await d.runTurn({ text: 'a' }, { name: 'requirements', allowedWritePaths: ['/r'] });
      const p1 = current!;
      await d.runTurn({ text: 'b' }, { name: 'design', allowedWritePaths: ['/d'] });
      const p2 = current!;
      await d.finish('close');
      assert.deepEqual(discarded, [p1.id]);
      assert.ok(host.ids().includes(p2.id), 'the record holding the spec conversation was removed');
      assert.ok(!host.ids().includes(p1.id));
    } finally {
      w.cleanup();
    }
  }
  // a phase record whose turns the continuation does not hold (its fork was cut earlier) stays
  {
    const w = makeWs();
    const host = new RecordingHost(w, fakeModel());
    try {
      await host.runTurn({ text: 'hello' });
      host.save(host.session as MockSession);
      const create = host.createSession.bind(host);
      host.createSession = async (o) => {
        const s = (await create(o)) as MockSession;
        if (!o.specPhase) s.record.turns.splice(s.record.turns.length - 1, 1); // the continuation lacks the last phase turn
        return s;
      };
      host.chooseAnswers = ['Stop here'];
      await FEATURE(rtOf(host));
      const phase = host.sessions.find((s) => s.opts.specPhase)!;
      assert.ok(host.ids().includes(phase.id), 'a phase record the continuation does not hold in full was removed');
    } finally {
      w.cleanup();
    }
  }
});

test('r5 T5: discardSpecRecord removes only a closed spec-phase record (never the chat\'s, a tangent, or one a live process holds)', () => {
  const w = makeWs();
  try {
    const store = new SessionStore(sessionsDir(w.ctx));
    const mk = (origin: 'spec' | 'repl' | 'acp', forkKind: 'main' | 'tangent' = 'main'): string => {
      const r = store.create({ origin, cwd: w.proj, agent: 'a', model: 'auto', forkKind });
      fs.writeFileSync(journalPath(store.dir, r.sessionId), '{}\n');
      return r.sessionId;
    };
    const phase = mk('spec');
    const chat = mk('repl');
    const acp = mk('acp');
    const tangent = mk('spec', 'tangent');
    const open = mk('spec');
    const lock = store.acquireLock(open);
    try {
      assert.equal(discardSpecRecord(w.ctx, chat), false);
      assert.equal(discardSpecRecord(w.ctx, acp), false);
      assert.equal(discardSpecRecord(w.ctx, tangent), false);
      assert.equal(discardSpecRecord(w.ctx, open), false, 'a record this process still holds open was removed');
      assert.equal(discardSpecRecord(w.ctx, 'no-such-id'), false);
      assert.equal(discardSpecRecord(w.ctx, '../escape'), false);
      assert.equal(discardSpecRecord(w.ctx, phase), true);
    } finally {
      lock.release();
    }
    assert.equal(store.read(phase), undefined);
    assert.equal(fs.existsSync(journalPath(store.dir, phase)), false);
    for (const id of [chat, acp, tangent, open]) assert.ok(store.read(id), id);
  } finally {
    w.cleanup();
  }
});
