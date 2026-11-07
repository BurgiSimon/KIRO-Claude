/**
 * Verifier guards for the round-4 "session-records" fixes (scratchpad r4-findings.json #4, #10):
 *  - #10 × K1 / S1: the r4 #10 pin can make a session's pending fork point a cancelled turn's
 *    USER uuid (`KiroSession.forkSource().at`). A `create({ fork })` at that point (the spec
 *    driver's phase session forked from a chat that has no transcript of its own yet: a `/chat
 *    load`, a pending fork reopened after a quit) must still carry the parent's turns and journal
 *    through that turn, as it does for a fork at the parent's last answer: otherwise the fork's
 *    record has no history (`/tangent`, `/rewind`, the continuation's turns) and a fork Claude
 *    cannot serve falls back on an empty journal.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { importSessionExport, KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import type { KiroSession } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env };
}

async function open(sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> {
  return KiroSessionImpl.create({ ...baseOptions(sb, ui), ...over });
}

/** A fork of `parent`'s conversation as SpecSessionDriver.fork asks for one (origin 'spec': a phase). */
async function forkOf(sb: Sandbox, parent: KiroSession, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> {
  const src = parent.forkSource()!;
  return open(sb, { origin: 'spec', fork: { fromClaudeSessionId: src.from, ...(src.at ? { at: src.at } : {}), kind: 'main', parentId: parent.id } }, ui);
}

const SCRIPT = {
  turns: [{ repeat: true, match: '^SLOWPOKE', steps: [{ sleepMs: 8000 }, { text: 'late answer' }] }],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const journalText = (sb: Sandbox, id: string): string => {
  try {
    return fs.readFileSync(path.join(sb.sessionsDir, `${id}.jsonl`), 'utf8');
  } catch {
    return '';
  }
};

/** A prompt cancelled (interrupt) before Claude produced any assistant message. */
async function cancelledTurn(s: KiroSession, text: string): Promise<void> {
  const gen = s.prompt({ text });
  const done = drain(gen);
  await sleep(400);
  await s.interrupt();
  const { result } = await done;
  assert.equal(result.stopReason, 'cancelled', 'precondition: the turn was cancelled');
}

/** Every Claude transcript file `<id>.jsonl` under the sandbox's CLAUDE_CONFIG_DIR. */
function transcriptsOf(sb: Sandbox, id: string): string[] {
  const out: string[] = [];
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
      else if (e.name === `${id}.jsonl`) out.push(p);
    }
  };
  walk(sb.claudeConfig);
  return out;
}

/**
 * A chat pinned at a cancelled turn's user line with no transcript of its own yet: `/chat load` of
 * an export without a transcript whose last turn was cancelled before any answer (r4 #10 pin).
 */
async function pinnedAtUserLine(): Promise<{ sb: Sandbox; s: KiroSessionImpl; imported: KiroSessionImpl; userUuid: string; mainClaude: string }> {
  const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
  const s = await open(sb);
  await drain(s.prompt({ text: 'alpha ALPHA_1' }));
  await cancelledTurn(s, 'SLOWPOKE beta');
  const last = s.record.turns.at(-1)!;
  assert.equal(last.assistantUuid, undefined, 'precondition: no answer recorded');
  const mainClaude = s.claudeSessionId!;
  const file = path.join(sb.root, 'export.json');
  await s.exportTo(file, true);
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  data.claudeTranscript = '';
  fs.writeFileSync(file, JSON.stringify(data));
  const starts = sb.starts().length;
  const imported = (await importSessionExport(file, baseOptions(sb))) as KiroSessionImpl;
  assert.equal(flagValue(sb.starts()[starts]!, '--resume-session-at'), last.userUuid, 'precondition: the import is pinned at the cancelled user line');
  assert.equal(imported.forkSource().at, last.userUuid, 'precondition: its fork point is that user line');
  return { sb, s, imported, userUuid: last.userUuid, mainClaude };
}

describe('r4 #10 (verify): a fork at a pending fork point that is a cancelled turn\'s user line', () => {
  it('carries the parent\'s turns and journal through that turn (K1 / S1)', async () => {
    const { sb, s, imported } = await pinnedAtUserLine();
    let phase: KiroSessionImpl | undefined;
    try {
      phase = await forkOf(sb, imported);
      assert.deepEqual(
        phase.record.turns.map((t) => t.preview),
        ['alpha ALPHA_1', 'SLOWPOKE beta'],
        'the fork\'s record lost the conversation it forks',
      );
      assert.equal(phase.record.messageCount, 2);
      const j = journalText(sb, phase.id);
      assert.match(j, /alpha ALPHA_1/, 'the fork\'s journal lost the parent\'s history');
      assert.match(j, /SLOWPOKE beta/);
    } finally {
      await closeAll(phase, imported, s);
    }
  });

  it('…so a fork Claude cannot serve falls back on that history, not on an empty journal', async () => {
    const { sb, s, imported, mainClaude } = await pinnedAtUserLine();
    let phase: KiroSessionImpl | undefined;
    try {
      await s.close();
      // the fork source is gone (e.g. its transcript was cleaned up): the fork's spawn falls back
      for (const t of transcriptsOf(sb, mainClaude)) fs.rmSync(t);
      const ui = recordingUI();
      phase = await forkOf(sb, imported, ui);
      const { result } = await drain(phase.prompt({ text: 'Phase: REQUIREMENTS' }));
      assert.match(result.text, /ALPHA_1/, `the fallback lost the conversation: ${result.text}`);
      assert.match(result.text, /SLOWPOKE beta/, `the fallback lost the cancelled line: ${result.text}`);
    } finally {
      await closeAll(phase, imported, s);
    }
  });

  it('a fork at an earlier answer of the same parent still cuts there (a rewind point)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let f: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'one ONE_1' }));
      await drain(s.prompt({ text: 'two TWO_2' }));
      const a1 = s.record.turns[0]!.assistantUuid!;
      f = await open(sb, { origin: 'spec', fork: { fromClaudeSessionId: s.claudeSessionId!, at: a1, kind: 'main', parentId: s.id } });
      assert.deepEqual(f.record.turns.map((t) => t.preview), ['one ONE_1']);
      assert.doesNotMatch(journalText(sb, f.id), /TWO_2/);
      // a user uuid of an ANSWERED turn is no fork point of ours: the cut is unknown, nothing is carried (G2)
      await f.close();
      const u2 = s.record.turns[1]!.userUuid;
      f = await open(sb, { origin: 'spec', fork: { fromClaudeSessionId: s.claudeSessionId!, at: u2, kind: 'main', parentId: s.id } });
      assert.deepEqual(f.record.turns, []);
    } finally {
      await closeAll(f, s);
    }
  });
});

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

describe('r4 #10 (verify): a copy whose journal ends with a compaction, as the real claude serves it', () => {
  // Real claude 2.1.319 (VERIFIED by this verifier: haiku, turn → /compact → turn, then `--resume S
  // --resume-session-at <the pre-compaction answer> --fork-session`) loads a transcript from its
  // last compact boundary and refuses an older uuid it did not keep verbatim: `No message found
  // with message.uuid of: <uuid>`. With two turns the compaction keeps the last answer (the pin,
  // r5 S2), which the fake (r5 S1) and the real claude serve, so the refusal is made here by
  // removing the entries through that answer from the source transcript.
  it('falls back on its own journal: the conversation through the compaction, none of the original\'s later turns', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb, { origin: 'acp' });
    let o: KiroSessionImpl | undefined;
    let copy: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      await drain(s.prompt({ text: 'beta BETA_2' }));
      await drain(s.compact());
      const at = s.record.turns.at(-1)!.assistantUuid!;
      const claudeId = s.claudeSessionId!;
      const origId = s.id;
      await s.close();
      const y = layerBCopy(sb, origId);
      o = await open(sb, { origin: 'acp', resume: { sessionId: origId } });
      await drain(o.prompt({ text: 'gamma-later GAMMA_3' }));
      await o.close();
      const files = transcriptsOf(sb, claudeId);
      assert.equal(files.length, 1, 'precondition: one source transcript');
      const lines = fs.readFileSync(files[0]!, 'utf8').split('\n').filter((l) => l.trim() !== '');
      const cut = lines.findIndex((l) => (JSON.parse(l) as { uuid?: string }).uuid === at);
      assert.ok(cut >= 0, 'precondition: the transcript holds the pre-compaction answer');
      fs.writeFileSync(files[0]!, lines.slice(cut + 1).join('\n') + '\n');
      const starts = sb.starts().length;
      const ui = recordingUI();
      copy = await open(sb, { origin: 'acp', resume: { sessionId: y } }, ui);
      assert.equal(flagValue(sb.starts()[starts]!, '--resume-session-at'), at, 'pinned at the copied record\'s last turn');
      const { result } = await drain(copy.prompt({ text: 'RECALL' }));
      assert.doesNotMatch(result.text, /GAMMA_3/, `the copy sees a turn the original made after the copy: ${result.text}`);
      assert.match(result.text, /ALPHA_1/, `the fallback lost the conversation: ${result.text}`);
      assert.match(result.text, /BETA_2/, `the fallback lost the conversation: ${result.text}`);
    } finally {
      await closeAll(copy, o, s);
    }
  });
});
