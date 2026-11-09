/**
 * r12h H1 (repl group), session half: `KiroSessionInternalOptions.resumeDefaults`. The REPL's
 * `/chat resume` and its forced-stop restart reopen a saved record by id with the agent, model and
 * effort they read BEFORE the session's lock was taken (the list the user picked from, which can be
 * open for any time; the stopped session's own). As explicit options those won over the record that
 * KiroSessionImpl.build reads again under the lock (r12g S1), so a holder that saved others in the
 * meantime and closed (a chat in another terminal that swapped to a more restrictive agent) had
 * its choice undone by the open's next save. With `resumeDefaults` they are defaults: the record as
 * read under the lock wins, as for `chat --resume-id` without `--agent` / `--model` / `--effort`,
 * and each applies only to what the record does not name (the chat's effort for a record with
 * none). Without it, explicit options still win (`chat --resume-id --agent …`, ACP `loadFresh`).
 *
 * Sessions of this process over the fake claude; the hung-up holder (a real child process that
 * saves the record at its close) is the r12g helper's.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, type Sandbox } from './helpers.js';
import { HOLDER, LINUX, STORE_URL, killChildren, runNode, stopThenHangUp } from './r12g-session-helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});
after(killChildren);

const SCRIPT = { default: { steps: [{ text: 'ANSWER to {{userText}}' }] } };

function sandbox(): Sandbox {
  const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
  sb.agent('bee', { description: 'the agent the list showed', tools: ['*'] });
  sb.agent('wasp', { description: 'the agent the holder swapped to', tools: ['read'] });
  sb.refresh();
  fs.mkdirSync(path.join(sb.root, 'tmp'), { recursive: true });
  return sb;
}

const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env: sb.env, ...over });

const store = (sb: Sandbox): SessionStore => new SessionStore(sb.sessionsDir);
const read = (sb: Sandbox, id: string): SessionRecord => {
  const r = store(sb).read(id);
  assert.ok(r, `record ${id} exists`);
  return r;
};

/** A saved conversation of agent `bee` on sonnet, no effort, with one finished turn. */
async function saved(sb: Sandbox): Promise<string> {
  const s = await open(sb, { agentName: 'bee', model: 'claude-sonnet-4.5' });
  try {
    await drain(s.prompt({ text: 'first' }));
  } finally {
    await closeAll(s);
  }
  const r = read(sb, s.id);
  assert.equal(r.agent, 'bee', 'precondition');
  assert.equal(r.effort, undefined, 'precondition: the record has no effort');
  return s.id;
}

/** What a holder in another process saved at its close (the record on disk changed, no lock). */
function holderSaved(sb: Sandbox, id: string, f: (r: SessionRecord) => void): void {
  const r = read(sb, id);
  f(r);
  store(sb).write(r);
}

/** The --model / --effort of the last Claude Code started. */
function lastStart(sb: Sandbox): { model: string | undefined; effort: string | undefined } {
  const argv = sb.starts().at(-1)!;
  return { model: flagValue(argv, '--model'), effort: flagValue(argv, '--effort') };
}

/** What the REPL passes for `/chat resume`: the listed record's agent and model, the chat's effort. */
const AS_LISTED = { agentName: 'bee', model: 'claude-sonnet-4.5', effort: 'high' } as const;

describe('r12h: resumeDefaults (the REPL\'s /chat resume and forced-stop restart)', () => {
  it('the agent, model and effort the record has when its lock is taken win over the ones read before', async () => {
    const sb = sandbox();
    const id = await saved(sb);
    const sonnet = lastStart(sb).model;
    holderSaved(sb, id, (r) => {
      r.agent = 'wasp';
      r.model = 'claude-opus-4.7';
      r.effort = 'low';
    });
    const s = await open(sb, { ...AS_LISTED, resume: { sessionId: id }, resumeDefaults: true });
    try {
      assert.equal(s.agent.name, 'wasp', 'the agent the holder swapped to');
      assert.equal(s.model, 'claude-opus-4.7');
      assert.equal(s.effort, 'low');
      const started = lastStart(sb);
      assert.notEqual(started.model, sonnet, `Claude Code started on the model read before the lock: ${started.model}`);
      assert.match(started.model ?? '', /opus-4-7/);
      assert.equal(started.effort, 'low');
      await drain(s.prompt({ text: 'second' }));
    } finally {
      await closeAll(s);
    }
    const after = read(sb, id);
    assert.equal(after.agent, 'wasp', 'the open saved the agent read before the lock over the holder\'s');
    assert.equal(after.model, 'claude-opus-4.7');
    assert.equal(after.effort, 'low');
    assert.deepEqual(after.turns.map((t) => t.preview), ['first', 'second']);
  });

  it('a record with no effort runs at the default effort given (the chat\'s), not the model\'s default', async () => {
    const sb = sandbox();
    const id = await saved(sb);
    const s = await open(sb, { ...AS_LISTED, resume: { sessionId: id }, resumeDefaults: true });
    try {
      assert.equal(s.agent.name, 'bee');
      assert.equal(s.effort, 'high');
      assert.equal(lastStart(sb).effort, 'high');
    } finally {
      await closeAll(s);
    }
    assert.equal(read(sb, id).effort, 'high');
  });

  it('control: without resumeDefaults the options are explicit and win (`chat --resume-id --agent --model --effort`)', async () => {
    const sb = sandbox();
    const id = await saved(sb);
    holderSaved(sb, id, (r) => {
      r.agent = 'wasp';
      r.model = 'claude-opus-4.7';
      r.effort = 'low';
    });
    const s = await open(sb, { ...AS_LISTED, resume: { sessionId: id } });
    try {
      assert.equal(s.agent.name, 'bee');
      assert.equal(s.model, 'claude-sonnet-4.5');
      assert.equal(s.effort, 'high');
    } finally {
      await closeAll(s);
    }
  });

  it('trust: an initialTrust (the chat\'s, mapped from its agent) goes to the agent resolved under the lock', async () => {
    const sb = sandbox();
    const id = await saved(sb);
    holderSaved(sb, id, (r) => {
      r.agent = 'wasp';
    });
    const chatTrust = { trustAll: false, allowedTools: ['shell'], rules: [], revokedTools: ['write'] };
    const s = await open(sb, { ...AS_LISTED, resume: { sessionId: id }, resumeDefaults: true, initialTrust: { trust: chatTrust, agent: 'kiro_default' } });
    try {
      assert.equal(s.agent.name, 'wasp');
      // the chat's per-tool trust belongs to its own agent: parked there, not given to wasp
      assert.deepEqual(s.trust.allowedTools, []);
      assert.deepEqual(s.trust.byAgent?.kiro_default?.allowedTools, ['shell']);
    } finally {
      await closeAll(s);
    }
  });

  it('a hung-up holder continued by the open saves another agent and effort at its close: the open runs those', { skip: LINUX ? false : 'needs Linux /proc' }, async () => {
    const sb = sandbox();
    const id = await saved(sb);
    const h = await runNode(sb.root, path.join(sb.root, 'tmp'), HOLDER, [STORE_URL, sb.sessionsDir, id, 'release', JSON.stringify({ set: { agent: 'wasp', effort: 'low' } })], { ready: true });
    await stopThenHangUp(h.pid);
    const s = await open(sb, { ...AS_LISTED, resume: { sessionId: id }, resumeDefaults: true });
    try {
      assert.deepEqual(await h.exit, { code: 0, signal: null });
      assert.equal(s.agent.name, 'wasp');
      assert.equal(s.effort, 'low');
    } finally {
      await closeAll(s);
    }
    assert.equal(read(sb, id).agent, 'wasp');
  });
});
