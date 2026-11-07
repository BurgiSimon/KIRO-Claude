/**
 * Fourth review round, spec half (r4-findings #0/#7, #2, #3, #8). Unit level, over the spec test
 * doubles (MockHost / MockSession, a SpecRuntime rig); the same defects end to end through the real
 * runRepl and the fake claude are in test/repl/spec-r4-*.test.ts.
 *
 *  - #0/#7: a /spec flow started in plan mode hands the chat a continuation that is in plan mode
 *    again (the phase sessions run without it: they must write the spec documents).
 *  - #2: `/spec run` passes its signal (Ctrl+C) to a task's PreTaskExec / PostTaskExec hooks; a
 *    press during PreTaskExec opens no task session; a PostTaskExec after an interrupt still runs.
 *  - #3: task sessions (and the driver's phase sessions and continuation) are created under the
 *    command's start signal (session/startSignal.ts, K3): a press while one runs its agentSpawn
 *    hooks cancels that start, reported as `interrupted`, never as `failed`.
 *  - #8: a second flow started from the continuation a first flow handed over forks with that
 *    continuation (the session the user is in) as the parent record, at the same fork point.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { CliContext, HookRunnerLike, KiroSession, KiroSessionOptions, PromptInput, TurnResult } from '../../src/types.js';
import { runSpecCommandWith } from '../../src/spec/cli.js';
import { parseTasks } from '../../src/spec/model.js';
import { currentStartSignal, SessionStartCancelledError } from '../../src/session/startSignal.js';
import {
  SpecSessionDriver,
  createNewSpec,
  createReplRuntime,
  resumeSpec,
  runSpecTasks,
  type SessionPort,
  type SpecRuntime,
  type TaskSessionHandle,
} from '../../src/spec/workflow.js';
import { DESIGN_MD, MockHost, MockSession, REQ_MD, TASKS_MD, fakeModel, makeWs, mockSettings, read, taskHook, writeSpec, type FakeModelOptions, type Ws } from './helpers.js';

class Capture extends Writable {
  data = '';
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += chunk.toString();
    cb();
  }
}

const MAIN_LINE = 'remember PELICAN';
const REQ = /^Phase: REQUIREMENTS/;

function setup(o: FakeModelOptions = {}, opts: { hooks?: ('PreTaskExec' | 'PostTaskExec')[] } = {}): { w: Ws; host: MockHost } {
  const w = makeWs();
  const host = new MockHost(w.ctx, fakeModel(o), opts.hooks ? { hooks: opts.hooks.map(taskHook) } : {});
  return { w, host };
}

const rtOf = (host: MockHost): SpecRuntime => createReplRuntime(host, { openEditor: null });
const FEATURE = (rt: SpecRuntime, name = 'todo-export'): ReturnType<typeof createNewSpec> => createNewSpec(rt, { name, kind: 'feature', description: 'Export todos as CSV' });

/** The REPL's per-command Ctrl+C signal (read duck-typed by createReplRuntime); `press()` aborts it. */
function commandSignal(host: MockHost): { press(): void; readonly signal: AbortSignal } {
  const ac = new AbortController();
  Object.defineProperty(host, 'commandSignal', { get: () => ac.signal, configurable: true });
  return { press: () => ac.abort(), signal: ac.signal };
}

/** Plan mode of every session the host activates, at the moment it is activated. */
function recordActivations(host: MockHost): { s: KiroSession; plan: boolean }[] {
  const seen: { s: KiroSession; plan: boolean }[] = [];
  const replace = host.replaceSession.bind(host);
  host.replaceSession = (s: KiroSession) => {
    seen.push({ s, plan: s.planMode });
    replace(s);
  };
  return seen;
}

// ──────────────────────── #0 / #7: plan mode survives a /spec flow ────────────────────────

test('R4 #0/#7: a /spec flow started in plan mode hands the chat a continuation in plan mode; the phase sessions run without it', async () => {
  const cases: { label: string; choose: string[]; override?: FakeModelOptions['override'] }[] = [
    { label: 'stopped at the requirements checkpoint', choose: ['Stop here'] },
    { label: 'every checkpoint approved', choose: ['Approve and continue to design', 'Approve and continue to tasks', 'Approve tasks'] },
    {
      label: 'a drafting turn Claude answered with an error',
      choose: [],
      override: (i) => (REQ.test(i.text) ? { stopReason: 'error', isError: true, error: 'usage limit reached' } : undefined),
    },
  ];
  for (const k of cases) {
    const turns: { phase: string | undefined; plan: boolean }[] = [];
    const { w, host } = setup({
      override: (i, s) => {
        turns.push({ phase: s.currentPhase?.name, plan: s.planMode });
        return k.override?.(i, s);
      },
    });
    try {
      const original = host.session as MockSession;
      original.planMode = true;
      await host.runTurn({ text: MAIN_LINE });
      host.chooseAnswers = [...k.choose];
      const activations = recordActivations(host);
      await FEATURE(rtOf(host));
      const cur = host.session as MockSession;
      assert.notEqual(cur, original, `${k.label}: a turn reached Claude, so the chat continues in the continuation`);
      assert.equal(cur.closed, false, k.label);
      assert.equal(cur.planMode, true, `${k.label}: the continuation lost the chat's plan mode`);
      assert.equal(activations.at(-1)?.s, cur, k.label);
      assert.equal(activations.at(-1)?.plan, true, `${k.label}: the continuation was handed to the chat before its plan mode was set`);
      const phaseTurns = turns.filter((t) => t.phase !== undefined);
      assert.ok(phaseTurns.length > 0, k.label);
      assert.deepEqual(
        phaseTurns.filter((t) => t.plan),
        [],
        `${k.label}: a phase session ran in plan mode (it could not write its document)`,
      );
      if (!k.override) assert.ok(fs.existsSync(path.join(w.specs, 'todo-export', 'requirements.md')), `${k.label}: the phase session could not write`);
      for (const s of host.sessions) if (s.opts.specPhase) assert.equal(s.planMode, false, `${k.label}: phase session ${s.id} in plan mode`);
    } finally {
      w.cleanup();
    }
  }
});

test('R4 #0/#7: plan mode off before the flow stays off; a second flow from a plan-mode continuation keeps plan mode', async () => {
  const { w, host } = setup();
  try {
    await host.runTurn({ text: MAIN_LINE });
    host.chooseAnswers = ['Stop here'];
    await FEATURE(rtOf(host), 'spec-one');
    assert.equal(host.session.planMode, false, 'the continuation of a chat without plan mode is not put in plan mode');
    // /plan in the continuation, then a second flow from it
    host.session.planMode = true;
    const cont = host.session;
    host.chooseAnswers = ['Stop here'];
    await FEATURE(rtOf(host), 'spec-two');
    assert.notEqual(host.session, cont);
    assert.equal(host.session.planMode, true, 'the second continuation lost plan mode');
    assert.equal((cont as MockSession).closed, true);
  } finally {
    w.cleanup();
  }
});

test('R4 #0/#7: flows that hand the chat its own session back keep its plan mode (nothing reached Claude, continuation fork failed, finish close)', async () => {
  // a press while the first phase session starts: no spec turn reaches Claude
  {
    const { w, host } = setup();
    try {
      const original = host.session as MockSession;
      original.planMode = true;
      await host.runTurn({ text: MAIN_LINE });
      const cmd = commandSignal(host);
      const create = host.createSession.bind(host);
      host.createSession = async (o) => {
        const s = await create(o);
        cmd.press();
        return s;
      };
      const r = await FEATURE(rtOf(host));
      assert.equal(r.status, 'error');
      assert.equal(host.session, original);
      assert.equal(original.closed, false);
      assert.equal(host.session.planMode, true);
    } finally {
      w.cleanup();
    }
  }
  // the continuation fork fails: the chat gets its original back
  {
    const { w, host } = setup();
    try {
      const original = host.session as MockSession;
      original.planMode = true;
      await host.runTurn({ text: MAIN_LINE });
      const create = host.createSession.bind(host);
      let n = 0;
      host.createSession = async (o) => {
        if (++n === 2) throw new Error('fork failed');
        return create(o);
      };
      host.chooseAnswers = ['Stop here'];
      await FEATURE(rtOf(host));
      assert.equal(host.session, original);
      assert.equal(host.session.planMode, true);
    } finally {
      w.cleanup();
    }
  }
  // finish('close') (the CLI's mode) never hands anything over
  {
    const main = new MockSession({ origin: 'repl' }, () => ({ text: 'ok' }));
    main.planMode = true;
    let current: KiroSession = main;
    const made: MockSession[] = [];
    const port: SessionPort = {
      active: () => current,
      create: async (o) => {
        const s = new MockSession(o, () => ({ text: 'ok' }));
        made.push(s);
        return s;
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
    await d.runTurn({ text: 'a' }, { name: 'requirements', allowedWritePaths: ['/a'] });
    assert.equal(made[0]!.planMode, false, 'the phase session runs without plan mode');
    await d.finish('close');
    assert.equal(current, main);
    assert.equal(main.planMode, true);
    assert.equal(made[0]!.closed, true);
  }
});

// ──────────────────────── #8: a second flow from a handed-over continuation ────────────────────────

test("R4 #8: a second /spec flow from the continuation a first flow handed over forks with the continuation as the parent record (same fork point)", async () => {
  const { w, host } = setup();
  try {
    await host.runTurn({ text: MAIN_LINE });
    host.chooseAnswers = ['Stop here'];
    await FEATURE(rtOf(host), 'spec-one');
    const p1 = host.sessions.find((s) => s.opts.specPhase?.name === 'requirements')!;
    const cont = host.session as MockSession;
    assert.equal(cont.prompts.length, 0, 'precondition: the continuation has no message of its own');
    const n = host.created.length;
    host.chooseAnswers = ['Stop here'];
    await FEATURE(rtOf(host), 'spec-two');
    const phase2 = host.created[n]!;
    assert.equal(phase2.specPhase?.name, 'requirements');
    assert.equal(phase2.fork?.fromClaudeSessionId, p1.claudeSessionId, 'the fork still starts where the continuation starts (it has no transcript)');
    assert.equal(phase2.fork?.parentId, cont.id, "the parent record is the session the user is in (its carry, context rules), not the first flow's phase session");
    assert.deepEqual(host.lostForks, []);
    // the second continuation forks from the second phase session (which got its turn)
    const p2 = host.sessions.find((s) => s.opts === phase2)!;
    assert.equal(host.created[n + 1]!.fork?.parentId, p2.id);
    assert.equal(host.created[n + 1]!.fork?.fromClaudeSessionId, p2.claudeSessionId);
    // the same through /spec <name> (approve at the checkpoint) and with a turn in between
    const cont2 = host.session as MockSession;
    const m = host.created.length;
    host.chooseAnswers = ['Approve and continue to design', 'Stop here'];
    await resumeSpec(rtOf(host), 'spec-two');
    assert.equal(host.created[m]!.fork?.parentId, cont2.id);
    assert.equal(host.created[m]!.fork?.fromClaudeSessionId, p2.claudeSessionId);
  } finally {
    w.cleanup();
  }
});

test('R4 #8: what the user added to the handed-over continuation (a merged carry, a context rule) reaches the next flow and its continuation', async () => {
  const { w, host } = setup();
  try {
    // model create({fork}) (session/kiroSession.ts, K1): a fork's record is built from its PARENT record
    const create = host.createSession.bind(host);
    host.createSession = async (o) => {
      const s = (await create(o)) as MockSession;
      const parent = o.fork?.parentId ? host.sessions.find((x) => x.id === o.fork!.parentId) : undefined;
      if (parent) {
        s.record.contextRules = [...parent.record.contextRules];
        if (parent.record.pendingContext?.length) s.record.pendingContext = [...parent.record.pendingContext];
      }
      return s;
    };
    await host.runTurn({ text: MAIN_LINE });
    host.chooseAnswers = ['Stop here'];
    await FEATURE(rtOf(host), 'spec-one');
    const cont = host.session as MockSession;
    // /tangent merge and /context add in the continuation (no message of its own yet)
    cont.record.pendingContext = ['<tangent-summary>ZEBRA</tangent-summary>'];
    cont.record.contextRules = [{ rule: 'notes.md', origin: 'session' }];
    host.chooseAnswers = ['Stop here'];
    await FEATURE(rtOf(host), 'spec-two');
    const after = host.session as MockSession;
    assert.notEqual(after, cont);
    const phase2 = host.sessions.find((s) => s.opts.specPhase?.name === 'requirements' && s.opts.fork?.parentId === cont.id);
    assert.ok(phase2, `the second flow's phase session was not forked with the continuation as parent: ${JSON.stringify(host.created.map((c) => c.fork))}`);
    assert.deepEqual(phase2.record.pendingContext, ['<tangent-summary>ZEBRA</tangent-summary>']);
    assert.deepEqual(after.record.contextRules.map((r) => r.rule), ['notes.md'], 'the context rule is gone after the second flow');
  } finally {
    w.cleanup();
  }
});

// ──────────────────────── #2 / #3: /spec run Ctrl+C at hooks and session starts ────────────────────────

const ok = (text: string): TurnResult => ({ stopReason: 'end_turn', isError: false, text, permissionDenials: [] });
const boxOf = (dir: string, id: string): string => parseTasks(read(path.join(dir, 'tasks.md'))).byId.get(id)!.box;

interface HookCall {
  trigger: 'PreTaskExec' | 'PostTaskExec';
  taskId: string;
  status: string | undefined;
  /** The call got a signal that had not fired yet. */
  live: boolean;
  end?: 'killed' | 'finished';
}

/**
 * A task-hook runner whose `hang` triggers model a command hook that runs `hangMs` (timeout 0 in
 * practice: until killed); `ctx.signal` kills it like runShell does (aborted ⇒ no output, no
 * warning, no block, no agent prompt).
 */
function hangingHooks(hang: readonly string[], o: { hangMs?: number; onStart?: (c: HookCall) => void; postAgentPrompts?: string[] } = {}): HookRunnerLike & { calls: HookCall[] } {
  const calls: HookCall[] = [];
  const none = { warnings: [] };
  return {
    calls,
    hooks: [],
    runSessionStart: async () => ({ outputs: [], agentPrompts: [], warnings: [] }),
    runUserPromptSubmit: async () => ({ outputs: [], agentPrompts: [], warnings: [] }),
    runPreToolUse: async () => ({ blocked: false, warnings: [] }),
    runPostToolUse: async () => none,
    runStop: async () => none,
    runSessionEnd: async () => none,
    runFileHook: async () => none,
    runManual: async () => ({ found: false, warnings: [] }),
    async runTaskHook(ctx, trigger, task) {
      const c: HookCall = { trigger, taskId: task.taskId, status: (task as { status?: string }).status, live: !!ctx.signal && !ctx.signal.aborted };
      calls.push(c);
      if (ctx.signal?.aborted) {
        c.end = 'killed';
        return { blocked: false, agentPrompts: [], warnings: [] };
      }
      o.onStart?.(c);
      if (hang.includes(trigger)) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            c.end = 'finished';
            resolve();
          }, o.hangMs ?? 2000);
          ctx.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              c.end = 'killed';
              resolve();
            },
            { once: true },
          );
        });
      } else c.end = 'finished';
      const prompts = trigger === 'PostTaskExec' && c.end === 'finished' ? o.postAgentPrompts ?? [] : [];
      return { blocked: false, agentPrompts: prompts, warnings: [] };
    },
  };
}

interface Rig {
  rt: SpecRuntime;
  printed: string[];
  handles: { id: string; ran: number; closed: boolean }[];
}

/** A SpecRuntime whose task sessions are plain handles; `signal` is the run's (the REPL command's). */
function taskRig(w: Ws, signal: AbortSignal, o: { turn?: (i: PromptInput) => TurnResult | Promise<TurnResult>; runner?: HookRunnerLike } = {}): Rig {
  const printed: string[] = [];
  const handles: Rig['handles'] = [];
  let n = 0;
  const rt: SpecRuntime = {
    ws: w.ctx,
    interactive: true,
    commandPrefix: '/spec',
    maxParallelTasks: 1,
    signal,
    print: (t) => printed.push(t),
    ask: async () => '',
    confirm: async () => false,
    choose: async () => undefined,
    runSpecTurn: async () => ok(''),
    async openTaskSession(): Promise<TaskSessionHandle> {
      const h = { id: `h${++n}`, ran: 0, closed: false };
      handles.push(h);
      return {
        sessionId: h.id,
        run: async (i) => {
          h.ran++;
          return o.turn ? o.turn(i) : ok('Done.\nTASK_RESULT: completed');
        },
        interrupt: async () => undefined,
        close: async () => {
          h.closed = true;
        },
      };
    },
    taskHooks: () => (o.runner ? { runner: o.runner, sessionId: 'main' } : undefined),
    finish: async () => undefined,
  };
  return { rt, printed, handles };
}

test('R4 #2: Ctrl+C while a task\'s PreTaskExec hook runs kills it; the task is interrupted before any task session opens, the run stops', async () => {
  const w = makeWs();
  try {
    const dir = writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const ac = new AbortController();
    const runner = hangingHooks(['PreTaskExec'], { onStart: () => setTimeout(() => ac.abort(), 10) });
    const rig = taskRig(w, ac.signal, { runner });
    const t0 = Date.now();
    const r = await runSpecTasks(rig.rt, 'todo-export', { kind: 'ids', ids: ['1.1', '2.1'], includeOptional: true });
    assert.ok(Date.now() - t0 < 1500, `the run waited for the hook to end on its own (${Date.now() - t0} ms)`);
    assert.deepEqual(
      runner.calls.map((c) => [c.trigger, c.taskId, c.live, c.end]),
      [['PreTaskExec', '1.1', true, 'killed']],
      'the PreTaskExec hook got the run signal and was killed; no PostTaskExec for a task that never started',
    );
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.status]), [['1.1', 'interrupted']]);
    assert.equal(r.status, 'stopped');
    assert.deepEqual(rig.handles, [], 'a task session was opened after the Ctrl+C');
    assert.equal(boxOf(dir, '1.1'), ' ');
    assert.ok(rig.printed.includes('✗ Task 1.1 interrupted'), rig.printed.join('\n'));
    assert.ok(!rig.printed.some((l) => /▶ Task 2\.1/.test(l)), rig.printed.join('\n'));
  } finally {
    w.cleanup();
  }
});

test("R4 #2: Ctrl+C while a completed task's PostTaskExec hook runs kills it; no follow-up turn, the run stops", async () => {
  const w = makeWs();
  try {
    const dir = writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const ac = new AbortController();
    const runner = hangingHooks(['PostTaskExec'], { postAgentPrompts: ['verify the task'], onStart: (c) => c.trigger === 'PostTaskExec' && setTimeout(() => ac.abort(), 10) });
    const rig = taskRig(w, ac.signal, { runner });
    const t0 = Date.now();
    const r = await runSpecTasks(rig.rt, 'todo-export', { kind: 'ids', ids: ['1.1', '2.1'], includeOptional: true });
    assert.ok(Date.now() - t0 < 1500, `the run waited for the hook to end on its own (${Date.now() - t0} ms)`);
    assert.deepEqual(
      runner.calls.map((c) => [c.trigger, c.taskId, c.status, c.live, c.end]),
      [
        ['PreTaskExec', '1.1', undefined, true, 'finished'],
        ['PostTaskExec', '1.1', 'completed', true, 'killed'],
      ],
    );
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.status]), [['1.1', 'completed']]);
    assert.equal(boxOf(dir, '1.1'), 'x');
    assert.deepEqual(rig.handles.map((h) => [h.ran, h.closed]), [[1, true]], 'no follow-up turn after the Ctrl+C; the task session is closed');
    assert.ok(!rig.printed.some((l) => /▶ Task 2\.1/.test(l)), rig.printed.join('\n'));
  } finally {
    w.cleanup();
  }
});

test('R4 #2: a task interrupted by Ctrl+C still runs its PostTaskExec hook (status interrupted), not skipped as aborted before it started', async () => {
  const w = makeWs();
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const ac = new AbortController();
    const runner = hangingHooks([], { postAgentPrompts: ['verify the task'] });
    const rig = taskRig(w, ac.signal, {
      runner,
      turn: () => {
        ac.abort();
        return { stopReason: 'cancelled', isError: false, text: '', permissionDenials: [] };
      },
    });
    const r = await runSpecTasks(rig.rt, 'todo-export', { kind: 'ids', ids: ['1.1', '2.1'], includeOptional: true });
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.status]), [['1.1', 'interrupted']]);
    const post = runner.calls.filter((c) => c.trigger === 'PostTaskExec');
    assert.deepEqual(post.map((c) => [c.taskId, c.status, c.end]), [['1.1', 'interrupted', 'finished']], 'the PostTaskExec hook did not run');
    assert.deepEqual(rig.handles.map((h) => [h.ran, h.closed]), [[1, true]], 'no follow-up turn for an interrupted task');
  } finally {
    w.cleanup();
  }
});

/** host.createSession models a session start whose agentSpawn hook runs `ms` unless its start signal cancels it. */
function slowStarts(host: MockHost, which: (o: Partial<KiroSessionOptions>) => boolean, ms = 2000): { signals: (AbortSignal | undefined)[]; started: () => number } {
  const signals: (AbortSignal | undefined)[] = [];
  let started = 0;
  const create = host.createSession.bind(host);
  host.createSession = async (o) => {
    if (which(o)) {
      const sig = currentStartSignal();
      signals.push(sig);
      started++;
      await new Promise<void>((resolve, reject) => {
        if (sig?.aborted) return reject(new SessionStartCancelledError());
        const t = setTimeout(resolve, ms);
        sig?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new SessionStartCancelledError());
          },
          { once: true },
        );
      });
    }
    return create(o);
  };
  return { signals, started: () => started };
}

const isTaskSession = (o: Partial<KiroSessionOptions>): boolean => o.origin === 'spec' && !o.specPhase;

test("R4 #3: Ctrl+C while a /spec run task session's agentSpawn hook runs cancels its start: the task is interrupted (not failed), no turn, the run stops", async () => {
  const { w, host } = setup();
  try {
    const dir = writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const original = host.session as MockSession;
    const cmd = commandSignal(host);
    const slow = slowStarts(host, isTaskSession);
    setTimeout(() => cmd.press(), 30);
    const t0 = Date.now();
    const r = await runSpecTasks(rtOf(host), 'todo-export', { kind: 'ids', ids: ['1.1', '2.1'], includeOptional: true });
    assert.ok(Date.now() - t0 < 1500, `the start was not cancelled (${Date.now() - t0} ms)`);
    assert.equal(slow.signals[0], cmd.signal, 'the task session was not created under the command signal');
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.status, o.reason]), [['1.1', 'interrupted', undefined]]);
    assert.equal(slow.started(), 1, 'the run went on to task 2.1');
    assert.ok(host.text.includes('✗ Task 1.1 interrupted'), host.text);
    assert.ok(!/could not start a session/.test(host.text), host.text);
    assert.equal(host.session, original);
    assert.equal(host.sessions.length, 1, 'no task session exists');
    assert.equal(boxOf(dir, '1.1'), ' ');
  } finally {
    w.cleanup();
  }
});

test("R4 #3: a task session start that fails for another reason is still 'failed: could not start a session'", async () => {
  const { w, host } = setup();
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    commandSignal(host);
    host.createSession = async () => {
      throw new Error('Claude Code CLI not found');
    };
    const r = await runSpecTasks(rtOf(host), 'todo-export', { kind: 'next' });
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.status, o.reason]), [['1.1', 'failed', 'could not start a session: Claude Code CLI not found']]);
  } finally {
    w.cleanup();
  }
});

test("R4 #3: Ctrl+C while a /spec new phase session's agentSpawn hook runs cancels its start: the turn is interrupted, the chat stays on main", async () => {
  const { w, host } = setup();
  try {
    const original = host.session as MockSession;
    await host.runTurn({ text: MAIN_LINE });
    const cmd = commandSignal(host);
    const slow = slowStarts(host, (o) => o.specPhase?.name === 'requirements');
    setTimeout(() => cmd.press(), 30);
    const t0 = Date.now();
    const r = await FEATURE(rtOf(host));
    assert.ok(Date.now() - t0 < 1500, `the phase session start was not cancelled (${Date.now() - t0} ms)`);
    assert.equal(slow.signals[0], cmd.signal);
    assert.equal(r.status, 'error');
    assert.equal(r.message, 'interrupted');
    assert.ok(host.text.includes('✗ Drafting requirements.md failed: interrupted'), host.text);
    assert.equal(host.session, original);
    assert.equal(original.closed, false);
    assert.equal(host.sessions.length, 1, 'no phase session exists');
  } finally {
    w.cleanup();
  }
});

test('R4 #3: a press an earlier turn of the command handled does not cancel later session starts (continuation, next phase)', async () => {
  const { w, host } = setup({
    // the press lands during the drafting turn (which Claude then ends as interrupted)
    override: (i) => (REQ.test(i.text) ? (cmd.press(), { stopReason: 'cancelled' }) : undefined),
  });
  const cmd = commandSignal(host);
  try {
    const original = host.session as MockSession;
    await host.runTurn({ text: MAIN_LINE });
    const slow = slowStarts(host, (o) => !o.specPhase, 30);
    const r = await FEATURE(rtOf(host));
    assert.equal(r.status, 'error');
    assert.equal(cmd.signal.aborted, true);
    // the turn reached Claude: the chat continues in a continuation, whose start no stale press cancelled
    assert.equal(slow.signals.length, 1);
    assert.equal(slow.signals[0], undefined, 'an already aborted command signal was given to the continuation start');
    assert.notEqual(host.session, original);
    assert.ok((host.session as MockSession).conversation.some((t) => REQ.test(t)));
  } finally {
    w.cleanup();
  }
});

test("R4 #3: Ctrl+C while the continuation's agentSpawn hook runs cancels that start: the chat gets its own session back, open, every phase session closed", async () => {
  const { w, host } = setup();
  try {
    const original = host.session as MockSession;
    original.planMode = true;
    await host.runTurn({ text: MAIN_LINE });
    const cmd = commandSignal(host);
    const slow = slowStarts(host, (o) => !o.specPhase);
    host.chooseAnswers = ['Stop here'];
    const choose = host.choose.bind(host);
    host.choose = async (q, opts) => {
      const i = await choose(q, opts);
      setTimeout(() => cmd.press(), 30);
      return i;
    };
    const t0 = Date.now();
    const r = await FEATURE(rtOf(host));
    assert.ok(Date.now() - t0 < 1500, `the continuation start was not cancelled (${Date.now() - t0} ms)`);
    assert.equal(r.status, 'stopped');
    assert.equal(slow.signals[0], cmd.signal);
    assert.equal(host.session, original);
    assert.equal(original.closed, false);
    assert.equal(original.planMode, true);
    for (const s of host.sessions) if (s !== original) assert.equal(s.closed, true, `${s.id} left open`);
  } finally {
    w.cleanup();
  }
});

test('R4 #3 (CLI): the first Ctrl+C of `kiro-claude spec run` cancels a task session start whose agentSpawn hooks run: interrupted, exit 1', async () => {
  const w = makeWs();
  const err = new Capture();
  const out = new Capture();
  const before = new Set(process.listeners('SIGINT'));
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const signals: (AbortSignal | undefined)[] = [];
    const ctx: CliContext = {
      ws: w.ctx,
      settings: mockSettings(),
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stdout: out as unknown as NodeJS.WriteStream,
      stderr: err as unknown as NodeJS.WriteStream,
      progName: 'kiro-claude',
      verbosity: 0,
    };
    const t0 = Date.now();
    const code = await runSpecCommandWith(['run', 'todo-export', '1.1', '2.1'], ctx, {
      createSession: async (o) => {
        const sig = currentStartSignal();
        signals.push(sig);
        // the CLI's own SIGINT handler (only it: never a signal to the test process)
        const press = process.listeners('SIGINT').find((l) => !before.has(l));
        setTimeout(() => (press as (() => void) | undefined)?.(), 20);
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 2000);
          sig?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(new SessionStartCancelledError());
            },
            { once: true },
          );
        });
        return new MockSession(o, fakeModel()) as KiroSession;
      },
    });
    assert.ok(Date.now() - t0 < 1500, `the task session start was not cancelled (${Date.now() - t0} ms)`);
    assert.equal(code, 1);
    assert.equal(signals.length, 1, 'the run went on to task 2.1');
    assert.ok(signals[0], 'the task session was not created under the run signal');
    assert.match(err.data, /✗ Task 1\.1 interrupted/, err.data);
    assert.doesNotMatch(err.data, /could not start a session/, err.data);
    assert.match(out.data, /Spec run finished: 0 completed, 1 interrupted/, out.data);
  } finally {
    for (const l of process.listeners('SIGINT')) if (!before.has(l)) process.off('SIGINT', l);
    w.cleanup();
  }
});
