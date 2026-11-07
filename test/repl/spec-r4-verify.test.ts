/**
 * Adversarial checks of the r4 spec fixes (#0/#7 plan mode, #2/#3 Ctrl+C, #8 second flow), end to
 * end: the real runRepl over the fake claude, everything in a temp root (test/spec/liveRepl.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TempEnv } from './harness.js';
import { liveRepl } from '../spec/liveRepl.js';

const SHIFT_TAB = '\u001b[Z';

const script = (t: TempEnv): unknown => ({
  turns: [
    {
      repeat: true,
      match: 'Phase: REQUIREMENTS',
      steps: [
        { tool: { name: 'Write', input: { file_path: path.join(t.wsDir, '.kiro', 'specs', 'my-feature', 'requirements.md'), content: '# Requirements\n' } } },
        { text: 'PHASE-SAID {{lastToolResult}} END' },
      ],
    },
    {
      repeat: true,
      match: 'make the file',
      steps: [{ tool: { name: 'Bash', input: { command: 'touch made.txt', description: 'Create a file' } } }, { text: 'TOOL-SAID {{lastToolResult}} END' }],
    },
    { repeat: true, steps: [{ text: 'OK' }] },
  ],
});

const promptOf = (out: string): string | undefined => /(?:^|\n)([^\n]*> )$/.exec(out)?.[1];

test('spec-r4 verify #0/#7: plan mode turned on with Shift+Tab at a /spec checkpoint is not dropped by the hand-over (--trust-all-tools)', { timeout: 90_000 }, async () => {
  const r = liveRepl(script, { tty: true, sessionOptions: { trustAllTools: true } });
  try {
    await r.waitFor(/!> $/);
    const flow = await r.send('/spec new my-feature --type feature --workflow requirements-first a csv export', /Stop here \(resume later with \/spec my-feature\)[\s\S]*> $/);
    assert.match(flow, /PHASE-SAID [\s\S]*? END/, flow);
    // Shift+Tab while the checkpoint question is read: the REPL toggles plan mode and shows it
    const mark = r.o().length;
    r.raw(SHIFT_TAB);
    await r.waitFor(/\[plan\] !> $/, 10_000, mark);
    const stopped = await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
    assert.equal(promptOf(stopped), '[plan] !> ', `plan mode the user turned on at the checkpoint was dropped by the hand-over:\n${stopped.slice(-400)}`);
    const after = await r.send('make the file', /TOOL-SAID [\s\S]*? END[\s\S]*> $/);
    assert.match(after, /Plan mode is read-only/, `the mutating tool ran after the flow although the prompt showed [plan]:\n${after}`);
  } finally {
    await r.close();
  }
});

/** `--resume` / `--session-id` of every fake claude start so far. */
function starts(r: { t: TempEnv }): { resume?: string; sid?: string }[] {
  const file = path.join(r.t.root, 'fake.log');
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { event?: string; argv?: string[] })
    .filter((e) => e.event === 'start' && Array.isArray(e.argv))
    .map((e) => {
      const a = e.argv!;
      const v = (f: string): string | undefined => (a.indexOf(f) >= 0 ? a[a.indexOf(f) + 1] : undefined);
      const o: { resume?: string; sid?: string } = {};
      const resume = v('--resume');
      const sid = v('--session-id');
      if (resume) o.resume = resume;
      if (sid) o.sid = sid;
      return o;
    });
}

test('spec-r4 verify #8: /compact in the continuation of a first /spec flow is kept by a second flow (it forks the compacted session)', { timeout: 120_000 }, async () => {
  const r = liveRepl({
    turns: [
      { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'PHASE END' }] },
      { repeat: true, match: 'what do you know', steps: [{ text: 'HISTORY=[{{historyUserTexts}}] END' }] },
      { repeat: true, steps: [{ text: 'ANSWER END' }] },
    ],
  });
  try {
    await r.waitFor(/> $/);
    await r.send('first line ALPHA', /ANSWER END[\s\S]*> $/);
    await r.send('/spec new spec-one --type feature --workflow requirements-first a csv export', /Stop here \(resume later with \/spec spec-one\)[\s\S]*> $/);
    await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
    const cont = starts(r).at(-1)!;
    assert.ok(cont.sid && cont.resume, `precondition: the continuation is a fork ${JSON.stringify(cont)}`);
    const out = await r.send('/compact', /compacted successfully[\s\S]*> $/);
    assert.match(out, /compacted successfully/, out);
    const flow2 = await r.send('/spec new spec-two --type feature --workflow requirements-first a pdf export', /Stop here \(resume later with \/spec spec-two\)[\s\S]*> $/);
    const phase2 = starts(r).at(-1)!;
    assert.equal(phase2.resume, cont.sid, `the second flow forked ${phase2.resume} (the first flow's phase session) instead of the compacted continuation ${cont.sid}`);
    assert.doesNotMatch(flow2, /could not find the saved conversation/, flow2);
    await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
    // the chat still holds the whole conversation: the main line and both spec flows
    const h = /HISTORY=\[([\s\S]*?)\] END/.exec(await r.send('what do you know', /HISTORY=[\s\S]*? END[\s\S]*> $/))![1]!;
    assert.ok(h.startsWith('first line ALPHA | '), h.slice(0, 200));
    assert.ok(/spec "spec-one"/.test(h) && /spec "spec-two"/.test(h), `a spec flow is missing from the chat's conversation:\n${h.slice(0, 400)}`);
  } finally {
    await r.close();
  }
});
