/**
 * r5 #8 (session group), end to end (the real runRepl over the fake claude, which answers like
 * claude 2.1.319): `/compact` of a chat with no messages prints Claude's reason once and no
 * success line; after a message `/compact` reports its compaction as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { liveRepl } from '../spec/liveRepl.js';

const SCRIPT = { turns: [{ repeat: true, steps: [{ text: 'ANSWER' }] }] };

test('/compact of a new chat: "No messages to compact" once, no success line; the chat goes on', { timeout: 60_000 }, async () => {
  const r = liveRepl(SCRIPT);
  try {
    await r.waitFor(/> $/);
    const out = await r.send('/compact', /No messages to compact[\s\S]*> $/);
    assert.doesNotMatch(out, /compacted successfully/, out);
    assert.equal(out.split('No messages to compact').length - 1, 1, `printed more than once:\n${out}`);
    await r.send('hello', /ANSWER[\s\S]*> $/);
    const ok = await r.send('/compact', /compacted successfully[\s\S]*> $/);
    assert.doesNotMatch(ok, /No messages to compact/, ok);
  } finally {
    await r.close();
  }
});
