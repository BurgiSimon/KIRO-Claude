/**
 * r12 #1 (session group): a chat stopped for good with a hangup or a kill pending holds its session
 * lock until someone continues it. Under `sudo` with `use_pty`, closing the terminal of a chat
 * stopped in the background (Ctrl+Z; a self-stop after `bg`, `&`, a `!cmd` that ended there) makes
 * sudo pass the SIGHUP on but never continue the chat (as for any program it runs), so the chat stays
 * in state T with SIGHUP pending and `chat --resume` / ACP `session/load` refused with 'Session is
 * active in another process (PID N)'. SessionStore.acquireLock now continues such a holder (SIGCONT
 * only), when it is verifiably the process that wrote the lock (same boot, same start time, same
 * user, this host), waits a bounded time for it to close, and takes the lock as for a dead holder.
 * Any other live holder keeps the error unchanged.
 *
 * The holders here are real child processes: one that takes its lock through the store and closes
 * at SIGHUP / SIGTERM as the chat does, stopped with SIGSTOP and then sent the signal while stopped
 * (a signal sent to a stopped process stays pending: no sudo needed), or a plain sleeper whose lock
 * the test writes. Every child is killed by the test that started it (SIGCONT + SIGKILL) and gets
 * TMPDIR in the test's temp dir.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SessionStore } from '../../src/session/store.js';
import { removeOnExit } from '../tmpdirs.js';

const LINUX = process.platform === 'linux' && fs.existsSync('/proc/self/stat');
const skip = LINUX ? false : 'needs Linux /proc';
const STORE_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/session/store.js')).href;
const ACTIVE = /^Failed to start session: Session is active in another process \(PID (\d+)\)$/;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const children: ChildProcess[] = [];
after(() => {
  for (const c of children) {
    if (c.exitCode !== null || c.signalCode !== null || c.pid === undefined) continue;
    try {
      process.kill(c.pid, 'SIGCONT');
      process.kill(c.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
});

function tmp(): { root: string; dir: string; tmpdir: string } {
  const root = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r12f-lock-'))));
  const dir = path.join(root, 'sessions');
  const tmpdir = path.join(root, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(tmpdir);
  return { root, dir, tmpdir };
}

/**
 * A chat-like lock holder: takes the lock of `id` through the store, then at SIGHUP or SIGTERM
 * `release` releases it and exits 0 (the chat's close), `die` exits 0 leaving it (a close whose grace
 * ran out), `retake` releases it, takes it again for 400 ms and then exits (the chat's makeNewest),
 * `ignore` runs on with it.
 */
const HOLDER = `const [storeUrl, dir, id, mode] = process.argv.slice(2);
const { SessionStore } = await import(storeUrl);
const store = new SessionStore(dir);
const lock = store.acquireLock(id);
const close = () => {
  if (mode === 'release') { lock.release(); process.exit(0); }
  if (mode === 'die') process.exit(0);
  if (mode === 'retake') {
    lock.release();
    const again = store.acquireLock(id);
    setTimeout(() => { again.release(); process.exit(0); }, 400);
  }
};
process.on('SIGHUP', close);
process.on('SIGTERM', close);
process.stdout.write('ready\\n');
setInterval(() => {}, 1 << 30);
`;

/** Takes the lock of `id` and holds it until its stdin ends (`GOT`), or prints the error (`ERR <message>`). */
const OPENER = `const [storeUrl, dir, id] = process.argv.slice(2);
const { SessionStore } = await import(storeUrl);
try {
  const lock = new SessionStore(dir).acquireLock(id);
  process.stdout.write('GOT\\n');
  process.stdin.on('end', () => { lock.release(); process.exit(0); });
  process.stdin.resume();
} catch (e) {
  process.stdout.write('ERR ' + e.message + '\\n');
  process.exit(0);
}
`;

interface Child {
  child: ChildProcess;
  pid: number;
  out(): string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function run(t: ReturnType<typeof tmp>, source: string, args: string[], opts: { uid?: number; ready?: boolean } = {}): Promise<Child> {
  const script = path.join(t.root, `child-${children.length}.mjs`);
  fs.writeFileSync(script, source);
  fs.chmodSync(t.root, 0o755);
  fs.chmodSync(script, 0o644);
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, TMPDIR: t.tmpdir },
    ...(opts.uid !== undefined ? { uid: opts.uid, gid: opts.uid } : {}),
  });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stdin!.on('error', () => undefined);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
  if (opts.ready !== false) await until(() => out.includes('ready'), 'the child is ready', 15_000);
  return { child, pid: child.pid!, out: () => out, exit };
}

const SLEEPER = `process.stdout.write('ready\\n'); setInterval(() => {}, 1 << 30);\n`;

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

function state(pid: number): string {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[0] ?? 'gone';
  } catch {
    return 'gone';
  }
}

/**
 * Every thread of `pid` is in a job-control stop: Node runs several, and a signal sent while one
 * of them still runs is delivered to it (not left pending), so a test sends it only after this.
 */
function allStopped(pid: number): boolean {
  try {
    const tids = fs.readdirSync(`/proc/${pid}/task`);
    return (
      tids.length > 0 &&
      tids.every((t) => {
        const s = fs.readFileSync(`/proc/${pid}/task/${t}/stat`, 'utf8');
        return s.slice(s.lastIndexOf(')') + 2).split(' ')[0] === 'T';
      })
    );
  } catch {
    return false;
  }
}

function startTicks(pid: number): number {
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[19]);
}

const BOOT_ID = LINUX ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : '';

/** SIGHUP (bit 0) or SIGTERM (bit 14) pending, from /proc/<pid>/status SigPnd and ShdPnd. */
function pending(pid: number): { hup: boolean; term: boolean } {
  const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  let bits = 0;
  for (const m of st.matchAll(/^(?:SigPnd|ShdPnd):\s*([0-9a-f]+)$/gm)) bits |= Number.parseInt(m[1]!.slice(-4), 16);
  return { hup: (bits & 1) !== 0, term: (bits & (1 << 14)) !== 0 };
}

/** Stop `pid` as the shell's job control would, then (optionally) send `sig` while it is stopped. */
async function stopWith(pid: number, sig?: 'SIGHUP' | 'SIGTERM'): Promise<void> {
  process.kill(pid, 'SIGSTOP');
  await until(() => allStopped(pid), `the child is stopped (state ${state(pid)})`);
  if (!sig) return;
  process.kill(pid, sig);
  await until(() => (sig === 'SIGHUP' ? pending(pid).hup : pending(pid).term), `${sig} is pending`);
  await sleep(100);
  assert.equal(state(pid), 'T', `${sig} sent to a stopped process stays pending`);
}

function lockOf(dir: string, id: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.lock`), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** acquireLock in this process, timed: the lock, or the error message. */
function timedAcquire(dir: string, id: string): { ms: number; lock?: { release(): void }; error?: string } {
  const t0 = Date.now();
  try {
    const lock = new SessionStore(dir).acquireLock(id);
    return { ms: Date.now() - t0, lock };
  } catch (e) {
    return { ms: Date.now() - t0, error: (e as Error).message };
  }
}

const ID = '12121212-1212-4121-8121-121212121212';

describe('r12f session lock: a holder stopped for good with a hangup or kill pending', { skip }, () => {
  it('SIGHUP pending (sudo use_pty after the terminal closed): continued, closes, and the lock is taken', async () => {
    const t = tmp();
    const h = await run(t, HOLDER, [STORE_URL, t.dir, ID, 'release']);
    assert.equal(lockOf(t.dir, ID)?.pid, h.pid);
    await stopWith(h.pid, 'SIGHUP');
    const r = timedAcquire(t.dir, ID);
    assert.equal(r.error, undefined, r.error);
    assert.equal(lockOf(t.dir, ID)?.pid, process.pid);
    // it ran its own SIGHUP close (exit 0), so it was continued, not killed
    assert.deepEqual(await h.exit, { code: 0, signal: null });
    assert.ok(r.ms < 3000, `took ${r.ms} ms`);
    r.lock!.release();
    assert.equal(lockOf(t.dir, ID), undefined);
  });

  it('SIGTERM pending (a plain `kill <pid>` of a stopped chat): continued, closes, and the lock is taken', async () => {
    const t = tmp();
    const h = await run(t, HOLDER, [STORE_URL, t.dir, ID, 'release']);
    await stopWith(h.pid, 'SIGTERM');
    const r = timedAcquire(t.dir, ID);
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(await h.exit, { code: 0, signal: null });
    r.lock!.release();
  });

  it('a holder that exits at the signal leaving its lock (its close grace ran out) is taken over', async () => {
    const t = tmp();
    const h = await run(t, HOLDER, [STORE_URL, t.dir, ID, 'die']);
    await stopWith(h.pid, 'SIGHUP');
    const r = timedAcquire(t.dir, ID);
    assert.equal(r.error, undefined, r.error);
    assert.equal(lockOf(t.dir, ID)?.pid, process.pid);
    assert.deepEqual(await h.exit, { code: 0, signal: null });
    r.lock!.release();
  });

  it('a holder that takes its lock again while it closes (the chat makes its record the newest) is waited for', async () => {
    const t = tmp();
    const h = await run(t, HOLDER, [STORE_URL, t.dir, ID, 'retake']);
    await stopWith(h.pid, 'SIGHUP');
    const r = timedAcquire(t.dir, ID);
    assert.equal(r.error, undefined, r.error);
    assert.equal(lockOf(t.dir, ID)?.pid, process.pid);
    assert.ok(r.ms >= 300, `the second lock was waited for (${r.ms} ms)`);
    r.lock!.release();
    assert.deepEqual(await h.exit, { code: 0, signal: null });
  });

  it('two openers racing for the lock of a hung-up holder: one takes it, the other gets the Kiro message', async () => {
    const t = tmp();
    const h = await run(t, HOLDER, [STORE_URL, t.dir, ID, 'release']);
    await stopWith(h.pid, 'SIGHUP');
    const a = await run(t, OPENER, [STORE_URL, t.dir, ID], { ready: false });
    const b = await run(t, OPENER, [STORE_URL, t.dir, ID], { ready: false });
    await until(() => /GOT|ERR/.test(a.out()) && /GOT|ERR/.test(b.out()), 'both openers answered', 15_000);
    const outs = [a.out().trim(), b.out().trim()];
    assert.equal(outs.filter((o) => o === 'GOT').length, 1, JSON.stringify(outs));
    const refused = outs.find((o) => o !== 'GOT')!;
    const m = ACTIVE.exec(refused.replace(/^ERR /, ''));
    assert.ok(m, refused);
    const winner = outs[0] === 'GOT' ? a : b;
    assert.ok([String(winner.pid), String(h.pid)].includes(m[1]!), refused);
    assert.equal(lockOf(t.dir, ID)?.pid, winner.pid);
    a.child.stdin!.end();
    b.child.stdin!.end();
    await Promise.all([a.exit, b.exit]);
    assert.deepEqual(await h.exit, { code: 0, signal: null });
  });
});

describe('r12f session lock: holders that are left alone (the Kiro message, unchanged)', { skip }, () => {
  it('stopped by an ordinary Ctrl+Z in a terminal still open (nothing pending): refused at once, not continued', async () => {
    const t = tmp();
    const h = await run(t, HOLDER, [STORE_URL, t.dir, ID, 'release']);
    await stopWith(h.pid);
    const r = timedAcquire(t.dir, ID);
    assert.match(r.error ?? '', ACTIVE);
    assert.equal(ACTIVE.exec(r.error!)![1], String(h.pid));
    assert.ok(r.ms < 2500, `took ${r.ms} ms (no wait for a holder left alone)`);
    await sleep(200);
    assert.equal(state(h.pid), 'T', 'still stopped');
    assert.equal(lockOf(t.dir, ID)?.pid, h.pid);
  });

  it('a running holder: refused at once', async () => {
    const t = tmp();
    const h = await run(t, HOLDER, [STORE_URL, t.dir, ID, 'release']);
    const r = timedAcquire(t.dir, ID);
    assert.match(r.error ?? '', ACTIVE);
    assert.ok(r.ms < 2500, `took ${r.ms} ms (no wait for a holder left alone)`);
    assert.equal(lockOf(t.dir, ID)?.pid, h.pid);
  });

  it('continued but not closing in time: the Kiro message after the bounded wait, the lock untouched', async () => {
    const t = tmp();
    const h = await run(t, HOLDER, [STORE_URL, t.dir, ID, 'ignore']);
    const before = fs.readFileSync(path.join(t.dir, `${ID}.lock`), 'utf8');
    await stopWith(h.pid, 'SIGHUP');
    const r = timedAcquire(t.dir, ID);
    assert.match(r.error ?? '', ACTIVE);
    assert.ok(r.ms >= 2500 && r.ms < 8000, `waited ${r.ms} ms`);
    assert.notEqual(state(h.pid), 'T', 'it was continued');
    assert.equal(fs.readFileSync(path.join(t.dir, `${ID}.lock`), 'utf8'), before);
  });

  for (const [what, lock] of [
    ['a lock without the holder’s start time (KiroCrew’s shape, an older kiro-claude)', (pid: number) => ({ pid, started_at: new Date().toISOString(), host: os.hostname() })],
    ['a lock whose start time is not the process’s (pid reuse)', (pid: number) => ({ pid, started_at: new Date().toISOString(), host: os.hostname(), boot_id: BOOT_ID, start_ticks: startTicks(pid) + 1 })],
    ['a lock of another boot', (pid: number) => ({ pid, started_at: new Date().toISOString(), host: os.hostname(), boot_id: '00000000-0000-4000-8000-000000000000', start_ticks: startTicks(pid) })],
    ['a lock of another host', (pid: number) => ({ pid, started_at: new Date().toISOString(), host: `not-${os.hostname()}`, boot_id: BOOT_ID, start_ticks: startTicks(pid) })],
  ] as const) {
    it(`${what}: never signalled`, async () => {
      const t = tmp();
      const h = await run(t, SLEEPER, []);
      const text = `${JSON.stringify(lock(h.pid))}\n`;
      fs.writeFileSync(path.join(t.dir, `${ID}.lock`), text);
      await stopWith(h.pid, 'SIGHUP');
      const r = timedAcquire(t.dir, ID);
      assert.match(r.error ?? '', ACTIVE);
      assert.ok(r.ms < 2500, `took ${r.ms} ms (no wait for a holder left alone)`);
      await sleep(200);
      assert.equal(state(h.pid), 'T', 'still stopped');
      assert.equal(fs.readFileSync(path.join(t.dir, `${ID}.lock`), 'utf8'), text);
    });
  }

  it('control: the same lock with the right start time is acted on (the sleeper dies of its SIGHUP)', async () => {
    const t = tmp();
    const h = await run(t, SLEEPER, []);
    fs.writeFileSync(path.join(t.dir, `${ID}.lock`), `${JSON.stringify({ pid: h.pid, started_at: new Date().toISOString(), host: os.hostname(), boot_id: BOOT_ID, start_ticks: startTicks(h.pid) })}\n`);
    await stopWith(h.pid, 'SIGHUP');
    const r = timedAcquire(t.dir, ID);
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(await h.exit, { code: null, signal: 'SIGHUP' });
    r.lock!.release();
  });

  it('a process of another user is never signalled', { skip: process.getuid?.() === 0 ? false : 'needs root (a child of another uid)' }, async () => {
    const t = tmp();
    const h = await run(t, SLEEPER, [], { uid: 65534 });
    const text = `${JSON.stringify({ pid: h.pid, started_at: new Date().toISOString(), host: os.hostname(), boot_id: BOOT_ID, start_ticks: startTicks(h.pid) })}\n`;
    fs.writeFileSync(path.join(t.dir, `${ID}.lock`), text);
    await stopWith(h.pid, 'SIGHUP');
    const r = timedAcquire(t.dir, ID);
    assert.match(r.error ?? '', ACTIVE);
    await sleep(200);
    assert.equal(state(h.pid), 'T', 'still stopped');
  });
});
