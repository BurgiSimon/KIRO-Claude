/**
 * Round-11 fix "terminal-b", findings #3 and #5 (documentation), with the behaviour the documents
 * now describe, in a real terminal (python3 pty; temp HOME, KIRO_HOME, CLAUDE_CONFIG_DIR and XDG_*
 * only; test/fixtures/fake-claude.mjs).
 *
 * #3: README said of a chat stopped while it is still starting, and of `kiro-claude chat &`, that
 * what you type right after `fg` "counts as typed: Enter submits". The reader reads the keys the
 * shell's cooked mode queued as typed only when the start finished while the chat was in the
 * background (Repl.run's `waited`, decided once after the start: it then stops itself until `fg`,
 * r11 #2); a `fg` while it still starts brings it up as a chat starting in the foreground, where a
 * newline typed before its prompt stays a soft newline (Kiro/Q parity, r10). README now says so.
 *
 * #5: docs/ARCHITECTURE.md "Signals and child processes" said every child is spawned `detached` and
 * "No child outlives kiro-claude"; a `!cmd` (and `$EDITOR`, the interactive `claude auth`) runs in
 * kiro-claude's own process group, untracked, and outlives a chat closed by a SIGTERM to it alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { mkRoot } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';
import { SLOW_START, procPgrp, procState, quits, setup, skipPty, sleep, startChat, stopsForTerminal, waitUntil } from './r11f-ta-pty-helpers.js';

/** A file of the repository the tests run from (the cwd or a parent of it). */
function doc(rel: string): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'repl', 'input.ts')) && fs.existsSync(path.join(dir, rel))) return fs.readFileSync(path.join(dir, rel), 'utf8');
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

// ───────────────────────────── #3 ─────────────────────────────

test('r11f #3: README qualifies "counts as typed" after `fg` for a chat still starting (a fg then is a foreground start)', () => {
  const text = doc('README.md').replace(/\s+/g, ' ');
  const sentence = /[^.]*counts as typed[^.]*\./.exec(text)?.[0] ?? '';
  assert.notEqual(sentence, '', 'the sentence is gone');
  assert.match(sentence, /still starting/, sentence);
  assert.match(sentence, /new line/, sentence);
  assert.match(sentence, /kill -TSTP` or `kill -STOP` from elsewhere/, `#0: the stop from elsewhere is not named: ${sentence}`);
});

for (const how of ['amp', 'ctrlz'] as const) {
  const what = how === 'amp' ? '`kiro-claude chat &`, `fg` while it is still starting' : 'Ctrl+Z while the chat starts, then `fg`';
  test(`r11f #3: ${what}: a line + Enter typed right after \`fg\` stays a new line (as in a foreground start); the next Enter submits it`, { skip: skipPty, timeout: 120_000 }, async () => {
    const s = setup({ env: SLOW_START });
    try {
      const { t, r } = s;
      const pid = await startChat(t, r, { amp: how === 'amp' });
      if (how === 'ctrlz') {
        const m = t.screen().length;
        t.write('\x1a');
        await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'stopped while starting', m);
      } else await sleep(300);
      assert.doesNotMatch(t.screen(), /Welcome to/, 'precondition: still starting');
      const mark = t.screen().length;
      t.write('fg\r');
      await sleep(300);
      t.write('hello\r');
      await t.waitFor(/Welcome to[\s\S]*> hello/, 'the greeting and the typed line', mark, 30_000);
      await sleep(1000);
      assert.doesNotMatch(t.screen().slice(mark), /ANSWER to/, 'submitted: README says an Enter typed then stays a new line');
      t.write('\r');
      await t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the answer after a second Enter', mark, 15_000);
      await quits(t, r, pid);
    } finally {
      await s.t.dispose();
    }
  });
}

test('r11f #3: `kiro-claude chat &` whose start finished in the background (it stopped itself): a line + Enter typed right after `fg` submits', { skip: skipPty, timeout: 120_000 }, async () => {
  const s = setup({ env: SLOW_START });
  try {
    const { t, r } = s;
    const pid = await startChat(t, r, { amp: true });
    await stopsForTerminal(t, pid, 20_000);
    const mark = t.screen().length;
    t.write('fg\r');
    await sleep(100);
    t.write('hello\r');
    await t.waitFor(/ANSWER to hello[\s\S]*> $/, 'the answer to the line typed right after fg', mark, 20_000);
    await sleep(300);
    assert.equal(t.screen().slice(mark).match(/ANSWER to hello/g)?.length, 1, t.screen().slice(mark));
    await quits(t, r, pid);
  } finally {
    await s.t.dispose();
  }
});

// ───────────────────────────── #5 ─────────────────────────────

/** A session leader that stays (as an interactive shell does), the chat in its own foreground process group. */
const JOB_DRIVER = String.raw`
import os, pty, sys, select, signal, time
argv = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    c = os.fork()
    if c == 0:
        os.setpgid(0, 0)
        signal.signal(signal.SIGTTOU, signal.SIG_IGN)
        os.tcsetpgrp(0, os.getpid())
        signal.signal(signal.SIGTTOU, signal.SIG_DFL)
        os.execvp(argv[0], argv)
    try:
        os.setpgid(c, c)
    except OSError:
        pass
    os.write(1, b"KCPID %d\n" % c)
    os.waitpid(c, 0)
    os.write(1, b"KCEXITED\n")
    while True:
        signal.pause()
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
            d = b''
        if d:
            os.write(1, d)
    if inp_open and inp in r:
        d = os.read(inp, 65536)
        if d:
            os.write(master, d)
        else:
            inp_open = False
os.close(master)
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
os.waitpid(pid, 0)
`;

function findByCmdline(cmdline: string): number | undefined {
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (fs.readFileSync(`/proc/${d}/cmdline`, 'utf8') === cmdline) return Number(d);
    } catch {
      // gone
    }
  }
  return undefined;
}

test('r11f #5: a `!cmd` child runs in the chat\'s own process group, untracked, and outlives a chat closed by a SIGTERM to it alone; ARCHITECTURE "Signals and child processes" says so', { skip: skipPty, timeout: 120_000 }, async () => {
  const r = mkRoot({ turns: [{ repeat: true, steps: [{ text: 'ok' }] }] });
  removeOnExit(r.root);
  const driver = path.join(r.root, 'job.py');
  fs.writeFileSync(driver, JOB_DRIVER);
  const drv = spawn('python3', ['-I', driver, process.execPath, builtBin(), 'chat'], { cwd: r.ws, env: r.env({ TERM: 'xterm' }), stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  drv.stdout.on('data', (d: Buffer) => (out += d.toString()));
  drv.stdin.on('error', () => undefined);
  const screen = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  // a unique duration marks the child this test started
  const marker = `${(61 + Math.random()).toFixed(4)}`;
  let chatPid = 0;
  let childPid: number | undefined;
  try {
    await waitUntil(() => /KCPID (\d+)/.test(out), 'the chat starts', 15_000);
    chatPid = Number(/KCPID (\d+)/.exec(out)![1]);
    await waitUntil(() => /Welcome to[\s\S]*> $/.test(screen()), 'the chat prompt', 30_000);
    await sleep(300);
    drv.stdin.write(`!sleep ${marker}\r`);
    await waitUntil(() => (childPid = findByCmdline(`sleep\0${marker}\0`)) !== undefined, 'the !cmd child', 15_000);
    assert.equal(procPgrp(childPid!), chatPid, "the !cmd child runs in the chat's own process group (not detached)");
    process.kill(chatPid, 'SIGTERM');
    await waitUntil(() => /KCEXITED/.test(out), 'the chat ends', 15_000);
    await sleep(300);
    const st = procState(childPid!);
    assert.ok(st !== 'gone' && st !== 'Z', `the !cmd child did not outlive the chat (state ${st})`);
  } finally {
    for (const p of [childPid, chatPid]) {
      if (p && procState(p) !== 'gone') {
        try {
          process.kill(p, 'SIGKILL');
        } catch {
          // gone
        }
      }
    }
    drv.kill('SIGTERM');
    await sleep(200);
    r.cleanup();
  }
  const arch = doc('docs/ARCHITECTURE.md');
  const start = arch.indexOf('## Signals and child processes');
  assert.ok(start >= 0, 'the section exists');
  const next = arch.indexOf('\n## ', start + 5);
  const section = arch.slice(start, next < 0 ? undefined : next);
  assert.doesNotMatch(section, /\*\*No child outlives kiro-claude\.\*\*/, 'claims no child outlives kiro-claude');
  assert.doesNotMatch(section, /every child is spawned `detached`/, 'claims every child is detached');
  assert.match(section, /!cmd/, 'the section never names the children it does not track');
  assert.match(section, /claude auth login\|logout/, 'the interactive `claude auth` (untracked) is not named');
  assert.match(section, /outlives?|running after\s+kiro-claude died/, 'the section does not say such a child can outlive kiro-claude');
});
