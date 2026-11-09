/**
 * Round-11 verification of the "terminal-a" fix for finding #1 under `sudo` with `Defaults
 * use_pty` (sudo 1.9: the default on current Debian/Ubuntu): a python3 pty driver running an
 * interactive bash, `sudo -n -E` with the test's temp HOME / KIRO_HOME / CLAUDE_CONFIG_DIR /
 * XDG_* (r11f-ta-pty-helpers.ts; nothing of sudoers is changed). Skipped without passwordless
 * sudo whose policy says use_pty.
 *
 * `!bash -i` puts itself in a process group of its own on sudo's inner pty and makes it that
 * pty's foreground; SIGKILLed (`kill -9 $$` in it) it leaves its dead group there. The chat then
 * stops itself because it needs the terminal (SIGTTIN, r11 #1). sudo, in the foreground of the
 * user's terminal, answers a command's SIGTTIN by resuming it in the foreground at once: its
 * monitor gives the inner pty back to the process group that had it when the command stopped,
 * which is the dead one (that tcsetpgrp fails), and continues the chat. So the chat stopped and
 * was continued every poll, forever, still off its terminal; bash, blocked on sudo's job, never
 * got the terminal back, and Ctrl+C, Ctrl+Z and Ctrl+D reached nobody: the user's terminal was
 * lost until a kill from elsewhere (as before r11, when the chat only polled). Now a self-stop
 * that comes back at once while the chat is still in the background is followed by a SIGTSTP,
 * which sudo answers by suspending itself: bash gets the terminal back ('Stopped') and `kill %1`
 * closes the chat. (It cannot come back there: sudo restores the dead group at every resume, and
 * Node has no tcsetpgrp; `fg` gives 'Stopped' again.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BASH, killedCleanly, procState, setup, skipPty, startAtPrompt, sudoUsePty, waitUntil, type Setup } from './r11f-ta-pty-helpers.js';

const skip = skipPty || (sudoUsePty() ? false : 'needs passwordless sudo with use_pty');
const SUDO = 'sudo -n -E ';

/** Under sudo: `!bash -i`, then `kill -9 $$` in it; bash must get its terminal back. */
async function childDiesHoldingInnerPty(s: Setup): Promise<number> {
  const { r, t } = s;
  const pid = await startAtPrompt(t, r, { prefix: SUDO });
  let mark = t.screen().length;
  t.write(`!PS1='INNER$ ' '${BASH}' --norc --noprofile -i\r`);
  await t.waitFor(/INNER\$ $/, 'the inner bash prompt', mark);
  mark = t.screen().length;
  t.write('kill -9 $$\r');
  await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped and has the terminal again', mark, 15_000);
  await waitUntil(() => procState(pid) === 'T', `the chat is stopped (state ${procState(pid)})`, 5000);
  // nothing of the chat's held output (the child's exit status) is written from the background
  assert.doesNotMatch(t.screen().slice(mark), /Self exited/, 'the held output was written from the background');
  return pid;
}

test('r11f verify #1 sudo use_pty: `!bash -i`, then `kill -9 $$` in it: bash gets the terminal back (the job stopped); `kill %1` closes the chat (143, lock released, SessionEnd ran)', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await childDiesHoldingInnerPty(s);
    await killedCleanly(s, pid, { notPrinted: /Self exited/ });
  } finally {
    await s.t.dispose();
  }
});

test('r11f verify #1 sudo use_pty: the same, then `fg`: the terminal comes back to bash again (sudo restores the dead group), and `kill %1` closes the chat', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await childDiesHoldingInnerPty(s);
    const mark = s.t.screen().length;
    s.t.write('fg\r');
    await s.t.waitFor(/fg\r?\n[\s\S]*Stopped[\s\S]*BASH\$ $/, 'bash has the terminal again after fg', mark, 15_000);
    await waitUntil(() => procState(pid) === 'T', `the chat is stopped (state ${procState(pid)})`, 5000);
    await killedCleanly(s, pid, { notPrinted: /Self exited/ });
  } finally {
    await s.t.dispose();
  }
});
