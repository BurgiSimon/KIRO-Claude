/**
 * r12 #1 (session group), in a real terminal under `sudo` with `Defaults use_pty`: a chat stopped in
 * the background (Ctrl+Z at the prompt and `bg`, after which it stops itself because it needs the
 * terminal; or a plain Ctrl+Z) whose terminal is then closed. bash sends sudo SIGHUP and SIGCONT;
 * sudo passes the SIGHUP on to the chat but, its user's terminal gone, never continues it (as for any
 * program it runs), so the chat stays stopped with SIGHUP pending and its lock held: the residual
 * the README now describes. `kiro-claude chat --resume` in a new terminal then continues it (the
 * session store's hung-up holder recovery): the old chat closes as at a hangup (its SessionEnd hook
 * runs), and the new chat comes up on the conversation and answers.
 *
 * Interactive bash in a python3 pty (test/repl/r11f-ta-pty-helpers.ts), the fake claude, temp HOME;
 * the second terminal is a python3 pty running `sudo -n -E kiro-claude chat --resume` directly.
 * Skipped without python3, bash or passwordless sudo with use_pty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import type { Root } from '../headless/r5f-signals-helpers.js';
import { answers, bg, ctrlZ, procState, setup, skipPty, sleep, startAtPrompt, startChat, sudoUsePty, waitUntil, type Setup } from './r11f-ta-pty-helpers.js';

const skip = skipPty || (sudoUsePty() ? false : 'needs passwordless sudo with use_pty');
const SUDO = 'sudo -n -E ';

/** A pty running `argv` directly (no shell): its screen, keys, and its end. */
const DRIVER = String.raw`
import os, pty, sys, select, signal, struct, fcntl, termios, time
pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
stop = [False]
signal.signal(signal.SIGTERM, lambda s, f: stop.__setitem__(0, True))
inp = sys.stdin.fileno()
inp_open = True
status = None
while status is None and not stop[0]:
    fds = [master] + ([inp] if inp_open else [])
    try:
        r, _, _ = select.select(fds, [], [], 0.05)
    except InterruptedError:
        continue
    if master in r:
        try:
            d = os.read(master, 65536)
        except OSError:
            d = b''
        if d:
            os.write(1, d)
    if inp_open and inp in r:
        d = os.read(inp, 65536)
        if d:
            os.write(master, d)
        else:
            inp_open = False
    w, st = os.waitpid(pid, os.WNOHANG)
    if w == pid:
        status = st
if status is None:
    os.close(master)
    end = time.time() + 4
    while status is None and time.time() < end:
        w, st = os.waitpid(pid, os.WNOHANG)
        if w == pid:
            status = st
        else:
            time.sleep(0.02)
    if status is None:
        os.kill(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) & 0xff)
`;

interface Pty {
  write(s: string): void;
  screen(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  exit: Promise<number | null>;
  close(): Promise<void>;
}

/** `sudo -n -E node <bin> chat <args…>` in a fresh pty, environment of the root `r`. */
function chatInNewTerminal(r: Root, args: string[]): Pty {
  const driver = path.join(r.root, 'pty2.py');
  fs.writeFileSync(driver, DRIVER);
  const env = r.env({ TERM: 'xterm' });
  const py = spawn('python3', ['-I', driver, 'sudo', '-n', '-E', process.execPath, builtBin(), 'chat', ...args], { cwd: r.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  py.stdout.on('data', (d: Buffer) => (out += d.toString()));
  py.stderr.on('data', () => undefined);
  py.stdin.on('error', () => undefined);
  const exit = new Promise<number | null>((res) => py.on('exit', (code) => res(code)));
  const screen = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return {
    write: (s) => py.stdin.write(s),
    screen,
    async waitFor(re, what, from = 0, ms = 30_000) {
      const t0 = Date.now();
      while (!re.test(screen().slice(from))) {
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n--- screen:\n${JSON.stringify(screen().slice(from).slice(-2000))}`);
        await sleep(10);
      }
    },
    exit,
    async close() {
      if (py.exitCode !== null) return;
      py.kill('SIGTERM');
      if ((await within(exit.then(() => true), 6000)) === undefined) py.kill('SIGKILL');
    },
  };
}

function hupPending(pid: number): boolean {
  try {
    const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return [...st.matchAll(/^(?:SigPnd|ShdPnd):\s*([0-9a-f]+)$/gm)].some((m) => (Number.parseInt(m[1]!.slice(-4), 16) & 1) !== 0);
  } catch {
    return false;
  }
}

/** `p`'s value, or undefined after `ms` (the timer is cleared: it never keeps the test process alive). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((res) => (timer = setTimeout(() => res(undefined), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

const endings = (s: Setup): number => (fs.existsSync(s.ended) ? fs.readFileSync(s.ended, 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0);

/** The terminal closes; the chat stays stopped with SIGHUP pending (sudo's relay); then `chat --resume` in a new terminal. */
async function hangupThenResume(s: Setup, pid: number): Promise<void> {
  await s.t.hangup();
  await waitUntil(() => hupPending(pid), `SIGHUP pending in the stopped chat (state ${procState(pid)})`, 10_000);
  await sleep(1000);
  assert.equal(procState(pid), 'T', 'under sudo use_pty the hung-up chat is never continued by sudo');
  assert.equal(endings(s), 0, 'its SessionEnd has not run');
  assert.equal(s.r.locks().length, 1, 'it holds its lock');

  const t2 = chatInNewTerminal(s.r, ['--resume']);
  try {
    const t0 = Date.now();
    await t2.waitFor(/Picking up where we left off[\s\S]*You are chatting with[\s\S]*> $/, 'the resumed chat’s prompt', 0, 40_000);
    const ms = Date.now() - t0;
    if (process.env.KC_R12F_TIMING) process.stderr.write(`resumed chat up after ${ms} ms\n`);
    assert.equal(procState(pid), 'gone', 'the old chat closed');
    assert.equal(endings(s), 1, 'the old chat’s SessionEnd ran');
    assert.doesNotMatch(t2.screen(), /active in another process/);
    const mark = t2.screen().length;
    t2.write('again\r');
    await t2.waitFor(/ANSWER to again[\s\S]*> $/, 'the answer in the resumed chat', mark, 20_000);
    t2.write('/quit\r');
    assert.equal(await within(t2.exit, 20_000), 0, t2.screen().slice(-1000));
    assert.equal(endings(s), 2);
    assert.deepEqual(s.r.locks(), []);
    // what the user sees meanwhile: nothing more than a start that takes a moment longer
    assert.ok(ms < 20_000, `the resumed chat came up after ${ms} ms`);
  } finally {
    await t2.close();
  }
}

test('sudo use_pty: Ctrl+Z at the prompt and bg (the chat stops itself), terminal closed: chat --resume in a new terminal works', { skip, timeout: 180_000 }, async () => {
  const s = setup();
  try {
    const pid = await startAtPrompt(s.t, s.r, { prefix: SUDO });
    await answers(s.t, 0, 'hello');
    await ctrlZ(s.t, pid);
    await bg(s.t);
    await sleep(500);
    assert.equal(procState(pid), 'T', 'the chat stopped itself after bg');
    await hangupThenResume(s, pid);
  } finally {
    await s.t.dispose();
  }
});

test('sudo use_pty: a plain Ctrl+Z, terminal closed: chat --resume in a new terminal works', { skip, timeout: 180_000 }, async () => {
  const s = setup();
  try {
    const pid = await startAtPrompt(s.t, s.r, { prefix: SUDO });
    await answers(s.t, 0, 'hello');
    await ctrlZ(s.t, pid);
    await hangupThenResume(s, pid);
  } finally {
    await s.t.dispose();
  }
});

test('sudo use_pty: `sudo kiro-claude chat &` (stops itself before its greeting), terminal closed: a new chat --resume comes up and the old one is gone', { skip, timeout: 180_000 }, async () => {
  const s = setup();
  try {
    const pid = await startChat(s.t, s.r, { prefix: SUDO, amp: true });
    await waitUntil(() => procState(pid) === 'T', 'self-stop', 15_000);
    await s.t.hangup();
    await waitUntil(() => hupPending(pid), `SIGHUP pending in the stopped chat (state ${procState(pid)})`, 10_000);
    const t2 = chatInNewTerminal(s.r, ['--resume']);
    try {
      await t2.waitFor(/You are chatting with[\s\S]*> $/, 'the new chat’s prompt', 0, 40_000);
      assert.equal(procState(pid), 'gone', 'the old chat closed');
      assert.doesNotMatch(t2.screen(), /active in another process/);
      assert.equal(endings(s), 1, 'the old chat’s SessionEnd ran');
      const mark = t2.screen().length;
      t2.write('again\r');
      await t2.waitFor(/ANSWER to again[\s\S]*> $/, 'the answer in the new chat', mark, 20_000);
      t2.write('/quit\r');
      assert.equal(await within(t2.exit, 20_000), 0, t2.screen().slice(-1000));
      assert.deepEqual(s.r.locks(), []);
    } finally {
      await t2.close();
    }
  } finally {
    await s.t.dispose();
  }
});
