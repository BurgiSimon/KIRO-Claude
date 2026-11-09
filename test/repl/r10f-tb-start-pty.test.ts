/**
 * Round-10 fix "terminal-b" #1 in a real terminal: a python3 pty driver running an interactive bash
 * (job control), the built CLI over test/fixtures/fake-claude.mjs, temp dirs only.
 *
 * A chat stopped while it is still starting (Ctrl+Z while Claude Code has not answered
 * `initialize` yet: the terminal is still cooked, so the terminal's SIGTSTP stops the job;
 * FAKE_CLAUDE_CONTROL_DELAYS models a slow start), then `kill %1` (bash: SIGTERM, then SIGCONT) or
 * `bg`; and `kiro-claude chat &`. The initialize answer reaches the pipe during the stop and is read
 * before the signal after the continue, so run() went on to create the line reader, whose readline
 * set raw mode (a tcsetattr) from the background: SIGTTOU stopped the chat inside that ioctl, which
 * restarts after every SIGCONT, so the SIGTERM was never handled ('Stopped', lock held, no
 * SessionEnd) until `fg`, which then drew the greeting and the prompt before it died. Now the first
 * prompt waits off the terminal for the foreground, and what the chat writes to the terminal while
 * it starts in the background waits too (with `stty tostop` such a write stopped it the same way).
 * Since r11 #2 the chat stops by itself while it waits there, like a background job that reads its
 * terminal ('Stopped (tty input)', at the default action of its own SIGTTIN, not inside a
 * restarting ioctl), so the "waits off the terminal" checks expect that stop (before r11 they
 * asserted it kept running, which under `sudo` never came up after `fg`).
 *
 * Each kill checks: exit status 143, the lock released, SessionEnd ran, nothing printed after the
 * signal. Controls: Ctrl+Z while starting then `fg`, and `chat &` then `fg`, work.
 */
import { test } from 'node:test';
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
/** Claude Code answers `initialize` this late: the chat is still starting meanwhile. */
const SLOW_START = { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 2500 }) };
/** What the chat draws once its first prompt is up (greeting, prompt). */
const DRAWN = /Welcome to|You are chatting with|^> |\n> /;

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

/** Workspace hooks: SessionEnd appends each payload to `ended`; with `warn`, a SessionStart hook that fails (a notice while the chat starts). */
function hooks(r: Root, ended: string, warn = false): void {
  const dir = path.join(r.ws, '.kiro', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const list: unknown[] = [{ name: 'end', trigger: 'SessionEnd', timeout: 0, action: { type: 'command', command: `cat >> '${ended}'; echo >> '${ended}'` } }];
  if (warn) list.push({ name: 'warn', trigger: 'SessionStart', timeout: 0, action: { type: 'command', command: 'echo START-WARNING >&2; exit 1' } });
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ version: 'v1', hooks: list }));
}

interface Term {
  write(s: string): void;
  screen(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  chatPid(): number;
  dispose(): Promise<void>;
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

/** Start the chat (`&`: in the background) and wait until it holds its session lock (it is starting). */
async function startChat(t: Term, r: Root, prefix = '', amp = false): Promise<number> {
  await t.waitFor(/BASH\$ $/, 'bash prompt');
  t.write(`${prefix}'${process.execPath}' '${builtBin()}' chat${amp ? ' &' : ''}\r`);
  await waitUntil(() => r.locks().length === 1, 'the session lock', 15_000);
  return t.chatPid();
}

/** Ctrl+Z while the chat starts; the initialize answer then reaches the pipe during the stop. */
async function stopWhileStarting(t: Term, pid: number): Promise<void> {
  await sleep(300);
  const mark = t.screen().length;
  t.write('\x1a');
  await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
  assert.equal(procState(pid), 'T');
  await sleep(3500);
}

/**
 * In the background the chat waits off the terminal and draws nothing. Since r11 #2 it stops there
 * by itself, as a background job that reads its terminal does (its own SIGTTIN at the default
 * action: `jobs -l` says 'Stopped (tty input)'), never inside a restarting tcsetattr or write
 * (SIGTTOU, 'Stopped (tty output)'), which r10 #1 was about: `kill %1` must still close it.
 */
async function stopsOffTheTerminal(t: Term, pid: number, mark: number): Promise<void> {
  await waitUntil(() => procState(pid) === 'T', `the chat stops by itself in the background (state ${procState(pid)})`, 10_000);
  const m = t.screen().length;
  t.write('jobs -l\r');
  await t.waitFor(/jobs -l\r?\n[\s\S]*\[1\][+-]? +\d+ +\S[\s\S]*BASH\$ $/, 'the job list', m, 10_000);
  assert.match(t.screen().slice(m), /\[1\][+-]? +\d+ +Stopped \(tty input\)/, t.screen().slice(m));
  assert.doesNotMatch(t.screen().slice(mark).replace(/BASH\$ /g, ''), DRAWN, 'drawn from the background');
}

/** `kill %1`: gone at once, exit status 143, nothing printed after the signal, lock released, SessionEnd ran. */
async function killedCleanly(t: Term, r: Root, pid: number, ended: string): Promise<void> {
  const mark = t.screen().length;
  t.write('kill %1\r');
  await waitUntil(() => procState(pid) === 'gone', `the chat ends after \`kill %1\` (state ${procState(pid)})`, 10_000);
  t.write('wait %1; echo "EXIT=$?"\r');
  await t.waitFor(/EXIT=\d+/, 'the job status', mark, 10_000);
  const after = t.screen().slice(mark);
  assert.match(after, /EXIT=143/, after);
  assert.doesNotMatch(after.replace(/BASH\$ /g, ''), DRAWN, `printed after the signal:\n${JSON.stringify(after)}`);
  assert.doesNotMatch(after, /START-WARNING/, 'a notice held while starting was printed after the signal');
  assert.deepEqual(r.locks(), [], 'the session lock is left');
  await waitUntil(() => fs.existsSync(ended) && fs.readFileSync(ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
}

/** The prompt is up: a line is answered once; /quit ends the chat with status 0 and its lock released. */
async function works(t: Term, r: Root, pid: number, from: number): Promise<void> {
  await t.waitFor(/Welcome to[\s\S]*> $/, 'the greeting and the prompt', from);
  let mark = t.screen().length;
  t.write('hello\r');
  await t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the answer', mark);
  assert.equal(t.screen().slice(mark).match(/ANSWER to hello/g)?.length, 1);
  mark = t.screen().length;
  t.write('/quit\r');
  await waitUntil(() => procState(pid) === 'gone', 'the chat ends after /quit', 10_000);
  t.write('echo "EXIT=$?"\r');
  await t.waitFor(/EXIT=\d+/, 'the exit status', mark, 10_000);
  assert.match(t.screen().slice(mark), /EXIT=0/);
  assert.deepEqual(r.locks(), []);
}

function setup(warn = false): { r: Root; t: Term; ended: string } {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const ended = path.join(r.root, 'ended.jsonl');
  hooks(r, ended, warn);
  return { r, t: underBash(r, SLOW_START), ended };
}

test('r10f #1: Ctrl+Z while the chat starts, then `kill %1`: it closes and dies of SIGTERM without fg (lock released, SessionEnd ran, nothing drawn)', { skip, timeout: 120_000 }, async () => {
  const { r, t, ended } = setup();
  try {
    const pid = await startChat(t, r);
    await stopWhileStarting(t, pid);
    await killedCleanly(t, r, pid, ended);
  } finally {
    await t.dispose();
  }
});

test('r10f #1: Ctrl+Z while the chat starts, then `bg`: it waits off the terminal (stopped again by itself since r11 #2, nothing drawn); `kill %1` closes it', { skip, timeout: 120_000 }, async () => {
  const { r, t, ended } = setup();
  try {
    const pid = await startChat(t, r);
    await stopWhileStarting(t, pid);
    const mark = t.screen().length;
    t.write('bg\r');
    await t.waitFor(/BASH\$ $/, 'bash prompt after bg', mark);
    await stopsOffTheTerminal(t, pid, mark);
    await killedCleanly(t, r, pid, ended);
  } finally {
    await t.dispose();
  }
});

test('r10f #1 control: Ctrl+Z while the chat starts, then `fg`: the greeting and the prompt come up and it works', { skip, timeout: 120_000 }, async () => {
  const { r, t } = setup();
  try {
    const pid = await startChat(t, r);
    await stopWhileStarting(t, pid);
    const mark = t.screen().length;
    t.write('fg\r');
    await works(t, r, pid, mark);
  } finally {
    await t.dispose();
  }
});

test('r10f #1: Ctrl+Z while the chat starts, `bg`, then `fg` (of the job stopped again by itself, r11 #2): the prompt comes up and it works', { skip, timeout: 120_000 }, async () => {
  const { r, t } = setup();
  try {
    const pid = await startChat(t, r);
    await stopWhileStarting(t, pid);
    let mark = t.screen().length;
    t.write('bg\r');
    await t.waitFor(/BASH\$ $/, 'bash prompt after bg', mark);
    await stopsOffTheTerminal(t, pid, mark);
    mark = t.screen().length;
    t.write('fg\r');
    await works(t, r, pid, mark);
  } finally {
    await t.dispose();
  }
});

test('r10f #1: `kiro-claude chat &`, then `kill %1`: it closes and dies of SIGTERM (lock released, SessionEnd ran, nothing drawn)', { skip, timeout: 120_000 }, async () => {
  const { r, t, ended } = setup();
  try {
    const mark = t.screen().length;
    const pid = await startChat(t, r, '', true);
    await sleep(3500); // started, waiting for the foreground
    await stopsOffTheTerminal(t, pid, mark);
    await killedCleanly(t, r, pid, ended);
  } finally {
    await t.dispose();
  }
});

test('r10f #1 control: `kiro-claude chat &`, then `fg`: the greeting and the prompt come up and it works', { skip, timeout: 120_000 }, async () => {
  const { r, t } = setup();
  try {
    const pid = await startChat(t, r, '', true);
    await sleep(3500);
    const mark = t.screen().length;
    t.write('fg\r');
    await works(t, r, pid, mark);
  } finally {
    await t.dispose();
  }
});

test('r10f #1: `stty tostop`, `kiro-claude chat &` with a notice while it starts: it is not stopped by that write (only by its own stop for the terminal, r11 #2); `kill %1` closes it, the notice never printed', { skip, timeout: 120_000 }, async () => {
  const { r, t, ended } = setup(true);
  try {
    const mark = t.screen().length;
    const pid = await startChat(t, r, 'stty tostop; ', true);
    await sleep(3500); // the SessionStart hook failed meanwhile: its notice is held
    await stopsOffTheTerminal(t, pid, mark);
    assert.doesNotMatch(t.screen().slice(mark), /START-WARNING/, 'the notice was written from the background');
    await killedCleanly(t, r, pid, ended);
  } finally {
    await t.dispose();
  }
});

test('r10f #1: `stty tostop`, `kiro-claude chat &` with a notice while it starts, then `fg`: the notice comes first, then the greeting, and it works', { skip, timeout: 120_000 }, async () => {
  const { r, t } = setup(true);
  try {
    const pid = await startChat(t, r, 'stty tostop; ', true);
    await sleep(3500);
    const mark = t.screen().length;
    t.write('fg\r');
    await t.waitFor(/START-WARNING[\s\S]*Welcome to/, 'the held notice, then the greeting', mark);
    await works(t, r, pid, mark);
  } finally {
    await t.dispose();
  }
});

test('r10f #1/#2: `kiro-claude chat &`, then `sleep 0.6; fg` with hello + Enter typed during the sleep (cooked): submitted once at the first prompt', { skip, timeout: 120_000 }, async () => {
  const { r, t } = setup();
  try {
    const pid = await startChat(t, r, '', true);
    await sleep(3500);
    const mark = t.screen().length;
    t.write('sleep 0.6; fg\r');
    await sleep(250);
    t.write('hello\r');
    await t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the line typed before fg is answered', mark);
    await sleep(300);
    assert.equal(t.screen().slice(mark).match(/ANSWER to hello/g)?.length, 1, t.screen().slice(mark));
    t.write('/quit\r');
    await waitUntil(() => procState(pid) === 'gone', 'the chat ends after /quit', 10_000);
    assert.deepEqual(r.locks(), []);
  } finally {
    await t.dispose();
  }
});
