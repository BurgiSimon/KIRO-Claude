import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { ApprovalRequest, CliContext, KiroSession, KiroSessionOptions, WorkspaceContext } from '../../src/types.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { parseTasks } from '../../src/spec/model.js';
import { SPEC_HELP_TEXT, runSpecCommand, runSpecCommandWith, type SpecCliDeps, type SpecCliIO } from '../../src/spec/cli.js';
import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';
import { DESIGN_MD, MockSession, REQ_MD, TASKS_MD, fakeModel, makeWs, mockSettings, read, recordingHooks, writeSpec, type FakeModelOptions, type ModelScript, type Ws } from './helpers.js';

class Capture extends Writable {
  data = '';
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += chunk.toString();
    cb();
  }
}

interface Rig {
  w: Ws;
  ctx: CliContext;
  out: Capture;
  err: Capture;
  sessions: MockSession[];
  opts: KiroSessionOptions[];
  deps: SpecCliDeps;
  run(args: string): Promise<number>;
}

/** CLI context over a temp workspace; sessions are MockSessions driven by the fake model. */
function rig(model: FakeModelOptions = {}, extra: Partial<SpecCliDeps> = {}, ws?: Ws): Rig {
  const w = ws ?? makeWs();
  const out = new Capture();
  const err = new Capture();
  const stdin = new PassThrough();
  const ctx: CliContext = {
    ws: w.ctx,
    settings: mockSettings(),
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: out as unknown as NodeJS.WriteStream,
    stderr: err as unknown as NodeJS.WriteStream,
    progName: 'kiro-claude',
    verbosity: 0,
  };
  const sessions: MockSession[] = [];
  const opts: KiroSessionOptions[] = [];
  const base = fakeModel(model);
  // the model also streams its text and a tool line so the renderer is exercised
  const script: ModelScript = async (input, s) => {
    const r = await base(input, s);
    return { ...r, events: [{ type: 'tool_start', toolUseId: 't1', trusted: false, call: { displayName: 'write', summary: 'Path: x', mcp: undefined } as never }, { type: 'text_delta', text: r.text ?? '' }] };
  };
  const deps: SpecCliDeps = {
    createSession: async (o) => {
      opts.push(o);
      const s = new MockSession(o, script);
      sessions.push(s);
      return s as KiroSession;
    },
    ...extra,
  };
  return {
    w,
    ctx,
    out,
    err,
    sessions,
    opts,
    deps,
    run: (args) => runSpecCommandWith(args.split(' ').filter(Boolean), ctx, deps),
  };
}

test('help, usage errors, unknown subcommands', async () => {
  const r = rig();
  try {
    assert.equal(await r.run('--help'), 0);
    assert.equal(r.out.data, SPEC_HELP_TEXT);
    assert.equal(await r.run('help'), 0);
    assert.equal(await r.run(''), 2);
    assert.ok(r.err.data.startsWith('Spec-driven development'));
    r.err.data = '';
    assert.equal(await r.run('list --bogus'), 2);
    assert.equal(r.err.data, "error: unexpected argument '--bogus' found\n\nFor more information, try '--help'.\n");
    r.err.data = '';
    assert.equal(await r.run('frobnicate'), 2);
    assert.match(r.err.data, /^error: unrecognized subcommand 'frobnicate'/);
    assert.equal(await r.run('new'), 2);
    assert.match(r.err.data, /required arguments were not provided:\n {2}<NAME>/);
    assert.equal(await r.run('list --format yaml'), 2);
    assert.equal(await r.run('new x --type nope --description d'), 2);
    assert.match(r.err.data, /invalid value 'nope' for '--type <TYPE>'/);
    assert.equal(await r.run('new x --workflow sideways --description d'), 2);
    assert.equal(await r.run('new x --detail mid --description d'), 2);
    assert.equal(await r.run('list --agent'), 2);
    assert.match(r.err.data, /a value is required for '--agent <VALUE>'/);
    assert.equal(r.sessions.length, 0);
    assert.equal(typeof runSpecCommand, 'function');
  } finally {
    r.w.cleanup();
  }
});

test('list / status / view against a temp workspace', async () => {
  const r = rig();
  try {
    assert.equal(await r.run('list'), 0);
    assert.equal(r.out.data, '');
    assert.match(r.err.data, /No specs found in .*\.kiro\/specs\. Create one with: kiro-claude spec new <name>/);
    writeSpec(r.w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    writeSpec(r.w, 'half', { requirements: REQ_MD });
    assert.equal(await r.run('list'), 0);
    assert.equal(r.out.data, 'half         feature  requirements ✓  -\ntodo-export  feature  tasks ✓         0/5\n');
    r.out.data = '';
    assert.equal(await r.run('list --format json'), 0);
    const j = JSON.parse(r.out.data) as { name: string; phase: string }[];
    assert.deepEqual(
      j.map((x) => [x.name, x.phase]),
      [
        ['half', 'design'],
        ['todo-export', 'execution'],
      ],
    );
    r.out.data = '';
    assert.equal(await r.run('status todo-export'), 0);
    assert.match(r.out.data, /^Spec: todo-export \(feature, requirements-first\)\n/);
    r.out.data = '';
    assert.equal(await r.run('status todo-export --format json'), 0);
    const st = JSON.parse(r.out.data) as { tasks: { id: string; status: string; optional: boolean }[]; lint: string[] };
    assert.deepEqual(st.tasks.slice(0, 3), [
      { id: '1', title: 'Implement the exporter', status: 'not_started', optional: false, checkpoint: false, parentId: null },
      { id: '1.1', title: 'Create `src/export.ts` with `toCsv(todos)`', status: 'not_started', optional: false, checkpoint: false, parentId: '1' },
      { id: '1.2', title: 'Write property test for row count', status: 'not_started', optional: true, checkpoint: false, parentId: '1' },
    ]);
    r.out.data = '';
    assert.equal(await r.run('status'), 0);
    assert.match(r.out.data, /^half/);
    assert.equal(await r.run('status nope'), 1);
    assert.match(r.err.data, /error: spec 'nope' not found/);
    r.out.data = '';
    assert.equal(await r.run('view todo-export design'), 0);
    assert.equal(r.out.data, DESIGN_MD);
    r.out.data = '';
    assert.equal(await r.run('view half'), 0);
    assert.equal(r.out.data, REQ_MD);
    assert.equal(await r.run('view half tasks'), 1);
    assert.equal(await r.run('view half bogus'), 2);
    assert.equal(r.sessions.length, 0, 'read-only commands never start a session');
  } finally {
    r.w.cleanup();
  }
});

test('a rejected usage limit is shown once on stderr (C19: the session sends only the rate_limit event)', async () => {
  const base = fakeModel({});
  const script: ModelScript = async (input, s) => {
    const r = await base(input, s);
    return { ...r, events: [{ type: 'rate_limit', status: 'rejected', resetsAt: 1_900_000_000 }, { type: 'rate_limit', status: 'allowed' }, { type: 'text_delta', text: r.text ?? '' }] };
  };
  const r = rig({}, { createSession: async (o) => new MockSession(o, script) as KiroSession });
  try {
    await r.run('new todo-export --description Export todos as CSV');
    const hits = r.err.data.match(/WARNING: Claude Code usage limit reached \(resets 2030-03-17T17:46:40\.000Z\)/g) ?? [];
    assert.equal(hits.length, 1, r.err.data);
  } finally {
    r.w.cleanup();
  }
});

test('new (non-interactive): stops at the first checkpoint; approve continues; --yes finishes', async () => {
  const r = rig();
  try {
    assert.equal(await r.run('new todo-export'), 2);
    assert.match(r.err.data, /a description is required/);
    r.err.data = '';
    assert.equal(await r.run('new todo-export --description Export todos as CSV'), 0);
    // `--description Export` takes one word; the rest are positionals ⇒ description = "Export"
    assert.match(r.sessions[0]!.prompts[0]!.text, /User description \(ground truth\): Export$/);
    assert.ok(fs.existsSync(path.join(r.w.specs, 'todo-export', 'requirements.md')));
    assert.ok(!fs.existsSync(path.join(r.w.specs, 'todo-export', 'design.md')));
    assert.match(r.err.data, /^Created \.kiro\/specs\/todo-export\/$/m);
    assert.match(r.err.data, /^requirements\.md ready \(2 requirements, 3 criteria\)$/m);
    assert.match(r.err.data, /requirements\.md is waiting for review\. Approve with: kiro-claude spec approve todo-export · Request changes: kiro-claude spec revise todo-export <feedback>/);
    // renderer: assistant text ⇒ stdout, tool lines ⇒ stderr
    assert.match(r.out.data, /Wrote requirements\.md\. Please review\.\n/);
    assert.match(r.err.data, /🛠️ {2}Using tool: write\n ⋮ \n ● Path: x/);
    assert.deepEqual(
      r.sessions.map((s) => [s.closed, s.started]),
      [[true, true]],
    );
    const o = r.opts[0]!;
    assert.equal(o.origin, 'spec');
    assert.equal(o.interactive, false);
    assert.equal(o.env, r.w.ctx.env);
    assert.deepEqual(o.specPhase, { name: 'requirements', allowedWritePaths: [path.join(r.w.specs, 'todo-export', 'requirements.md')] });
    // revise
    assert.equal(await r.run('revise todo-export add TSV'), 0);
    assert.match(r.sessions[1]!.prompts[0]!.text, /^Revise .*requirements\.md per this feedback, in place, then stop again:\nadd TSV$/);
    assert.equal(await r.run('revise todo-export'), 2);
    // approve drafts design and stops; approve --yes runs to the end
    assert.equal(await r.run('approve todo-export'), 0);
    assert.ok(fs.existsSync(path.join(r.w.specs, 'todo-export', 'design.md')));
    assert.ok(!fs.existsSync(path.join(r.w.specs, 'todo-export', 'tasks.md')));
    assert.equal(await r.run('approve todo-export --yes'), 0);
    assert.ok(fs.existsSync(path.join(r.w.specs, 'todo-export', 'tasks.md')));
    assert.match(r.err.data, /Spec ready\. Run all tasks: kiro-claude spec run todo-export · Step through: kiro-claude spec run todo-export --next/);
    assert.ok(r.sessions.every((s) => s.closed));
    assert.equal(await r.run('approve nope'), 1);
    // already exists
    assert.equal(await r.run('new todo-export --description again'), 1);
  } finally {
    r.w.cleanup();
  }
});

test('new --yes with session flags; name normalization; bugfix and quick types', async () => {
  const r = rig();
  try {
    assert.equal(await runSpecCommandWith(['new', 'Todo Export', '--yes', '-a', '--agent', 'dev', '--model', 'claude-sonnet-5.5', '--trust-tools', 'read, shell', '-d', 'Export todos'], r.ctx, r.deps), 0);
    assert.match(r.err.data, /Using spec name 'todo-export'/);
    assert.equal(parseTasks(read(path.join(r.w.specs, 'todo-export', 'tasks.md'))).tasks.length, 7);
    const o = r.opts[0]!;
    assert.deepEqual([o.trustAllTools, o.agentName, o.model, o.trustTools], [true, 'dev', 'claude-sonnet-5.5', ['read', 'shell']]);
    assert.equal(r.opts.length, 3, 'one restricted session per phase');
    assert.equal(r.opts[1]!.fork!.fromClaudeSessionId, r.sessions[0]!.claudeSessionId);
    assert.equal(await runSpecCommandWith(['new', 'fix-save', '--type', 'bugfix', '--yes', '--description', 'double save'], r.ctx, r.deps), 0);
    assert.ok(fs.existsSync(path.join(r.w.specs, 'fix-save', 'bugfix.md')));
    assert.equal(await runSpecCommandWith(['new', 'q', '--type', 'quick', '--yes', '--description', 'quick one'], r.ctx, r.deps), 0);
    assert.ok(fs.existsSync(path.join(r.w.specs, 'q', 'tasks.md')));
    assert.equal(await runSpecCommandWith(['new', '!!!', '--description', 'x'], r.ctx, r.deps), 2);
  } finally {
    r.w.cleanup();
  }
});

test('new --type quick (TTY): a cancelled clarifying-questions turn ends the spec with exit 1; no document turn is sent (F3)', async () => {
  const log: string[] = [];
  const r = rig({ log, override: (i) => (/^Quick Spec/.test(i.text) ? { text: '[1]: partial', stopReason: 'cancelled' } : undefined) }, { isTTY: true });
  try {
    (r.ctx.stdin as unknown as PassThrough).end(); // nothing more is typed: a later question would read EOF
    const code = await runSpecCommandWith(['new', 'my-feature', '--type', 'quick', '--description', 'do it'], r.ctx, r.deps);
    assert.deepEqual(log.map((t) => t.replace(/^(Quick Spec|Phase: [A-Z]+).*$/, '$1')), ['Quick Spec'], `turns sent:\n${r.out.data}\n${r.err.data}`);
    assert.equal(code, 1);
    assert.ok(`${r.out.data}${r.err.data}`.includes('✗ Quick Spec clarifying questions failed: interrupted'), `${r.out.data}\n${r.err.data}`);
    assert.equal(fs.existsSync(path.join(r.w.specs, 'my-feature', 'requirements.md')), false);
    assert.ok(r.sessions.every((s) => s.closed), 'the CLI closes its sessions');
  } finally {
    r.w.cleanup();
  }
});

test('run: exit codes, summary on stdout, hooks from config are optional', async () => {
  const r = rig({ taskText: { '2.1': 'nope\nTASK_RESULT: blocked - flaky test' } });
  try {
    const dir = writeSpec(r.w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    assert.equal(await r.run('run todo-export --next'), 0);
    assert.equal(parseTasks(read(path.join(dir, 'tasks.md'))).byId.get('1.1')!.box, 'x');
    assert.match(r.out.data, /Spec run finished: 1 completed\. 2 required tasks remain\./);
    r.out.data = '';
    assert.equal(await r.run('run todo-export'), 1);
    assert.match(r.out.data, /Spec run finished: 0 completed, 1 blocked\. 2 required tasks remain\.\n {2}2\.1: blocked — flaky test\nContinue with kiro-claude spec run todo-export/);
    assert.equal(await r.run('run todo-export 1.2,2.2 --include-optional'), 0);
    const t = parseTasks(read(path.join(dir, 'tasks.md')));
    assert.deepEqual(['1.2', '2.2', '1'].map((id) => t.byId.get(id)!.box), ['x', 'x', 'x']);
    assert.equal(await r.run('run todo-export 9.9'), 1);
    assert.equal(await r.run('run nope'), 1);
    assert.ok(r.opts.every((o) => o.specPhase === undefined && o.origin === 'spec'));
    assert.ok(r.sessions.every((s) => s.closed));
  } finally {
    r.w.cleanup();
  }
});

test('run: PreTaskExec/PostTaskExec hooks loaded from .kiro/hooks drive the injected runner', async () => {
  const w = makeWs();
  try {
    fs.mkdirSync(path.join(w.proj, '.kiro', 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(w.proj, '.kiro', 'hooks', 'tasks.json'),
      JSON.stringify({ version: 'v1', hooks: [{ name: 'pre', trigger: 'PreTaskExec', action: { type: 'command', command: 'true' } }] }),
    );
    const hooks = recordingHooks();
    let seen: number | undefined;
    const r = rig({}, { hookRunnerFactory: (h) => ((seen = h.length), hooks) }, w);
    writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    assert.equal(await r.run('run todo-export --next'), 0);
    assert.equal(seen, 1);
    assert.deepEqual(
      hooks.calls.map((c) => [c.trigger, c.task.taskId]),
      [
        ['PreTaskExec', '1.1'],
        ['PostTaskExec', '1.1'],
      ],
    );
  } finally {
    w.cleanup();
  }
});

test('analyze: findings on stdout; --yes applies the first fix', async () => {
  const analysis = JSON.stringify({ findings: [{ id: 'F1', category: 'conflict', requirements: ['1.2'], explanation: 'e', question: 'q?', options: [{ label: 'L', edit: 'E' }], severity: 'high' }] });
  const r = rig({ analysis });
  try {
    writeSpec(r.w, 'todo-export', { requirements: REQ_MD });
    assert.equal(await r.run('analyze todo-export'), 0);
    assert.equal(r.out.data, 'Question 1/1 · conflict · high · requirements 1.2\ne\n? q?\n  a. L — E\n', 'analysis JSON is not echoed');
    assert.deepEqual(r.opts[0]!.specPhase, { name: 'analyze', allowedWritePaths: [] });
    assert.equal(await r.run('analyze todo-export --yes'), 0);
    assert.ok(read(path.join(r.w.specs, 'todo-export', 'requirements.md')).includes('SHALL use UTF-8'));
    assert.equal(await r.run('analyze nope'), 1);
    assert.equal(await r.run('sync todo-export'), 1, 'no tasks.md yet');
  } finally {
    r.w.cleanup();
  }
});

function scriptedIO(answers: string[], prompts: string[]): SpecCliIO {
  return {
    question: async (p) => {
      prompts.push(p);
      return answers.shift() ?? '';
    },
    close: () => undefined,
  };
}

test('interactive TTY: pickers and checkpoints on stdout; numbered choices', async () => {
  const prompts: string[] = [];
  const r = rig({}, { isTTY: true, io: scriptedIO(['1', '1', 'Export todos', 'x', '9', '4'], prompts) });
  try {
    assert.equal(await r.run('new todo-export'), 0);
    assert.match(r.out.data, /\? What kind of spec\?\n {2}1\. Build a Feature\n {2}2\. Fix a Bug\n {2}3\. Quick Spec\n/);
    assert.match(r.out.data, /\? Which workflow\?\n {2}1\. Requirements-First\n {2}2\. Design-First\n/);
    assert.match(r.out.data, /\? Do the requirements look good\? If so, we can move on to the design\.\n {2}1\. Approve and continue to design\n {2}2\. Request changes…\n {2}3\. Analyze requirements\n {2}4\. Stop here \(resume later with kiro-claude spec approve todo-export · kiro-claude spec revise todo-export <feedback>\)\n/);
    assert.deepEqual(prompts, ['Choose 1-3 (empty to cancel): ', 'Choose 1-2 (empty to cancel): ', 'What should this spec cover? ', 'Choose 1-4 (empty to cancel): ', 'Choose 1-4 (empty to cancel): ', 'Choose 1-4 (empty to cancel): ']);
    assert.equal(r.opts[0]!.interactive, true);
    assert.match(r.err.data, /Stopped at the requirements\.md checkpoint\./);
    // design-first asks for the detail level
    const p2: string[] = [];
    const rd = rig({}, { isTTY: true, io: scriptedIO(['1', '2', '2', 'Build it', '4'], p2) }, r.w);
    assert.equal(await rd.run('new df'), 0);
    assert.match(rd.out.data, /\? Start with which level of design\?\n {2}1\. High Level Design\n {2}2\. Low Level Design\n/);
    assert.match(rd.sessions[0]!.prompts[0]!.text, /^Detail level: LOW-LEVEL/);
    // --yes disables interactivity even on a TTY
    const r2 = rig({}, { isTTY: true, io: scriptedIO([], []) }, r.w);
    assert.equal(await r2.run('approve todo-export --yes'), 0);
    assert.equal(r2.opts[0]!.interactive, false);
  } finally {
    r.w.cleanup();
  }
});

test('interactive TTY: tool approval prompt maps y/n/t/other; non-interactive denies', async () => {
  const prompts: string[] = [];
  // '' answers the design checkpoint (cancel ⇒ stop); then: '' (re-ask), t, n, y, free text
  const r = rig({}, { isTTY: true, io: scriptedIO(['', '', 't', 'n', 'y', 'please use the other file'], prompts) });
  try {
    writeSpec(r.w, 'todo-export', { requirements: REQ_MD });
    assert.equal(await r.run('approve todo-export'), 0);
    const ui = r.opts[0]!.ui;
    const req = { call: { displayName: 'shell', summary: 'I will run the following shell command: ls' }, requestId: 'r1', reasons: [], agentName: 'kiro_default' } as unknown as ApprovalRequest;
    const sig = new AbortController().signal;
    assert.deepEqual(await ui.requestApproval(req, sig), { kind: 'allow-always' });
    assert.deepEqual(await ui.requestApproval(req, sig), { kind: 'deny' });
    assert.deepEqual(await ui.requestApproval(req, sig), { kind: 'allow-once' });
    assert.deepEqual(await ui.requestApproval(req, sig), { kind: 'redirect', text: 'please use the other file' });
    assert.equal(prompts.filter((p) => p === "Allow this action? Use 't' to trust (always allow) this tool for the session. [y/n/t]: ").length, 5);
    assert.match(r.err.data, /🛠️ {2}Using tool: shell\n ⋮ \n ● I will run the following shell command: ls/);
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await ui.requestApproval(req, aborted.signal), { kind: 'cancelled' });
    const r2 = rig({}, {}, r.w);
    assert.equal(await r2.run('revise todo-export more'), 0);
    assert.deepEqual(await r2.opts[0]!.ui.requestApproval(req, sig), { kind: 'deny' });
    r2.opts[0]!.ui.notice('warn', 'a warning');
    assert.match(r2.err.data, /a warning\n/);
  } finally {
    r.w.cleanup();
  }
});

/** Counts `[y/n/t]` prompts; throws past a bound (a microtask-only loop starves every timer). */
class BoundedOut extends Writable {
  data = '';
  isTTY = true;
  writes = 0;
  prompts = 0;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += chunk.toString();
    cb();
  }
  override write(chunk: unknown, ...rest: unknown[]): boolean {
    this.writes++;
    if (String(chunk).includes('[y/n/t]')) this.prompts++;
    if (this.writes > 200) throw new Error(`RUNAWAY: ${this.prompts} approval prompts on a closed stdin`);
    return (super.write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }
}

test('interactive TTY: a tool approval after stdin EOF (Ctrl+D) is cancelled, never re-asked forever (C13)', async () => {
  const w = makeWs();
  try {
    const stdin = new PassThrough();
    stdin.end(); // Ctrl+D / a closed pipe before the approval
    await new Promise((r) => setImmediate(r));
    const out = new BoundedOut();
    const err = new Capture();
    const ctx: CliContext = {
      ws: w.ctx,
      settings: mockSettings(),
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: out as unknown as NodeJS.WriteStream,
      stderr: err as unknown as NodeJS.WriteStream,
      progName: 'kiro-claude',
      verbosity: 0,
    };
    const answers: unknown[] = [];
    let failure: unknown;
    const req = { call: { displayName: 'shell', summary: 'echo hi' }, requestId: 'r1', reasons: [], agentName: 'kiro_default' } as unknown as ApprovalRequest;
    const deps: SpecCliDeps = {
      isTTY: true,
      createSession: async (o) => {
        try {
          // two approvals: the second one starts with the input already closed
          answers.push(await o.ui.requestApproval(req, new AbortController().signal));
          answers.push(await o.ui.requestApproval(req, new AbortController().signal));
        } catch (e) {
          failure = e;
        }
        throw new Error('stop after the approvals');
      },
    };
    const code = await runSpecCommandWith(['new', 'my-feature', '--type', 'quick', '--description', 'do it'], ctx, deps);
    assert.equal(failure, undefined, `${(failure as Error | undefined)?.message}`);
    assert.ok(answers.length >= 2, `${answers.length} approvals`);
    assert.deepEqual(answers, answers.map(() => ({ kind: 'cancelled' })));
    assert.equal(out.prompts, answers.length, 'the question is asked once per approval');
    assert.equal(code, 1);
  } finally {
    w.cleanup();
  }
});

test('interactive TTY: Ctrl+D while the [y/n/t] question waits cancels the approval (C13)', async () => {
  const w = makeWs();
  try {
    const stdin = new PassThrough(); // still open: the user has not answered yet
    const out = new BoundedOut();
    const ctx: CliContext = {
      ws: w.ctx,
      settings: mockSettings(),
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: out as unknown as NodeJS.WriteStream,
      stderr: new Capture() as unknown as NodeJS.WriteStream,
      progName: 'kiro-claude',
      verbosity: 0,
    };
    let answer: unknown;
    let failure: unknown;
    let calls = 0;
    const req = { call: { displayName: 'shell', summary: 'echo hi' }, requestId: 'r1', reasons: [], agentName: 'kiro_default' } as unknown as ApprovalRequest;
    const deps: SpecCliDeps = {
      isTTY: true,
      createSession: async (o) => {
        if (calls++ > 0) throw new Error('stop'); // the driver may try again: no second approval
        const pending = o.ui.requestApproval(req, new AbortController().signal);
        // an empty Enter re-asks (Q); then Ctrl+D ends the input while the question waits
        setTimeout(() => stdin.write('\n'), 20);
        setTimeout(() => stdin.end(), 60);
        try {
          answer = await pending;
        } catch (e) {
          failure = e;
        }
        throw new Error('stop after the approval');
      },
    };
    const code = await runSpecCommandWith(['new', 'my-feature', '--type', 'quick', '--description', 'do it'], ctx, deps);
    assert.equal(failure, undefined, `${(failure as Error | undefined)?.message}`);
    assert.deepEqual(answer, { kind: 'cancelled' });
    assert.equal(out.prompts, 2, 'asked, re-asked after the empty answer, then cancelled at EOF');
    assert.equal(code, 1);
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── e2e: real KiroSession + fake-claude ─────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const sessionModule = path.join(here, '..', '..', 'src', 'session', 'kiroSession.js');

test('e2e (fake-claude): phase write restriction reaches the gate; writes elsewhere are denied', { skip: !fs.existsSync(sessionModule) && 'session/kiroSession.js not built' }, async () => {
  const w = makeWs('kc-spec-e2e-');
  try {
    const claudeConfig = path.join(w.root, 'claude-config');
    const runtime = path.join(w.root, 'run');
    fs.mkdirSync(claudeConfig);
    fs.mkdirSync(runtime, { mode: 0o700 });
    const reqPath = path.join(w.specs, 'e2e', 'requirements.md');
    const script = {
      turns: [
        {
          match: 'Phase: REQUIREMENTS',
          steps: [
            { tool: { name: 'Write', input: { file_path: path.join(w.proj, 'notes.md'), content: 'x' } } },
            { text: 'OUTSIDE: {{lastToolResult}}' },
            { tool: { name: 'Write', input: { file_path: reqPath, content: '# Requirements Document\n' } } },
            { text: 'INSIDE: {{lastToolResult}}' },
          ],
        },
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
    const ws: WorkspaceContext = createWorkspaceContext(w.proj, env);
    const out = new Capture();
    const err = new Capture();
    const ctx: CliContext = {
      ws,
      settings: mockSettings(),
      stdin: new PassThrough() as unknown as NodeJS.ReadStream,
      stdout: out as unknown as NodeJS.WriteStream,
      stderr: err as unknown as NodeJS.WriteStream,
      progName: 'kiro-claude',
      verbosity: 0,
    };
    const code = await runSpecCommandWith(['new', 'e2e', '--description', 'demo'], ctx);
    // the fake does not execute tools, so requirements.md is never written: headless ⇒ exit 1
    assert.equal(code, 1, err.data);
    assert.match(out.data, /OUTSIDE: .*Spec phase requirements: only .*requirements\.md may be written now/);
    assert.doesNotMatch(out.data, /INSIDE: .*Spec phase/);
    assert.match(err.data, /requirements\.md was not written/);
    const starts = fs
      .readFileSync(path.join(w.root, 'fake.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; argv?: string[] })
      .filter((e) => e.event === 'start' && e.argv?.includes('-p'));
    assert.equal(starts.length, 1, 'one claude child for the requirements phase (probes excluded)');
  } finally {
    w.cleanup();
  }
});
