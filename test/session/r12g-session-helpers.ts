/**
 * Shared helpers of the r12g session-lock tests (test/session, test/cli and test/acp
 * r12g-session-*.test.ts): real child processes that hold or take a session lock through the built
 * store, stopped the way a shell's job control (or sudo with `use_pty` after the terminal closed)
 * leaves them, and the /proc reads that tell when a stop or a pending signal has landed.
 *
 * Every child gets TMPDIR in the caller's temp dir and is killed by {@link killChildren}
 * (SIGCONT + SIGKILL, only the pids started here).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LINUX = process.platform === 'linux' && fs.existsSync('/proc/self/stat');
/** The built store module, for child processes (this file is built next to src/). */
export const STORE_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/session/store.js')).href;
export const ACTIVE = /^Failed to start session: Session is active in another process \(PID (\d+)\)$/;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Blocks this thread (the event loop too) for `ms`. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export async function until(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

export function state(pid: number): string {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[0] ?? 'gone';
  } catch {
    return 'gone';
  }
}

/**
 * Every thread of `pid` is in a job-control stop: Node runs several, and a signal sent while one of
 * them still runs is delivered to it (not left pending), so a signal is sent only after this.
 */
export function allStopped(pid: number): boolean {
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

/** SIGHUP (bit 0) or SIGTERM (bit 14) pending, from /proc/<pid>/status SigPnd and ShdPnd. */
export function pending(pid: number): { hup: boolean; term: boolean } {
  const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  let bits = 0;
  for (const m of st.matchAll(/^(?:SigPnd|ShdPnd):\s*([0-9a-f]+)$/gm)) bits |= Number.parseInt(m[1]!.slice(-4), 16);
  return { hup: (bits & 1) !== 0, term: (bits & (1 << 14)) !== 0 };
}

/** Stop `pid` as job control does, then send SIGHUP while it is stopped (it stays pending). */
export async function stopThenHangUp(pid: number): Promise<void> {
  process.kill(pid, 'SIGSTOP');
  await until(() => allStopped(pid), `the child is stopped (state ${state(pid)})`);
  process.kill(pid, 'SIGHUP');
  await until(() => pending(pid).hup, 'SIGHUP is pending');
  await sleep(100);
  if (state(pid) !== 'T') throw new Error(`a SIGHUP sent to a stopped process stays pending (state ${state(pid)})`);
}

export interface Child {
  child: ChildProcess;
  pid: number;
  out(): string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children: ChildProcess[] = [];

/** SIGCONT + SIGKILL every child {@link runNode} started that is still running. */
export function killChildren(): void {
  for (const c of children) {
    if (c.pid === undefined || c.exitCode !== null || c.signalCode !== null) continue;
    try {
      process.kill(c.pid, 'SIGCONT');
      process.kill(c.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
}

let scripts = 0;
/**
 * Run `source` (an ES module) under this Node with `args`, stdin a pipe, TMPDIR `tmpdir`. With
 * `ready`, waits until it printed `ready`.
 */
export async function runNode(dir: string, tmpdir: string, source: string, args: string[], opts: { ready?: boolean } = {}): Promise<Child> {
  const script = path.join(dir, `child-${process.pid}-${scripts++}.mjs`);
  fs.writeFileSync(script, source);
  const child = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TMPDIR: tmpdir } });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stdin!.on('error', () => undefined);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
  if (opts.ready) await until(() => out.includes('ready'), 'the child is ready');
  return { child, pid: child.pid!, out: () => out, exit };
}

/**
 * Start `source` without waiting for anything (usable while this thread is blocked, e.g. inside a
 * synchronous hook): the child writes its result to a file instead of a pipe.
 */
export function spawnDetached(dir: string, tmpdir: string, source: string, args: string[]): ChildProcess {
  const script = path.join(dir, `child-${process.pid}-${scripts++}.mjs`);
  fs.writeFileSync(script, source);
  const child = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'ignore', 'inherit'], env: { ...process.env, TMPDIR: tmpdir } });
  children.push(child);
  child.stdin!.on('error', () => undefined);
  return child;
}

/**
 * A chat-like lock holder: takes the lock of `id` through the store and prints `ready`; at SIGHUP
 * or SIGTERM it closes as the chat does: `release` releases the lock and exits 0, `die` exits 0
 * leaving it (a close whose grace ran out). With a JSON `change` it first saves the record changed
 * as given (`set`: fields assigned; `turn`: a turn appended, `messageCount` + 1; `drop`: the
 * record removed, as a chat that never had a message drops it), the way the chat's close saves
 * what it had (the turn it was running, settled as interrupted).
 */
export const HOLDER = `const [storeUrl, dir, id, mode, change] = process.argv.slice(2);
const { SessionStore } = await import(storeUrl);
const fs = await import('node:fs');
const store = new SessionStore(dir);
const lock = store.acquireLock(id);
const close = () => {
  if (change) {
    const c = JSON.parse(change);
    if (c.drop) fs.rmSync(store.pathFor(id), { force: true });
    else {
      const rec = store.read(id);
      Object.assign(rec, c.set ?? {});
      if (c.turn) { rec.turns.push(c.turn); rec.messageCount += 1; if (!rec.title) rec.title = c.turn.preview; }
      store.write(rec);
    }
  }
  if (mode === 'release') lock.release();
  process.exit(0);
};
process.on('SIGHUP', close);
process.on('SIGTERM', close);
process.stdout.write('ready\\n');
setInterval(() => {}, 1 << 30);
`;

/**
 * Takes the lock of `id` once the clock reaches `at` (ms; a busy wait, so that every opener starts
 * at the same moment) and writes `GOT` or `ERR <message>` to stdout, or to the file `resultFile`
 * when given; holds the lock until its stdin ends.
 */
export const OPENER = `const [storeUrl, dir, id, at, resultFile] = process.argv.slice(2);
const { SessionStore } = await import(storeUrl);
const fs = await import('node:fs');
const store = new SessionStore(dir);
const say = (s) => { if (resultFile) fs.writeFileSync(resultFile, s); else process.stdout.write(s + '\\n'); };
while (Date.now() < Number(at || 0)) {}
try {
  const lock = store.acquireLock(id);
  say('GOT');
  process.stdin.on('end', () => { lock.release(); process.exit(0); });
  process.stdin.resume();
} catch (e) {
  say('ERR ' + e.message);
  process.exit(0);
}
`;

/** Blocking wait for `file` to hold something (from a child started with {@link spawnDetached}). */
export function waitForFileSync(file: string, ms: number): string | undefined {
  const t0 = Date.now();
  for (;;) {
    try {
      const s = fs.readFileSync(file, 'utf8');
      if (s !== '') return s;
    } catch {
      // not yet
    }
    if (Date.now() - t0 > ms) return undefined;
    sleepSync(5);
  }
}
