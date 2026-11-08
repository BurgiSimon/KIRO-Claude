/**
 * Round 8, finding #9 (spec), in process: the type of a spec without a usable `specType` (no
 * `.config.kiro`, a legacy `{"generationMode": …}` one, or one without `specType`) is inferred from
 * `bugfix.md`. store.summarizeSpecDir used `docs.bugfix.nonEmpty` and readSpecConfig's legacy
 * branch `hasText(bugfix.md)`, both false for a document kiro-claude does not read (docfs: a
 * symbolic link, a dangling one, one the user cannot read). So an existing bugfix.md that is
 * refused counted as missing: the spec became a requirements-first feature spec at "Phase:
 * drafting requirements.md", and status, list, view, analyze, approve and `/spec <name>` named a
 * requirements.md this spec never has. That broke the rule that an unreadable document is never
 * taken for a missing one (r7 #6).
 *
 * Now an existing refused bugfix.md counts as present for the type, as it does for the phase: the
 * spec derives as a bugfix spec with bugfix.md awaiting approval and marked `⚠ not read`. With real
 * permissions (uid 65534): test/spec/r8f-spec-type-access.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { CliContext, KiroSession } from '../../src/types.js';
import { runSpecCommandWith, type SpecCliDeps } from '../../src/spec/cli.js';
import { createReplRuntime, resumeSpec } from '../../src/spec/workflow.js';
import { formatSpecList, formatSpecStatus, loadSpecDir, readSpecConfig, specContextBlock, specSummaryJson, summarizeSpecDir } from '../../src/spec/store.js';
import { BUGFIX_MD, MockHost, MockSession, REQ_MD, fakeModel, makeWs, mockSettings, writeSpec, type Ws } from './helpers.js';
import { removeOnExit } from '../tmpdirs.js';

class Capture extends Writable {
  data = '';
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += chunk.toString();
    cb();
  }
}

function ws(): Ws {
  const w = makeWs('kc-r8f-spec-type-');
  removeOnExit(w.root);
  return w;
}

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
  const code = await runSpecCommandWith(argv, ctx, { createSession: async (o) => new MockSession(o, model) as KiroSession, ...extra });
  return { code, out: out.data, err: err.data, log };
}

const CONFIGS: [string, string | undefined][] = [
  ['no .config.kiro', undefined],
  ['legacy {"generationMode"} .config.kiro', '{"generationMode": "requirements-first"}'],
  ['.config.kiro without specType', '{"specId": "x", "workflowType": "requirements-first"}'],
];

/** `fix-crash` with only a bugfix.md that docfs refuses: `kind` 'link' (to a regular file in the workspace) or 'dangling'. */
function refusedBugfix(w: Ws, kind: 'link' | 'dangling', config: string | undefined): { dir: string; doc: string } {
  const dir = writeSpec(w, 'fix-crash', config === undefined ? {} : { config });
  const target = path.join(w.proj, 'notes', 'bugfix.md');
  if (kind === 'link') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, BUGFIX_MD);
  }
  const doc = path.join(dir, 'bugfix.md');
  fs.symlinkSync(target, doc);
  return { dir, doc };
}

/** What every surface must show for a bugfix spec whose bugfix.md exists but is refused. */
function assertBugfixRefused(dir: string, doc: string): void {
  const s = summarizeSpecDir(dir);
  const show = JSON.stringify(specSummaryJson(s));
  assert.equal(s.specType, 'bugfix', show);
  assert.deepEqual(s.order, ['bugfix', 'design', 'tasks'], show);
  assert.equal(s.phase, 'design', show);
  assert.equal(s.awaitingApproval, 'bugfix', show);
  assert.ok(s.refused?.startsWith(doc), show);
  assert.deepEqual(Object.keys(specSummaryJson(s).documents as object), ['bugfix', 'design', 'tasks'], show);
  const status = formatSpecStatus(loadSpecDir(dir));
  assert.match(status, /^Spec: fix-crash \(bugfix, requirements-first\)$/m, status);
  assert.match(status, /^ {2}bugfix\.md\s+⚠\s+not read \(below\)$/m, status);
  assert.match(status, /^Phase: bugfix\.md awaiting approval \(next: design\.md\)$/m, status);
  assert.doesNotMatch(status, /requirements\.md|drafting/, status);
  assert.match(formatSpecList([s]), /^fix-crash\s+bugfix\s+refused\s+-$/m);
}

for (const [label, config] of CONFIGS) {
  for (const kind of ['link', 'dangling'] as const) {
    test(`a refused bugfix.md (${kind === 'link' ? 'a symbolic link' : 'a dangling link'}, ${label}) keeps the spec a bugfix spec`, () => {
      const w = ws();
      const { dir, doc } = refusedBugfix(w, kind, config);
      if (config !== undefined) assert.equal(readSpecConfig(dir)?.specType, 'bugfix', 'readSpecConfig infers the type from the refused bugfix.md');
      assertBugfixRefused(dir, doc);
    });
  }
}

test('a refused bugfix.md: view, analyze, approve and list name bugfix.md and its reason, never a requirements.md', async () => {
  const w = ws();
  const { doc } = refusedBugfix(w, 'link', '{"generationMode": "requirements-first"}');
  const view = await spec(w, ['view', 'fix-crash']);
  const viewReq = await spec(w, ['view', 'fix-crash', 'requirements']);
  const analyze = await spec(w, ['analyze', 'fix-crash', '--yes']);
  const approve = await spec(w, ['approve', 'fix-crash']);
  const list = await spec(w, ['list']);
  const json = await spec(w, ['status', 'fix-crash', '--format', 'json']);
  const all = [view, viewReq, analyze, approve, list, json].map((r) => `(exit ${r.code})\n${r.out}${r.err}`).join('\n---\n');
  for (const r of [view, viewReq]) {
    assert.equal(r.code, 1, all);
    assert.ok(r.err.startsWith(`error: ${doc} is a symbolic link`), all);
  }
  assert.equal(analyze.code, 1, all);
  assert.ok(analyze.err.includes(`✗ Cannot analyze bugfix.md: ${doc} is a symbolic link`), all);
  assert.equal(approve.code, 1, all);
  assert.ok(approve.err.includes(`✗ Cannot approve bugfix.md: ${doc} is a symbolic link`), all);
  assert.match(list.out, /^fix-crash\s+bugfix\s+refused\s+-$/m, all);
  const j = JSON.parse(json.out) as Record<string, unknown>;
  assert.equal(j.specType, 'bugfix', all);
  assert.equal(j.phase, 'design', all);
  assert.equal(j.awaitingApproval, 'bugfix', all);
  for (const r of [view, viewReq, analyze, approve, list, json]) assert.doesNotMatch(`${r.out}${r.err}`, /requirements\.md|No requirements/, all);
  for (const r of [view, viewReq, analyze, approve]) assert.deepEqual(r.log, [], `a turn ran:\n${all}`);
});

test('REPL /spec <name> with a refused bugfix.md: the bugfix.md checkpoint (no Approve, the reason), never "Cannot draft requirements.md"', async () => {
  const w = ws();
  const { doc } = refusedBugfix(w, 'link', undefined);
  const host = new MockHost(w.ctx, fakeModel());
  host.chooseAnswers = ['Stop here'];
  const r = await resumeSpec(createReplRuntime(host, { openEditor: null }), 'fix-crash');
  assert.equal(r.status, 'stopped', host.text);
  assert.match(host.chosen[0]?.question ?? '', /^Does the bug analysis look good\?/, JSON.stringify(host.chosen));
  assert.ok(!host.chosen[0]!.options.some((o) => /^Approve/.test(o)), JSON.stringify(host.chosen));
  assert.ok(host.text.includes(`⚠ ${doc} is a symbolic link`), host.text);
  assert.match(host.text, /Stopped at the bugfix\.md checkpoint/, host.text);
  assert.doesNotMatch(host.text, /requirements\.md/, host.text);
});

test('unchanged: a readable bugfix.md is a bugfix spec; an empty one next to requirements.md is not; a specType in .config.kiro wins', () => {
  const w = ws();
  const readable = writeSpec(w, 'readable', { bugfix: BUGFIX_MD });
  assert.equal(summarizeSpecDir(readable).specType, 'bugfix');
  assert.equal(summarizeSpecDir(readable).awaitingApproval, 'bugfix');
  const empty = writeSpec(w, 'empty', { bugfix: '  \n', requirements: REQ_MD });
  assert.equal(summarizeSpecDir(empty).specType, 'feature');
  assert.equal(summarizeSpecDir(empty).awaitingApproval, 'requirements');
  const emptyLegacy = writeSpec(w, 'empty-legacy', { bugfix: '', requirements: REQ_MD, config: '{"generationMode": "requirements-first"}' });
  assert.equal(readSpecConfig(emptyLegacy)?.specType, 'feature');
  assert.equal(summarizeSpecDir(emptyLegacy).specType, 'feature');
  // the config's own specType is kept, whatever bugfix.md is
  const w2 = ws();
  const { dir } = refusedBugfix(w2, 'link', '{"specId": "x", "workflowType": "requirements-first", "specType": "feature"}');
  assert.equal(summarizeSpecDir(dir).specType, 'feature');
});

test('a refused bugfix.md is not read into the context block, which is the bugfix one (no requirements.md)', () => {
  const w = ws();
  const { dir } = refusedBugfix(w, 'link', undefined);
  fs.writeFileSync(path.join(dir, 'requirements.md'), REQ_MD);
  const s = summarizeSpecDir(dir);
  assert.equal(s.specType, 'bugfix');
  const refused: string[] = [];
  assert.equal(specContextBlock(w.ctx, s, refused), undefined);
  assert.deepEqual(refused, []);
});

test('a spec folder linked out of the workspace holding a bugfix.md: its type is bugfix (the files are only stat-ed), its phase unknown', () => {
  const w = ws();
  const outside = path.join(w.root, 'outside', 'fix-crash');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'bugfix.md'), BUGFIX_MD);
  fs.symlinkSync(outside, path.join(w.specs, 'fix-crash'));
  const s = summarizeSpecDir(path.join(w.specs, 'fix-crash'));
  assert.equal(s.specType, 'bugfix');
  assert.ok(s.refused, JSON.stringify(s));
  const status = formatSpecStatus(loadSpecDir(path.join(w.specs, 'fix-crash')));
  assert.match(status, /^Phase: unknown \(not read\)$/m, status);
  assert.doesNotMatch(status, /requirements\.md/, status);
});

test('a bugfix.md the user cannot read (mode 000, not as root) keeps the spec a bugfix spec', { skip: process.getuid?.() === 0 ? 'root reads it anyway: r8f-spec-type-access.test.ts runs this as uid 65534' : process.platform === 'win32' ? 'POSIX modes' : false }, () => {
  const w = ws();
  const dir = writeSpec(w, 'fix-crash', { bugfix: BUGFIX_MD });
  const doc = path.join(dir, 'bugfix.md');
  fs.chmodSync(doc, 0o000);
  try {
    const s = summarizeSpecDir(dir);
    assert.equal(s.specType, 'bugfix', JSON.stringify(s));
    assert.equal(s.awaitingApproval, 'bugfix', JSON.stringify(s));
    assert.match(s.refused ?? '', /cannot be accessed \(permission denied\)/);
  } finally {
    fs.chmodSync(doc, 0o644);
  }
});
