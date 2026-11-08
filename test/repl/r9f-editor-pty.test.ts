/**
 * Round-9 fix "editor" (#2): a child the chat hands the terminal to (`$EDITOR` for /editor and for
 * the spec checkpoint's "Open in $EDITOR", and `!cmd`) gets it whenever the chat reads the
 * keyboard, whatever the chat's stdout is. `kiro-claude chat | cat` (or `| tee session.log`) runs
 * the chat in terminal mode (raw keys: only stdin decides), but Repl.childIo handed the terminal
 * over only when stdout was a TTY too. Then the child got stdin /dev/null (vim: "Input is not from
 * a terminal", and it hung), the reader was not suspended and took the keys typed for the child
 * as type-ahead, the spec flow's edit was lost (r8g routed it through ReplContext.openEditor; it
 * had used spawnSync with inherited stdio), and an interactive `!cmd` (`!read x`) read nothing.
 *
 * DECISION, as Q (its editor and `!cmd` run with `Command::status()`, every stream inherited) and
 * de073bb's spawnSync: such a child gets the terminal on stdin (the reader suspended meanwhile) and
 * writes to the process's own stdout and stderr, a pipe included: the screen of `| cat` or
 * `| tee` shows it, in order with what the chat writes before and after it.
 *
 * In a real terminal (a python3 pty; the chat, or `sh -c 'exec node … chat | cat'`, as the pty's
 * session leader) over test/fixtures/fake-claude.mjs, temp dirs only; and headless (piped input),
 * which is unchanged: the child's stdin is closed, so it never eats the chat's next input line.
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
sys.stderr.write('STATUS %s\n' % status)
sys.stderr.flush()
`;

const SH = spawnSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).stdout?.trim() ?? '';
const HAVE_PTY =
  process.platform === 'linux' && spawnSync('python3', ['-I', '-c', 'import pty, termios, fcntl'], { stdio: 'ignore' }).status === 0;
const skip = !HAVE_PTY ? 'needs Linux and python3 (pty)' : SH ? false : 'needs sh';
const linux = process.platform === 'linux' ? false : 'Linux';

const SCRIPT = { turns: [{ repeat: true, steps: [{ text: 'ANSWER to {{userText}}' }] }] };

/**
 * An editor that says whether its stdin and stdout are terminals, then reads one line from its
 * stdin (what the user types into it) and appends all of it to the file it was given.
 */
const EDITOR_SH = `#!/bin/sh
if [ -t 0 ]; then i=yes; else i=no; fi
if [ -t 1 ]; then o=yes; else o=no; fi
printf 'EDITOR-READY\\n'
IFS= read -r line
printf 'stdin-tty=%s stdout-tty=%s line=%s\\n' "$i" "$o" "$line" >> "$1"
`;

/**
 * A `!cmd` that says where its stdin and stdout go, then reads a line (as `!read x` would). The
 * markers are built by printf, so the echo of the command line itself never matches them.
 */
const BANG =
  "!if [ -t 0 ]; then i=tty; else i=none; fi; if [ -t 1 ]; then o=tty; else o=pipe; fi; printf 'IN-%s OUT-%s\\n' \"$i\" \"$o\"; IFS= read -r x || printf 'EOF-%s ' STDIN; printf 'GOT-%s.\\n' \"$x\"";
const BANG_SAID = /IN-(\w+) OUT-(\w+)/;
const BANG_GOT = /(EOF-STDIN )?GOT-(\w*)\./;

const REQUIREMENTS =
  '# Requirements Document\n\n## Introduction\n\nx\n\n## Requirements\n\n### Requirement 1: A\n\n**User Story:** As a user, I want a, so that b.\n\n#### Acceptance Criteria\n\n1. THE System SHALL a\n';

function editorRoot(): { r: Root; editor: string } {
  const r = mkRoot(SCRIPT);
  removeOnExit(r.root);
  const editor = path.join(r.root, 'ed.sh');
  fs.writeFileSync(editor, EDITOR_SH, { mode: 0o755 });
  return { r, editor };
}

interface Term {
  write(s: string): void;
  /** The screen so far, CSI sequences removed. */
  screen(): string;
  /** Everything written to the terminal so far. */
  raw(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  dispose(): Promise<void>;
}

/** The chat as the pty's session leader: `piped` runs it as `sh -c 'exec node … chat | cat'`. */
function openChat(r: Root, piped: boolean, extraEnv: Record<string, string>): Term {
  const driver = path.join(r.root, 'pty.py');
  fs.writeFileSync(driver, PTY_DRIVER);
  const env = r.env({ TERM: 'xterm', ...extraEnv });
  const chat = `'${process.execPath}' '${builtBin()}' chat`;
  const argv = piped ? [SH, '-c', `exec ${chat} | cat`] : [process.execPath, builtBin(), 'chat'];
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
  const chatPid = (): number | undefined => {
    const lock = r.locks()[0];
    if (!lock) return undefined;
    try {
      return (JSON.parse(fs.readFileSync(path.join(r.sessions, lock), 'utf8')) as { pid: number }).pid;
    } catch {
      return undefined;
    }
  };
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
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n--- screen:\n${JSON.stringify(screen().slice(from).slice(-2000))}\n--- driver:\n${perr}`);
        await sleep(10);
      }
      pid ??= chatPid();
    },
    async dispose() {
      pid ??= chatPid();
      if (!done) {
        py.kill('SIGTERM');
        await Promise.race([exited, sleep(5000)]);
        if (!done) py.kill('SIGKILL');
      }
      // only the kiro-claude this test started, should it outlive its terminal
      if (pid !== undefined && ours(pid)) {
        try {
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

const lastBracketedPaste = (s: string): string | undefined => [...s.matchAll(/\u001b\[\?2004([hl])/g)].pop()?.[1];

/**
 * What reached the terminal since `rawMark` keeps its order through a piped stdout too: the
 * reader turned bracketed paste off before the child's first output `marker` (r9 #8: the reader's
 * switches go to its own output, the chat's stdout, where the child's output goes as well) and
 * on again only after it.
 */
function handedOverInOrder(t: Term, rawMark: number, marker: RegExp): void {
  const seg = t.raw().slice(rawMark);
  const at = seg.search(marker);
  assert.ok(at >= 0, `no ${marker}`);
  assert.equal(lastBracketedPaste(seg.slice(0, at)), 'l', 'bracketed paste was not off when the child started');
}

/** The chat reads again, and nothing typed for the child was kept as the chat's type-ahead. */
async function chatReadsAgain(t: Term): Promise<void> {
  await sleep(300);
  assert.equal(lastBracketedPaste(t.raw()), 'h', 'bracketed paste is off at the chat prompt after the child');
  const mark = t.screen().length;
  t.write('next\r');
  await t.waitFor(/ANSWER to next\r?\n[\s\S]*> $/, 'the chat answers the next input', mark, 15_000);
  assert.doesNotMatch(t.screen().slice(mark), /ANSWER to (?!next)/, 'keys typed into the child were replayed into the chat');
}

async function editorSession(piped: boolean): Promise<string> {
  const { r, editor } = editorRoot();
  const t = openChat(r, piped, { EDITOR: editor });
  try {
    await t.waitFor(/> $/, 'chat prompt');
    const mark = t.screen().length;
    const rawMark = t.raw().length;
    t.write('/editor\r');
    await t.waitFor(/EDITOR-READY/, 'the editor runs', mark);
    handedOverInOrder(t, rawMark, /EDITOR-READY/);
    t.write('typed into the editor\r');
    await t.waitFor(/ANSWER to stdin-tty[^\n]*\r?\n[\s\S]*> $/, "the editor's text is submitted", mark, 15_000);
    const answer = /ANSWER to (stdin-tty[^\r\n]*)/.exec(t.screen().slice(mark))![1]!;
    await chatReadsAgain(t);
    return answer;
  } finally {
    await t.dispose();
  }
}

test('r9f #2: /editor in `kiro-claude chat | cat`: the editor gets the terminal on stdin (the reader hands it over), writes to the inherited pipe, and its keys are its own', { skip, timeout: 90_000 }, async () => {
  assert.equal(await editorSession(true), 'stdin-tty=yes stdout-tty=no line=typed into the editor');
});

test('r9f #2 control: /editor on a plain terminal: stdin and stdout are the terminal', { skip, timeout: 90_000 }, async () => {
  assert.equal(await editorSession(false), 'stdin-tty=yes stdout-tty=yes line=typed into the editor');
});

async function specEditorSession(piped: boolean): Promise<string> {
  const { r, editor } = editorRoot();
  const dir = path.join(r.ws, '.kiro', 'specs', 'feat');
  fs.mkdirSync(dir, { recursive: true });
  const req = path.join(dir, 'requirements.md');
  fs.writeFileSync(req, REQUIREMENTS);
  const t = openChat(r, piped, { EDITOR: editor });
  try {
    await t.waitFor(/> $/, 'chat prompt');
    let mark = t.screen().length;
    t.write('/spec feat\r');
    await t.waitFor(/Stop here[^\n]*\r?\n[\s\S]*> $/, 'the requirements checkpoint', mark, 30_000);
    const pick = /(\d+)\. Open in \$EDITOR/.exec(t.screen().slice(mark));
    assert.ok(pick, `no "Open in $EDITOR" option:\n${t.screen().slice(mark)}`);
    mark = t.screen().length;
    const rawMark = t.raw().length;
    t.write(`${pick[1]}\r`);
    await t.waitFor(/EDITOR-READY/, 'the editor runs', mark);
    handedOverInOrder(t, rawMark, /EDITOR-READY/);
    t.write('spec edit\r');
    // the checkpoint menu comes back after the editor
    await t.waitFor(/EDITOR-READY[\s\S]*Open in \$EDITOR[\s\S]*Stop here[^\n]*\r?\n[\s\S]*> $/, 'the checkpoint menu again', mark, 15_000);
    const stop = /(\d+)\. Stop here/.exec(t.screen().slice(mark));
    assert.ok(stop);
    const edited = fs.readFileSync(req, 'utf8');
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.swp')));
    mark = t.screen().length;
    t.write(`${stop[1]}\r`);
    await t.waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, 'the spec flow stops', mark, 15_000);
    await chatReadsAgain(t);
    return edited.slice(REQUIREMENTS.length);
  } finally {
    await t.dispose();
  }
}

test('r9f #2: the spec checkpoint\'s "Open in $EDITOR" in `kiro-claude chat | cat`: the editor gets the terminal, the file is edited, the menu comes back', { skip, timeout: 120_000 }, async () => {
  assert.equal(await specEditorSession(true), 'stdin-tty=yes stdout-tty=no line=spec edit\n');
});

test('r9f #2 control: the spec checkpoint\'s "Open in $EDITOR" on a plain terminal', { skip, timeout: 120_000 }, async () => {
  assert.equal(await specEditorSession(false), 'stdin-tty=yes stdout-tty=yes line=spec edit\n');
});

async function bangSession(piped: boolean): Promise<string> {
  const { r } = editorRoot();
  const t = openChat(r, piped, {});
  try {
    await t.waitFor(/> $/, 'chat prompt');
    const mark = t.screen().length;
    const rawMark = t.raw().length;
    t.write(`${BANG}\r`);
    await t.waitFor(BANG_SAID, 'the !cmd runs', mark);
    handedOverInOrder(t, rawMark, BANG_SAID);
    t.write('abc\r');
    await t.waitFor(new RegExp(`${BANG_GOT.source}[^\\n]*\\r?\\n[\\s\\S]*> $`), 'the !cmd ends', mark, 15_000);
    const s = t.screen().slice(mark);
    const got = `${BANG_SAID.exec(s)![0]} ${BANG_GOT.exec(s)![0]}`;
    await chatReadsAgain(t);
    return got;
  } finally {
    await t.dispose();
  }
}

test('r9f #2: an interactive `!cmd` in `kiro-claude chat | cat` reads the terminal (as in Q), its output goes to the inherited pipe, the reader takes none of its keys', { skip, timeout: 90_000 }, async () => {
  assert.equal(await bangSession(true), 'IN-tty OUT-pipe GOT-abc.');
});

test('r9f #2 control: an interactive `!cmd` on a plain terminal', { skip, timeout: 90_000 }, async () => {
  assert.equal(await bangSession(false), 'IN-tty OUT-tty GOT-abc.');
});

test('r9f #2 headless (piped input) unchanged: a `!cmd` and the editor get no stdin (the next input line stays the chat\'s), their output goes through the chat', { skip: linux, timeout: 60_000 }, async () => {
  const { r, editor } = editorRoot();
  const c = cli(r, ['chat'], { env: { EDITOR: editor } });
  try {
    c.line(BANG);
    c.line('/editor');
    c.line('next');
    c.line('/quit');
    const exit = await Promise.race([c.exit, sleep(30_000).then(() => undefined)]);
    assert.ok(exit, `the chat did not end:\n${c.o()}`);
    const o = c.o();
    assert.equal(`${BANG_SAID.exec(o)?.[0]} ${BANG_GOT.exec(o)?.[0]}`, 'IN-none OUT-pipe EOF-STDIN GOT-.', o);
    assert.match(o, /EDITOR-READY\n/, o);
    assert.match(o, /ANSWER to stdin-tty=no stdout-tty=no line=\n/, o);
    assert.match(o, /ANSWER to next\n/, o);
  } finally {
    c.dispose();
    r.cleanup();
  }
});
