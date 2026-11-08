/**
 * r8 #7 (session group): every record of a fork that still has to be made is on disk with that
 * fork (`pendingFork`) from its first write, not only the `/tangent` and `/rewind` records (r7 #1).
 * build()'s `create({ fork })` branch (a /spec phase session, the continuation a /spec flow hands
 * to the chat) and importSessionExport in mode 'fork' (`/chat load` of an export without a
 * transcript) wrote their record without it; spawn() added it only once the Claude child was up
 * (agentSpawn hooks, spawn, initialize: seconds with a real claude). A crash in that window made
 * `chat --resume` (it opens that newest record) pick mode 'resume' for a Claude id with no
 * transcript, so it fell back on a new conversation with the journal as text history ('Claude
 * Code could not find the saved conversation…') instead of forking the source again.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { importSessionExport, KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { KiroSession, SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, fakeClaudePath, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = { default: { steps: [{ text: 'HIST[{{historyUserTexts}}]' }] } };
const FALLBACK = /could not find the saved conversation/i;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const sandbox = (): Sandbox => mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
const open = (sb: Sandbox, env: NodeJS.ProcessEnv, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env, ...over });

/** Wait for a record that is not in `known` (the one being made), read it from disk. */
async function newRecord(sb: Sandbox, known: Set<string>): Promise<SessionRecord> {
  const store = new SessionStore(sb.sessionsDir);
  for (let i = 0; i < 400; i++) {
    const r = store.list({ cwd: sb.cwd }).find((x) => !known.has(x.sessionId));
    if (r) return r;
    await sleep(10);
  }
  assert.fail('no new record appeared');
}

const known = (sb: Sandbox): Set<string> => new Set(new SessionStore(sb.sessionsDir).list({ cwd: sb.cwd }).map((r) => r.sessionId));

// ── the record on disk while its Claude child starts ──

describe('r8 #7: a fork record on disk while its Claude child starts holds the fork still to be made', () => {
  for (const origin of ['repl', 'spec'] as const) {
    it(`create({ fork }) (origin ${origin}): pendingFork from the first write, at the fork point when one is given`, async () => {
      const sb = sandbox();
      const env = { ...sb.env };
      const chat = await open(sb, env);
      let fork: KiroSessionImpl | undefined;
      try {
        await drain(chat.prompt({ text: 'one' }));
        await drain(chat.prompt({ text: 'two' }));
        const from = chat.claudeSessionId!;
        const at = origin === 'spec' ? chat.record.turns[0]!.assistantUuid! : undefined;
        const before = known(sb);
        env.FAKE_CLAUDE_CONTROL_DELAYS = JSON.stringify({ initialize: 1500 });
        const p = open(sb, env, { origin, fork: { fromClaudeSessionId: from, kind: 'main', parentId: chat.id, ...(at ? { at } : {}) } });
        const rec = await newRecord(sb, before);
        await sleep(200);
        const during = new SessionStore(sb.sessionsDir).read(rec.sessionId)!;
        fork = await p;
        assert.equal(during.turns.length, at ? 1 : 2, 'precondition: the record carries the parent turns');
        assert.deepEqual(during.pendingFork, { from, ...(at ? { at } : {}) }, 'the fork still to be made, on disk while the child starts');
        assert.deepEqual(new SessionStore(sb.sessionsDir).read(rec.sessionId)?.pendingFork, during.pendingFork, 'the same once the child is up');
      } finally {
        await closeAll(fork, chat);
      }
    });
  }

  it('importSessionExport of a pending fork (no transcript): pendingFork from the first write', async () => {
    const sb = sandbox();
    const env = { ...sb.env };
    const s = await open(sb, env);
    let imported: KiroSession | undefined;
    try {
      await drain(s.prompt({ text: 'one' }));
      await drain(s.prompt({ text: 'two' }));
      await s.rewind(1); // a pending fork: its own Claude id has no transcript yet
      const file = await s.exportTo(path.join(sb.root, 'exp.json'), true);
      const exp = JSON.parse(fs.readFileSync(file, 'utf8')) as { session: SessionRecord; claudeTranscript: string };
      assert.ok(exp.session.pendingFork, 'precondition: the export has a pendingFork');
      assert.equal(exp.claudeTranscript, '', 'precondition: the export has no transcript');
      const before = known(sb);
      const slow = { ...env, FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 1500 }) };
      const importOpts: KiroSessionInternalOptions = { ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env: slow };
      const p = importSessionExport(file, importOpts);
      const rec = await newRecord(sb, before);
      await sleep(200);
      const during = new SessionStore(sb.sessionsDir).read(rec.sessionId)!;
      imported = await p;
      assert.deepEqual(during.pendingFork, exp.session.pendingFork, `the fork still to be made, on disk while the child starts (turns ${during.turns.length})`);
      assert.deepEqual(new SessionStore(sb.sessionsDir).read(rec.sessionId)?.pendingFork, during.pendingFork, 'the same once the child is up');
    } finally {
      await closeAll(imported, s);
    }
  });

  it('importSessionExport of an export without a transcript whose Claude session still exists: pendingFork at its last turn from the first write', async () => {
    const sb = sandbox();
    const env = { ...sb.env };
    const s = await open(sb, env);
    let imported: KiroSession | undefined;
    try {
      await drain(s.prompt({ text: 'one' }));
      await drain(s.prompt({ text: 'two' }));
      const file = await s.exportTo(path.join(sb.root, 'exp.json'), true);
      const exp = JSON.parse(fs.readFileSync(file, 'utf8')) as { session: SessionRecord; claudeTranscript: string };
      // the transcript left out of the file (an export made where Claude had none), still on disk here
      fs.writeFileSync(file, JSON.stringify({ ...exp, claudeTranscript: '' }));
      const before = known(sb);
      const slow = { ...env, FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 1500 }) };
      const importOpts: KiroSessionInternalOptions = { ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env: slow };
      const p = importSessionExport(file, importOpts);
      const rec = await newRecord(sb, before);
      await sleep(200);
      const during = new SessionStore(sb.sessionsDir).read(rec.sessionId)!;
      imported = await p;
      assert.deepEqual(during.pendingFork, { from: s.claudeSessionId!, at: s.record.turns[1]!.assistantUuid! }, 'the fork of the exported session at its last turn');
      assert.deepEqual(new SessionStore(sb.sessionsDir).read(rec.sessionId)?.pendingFork, during.pendingFork, 'the same once the child is up');
    } finally {
      await closeAll(imported, s);
    }
  });
});

// ── a real crash while the fork's child starts, then `chat --no-interactive --resume` ──

const moduleUrl = (rel: string): string => new URL(rel, import.meta.url).href;

type CrashKind = 'create-repl' | 'create-spec' | 'import';

/** A child node process makes the fork record and SIGKILLs itself while that record's Claude child initializes. */
function crashDuringForkStart(sb: Sandbox, kind: CrashKind): { chatClaude: string; forkId?: string; onDisk?: SessionRecord } {
  const outFile = path.join(sb.root, 'out.json');
  const code = `
    import * as fs from 'node:fs';
    import * as path from 'node:path';
    const { KiroSessionImpl, importSessionExport } = await import(${JSON.stringify(moduleUrl('../../src/session/kiroSession.js'))});
    const { SessionStore } = await import(${JSON.stringify(moduleUrl('../../src/session/store.js'))});
    const { createWorkspaceContext } = await import(${JSON.stringify(moduleUrl('../../src/config/workspace.js'))});
    const { fakeBinary, fakeCaps, recordingUI, drain } = await import(${JSON.stringify(moduleUrl('./helpers.js'))});
    const cfg = JSON.parse(process.env.R8F_CFG);
    const env = { ...process.env };
    const ws = createWorkspaceContext(cfg.cwd, env);
    const caps = await fakeCaps();
    const chat = await KiroSessionImpl.create({ ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env });
    await drain(chat.prompt({ text: 'one' }));
    await drain(chat.prompt({ text: 'two' }));
    const out = { chatClaude: chat.claudeSessionId };
    const store = new SessionStore(cfg.sessionsDir);
    let file;
    if (cfg.kind === 'import') {
      await chat.rewind(1);
      file = await chat.exportTo(path.join(cfg.root, 'exp.json'), true);
    }
    const known = new Set(store.list({ cwd: ws.cwd }).map((r) => r.sessionId));
    const slow = { ...env, FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 3000 }) };
    const base = { ws, interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env: slow };
    if (cfg.kind === 'import') void importSessionExport(file, { ...base, origin: 'repl' }).catch(() => {});
    else void KiroSessionImpl.create({ ...base, origin: cfg.kind === 'create-spec' ? 'spec' : 'repl', fork: { fromClaudeSessionId: chat.claudeSessionId, kind: 'main', parentId: chat.id } }).catch(() => {});
    for (let i = 0; i < 400 && !out.forkId; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const r = store.list({ cwd: ws.cwd }).find((x) => !known.has(x.sessionId));
      if (r) out.forkId = r.sessionId;
    }
    await new Promise((r) => setTimeout(r, 500));
    out.onDisk = store.read(out.forkId);
    fs.writeFileSync(cfg.outFile, JSON.stringify(out));
    process.kill(process.pid, 'SIGKILL');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...sb.env, KIRO_CLAUDE_FAKE: fakeClaudePath(), R8F_CFG: JSON.stringify({ cwd: sb.cwd, root: sb.root, sessionsDir: sb.sessionsDir, outFile, kind }) },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.signal, 'SIGKILL', `the child did not crash as planned: status ${r.status}, stderr ${r.stderr}`);
  return JSON.parse(fs.readFileSync(outFile, 'utf8')) as { chatClaude: string; forkId?: string; onDisk?: SessionRecord };
}

describe('r8 #7: a crash while the fork record\'s Claude child starts, then chat --no-interactive --resume', () => {
  const cases: { kind: CrashKind; what: string; turns: number; hist: string }[] = [
    { kind: 'create-repl', what: 'create({ fork }) of a /spec continuation (origin repl)', turns: 2, hist: 'one | two | three' },
    { kind: 'create-spec', what: 'create({ fork }) of a /spec phase session (origin spec)', turns: 2, hist: 'one | two | three' },
    { kind: 'import', what: '/chat load of an export without a transcript (mode fork)', turns: 1, hist: 'one | three' },
  ];
  for (const c of cases) {
    it(`${c.what}: the resume forks the source again, no journal fallback`, async () => {
      const sb = sandbox();
      const out = crashDuringForkStart(sb, c.kind);
      assert.ok(out.forkId && out.onDisk, 'precondition: the fork record was written before the crash');
      assert.equal(out.onDisk.turns.length, c.turns, 'precondition: the fork record carries the turns');
      assert.equal(new SessionStore(sb.sessionsDir).latestResumable(sb.cwd)?.sessionId, out.forkId, 'precondition: chat --resume opens the fork record');
      const ui = recordingUI();
      const s = await open(sb, sb.env, { interactive: false, resume: { latest: true } }, ui);
      try {
        assert.equal(s.id, out.forkId);
        const { result } = await drain(s.prompt({ text: 'three' }));
        const last = sb.starts().at(-1)!;
        assert.ok(
          !ui.notices.some((n) => FALLBACK.test(n.message)),
          `pendingFork on disk during the start: ${JSON.stringify(out.onDisk.pendingFork)}; the resume fell back on the journal: ${JSON.stringify(ui.notices)}`,
        );
        assert.ok(last.includes('--fork-session') && last.includes(out.chatClaude), `the resume did not fork the source again: ${JSON.stringify(last)}`);
        assert.equal(result.text, `HIST[${c.hist}]`, 'the forked conversation, not the journal as text history');
      } finally {
        await closeAll(s);
      }
    });
  }
});
