/**
 * Round-7 verification of the "repl-input" fix (finding #2) in a real terminal: an interactive
 * bash with job control on a python3 pty, the built CLI over test/fixtures/fake-claude.mjs, temp
 * dirs (see r7f-repl-input-verify.test.ts for the in-process half).
 *
 *  - A blocking preToolUse hook still blocks when Ctrl+Z is pressed while it runs and the job
 *    then stays stopped longer than the hook's timeout. kiro-claude stopped at once, the hook ran
 *    on (its own process group) and blocked, but at `fg` its timeout fired before its exit was
 *    seen: "timed out", which never blocks, and the trusted tool ran. Now the stop waits for the
 *    prompt that follows the turn.
 *  - A stop from elsewhere (`kill -TSTP` or `kill -STOP` of kiro-claude, then `fg`) left the
 *    terminal in the shell's cooked mode: Enter was a soft newline (nothing could be submitted)
 *    and Ctrl+D a real end of input. Now kiro-claude takes the terminal back at SIGCONT.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { mkRoot, sleep, type Root } from '../headless/r5f-signals-helpers.js';

// runs argv on a fresh pty (session leader) and relays our pipe to it; SIGTERM closes the master
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
const skip = !HAVE_PTY ? 'needs Linux and python3 (pty)' : BASH ? false : 'needs bash';

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
  screen(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  status(): string | undefined;
  exited: Promise<unknown>;
  chatPid(): number;
  dispose(): Promise<void>;
}

function openBash(): Term {
  const r = mkRoot(SCRIPT);
  const driver = path.join(r.root, 'pty.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const py = spawn('python3', ['-I', driver, BASH, '--norc', '--noprofile', '-i'], {
    cwd: r.ws,
    env: r.env({ TERM: 'xterm', PS1: 'BASH$ ' }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
    async dispose() {
      if (!done) {
        py.kill('SIGTERM');
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

async function startChat(t: Term, args: string[] = []): Promise<void> {
  await t.waitFor(/BASH\$ $/, 'bash prompt');
  t.write(`'${process.execPath}' '${builtBin()}' chat${args.map((a) => ` '${a}'`).join('')}\r`);
  await t.waitFor(/chat[^\n]*\r?\n[\s\S]*> $/, 'chat prompt');
  t.chatPid();
}

async function quit(t: Term): Promise<void> {
  const mark = t.screen().length;
  t.write('/quit\r');
  await t.waitFor(/To resume this session: kiro-claude chat --resume-id [\s\S]*BASH\$ $/, 'quit back to bash', mark);
  t.write('exit\r');
  await Promise.race([t.exited, sleep(5000)]);
  assert.equal(t.status(), 'code 0', 'bash did not exit');
  assert.deepEqual(t.r.locks(), [], 'the session lock was not released');
}

test('r7f verify #2: a blocking preToolUse hook still blocks when Ctrl+Z is pressed while it runs and the stop outlasts its timeout', { skip, timeout: 90_000 }, async () => {
  const t = openBash();
  try {
    const agents = path.join(t.r.home, '.kiro', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(
      path.join(agents, 'guard.json'),
      JSON.stringify({
        name: 'guard',
        description: 'a trusted shell guarded by a slow blocking hook',
        tools: ['*'],
        allowedTools: ['*'],
        hooks: { preToolUse: [{ matcher: '*', command: 'sleep 1; echo BLOCKED-BY-HOOK >&2; exit 2', timeout_ms: 2500 }] },
      }),
    );
    await startChat(t, ['--agent', 'guard']);
    let mark = t.screen().length;
    t.write('make a file\r');
    await sleep(400); // the hook runs
    t.write('\u001a');
    // the job stops at the prompt that follows the turn, not under the hook
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'the job stops', mark, 15_000);
    await sleep(3500); // longer than the hook's timeout
    t.write('fg\r');
    await t.waitFor(/fg\r?\n[^\n]*chat[^\n]*\r?\n[\s\S]*> $/, 'after fg: the prompt', mark, 10_000);
    const s = t.screen().slice(mark);
    assert.doesNotMatch(s, /RAN-OK|timed out/, `the hook's block was lost to the stop:\n${s}`);
    assert.match(s, /TOOL-SAID PreToolUse:Bash hook error: PreToolHook blocked the tool execution: BLOCKED-BY-HOOK/);
    mark = t.screen().length;
    t.write('next\r');
    await t.waitFor(/ANSWER to next[\s\S]*> $/, 'the chat reads again', mark, 10_000);
    await quit(t);
  } finally {
    await t.dispose();
  }
});

for (const sig of ['SIGTSTP', 'SIGSTOP'] as const) {
  test(`r7f verify #2: kill -${sig.slice(3)} from elsewhere at the prompt, then fg: Enter submits again and Ctrl+D is the key`, { skip, timeout: 90_000 }, async () => {
    const t = openBash();
    try {
      await startChat(t);
      let mark = t.screen().length;
      t.write('first\r');
      await t.waitFor(/ANSWER to first[\s\S]*> $/, 'first answer', mark);
      t.write('hal');
      await t.waitFor(/> hal$/, 'half-typed line', mark);
      mark = t.screen().length;
      process.kill(t.chatPid(), sig);
      await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'the job stops', mark, 5000);
      const fg = t.screen().length;
      t.write('fg\r');
      await t.waitFor(/fg\r?\n[^\n]*chat[^\n]*\r?\n> hal$/, 'after fg: the prompt and the half-typed line on a fresh line', fg, 5000);
      mark = t.screen().length;
      t.write('f\r');
      await t.waitFor(/ANSWER to half[\s\S]*> $/, 'after fg: Enter submits', mark, 10_000);
      mark = t.screen().length;
      t.write('\u0004');
      await t.waitFor(/press Ctrl\+C or Ctrl\+D again/, 'Ctrl+D is the key: the exit hint', mark, 5000);
      await sleep(300);
      assert.ok(t.r.locks().length === 1, 'the first Ctrl+D quit');
      // a stop from elsewhere while an answer streams: the next prompt still reads
      mark = t.screen().length;
      t.write('slow one\r');
      await t.waitFor(/BEGIN/, 'answer streaming', mark);
      process.kill(t.chatPid(), sig);
      await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'the job stops while the answer streams', mark, 5000);
      t.write('fg\r');
      await t.waitFor(/END-OF-SLOW[\s\S]*> $/, 'after fg: the answer ends', mark, 10_000);
      mark = t.screen().length;
      t.write('next\r');
      await t.waitFor(/ANSWER to next[\s\S]*> $/, 'the chat reads again', mark, 10_000);
      await quit(t);
    } finally {
      await t.dispose();
    }
  });
}
