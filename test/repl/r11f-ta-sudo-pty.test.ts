/**
 * Round-11 fix "terminal-a" #2 under `sudo` with `Defaults use_pty` (sudo 1.9: the default on
 * current Debian/Ubuntu): a python3 pty driver running an interactive bash, `sudo -E` with the
 * test's temp HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG_* (r11f-ta-pty-helpers.ts; nothing of
 * sudoers is changed). Skipped without passwordless sudo whose policy says use_pty.
 *
 * sudo runs the command on an inner pty it relays. While sudo is in the background of the user's
 * terminal its monitor keeps the inner pty's foreground; sudo hands it to the command only after
 * sudo itself is continued (SIGCONT), which normally follows the command's job-control stop (sudo
 * then suspends itself, bash shows 'Stopped', `fg` sends SIGCONT). bash's `fg` of a job it knows to
 * be running sends no SIGCONT. Since the r9/r10 foreground polls the chat never stopped there, so
 * `sudo kiro-claude chat &` + `fg`, Ctrl+Z while it starts + `bg` + `fg` (they worked at
 * e914e7e: a regression of the r10 #1 wait), Ctrl+Z at the prompt + `bg` + `fg`, and a `!cmd`
 * that ended in the background never came up after `fg` (no greeting or prompt, lock held). Now the chat stops like a background job
 * that reads its terminal (SIGTTIN, which sudo relays by suspending itself, 'Stopped (tty input)'),
 * and `fg` continues sudo, which hands the inner pty over. `kill %1` (SIGTERM relayed by sudo, then
 * SIGCONT) still closes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SLOW_START,
  answers,
  bg,
  ctrlZ,
  killedCleanly,
  nothingDrawn,
  quits,
  setup,
  skipPty,
  sleep,
  startAtPrompt,
  startChat,
  stopsForTerminal,
} from './r11f-ta-pty-helpers.js';
import { sudoUsePty } from './r11f-ta-pty-helpers.js';

const skip = skipPty || (sudoUsePty() ? false : 'needs passwordless sudo with use_pty');
const SUDO = 'sudo -n -E ';

test('r11f #2 sudo: `sudo kiro-claude chat &`: it stops by itself; `fg` brings the greeting and the prompt, and it answers', { skip, timeout: 120_000 }, async () => {
  const s = setup({ env: SLOW_START });
  try {
    const mark = s.t.screen().length;
    const pid = await startChat(s.t, s.r, { prefix: SUDO, amp: true });
    await sleep(3000);
    await stopsForTerminal(s.t, pid);
    nothingDrawn(s.t, mark);
    const m = s.t.screen().length;
    s.t.write('fg\r');
    await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the greeting and the prompt after fg', m, 15_000);
    await answers(s.t, m);
    await quits(s.t, s.r, pid);
  } finally {
    await s.t.dispose();
  }
});

test('r11f #2 sudo: `sudo kiro-claude chat &`, then `kill %1`: it closes and dies of SIGTERM (lock released, SessionEnd ran, nothing drawn)', { skip, timeout: 120_000 }, async () => {
  const s = setup({ env: SLOW_START });
  try {
    const pid = await startChat(s.t, s.r, { prefix: SUDO, amp: true });
    await sleep(3000);
    await stopsForTerminal(s.t, pid);
    await killedCleanly(s, pid);
  } finally {
    await s.t.dispose();
  }
});

test('r11f #2 sudo: Ctrl+Z while the chat starts, `bg`, then `fg`: it comes up and answers', { skip, timeout: 120_000 }, async () => {
  const s = setup({ env: SLOW_START });
  try {
    const pid = await startChat(s.t, s.r, { prefix: SUDO });
    await sleep(300);
    const mark = s.t.screen().length;
    s.t.write('\x1a');
    await s.t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
    await sleep(3000);
    await bg(s.t);
    await stopsForTerminal(s.t, pid);
    nothingDrawn(s.t, mark);
    const m = s.t.screen().length;
    s.t.write('fg\r');
    await s.t.waitFor(/Welcome to[\s\S]*> $/, 'the greeting and the prompt after fg', m, 15_000);
    await answers(s.t, m);
  } finally {
    await s.t.dispose();
  }
});

test('r11f #2 sudo: Ctrl+Z at the prompt, `bg` (it stops again), `fg`: it answers; again Ctrl+Z, `bg`, `kill %1`: it closes', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await startAtPrompt(s.t, s.r, { prefix: SUDO });
    await ctrlZ(s.t, pid);
    await bg(s.t);
    await stopsForTerminal(s.t, pid);
    const m = s.t.screen().length;
    s.t.write('fg\r');
    await answers(s.t, m);
    await ctrlZ(s.t, pid);
    await bg(s.t);
    await stopsForTerminal(s.t, pid);
    await killedCleanly(s, pid);
  } finally {
    await s.t.dispose();
  }
});

test('r11f #2 sudo: `!sleep 1`, Ctrl+Z, `bg` (the child ends in the background): the chat stops; `fg` brings the prompt and it answers', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const pid = await startAtPrompt(s.t, s.r, { prefix: SUDO });
    s.t.write('!sleep 1\r');
    await sleep(400);
    await ctrlZ(s.t, pid);
    await bg(s.t);
    await sleep(1200);
    await stopsForTerminal(s.t, pid);
    const m = s.t.screen().length;
    s.t.write('fg\r');
    await answers(s.t, m);
    assert.equal(s.r.locks().length, 1);
  } finally {
    await s.t.dispose();
  }
});
