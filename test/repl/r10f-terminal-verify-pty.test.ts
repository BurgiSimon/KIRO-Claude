/**
 * Round-10 verification of the "terminal" group's fix for #2 in a real terminal: a python3 pty
 * driver running an interactive bash, the built CLI over test/fixtures/fake-claude.mjs, temp dirs
 * only (r10f-terminal-verify.test.ts has the unit level and the reasons).
 *
 * The keys the terminal queued in a cooked mode (no bracketed paste there; ICRNL makes Return a
 * newline) were read as typed whenever the reader turned raw mode on again, not only after the
 * background stretch the finding was about. So a multi-line paste while the chat started, or
 * during a `!cmd` that did not read it, became one prompt per line, and a pasted line starting with
 * `!` ran as a shell command, before any Enter; and a `y` + Return typed while an approval-time
 * `!cmd` ran allowed the tool. Before r10, and in Q (rustyline reads that newline as Ctrl+J, which
 * Q binds to insert a new line), those newlines were soft: one input, nothing run or answered
 * before an Enter at the prompt.
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

const SCRIPT = {
  turns: [
    { repeat: true, match: 'tool please', steps: [{ text: 'drafting ' }, { tool: { name: 'Bash', input: { command: 'touch made.txt' } } }, { text: 'after' }] },
    { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] },
  ],
};

async function waitUntil(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

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

function setup(extra: Record<string, string> = {}): { r: Root; t: Term; fakeLog: string } {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const fakeLog = path.join(r.root, 'fake.log');
  return { r, t: underBash(r, { FAKE_CLAUDE_LOG: fakeLog, ...extra }), fakeLog };
}

/** The approval answers kiro-claude sent to Claude Code (the fake's log). */
function approvals(fakeLog: string): string[] {
  if (!fs.existsSync(fakeLog)) return [];
  return fs
    .readFileSync(fakeLog, 'utf8')
    .split('\n')
    .filter((l) => l.includes('"control_response"') && l.includes('"behavior"'))
    .map((l) => (JSON.parse(l) as { line: { response: { response: { behavior: string } } } }).line.response.response.behavior);
}

async function quit(t: Term, r: Root, pid: number): Promise<void> {
  const mark = t.screen().length;
  t.write('/quit\r');
  await waitUntil(() => procState(pid) === 'gone', 'the chat ends after /quit', 10_000);
  t.write('echo "EXIT=$?"\r');
  await t.waitFor(/EXIT=\d+/, 'the exit status', mark, 10_000);
  assert.match(t.screen().slice(mark), /EXIT=0/);
  assert.deepEqual(r.locks(), []);
}

test('r10f verify: a multi-line paste while the chat starts (cooked terminal) stays one input: nothing is submitted, and a pasted `!` line is not run, before Enter', { skip, timeout: 120_000 }, async () => {
  const { r, t } = setup({ FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 3000 }) });
  try {
    await t.waitFor(/BASH\$ $/, 'bash prompt');
    t.write(`'${process.execPath}' '${builtBin()}' chat\r`);
    await waitUntil(() => r.locks().length === 1, 'the session lock', 15_000);
    const pid = t.chatPid();
    // a paste while it starts: the terminal sends Return as CR, ICRNL queues a newline
    assert.doesNotMatch(t.screen(), /Welcome to/, 'the chat was up before the paste (machine too slow for this test)');
    t.write('first line\r!touch pasted.txt\rthird\r');
    await t.waitFor(/Welcome to[\s\S]*> /, 'the greeting and the prompt');
    await sleep(1500);
    const before = t.screen();
    assert.doesNotMatch(before, /ANSWER to/, `a pasted line was submitted on its own:\n${JSON.stringify(before.slice(-800))}`);
    assert.equal(fs.existsSync(path.join(r.ws, 'pasted.txt')), false, 'a pasted `!` line ran as a shell command');
    // Enter at the prompt sends the paste as one prompt
    const mark = t.screen().length;
    t.write('\r');
    await t.waitFor(/ANSWER to first line[\s\S]*> $/, 'the answer', mark);
    const after = t.screen().slice(mark);
    assert.equal(after.match(/ANSWER to/g)?.length, 1, after);
    assert.match(after, /third/, after);
    assert.equal(fs.existsSync(path.join(r.ws, 'pasted.txt')), false);
    await quit(t, r, pid);
  } finally {
    await t.dispose();
  }
});

test('r10f verify: lines typed during a `!cmd` that ends in the foreground and does not read them stay one input at the next prompt (nothing run before Enter)', { skip, timeout: 120_000 }, async () => {
  const { r, t } = setup();
  try {
    await t.waitFor(/BASH\$ $/, 'bash prompt');
    t.write(`'${process.execPath}' '${builtBin()}' chat\r`);
    await t.waitFor(/Welcome to[\s\S]*> $/, 'the greeting and the prompt');
    const pid = t.chatPid();
    let mark = t.screen().length;
    t.write('!sleep 2\r');
    await sleep(500);
    t.write('one\r!touch typed.txt\r');
    await t.waitFor(/> one[\s\S]*touch typed\.txt/, 'the queued lines shown in the prompt', mark);
    await sleep(1000);
    const shown = t.screen().slice(mark);
    assert.doesNotMatch(shown, /ANSWER to/, `a line typed during the child was submitted on its own:\n${JSON.stringify(shown)}`);
    assert.equal(fs.existsSync(path.join(r.ws, 'typed.txt')), false, 'a typed `!` line ran as a shell command');
    mark = t.screen().length;
    t.write('\r');
    await t.waitFor(/ANSWER to one[\s\S]*> $/, 'the answer', mark);
    assert.equal(t.screen().slice(mark).match(/ANSWER to/g)?.length, 1);
    assert.equal(fs.existsSync(path.join(r.ws, 'typed.txt')), false);
    await quit(t, r, pid);
  } finally {
    await t.dispose();
  }
});

test('r10f verify: `y` + Return typed while an approval-time `!cmd` runs does not allow the tool (the answer needs an Enter at the question)', { skip, timeout: 120_000 }, async () => {
  const { r, t, fakeLog } = setup();
  try {
    await t.waitFor(/BASH\$ $/, 'bash prompt');
    t.write(`'${process.execPath}' '${builtBin()}' chat\r`);
    await t.waitFor(/Welcome to[\s\S]*> $/, 'the greeting and the prompt');
    const pid = t.chatPid();
    let mark = t.screen().length;
    t.write('tool please\r');
    await t.waitFor(/\[y\/n\/t\][\s\S]*> $/, 'the approval prompt', mark);
    mark = t.screen().length;
    t.write('!sleep 2\r');
    await sleep(500);
    // typed blind during the child (meant for it, a stray repeat, ...): not read by it
    t.write('y\r');
    await t.waitFor(/\[y\/n\/t\][\s\S]*> y/, 'the approval question asked again, with the queued y', mark);
    await sleep(1000);
    assert.deepEqual(approvals(fakeLog), [], 'a Return typed during the `!cmd` answered the approval');
    assert.equal(fs.existsSync(path.join(r.ws, 'made.txt')), false);
    // an Enter typed at the question answers it
    t.write('\r');
    await waitUntil(() => approvals(fakeLog).length === 1, 'the answer after Enter', 10_000);
    assert.deepEqual(approvals(fakeLog), ['allow']);
    await t.waitFor(/after[\s\S]*> $/, 'the turn ends', mark);
    await quit(t, r, pid);
  } finally {
    await t.dispose();
  }
});

/** utime + stime of `pid` in clock ticks (/proc/<pid>/stat), or undefined once it is gone. */
function cpuTicks(pid: number): number | undefined {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]);
  } catch {
    return undefined;
  }
}

function children(pid: number): number[] {
  try {
    return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

// The guard that catches SIGTTOU while a child owns the terminal (r10 #0) holds the chat's stream
// writes, but the debug log (util/log.ts) writes synchronously to its file. With
// KIRO_CHAT_LOG_FILE naming the terminal, `stty tostop`, and the chat continued in the background
// (Ctrl+Z inside a `!cmd`, `bg`), a log line made the write get SIGTTOU, the caught signal restart
// it, forever: 100% CPU, no JS, only SIGKILL ended it. The guard is not installed then: such a
// write stops the chat as before r10 (until `fg`).
test('r10f verify: a debug log on the terminal while a `!cmd` owns it, continued in the background with `stty tostop`: the log write does not spin (no SIGTTOU livelock)', { skip, timeout: 120_000 }, async () => {
  const { t } = setup({ KIRO_CHAT_LOG_FILE: '/dev/tty', KIRO_LOG_LEVEL: 'debug' });
  try {
    await t.waitFor(/BASH\$ $/, 'bash prompt');
    t.write('stty tostop\r');
    await t.waitFor(/stty tostop[\s\S]*BASH\$ $/, 'tostop');
    t.write(`'${process.execPath}' '${builtBin()}' chat\r`);
    await t.waitFor(/Welcome to[\s\S]*> $/, 'the greeting and the prompt');
    const pid = t.chatPid();
    let mark = t.screen().length;
    t.write('!sleep 30\r');
    await sleep(800);
    t.write('\x1a');
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    mark = t.screen().length;
    t.write('bg\r');
    await t.waitFor(/BASH\$ $/, 'bg', mark);
    await sleep(500);
    // Claude Code dies: the chat logs it (debug) while the child still owns the terminal
    const fake = children(pid).filter((k) => {
      try {
        return fs.readFileSync(`/proc/${k}/cmdline`, 'utf8').includes('fake-claude');
      } catch {
        return false;
      }
    });
    assert.ok(fake.length > 0, 'no Claude Code child');
    for (const k of fake) process.kill(k, 'SIGKILL');
    await sleep(1000);
    const c0 = cpuTicks(pid);
    await sleep(2000);
    const c1 = cpuTicks(pid);
    assert.ok(c0 !== undefined && c1 !== undefined, 'the chat is gone');
    // 2 s at 100% CPU is about 200 ticks; stopped (or idle) is about 0
    assert.ok(c1 - c0 < 60, `the chat spins (state ${procState(pid)}, ${c1 - c0} ticks of CPU in 2 s)`);
  } finally {
    await t.dispose();
  }
});
