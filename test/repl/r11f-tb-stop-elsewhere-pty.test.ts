/**
 * Round-11 fix "terminal-b", finding #0, in a real terminal: an interactive bash (job control) in
 * a python3 pty, the built CLI over test/fixtures/fake-claude.mjs, temp HOME, KIRO_HOME,
 * CLAUDE_CONFIG_DIR and XDG_* only (test/repl/r11f-ta-pty-helpers.ts).
 *
 * After a stop from elsewhere (`kill -TSTP <pid>` / `kill -STOP <pid>`; not Ctrl+Z, whose jobStop
 * pauses the input before the stop), keys typed in the shell before `fg`'s SIGCONT (`sleep 0.6;
 * fg`, typed during the sleep) were read by the still flowing input in the shell's canonical mode,
 * before the reader's SIGCONT listener could pause it (libuv dispatches signals after the I/O of
 * the same poll): one Ctrl+D (canonical end of file: a 0-byte read) ended the input as at a
 * hangup (an open approval cancelled unanswered, the chat gone, later keys run by bash), and a
 * line's Return was a soft newline. And after `kill -STOP`, a `kill -CONT` from elsewhere while
 * bash ran a command with keys typed ahead made the chat read the terminal from the background:
 * the kernel's SIGTTIN stopped it inside that read, restarted after every continue, so `kill %1`
 * left it 'Stopped' with its lock until `fg`. Ctrl+Z behaved as documented (the controls here).
 *
 * Also: with no shell that could take the terminal (kiro-claude leads the terminal's session),
 * keys typed during such a stop were typed raw and are read as such (a Ctrl+J stays a soft
 * newline).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { mkRoot } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';
import { answers, killedCleanly, procState, quits, setup, skipPty, sleep, startAtPrompt, waitUntil, type Setup, type Term } from './r11f-ta-pty-helpers.js';

const SCRIPT = {
  turns: [
    {
      repeat: true,
      match: '^go',
      steps: [{ sleepMs: 2500 }, { tool: { name: 'Bash', input: { command: 'echo HI' }, result: 'HI-RAN' } }, { text: 'RESULT=[{{lastToolResult}}]' }],
    },
  ],
  default: { steps: [{ text: 'ANSWER to {{userText}}' }] },
};

/** The approval question, its read waiting for the answer at its own prompt. */
const APPROVAL = /Allow this action\?[^\n]*\[y\/n\/t\]:\s*> $/;
const DENIED = /doesn't want to proceed/;
const EXIT_HINT = /press Ctrl\+C or Ctrl\+D again/;

type How = 'ctrlz' | 'SIGTSTP' | 'SIGSTOP';

/** Stop the chat: Ctrl+Z at the terminal, or a signal from elsewhere. bash reports the job stopped. */
async function stop(t: Term, pid: number, how: How): Promise<void> {
  const mark = t.screen().length;
  if (how === 'ctrlz') t.write('\x1a');
  else process.kill(pid, how);
  await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
  await waitUntil(() => procState(pid) === 'T', 'stopped', 5000);
}

/** `sleep 0.6; fg`, with `keys` typed during the sleep (queued in the shell's cooked mode). */
async function fgWithKeysTyped(t: Term, keys: string[]): Promise<number> {
  const mark = t.screen().length;
  t.write('sleep 0.6; fg\r');
  await sleep(250);
  for (const k of keys) {
    t.write(k);
    await sleep(50);
  }
  return mark;
}

async function withChat(fn: (s: Setup, pid: number) => Promise<void>): Promise<void> {
  const s = setup({ script: SCRIPT });
  try {
    const pid = await startAtPrompt(s.t, s.r);
    await sleep(300);
    await fn(s, pid);
  } finally {
    await s.t.dispose();
  }
}

for (const how of ['ctrlz', 'SIGTSTP', 'SIGSTOP'] as const) {
  const what = how === 'ctrlz' ? 'control: Ctrl+Z' : `kill -${how.slice(3)} from elsewhere`;

  test(`r11f #0: ${what} at the prompt, Ctrl+D typed during \`sleep 0.6; fg\`: it is Ctrl+D (the exit hint), not an end of input; the chat stays and reads on`, { skip: skipPty, timeout: 120_000 }, async () => {
    await withChat(async ({ t, r }, pid) => {
      await stop(t, pid, how);
      const mark = await fgWithKeysTyped(t, ['\x04']);
      await t.waitFor(EXIT_HINT, 'the exit hint of a first Ctrl+D', mark, 10_000);
      await sleep(800);
      assert.notEqual(procState(pid), 'gone', `one queued Ctrl+D ended the chat:\n${JSON.stringify(t.screen().slice(mark))}`);
      assert.doesNotMatch(t.screen().slice(mark), /To resume this session/);
      await answers(t, mark);
      await quits(t, r, pid);
    });
  });

  test(`r11f #0: ${what} at the prompt, \`hello\` + Enter typed during \`sleep 0.6; fg\`: submitted, once`, { skip: skipPty, timeout: 120_000 }, async () => {
    await withChat(async ({ t, r }, pid) => {
      await stop(t, pid, how);
      const mark = await fgWithKeysTyped(t, ['hello\r']);
      await t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the answer to the queued line', mark, 15_000);
      await sleep(300);
      assert.equal(t.screen().slice(mark).match(/ANSWER to hello/g)?.length, 1, t.screen().slice(mark));
      await quits(t, r, pid);
    });
  });
}

for (const how of ['SIGTSTP', 'SIGSTOP'] as const) {
  test(`r11f #0: kill -${how.slice(3)} from elsewhere mid-turn, Ctrl+D and a line typed during \`sleep 0.6; fg\`: the approval is asked, not cancelled; bash runs nothing; the chat answers on`, { skip: skipPty, timeout: 120_000 }, async () => {
    await withChat(async ({ t, r }, pid) => {
      const m0 = t.screen().length;
      t.write('go\r');
      await t.waitFor(/Thinking/, 'the turn runs', m0, 10_000);
      await sleep(400);
      await stop(t, pid, how);
      const mark = await fgWithKeysTyped(t, ['\x04', 'echo TYPED-FOR-CHAT\r']);
      await t.waitFor(/Allow this action\?/, 'the approval question', mark, 15_000);
      await sleep(800);
      const at = t.screen().slice(mark);
      assert.doesNotMatch(at, DENIED, `the approval was cancelled unanswered:\n${JSON.stringify(at)}`);
      assert.notEqual(procState(pid), 'gone', 'the chat quit mid-turn');
      assert.match(at, APPROVAL, `the approval is not waiting for its answer:\n${JSON.stringify(at)}`);
      const m1 = t.screen().length;
      t.write('y\r');
      await t.waitFor(/RESULT=\[HI-RAN\][\s\S]*> $/, 'the approved tool ran', m1, 15_000);
      await sleep(300);
      const all = t.screen().slice(mark);
      assert.doesNotMatch(all, /BASH\$ echo TYPED-FOR-CHAT|\nTYPED-FOR-CHAT/, `bash ran the line typed for the chat:\n${JSON.stringify(all)}`);
      await answers(t, t.screen().length - 2);
      await quits(t, r, pid);
    });
  });
}

test('r11f #0: kill -STOP from elsewhere at an open approval, Ctrl+D typed during `sleep 0.6; fg`: the approval stays open and takes its answer', { skip: skipPty, timeout: 120_000 }, async () => {
  await withChat(async ({ t, r }, pid) => {
    const m0 = t.screen().length;
    t.write('go\r');
    await t.waitFor(APPROVAL, 'the approval question', m0, 15_000);
    await sleep(300);
    await stop(t, pid, 'SIGSTOP');
    const mark = await fgWithKeysTyped(t, ['\x04']);
    await sleep(1500);
    const at = t.screen().slice(mark);
    assert.doesNotMatch(at, DENIED, `the approval was cancelled unanswered:\n${JSON.stringify(at)}`);
    assert.notEqual(procState(pid), 'gone', 'the chat quit at the approval');
    // the read being answered is drawn again on the shell's fresh line: the approval's prompt
    assert.match(at, /\n> $/, `the approval's prompt is not drawn again, waiting for its answer:\n${JSON.stringify(at)}`);
    const m1 = t.screen().length;
    t.write('y\r');
    await t.waitFor(/RESULT=\[HI-RAN\][\s\S]*> $/, 'the approved tool ran', m1, 15_000);
    await quits(t, r, pid);
  });
});

test('r11f #0: kill -STOP, then kill -CONT from elsewhere while bash runs `sleep 3` with a line typed ahead: the line is bash\'s, the chat reads nothing there, and `kill %1` closes it', { skip: skipPty, timeout: 120_000 }, async () => {
  const s = setup({ script: SCRIPT });
  try {
    const { t, r } = s;
    const pid = await startAtPrompt(t, r);
    await sleep(300);
    await stop(t, pid, 'SIGSTOP');
    const mark = t.screen().length;
    t.write('sleep 3\r');
    await sleep(400);
    t.write('abc\r'); // typed ahead for bash while its command runs
    await sleep(300);
    process.kill(pid, 'SIGCONT'); // continued from elsewhere: bash keeps the terminal
    await t.waitFor(/abc: command not found[\s\S]*BASH\$ $/, 'bash runs the line typed ahead', mark, 15_000);
    await sleep(300);
    await killedCleanly(s, pid);
  } finally {
    await s.t.dispose();
  }
});

// ───────────────────────────── no shell: kiro-claude leads the terminal's session ─────────────────────────────

/** A pty whose session leader is the chat itself (`ssh -t host kiro-claude chat`): stdin forwarded, the screen on stdout. */
const LEADER_DRIVER = String.raw`
import os, pty, sys, select, signal, struct, fcntl, termios, time
argv = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
os.write(1, b'CHILD %d\n' % pid)
stop = [False]
signal.signal(signal.SIGTERM, lambda s, f: stop.__setitem__(0, True))
inp = sys.stdin.fileno()
inp_open = True
while not stop[0]:
    fds = [master] + ([inp] if inp_open else [])
    try:
        r, _, _ = select.select(fds, [], [], 0.05)
    except InterruptedError:
        continue
    if master in r:
        try:
            d = os.read(master, 65536)
        except OSError:
            break
        if not d:
            break
        os.write(1, d)
    if inp_open and inp in r:
        d = os.read(inp, 65536)
        if d:
            os.write(master, d)
        else:
            inp_open = False
    w, _ = os.waitpid(pid, os.WNOHANG)
    if w == pid:
        break
try:
    os.kill(pid, signal.SIGCONT)
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
`;

test('r11f #0: no shell (kiro-claude leads its session): kill -STOP / kill -CONT from elsewhere, keys typed meanwhile were typed raw and are read as such (a Ctrl+J stays a soft newline)', { skip: skipPty, timeout: 120_000 }, async () => {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const driver = path.join(r.root, 'leader.py');
  fs.writeFileSync(driver, LEADER_DRIVER);
  const py = spawn('python3', ['-I', driver, process.execPath, builtBin(), 'chat'], { cwd: r.ws, env: r.env({ TERM: 'xterm' }), stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  py.stdout.on('data', (d: Buffer) => (out += d.toString()));
  py.stdin.on('error', () => undefined);
  const screen = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let pid = 0;
  try {
    await waitUntil(() => /CHILD (\d+)/.test(out), 'the chat starts', 15_000);
    pid = Number(/CHILD (\d+)/.exec(out)![1]);
    await waitUntil(() => /Welcome to[\s\S]*> $/.test(screen()), 'the chat prompt', 30_000);
    await sleep(300);
    process.kill(pid, 'SIGSTOP');
    await waitUntil(() => procState(pid) === 'T', 'stopped', 5000);
    const mark = screen().length;
    // typed while it is stopped; the terminal is still in the chat's raw mode (nobody took it):
    // ab, Ctrl+J (a soft newline), cd, Return
    py.stdin.write('ab\ncd\r');
    await sleep(600);
    process.kill(pid, 'SIGCONT');
    await waitUntil(() => /ANSWER to ab/.test(screen().slice(mark)), 'the answer', 15_000);
    await sleep(500);
    const after = screen().slice(mark);
    assert.doesNotMatch(after, /ANSWER to cd/, `the raw Ctrl+J was read as a Return (cooked-mode mapping): ${JSON.stringify(after)}`);
    assert.match(after, /ANSWER to ab\r?\n\s*cd/, JSON.stringify(after));
    py.stdin.write('/quit\r');
    await waitUntil(() => procState(pid) === 'gone' || procState(pid) === 'Z', 'the chat ends after /quit', 15_000);
  } finally {
    py.kill('SIGTERM');
    await sleep(300);
    if (pid && procState(pid) !== 'gone') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
    r.cleanup();
  }
});
