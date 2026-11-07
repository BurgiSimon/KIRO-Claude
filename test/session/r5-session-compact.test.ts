/**
 * r5 S2: a record whose conversation ends with a `/compact` is forked at the compaction, not
 * through the journal fallback.
 *
 * VERIFIED with the real claude 2.1.319 (r5 session scratchpad probe-compact-pin*.mjs, modelled by
 * the fake since r5 S1): a resume loads a transcript from its last compact boundary, so a fork at
 * the last turn's answer is refused (`No message found`) unless the compaction kept that message
 * verbatim (two user turns or more); a fork at the summary (the boundary's anchor) or at the
 * message kept verbatim is served and holds the compacted conversation (the model still knew the
 * summarized lines). So `/compact` records that uuid on the record's last turn
 * (`SessionTurnRecord.compactUuid`: the kept message, else the summary), and the pin of a saved
 * record (a KiroCrew copy, a pending fork reopened after a quit, a `/chat load` without a
 * transcript) is that uuid: a faithful fork of the conversation as saved, never the original's
 * later turns. A `/compact` of a fresh Claude session whose restored history is still pending
 * summarizes none of the conversation: it records nothing.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { importSessionExport, KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = { default: { steps: [{ text: 'hist={{historyUserTexts}}' }] } };

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env };
}
const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui?: RecordingUI): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ...baseOptions(sb, ui), ...over });
const read = (sb: Sandbox, id: string): SessionRecord | undefined => new SessionStore(sb.sessionsDir).read(id);
const fallbackNotice = (ui: RecordingUI): boolean => ui.notices.some((n) => /could not find the saved conversation/i.test(n.message));

/** Every Claude transcript entry of `claudeId` under the sandbox's CLAUDE_CONFIG_DIR. */
function transcript(sb: Sandbox, claudeId: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (d: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === `${claudeId}.jsonl`) {
        for (const l of fs.readFileSync(p, 'utf8').split('\n')) if (l.trim()) out.push(JSON.parse(l) as Record<string, unknown>);
      }
    }
  };
  walk(sb.claudeConfig);
  return out;
}
const summaryUuid = (sb: Sandbox, claudeId: string): string | undefined => transcript(sb, claudeId).filter((l) => l.isCompactSummary === true).at(-1)?.uuid as string | undefined;

/** Copy record and journal under a new id the way KiroCrew's Layer B transfer does (08a §4.2). */
function layerBCopy(sb: Sandbox, sid: string): string {
  const nsid = randomUUID();
  const raw = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${sid}.json`), 'utf8')) as Record<string, unknown>;
  raw.session_id = nsid;
  raw.title = null;
  fs.writeFileSync(path.join(sb.sessionsDir, `${nsid}.json`), JSON.stringify(raw));
  fs.copyFileSync(path.join(sb.sessionsDir, `${sid}.jsonl`), path.join(sb.sessionsDir, `${nsid}.jsonl`));
  return nsid;
}

describe('r5 S2: /compact records where a fork of the compacted conversation starts', () => {
  for (const turns of [1, 2]) {
    it(`a KiroCrew copy of a record whose ${turns === 1 ? 'only turn' : 'last turn'} a compaction followed forks at the compaction (no fallback), without the original's later turns`, async () => {
      const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
      const s = await open(sb, { origin: 'acp' });
      let o: KiroSessionImpl | undefined;
      let copy: KiroSessionImpl | undefined;
      try {
        await drain(s.prompt({ text: 'alpha ALPHA_1' }));
        if (turns === 2) await drain(s.prompt({ text: 'beta BETA_2' }));
        await drain(s.compact());
        const claudeId = s.claudeSessionId!;
        const last = s.record.turns.at(-1)!;
        const pin = turns === 1 ? summaryUuid(sb, claudeId) : last.assistantUuid;
        assert.ok(pin, 'precondition: a summary in the transcript');
        assert.equal(last.compactUuid, pin, turns === 1 ? 'nothing kept verbatim: the summary' : 'the answer the compaction kept verbatim');
        assert.equal(read(sb, s.id)?.turns.at(-1)?.compactUuid, pin, 'saved with the record');
        const origId = s.id;
        await s.close();
        const y = layerBCopy(sb, origId);
        o = await open(sb, { origin: 'acp', resume: { sessionId: origId } });
        await drain(o.prompt({ text: 'gamma-later GAMMA_3' }));
        await o.close();
        const starts = sb.starts().length;
        const ui = recordingUI();
        copy = await open(sb, { origin: 'acp', resume: { sessionId: y } }, ui);
        const argv = sb.starts()[starts]!;
        assert.equal(flagValue(argv, '--resume'), claudeId, `argv: ${argv.join(' ')}`);
        assert.ok(argv.includes('--fork-session'));
        assert.equal(flagValue(argv, '--resume-session-at'), pin, 'pinned at the compaction');
        assert.equal(fallbackNotice(ui), false, 'Claude serves the pin: a fork, not the journal fallback');
        const { result } = await drain(copy.prompt({ text: 'RECALL' }));
        assert.equal(result.text, turns === 1 ? 'hist=alpha ALPHA_1 | RECALL' : 'hist=alpha ALPHA_1 | beta BETA_2 | RECALL');
        assert.doesNotMatch(String(copy.record.pendingHistory ?? ''), /ALPHA_1/, 'no restored-history block: the fork holds the conversation');
      } finally {
        await closeAll(copy, o, s);
      }
    });
  }

  it('a fresh tangent of a compacted chat, reopened after a quit, forks main at the compaction', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let t: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'first ALPHA_1' }));
      await drain(s.compact());
      const mainClaude = s.claudeSessionId!;
      const pin = summaryUuid(sb, mainClaude)!;
      await s.enterTangent('side');
      const tangentId = s.id;
      await s.close();
      const starts = sb.starts().length;
      const ui = recordingUI();
      t = await open(sb, { resume: { sessionId: tangentId } }, ui);
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude);
      assert.equal(flagValue(argv, '--resume-session-at'), pin, `argv: ${argv.join(' ')}`);
      assert.equal(fallbackNotice(ui), false);
      assert.deepEqual(read(sb, tangentId)?.pendingFork, { from: mainClaude, at: pin }, 'the reopen keeps its pin with the pending fork');
      const { result } = await drain(t.prompt({ text: 'in tangent' }));
      assert.equal(result.text, 'hist=first ALPHA_1 | in tangent');
    } finally {
      await closeAll(t, s);
    }
  });

  it('/chat load of an export without a transcript after a compaction forks the exported session at the compaction', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let imported: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      await drain(s.compact());
      const mainClaude = s.claudeSessionId!;
      const pin = summaryUuid(sb, mainClaude)!;
      const file = path.join(sb.root, 'export.json');
      await s.exportTo(file, true);
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      data.claudeTranscript = '';
      fs.writeFileSync(file, JSON.stringify(data));
      await drain(s.prompt({ text: 'later GAMMA_3' })); // the original runs on
      const starts = sb.starts().length;
      const ui = recordingUI();
      imported = (await importSessionExport(file, baseOptions(sb, ui))) as KiroSessionImpl;
      const argv = sb.starts()[starts]!;
      assert.equal(flagValue(argv, '--resume'), mainClaude, `argv: ${argv.join(' ')}`);
      assert.equal(flagValue(argv, '--resume-session-at'), pin);
      assert.equal(fallbackNotice(ui), false);
      const { result } = await drain(imported.prompt({ text: 'loaded' }));
      assert.equal(result.text, 'hist=alpha ALPHA_1 | loaded');
    } finally {
      await closeAll(imported, s);
    }
  });

  it('a spec-style fork made at that pin carries the record\'s turns and journal (forkCutIndex knows the pin)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb, { origin: 'acp' });
    let copy: KiroSessionImpl | undefined;
    let phase: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      await drain(s.compact());
      const pin = s.record.turns.at(-1)!.compactUuid!;
      const origId = s.id;
      await s.close();
      const y = layerBCopy(sb, origId);
      copy = await open(sb, { origin: 'acp', resume: { sessionId: y } });
      const src = copy.forkSource();
      assert.equal(src.at, pin, 'the copy\'s fork source is pinned at the compaction until it speaks');
      phase = await open(sb, { origin: 'spec', fork: { fromClaudeSessionId: src.from, at: src.at!, kind: 'main', parentId: copy.id } });
      assert.equal(phase.record.turns.length, 1, 'the fork carries the turn the compaction followed (K1)');
      assert.equal(phase.record.messageCount, 1);
      const journal = fs.readFileSync(path.join(sb.sessionsDir, `${phase.id}.jsonl`), 'utf8');
      assert.match(journal, /ALPHA_1/, 'and the journal through it');
      const { result } = await drain(phase.prompt({ text: 'Phase' }));
      assert.equal(result.text, 'hist=alpha ALPHA_1 | Phase');
    } finally {
      await closeAll(phase, copy, s);
    }
  });

  it('a /compact while a restored history is pending records no pin (it summarized none of the conversation)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let r: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      const id = s.id;
      const claudeId = s.claudeSessionId!;
      await s.close();
      for (const f of (function* walk(d: string): Generator<string> {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) yield* walk(p);
          else if (e.name === `${claudeId}.jsonl`) yield p;
        }
      })(sb.claudeConfig)) fs.rmSync(f);
      const ui = recordingUI();
      r = await open(sb, { resume: { sessionId: id } }, ui);
      assert.ok(fallbackNotice(ui), 'precondition: the transcript is gone');
      assert.ok(r.record.pendingHistory, 'precondition: the history is pending');
      await drain(r.compact());
      assert.equal(r.record.turns.at(-1)!.compactUuid, undefined);
      assert.equal(read(sb, id)?.turns.at(-1)?.compactUuid, undefined);
    } finally {
      await closeAll(r, s);
    }
  });

  it('the index keeps a UUID pin and drops anything else (it becomes an argv value)', () => {
    const sb = mkSandbox();
    const store = new SessionStore(sb.sessionsDir);
    const rec = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'kiro_default', model: 'auto' });
    const good = randomUUID();
    store.appendTurn(rec, { userUuid: randomUUID(), assistantUuid: randomUUID(), compactUuid: good, preview: 'p', at: new Date().toISOString() }, 'a');
    assert.equal(store.read(rec.sessionId)?.turns[0]?.compactUuid, good);
    const file = path.join(sb.sessionsDir, `${rec.sessionId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { turns: Record<string, unknown>[] };
    raw.turns[0]!.compactUuid = '--dangerously-skip-permissions';
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal(store.read(rec.sessionId)?.turns[0]?.compactUuid, undefined);
  });
});
