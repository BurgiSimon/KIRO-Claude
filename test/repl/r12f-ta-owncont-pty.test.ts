/**
 * Round-12 fix "terminal-a", finding #3, in a real terminal: an interactive bash (job control) in
 * a python3 pty, the built CLI over test/fixtures/fake-claude.mjs, temp HOME, KIRO_HOME,
 * CLAUDE_CONFIG_DIR and XDG_* only (r11f-ta-pty-helpers.ts).
 *
 * LineReader.continued() took any SIGCONT that came within OWN_CONT_MS (250 ms) of a retake for
 * that retake's own. A stop from elsewhere (`kill -STOP <pid>`) that bash reported as Stopped, and
 * its `fg`, inside that window (a supervisor, a test harness: no person types that fast) then got
 * no retake: bash had put the terminal in its canonical mode, nothing was drawn, and Return (a
 * newline: Ctrl+J, a soft newline) never submitted. Now only the SIGCONT that the reader's own
 * stop (Ctrl+Z's SIGTSTP, the self-stop in the background) still has to come is absorbed.
 *
 * The outside stop follows the retake as fast as the test can see it (bash's `Stopped`); when that
 * is later than the window on a loaded machine, the test still checks the same outcome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

import { answers, bg, ctrlZ, procState, quits, setup, skipPty, sleep, startAtPrompt, stopsForTerminal, waitUntil, type Term } from './r11f-ta-pty-helpers.js';

/** The chat's TMPDIR in the test's root (removed with it, should the chat be killed). */
const inRoot = (r: { root: string }): string => `TMPDIR='${r.root}' `;

/** Whether the chat's terminal is in canonical mode (the shell's), not the chat's raw mode. */
function canonical(pid: number): boolean {
  const tty = fs.readlinkSync(`/proc/${pid}/fd/0`);
  const r = spawnSync('stty', ['-F', tty, '-a'], { encoding: 'utf8' });
  return /(^|\s)icanon(\s|$)/.test(r.stdout ?? '');
}

/** `fg`, and the chat takes the terminal back (bracketed paste on again, its prompt drawn). Resolves at the retake. */
async function fgRetake(t: Term): Promise<number> {
  const raw = t.raw().length;
  const scr = t.screen().length;
  t.write('fg\r');
  await waitUntil(() => t.raw().slice(raw).includes('\u001b[?2004h') && /> $/.test(t.screen().slice(scr)), 'the chat takes the terminal back after fg', 15_000);
  return performance.now();
}

/** `kill -STOP` from elsewhere right away, bash reports it, `fg` again: the chat takes the terminal back and a line is answered. */
async function stopElsewhereAndFg(t: Term, pid: number, since: number, pauseMs = 0): Promise<void> {
  if (pauseMs) await sleep(pauseMs);
  const mark = t.screen().length;
  process.kill(pid, 'SIGSTOP');
  await t.waitFor(/Stopped[\s\S]*BASH\$ $/, 'bash reports the job stopped', mark);
  await waitUntil(() => procState(pid) === 'T', 'stopped', 5000);
  const raw = t.raw().length;
  const m = t.screen().length;
  t.write('fg\r');
  const after = performance.now() - since;
  await waitUntil(() => procState(pid) !== 'T', 'running after fg', 5000);
  try {
    await waitUntil(() => t.raw().slice(raw).includes('\u001b[?2004h'), 'taken back', 5000);
  } catch {
    // reported below
  }
  await sleep(300);
  assert.equal(canonical(pid), false, `the terminal was left in the shell's canonical mode (fg ${after.toFixed(0)} ms after the retake); drawn after fg: ${JSON.stringify(t.raw().slice(raw))}`);
  assert.match(t.raw().slice(raw), /\u001b\[\?2004h/, `no retake after fg (${after.toFixed(0)} ms after the retake): ${JSON.stringify(t.raw().slice(raw))}`);
  await answers(t, m);
}

test('r12f #3: Ctrl+Z, `fg`, then a stop from elsewhere and its `fg` right after the retake: the terminal is taken back and Return submits', { skip: skipPty, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const { t, r } = s;
    const pid = await startAtPrompt(t, r, { prefix: inRoot(r) });
    await sleep(300);
    await ctrlZ(t, pid);
    const at = await fgRetake(t);
    await stopElsewhereAndFg(t, pid, at);
    await quits(t, r, pid);
  } finally {
    await s.t.dispose();
  }
});

test('r12f #3: Ctrl+Z, `bg` (the chat stops itself: it needs the terminal), `fg`, then a stop from elsewhere and its `fg` right after the retake: taken back', { skip: skipPty, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const { t, r } = s;
    const pid = await startAtPrompt(t, r, { prefix: inRoot(r) });
    await sleep(300);
    await ctrlZ(t, pid);
    await bg(t);
    await stopsForTerminal(t, pid);
    const at = await fgRetake(t);
    await stopElsewhereAndFg(t, pid, at);
    await quits(t, r, pid);
  } finally {
    await s.t.dispose();
  }
});

test('r12f #3 control: a stop from elsewhere 400 ms after a retake is taken back after `fg`', { skip: skipPty, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    const { t, r } = s;
    const pid = await startAtPrompt(t, r, { prefix: inRoot(r) });
    await sleep(300);
    await ctrlZ(t, pid);
    const at = await fgRetake(t);
    await stopElsewhereAndFg(t, pid, at, 400);
    await quits(t, r, pid);
  } finally {
    await s.t.dispose();
  }
});
