import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  CONFIG_FILE,
  createSpecFolder,
  docOrder,
  formatSpecConfig,
  formatSpecList,
  formatSpecStatus,
  isValidSpecName,
  listSpecs,
  loadSpec,
  normalizeSpecName,
  phaseLabel,
  readSpecConfig,
  resolveSpecDir,
  specContextBlock,
  specSummaryJson,
  summarizeSpec,
  writeSpecConfig,
} from '../../src/spec/store.js';
import { BUGFIX_MD, BUGFIX_TASKS_MD, DESIGN_MD, REQ_MD, TASKS_MD, exampleSpecDir, makeWs, writeSpec } from './helpers.js';

test('spec names: validation and normalization (03 §1.2)', () => {
  for (const ok of ['user-authentication', 'a', 'v2-api', 'github-issue-automation']) assert.equal(isValidSpecName(ok), true, ok);
  for (const bad of ['User-Auth', 'a--b', '-a', 'a-', 'a_b', '', 'a b', '../x']) assert.equal(isValidSpecName(bad), false, bad);
  assert.equal(normalizeSpecName('User Authentication!'), 'user-authentication');
  assert.equal(normalizeSpecName('  Ünïcode  Thing__v2 '), 'unicode-thing-v2');
  assert.equal(normalizeSpecName('---'), '');
});

test('.config.kiro: exact Kiro shape, no trailing newline (03 §1.3)', () => {
  const s = formatSpecConfig({ specId: 'b42c3b23-6015-4bed-8ccd-e395d3b6b22b', workflowType: 'requirements-first', specType: 'feature' });
  assert.equal(s, '{"specId": "b42c3b23-6015-4bed-8ccd-e395d3b6b22b", "workflowType": "requirements-first", "specType": "feature"}');
  assert.ok(!s.endsWith('\n'));
  const w = makeWs();
  try {
    const dir = path.join(w.specs, 'x');
    fs.mkdirSync(dir);
    writeSpecConfig(dir, { specId: 'id', workflowType: 'design-first', specType: 'bugfix' });
    assert.equal(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8'), '{"specId": "id", "workflowType": "design-first", "specType": "bugfix"}');
    assert.deepEqual(readSpecConfig(dir), { specId: 'id', workflowType: 'design-first', specType: 'bugfix' });
  } finally {
    w.cleanup();
  }
});

test('.config.kiro: legacy generationMode, garbled, missing, extra keys', () => {
  const w = makeWs();
  try {
    const cases: [string | undefined, unknown][] = [
      ['{"generationMode": "requirements-first"}', { specId: '', workflowType: 'requirements-first', specType: 'feature' }],
      ['{"generationMode": "design-first"}', { specId: '', workflowType: 'design-first', specType: 'feature' }],
      ['﻿{"specId": "a", "workflowType": "requirements-first", "specType": "bugfix", "extra": 1}', { specId: 'a', workflowType: 'requirements-first', specType: 'bugfix' }],
      ['{"specType": "quick"}', { specId: '', workflowType: 'requirements-first', specType: 'feature' }],
      ['not json', null],
      ['[]', null],
      ['{}', null],
      [undefined, null],
    ];
    cases.forEach(([raw, want], i) => {
      const dir = writeSpec(w, `c${i}`, raw === undefined ? {} : { config: raw });
      assert.deepEqual(readSpecConfig(dir), want, raw ?? '(missing)');
    });
  } finally {
    w.cleanup();
  }
});

test('createSpecFolder: writes the config, refuses duplicates and bad names', () => {
  const w = makeWs();
  try {
    const dir = createSpecFolder(w.ctx, 'todo-export', { specType: 'feature', workflowType: 'requirements-first' });
    assert.equal(dir, path.join(w.specs, 'todo-export'));
    const cfg = readSpecConfig(dir)!;
    assert.match(cfg.specId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.throws(() => createSpecFolder(w.ctx, 'todo-export', { specType: 'feature', workflowType: 'requirements-first' }), /already exists/);
    assert.throws(() => createSpecFolder(w.ctx, 'Bad Name', { specType: 'feature', workflowType: 'requirements-first' }), /invalid spec name/);
  } finally {
    w.cleanup();
  }
});

test('resolveSpecDir: exact, case-insensitive, no traversal', () => {
  const w = makeWs();
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD });
    assert.equal(resolveSpecDir(w.ctx, 'todo-export'), path.join(w.specs, 'todo-export'));
    assert.equal(resolveSpecDir(w.ctx, 'TODO-Export'), path.join(w.specs, 'todo-export'));
    for (const bad of ['..', '../proj', 'a/b', '', 'missing']) assert.equal(resolveSpecDir(w.ctx, bad), undefined, bad);
  } finally {
    w.cleanup();
  }
});

test('derived phase state (03 §1.11.2): table', () => {
  const w = makeWs();
  try {
    const rows: [string, Parameters<typeof writeSpec>[2], string, string | undefined][] = [
      ['empty', { config: '{"specId": "1", "workflowType": "requirements-first", "specType": "feature"}' }, 'requirements', undefined],
      ['req-only', { requirements: REQ_MD }, 'design', 'requirements'],
      ['req-design', { requirements: REQ_MD, design: DESIGN_MD }, 'tasks', 'design'],
      ['all', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD }, 'execution', undefined],
      ['done', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD.replace(/- \[ \] (1\.1|2\.1|3\.)/g, '- [x] $1') }, 'done', undefined],
      ['blank-design', { requirements: REQ_MD, design: '  \n\n' }, 'design', 'requirements'],
      ['tasks-without-tasks', { requirements: REQ_MD, design: DESIGN_MD, tasks: '# Implementation Plan\n\nTBD\n' }, 'tasks', 'design'],
      // bugfix: inferred from bugfix.md; empty requirements.md next to it ignored (KI:#9963)
      ['bug', { bugfix: BUGFIX_MD, requirements: '' }, 'design', 'bugfix'],
      ['bug-all', { bugfix: BUGFIX_MD, design: DESIGN_MD, tasks: BUGFIX_TASKS_MD }, 'execution', undefined],
      ['design-first', { config: '{"specId": "1", "workflowType": "design-first", "specType": "feature"}', design: DESIGN_MD }, 'requirements', 'design'],
    ];
    for (const [name, docs, phase, awaiting] of rows) {
      writeSpec(w, name, docs);
      const s = summarizeSpec(w.ctx, name)!;
      assert.equal(s.phase, phase, name);
      assert.equal(s.awaitingApproval, awaiting, name);
    }
    assert.deepEqual(summarizeSpec(w.ctx, 'bug')!.order, ['bugfix', 'design', 'tasks']);
    assert.equal(summarizeSpec(w.ctx, 'bug')!.specType, 'bugfix');
    assert.deepEqual(summarizeSpec(w.ctx, 'design-first')!.order, ['design', 'requirements', 'tasks']);
    assert.deepEqual(docOrder('feature', 'requirements-first'), ['requirements', 'design', 'tasks']);
    assert.deepEqual(summarizeSpec(w.ctx, 'all')!.progress, { total: 5, done: 0, requiredTotal: 3, requiredDone: 0 });
    assert.equal(summarizeSpec(w.ctx, 'nope'), undefined);
  } finally {
    w.cleanup();
  }
});

test('listSpecs + formatSpecList rows `name  type  phase  done/total` (03 §1.11.1)', () => {
  const w = makeWs();
  try {
    assert.deepEqual(listSpecs(w.ctx), []);
    writeSpec(w, 'user-auth', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD.replace('- [ ] 1.1', '- [x] 1.1') });
    writeSpec(w, 'fix-save', { bugfix: BUGFIX_MD });
    writeSpec(w, 'brand-new', {});
    fs.mkdirSync(path.join(w.specs, '.hidden'));
    fs.writeFileSync(path.join(w.specs, 'stray.md'), 'x');
    const all = listSpecs(w.ctx);
    assert.deepEqual(
      all.map((s) => s.name),
      ['brand-new', 'fix-save', 'user-auth'],
    );
    assert.equal(formatSpecList(all), ['brand-new  feature  new       -', 'fix-save   bugfix   bugfix ✓  -', 'user-auth  feature  tasks ✓   1/5'].join('\n'));
    assert.equal(phaseLabel({ phase: 'done', order: [], awaitingApproval: undefined }), 'done');
    assert.equal(formatSpecList([]), '');
    const j = specSummaryJson(all[2]!);
    assert.deepEqual(j.documents, { requirements: true, design: true, tasks: true });
    assert.equal(j.phase, 'execution');
  } finally {
    w.cleanup();
  }
});

test('loadSpec + formatSpecStatus', () => {
  const w = makeWs();
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const spec = loadSpec(w.ctx, 'todo-export')!;
    assert.deepEqual(spec.criteriaIds, ['1.1', '1.2', '2.1']);
    assert.deepEqual(spec.lint, []);
    const out = formatSpecStatus(spec);
    assert.match(out, /^Spec: todo-export \(feature, requirements-first\)$/m);
    assert.match(out, /^ {2}requirements\.md +✓ {2}2 requirements, 3 criteria$/m);
    assert.match(out, /^ {2}design\.md +✓ {2}7 sections, 2 properties$/m);
    assert.match(out, /^ {2}tasks\.md +✓ {2}0\/5 tasks done \(required 0\/3\)$/m);
    assert.match(out, /^Phase: execution$/m);
    assert.match(out, /^Next task: 1\.1 Create `src\/export\.ts`/m);
    assert.match(out, /^ {4}\[ \]\* 1\.2 Write property test for row count$/m);
    writeSpec(w, 'half', { requirements: REQ_MD });
    const half = formatSpecStatus(loadSpec(w.ctx, 'half')!);
    assert.match(half, /design\.md +— {2}not written yet/);
    assert.match(half, /^Phase: requirements\.md awaiting approval \(next: design\.md\)$/m);
    writeSpec(w, 'gaps', { requirements: REQ_MD, tasks: '- [ ] 1. a\n  - _Requirements: 1.1_\n' });
    assert.match(formatSpecStatus(loadSpec(w.ctx, 'gaps')!), /⚠ Acceptance criteria not covered by any task: 1\.2, 2\.1/);
  } finally {
    w.cleanup();
  }
});

test('specContextBlock: docs in order with #[[file:]] expanded; empty requirements next to bugfix skipped', () => {
  const w = makeWs();
  try {
    fs.writeFileSync(path.join(w.proj, 'schema.sql'), 'CREATE TABLE todo(id int);\n');
    writeSpec(w, 'todo-export', { requirements: REQ_MD, design: `${DESIGN_MD}\n#[[file:schema.sql]]\n`, tasks: TASKS_MD });
    const s = summarizeSpec(w.ctx, 'todo-export')!;
    const b = specContextBlock(w.ctx, s)!;
    assert.ok(b.startsWith(`<spec name="todo-export" path="${s.dir}">\n[${path.join(s.dir, 'requirements.md')}]\n# Requirements Document`));
    assert.ok(b.indexOf('design.md]') < b.indexOf('tasks.md]'));
    assert.match(b, /\[schema\.sql\]\nCREATE TABLE todo\(id int\);/);
    assert.ok(b.endsWith('\n</spec>'));
    writeSpec(w, 'bug', { bugfix: BUGFIX_MD, requirements: '' });
    const bb = specContextBlock(w.ctx, summarizeSpec(w.ctx, 'bug')!)!;
    assert.ok(!bb.includes('requirements.md]'));
    assert.ok(bb.includes('bugfix.md]'));
    writeSpec(w, 'nothing', {});
    assert.equal(specContextBlock(w.ctx, summarizeSpec(w.ctx, 'nothing')!), undefined);
  } finally {
    w.cleanup();
  }
});

const ex = exampleSpecDir();

test('real example spec: summary and status', { skip: !ex && 'example spec not available' }, () => {
  const w = makeWs();
  try {
    const dir = path.join(w.specs, 'github-issue-automation');
    fs.mkdirSync(dir);
    for (const f of ['requirements.md', 'design.md', 'tasks.md']) fs.copyFileSync(path.join(ex!, f), path.join(dir, f));
    const spec = loadSpec(w.ctx, 'github-issue-automation')!;
    assert.equal(spec.config, null);
    assert.equal(spec.specType, 'feature');
    assert.equal(spec.phase, 'execution');
    assert.deepEqual(spec.lint, []);
    assert.equal(formatSpecList([spec]), 'github-issue-automation  feature  tasks ✓  26/52');
    assert.match(formatSpecStatus(spec), /Next task: 5 Checkpoint - Core classification working/);
  } finally {
    w.cleanup();
  }
});
