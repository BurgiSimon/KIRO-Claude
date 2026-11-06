import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANALYZE_JSON_SCHEMA,
  CORRECTNESS_INTRO,
  analyzePrompt,
  applyFindingsPrompt,
  approveLabel,
  bugfixAnalysisPrompt,
  bugfixDesignPrompt,
  bugfixTasksPrompt,
  checkpointQuestion,
  designPrompt,
  parseAnalysis,
  parseTaskResult,
  phasePrompt,
  phaseWritableDocs,
  quickQuestionsPrompt,
  requirementsPrompt,
  revisionPrompt,
  specModeBlock,
  syncPrompt,
  taskExecutionPrompt,
  tasksPrompt,
} from '../../src/spec/prompts.js';

const D = '/ws/.kiro/specs/todo-export';
const V = { name: 'todo-export', dir: D, ws: '/ws' };

function has(text: string, needles: string[]): void {
  for (const n of needles) assert.ok(text.includes(n), `missing ${JSON.stringify(n)} in:\n${text}`);
}

test('spec-mode base block (03 §1.10.1)', () => {
  const b = specModeBlock({ ...V, type: 'feature' });
  assert.ok(b.startsWith('<kiro-spec-mode>\nYou are working in Kiro spec mode on the spec "todo-export" (feature).'));
  assert.ok(b.endsWith('</kiro-spec-mode>'));
  has(b, [
    `Spec folder: ${D}   Workspace: /ws`,
    'Write spec documents ONLY at the exact paths given in each phase instruction',
    'Work on exactly ONE phase per turn',
    'Never implement product code while drafting requirements, design, or tasks.',
    '.kiro/steering/**/*.md and AGENTS.md',
    'Do not advance phases yourself.',
    'ask at most 3, each with your recommended answer',
    'no placeholders, no TODOs',
  ]);
});

test('requirements phase: EARS rules, exact path, structure (03 §1.10.2)', () => {
  const p = requirementsPrompt({ dir: D, desc: 'Export todos as CSV' });
  assert.ok(p.startsWith(`Phase: REQUIREMENTS. Create or update ${D}/requirements.md.`));
  has(p, [
    '# Requirements Document',
    '## Introduction',
    '## Glossary',
    '### Requirement <N>: <Title>',
    '**User Story:** As a <role>, I want <capability>, so that <benefit>',
    '#### Acceptance Criteria',
    'THE <System> SHALL <response>',
    'WHEN <trigger>, THE <System> SHALL <response>',
    'WHILE <state>, THE <System> SHALL <response>',
    'IF <unwanted condition>, THEN THE <System> SHALL <response>',
    'WHERE <optional feature applies>, THE <System> SHALL <response>',
    'atomic (one SHALL)',
    'criteria are referenced later as <requirement>.<criterion> (e.g. 2.3)',
    'without asking a series of\nquestions first',
    'User description (ground truth): Export todos as CSV',
  ]);
  assert.ok(!p.includes('conversation so far'));
  has(requirementsPrompt({ dir: D, desc: 'x', useConversation: true, clarifications: '1=a' }), ['Use the conversation so far as input.', 'Clarifications from the user:\n1=a']);
  const df = requirementsPrompt({ dir: D, desc: 'x', designFirst: true });
  has(df, ['Derive requirements that are feasible under the approved design', 'append ## Correctness Properties to design.md', CORRECTNESS_INTRO]);
});

test('design phase: sections, correctness properties, PBT config (03 §1.10.3)', () => {
  const p = designPrompt(V);
  assert.ok(p.startsWith(`Phase: DESIGN. Requirements in ${D}/requirements.md are approved. Create or update ${D}/design.md.`));
  has(p, [
    '# Design Document: <Title>',
    '## Overview',
    '## Architecture',
    'mermaid',
    '## Components and Interfaces',
    '## Data Models',
    '## Correctness Properties',
    CORRECTNESS_INTRO,
    '### Property <K>: <Name>',
    '*For any* …',
    '**Validates: Requirements x.y, …**',
    '## Error Handling',
    '## Testing Strategy',
    'at least 100 iterations each',
    '"Feature: todo-export, Property <K>: <text>"',
    'must address every acceptance criterion',
    'suggest a requirements change',
  ]);
  const hl = designPrompt({ ...V, designFirst: { detail: 'high', desc: 'Build it' } });
  assert.ok(hl.startsWith('Detail level: HIGH-LEVEL'));
  assert.ok(!hl.includes('## Correctness Properties  ('));
  has(hl, ['Do not write "## Correctness Properties" yet', `Create or update ${D}/design.md`, 'User description (ground truth): Build it']);
  assert.ok(designPrompt({ ...V, designFirst: { detail: 'low', desc: 'x' } }).startsWith('Detail level: LOW-LEVEL (algorithm pseudocode'));
});

test('tasks phase: format and rules (03 §1.10.4)', () => {
  const p = tasksPrompt({ dir: D });
  assert.ok(p.startsWith(`Phase: TASKS. Requirements and design are approved. Create or update ${D}/tasks.md.`));
  has(p, [
    '# Implementation Plan: <Title>',
    '- [ ] 1. <Top-level task>',
    '  - [ ] 1.1 <Sub-task',
    '    - _Requirements: 1.1, 2.3_',
    '  - [ ]* 1.2 Write property test for <thing>',
    '- [ ] 2. Checkpoint - <milestone>',
    'Ensure all tests pass, ask the user if questions arise.',
    '## Notes',
    '## Task Dependency Graph',
    '```json\n{"waves":[{"id":0,"tasks":["1.1"]},{"id":1,"tasks":["1.2","2.1"]}]}\n```',
    'at most two levels',
    'every criterion is covered by some task',
    'optional with "*" right after "]"',
    'one property-test\nsub-task per design property',
    'NO manual testing, deployment, metrics gathering',
    'checkpoints excluded',
  ]);
});

test('bugfix phases (03 §1.10.5)', () => {
  const a = bugfixAnalysisPrompt({ dir: D, desc: 'double save loses edits' });
  assert.ok(a.startsWith(`Phase: BUG ANALYSIS. Create or update ${D}/bugfix.md using exactly:`));
  has(a, [
    '# Bugfix Requirements Document',
    '### Current Behavior (Defect)        1.1 WHEN <condition> THEN the system <incorrect behavior>',
    '### Expected Behavior (Correct)      2.1 WHEN <condition> THEN the system SHALL <correct behavior>',
    'THEN the system SHALL CONTINUE TO <behavior>',
    'isBugCondition(X)',
    'do not fix anything yet',
    'User report: double save loses edits',
  ]);
  has(bugfixDesignPrompt({ dir: D }), [`then write ${D}/design.md with:`, 'Hypothesized Root\nCause', 'Property 1: Bug Condition', 'Property 2: Preservation', 'minimal and\nsurgical']);
  has(bugfixTasksPrompt({ dir: D }), [`Write ${D}/tasks.md in this order`, 'MUST FAIL\non unfixed code', 'MUST PASS on unfixed code', '`_Bug_Condition:_`', 'These tasks are required (no `*`).']);
});

test('quick spec questions (03 §1.10.7)', () => {
  const q = quickQuestionsPrompt({ desc: 'CSV export' });
  has(q, ['up to 6 clarifying questions', '[1]: <question>', 'a. <option> (recommended)', '(Answer with "1=a, 2=b" or provide your own answers)', 'Do not write\nany file', 'Request: CSV export']);
});

test('phasePrompt dispatch + phaseWritableDocs', () => {
  const base = { ...V, desc: 'd', specType: 'feature' as const, workflowType: 'requirements-first' as const };
  assert.ok(phasePrompt('requirements', base).startsWith('Phase: REQUIREMENTS.'));
  assert.ok(phasePrompt('design', base).startsWith('Phase: DESIGN. Requirements'));
  assert.ok(phasePrompt('tasks', base).startsWith('Phase: TASKS.'));
  const df = { ...base, workflowType: 'design-first' as const, detail: 'low' as const };
  assert.ok(phasePrompt('design', df).startsWith('Detail level: LOW-LEVEL'));
  assert.match(phasePrompt('requirements', df), /Derive requirements that are feasible/);
  const bug = { ...base, specType: 'bugfix' as const };
  assert.ok(phasePrompt('bugfix', bug).startsWith('Phase: BUG ANALYSIS.'));
  assert.ok(phasePrompt('design', bug).startsWith('Phase: DESIGN (bugfix).'));
  assert.ok(phasePrompt('tasks', bug).startsWith('Phase: TASKS (bugfix).'));
  assert.match(phasePrompt('requirements', { ...base, desc: '' }), /no new description; continue the spec "todo-export"/);
  assert.deepEqual(phaseWritableDocs('requirements', base), ['requirements']);
  assert.deepEqual(phaseWritableDocs('requirements', df), ['requirements', 'design']);
  assert.deepEqual(phaseWritableDocs('design', df), ['design']);
});

test('checkpoint questions and labels (03 §1.4.2 / §1.11.4)', () => {
  assert.equal(checkpointQuestion('requirements', 'design'), 'Do the requirements look good? If so, we can move on to the design.');
  assert.equal(checkpointQuestion('design', 'tasks'), 'Does the design look good? If so, we can move on to the implementation plan.');
  assert.equal(checkpointQuestion('tasks', undefined), 'Do the tasks look good?');
  assert.equal(checkpointQuestion('bugfix', 'design'), 'Does the bug analysis look good? If so, we can move on to the design.');
  assert.equal(checkpointQuestion('design', 'requirements'), 'Does the design look good? If so, we can move on to the requirements.');
  assert.equal(approveLabel('requirements', 'design'), 'Approve and continue to design');
  assert.equal(approveLabel('design', 'tasks'), 'Approve and continue to tasks');
  assert.equal(approveLabel('tasks', undefined), 'Approve tasks');
});

test('revisionPrompt (03 §1.11.4)', () => {
  assert.equal(
    revisionPrompt({ file: 'requirements.md', feedback: 'Also cover TSV.', comments: [{ line: 12, lineText: '1. WHEN x', comment: 'too vague' }] }),
    'Revise requirements.md per these review comments:\n- line 12 ("1. WHEN x"): too vague\nAlso cover TSV.',
  );
  assert.equal(revisionPrompt({ file: '/d/design.md', feedback: '  add caching ' }), 'Revise /d/design.md per this feedback, in place, then stop again:\nadd caching');
});

test('task execution prompt (03 §1.10.8)', () => {
  const p = taskExecutionPrompt({ id: '2.1', title: 'Quote fields', name: 'todo-export', dir: D, requirementRefs: ['2.1', '1.1'], details: ['Use RFC 4180'] });
  assert.ok(p.startsWith('Execute Task: 2.1 Quote fields\n'));
  has(p, [
    `Spec: todo-export (${D}). The task is marked [-] in tasks.md because it is the task you are executing\nnow.`,
    'Implement ONLY this task. Do not start other tasks, even if they look small.',
    '_Requirements: 2.1, 1.1_',
    'Do NOT edit checkboxes in tasks.md; the tool manages them.',
    'Finish with a final line exactly "TASK_RESULT: completed" or "TASK_RESULT: blocked - <reason>"',
    'Task details:\n- Use RFC 4180',
  ]);
  assert.ok(!p.includes('CHECKPOINT'));
  const cp = taskExecutionPrompt({ id: '3', title: 'Checkpoint - ok', name: 'n', dir: D, requirementRefs: [], isCheckpoint: true, hookPrompts: ['Check style first.'] });
  assert.ok(cp.startsWith('Check style first.\n\nExecute Task: 3 Checkpoint - ok'));
  has(cp, ['This is a CHECKPOINT', 'Verify against the task details and the design.']);
  has(taskExecutionPrompt({ id: '1', title: 't', name: 'n', dir: D, requirementRefs: [], subTasks: ['[ ] 1.1 a'] }), ['Sub-tasks:\n- [ ] 1.1 a']);
});

test('parseTaskResult: table (03 §1.7.2: no false completion)', () => {
  const rows: [string, unknown][] = [
    ['Done.\nTASK_RESULT: completed', { status: 'completed' }],
    ['TASK_RESULT: completed\n', { status: 'completed' }],
    ['**TASK_RESULT: completed**', { status: 'completed' }],
    ['`TASK_RESULT: completed`', { status: 'completed' }],
    ['> TASK_RESULT: Completed', { status: 'completed' }],
    ['TASK_RESULT: blocked - tests fail on CI', { status: 'blocked', reason: 'tests fail on CI' }],
    ['TASK_RESULT: blocked — missing API key', { status: 'blocked', reason: 'missing API key' }],
    ['TASK_RESULT: blocked: no db', { status: 'blocked', reason: 'no db' }],
    ['TASK_RESULT: blocked', { status: 'blocked', reason: 'no reason given' }],
    ['TASK_RESULT: completed\nlater\nTASK_RESULT: blocked - second thoughts', { status: 'blocked', reason: 'second thoughts' }],
    ['I will finish with TASK_RESULT: completed', undefined],
    ['TASK_RESULT: done', undefined],
    ['all good', undefined],
    ['', undefined],
  ];
  for (const [text, want] of rows) assert.deepEqual(parseTaskResult(text), want, JSON.stringify(text));
});

test('analyze prompt + parser + apply prompt (03 §1.8, §1.10.6)', () => {
  const p = analyzePrompt({ dir: D });
  assert.ok(p.startsWith(`Analyze ${D}/requirements.md (read-only; do not edit files).`));
  has(p, ['inconsistency', 'ambiguity', 'conflict', 'assumption', 'edge_case', 'Output only the JSON object matching the schema.', '{"findings":[]}']);
  assert.deepEqual(ANALYZE_JSON_SCHEMA.required, ['findings']);
  assert.ok(analyzePrompt({ dir: D, file: 'bugfix.md' }).includes(`${D}/bugfix.md`));

  const json = {
    findings: [
      { id: 'F1', category: 'ambiguity', requirements: ['1.1'], explanation: 'fast?', question: 'How fast?', options: [{ label: '< 1s', edit: 'WITHIN 1 second' }, 'plain string'], severity: 'high' },
      { category: 'edge_case', options: [] },
      'junk',
    ],
  };
  const parsed = parseAnalysis(`Here you go:\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`\nThanks`);
  assert.ok('findings' in parsed);
  assert.equal(parsed.findings.length, 2);
  assert.deepEqual(parsed.findings[0]!.options, [
    { label: '< 1s', edit: 'WITHIN 1 second' },
    { label: 'plain string', edit: 'plain string' },
  ]);
  assert.deepEqual(parsed.findings[1], { id: 'F2', category: 'edge_case', requirements: [], explanation: '', question: '', options: [], severity: 'medium' });
  assert.deepEqual(parseAnalysis('prefix {"findings":[]} suffix'), { findings: [] });
  assert.match((parseAnalysis('no json') as { error: string }).error, /no JSON object/);
  assert.match((parseAnalysis('{"findings": [}') as { error: string }).error, /invalid JSON/);
  assert.match((parseAnalysis('{"other": 1}') as { error: string }).error, /no "findings" array/);

  const ap = applyFindingsPrompt({ dir: D, answers: [{ finding: parsed.findings[0]!, resolution: 'WITHIN 1 second' }] });
  assert.ok(ap.startsWith(`Update ${D}/requirements.md to resolve these findings.`));
  has(ap, ['- F1 (ambiguity; criteria 1.1): How fast?', '  Resolution: WITHIN 1 second', 'keep existing criterion numbering stable']);
});

test('sync prompt (03 §1.10.9)', () => {
  has(syncPrompt({ dir: D, ws: '/ws' }), [`Compare ${D}/tasks.md with the current code in /ws`, 'change its box to [x]', 'continue numbering', 'update the Task Dependency Graph', 'Do not modify other text.']);
});
