/**
 * r12g S1 (session group), over ACP: `session/load` of a session whose lock a hung-up holder holds
 * (stopped with SIGHUP pending: r12 #1 continues it and waits for its close) answers with what that
 * holder saved at its close: the agent (currentModeId), the effort and the turns. loadFresh read the
 * record (agent, model, effort) before the session took the lock, so the answer and the started
 * child used the stale copy, and the session's next save dropped the holder's last turn.
 *
 * The holder is a child that takes the lock through the store and, at SIGHUP, saves the record
 * changed as given (as the chat's close saves it), releases the lock and exits; TMPDIR in the
 * test's temp dir; killed by the test should it outlive it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TestClient, tmpEnv, writeAgent, type TmpEnv } from './helpers.js';
import { HOLDER, LINUX, STORE_URL, killChildren, runNode, stopThenHangUp } from '../session/r12g-session-helpers.js';

const skip = LINUX ? false : 'needs Linux /proc';
const clients: TestClient[] = [];
after(async () => {
  killChildren();
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(10_000)));
});

/** A saved ACP session (one finished turn), its client closed; agent `other` exists. */
async function savedSession(): Promise<{ t: TmpEnv; sid: string; dir: string }> {
  const t = tmpEnv();
  writeAgent(t.kiroHome, 'other', { description: 'another agent', tools: ['read'] });
  const c = new TestClient({ env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)).sessionId as string;
  const r = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hello' }] }, 60_000);
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  assert.equal(await c.close(20_000), 0);
  const dir = path.join(t.kiroHome, 'sessions', 'cli');
  assert.equal(fs.existsSync(path.join(dir, `${sid}.lock`)), false);
  return { t, sid, dir };
}

const load = (c: TestClient, t: TmpEnv, sid: string, dir: string) =>
  c.request('session/load', { sessionId: sid, cwd: t.work, mcpServers: [], _meta: { '_kiro.dev/session_file': path.join(dir, `${sid}.json`) } }, 60_000);

interface Rec {
  agent: string;
  effort?: string;
  turns: { preview: string }[];
}
const record = (dir: string, sid: string): Rec => JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8')) as Rec;

test('session/load after a hung-up holder answers with the agent, effort and turns that holder saved at its close', { skip }, async () => {
  const { t, sid, dir } = await savedSession();
  assert.equal(record(dir, sid).agent, 'kiro_default');
  const change = { set: { agent: 'other', effort: 'high' }, turn: { userUuid: randomUUID(), preview: 'slow task', at: new Date().toISOString() } };
  const h = await runNode(t.root, t.env.TMPDIR!, HOLDER, [STORE_URL, dir, sid, 'release', JSON.stringify(change)], { ready: true });
  await stopThenHangUp(h.pid);
  const c = new TestClient({ env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const r = await load(c, t, sid, dir);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(await h.exit, { code: 0, signal: null }, 'the holder ran its own SIGHUP close');
  assert.equal(r.result?.modes?.currentModeId, 'other', JSON.stringify(r.result?.modes));
  const effort = (r.result?.configOptions as { id: string; currentValue: string }[]).find((o) => o.id === 'effortLevel');
  assert.equal(effort?.currentValue, 'high');
  const p = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'again' }] }, 60_000);
  assert.equal(p.result?.stopReason, 'end_turn', JSON.stringify(p));
  const rec = record(dir, sid);
  assert.deepEqual(rec.turns.map((x) => x.preview), ['hello', 'slow task', 'again']);
  assert.deepEqual([rec.agent, rec.effort], ['other', 'high']);
  assert.equal(await c.close(20_000), 0);
});

test('control: session/load with no holder answers with the saved agent and turns as before', { skip }, async () => {
  const { t, sid, dir } = await savedSession();
  const c = new TestClient({ env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const r = await load(c, t, sid, dir);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.result?.modes?.currentModeId, 'kiro_default');
  assert.equal(fs.existsSync(path.join(dir, `${sid}.lock`)), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${sid}.lock`), 'utf8')).pid, process.pid);
  assert.equal(await c.close(20_000), 0);
  assert.deepEqual(record(dir, sid).turns.map((x) => x.preview), ['hello']);
});
