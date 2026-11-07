/**
 * Child lifecycle of every `claude` spawn (src/claude/lifecycle.ts):
 *  - hang-proof probes: runCaptured kills the whole process group on timeout (SIGTERM, then
 *    SIGKILL after a short grace), resolves promptly even when a grandchild holds the pipes, and
 *    leaves nothing that keeps the event loop alive;
 *  - terminal signals: the ClaudeProcess child runs in its own process group (POSIX), so a SIGINT
 *    sent to kiro-claude's process group (terminal Ctrl+C) does not reach it, and it is cleaned up
 *    when kiro-claude exits or gets SIGTERM/SIGHUP.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { runCaptured } from '../../src/claude/binary.js';
import { KILL_GRACE_MS, PROCESS_GROUPS } from '../../src/claude/lifecycle.js';
import { fakeClaudePath, fakeEnv, mkTmp, startFake } from './helpers.js';
import { alive, builtModule, isLinux, isWin, pgidOf, readPids, reap, spawnNode, waitDead, waitForLine, writeHangFake } from './hang-helpers.js';

describe('runCaptured: hang-proof', () => {
  it('kills a hanging child and its pipe-holding grandchild on timeout, promptly', { skip: isWin }, async () => {
    const dir = mkTmp();
    const { bin, pidFile } = writeHangFake(dir, { mode: 'all', grandchild: true });
    const t0 = Date.now();
    const r = await Promise.race([
      runCaptured(bin, ['--version'], { timeoutMs: 300 }),
      new Promise<'hung'>((res) => setTimeout(() => res('hung'), 8_000).unref()),
    ]);
    const pids = readPids(pidFile);
    try {
      assert.notEqual(r, 'hung', 'runCaptured must resolve although a grandchild holds stdout/stderr');
      if (r === 'hung') return;
      assert.equal(r.timedOut, true);
      assert.ok(Date.now() - t0 < 300 + KILL_GRACE_MS + 1_500, `took ${Date.now() - t0} ms`);
      assert.equal(pids.length, 2);
      assert.ok(await waitDead(pids, 2_000), 'child and grandchild are killed (process group)');
    } finally {
      reap(pids);
    }
  });

  it('SIGTERM first, SIGKILL after the grace when SIGTERM is ignored', { skip: isWin }, async () => {
    const dir = mkTmp();
    const { bin, pidFile } = writeHangFake(dir, { mode: 'all', grandchild: true, ignoreTerm: true });
    const t0 = Date.now();
    const r = await Promise.race([
      runCaptured(bin, ['auth', 'status'], { timeoutMs: 200 }),
      new Promise<'hung'>((res) => setTimeout(() => res('hung'), 8_000).unref()),
    ]);
    const pids = readPids(pidFile);
    try {
      assert.notEqual(r, 'hung');
      if (r === 'hung') return;
      const ms = Date.now() - t0;
      assert.equal(r.timedOut, true);
      assert.ok(ms >= 200 + KILL_GRACE_MS - 50, `SIGKILL only after the grace (${ms} ms)`);
      assert.ok(ms < 200 + KILL_GRACE_MS + 1_500, `took ${ms} ms`);
      assert.ok(await waitDead(pids, 2_000), 'SIGTERM-ignoring child and grandchild are SIGKILLed');
    } finally {
      reap(pids);
    }
  });

  it('a normal exit whose grandchild keeps the pipes open still resolves', { skip: isWin }, async () => {
    const dir = mkTmp();
    const bin = path.join(dir, 'leaky.mjs');
    const pidFile = path.join(dir, 'pids');
    fs.writeFileSync(
      bin,
      `import { spawn } from 'node:child_process';
import fs from 'node:fs';
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync(${JSON.stringify(pidFile)}, g.pid + '\\n');
process.stdout.write('2.1.318 (Claude Code)\\n', () => process.exit(0));
`,
    );
    const r = await Promise.race([
      runCaptured(bin, ['--version'], { timeoutMs: 10_000 }),
      new Promise<'hung'>((res) => setTimeout(() => res('hung'), 6_000).unref()),
    ]);
    const pids = readPids(pidFile);
    try {
      assert.notEqual(r, 'hung', 'resolves after a short drain instead of waiting for the grandchild');
      if (r === 'hung') return;
      assert.equal(r.code, 0);
      assert.equal(r.timedOut, false);
      assert.match(r.stdout, /2\.1\.318/);
    } finally {
      reap(pids);
    }
  });

  it('no timer or child keeps the event loop alive after a timed-out probe (process level)', { skip: isWin }, async () => {
    const dir = mkTmp();
    const { bin, pidFile } = writeHangFake(dir, { mode: 'all', grandchild: true, ignoreTerm: true });
    const driver = path.join(dir, 'driver.mjs');
    fs.writeFileSync(
      driver,
      `const { runCaptured } = await import(${JSON.stringify(builtModule('claude/binary.js'))});
const r = await runCaptured(${JSON.stringify(bin)}, ['--version'], { timeoutMs: 200 });
process.stdout.write(JSON.stringify({ timedOut: r.timedOut }) + '\\n');
// no process.exit(): the process must end on its own
`,
    );
    const run = spawnNode([driver], { capMs: 10_000 });
    const res = await run.done;
    const pids = readPids(pidFile);
    try {
      assert.equal(res.killedByTest, false, `driver must exit on its own (stdout=${run.stdout()} stderr=${run.stderr()})`);
      assert.equal(res.code, 0);
      assert.match(run.stdout(), /"timedOut":true/);
      assert.ok(res.ms < 200 + KILL_GRACE_MS + 3_000, `took ${res.ms} ms`);
      assert.ok(await waitDead(pids, 2_000));
    } finally {
      reap(pids);
    }
  });

  it('runs probes in their own process group (POSIX)', { skip: !isLinux }, async () => {
    const dir = mkTmp();
    const bin = path.join(dir, 'pg.mjs');
    fs.writeFileSync(bin, `import fs from 'node:fs';
const st = fs.readFileSync('/proc/self/stat', 'utf8');
const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
process.stdout.write(JSON.stringify({ pid: process.pid, pgrp: Number(f[2]) }) + '\\n');
`);
    const r = await runCaptured(bin, []);
    const o = JSON.parse(r.stdout) as { pid: number; pgrp: number };
    assert.equal(PROCESS_GROUPS, true);
    assert.equal(o.pgrp, o.pid, 'probe child leads its own process group');
  });
});

describe('ClaudeProcess: own process group, terminal signals, cleanup', () => {
  it('the claude child leads its own process group (POSIX)', { skip: !isLinux }, async () => {
    const h = await startFake();
    try {
      const pid = h.proc.pid!;
      assert.equal(pgidOf(pid), pid);
      assert.notEqual(pgidOf(pid), pgidOf(process.pid));
    } finally {
      await h.proc.close({ graceMs: 0 });
    }
  });

  /** A kiro-claude stand-in: starts a ClaudeProcess on fake-claude and reports pids. */
  function writeDriver(dir: string): string {
    const driver = path.join(dir, 'driver.mjs');
    fs.writeFileSync(
      driver,
      `const { ClaudeProcess } = await import(${JSON.stringify(builtModule('claude/process.js'))});
const proc = await ClaudeProcess.start({
  binary: { path: ${JSON.stringify(fakeClaudePath())}, version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' },
  args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'],
  cwd: process.cwd(),
  env: process.env,
  initialize: {},
  handlers: { onHookCallback: async () => ({}), onCanUseTool: async (r) => ({ behavior: 'allow', updatedInput: r.input }) },
});
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (process.env.DRIVER_SIGINT_HANDLER === '1') process.on('SIGINT', () => say({ event: 'sigint' }));
process.stdin.on('data', (d) => { if (String(d).includes('exit')) process.exit(0); });
say({ event: 'ready', pid: process.pid, childPid: proc.pid });
`,
    );
    return driver;
  }

  it('SIGINT to kiro-claude\'s process group does not reach the child; exit cleans it up', { skip: !isLinux }, async () => {
    const dir = mkTmp();
    const run = spawnNode([writeDriver(dir)], {
      env: fakeEnv({ DRIVER_SIGINT_HANDLER: '1', FAKE_CLAUDE_HANG_ON_EOF: '1' }),
      cwd: dir,
      capMs: 20_000,
      detached: true, // the driver leads a process group, like a shell's foreground job
    });
    let childPid = 0;
    try {
      const ready = await waitForLine(run, (o) => o.event === 'ready');
      childPid = ready.childPid as number;
      const driverPid = ready.pid as number;
      assert.ok(alive(childPid));
      // Terminal Ctrl+C: SIGINT to every process of the foreground process group.
      process.kill(-driverPid, 'SIGINT');
      await waitForLine(run, (o) => o.event === 'sigint');
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(alive(childPid), 'the claude child must not receive the terminal SIGINT');
      assert.ok(alive(driverPid), 'kiro-claude handled SIGINT itself');
      // kiro-claude exits without closing the session (FAKE_CLAUDE_HANG_ON_EOF: EOF alone is not enough).
      run.child.stdin!.write('exit\n');
      const res = await run.done;
      assert.equal(res.code, 0);
      assert.ok(await waitDead([childPid], 3_000), 'the child is killed when kiro-claude exits');
    } finally {
      if (childPid) reap([childPid]);
    }
  });

  for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
    it(`${sig} to kiro-claude (no handler of its own) kills the child group and kiro-claude still dies of ${sig}`, { skip: !isLinux }, async () => {
      const dir = mkTmp();
      const run = spawnNode([writeDriver(dir)], {
        // The child ignores SIGTERM and EOF: only the SIGKILL after the grace stops it.
        env: fakeEnv({ FAKE_CLAUDE_HANG_ON_EOF: '1', FAKE_CLAUDE_IGNORE_SIGTERM: '1' }),
        cwd: dir,
        capMs: 20_000,
      });
      let childPid = 0;
      try {
        const ready = await waitForLine(run, (o) => o.event === 'ready');
        childPid = ready.childPid as number;
        process.kill(ready.pid as number, sig);
        const res = await run.done;
        assert.equal(res.killedByTest, false);
        assert.equal(res.signal, sig, `kiro-claude keeps the default disposition (code=${res.code})`);
        assert.ok(res.ms < 10_000);
        assert.ok(await waitDead([childPid], 3_000), 'the child group is killed');
      } finally {
        if (childPid) reap([childPid]);
      }
    });
  }

  it('SIGINT with no handler of kiro-claude\'s own: child killed, kiro-claude dies of SIGINT', { skip: !isLinux }, async () => {
    const dir = mkTmp();
    const run = spawnNode([writeDriver(dir)], { env: fakeEnv({ FAKE_CLAUDE_HANG_ON_EOF: '1' }), cwd: dir, capMs: 20_000, detached: true });
    let childPid = 0;
    try {
      const ready = await waitForLine(run, (o) => o.event === 'ready');
      childPid = ready.childPid as number;
      process.kill(-(ready.pid as number), 'SIGINT');
      const res = await run.done;
      assert.equal(res.killedByTest, false);
      assert.equal(res.signal, 'SIGINT');
      assert.ok(await waitDead([childPid], 3_000));
    } finally {
      if (childPid) reap([childPid]);
    }
  });

  it('close() still escalates to the whole group (SIGTERM-ignoring child)', { skip: isWin }, async () => {
    const h = await startFake({ env: { FAKE_CLAUDE_HANG_ON_EOF: '1', FAKE_CLAUDE_IGNORE_SIGTERM: '1' } });
    const pid = h.proc.pid!;
    const info = await h.proc.close({ graceMs: 50 });
    assert.equal(info.signal, 'SIGKILL');
    assert.ok(await waitDead([pid], 2_000));
  });
});

/**
 * Review round 4 #11: a forwarded SIGTERM/SIGHUP (or shutdownTrackedChildren's SIGTERM) can kill
 * a group's leader — runShell's shell, the claude child — while a member of its group handles or
 * ignores the signal (a hook program with a cleanup handler, a trap, a nohup'd command). The
 * leader's exit drops it from the tracked set, so the members used to be left running with no
 * timeout: kiro-claude then died of the re-raised signal (no 'exit' sweep), the member was
 * re-parented to init. Members get the rest of the grace, then their group is SIGKILLed (only
 * while it is provably still ours, L1).
 */
describe('signalled groups whose leader exited first (r4 #11)', () => {
  const unixLinux = { skip: !isLinux };

  /**
   * A hook-like program (`node <member> <pidFile>`): writes its pid, then on SIGTERM/SIGHUP runs
   * a cleanup handler that takes `cleanupMs` (never finishes when undefined) and exits, after
   * writing `<pidFile>.cleaned`.
   */
  function writeMember(dir: string, cleanupMs?: number): { member: string; pidFile: string; cleaned: string } {
    const member = path.join(dir, 'member-r4-11.cjs');
    const pidFile = path.join(dir, 'member.pid');
    const onSig =
      cleanupMs === undefined
        ? '() => {}'
        : `() => setTimeout(() => { fs.writeFileSync(process.argv[2] + '.cleaned', 'y'); process.exit(0); }, ${cleanupMs})`;
    fs.writeFileSync(
      member,
      `const fs = require('fs');
process.on('SIGTERM', ${onSig});
process.on('SIGHUP', ${onSig});
fs.writeFileSync(process.argv[2], process.pid + '\\n');
setInterval(() => {}, 1000);
`,
    );
    return { member, pidFile, cleaned: `${pidFile}.cleaned` };
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

  /** A kiro-claude stand-in like the REPL / headless runner: no SIGTERM/SIGHUP listener of its own. */
  function writeHookDriver(dir: string, member: string, pidFile: string): string {
    const driver = path.join(dir, 'hook-driver.mjs');
    fs.writeFileSync(
      driver,
      `const { runShell } = await import(${JSON.stringify(builtModule('util/process.js'))});
void runShell(${JSON.stringify(`node '${member}' '${pidFile}'; echo after`)}, { cwd: ${JSON.stringify(dir)}, timeoutMs: 60000 });
setInterval(() => {}, 1000);
`,
    );
    return driver;
  }

  for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
    it(`a forwarded ${sig} SIGKILLs a hook group member that survives it after the shell (the leader) died`, unixLinux, async () => {
      const dir = mkTmp();
      const { member, pidFile } = writeMember(dir);
      const run = spawnNode([writeHookDriver(dir, member, pidFile)], { cwd: dir, capMs: 20_000 });
      let pid = 0;
      try {
        pid = await waitPid(pidFile, 10_000);
        assert.ok(alive(pid), 'the member runs while the hook runs');
        assert.notEqual(pgidOf(pid), pid, 'the member is not a group leader (the shell is)');
        process.kill(run.child.pid!, sig);
        const res = await run.done;
        assert.equal(res.killedByTest, false);
        assert.equal(res.signal, sig, `the driver dies of the re-raised ${sig} (code=${res.code})`);
        assert.ok(res.ms < 10_000);
        assert.ok(await waitDead([pid], 1_000), `hook group member ${pid} still runs after the driver died of ${sig}`);
      } finally {
        reap(readPids(pidFile));
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // Verifier (r4 #11): members get no grace of their own once every leader is gone. While
  // kiro-claude waited for them, the rest of it kept running and reacted to the dead children:
  // runShell resolved after its pipe grace, the session respawned Claude Code and ran the prompt
  // (see the CLI test below). So kiro-claude dies as soon as its leaders are gone, as before.
  it('a forwarded signal does not wait for members once every leader is gone: they are SIGKILLed at once', unixLinux, async () => {
    const dir = mkTmp();
    const { member, pidFile, cleaned } = writeMember(dir, Math.floor(KILL_GRACE_MS * 0.6));
    const run = spawnNode([writeHookDriver(dir, member, pidFile)], { cwd: dir, capMs: 20_000 });
    try {
      const pid = await waitPid(pidFile, 10_000);
      const t0 = Date.now();
      process.kill(run.child.pid!, 'SIGTERM');
      const res = await run.done;
      const ms = Date.now() - t0 - 50; // spawnNode resolves 50 ms after the exit
      assert.equal(res.signal, 'SIGTERM');
      assert.ok(ms < KILL_GRACE_MS * 0.5, `kiro-claude died ${ms} ms after the signal (it waited for the member)`);
      assert.ok(await waitDead([pid], 1_000), `hook group member ${pid} still runs`);
      assert.equal(fs.existsSync(cleaned), false, 'the member was SIGKILLed before its (slow) cleanup ended');
    } finally {
      reap(readPids(pidFile));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a second signal while another leader is in its grace also SIGKILLs the members of a leader that already died', unixLinux, async () => {
    const dir = mkTmp();
    const { member, pidFile } = writeMember(dir);
    const ignorerPid = path.join(dir, 'ignorer.pid');
    const driver = path.join(dir, 'two-hooks-driver.mjs');
    fs.writeFileSync(
      driver,
      `const { runShell } = await import(${JSON.stringify(builtModule('util/process.js'))});
void runShell(${JSON.stringify(`node '${member}' '${pidFile}'; echo after`)}, { cwd: ${JSON.stringify(dir)}, timeoutMs: 60000 });
// A second hook whose shell ignores the signal keeps the grace running.
void runShell(${JSON.stringify(`trap '' TERM HUP; echo $$ > '${ignorerPid}'; sleep 30; echo after`)}, { cwd: ${JSON.stringify(dir)}, timeoutMs: 60000 });
setInterval(() => {}, 1000);
`,
    );
    const run = spawnNode([driver], { cwd: dir, capMs: 20_000 });
    try {
      const pid = await waitPid(pidFile, 10_000);
      const shell = await waitPid(ignorerPid, 10_000);
      const t0 = Date.now();
      process.kill(run.child.pid!, 'SIGTERM');
      await new Promise((r) => setTimeout(r, Math.floor(KILL_GRACE_MS * 0.2)));
      assert.ok(alive(shell) && alive(pid), 'the grace still runs (signal-ignoring shell and member alive)');
      assert.equal(run.child.exitCode === null && run.child.signalCode === null, true, 'kiro-claude still waits');
      process.kill(run.child.pid!, 'SIGTERM');
      const res = await run.done;
      assert.equal(res.signal, 'SIGTERM');
      assert.ok(Date.now() - t0 < KILL_GRACE_MS, `the second signal cut the grace short (${Date.now() - t0} ms)`);
      assert.ok(await waitDead([pid, shell], 1_000), `member ${pid} (of a dead shell) or shell ${shell} survived`);
    } finally {
      reap([...readPids(pidFile), ...readPids(ignorerPid)]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // shutdownTrackedChildren() runs once main() resolved: nothing reacts to the dead leaders any
  // more, so there members do get the rest of the grace.
  for (const variant of ['ignores', 'cleans up'] as const) {
    const title =
      variant === 'ignores'
        ? "shutdownTrackedChildren() SIGKILLs a member that survives the SIGTERM its group's leader died of"
        : "shutdownTrackedChildren() gives a member of a leader that died of the SIGTERM the rest of the grace for its cleanup";
    it(title, unixLinux, async () => {
      const dir = mkTmp();
      const graceMs = variant === 'ignores' ? 300 : KILL_GRACE_MS;
      const { member, pidFile, cleaned } = writeMember(dir, variant === 'ignores' ? undefined : Math.floor(graceMs * 0.4));
      // The tracked (graceful) leader spawns the member into its own group and dies of SIGTERM.
      const leader = path.join(dir, 'leader.cjs');
      fs.writeFileSync(
        leader,
        `require('child_process').spawn(process.execPath, [${JSON.stringify(member)}, ${JSON.stringify(pidFile)}], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`,
      );
      const driver = path.join(dir, 'shutdown-driver.mjs');
      fs.writeFileSync(
        driver,
        `import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
const { groupSpawnOptions, shutdownTrackedChildren, trackChild } = await import(${JSON.stringify(builtModule('claude/lifecycle.js'))});
const child = spawn(process.execPath, [${JSON.stringify(leader)}], { ...groupSpawnOptions(), stdio: 'ignore' });
trackChild(child, true, { graceful: true });
while (!fs.existsSync(${JSON.stringify(pidFile)})) await new Promise((r) => setTimeout(r, 20));
await shutdownTrackedChildren(${graceMs});
process.stdout.write(JSON.stringify({ event: 'done', leaderSignal: child.signalCode, cleaned: fs.existsSync(${JSON.stringify(cleaned)}) }) + '\\n');
setInterval(() => {}, 1000); // no exit sweep: shutdownTrackedChildren alone must have done it
`,
      );
      const run = spawnNode([driver], { cwd: dir, capMs: 20_000 });
      try {
        const done = await waitForLine(run, (o) => o.event === 'done', 15_000);
        assert.equal(done.leaderSignal, 'SIGTERM', 'the leader died of the SIGTERM');
        if (variant === 'cleans up') assert.equal(done.cleaned, true, "shutdownTrackedChildren() returned before the member's cleanup ended");
        const [pid] = readPids(pidFile);
        assert.ok(pid);
        assert.ok(await waitDead([pid], 500), `group member ${pid} survived shutdownTrackedChildren()`);
      } finally {
        run.child.kill('SIGKILL');
        await run.done;
        reap(readPids(pidFile));
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  /** Temp HOME/KIRO_HOME/CLAUDE_CONFIG_DIR/XDG_* for a real `kiro-claude` run on the fake. */
  function cliEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    for (const d of ['home', 'kiro/agents', 'cfg', 'run', 'cache', 'ws']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.chmodSync(path.join(dir, 'run'), 0o700);
    return {
      PATH: process.env.PATH,
      HOME: path.join(dir, 'home'),
      KIRO_HOME: path.join(dir, 'kiro'),
      CLAUDE_CONFIG_DIR: path.join(dir, 'cfg'),
      XDG_RUNTIME_DIR: path.join(dir, 'run'),
      XDG_CACHE_HOME: path.join(dir, 'cache'),
      KIRO_CLAUDE_BIN: fakeClaudePath(),
      FAKE_CLAUDE_LOG: path.join(dir, 'fake.log'),
      ...extra,
    };
  }

  /** The fake's log: stream-mode starts (one per Claude Code session child) and turns run. */
  function fakeActivity(dir: string): { streamStarts: number; turns: string[] } {
    let lines: Array<{ event?: string; argv?: string[]; userText?: string }> = [];
    try {
      lines = fs
        .readFileSync(path.join(dir, 'fake.log'), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { event?: string });
    } catch {
      /* no log */
    }
    return {
      streamStarts: lines.filter((e) => e.event === 'start' && (e.argv ?? []).includes('-p')).length,
      turns: lines.filter((e) => e.event === 'turn').map((e) => String(e.userText)),
    };
  }

  it('kiro-claude chat --no-interactive: SIGTERM during a userPromptSubmit hook leaves no hook process behind, and neither restarts Claude Code nor runs the prompt', unixLinux, async () => {
    const dir = mkTmp();
    const { member, pidFile } = writeMember(dir);
    const env = cliEnv(dir);
    fs.writeFileSync(
      path.join(dir, 'kiro/agents/hooky.json'),
      JSON.stringify({
        name: 'hooky',
        description: 't',
        tools: ['*'],
        hooks: { userPromptSubmit: [{ command: `node '${member}' '${pidFile}'; echo after`, timeout_ms: 60000 }] },
      }),
    );
    const run = spawnNode([builtModule('bin/kiro-claude.js'), 'chat', '--no-interactive', '--trust-all-tools', '--agent', 'hooky', 'hello there'], {
      cwd: path.join(dir, 'ws'),
      env,
      capMs: 30_000,
    });
    try {
      const pid = await waitPid(pidFile, 20_000);
      process.kill(run.child.pid!, 'SIGTERM');
      const res = await run.done;
      assert.equal(res.killedByTest, false);
      assert.equal(res.signal, 'SIGTERM', `stderr=${run.stderr()}`);
      assert.ok(await waitDead([pid], 1_000), `hook process ${pid} outlived kiro-claude's SIGTERM death`);
      // Verifier: kiro-claude must not keep working while it dies (runShell resolving after its
      // pipe grace, the session respawning the claude child that died of the forwarded signal
      // and sending it the prompt: a real API turn, tools included, after a SIGTERM).
      const act = fakeActivity(dir);
      assert.deepEqual(act.turns, [], `a turn ran during the SIGTERM shutdown; stderr=${run.stderr()}`);
      assert.equal(act.streamStarts, 1, `Claude Code was restarted during the SIGTERM shutdown; stderr=${run.stderr()}`);
      assert.doesNotMatch(run.stderr(), /restarting it/);
    } finally {
      reap(readPids(pidFile));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kiro-claude chat --no-interactive: a forwarded SIGTERM also SIGKILLs a member of the claude child's group that survives it, at once", unixLinux, async () => {
    const dir = mkTmp();
    const { member, pidFile } = writeMember(dir);
    // A claude whose group holds a signal-ignoring member that keeps no pipe of ours (a stuck
    // MCP server or background tool command): Claude Code itself dies of the SIGTERM.
    const wrapper = path.join(dir, 'claude');
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh
case " $* " in *" -p "*) node '${member}' '${pidFile}' </dev/null >/dev/null 2>&1 & ;; esac
exec '${process.execPath}' '${fakeClaudePath()}' "$@"
`,
    );
    fs.chmodSync(wrapper, 0o755);
    const env = cliEnv(dir, {
      KIRO_CLAUDE_BIN: wrapper,
      FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify({ default: { steps: [{ text: 'streaming-r4-11' }, { sleepMs: 30_000 }, { text: 'done' }] } }),
    });
    const run = spawnNode([builtModule('bin/kiro-claude.js'), 'chat', '--no-interactive', '--trust-all-tools', 'hello there'], {
      cwd: path.join(dir, 'ws'),
      env,
      capMs: 30_000,
    });
    try {
      const pid = await waitPid(pidFile, 20_000);
      const end = Date.now() + 20_000;
      while (!run.stdout().includes('streaming-r4-11') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      assert.match(run.stdout(), /streaming-r4-11/, `the turn never streamed; stderr=${run.stderr()}`);
      assert.notEqual(pgidOf(pid), pid, "the member is in the claude child's group, not leading one");
      process.kill(run.child.pid!, 'SIGTERM');
      const res = await run.done;
      assert.equal(res.killedByTest, false);
      assert.equal(res.signal, 'SIGTERM', `stderr=${run.stderr()}`);
      assert.ok(await waitDead([pid], 1_000), `claude group member ${pid} outlived kiro-claude's SIGTERM death`);
      // Dying at once, kiro-claude does not report the exit of the child it just signalled.
      assert.doesNotMatch(run.stderr(), /Claude Code exited/);
    } finally {
      reap(readPids(pidFile));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
