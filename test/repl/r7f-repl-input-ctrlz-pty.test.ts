/**
 * Round-7 fix "repl-input" (finding #2): Ctrl+Z in a real terminal.
 *
 *  - Under an interactive bash with job control: Ctrl+Z stops kiro-claude (bash reports the job
 *    stopped), `fg` brings it back, and the chat reads again: the half-typed line is drawn again
 *    and submitted, history still works, an approval prompt still takes its `y`, and a Ctrl+Z
 *    while an answer streams stops at the prompt that follows it (r7 verification). Before the
 *    fix readline paused its interface at SIGCONT and nothing typed was read again.
 *  - As the pty's session leader (ssh -t, docker run -it, tmux new 'cmd'): the stop is discarded
 *    (orphaned process group), and the terminal stays in raw mode: Enter still submits (the
 *    approval and the half-typed line), and Ctrl+D is the key (the exit hint, then exit 0), not an
 *    end of input. Before the fix raw mode stayed off: Enter was a soft newline and the first
 *    Ctrl+D quit as a hangup.
 *
 * The terminal is a python3 pty driver: it runs its argv (bash, or kiro-claude itself) on a fresh
 * pty as the session leader and relays our pipe to the pty and back; on SIGTERM it closes the
 * master and reaps its child. Built CLI over test/fixtures/fake-claude.mjs, temp dirs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { mkRoot, sleep, type Root } from '../headless/r5f-signals-helpers.js';

const PTY_DRIVER = String.raw`
import os, pty, sys, select, signal, struct, fcntl, termios, time
argv = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
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
if os.WIFSIGNALED(status):
    sys.stderr.write('STATUS signal %d\n' % os.WTERMSIG(status))
else:
    sys.stderr.write('STATUS code %d\n' % os.WEXITSTATUS(status))
sys.stderr.flush()
`;

const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout?.trim() ?? '';
const HAVE_PTY =
  process.platform === 'linux' && spawnSync('python3', ['-I', '-c', 'import pty, termios, fcntl'], { stdio: 'ignore' }).status === 0;
const skip = HAVE_PTY ? false : 'needs Linux and python3 (pty)';
const skipBash = skip || (BASH ? false : 'needs bash');

const SCRIPT = {
  turns: [
    {
      repeat: true,
      match: '^make',
      steps: [{ tool: { name: 'Bash', input: { command: 'touch made.txt', description: 'Create a file' }, result: 'RAN-OK' } }, { text: 'TOOL-SAID {{lastToolResult}}' }],
    },
    { repeat: true, match: '^slow', steps: [{ text: 'BEGIN ' }, { sleepMs: 1500 }, { text: 'END-OF-SLOW' }] },
    { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] },
  ],
};

interface Term {
  r: Root;
  write(s: string): void;
  /** The screen so far, CSI sequences removed. */
  screen(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  /** The driver's report once it exited ('code N' / 'signal N'), else undefined. */
  status(): string | undefined;
  exited: Promise<unknown>;
  /** kiro-claude's pid (from its session lock), once the chat is up. */
  chatPid(): number;
  /** Close the terminal: the driver closes the pty master and reaps its child. */
  hangup(): void;
  dispose(): Promise<void>;
}

function open(mode: 'bash' | 'leader'): Term {
  const r = mkRoot(SCRIPT);
  const driver = path.join(r.root, 'pty.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const env = r.env({ TERM: 'xterm', PS1: 'BASH$ ' });
  const argv = mode === 'bash' ? [BASH, '--norc', '--noprofile', '-i'] : [process.execPath, builtBin(), 'chat'];
  const py = spawn('python3', ['-I', driver, ...argv], { cwd: r.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let perr = '';
  let done = false;
  py.stdout.on('data', (d: Buffer) => (out += d.toString()));
  py.stderr.on('data', (d: Buffer) => (perr += d.toString()));
  const exited = new Promise((res) =>
    py.on('exit', (...a) => {
      done = true;
      res(a);
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
    r,
    write: (s) => py.stdin.write(s),
    screen,
    async waitFor(re, what, from = 0, ms = 20_000) {
      const t0 = Date.now();
      while (!re.test(screen().slice(from))) {
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n--- screen:\n${JSON.stringify(screen().slice(from).slice(-1500))}\n--- driver:\n${perr}`);
        await sleep(10);
      }
    },
    status: () => /STATUS (.*)/.exec(perr)?.[1],
    exited,
    chatPid() {
      if (pid === undefined) {
        const lock = r.locks()[0];
        assert.ok(lock, 'no session lock');
        pid = (JSON.parse(fs.readFileSync(path.join(r.sessions, lock), 'utf8')) as { pid: number }).pid;
      }
      return pid;
    },
    hangup() {
      if (!done) py.kill('SIGTERM');
    },
    async dispose() {
      if (!done) {
        py.kill('SIGTERM'); // the driver closes the terminal and reaps its child
        await Promise.race([exited, sleep(5000)]);
        if (!done) py.kill('SIGKILL');
      }
      // only the kiro-claude this test started, should it outlive its terminal
      if (pid !== undefined && ours(pid)) {
        try {
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

/** Under bash: start the chat as a job and wait for its prompt. */
async function startUnderBash(t: Term): Promise<void> {
  await t.waitFor(/BASH\$ $/, 'bash prompt');
  t.write(`'${process.execPath}' '${builtBin()}' chat\r`);
  await t.waitFor(/chat\r?\n[\s\S]*> $/, 'chat prompt');
  t.chatPid();
}

/** Ctrl+Z under bash: the job stops and bash prompts again; then `fg`. Returns the screen mark after fg. */
async function stopAndFg(t: Term): Promise<number> {
  const mark = t.screen().length;
  t.write('\u001a');
  await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark, 5000);
  const fg = t.screen().length;
  t.write('fg\r');
  return fg;
}

async function quitUnderBash(t: Term): Promise<void> {
  const mark = t.screen().length;
  t.write('/quit\r');
  await t.waitFor(/To resume this session: kiro-claude chat --resume-id [\s\S]*BASH\$ $/, 'quit back to bash', mark);
  t.write('exit\r');
  await Promise.race([t.exited, sleep(5000)]);
  assert.equal(t.status(), 'code 0', 'bash did not exit');
  assert.deepEqual(t.r.locks(), [], 'the session lock was not released');
}

test('r7f #2: Ctrl+Z at the chat prompt under bash, then fg: the half-typed line comes back and is submitted; history works', { skip: skipBash, timeout: 90_000 }, async () => {
  const t = open('bash');
  try {
    await startUnderBash(t);
    let mark = t.screen().length;
    t.write('first\r');
    await t.waitFor(/ANSWER to first[\s\S]*> $/, 'first answer', mark);
    t.write('half');
    await t.waitFor(/> half$/, 'half-typed line', mark);
    const fg = await stopAndFg(t);
    await t.waitFor(/> half$/, 'after fg: the prompt and the half-typed line are drawn again', fg, 5000);
    mark = t.screen().length;
    t.write(' typed\r');
    await t.waitFor(/ANSWER to half typed[\s\S]*> $/, 'after fg: the line is read and answered', mark, 10_000);
    mark = t.screen().length;
    t.write('\u001b[A'); // Up: the history still holds the inputs
    await t.waitFor(/> half typed$/, 'history after fg', mark, 5000);
    t.write('\u0015'); // Ctrl+U: clear the line again
    await sleep(200);
    await quitUnderBash(t);
  } finally {
    await t.dispose();
  }
});

test('r7f #2: Ctrl+Z at an approval prompt under bash, then fg: y still answers it', { skip: skipBash, timeout: 90_000 }, async () => {
  const t = open('bash');
  try {
    await startUnderBash(t);
    let mark = t.screen().length;
    t.write('make a file\r');
    await t.waitFor(/\[y\/n\/t\]:[\s\S]*> $/, 'approval prompt', mark);
    const fg = await stopAndFg(t);
    await t.waitFor(/fg\r?\n[\s\S]*> $/, 'after fg: the approval\'s prompt is drawn again', fg, 5000);
    mark = t.screen().length;
    t.write('y\r');
    await t.waitFor(/TOOL-SAID RAN-OK[\s\S]*> $/, 'after fg: the approval took its y', mark, 10_000);
    await quitUnderBash(t);
  } finally {
    await t.dispose();
  }
});

test('r7f #2: Ctrl+Z while an answer streams under bash stops at the prompt after it; after fg the chat reads again', { skip: skipBash, timeout: 90_000 }, async () => {
  // r7 verification: never under a running turn (the r7 DECISION; see r8f-repl-input-pty for hooks)
  const t = open('bash');
  try {
    await startUnderBash(t);
    let mark = t.screen().length;
    t.write('slow one\r');
    await t.waitFor(/BEGIN/, 'answer streaming', mark);
    const stopMark = t.screen().length;
    t.write('\u001a');
    await t.waitFor(/END-OF-SLOW[\s\S]*Stopped[\s\S]*BASH\$ $/, 'the answer ends, then the job stops', stopMark, 10_000);
    const fg = t.screen().length;
    t.write('fg\r');
    await t.waitFor(/fg\r?\n[^\n]*chat\r?\n> $/, 'after fg: the prompt', fg, 10_000);
    mark = t.screen().length;
    t.write('next\r');
    await t.waitFor(/ANSWER to next[\s\S]*> $/, 'the chat reads again', mark, 10_000);
    await quitUnderBash(t);
  } finally {
    await t.dispose();
  }
});

test('r7f #2: Ctrl+Z as the terminal session leader (the stop is discarded): Enter still submits and Ctrl+D is the key', { skip, timeout: 90_000 }, async () => {
  const t = open('leader');
  try {
    await t.waitFor(/> $/, 'chat prompt');
    t.chatPid();
    let mark = t.screen().length;
    t.write('make a file\r');
    await t.waitFor(/\[y\/n\/t\]:[\s\S]*> $/, 'approval prompt', mark);
    t.write('\u001a');
    await sleep(500);
    mark = t.screen().length;
    t.write('y\r');
    await t.waitFor(/TOOL-SAID RAN-OK[\s\S]*> $/, 'the approval took its y after Ctrl+Z', mark, 10_000);
    mark = t.screen().length;
    t.write('sec');
    await t.waitFor(/^sec$/, 'half-typed line', mark, 5000);
    t.write('\u001a');
    await sleep(300);
    t.write('ond\r');
    await t.waitFor(/ANSWER to second[\s\S]*> $/, 'the half-typed line is kept and Enter submits it', mark, 10_000);
    mark = t.screen().length;
    t.write('\u0004');
    await t.waitFor(/press Ctrl\+C or Ctrl\+D again/, 'Ctrl+D is the key: the exit hint, not an end of input', mark, 5000);
    await sleep(300);
    assert.equal(t.status(), undefined, 'the first Ctrl+D quit');
    mark = t.screen().length;
    t.write('\u0004');
    await Promise.race([t.exited, sleep(10_000)]);
    assert.equal(t.status(), 'code 0');
    assert.match(t.screen().slice(mark), /To resume this session: kiro-claude chat --resume-id /);
    assert.deepEqual(t.r.locks(), []);
  } finally {
    await t.dispose();
  }
});

test('r7g: closing the terminal while the chat is stopped under bash (SIGHUP then SIGTERM, each with SIGCONT) closes the session: no lock left', { skip: skipBash, timeout: 120_000 }, async () => {
  for (let run = 1; run <= 3; run++) {
    const t = open('bash');
    try {
      await startUnderBash(t);
      const pid = t.chatPid();
      let mark = t.screen().length;
      t.write('first\r');
      await t.waitFor(/ANSWER to first[\s\S]*> $/, 'first answer', mark);
      mark = t.screen().length;
      t.write('\u001a');
      await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark, 5000);
      // the driver closes the pty master: bash gets SIGHUP, hangs up its jobs (SIGHUP + SIGCONT),
      // then terminates its stopped jobs as it exits (SIGTERM + SIGCONT)
      const alive = (): boolean => {
        try {
          return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
        } catch {
          return false;
        }
      };
      const t0 = Date.now();
      t.hangup();
      await Promise.race([t.exited, sleep(8000)]);
      while (alive() && Date.now() - t0 < 10_000) await sleep(20);
      assert.ok(!alive(), `run ${run}: kiro-claude outlived its terminal`);
      assert.deepEqual(t.r.locks(), [], `run ${run}: the session lock was left behind (the close was cut short)`);
    } finally {
      await t.dispose();
    }
  }
});
