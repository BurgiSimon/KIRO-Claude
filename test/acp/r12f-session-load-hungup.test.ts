/**
 * r12 #1 (session group), over ACP: `session/load` of a session whose lock a process holds that is
 * stopped for good with SIGHUP pending (what sudo with `use_pty` leaves of a chat stopped in the
 * background when its terminal closes) continues that process, which closes and gives up the
 * lock, and loads the session. KiroCrew used to get 'Session is active in another process' on every
 * retry until someone continued the chat by hand. A holder stopped with nothing pending keeps the
 * error, with the wire text KiroCrew retries on unchanged.
 *
 * The holder is a child that takes the lock through the store and closes at SIGHUP as the chat does;
 * it gets TMPDIR in the test's temp dir and is killed by the test should it outlive it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TestClient, tmpEnv, type TmpEnv } from './helpers.js';

const skip = process.platform === 'linux' && fs.existsSync('/proc/self/stat') ? false : 'needs Linux /proc';
const STORE_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/session/store.js')).href;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const clients: TestClient[] = [];
const children: ChildProcess[] = [];
after(async () => {
  for (const c of children) {
    if (c.pid === undefined || c.exitCode !== null || c.signalCode !== null) continue;
    try {
      process.kill(c.pid, 'SIGCONT');
      process.kill(c.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(10_000)));
});

const HOLDER = `const [storeUrl, dir, id] = process.argv.slice(2);
const { SessionStore } = await import(storeUrl);
const lock = new SessionStore(dir).acquireLock(id);
const close = () => { lock.release(); process.exit(0); };
process.on('SIGHUP', close);
process.on('SIGTERM', close);
process.stdout.write('ready\\n');
setInterval(() => {}, 1 << 30);
`;

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

function hupPending(pid: number): boolean {
  const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  return [...st.matchAll(/^(?:SigPnd|ShdPnd):\s*([0-9a-f]+)$/gm)].some((m) => (Number.parseInt(m[1]!.slice(-4), 16) & 1) !== 0);
}

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

/** A saved ACP session (one finished turn), its client closed. */
async function savedSession(): Promise<{ t: TmpEnv; sid: string; dir: string }> {
  const t = tmpEnv();
  const c = new TestClient({ env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)).sessionId as string;
  const r = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hello' }] }, 60_000);
  assert.equal(r.result?.stopReason, 'end_turn', JSON.stringify(r));
  assert.equal(await c.close(20_000), 0);
  const dir = path.join(t.kiroHome, 'sessions', 'cli');
  assert.ok(fs.existsSync(path.join(dir, `${sid}.json`)));
  assert.equal(fs.existsSync(path.join(dir, `${sid}.lock`)), false);
  return { t, sid, dir };
}

/** The holder of `sid`'s lock, stopped, with SIGHUP sent while stopped when `hup`. */
async function stoppedHolder(t: TmpEnv, dir: string, sid: string, hup: boolean): Promise<{ child: ChildProcess; pid: number; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }> {
  const script = path.join(t.root, 'holder.mjs');
  fs.writeFileSync(script, HOLDER);
  const child = spawn(process.execPath, [script, STORE_URL, dir, sid], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, TMPDIR: t.env.TMPDIR } });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
  await until(() => out.includes('ready'), 'the holder has the lock', 15_000);
  const pid = child.pid!;
  process.kill(pid, 'SIGSTOP');
  await until(() => allStopped(pid), 'the holder is stopped');
  if (hup) {
    process.kill(pid, 'SIGHUP');
    await until(() => hupPending(pid), 'SIGHUP is pending');
  }
  return { child, pid, exit };
}

const load = (c: TestClient, t: TmpEnv, sid: string, dir: string) =>
  c.request('session/load', { sessionId: sid, cwd: t.work, mcpServers: [], _meta: { '_kiro.dev/session_file': path.join(dir, `${sid}.json`) } }, 60_000);

test('session/load of a session held by a process stopped with SIGHUP pending: continued, it closes, and the session loads', { skip }, async () => {
  const { t, sid, dir } = await savedSession();
  const h = await stoppedHolder(t, dir, sid, true);
  const c = new TestClient({ env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const r = await load(c, t, sid, dir);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.ok(r.result?.modes, JSON.stringify(r));
  assert.deepEqual(await h.exit, { code: 0, signal: null }, 'the holder ran its own SIGHUP close');
  const lock = JSON.parse(fs.readFileSync(path.join(dir, `${sid}.lock`), 'utf8')) as { pid: number };
  assert.equal(lock.pid, process.pid, 'the lock is the loading server’s');
  const p = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'again' }] }, 60_000);
  assert.equal(p.result?.stopReason, 'end_turn', JSON.stringify(p));
  assert.equal(await c.close(20_000), 0);
});

test('control: session/load while the holder is stopped with nothing pending keeps the error KiroCrew retries on', { skip }, async () => {
  const { t, sid, dir } = await savedSession();
  const h = await stoppedHolder(t, dir, sid, false);
  const c = new TestClient({ env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const r = await load(c, t, sid, dir);
  assert.deepEqual(r.error, { code: -32603, message: 'Internal error', data: `Failed to start session: Session is active in another process (PID ${h.pid})` });
  await sleep(200);
  assert.equal(state(h.pid), 'T', 'the holder is not touched');
  assert.equal(await c.close(20_000), 0);
});
