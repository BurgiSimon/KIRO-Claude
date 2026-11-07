/**
 * Round-5 fix "signals", verifier: other entry points to g2 (after a fatal signal the REPL prints
 * nothing of its own during the grace). Two outputs the fix did not cover:
 *  - a `!cmd` started before the signal: its stdout went through Repl.write() (dropped), its
 *    stderr went straight to the REPL's stderr (printed during the grace);
 *  - the `Thinking...` spinner already animating at the signal (after a tool ended, Claude slow
 *    to honour the interrupt): it kept drawing frames for the whole grace and was left on screen
 *    when the signal ended the process.
 * Built CLI over test/fixtures/fake-claude.mjs, temp dirs; the spinner case on a python3 pty.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { cli, mkRoot, sessionEndHook, sleep, waitFile, type Cli } from '../headless/r5f-signals-helpers.js';

const clis: Cli[] = [];
afterEach(() => {
  for (const c of clis.splice(0)) c.dispose();
});

test('r5f verify g2: the stderr of a `!cmd` running at a SIGTERM is not printed during the grace (its stdout is not either)', { timeout: 60_000 }, async () => {
  const r = mkRoot({ turns: [{ repeat: true, steps: [{ text: 'ANSWER-ONE' }] }] });
  try {
    const started = path.join(r.root, 'bang.started');
    // the close's SessionEnd hook keeps the grace open while the command writes
    sessionEndHook(r, 'cat > /dev/null; sleep 1.5');
    const c = cli(r, ['chat']);
    clis.push(c);
    await c.waitFor(/> $/);
    c.line('hello');
    await c.waitFor(/ANSWER-ONE[\s\S]*> $/);
    c.line(`!touch '${started}'; sleep 0.6; echo ERR-LINE >&2; echo OUT-LINE; sleep 5`);
    await waitFile(started, `the command never started\n${c.o()}`);
    await sleep(150);
    const at = c.o().length;
    c.kill('SIGTERM');
    const e = await c.exit;
    const after = c.o().slice(at);
    assert.equal(e.signal, 'SIGTERM', `exit ${JSON.stringify(e)}\n${c.o()}`);
    assert.equal(after, '', `printed after the signal:\n${JSON.stringify(after)}`);
    assert.deepEqual(r.locks(), []);
  } finally {
    r.cleanup();
  }
});

// ───────────────────────────── the spinner (needs a real terminal) ─────────────────────────────

/** Runs a command on a fresh pty (session leader), relays our pipe to it and back. */
const PTY_DRIVER = String.raw`
import os, pty, sys, select
argv = sys.argv[1:]
pid, master = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
inp = sys.stdin.fileno()
inp_open = True
status = None
while status is None:
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
sys.stderr.write('STATUS %s %d\n' % (('signal', os.WTERMSIG(status)) if os.WIFSIGNALED(status) else ('code', os.WEXITSTATUS(status))))
`;

const HAVE_PTY = process.platform === 'linux' && spawnSync('python3', ['-I', '-c', 'import pty'], { stdio: 'ignore' }).status === 0;

test('r5f verify g2: a spinner animating at a SIGTERM stops at the signal (no more frames during the grace)', { skip: HAVE_PTY ? false : 'needs Linux and python3 (pty)', timeout: 60_000 }, async () => {
  // a tool ends (the spinner starts again), then Claude goes quiet and is slow to honour the
  // interrupt the close sends: the turn stays open for the whole grace
  const r = mkRoot({
    turns: [
      { steps: [{ text: 'ANSWER-ONE' }] },
      { steps: [{ tool: { name: 'Read', input: { file_path: '/etc/hostname' } } }, { sleepMs: 100_000 }, { text: 'never' }] },
    ],
  });
  const driver = path.join(r.root, 'pty.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const env = r.env({ TERM: 'xterm', FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }) });
  const py = spawn('python3', ['-I', driver, process.execPath, builtBin(), 'chat', '--trust-all-tools'], { cwd: r.ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let perr = '';
  py.stdout.on('data', (d: Buffer) => (out += d.toString()));
  py.stderr.on('data', (d: Buffer) => (perr += d.toString()));
  const exited = new Promise((res) => py.on('exit', res));
  const screen = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const waitFor = async (fn: () => boolean, what: string): Promise<void> => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > 20_000) throw new Error(`timeout: ${what}\n--- screen:\n${screen()}\n--- driver:\n${perr}`);
      await sleep(25);
    }
  };
  let pid: number | undefined;
  try {
    await waitFor(() => /> $/.test(screen()), 'chat prompt');
    py.stdin.write('hello\r');
    await waitFor(() => /ANSWER-ONE[\s\S]*> $/.test(screen()), 'first answer');
    pid = (JSON.parse(fs.readFileSync(path.join(r.sessions, r.locks()[0]!), 'utf8')) as { pid: number }).pid;
    py.stdin.write('read it\r');
    // the spinner animates again after the tool's end
    await waitFor(() => /Completed in[\s\S]*(Thinking\.\.\.[\s\S]*){3}$/.test(screen()), 'spinner after the tool');
    const at = out.length;
    process.kill(pid, 'SIGTERM');
    await exited;
    assert.match(perr, /STATUS signal 15/, perr);
    const after = out.slice(at);
    assert.doesNotMatch(after, /Thinking/, `the spinner drew after the signal:\n${JSON.stringify(after.slice(0, 400))}`);
  } finally {
    py.kill('SIGKILL');
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL'); // only the kiro-claude this test started, should it hang
      } catch {
        // gone
      }
    }
    r.cleanup();
  }
});
