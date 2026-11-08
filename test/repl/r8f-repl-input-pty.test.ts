/**
 * Round-8 fix "repl-input" in a real terminal (a python3 pty driver running an interactive bash,
 * or kiro-claude itself as the session leader) and headless; the built CLI over
 * test/fixtures/fake-claude.mjs, temp dirs only.
 *
 *  - #0/#1: Ctrl+Z at an approval prompt while a PARALLEL call's blocking preToolUse hook runs
 *    (two concurrency-safe Reads in one message, or two parallel subagents): the hook exits 2
 *    while kiro-claude is stopped, the stop outlasts its timeout, then `fg`. The hook must still
 *    block. Before the fix runShell's expired timeout ran before the hook's exit was seen at
 *    SIGCONT: "timed out" (never blocks), and the guarded, trusted Read ran. The same for a stop
 *    from elsewhere (`kill -STOP`, then `kill -CONT`) during a turn, headless and interactive.
 *  - #2: Ctrl+Z while a `!cmd` owns the terminal, then `fg` (bash turns bracketed paste off before
 *    it continues the job), and an `$EDITOR` that turns it off at exit (vim does): bracketed paste
 *    is on again at the chat prompt, so a two-line paste stays one input.
 *  - #4: Ctrl+Z pressed three times while an answer streams: one stop, one `fg`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { cli, mkRoot, sleep, type Root } from '../headless/r5f-signals-helpers.js';
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
const linux = process.platform === 'linux' ? false : 'Linux';

const SECRET_READ = { name: 'Read', input: { file_path: '{{cwd}}/secret.env' }, result: 'SECRET=hunter2' };
const HOST_READ = { name: 'Read', input: { file_path: '/etc/hostname' }, result: 'HOST-CONTENT' };
const sub = (id: string, call: Record<string, unknown>): Record<string, unknown> => ({ ...call, agent_id: id, agent_type: 'general-purpose' });

const SCRIPT = {
  turns: [
    // two concurrency-safe Reads in one message: /etc/hostname is outside the workspace (the gate
    // asks), secret.env inside it (trusted) is guarded by the agent's hook
    { repeat: true, match: '^read both', steps: [{ parallel: [HOST_READ, SECRET_READ] }, { text: 'DONE {{lastToolResult}}' }] },
    { repeat: true, match: '^sub both', steps: [{ parallel: [sub('a1', HOST_READ), sub('a2', SECRET_READ)] }, { text: 'DONE {{lastToolResult}}' }] },
    { repeat: true, match: '^read secret', steps: [{ tool: SECRET_READ }, { text: 'DONE {{lastToolResult}}' }] },
    { repeat: true, match: '^slow', steps: [{ text: 'BEGIN ' }, { sleepMs: 1500 }, { text: 'END-OF-SLOW' }] },
    { repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] },
  ],
};

const HOOK_TIMEOUT_MS = 2500;
const STOPPED_MS = 4500; // longer than the hook's timeout

/** A root with the guard agent: its preToolUse hook blocks reads of secret.env after 1.5 s. */
function guardRoot(): { r: Root; hookLog: () => string } {
  const r = mkRoot(SCRIPT);
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
  return { r, hookLog: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

async function waitUntil(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(10);
  }
}

interface Term {
  r: Root;
  write(s: string): void;
  /** The screen so far, CSI sequences removed. */
  screen(): string;
  /** Everything written to the terminal so far. */
  raw(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  chatPid(): number;
  dispose(): Promise<void>;
}

function open(r: Root, argv: string[], extraEnv: Record<string, string> = {}): Term {
  const driver = path.join(r.root, 'pty.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const env = r.env({ TERM: 'xterm', PS1: 'BASH$ ', ...extraEnv });
  const py = spawn('python3', ['-I', driver, ...argv], { cwd: r.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let perr = '';
  let done = false;
  py.stdout.on('data', (d: Buffer) => (out += d.toString()));
  py.stderr.on('data', (d: Buffer) => (perr += d.toString()));
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
    r,
    write: (s) => py.stdin.write(s),
    screen,
    raw: () => out,
    async waitFor(re, what, from = 0, ms = 20_000) {
      const t0 = Date.now();
      while (!re.test(screen().slice(from))) {
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n--- screen:\n${JSON.stringify(screen().slice(from).slice(-2000))}\n--- driver:\n${perr}`);
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

const underBash = (r: Root, env: Record<string, string> = {}): Term => open(r, [BASH, '--norc', '--noprofile', '-i'], env);

async function startChat(t: Term, args = ''): Promise<void> {
  await t.waitFor(/BASH\$ $/, 'bash prompt');
  t.write(`'${process.execPath}' '${builtBin()}' chat${args}\r`);
  await t.waitFor(/chat[^\n]*\r?\n[\s\S]*> $/, 'chat prompt');
  t.chatPid();
}

const procState = (pid: number): string | undefined => {
  try {
    return /^State:\s+(\S)/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
  } catch {
    return undefined;
  }
};
const lastBracketedPaste = (s: string): string | undefined => [...s.matchAll(/\u001b\[\?2004([hl])/g)].pop()?.[1];

// ───────────────────────── #0/#1: a parallel call's hook under a stop ─────────────────────────

async function approvalStop(prompt: string, withCtrlZ: boolean): Promise<string> {
  const { r, hookLog } = guardRoot();
  const t = underBash(r);
  try {
    await startChat(t, ' --agent guard');
    const turnMark = t.screen().length;
    t.write(`${prompt}\r`);
    await t.waitFor(/\[y\/n\/t\]:[\s\S]*> $/, 'approval prompt for the /etc/hostname read', turnMark);
    // the guard of the parallel secret.env read runs now, under this approval prompt
    await waitUntil(() => /start/.test(hookLog()), 'the parallel call\'s hook starts', 3000);
    assert.doesNotMatch(hookLog(), /block/, 'the hook decided before the Ctrl+Z');
    if (withCtrlZ) {
      const stopMark = t.screen().length;
      t.write('\u001a');
      await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', stopMark, 5000);
      await sleep(STOPPED_MS);
      assert.match(hookLog(), /block/, 'the hook blocked while kiro-claude was stopped');
      const fg = t.screen().length;
      t.write('fg\r');
      await t.waitFor(/fg\r?\n[\s\S]*> $/, 'after fg: the approval prompt again', fg, 5000);
      await sleep(300);
    } else {
      await sleep(STOPPED_MS);
    }
    const mark = t.screen().length;
    t.write('n\r');
    await t.waitFor(/DONE [^\n]*[\s\S]*> $/, 'the turn ends', mark, 15_000);
    return t.screen().slice(turnMark);
  } finally {
    await t.dispose();
  }
}

test('r8f #0: control (no Ctrl+Z): the guard blocks the parallel secret.env read', { skip: skipBash, timeout: 90_000 }, async () => {
  const s = await approvalStop('read both', false);
  assert.doesNotMatch(s, /hunter2|timed out after/, s);
  assert.match(s, /NO-SECRETS/);
});

for (const [prompt, where] of [
  ['read both', 'two parallel Reads'],
  ['sub both', 'two parallel subagents'],
] as const) {
  test(`r8f #0/#1: Ctrl+Z at the approval prompt while a parallel call's guard hook runs (${where}), stopped longer than its timeout, fg: the guard still blocks`, { skip: skipBash, timeout: 90_000 }, async () => {
    const s = await approvalStop(prompt, true);
    assert.doesNotMatch(s, /timed out after/, `the hook that blocked while kiro-claude was stopped counted as timed out:\n${s}`);
    assert.doesNotMatch(s, /hunter2/, `the guarded read ran:\n${s}`);
    assert.match(s, /NO-SECRETS/);
  });
}

test('r8f #0: kill -STOP / kill -CONT of a headless chat while a blocking hook runs: the hook still blocks', { skip: linux, timeout: 60_000 }, async () => {
  const { r, hookLog } = guardRoot();
  const c = cli(r, ['chat', '--no-interactive', '--agent', 'guard', 'read secret'], { stdin: 'ignore' });
  try {
    await waitUntil(() => /start/.test(hookLog()), 'the guard hook starts', 20_000);
    process.kill(c.child.pid!, 'SIGSTOP');
    await sleep(STOPPED_MS);
    assert.match(hookLog(), /block/, 'the hook blocked while kiro-claude was stopped');
    process.kill(c.child.pid!, 'SIGCONT');
    const exit = await Promise.race([c.exit, sleep(20_000).then(() => undefined)]);
    assert.ok(exit, `the chat did not end:\n${c.o()}`);
    assert.doesNotMatch(c.o(), /hunter2|timed out after/, c.o());
    assert.match(c.o(), /DONE [^\n]*NO-SECRETS/);
  } finally {
    c.dispose();
    r.cleanup();
  }
});

test('r8f #0: kill -STOP / kill -CONT of the interactive chat (session leader) while a blocking hook runs: the hook still blocks, the chat reads again', { skip, timeout: 90_000 }, async () => {
  const { r, hookLog } = guardRoot();
  const t = open(r, [process.execPath, builtBin(), 'chat', '--agent', 'guard']);
  try {
    await t.waitFor(/> $/, 'chat prompt');
    const pid = t.chatPid();
    let mark = t.screen().length;
    t.write('read secret\r');
    await waitUntil(() => /start/.test(hookLog()), 'the guard hook starts', 20_000);
    process.kill(pid, 'SIGSTOP');
    await sleep(STOPPED_MS);
    assert.match(hookLog(), /block/, 'the hook blocked while kiro-claude was stopped');
    process.kill(pid, 'SIGCONT');
    await t.waitFor(/DONE [^\n]*[\s\S]*> $/, 'the turn ends', mark, 15_000);
    const s = t.screen().slice(mark);
    assert.doesNotMatch(s, /hunter2|timed out after/, s);
    assert.match(s, /NO-SECRETS/);
    mark = t.screen().length;
    t.write('next\r');
    await t.waitFor(/ANSWER to next[\s\S]*> $/, 'the chat reads again', mark, 10_000);
  } finally {
    await t.dispose();
  }
});

// ───────────────────────── #2: bracketed paste after a child ─────────────────────────

async function pasteStaysOneInput(t: Term): Promise<void> {
  const mark = t.screen().length;
  // the terminal brackets a paste only while the program last asked for it
  t.write(lastBracketedPaste(t.raw()) === 'h' ? '\u001b[200~one\rtwo\u001b[201~' : 'one\rtwo');
  await sleep(1500);
  assert.doesNotMatch(t.screen().slice(mark), /ANSWER/, 'a two-line paste submitted its first line as a prompt');
  t.write('\r');
  await t.waitFor(/ANSWER to one\r?\n[\s\S]*two[\s\S]*> $/, 'the paste is one input', mark, 10_000);
}

test('r8f #2: Ctrl+Z while a !cmd owns the terminal, then fg: bracketed paste is on again at the chat prompt', { skip: skipBash, timeout: 90_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const t = underBash(r);
  try {
    await startChat(t);
    assert.equal(lastBracketedPaste(t.raw()), 'h');
    const mark = t.screen().length;
    t.write('!sleep 1.5; echo BANG2-DONE\r');
    await sleep(400);
    t.write('\u001a');
    await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'the job stops', mark, 10_000);
    const fg = t.screen().length;
    t.write('fg\r');
    await t.waitFor(/BANG2-DONE[\s\S]*> $/, 'the !cmd ends, the chat prompt', fg, 10_000);
    await sleep(300);
    assert.equal(lastBracketedPaste(t.raw()), 'h', 'bracketed paste is off at the chat prompt after the child and fg');
    await pasteStaysOneInput(t);
  } finally {
    await t.dispose();
  }
});

test('r8f #2: an $EDITOR that turns bracketed paste off at exit (as vim does): it is on again at the chat prompt', { skip: skipBash, timeout: 90_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const ed = path.join(r.root, 'ed.sh');
  fs.writeFileSync(ed, `#!/bin/sh\nprintf '\\033[?2004l'\nprintf 'from the editor' > "$1"\n`, { mode: 0o755 });
  const t = underBash(r, { EDITOR: ed });
  try {
    await startChat(t);
    const mark = t.screen().length;
    t.write('/editor\r');
    await t.waitFor(/ANSWER to from the editor[\s\S]*> $/, 'the editor\'s text is submitted', mark, 15_000);
    await sleep(300);
    assert.equal(lastBracketedPaste(t.raw()), 'h', 'bracketed paste is off at the chat prompt after the editor');
    await pasteStaysOneInput(t);
  } finally {
    await t.dispose();
  }
});

// ───────────────────────── #4: several Ctrl+Z during one answer ─────────────────────────

test('r8f #4: Ctrl+Z pressed three times while an answer streams: one stop, one fg brings the chat back', { skip: skipBash, timeout: 90_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const t = underBash(r);
  try {
    await startChat(t);
    const pid = t.chatPid();
    let mark = t.screen().length;
    t.write('slow one\r');
    await t.waitFor(/BEGIN/, 'answer streaming', mark);
    const stopMark = t.screen().length;
    for (let i = 0; i < 3; i++) {
      t.write('\u001a');
      await sleep(150);
    }
    await t.waitFor(/END-OF-SLOW[\s\S]*Stopped[\s\S]*BASH\$ $/, 'the answer ends, then the job stops', stopMark, 10_000);
    await sleep(300);
    assert.equal(procState(pid), 'T', 'the chat is not stopped after its answer');
    const fg = t.screen().length;
    t.write('fg\r');
    await sleep(1500);
    const afterFg = t.screen().slice(fg);
    assert.ok(procState(pid) !== 'T' && !/Stopped/.test(afterFg), `after one fg the chat stopped again (state ${procState(pid)}): ${JSON.stringify(afterFg)}`);
    mark = t.screen().length;
    t.write('next\r');
    await t.waitFor(/ANSWER to next[\s\S]*> $/, 'the chat reads again', mark, 10_000);
  } finally {
    await t.dispose();
  }
});
