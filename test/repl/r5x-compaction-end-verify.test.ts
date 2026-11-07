/**
 * r5x X2 verifier (group compaction-end), the REPL over the real runRepl and the fake: a
 * compaction Claude reports `started` and never ends was closed only at the turn's end, so
 * "Compaction failed: …" was printed under the answer Claude gave once it went on. Its end now
 * comes before that answer (the session ends such a compaction at Claude's first main-thread
 * output; Claude streams nothing while it compacts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setColorEnabled } from '../../src/util/ansi.js';
import { liveRepl } from '../spec/liveRepl.js';

setColorEnabled(false);

const SCRIPT = {
  turns: [{ repeat: true, match: '^dangling', steps: [{ frame: { type: 'system', subtype: 'status', status: 'compacting' } }, { text: 'ANSWER dangling' }] }],
  default: { steps: [{ text: 'ANSWER' }] },
};

test('chat: a compaction Claude never ends: "Compaction failed: …" closes the start before the answer, once', { timeout: 60_000 }, async () => {
  const r = liveRepl(SCRIPT);
  try {
    await r.waitFor(/> $/);
    const out = await r.send('dangling please', /ANSWER dangling[\s\S]*> $/);
    const iStart = out.indexOf('Summarizing the conversation history...');
    const iEnd = out.indexOf('Compaction failed: Claude Code did not finish the compaction');
    const iAnswer = out.indexOf('ANSWER dangling');
    assert.ok(iStart >= 0 && iEnd > iStart, `the start was never closed:\n${out}`);
    assert.ok(iAnswer > iEnd, `the compaction's end was printed under the answer:\n${out}`);
    assert.equal(out.split('Compaction failed').length - 1, 1, out);
    assert.doesNotMatch(out, /trouble responding/, out);
  } finally {
    await r.close();
  }
});
