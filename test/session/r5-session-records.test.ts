/**
 * r5 session group, record items:
 *  - S3: a `pendingHistory` read from a record file or a `/chat load` export is capped at load
 *    like the block kiro-claude builds (the journal history's 48 KB plus its wrapper): the most
 *    recent part is kept, inside the wrapper; a block kiro-claude built is never touched.
 *  - S4: a main record that never had a message, left in the tangent stack by a quit inside a
 *    tangent (it has no lock file afterwards, so the store-side prune never removes it), is
 *    dropped by close(), which still holds its lock (no race with another process's
 *    create-then-lock window); one with a conversation is kept.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { importSessionExport, KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { PENDING_HISTORY_MAX_BYTES, SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

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
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

const OPEN = '<kiro-restored-history>';
const CLOSE = '</kiro-restored-history>';
const HEADER = `${OPEN}\nClaude Code could not restore the previous conversation of this session. This is its record as kept by Kiro; continue from it.\n\n`;
/** A restored-history block of about `kb` KB: OLDEST first, NEWEST last (multi-byte text in between). */
function hugeBlock(kb: number): string {
  const filler = Array.from({ length: Math.ceil((kb * 1024) / 40) }, (_, i) => `User: line ${i} ünïcødé ✓✓✓`).join('\n\n');
  return `${HEADER}User: OLDEST_LINE\n\n${filler}\n\nAssistant: NEWEST_LINE\n${CLOSE}`;
}

describe('r5 S3: a pending restored history is capped at load', () => {
  it('a record file\'s huge block keeps its wrapper and the most recent part, within the cap', () => {
    const sb = mkSandbox();
    const store = new SessionStore(sb.sessionsDir);
    const rec = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'kiro_default', model: 'auto' });
    const file = path.join(sb.sessionsDir, `${rec.sessionId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    raw.pendingHistory = hugeBlock(400);
    fs.writeFileSync(file, JSON.stringify(raw));
    const got = store.read(rec.sessionId)!.pendingHistory!;
    assert.ok(bytes(got) <= PENDING_HISTORY_MAX_BYTES, `${bytes(got)} bytes`);
    assert.ok(got.startsWith(HEADER), 'the wrapper and its explanation stay');
    assert.ok(got.endsWith(`NEWEST_LINE\n${CLOSE}`), 'the most recent part stays, closed');
    assert.doesNotMatch(got, /OLDEST_LINE/);
    assert.doesNotMatch(got, /�/, 'never a cut multi-byte character');
    assert.ok(bytes(got) > PENDING_HISTORY_MAX_BYTES - 4096, 'as much as fits is kept');
  });

  it('a block kiro-claude builds (≤ 48 KB of history) is kept as it is; a non-wrapped string keeps its end', () => {
    const sb = mkSandbox();
    const store = new SessionStore(sb.sessionsDir);
    const ok = `${HEADER}${'x'.repeat(48 * 1024 + 4)}\n${CLOSE}`;
    const a = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'kiro_default', model: 'auto', pendingHistory: ok });
    assert.equal(store.read(a.sessionId)!.pendingHistory, ok);
    const b = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'kiro_default', model: 'auto' });
    const file = path.join(sb.sessionsDir, `${b.sessionId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    raw.pendingHistory = `START ${'y'.repeat(300 * 1024)} END`;
    fs.writeFileSync(file, JSON.stringify(raw));
    const got = store.read(b.sessionId)!.pendingHistory!;
    assert.ok(bytes(got) <= PENDING_HISTORY_MAX_BYTES);
    assert.ok(got.endsWith(' END'));
    assert.doesNotMatch(got, /START/);
  });

  it('/chat load of an export carrying a huge pending block sends a capped one with the next line', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let imported: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      const file = path.join(sb.root, 'export.json');
      await s.exportTo(file, true);
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { session: Record<string, unknown>; claudeTranscript: string };
      data.session.pendingHistory = hugeBlock(1024);
      fs.writeFileSync(file, JSON.stringify(data));
      imported = (await importSessionExport(file, baseOptions(sb))) as KiroSessionImpl;
      assert.ok(bytes(imported.record.pendingHistory ?? '') <= PENDING_HISTORY_MAX_BYTES, 'capped on the imported record');
      await drain(imported.prompt({ text: 'loaded' }));
      const line = sb.userLines().at(-1)!;
      const content = JSON.stringify((line.message as { content: unknown }).content);
      assert.ok(bytes(content) < PENDING_HISTORY_MAX_BYTES + 8 * 1024, `the line carries ${bytes(content)} bytes`);
      assert.match(content, /NEWEST_LINE/);
      assert.doesNotMatch(content, /OLDEST_LINE/);
    } finally {
      await closeAll(imported, s);
    }
  });
});

describe('r5 S4: a never-used main left in the tangent stack by a quit inside a tangent is not listed', () => {
  it('main whose only actions were /compact and a respawn, quit inside its tangent: main is dropped (and the empty tangent, r5 g1)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    const mainId = s.id;
    try {
      await drain(s.compact()); // Claude writes the transcript of a local command line
      await s.addContext(['*.md']); // a respawn: `already in use` resumes that transcript
      await s.enterTangent('side');
      assert.equal(s.record.forkKind, 'tangent', 'precondition: inside the tangent');
    } finally {
      await s.close();
    }
    const store = new SessionStore(sb.sessionsDir);
    assert.equal(read(sb, mainId), undefined, 'a main that never had a message is not saved');
    assert.ok(!fs.existsSync(path.join(sb.sessionsDir, `${mainId}.jsonl`)), 'nor its journal');
    assert.ok(!fs.existsSync(path.join(sb.sessionsDir, `${mainId}.lock`)), 'nor its lock');
    // r5 g1: the tangent never had a message either, so it is dropped with main
    // (test/session/r5f-session-gaps.test.ts; one with a message of its own is kept)
    assert.deepEqual(store.list({ cwd: sb.cwd }).map((r) => r.forkKind), []);
  });

  it('…but kept when a /tangent merge left a carry for its next line (a reopen delivers it)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    const mainId = s.id;
    try {
      await drain(s.compact());
      await s.addContext(['*.md']);
      await s.enterTangent('one');
      await drain(s.prompt({ text: 'tangent TANGENT_1' }));
      await s.exitTangent('merge');
      assert.equal(s.id, mainId);
      assert.equal(s.record.pendingContext?.length, 1, 'precondition: the merge carry waits on main');
      await s.enterTangent('two');
    } finally {
      await s.close();
    }
    assert.match(read(sb, mainId)?.pendingContext?.[0] ?? '', /<tangent-summary/, 'main and its carry are kept');
  });

  it('a main with a conversation, quit inside its tangent, is kept (and unlocked)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    const mainId = s.id;
    try {
      await drain(s.prompt({ text: 'alpha ALPHA_1' }));
      await s.enterTangent('side');
    } finally {
      await s.close();
    }
    assert.equal(read(sb, mainId)?.messageCount, 1);
    assert.ok(!fs.existsSync(path.join(sb.sessionsDir, `${mainId}.lock`)));
  });

  it('another process\'s record created but not locked yet is never touched by list()', () => {
    const sb = mkSandbox();
    const store = new SessionStore(sb.sessionsDir);
    const r = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'kiro_default', model: 'auto', updatedAt: new Date(Date.now() + 1000).toISOString() });
    assert.equal(store.list({ cwd: sb.cwd }).some((x) => x.sessionId === r.sessionId), true);
    assert.ok(read(sb, r.sessionId));
  });
});

