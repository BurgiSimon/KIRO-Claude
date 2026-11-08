/**
 * Round-8 verification of the "repl-input" fix #0/#1 in a real terminal (a python3 pty driver
 * running an interactive bash; the built CLI over test/fixtures/fake-claude.mjs, temp dirs only):
 * another way to stop kiro-claude under a parallel call's running hook.
 *
 * The approval prompt also takes a `!cmd`. While that command owns the terminal the reader is
 * suspended, so a Ctrl+Z there is the terminal's own (not the reader's jobStop): it stops the
 * command and kiro-claude together, as one job, while the parallel secret.env read's guard hook
 * (its own process group) runs on and exits 2 during the stop. After `fg` the command ends, the
 * approval prompt is asked again, and the guard must still block (runShell: the stop is not
 * counted, the exit seen at SIGCONT keeps its status). With HEAD's runShell the hook counted as
 * "timed out" and the trusted read of secret.env ran. Bracketed paste is on again after that
 * `!cmd` (bash turned it off before `fg`; r8 #2).
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
const skip = !HAVE_PTY ? 'needs Linux and python3 (pty)' : !BASH ? 'needs bash' : false;

const SECRET_READ = { name: 'Read', input: { file_path: '{{cwd}}/secret.env' }, result: 'SECRET=hunter2' };
const HOST_READ = { name: 'Read', input: { file_path: '/etc/hostname' }, result: 'HOST-CONTENT' };
const SCRIPT = {
  turns: [
    // two concurrency-safe Reads in one message: /etc/hostname is outside the workspace (the gate
    // asks), secret.env inside it (trusted) is guarded by the agent's hook
    { repeat: true, match: '^read both', steps: [{ parallel: [HOST_READ, SECRET_READ] }, { text: 'DONE {{lastToolResult}}' }] },
    { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] },
  ],
};
const HOOK_TIMEOUT_MS = 2500;
const STOPPED_MS = 4500; // longer than the hook's timeout

const lastBracketedPaste = (s: string): string | undefined => [...s.matchAll(/\u001b\[\?2004([hl])/g)].pop()?.[1];

test('r8 verification #0/#1: Ctrl+Z during a !cmd typed at the approval prompt while a parallel call\'s guard hook runs, stopped longer than its timeout, fg: the guard still blocks', { skip, timeout: 90_000 }, async () => {
  const r: Root = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const log = path.join(r.root, 'hook.log');
  fs.writeFileSync(path.join(r.ws, 'secret.env'), 'SECRET=hunter2\n');
  const agents = path.join(r.home, '.kiro', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  const cmd = `p=$(cat); case "$p" in *secret.env*) echo start >> '${log}'; sleep 1.5; echo block >> '${log}'; echo NO-SECRETS >&2; exit 2;; esac; exit 0`;
  fs.writeFileSync(
    path.join(agents, 'guard.json'),
    JSON.stringify({ name: 'guard', description: 'guards secret.env', tools: ['*'], hooks: { preToolUse: [{ matcher: '*', command: cmd, timeout_ms: HOOK_TIMEOUT_MS }] } }),
  );
  const hookLog = (): string => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');

  const driver = path.join(r.root, 'pty.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const py = spawn('python3', ['-I', driver, BASH, '--norc', '--noprofile', '-i'], {
    cwd: r.ws,
    env: r.env({ TERM: 'xterm', PS1: 'BASH$ ' }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  const waitFor = async (re: RegExp, what: string, from = 0, ms = 20_000): Promise<void> => {
    const t0 = Date.now();
    while (!re.test(screen().slice(from))) {
      if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n--- screen:\n${JSON.stringify(screen().slice(from).slice(-2000))}`);
      await sleep(10);
    }
  };
  const until = async (cond: () => boolean, what: string, ms: number): Promise<void> => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
      await sleep(10);
    }
  };
  let chatPid: number | undefined;
  try {
    await waitFor(/BASH\$ $/, 'bash prompt');
    py.stdin.write(`'${process.execPath}' '${builtBin()}' chat --agent guard\r`);
    await waitFor(/chat[^\n]*\r?\n[\s\S]*> $/, 'chat prompt');
    const lock = r.locks()[0];
    assert.ok(lock, 'no session lock');
    chatPid = (JSON.parse(fs.readFileSync(path.join(r.sessions, lock), 'utf8')) as { pid: number }).pid;

    const turnMark = screen().length;
    py.stdin.write('read both\r');
    await waitFor(/\[y\/n\/t\]:[\s\S]*> $/, 'approval prompt for the /etc/hostname read', turnMark);
    await until(() => /start/.test(hookLog()), "the parallel call's hook starts", 3000);
    assert.doesNotMatch(hookLog(), /block/, 'the hook decided before the stop');

    // a !cmd at the approval prompt owns the terminal; the terminal's Ctrl+Z stops it and the chat
    const bang = screen().length;
    py.stdin.write('!sleep 2; echo BANG-DONE\r');
    await sleep(500);
    py.stdin.write('\u001a');
    await waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', bang, 5000);
    await sleep(STOPPED_MS);
    assert.match(hookLog(), /block/, 'the hook blocked while kiro-claude was stopped');
    const fg = screen().length;
    py.stdin.write('fg\r');
    await waitFor(/BANG-DONE[\s\S]*\[y\/n\/t\]:[\s\S]*> $/, 'after fg the !cmd ends and the approval prompt is asked again', fg, 10_000);
    await sleep(300);
    assert.equal(lastBracketedPaste(out), 'h', 'bracketed paste is off at the approval prompt after the !cmd and fg');

    const mark = screen().length;
    py.stdin.write('n\r');
    await waitFor(/DONE [^\n]*[\s\S]*> $/, 'the turn ends', mark, 15_000);
    const s = screen().slice(turnMark);
    assert.doesNotMatch(s, /timed out after/, `the hook that blocked while kiro-claude was stopped counted as timed out:\n${s}`);
    assert.doesNotMatch(s, /hunter2/, `the guarded read ran:\n${s}`);
    assert.match(s, /NO-SECRETS/);
  } finally {
    if (!done) {
      py.kill('SIGTERM');
      await Promise.race([exited, sleep(5000)]);
      if (!done) py.kill('SIGKILL');
    }
    // only the kiro-claude this test started, should it outlive its terminal
    if (chatPid !== undefined) {
      try {
        if (fs.readFileSync(`/proc/${chatPid}/cmdline`, 'utf8').includes(builtBin())) {
          process.kill(chatPid, 'SIGCONT');
          process.kill(chatPid, 'SIGKILL');
        }
      } catch {
        // gone
      }
    }
    await sleep(100);
    r.cleanup();
  }
});
