/**
 * Round 7, finding #8 (spec): `kiro-claude spec` printed resume hints in the REPL's form,
 * `${commandPrefix} <name>` = `kiro-claude spec <name>`, which the spec CLI rejects ("error:
 * unrecognized subcommand '<name>'", exit 2): `new` on an existing spec ("Resume it with"), `run`
 * of a spec without tasks.md ("Continue the spec with"), the interactive checkpoint's Stop label
 * ("resume later with") and its stop hint ("Resume later with"); `analyze` of a spec without
 * requirements.md said "Start with … new <feature-name>", which refuses an existing spec.
 *
 * Now SpecRuntime.resumeHint names the resume command (REPL: `/spec <name>`, unchanged); the spec
 * CLI names commands it accepts, by where the spec stands: `approve`/`revise` for a document
 * awaiting review, `run <name> --next` once the tasks are approved, `status <name>` for a spec
 * with a refused file, and `/spec <name>` in `kiro-claude chat` when the CLI has no command that
 * drafts the next document (only the chat drafts the first document of an existing folder).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { CliContext, KiroSession } from '../../src/types.js';
import { runSpecCommandWith, type SpecCliDeps, type SpecCliIO } from '../../src/spec/cli.js';
import { DESIGN_MD, MockSession, REQ_MD, TASKS_MD, fakeModel, makeWs, mockSettings, writeSpec, type Ws } from './helpers.js';

class Capture extends Writable {
  data = '';
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += chunk.toString();
    cb();
  }
}

function scriptedIO(answers: string[]): SpecCliIO {
  return { question: async () => answers.shift() ?? '', close: () => undefined };
}

/** Run `kiro-claude spec <argv>` in process over the workspace `w` (MockSessions, the fake model). */
async function spec(w: Ws, argv: string[], extra: Partial<SpecCliDeps> = {}): Promise<{ code: number; out: string; err: string }> {
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
  const model = fakeModel({});
  const deps: SpecCliDeps = { createSession: async (o) => new MockSession(o, model) as KiroSession, ...extra };
  const code = await runSpecCommandWith(argv, ctx, deps);
  return { code, out: out.data, err: err.data };
}

/** The ` · `-separated commands of a hint, each as argv after `kiro-claude spec` (placeholders filled in). */
function hintedCommands(hint: string): string[][] {
  return hint.split(' · ').map((c) => {
    const m = /^kiro-claude spec (.+)$/.exec(c.trim());
    assert.ok(m, `hint part ${JSON.stringify(c)} is not a kiro-claude spec command (hint: ${hint})`);
    return m[1]!.split(/\s+/).map((a) => (a === '<feedback>' ? 'add more detail' : a));
  });
}

/** Every command of `hint` is accepted by the spec CLI (never a usage error), each in a fresh copy of the workspace. */
async function assertAccepted(w: Ws, hint: string): Promise<void> {
  for (const argv of hintedCommands(hint)) {
    const copy = makeWs('kc-r7f-hints-copy-');
    try {
      fs.rmSync(copy.specs, { recursive: true, force: true });
      fs.cpSync(w.specs, copy.specs, { recursive: true });
      const r = await spec(copy, argv);
      assert.notEqual(r.code, 2, `the hinted \`kiro-claude spec ${argv.join(' ')}\` is a usage error: ${r.err}`);
      assert.doesNotMatch(r.err, /unrecognized subcommand/, r.err);
    } finally {
      copy.cleanup();
    }
  }
}

const NO_REPL_FORM = /kiro-claude spec (?:feat|todo-export)\b/;

test('spec new on an existing spec awaiting review: "Resume it with" names approve and revise, which the CLI accepts', async () => {
  const w = makeWs('kc-r7f-hints-');
  try {
    writeSpec(w, 'feat', { requirements: REQ_MD });
    const r = await spec(w, ['new', 'feat', '--description', 'x', '--yes']);
    assert.equal(r.code, 1);
    const m = /^Spec 'feat' already exists\. Resume it with (.+)$/m.exec(r.err);
    assert.ok(m, r.err);
    assert.equal(m[1], 'kiro-claude spec approve feat · kiro-claude spec revise feat <feedback>');
    assert.doesNotMatch(r.err, NO_REPL_FORM);
    await assertAccepted(w, m[1]!);
  } finally {
    w.cleanup();
  }
});

test('spec run without tasks.md: "Continue the spec with" names approve and revise (design awaiting review)', async () => {
  const w = makeWs('kc-r7f-hints-');
  try {
    writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD });
    const r = await spec(w, ['run', 'feat', '--all']);
    assert.equal(r.code, 1);
    const m = /^Spec 'feat' has no tasks\.md yet\. Continue the spec with (.+)$/m.exec(r.err);
    assert.ok(m, r.err);
    assert.equal(m[1], 'kiro-claude spec approve feat · kiro-claude spec revise feat <feedback>');
    await assertAccepted(w, m[1]!);
  } finally {
    w.cleanup();
  }
});

test('a spec folder with no document: the CLI cannot draft it, so the hint names /spec <name> in kiro-claude chat', async () => {
  const w = makeWs('kc-r7f-hints-');
  try {
    writeSpec(w, 'feat', { config: '{"specId": "x", "workflowType": "requirements-first", "specType": "feature"}' });
    const nw = await spec(w, ['new', 'feat', '--description', 'x', '--yes']);
    assert.match(nw.err, /^Spec 'feat' already exists\. Resume it with \/spec feat in kiro-claude chat$/m, nw.err);
    const run = await spec(w, ['run', 'feat', '--all']);
    assert.match(run.err, /^Spec 'feat' has no tasks\.md yet\. Continue the spec with \/spec feat in kiro-claude chat$/m, run.err);
    const an = await spec(w, ['analyze', 'feat', '--yes']);
    assert.match(an.err, /^No requirements\.md yet\. Continue the spec with \/spec feat in kiro-claude chat$/m, an.err);
    for (const t of [nw.err, run.err, an.err]) assert.doesNotMatch(t, /Start with kiro-claude spec new|kiro-claude spec feat\b/, t);
  } finally {
    w.cleanup();
  }
});

test('approved tasks: the hint for an existing spec is run <name> --next; a spec with a refused file: status <name>', async () => {
  const w = makeWs('kc-r7f-hints-');
  try {
    writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const r = await spec(w, ['new', 'feat', '--description', 'x', '--yes']);
    const m = /^Spec 'feat' already exists\. Resume it with (.+)$/m.exec(r.err);
    assert.ok(m, r.err);
    assert.equal(m[1], 'kiro-claude spec run feat --next');
    // a document that is a symbolic link (docfs refuses it): status says why
    const dir = writeSpec(w, 'linked', { requirements: REQ_MD });
    fs.writeFileSync(path.join(w.proj, 'elsewhere.md'), DESIGN_MD);
    fs.symlinkSync(path.join(w.proj, 'elsewhere.md'), path.join(dir, 'design.md'));
    const l = await spec(w, ['new', 'linked', '--description', 'x', '--yes']);
    const ml = /^Spec 'linked' already exists\. Resume it with (.+)$/m.exec(l.err);
    assert.ok(ml, l.err);
    assert.equal(ml[1], 'kiro-claude spec status linked');
    const st = await spec(w, ['status', 'linked']);
    assert.equal(st.code, 0, st.err);
    assert.match(st.out, /is a symbolic link/, st.out);
  } finally {
    w.cleanup();
  }
});

test('interactive checkpoint Stop: the label and the stop hint name approve and revise, which the CLI accepts', async () => {
  const w = makeWs('kc-r7f-hints-');
  try {
    // kind 1 (feature), workflow 1 (requirements-first), description, then 4 = "Stop here (…)"
    const r = await spec(w, ['new', 'todo-export'], { isTTY: true, io: scriptedIO(['1', '1', 'Export todos', '4']) });
    assert.equal(r.code, 0, r.err);
    const label = /Stop here \(resume later with (.+)\)\n/.exec(r.out);
    assert.ok(label, r.out);
    assert.equal(label[1], 'kiro-claude spec approve todo-export · kiro-claude spec revise todo-export <feedback>');
    const stop = /^Stopped at the requirements\.md checkpoint\. Resume later with (.+)\.$/m.exec(r.err);
    assert.ok(stop, r.err);
    assert.equal(stop[1], label[1]);
    assert.doesNotMatch(`${r.out}${r.err}`, NO_REPL_FORM);
    await assertAccepted(w, label[1]!);
  } finally {
    w.cleanup();
  }
});
