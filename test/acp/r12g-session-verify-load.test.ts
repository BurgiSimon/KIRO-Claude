/**
 * r12g S1 verification (session group), over ACP: `session/load` turns the record's agent, model
 * and effort into the session's options, so it must read them under the session's lock. loadFresh
 * took the lock first only when, at its look, another live process held it; with no lock on disk it
 * read the record unlocked, and a process that opened the session, changed its agent and effort
 * and closed it before the session's own lock was taken had those overwritten: the session ran
 * the agent read before (the record's later save wrote it back), whatever that process saved.
 *
 * Deterministic: the ACP server runs in this process; a hook on node:fs (`syncBuiltinESMExports`)
 * holds this thread right after the load's first read of the record while a real child process
 * opens the session through the store, saves agent `other` and effort `high`, and closes it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';

import { TestClient, tmpEnv, writeAgent, type TmpEnv } from './helpers.js';
import { LINUX, STORE_URL, killChildren, spawnDetached, waitForFileSync } from '../session/r12g-session-helpers.js';

const skip = LINUX ? false : 'needs Linux /proc';
const fsCjs = createRequire(import.meta.url)('node:fs') as typeof fs;
const clients: TestClient[] = [];
after(async () => {
  killChildren();
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(10_000)));
});

/** Opens the session through the store, saves `set` on its record, closes it; `DONE` or `ERR <message>`. */
const OTHER_OPEN = `const [storeUrl, dir, id, set, resultFile] = process.argv.slice(2);
const { SessionStore } = await import(storeUrl);
const fs = await import('node:fs');
const store = new SessionStore(dir);
try {
  const lock = store.acquireLock(id);
  const rec = store.read(id);
  Object.assign(rec, JSON.parse(set));
  store.write(rec);
  lock.release();
  fs.writeFileSync(resultFile, 'DONE');
} catch (e) {
  fs.writeFileSync(resultFile, 'ERR ' + e.message);
}
`;

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
  return { t, sid, dir: path.join(t.kiroHome, 'sessions', 'cli') };
}

test('session/load with no lock on disk: what another process saved before the session took the lock is what it runs', { skip }, async () => {
  const { t, sid, dir } = await savedSession();
  const recPath = path.join(dir, `${sid}.json`);
  const c = new TestClient({ env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  let other: string | undefined;
  const orig = fsCjs.readFileSync;
  let armed = true;
  fsCjs.readFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const out = (orig as (...a: unknown[]) => unknown)(p, ...rest);
    if (armed && typeof p === 'string' && p === recPath) {
      armed = false;
      const file = path.join(t.root, 'other.result');
      spawnDetached(t.root, t.env.TMPDIR!, OTHER_OPEN, [STORE_URL, dir, sid, JSON.stringify({ agent: 'other', effort: 'high' }), file]);
      other = waitForFileSync(file, 20_000);
    }
    return out;
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  let r: Awaited<ReturnType<TestClient['request']>>;
  try {
    r = await c.request('session/load', { sessionId: sid, cwd: t.work, mcpServers: [] }, 60_000);
  } finally {
    fsCjs.readFileSync = orig;
    syncBuiltinESMExports();
  }
  assert.equal(armed, false, 'the load read the record (the hook ran)');
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const effort = (r.result?.configOptions as { id: string; currentValue: string }[]).find((o) => o.id === 'effortLevel')?.currentValue;
  const mode = r.result?.modes?.currentModeId;
  if (other === 'DONE') {
    // it saved before the session's lock: the session runs what it saved
    assert.deepEqual([mode, effort], ['other', 'high'], `the other process saved agent other, effort high (${other})`);
  } else {
    // refused: the load held the lock while it read
    assert.match(other ?? '', /^ERR Failed to start session: Session is active in another process/);
    assert.equal(mode, 'kiro_default');
  }
  assert.equal(await c.close(20_000), 0);
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8')) as { agent: string; effort?: string };
  assert.equal(rec.agent, mode, 'the record keeps the agent the session ran');
});
