/**
 * Round-7 residual (repl-trust verify gap): KiroSessionOptions.planMode, which `/chat new`,
 * `/chat load` and `/chat resume` pass from a chat in plan mode, is on the record before it is
 * first written. Plan mode used to be set only once create() had run the agentSpawn hooks and
 * started Claude Code, so a SIGKILL in that window left the new record on disk outside plan mode,
 * and `chat --resume` (it opens the newest record) ran it with edits allowed. A resumed record is
 * written only once its child is up (build), so a start that dies leaves it as it was.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, importSessionExport, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { KiroSession, SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = { default: { steps: [{ text: 'OK' }] } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const open = (sb: Sandbox, env: NodeJS.ProcessEnv, over: Partial<KiroSessionInternalOptions> = {}): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env, ...over });

/** The first record not in `known`, read from disk (the one being started). */
async function newRecord(sb: Sandbox, known: Set<string>): Promise<SessionRecord> {
  const store = new SessionStore(sb.sessionsDir);
  for (let i = 0; i < 400; i++) {
    const r = store.list({ cwd: sb.cwd }).find((x) => !known.has(x.sessionId));
    if (r) return r;
    await sleep(10);
  }
  assert.fail('no new record appeared');
}

const slowStart = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 1500 }) });

describe('r7g: KiroSessionOptions.planMode is on the record from its first write', () => {
  it('a new session (/chat new from plan mode): in plan mode on disk while its child starts', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const chat = await open(sb, sb.env);
    let next: KiroSessionImpl | undefined;
    try {
      const p = open(sb, slowStart(sb.env), { planMode: true });
      const rec = await newRecord(sb, new Set([chat.id]));
      next = await p;
      assert.equal(rec.planMode, true, 'the record was written outside plan mode while Claude Code started');
      assert.equal(next.planMode, true);
    } finally {
      await closeAll(next, chat);
    }
  });

  it('control: without the option a new session starts outside plan mode', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb, sb.env);
    try {
      assert.equal(s.planMode, false);
      assert.equal(new SessionStore(sb.sessionsDir).read(s.id)?.planMode, false);
    } finally {
      await closeAll(s);
    }
  });

  it('an import (/chat load from plan mode): in plan mode on disk while its child starts', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb, sb.env);
    await drain(s.prompt({ text: 'remember ALPHA' }));
    await s.exportTo('saved.json', false);
    await s.close();
    let imported: KiroSession | undefined;
    try {
      const p = importSessionExport('saved.json', { ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), env: slowStart(sb.env), planMode: true });
      const rec = await newRecord(sb, new Set([s.id]));
      imported = await p;
      assert.equal(rec.turns.length, 1, 'the imported record (with its turn)');
      assert.equal(rec.planMode, true, 'the imported record was written outside plan mode while Claude Code started');
      assert.equal(imported.planMode, true);
    } finally {
      await closeAll(imported);
    }
  });

  it('a resume (/chat resume from plan mode): the saved record is untouched during the start, then in plan mode', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const old = await open(sb, sb.env);
    await drain(old.prompt({ text: 'one' }));
    const id = old.id;
    await old.close();
    const store = new SessionStore(sb.sessionsDir);
    assert.equal(store.read(id)?.planMode, false);
    const p = open(sb, slowStart(sb.env), { planMode: true, resume: { sessionId: id } });
    await sleep(500);
    assert.equal(store.read(id)?.planMode, false, 'a resume writes the saved record only once its child is up');
    const s = await p;
    try {
      assert.equal(s.planMode, true);
      assert.equal(store.read(id)?.planMode, true, 'written in plan mode once started');
    } finally {
      await closeAll(s);
    }
  });
});
