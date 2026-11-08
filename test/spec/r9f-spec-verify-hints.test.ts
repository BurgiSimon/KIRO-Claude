/**
 * Round 9, finding #6, verification: `/spec revise` in chat and the new `--doc <doc>` option.
 *
 * The r9 #6 fix made `approve` / `revise` take the document under review explicitly (`--doc
 * <doc>`). In chat, `/spec revise` took `--doc` (and `--doc=`) out of the WHOLE line, but its
 * feedback is free text, which before went to the revision verbatim. So feedback that mentions
 * the option (a spec about a CLI: `explain the --doc flag`) was refused ("Unknown document
 * 'flag'"), and feedback that happens to name a document after it (`mention --doc requirements in
 * the overview`) silently revised that other document, with the words cut out of the feedback:
 * the wrong-document revision #6 is about.
 *
 * Now `--doc` is an option of `/spec revise` only before the feedback, as its usage shows
 * (`/spec revise [feature-name] [--doc <doc>] <feedback>`, and every hint names it so): before or
 * after the name; from the first word of the feedback on, everything is feedback. `/spec approve`
 * has no free text and still takes it anywhere. The spec CLI keeps its parser's rule (flags
 * anywhere, `--` ends them; a shell argument holds quoted feedback whole).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { specSlashCommands } from '../../src/spec/slash.js';
import { DESIGN_MD, MockHost, REQ_MD, fakeModel, makeWs, writeSpec, type Ws } from './helpers.js';
import { removeOnExit } from '../tmpdirs.js';

function ws(): Ws {
  const w = makeWs('kc-r9f-spec-verify-');
  removeOnExit(w.root);
  return w;
}

/** `line` typed in chat over a fresh requirements-first spec whose design.md awaits review; every turn's full text. */
async function typed(line: string): Promise<{ text: string; turns: string[]; dir: string }> {
  const w = ws();
  const dir = writeSpec(w, 'feat', { requirements: REQ_MD, design: DESIGN_MD });
  const turns: string[] = [];
  const host = new MockHost(
    w.ctx,
    fakeModel({
      override: (input) => {
        turns.push(input.text);
        return undefined;
      },
    }),
  );
  host.chooseAnswers = ['Stop here'];
  const words = line.split(/\s+/).slice(1);
  await specSlashCommands[0]!.run(words, line, host);
  return { text: host.text, turns, dir };
}

const revised = (dir: string, doc: string, feedback: string): string => `Revise ${path.join(dir, `${doc}.md`)} per this feedback, in place, then stop again:\n${feedback}`;

test('/spec revise: a --doc in the feedback is feedback, never the option (it neither refuses nor retargets the revision)', async () => {
  for (const feedback of ['explain the --doc flag', 'mention --doc requirements in the overview', 'say that --doc=tasks names tasks.md']) {
    const r = await typed(`/spec revise feat ${feedback}`);
    const shown = `/spec revise feat ${feedback}\n${r.text}\n--- turns\n${r.turns.join('\n---\n')}`;
    assert.doesNotMatch(r.text, /Unknown document/, shown);
    // design.md is the document under review: it is revised, with the feedback as typed
    assert.deepEqual(r.turns, [revised(r.dir, 'design', feedback)], shown);
  }
});

test('/spec revise: --doc before the feedback is the option (before or after the name)', async () => {
  for (const line of ['/spec revise feat --doc requirements add a criterion', '/spec revise --doc requirements feat add a criterion', '/spec revise feat --doc=requirements add a criterion']) {
    const r = await typed(line);
    const shown = `${line}\n${r.text}\n--- turns\n${r.turns.join('\n---\n')}`;
    assert.deepEqual(r.turns, [revised(r.dir, 'requirements', 'add a criterion')], shown);
  }
  // an unknown document there is still refused, before any turn
  const bad = await typed('/spec revise feat --doc nope add a criterion');
  assert.match(bad.text, /Unknown document 'nope'\. Use requirements, bugfix, design or tasks\./, bad.text);
  assert.deepEqual(bad.turns, [], bad.text);
});

test('/spec approve still takes --doc anywhere (it has no free text)', async () => {
  const r = await typed('/spec approve feat --doc requirements');
  const shown = `${r.text}\n--- turns\n${r.turns.join('\n---\n')}`;
  assert.equal(r.turns.length, 1, shown);
  assert.match(r.turns[0]!, /^Phase: DESIGN\. /, shown);
});
