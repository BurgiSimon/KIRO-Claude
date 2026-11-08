/**
 * Round 8, verifier of the spec fixes, finding #10 follow-up: the fix made every interactive
 * checkpoint Stop in `kiro-claude spec` name `approve <name> · revise <name> <feedback>`, also at
 * the checkpoint of a spec's FIRST document when the phase turn did not write it (or a revision
 * emptied it). The CLI's `approve` and `revise` act on the document the files say awaits review;
 * there is none then, so both hinted commands fail ("Nothing to approve yet: requirements.md has
 * not been written.", exit 1). Before the fix the hint there was r7 #8's `/spec <name> in
 * kiro-claude chat` (only the chat drafts the first document of an existing folder).
 *
 * Now the checkpoint's document (`awaiting`) makes the CLI name approve/revise only when that
 * review is the one `approve` / `revise` resume (the tasks.md review included, r8 #10); else the
 * hint comes from where the spec stands, as outside a checkpoint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { CliContext, KiroSession } from '../../src/types.js';
import { runSpecCommandWith, type SpecCliDeps, type SpecCliIO } from '../../src/spec/cli.js';
import { REQ_MD, MockSession, fakeModel, makeWs, mockSettings, writeSpec, type Ws } from './helpers.js';
import type { ModelScript } from './helpers.js';
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
  const w = makeWs('kc-r8f-spec-verify-hints-');
  removeOnExit(w.root);
  return w;
}

/** A model whose turns for `docs` (drafting, or revising when `revise`) write nothing / empty the file. */
function withholding(docs: string[], o: { empties?: boolean } = {}): ModelScript {
  const base = fakeModel({});
  return (input, s) => {
    const t = input.text;
    for (const d of docs) {
      if (new RegExp(`Create or update \\S+/${d.replace('.', '\\.')}`).test(t)) return { text: `I did not write ${d}.` };
      const m = new RegExp(`^Revise (\\S+/${d.replace('.', '\\.')})`).exec(t);
      if (m && o.empties) {
        fs.writeFileSync(m[1]!, '');
        return { text: `Emptied ${d}.` };
      }
    }
    return base(input, s);
  };
}

async function spec(w: Ws, argv: string[], model: ModelScript, extra: Partial<SpecCliDeps> = {}): Promise<{ code: number; out: string; err: string }> {
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
  const code = await runSpecCommandWith(argv, ctx, { createSession: async (o) => new MockSession(o, model) as KiroSession, ...extra });
  return { code, out: out.data, err: err.data };
}

const CHAT = '/spec feat in kiro-claude chat';

interface Case {
  title: string;
  docs?: { requirements?: string };
  argv: string[];
  answers: string[];
  model: ModelScript;
  /** The checkpoint stopped at (its file). */
  doc: string;
}

const CASES: Case[] = [
  { title: 'spec new (requirements-first): the phase turn wrote no requirements.md', argv: ['new', 'feat'], answers: ['1', '1', 'Export todos', 'stop'], model: withholding(['requirements.md']), doc: 'requirements.md' },
  { title: 'spec new (design-first): the phase turn wrote no design.md', argv: ['new', 'feat'], answers: ['1', '2', '1', 'Export todos', 'stop'], model: withholding(['design.md']), doc: 'design.md' },
  { title: 'spec new (bugfix): the phase turn wrote no bugfix.md', argv: ['new', 'feat'], answers: ['2', 'Crash on start', 'stop'], model: withholding(['bugfix.md']), doc: 'bugfix.md' },
  {
    title: 'spec revise of requirements.md: the revision emptied it',
    docs: { requirements: REQ_MD },
    argv: ['revise', 'feat', 'start', 'over'],
    answers: ['stop'],
    model: withholding(['requirements.md'], { empties: true }),
    doc: 'requirements.md',
  },
];

for (const c of CASES) {
  test(`interactive Stop at the checkpoint of an unwritten first document names the chat, never approve/revise that fail: ${c.title}`, async () => {
    const w = ws();
    if (c.docs) writeSpec(w, 'feat', c.docs);
    const r = await spec(w, c.argv, c.model, { isTTY: true, io: scriptedIO([...c.answers]) });
    const all = `--- stdout\n${r.out}\n--- stderr\n${r.err}`;
    assert.equal(r.code, 0, all);
    assert.match(r.err, new RegExp(`⚠ ${c.doc.replace('.', '\\.')} was not written`), all);
    const labels = [...r.out.matchAll(/Stop here \(resume later with (.+)\)\n/g)].map((m) => m[1]!);
    assert.deepEqual(labels, [CHAT], all);
    const stop = /^Stopped at the (\S+) checkpoint\. Resume later with (.+)\.$/m.exec(r.err);
    assert.ok(stop, all);
    assert.equal(stop[1], c.doc, all);
    assert.equal(stop[2], CHAT, all);
    // what the CLI's approve / revise would say there (why they are not the hint)
    const approve = await spec(w, ['approve', 'feat'], fakeModel({}));
    assert.equal(approve.code, 1, approve.err);
    assert.match(approve.err, new RegExp(`Nothing to approve yet: ${c.doc.replace('.', '\\.')} has not been written`), approve.err);
  });
}

test('control: the checkpoint of a later document that was not written keeps approve/revise, and approve drafts it again', async () => {
  const w = ws();
  writeSpec(w, 'feat', { requirements: REQ_MD });
  const r = await spec(w, ['approve', 'feat'], withholding(['design.md']), { isTTY: true, io: scriptedIO(['stop']) });
  const all = `--- stdout\n${r.out}\n--- stderr\n${r.err}`;
  assert.equal(r.code, 0, all);
  const hint = 'kiro-claude spec approve feat · kiro-claude spec revise feat <feedback>';
  assert.match(r.out, new RegExp(`Stop here \\(resume later with ${hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), all);
  assert.match(r.err, /^Stopped at the design\.md checkpoint\. Resume later with kiro-claude spec approve feat · kiro-claude spec revise feat <feedback>\.$/m, all);
  const again = await spec(w, ['approve', 'feat'], fakeModel({}));
  assert.equal(again.code, 0, again.err);
  assert.ok(fs.existsSync(path.join(w.specs, 'feat', 'design.md')), again.err);
  assert.match(again.err, /^design\.md is waiting for review\./m, again.err);
});
