/**
 * r12g S2 verification (session group): the race-free stale-lock takeover (session/store.ts
 * "Stale-lock takeover") must not make a stale lock harder to take over than before.
 *
 * - A session id of the longest allowed length (200 characters, isSafeSessionId): the takeover
 *   claim's temp file (createExclusive) was `.<claim name>.<pid>.<random>.tmp`, longer than the
 *   255-byte file name limit, so the open threw ENAMETOOLONG instead of taking the stale lock over,
 *   and `store.delete` threw after removing the record, leaving the lock.
 * - Claims left by claimants that died in the middle of a takeover: past four of them in a row
 *   the walk gave up, and every later open of the session failed with 'could not acquire the
 *   session lock' for good (nobody ever got past them to remove the stale lock).
 * - An open waiting for another opener's claim polled by creating the claim again every 2 ms (a
 *   temp file written, linked and removed each time; one left behind by each SIGKILL that lands
 *   there): it now reads the claim and creates it only while it is absent.
 * - A lock of this process taken by another lock object of it (ACP loadFresh hands the lock it
 *   read the record under to the session it starts) went through the stale-lock takeover: the name
 *   was free for a moment between the removal and the create, and an open of another process that
 *   ran right then owned the session (the load failed with 'Session is active in another
 *   process'). It is now replaced in one step (a rename over it).
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { SessionStore, isSafeSessionId } from '../../src/session/store.js';
import { removeOnExit } from '../tmpdirs.js';
import { ACTIVE, LINUX, OPENER, STORE_URL, killChildren, runNode, spawnDetached, waitForFileSync } from './r12g-session-helpers.js';

const skip = LINUX ? false : 'needs Linux /proc';
after(killChildren);

const fsCjs = createRequire(import.meta.url)('node:fs') as typeof fs;
const ID = '12121212-1212-4121-8121-1212121212bb';

function tmp(): { root: string; dir: string; tmpdir: string } {
  const root = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r12g-vtake-'))));
  const dir = path.join(root, 'sessions');
  const tmpdir = path.join(root, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(tmpdir);
  return { root, dir, tmpdir };
}

async function deadPid(t: ReturnType<typeof tmp>): Promise<number> {
  const c = await runNode(t.root, t.tmpdir, 'process.exit(0);\n', []);
  await c.exit;
  return c.pid;
}

const staleText = (pid: number): string => `${JSON.stringify({ pid, started_at: new Date().toISOString(), host: os.hostname() })}\n`;
const key = (seed: string): string => createHash('sha256').update(seed).digest('hex').slice(0, 24);
const claimPath = (dir: string, id: string, k: string): string => path.join(dir, `.${id}.lock.takeover-${k}`);
const debris = (dir: string, id: string): string[] => fs.readdirSync(dir).filter((f) => f !== `${id}.lock` && f !== `${id}.json`);
const lockPid = (p: string): number | undefined => {
  try {
    return (JSON.parse(fs.readFileSync(p, 'utf8')) as { pid: number }).pid;
  } catch {
    return undefined;
  }
};

describe('r12g S2 verify: a stale lock is still taken over', { skip }, () => {
  it('of a session id of the longest allowed length (200 characters): the open and store.delete take it over', async () => {
    const t = tmp();
    const id = `a${'0'.repeat(199)}`;
    assert.ok(isSafeSessionId(id));
    const store = new SessionStore(t.dir);
    store.create({ sessionId: id, origin: 'repl', cwd: t.root, agent: 'kiro_default', model: 'auto' });
    fs.writeFileSync(store.lockPathFor(id), staleText(await deadPid(t)));
    const lock = store.acquireLock(id);
    assert.equal(lockPid(store.lockPathFor(id)), process.pid, 'the lock is ours');
    lock.release();
    assert.equal(fs.existsSync(store.lockPathFor(id)), false);
    fs.writeFileSync(store.lockPathFor(id), staleText(await deadPid(t)));
    assert.equal(store.delete(id), true);
    assert.equal(fs.existsSync(store.lockPathFor(id)), false, 'the stale lock went with the record');
    assert.deepEqual(debris(t.dir, id), []);
  });

  it('past more than four claims of claimants that died in the middle of a takeover, also later', async () => {
    const t = tmp();
    const store = new SessionStore(t.dir);
    const text = staleText(await deadPid(t));
    const lockPath = store.lockPathFor(ID);
    fs.writeFileSync(lockPath, text);
    // the chain every opener derives: claim k, then hash(k + that claim's text)
    let k = key(text);
    for (let i = 0; i < 6; i++) {
      const ct = staleText(await deadPid(t));
      fs.writeFileSync(claimPath(t.dir, ID, k), ct);
      k = key(`${k}\n${ct}`);
    }
    const lock = store.acquireLock(ID);
    assert.equal(lockPid(lockPath), process.pid);
    lock.release();
    assert.deepEqual(debris(t.dir, ID), [], 'the claims on the stale text went with it');
  });
});

/**
 * Run `inject` once, right after this process's first call that left the name `lockPath` free
 * (`unlinkSync(lockPath)` or `renameSync(lockPath, …)`), with this thread held there.
 */
function afterLockNameFreed(lockPath: string, inject: () => void): { restore(): void; fired(): boolean } {
  const orig = { unlinkSync: fsCjs.unlinkSync, renameSync: fsCjs.renameSync };
  let armed = true;
  const fire = (p: fs.PathLike): void => {
    if (armed && String(p) === lockPath) {
      armed = false;
      inject();
    }
  };
  fsCjs.unlinkSync = (p: fs.PathLike): void => {
    orig.unlinkSync(p);
    fire(p);
  };
  fsCjs.renameSync = (a: fs.PathLike, b: fs.PathLike): void => {
    orig.renameSync(a, b);
    fire(a);
  };
  syncBuiltinESMExports();
  return {
    restore() {
      fsCjs.unlinkSync = orig.unlinkSync;
      fsCjs.renameSync = orig.renameSync;
      syncBuiltinESMExports();
    },
    fired: () => !armed,
  };
}

describe('r12g S2 verify: a lock of this process handed to another lock object of it', { skip }, () => {
  it('(ACP loadFresh hands its lock to the session it starts) the name is never free: an open in between is refused', async () => {
    const t = tmp();
    const store = new SessionStore(t.dir);
    const lockPath = store.lockPathFor(ID);
    const pre = store.acquireLock(ID);
    const children: ReturnType<typeof spawnDetached>[] = [];
    /** Another process's whole open, its answer (`GOT` or `ERR <message>`). */
    const otherOpen = (name: string): string | undefined => {
      const file = path.join(t.root, `${name}.result`);
      children.push(spawnDetached(t.root, t.tmpdir, OPENER, [STORE_URL, t.dir, ID, '0', file]));
      return waitForFileSync(file, 20_000);
    };
    let during: string | undefined;
    // should the name be free for a moment while the lock changes hands, another open runs right then
    const hook = afterLockNameFreed(lockPath, () => (during = otherOpen('during')));
    let second: { release(): void } | undefined;
    let error: string | undefined;
    try {
      second = store.acquireLock(ID);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      hook.restore();
    }
    try {
      assert.equal(error, undefined, `the session takes the lock handed to it (an open while the name was free: ${during})`);
      assert.equal(hook.fired(), false, `the name was never free (an open then: ${during})`);
      assert.equal(lockPid(lockPath), process.pid);
      const after = otherOpen('after');
      assert.equal(ACTIVE.exec((after ?? '').replace(/^ERR /, ''))?.[1], String(process.pid), `another open is refused: ${after}`);
    } finally {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = new Promise((res) => child.once('exit', res));
        child.stdin!.end();
        await exited;
      }
    }
    // the first lock object no longer owns it: its release leaves the session's lock
    pre.release();
    assert.equal(lockPid(lockPath), process.pid);
    second!.release();
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(debris(t.dir, ID), []);
  });
});

describe('r12g S2 verify: an open waiting for another opener’s claim', { skip }, () => {
  it('reads the claim while it waits: no claim temp file every poll', async () => {
    const t = tmp();
    const store = new SessionStore(t.dir);
    const text = staleText(await deadPid(t));
    const lockPath = store.lockPathFor(ID);
    fs.writeFileSync(lockPath, text);
    const claimant = await runNode(t.root, t.tmpdir, "process.stdout.write('ready\\n'); setInterval(() => {}, 1 << 30);\n", [], { ready: true });
    const st = fs.readFileSync(`/proc/${claimant.pid}/stat`, 'utf8');
    const claim = `${JSON.stringify({
      pid: claimant.pid,
      started_at: new Date().toISOString(),
      host: os.hostname(),
      boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      start_ticks: Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[19]),
    })}\n`;
    fs.writeFileSync(claimPath(t.dir, ID, key(text)), claim);
    const orig = fsCjs.writeFileSync;
    let temps = 0;
    fsCjs.writeFileSync = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.startsWith(t.dir) && p.endsWith('.tmp')) temps++;
      return (orig as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    let error: string | undefined;
    try {
      store.acquireLock(ID).release();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      fsCjs.writeFileSync = orig;
      syncBuiltinESMExports();
    }
    assert.equal(ACTIVE.exec(error ?? '')?.[1], String(claimant.pid), error);
    assert.ok(temps <= 2, `temp files written while waiting for the claim: ${temps}`);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), text, 'the stale lock is left to the claimant');
    claimant.child.kill('SIGKILL');
    await claimant.exit;
    const lock = store.acquireLock(ID);
    lock.release();
    assert.deepEqual(debris(t.dir, ID), []);
  });
});
