/**
 * Review round 5, H1: members of the claude child's process group (an MCP server claude spawned
 * that ignores stdin EOF, a stuck tool command) used to survive claude's own exit: on close()
 * (`/quit`, the REPL's ExitSignals close, ACP shutdown, the end of a headless run), and when
 * claude itself crashed. ClaudeProcess.close() returned once the leader was gone, the leader's
 * exit untracked the group, and nothing killed what was left in it; the members were re-parented
 * to init and ran on.
 *
 * Now, once the leader of a claude child's group has exited (gracefully or not), what is left of
 * the group gets a short bounded wait to leave on its own and is then SIGKILLed, through
 * lifecycle's signalChild, i.e. only while the group is provably still ours (L1). close()
 * resolves after that; a fatal signal or a process exit during the wait SIGKILLs the members at
 * once.
 *
 * The claude stand-in is a shell wrapper that starts a member in the background (in its own
 * process group, which is the claude child's) and then execs the fake.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ClaudeProcess, ClaudeProcessError } from '../../src/claude/process.js';
import { STREAM_ARGS, allowAllHandlers, collectTurn, fakeClaudePath, fakeEnv, mkTmp } from './helpers.js';
import { alive, builtModule, isLinux, pgidOf, readPids, reap, spawnNode, waitDead } from './hang-helpers.js';

const linux = { skip: !isLinux };

type MemberKind =
  /** ignores stdin EOF (reads nothing), SIGTERM, SIGHUP and SIGINT; holds no pipe of ours */
  | 'stuck'
  /** like `stuck`, but keeps claude's stdout pipe open (a tool command that inherited it) */
  | 'pipe'
  /** like `stuck`, but leaves on its own 150 ms after the leader is gone (writes `.cleaned`) */
  | 'polite'
  /** ignores stdin EOF; on SIGTERM cleans up for 100 ms, writes `.cleaned` and exits */
  | 'term';

interface Member {
  dir: string;
  /** The claude wrapper (KIRO_CLAUDE_BIN / ClaudeStartOptions.binary.path). */
  wrapper: string;
  pidFile: string;
  cleaned: string;
}

/** Writes the member program and a claude wrapper that starts it for stream-mode (`-p`) runs. */
function writeMemberClaude(dir: string, kind: MemberKind): Member {
  const member = path.join(dir, `member-r5-${kind}.cjs`);
  const pidFile = path.join(dir, `member-${kind}.pid`);
  const cleaned = `${pidFile}.cleaned`;
  const polite =
    kind === 'polite'
      ? `const leader = Number(process.argv[3]);
const gone = () => { try { process.kill(leader, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
const t = setInterval(() => { if (gone()) { clearInterval(t); setTimeout(() => { fs.writeFileSync(${JSON.stringify(cleaned)}, 'y'); process.exit(0); }, 150); } }, 10);`
      : '';
  const onTerm =
    kind === 'term' ? `() => setTimeout(() => { fs.writeFileSync(${JSON.stringify(cleaned)}, 'y'); process.exit(0); }, 100)` : '() => {}';
  fs.writeFileSync(
    member,
    `const fs = require('fs');
for (const s of ['SIGHUP', 'SIGINT']) process.on(s, () => {});
process.on('SIGTERM', ${onTerm});
fs.writeFileSync(process.argv[2], process.pid + '\\n');
${polite}
setInterval(() => {}, 1000);
`,
  );
  const out = kind === 'pipe' ? '' : ' >/dev/null';
  const wrapper = path.join(dir, 'claude');
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh
case " $* " in *" -p "*) '${process.execPath}' '${member}' '${pidFile}' $$ </dev/null${out} 2>/dev/null & ;; esac
exec '${process.execPath}' '${fakeClaudePath()}' "$@"
`,
  );
  fs.chmodSync(wrapper, 0o755);
  return { dir, wrapper, pidFile, cleaned };
}

async function waitPid(pidFile: string, ms: number): Promise<number> {
  const end = Date.now() + ms;
  for (;;) {
    const [pid] = readPids(pidFile);
    if (pid) return pid;
    if (Date.now() > end) throw new Error(`timed out waiting for ${pidFile}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function startMemberClaude(m: Member, script?: unknown): Promise<ClaudeProcess> {
  return ClaudeProcess.start({
    binary: { path: m.wrapper, version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' },
    args: [...STREAM_ARGS],
    cwd: m.dir,
    env: fakeEnv({ FAKE_CLAUDE_LOG: path.join(m.dir, 'fake.log'), ...(script ? { FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script) } : {}) }),
    initialize: {},
    handlers: allowAllHandlers,
  });
}

describe("ClaudeProcess: members left in the claude child's group once it exited (r5 H1)", () => {
  it('close(): claude exits on stdin EOF, a member that ignores EOF and signals is SIGKILLed before close() resolves (bounded)', linux, async () => {
    const m = writeMemberClaude(mkTmp(), 'stuck');
    const proc = await startMemberClaude(m);
    const pid = await waitPid(m.pidFile, 10_000);
    try {
      assert.equal(pgidOf(pid), proc.pid, "the member is in the claude child's process group");
      const t0 = Date.now();
      const info = await proc.close();
      const ms = Date.now() - t0;
      assert.equal(info.code, 0, 'Claude Code exited gracefully on stdin EOF (no SIGTERM needed)');
      assert.ok(ms < 1_500, `close() waited ${ms} ms (the wait for members must be short and bounded)`);
      assert.ok(await waitDead([pid], 200), `member ${pid} of the claude child's group outlived close()`);
    } finally {
      reap(readPids(m.pidFile));
      fs.rmSync(m.dir, { recursive: true, force: true });
    }
  });

  it('close(): a member that leaves on its own right after claude is given the time to (not SIGKILLed)', linux, async () => {
    const m = writeMemberClaude(mkTmp(), 'polite');
    const proc = await startMemberClaude(m);
    const pid = await waitPid(m.pidFile, 10_000);
    try {
      await proc.close();
      assert.equal(fs.existsSync(m.cleaned), true, 'the member was SIGKILLed before it could leave on its own (or close() did not wait)');
      assert.ok(await waitDead([pid], 200));
    } finally {
      reap(readPids(m.pidFile));
      fs.rmSync(m.dir, { recursive: true, force: true });
    }
  });

  it('close(): a member that ignores stdin EOF but handles SIGTERM is SIGTERMed first and gets to clean up', linux, async () => {
    const m = writeMemberClaude(mkTmp(), 'term');
    const proc = await startMemberClaude(m);
    const pid = await waitPid(m.pidFile, 10_000);
    try {
      const info = await proc.close();
      assert.equal(info.code, 0);
      assert.ok(await waitDead([pid], 200), `member ${pid} outlived close()`);
      assert.equal(fs.existsSync(m.cleaned), true, 'the member was SIGKILLed without a SIGTERM (no cleanup)');
    } finally {
      reap(readPids(m.pidFile));
      fs.rmSync(m.dir, { recursive: true, force: true });
    }
  });

  it("a crash of Claude Code itself: a surviving member of its group is SIGKILLed, with nobody calling close()", linux, async () => {
    const m = writeMemberClaude(mkTmp(), 'stuck');
    const proc = await startMemberClaude(m, { default: { steps: [{ text: 'about to crash' }, { exit: 3, stderr: 'boom' }] } });
    const pid = await waitPid(m.pidFile, 10_000);
    try {
      await assert.rejects(collectTurn(proc.turn('hello')), (e: unknown) => e instanceof ClaudeProcessError && /exit code 3/.test(e.message));
      assert.equal((await proc.exited).code, 3);
      assert.ok(await waitDead([pid], 1_500), `member ${pid} of a crashed Claude Code's group still runs`);
    } finally {
      reap(readPids(m.pidFile));
      fs.rmSync(m.dir, { recursive: true, force: true });
    }
  });

  it("close(): a stuck tool command holding claude's stdout pipe is SIGKILLed too, and close() does not wait for the pipe drain", linux, async () => {
    const m = writeMemberClaude(mkTmp(), 'pipe');
    const proc = await startMemberClaude(m);
    const pid = await waitPid(m.pidFile, 10_000);
    try {
      const t0 = Date.now();
      const info = await proc.close();
      const ms = Date.now() - t0;
      assert.equal(info.code, 0);
      assert.ok(await waitDead([pid], 200), `member ${pid} holding claude's stdout outlived close()`);
      // The drain gives up after EXIT_DRAIN_MS (1 s); the member's death closes the pipe sooner.
      assert.ok(ms < 950, `close() took ${ms} ms: it waited for the drain deadline instead of ending the member`);
    } finally {
      reap(readPids(m.pidFile));
      fs.rmSync(m.dir, { recursive: true, force: true });
    }
  });
});

describe("kiro-claude stand-ins: the members' wait is cut short by a fatal signal or an exit (r5 H1)", () => {
  /**
   * A kiro-claude stand-in with no signal listener of its own: starts a ClaudeProcess on the
   * member wrapper, closes it, and as soon as Claude Code has exited (the members' wait runs)
   * either sends itself `SIGTERM` or calls `process.exit(0)`.
   */
  function writeDriver(m: Member, then: 'SIGTERM' | 'exit'): string {
    const driver = path.join(m.dir, `driver-${then}.mjs`);
    fs.writeFileSync(
      driver,
      `const { ClaudeProcess } = await import(${JSON.stringify(builtModule('claude/process.js'))});
const proc = await ClaudeProcess.start({
  binary: { path: ${JSON.stringify(m.wrapper)}, version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' },
  args: ${JSON.stringify([...STREAM_ARGS])},
  cwd: process.cwd(),
  env: process.env,
  initialize: {},
  handlers: { onHookCallback: async () => ({}), onCanUseTool: async (r) => ({ behavior: 'allow', updatedInput: r.input }) },
});
const fs = await import('node:fs');
while (!fs.existsSync(${JSON.stringify(m.pidFile)})) await new Promise((r) => setTimeout(r, 20));
proc.on('exit', () => {
  process.stdout.write(JSON.stringify({ event: 'claude-exited' }) + '\\n');
  ${then === 'SIGTERM' ? "process.kill(process.pid, 'SIGTERM');" : 'process.exit(0);'}
});
void proc.close();
setInterval(() => {}, 1000);
`,
    );
    return driver;
  }

  it('SIGTERM nobody else handles, while the members wait: they are SIGKILLed and kiro-claude dies of SIGTERM', linux, async () => {
    const m = writeMemberClaude(mkTmp(), 'stuck');
    const run = spawnNode([writeDriver(m, 'SIGTERM')], { cwd: m.dir, env: fakeEnv(), capMs: 20_000 });
    try {
      const pid = await waitPid(m.pidFile, 10_000);
      const res = await run.done;
      assert.equal(res.killedByTest, false);
      assert.match(run.stdout(), /claude-exited/, `stderr=${run.stderr()}`);
      assert.equal(res.signal, 'SIGTERM', `the stand-in dies of the signal (code=${res.code}, stderr=${run.stderr()})`);
      assert.ok(await waitDead([pid], 500), `member ${pid} outlived kiro-claude's SIGTERM death`);
    } finally {
      reap(readPids(m.pidFile));
      fs.rmSync(m.dir, { recursive: true, force: true });
    }
  });

  it('process.exit() while the members wait: the exit sweep SIGKILLs them', linux, async () => {
    const m = writeMemberClaude(mkTmp(), 'stuck');
    const run = spawnNode([writeDriver(m, 'exit')], { cwd: m.dir, env: fakeEnv(), capMs: 20_000 });
    try {
      const pid = await waitPid(m.pidFile, 10_000);
      const res = await run.done;
      assert.equal(res.killedByTest, false);
      assert.match(run.stdout(), /claude-exited/, `stderr=${run.stderr()}`);
      assert.equal(res.code, 0);
      assert.ok(await waitDead([pid], 500), `member ${pid} outlived kiro-claude's exit`);
    } finally {
      reap(readPids(m.pidFile));
      fs.rmSync(m.dir, { recursive: true, force: true });
    }
  });
});

describe('kiro-claude chat: a member of the claude child\'s group does not outlive kiro-claude (r5 H1)', () => {
  /** Temp HOME/KIRO_HOME/CLAUDE_CONFIG_DIR/XDG_* for a real `kiro-claude` run on the member wrapper. */
  function cliEnv(m: Member, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    for (const d of ['home', 'kiro', 'cfg', 'run', 'cache', 'ws']) fs.mkdirSync(path.join(m.dir, d), { recursive: true });
    fs.chmodSync(path.join(m.dir, 'run'), 0o700);
    return {
      PATH: process.env.PATH,
      HOME: path.join(m.dir, 'home'),
      KIRO_HOME: path.join(m.dir, 'kiro'),
      CLAUDE_CONFIG_DIR: path.join(m.dir, 'cfg'),
      XDG_RUNTIME_DIR: path.join(m.dir, 'run'),
      XDG_CACHE_HOME: path.join(m.dir, 'cache'),
      KIRO_CLAUDE_BIN: m.wrapper,
      FAKE_CLAUDE_LOG: path.join(m.dir, 'fake.log'),
      ...extra,
    };
  }

  it('chat --no-interactive: the run ends normally (session closed, Claude Code exits on EOF), the member is gone', linux, async () => {
    const m = writeMemberClaude(mkTmp(), 'stuck');
    const env = cliEnv(m, { FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify({ default: { steps: [{ text: 'reply-r5-h1' }] } }) });
    const run = spawnNode([builtModule('bin/kiro-claude.js'), 'chat', '--no-interactive', '--trust-all-tools', 'hello there'], {
      cwd: path.join(m.dir, 'ws'),
      env,
      capMs: 30_000,
    });
    try {
      const res = await run.done;
      assert.equal(res.killedByTest, false);
      assert.equal(res.code, 0, `stderr=${run.stderr()}`);
      assert.match(run.stdout(), /reply-r5-h1/);
      const [pid] = readPids(m.pidFile);
      assert.ok(pid, 'the member was started');
      assert.ok(await waitDead([pid], 500), `member ${pid} outlived the headless run`);
    } finally {
      reap(readPids(m.pidFile));
      fs.rmSync(m.dir, { recursive: true, force: true });
    }
  });

  it('chat (REPL) /quit: the member is gone once kiro-claude exited', linux, async () => {
    const m = writeMemberClaude(mkTmp(), 'stuck');
    const env = cliEnv(m, { FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify({ default: { steps: [{ text: 'reply-r5-h1' }] } }) });
    const run = spawnNode([builtModule('bin/kiro-claude.js'), 'chat', '--trust-all-tools'], { cwd: path.join(m.dir, 'ws'), env, capMs: 30_000 });
    try {
      run.child.stdin!.write('hello there\n');
      const end = Date.now() + 20_000;
      while (!run.stdout().includes('reply-r5-h1') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      assert.match(run.stdout(), /reply-r5-h1/, `stderr=${run.stderr()}`);
      const pid = await waitPid(m.pidFile, 5_000);
      run.child.stdin!.write('/quit\n');
      const res = await run.done;
      assert.equal(res.killedByTest, false);
      assert.equal(res.code, 0, `stderr=${run.stderr()}`);
      assert.ok(await waitDead([pid], 500), `member ${pid} outlived /quit`);
    } finally {
      reap(readPids(m.pidFile));
      fs.rmSync(m.dir, { recursive: true, force: true });
    }
  });

  for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
    it(`chat (REPL): ${sig} mid-turn (the REPL closes the session, then re-raises): the member is gone once kiro-claude died`, linux, async () => {
      const m = writeMemberClaude(mkTmp(), 'stuck');
      const env = cliEnv(m, { FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify({ default: { steps: [{ text: 'thinking-r5-h1' }, { sleepMs: 30_000 }, { text: 'done' }] } }) });
      const run = spawnNode([builtModule('bin/kiro-claude.js'), 'chat', '--trust-all-tools'], { cwd: path.join(m.dir, 'ws'), env, capMs: 30_000 });
      try {
        run.child.stdin!.write('hello there\n');
        const end = Date.now() + 20_000;
        while (!run.stdout().includes('thinking-r5-h1') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
        assert.match(run.stdout(), /thinking-r5-h1/, `stderr=${run.stderr()}`);
        const pid = await waitPid(m.pidFile, 5_000);
        assert.ok(alive(pid));
        process.kill(run.child.pid!, sig);
        const res = await run.done;
        assert.equal(res.killedByTest, false);
        assert.equal(res.signal, sig, `kiro-claude dies of ${sig} (code=${res.code}, stderr=${run.stderr()})`);
        assert.ok(await waitDead([pid], 500), `member ${pid} outlived kiro-claude's ${sig} death`);
      } finally {
        reap(readPids(m.pidFile));
        fs.rmSync(m.dir, { recursive: true, force: true });
      }
    });
  }
});
