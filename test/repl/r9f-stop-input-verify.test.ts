/**
 * Round-9 verification of the "stop-input" fix (findings #0/#1): `terminalInForeground`, the
 * foreground test the terminal reader (repl/input.ts) and the REPL's hand-back after a child
 * (repl/core.ts) ask before they change the terminal's mode after a stop.
 *
 * It compared the input's device with the controlling terminal's (`tty_nr` of /proc/self/stat)
 * and took any other terminal for one no job control applies to, so it answered "foreground"
 * for an input opened on `/dev/tty` (`kiro-claude chat < /dev/tty`, as editors' and git hooks'
 * wrappers run it): that is the controlling terminal under another device number (5:0). In the
 * background the retake then set raw mode and SIGTTOU stopped the chat again: after Ctrl+Z and
 * `bg` it was 'Stopped (tty output)', and `kill %1` (SIGTERM, then SIGCONT) never closed it, the
 * restarted tcsetattr stopping it again before the SIGTERM listener ran (r9 #1 by another way in).
 *
 * Here a python3 pty makes a real controlling terminal; a child in a process group of its own is
 * a background job of it. Linux only (/proc), skipped without python3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { removeOnExit } from '../tmpdirs.js';

const HAVE_PTY =
  process.platform === 'linux' && spawnSync('python3', ['-I', '-c', 'import pty, termios, fcntl'], { stdio: 'ignore' }).status === 0;
const skip = HAVE_PTY ? false : 'needs Linux and python3 (pty)';

const INPUT_JS = new URL('../../src/repl/input.js', import.meta.url).href;

/**
 * argv: fg|bg, command…: runs the command on a fresh pty, as the session leader's child, in the
 * leader's (foreground) process group (`fg`) or in a process group of its own (`bg`), and waits.
 */
const PTY_DRIVER = String.raw`
import os, pty, sys, select
mode = sys.argv[1]
cmd = sys.argv[2:]
pid, master = pty.fork()
if pid == 0:
    g = os.fork()
    if g == 0:
        if mode == 'bg':
            os.setpgid(0, 0)
        os.execvp(cmd[0], cmd)
    _, st = os.waitpid(g, 0)
    os._exit(0)
while True:
    try:
        r, _, _ = select.select([master], [], [], 0.05)
    except InterruptedError:
        continue
    if master in r:
        try:
            d = os.read(master, 65536)
        except OSError:
            d = b''
        if not d:
            break
    w, _ = os.waitpid(pid, os.WNOHANG)
    if w == pid:
        break
`;

function probe(mode: 'fg' | 'bg'): { devTty: boolean; stdin: boolean; pgrpIsTpgid: boolean } {
  const dir = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r9f-fg-'))));
  const driver = path.join(dir, 'pty.py');
  const script = path.join(dir, 'probe.mjs');
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(driver, PTY_DRIVER);
  fs.writeFileSync(
    script,
    `import * as fs from 'node:fs';
const { terminalInForeground } = await import(${JSON.stringify(INPUT_JS)});
const tty = fs.openSync('/dev/tty', 'r+');
const s = fs.readFileSync('/proc/self/stat', 'utf8');
const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ devTty: terminalInForeground({ fd: tty }), stdin: terminalInForeground({ fd: 0 }), pgrpIsTpgid: f[2] === f[5] }));
`,
  );
  const r = spawnSync('python3', ['-I', driver, mode, process.execPath, script], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  assert.ok(fs.existsSync(out), `the probe wrote nothing (status ${String(r.status)}, stderr ${JSON.stringify(r.stderr)})`);
  return JSON.parse(fs.readFileSync(out, 'utf8')) as { devTty: boolean; stdin: boolean; pgrpIsTpgid: boolean };
}

test('r9f-v: terminalInForeground: an input opened on /dev/tty (the controlling terminal) of a background job is not in the foreground', { skip }, () => {
  const bg = probe('bg');
  assert.equal(bg.pgrpIsTpgid, false, 'precondition: the probe runs as a background job of its terminal');
  assert.equal(bg.stdin, false, 'control: the terminal itself (stdin)');
  assert.equal(bg.devTty, false, '/dev/tty was taken for a terminal no job control applies to: a mode change there from the background stops kiro-claude (SIGTTOU)');
});

test('r9f-v: terminalInForeground: in the foreground both the terminal and /dev/tty are', { skip }, () => {
  const fg = probe('fg');
  assert.equal(fg.pgrpIsTpgid, true, 'precondition: the probe runs in the foreground process group');
  assert.deepEqual([fg.stdin, fg.devTty], [true, true]);
});
