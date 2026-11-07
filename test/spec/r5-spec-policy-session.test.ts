/**
 * Round 5, group spec-policy, T1 (session half): KiroSessionOptions.initialTrust over the real
 * KiroSessionImpl and the fake claude. A session that continues a chat (a /spec phase session, the
 * continuation, a task session, the REPL's forced-stop restart) starts from the chat's trust as it
 * is: the launch `--trust-tools` / `--trust-all-tools` are not applied again (they would re-trust a
 * tool the user untrusted), a resumed record's own trust is replaced, and per-tool trust given
 * under another agent is parked under `byAgent` (Q keeps per-agent trust).
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionTrust } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, type Sandbox } from '../session/helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

function open(sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}): Promise<KiroSessionImpl> {
  return KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env: sb.env, ...over });
}

const SCRIPT = { turns: [], default: { steps: [{ text: 'ok' }] } };

/** A V2 agent whose allowedTools grants shell; the user revoked it (`/tools untrust shell`). */
function chatTrust(): SessionTrust {
  return {
    trustAll: false,
    allowedTools: ['fs_write'],
    rules: [{ capability: 'fs_write', effect: 'allow', scope: 'session' }],
    revokedTools: ['execute_bash'],
    byAgent: { reviewer: { allowedTools: ['@git/status'], rules: [] } },
  };
}

const permission = (s: KiroSessionImpl, name: string): string | undefined => s.toolListing().find((t) => t.name === name)?.permission;

test('r5 T1: initialTrust replaces the launch --trust-tools / --trust-all-tools; the gate honours its revocations', async () => {
  const sb = mkSandbox({ script: SCRIPT });
  sb.agent('dev', { description: 'dev', tools: ['*'], allowedTools: ['shell'] });
  let control: KiroSessionImpl | undefined;
  let s: KiroSessionImpl | undefined;
  try {
    // control: the launch flags apply to a session without a snapshot
    control = await open(sb, { agentName: 'dev', trustTools: ['shell', 'read'] });
    assert.deepEqual(control.trust.allowedTools.sort(), ['execute_bash', 'fs_read']);
    await control.close();
    s = await open(sb, { agentName: 'dev', trustTools: ['shell', 'read'], trustAllTools: true, initialTrust: { trust: chatTrust(), agent: 'dev' } });
    assert.deepEqual(s.trust, chatTrust(), 'the launch flags were applied over the chat\'s trust');
    assert.equal(permission(s, 'shell'), 'not trusted', 'a tool the user untrusted (revoked from the agent) is trusted again');
    assert.equal(permission(s, 'write'), 'trusted');
    // the record holds it too (a later resume of it, its continuation, an export)
    await drain(s.prompt({ text: 'hello' }));
    const rec = new SessionStore(sb.sessionsDir).read(s.id)!;
    assert.deepEqual(rec.trust, chatTrust());
  } finally {
    await closeAll(control, s);
    fs.rmSync(sb.root, { recursive: true, force: true });
  }
});

test('r5 T1: a snapshot taken under another agent is parked under byAgent; a resumed record\'s own trust is replaced, trust-all included', async () => {
  const sb = mkSandbox({ script: SCRIPT });
  sb.agent('dev', { description: 'dev', tools: ['*'] });
  let a: KiroSessionImpl | undefined;
  let b: KiroSessionImpl | undefined;
  try {
    const snap = chatTrust();
    snap.byAgent = { dev: { allowedTools: ['execute_bash'], rules: [] } };
    a = await open(sb, { agentName: 'dev', initialTrust: { trust: snap, agent: 'kiro_default' } });
    assert.deepEqual(a.trust.allowedTools, ['execute_bash'], 'the session agent\'s own entry is the flat one');
    assert.deepEqual(a.trust.byAgent?.kiro_default?.allowedTools, ['fs_write'], 'the snapshot agent\'s trust is parked');
    assert.deepEqual(a.trust.byAgent?.kiro_default?.revokedTools, ['execute_bash']);
    // the snapshot is copied: changing it later does not reach the session
    snap.allowedTools.push('later');
    assert.ok(!JSON.stringify(a.trust).includes('later'));
    await drain(a.prompt({ text: 'hello' }));
    a.trustTools(['grep']);
    await a.close();
    // the forced-stop restart resumes the record with the trust the chat had (trust-all on, a
    // revocation made after the record was last saved) instead of the record's
    const now: SessionTrust = { trustAll: true, allowedTools: [], rules: [], revokedTools: ['fs_write'] };
    b = await open(sb, { agentName: 'dev', resume: { sessionId: a.id }, initialTrust: { trust: now, agent: 'dev' } });
    assert.equal(b.id, a.id);
    assert.equal(b.trust.trustAll, true, 'trust-all of the chat (same invocation) was dropped');
    assert.deepEqual(b.trust.allowedTools, []);
    assert.deepEqual(b.trust.revokedTools, ['fs_write']);
  } finally {
    await closeAll(a, b);
    fs.rmSync(sb.root, { recursive: true, force: true });
  }
});
