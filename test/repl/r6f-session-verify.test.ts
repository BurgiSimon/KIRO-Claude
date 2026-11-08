/**
 * r6 #4 at the chat (session group verifier): Ctrl+C while `/compact` compacts, with the frames
 * the real claude 2.1.319 answers that interrupt with (the fake's interrupted /compact: a failed
 * status whose compact_error is `API Error: Request was aborted.`, a synthetic `Compaction
 * canceled.`, a success result with `local_command`). The chat closes the start with
 * `Compaction cancelled.` once, prints no API error, no failure or success line, and the next
 * prompt still answers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { liveRepl } from '../spec/liveRepl.js';

const SCRIPT = { default: { steps: [{ text: 'ANSWER[{{userText}}]' }] } };
const count = (s: string, sub: string): number => s.split(sub).length - 1;

test('chat: Ctrl+C while /compact compacts prints "Compaction cancelled." once, no API error, and the chat goes on', { timeout: 60_000 }, async () => {
  const r = liveRepl(SCRIPT, {
    before: (t) => {
      t.env.FAKE_CLAUDE_COMPACT_MS = '5000';
    },
  });
  try {
    await r.waitFor(/> $/);
    await r.send('alpha', /ANSWER\[alpha\][\s\S]*> $/);
    await r.send('beta', /ANSWER\[beta\][\s\S]*> $/);
    const from = r.o().length;
    r.line('/compact');
    await r.waitFor(/Summarizing the conversation history\.\.\./, 20_000, from);
    r.ctrlC();
    const out = await r.waitFor(/Compaction cancelled\.[\s\S]*> $/, 20_000, from);
    assert.equal(count(out, 'Compaction cancelled.'), 1, out);
    assert.doesNotMatch(out, /Request was aborted|API Error/, out);
    assert.doesNotMatch(out, /Compaction failed/, out);
    assert.doesNotMatch(out, /Kiro is having trouble responding/, out);
    assert.doesNotMatch(out, /compacted successfully/, out);
    assert.doesNotMatch(out, /Compaction canceled\./, "Claude's synthetic frame is no answer");
    const next = await r.send('gamma', /ANSWER\[gamma\][\s\S]*> $/);
    assert.match(next, /ANSWER\[gamma\]/);
  } finally {
    await r.close();
  }
});
