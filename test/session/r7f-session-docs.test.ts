/**
 * r7 #9 (session group): the contract docs of a compaction that does not compact match the code.
 * b433438 made the reason of `compaction_failed` Claude's `compact_error` made readable
 * (compactErrorText: internal codes as sentences, without Claude's `Compaction failed ·`), and
 * `Compaction cancelled` with `cancelled` whenever the turn was interrupted; an interrupted
 * `/compact` is stopReason `cancelled` with no error, although claude 2.1.319 reports the abort as
 * `compact_result: 'failed'` (`API Error: Request was aborted.`) under a success result. Checked
 * here: the behaviour through the session, then the SessionEvent doc in src/types.ts and the
 * src/session/kiroSession.ts module doc (read from the repository root; tests run from there).
 * The r7 #3 decision (model and effort are session state across tangents) is checked in the
 * ARCHITECTURE Tangents paragraph too.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl } from '../../src/session/kiroSession.js';
import type { SessionEvent } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'session', 'kiroSession.ts')) && fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}
const source = (rel: string): string => fs.readFileSync(path.join(repoRoot(), rel), 'utf8');

/** The JSDoc block right before `type: 'compaction_failed'` in src/types.ts. */
function compactionFailedDoc(): string {
  const src = source('src/types.ts');
  const at = src.indexOf("type: 'compaction_failed'");
  assert.ok(at > 0);
  const open = src.lastIndexOf('/**', at);
  return src.slice(open, src.indexOf('*/', open) + 2).replace(/\n\s*\*\s?/g, ' ');
}

/** The module doc of src/session/kiroSession.ts (its first comment block), one line. */
function sessionModuleDoc(): string {
  const src = source('src/session/kiroSession.ts');
  return src.slice(src.indexOf('/**'), src.indexOf('*/') + 2).replace(/\n\s*\*\s?/g, ' ');
}

const failedOf = (events: SessionEvent[]): SessionEvent | undefined => events.find((e) => e.type === 'compaction_failed');

describe('r7 #9: compaction_failed and an interrupted /compact, as the contract docs say', () => {
  it("an internal code's reason is a sentence (behaviour), and types.ts says the reason is made readable", async () => {
    const sb = mkSandbox({ script: { turns: [{ steps: [{ autoCompact: 'failed', error: 'too_few_groups' }, { text: 'ANSWER' }] }] } as never });
    const s = await KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: false, ui: recordingUI(), binary: fakeBinary(), caps, env: sb.env });
    try {
      const { events, result } = await drain(s.prompt({ text: 'go' }));
      assert.deepEqual(failedOf(events), { type: 'compaction_failed', reason: 'Not enough messages to compact.' });
      assert.equal(result.text, 'ANSWER');
    } finally {
      await closeAll(s);
    }
    const doc = compactionFailedDoc();
    assert.doesNotMatch(doc, /`reason` = its `compact_error`/, 'types.ts still says the reason is the raw compact_error');
    assert.match(doc, /Compaction cancelled/, 'types.ts: an interrupted one reads Compaction cancelled');
    assert.match(doc, /too_few_groups/, "types.ts: Claude Code's internal codes become sentences");
    assert.match(doc, /Compaction failed ·/, "types.ts: without Claude's own prefix");
  });

  it('an interrupted /compact is cancelled with no error (behaviour), and the module doc says so', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_COMPACT_MS: '4000' } });
    const s = await KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env: sb.env });
    try {
      await drain(s.prompt({ text: 'one' }));
      await drain(s.prompt({ text: 'two' }));
      const gen = s.compact();
      const events: SessionEvent[] = [];
      let result;
      for (;;) {
        const r = await gen.next();
        if (r.done) {
          result = r.value;
          break;
        }
        events.push(r.value);
        if (r.value.type === 'compaction' && r.value.state === 'started') setTimeout(() => void s.interrupt(), 300);
      }
      assert.ok(events.some((e) => e.type === 'compaction' && e.state === 'started'), 'precondition: the compaction started');
      assert.deepEqual(failedOf(events), { type: 'compaction_failed', reason: 'Compaction cancelled', cancelled: true });
      assert.equal(result.stopReason, 'cancelled');
      assert.equal(result.isError, false);
      assert.equal(result.error, undefined);
    } finally {
      await closeAll(s);
    }
    const doc = sessionModuleDoc();
    assert.doesNotMatch(doc, /with its `compact_error` as the reason/, 'the module doc still says the reason is the raw compact_error');
    assert.match(doc, /Request was aborted/, 'the module doc names the 2.1.319 abort report');
    assert.match(doc, /compactErrorText/, 'the module doc names compactErrorText');
    assert.match(doc, /stopReason `cancelled` with no error/, 'the module doc says an interrupted /compact is no error');
  });
});

describe('r7 #3: docs/ARCHITECTURE.md (Sessions, Tangents) says the model and effort are session state', () => {
  it('the Tangents paragraph names /model, /effort and the agent\'s pinned model', () => {
    const md = source('docs/ARCHITECTURE.md');
    const at = md.indexOf('* **Tangents.** `/tangent` forks the conversation');
    assert.ok(at > 0);
    const para = md.slice(at, md.indexOf('\n* **', at + 5)).replace(/\s+/g, ' ');
    assert.match(para, /`\/model`/, 'the Tangents paragraph names /model');
    assert.match(para, /`\/effort`/, 'the Tangents paragraph names /effort');
    assert.match(para, /model the agent pins/, "the Tangents paragraph names the agent's pinned model");
  });
});
