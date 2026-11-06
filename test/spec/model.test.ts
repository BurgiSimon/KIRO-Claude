import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  TASK_RE,
  applyBoxChange,
  compareTaskIds,
  formatTaskLine,
  incompleteLeavesOf,
  isOptionalTask,
  leafTasks,
  lintSpec,
  normalizeGraph,
  normalizeTasksText,
  parseBugfix,
  parseDesign,
  parseRefList,
  parseRequirements,
  parseTasks,
  planRun,
  planTasks,
  repairMessage,
  scanLines,
  taskProgress,
  writeTaskStatus,
} from '../../src/spec/model.js';
import { BUGFIX_MD, DESIGN_MD, REQ_MD, TASKS_MD, exampleSpecDir, makeWs } from './helpers.js';

const ids = (ts: { id: string }[]): string[] => ts.map((t) => t.id);

// ───────────────────────────── TASK_RE ─────────────────────────────

test('TASK_RE: line grammar table (03 §1.5.5)', () => {
  const rows: [string, Record<string, string | undefined> | null][] = [
    ['- [ ] 1. Set up project', { indent: '', box: ' ', opt: undefined, id: '1', title: 'Set up project' }],
    ['  - [x] 2.1 Create models', { indent: '  ', box: 'x', opt: undefined, id: '2.1', title: 'Create models' }],
    ['  - [ ]* 2.2 Write unit tests', { indent: '  ', box: ' ', opt: '*', id: '2.2', title: 'Write unit tests' }],
    ['- [-] 3. In progress', { box: '-', id: '3', title: 'In progress' }],
    ['- [~] 4. Queued', { box: '~', id: '4', title: 'Queued' }],
    ['- [X] 5. Upper X', { box: 'X', id: '5', title: 'Upper X' }],
    ['- [] 6. Empty box', { box: '', id: '6', title: 'Empty box' }],
    ['* [ ] 7. Star bullet', { box: ' ', id: '7', title: 'Star bullet' }],
    ['+ [ ] 8. Plus bullet', { box: ' ', id: '8', title: 'Plus bullet' }],
    ['1. [ ] Ordered marker', { ord: '1', id: undefined, title: 'Ordered marker' }],
    ['- [ ] Unnumbered task', { id: undefined, title: 'Unnumbered task' }],
    ['- [ ] 14. Final checkpoint - Integration testing', { id: '14', title: 'Final checkpoint - Integration testing' }],
    ['- [ ] 3.', { id: '3', title: '' }],
    ['- [ ] 1.Title', { id: undefined, title: '1.Title' }],
    ['- [x] 1.1 (P) スクリプト', { id: '1.1', title: '(P) スクリプト' }],
    ['- not a task', null],
    ['[ ] 1. no bullet', null],
    ['- [y] 1. bad box', null],
  ];
  for (const [line, want] of rows) {
    const m = TASK_RE.exec(line);
    if (want === null) {
      assert.equal(m, null, line);
      continue;
    }
    assert.ok(m, line);
    for (const [k, v] of Object.entries(want)) assert.equal(m.groups![k], v, `${line} → ${k}`);
  }
});

test('parseRefList / compareTaskIds', () => {
  assert.deepEqual(parseRefList('1.1, 2.3,  5'), ['1.1', '2.3', '5']);
  assert.deepEqual(parseRefList('R1.6 R3.5.'), ['1.6', '3.5']);
  assert.deepEqual(parseRefList('1.1, 1.1, foo, (2.2)'), ['1.1', '2.2']);
  const sorted = ['2.10', '2.9', '10', '2', '#1', '1.1'].sort(compareTaskIds);
  assert.deepEqual(sorted, ['1.1', '2', '2.9', '2.10', '10', '#1']);
});

test('scanLines marks fenced blocks (backticks, tildes, indented, longer closers)', () => {
  const text = ['a', '```ts', '- [ ] 1. not a task', '```', 'b', '  ~~~', '  x', '  ~~~~', 'c', '````', '```', '````', 'd'].join('\n');
  const l = scanLines(text);
  assert.deepEqual(
    l.map((x) => x.fenced),
    [false, true, true, true, false, true, true, true, false, true, true, true, false],
  );
  assert.equal(l[4]!.start, text.indexOf('\nb') + 1);
});

// ───────────────────────────── parseTasks ─────────────────────────────

test('parseTasks: synthetic 2026 tasks.md', () => {
  const t = parseTasks(TASKS_MD);
  assert.equal(t.title, 'Todo Export');
  assert.deepEqual(ids(t.tasks), ['1', '1.1', '1.2', '2', '2.1', '2.2', '3']);
  const byId = t.byId;
  assert.deepEqual(byId.get('1')!.children, ['1.1', '1.2']);
  assert.equal(byId.get('1.1')!.parentId, '1');
  assert.deepEqual(byId.get('1.1')!.requirementRefs, ['1.1', '1.2']);
  assert.deepEqual(byId.get('1.1')!.details, ['Header row first', '_Requirements: 1.1, 1.2_']);
  assert.equal(byId.get('1.2')!.optional, true);
  assert.deepEqual(byId.get('1.2')!.propertyRefs, [1]);
  assert.deepEqual(byId.get('1.2')!.validates, ['1.1', '1.2']);
  assert.equal(byId.get('3')!.isCheckpoint, true);
  assert.equal(byId.get('3')!.parentId, null);
  assert.equal(t.graph.source, 'file');
  // waves from the file; checkpoint excluded; nothing omitted
  assert.deepEqual(t.graph.waves, [
    ['1.1', '1.2'],
    ['2.1', '2.2'],
  ]);
  assert.match(byId.get('1.1')!.textHash, /^[0-9a-f]{64}$/);
  // box offsets point at the box character
  for (const task of t.tasks) assert.equal(TASKS_MD[task.boxOffset], task.box === 'x' ? 'x' : task.box);
});

test('parseTasks: 2025 flat format (sub-tasks not indented) takes the parent from the numbering', () => {
  const text = ['- [ ] 1. Parent', '- [ ] 1.1 Child one', '- [x] 1.2 Child two', '- [ ] 2. Next', '- [ ] 2.1 Grandchild?', ''].join('\n');
  const t = parseTasks(text);
  assert.deepEqual(
    t.tasks.map((x) => [x.id, x.parentId]),
    [
      ['1', null],
      ['1.1', '1'],
      ['1.2', '1'],
      ['2', null],
      ['2.1', '2'],
    ],
  );
});

test('parseTasks: fenced checklists are not tasks; fenced detail blocks stay with the task', () => {
  const text = [
    '- [ ] 1. Real task',
    '  - Detail',
    '    ```ts',
    '- [ ] 9. inside a fence',
    '    ```',
    '  - After fence',
    '',
    '```',
    '- [ ] 8. example in a top-level fence',
    '```',
    '- [ ] 2. Second',
  ].join('\n');
  const t = parseTasks(text);
  assert.deepEqual(ids(t.tasks), ['1', '2']);
  assert.deepEqual(t.byId.get('1')!.details, ['Detail', '```ts', '- [ ] 9. inside a fence', '```', 'After fence']);
});

test('parseTasks: unnumbered and duplicate ids are synthesized, parents by indentation', () => {
  const text = ['- [ ] Setup', '  - [ ] Install deps', '- [ ] 1. Numbered', '- [ ] 1. Duplicate number', ''].join('\n');
  const t = parseTasks(text);
  assert.deepEqual(
    t.tasks.map((x) => [x.id, x.parentId, x.synthesized]),
    [
      ['#1', null, true],
      ['#2', '#1', true],
      ['1', null, false],
      ['#3', null, true],
    ],
  );
});

test('parseTasks: ordered-list markers carry the id (`1. [ ] Title`)', () => {
  const text = ['  1. [ ] Add scope foundations', '  - [~] 1.1 Derive child scopes', '  - [ ]* 1.2 Unit tests', '  2. [ ] Checkpoint - tests pass', ''].join('\n');
  const t = parseTasks(text);
  assert.deepEqual(
    t.tasks.map((x) => [x.id, x.parentId, x.box, x.status]),
    [
      ['1', null, ' ', 'not_started'],
      ['1.1', '1', '~', 'queued'],
      ['1.2', '1', ' ', 'not_started'],
      ['2', null, ' ', 'not_started'],
    ],
  );
  assert.equal(t.byId.get('2')!.isCheckpoint, true);
});

test('parseTasks: CRLF files keep offsets and strip \\r from titles', () => {
  const text = TASKS_MD.replace(/\n/g, '\r\n');
  const t = parseTasks(text);
  assert.equal(t.eol, '\r\n');
  assert.equal(t.byId.get('2.1')!.title, 'Quote special characters in `src/export.ts`');
  const r = applyBoxChange(text, '2.1', 'x');
  assert.equal(r.text, text.replace('- [ ] 2.1', '- [x] 2.1'));
});

test('parseTasks: statuses and checkpoint variants', () => {
  const text = [
    '- [x] 1. Done',
    '- [-] 2. Running',
    '- [ ] 3. Checkpoint — Verify',
    '- [ ] 4. CHECKPOINT – all tests must pass',
    '- [ ] 5. Final checkpoint - Integration',
    '- [ ] 6. Checkpointing is not a checkpoint',
  ].join('\n');
  const t = parseTasks(text);
  assert.deepEqual(
    t.tasks.map((x) => [x.status, x.isCheckpoint]),
    [
      ['completed', false],
      ['in_progress', false],
      ['not_started', true],
      ['not_started', true],
      ['not_started', true],
      ['not_started', false],
    ],
  );
});

test('graph: tolerant shapes (03 §1.6.3)', () => {
  const body = ['- [ ] 1. A', '- [ ] 2. B', '  - [ ] 2.1 B1', '  - [ ] 2.2 B2', '- [ ] 3. Checkpoint - x', '- [ ] 4. C', ''].join('\n');
  const parsed = parseTasks(body);
  const g = (raw: unknown): string[][] => normalizeGraph(raw, parsed).waves;
  // canonical, sorted by id
  assert.deepEqual(g({ waves: [{ id: 1, tasks: ['2.1'] }, { id: 0, tasks: ['1'] }] }), [['1'], ['2.1'], ['2.2', '4']]);
  // {wave, dependsOn} variant; parent id expands to its leaves; checkpoint dropped; unknown dropped
  assert.deepEqual(g({ waves: [{ wave: 1, tasks: ['1', '99'], dependsOn: [] }, { wave: 2, tasks: ['2', '3', '4'] }] }), [['1'], ['2.1', '2.2', '4']]);
  // arrays of arrays, numbers accepted
  assert.deepEqual(g({ waves: [[1], ['2.1', '2.2'], ['4']] }), [['1'], ['2.1', '2.2'], ['4']]);
  // invalid ⇒ derived sequential (checkpoint excluded)
  assert.deepEqual(normalizeGraph(undefined, parsed), { waves: [['1'], ['2.1'], ['2.2'], ['4']], source: 'derived' });
  assert.equal(normalizeGraph({ nope: 1 }, parsed).source, 'derived');
});

test('graph: found anywhere in the file; mermaid then json; invalid json reported', () => {
  const head = ['# Implementation Plan', '', '## Task Dependency Graph', ''];
  const tasks = ['## Tasks', '', '- [ ] 1. A', '- [ ] 2. B', ''];
  const before = parseTasks([...head, '```json', '{"waves":[{"id":0,"tasks":["2"]},{"id":1,"tasks":["1"]}]}', '```', '', ...tasks].join('\n'));
  assert.deepEqual(before.graph, { waves: [['2'], ['1']], source: 'file' });
  const mermaid = parseTasks(
    [...tasks, '## Task Dependency Graph', '', '```mermaid', 'flowchart TD', '```', '', '```', 'Wave break notes', '```', '', '```json', '{"waves":[["2","1"]]}', '```', ''].join('\n'),
  );
  assert.deepEqual(mermaid.graph.waves, [['2', '1']]);
  assert.equal(mermaid.graphError, undefined);
  const bad = parseTasks([...tasks, '## Task Dependency Graph', '', '```json', '{"waves": [', '```', ''].join('\n'));
  assert.equal(bad.graph.source, 'derived');
  assert.match(bad.graphError ?? '', /invalid JSON/);
  const onlyMermaid = parseTasks([...tasks, '## Task Dependency Graph', '```mermaid', 'graph', '```', ''].join('\n'));
  assert.equal(onlyMermaid.graph.source, 'derived');
  assert.equal(onlyMermaid.graphError, undefined);
});

// ───────────────────────────── progress / planning ─────────────────────────────

test('taskProgress and optional inheritance', () => {
  const text = ['- [x] 1. A', '- [ ]* 2. Optional parent', '  - [ ] 2.1 inherits optional', '- [ ] 3. B', '  - [x] 3.1 b1', '  - [ ]* 3.2 b2', ''].join('\n');
  const t = parseTasks(text);
  assert.equal(isOptionalTask(t.byId.get('2.1')!, t.byId), true);
  assert.equal(isOptionalTask(t.byId.get('3.1')!, t.byId), false);
  assert.deepEqual(ids(leafTasks(t)), ['1', '2.1', '3.1', '3.2']);
  assert.deepEqual(taskProgress(t), { total: 4, done: 2, requiredTotal: 2, requiredDone: 2 });
  assert.deepEqual(ids(incompleteLeavesOf(t.byId.get('3')!, t.byId)), ['3.2']);
});

test('planRun: scopes, waves and checkpoint barriers', () => {
  const t = parseTasks(TASKS_MD);
  const steps = (sel: Parameters<typeof planRun>[1]): string =>
    planRun(t, sel)
      .steps.map((s) => (s.kind === 'wave' ? s.tasks.map((x) => x.id).join('+') : `CP${s.task.id}`))
      .join(' | ');
  assert.equal(steps({ kind: 'scope', includeOptional: false }), '1.1 | 2.1 | CP3');
  assert.equal(steps({ kind: 'scope', includeOptional: true }), '1.1+1.2 | 2.1+2.2 | CP3');
  assert.equal(steps({ kind: 'next' }), '1.1');
  assert.equal(steps({ kind: 'ids', ids: ['2'] }), '2.1');
  assert.equal(steps({ kind: 'ids', ids: ['2'], includeOptional: true }), '2.1+2.2');
  assert.equal(steps({ kind: 'ids', ids: ['1.2'] }), '1.2', 'an explicit optional leaf runs');
  assert.equal(steps({ kind: 'ids', ids: ['3', '1.1'] }), '1.1 | CP3');
  const unk = planRun(t, { kind: 'ids', ids: ['9', '1.1'] });
  assert.deepEqual(unk.unknownIds, ['9']);
  assert.deepEqual(ids(planTasks(unk)), ['1.1']);
});

test('planRun: checkpoint splits graph waves by document position', () => {
  const text = [
    '- [ ] 1. A',
    '- [ ] 2. Checkpoint - after A',
    '- [ ] 3. B',
    '- [ ] 4. C',
    '- [ ] 5. Final checkpoint - done',
    '## Task Dependency Graph',
    '```json',
    '{"waves":[{"id":0,"tasks":["1","3","4"]}]}',
    '```',
  ].join('\n');
  const plan = planRun(parseTasks(text), { kind: 'scope', includeOptional: false });
  assert.deepEqual(
    plan.steps.map((s) => (s.kind === 'wave' ? ids(s.tasks) : [`CP${s.task.id}`])),
    [['1'], ['CP2'], ['3', '4'], ['CP5']],
  );
  // completed tasks are skipped, next is the first remaining
  const done = text.replace('- [ ] 1. A', '- [x] 1. A');
  assert.deepEqual(ids(planTasks(planRun(parseTasks(done), { kind: 'next' }))), ['2']);
});

// ───────────────────────────── write-back ─────────────────────────────

test('applyBoxChange: only the box character changes; parent roll-up incl. optional children', () => {
  const r1 = applyBoxChange(TASKS_MD, '1.1', '-');
  assert.equal(r1.text, TASKS_MD.replace('- [ ] 1.1', '- [-] 1.1'));
  assert.deepEqual(r1.changes, [{ id: '1.1', from: ' ', to: '-' }]);
  const r2 = applyBoxChange(r1.text, '1.1', 'x');
  // 1.2 (optional) still open ⇒ parent stays [ ] (KR sample, 03 §1.5.5)
  assert.equal(parseTasks(r2.text).byId.get('1')!.box, ' ');
  const r3 = applyBoxChange(r2.text, '1.2', 'x');
  assert.deepEqual(r3.changes, [
    { id: '1.2', from: ' ', to: 'x' },
    { id: '1', from: ' ', to: 'x' },
  ]);
  assert.equal(r3.text, TASKS_MD.replace('- [ ] 1.1', '- [x] 1.1').replace('- [ ]* 1.2', '- [x]* 1.2').replace('- [ ] 1. Impl', '- [x] 1. Impl'));
  // unchanged box ⇒ no change, same text
  assert.deepEqual(applyBoxChange(r3.text, '1.1', 'x'), { text: r3.text, changes: [] });
  assert.throws(() => applyBoxChange(TASKS_MD, '42', 'x'), /task 42 not found/);
});

test('applyBoxChange: empty box [] is filled by insertion', () => {
  const text = '- [] 1. Empty\n- [ ] 2. Other\n';
  const r = applyBoxChange(text, '1', 'x');
  assert.equal(r.text, '- [x] 1. Empty\n- [ ] 2. Other\n');
  assert.equal(applyBoxChange(text, '2', 'x').text, '- [] 1. Empty\n- [x] 2. Other\n');
});

test('round trip: every box change on the synthetic file preserves all other bytes', () => {
  const t = parseTasks(TASKS_MD);
  for (const task of t.tasks) {
    for (const box of ['x', '-', '~', ' '] as const) {
      const r = applyBoxChange(TASKS_MD, task.id, box);
      assert.equal(r.text.length, TASKS_MD.length);
      const diffs = [...r.text].map((ch, i) => (ch !== TASKS_MD[i] ? i : -1)).filter((i) => i >= 0);
      const allowed = new Set(r.changes.map((c) => t.byId.get(c.id)!.boxOffset));
      for (const d of diffs) assert.ok(allowed.has(d), `${task.id}→${box}: unexpected change at ${d}`);
    }
  }
});

test('writeTaskStatus: re-reads, writes atomically, reports stale hashes, throws when gone', () => {
  const w = makeWs();
  try {
    const f = path.join(w.proj, 'tasks.md');
    fs.writeFileSync(f, TASKS_MD);
    const h = parseTasks(TASKS_MD).byId.get('2.1')!.textHash;
    const r = writeTaskStatus(f, '2.1', 'x', { expectHash: h });
    assert.deepEqual(r, { changes: [{ id: '2.1', from: ' ', to: 'x' }] });
    assert.equal(fs.readFileSync(f, 'utf8'), TASKS_MD.replace('- [ ] 2.1', '- [x] 2.1'));
    // someone edited the title: still found by id, flagged stale
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Quote special characters', 'Quote specials'));
    assert.equal(writeTaskStatus(f, '2.1', ' ', { expectHash: h }).stale, true);
    assert.throws(() => writeTaskStatus(f, '7.7', 'x'), /no longer in/);
    assert.deepEqual(
      fs.readdirSync(w.proj).filter((n) => n.endsWith('.tmp')),
      [],
    );
  } finally {
    w.cleanup();
  }
});

// ───────────────────────────── normalizer ─────────────────────────────

test('normalizeTasksText: repairs (03 §1.6.6)', () => {
  const broken = [
    '# Implementation Plan',
    '',
    '- 1. Main task without a box',
    '  - [ ] 1.1 Sub-task',
    '* [ ] 2. Star bullet',
    '+ [x] 3. Plus bullet',
    '- [] 4. Empty box',
    '  - [ ] *4.1 Optional, star glued to the id',
    '  - [ ] * 4.2 Optional with a space',
    '  - [ ] *Emphasis* is a title, untouched',
    '- 5. Plain numbered note (no sub-tasks)',
    '```',
    '* [ ] 6. fenced, untouched',
    '```',
    '',
    '',
  ].join('\n');
  const n = normalizeTasksText(broken);
  assert.equal(
    n.text,
    [
      '# Implementation Plan',
      '',
      '- [ ] 1. Main task without a box',
      '  - [ ] 1.1 Sub-task',
      '- [ ] 2. Star bullet',
      '- [x] 3. Plus bullet',
      '- [ ] 4. Empty box',
      '  - [ ]*4.1 Optional, star glued to the id',
      '  - [ ]* 4.2 Optional with a space',
      '  - [ ] *Emphasis* is a title, untouched',
      '- 5. Plain numbered note (no sub-tasks)',
      '```',
      '* [ ] 6. fenced, untouched',
      '```',
      '',
    ].join('\n'),
  );
  assert.equal(n.changedLines, 7);
  assert.equal(repairMessage('tasks.md', n.changedLines), 'Repaired tasks.md formatting (7 lines)');
  const p = parseTasks(n.text);
  assert.deepEqual([p.byId.get('4.1')!.optional, p.byId.get('4.2')!.optional, p.byId.get('4.1')!.parentId], [true, true, '4']);
  assert.equal(repairMessage('tasks.md', 1), 'Repaired tasks.md formatting (1 line)');
  // idempotent; already-clean files are untouched
  assert.deepEqual(normalizeTasksText(n.text), { text: n.text, changedLines: 0 });
  assert.deepEqual(normalizeTasksText(TASKS_MD), { text: TASKS_MD, changedLines: 0 });
  assert.deepEqual(normalizeTasksText('- [ ] 1. a'), { text: '- [ ] 1. a\n', changedLines: 1 });
  assert.deepEqual(normalizeTasksText('- [ ] 1. a\r\n* [ ] 2. b\r\n'), { text: '- [ ] 1. a\r\n- [ ] 2. b\r\n', changedLines: 1 });
  assert.deepEqual(normalizeTasksText(''), { text: '', changedLines: 0 });
});

// ───────────────────────────── requirements / bugfix / design ─────────────────────────────

test('parseRequirements: 2026 format', () => {
  const r = parseRequirements(REQ_MD);
  assert.equal(r.title, 'Requirements Document');
  assert.deepEqual(r.glossary, [
    { term: 'Exporter', definition: 'The module that serializes todos' },
    { term: 'Todo_Store', definition: 'The persistence layer holding todos' },
  ]);
  assert.deepEqual(
    r.requirements.map((q) => [q.number, q.title, q.criteria.map((c) => c.id)]),
    [
      [1, 'CSV export', ['1.1', '1.2']],
      [2, 'Escaping', ['2.1']],
    ],
  );
  assert.match(r.requirements[0]!.userStory!, /^As a user, I want to export/);
  assert.deepEqual(r.criteriaIds, ['1.1', '1.2', '2.1']);
  assert.equal(r.requirements[1]!.criteria[0]!.text, 'THE Exporter SHALL quote fields that contain commas, quotes or newlines');
});

test('parseRequirements: 2025 format, wrapped criteria, positions as ids, fences ignored', () => {
  const text = [
    '# Requirements Document',
    '## Requirements',
    '### Requirement 1',
    '**User Story:** As a dev, I want X, so that Y',
    '#### Acceptance Criteria',
    '1. WHEN [event] THEN [system] SHALL [response]',
    '   continued on the next line',
    '1. IF [precondition] THEN [system] SHALL [response]',
    '',
    '```',
    '3. not a criterion',
    '```',
    '### Requirement 2: Second',
    '#### Acceptance Criteria',
    '5. WHEN a AND b THEN the system SHALL c',
  ].join('\n');
  const r = parseRequirements(text);
  assert.deepEqual(r.criteriaIds, ['1.1', '1.2', '2.1']);
  assert.equal(r.requirements[0]!.title, undefined);
  assert.equal(r.requirements[0]!.criteria[0]!.text, 'WHEN [event] THEN [system] SHALL [response] continued on the next line');
});

test('parseBugfix: ids per section, multi-line items', () => {
  const b = parseBugfix(BUGFIX_MD);
  assert.deepEqual(ids(b.current), ['1.1', '1.2']);
  assert.deepEqual(ids(b.expected), ['2.1']);
  assert.deepEqual(ids(b.unchanged), ['3.1']);
  assert.deepEqual(b.criteriaIds, ['1.1', '1.2', '2.1', '3.1']);
  const wrapped = parseBugfix('### Current Behavior (Defect)\n\n1.1 WHEN x THEN the system\noverwrites y\n\n## Other\n9.9 ignored\n');
  assert.equal(wrapped.current[0]!.text, 'WHEN x THEN the system overwrites y');
  assert.deepEqual(wrapped.criteriaIds, ['1.1']);
});

test('parseDesign: sections and properties', () => {
  const d = parseDesign(DESIGN_MD);
  assert.equal(d.title, 'Todo Export');
  assert.deepEqual(d.sections, ['Overview', 'Architecture', 'Components and Interfaces', 'Data Models', 'Correctness Properties', 'Error Handling', 'Testing Strategy']);
  assert.deepEqual(
    d.properties.map((p) => [p.number, p.name, p.validates]),
    [
      [1, 'Row count', ['1.1', '1.2']],
      [2, 'Round trip', ['2.1']],
    ],
  );
});

test('lintSpec: coverage, unknown refs, properties without tasks (03 §1.6.5)', () => {
  const tasks = parseTasks(TASKS_MD);
  assert.deepEqual(lintSpec({ criteriaIds: ['1.1', '1.2', '2.1'], tasks, design: parseDesign(DESIGN_MD) }), []);
  const issues = lintSpec({
    criteriaIds: ['1.1', '1.2', '2.1', '2.2'],
    tasks: parseTasks('- [ ] 1. a\n  - _Requirements: 1.1, 9.9_\n- [ ] 2. b\n  - _Requirements: 2_\n'),
    design: parseDesign(DESIGN_MD),
  });
  assert.deepEqual(
    issues.map((i) => [i.code, i.ids]),
    [
      ['uncovered-criterion', ['1.2']],
      ['unknown-ref', ['1 → 9.9']],
      ['property-without-task', ['1', '2']],
    ],
  );
  assert.equal(issues[0]!.message, 'Acceptance criteria not covered by any task: 1.2');
  assert.deepEqual(lintSpec({ criteriaIds: ['1.1'] }), []);
});

test('formatTaskLine', () => {
  const t = parseTasks(TASKS_MD);
  assert.equal(formatTaskLine(t.byId.get('1')!, t.byId), '[ ] 1. Implement the exporter');
  assert.equal(formatTaskLine(t.byId.get('1.2')!, t.byId), '  [ ]* 1.2 Write property test for row count');
});

// ───────────────────────────── the real Kiro example (KR:) ─────────────────────────────

const ex = exampleSpecDir();

test('real example spec: tasks.md parses as observed (03 §1.5.5)', { skip: !ex && 'example spec not available' }, () => {
  const text = fs.readFileSync(path.join(ex!, 'tasks.md'), 'utf8');
  const t = parseTasks(text);
  assert.equal(t.title, 'GitHub Issue Automation');
  assert.equal(t.tasks.length, 62);
  assert.equal(t.tasks.filter((x) => x.synthesized).length, 0);
  assert.deepEqual(
    t.tasks.filter((x) => x.isCheckpoint).map((x) => x.id),
    ['5', '8', '14'],
  );
  // legacy-style parents: [ ] while required children are [x] and optional ones open
  const two = t.byId.get('2')!;
  assert.equal(two.box, ' ');
  assert.deepEqual(two.children, ['2.1', '2.2']);
  assert.equal(t.byId.get('2.2')!.optional, true);
  assert.deepEqual(t.byId.get('3.4')!.propertyRefs, [1]);
  assert.deepEqual(t.byId.get('3.4')!.validates, ['1.1', '5.5']);
  assert.deepEqual(t.byId.get('1')!.requirementRefs, ['5.1', '5.2']);
  assert.deepEqual(taskProgress(t), { total: 52, done: 26, requiredTotal: 29, requiredDone: 26 });
  assert.equal(t.graph.source, 'derived');
  // remaining required work is exactly the three checkpoints, in order
  const plan = planRun(t, { kind: 'scope', includeOptional: false });
  assert.deepEqual(
    plan.steps.map((s) => s.kind),
    ['checkpoint', 'checkpoint', 'checkpoint'],
  );
  // normalizer leaves Kiro's own output alone; every write-back preserves the rest byte-for-byte
  assert.equal(normalizeTasksText(text).changedLines, 0);
  const r = applyBoxChange(text, '2.2', 'x');
  assert.deepEqual(r.changes, [
    { id: '2.2', from: ' ', to: 'x' },
    { id: '2', from: ' ', to: 'x' },
  ]);
  assert.equal(r.text, text.replace('  - [ ]* 2.2 Write unit tests', '  - [x]* 2.2 Write unit tests').replace('- [ ] 2. Implement core data models', '- [x] 2. Implement core data models'));
});

test('real example spec: requirements/design parse and lint cleanly', { skip: !ex && 'example spec not available' }, () => {
  const r = parseRequirements(fs.readFileSync(path.join(ex!, 'requirements.md'), 'utf8'));
  assert.equal(r.requirements.length, 8);
  assert.equal(r.criteriaIds.length, 41);
  assert.equal(r.glossary.length, 7);
  assert.equal(r.requirements[0]!.title, 'Automatic Label Assignment');
  const d = parseDesign(fs.readFileSync(path.join(ex!, 'design.md'), 'utf8'));
  assert.equal(d.title, 'GitHub Issue Automation');
  assert.equal(d.properties.length, 22);
  assert.deepEqual(d.properties[0], { number: 1, name: 'Bedrock API Invocation', validates: ['1.1', '5.5'], line: d.properties[0]!.line });
  const t = parseTasks(fs.readFileSync(path.join(ex!, 'tasks.md'), 'utf8'));
  assert.deepEqual(lintSpec({ criteriaIds: r.criteriaIds, tasks: t, design: d }), []);
});
