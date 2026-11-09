/**
 * Round-9 verification of the "stop-input" fix (findings #0/#1) in a real terminal: a python3 pty
 * driver running an interactive bash (job control), the built CLI over test/fixtures/fake-claude.mjs,
 * temp dirs only. The chat reads its keys from `/dev/tty` (`kiro-claude chat < /dev/tty`), the
 * controlling terminal under another device number than the pty's.
 *
 * The foreground test (repl/input.ts terminalInForeground) took that input for a terminal no job
 * control applies to and answered "foreground" in the background too. So:
 *  - after Ctrl+Z and `bg` the reader set raw mode from the background and SIGTTOU stopped the
 *    chat again ('Stopped (tty output)'), and `kill %1` (SIGTERM, then SIGCONT) then never closed
 *    it: the restarted tcsetattr stopped it again before its SIGTERM listener ran (r9 #1);
 *  - a `!cmd` that ended after Ctrl+Z and `bg` handed the terminal back from the background
 *    (Repl.handBack) with the same result: stopped for good, lock held, no SessionEnd until `fg`.
 * Now both stay off the terminal in the background, and `kill %1` closes them at once. Since r11 #2
 * they stop again by themselves there once they need the terminal, like a background job that reads
 * it (its own SIGTTIN at the default action: `jobs -l` says 'Stopped (tty input)', not the 'Stopped
 * (tty output)' of a restarting tcsetattr), which `kill %1` (SIGTERM, then SIGCONT) still closes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { mkRoot, sleep, type Root } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';
import { stoppedJobState } from './r11f-ta-pty-helpers.js';

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
        end = time.time() + 3
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

const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout?.trim() ?? '';
const HAVE_PTY =
  process.platform === 'linux' && spawnSync('python3', ['-I', '-c', 'import pty, termios, fcntl'], { stdio: 'ignore' }).status === 0;
const skip = HAVE_PTY ? (BASH ? false : 'needs bash') : 'needs Linux and python3 (pty)';

const SCRIPT = { turns: [{ repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] }] };

/** A SessionEnd hook (workspace hooks file) appending each closed session's payload to `file`. */
function sessionEndHook(r: Root, file: string): void {
  const dir = path.join(r.ws, '.kiro', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'end.json'), JSON.stringify({ version: 'v1', hooks: [{ name: 'end', trigger: 'SessionEnd', timeout: 0, action: { type: 'command', command: `cat >> '${file}'; echo >> '${file}'` } }] }));
}

async function waitUntil(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

/** The state letter of /proc/<pid>/stat, or 'gone'. */
function procState(pid: number): string {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[0] ?? 'gone';
  } catch {
    return 'gone';
  }
}

interface Term {
  write(s: string): void;
  /** The screen so far, CSI sequences removed. */
  screen(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  chatPid(): number;
  dispose(): Promise<void>;
}

function underBash(r: Root): Term {
  const driver = path.join(r.root, 'pty.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const env = r.env({ TERM: 'xterm', PS1: 'BASH$ ' });
  const py = spawn('python3', ['-I', driver, BASH, '--norc', '--noprofile', '-i'], { cwd: r.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let done = false;
  py.stdout.on('data', (d: Buffer) => (out += d.toString()));
  py.stderr.on('data', () => undefined);
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
    write: (s) => py.stdin.write(s),
    screen,
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
    async dispose() {
      if (!done) {
        py.kill('SIGTERM');
        await Promise.race([exited, sleep(5000)]);
        if (!done) py.kill('SIGKILL');
      }
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

/** `chat < /dev/tty` under bash, one answered prompt; the chat's pid. */
async function startChat(t: Term): Promise<number> {
  await t.waitFor(/BASH\$ $/, 'bash prompt');
  t.write(`'${process.execPath}' '${builtBin()}' chat < /dev/tty\r`);
  await t.waitFor(/chat[^\n]*\r?\n[\s\S]*> $/, 'chat prompt');
  const pid = t.chatPid();
  const mark = t.screen().length;
  t.write('hello\r');
  await t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the answer', mark);
  return pid;
}

/**
 * The chat stopped again by itself in the background (r11 #2): state T, and bash's `jobs -l` names
 * its own SIGTTIN ('Stopped (tty input)'), not a SIGTTOU from touching the terminal.
 */
async function stoppedForTerminal(t: Term, pid: number): Promise<void> {
  await waitUntil(() => procState(pid) === 'T', `the chat stops by itself in the background (state ${procState(pid)})`, 10_000);
  // (bash may not count the job stopped yet: `jobs -l` is asked until it does, r12g T1)
  assert.equal(await stoppedJobState(t), 'Stopped (tty input)');
}

/**
 * `kill %1` of the chat in the background (stopped by itself: bash sends SIGTERM, then SIGCONT): it
 * closes (the lock released, SessionEnd run) and dies of SIGTERM within the documented time,
 * printing nothing.
 */
async function killRunningJob(t: Term, r: Root, pid: number, ended: string): Promise<void> {
  const mark = t.screen().length;
  const t0 = Date.now();
  t.write('kill %1\r');
  await waitUntil(() => procState(pid) === 'gone', 'the chat ends after `kill %1` (stopped again: SIGTTOU)', 10_000);
  // README: the close gets at most 2 s
  assert.ok(Date.now() - t0 < 6000, `the chat ended after ${Date.now() - t0} ms`);
  t.write('wait %1; echo "EXIT=$?"\r');
  await t.waitFor(/EXIT=\d+/, 'the job status', mark, 10_000);
  assert.match(t.screen().slice(mark), /EXIT=143/, t.screen().slice(mark));
  assert.deepEqual(r.locks(), [], 'the session lock is left');
  await waitUntil(() => fs.existsSync(ended) && fs.readFileSync(ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
  assert.doesNotMatch(t.screen().slice(mark).replace(/BASH\$ /g, ''), /> /, 'the chat drew its prompt after the signal');
}

test('r9f-v: `chat < /dev/tty`, Ctrl+Z, `bg`: the chat stays off the terminal (stopped again by itself, r11 #2); `fg` takes it back; `kill %1` closes it', { skip, timeout: 120_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const ended = path.join(r.root, 'ended.jsonl');
  sessionEndHook(r, ended);
  const t = underBash(r);
  try {
    const pid = await startChat(t);
    let mark = t.screen().length;
    t.write('half');
    await t.waitFor(/half$/, 'the half-typed line', mark);
    t.write('\x1a');
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    mark = t.screen().length;
    t.write('bg\r');
    await t.waitFor(/BASH\$ $/, 'bash prompt after bg', mark + 3);
    await sleep(800);
    await stoppedForTerminal(t, pid);
    t.write('echo SHELL-OK\r');
    await t.waitFor(/SHELL-OK[\s\S]*BASH\$ $/, 'bash runs a command', mark);
    assert.doesNotMatch(t.screen().slice(mark), /> half/, 'the chat drew its prompt in the background');
    mark = t.screen().length;
    t.write('fg\r');
    await t.waitFor(/> half$/, 'the prompt and the half-typed line are back', mark, 10_000);
    t.write(' line\r');
    await t.waitFor(/ANSWER to half line[\s\S]*> $/, 'the input is read again', mark, 15_000);
    // once more into the background, then killed there
    mark = t.screen().length;
    t.write('\x1a');
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    mark = t.screen().length;
    t.write('bg\r');
    await t.waitFor(/BASH\$ $/, 'bash prompt after bg', mark + 3);
    await sleep(500);
    await stoppedForTerminal(t, pid);
    await killRunningJob(t, r, pid, ended);
  } finally {
    await t.dispose();
  }
});

test('r9f-v: `chat < /dev/tty`, a `!cmd` ends after Ctrl+Z and `bg`: the chat stays off the terminal (stopped again by itself, r11 #2) and `kill %1` closes it', { skip, timeout: 120_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const ended = path.join(r.root, 'ended.jsonl');
  const started = path.join(r.root, 'child-started');
  const done = path.join(r.root, 'child-done');
  sessionEndHook(r, ended);
  const t = underBash(r);
  try {
    const pid = await startChat(t);
    let mark = t.screen().length;
    t.write(`!touch '${started}'; sleep 1.5; touch '${done}'\r`);
    await waitUntil(() => fs.existsSync(started), 'the child runs', 10_000);
    t.write('\x1a'); // the terminal's own Ctrl+Z (cooked): the child and the chat stop together
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    mark = t.screen().length;
    t.write('bg\r');
    await t.waitFor(/BASH\$ $/, 'bash prompt after bg', mark + 3);
    await waitUntil(() => fs.existsSync(done), 'the child ends in the background', 10_000);
    await sleep(800);
    await stoppedForTerminal(t, pid);
    await killRunningJob(t, r, pid, ended);
  } finally {
    await t.dispose();
  }
});
