/**
 * r4-findings #0/#7 (spec half), end to end: the real runRepl over the fake claude. Plan mode (the
 * gate denies mutating tools, the prompt shows `[plan]`) must survive the session replacement a
 * `/spec` flow does when it hands the chat its continuation (SpecSessionDriver.finish('keep')),
 * as it survives a tangent / rewind and the forced-stop restart. The phase sessions themselves run
 * without plan mode (their spec-phase write allowance must work).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TempEnv } from './harness.js';
import { liveRepl } from '../spec/liveRepl.js';

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
      steps: [{ tool: { name: 'Bash', input: { command: 'touch made-in-plan-mode.txt', description: 'Create a file' } } }, { text: 'TOOL-SAID {{lastToolResult}} END' }],
    },
    { repeat: true, steps: [{ text: 'OK' }] },
  ],
});

const promptOf = (out: string): string | undefined => /(?:^|\n)([^\n]*> )$/.exec(out)?.[1];

for (const trustAll of [false, true]) {
  test(`spec-r4 #0/#7: a /spec flow started in plan mode hands the chat back in plan mode${trustAll ? ' (--trust-all-tools: the mutating tool stays denied)' : ''}`, { timeout: 90_000 }, async () => {
    const r = liveRepl(script, trustAll ? { sessionOptions: { trustAllTools: true } } : {});
    try {
      const bang = trustAll ? '!' : '';
      await r.waitFor(/> $/);
      await r.send('/plan', new RegExp(`Entered plan mode[\\s\\S]*\\[plan\\] ${bang}> $`));
      const before = await r.send('make the file', /TOOL-SAID [\s\S]*? END[\s\S]*> $/);
      assert.match(before, /Plan mode is read-only/, `control: plan mode denies the tool before the flow\n${before}`);

      const flow = await r.send('/spec new my-feature --type feature --workflow requirements-first a csv export', /Stop here \(resume later with \/spec my-feature\)[\s\S]*> $/);
      // the phase session writes its document: plan mode does not apply to it
      assert.match(flow, /PHASE-SAID [\s\S]*? END/, flow);
      assert.doesNotMatch(/PHASE-SAID ([\s\S]*?) END/.exec(flow)![1]!, /Plan mode is read-only|denied/i, `the phase session ran in plan mode:\n${flow}`);
      const stopped = await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
      assert.equal(promptOf(stopped), `[plan] ${bang}> `, `the prompt left plan mode after the /spec flow (no notice):\n${stopped.slice(-400)}`);

      const after = await r.send('make the file', /(TOOL-SAID [\s\S]*? END[\s\S]*> $)|(Allow this action\?[\s\S]*\[y\/n\/t\]:)/);
      if (/Allow this action\?/.test(after)) {
        r.line('n');
        await r.waitFor(/TOOL-SAID [\s\S]*? END[\s\S]*> $/);
      }
      assert.ok(!/Allow this action\?/.test(after), `plan mode no longer denies the mutating tool (it went to approval):\n${after}`);
      assert.ok(!/Bash completed with no output/.test(after), `the mutating tool ran after the flow:\n${after}`);
      assert.match(after, /Plan mode is read-only/, after);

      const quit = await r.send('/quit', /--resume-id [0-9a-f-]{36}/);
      assert.equal(await r.exit, 0);
      // the record the chat ended on (the continuation /quit offers to resume) keeps plan mode
      const sid = /--resume-id ([0-9a-f-]{36})/.exec(quit)![1]!;
      const rec = JSON.parse(fs.readFileSync(path.join(r.t.home, '.kiro', 'sessions', 'cli', `${sid}.json`), 'utf8')) as { planMode?: boolean; origin?: string };
      assert.equal(rec.planMode, true, `the saved continuation record ${sid} lost plan mode`);
    } finally {
      await r.close();
    }
  });
}
