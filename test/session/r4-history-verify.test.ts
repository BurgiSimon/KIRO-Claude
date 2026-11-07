/**
 * Verifier guards for the round-4 restored-history fixes (scratchpad r4-findings.json #1, #6; see
 * r4-history.test.ts for the fixer's own guards). Each case attacks the pending restored history
 * kept on the record (`SessionRecord.pendingHistory`):
 *  - a `/effort` queued while the block is pending belongs to the record it was set in: a tangent's
 *    level never reaches its parent's Claude session after `/tangent` (exit), nor a parent's the
 *    tangent (each child starts with its own record's `--effort`);
 *  - a `/compact` while the block is pending compacts a Claude session that never had the
 *    conversation: the journal keeps the conversation (no compaction marker of nothing), so a later
 *    second loss of the transcript, after the block was delivered, still restores the turns
 *    before the first loss; a `/compact` after delivery is journaled as before;
 *  - a `/rewind` and a `create({ fork })` at a rewind point while the block is pending send only
 *    their cut history (G2), once, also when the fresh Claude session has a transcript;
 *  - a tangent whose own fork falls back sends its copy once (never with a journal-built block);
 *  - a respawn fallback inside a prompt with a `/effort` queued writes the `/effort`, then the
 *    prompt line with the history (#6);
 *  - a quit inside a tangent keeps the parent's block and the tangent's copy on their records.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { readJournal } from '../../src/session/kiroFiles.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

/** Replies that never echo the history (so a block's content is only what the line carries). */
const QUIET = { turns: [], default: { steps: [{ text: 'effort={{effort}} n={{historyCount}}' }] } };
const BLOCK = '<kiro-restored-history>';

async function open(sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> {
  return KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, ...over });
}

function textOf(line: Record<string, unknown> | undefined): string {
  const c = (line?.message as { content?: unknown } | undefined)?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text) : '')).join('');
}
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
const lineFor = (sb: Sandbox, needle: string): string => sb.userLines().map(textOf).filter((t) => t.includes(needle)).at(-1) ?? '';
const fellBack = (ui: RecordingUI): boolean => ui.notices.some((n) => /could not find the saved conversation/i.test(n.message));
const onDisk = (sb: Sandbox, id: string): SessionRecord | undefined => new SessionStore(sb.sessionsDir).read(id);
const loseTranscripts = (sb: Sandbox): void => fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });

/** A saved session with `prompts` (effort `high`), its transcripts lost, reopened (fell back). */
async function fallenBack(prompts = ['remember ALPHA_1']): Promise<{ sb: Sandbox; s: KiroSessionImpl; id: string }> {
  const sb = mkSandbox({ script: QUIET, env: { FAKE_CLAUDE_PERSIST: '1' } });
  const first = await open(sb);
  const id = first.id;
  try {
    await first.setEffort('high');
    for (const p of prompts) await drain(first.prompt({ text: p }));
  } finally {
    await closeAll(first);
  }
  loseTranscripts(sb);
  const ui = recordingUI();
  const s = await open(sb, { resume: { sessionId: id } }, ui);
  assert.ok(fellBack(ui), 'precondition: the resume fell back to a fresh Claude session');
  assert.ok(s.record.pendingHistory, 'precondition: the history is pending');
  return { sb, s, id };
}

describe('R4 #1 (verify): a /effort queued while the history is pending stays with its record', () => {
  it('set in a tangent (its copy of the history pending), then /tangent exit: the parent keeps its own level', async () => {
    const { sb, s } = await fallenBack();
    try {
      assert.equal(s.effort, 'high');
      await s.enterTangent('side');
      await s.setEffort('low'); // queued: the tangent's copy of the history is pending
      assert.equal(s.effort, 'low');
      await s.exitTangent('discard');
      assert.equal(s.effort, 'high', "the parent's saved level");
      const { result } = await drain(s.prompt({ text: 'in main' }));
      assert.match(result.text, /^effort=high /, `the parent's Claude session runs at its own level: ${result.text.slice(0, 40)}`);
      assert.equal(count(lineFor(sb, 'in main'), BLOCK), 1, "the parent's own copy of the history, once");
      assert.ok(!sb.userLines().map(textOf).includes('/effort low'), "the tangent's level was never written to a child");
    } finally {
      await closeAll(s);
    }
  });

  it('set in the parent while pending, then /tangent and back: each child runs at its own record\'s level', async () => {
    const { sb, s } = await fallenBack();
    try {
      await s.setEffort('low'); // queued for the parent's next line
      await s.enterTangent('side');
      assert.equal(s.effort, 'low', 'the tangent copies the level');
      await s.setEffort('medium'); // the tangent's own (queued too)
      const t = await drain(s.prompt({ text: 'in tangent' }));
      assert.match(t.result.text, /^effort=medium /, t.result.text.slice(0, 40));
      await s.exitTangent('discard');
      const m = await drain(s.prompt({ text: 'in main' }));
      assert.match(m.result.text, /^effort=low /, m.result.text.slice(0, 40));
      assert.equal(count(lineFor(sb, 'in main'), BLOCK), 1);
    } finally {
      await closeAll(s);
    }
  });
});

describe('R4 #1 (verify): a /compact while the history is pending', () => {
  it('then the line delivers it, the transcript is lost again, reopen: the turns before the first loss come back', async () => {
    const { sb, s, id } = await fallenBack(['remember ALPHA_1', 'second BETA_2']);
    await drain(s.compact()); // Claude compacts a session that does not hold the conversation
    await drain(s.prompt({ text: 'next GAMMA_3' }));
    assert.equal(s.record.pendingHistory, undefined, 'precondition: delivered');
    await s.close();
    loseTranscripts(sb);
    const ui = recordingUI();
    const s2 = await open(sb, { resume: { sessionId: id } }, ui);
    try {
      assert.ok(fellBack(ui), 'precondition: the reopen fell back');
      await drain(s2.prompt({ text: 'after reopen' }));
      const t = lineFor(sb, 'after reopen');
      assert.equal(count(t, BLOCK), 1, JSON.stringify(t.slice(0, 300)));
      assert.match(t, /User: remember ALPHA_1[\s\S]*User: second BETA_2[\s\S]*User: next GAMMA_3[\s\S]*<\/kiro-restored-history>[\s\S]*after reopen/, JSON.stringify(t.slice(0, 600)));
    } finally {
      await closeAll(s2);
    }
  });

  it('a /compact after the block was delivered is journaled as before (its summary is the conversation\'s)', async () => {
    const { sb, s, id } = await fallenBack();
    try {
      await drain(s.prompt({ text: 'next' }));
      const before = readJournal(sb.sessionsDir, id).filter((j) => j.kind === 'Compaction').length;
      await drain(s.compact());
      assert.equal(readJournal(sb.sessionsDir, id).filter((j) => j.kind === 'Compaction').length, before + 1);
    } finally {
      await closeAll(s);
    }
  });
});

describe('R4 #1 (verify): forks at a rewind point while the history is pending send their cut history (G2)', () => {
  for (const local of [false, true]) {
    const tag = local ? ' (the fresh Claude session has a transcript: /compact)' : '';
    it(`/rewind 1${tag}`, async () => {
      const { sb, s, id } = await fallenBack(['m1 MARK_ONE', 'm2 MARK_TWO']);
      try {
        if (local) await drain(s.compact());
        await s.rewind(1);
        await drain(s.prompt({ text: 'after rewind' }));
        const t = lineFor(sb, 'after rewind');
        assert.equal(count(t, BLOCK), 1, JSON.stringify(t.slice(0, 300)));
        assert.match(t, /MARK_ONE/);
        assert.doesNotMatch(t, /MARK_TWO/, 'the turn rewound away is never sent');
        assert.match(onDisk(sb, id)?.pendingHistory ?? '', /MARK_TWO/, 'the old record keeps its own block');
      } finally {
        await closeAll(s);
      }
    });

    it(`create({ fork }) at turn 1${tag}`, async () => {
      const { sb, s } = await fallenBack(['m1 MARK_ONE', 'm2 MARK_TWO']);
      let f: KiroSessionImpl | undefined;
      try {
        if (local) await drain(s.compact());
        const at = s.record.turns[0]!.assistantUuid!;
        f = await open(sb, { origin: 'spec', fork: { fromClaudeSessionId: s.forkSource().from, at, kind: 'main', parentId: s.id } });
        // its own fallback's block (the journal cut at that turn), not a copy of the parent's
        assert.doesNotMatch(f.record.pendingHistory ?? '', /MARK_TWO/, "no copy of the parent's whole history");
        await drain(f.prompt({ text: 'in fork' }));
        const t = lineFor(sb, 'in fork');
        assert.equal(count(t, BLOCK), 1, JSON.stringify(t.slice(0, 300)));
        assert.match(t, /MARK_ONE/);
        assert.doesNotMatch(t, /MARK_TWO/);
      } finally {
        await closeAll(f, s);
      }
    });
  }
});

describe('R4 #1 (verify): the copies are one block each', () => {
  it('a /tangent whose fork falls back too (the fresh Claude session has no transcript) sends its copy once', async () => {
    const { sb, s } = await fallenBack();
    try {
      await s.enterTangent('side');
      await drain(s.prompt({ text: 'in tangent' }));
      const t = lineFor(sb, 'in tangent');
      assert.equal(count(t, BLOCK), 1, JSON.stringify(t.slice(0, 300)));
      assert.equal(count(t, 'User: remember ALPHA_1'), 1);
    } finally {
      await closeAll(s);
    }
  });
});

describe('R4 #6 (verify): a respawn fallback inside a prompt with a /effort queued', () => {
  it('writes the /effort, then the prompt line with the history (in this child, in order)', async () => {
    const sb = mkSandbox({ script: QUIET, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const ui = recordingUI();
    const s = await open(sb, {}, ui);
    try {
      await drain(s.prompt({ text: 'remember PELICAN' }));
      loseTranscripts(sb);
      const pid = s.process!.pid!;
      process.kill(pid, 'SIGKILL');
      const t0 = Date.now();
      while (s.process?.running && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
      await s.setEffort('low'); // the child is down: queued
      const before = sb.userLines().length;
      const { result } = await drain(s.prompt({ text: 'which word?' }));
      assert.ok(fellBack(ui), 'precondition: the respawn fell back');
      const lines = sb.userLines().slice(before).map(textOf);
      assert.equal(lines.length, 2, JSON.stringify(lines.map((l) => l.slice(0, 50))));
      assert.equal(lines[0], '/effort low');
      assert.match(lines[1]!, /<kiro-restored-history>[\s\S]*PELICAN[\s\S]*which word\?/);
      assert.match(result.text, /^effort=low /);
      assert.equal(onDisk(sb, s.id)?.pendingHistory, undefined, 'delivered');
    } finally {
      await closeAll(s);
    }
  });
});

describe('R4 #1 (verify): a quit inside a tangent', () => {
  it("keeps the parent's block and the tangent's copy on their records; each reopen sends its own once", async () => {
    const { sb, s, id } = await fallenBack();
    await s.enterTangent('side');
    const tid = s.id;
    await s.close();
    assert.match(onDisk(sb, id)?.pendingHistory ?? '', /ALPHA_1/, "the parent's block");
    assert.match(onDisk(sb, tid)?.pendingHistory ?? '', /ALPHA_1/, "the tangent's copy");
    for (const [rid, text] of [
      [tid, 'tangent again'],
      [id, 'main again'],
    ] as const) {
      const r = await open(sb, { resume: { sessionId: rid } });
      try {
        await drain(r.prompt({ text }));
        assert.equal(count(lineFor(sb, text), BLOCK), 1, `${text}: ${JSON.stringify(lineFor(sb, text).slice(0, 200))}`);
        assert.match(lineFor(sb, text), /ALPHA_1/);
        await drain(r.prompt({ text: `${text} later` }));
        assert.equal(count(lineFor(sb, `${text} later`), BLOCK), 0);
      } finally {
        await closeAll(r);
      }
    }
  });
});
