import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseTasks } from '../../src/spec/model.js';
import { readSpecConfig } from '../../src/spec/store.js';
import { RUN_SCOPE_LABELS, SPEC_TYPE_LABELS, SPEC_USAGE, WORKFLOW_LABELS, specSlashCommands } from '../../src/spec/slash.js';
import { DESIGN_MD, MockHost, REQ_MD, TASKS_MD, fakeModel, makeWs, mockSettings, read, writeSpec, type Ws } from './helpers.js';

const spec = specSlashCommands[0]!;

function setup(settings?: Record<string, unknown>): { w: Ws; host: MockHost } {
  const w = makeWs();
  const host = new MockHost(w.ctx, fakeModel(), settings ? { settings: mockSettings(settings) } : {});
  return { w, host };
}

const run = (host: MockHost, line: string): Promise<void | 'quit'> => spec.run(line.split(' ').filter(Boolean), line, host);

test('/spec is registered with summary and usage', () => {
  assert.equal(specSlashCommands.length, 1);
  assert.equal(spec.name, 'spec');
  assert.match(spec.summary, /requirements → design → tasks/);
  assert.equal(spec.usage, SPEC_USAGE);
  for (const f of ['/spec new <feature-name>', '/spec run <feature-name>', '/spec view <feature-name>', '/spec analyze_requirements', '/spec approve', '/spec revise', '/spec status', '/spec list', '/spec sync']) {
    assert.ok(SPEC_USAGE.includes(f), f);
  }
  assert.deepEqual([...SPEC_TYPE_LABELS], ['Build a Feature', 'Fix a Bug', 'Quick Spec']);
  assert.deepEqual([...RUN_SCOPE_LABELS], ['All remaining required tasks', 'All remaining tasks (include optional *)', 'Select tasks…', 'Cancel']);
});

test('/spec help, list, status', async () => {
  const { w, host } = setup();
  try {
    await run(host, 'help');
    assert.equal(host.printed.pop(), SPEC_USAGE);
    await run(host, 'list');
    assert.equal(host.printed.pop(), 'No specs yet. Start one with /spec new <feature-name>');
    await run(host, '');
    assert.equal(host.printed.pop(), 'No specs yet. Start one with /spec new <feature-name>');
    writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    writeSpec(w, 'other', { requirements: REQ_MD });
    await run(host, 'list');
    assert.equal(host.printed.pop(), 'other        feature  requirements ✓  -\ntodo-export  feature  tasks ✓         0/5');
    await run(host, 'status');
    assert.match(host.printed.pop()!, /^other/);
    await run(host, 'status todo-export');
    assert.match(host.printed.pop()!, /^Spec: todo-export \(feature, requirements-first\)/);
    await run(host, 'status nope');
    assert.equal(host.printed.pop(), "Spec 'nope' not found.");
  } finally {
    w.cleanup();
  }
});

test('/spec new: name normalization + confirm, type and workflow pickers, description question, phases', async () => {
  const { w, host } = setup();
  try {
    host.confirmAnswers = [true];
    host.chooseAnswers = ['Build a Feature', 'Requirements-First', 'Approve and continue to design', 'Stop here'];
    host.askAnswers = ['Export todos as CSV'];
    await spec.run(['new', 'Todo', 'Export!'], 'new Todo Export!', host);
    // "Todo" is the name word; "Export!" becomes the description, so no description question
    assert.equal(fs.existsSync(path.join(w.specs, 'todo')), true);
    assert.deepEqual(host.chosen.slice(0, 2).map((c) => c.question), ['What kind of spec?', 'Which workflow?']);
    assert.deepEqual(host.chosen[0]!.options, [...SPEC_TYPE_LABELS]);
    assert.deepEqual(host.chosen[1]!.options, [...WORKFLOW_LABELS]);
    assert.match(host.sessions[1]!.prompts[0]!.text, /User description \(ground truth\): Export!$/);
    assert.ok(fs.existsSync(path.join(w.specs, 'todo', 'design.md')));
  } finally {
    w.cleanup();
  }
  const b = setup({ 'kiroClaude.spec.defaultWorkflow': 'design-first' });
  try {
    b.host.askAnswers = ['My Feature', 'Build the thing'];
    b.host.confirmAnswers = [true];
    b.host.chooseAnswers = ['Build a Feature', 'Low Level Design', 'Stop here'];
    await run(b.host, 'new');
    assert.deepEqual(b.host.asked, ['Feature name (kebab-case, e.g. user-authentication):', 'What should this spec cover? (used as the ground truth)']);
    assert.deepEqual(b.host.chosen.map((c) => c.question), ['What kind of spec?', 'Start with which level of design?', 'Does the design look good? If so, we can move on to the requirements.']);
    const cfg = readSpecConfig(path.join(b.w.specs, 'my-feature'))!;
    assert.equal(cfg.workflowType, 'design-first');
    assert.match(b.host.sessions[1]!.prompts[0]!.text, /^Detail level: LOW-LEVEL/);
  } finally {
    b.w.cleanup();
  }
});

test('/spec new: --type, refusals, cancellations', async () => {
  const { w, host } = setup();
  try {
    host.chooseAnswers = ['Approve tasks'];
    host.askAnswers = ['1=a'];
    await run(host, 'new quick-one --type quick CSV export');
    assert.equal(host.chosen.length, 1, 'quick spec: no type picker, one final checkpoint');
    assert.ok(fs.existsSync(path.join(w.specs, 'quick-one', 'tasks.md')));
    await run(host, 'new x --type nope');
    assert.equal(host.printed.pop(), "Unknown spec type 'nope'. Use feature, bugfix or quick.");
    await run(host, 'new quick-one');
    assert.equal(host.printed.pop(), "Spec 'quick-one' already exists. Resume it with /spec quick-one");
    host.confirmAnswers = [false];
    await run(host, 'new Not_Kebab');
    assert.equal(fs.existsSync(path.join(w.specs, 'not-kebab')), false);
    host.chooseAnswers = [undefined];
    await run(host, 'new cancelled');
    assert.equal(fs.existsSync(path.join(w.specs, 'cancelled')), false);
    host.chooseAnswers = ['Fix a Bug'];
    host.askAnswers = [''];
    await run(host, 'new nodesc');
    assert.equal(host.printed.pop(), 'A description is needed to draft the spec.');
    assert.equal(host.asked.pop(), 'Describe the bug (symptom, where it happens, expected behavior):');
    assert.equal(fs.existsSync(path.join(w.specs, 'nodesc')), false);
  } finally {
    w.cleanup();
  }
});

test('/spec view|open', async () => {
  const { w, host } = setup();
  try {
    const dir = writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD });
    await run(host, 'view todo-export design');
    assert.equal(host.printed.pop(), `[${path.join(dir, 'design.md')}]\n${DESIGN_MD.trimEnd()}`);
    await run(host, 'open todo-export');
    assert.ok(host.printed.pop()!.startsWith(`[${path.join(dir, 'design.md')}]`), 'defaults to the document under review');
    await run(host, 'view todo-export tasks');
    assert.equal(host.printed.pop(), 'tasks.md has not been written yet.');
    await run(host, 'view todo-export bogus');
    assert.match(host.printed.pop()!, /Unknown document 'bogus'/);
    await run(host, 'view');
    assert.match(host.printed.pop()!, /^Usage: \/spec view/);
    await run(host, 'view nope');
    assert.match(host.printed.pop()!, /not found/);
  } finally {
    w.cleanup();
  }
});

test('/spec run: scope picker, explicit ids, flags, errors', async () => {
  const { w, host } = setup();
  try {
    const dir = writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    const box = (id: string): string => parseTasks(read(path.join(dir, 'tasks.md'))).byId.get(id)!.box;
    await run(host, 'run todo-export 1.1');
    assert.equal(box('1.1'), 'x');
    host.chooseAnswers = ['Cancel'];
    await run(host, 'run todo-export');
    assert.deepEqual(host.chosen.pop()!.options, [...RUN_SCOPE_LABELS]);
    assert.equal(box('2.1'), ' ');
    host.chooseAnswers = ['Select tasks…'];
    host.askAnswers = ['2.2'];
    await run(host, 'run todo-export');
    assert.equal(box('2.2'), 'x');
    await run(host, 'run todo-export --next');
    assert.equal(box('2.1'), 'x');
    host.chooseAnswers = ['All remaining tasks (include optional *)'];
    await run(host, 'run todo-export');
    assert.ok(parseTasks(read(path.join(dir, 'tasks.md'))).tasks.every((t) => t.box === 'x'));
    await run(host, 'run todo-export --bogus');
    assert.match(host.printed.pop()!, /^Unknown option --bogus\nUsage: \/spec run/);
    // no name: picker only over specs with tasks; a single candidate is picked directly
    writeSpec(w, 'no-tasks', { requirements: REQ_MD });
    await run(host, 'run --all');
    assert.ok(host.text.includes('No remaining required tasks.'));
  } finally {
    w.cleanup();
  }
});

test('/spec analyze: picker over specs with requirements; message when none', async () => {
  const { w, host } = setup();
  try {
    await run(host, 'analyze_requirements');
    assert.equal(host.printed.pop(), 'No spec has requirements yet. Create one with /spec new <feature-name>');
    writeSpec(w, 'todo-export', { requirements: REQ_MD });
    await run(host, 'analyze');
    assert.ok(host.text.includes('No issues found in requirements.md.'));
  } finally {
    w.cleanup();
  }
});

test('/spec <name>, /spec picker, approve/revise use the remembered spec', async () => {
  const { w, host } = setup();
  try {
    writeSpec(w, 'todo-export', { requirements: REQ_MD });
    writeSpec(w, 'other', {});
    host.chooseAnswers = ['Stop here'];
    await run(host, 'todo-export');
    assert.equal(host.chosen.pop()!.question, 'Do the requirements look good? If so, we can move on to the design.');
    // approve without a name: the remembered spec
    host.chooseAnswers = ['Stop here'];
    await run(host, 'approve');
    assert.ok(fs.existsSync(path.join(w.specs, 'todo-export', 'design.md')));
    // revise with an explicit name and feedback
    host.chooseAnswers = ['Stop here'];
    await run(host, 'revise todo-export add caching please');
    assert.ok(read(path.join(w.specs, 'todo-export', 'design.md')).includes('<!-- revised -->'));
    // revise without feedback asks for it
    host.askAnswers = ['more detail'];
    host.chooseAnswers = ['Stop here'];
    await run(host, 'revise');
    assert.equal(host.asked.pop(), 'What should change?');
    // picker
    host.chooseAnswers = [1, 'Stop here']; // rows sorted: other, todo-export
    await run(host, '');
    assert.equal(host.chosen[host.chosen.length - 2]!.question, 'Select a spec');
    await run(host, 'nope');
    assert.match(host.printed.pop()!, /^Spec 'nope' not found\. Create it with \/spec new nope\n\n\/spec /);
    // sync
    writeSpec(w, 'with-tasks', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
    await run(host, 'sync with-tasks');
    assert.ok(host.text.includes('1.1: [ ] → [x]'));
  } finally {
    w.cleanup();
  }
});
