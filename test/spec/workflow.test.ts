import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { KiroSession, KiroSessionOptions, PromptInput, TurnResult } from '../../src/types.js';
import { parseTasks } from '../../src/spec/model.js';
import { readSpecConfig } from '../../src/spec/store.js';
import {
  SpecSessionDriver,
  analyzeRequirements,
  approveSpec,
  canSetSpecPhase,
  createNewSpec,
  createReplRuntime,
  resumeSpec,
  reviseSpec,
  runSpecTasks,
  syncSpec,
  turnFailure,
  type SessionPort,
  type SpecRuntime,
  type TaskSessionHandle,
} from '../../src/spec/workflow.js';
import {
  DESIGN_MD,
  MockHost,
  MockSession,
  REQ_MD,
  SettableSession,
  TASKS_MD,
  fakeModel,
  makeWs,
  read,
  recordingHooks,
  taskHook,
  writeSpec,
  type FakeModelOptions,
  type ModelScript,
  type Ws,
} from './helpers.js';

const states = (r: { transitions: { state: string; doc?: string }[] }): string[] => r.transitions.map((t) => (t.doc ? `${t.state}:${t.doc}` : t.state));

function setup(o: FakeModelOptions = {}, opts: { initial?: MockSession; hooks?: Parameters<typeof taskHook>[0][] } = {}): { w: Ws; host: MockHost; log: string[] } {
  const w = makeWs();
  const log: string[] = [];
  const hookOpt = opts.hooks ? { hooks: opts.hooks.map(taskHook) } : {};
  const host = new MockHost(w.ctx, fakeModel({ ...o, log }), { ...(opts.initial ? { initial: opts.initial } : {}), ...hookOpt });
  return { w, host, log };
}

const specDir = (w: Ws, n = 'todo-export'): string => path.join(w.specs, n);
const writeFull = (w: Ws, tasks = TASKS_MD): string => writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks });

// ───────────────────────────── phases (REPL, fork path) ─────────────────────────────

test('new feature spec: approve every checkpoint; each phase restricted to its document; context forked', async () => {
  const { w, host } = setup();
  try {
    host.chooseAnswers = ['Approve and continue to design', 'Approve and continue to tasks', 'Approve tasks'];
    const original = host.session as MockSession;
    const rt = createReplRuntime(host, { openEditor: null });
    const r = await createNewSpec(rt, { name: 'todo-export', kind: 'feature', description: 'Export todos as CSV' });
    assert.equal(r.status, 'ready');
    assert.deepEqual(states(r), [
      'drafting:requirements',
      'review:requirements',
      'approved:requirements',
      'drafting:design',
      'review:design',
      'approved:design',
      'drafting:tasks',
      'review:tasks',
      'approved:tasks',
      'ready',
    ]);
    const dir = specDir(w);
    assert.equal(read(path.join(dir, 'requirements.md')), REQ_MD);
    assert.equal(read(path.join(dir, 'design.md')), DESIGN_MD);
    assert.equal(read(path.join(dir, 'tasks.md')), TASKS_MD);
    assert.deepEqual(readSpecConfig(dir)?.workflowType, 'requirements-first');
    // checkpoint questions (03 §1.4.2) and options (03 §1.11.4)
    assert.deepEqual(
      host.chosen.map((c) => c.question),
      [
        'Do the requirements look good? If so, we can move on to the design.',
        'Does the design look good? If so, we can move on to the implementation plan.',
        'Do the tasks look good?',
      ],
    );
    assert.deepEqual(host.chosen[0]!.options, ['Approve and continue to design', 'Request changes…', 'Analyze requirements', 'Stop here (resume later with /spec todo-export)']);
    assert.ok(!host.chosen[1]!.options.includes('Analyze requirements'));
    // sessions: 3 restricted phase sessions, each forked from the previous conversation, then an unrestricted continuation
    const phases = host.created.map((o) => o.specPhase);
    assert.deepEqual(phases, [
      { name: 'requirements', allowedWritePaths: [path.join(dir, 'requirements.md')] },
      { name: 'design', allowedWritePaths: [path.join(dir, 'design.md')] },
      { name: 'tasks', allowedWritePaths: [path.join(dir, 'tasks.md')] },
      undefined,
    ]);
    assert.deepEqual(
      host.created.map((o) => o.origin),
      ['spec', 'spec', 'spec', undefined],
    );
    const [s1, s2, s3, s4] = host.sessions.slice(1);
    assert.deepEqual(host.created[0]!.fork, { fromClaudeSessionId: original.claudeSessionId, kind: 'main', parentId: original.id });
    assert.equal(host.created[1]!.fork!.fromClaudeSessionId, s1!.claudeSessionId);
    assert.equal(host.created[3]!.fork!.fromClaudeSessionId, s3!.claudeSessionId);
    assert.deepEqual(
      [original.closed, s1!.closed, s2!.closed, s3!.closed, s4!.closed],
      [true, true, true, true, false],
    );
    assert.equal(host.session, s4);
    // the phase turn input: spec-mode block as context, instruction as text, no prompt hooks
    const p0 = s1!.prompts[0]!;
    assert.match(p0.text, /^Phase: REQUIREMENTS\. Create or update .*requirements\.md\./);
    assert.match(p0.text, /User description \(ground truth\): Export todos as CSV$/);
    assert.match(p0.extraContext![0]!, /^<kiro-spec-mode>\nYou are working in Kiro spec mode on the spec "todo-export" \(feature\)/);
    assert.equal(p0.skipPromptHooks, true);
    assert.ok(host.text.includes('requirements.md ready (2 requirements, 3 criteria)'));
    assert.ok(host.text.includes('design.md ready (7 sections, 2 properties)'));
    assert.ok(host.text.includes('tasks.md ready (0/5 tasks done (required 0/3))'));
    assert.ok(host.text.includes('Spec ready. Run all tasks: /spec run todo-export · Step through: /spec todo-export'));
  } finally {
    w.cleanup();
  }
});

test('revise loop: feedback revises the same document in the same phase session; empty feedback re-shows the checkpoint', async () => {
  const { w, host } = setup();
  try {
    host.chooseAnswers = ['Request changes…', 'Request changes…', 'Approve and continue to design', 'Stop here'];
    host.askAnswers = ['', 'Also cover TSV export'];
    const rt = createReplRuntime(host, { openEditor: null });
    const r = await createNewSpec(rt, { name: 'todo-export', kind: 'feature', description: 'd' });
    assert.equal(r.status, 'stopped');
    assert.equal(r.awaiting, 'design');
    assert.deepEqual(states(r), [
      'drafting:requirements',
      'review:requirements',
      'revising:requirements',
      'review:requirements',
      'approved:requirements',
      'drafting:design',
      'review:design',
      'stopped:design',
    ]);
    const phaseSession = host.sessions[1]!;
    assert.equal(phaseSession.prompts.length, 2, 'revision ran in the requirements session');
    assert.match(phaseSession.prompts[1]!.text, /^Revise .*requirements\.md per this feedback, in place, then stop again:\nAlso cover TSV export$/);
    assert.ok(read(path.join(specDir(w), 'requirements.md')).includes('<!-- revised -->'));
    assert.equal(host.asked.length, 2);
    assert.ok(host.text.includes('Stopped at the design.md checkpoint. Resume later with /spec todo-export.'));
    assert.equal(host.created.filter((o) => o.specPhase).length, 2);
  } finally {
    w.cleanup();
  }
});

test('in-place setSpecPhase sessions are switched per turn (no new sessions)', async () => {
  const w = makeWs();
  try {
    const script = fakeModel();
    const initial = new SettableSession({ origin: 'repl' }, script);
    const host = new MockHost(w.ctx, script, { initial });
    host.chooseAnswers = ['Approve and continue to design', 'Approve and continue to tasks', 'Approve tasks'];
    assert.equal(canSetSpecPhase(initial), true);
    const r = await createNewSpec(createReplRuntime(host, { openEditor: null }), { name: 'todo-export', kind: 'feature', description: 'd' });
    assert.equal(r.status, 'ready');
    assert.equal(host.created.length, 0);
    assert.equal(host.session, initial);
    assert.equal(initial.closed, false);
    const dir = specDir(w);
    assert.deepEqual(initial.phaseChanges, [
      { name: 'requirements', allowedWritePaths: [path.join(dir, 'requirements.md')] },
      undefined,
      { name: 'design', allowedWritePaths: [path.join(dir, 'design.md')] },
      undefined,
      { name: 'tasks', allowedWritePaths: [path.join(dir, 'tasks.md')] },
      undefined,
    ]);
    assert.equal(initial.prompts.length, 3);
  } finally {
    w.cleanup();
  }
});

test('quick spec: questions turn (no writes), then three phases with one final checkpoint', async () => {
  const { w, host } = setup();
  try {
    host.chooseAnswers = ['Approve tasks'];
    host.askAnswers = ['1=a'];
    const r = await createNewSpec(createReplRuntime(host, { openEditor: null }), { name: 'quick-one', kind: 'quick', description: 'CSV export' });
    assert.equal(r.status, 'ready');
    assert.deepEqual(states(r), ['drafting:requirements', 'drafting:design', 'drafting:tasks', 'review:tasks', 'approved:tasks', 'ready']);
    assert.equal(host.chosen.length, 1);
    assert.deepEqual(host.created[0]!.specPhase, { name: 'quick-questions', allowedWritePaths: [] });
    const q = host.sessions[1]!.prompts[0]!;
    assert.match(q.text, /^Quick Spec: before any document is written/);
    const reqPrompt = host.sessions[2]!.prompts[0]!.text;
    assert.match(reqPrompt, /Clarifications from the user:\n1=a/);
    assert.match(host.sessions[2]!.prompts[0]!.extraContext![0]!, /\(quick\)/);
    assert.equal(readSpecConfig(specDir(w, 'quick-one'))?.specType, 'feature');
  } finally {
    w.cleanup();
  }
});

test('quick spec: a cancelled or failed questions turn ends the flow; no document turn runs (F3)', async () => {
  const cases: [string, { text?: string; stopReason: 'cancelled' | 'error'; isError?: boolean; error?: string }, string][] = [
    ['Ctrl+C', { text: '[1]: partial', stopReason: 'cancelled' }, 'interrupted'],
    ['usage limit', { stopReason: 'error', isError: true, error: 'usage limit reached' }, 'usage limit reached'],
  ];
  for (const [label, turn, message] of cases) {
    const { w, host, log } = setup({ override: (i) => (/^Quick Spec/.test(i.text) ? { ...turn } : undefined) });
    try {
      host.chooseAnswers = ['Approve tasks'];
      host.askAnswers = ['1=a'];
      const r = await createNewSpec(createReplRuntime(host, { openEditor: null }), { name: 'quick-one', kind: 'quick', description: 'CSV export' });
      assert.deepEqual(log.filter((t) => !/^Quick Spec/.test(t)), [], `${label}: turns after the failed questions turn`);
      assert.equal(r.status, 'error', label);
      assert.equal(r.message, message, label);
      assert.deepEqual(states(r), ['error'], label);
      assert.deepEqual(host.asked, [], `${label}: the answers are not asked for`);
      assert.equal(host.chosen.length, 0, label);
      assert.ok(host.text.includes(`✗ Quick Spec clarifying questions failed: ${message}`), host.text);
      assert.equal(fs.existsSync(path.join(specDir(w, 'quick-one'), 'requirements.md')), false, label);
    } finally {
      w.cleanup();
    }
  }
});

test("REPL runtime: Ctrl+C (the command signal) while a spec turn's phase session starts cancels that turn before it is sent (F0/F3)", async () => {
  for (const kind of ['quick', 'feature'] as const) {
    const { w, host, log } = setup();
    try {
      const ac = new AbortController();
      // the REPL's per-command signal (repl/core.ts ReplContext.commandSignal), read duck-typed
      Object.defineProperty(host, 'commandSignal', { get: () => ac.signal, configurable: true });
      const create = host.createSession.bind(host);
      // the press lands while the first phase session's Claude Code starts (the driver's fork)
      host.createSession = async (o) => {
        const s = await create(o);
        if (o.specPhase) ac.abort();
        return s;
      };
      const r = await createNewSpec(createReplRuntime(host, { openEditor: null }), { name: 'one', kind, description: 'CSV export' });
      assert.deepEqual(log, [], `${kind}: a turn was sent after the Ctrl+C`);
      assert.equal(r.status, 'error', kind);
      assert.equal(r.message, 'interrupted', kind);
      assert.ok(host.text.includes(kind === 'quick' ? '✗ Quick Spec clarifying questions failed: interrupted' : '✗ Drafting requirements.md failed: interrupted'), host.text);
      assert.deepEqual(host.asked, [], kind);
      assert.equal(host.chosen.length, 0, kind);
    } finally {
      w.cleanup();
    }
  }
  // a press handled by an earlier turn that completed anyway (the interrupt came too late) does
  // not cancel the turns after the user's own approval
  const ac = new AbortController();
  const { w, host, log } = setup({
    override: (i) => {
      if (/^Phase: REQUIREMENTS/.test(i.text)) ac.abort();
      return undefined;
    },
  });
  try {
    Object.defineProperty(host, 'commandSignal', { get: () => ac.signal, configurable: true });
    host.chooseAnswers = ['Approve and continue to design', 'Approve and continue to tasks', 'Approve tasks'];
    const r = await createNewSpec(createReplRuntime(host, { openEditor: null }), { name: 'todo-export', kind: 'feature', description: 'd' });
    assert.equal(r.status, 'ready', host.text);
    assert.equal(log.length, 3, log.join('\n'));
  } finally {
    w.cleanup();
  }
});

test('bugfix spec: bugfix.md → design → tasks with bugfix prompts', async () => {
  const { w, host } = setup();
  try {
    host.chooseAnswers = ['Approve and continue to design', 'Approve and continue to tasks', 'Approve tasks'];
    const r = await createNewSpec(createReplRuntime(host, { openEditor: null }), { name: 'fix-save', kind: 'bugfix', description: 'double save loses edits' });
    assert.equal(r.status, 'ready');
    assert.deepEqual(states(r).filter((s) => s.startsWith('drafting')), ['drafting:bugfix', 'drafting:design', 'drafting:tasks']);
    const dir = specDir(w, 'fix-save');
    assert.equal(readSpecConfig(dir)?.specType, 'bugfix');
    assert.ok(fs.existsSync(path.join(dir, 'bugfix.md')));
    assert.ok(!fs.existsSync(path.join(dir, 'requirements.md')));
    assert.equal(host.chosen[0]!.question, 'Does the bug analysis look good? If so, we can move on to the design.');
    assert.ok(host.chosen[0]!.options.includes('Analyze requirements'));
    assert.match(host.sessions[2]!.prompts[0]!.text, /^Phase: DESIGN \(bugfix\)/);
    assert.match(host.sessions[3]!.prompts[0]!.text, /^Phase: TASKS \(bugfix\)/);
  } finally {
    w.cleanup();
  }
});

test('design-first: design (detail level) → requirements (may append to design.md) → tasks', async () => {
  const { w, host } = setup();
  try {
    host.chooseAnswers = ['Approve and continue to requirements', 'Approve and continue to tasks', 'Approve tasks'];
    const r = await createNewSpec(createReplRuntime(host, { openEditor: null }), {
      name: 'df',
      kind: 'feature',
      workflowType: 'design-first',
      detail: 'low',
      description: 'd',
    });
    assert.equal(r.status, 'ready');
    const dir = specDir(w, 'df');
    assert.equal(readSpecConfig(dir)?.workflowType, 'design-first');
    assert.match(host.sessions[1]!.prompts[0]!.text, /^Detail level: LOW-LEVEL/);
    assert.deepEqual(host.created[1]!.specPhase!.allowedWritePaths, [path.join(dir, 'requirements.md'), path.join(dir, 'design.md')]);
    assert.equal(host.chosen[0]!.question, 'Does the design look good? If so, we can move on to the requirements.');
  } finally {
    w.cleanup();
  }
});

test('phase failures and missing documents', async () => {
  const fail = setup({ override: (i) => (i.text.startsWith('Phase: REQUIREMENTS') ? { isError: true, stopReason: 'error', error: 'Not logged in · Please run /login' } : undefined) });
  try {
    const r = await createNewSpec(createReplRuntime(fail.host, { openEditor: null }), { name: 'x', kind: 'feature', description: 'd' });
    assert.equal(r.status, 'error');
    assert.equal(r.message, 'Not logged in · Please run /login');
    assert.deepEqual(states(r), ['drafting:requirements', 'error:requirements']);
    assert.ok(fail.host.text.includes('✗ Drafting requirements.md failed: Not logged in · Please run /login'));
  } finally {
    fail.w.cleanup();
  }
  const missing = setup({ override: (i) => (i.text.startsWith('Phase: REQUIREMENTS') ? { text: 'I have questions first.' } : undefined) });
  try {
    missing.host.chooseAnswers = ['Stop here'];
    const r = await createNewSpec(createReplRuntime(missing.host, { openEditor: null }), { name: 'x', kind: 'feature', description: 'd' });
    assert.equal(r.status, 'stopped');
    assert.ok(missing.host.text.includes('⚠ requirements.md was not written'));
    assert.deepEqual(missing.host.chosen[0]!.options, ['Request changes…', 'Stop here (resume later with /spec x)']);
  } finally {
    missing.w.cleanup();
  }
  const cancelled = setup({ override: () => ({ stopReason: 'cancelled', isError: true }) });
  try {
    const r = await createNewSpec(createReplRuntime(cancelled.host, { openEditor: null }), { name: 'x', kind: 'feature', description: 'd' });
    assert.equal(r.message, 'interrupted');
  } finally {
    cancelled.w.cleanup();
  }
});

test('new: existing / invalid names are refused before any turn', async () => {
  const { w, host } = setup();
  try {
    writeSpec(w, 'todo-export', {});
    const rt = createReplRuntime(host, { openEditor: null });
    const r1 = await createNewSpec(rt, { name: 'todo-export', kind: 'feature', description: 'd' });
    assert.equal(r1.status, 'error');
    assert.ok(host.text.includes("Spec 'todo-export' already exists. Resume it with /spec todo-export"));
    const r2 = await createNewSpec(rt, { name: 'Bad Name', kind: 'feature', description: 'd' });
    assert.match(r2.message!, /Invalid spec name/);
    assert.equal(host.created.length, 0);
  } finally {
    w.cleanup();
  }
});

test('resume / approve / revise derive the state from files', async () => {
  const { w, host } = setup();
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD });
    const rt = createReplRuntime(host, { openEditor: null });
    // resume shows the pending requirements checkpoint first (no drafting)
    host.chooseAnswers = ['Stop here'];
    const r1 = await resumeSpec(rt, 'todo-export');
    assert.deepEqual(states(r1), ['review:requirements', 'stopped:requirements']);
    // approve drafts design, then shows its checkpoint
    host.chooseAnswers = ['Stop here'];
    const r2 = await approveSpec(rt, 'todo-export');
    assert.deepEqual(states(r2), ['approved:requirements', 'drafting:design', 'review:design', 'stopped:design']);
    assert.ok(fs.existsSync(path.join(specDir(w), 'design.md')));
    // revise targets the document under review
    host.chooseAnswers = ['Approve and continue to tasks', 'Approve tasks'];
    const r3 = await reviseSpec(rt, 'todo-export', 'add caching');
    assert.deepEqual(states(r3), ['revising:design', 'review:design', 'approved:design', 'drafting:tasks', 'review:tasks', 'approved:tasks', 'ready']);
    assert.ok(read(path.join(specDir(w), 'design.md')).includes('<!-- revised -->'));
    // with tasks written, approve just prints the ready hint
    const r4 = await approveSpec(rt, 'todo-export');
    assert.equal(r4.status, 'ready');
    // unknown spec
    const r5 = await resumeSpec(rt, 'nope');
    assert.equal(r5.status, 'error');
    assert.ok(host.text.includes("Spec 'nope' not found"));
    // nothing to approve yet / resume asks for a description
    writeSpec(w, 'empty', {});
    assert.equal((await approveSpec(rt, 'empty')).status, 'error');
    host.askAnswers = [''];
    assert.equal((await resumeSpec(rt, 'empty')).status, 'error');
    assert.match(host.asked[host.asked.length - 1]!, /What should the spec "empty" cover\?/);
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── non-interactive runtime over the driver ─────────────────────────────

interface HeadlessRig {
  rt: SpecRuntime;
  sessions: MockSession[];
  created: Partial<KiroSessionOptions>[];
  printed: string[];
  results: string[];
}

/** A CLI-like runtime: SpecSessionDriver over MockSessions, interactive false. */
function headless(w: Ws, script: ModelScript, opts: { maxParallel?: number; hooks?: ReturnType<typeof recordingHooks> } = {}): HeadlessRig {
  const sessions: MockSession[] = [];
  const created: Partial<KiroSessionOptions>[] = [];
  const printed: string[] = [];
  const results: string[] = [];
  let current: KiroSession | undefined;
  const run = async (s: KiroSession, input: PromptInput): Promise<TurnResult> => {
    const g = s.prompt(input);
    for (;;) {
      const n = await g.next();
      if (n.done) return n.value;
    }
  };
  const port: SessionPort = {
    active: () => current,
    create: async (o) => {
      created.push(o);
      const s = new MockSession({ ...o, interactive: false }, script);
      sessions.push(s);
      return s;
    },
    activate: (s) => {
      current = s;
    },
    run,
  };
  const driver = new SpecSessionDriver(port);
  const rt: SpecRuntime = {
    ws: w.ctx,
    interactive: false,
    commandPrefix: 'kiro-claude spec',
    maxParallelTasks: opts.maxParallel ?? 1,
    print: (t) => printed.push(t),
    result: (t) => results.push(t),
    ask: async () => '',
    confirm: async () => false,
    choose: async () => {
      throw new Error('choose in non-interactive runtime');
    },
    runSpecTurn: (i, p, o) => driver.runTurn(i, p, o),
    async openTaskSession(): Promise<TaskSessionHandle> {
      const s = await port.create({ origin: 'spec' });
      return { sessionId: s.id, run: (i) => run(s, i), interrupt: () => s.interrupt(), close: () => s.close() };
    },
    taskHooks: () => (opts.hooks ? { runner: opts.hooks, sessionId: 'orchestrator' } : undefined),
    readyHint: (n) => `Spec ready. Run all tasks: kiro-claude spec run ${n}`,
    finish: () => driver.finish('close'),
  };
  return { rt, sessions, created, printed, results };
}

test('headless: checkpoints stop after each phase unless auto-approved; driver closes its sessions', async () => {
  const w = makeWs();
  try {
    const a = headless(w, fakeModel());
    const r = await createNewSpec(a.rt, { name: 'todo-export', kind: 'feature', description: 'd' });
    assert.equal(r.status, 'stopped');
    assert.deepEqual(states(r), ['drafting:requirements', 'review:requirements', 'stopped:requirements']);
    assert.ok(a.printed.includes('requirements.md is waiting for review. Approve with: kiro-claude spec approve todo-export · Request changes: kiro-claude spec revise todo-export <feedback>'));
    assert.deepEqual(
      a.sessions.map((s) => s.closed),
      [true],
    );
    // approve in a later invocation: fresh conversation (no fork), next phase drafted, stops again
    const b = headless(w, fakeModel());
    const r2 = await approveSpec(b.rt, 'todo-export');
    assert.deepEqual(states(r2), ['approved:requirements', 'drafting:design', 'review:design', 'stopped:design']);
    assert.equal(b.created[0]!.fork, undefined);
    // auto-approve runs everything
    const c = headless(w, fakeModel());
    const r3 = await approveSpec(c.rt, 'todo-export', { autoApprove: true });
    assert.equal(r3.status, 'ready');
    assert.ok(c.printed.includes('Spec ready. Run all tasks: kiro-claude spec run todo-export'));
    const d = headless(w, fakeModel());
    const r4 = await createNewSpec(d.rt, { name: 'auto', kind: 'quick', description: 'x', autoApprove: true });
    assert.equal(r4.status, 'ready');
    // non-interactive quick spec skips the questions turn and says so
    assert.match(d.sessions[0]!.prompts[0]!.text, /^Phase: REQUIREMENTS/);
    assert.match(d.sessions[0]!.prompts[0]!.text, /non-interactive run/);
    assert.deepEqual(
      d.sessions.map((s) => s.closed),
      [true, true, true],
    );
  } finally {
    w.cleanup();
  }
});

test('SpecSessionDriver: reuses the phase session for the same restriction, forks on change', async () => {
  const w = makeWs();
  try {
    const rig = headless(w, () => ({ text: 'ok' }));
    const p1 = { name: 'requirements', allowedWritePaths: ['/a'] };
    await rig.rt.runSpecTurn({ text: 'one' }, p1);
    await rig.rt.runSpecTurn({ text: 'two' }, { ...p1, allowedWritePaths: ['/a'] });
    assert.equal(rig.sessions.length, 1);
    await rig.rt.runSpecTurn({ text: 'three' }, { name: 'design', allowedWritePaths: ['/b'] });
    assert.equal(rig.sessions.length, 2);
    assert.equal(rig.sessions[0]!.closed, true);
    assert.equal(rig.created[1]!.fork!.fromClaudeSessionId, rig.sessions[0]!.claudeSessionId);
    await rig.rt.finish();
    assert.equal(rig.sessions[1]!.closed, true);
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── task execution ─────────────────────────────

test('run: required tasks in plan order, fresh child session per task, [-] while running, [x] after', async () => {
  const boxesAtStart: Record<string, string> = {};
  let file = '';
  const { w, host } = setup({
    override: (i) => {
      const m = /Execute Task: (\S+)/.exec(i.text);
      if (m) boxesAtStart[m[1]!] = parseTasks(read(file)).byId.get(m[1]!)!.box;
      return undefined;
    },
  });
  try {
    const dir = writeFull(w);
    file = path.join(dir, 'tasks.md');
    const original = host.session;
    const rt = createReplRuntime(host, { openEditor: null });
    const r = await runSpecTasks(rt, 'todo-export', { kind: 'scope', includeOptional: false });
    assert.equal(r.status, 'completed');
    assert.deepEqual(
      r.outcomes.map((o) => [o.id, o.status]),
      [
        ['1.1', 'completed'],
        ['2.1', 'completed'],
        ['3', 'completed'],
      ],
    );
    assert.deepEqual(boxesAtStart, { '1.1': '-', '2.1': '-', '3': '-' });
    const t = parseTasks(read(file));
    assert.deepEqual(
      ['1.1', '1.2', '1', '2.1', '3'].map((id) => t.byId.get(id)!.box),
      ['x', ' ', ' ', 'x', 'x'],
    );
    assert.equal(r.remainingRequired, 0);
    // one fresh session per task (no specPhase, no fork), each closed; REPL session restored
    assert.deepEqual(host.created, [{ origin: 'spec' }, { origin: 'spec' }, { origin: 'spec' }]);
    assert.ok(host.sessions.slice(1).every((s) => s.closed && s.prompts.length === 1));
    assert.equal(host.session, original);
    const p = host.sessions[1]!.prompts[0]!;
    assert.match(p.text, /^Execute Task: 1\.1 Create `src\/export\.ts` with `toCsv\(todos\)`\n/);
    assert.match(p.text, /_Requirements: 1\.1, 1\.2_/);
    assert.match(p.extraContext![0]!, /^<spec name="todo-export"/);
    assert.match(host.sessions[3]!.prompts[0]!.text, /This is a CHECKPOINT/);
    assert.ok(host.text.includes('Running 3 tasks of todo-export: 1.1, 2.1, 3'));
    assert.ok(host.text.includes('✓ Task 1.1 completed'));
    assert.ok(host.text.includes('Spec run finished: 3 completed. 0 required tasks remain.'));
  } finally {
    w.cleanup();
  }
});

test('run: stops at the first failure and reverts the box; later tasks do not run', async () => {
  const cases: [string, FakeModelOptions['taskText'], string, string | undefined][] = [
    ['blocked', { '2.1': 'Cannot.\nTASK_RESULT: blocked - no database' }, 'blocked', 'no database'],
    ['no sentinel', { '2.1': 'I think it is done.' }, 'failed', 'the task session ended without a TASK_RESULT line'],
    ['error', { '2.1': { isError: true, stopReason: 'error', error: 'overloaded' } }, 'failed', 'overloaded'],
    ['max turns', { '2.1': { stopReason: 'max_turns', text: 'TASK_RESULT: completed' } }, 'failed', 'the turn hit the maximum number of turns'],
    ['interrupted', { '2.1': { stopReason: 'cancelled', isError: true } }, 'interrupted', undefined],
  ];
  for (const [label, taskText, status, reason] of cases) {
    const { w, host } = setup({ taskText });
    try {
      const dir = writeFull(w);
      const r = await runSpecTasks(createReplRuntime(host, { openEditor: null }), 'todo-export', { kind: 'scope', includeOptional: false });
      assert.equal(r.status, 'stopped', label);
      assert.deepEqual(
        r.outcomes.map((o) => [o.id, o.status, o.reason]),
        [
          ['1.1', 'completed', undefined],
          ['2.1', status, reason],
        ],
        label,
      );
      const t = parseTasks(read(path.join(dir, 'tasks.md')));
      assert.equal(t.byId.get('2.1')!.box, ' ', label);
      assert.equal(t.byId.get('3')!.box, ' ', label);
      assert.ok(host.text.includes('Continue with /spec run todo-export'), label);
      assert.equal(r.remainingRequired, 2, label);
    } finally {
      w.cleanup();
    }
  }
});

test('run: PreTaskExec/PostTaskExec hooks — payload, agent prompts, follow-up turn, block ⇒ skip', async () => {
  const hooks = recordingHooks({ block: (id) => (id === '1.1' ? 'lint first' : undefined), preAgentPrompts: ['Read CONTRIBUTING.md first.'], postAgentPrompts: ['Verify spec alignment.'] });
  const { w, host } = setup({}, { hooks: ['PreTaskExec', 'PostTaskExec'] });
  try {
    const dir = writeFull(w);
    const rt = createReplRuntime(host, { openEditor: null, hookRunnerFactory: () => hooks });
    const r = await runSpecTasks(rt, 'todo-export', { kind: 'ids', ids: ['1.1', '2.1'] });
    assert.deepEqual(
      r.outcomes.map((o) => [o.id, o.status]),
      [
        ['1.1', 'skipped'],
        ['2.1', 'completed'],
      ],
    );
    assert.deepEqual(
      hooks.calls.map((c) => [c.trigger, c.task.taskId, c.task.status]),
      [
        ['PreTaskExec', '1.1', undefined],
        ['PreTaskExec', '2.1', undefined],
        ['PostTaskExec', '2.1', 'completed'],
      ],
    );
    assert.deepEqual(hooks.calls[1]!.task, { specName: 'todo-export', taskId: '2.1', title: 'Quote special characters in `src/export.ts`', specDir: dir, optional: false });
    assert.equal(hooks.calls[0]!.sessionId, host.session.id);
    assert.equal(parseTasks(read(path.join(dir, 'tasks.md'))).byId.get('1.1')!.box, ' ', 'blocked task keeps its box');
    assert.ok(host.text.includes('⏭ Task 1.1 skipped: PreTaskExec hook blocked it: lint first'));
    assert.ok(host.text.includes('hook warning for 1.1'));
    // only one task session (2.1): pre prompt prepended, post prompt as a follow-up turn before close
    const s = host.sessions[1]!;
    assert.equal(host.sessions.length, 2);
    assert.match(s.prompts[0]!.text, /^Read CONTRIBUTING\.md first\.\n\nExecute Task: 2\.1/);
    assert.equal(s.prompts[1]!.text, 'Verify spec alignment.');
    assert.equal(s.closed, true);
    assert.equal(r.status, 'completed');
    // a run without task hooks configured never builds a runner
    const { w: w2, host: h2 } = setup();
    try {
      writeFull(w2);
      let built = 0;
      await runSpecTasks(createReplRuntime(h2, { openEditor: null, hookRunnerFactory: () => (built++, hooks) }), 'todo-export', { kind: 'next' });
      assert.equal(built, 0);
    } finally {
      w2.cleanup();
    }
  } finally {
    w.cleanup();
  }
});

test('run: next / explicit ids / optional scope / nothing to do / unknown ids', async () => {
  const { w, host } = setup();
  try {
    writeFull(w);
    const rt = createReplRuntime(host, { openEditor: null });
    const r1 = await runSpecTasks(rt, 'todo-export', { kind: 'next' });
    assert.deepEqual(r1.outcomes.map((o) => o.id), ['1.1']);
    const r2 = await runSpecTasks(rt, 'todo-export', { kind: 'scope', includeOptional: true });
    assert.deepEqual(r2.outcomes.map((o) => o.id), ['1.2', '2.1', '2.2', '3']);
    const t = parseTasks(read(path.join(specDir(w), 'tasks.md')));
    assert.ok(t.tasks.every((x) => x.box === 'x'), 'parents rolled up');
    const r3 = await runSpecTasks(rt, 'todo-export', { kind: 'scope', includeOptional: false });
    assert.equal(r3.status, 'nothing');
    assert.ok(host.text.includes('No remaining required tasks.'));
    const r4 = await runSpecTasks(rt, 'todo-export', { kind: 'ids', ids: ['9.9'] });
    assert.equal(r4.status, 'error');
    assert.ok(host.text.includes('Unknown task id: 9.9'));
    writeSpec(w, 'no-tasks', { requirements: REQ_MD });
    assert.equal((await runSpecTasks(rt, 'no-tasks', { kind: 'next' })).status, 'error');
  } finally {
    w.cleanup();
  }
});

test('run: tasks of one wave run concurrently up to maxParallelTasks; checkpoints alone', async () => {
  const w = makeWs();
  try {
    writeFull(w);
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const script: ModelScript = async (i) => {
      const id = /Execute Task: (\S+)/.exec(i.text)![1]!;
      running++;
      peak = Math.max(peak, running);
      order.push(`start ${id}`);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      order.push(`end ${id}`);
      return { text: 'TASK_RESULT: completed' };
    };
    const rig = headless(w, script, { maxParallel: 2 });
    const r = await runSpecTasks(rig.rt, 'todo-export', { kind: 'scope', includeOptional: true });
    assert.equal(r.status, 'completed');
    assert.equal(peak, 2);
    assert.deepEqual(order.slice(0, 2), ['start 1.1', 'start 1.2']);
    assert.ok(order.indexOf('start 3') > order.indexOf('end 2.2'), 'checkpoint after the wave');
    assert.ok(rig.results.some((t) => t.startsWith('Spec run finished: 5 completed.')));
  } finally {
    w.cleanup();
  }
});

test('run: abort signal stops scheduling and interrupts running task sessions', async () => {
  const w = makeWs();
  try {
    const dir = writeFull(w);
    const ac = new AbortController();
    const script: ModelScript = async () => {
      ac.abort();
      await new Promise((r) => setTimeout(r, 5));
      return { stopReason: 'cancelled', isError: true };
    };
    const rig = headless(w, script);
    const r = await runSpecTasks(rig.rt, 'todo-export', { kind: 'scope', includeOptional: false }, { signal: ac.signal });
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.status]), [['1.1', 'interrupted']]);
    assert.equal(rig.sessions[0]!.interrupted, 1);
    assert.equal(parseTasks(read(path.join(dir, 'tasks.md'))).byId.get('1.1')!.box, ' ');
  } finally {
    w.cleanup();
  }
});

test('resume in execution phase: step through tasks', async () => {
  const { w, host } = setup();
  try {
    writeFull(w);
    host.chooseAnswers = ['Run next task: 1.1'];
    const rt = createReplRuntime(host, { openEditor: null });
    const r = await resumeSpec(rt, 'todo-export');
    assert.equal(r.status, 'ready');
    assert.deepEqual(host.chosen[0]!.options, [
      'Run next task: 1.1 Create `src/export.ts` with `toCsv(todos)`',
      'Run all remaining required tasks',
      'Run all remaining tasks (include optional *)',
      'Select tasks…',
      'Review tasks.md (checkpoint)',
      'Stop',
    ]);
    assert.equal(parseTasks(read(path.join(specDir(w), 'tasks.md'))).byId.get('1.1')!.box, 'x');
    host.chooseAnswers = ['Stop'];
    assert.equal((await resumeSpec(rt, 'todo-export')).status, 'stopped');
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── analyze / sync ─────────────────────────────

const FINDINGS = JSON.stringify({
  findings: [
    { id: 'F1', category: 'ambiguity', requirements: ['1.1'], explanation: 'Row order unspecified.', question: 'Which order?', options: [{ label: 'By creation date', edit: 'WHEN exporting, THE Exporter SHALL order rows by creation date' }], severity: 'medium' },
    { id: 'F2', category: 'edge_case', requirements: ['2.1'], explanation: 'Empty titles.', question: 'Allow empty titles?', options: [{ label: 'Yes', edit: 'x' }], severity: 'low' },
  ],
});

test('analyze: read-only analysis turn, Question i/N, answers applied in one write turn', async () => {
  const { w, host } = setup({ analysis: `\`\`\`json\n${FINDINGS}\n\`\`\`` });
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD });
    host.chooseAnswers = ['By creation date', 'Dismiss (intentional)'];
    const r = await analyzeRequirements(createReplRuntime(host, { openEditor: null }), 'todo-export');
    assert.equal(r.status, 'applied');
    assert.equal(r.findings.length, 2);
    assert.deepEqual(r.answers.map((a) => [a.finding.id, a.resolution]), [['F1', 'WHEN exporting, THE Exporter SHALL order rows by creation date']]);
    const file = path.join(specDir(w), 'requirements.md');
    assert.deepEqual(host.created[0]!.specPhase, { name: 'analyze', allowedWritePaths: [] });
    assert.deepEqual(host.created[1]!.specPhase, { name: 'requirements', allowedWritePaths: [file] });
    assert.ok(host.text.includes('Question 1/2 · ambiguity · medium · requirements 1.1'));
    assert.deepEqual(host.chosen[0]!.options, ['By creation date', 'Other (type answer)', 'Dismiss (intentional)']);
    assert.match(host.sessions[2]!.prompts[0]!.text, /Resolution: WHEN exporting, THE Exporter SHALL order rows by creation date/);
    assert.ok(read(file).includes('SHALL use UTF-8'));
    assert.ok(host.text.includes('requirements.md updated (4 criteria)'));
  } finally {
    w.cleanup();
  }
});

test('analyze: none / parse error / non-interactive report / auto-apply / other answer', async () => {
  const w = makeWs();
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD });
    const none = headless(w, fakeModel({ analysis: '{"findings":[]}' }));
    assert.equal((await analyzeRequirements(none.rt, 'todo-export')).status, 'none');
    assert.deepEqual(none.results, ['No issues found in requirements.md.']);
    const bad = headless(w, fakeModel({ analysis: 'sorry' }));
    assert.equal((await analyzeRequirements(bad.rt, 'todo-export')).status, 'error');
    const rep = headless(w, fakeModel({ analysis: FINDINGS }));
    const r = await analyzeRequirements(rep.rt, 'todo-export');
    assert.equal(r.status, 'reported');
    assert.match(rep.results[0]!, /^Question 1\/2 · ambiguity · medium · requirements 1\.1\nRow order unspecified\.\n\? Which order\?\n {2}a\. By creation date — WHEN exporting/);
    assert.equal(rep.sessions.length, 1, 'no write turn');
    const auto = headless(w, fakeModel({ analysis: FINDINGS }));
    const ra = await analyzeRequirements(auto.rt, 'todo-export', { autoApply: true });
    assert.equal(ra.status, 'applied');
    assert.equal(ra.answers.length, 2);
    assert.equal((await analyzeRequirements(auto.rt, 'missing')).status, 'error');
  } finally {
    w.cleanup();
  }
  const o = setup({ analysis: FINDINGS });
  try {
    writeSpec(o.w, 'todo-export', { requirements: REQ_MD });
    o.host.chooseAnswers = ['Other (type answer)', undefined];
    o.host.askAnswers = ['Order by title'];
    const r = await analyzeRequirements(createReplRuntime(o.host, { openEditor: null }), 'todo-export');
    assert.deepEqual(r.answers.map((a) => a.resolution), ['Order by title']);
  } finally {
    o.w.cleanup();
  }
});

test('analyze from the requirements checkpoint, then approve', async () => {
  const { w, host } = setup({ analysis: '{"findings":[]}' });
  try {
    host.chooseAnswers = ['Analyze requirements', 'Stop here'];
    const r = await createNewSpec(createReplRuntime(host, { openEditor: null }), { name: 'todo-export', kind: 'feature', description: 'd' });
    assert.deepEqual(states(r), ['drafting:requirements', 'review:requirements', 'analyzing:requirements', 'review:requirements', 'stopped:requirements']);
    assert.ok(host.text.includes('No issues found in requirements.md.'));
  } finally {
    w.cleanup();
  }
});

test('sync: one turn restricted to tasks.md, status diff reported', async () => {
  const { w, host } = setup();
  try {
    const dir = writeFull(w);
    const r = await syncSpec(createReplRuntime(host, { openEditor: null }), 'todo-export');
    assert.deepEqual(r, { status: 'ok', changes: ['1.1: [ ] → [x]'] });
    assert.deepEqual(host.created[0]!.specPhase, { name: 'tasks', allowedWritePaths: [path.join(dir, 'tasks.md')] });
    assert.match(host.sessions[1]!.prompts[0]!.text, /^Compare .*tasks\.md with the current code/);
  } finally {
    w.cleanup();
  }
});

test('turnFailure table', () => {
  const base: TurnResult = { stopReason: 'end_turn', isError: false, text: '', permissionDenials: [] };
  assert.equal(turnFailure(base), undefined);
  assert.equal(turnFailure({ ...base, stopReason: 'cancelled', isError: true }), 'interrupted');
  assert.equal(turnFailure({ ...base, isError: true, error: 'x' }), 'x');
  assert.equal(turnFailure({ ...base, stopReason: 'error' }), 'the turn ended with an error');
  assert.equal(turnFailure({ ...base, stopReason: 'refusal' }), 'the model refused the request');
  // C20: never Claude's own "Please run /login" advice
  assert.equal(turnFailure({ ...base, isError: true, authError: true, error: 'Not logged in · Please run /login' }), 'you are not logged in to Claude Code (run kiro-claude login)');
});

test('tasks.md written by a phase turn is normalized', async () => {
  const broken = TASKS_MD.replace('- [ ] 2. Implement escaping', '* [ ] 2. Implement escaping');
  const { w, host } = setup({ tasks: broken });
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD });
    host.chooseAnswers = ['Approve tasks'];
    await approveSpec(createReplRuntime(host, { openEditor: null }), 'todo-export');
    assert.equal(read(path.join(specDir(w), 'tasks.md')), TASKS_MD);
    assert.ok(host.text.includes('Repaired tasks.md formatting (1 line)'));
  } finally {
    w.cleanup();
  }
});

test('session start failures are reported as phase errors; finish falls back to the original session', async () => {
  const { w, host } = setup();
  try {
    const original = host.session;
    let calls = 0;
    host.createSession = async () => {
      calls++;
      throw new Error('Claude Code CLI not found');
    };
    const r = await createNewSpec(createReplRuntime(host, { openEditor: null }), { name: 'todo-export', kind: 'feature', description: 'd' });
    assert.equal(r.status, 'error');
    assert.equal(r.message, 'Claude Code CLI not found');
    assert.ok(host.text.includes('✗ Drafting requirements.md failed: Claude Code CLI not found'));
    assert.equal(host.session, original);
    assert.equal(calls, 1);
  } finally {
    w.cleanup();
  }
  const b = setup();
  try {
    const original = b.host.session as MockSession;
    const realCreate = b.host.createSession.bind(b.host);
    let n = 0;
    b.host.createSession = async (o) => {
      if (++n === 2) throw new Error('fork failed');
      return realCreate(o);
    };
    b.host.chooseAnswers = ['Stop here'];
    const r = await createNewSpec(createReplRuntime(b.host, { openEditor: null }), { name: 'todo-export', kind: 'feature', description: 'd' });
    assert.equal(r.status, 'stopped');
    assert.equal(b.host.session, original, 'continuation fork failed ⇒ original active again');
    assert.equal(original.closed, false);
    assert.equal(b.host.sessions[1]!.closed, true, 'restricted phase session closed');
  } finally {
    b.w.cleanup();
  }
});
