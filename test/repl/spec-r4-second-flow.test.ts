/**
 * r4-findings #8, end to end: the real runRepl over the fake claude (transcripts persisted). A
 * second `/spec` flow started from the continuation a first flow handed over must fork with THAT
 * continuation as the parent record (its `/tangent merge` carry, its `/context add` rules), not
 * with the first flow's phase session, while still starting where the continuation starts (it
 * has no transcript of its own yet). The same steps with the carry / rule made in main (the G1
 * path) are the controls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { liveRepl, type LiveRepl } from '../spec/liveRepl.js';

const SCRIPT = {
  turns: [
    { repeat: true, match: '^Summarize the findings', steps: [{ text: 'SUMMARY_OF_TANGENT_ZEBRA' }] },
    { repeat: true, match: 'kiro-spec-mode', steps: [{ text: 'phase answer' }] },
    { repeat: true, steps: [{ text: 'HIST<<{{historyUserTexts}}>>' }] },
  ],
};

async function flowThenStop(r: LiveRepl, name: string, desc: string): Promise<void> {
  await r.send(`/spec new ${name} --type feature --workflow requirements-first ${desc}`, /Stop here \(resume later with \/spec [^)]+\)[\s\S]*> $/, 30_000);
  await r.send('Stop', /Stopped[\s\S]*> $/, 30_000);
}

async function scenario(where: 'main' | 'continuation', what: 'carry' | 'rule'): Promise<{ history?: string; delivered?: number; rules?: string }> {
  const r = liveRepl(SCRIPT, { before: (t) => fs.writeFileSync(path.join(t.wsDir, 'notes.md'), 'NOTES-RULE-BODY\n') });
  try {
    await r.waitFor(/> $/);
    await r.send('first chat line', /HIST<<first chat line>>[\s\S]*> $/);
    if (where === 'continuation') await flowThenStop(r, 'spec-one', 'a csv export');
    if (what === 'carry') {
      await r.send('/tangent side', /> $/);
      await r.send('tangent question', /tangent question>>[\s\S]*> $/);
      assert.match(await r.send('/tangent merge', /> $/), /Merged/);
    } else {
      assert.match(await r.send('/context add notes.md', /> $/), /Added 1 path/);
    }
    const before = r.userLines().length;
    await flowThenStop(r, 'spec-two', 'a tsv export');
    if (what === 'carry') {
      const h = await r.send('what did the tangent find?', /HIST<<[\s\S]*?>>[\s\S]*> $/);
      return {
        history: /HIST<<([\s\S]*?)>>/.exec(h)![1]!,
        delivered: r.userLines().slice(before).filter((u) => u.includes('SUMMARY_OF_TANGENT_ZEBRA')).length,
      };
    }
    const s = await r.send('/context show', /> $/);
    return { rules: /Session \(temporary\):\n([\s\S]*?)\n\n/.exec(s)?.[1] ?? s };
  } finally {
    await r.close();
  }
}

for (const where of ['main', 'continuation'] as const) {
  const label = where === 'main' ? 'control: made in main' : 'made in the continuation of a first /spec flow';
  test(`spec-r4 #8: a /tangent merge carry ${label} reaches the chat through a (second) /spec flow`, { timeout: 120_000 }, async () => {
    const o = await scenario(where, 'carry');
    // the conversation the fake saw, one entry per user line (the spec ones start with the spec-mode block)
    const seen = JSON.stringify(o.history!.split(' | ').map((u) => (/<kiro-spec-mode>/.test(u) ? `<spec: ${/on the spec "([^"]+)"/.exec(u)?.[1]}>` : u.slice(0, 80))));
    assert.ok((o.delivered ?? 0) >= 1, `the merged summary was sent ${o.delivered}x after the merge; the chat's conversation: ${seen}`);
    assert.match(o.history!, /SUMMARY_OF_TANGENT_ZEBRA/, `the chat's conversation lacks the merged summary: ${seen}`);
  });
  test(`spec-r4 #8: a /context add rule ${label} survives a (second) /spec flow`, { timeout: 120_000 }, async () => {
    const o = await scenario(where, 'rule');
    assert.match(o.rules!, /notes\.md/, `the session rule is gone after the flow: ${JSON.stringify(o)}`);
  });
}
