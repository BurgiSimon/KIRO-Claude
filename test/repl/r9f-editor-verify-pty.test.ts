/**
 * Round-9 verification of the "editor" fix (#2) in a real terminal: a python3 pty driver running
 * an interactive bash (job control), the built CLI over test/fixtures/fake-claude.mjs, temp dirs
 * only. The fix hands the terminal to `!cmd` and `$EDITOR` also when the chat's stdout is piped
 * (`kiro-claude chat | cat`), so the hand-over and the hand-back now run there too.
 *
 * The hand-back (Repl.runBang / Repl.openEditor) resumed the reader at once when the child ended:
 * a tcsetattr (raw mode). A child that ends while kiro-claude runs in the background (Ctrl+Z in a
 * `!cmd` or in the editor, which stops the whole job, then `bg`) made that tcsetattr from a
 * background process group, so SIGTTOU stopped the chat again ('Stopped (tty output)'). Then
 * `kill %1` (bash: SIGTERM, then SIGCONT) never closed it: the restarted tcsetattr stopped it again
 * before its SIGTERM listener ran (lock held, no SessionEnd) until `fg` or SIGKILL, the same
 * defect as r9 #1 at the prompt. Now the terminal is taken back only in the foreground: the chat
 * stays off the terminal in the background until `fg`, and a fatal signal meanwhile closes it.
 * Plain terminal and `| cat` alike. Since r11 #2 it stops again by itself there, like a background
 * job that reads its terminal (its own SIGTTIN to its process group, `| cat` included: `jobs -l`
 * says 'Stopped (tty input)', not the 'Stopped (tty output)' of a restarting tcsetattr); between r9
 * and r11 it ran on, and under `sudo` that never came up after `fg`.
 *
 * The hand-over: with stdout piped the child writes to that pipe itself, which the fix says keeps
 * its output "in order with what the chat writes before and after". Node queues what a pipe does
 * not take at once (writes to a pipe are asynchronous), so behind a consumer that lags (`| tee
 * log` over a slow link; here a reader taking 2 KB every 10 ms) a `!cmd` typed ahead during a
 * long answer printed in the middle of that answer, before the prompt and before the reader's
 * bracketed-paste switch. Now the chat's output is handed to the OS before the child starts.
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

/**
 * A `!cmd` that says it runs, waits until the test creates `go` in the workspace (after Ctrl+Z
 * and `bg`: no timing) and says it is done. Markers built by printf.
 */
const BANG = "!printf 'CHILD-''RUNS\\n'; while [ ! -e go ]; do sleep 0.05; done; printf 'CHILD-''DONE\\n'";
/** An editor that does the same, then writes the file it was given. */
const EDITOR_SH = `#!/bin/sh
printf 'CHILD-''RUNS\\n'
while [ ! -e go ]; do sleep 0.05; done
printf 'edited in the background' > "$1"
printf 'CHILD-''DONE\\n'
`;

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

/** Children of `pid` that run a shell or `sleep` (the `!cmd`'s or the editor's), by /proc/<n>/stat. */
function childCommands(pid: number): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const s = fs.readFileSync(`/proc/${e}/stat`, 'utf8');
      const comm = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));
      const ppid = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === pid && /^(sh|bash|dash|sleep|ed\.sh)$/.test(comm)) out.push(comm);
    } catch {
      // gone
    }
  }
  return out;
}

interface Term {
  write(s: string): void;
  /** The screen so far, CSI sequences removed. */
  screen(): string;
  raw(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  chatPid(): number;
  dispose(): Promise<void>;
}

function underBash(r: Root, extraEnv: Record<string, string> = {}): Term {
  const driver = path.join(r.root, 'pty.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const env = r.env({ TERM: 'xterm', PS1: 'BASH$ ', ...extraEnv });
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

/** A SessionEnd hook (workspace hooks file) appending each closed session's payload to `file`. */
function sessionEndHook(r: Root, file: string): void {
  const dir = path.join(r.ws, '.kiro', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'end.json'), JSON.stringify({ version: 'v1', hooks: [{ name: 'end', trigger: 'SessionEnd', timeout: 0, action: { type: 'command', command: `cat >> '${file}'; echo >> '${file}'` } }] }));
}

const lastBracketedPaste = (s: string): string | undefined => [...s.matchAll(/\u001b\[\?2004([hl])/g)].pop()?.[1];

interface Run {
  r: Root;
  t: Term;
  pid: number;
  ended: string;
}

/**
 * Start the chat under bash (`piped`: `chat | cat`), run the child (`!cmd`, or /editor), Ctrl+Z
 * while it runs (the whole job stops), `bg`, and wait until the child has ended in the background
 * (and long enough for a hand-back that would stop the chat to have done so).
 */
async function childEndsInBackground(piped: boolean, via: 'bang' | 'editor'): Promise<Run> {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const ended = path.join(r.root, 'ended.jsonl');
  sessionEndHook(r, ended);
  const editor = path.join(r.root, 'ed.sh');
  fs.writeFileSync(editor, EDITOR_SH, { mode: 0o755 });
  const t = underBash(r, { EDITOR: editor });
  await t.waitFor(/BASH\$ $/, 'bash prompt');
  t.write(`'${process.execPath}' '${builtBin()}' chat${piped ? ' | cat' : ''}\r`);
  await t.waitFor(/chat[^\n]*\r?\n[\s\S]*> $/, 'chat prompt');
  const pid = t.chatPid();
  let mark = t.screen().length;
  t.write(via === 'bang' ? `${BANG}\r` : '/editor\r');
  await t.waitFor(/CHILD-RUNS/, 'the child runs', mark);
  mark = t.screen().length;
  t.write('\x1a');
  await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
  assert.equal(procState(pid), 'T');
  mark = t.screen().length;
  t.write('bg\r');
  await t.waitFor(/BASH\$ $/, 'bash prompt after bg', mark + 3);
  fs.writeFileSync(path.join(r.ws, 'go'), '');
  await t.waitFor(/CHILD-DONE/, 'the child ends in the background', mark, 15_000);
  await waitUntil(() => childCommands(pid).length === 0, 'the child has exited', 10_000);
  // the hand-back stops the chat by itself once the child ended (r11 #2: its own SIGTTIN); one that
  // touched the terminal from the background would have stopped it with SIGTTOU at once
  const t0 = Date.now();
  while (procState(pid) !== 'T' && Date.now() - t0 < 1500) await sleep(20);
  return { r, t, pid, ended };
}

/** The chat stopped again by itself in the background (r11 #2): `jobs -l` names its own SIGTTIN. */
async function stoppedForTerminal(t: Term, pid: number): Promise<void> {
  assert.equal(procState(pid), 'T', 'the chat did not stop again in the background once the child ended');
  const mark = t.screen().length;
  t.write('jobs -l\r');
  await t.waitFor(/jobs -l\r?\n[\s\S]*\[1\][\s\S]*BASH\$ $/, 'the job list', mark, 5000);
  assert.match(t.screen().slice(mark), /\[1\][+-]? +\d+ +Stopped \(tty input\)/, t.screen().slice(mark));
}

async function thenKill(piped: boolean, via: 'bang' | 'editor'): Promise<void> {
  const { r, t, pid, ended } = await childEndsInBackground(piped, via);
  try {
    await stoppedForTerminal(t, pid);
    const mark = t.screen().length;
    const t0 = Date.now();
    // the job is stopped (r11 #2): bash's kill sends SIGTERM, then SIGCONT, and marks the job
    // running only once that continue reaches it, so an immediate `wait %1` can find it still
    // stopped (148/149; as in r9f-stop-input-pty.test.ts): wait for the chat to be gone first
    t.write('kill %1\r');
    await waitUntil(() => procState(pid) === 'gone', `the chat ends (state ${procState(pid)})`, 10_000);
    assert.ok(Date.now() - t0 < 8000, `the chat ended after ${Date.now() - t0} ms`);
    t.write('wait %1; echo "EXIT=$?"\r');
    await t.waitFor(/EXIT=\d+/, 'the job ends', mark, 10_000);
    assert.match(t.screen().slice(mark), /EXIT=143/, t.screen().slice(mark));
    assert.deepEqual(r.locks(), [], 'the session lock is left');
    await waitUntil(() => fs.existsSync(ended) && fs.readFileSync(ended, 'utf8').trim() !== '', 'the SessionEnd hook ran', 5000);
    await sleep(300);
    // after the signal nothing more is printed (no prompt drawn before it died)
    const after = t.screen().slice(mark);
    assert.doesNotMatch(after.replace(/BASH\$ /g, ''), /> /, `printed after the signal:\n${JSON.stringify(after)}`);
  } finally {
    await t.dispose();
  }
}

async function thenFg(piped: boolean, via: 'bang' | 'editor'): Promise<void> {
  const { t, pid } = await childEndsInBackground(piped, via);
  try {
    await stoppedForTerminal(t, pid);
    let mark = t.screen().length;
    // bash continues the stopped job (SIGCONT) and gives it the terminal
    t.write('fg\r');
    if (via === 'editor') {
      await t.waitFor(/ANSWER to edited in the background[\s\S]*> $/, "the editor's text is submitted after fg", mark, 15_000);
    } else {
      await t.waitFor(/> $/, 'the chat prompt after fg', mark, 10_000);
    }
    await sleep(200);
    assert.equal(lastBracketedPaste(t.raw()), 'h', 'bracketed paste is not on again at the chat prompt');
    mark = t.screen().length;
    t.write('next\r');
    await t.waitFor(/ANSWER to next[\s\S]*> $/, 'the chat reads again', mark, 15_000);
  } finally {
    await t.dispose();
  }
}

test('r9f-v: `!cmd`, Ctrl+Z, `bg`, the child ends in the background, `kill %1`: the chat closes and dies of SIGTERM at once', { skip, timeout: 90_000 }, async () => {
  await thenKill(false, 'bang');
});

test('r9f-v: the same in `kiro-claude chat | cat`', { skip, timeout: 90_000 }, async () => {
  await thenKill(true, 'bang');
});

test('r9f-v: /editor in `kiro-claude chat | cat`, Ctrl+Z, `bg`, the editor ends in the background, `kill %1`: the chat closes', { skip, timeout: 90_000 }, async () => {
  await thenKill(true, 'editor');
});

test('r9f-v: `!cmd` in `kiro-claude chat | cat`, Ctrl+Z, `bg`, the child ends: the chat stays off the terminal (stopped again by itself, r11 #2); `fg` takes the terminal back', { skip, timeout: 90_000 }, async () => {
  await thenFg(true, 'bang');
});

test('r9f-v: /editor on a plain terminal, Ctrl+Z, `bg`, the editor ends: `fg` takes the terminal back and submits the text', { skip, timeout: 90_000 }, async () => {
  await thenFg(false, 'editor');
});

/** A pipe consumer that lags: 2 KB every 10 ms. */
const SLOW_CAT = `import os, time
while True:
    d = os.read(0, 2048)
    if not d:
        break
    os.write(1, d)
    time.sleep(0.01)
`;

test('r9f-v: `kiro-claude chat | <slow reader>`: a `!cmd` typed ahead during a long answer prints after the answer, the prompt and the bracketed-paste switch', { skip, timeout: 120_000 }, async () => {
  // ~480 KB, well past what the pipe holds, so Node still queues most of it at the next prompt
  const big = `${Array.from({ length: 6000 }, (_, i) => `big line ${String(i).padStart(5, '0')} ${'x'.repeat(60)}`).join('\n')}\nEND-OF-BIG`;
  const script = { turns: [{ repeat: true, match: '^big', steps: [{ text: big }] }, ...SCRIPT.turns] };
  const r = mkRoot(script);
  removeOnExit(r.root);
  // (the script is too big for an environment variable: the fake reads it from a file)
  const scriptFile = path.join(r.root, 'script.json');
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const slow = path.join(r.root, 'slowcat.py');
  fs.writeFileSync(slow, SLOW_CAT);
  const t = underBash(r, { FAKE_CLAUDE_SCRIPT_JSON: '', FAKE_CLAUDE_SCRIPT: scriptFile });
  try {
    await t.waitFor(/BASH\$ $/, 'bash prompt');
    t.write(`'${process.execPath}' '${builtBin()}' chat | python3 -I '${slow}'\r`);
    await t.waitFor(/chat[^\n]*\r?\n[\s\S]*> $/, 'chat prompt', 0, 30_000);
    const mark = t.screen().length;
    const rawMark = t.raw().length;
    t.write('big\r');
    await t.waitFor(/big line 00100/, 'the long answer starts to show', mark, 30_000);
    // typed ahead while the answer streams: replayed at the next prompt
    t.write("!printf 'CHILD-''OUT\\n'\r");
    await t.waitFor(/END-OF-BIG/, 'the end of the answer', mark, 60_000);
    await t.waitFor(/CHILD-OUT[\s\S]*> $/, 'the !cmd ran and the prompt is back', mark, 60_000);
    const s = t.screen().slice(mark);
    assert.ok(s.indexOf('END-OF-BIG') < s.indexOf('CHILD-OUT'), `the !cmd's output overtook the answer:\n${JSON.stringify(s.slice(s.indexOf('CHILD-OUT') - 300, s.indexOf('CHILD-OUT') + 100))}`);
    const raw = t.raw().slice(rawMark);
    const at = raw.indexOf('CHILD-OUT');
    assert.equal(lastBracketedPaste(raw.slice(0, at)), 'l', 'bracketed paste was not off before the child wrote');
    assert.match(s.slice(0, s.indexOf('CHILD-OUT')), /END-OF-BIG[\s\S]*> !printf/, 'the prompt with the typed-ahead line was not shown before the child wrote');
    const m2 = t.screen().length;
    t.write('next\r');
    await t.waitFor(/ANSWER to next[\s\S]*> $/, 'the chat reads again', m2, 30_000);
  } finally {
    await t.dispose();
  }
});
