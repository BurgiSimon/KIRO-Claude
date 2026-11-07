/**
 * Review X1 (spec-links), the verifier's findings on the fix:
 *  - V1: a spec with a refused INPUT document (requirements.md committed as a link out of the
 *    workspace, design.md regular, tasks.md missing): the design checkpoint said nothing about it
 *    and offered Approve, and approving drafted tasks.md with a prompt that has the model read
 *    requirements.md (through the link). The phases must name the refusal, offer no Approve,
 *    and draft nothing; `approve` (REPL and `kiro-claude spec approve -y`) refuses with the reason.
 *  - V2: a `.config.kiro` committed as a link: the spec's type and workflow are unknown, but
 *    `/spec <name>` silently used the defaults, asked for a description and drafted a document.
 *    It must refuse with the reason before asking anything.
 *  - V3: a `.kiro/specs` linked out of the workspace: `list` enumerated the folder it points to
 *    (every directory there became a "refused" spec). The listing must not read it and must say why.
 *  - V4: a document that becomes a link while a task session starts (a parallel task's turn) was
 *    silently left out of that task's context. The task must fail with the reason instead.
 *  - V5: `/spec run` without a scope asked "Which tasks of …?" for a spec it then refused, and
 *    `/spec <name>` at the execution stage offered task runs it then refused.
 *  - V6: `sync` checked only tasks.md, but its prompt has the model compare tasks.md "with
 *    requirements/design" and add tasks for uncovered criteria: with a refused design.md the turn
 *    ran anyway. It must refuse a spec with any refused file, like `run` and the phases.
 *  - V7: `approve` / `revise` of a spec whose folder is a dangling link said "requirements.md has
 *    not been written", which it can never be there; they must name the reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { CliContext, KiroSession, KiroSessionOptions } from '../../src/types.js';
import { listSpecs } from '../../src/spec/store.js';
import { runSpecCommandWith, type SpecCliDeps } from '../../src/spec/cli.js';
import { specSlashCommands } from '../../src/spec/slash.js';
import { approveSpec, createReplRuntime, resumeSpec, runSpecTasks, syncSpec } from '../../src/spec/workflow.js';
import { DESIGN_MD, MockHost, MockSession, REQ_MD, TASKS_MD, fakeModel, makeWs, mockSettings, read, writeSpec, type Ws } from './helpers.js';

const SECRET = 'KC-VERIFY-SECRET-5d1e';

function outside(w: Ws, name: string, content: string): string {
  const dir = path.join(w.root, 'outside');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

class Capture extends Writable {
  data = '';
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += chunk.toString();
    cb();
  }
}

function cli(w: Ws): { out: Capture; err: Capture; sessions: MockSession[]; run(args: string): Promise<number> } {
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
  const sessions: MockSession[] = [];
  const script = fakeModel();
  const deps: SpecCliDeps = {
    createSession: async (o: KiroSessionOptions) => {
      const s = new MockSession(o, script);
      sessions.push(s);
      return s as KiroSession;
    },
    isTTY: false,
  };
  return {
    out,
    err,
    sessions,
    run: (args) => {
      out.data = '';
      err.data = '';
      return runSpecCommandWith(args.split(' ').filter(Boolean), ctx, deps);
    },
  };
}

/** Spec `feat`: requirements.md a link out of the workspace, design.md regular, no tasks.md. */
function inputLinked(w: Ws): string {
  const dir = writeSpec(w, 'feat', { design: DESIGN_MD });
  fs.symlinkSync(outside(w, 'requirements.md', `${REQ_MD}\n${SECRET}\n`), path.join(dir, 'requirements.md'));
  return dir;
}

test('V1 /spec <name>: the design checkpoint names a refused requirements.md, offers no Approve, and nothing is drafted', async () => {
  const w = makeWs('kc-r5x-links-v-');
  try {
    const dir = inputLinked(w);
    const log: string[] = [];
    const h = new MockHost(w.ctx, fakeModel({ log }));
    h.chooseAnswers = ['Stop here'];
    const r = await resumeSpec(createReplRuntime(h, { openEditor: null }), 'feat');
    assert.notEqual(r.status, 'ready');
    assert.match(h.text, /requirements\.md is a symbolic link/, 'the checkpoint did not say why');
    const opts = h.chosen[0]?.options ?? [];
    assert.ok(!opts.some((o) => /^Approve/.test(o)), `Approve was offered: ${JSON.stringify(opts)}`);
    assert.deepEqual(log, [], 'a phase turn ran');
    assert.equal(fs.existsSync(path.join(dir, 'tasks.md')), false, 'tasks.md was drafted');
    assert.ok(!h.text.includes(SECRET));
  } finally {
    w.cleanup();
  }
});

test('V1 approve (REPL runtime and `kiro-claude spec approve -y`): a refused input document is named, nothing is drafted', async () => {
  const w = makeWs('kc-r5x-links-v-');
  try {
    const dir = inputLinked(w);
    const log: string[] = [];
    const h = new MockHost(w.ctx, fakeModel({ log }));
    const r = await approveSpec(createReplRuntime(h, { openEditor: null }), 'feat');
    assert.equal(r.status, 'error');
    assert.match(h.text, /requirements\.md is a symbolic link/);
    assert.deepEqual(log, [], 'a phase turn ran');
    assert.equal(h.chosen.length, 0, 'a checkpoint was shown');
    const c = cli(w);
    assert.equal(await c.run('approve feat -y'), 1);
    assert.match(c.err.data, /requirements\.md is a symbolic link/);
    assert.equal(c.sessions.length, 0, 'a session was started');
    assert.equal(fs.existsSync(path.join(dir, 'tasks.md')), false, 'tasks.md was drafted');
  } finally {
    w.cleanup();
  }
});

test('V2 a .config.kiro committed as a link: /spec <name> refuses with the reason before asking a description; nothing is drafted', async () => {
  const w = makeWs('kc-r5x-links-v-');
  try {
    const dir = writeSpec(w, 'feat', { design: DESIGN_MD });
    fs.symlinkSync(outside(w, 'cfg.json', '{"specId":"x","workflowType":"design-first","specType":"feature"}'), path.join(dir, '.config.kiro'));
    const log: string[] = [];
    const h = new MockHost(w.ctx, fakeModel({ log }));
    h.askAnswers = ['a description'];
    h.chooseAnswers = ['Stop here'];
    const r = await resumeSpec(createReplRuntime(h, { openEditor: null }), 'feat');
    assert.equal(r.status, 'error');
    assert.match(h.text, /\.config\.kiro is a symbolic link/);
    assert.deepEqual(h.asked, [], 'a description was asked for');
    assert.deepEqual(log, [], 'a phase turn ran');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.config.kiro', 'design.md']);
  } finally {
    w.cleanup();
  }
});

test('V3 a .kiro/specs linked out of the workspace is not enumerated; list says why (CLI and REPL)', async () => {
  const w = makeWs('kc-r5x-links-v-');
  try {
    const out = path.join(w.root, 'outside-home');
    fs.mkdirSync(path.join(out, 'private-project'), { recursive: true });
    fs.mkdirSync(path.join(out, 'mail'), { recursive: true });
    fs.writeFileSync(path.join(out, 'mail', 'tasks.md'), TASKS_MD);
    fs.rmSync(w.specs, { recursive: true });
    fs.symlinkSync(out, w.specs);
    assert.deepEqual(listSpecs(w.ctx), [], 'the outside folder was enumerated');
    const c = cli(w);
    for (const cmd of ['list', 'status', 'list --format json']) {
      assert.equal(await c.run(cmd), 1, cmd);
      assert.match(c.err.data, /\.kiro\/specs resolves to .*outside-home, outside the workspace/, cmd);
      assert.doesNotMatch(c.out.data + c.err.data, /private-project|mail/, cmd);
    }
    const h = new MockHost(w.ctx, fakeModel());
    const slash = specSlashCommands[0]!;
    for (const line of ['list', 'status', 'run']) {
      await slash.run(line.split(' '), `/spec ${line}`, h);
      assert.match(h.printed.at(-1)!, /\.kiro\/specs resolves to .*outside-home, outside the workspace/, line);
    }
    assert.doesNotMatch(h.text, /private-project|mail/);
    assert.equal(h.chosen.length, 0, 'a picker was shown');
  } finally {
    w.cleanup();
  }
});

test('V4 a document that becomes a link while a task session starts: the task fails with the reason (its context does not silently lose it)', async () => {
  const w = makeWs('kc-r5x-links-v-');
  try {
    const dir = writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const target = outside(w, 'design.md', `${DESIGN_MD}\n${SECRET}\n`);
    class LinkingHost extends MockHost {
      override async createSession(opts: Partial<KiroSessionOptions>): Promise<KiroSession> {
        // e.g. a parallel task's turn replaces design.md while this task's Claude starts
        fs.rmSync(path.join(dir, 'design.md'));
        fs.symlinkSync(target, path.join(dir, 'design.md'));
        return super.createSession(opts);
      }
    }
    const h = new LinkingHost(w.ctx, fakeModel());
    const r = await runSpecTasks(createReplRuntime(h, { openEditor: null }), 'feat', { kind: 'next' });
    assert.notEqual(r.status, 'completed');
    assert.equal(r.outcomes[0]?.status, 'failed');
    assert.match(r.outcomes[0]?.reason ?? '', /design\.md is a symbolic link/);
    const prompts = h.sessions.flatMap((s) => s.prompts);
    assert.ok(!prompts.some((p) => /Execute Task/.test(p.text)), 'the task turn ran without design.md');
    assert.equal(read(target), `${DESIGN_MD}\n${SECRET}\n`);
    assert.ok(!h.text.includes(SECRET));
  } finally {
    w.cleanup();
  }
});

test('V5 /spec run without a scope: a refused spec is refused before "Which tasks of …?" is asked', async () => {
  const w = makeWs('kc-r5x-links-v-');
  try {
    const dir = writeSpec(w, 'feat', { requirements: REQ_MD, tasks: TASKS_MD });
    fs.symlinkSync(outside(w, 'design.md', DESIGN_MD), path.join(dir, 'design.md'));
    const h = new MockHost(w.ctx, fakeModel());
    await specSlashCommands[0]!.run(['run', 'feat'], '/spec run feat', h);
    assert.equal(h.chosen.length, 0, `a scope was asked: ${JSON.stringify(h.chosen)}`);
    assert.match(h.printed.at(-1)!, /Spec 'feat' cannot run: .*design\.md is a symbolic link/);
    // `/spec feat` at the execution stage: the step-through menu offers no task run it would refuse
    h.chooseAnswers = ['Stop'];
    await specSlashCommands[0]!.run(['feat'], '/spec feat', h);
    assert.match(h.text, /design\.md is a symbolic link/);
    const opts = h.chosen.at(-1)?.options ?? [];
    assert.ok(!opts.some((o) => /^(Run|Select tasks)/.test(o)), `task runs were offered: ${JSON.stringify(opts)}`);
    assert.ok(opts.some((o) => /^Review tasks\.md/.test(o)));
  } finally {
    w.cleanup();
  }
});

test('V6 sync: a spec with a refused design.md (tasks.md regular) is refused with the reason; no sync turn runs (REPL and CLI)', async () => {
  const w = makeWs('kc-r5x-links-v-');
  try {
    const dir = writeSpec(w, 'feat', { requirements: REQ_MD, tasks: TASKS_MD });
    fs.symlinkSync(outside(w, 'design.md', `${DESIGN_MD}\n${SECRET}\n`), path.join(dir, 'design.md'));
    const log: string[] = [];
    const h = new MockHost(w.ctx, fakeModel({ log }));
    const r = await syncSpec(createReplRuntime(h, { openEditor: null }), 'feat');
    assert.equal(r.status, 'error');
    assert.match(h.text, /Cannot sync .*design\.md is a symbolic link/);
    assert.deepEqual(log, [], 'a sync turn ran');
    const c = cli(w);
    assert.equal(await c.run('sync feat'), 1);
    assert.match(c.err.data, /design\.md is a symbolic link/);
    assert.equal(c.sessions.length, 0, 'a session was started');
    assert.equal(read(path.join(dir, 'tasks.md')), TASKS_MD);
  } finally {
    w.cleanup();
  }
});

test('V7 approve / revise of a spec folder that is a dangling link name the reason (not "has not been written")', async () => {
  const w = makeWs('kc-r5x-links-v-');
  try {
    fs.symlinkSync(path.join(w.root, 'gone'), path.join(w.specs, 'feat'));
    const c = cli(w);
    assert.equal(await c.run('approve feat'), 1);
    assert.match(c.err.data, /resolves to nothing \(dangling, or a loop\)/);
    assert.doesNotMatch(c.err.data, /has not been written/);
    assert.equal(await c.run('revise feat shorter'), 1);
    assert.match(c.err.data, /resolves to nothing \(dangling, or a loop\)/);
    assert.doesNotMatch(c.err.data, /has not been written/);
    assert.equal(c.sessions.length, 0);
    assert.equal(fs.existsSync(path.join(w.root, 'gone')), false, 'the link target was created');
  } finally {
    w.cleanup();
  }
});
