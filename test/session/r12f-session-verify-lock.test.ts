/**
 * r12 #1 verification (session group): the hung-up holder recovery of SessionStore.acquireLock
 * (session/store.ts, "Hung-up holder") must never signal a process it cannot tie to the lock.
 *
 * - A lock file another user wrote (owned by another uid) proves nothing about who wrote it: its
 *   `pid`, `boot_id` and `start_ticks` are all world-readable facts of any process, so anyone who
 *   can write into the session index (the user's own dir under `sudo -E` with HOME kept, as root
 *   opens it) could name one of OUR processes that is stopped with SIGHUP pending and have us
 *   continue it. Before this check such a lock was acted on: SIGCONT sent, the process closed.
 * - A ptrace stop (state `t`, here with SIGHUP pending in ShdPnd, as the kernel shows it for a
 *   traced process) is never touched: refused at once, as before.
 *
 * Real processes: a plain sleeper whose lock the test writes, stopped with SIGSTOP and sent SIGHUP
 * while stopped (it stays pending); for the ptrace case a single-threaded `sleep` traced by a
 * python3 helper (PTRACE_ATTACH). Every child is killed by the test that started it.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SessionStore } from '../../src/session/store.js';
import { removeOnExit } from '../tmpdirs.js';

const LINUX = process.platform === 'linux' && fs.existsSync('/proc/self/stat');
const ROOT = process.getuid?.() === 0;
const ACTIVE = /^Failed to start session: Session is active in another process \(PID (\d+)\)$/;
const ID = '34343434-3434-4343-8343-343434343434';
const BOOT_ID = LINUX ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : '';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const HAVE_PY = LINUX && spawnSync('python3', ['-I', '-c', 'import ctypes'], { stdio: 'ignore' }).status === 0;
const HAVE_SLEEP = LINUX && spawnSync('sleep', ['0'], { stdio: 'ignore' }).status === 0;

const children: ChildProcess[] = [];
after(() => {
  for (const c of children) {
    if (c.exitCode !== null || c.signalCode !== null || c.pid === undefined) continue;
    try {
      process.kill(c.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
});

function tmp(): { root: string; dir: string; tmpdir: string } {
  const root = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r12f-verify-lock-'))));
  const dir = path.join(root, 'sessions');
  const tmpdir = path.join(root, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(tmpdir);
  return { root, dir, tmpdir };
}

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

function fields(pid: number): string[] {
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return s.slice(s.lastIndexOf(')') + 2).split(' ');
}

function state(pid: number): string {
  try {
    return fields(pid)[0] ?? 'gone';
  } catch {
    return 'gone';
  }
}

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

function hupPending(pid: number): boolean {
  const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  return [...st.matchAll(/^(?:SigPnd|ShdPnd):\s*([0-9a-f]+)$/gm)].some((m) => (Number.parseInt(m[1]!.slice(-4), 16) & 1) !== 0);
}

/** A lock naming `pid` exactly as that process would write it (this host, this boot, its start time). */
function lockText(pid: number): string {
  return `${JSON.stringify({ pid, started_at: new Date().toISOString(), host: os.hostname(), boot_id: BOOT_ID, start_ticks: Number(fields(pid)[19]) })}\n`;
}

function timedAcquire(dir: string): { ms: number; lock?: { release(): void }; error?: string } {
  const t0 = Date.now();
  try {
    const lock = new SessionStore(dir).acquireLock(ID);
    return { ms: Date.now() - t0, lock };
  } catch (e) {
    return { ms: Date.now() - t0, error: (e as Error).message };
  }
}

function sleeper(t: ReturnType<typeof tmp>): { child: ChildProcess; pid: number; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', env: { ...process.env, TMPDIR: t.tmpdir } });
  children.push(child);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
  return { child, pid: child.pid!, exit };
}

describe('r12f verify: the hung-up holder recovery never acts on a lock it cannot tie to its holder', { skip: LINUX ? false : 'needs Linux /proc' }, () => {
  it('a lock file owned by another user, naming our own stopped process with SIGHUP pending: never signalled', { skip: ROOT ? false : 'needs root (chown of the lock file)' }, async () => {
    const t = tmp();
    const h = sleeper(t);
    await until(() => state(h.pid) === 'S' || state(h.pid) === 'R', 'the sleeper runs');
    const text = lockText(h.pid);
    const file = path.join(t.dir, `${ID}.lock`);
    fs.writeFileSync(file, text, { mode: 0o644 });
    fs.chownSync(file, 65534, 65534);
    process.kill(h.pid, 'SIGSTOP');
    await until(() => allStopped(h.pid), 'the sleeper is stopped');
    process.kill(h.pid, 'SIGHUP');
    await until(() => hupPending(h.pid), 'SIGHUP is pending');
    const r = timedAcquire(t.dir);
    assert.match(r.error ?? '', ACTIVE, 'the error is unchanged');
    assert.equal(ACTIVE.exec(r.error!)![1], String(h.pid));
    assert.ok(r.ms < 2500, `took ${r.ms} ms (no wait: nothing was continued)`);
    await sleep(200);
    assert.equal(state(h.pid), 'T', 'still stopped: no SIGCONT was sent');
    assert.ok(hupPending(h.pid), 'its SIGHUP still pending');
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'the lock is untouched');
  });

  it('control: the same lock owned by us is acted on (continued, the sleeper dies of its SIGHUP)', async () => {
    const t = tmp();
    const h = sleeper(t);
    await until(() => state(h.pid) === 'S' || state(h.pid) === 'R', 'the sleeper runs');
    fs.writeFileSync(path.join(t.dir, `${ID}.lock`), lockText(h.pid), { mode: 0o600 });
    process.kill(h.pid, 'SIGSTOP');
    await until(() => allStopped(h.pid), 'the sleeper is stopped');
    process.kill(h.pid, 'SIGHUP');
    await until(() => hupPending(h.pid), 'SIGHUP is pending');
    const r = timedAcquire(t.dir);
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(await h.exit, { code: null, signal: 'SIGHUP' });
    r.lock!.release();
  });

  it('a lock file that is a symbolic link to a lock of the process: never signalled', async () => {
    const t = tmp();
    const h = sleeper(t);
    await until(() => state(h.pid) === 'S' || state(h.pid) === 'R', 'the sleeper runs');
    const real = path.join(t.root, 'elsewhere.lock');
    const text = lockText(h.pid);
    fs.writeFileSync(real, text, { mode: 0o600 });
    fs.symlinkSync(real, path.join(t.dir, `${ID}.lock`));
    process.kill(h.pid, 'SIGSTOP');
    await until(() => allStopped(h.pid), 'the sleeper is stopped');
    process.kill(h.pid, 'SIGHUP');
    await until(() => hupPending(h.pid), 'SIGHUP is pending');
    const r = timedAcquire(t.dir);
    assert.match(r.error ?? '', ACTIVE);
    assert.ok(r.ms < 2500, `took ${r.ms} ms`);
    await sleep(200);
    assert.equal(state(h.pid), 'T', 'still stopped');
  });

  it('a ptrace stop (state t) with SIGHUP pending: refused at once, never continued', { skip: HAVE_PY && HAVE_SLEEP ? false : 'needs python3 and sleep' }, async () => {
    const t = tmp();
    // a single-threaded holder: a signal sent to it stays pending while the tracer holds it
    const target = spawn('sleep', ['1000'], { stdio: 'ignore', env: { ...process.env, TMPDIR: t.tmpdir } });
    children.push(target);
    const pid = target.pid!;
    await until(() => state(pid) === 'S', 'sleep runs');
    const tracerSrc = [
      'import ctypes, os, sys',
      'libc = ctypes.CDLL(None, use_errno=True)',
      'pid = int(sys.argv[1])',
      'if libc.ptrace(16, pid, None, None) != 0:',
      '    print("NOATTACH", ctypes.get_errno(), flush=True); sys.exit(0)',
      'os.waitpid(pid, 0)',
      'print("ATTACHED", flush=True)',
      'sys.stdin.read()',
      'libc.ptrace(17, pid, None, 0)',
    ].join('\n');
    const tracer = spawn('python3', ['-I', '-c', tracerSrc, String(pid)], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TMPDIR: t.tmpdir } });
    children.push(tracer);
    let out = '';
    tracer.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    tracer.stdin!.on('error', () => undefined);
    try {
      await until(() => /ATTACHED|NOATTACH/.test(out), 'the tracer attached');
      if (out.includes('NOATTACH')) {
        process.kill(pid, 'SIGKILL');
        return; // ptrace not permitted here: nothing to check
      }
      assert.equal(state(pid), 't', 'a ptrace stop reads as t');
      fs.writeFileSync(path.join(t.dir, `${ID}.lock`), lockText(pid), { mode: 0o600 });
      process.kill(pid, 'SIGHUP');
      await until(() => hupPending(pid), 'SIGHUP is pending in the traced process');
      const r = timedAcquire(t.dir);
      assert.match(r.error ?? '', ACTIVE);
      assert.equal(ACTIVE.exec(r.error!)![1], String(pid));
      assert.ok(r.ms < 2500, `took ${r.ms} ms (no wait: a ptrace stop is left alone)`);
      assert.equal(state(pid), 't');
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
      tracer.stdin!.end();
    }
  });
});
