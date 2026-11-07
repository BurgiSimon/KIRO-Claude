/**
 * Round 5, group spec-policy, verifier: holes left by the T1/T3 fixes, end to end (the real runRepl
 * and session/kiroSession over test/fixtures/fake-claude.mjs, everything in a temp root,
 * test/spec/liveRepl.ts).
 *
 *  - A `/spec run` task session is the chat's while its task runs: a restriction the user adds
 *    there (Shift+Tab into plan mode, `/tools untrust` typed at its approval prompt) must hold for
 *    the later tasks of the run and for the chat the run hands back. Before, every task session
 *    started from the chat's trust and plan mode again, so the next task ran with edits allowed /
 *    the untrusted tool trusted, and so did the chat afterwards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TempEnv } from './harness.js';
import { liveRepl, seedTodoExport, type LiveRepl } from '../spec/liveRepl.js';

const ASK = /\[y\/n\/t\]:/;
const SHIFT_TAB = '\u001b[Z';
const promptOf = (out: string): string | undefined => /(?:^|[\r\n])([^\r\n]*> )$/.exec(out)?.[1];
const RUN_DONE = /Spec run finished[\s\S]*> $/;

const bash = (file: string, tag: string, extra = ''): unknown[] => [
  { tool: { name: 'Bash', input: { command: `touch ${file}`, description: 'Create a file' } } },
  { text: `${tag} {{lastToolResult}} END${extra}` },
];

/**
 * Type `line`, then answer the approval prompts in order with `answers` (an entry may be a list of
 * lines: commands typed at the prompt before the answer). Returns the output up to `done` and how
 * many approval prompts were shown.
 */
async function drive(r: LiveRepl, line: string, done: RegExp, answers: (string | string[])[]): Promise<{ out: string; asked: number }> {
  const from = r.o().length;
  r.line(line);
  let asked = 0;
  const queue = [...answers];
  for (;;) {
    const out = await r.waitFor(new RegExp(`(${ASK.source})|(${done.source})`), 30_000, from);
    const n = (out.match(new RegExp(ASK.source, 'g')) ?? []).length;
    if (n > asked) {
      asked = n;
      const a = queue.shift() ?? 'n';
      for (const l of Array.isArray(a) ? a : [a]) r.line(l);
      continue;
    }
    if (done.test(out)) return { out, asked };
    await new Promise((res) => setTimeout(res, 25));
  }
}

test('r5 verify e2e: Shift+Tab into plan mode during a /spec run task stops the run there; the chat comes back in plan mode', { timeout: 120_000 }, async () => {
  const r = liveRepl(
    {
      turns: [
        { repeat: true, match: 'Execute Task: 1\\.1', steps: bash('task-1.txt', 'T1-SAID', '\nTASK_RESULT: completed') },
        { repeat: true, match: 'Execute Task: 2\\.1', steps: bash('task-2.txt', 'T2-SAID', '\nTASK_RESULT: completed') },
        { repeat: true, match: 'run it', steps: bash('after.txt', 'TOOL-SAID') },
        { repeat: true, steps: [{ text: 'ANSWER' }] },
      ],
    },
    { tty: true, before: (t) => void seedTodoExport(t.wsDir) },
  );
  try {
    await r.waitFor(/> $/);
    const from = r.o().length;
    r.line('/spec run todo-export 1.1 2.1');
    await r.waitFor(ASK, 30_000, from);
    // the task session is the chat's now: Shift+Tab turns plan mode on (the prompt says so)
    const mark = r.o().length;
    r.raw(SHIFT_TAB);
    await r.waitFor(/\[plan\] > $/, 10_000, mark);
    r.line('n');
    // any later approval prompt (task 2.1's, before the fix) is answered n
    let asked = 1;
    let out = '';
    for (;;) {
      out = await r.waitFor(new RegExp(`(${ASK.source})|(${RUN_DONE.source})`), 30_000, from);
      const n = (out.match(new RegExp(ASK.source, 'g')) ?? []).length;
      if (n > asked) {
        asked = n;
        r.line('n');
        continue;
      }
      if (RUN_DONE.test(out)) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    const tasks = r.userLines().filter((l) => /Execute Task: /.test(l));
    assert.equal(tasks.filter((l) => /Execute Task: 2\.1/.test(l)).length, 0, `task 2.1 ran after the user turned plan mode on:\n${out}`);
    assert.match(out, /Plan mode is read-only: running spec tasks implements code/, out);
    assert.ok(!fs.existsSync(path.join(r.t.wsDir, 'task-2.txt')));
    assert.equal(promptOf(out), '[plan] > ', `the chat came back out of the plan mode the user turned on:\n${out}`);
    // and the chat's next turn is in plan mode: its Bash is denied, not asked
    const after = await drive(r, 'run it (after)', /TOOL-SAID [\s\S]*? END[\s\S]*> $/, []);
    assert.equal(after.asked, 0, after.out);
    assert.match(after.out, /TOOL-SAID [\s\S]*Plan mode is read-only/, after.out);
  } finally {
    await r.close();
  }
});

test('r5 verify e2e: `/tools untrust` typed at a /spec run task\'s approval prompt holds for the next task and for the chat afterwards', { timeout: 120_000 }, async () => {
  const r = liveRepl(
    (t: TempEnv) => ({
      turns: [
        {
          repeat: true,
          match: 'Execute Task: 1\\.1',
          steps: [
            { tool: { name: 'Write', input: { file_path: path.join(t.wsDir, 'src', 'export.ts'), content: 'export {};\n' } } },
            { text: 'T1-SAID {{lastToolResult}} END\nTASK_RESULT: completed' },
          ],
        },
        { repeat: true, match: 'Execute Task: 2\\.1', steps: bash('task-2.txt', 'T2-SAID', '\nTASK_RESULT: completed') },
        { repeat: true, match: 'run it', steps: bash('after.txt', 'TOOL-SAID') },
        { repeat: true, steps: [{ text: 'ANSWER' }] },
      ],
    }),
    { sessionOptions: { trustTools: ['shell'] }, before: (t) => void seedTodoExport(t.wsDir) },
  );
  try {
    await r.waitFor(/> $/);
    // task 1.1 asks for its write; the user types `/tools untrust shell` there (the question is
    // asked again), then answers n. Task 2.1's shell call must then ask, and so must the chat's
    const run = await drive(r, '/spec run todo-export 1.1 2.1', RUN_DONE, ['/tools untrust shell', 'n', 'n']);
    assert.match(run.out, /Task 2\.1/, run.out);
    assert.equal(run.asked, 3, `task 2.1's shell call ran without asking after \`/tools untrust shell\` in task 1.1 (asked ${run.asked}):\n${run.out}`);
    assert.doesNotMatch(run.out, /Using tool: shell \(trusted\)/, run.out);
    const after = await drive(r, 'run it (after)', /TOOL-SAID [\s\S]*? END[\s\S]*> $/, ['n']);
    assert.equal(after.asked, 1, `the chat's shell call ran without asking after \`/tools untrust shell\` in a task:\n${after.out}`);
  } finally {
    await r.close();
  }
});
