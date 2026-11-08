/**
 * Round 9, findings #6 and #9 (spec hints).
 *
 * #6: a checkpoint whose document is not the review `approve` / `revise` act on. kiro-claude
 * derives the review from the files alone (research 03 §1.11.2): when a spec already has a
 * tasks.md with tasks and an earlier document is drafted (again) — the design.md of a
 * requirements-first or bugfix spec drafted again by `spec approve`, the requirements.md of a
 * design-first spec drafted next to an existing tasks.md — every document is present after the
 * draft, so the files say `execution` and plain `approve` / `revise` act on tasks.md. At that
 * design.md (requirements.md) checkpoint the interactive Stop label and stop hint fell through to
 * `spec run <name> --next` (it runs task 1.1 at once and skips the review the user stopped at),
 * and the headless "<doc> is waiting for review" line named approve / revise, which acted on
 * tasks.md ("Spec ready" with the stale tasks.md; a revision of tasks.md).
 *
 * Now `approve` and `revise` take the document under review explicitly (`--doc <doc>`, the CLI
 * and `/spec` in chat): `approve <name> --doc <doc>` approves that document and drafts the next
 * one (as the checkpoint's Approve does), `revise <name> --doc <doc> <feedback>` revises it. Every
 * checkpoint whose document is not the review the files give names that form, in the Stop label,
 * the stop hint and the headless line; at a checkpoint whose document IS that review the plain
 * form stays (test/spec/r8f-spec-hints.test.ts). Also the tasks.md checkpoint of a tasks.md
 * without parseable tasks (the files say design.md awaits review there) now names `--doc tasks`.
 *
 * #9: README.md said `run <name> --next` is named only "for a spec whose tasks you approved", but
 * the approval of tasks.md is recorded nowhere: outside a checkpoint every spec whose tasks.md has
 * tasks gets it. README now says so (as ARCHITECTURE does).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { CliContext, KiroSession } from '../../src/types.js';
import { runSpecCommandWith, type SpecCliDeps, type SpecCliIO } from '../../src/spec/cli.js';
import { specSlashCommands } from '../../src/spec/slash.js';
import { approveSpec, createReplRuntime } from '../../src/spec/workflow.js';
import { BUGFIX_MD, BUGFIX_TASKS_MD, DESIGN_MD, MockHost, MockSession, REQ_MD, TASKS_MD, fakeModel, makeWs, mockSettings, writeSpec, type FakeModelOptions, type Ws } from './helpers.js';
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
  const w = makeWs('kc-r9f-spec-hints-');
  removeOnExit(w.root);
  return w;
}

/** A fresh workspace holding a copy of `w`'s specs. */
function copyOf(w: Ws): Ws {
  const copy = ws();
  fs.rmSync(copy.specs, { recursive: true, force: true });
  fs.cpSync(w.specs, copy.specs, { recursive: true });
  return copy;
}

/** `kiro-claude spec <argv>` in process over `w` (MockSessions, the fake model); `log`: the first line of every turn. */
async function spec(w: Ws, argv: string[], extra: Partial<SpecCliDeps> = {}, model: FakeModelOptions = {}): Promise<{ code: number; out: string; err: string; log: string[] }> {
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
  const m = fakeModel({ ...model, log });
  const deps: SpecCliDeps = { createSession: async (o) => new MockSession(o, m) as KiroSession, ...extra };
  const code = await runSpecCommandWith(argv, ctx, deps);
  return { code, out: out.data, err: err.data, log };
}

const docHint = (name: string, doc: string): string => `kiro-claude spec approve ${name} --doc ${doc} · kiro-claude spec revise ${name} --doc ${doc} <feedback>`;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ` · `-separated commands of a hint, each as argv after `kiro-claude spec` (placeholders filled in). */
function hintedCommands(hint: string): string[][] {
  return hint.split(' · ').map((c) => {
    const m = /^kiro-claude spec (.+)$/.exec(c.trim());
    assert.ok(m, `hint part ${JSON.stringify(c)} is not a kiro-claude spec command (hint: ${hint})`);
    return m[1]!.split(/\s+/).map((a) => (a === '<feedback>' ? 'add more detail' : a));
  });
}

/**
 * Each command of `hint`, headless in a fresh copy of `w`: accepted, never a task turn; `approve`
 * approves `doc` (the phase turn of `next` runs), `revise` revises `doc` and stops at its
 * checkpoint again with the same `--doc` hint.
 */
async function assertResumes(w: Ws, hint: string, doc: string, next: RegExp): Promise<void> {
  const file = `${doc}.md`;
  for (const argv of hintedCommands(hint)) {
    const copy = copyOf(w);
    const r = await spec(copy, argv);
    const all = `hint: ${hint}\n--- kiro-claude spec ${argv.join(' ')} (exit ${r.code})\n${r.out}${r.err}\n--- turns\n${r.log.join('\n')}`;
    assert.equal(r.code, 0, all);
    assert.deepEqual(r.log.filter((l) => /Execute Task/.test(l)), [], `the hint at the ${file} checkpoint ran a task:\n${all}`);
    if (argv[0] === 'approve') {
      assert.ok(r.log.some((l) => next.test(l)), `'approve' named at the ${file} checkpoint did not approve ${file}:\n${all}`);
      assert.doesNotMatch(r.err, /Spec ready/, all);
    } else {
      assert.equal(argv[0], 'revise', all);
      assert.deepEqual(r.log, [`Revise ${path.join(copy.specs, 'feat', file)} per this feedback, in place, then stop again:`], all);
      assert.match(r.err, new RegExp(`^${esc(file)} is waiting for review\\. Approve with: kiro-claude spec approve feat --doc ${doc} · Request changes: kiro-claude spec revise feat --doc ${doc} <feedback>$`, 'm'), all);
    }
  }
}

const DESIGN_FIRST = '{"specId": "x", "workflowType": "design-first", "specType": "feature"}';

const CASES = [
  { title: 'requirements-first: design.md drafted again next to tasks.md', docs: { requirements: REQ_MD, tasks: TASKS_MD }, doc: 'design', next: /^Phase: TASKS\. / },
  { title: 'design-first: requirements.md drafted next to tasks.md', docs: { design: DESIGN_MD, tasks: TASKS_MD, config: DESIGN_FIRST }, doc: 'requirements', next: /^Phase: TASKS\. / },
  { title: 'bugfix: design.md drafted again next to tasks.md', docs: { bugfix: BUGFIX_MD, tasks: BUGFIX_TASKS_MD }, doc: 'design', next: /^Phase: TASKS \(bugfix\)\. / },
];

for (const c of CASES) {
  test(`#6 interactive Stop at the checkpoint names approve/revise --doc, never run --next: ${c.title}`, async () => {
    const w = ws();
    writeSpec(w, 'feat', c.docs);
    const r = await spec(w, ['approve', 'feat'], { isTTY: true, io: scriptedIO(['stop']) });
    const all = `--- stdout\n${r.out}\n--- stderr\n${r.err}`;
    assert.equal(r.code, 0, all);
    const labels = [...r.out.matchAll(/Stop here \(resume later with (.+)\)\n/g)].map((m) => m[1]!);
    assert.deepEqual(labels, [docHint('feat', c.doc)], all);
    const stop = /^Stopped at the (\S+) checkpoint\. Resume later with (.+)\.$/m.exec(r.err);
    assert.ok(stop, all);
    assert.equal(stop[1], `${c.doc}.md`, all);
    assert.equal(stop[2], docHint('feat', c.doc), all);
    assert.doesNotMatch(`${r.out}${r.err}`, /spec run feat --next/, all);
    await assertResumes(w, stop[2]!, c.doc, c.next);
  });

  test(`#6 headless stop at the checkpoint: the approve/revise it names act on that document: ${c.title}`, async () => {
    const w = ws();
    writeSpec(w, 'feat', c.docs);
    const r = await spec(w, ['approve', 'feat']);
    assert.equal(r.code, 0, r.err);
    const m = new RegExp(`^${esc(c.doc)}\\.md is waiting for review\\. Approve with: (.+) · Request changes: (.+)$`, 'm').exec(r.err);
    assert.ok(m, r.err);
    assert.equal(`${m[1]} · ${m[2]}`, docHint('feat', c.doc), r.err);
    await assertResumes(w, `${m[1]} · ${m[2]}`, c.doc, c.next);
  });
}

test('#6 approve --doc of the document the files give is the plain approve; approve --doc of an earlier one drafts the next one again', async () => {
  const w = ws();
  writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
  // tasks.md is the review the files give: --doc tasks says ready, as plain approve does
  const t = await spec(copyOf(w), ['approve', 'feat', '--doc', 'tasks']);
  assert.equal(t.code, 0, t.err);
  assert.deepEqual(t.log, [], t.err);
  assert.match(t.err, /^Spec ready\. Run all tasks: kiro-claude spec run feat · Step through: kiro-claude spec run feat --next$/m, t.err);
  // requirements.md, approved again: design.md is drafted again (create or update) and stops at its checkpoint
  const r = await spec(copyOf(w), ['approve', 'feat', '--doc=requirements']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.log.length, 1, r.log.join('\n'));
  assert.match(r.log[0]!, /^Phase: DESIGN\. /, r.log.join('\n'));
  assert.match(r.err, /^design\.md is waiting for review\. Approve with: kiro-claude spec approve feat --doc design · Request changes: kiro-claude spec revise feat --doc design <feedback>$/m, r.err);
  // `requirements` names a bugfix spec's bugfix.md (as `view` does)
  const b = ws();
  writeSpec(b, 'feat', { bugfix: BUGFIX_MD, tasks: BUGFIX_TASKS_MD });
  fs.writeFileSync(path.join(b.specs, 'feat', 'design.md'), DESIGN_MD);
  const rb = await spec(b, ['revise', 'feat', '--doc', 'requirements', 'name', 'the', 'file']);
  assert.equal(rb.code, 0, rb.err);
  assert.deepEqual(rb.log, [`Revise ${path.join(b.specs, 'feat', 'bugfix.md')} per this feedback, in place, then stop again:`], rb.err);
  assert.match(rb.err, /^bugfix\.md is waiting for review\. Approve with: kiro-claude spec approve feat --doc bugfix · /m, rb.err);
});

test('#6 --doc is refused when that document cannot be under review; no turn runs', async () => {
  const w = ws();
  writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD });
  const cases: { argv: string[]; code: number; err: RegExp }[] = [
    { argv: ['approve', 'feat', '--doc', 'nope'], code: 2, err: /^error: unknown document 'nope' \(requirements, bugfix, design, tasks\)$/m },
    { argv: ['revise', 'feat', '--doc', 'nope', 'x'], code: 2, err: /^error: unknown document 'nope' \(requirements, bugfix, design, tasks\)$/m },
    { argv: ['approve', 'feat', '--doc', 'bugfix'], code: 1, err: /bugfix\.md is not a document of spec 'feat' \(requirements\.md, design\.md, tasks\.md\)/ },
    { argv: ['approve', 'feat', '--doc', 'tasks'], code: 1, err: /^Nothing to approve yet: tasks\.md has not been written\.$/m },
    { argv: ['revise', 'feat', '--doc', 'tasks', 'x'], code: 1, err: /^Nothing to revise yet: tasks\.md has not been written\.$/m },
    { argv: ['status', 'feat', '--doc', 'design'], code: 2, err: /^error: unexpected argument '--doc' found$/m },
  ];
  for (const k of cases) {
    const r = await spec(copyOf(w), k.argv);
    const all = `kiro-claude spec ${k.argv.join(' ')} (exit ${r.code})\n${r.err}`;
    assert.equal(r.code, k.code, all);
    assert.match(r.err, k.err, all);
    assert.deepEqual(r.log, [], all);
  }
  // a document after one that has not been written cannot be under review
  const gap = ws();
  writeSpec(gap, 'feat', { design: DESIGN_MD });
  const g = await spec(gap, ['approve', 'feat', '--doc', 'design']);
  assert.equal(g.code, 1, g.err);
  assert.match(g.err, /Cannot approve design\.md: requirements\.md has not been written yet/, g.err);
  assert.deepEqual(g.log, [], g.err);
  // a spec with a refused file: --doc does not get past the refusal
  const lk = ws();
  const dir = writeSpec(lk, 'feat', { requirements: REQ_MD, tasks: TASKS_MD });
  fs.writeFileSync(path.join(lk.proj, 'elsewhere.md'), DESIGN_MD);
  fs.symlinkSync(path.join(lk.proj, 'elsewhere.md'), path.join(dir, 'design.md'));
  const l = await spec(lk, ['approve', 'feat', '--doc', 'requirements']);
  assert.equal(l.code, 1, l.err);
  assert.match(l.err, /Cannot approve requirements\.md: .*design\.md is a symbolic link/, l.err);
  assert.deepEqual(l.log, [], l.err);
});

test('#6 the tasks.md checkpoint of a tasks.md without parseable tasks (the files say design.md awaits review) names --doc tasks', async () => {
  const w = ws();
  writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD });
  const plain = '# Implementation Plan: Todo Export\n\nThe plan is still open.\n';
  const r = await spec(w, ['approve', 'feat', '--doc', 'design'], { isTTY: true, io: scriptedIO(['stop']) }, { tasks: plain });
  const all = `--- stdout\n${r.out}\n--- stderr\n${r.err}`;
  assert.equal(r.code, 0, all);
  const stop = /^Stopped at the tasks\.md checkpoint\. Resume later with (.+)\.$/m.exec(r.err);
  assert.ok(stop, all);
  assert.equal(stop[1], docHint('feat', 'tasks'), all);
  for (const argv of hintedCommands(stop[1]!)) {
    const copy = copyOf(w);
    const x = await spec(copy, argv);
    const shown = `kiro-claude spec ${argv.join(' ')} (exit ${x.code})\n${x.err}\n${x.log.join('\n')}`;
    assert.equal(x.code, 0, shown);
    if (argv[0] === 'approve') {
      assert.deepEqual(x.log, [], shown);
      assert.match(x.err, /^Spec ready\. /m, shown);
    } else assert.deepEqual(x.log, [`Revise ${path.join(copy.specs, 'feat', 'tasks.md')} per this feedback, in place, then stop again:`], shown);
  }
});

test('#6 headless: a revision that empties its document stops with the hint for where the spec stands, not "waiting for review"', async () => {
  const w = ws();
  const dir = writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD });
  const empty = (input: { text: string }): { text: string } | undefined => {
    if (!input.text.startsWith('Revise ')) return undefined;
    fs.writeFileSync(path.join(dir, 'design.md'), '');
    return { text: 'Emptied.' };
  };
  const r = await spec(w, ['revise', 'feat', 'start', 'over'], {}, { override: empty });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /^⚠ design\.md was not written/m, r.err);
  assert.doesNotMatch(r.err, /design\.md is waiting for review/, r.err);
  assert.match(r.err, /^Stopped at the design\.md checkpoint\. Resume later with kiro-claude spec approve feat · kiro-claude spec revise feat <feedback>\.$/m, r.err);
});

test('#6 REPL: the design.md checkpoint next to tasks.md names /spec approve|revise --doc design, and both act on design.md', async () => {
  const w = ws();
  writeSpec(w, 'feat', { requirements: REQ_MD, tasks: TASKS_MD });
  const host = new MockHost(w.ctx, fakeModel());
  host.chooseAnswers = ['Stop here'];
  const r = await approveSpec(createReplRuntime(host, { openEditor: null }), 'feat');
  assert.equal(r.status, 'stopped', host.text);
  const hint = '/spec approve feat --doc design · /spec revise feat --doc design <feedback>';
  assert.ok(host.chosen[0]?.options.includes(`Stop here (resume later with ${hint})`), JSON.stringify(host.chosen));
  assert.match(host.text, new RegExp(`^Stopped at the design\\.md checkpoint\\. Resume later with ${esc(hint)}\\.$`, 'm'), host.text);
  for (const line of ['/spec approve feat --doc design', '/spec revise feat --doc design add more detail']) {
    const copy = copyOf(w);
    const log: string[] = [];
    const h = new MockHost(copy.ctx, fakeModel({ log }));
    h.chooseAnswers = ['Stop here'];
    const words = line.split(/\s+/).slice(1);
    await specSlashCommands[0]!.run(words, line, h);
    const shown = `${line}\n${h.text}\n--- turns\n${log.join('\n')}`;
    assert.deepEqual(log.filter((l) => /Execute Task/.test(l)), [], shown);
    if (words[0] === 'approve') assert.ok(log.some((l) => /^Phase: TASKS\. /.test(l)), shown);
    else {
      assert.deepEqual(log, [`Revise ${path.join(copy.specs, 'feat', 'design.md')} per this feedback, in place, then stop again:`], shown);
      assert.match(h.text, new RegExp(`^Stopped at the design\\.md checkpoint\\. Resume later with ${esc(hint)}\\.$`, 'm'), shown);
    }
  }
  // an unknown document is refused before any turn
  const h = new MockHost(w.ctx, fakeModel());
  await specSlashCommands[0]!.run(['approve', 'feat', '--doc', 'nope'], '/spec approve feat --doc nope', h);
  assert.match(h.text, /Unknown document 'nope'\. Use requirements, bugfix, design or tasks\./, h.text);
});

// ───────────────────────────── #9: README ─────────────────────────────

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'spec', 'cli.ts')) && fs.existsSync(path.join(dir, 'README.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

test('#9 README: run <name> --next is named outside a checkpoint for any spec whose tasks.md has tasks (no approval is recorded)', async () => {
  // a spec stopped unapproved at its tasks.md checkpoint
  const w = ws();
  const r = await spec(w, ['new', 'feat'], { isTTY: true, io: scriptedIO(['1', '1', 'Export todos', '1', '1', 'stop']) });
  assert.match(r.err, /^Stopped at the tasks\.md checkpoint\. Resume later with kiro-claude spec approve feat · kiro-claude spec revise feat <feedback>\.$/m, r.err);
  const again = await spec(w, ['new', 'feat', 'x']);
  assert.match(again.err, /^Spec 'feat' already exists\. Resume it with kiro-claude spec run feat --next$/m, again.err);
  const readme = fs.readFileSync(path.join(repoRoot(), 'README.md'), 'utf8').replace(/\s+/g, ' ');
  assert.doesNotMatch(readme, /for a spec whose tasks you approved/, 'README promises run --next only after an approval kiro-claude does not record');
  assert.match(readme, /kiro-claude does not record that you approved `tasks\.md`/);
  assert.match(readme, /`approve <name> --doc <doc>`/);
});
