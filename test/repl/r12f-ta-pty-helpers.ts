/**
 * Shared helpers of the round-12 "terminal-a" pty tests (r12f-ta-approval-pty.test.ts,
 * r12f-ta-owncont-pty.test.ts): on top of r11f-ta-pty-helpers.ts (an interactive bash in a python3
 * pty, the built CLI over test/fixtures/fake-claude.mjs, temp dirs only), a chat whose Claude Code
 * can be held at a known point of a tool call, a pty whose session leader is the chat itself (no
 * shell: `ssh -t host kiro-claude chat`), and a deterministic event-loop stall of the chat (a
 * temporary cgroup-v1 freezer this module creates and removes; the chat stops nowhere, gets no
 * SIGCONT, and Claude Code runs on).
 *
 * Holding Claude Code: the chat runs agent `stopper`, whose preToolUse hook command stops the fake
 * claude (`kill -STOP` of the pid the test wrote to `fake.pid`, once) before the chat answers the
 * hook_callback. The answer then waits in the fake's stdin, and its can_use_tool is sent only once
 * the test continues it: after the keys the test types, while the chat cannot read them.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin } from '../cli/helpers.js';
import { mkRoot, type Root } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';
import { procState, sleep, waitUntil } from './r11f-ta-pty-helpers.js';

/**
 * `go…`: a Bash call Claude Code asks permission for, then `DONE <its result>` (`race…`: the same
 * 1.5 s later); `slow…`: an answer 2.5 s later; anything else is answered at once.
 */
export const APPROVAL_SCRIPT = {
  turns: [
    {
      repeat: true,
      match: '^go',
      steps: [{ sleepMs: 300 }, { tool: { name: 'Bash', input: { command: 'echo X' }, result: 'TOOL-RAN', permission: 'ask' } }, { text: 'DONE <{{lastToolResult}}>' }],
    },
    {
      repeat: true,
      match: '^race',
      steps: [{ sleepMs: 1500 }, { tool: { name: 'Bash', input: { command: 'echo X' }, result: 'TOOL-RAN', permission: 'ask' } }, { text: 'DONE <{{lastToolResult}}>' }],
    },
    { repeat: true, match: '^slow', steps: [{ sleepMs: 2500 }, { text: 'SLOW-DONE' }] },
  ],
  default: { steps: [{ text: 'ANSWER to {{userText}}' }] },
};

/**
 * The approval question, waiting at its own prompt (`[stopper] > `) with nothing typed (the prompt
 * drawn again in place after a stop: ESC[1G, removed with the other CSI sequences here).
 */
export const APPROVAL_WAITING = /Allow this action\?[^\n]*\[y\/n\/t\]:\s*(?:(?:\[stopper\] )?> )+$/;

export interface Held {
  r: Root;
  /** `--agent stopper` and the fake's log: append to the chat command line. */
  args: string;
  /** Environment for the chat command (the fake's log of what it sends and gets). */
  prefix: string;
  /** Hold Claude Code at the next tool call: the fake (a child of `chatPid`) is stopped by the hook. */
  armHold(chatPid: number): number;
  /** The hook has stopped the fake and exited (the chat answers the hook_callback right after). */
  held(fakePid: number): Promise<void>;
  /** Frames the fake sent (`control_request` subtypes) and got (`control_response` behaviors), and its turns. */
  sent(subtype: string): number;
  behaviors(): string[];
  messages(): string[];
  turns(): string[];
}

interface LogEntry {
  event?: string;
  frame?: { type?: string; request?: { subtype?: string } };
  line?: { type?: string; response?: { response?: { behavior?: string; message?: string } } };
  userText?: string;
}

/** Agent `stopper` in root `r`, which holds Claude Code at a tool call ({@link Held}). */
export function holdIn(r: Root): Held {
  const fakeLog = path.join(r.root, 'fake.log');
  const pidFile = path.join(r.root, 'fake.pid');
  const hookLog = path.join(r.root, 'hook.log');
  const agents = path.join(r.home, '.kiro', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  const cmd = `f='${pidFile}'; if [ -s "$f" ]; then kill -STOP "$(cat "$f")"; rm -f "$f"; echo held >> '${hookLog}'; fi; exit 0`;
  fs.writeFileSync(
    path.join(agents, 'stopper.json'),
    JSON.stringify({ name: 'stopper', description: 'holds Claude Code at a tool call', tools: ['*'], hooks: { preToolUse: [{ matcher: '*', command: cmd, timeout_ms: 30_000 }] } }),
  );
  const entries = (): LogEntry[] => {
    if (!fs.existsSync(fakeLog)) return [];
    const out: LogEntry[] = [];
    for (const l of fs.readFileSync(fakeLog, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l) as LogEntry);
      } catch {
        // a line being written
      }
    }
    return out;
  };
  const answers = (): { behavior?: string; message?: string }[] =>
    entries()
      .filter((e) => e.event === 'stdin' && e.line?.type === 'control_response' && e.line.response?.response?.behavior !== undefined)
      .map((e) => e.line!.response!.response!);
  return {
    r,
    args: ' --agent stopper',
    prefix: `TMPDIR='${r.root}' FAKE_CLAUDE_LOG='${fakeLog}' FAKE_CLAUDE_LOG_STDOUT=1 `,
    armHold(chatPid) {
      const pid = fakeOf(chatPid);
      fs.writeFileSync(pidFile, String(pid));
      return pid;
    },
    async held(fakePid) {
      await waitUntil(() => fs.existsSync(hookLog) && procState(fakePid) === 'T', 'the hook holds Claude Code', 20_000);
      // the hook command has exited; the chat answers the hook_callback (into the stopped fake's stdin)
      await sleep(400);
      assert.equal(this.sent('can_use_tool'), 0, 'Claude Code asked before it was held');
    },
    sent: (subtype) => entries().filter((e) => e.event === 'stdout' && e.frame?.type === 'control_request' && e.frame.request?.subtype === subtype).length,
    behaviors: () => answers().map((a) => a.behavior!),
    messages: () => answers().map((a) => a.message ?? ''),
    turns: () => entries().filter((e) => e.event === 'turn').map((e) => e.userText ?? ''),
  };
}

/** A temp root (removed on exit) with {@link holdIn}. */
export function heldRoot(script: unknown = APPROVAL_SCRIPT): Held {
  const r = mkRoot(script);
  removeOnExit(r.root);
  return holdIn(r);
}

/** The fake claude among the children of `chatPid`. */
export function fakeOf(chatPid: number): number {
  const kids: number[] = [];
  for (const tid of fs.readdirSync(`/proc/${chatPid}/task`)) {
    for (const k of fs.readFileSync(`/proc/${chatPid}/task/${tid}/children`, 'utf8').split(/\s+/)) if (k) kids.push(Number(k));
  }
  const fakes = kids.filter((k) => {
    try {
      return fs.readFileSync(`/proc/${k}/cmdline`, 'utf8').includes('fake-claude');
    } catch {
      return false;
    }
  });
  assert.equal(fakes.length, 1, `the chat's children: ${kids.join(' ')}`);
  return fakes[0]!;
}

// ───────────────────────────── a deterministic stall: a cgroup-v1 freezer ─────────────────────────────

const FREEZER = '/sys/fs/cgroup/freezer';

/** Whether a temporary cgroup-v1 freezer can be made here (root, v1 freezer mounted). */
export function canFreeze(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    fs.accessSync(FREEZER, fs.constants.W_OK);
    return fs.existsSync(path.join(FREEZER, 'cgroup.procs'));
  } catch {
    return false;
  }
}

/** Freeze `pid` alone (its event loop stalls: no stop, no SIGCONT); `thaw()` ends it and removes the cgroup. */
export async function freeze(pid: number): Promise<{ thaw(): void }> {
  const cg = path.join(FREEZER, `kc-r12f-ta-${process.pid}-${pid}`);
  fs.mkdirSync(cg);
  let thawed = false;
  const thaw = (): void => {
    if (thawed) return;
    thawed = true;
    try {
      fs.writeFileSync(path.join(cg, 'freezer.state'), 'THAWED');
    } catch {
      // gone
    }
    try {
      for (const p of fs.readFileSync(path.join(cg, 'cgroup.procs'), 'utf8').split(/\s+/)) if (p) fs.writeFileSync(path.join(FREEZER, 'cgroup.procs'), p);
    } catch {
      // gone
    }
    try {
      fs.rmdirSync(cg);
    } catch {
      // left: removed by the exit hook below
    }
  };
  process.once('exit', thaw);
  fs.writeFileSync(path.join(cg, 'cgroup.procs'), String(pid));
  fs.writeFileSync(path.join(cg, 'freezer.state'), 'FROZEN');
  await waitUntil(() => fs.readFileSync(path.join(cg, 'freezer.state'), 'utf8').trim() === 'FROZEN', 'frozen', 5000);
  return { thaw };
}

// ───────────────────────────── no shell: the chat leads the pty's session ─────────────────────────────

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

export interface Leader {
  pid: number;
  write(s: string): void;
  screen(): string;
  waitFor(re: RegExp, what: string, from?: number, ms?: number): Promise<void>;
  dispose(): Promise<void>;
}

/** The chat as the session leader of a pty (no shell that could take the terminal), at its prompt. */
export async function leaderChat(h: Held, env: Record<string, string> = {}): Promise<Leader> {
  const { r } = h;
  const driver = path.join(r.root, 'leader.py');
  fs.writeFileSync(driver, LEADER_DRIVER);
  const fakeLog = /FAKE_CLAUDE_LOG='([^']+)'/.exec(h.prefix)![1]!;
  const py: ChildProcess = spawn('python3', ['-I', driver, process.execPath, builtBin(), 'chat', ...h.args.trim().split(' ')], {
    cwd: r.ws,
    env: r.env({ TERM: 'xterm', FAKE_CLAUDE_LOG: fakeLog, FAKE_CLAUDE_LOG_STDOUT: '1', TMPDIR: r.root, ...env }),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let out = '';
  py.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  py.stdin!.on('error', () => undefined);
  const screen = (): string => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  let pid = 0;
  const l: Leader = {
    get pid() {
      return pid;
    },
    write: (s) => {
      py.stdin!.write(s);
    },
    screen,
    async waitFor(re, what, from = 0, ms = 20_000) {
      const t0 = Date.now();
      while (!re.test(screen().slice(from))) {
        if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}\n--- screen:\n${JSON.stringify(screen().slice(from).slice(-2000))}`);
        await sleep(10);
      }
    },
    async dispose() {
      py.kill('SIGTERM');
      await sleep(300);
      // only the chat this test started
      if (pid && procState(pid) !== 'gone') {
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
  try {
    await waitUntil(() => /CHILD (\d+)/.test(out), 'the chat starts', 15_000);
    pid = Number(/CHILD (\d+)/.exec(out)![1]);
    await l.waitFor(/Welcome to[\s\S]*> $/, 'the chat prompt', 0, 30_000);
  } catch (e) {
    await l.dispose();
    throw e;
  }
  return l;
}
