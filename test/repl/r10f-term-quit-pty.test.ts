/**
 * Round-10 fix "terminal-a" #3 and #5 in a real terminal: a python3 pty driver running an
 * interactive bash (job control), the built CLI over test/fixtures/fake-claude.mjs, temp dirs only.
 *
 *  - #3: /quit with a slow SessionEnd hook, the chat stopped from elsewhere (`kill -STOP`) during
 *    that final close, then `kill %1` (bash: SIGTERM, then SIGCONT). run()'s finally printed the
 *    resume hint over the shell, removed the signal listeners and closed the reader: readline's
 *    close() turned raw mode off from the background (a tcsetattr), and SIGTTOU stopped the chat
 *    again until `fg`. Now the fatal signal ends the process once the close is done (no reader
 *    close, no hint in the background): it dies of SIGTERM without `fg`.
 *  - The non-signal end in the background (the documented gap): /quit, `kill -STOP`, `kill -CONT`
 *    from elsewhere while bash holds the terminal. The close finishes in the background (lock
 *    released, SessionEnd ran) and kiro-claude's own close touches nothing of the terminal; the
 *    chat ends with status 0 once in the foreground, the terminal not left raw. (Node's own exit
 *    still restores the terminal's mode through libuv's terminal descriptor without SIGTTOU
 *    blocked, so from the background that exit waits stopped for `fg`: the known gap.)
 *  - #5 (README): a plain `kill <pid>` of a chat stopped with Ctrl+Z does not close it while it
 *    stays stopped (kiro-claude catches SIGTERM, so the kernel keeps it pending); it closes at once
 *    when continued (`kill -CONT`), as `kill %1` does in its shell.
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

/** A SessionEnd hook (workspace hooks file) that takes `seconds`, then appends the payload to `file`. */
function slowSessionEnd(r: Root, file: string, seconds: number): void {
  const dir = path.join(r.ws, '.kiro', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'end.json'),
    JSON.stringify({ version: 'v1', hooks: [{ name: 'end', trigger: 'SessionEnd', timeout: 0, action: { type: 'command', command: `sleep ${seconds}; cat >> '${file}'; echo >> '${file}'` } }] }),
  );
}

interface Term {
  write(s: string): void;
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

async function startChat(t: Term): Promise<number> {
  await t.waitFor(/BASH\$ $/, 'bash prompt');
  t.write(`'${process.execPath}' '${builtBin()}' chat\r`);
  await t.waitFor(/chat[^\n]*\r?\n[\s\S]*> $/, 'chat prompt');
  return t.chatPid();
}

/** The chat answers, /quit starts its slow final close, and the chat is stopped from elsewhere during it. */
async function stoppedDuringQuit(r: Root, t: Term): Promise<number> {
  const pid = await startChat(t);
  let mark = t.screen().length;
  t.write('hello\r');
  await t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the answer', mark);
  mark = t.screen().length;
  t.write('/quit\r');
  await sleep(400);
  assert.deepEqual(r.locks().length, 1, 'precondition: the close is still running');
  process.kill(pid, 'SIGSTOP'); // kill -STOP from elsewhere
  await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark, 5000);
  return pid;
}

const hookRan = (file: string): boolean => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '';

test('r10f #3: /quit, `kill -STOP` during its slow close, then `kill %1`: the chat ends (SIGTERM) without fg; lock released, SessionEnd ran', { skip, timeout: 120_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const ended = path.join(r.root, 'ended.jsonl');
  slowSessionEnd(r, ended, 1.5);
  const t = underBash(r);
  try {
    const pid = await stoppedDuringQuit(r, t);
    const mark = t.screen().length;
    t.write('kill %1\r');
    await waitUntil(() => procState(pid) === 'gone', `the chat ends after \`kill %1\` (state ${procState(pid)}: stopped again by SIGTTOU?)`, 15_000);
    t.write('wait %1; echo "EXIT=$?"\r');
    await t.waitFor(/EXIT=\d+/, 'the job status', mark, 10_000);
    assert.match(t.screen().slice(mark), /EXIT=143/, t.screen().slice(mark));
    assert.equal(hookRan(ended), true, 'the SessionEnd hook ran');
    assert.deepEqual(r.locks(), [], 'the session lock is left');
    // nothing is written over the shell from the background (the hint included)
    assert.doesNotMatch(t.screen().slice(mark), /To resume this session/, t.screen().slice(mark));
  } finally {
    await t.dispose();
  }
});

test('r10f #3: the non-signal end in the background: /quit, `kill -STOP`, `kill -CONT` there: the close finishes, `fg` ends it with status 0, the terminal not left raw', { skip, timeout: 120_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const ended = path.join(r.root, 'ended.jsonl');
  slowSessionEnd(r, ended, 1.5);
  const t = underBash(r);
  try {
    const pid = await stoppedDuringQuit(r, t);
    process.kill(pid, 'SIGCONT'); // kill -CONT from elsewhere: a background job while bash holds the terminal
    await waitUntil(() => hookRan(ended) && r.locks().length === 0, 'the close finishes in the background', 10_000);
    const mark = t.screen().length;
    t.write('fg\r');
    await waitUntil(() => procState(pid) === 'gone', `the chat ends after fg (state ${procState(pid)})`, 10_000);
    t.write('echo "EXIT=$?"; stty -a | tr " " "\\n" | grep -x -e icanon -e -icanon -e echo -e -echo | tr "\\n" " "; echo END\r');
    await t.waitFor(/EXIT=\d+[\s\S]*END/, 'the status and the terminal mode', mark, 10_000);
    const s = t.screen().slice(mark);
    assert.match(s, /EXIT=0/, s);
    assert.match(s, /\bicanon echo\b/, `the terminal was left raw: ${s}`);
  } finally {
    await t.dispose();
  }
});

test('r10f #5 (README): a plain `kill <pid>` of a chat stopped with Ctrl+Z waits until it is continued; then it closes at once', { skip, timeout: 120_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const ended = path.join(r.root, 'ended.jsonl');
  slowSessionEnd(r, ended, 0);
  const t = underBash(r);
  try {
    const pid = await startChat(t);
    let mark = t.screen().length;
    t.write('hello\r');
    await t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the answer', mark);
    mark = t.screen().length;
    t.write('\x1a');
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    process.kill(pid, 'SIGTERM'); // kill <pid> from elsewhere
    await sleep(2500);
    assert.equal(procState(pid), 'T', 'a stopped chat runs no handler: the SIGTERM waits');
    assert.equal(r.locks().length, 1);
    process.kill(pid, 'SIGCONT'); // kill -CONT <pid>
    await waitUntil(() => procState(pid) === 'gone', `the chat ends once continued (state ${procState(pid)})`, 10_000);
    assert.deepEqual(r.locks(), []);
    assert.equal(hookRan(ended), true);
  } finally {
    await t.dispose();
  }
});
