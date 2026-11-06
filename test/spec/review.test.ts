/**
 * Reviewer's adversarial tests for spec/ (likely-wrong cases found while reviewing against
 * research 03 §1.3, §1.5.5, §1.6, §1.7, §1.10.8, §1.11.4). Each test names the defect it pins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { CliContext, HookRunnerLike, KiroSession, KiroSessionOptions, PromptInput, TurnResult } from '../../src/types.js';
import { applyBoxChange, lintSpec, normalizeTasksText, parseRequirements, parseTasks, planRun, planTasks, writeTaskStatus } from '../../src/spec/model.js';
import { parseTaskResult } from '../../src/spec/prompts.js';
import { readSpecConfig, resolveSpecDir, specSummaryJson, summarizeSpecDir } from '../../src/spec/store.js';
import { SpecSessionDriver, createNewSpec, runSpecTasks, type SessionPort, type SpecRuntime, type TaskSessionHandle } from '../../src/spec/workflow.js';
import { runSpecCommandWith } from '../../src/spec/cli.js';
import { BUGFIX_MD, DESIGN_MD, MockSession, REQ_MD, TASKS_MD, exampleSpecDir, fakeModel, makeWs, mockSettings, read, recordingHooks, writeSpec, type ModelScript, type Ws } from './helpers.js';

// ───────────────────────────── helpers ─────────────────────────────

const ok = (text: string): TurnResult => ({ stopReason: 'end_turn', isError: false, text, permissionDenials: [] });

interface Rig {
  rt: SpecRuntime;
  printed: string[];
  handles: { id: string; ran: number; closed: boolean; interrupted: number }[];
}

/** Headless runtime whose task sessions are plain handles (custom start delay / turn result). */
function taskRig(w: Ws, o: { startDelayMs?: number; turn?: (i: PromptInput) => TurnResult | Promise<TurnResult>; hooks?: () => { runner: HookRunnerLike; sessionId: string } | undefined; openThrows?: boolean } = {}): Rig {
  const printed: string[] = [];
  const handles: Rig['handles'] = [];
  let n = 0;
  const rt: SpecRuntime = {
    ws: w.ctx,
    interactive: false,
    commandPrefix: 'kiro-claude spec',
    maxParallelTasks: 1,
    print: (t) => printed.push(t),
    ask: async () => '',
    confirm: async () => false,
    choose: async () => undefined,
    runSpecTurn: async () => ok(''),
    async openTaskSession(): Promise<TaskSessionHandle> {
      if (o.openThrows) throw new Error('spawn failed');
      if (o.startDelayMs) await new Promise((r) => setTimeout(r, o.startDelayMs));
      const h = { id: `h${++n}`, ran: 0, closed: false, interrupted: 0 };
      handles.push(h);
      return {
        sessionId: h.id,
        run: async (i) => {
          h.ran++;
          return o.turn ? o.turn(i) : ok('Done.\nTASK_RESULT: completed');
        },
        interrupt: async () => {
          h.interrupted++;
        },
        close: async () => {
          h.closed = true;
        },
      };
    },
    taskHooks: o.hooks ?? (() => undefined),
    finish: async () => undefined,
  };
  return { rt, printed, handles };
}

const boxOf = (dir: string, id: string): string => parseTasks(read(path.join(dir, 'tasks.md'))).byId.get(id)!.box;

class Capture extends Writable {
  data = '';
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += chunk.toString();
    cb();
  }
}

function cliCtx(w: Ws): { ctx: CliContext; out: Capture; err: Capture } {
  const out = new Capture();
  const err = new Capture();
  const ctx: CliContext = {
    ws: w.ctx,
    settings: mockSettings(),
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout: out as unknown as NodeJS.WriteStream,
    stderr: err as unknown as NodeJS.WriteStream,
    progName: 'kiro-claude',
    verbosity: 0,
  };
  return { ctx, out, err };
}

// ───────────────────────────── model ─────────────────────────────

test('review: a nested ordered checklist does not steal task numbers (w7 top-level style still works)', () => {
  // BUG (fixed): `  1. [ ] step` under task 2 became top-level task "1" and the real task 1 was
  // renamed "#1", so `spec run demo 1` ran the wrong item.
  const nested = parseTasks(['## Tasks', '', '- [ ] 2. Implement', '  1. [ ] nested step', '- [ ] 1. First', ''].join('\n'));
  assert.deepEqual(
    nested.tasks.map((t) => [t.id, t.parentId, t.title]),
    [
      ['2', null, 'Implement'],
      ['#1', '2', 'nested step'],
      ['1', null, 'First'],
    ],
  );
  const nested2 = parseTasks(['- [ ] 1. A', '  3. [ ] nested', '- [ ] 2. B', '- [ ] 3. C', ''].join('\n'));
  assert.equal(nested2.byId.get('3')!.title, 'C');
  assert.equal(nested2.byId.get('#1')!.parentId, '1');
  // w7: a bare "-" bullet followed by an indented ordered item is a top-level task
  const w7 = parseTasks(['## Tasks', '', '-', '  1. [ ] Foundations', '  - [~] 1.1 Child scopes', '-', '  2. [ ] Checkpoint - tests pass', ''].join('\n'));
  assert.deepEqual(
    w7.tasks.map((t) => [t.id, t.parentId]),
    [
      ['1', null],
      ['1.1', '1'],
      ['2', null],
    ],
  );
});

test('review: `(Validates R1.6, R3.5.)` variant counts as requirement refs (03 §1.5.5)', () => {
  const t = parseTasks(['- [ ] 1. A', '  - Do it (Validates R1.1, R1.2.)', '- [ ] 2. B', '  - _Requirements: 2.1_', ''].join('\n'));
  assert.deepEqual(t.byId.get('1')!.requirementRefs, ['1.1', '1.2']);
  const req = parseRequirements(REQ_MD);
  assert.deepEqual(
    lintSpec({ criteriaIds: req.criteriaIds, tasks: t }).filter((i) => i.code === 'uncovered-criterion'),
    [],
  );
});

test('review: every box change on the real example spec preserves all other bytes', { skip: !exampleSpecDir() && 'example spec not available' }, () => {
  const text = read(path.join(exampleSpecDir()!, 'tasks.md'));
  const parsed = parseTasks(text);
  assert.ok(parsed.tasks.length > 40);
  for (const t of parsed.tasks) {
    for (const b of [' ', 'x', '-', '~'] as const) {
      const { text: next } = applyBoxChange(text, t.id, b);
      assert.equal(next.length, text.length, `${t.id} → [${b}]`);
      let diffs = 0;
      for (let i = 0; i < text.length; i++) if (text[i] !== next[i]) diffs++;
      assert.ok(diffs <= 3, `${t.id} → [${b}] changed ${diffs} chars (box + parent roll-ups only)`);
    }
  }
  // the normalizer does not touch a well-formed Kiro file
  assert.equal(normalizeTasksText(text).changedLines, 0);
});

test('review: writeTaskStatus after the agent rewrote tasks.md finds the task by id', () => {
  const w = makeWs();
  try {
    const dir = writeSpec(w, 'demo', { tasks: TASKS_MD });
    const file = path.join(dir, 'tasks.md');
    const before = parseTasks(read(file)).byId.get('2.1')!;
    // the agent inserts lines above 2.1 (offsets shift) and edits another task's details
    fs.writeFileSync(file, read(file).replace('## Tasks\n', '## Tasks\n\n> Note: added by the agent\n> second line\n').replace('Header row first', 'Header row first (RFC 4180)'));
    const r = writeTaskStatus(file, '2.1', 'x', { expectHash: before.textHash });
    assert.equal(r.stale, undefined, '2.1 itself did not change');
    assert.equal(boxOf(dir, '2.1'), 'x');
    assert.match(read(file), /> Note: added by the agent/);
    assert.match(read(file), /Header row first \(RFC 4180\)/);
    assert.throws(() => writeTaskStatus(file, '9.9', 'x'), /no longer in/);
  } finally {
    w.cleanup();
  }
});

test('review: planRun next skips optional tasks unless asked; explicit optional leaf still runs', () => {
  const t = parseTasks(TASKS_MD.replace('- [ ] 1.1', '- [x] 1.1'));
  assert.equal(planTasks(planRun(t, { kind: 'next' }))[0]!.id, '2.1');
  assert.equal(planTasks(planRun(t, { kind: 'next', includeOptional: true }))[0]!.id, '1.2');
  assert.deepEqual(planTasks(planRun(t, { kind: 'ids', ids: ['1.2'] })).map((x) => x.id), ['1.2']);
  // a parent id expands to its incomplete required leaves only
  assert.deepEqual(planTasks(planRun(t, { kind: 'ids', ids: ['2'] })).map((x) => x.id), ['2.1']);
});

// ───────────────────────────── store ─────────────────────────────

test('review: legacy `{"generationMode": …}` config infers specType from bugfix.md (03 §1.3)', () => {
  // BUG (fixed): legacy files without specType were always read as feature specs, so a legacy
  // bugfix spec got requirements-first phases (requirements.md) and the wrong prompts.
  const w = makeWs();
  try {
    const bug = writeSpec(w, 'legacy-bug', { config: '{"generationMode": "requirements-first"}', bugfix: BUGFIX_MD });
    const feat = writeSpec(w, 'legacy-feat', { config: '{"generationMode": "requirements-first"}', requirements: REQ_MD });
    const explicit = writeSpec(w, 'explicit', { config: '{"specId": "a", "workflowType": "requirements-first", "specType": "feature"}', bugfix: BUGFIX_MD });
    assert.equal(readSpecConfig(bug)!.specType, 'bugfix');
    assert.deepEqual(summarizeSpecDir(bug).order, ['bugfix', 'design', 'tasks']);
    assert.equal(summarizeSpecDir(bug).awaitingApproval, 'bugfix');
    assert.equal(readSpecConfig(feat)!.specType, 'feature');
    assert.equal(readSpecConfig(explicit)!.specType, 'feature', 'an explicit specType wins');
    assert.equal(specSummaryJson(summarizeSpecDir(bug)).specId, null, 'legacy files have no specId');
    // reading never rewrites the file (never add keys, 03 §1.3)
    assert.equal(read(path.join(bug, '.config.kiro')), '{"generationMode": "requirements-first"}');
  } finally {
    w.cleanup();
  }
});

test('review: resolveSpecDir never escapes .kiro/specs', () => {
  const w = makeWs();
  try {
    writeSpec(w, 'demo', { requirements: REQ_MD });
    fs.mkdirSync(path.join(w.proj, '.kiro', 'secret'), { recursive: true });
    for (const n of ['..', '../secret', '../../', 'demo/../../secret', path.join(w.proj, '.kiro', 'secret'), '..\\secret', '', '.', ' ']) {
      assert.equal(resolveSpecDir(w.ctx, n), undefined, JSON.stringify(n));
    }
    assert.equal(resolveSpecDir(w.ctx, 'DEMO'), path.join(w.specs, 'demo'));
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── prompts ─────────────────────────────

test('review: parseTaskResult — `completed` only as the unqualified final line (03 §1.7.2 / §1.10.8)', () => {
  // BUG (fixed): any earlier "TASK_RESULT: completed" line, or "completed - partially", marked [x].
  const rows: [string, unknown][] = [
    ['TASK_RESULT: completed\nBut the tests still fail.', undefined],
    ['TASK_RESULT: completed - partially, tests are skipped', undefined],
    ['TASK_RESULT: completed.', { status: 'completed' }],
    ['Summary\n\nTASK_RESULT: completed\n```', { status: 'completed' }],
    ['**TASK_RESULT: completed**\n\n---\n', { status: 'completed' }],
    ['TASK_RESULT: blocked - flaky\nmore text after', { status: 'blocked', reason: 'flaky' }],
    ['TASK_RESULT: blocked.', { status: 'blocked', reason: 'no reason given' }],
    ['TASK_RESULT: completed\nTASK_RESULT: blocked - wait', { status: 'blocked', reason: 'wait' }],
  ];
  for (const [text, want] of rows) assert.deepEqual(parseTaskResult(text), want, JSON.stringify(text));
});

// ───────────────────────────── task runner ─────────────────────────────

test('review: Ctrl+C while a task session is still starting does not run the task', async () => {
  // BUG (fixed): the abort handler only interrupts sessions it knows; one still spawning was then
  // run to completion and marked [x] although the user had interrupted the run.
  const w = makeWs();
  try {
    const dir = writeSpec(w, 'demo', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const rig = taskRig(w, { startDelayMs: 40 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    const r = await runSpecTasks(rig.rt, 'demo', { kind: 'scope', includeOptional: false }, { signal: ac.signal });
    assert.equal(r.status, 'stopped');
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.status]), [['1.1', 'interrupted']]);
    assert.deepEqual(rig.handles.map((h) => [h.ran, h.closed]), [[0, true]]);
    assert.equal(boxOf(dir, '1.1'), ' ', 'reverted from [-]');
  } finally {
    w.cleanup();
  }
});

test('review: a throwing PostTaskExec runner neither leaks the task session nor rejects the run', async () => {
  // BUG (fixed): runSpecTasks rejected and the task's claude child was never closed.
  const w = makeWs();
  try {
    const dir = writeSpec(w, 'demo', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const base = recordingHooks();
    const runner: HookRunnerLike = {
      ...base,
      async runTaskHook(ctx, trigger, task) {
        if (trigger === 'PostTaskExec') throw new Error('hook runner exploded');
        return base.runTaskHook(ctx, trigger, task);
      },
    };
    const rig = taskRig(w, { hooks: () => ({ runner, sessionId: 'orch' }) });
    const r = await runSpecTasks(rig.rt, 'demo', { kind: 'next' });
    assert.equal(r.status, 'completed');
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.status]), [['1.1', 'completed']]);
    assert.deepEqual(rig.handles.map((h) => h.closed), [true]);
    assert.equal(boxOf(dir, '1.1'), 'x');
    assert.ok(rig.printed.some((l) => /PostTaskExec hooks for task 1\.1 failed: hook runner exploded/.test(l)));
  } finally {
    w.cleanup();
  }
});

test('review: a throwing PreTaskExec runner fails the task without opening a session or touching the box', async () => {
  const w = makeWs();
  try {
    const dir = writeSpec(w, 'demo', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const runner: HookRunnerLike = {
      ...recordingHooks(),
      async runTaskHook() {
        throw new Error('no shell');
      },
    };
    const rig = taskRig(w, { hooks: () => ({ runner, sessionId: 'orch' }) });
    const r = await runSpecTasks(rig.rt, 'demo', { kind: 'scope', includeOptional: false });
    assert.equal(r.status, 'stopped');
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.status]), [['1.1', 'failed']]);
    assert.equal(rig.handles.length, 0);
    assert.equal(boxOf(dir, '1.1'), ' ');
  } finally {
    w.cleanup();
  }
});

test('review: an unexpected error inside one task becomes a failed outcome (no unhandled rejection)', async () => {
  const w = makeWs();
  try {
    writeSpec(w, 'demo', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const rig = taskRig(w, {
      hooks: () => {
        throw new Error('settings exploded');
      },
    });
    const r = await runSpecTasks(rig.rt, 'demo', { kind: 'scope', includeOptional: false });
    assert.equal(r.status, 'stopped');
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.status, o.reason]), [['1.1', 'failed', 'settings exploded']]);
  } finally {
    w.cleanup();
  }
});

test('review: an ambiguous final text never marks [x]; the run stops and the box reverts', async () => {
  const w = makeWs();
  try {
    const dir = writeSpec(w, 'demo', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const rig = taskRig(w, { turn: () => ok('TASK_RESULT: completed\nActually the build is red, I will fix it next.') });
    const r = await runSpecTasks(rig.rt, 'demo', { kind: 'scope', includeOptional: false });
    assert.equal(r.status, 'stopped');
    assert.equal(r.outcomes.length, 1);
    assert.equal(r.outcomes[0]!.status, 'failed');
    assert.equal(boxOf(dir, '1.1'), ' ');
    assert.equal(boxOf(dir, '2.1'), ' ', 'later tasks did not run');
    // isError with a completed sentinel is not completed either (result.subtype must be success)
    const rig2 = taskRig(w, { turn: () => ({ ...ok('TASK_RESULT: completed'), isError: true, stopReason: 'error', error: 'max budget' }) });
    const r2 = await runSpecTasks(rig2.rt, 'demo', { kind: 'next' });
    assert.equal(r2.outcomes[0]!.status, 'failed');
    assert.equal(boxOf(dir, '1.1'), ' ');
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── phases (headless) ─────────────────────────────

function phaseRig(w: Ws, script: ModelScript): { rt: SpecRuntime; printed: string[]; sessions: MockSession[] } {
  const printed: string[] = [];
  const sessions: MockSession[] = [];
  let current: KiroSession | undefined;
  const port: SessionPort = {
    active: () => current,
    create: async (o: Partial<KiroSessionOptions>) => {
      const s = new MockSession({ ...o, interactive: false }, script);
      sessions.push(s);
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
  const driver = new SpecSessionDriver(port);
  const rt: SpecRuntime = {
    ws: w.ctx,
    interactive: false,
    commandPrefix: 'kiro-claude spec',
    maxParallelTasks: 1,
    print: (t) => printed.push(t),
    ask: async () => '',
    confirm: async () => false,
    choose: async () => undefined,
    runSpecTurn: (i, p, o) => driver.runTurn(i, p, o),
    openTaskSession: async () => {
      throw new Error('no tasks here');
    },
    taskHooks: () => undefined,
    finish: () => driver.finish('close'),
  };
  return { rt, printed, sessions };
}

test('review: headless phase turn that wrote nothing is an error, not "waiting for review"', async () => {
  // BUG (fixed): `spec new --yes` / `spec approve` exited 0 and printed "requirements.md is
  // waiting for review" although the document did not exist.
  const w = makeWs();
  try {
    const silent = phaseRig(w, () => ({ text: 'I could not write the file.' }));
    const r = await createNewSpec(silent.rt, { name: 'demo', kind: 'feature', description: 'd', autoApprove: true });
    assert.equal(r.status, 'error');
    assert.equal(r.awaiting, 'requirements');
    assert.equal(r.message, 'requirements.md was not written');
    assert.ok(!silent.printed.some((l) => /waiting for review/.test(l)));
    assert.deepEqual(silent.sessions.map((s) => s.closed), [true]);
    // quick specs fail the same way
    const q = phaseRig(w, () => ({ text: 'nope' }));
    const rq = await createNewSpec(q.rt, { name: 'quick-one', kind: 'quick', description: 'd', autoApprove: true });
    assert.equal(rq.status, 'error');
    // a cooperative model still reaches the ready state
    const good = phaseRig(w, fakeModel());
    const rg = await createNewSpec(good.rt, { name: 'good', kind: 'feature', description: 'd', autoApprove: true });
    assert.equal(rg.status, 'ready');
    assert.ok(good.sessions.every((s) => s.closed));
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── CLI ─────────────────────────────

test('review: CLI --spec-auto-approve is --yes; view of a blank document is "not written"', async () => {
  const w = makeWs();
  try {
    const sessions: MockSession[] = [];
    const deps = {
      isTTY: false,
      createSession: async (o: KiroSessionOptions) => {
        const s = new MockSession(o, fakeModel());
        sessions.push(s);
        return s as KiroSession;
      },
    };
    const a = cliCtx(w);
    assert.equal(await runSpecCommandWith(['new', 'auto', '--spec-auto-approve', '-d', 'export todos'], a.ctx, deps), 0, a.err.data);
    assert.match(a.err.data, /Spec ready\. Run all tasks: kiro-claude spec run auto/);
    assert.ok(fs.existsSync(path.join(w.specs, 'auto', 'tasks.md')));
    assert.ok(sessions.every((s) => s.closed), 'every phase session closed');
    writeSpec(w, 'blank', { requirements: '  \n\n' });
    const b = cliCtx(w);
    assert.equal(await runSpecCommandWith(['view', 'blank', 'requirements'], b.ctx, deps), 1);
    assert.match(b.err.data, /requirements\.md has not been written yet/);
    // a headless phase that writes nothing exits 1
    const c = cliCtx(w);
    const silent = { ...deps, createSession: async (o: KiroSessionOptions) => new MockSession(o, () => ({ text: 'no' })) as KiroSession };
    assert.equal(await runSpecCommandWith(['new', 'silent', '-d', 'x'], c.ctx, silent), 1);
  } finally {
    w.cleanup();
  }
});

test('review: CLI never creates or reads a spec outside .kiro/specs', async () => {
  const w = makeWs();
  try {
    const deps = { isTTY: false, createSession: async (o: KiroSessionOptions) => new MockSession(o, fakeModel()) as KiroSession };
    const a = cliCtx(w);
    assert.equal(await runSpecCommandWith(['new', '../../evil', '-d', 'x'], a.ctx, deps), 0, a.err.data);
    assert.match(a.err.data, /Using spec name 'evil'/);
    assert.ok(fs.existsSync(path.join(w.specs, 'evil', '.config.kiro')));
    assert.ok(!fs.existsSync(path.join(w.proj, 'evil')) && !fs.existsSync(path.join(w.root, 'evil')));
    fs.writeFileSync(path.join(w.proj, '.kiro', 'tasks.md'), '- [ ] 1. outside\n');
    for (const n of ['..', '../..', '../specs/evil/..']) {
      const b = cliCtx(w);
      assert.equal(await runSpecCommandWith(['view', n, 'tasks'], b.ctx, deps), 1, n);
      assert.equal(b.out.data, '');
      const c = cliCtx(w);
      assert.equal(await runSpecCommandWith(['run', n], c.ctx, deps), 1, n);
    }
    assert.equal(read(path.join(w.proj, '.kiro', 'tasks.md')), '- [ ] 1. outside\n');
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── e2e: real KiroSession + fake-claude ─────────────────────────────

const sessionModuleBuilt = (() => {
  try {
    return fs.existsSync(new URL('../../src/session/kiroSession.js', import.meta.url));
  } catch {
    return false;
  }
})();

test('review e2e (fake-claude): spec run reads TASK_RESULT from the real TurnResult; ambiguous result stops the run', { skip: !sessionModuleBuilt && 'session/kiroSession.js not built' }, async () => {
  const { fakeClaudePath, fakeEnv } = await import('../claude/helpers.js');
  const { createWorkspaceContext } = await import('../../src/config/workspace.js');
  const w = makeWs('kc-spec-review-e2e-');
  try {
    const dir = writeSpec(w, 'demo', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const claudeConfig = path.join(w.root, 'claude-config');
    const runtime = path.join(w.root, 'run');
    fs.mkdirSync(claudeConfig);
    fs.mkdirSync(runtime, { mode: 0o700 });
    const script = {
      turns: [
        { repeat: true, match: 'Execute Task: 1\\.1 ', steps: [{ text: 'Implemented toCsv.\n\nTASK_RESULT: completed' }] },
        { repeat: true, match: 'Execute Task: 2\\.1 ', steps: [{ text: 'TASK_RESULT: completed\nHmm, the escaping tests still fail.' }] },
      ],
    };
    const env = fakeEnv({
      HOME: w.home,
      USERPROFILE: w.home,
      KIRO_HOME: path.join(w.home, '.kiro'),
      CLAUDE_CONFIG_DIR: claudeConfig,
      XDG_RUNTIME_DIR: runtime,
      XDG_CACHE_HOME: path.join(w.root, 'cache'),
      KIRO_CLAUDE_BIN: fakeClaudePath(),
      FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script),
      FAKE_CLAUDE_LOG: path.join(w.root, 'fake.log'),
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_EFFORT_LEVEL: undefined,
      KIRO_CLAUDE_SESSIONS_DIR: undefined,
    });
    const { ctx, out, err } = cliCtx(w);
    ctx.ws = createWorkspaceContext(w.proj, env);
    const code = await runSpecCommandWith(['run', 'demo'], ctx);
    assert.equal(code, 1, err.data);
    assert.equal(boxOf(dir, '1.1'), 'x');
    assert.equal(boxOf(dir, '2.1'), ' ');
    assert.equal(boxOf(dir, '3'), ' ', 'the checkpoint after the failure did not run');
    assert.match(out.data, /Spec run finished: 1 completed, 1 failed\./);
    assert.match(out.data, /2\.1: failed — ambiguous TASK_RESULT \(expected the final line to be exactly "TASK_RESULT: completed"\)/);
    // one claude child per task, each closed (stdin_end logged)
    const log = fs
      .readFileSync(path.join(w.root, 'fake.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; argv?: string[]; pid?: number });
    assert.equal(log.filter((e) => e.event === 'start' && e.argv?.includes('-p')).length, 2);
    assert.equal(log.filter((e) => e.event === 'stdin_end').length, 2, 'both task children were closed');
  } finally {
    w.cleanup();
  }
});
