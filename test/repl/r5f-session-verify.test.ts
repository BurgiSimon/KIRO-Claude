/**
 * r5 #8, verifier (session group), end to end (the real runRepl over the fake claude, which
 * answers like claude 2.1.319): a `/compact` of a chat that holds only local commands (a
 * `/compact` refused before, an `/effort`) is refused by Claude with "Not enough messages to
 * compact." under a result that says success; the REPL prints that reason once and no success
 * line, and a later compaction is reported from its start again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { liveRepl } from '../spec/liveRepl.js';

const SCRIPT = { turns: [{ repeat: true, steps: [{ text: 'ANSWER' }] }] };

for (const first of ['/compact', '/effort high']) {
  test(`${first}, then /compact in a new chat: "Not enough messages to compact" once, no success line`, { timeout: 60_000 }, async () => {
    const r = liveRepl(SCRIPT);
    try {
      await r.waitFor(/> $/);
      await r.send(first, /> $/);
      const out = await r.send('/compact', /Not enough messages to compact[\s\S]*> $/);
      assert.doesNotMatch(out, /compacted successfully/, out);
      assert.equal(out.split('Not enough messages to compact').length - 1, 1, `printed more than once:\n${out}`);
      await r.send('hello', /ANSWER[\s\S]*> $/);
      const ok = await r.send('/compact', /compacted successfully[\s\S]*> $/);
      assert.match(ok, /Summarizing the conversation history/, `the compaction after the refused one printed no start:\n${ok}`);
    } finally {
      await r.close();
    }
  });
}
