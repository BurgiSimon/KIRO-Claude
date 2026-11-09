/**
 * r12 #1 (session group), through the built CLI: a real kiro-claude chat that holds its session
 * (here a headless `chat --no-interactive` in the middle of a long turn) is stopped (SIGSTOP) and
 * then sent SIGHUP while stopped, which stays pending: what sudo with `use_pty` leaves behind when
 * the terminal of a stopped chat closes. `chat --resume-id <id>` then continues it (SIGCONT), the
 * old chat closes as at a hangup (its SessionEnd hook runs, it dies of SIGHUP) and the new chat
 * runs on the session; `chat --delete-session <id>` deletes it the same way. A chat stopped with
 * nothing pending (an ordinary Ctrl+Z in a terminal still open) is left alone: the error text is
 * unchanged and the chat stays stopped.
 *
 * Temp root, fake claude (test/headless/r5f-signals-helpers.ts mkRoot); every child gets TMPDIR in
 * the root and is killed by the test that started it.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, mkRoot, sessionEndHook, sleep, type Cli, type Root } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';

const skip = process.platform === 'linux' && fs.existsSync('/proc/self/stat') ? false : 'needs Linux /proc';
const SCRIPT = {
  turns: [
    { match: 'slow', repeat: true, steps: [{ text: 'working on it' }, { sleepMs: 120_000 }, { text: 'done' }] },
    { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] },
  ],
};

const started: Cli[] = [];

/** `p`'s value, or undefined after `ms` (the timer is cleared: it never keeps the test process alive). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((res) => (timer = setTimeout(() => res(undefined), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * End a chat this test started the way `kill %1` does (SIGTERM, then SIGCONT), so it closes and ends
 * its own Claude Code child; SIGKILL only if it outlives its close grace.
 */
async function end(c: Cli): Promise<void> {
  const pid = c.child.pid;
  if (pid === undefined || c.child.exitCode !== null || c.child.signalCode !== null) return;
  try {
    process.kill(pid, 'SIGTERM');
    process.kill(pid, 'SIGCONT');
  } catch {
    return;
  }
  if (await within(c.exit, 8000)) return;
  c.dispose();
}

after(async () => {
  await Promise.all(started.map(end));
});

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

async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

interface Setup {
  r: Root;
  ended: string;
  tmpdir: string;
  holder: Cli;
  pid: number;
  sid: string;
}

/** A headless chat in the middle of a long turn, holding its session's lock; stopped, then `sig` sent while stopped. */
async function holderStopped(sig?: 'SIGHUP'): Promise<Setup> {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const ended = path.join(r.root, 'ended.jsonl');
  sessionEndHook(r, `cat >> '${ended}'; echo >> '${ended}'`);
  const tmpdir = path.join(r.root, 'tmp');
  fs.mkdirSync(tmpdir);
  // a conversation with a finished turn (a chat that never had one is dropped at its close)
  const first = cli(r, ['chat', '--no-interactive', 'first'], { stdin: 'ignore', env: { TMPDIR: tmpdir } });
  started.push(first);
  assert.equal((await first.exit).code, 0, first.o());
  assert.equal(r.records().length, 1);
  const sid = r.records()[0]!.sessionId;
  fs.rmSync(ended, { force: true });
  const holder = cli(r, ['chat', '--resume-id', sid, '--no-interactive', '--trust-all-tools', 'slow task'], { stdin: 'ignore', env: { TMPDIR: tmpdir } });
  started.push(holder);
  await holder.waitFor(/working on it/, 0, 30_000);
  assert.deepEqual(r.locks(), [`${sid}.lock`]);
  const pid = holder.child.pid!;
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.sessions, `${sid}.lock`), 'utf8')).pid, pid);
  process.kill(pid, 'SIGSTOP');
  await until(() => allStopped(pid), 'the chat is stopped');
  if (sig) {
    process.kill(pid, sig);
    await until(() => hupPending(pid), 'SIGHUP is pending');
    await sleep(200);
    assert.equal(state(pid), 'T', 'a SIGHUP sent to a stopped chat stays pending');
  }
  return { r, ended, tmpdir, holder, pid, sid };
}

const endings = (s: Setup): number => (fs.existsSync(s.ended) ? fs.readFileSync(s.ended, 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0);

async function runCli(s: Setup, args: string[]): Promise<{ code: number | null; out: string; ms: number }> {
  const t0 = Date.now();
  const c = cli(s.r, args, { stdin: 'ignore', env: { TMPDIR: s.tmpdir } });
  started.push(c);
  const exit = await within(c.exit, 60_000);
  if (!exit) {
    c.dispose();
    throw new Error(`timeout: ${args.join(' ')}\n${c.o()}`);
  }
  return { code: exit.code, out: c.o(), ms: Date.now() - t0 };
}

describe('r12f chat: a session held by a chat stopped with a hangup pending', { skip }, () => {
  it('chat --resume-id continues the stopped chat, which closes (SessionEnd, dies of SIGHUP), and runs on the session', async () => {
    const s = await holderStopped('SIGHUP');
    assert.equal(endings(s), 0);
    const r = await runCli(s, ['chat', '--resume-id', s.sid, '--no-interactive', 'again']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ANSWER to again/);
    assert.doesNotMatch(r.out, /active in another process/);
    assert.deepEqual(await s.holder.exit, { code: null, signal: 'SIGHUP' });
    // the old chat's SessionEnd, then the new one's
    assert.equal(endings(s), 2, fs.existsSync(s.ended) ? fs.readFileSync(s.ended, 'utf8') : '');
    assert.deepEqual(s.r.locks(), []);
  });

  it('chat --delete-session continues the stopped chat, waits for its close and deletes the session', async () => {
    const s = await holderStopped('SIGHUP');
    const r = await runCli(s, ['chat', '--delete-session', s.sid]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Deleted chat session ${s.sid}`));
    assert.deepEqual(await s.holder.exit, { code: null, signal: 'SIGHUP' });
    assert.equal(endings(s), 1);
    assert.deepEqual(s.r.locks(), []);
    assert.equal(fs.existsSync(path.join(s.r.sessions, `${s.sid}.json`)), false, 'the record is deleted (not written back by the closing chat)');
  });
});

describe('r12f chat: a session held by a chat stopped with nothing pending (an ordinary Ctrl+Z)', { skip }, () => {
  it('chat --resume-id and --delete-session refuse with the unchanged text; the chat stays stopped with its lock', async () => {
    const s = await holderStopped();
    const resume = await runCli(s, ['chat', '--resume-id', s.sid, '--no-interactive', 'again']);
    assert.notEqual(resume.code, 0);
    assert.match(resume.out, new RegExp(`Failed to start session: Session is active in another process \\(PID ${s.pid}\\)`));
    const del = await runCli(s, ['chat', '--delete-session', s.sid]);
    assert.equal(del.code, 1, del.out);
    assert.match(del.out, new RegExp(`error: Session is active in another process \\(PID ${s.pid}\\)`));
    assert.ok(del.ms < 10_000);
    await sleep(200);
    assert.equal(state(s.pid), 'T');
    assert.deepEqual(s.r.locks(), [`${s.sid}.lock`]);
    assert.equal(fs.existsSync(path.join(s.r.sessions, `${s.sid}.json`)), true);
    assert.equal(endings(s), 0);
    // `kill %1` still closes it as before
    await end(s.holder);
    assert.deepEqual(await s.holder.exit, { code: null, signal: 'SIGTERM' });
    assert.equal(endings(s), 1);
    assert.deepEqual(s.r.locks(), []);
  });
});
