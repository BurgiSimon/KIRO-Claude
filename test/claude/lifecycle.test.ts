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
