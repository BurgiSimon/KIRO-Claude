/**
 * Review X1 (spec-links): kiro-claude's OWN reads and writes of spec documents and their folders
 * follow the rules of the spec-phase write allowance (policy/specwrite.ts): a symbolic link AT a
 * document (or `.config.kiro`) is never followed, a link above it that resolves to nothing is
 * refused, and nothing whose real path is outside the workspace is read or written. A `.kiro/specs`
 * or feature folder linked INSIDE the workspace keeps working. A refused document gives a clear
 * message (list, status, view, run, sync, analyze, the phases), never a crash, and is never treated
 * as missing in a way that would overwrite it.
 *
 * Covered: store (summarize, load, context block, list, config, createSpecFolder), model
 * (writeTaskStatus), workflow (repair after a phase turn, box updates during a run, sync, analyze),
 * `kiro-claude spec` (view, status, list, run, new, sync, analyze) and `/spec` in the REPL (view,
 * status, list, run). Only existing exports are used, so the file compiles against the code
 * before the fix (where these tests fail for the reported reason).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { CliContext, KiroSession, KiroSessionOptions } from '../../src/types.js';
import { parseTasks, writeTaskStatus } from '../../src/spec/model.js';
import { createSpecFolder, listSpecs, loadSpec, loadSpecDir, readSpecConfig, resolveSpecDir, specContextBlock, specSummaryJson, summarizeSpecDir } from '../../src/spec/store.js';
import { runSpecCommandWith, type SpecCliDeps } from '../../src/spec/cli.js';
import { specSlashCommands } from '../../src/spec/slash.js';
import { analyzeRequirements, approveSpec, createReplRuntime, runSpecTasks, syncSpec } from '../../src/spec/workflow.js';
import { DESIGN_MD, MockHost, MockSession, REQ_MD, TASKS_MD, fakeModel, makeWs, mockSettings, read, writeSpec, type FakeModelOptions, type Ws } from './helpers.js';

const SECRET = 'KC-OUTSIDE-SECRET-7f3a';
/** An outside file that tasks.md normalization would change (`* [ ]` ⇒ `- [ ]`). */
const OUTSIDE_TASKS = `# My notes ${SECRET}\n\n* [ ] 1. Outside task\n  * [ ] 1.1 Sub task\n`;

/** `refused` of a summary or document info (absent from the types before the fix). */
const refusedOf = (x: unknown): string | undefined => (x as { refused?: string }).refused;

/** A file outside the workspace (`<root>/outside/<name>`). */
function outside(w: Ws, name: string, content: string): string {
  const dir = path.join(w.root, 'outside');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

/** Spec `feat` with regular `docs` and `link` committed as a symbolic link to `target`. */
function linkedSpec(w: Ws, docs: Parameters<typeof writeSpec>[2], link: string, target: string): string {
  const dir = writeSpec(w, 'feat', docs);
  fs.symlinkSync(target, path.join(dir, link));
  return dir;
}

// ───────────────────────────── store ─────────────────────────────

test('store: a design.md linked to a file outside the workspace is never read (summary, load, context block)', () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const target = outside(w, 'design.md', `${DESIGN_MD}\n${SECRET}\n`);
    const dir = linkedSpec(w, { requirements: REQ_MD }, 'design.md', target);
    const s = summarizeSpecDir(dir);
    assert.match(refusedOf(s.docs.design) ?? '', /design\.md is a symbolic link/);
    assert.match(refusedOf(s) ?? '', /design\.md is a symbolic link/);
    assert.equal(s.docs.design.nonEmpty, false, 'a refused document has no known content');
    assert.equal(s.awaitingApproval, 'design', 'a refused document is not treated as missing (it would be drafted over)');
    assert.equal(s.phase, 'tasks');
    const spec = loadSpecDir(dir);
    assert.equal(spec.texts.design, undefined, 'the link target was read');
    assert.ok(!JSON.stringify(spec).includes(SECRET), 'the outside text reached the loaded spec');
    const block = specContextBlock(w.ctx, s) ?? '';
    assert.ok(!block.includes(SECRET), 'the outside text reached the task context');
    assert.match(block, /Requirements Document/);
    assert.equal(read(target), `${DESIGN_MD}\n${SECRET}\n`);
  } finally {
    w.cleanup();
  }
});

test('store: a spec folder linked out of the workspace: listed with the reason, nothing in it is read', () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const real = path.join(w.root, 'outside', 'feat');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'requirements.md'), `${REQ_MD}\n${SECRET}\n`);
    fs.writeFileSync(path.join(real, 'design.md'), DESIGN_MD);
    fs.symlinkSync(real, path.join(w.specs, 'feat'));
    const all = listSpecs(w.ctx);
    assert.deepEqual(all.map((s) => s.name), ['feat']);
    assert.match(refusedOf(all[0]) ?? '', /resolves to .*outside\/feat, outside the workspace/);
    const spec = loadSpec(w.ctx, 'feat')!;
    assert.deepEqual(spec.texts, {});
    assert.ok(!JSON.stringify(spec).includes(SECRET));
    assert.equal(specContextBlock(w.ctx, spec), undefined);
    assert.equal(specSummaryJson(spec).refused !== null && specSummaryJson(spec).refused !== undefined, true, 'JSON carries the reason');
  } finally {
    w.cleanup();
  }
});

test('store: a .kiro/specs or feature folder linked INSIDE the workspace is read as before', () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const real = path.join(w.proj, 'docs', 'feat');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'requirements.md'), REQ_MD);
    fs.symlinkSync(path.join('..', '..', 'docs', 'feat'), path.join(w.specs, 'feat'));
    const spec = loadSpec(w.ctx, 'feat')!;
    assert.equal(refusedOf(spec), undefined);
    assert.equal(spec.texts.requirements, REQ_MD);
    // .kiro/specs itself a link inside the workspace
    fs.rmSync(path.join(w.specs, 'feat'));
    const specs2 = path.join(w.proj, 'docs', 'specs');
    fs.mkdirSync(specs2, { recursive: true });
    fs.renameSync(real, path.join(specs2, 'feat'));
    fs.rmSync(w.specs, { recursive: true });
    fs.symlinkSync(path.join('..', 'docs', 'specs'), w.specs);
    assert.equal(loadSpec(w.ctx, 'feat')!.texts.requirements, REQ_MD);
    const dir = createSpecFolder(w.ctx, 'second', { specType: 'feature', workflowType: 'requirements-first' });
    assert.ok(fs.existsSync(path.join(specs2, 'second', '.config.kiro')), 'a new spec is created through the link');
    assert.equal(readSpecConfig(dir)?.specType, 'feature');
  } finally {
    w.cleanup();
  }
});

test('store: a dangling or looping spec folder link is listed and resolved, with the reason', () => {
  const w = makeWs('kc-r5x-links-');
  try {
    fs.symlinkSync(path.join(w.root, 'gone'), path.join(w.specs, 'feat'));
    fs.symlinkSync(path.join(w.specs, 'loop-b'), path.join(w.specs, 'loop-a'));
    fs.symlinkSync(path.join(w.specs, 'loop-a'), path.join(w.specs, 'loop-b'));
    const all = listSpecs(w.ctx);
    assert.deepEqual(all.map((s) => s.name), ['feat', 'loop-a', 'loop-b']);
    for (const s of all) assert.match(refusedOf(s) ?? '', /resolves to nothing \(dangling, or a loop\)/, s.name);
    assert.ok(resolveSpecDir(w.ctx, 'feat'), 'the dangling folder is found (so its commands can say why)');
  } finally {
    w.cleanup();
  }
});

test('store: a .config.kiro that is a symbolic link is not read', () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const target = outside(w, 'cfg.json', `{"specId": "${SECRET}", "workflowType": "design-first", "specType": "bugfix"}`);
    const dir = linkedSpec(w, { requirements: REQ_MD }, '.config.kiro', target);
    assert.equal(readSpecConfig(dir), null);
    const s = summarizeSpecDir(dir);
    assert.match(refusedOf(s) ?? '', /\.config\.kiro is a symbolic link/);
    assert.ok(!JSON.stringify(specSummaryJson(s)).includes(SECRET));
  } finally {
    w.cleanup();
  }
});

test('store: createSpecFolder refuses a .kiro/specs linked out of the workspace or dangling (nothing created outside)', () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const out = path.join(w.root, 'outside-specs');
    fs.mkdirSync(out);
    fs.rmSync(w.specs, { recursive: true });
    fs.symlinkSync(out, w.specs);
    assert.throws(() => createSpecFolder(w.ctx, 'demo', { specType: 'feature', workflowType: 'requirements-first' }), /outside the workspace/);
    assert.deepEqual(fs.readdirSync(out), []);
    fs.rmSync(w.specs);
    fs.symlinkSync(path.join(w.root, 'gone'), w.specs);
    assert.throws(() => createSpecFolder(w.ctx, 'demo', { specType: 'feature', workflowType: 'requirements-first' }), /resolves to nothing/);
    assert.equal(fs.existsSync(path.join(w.root, 'gone')), false);
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── model ─────────────────────────────

test('writeTaskStatus: a tasks.md linked out of the workspace is refused and its target left alone', () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const target = outside(w, 'tasks.md', TASKS_MD);
    const dir = linkedSpec(w, {}, 'tasks.md', target);
    assert.throws(() => writeTaskStatus(path.join(dir, 'tasks.md'), '1.1', 'x'), /tasks\.md is a symbolic link/);
    assert.equal(read(target), TASKS_MD);
    assert.ok(fs.lstatSync(path.join(dir, 'tasks.md')).isSymbolicLink(), 'the link itself is kept');
    // through a feature folder linked out of the workspace
    const real = path.join(w.root, 'outside', 'feat2');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'tasks.md'), TASKS_MD);
    fs.symlinkSync(real, path.join(w.specs, 'feat2'));
    assert.throws(() => writeTaskStatus(path.join(w.specs, 'feat2', 'tasks.md'), '1.1', 'x'), /outside the workspace/);
    assert.equal(read(path.join(real, 'tasks.md')), TASKS_MD);
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── workflow (REPL runtime over MockHost) ─────────────────────────────

function host(w: Ws, o: FakeModelOptions = {}): MockHost {
  return new MockHost(w.ctx, fakeModel(o));
}

test('/spec run: a tasks.md linked out of the workspace is not repaired, no box is ticked, no task runs; the reason is printed', async () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const target = outside(w, 'tasks.md', OUTSIDE_TASKS);
    linkedSpec(w, { requirements: REQ_MD, design: DESIGN_MD }, 'tasks.md', target);
    const h = host(w);
    const r = await runSpecTasks(createReplRuntime(h, { openEditor: null }), 'feat', { kind: 'scope', includeOptional: true });
    assert.equal(read(target), OUTSIDE_TASKS, 'the outside file was rewritten');
    assert.equal(r.status, 'error');
    assert.equal(h.created.length, 0, 'a task session was started');
    assert.match(h.text, /tasks\.md is a symbolic link/);
    assert.ok(!h.text.includes(SECRET));
  } finally {
    w.cleanup();
  }
});

test('a tasks phase turn that leaves tasks.md as a link out of the workspace: the repair after it does not touch the target', async () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const target = outside(w, 'tasks.md', OUTSIDE_TASKS);
    writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD });
    const h = host(w, {
      override: (i) => {
        const m = /Create or update (\S+\/tasks\.md)/.exec(i.text);
        if (!m) return undefined;
        fs.symlinkSync(target, m[1]!); // e.g. a trusted `ln -s` in the phase turn
        return { text: 'Linked tasks.md.' };
      },
    });
    h.chooseAnswers = ['Stop here'];
    await approveSpec(createReplRuntime(h, { openEditor: null }), 'feat');
    assert.equal(read(target), OUTSIDE_TASKS, 'the repair rewrote the outside file');
    assert.match(h.text, /tasks\.md is a symbolic link/);
    assert.doesNotMatch(h.text, /Repaired tasks\.md/);
    assert.ok(!h.text.includes(SECRET));
  } finally {
    w.cleanup();
  }
});

test('a task turn that replaces tasks.md with a link out of the workspace: the box update leaves the target alone', async () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const target = outside(w, 'tasks.md', TASKS_MD);
    const dir = writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const file = path.join(dir, 'tasks.md');
    const h = host(w, {
      override: (i) => {
        if (!/Execute Task: 1\.1/.test(i.text)) return undefined;
        fs.rmSync(file);
        fs.symlinkSync(target, file);
        return { text: 'done\nTASK_RESULT: completed' };
      },
    });
    const r = await runSpecTasks(createReplRuntime(h, { openEditor: null }), 'feat', { kind: 'next' });
    assert.equal(read(target), TASKS_MD, 'the box was ticked in the outside file');
    assert.notEqual(r.status, 'completed');
    assert.match(h.text, /tasks\.md is a symbolic link/);
  } finally {
    w.cleanup();
  }
});

test('/spec sync and analyze: a linked document is refused with the reason, no turn runs, the target is untouched', async () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const tasks = outside(w, 'tasks.md', OUTSIDE_TASKS);
    const dir = linkedSpec(w, { design: DESIGN_MD }, 'tasks.md', tasks);
    const req = outside(w, 'requirements.md', `${REQ_MD}\n${SECRET}\n`);
    fs.symlinkSync(req, path.join(dir, 'requirements.md'));
    const h = host(w);
    const s = await syncSpec(createReplRuntime(h, { openEditor: null }), 'feat');
    assert.equal(s.status, 'error');
    assert.match(h.text, /tasks\.md is a symbolic link/);
    const a = await analyzeRequirements(createReplRuntime(h, { openEditor: null }), 'feat');
    assert.equal(a.status, 'error');
    assert.match(h.text, /requirements\.md is a symbolic link/);
    assert.equal(h.created.length, 0, 'a spec turn ran');
    assert.equal(read(tasks), OUTSIDE_TASKS);
    assert.ok(!h.text.includes(SECRET));
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── `kiro-claude spec` ─────────────────────────────

class Capture extends Writable {
  data = '';
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += chunk.toString();
    cb();
  }
}

interface Cli {
  out: Capture;
  err: Capture;
  sessions: MockSession[];
  run(args: string): Promise<number>;
}

function cli(w: Ws, model: FakeModelOptions = {}): Cli {
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
  const script = fakeModel(model);
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

test('kiro-claude spec view/status/list: a linked design.md is never printed; each command names the reason', async () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const target = outside(w, 'design.md', `${DESIGN_MD}\n${SECRET}\n`);
    linkedSpec(w, { requirements: REQ_MD }, 'design.md', target);
    const c = cli(w);
    assert.equal(await c.run('view feat design'), 1);
    assert.ok(!c.out.data.includes(SECRET), 'view printed the link target');
    assert.match(c.err.data, /design\.md is a symbolic link/);
    assert.equal(await c.run('view feat'), 1, 'the default document is the one under review');
    assert.ok(!c.out.data.includes(SECRET));
    assert.match(c.err.data, /design\.md is a symbolic link/);
    assert.equal(await c.run('view feat requirements'), 0, 'the regular document still prints');
    assert.match(c.out.data, /Requirements Document/);
    assert.equal(await c.run('status feat'), 0);
    assert.match(c.out.data, /design\.md\s+⚠/);
    assert.match(c.out.data, /design\.md is a symbolic link/);
    assert.ok(!c.out.data.includes(SECRET));
    assert.equal(await c.run('status feat --format json'), 0);
    const j = JSON.parse(c.out.data) as { refused?: string };
    assert.match(j.refused ?? '', /design\.md is a symbolic link/);
    assert.equal(await c.run('list'), 0);
    assert.match(c.out.data, /^feat\s+feature\s+refused\s+-$/m);
    assert.match(c.err.data, /design\.md is a symbolic link/);
    assert.equal(c.sessions.length, 0);
  } finally {
    w.cleanup();
  }
});

test('kiro-claude spec run/sync/analyze: linked documents are refused (exit 1), targets untouched, no session', async () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const tasks = outside(w, 'tasks.md', OUTSIDE_TASKS);
    const dir = linkedSpec(w, { design: DESIGN_MD }, 'tasks.md', tasks);
    fs.symlinkSync(outside(w, 'requirements.md', REQ_MD), path.join(dir, 'requirements.md'));
    const c = cli(w);
    assert.equal(await c.run('run feat --all'), 1);
    assert.match(c.err.data, /Spec 'feat' cannot run: .*(requirements|tasks)\.md is a symbolic link/);
    assert.equal(await c.run('sync feat'), 1);
    assert.match(c.err.data, /tasks\.md is a symbolic link/);
    assert.equal(await c.run('analyze feat'), 1);
    assert.match(c.err.data, /requirements\.md is a symbolic link/);
    assert.equal(c.sessions.length, 0);
    assert.equal(read(tasks), OUTSIDE_TASKS);
  } finally {
    w.cleanup();
  }
});

test('kiro-claude spec new: a .kiro/specs linked out of the workspace is refused (exit 1, nothing created there)', async () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const out = path.join(w.root, 'outside-specs');
    fs.mkdirSync(out);
    fs.rmSync(w.specs, { recursive: true });
    fs.symlinkSync(out, w.specs);
    const c = cli(w);
    assert.equal(await c.run('new demo --description demo'), 1);
    assert.match(c.err.data, /outside the workspace/);
    assert.deepEqual(fs.readdirSync(out), []);
    assert.equal(c.sessions.length, 0);
  } finally {
    w.cleanup();
  }
});

test('kiro-claude spec run: a feature folder linked inside the workspace still ticks the box in the real tasks.md', async () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const real = path.join(w.proj, 'docs', 'feat');
    fs.mkdirSync(real, { recursive: true });
    for (const [n, t] of [['requirements.md', REQ_MD], ['design.md', DESIGN_MD], ['tasks.md', TASKS_MD]] as const) fs.writeFileSync(path.join(real, n), t);
    fs.symlinkSync(path.join('..', '..', 'docs', 'feat'), path.join(w.specs, 'feat'));
    const c = cli(w);
    assert.equal(await c.run('run feat --next'), 0, c.err.data);
    assert.equal(parseTasks(read(path.join(real, 'tasks.md'))).byId.get('1.1')!.box, 'x');
    assert.ok(fs.lstatSync(path.join(w.specs, 'feat')).isSymbolicLink());
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── `/spec` in the REPL ─────────────────────────────

test('/spec view/status/list/run in the REPL: a linked document is never printed nor written; each names the reason', async () => {
  const w = makeWs('kc-r5x-links-');
  try {
    const design = outside(w, 'design.md', `${DESIGN_MD}\n${SECRET}\n`);
    const tasks = outside(w, 'tasks.md', OUTSIDE_TASKS);
    const dir = linkedSpec(w, { requirements: REQ_MD }, 'design.md', design);
    fs.symlinkSync(tasks, path.join(dir, 'tasks.md'));
    const h = host(w);
    const slash = specSlashCommands[0]!;
    const run = (line: string): Promise<void | 'quit'> => slash.run(line.split(' ').filter(Boolean), line, h);
    await run('view feat design');
    assert.match(h.printed.at(-1)!, /design\.md is a symbolic link/);
    await run('status feat');
    assert.match(h.printed.at(-1)!, /design\.md\s+⚠/);
    await run('list');
    assert.match(h.text, /^feat\s+feature\s+refused\s+-$/m);
    await run('run feat --all');
    assert.match(h.printed.at(-1)!, /symbolic link/);
    assert.ok(!h.text.includes(SECRET), 'the outside text was printed');
    assert.equal(read(tasks), OUTSIDE_TASKS);
    assert.equal(h.created.length, 0);
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── comments ─────────────────────────────

test('workflow.ts no longer says the spec CLI runs PostTaskExec without a signal (r5 gave it NextPress)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'spec', 'workflow.ts'), 'utf8').replace(/\s*\n\s*(\*|\/\/)\s*/g, ' ');
  assert.doesNotMatch(src, /Absent \(spec CLI\): such work runs without a signal/);
  assert.doesNotMatch(src, /a host without one \(spec CLI\) runs it without a signal/);
  assert.match(src, /spec CLI/);
});
