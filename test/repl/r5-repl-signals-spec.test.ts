/**
 * Round-5 "repl-signals" P1, the spec side (src/spec/workflow.ts over a mock ReplHost): once a
 * Ctrl+C has aborted the command signal (it interrupted a phase turn or a task), the REPL's
 * `nextPressSignal()` (repl/types.ts ReplContext, read duck-typed) is what a later press aborts:
 *  - the start signal of a later phase session and of the continuation (createReplRuntime's
 *    createUnderPress): a press while it runs its agentSpawn hooks cancels that start;
 *  - the signal of the PostTaskExec hooks of an interrupted task (executeTask): a press kills them;
 *  - a cancelled continuation start gives the chat its own session back (SpecSessionDriver.finish)
 *    and says so in a short notice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { HookRunnerLike, KiroSession, KiroSessionOptions } from '../../src/types.js';
import { currentStartSignal, SessionStartCancelledError } from '../../src/session/startSignal.js';
import { createReplRuntime, runSpecTasks, type SpecRuntime } from '../../src/spec/workflow.js';
import { DESIGN_MD, MockHost, MockSession, REQ_MD, TASKS_MD, fakeModel, makeWs, recordingHooks, taskHook, writeSpec, type FakeModelOptions, type Ws } from '../spec/helpers.js';

const rtOf = (host: MockHost, deps: Parameters<typeof createReplRuntime>[1] = {}): SpecRuntime => createReplRuntime(host, { openEditor: null, ...deps });

/** The REPL's command signal and its next-press signals on a mock host (both read duck-typed). */
function presses(host: MockHost): { press(): void; command: AbortSignal; issued: AbortSignal[] } {
  const cmd = new AbortController();
  const waiting: AbortController[] = [];
  const issued: AbortSignal[] = [];
  Object.defineProperty(host, 'commandSignal', { get: () => cmd.signal, configurable: true });
  Object.defineProperty(host, 'nextPressSignal', {
    configurable: true,
    value: (): AbortSignal => {
      const ac = new AbortController();
      waiting.push(ac);
      issued.push(ac.signal);
      return ac.signal;
    },
  });
  return {
    command: cmd.signal,
    issued,
    // every press aborts the command signal and the next-press signals asked for before it
    press(): void {
      cmd.abort();
      for (const ac of waiting.splice(0)) ac.abort();
    },
  };
}

/** host.createSession models a start whose agentSpawn hook runs `ms` unless its start signal cancels it. */
function slowStarts(host: MockHost, which: (o: Partial<KiroSessionOptions>) => boolean, ms = 3000): { signals: (AbortSignal | undefined)[] } {
  const signals: (AbortSignal | undefined)[] = [];
  const create = host.createSession.bind(host);
  host.createSession = async (o) => {
    if (which(o)) {
      const sig = currentStartSignal();
      signals.push(sig);
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
  return { signals };
}

const isPhase = (o: Partial<KiroSessionOptions>): boolean => !!o.specPhase;
const isContinuation = (o: Partial<KiroSessionOptions>): boolean => !o.specPhase && o.origin !== 'spec';

function setup(o: FakeModelOptions = {}, hooks: ('PreTaskExec' | 'PostTaskExec')[] = []): { w: Ws; host: MockHost } {
  const w = makeWs();
  const host = new MockHost(w.ctx, fakeModel(o), hooks.length ? { hooks: hooks.map(taskHook) } : {});
  return { w, host };
}

test('r5 P1: after a press aborted the command signal, a later phase session starts under the next press (a press during its agentSpawn hooks cancels it)', async () => {
  const { w, host } = setup();
  try {
    const original = host.session;
    const p = presses(host);
    p.press(); // e.g. it interrupted an earlier turn of the command
    const slow = slowStarts(host, isPhase);
    const rt = rtOf(host);
    setTimeout(() => p.press(), 40);
    const t0 = Date.now();
    const r = await rt.runSpecTurn({ text: 'Phase: DESIGN' }, { name: 'design', allowedWritePaths: [`${w.specs}/x/design.md`] });
    assert.ok(Date.now() - t0 < 1500, `the phase session start was not cancelled by the press (${Date.now() - t0} ms)`);
    assert.equal(r.stopReason, 'cancelled');
    assert.ok(slow.signals[0], 'the phase session had no start signal');
    assert.notEqual(slow.signals[0], p.command, 'the start signal must not be the already aborted command signal');
    assert.equal(slow.signals[0], p.issued[0], 'the start signal is the next-press signal');
    assert.equal(host.session, original, 'nothing half-started became the chat');
    await rt.finish();
    assert.equal(host.session, original);
  } finally {
    w.cleanup();
  }
});

test('r5 P1: the continuation of a flow whose turn a press interrupted starts under the next press: a press cancels it, the chat keeps its own session and a notice says so', async () => {
  const { w, host } = setup();
  try {
    const original = host.session as MockSession;
    const p = presses(host);
    const rt = rtOf(host);
    const dir = writeSpec(w, 'todo-export', { requirements: REQ_MD });
    // a phase turn that reached Claude, then the press that interrupted it
    const r = await rt.runSpecTurn({ text: `Phase: REQUIREMENTS. Create or update ${dir}/requirements.md.` }, { name: 'requirements', allowedWritePaths: [`${dir}/requirements.md`] });
    assert.equal(r.stopReason, 'end_turn');
    const phase = host.session as MockSession;
    assert.notEqual(phase, original);
    p.press();
    const slow = slowStarts(host, isContinuation);
    setTimeout(() => p.press(), 40);
    const t0 = Date.now();
    await rt.finish();
    assert.ok(Date.now() - t0 < 1500, `the continuation start was not cancelled (${Date.now() - t0} ms)`);
    assert.equal(slow.signals.length, 1);
    assert.ok(slow.signals[0] && slow.signals[0] !== p.command, 'the continuation had no usable start signal');
    assert.equal(host.session, original, 'the chat must get its own session back');
    assert.equal(original.closed, false);
    assert.equal(phase.closed, true, 'the phase session is closed');
    assert.match(host.text, /Ctrl\+C: the chat keeps its own conversation/, host.text);
  } finally {
    w.cleanup();
  }
});

test('r5 P1: a continuation whose start a first press cancels (command signal) also gets the notice', async () => {
  const { w, host } = setup();
  try {
    const original = host.session as MockSession;
    const p = presses(host);
    const rt = rtOf(host);
    const dir = writeSpec(w, 'todo-export', { requirements: REQ_MD });
    await rt.runSpecTurn({ text: `Phase: REQUIREMENTS. Create or update ${dir}/requirements.md.` }, { name: 'requirements', allowedWritePaths: [`${dir}/requirements.md`] });
    const slow = slowStarts(host, isContinuation);
    setTimeout(() => p.press(), 40);
    await rt.finish();
    assert.equal(slow.signals[0], p.command, 'a first press is the command signal');
    assert.equal(host.session, original);
    assert.match(host.text, /Ctrl\+C: the chat keeps its own conversation/, host.text);
  } finally {
    w.cleanup();
  }
});

test('r5 P1: no notice when the continuation is handed over normally', async () => {
  const { w, host } = setup();
  try {
    const original = host.session;
    const rt = rtOf(host);
    presses(host);
    const dir = writeSpec(w, 'todo-export', { requirements: REQ_MD });
    await rt.runSpecTurn({ text: `Phase: REQUIREMENTS. Create or update ${dir}/requirements.md.` }, { name: 'requirements', allowedWritePaths: [`${dir}/requirements.md`] });
    await rt.finish();
    assert.notEqual(host.session, original, 'the continuation is the chat');
    assert.doesNotMatch(host.text, /keeps its own conversation/);
  } finally {
    w.cleanup();
  }
});

test('r5 P1: the PostTaskExec hooks of a task a press interrupted run under the next press (a press kills them)', async () => {
  let p!: ReturnType<typeof presses>;
  const { w, host } = setup(
    {
      override: (i) => {
        if (!/Execute Task: 1\.1/.test(i.text)) return undefined;
        p.press(); // Ctrl+C during the task turn: it ends interrupted
        return { stopReason: 'cancelled', text: '' };
      },
    },
    ['PostTaskExec'],
  );
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    p = presses(host);
    const base = recordingHooks();
    const seen: { trigger: string; signal: AbortSignal | undefined }[] = [];
    const runner: HookRunnerLike = {
      ...base,
      // a PostTaskExec command hook with timeout 0 that never ends unless its signal kills it
      runTaskHook: async (ctx, trigger, info) => {
        seen.push({ trigger, signal: ctx.signal });
        if (trigger === 'PostTaskExec') {
          setTimeout(() => p.press(), 40);
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 3000);
            ctx.signal?.addEventListener('abort', () => {
              clearTimeout(t);
              resolve();
            });
          });
          return { blocked: false, agentPrompts: [], warnings: [] };
        }
        return base.runTaskHook(ctx, trigger, info);
      },
    };
    const t0 = Date.now();
    const r = await runSpecTasks(rtOf(host, { hookRunnerFactory: () => runner }), 'todo-export', { kind: 'ids', ids: ['1.1', '2.1'], includeOptional: true });
    const ms = Date.now() - t0;
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.status]), [['1.1', 'interrupted']]);
    const post = seen.find((s) => s.trigger === 'PostTaskExec');
    assert.ok(post, 'PostTaskExec did not run for the interrupted task');
    assert.ok(post.signal, 'the PostTaskExec hooks of the interrupted task got no signal: a press cannot kill them');
    assert.notEqual(post.signal, p.command);
    assert.ok(ms < 1500, `the hook was not killed by the press (${ms} ms)`);
  } finally {
    w.cleanup();
  }
});

test('r5 P1: a host without nextPressSignal (spec CLI, other hosts) keeps the earlier behaviour: no start signal after a press', async () => {
  const { w, host } = setup();
  try {
    const cmd = new AbortController();
    Object.defineProperty(host, 'commandSignal', { get: () => cmd.signal, configurable: true });
    cmd.abort();
    const signals: (AbortSignal | undefined)[] = [];
    const create = host.createSession.bind(host);
    host.createSession = async (o): Promise<KiroSession> => {
      signals.push(currentStartSignal());
      return create(o);
    };
    const r = await rtOf(host).runSpecTurn({ text: 'Phase: DESIGN' }, { name: 'design', allowedWritePaths: [`${w.specs}/x/design.md`] });
    assert.notEqual(r.stopReason, 'error');
    assert.deepEqual(signals, [undefined]);
  } finally {
    w.cleanup();
  }
});
