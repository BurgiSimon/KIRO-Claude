/**
 * Round-12 follow-up "terminal", verification of T3 (input.ts ttyAnswer): only a transient error
 * reading /proc/self/stat (out of file descriptors or memory) is "cannot tell", which is not the
 * foreground (the waits off the terminal look again later). A /proc that cannot be read for good
 * (Linux with no /proc mounted: a chroot, a minimal container or sandbox; ENOENT, EACCES) or reads
 * nothing it can parse says nothing about job control either way: the foreground is taken for
 * granted there, as off Linux (DECISION, module doc) and as before T3, and it is no end of the
 * terminal session. T3 made every /proc failure "cannot tell": with no /proc the chat waited for
 * a foreground it could never see, before its first prompt, for good (no greeting, no prompt,
 * polling every 20 ms until killed).
 *
 * Unit level through the TtySys seam (ENOENT, EACCES, EPERM, a /proc/self/stat it cannot parse),
 * and a real pty: the chat under `unshare --mount --fork` with an empty tmpfs over /proc (skipped
 * where a mount namespace is not permitted). Temp dirs only (r11f-ta-pty-helpers).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import * as inputMod from '../../src/repl/input.js';
import { answers, chatCommand, procState, quits, setup, skipPty, waitUntil } from './r11f-ta-pty-helpers.js';

interface Sys {
  isatty(fd: number): boolean;
  procStat(): string;
  rdev(fd: number): number;
}
const terminalInForeground = inputMod.terminalInForeground as (input: unknown, probe?: boolean, sys?: Sys) => boolean;
const terminalGone = inputMod.terminalGone as (input: unknown, sys?: Sys) => () => boolean;
const controllingTerminal = inputMod.controllingTerminal as (input: unknown, sys?: Sys) => boolean | undefined;

const FD = 7;
const PTS = (136 << 8) | 3;
/** /proc/self/stat with this tty_nr, in the background (pgrp 4242, the terminal's group 4300). */
const BACKGROUND = `4242 (node) S 1 4242 4000 ${PTS} 4300 4194560 1 0 0 0 0 0 0 0 20 0 11 0 9 1 1`;
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: test`), { code });

const linux = process.platform === 'linux' ? false : 'Linux /proc';

test('r12g verify T3: /proc/self/stat unreadable for good (ENOENT: no /proc; EACCES, EPERM) or unparsable is no "cannot tell": the foreground is taken for granted as off Linux, and it is no end of the terminal session', { skip: linux }, () => {
  for (const failure of ['ENOENT', 'EACCES', 'EPERM', 'unparsable'] as const) {
    let broken = false;
    const sys: Sys = {
      isatty: () => true,
      procStat: () => {
        if (!broken) return BACKGROUND;
        if (failure === 'unparsable') return 'garbage';
        throw errno(failure);
      },
      rdev: () => PTS,
    };
    const gone = terminalGone({ fd: FD }, sys);
    assert.equal(terminalInForeground({ fd: FD }, false, sys), false, `${failure}: the background, read from /proc`);
    broken = true;
    assert.equal(terminalInForeground({ fd: FD }, true, sys), true, `${failure}: the start waited for a foreground it can never see`);
    assert.equal(gone(), false, `${failure}: taken for the end of the terminal session`);
    assert.equal(controllingTerminal({ fd: FD }, sys), undefined, `${failure}: not told`);
    // (a watch made while /proc cannot be read at all never ends)
    assert.equal(terminalGone({ fd: FD }, sys)(), false, failure);
  }
  // control: a transient error is still "cannot tell", not the foreground (T3)
  const sys: Sys = { isatty: () => true, procStat: () => { throw errno('EMFILE'); }, rdev: () => PTS };
  assert.equal(terminalInForeground({ fd: FD }, true, sys), false, 'EMFILE: look again later');
});

const NO_PROC = "unshare --mount --fork sh -c 'mount -t tmpfs none /proc && exec \"$0\" \"$@\"'";
const hideProc =
  process.platform === 'linux' &&
  spawnSync('unshare', ['--mount', '--fork', 'sh', '-c', 'mount -t tmpfs none /proc && test ! -e /proc/self/stat'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
const skip = skipPty || (hideProc ? false : 'needs a mount namespace that can hide /proc (unshare --mount, CAP_SYS_ADMIN)');

test('r12g verify T3: on Linux with no /proc (a mount namespace with an empty /proc), `kiro-claude chat` in the foreground draws its greeting and prompt, answers, and /quit ends it', { skip, timeout: 120_000 }, async () => {
  const s = setup();
  try {
    await s.t.waitFor(/BASH\$ $/, 'bash prompt');
    const mark = s.t.screen().length;
    s.t.write(`${NO_PROC} ${chatCommand()}\r`);
    await waitUntil(() => s.r.locks().length === 1, 'the session lock', 20_000);
    const pid = s.t.chatPid();
    await s.t.waitFor(/Welcome to[\s\S]*> $/, `the greeting and the prompt with no /proc (chat state ${procState(pid)})`, mark, 30_000);
    await answers(s.t, mark);
    await quits(s.t, s.r, pid);
  } finally {
    await s.t.dispose();
  }
});
