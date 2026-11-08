/**
 * Round 8, finding #10 (spec): in the interactive `kiro-claude spec` CLI, the tasks.md
 * checkpoint's Stop label and stop hint named `kiro-claude spec run <name> --next`, which runs
 * the next task at once and skips the review the user stopped at. The headless stop at the same
 * checkpoint says tasks.md is waiting for review (approve / revise). The cause: the approval of
 * tasks.md is not saved anywhere, so a spec whose tasks.md has tasks derives as `execution`, and
 * cliResumeHint picked `run --next` from that phase without knowing a checkpoint was stopped at.
 *
 * Now SpecRuntime.resumeHint takes the document under review (`awaiting`), which the checkpoint's
 * Stop label and the stop hint pass: the CLI then names `approve <name> · revise <name>
 * <feedback>` at EVERY checkpoint (requirements, bugfix, design, tasks; requirements-first,
 * design-first, bugfix and quick specs; from `new`, `approve` and `revise`), and still
 * `status <name>` for a spec with a refused file. Callers outside a checkpoint (`new` of an
 * existing spec, `run` / `analyze` without their document) pass none and keep `run <name> --next`
 * for a spec that has tasks. The REPL's hint stays `/spec <name>`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { CliContext, KiroSession } from '../../src/types.js';
import { runSpecCommandWith, type SpecCliDeps, type SpecCliIO } from '../../src/spec/cli.js';
import { createReplRuntime, reviseSpec } from '../../src/spec/workflow.js';
import { DESIGN_MD, MockHost, MockSession, REQ_MD, TASKS_MD, fakeModel, makeWs, mockSettings, writeSpec, type Ws } from './helpers.js';
import { removeOnExit } from '../tmpdirs.js';

class Capture extends Writable {
  data = '';
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += chunk.toString();
    cb();
  }
}

/** Scripted answers; `stop` answers a "Choose 1-N" with N, the last option ("Stop here (…)"). */
function scriptedIO(answers: string[]): SpecCliIO {
  return {
    question: async (q) => {
      const a = answers.shift() ?? '';
      if (a !== 'stop') return a;
      const m = /Choose 1-(\d+)/.exec(q);
      assert.ok(m, `'stop' scripted for a question that is no menu: ${q}`);
      return m[1]!;
    },
    close: () => undefined,
  };
}

function ws(): Ws {
  const w = makeWs('kc-r8f-spec-hints-');
  removeOnExit(w.root);
  return w;
}

/** Run `kiro-claude spec <argv>` in process over `w` (MockSessions, the fake model); `log`: the first line of every turn. */
async function spec(w: Ws, argv: string[], extra: Partial<SpecCliDeps> = {}): Promise<{ code: number; out: string; err: string; log: string[] }> {
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
  const log: string[] = [];
  const model = fakeModel({ log });
  const deps: SpecCliDeps = { createSession: async (o) => new MockSession(o, model) as KiroSession, ...extra };
  const code = await runSpecCommandWith(argv, ctx, deps);
  return { code, out: out.data, err: err.data, log };
}

const reviewHint = (name: string): string => `kiro-claude spec approve ${name} · kiro-claude spec revise ${name} <feedback>`;

/** The ` · `-separated commands of a hint, each as argv after `kiro-claude spec` (placeholders filled in). */
function hintedCommands(hint: string): string[][] {
  return hint.split(' · ').map((c) => {
    const m = /^kiro-claude spec (.+)$/.exec(c.trim());
    assert.ok(m, `hint part ${JSON.stringify(c)} is not a kiro-claude spec command (hint: ${hint})`);
    return m[1]!.split(/\s+/).map((a) => (a === '<feedback>' ? 'add more detail' : a));
  });
}

/**
 * Each command of `hint`, headless in a fresh copy of `w`: accepted (never a usage error), and it
 * goes on with the review of `doc` (approve it or revise it): never a task turn.
 */
async function assertResumesReview(w: Ws, hint: string, doc: string): Promise<string> {
  const shown: string[] = [];
  for (const argv of hintedCommands(hint)) {
    const copy = ws();
    fs.rmSync(copy.specs, { recursive: true, force: true });
    fs.cpSync(w.specs, copy.specs, { recursive: true });
    const r = await spec(copy, argv);
    const all = `--- kiro-claude spec ${argv.join(' ')} (exit ${r.code})\n${r.out}${r.err}`;
    shown.push(all);
    assert.notEqual(r.code, 2, `the hinted command is a usage error:\n${all}`);
    assert.doesNotMatch(r.err, /unrecognized subcommand/, all);
    assert.deepEqual(r.log.filter((l) => /Execute Task/.test(l)), [], `the hinted command ran a task instead of the ${doc} review:\n${all}`);
    if (argv[0] === 'revise') {
      assert.ok(r.log.some((l) => l.startsWith(`Revise ${path.join(copy.specs, argv[1]!, doc)}`)), `revise did not revise ${doc}:\n${all}\n${r.log.join('\n')}`);
      assert.match(r.err, new RegExp(`${doc.replace('.', '\\.')} is waiting for review\\. Approve with: kiro-claude spec approve`), all);
    }
  }
  return shown.join('\n');
}

interface Case {
  title: string;
  /** Spec documents written before the command. */
  docs?: Partial<Record<'requirements' | 'bugfix' | 'design' | 'tasks', string>>;
  argv: string[];
  answers: string[];
  /** The checkpoint stopped at (its file). */
  doc: string;
  /** Number of checkpoints shown (Stop labels). */
  checkpoints: number;
}

const CASES: Case[] = [
  { title: 'spec new (requirements-first): requirements.md', argv: ['new', 'feat'], answers: ['1', '1', 'Export todos', 'stop'], doc: 'requirements.md', checkpoints: 1 },
  { title: 'spec new (requirements-first): design.md', argv: ['new', 'feat'], answers: ['1', '1', 'Export todos', '1', 'stop'], doc: 'design.md', checkpoints: 2 },
  { title: 'spec new (requirements-first): tasks.md', argv: ['new', 'feat'], answers: ['1', '1', 'Export todos', '1', '1', 'stop'], doc: 'tasks.md', checkpoints: 3 },
  { title: 'spec new (design-first): design.md', argv: ['new', 'feat'], answers: ['1', '2', '1', 'Export todos', 'stop'], doc: 'design.md', checkpoints: 1 },
  { title: 'spec new (design-first): requirements.md', argv: ['new', 'feat'], answers: ['1', '2', '1', 'Export todos', '1', 'stop'], doc: 'requirements.md', checkpoints: 2 },
  { title: 'spec new (design-first): tasks.md', argv: ['new', 'feat'], answers: ['1', '2', '1', 'Export todos', '1', '1', 'stop'], doc: 'tasks.md', checkpoints: 3 },
  { title: 'spec new (bugfix): bugfix.md', argv: ['new', 'feat'], answers: ['2', 'Crash on start', 'stop'], doc: 'bugfix.md', checkpoints: 1 },
  { title: 'spec new (bugfix): design.md', argv: ['new', 'feat'], answers: ['2', 'Crash on start', '1', 'stop'], doc: 'design.md', checkpoints: 2 },
  { title: 'spec new (bugfix): tasks.md', argv: ['new', 'feat'], answers: ['2', 'Crash on start', '1', '1', 'stop'], doc: 'tasks.md', checkpoints: 3 },
  { title: 'spec new (quick): tasks.md, its one checkpoint', argv: ['new', 'feat'], answers: ['3', 'Export todos', 'skip', 'stop'], doc: 'tasks.md', checkpoints: 1 },
  { title: 'spec approve (design approved, tasks drafted): tasks.md', docs: { requirements: REQ_MD, design: DESIGN_MD }, argv: ['approve', 'feat'], answers: ['stop'], doc: 'tasks.md', checkpoints: 1 },
  { title: 'spec revise of an existing tasks.md: tasks.md', docs: { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD }, argv: ['revise', 'feat', 'split', 'task', '2'], answers: ['stop'], doc: 'tasks.md', checkpoints: 1 },
];

for (const c of CASES) {
  test(`interactive Stop at a checkpoint names approve/revise, never run --next: ${c.title}`, async () => {
    const w = ws();
    if (c.docs) writeSpec(w, 'feat', c.docs);
    const r = await spec(w, c.argv, { isTTY: true, io: scriptedIO([...c.answers]) });
    const all = `--- stdout\n${r.out}\n--- stderr\n${r.err}`;
    assert.equal(r.code, 0, all);
    const labels = [...r.out.matchAll(/Stop here \(resume later with (.+)\)\n/g)].map((m) => m[1]!);
    assert.equal(labels.length, c.checkpoints, all);
    for (const l of labels) assert.equal(l, reviewHint('feat'), `a checkpoint's Stop label offers '${l}':\n${all}`);
    const stop = /^Stopped at the (\S+) checkpoint\. Resume later with (.+)\.$/m.exec(r.err);
    assert.ok(stop, all);
    assert.equal(stop[1], c.doc, all);
    assert.equal(stop[2], reviewHint('feat'), all);
    assert.doesNotMatch(`${r.out}${r.err}`, /spec run feat --next/, all);
    assert.deepEqual(r.log.filter((l) => /Execute Task/.test(l)), [], all);
    await assertResumesReview(w, stop[2]!, c.doc);
  });
}

test('the stopped tasks.md review is where the hint resumes: approve says ready, revise shows the tasks.md checkpoint again; no task runs', async () => {
  const w = ws();
  writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
  const tasksBefore = fs.readFileSync(path.join(w.specs, 'feat', 'tasks.md'), 'utf8');
  const r = await spec(w, ['revise', 'feat', 'split', 'task', '2'], { isTTY: true, io: scriptedIO(['stop']) });
  const stop = /^Stopped at the tasks\.md checkpoint\. Resume later with (.+)\.$/m.exec(r.err);
  assert.ok(stop, r.err);
  const shown = await assertResumesReview(w, stop[1]!, 'tasks.md');
  assert.match(shown, /--- kiro-claude spec approve feat \(exit 0\)\n[\s\S]*Spec ready\. Run all tasks: kiro-claude spec run feat/, shown);
  // the stop itself left the revised tasks.md, every box unticked
  const after = fs.readFileSync(path.join(w.specs, 'feat', 'tasks.md'), 'utf8');
  assert.ok(after.startsWith(tasksBefore.trimEnd()), after);
  assert.doesNotMatch(after, /- \[[x-]\]/, after);
});

test('headless stop at the tasks.md checkpoint is unchanged: tasks.md is waiting for review, approve/revise', async () => {
  const w = ws();
  writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
  const r = await spec(w, ['revise', 'feat', 'split', 'task', '2']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /^tasks\.md is waiting for review\. Approve with: kiro-claude spec approve feat · Request changes: kiro-claude spec revise feat <feedback>$/m, r.err);
});

test('outside a checkpoint the hint for a spec with tasks stays run <name> --next (new of an existing spec)', async () => {
  const w = ws();
  writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
  const r = await spec(w, ['new', 'feat', '--description', 'x', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^Spec 'feat' already exists\. Resume it with kiro-claude spec run feat --next$/m, r.err);
});

test('a checkpoint of a spec with a refused file: the Stop label and hint name status <name> (it says why)', async () => {
  const w = ws();
  const dir = writeSpec(w, 'feat', { requirements: REQ_MD, tasks: TASKS_MD });
  fs.writeFileSync(path.join(w.proj, 'elsewhere.md'), DESIGN_MD);
  fs.symlinkSync(path.join(w.proj, 'elsewhere.md'), path.join(dir, 'design.md'));
  const r = await spec(w, ['revise', 'feat', 'split', 'task', '2'], { isTTY: true, io: scriptedIO(['stop']) });
  const all = `${r.out}\n${r.err}`;
  const label = /Stop here \(resume later with (.+)\)\n/.exec(r.out);
  assert.ok(label, all);
  assert.equal(label[1], 'kiro-claude spec status feat', all);
  assert.match(r.err, /^Stopped at the tasks\.md checkpoint\. Resume later with kiro-claude spec status feat\.$/m, all);
});

test('REPL: the tasks.md checkpoint Stop label and stop hint stay /spec <name>', async () => {
  const w = ws();
  writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
  const host = new MockHost(w.ctx, fakeModel());
  host.chooseAnswers = ['Stop here'];
  const r = await reviseSpec(createReplRuntime(host, { openEditor: null }), 'feat', 'split task 2');
  assert.equal(r.status, 'stopped', host.text);
  assert.ok(host.chosen[0]?.options.includes('Stop here (resume later with /spec feat)'), JSON.stringify(host.chosen));
  assert.match(host.text, /^Stopped at the tasks\.md checkpoint\. Resume later with \/spec feat\.$/m, host.text);
});
