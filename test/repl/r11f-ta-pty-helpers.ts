/**
 * Shared helpers of the round-11 "terminal-a" pty tests (r11f-ta-selfstop-pty.test.ts,
 * r11f-ta-sudo-pty.test.ts): a python3 pty driver running an interactive bash (job control), the
 * built CLI over test/fixtures/fake-claude.mjs, temp dirs only (test/headless/r5f-signals-helpers.ts
 * mkRoot, removed on exit), and what a test reads back (the screen, /proc state, bash's job state).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { mkRoot, sleep, type Root } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';

const PTY_DRIVER = String.raw`
import os, pty, sys, select, signal, struct, fcntl, termios, time
argv = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
stop = [False]
signal.signal(signal.SIGTERM, lambda s, f: stop.__setitem__(0, True))
inp = sys.stdin.fileno()
inp_open = True
status = None
while status is None:
    if stop[0]:
        try:
            os.close(master)
        except OSError:
            pass
        end = time.time() + 4
        while status is None and time.time() < end:
            w, st = os.waitpid(pid, os.WNOHANG)
            if w == pid:
                status = st
            else:
                time.sleep(0.02)
        if status is None:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            _, status = os.waitpid(pid, 0)
        break
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
`;

export const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout?.trim() ?? '';
const HAVE_PTY = process.platform === 'linux' && spawnSync('python3', ['-I', '-c', 'import pty, termios, fcntl'], { stdio: 'ignore' }).status === 0;
/** Skip reason for a bash-in-a-pty test, or false. */
export const skipPty: string | false = HAVE_PTY ? (BASH ? false : 'needs bash') : 'needs Linux and python3 (pty)';

/** Passwordless sudo whose policy says `use_pty` (sudo then relays the command's terminal through a pty of its own). */
export function sudoUsePty(): boolean {
  if (process.platform !== 'linux') return false;
  const r = spawnSync('sudo', ['-n', '-l'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 && /\buse_pty\b/.test(r.stdout ?? '');
}

export { sleep };

export async function waitUntil(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

/** The state letter of /proc/<pid>/stat, or 'gone'. */
export function procState(pid: number): string {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[0] ?? 'gone';
  } catch {
    return 'gone';
  }
}

/** The process group of `pid` (/proc/<pid>/stat). */
export function procPgrp(pid: number): number {
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[2]);
}

export interface Term {
  write(s: string): void;
  /** The screen so far, CSI sequences removed. */
  screen(): string;
  /** Everything written to the terminal so far. */
  raw(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  /** The chat's pid (from its session lock). */
  chatPid(): number;
  /** Close the terminal (the driver closes the pty master: a hangup) and wait for the driver to end. */
  hangup(): Promise<void>;
  /** {@link hangup}, then kill a chat that outlived it and remove the temp root. */
  dispose(): Promise<void>;
  /** True once the driver (and so the terminal) is gone. */
  closed(): boolean;
}

export interface Setup {
  r: Root;
  t: Term;
  /** The SessionEnd hook's log (one JSON payload per closed session). */
  ended: string;
}

export const SCRIPT = { turns: [{ repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] }] };
/** Claude Code answers `initialize` this late: the chat is still starting meanwhile. */
export const SLOW_START = { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 2500 }) };

/** A temp root with a SessionEnd hook, and an interactive bash in a pty there. */
export function setup(opts: { script?: unknown; env?: Record<string, string>; prepare?: (r: Root) => void } = {}): Setup {
  const r = mkRoot(opts.script ?? SCRIPT);
  removeOnExit(r.root);
  const ended = path.join(r.root, 'ended.jsonl');
  const dir = path.join(r.ws, '.kiro', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'end.json'),
    JSON.stringify({ version: 'v1', hooks: [{ name: 'end', trigger: 'SessionEnd', timeout: 0, action: { type: 'command', command: `cat >> '${ended}'; echo >> '${ended}'` } }] }),
  );
  opts.prepare?.(r);
  return { r, t: underBash(r, opts.env), ended };
}

function underBash(r: Root, extra: Record<string, string> = {}): Term {
  const driver = path.join(r.root, 'pty.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const env = r.env({ TERM: 'xterm', PS1: 'BASH$ ', ...extra });
  const py = spawn('python3', ['-I', driver, BASH, '--norc', '--noprofile', '-i'], { cwd: r.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let done = false;
  py.stdout.on('data', (d: Buffer) => (out += d.toString()));
  py.stderr.on('data', () => undefined);
  py.stdin.on('error', () => undefined);
  const exited = new Promise((res) =>
    py.on('exit', () => {
      done = true;
      res(undefined);
    }),
  );
  const screen = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let pid: number | undefined;
  const ours = (p: number): boolean => {
    try {
      return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(builtBin());
    } catch {
      return false;
    }
  };
  return {
    write: (s) => {
      if (!done) py.stdin.write(s);
    },
    screen,
    raw: () => out,
    async waitFor(re, what, from = 0, ms = 20_000) {
      const t0 = Date.now();
      while (!re.test(screen().slice(from))) {
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n--- screen:\n${JSON.stringify(screen().slice(from).slice(-2000))}`);
        await sleep(10);
      }
    },
    chatPid() {
      if (pid === undefined) {
        const lock = r.locks()[0];
        assert.ok(lock, 'no session lock');
        pid = (JSON.parse(fs.readFileSync(path.join(r.sessions, lock), 'utf8')) as { pid: number }).pid;
      }
      return pid;
    },
    closed: () => done,
    async hangup() {
      if (done) return;
      py.kill('SIGTERM');
      await Promise.race([exited, sleep(6000)]);
      if (!done) py.kill('SIGKILL');
    },
    async dispose() {
      await this.hangup();
      // only the kiro-claude this test started, should it outlive its terminal
      if (pid !== undefined && ours(pid)) {
        try {
          process.kill(pid, 'SIGCONT');
          process.kill(pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
      await sleep(100);
      r.cleanup();
    },
  };
}

/** The command line that starts the chat (`prefix`: e.g. `sudo -E `). */
export function chatCommand(prefix = '', args = ''): string {
  return `${prefix}'${process.execPath}' '${builtBin()}' chat${args}`;
}

/** Start the chat at the bash prompt and wait until it holds its session lock (it is starting). */
export async function startChat(t: Term, r: Root, opts: { prefix?: string; amp?: boolean; pipe?: string } = {}): Promise<number> {
  await t.waitFor(/BASH\$ $/, 'bash prompt');
  t.write(`${chatCommand(opts.prefix)}${opts.pipe ?? ''}${opts.amp ? ' &' : ''}\r`);
  await waitUntil(() => r.locks().length === 1, 'the session lock', 20_000);
  return t.chatPid();
}

/** Start the chat in the foreground and wait for its prompt. */
export async function startAtPrompt(t: Term, r: Root, opts: { prefix?: string; pipe?: string } = {}): Promise<number> {
  const mark = t.screen().length;
  const pid = await startChat(t, r, opts);
  await t.waitFor(/Welcome to[\s\S]*> $/, 'the chat prompt', mark, 30_000);
  return pid;
}

/**
 * bash's state of job %1 (`jobs -l`, which names the stop signal: 'Stopped (tty input)' for
 * SIGTTIN, 'Stopped (tty output)' for SIGTTOU, plain 'Stopped' for SIGTSTP / SIGSTOP), or 'Running'.
 */
export async function jobState(t: Pick<Term, 'write' | 'screen' | 'waitFor'>): Promise<string> {
  const mark = t.screen().length;
  t.write('jobs -l\r');
  await t.waitFor(/jobs -l\r?\n[\s\S]*\[1\][+-]? +\d+ +\S[\s\S]*BASH\$ $/, 'the job list', mark, 10_000);
  const list = t.screen().slice(mark);
  const m = /\[1\][+-]? +\d+ +(\S+(?: \([^)]*\))?)/.exec(list.slice(list.indexOf('jobs -l')));
  return m?.[1] ?? '';
}

/**
 * {@link jobState} once bash counts job %1 stopped: `jobs -l` is asked again (every 100 ms, up to
 * `ms`) while it reads 'Running'. bash learns of a stop from its SIGCHLD and counts a job stopped
 * only once every process of it has stopped (`| cat`, a wrapper), so right after /proc shows the
 * chat in state T `jobs -l` can still list the job Running (r12g T1: such a one-shot check failed
 * once in a full suite). Returns the last state read ('Running' at the deadline).
 */
export async function stoppedJobState(t: Pick<Term, 'write' | 'screen' | 'waitFor'>, ms = 10_000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const state = await jobState(t);
    if (state !== 'Running' || Date.now() - t0 > ms) return state;
    await sleep(100);
  }
}

/** The chat stops by itself (it needs the terminal and is in the background): state T, and bash says 'Stopped (tty input)'. */
export async function stopsForTerminal(t: Term, pid: number, ms = 10_000): Promise<void> {
  await waitUntil(() => procState(pid) === 'T', `the chat stops in the background (state ${procState(pid)})`, ms);
  // (bash may not count the job stopped yet: asked until it does, r12g T1)
  assert.equal(await stoppedJobState(t), 'Stopped (tty input)');
}

/** Nothing of the chat's own (greeting, prompt) drawn after `mark`. */
export function nothingDrawn(t: Term, mark: number): void {
  assert.doesNotMatch(t.screen().slice(mark).replace(/BASH\$ /g, ''), /Welcome to|You are chatting with|(^|\n)> /, `drawn from the background:\n${JSON.stringify(t.screen().slice(mark))}`);
}

/**
 * The chat `pid` and those of its ancestors whose command line names the built CLI: the processes of
 * its job under bash (`sudo` and its monitor, a `bash -c` wrapper).
 */
function chatJob(pid: number): number[] {
  const out = [pid];
  let p = pid;
  for (let i = 0; i < 8; i++) {
    let parent: number;
    let cmd: string;
    try {
      const s = fs.readFileSync(`/proc/${p}/stat`, 'utf8');
      parent = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
      cmd = parent > 1 ? fs.readFileSync(`/proc/${parent}/cmdline`, 'utf8') : '';
    } catch {
      break;
    }
    if (!cmd.includes(builtBin())) break;
    out.push(parent);
    p = parent;
  }
  return out;
}

/** `kill %1`: gone at once, exit status 143, nothing printed after the signal, lock released, SessionEnd ran. */
export async function killedCleanly(s: Setup, pid: number, opts: { notPrinted?: RegExp } = {}): Promise<void> {
  const { r, t, ended } = s;
  const mark = t.screen().length;
  const job = chatJob(pid);
  const t0 = Date.now();
  t.write('kill %1\r');
  await waitUntil(() => procState(pid) === 'gone', `the chat ends after \`kill %1\` (state ${procState(pid)})`, 10_000);
  // `wait %1` only once bash has reaped the job's process (under sudo the chat is gone before
  // sudo is): bash marks a stopped job running only when its continue reaches it (SIGCHLD), so an
  // earlier `wait` can find it still stopped and return 148
  await waitUntil(() => job.every((p) => procState(p) === 'gone'), `the chat's job ends after \`kill %1\` (${job.map(procState).join(' ')})`, 10_000);
  // README: the close gets at most 2 s
  assert.ok(Date.now() - t0 < 7000, `the chat ended ${Date.now() - t0} ms after \`kill %1\``);
  t.write('wait %1; echo "EXIT=$?"\r');
  await t.waitFor(/EXIT=\d+/, 'the job status', mark, 10_000);
  const after = t.screen().slice(mark);
  assert.match(after, /EXIT=143/, after);
  nothingDrawn(t, mark);
  if (opts.notPrinted) assert.doesNotMatch(after, opts.notPrinted, `printed after the signal:\n${JSON.stringify(after)}`);
  assert.deepEqual(r.locks(), [], 'the session lock is left');
  await waitUntil(() => fs.existsSync(ended) && fs.readFileSync(ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
}

/** After `mark`: the prompt is up; a line is answered once (the chat reads the terminal). */
export async function answers(t: Term, mark: number, line = 'hello', ms = 20_000): Promise<void> {
  await t.waitFor(/> $/, 'the chat prompt', mark, ms);
  const m = t.screen().length;
  t.write(`${line}\r`);
  await t.waitFor(new RegExp(`ANSWER to ${line}[\\s\\S]*> $`), `the answer to ${line}`, m, 15_000);
  await sleep(200);
  assert.equal(t.screen().slice(m).match(new RegExp(`ANSWER to ${line}`, 'g'))?.length, 1, t.screen().slice(m));
}

/** `/quit`: the chat ends with status 0 and its lock released. */
export async function quits(t: Term, r: Root, pid: number): Promise<void> {
  const mark = t.screen().length;
  t.write('/quit\r');
  await waitUntil(() => procState(pid) === 'gone', 'the chat ends after /quit', 15_000);
  t.write('echo "EXIT=$?"\r');
  await t.waitFor(/EXIT=\d+/, 'the exit status', mark, 10_000);
  assert.match(t.screen().slice(mark), /EXIT=0/);
  assert.deepEqual(r.locks(), []);
}

/** Ctrl+Z at the prompt; bash reports the job stopped. */
export async function ctrlZ(t: Term, pid: number): Promise<void> {
  const mark = t.screen().length;
  t.write('\x1a');
  await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
  await waitUntil(() => procState(pid) === 'T', 'stopped', 5000);
}

/** `bg`; bash's prompt is back. */
export async function bg(t: Term): Promise<void> {
  const mark = t.screen().length;
  t.write('bg\r');
  await t.waitFor(/BASH\$ $/, 'bash prompt after bg', mark + 3);
}
