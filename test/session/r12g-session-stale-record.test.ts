/**
 * r12g S1 (session group): an open that took the lock from a hung-up holder it continued (r12 #1,
 * session/store.ts "Hung-up holder") works from the record as that holder saved it at its close,
 * not from the copy it read before it took the lock. KiroSessionImpl.build read the record and
 * derived the launch mode, the agent, the effort and the trust BEFORE acquireLock; whatever the
 * continued holder then saved at its close (the turn it was running, settled as interrupted; plan
 * mode; trust it narrowed; the agent and effort) was overwritten by the open's next save, and when
 * the holder's first turn was the one in progress the open launched Claude as a new session.
 *
 * The holder is a real child process that takes the lock through the store and, at SIGHUP, saves
 * the record changed the way the chat's close saves it, then releases the lock and exits; it is
 * stopped (SIGSTOP) and then sent SIGHUP while stopped (what sudo with `use_pty` leaves when the
 * terminal of a stopped chat closes). The opener is a session of this process over the fake claude.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, type Sandbox } from './helpers.js';
import { HOLDER, LINUX, STORE_URL, killChildren, runNode, stopThenHangUp } from './r12g-session-helpers.js';

const skip = LINUX ? false : 'needs Linux /proc';
const fsCjs = createRequire(import.meta.url)('node:fs') as typeof fs;
let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});
after(killChildren);

const SCRIPT = { default: { steps: [{ text: 'ANSWER to {{userText}}' }] } };

function sandbox(): Sandbox {
  const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
  sb.agent('other', { description: 'another agent', tools: ['read'] });
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

/** A saved conversation with one finished turn (its Claude transcript exists). */
async function saved(sb: Sandbox): Promise<string> {
  const s = await open(sb);
  try {
    await drain(s.prompt({ text: 'first' }));
  } finally {
    await closeAll(s);
  }
  return s.id;
}

/** Overwrite fields of the record on disk (what it held before the holder's close). */
function edit(sb: Sandbox, id: string, f: (r: SessionRecord) => void): void {
  const r = read(sb, id);
  f(r);
  store(sb).write(r);
}

/** The holder of `id`'s lock, which saves `change` at its close; stopped, then SIGHUP while stopped. */
async function hungUpHolder(sb: Sandbox, id: string, change: unknown, mode: 'release' | 'die' = 'release') {
  const h = await runNode(sb.root, path.join(sb.root, 'tmp'), HOLDER, [STORE_URL, sb.sessionsDir, id, mode, JSON.stringify(change)], { ready: true });
  await stopThenHangUp(h.pid);
  return h;
}

const turn = (preview: string) => ({ userUuid: randomUUID(), preview, at: new Date().toISOString() });
const previews = (r: SessionRecord): string[] => r.turns.map((t) => t.preview);

describe('r12g S1: an open that continued a hung-up holder uses the record the holder saved at its close', { skip }, () => {
  it('the turn the holder was running (saved at its close) is kept, and the next turn follows it', async () => {
    const sb = sandbox();
    const id = await saved(sb);
    const h = await hungUpHolder(sb, id, { turn: turn('slow task'), set: { lastPreview: 'working on it' } });
    const before = sb.starts().length;
    const s = await open(sb, { resume: { sessionId: id } });
    try {
      assert.deepEqual(await h.exit, { code: 0, signal: null }, 'the holder ran its own SIGHUP close');
      assert.deepEqual(previews(s.record), ['first', 'slow task']);
      await drain(s.prompt({ text: 'again' }));
      const r = read(sb, id);
      assert.deepEqual(previews(r), ['first', 'slow task', 'again']);
      assert.equal(r.messageCount, 3);
      const first = sb.starts()[before]!;
      assert.equal(flagValue(first, '--resume'), r.claudeSessionId, first.join(' '));
    } finally {
      await closeAll(s);
    }
  });

  it("the holder's first turn was the one in progress: title, messageCount and a resume of its Claude session", async () => {
    const sb = sandbox();
    const id = await saved(sb);
    // before its close the record has no turn yet (its first one is running): a new session's
    edit(sb, id, (r) => {
      r.turns = [];
      r.messageCount = 0;
      r.title = '';
      r.lastPreview = '';
    });
    const h = await hungUpHolder(sb, id, { turn: turn('first') });
    const before = sb.starts().length;
    const s = await open(sb, { resume: { sessionId: id } });
    try {
      assert.deepEqual(await h.exit, { code: 0, signal: null });
      const starts = sb.starts().slice(before);
      // launched as a resume of the holder's Claude session at once: never as a new one (which
      // Claude refuses with 'already in use' and the session then retries as a resume)
      assert.equal(flagValue(starts[0]!, '--resume'), id, starts[0]!.join(' '));
      assert.equal(flagValue(starts[0]!, '--session-id'), undefined, starts[0]!.join(' '));
      assert.equal(starts.length, 1, 'one launch');
      await drain(s.prompt({ text: 'again' }));
      const r = read(sb, id);
      assert.deepEqual(previews(r), ['first', 'again']);
      assert.equal(r.title, 'first');
      assert.equal(r.messageCount, 2);
    } finally {
      await closeAll(s);
    }
  });

  it("the holder's saved trust, plan mode, agent and effort win over the opener's copy (never wider)", async () => {
    const sb = sandbox();
    const id = await saved(sb);
    edit(sb, id, (r) => {
      r.trust.allowedTools = ['fs_write', 'execute_bash'];
    });
    const h = await hungUpHolder(sb, id, {
      turn: turn('slow task'),
      set: { planMode: true, agent: 'other', effort: 'high', trust: { trustAll: false, allowedTools: ['execute_bash'], rules: [], revokedTools: [] } },
    });
    const s = await open(sb, { resume: { sessionId: id } });
    try {
      assert.deepEqual(await h.exit, { code: 0, signal: null });
      assert.equal(s.agent.name, 'other');
      assert.equal(s.effort, 'high');
      assert.equal(s.planMode, true, 'plan mode the holder saved');
      assert.deepEqual(s.trust.allowedTools, ['execute_bash'], 'fs_write is no longer trusted: the holder untrusted it');
      await drain(s.prompt({ text: 'again' }));
      const r = read(sb, id);
      assert.deepEqual(previews(r), ['first', 'slow task', 'again']);
      assert.deepEqual([r.agent, r.effort, r.planMode, r.trust.allowedTools], ['other', 'high', true, ['execute_bash']]);
    } finally {
      await closeAll(s);
    }
  });

  it('trust-all the holder saved is still per invocation: the opener without --trust-all-tools does not get it', async () => {
    const sb = sandbox();
    const id = await saved(sb);
    const h = await hungUpHolder(sb, id, { turn: turn('slow task'), set: { trust: { trustAll: true, allowedTools: [], rules: [] } } });
    const s = await open(sb, { resume: { sessionId: id } });
    try {
      assert.deepEqual(await h.exit, { code: 0, signal: null });
      assert.equal(s.trust.trustAll, false);
      assert.deepEqual(previews(s.record), ['first', 'slow task']);
    } finally {
      await closeAll(s);
    }
  });

  it("the opener's own options still win over the record (an explicit agent and effort)", async () => {
    const sb = sandbox();
    const id = await saved(sb);
    const h = await hungUpHolder(sb, id, { turn: turn('slow task'), set: { agent: 'other', effort: 'high' } });
    const s = await open(sb, { resume: { sessionId: id }, agentName: 'kiro_default', effort: 'low' });
    try {
      assert.deepEqual(await h.exit, { code: 0, signal: null });
      assert.equal(s.agent.name, 'kiro_default');
      assert.equal(s.effort, 'low');
      assert.deepEqual(previews(s.record), ['first', 'slow task']);
    } finally {
      await closeAll(s);
    }
  });

  it("`chat --resume` (latest): the record re-read is the holder's too", async () => {
    const sb = sandbox();
    const id = await saved(sb);
    const h = await hungUpHolder(sb, id, { turn: turn('slow task') });
    const s = await open(sb, { resume: { latest: true } });
    try {
      assert.deepEqual(await h.exit, { code: 0, signal: null });
      assert.equal(s.id, id);
      assert.deepEqual(previews(s.record), ['first', 'slow task']);
    } finally {
      await closeAll(s);
    }
  });

  it('a holder that leaves its lock when it exits (close grace ran out) after saving: its record is used', async () => {
    const sb = sandbox();
    const id = await saved(sb);
    const h = await hungUpHolder(sb, id, { turn: turn('slow task') }, 'die');
    const s = await open(sb, { resume: { sessionId: id } });
    try {
      assert.deepEqual(await h.exit, { code: 0, signal: null });
      assert.deepEqual(previews(s.record), ['first', 'slow task']);
    } finally {
      await closeAll(s);
    }
  });

  it('a record the holder dropped at its close (a chat that never had a message): the open goes on with its own copy', async () => {
    const sb = sandbox();
    const id = await saved(sb);
    edit(sb, id, (r) => {
      r.turns = [];
      r.messageCount = 0;
      r.title = '';
    });
    const h = await hungUpHolder(sb, id, { drop: true });
    const s = await open(sb, { resume: { sessionId: id } });
    try {
      assert.deepEqual(await h.exit, { code: 0, signal: null });
      assert.equal(s.id, id);
      await drain(s.prompt({ text: 'again' }));
      assert.deepEqual(previews(read(sb, id)), ['again']);
    } finally {
      await closeAll(s);
    }
  });

  it('a holder that closed normally between the read and the lock (no hung-up holder): its save is used too', async () => {
    const sb = sandbox();
    const id = await saved(sb);
    const lockPath = path.join(sb.sessionsDir, `${id}.lock`);
    // right before the open's exclusive create of the lock, another process saves the record
    const orig = fsCjs.linkSync;
    let fired = false;
    fsCjs.linkSync = (a: fs.PathLike, b: fs.PathLike): void => {
      if (!fired && String(b) === lockPath) {
        fired = true;
        edit(sb, id, (r) => {
          r.turns.push(turn('slow task'));
          r.messageCount += 1;
          r.effort = 'high';
        });
      }
      orig(a, b);
    };
    syncBuiltinESMExports();
    let s: KiroSessionImpl | undefined;
    try {
      s = await open(sb, { resume: { sessionId: id } });
    } finally {
      fsCjs.linkSync = orig;
      syncBuiltinESMExports();
    }
    try {
      assert.ok(fired);
      assert.deepEqual(previews(s.record), ['first', 'slow task']);
      assert.equal(s.effort, 'high');
    } finally {
      await closeAll(s);
    }
  });

  it('control: a plain resume (no holder) is unchanged', async () => {
    const sb = sandbox();
    const id = await saved(sb);
    const s = await open(sb, { resume: { sessionId: id } });
    try {
      assert.deepEqual(previews(s.record), ['first']);
      await drain(s.prompt({ text: 'again' }));
      assert.deepEqual(previews(read(sb, id)), ['first', 'again']);
    } finally {
      await closeAll(s);
    }
  });
});
