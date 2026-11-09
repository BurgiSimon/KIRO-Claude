/**
 * r12g S2 (session group): taking over a stale session lock (its holder is dead, or is the hung-up
 * holder an open continued and that then exited leaving it) is atomic: whatever the interleaving of
 * the openers, exactly one of them owns the session. It used to be check-then-unlink: two openers
 * that both read the same stale text could each unlink, and the second unlink removed the first
 * one's NEW lock, so both held the session (the hung-up holder recovery, where every opener polls
 * the same lock every 20 ms, made that likelier).
 *
 * Deterministic interleavings: this process's open (or `store.delete`) is held right before it
 * removes the lock file's name (a hook on node:fs, `syncBuiltinESMExports`), and a second opener,
 * a real child process, runs a whole open in that window; or a third party (KiroCrew removes a dead
 * holder's lock itself) removes the stale lock and a fresh opener takes the name. Stress: 8 real
 * child openers released at the same instant, repeated, against a dead holder's lock and against a
 * hung-up holder. Every child gets TMPDIR in the test's temp dir and is killed by the test.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { SessionStore } from '../../src/session/store.js';
import { removeOnExit } from '../tmpdirs.js';
import { ACTIVE, HOLDER, LINUX, OPENER, STORE_URL, killChildren, runNode, sleep, spawnDetached, stopThenHangUp, until, waitForFileSync, type Child } from './r12g-session-helpers.js';

const skip = LINUX ? false : 'needs Linux /proc';
after(killChildren);

const ID = '12121212-1212-4121-8121-1212121212aa';
const fsCjs = createRequire(import.meta.url)('node:fs') as typeof fs;

function tmp(): { root: string; dir: string; tmpdir: string; lockPath: string } {
  const root = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r12g-take-'))));
  const dir = path.join(root, 'sessions');
  const tmpdir = path.join(root, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(tmpdir);
  return { root, dir, tmpdir, lockPath: path.join(dir, `${ID}.lock`) };
}

/** The pid of a process that has exited (a child run to its end). */
async function deadPid(t: ReturnType<typeof tmp>): Promise<number> {
  const c = await runNode(t.root, t.tmpdir, 'process.exit(0);\n', []);
  await c.exit;
  return c.pid;
}

const staleText = (pid: number): string => `${JSON.stringify({ pid, started_at: new Date().toISOString(), host: os.hostname() })}\n`;
const lockPid = (lockPath: string): number | undefined => {
  try {
    return (JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number }).pid;
  } catch {
    return undefined;
  }
};
/** What a takeover may leave next to the lock (claims, files moved aside, temp files): nothing. */
const debris = (dir: string): string[] => fs.readdirSync(dir).filter((f) => f !== `${ID}.lock` && f !== `${ID}.json`);

/**
 * Run `inject` once, right before this process's first call that removes the name `lockPath`
 * (`unlinkSync(lockPath)` or `renameSync(lockPath, …)`), with this thread held there.
 */
function beforeLockRemoval(lockPath: string, inject: () => void): { restore(): void; fired(): boolean } {
  const orig = { unlinkSync: fsCjs.unlinkSync, renameSync: fsCjs.renameSync };
  let armed = true;
  const fire = (p: fs.PathLike): void => {
    if (armed && String(p) === lockPath) {
      armed = false;
      inject();
    }
  };
  fsCjs.unlinkSync = (p: fs.PathLike): void => {
    fire(p);
    orig.unlinkSync(p);
  };
  fsCjs.renameSync = (a: fs.PathLike, b: fs.PathLike): void => {
    fire(a);
    orig.renameSync(a, b);
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

function acquire(dir: string): { lock?: { release(): void }; error?: string } {
  try {
    return { lock: new SessionStore(dir).acquireLock(ID) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** A child opener started inside a hook, its result read from a file (this thread is blocked there). */
function openerNow(t: ReturnType<typeof tmp>, name: string): { child: ChildProcess; result: string } {
  const result = path.join(t.root, `${name}.result`);
  const child = spawnDetached(t.root, t.tmpdir, OPENER, [STORE_URL, t.dir, ID, '0', result]);
  return { child, result };
}

async function endOpener(c: ChildProcess): Promise<void> {
  if (c.exitCode !== null || c.signalCode !== null) return;
  const exited = new Promise((res) => c.once('exit', res));
  c.stdin!.end();
  await exited;
}

describe('r12g S2: a stale lock is taken over by exactly one opener, whatever the interleaving', { skip }, () => {
  it('another opener takes the same stale lock over while this one is about to remove it: one of them owns the session', async () => {
    const t = tmp();
    fs.writeFileSync(t.lockPath, staleText(await deadPid(t)));
    let b: { child: ChildProcess; result: string } | undefined;
    const hook = beforeLockRemoval(t.lockPath, () => {
      b = openerNow(t, 'b');
      // the other opener's whole open runs while this one is held right before its removal
      waitForFileSync(b.result, 20_000);
    });
    let a: ReturnType<typeof acquire>;
    try {
      a = acquire(t.dir);
    } finally {
      hook.restore();
    }
    assert.ok(hook.fired(), 'the stale lock was removed by this opener (the hook ran)');
    const bOut = fs.readFileSync(b!.result, 'utf8');
    const owners = [a.lock ? process.pid : undefined, bOut === 'GOT' ? b!.child.pid : undefined].filter((p) => p !== undefined);
    assert.equal(owners.length, 1, `exactly one owner: this one ${a.lock ? 'GOT' : `ERR ${a.error}`}, the other ${bOut}`);
    assert.equal(lockPid(t.lockPath), owners[0], 'the lock file names the owner');
    const refused = a.lock ? bOut.replace(/^ERR /, '') : a.error!;
    assert.match(refused, ACTIVE);
    a.lock?.release();
    await endOpener(b!.child);
    assert.deepEqual(debris(t.dir), []);
  });

  it('a third party removes the stale lock and a fresh opener creates its own meanwhile: that lock is never removed', async () => {
    const t = tmp();
    fs.writeFileSync(t.lockPath, staleText(await deadPid(t)));
    let c: { child: ChildProcess; result: string } | undefined;
    const hook = beforeLockRemoval(t.lockPath, () => {
      // KiroCrew's own removal of a dead holder's lock (check-then-unlink), then a new open
      fs.unlinkSync(t.lockPath);
      c = openerNow(t, 'c');
      waitForFileSync(c.result, 20_000);
    });
    let a: ReturnType<typeof acquire>;
    try {
      a = acquire(t.dir);
    } finally {
      hook.restore();
    }
    assert.ok(hook.fired());
    assert.equal(fs.readFileSync(c!.result, 'utf8'), 'GOT');
    assert.equal(lockPid(t.lockPath), c!.child.pid, "the fresh opener's lock is still there");
    assert.equal(a.lock, undefined, 'this opener does not also own the session');
    assert.equal(ACTIVE.exec(a.error ?? '')?.[1], String(c!.child.pid), a.error);
    await endOpener(c!.child);
    assert.deepEqual(debris(t.dir), []);
  });

  it('store.delete removing a stale lock while an opener takes it over never removes the new lock', async () => {
    const t = tmp();
    const store = new SessionStore(t.dir);
    store.create({ sessionId: ID, origin: 'repl', cwd: t.root, agent: 'kiro_default', model: 'auto' });
    fs.writeFileSync(t.lockPath, staleText(await deadPid(t)));
    let b: { child: ChildProcess; result: string } | undefined;
    const hook = beforeLockRemoval(t.lockPath, () => {
      b = openerNow(t, 'b');
      waitForFileSync(b.result, 20_000);
    });
    try {
      assert.equal(store.delete(ID), true);
    } finally {
      hook.restore();
    }
    assert.ok(hook.fired());
    const bOut = fs.readFileSync(b!.result, 'utf8');
    if (bOut === 'GOT') assert.equal(lockPid(t.lockPath), b!.child.pid, 'an opener that owns the session keeps its lock file');
    else {
      assert.match(bOut.replace(/^ERR /, ''), ACTIVE);
      assert.equal(fs.existsSync(t.lockPath), false, 'the stale lock is gone with the record');
    }
    await endOpener(b!.child);
    assert.deepEqual(debris(t.dir), []);
  });
});

/** `n` openers of `dir`'s lock, all released at the same instant; their results once all answered. */
async function race(t: ReturnType<typeof tmp>, n: number): Promise<{ openers: Child[]; outs: string[] }> {
  const at = Date.now() + 800;
  const openers: Child[] = [];
  for (let i = 0; i < n; i++) openers.push(await runNode(t.root, t.tmpdir, OPENER, [STORE_URL, t.dir, ID, String(at)]));
  await until(() => openers.every((o) => /GOT|ERR/.test(o.out())), 'every opener answered', 30_000);
  return { openers, outs: openers.map((o) => o.out().trim()) };
}

async function settle(openers: Child[]): Promise<void> {
  for (const o of openers) o.child.stdin!.end();
  await Promise.all(openers.map((o) => o.exit));
}

function exactlyOne(t: ReturnType<typeof tmp>, openers: Child[], outs: string[], extraPids: number[] = []): void {
  const winners = openers.filter((_, i) => outs[i] === 'GOT');
  assert.equal(winners.length, 1, JSON.stringify(outs));
  assert.equal(lockPid(t.lockPath), winners[0]!.pid, 'the lock file names the owner');
  for (const o of outs.filter((x) => x !== 'GOT')) {
    const m = ACTIVE.exec(o.replace(/^ERR /, ''));
    assert.ok(m, o);
    assert.ok([winners[0]!.pid, ...extraPids, ...openers.map((x) => x.pid)].map(String).includes(m[1]!), o);
  }
}

describe('r12g S2: 8 openers released at once: exactly one owns the session, every round', { skip }, () => {
  it('against the stale lock of a dead holder (12 rounds)', async () => {
    for (let round = 0; round < 12; round++) {
      const t = tmp();
      fs.writeFileSync(t.lockPath, staleText(await deadPid(t)));
      const { openers, outs } = await race(t, 8);
      exactlyOne(t, openers, outs);
      await settle(openers);
      assert.deepEqual(debris(t.dir), [], `round ${round}`);
      assert.equal(fs.existsSync(t.lockPath), false);
    }
  });

  it('against a hung-up holder that exits leaving its lock (its close grace ran out) (5 rounds)', async () => {
    for (let round = 0; round < 5; round++) {
      const t = tmp();
      const h = await runNode(t.root, t.tmpdir, HOLDER, [STORE_URL, t.dir, ID, 'die'], { ready: true });
      await stopThenHangUp(h.pid);
      const { openers, outs } = await race(t, 8);
      assert.deepEqual(await h.exit, { code: 0, signal: null });
      exactlyOne(t, openers, outs, [h.pid]);
      await settle(openers);
      assert.deepEqual(debris(t.dir), [], `round ${round}`);
    }
  });

  it('against a hung-up holder that releases its lock as it closes (3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const t = tmp();
      const h = await runNode(t.root, t.tmpdir, HOLDER, [STORE_URL, t.dir, ID, 'release'], { ready: true });
      await stopThenHangUp(h.pid);
      const { openers, outs } = await race(t, 8);
      assert.deepEqual(await h.exit, { code: 0, signal: null });
      exactlyOne(t, openers, outs, [h.pid]);
      await settle(openers);
      assert.deepEqual(debris(t.dir), [], `round ${round}`);
    }
  });
});

/** The takeover claim an opener creates for the stale lock text `text` (store.ts takeOverStale). */
const claimPath = (t: ReturnType<typeof tmp>, text: string): string =>
  path.join(t.dir, `.${ID}.lock.takeover-${createHash('sha256').update(text).digest('hex').slice(0, 24)}`);

const BOOT_ID = LINUX ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : '';
function startTicks(pid: number): number {
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[19]);
}

describe('r12g S2: the takeover claim', { skip }, () => {
  it('a claim left by a claimant that died in the middle of a takeover does not block it; nothing is left', async () => {
    const t = tmp();
    const text = staleText(await deadPid(t));
    fs.writeFileSync(t.lockPath, text);
    fs.writeFileSync(claimPath(t, text), staleText(await deadPid(t)));
    const a = acquire(t.dir);
    assert.equal(a.error, undefined, a.error);
    assert.equal(lockPid(t.lockPath), process.pid);
    a.lock!.release();
    assert.deepEqual(debris(t.dir), []);
  });

  it('a live claimant (another opener in the middle of the takeover): left to it, the Kiro message names it', async () => {
    const t = tmp();
    const text = staleText(await deadPid(t));
    fs.writeFileSync(t.lockPath, text);
    const claimant = await runNode(t.root, t.tmpdir, "process.stdout.write('ready\\n'); setInterval(() => {}, 1 << 30);\n", [], { ready: true });
    const claim = `${JSON.stringify({ pid: claimant.pid, started_at: new Date().toISOString(), host: os.hostname(), boot_id: BOOT_ID, start_ticks: startTicks(claimant.pid) })}\n`;
    fs.writeFileSync(claimPath(t, text), claim);
    const t0 = Date.now();
    const a = acquire(t.dir);
    const ms = Date.now() - t0;
    assert.equal(ACTIVE.exec(a.error ?? '')?.[1], String(claimant.pid), a.error);
    assert.ok(ms >= 500 && ms < 6000, `a bounded wait for the claimant (${ms} ms)`);
    assert.equal(fs.readFileSync(t.lockPath, 'utf8'), text, 'the stale lock is left to the claimant');
    assert.equal(fs.readFileSync(claimPath(t, text), 'utf8'), claim);
    // store.delete leaves it too (someone is opening the session)
    const store = new SessionStore(t.dir);
    store.create({ sessionId: ID, origin: 'repl', cwd: t.root, agent: 'kiro_default', model: 'auto' });
    assert.equal(store.delete(ID), true);
    assert.equal(fs.readFileSync(t.lockPath, 'utf8'), text);
    claimant.child.kill('SIGKILL');
    await claimant.exit;
    // once the claimant is gone its claim no longer blocks
    const b = acquire(t.dir);
    assert.equal(b.error, undefined, b.error);
    b.lock!.release();
    assert.deepEqual(debris(t.dir), []);
  });

  it('a claim that cannot be read: young, it is a claim being written (left alone); old, a crashed one', async () => {
    const t = tmp();
    const text = staleText(await deadPid(t));
    fs.writeFileSync(t.lockPath, text);
    fs.writeFileSync(claimPath(t, text), '');
    const a = acquire(t.dir);
    assert.ok(a.error, 'refused while the claim is young');
    assert.equal(fs.readFileSync(t.lockPath, 'utf8'), text);
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(claimPath(t, text), old, old);
    const b = acquire(t.dir);
    assert.equal(b.error, undefined, b.error);
    b.lock!.release();
    assert.deepEqual(debris(t.dir), []);
  });

  it('control: an uncontended takeover of a dead holder’s lock is unchanged (the lock is ours, released cleanly)', async () => {
    const t = tmp();
    fs.writeFileSync(t.lockPath, staleText(await deadPid(t)));
    const a = acquire(t.dir);
    assert.equal(a.error, undefined, a.error);
    const lock = JSON.parse(fs.readFileSync(t.lockPath, 'utf8')) as Record<string, unknown>;
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.host, os.hostname());
    a.lock!.release();
    assert.equal(fs.existsSync(t.lockPath), false);
    await sleep(0);
    assert.deepEqual(debris(t.dir), []);
  });
});
