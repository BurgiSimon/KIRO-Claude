/**
 * A kill sent after the child was reaped must not reach an unrelated process group that reused
 * its pid (lifecycle L1). After Node reaped a group leader, `kill(-pid)` is only safe while
 * members of that group still live (they keep the number reserved); once the group is empty the
 * number can name a new group leader anywhere in the pid namespace. These cases make the kernel
 * hand the freed pid to a detached `sleep` (test/claude/pid-reuse-helpers.ts, Linux and root
 * only) right after the child exits, then drive each post-exit kill path of src/claude:
 *  - signalChild() itself;
 *  - runCaptured: the SIGKILL sent from finish() after a timed-out probe exited on SIGTERM
 *    while a grandchild that left the group held its pipes (CAPTURE_DRAIN_MS);
 *  - ClaudeProcess.close(): the SIGTERM sent when the grace ran out after the child exited but
 *    before its pipes were drained (EXIT_DRAIN_MS).
 * Guards: leftover members of our own group are still killed after the leader exited.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runCaptured } from '../../src/claude/binary.js';
import { groupSpawnOptions, ownsExitedGroup, parseProcStat, readProcessTable, signalChild, trackChild, type ProcInfo } from '../../src/claude/lifecycle.js';
import { ClaudeProcess } from '../../src/claude/process.js';
import { STREAM_ARGS, allowAllHandlers, fakeEnv, mkTmp } from './helpers.js';
import { alive, builtModule, isLinux, isWin, readPids } from './hang-helpers.js';
import { canChoosePid, exitedWithin, killIfSame, spawnWithPid, startTicksOf, waitReaped } from './pid-reuse-helpers.js';

const reuse = canChoosePid() ? {} : { skip: 'needs Linux and root to steer pid allocation (ns_last_pid)' };
const linux = isLinux ? {} : { skip: 'Linux /proc' };

/** A detached holder that keeps the inherited stdout/stderr open for `secs` (own session). */
function holderJs(pidFile: string, secs: number): string {
  return `const h = require('child_process').spawn('sleep', ['${secs}'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
h.unref();
require('fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n' + h.pid + '\\n');`;
}

describe('post-exit kills and pid reuse (L1)', () => {
  it('signalChild() after the leader was reaped does not signal a new group that reused its pid', reuse, async (t) => {
    const child = spawn('true', [], { ...groupSpawnOptions(), stdio: 'ignore' });
    trackChild(child, true, { graceful: false });
    await once(child, 'exit');
    const victim = spawnWithPid(child.pid!);
    if (!victim) return t.skip('the kernel did not hand out the freed pid');
    t.after(() => victim.kill('SIGKILL'));
    signalChild(child, 'SIGKILL', true);
    assert.equal(await exitedWithin(victim, 300), undefined, `group ${child.pid} (a new process that reused the pid) was killed`);
  });

  it('signalChild() after the leader exited still kills the members left in its group', linux, async (t) => {
    const child = spawn('sh', ['-c', 'sleep 30 & echo $!; exit 0'], { ...groupSpawnOptions(), stdio: ['ignore', 'pipe', 'ignore'] });
    trackChild(child, true, { graceful: false });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    await once(child, 'exit');
    for (let i = 0; i < 100 && !/\d+\n/.test(out); i++) await new Promise((r) => setTimeout(r, 10));
    const member = Number.parseInt(out, 10);
    assert.ok(member > 0, `no member pid: ${out}`);
    const start = startTicksOf(member);
    t.after(() => killIfSame(member, start));
    assert.ok(alive(member), 'the background member outlived the leader');
    assert.equal(signalChild(child, 'SIGKILL', true), true, 'the group was signalled');
    for (let i = 0; i < 100 && alive(member); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(alive(member), false, 'the leftover member was killed');
    child.stdout!.destroy();
  });

  it('runCaptured: the SIGKILL after a timed-out probe exited spares a group that reused its pid', reuse, async (t) => {
    const dir = mkTmp();
    const bin = path.join(dir, 'exits-on-term.cjs');
    const pidFile = path.join(dir, 'pids');
    // The probe exits on SIGTERM; its holder (own session) keeps the pipes open, so runCaptured
    // settles CAPTURE_DRAIN_MS after the exit and then SIGKILLs the "leftovers".
    fs.writeFileSync(bin, `${holderJs(pidFile, 3)}\nsetInterval(() => {}, 1e6);\n`);
    const running = runCaptured(process.execPath, [bin], { timeoutMs: 400 });
    for (let i = 0; i < 500 && readPids(pidFile).length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    const [pid, holder] = readPids(pidFile);
    assert.ok(pid && holder, 'the probe started');
    const holderStart = startTicksOf(holder!);
    t.after(() => killIfSame(holder!, holderStart));
    assert.ok(await waitReaped(pid!, 5000), 'the probe was killed on timeout');
    const victim = spawnWithPid(pid!);
    if (!victim) {
      await running;
      return t.skip('the kernel did not hand out the freed pid');
    }
    t.after(() => victim.kill('SIGKILL'));
    const r = await running;
    assert.equal(r.timedOut, true);
    assert.equal(await exitedWithin(victim, 300), undefined, `group ${pid} (a new process that reused the pid) was killed`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ClaudeProcess.close(): the SIGTERM after the child exited but before its pipes drained spares a group that reused its pid', reuse, async (t) => {
    const dir = mkTmp();
    const bin = path.join(dir, 'eof-claude.mjs');
    const pidFile = path.join(dir, 'pids');
    // Answers initialize, exits on stdin EOF; its holder keeps stdout/stderr open, so the exit is
    // only finalized after EXIT_DRAIN_MS, after close()'s grace ran out.
    fs.writeFileSync(
      bin,
      `import { createRequire } from 'node:module';
import readline from 'node:readline';
const require = createRequire(import.meta.url);
${holderJs(pidFile, 4)}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.type === 'control_request') process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }) + '\\n');
});
rl.on('close', () => process.exit(0));
`,
    );
    const proc = await ClaudeProcess.start({
      binary: { path: bin, version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' },
      args: [...STREAM_ARGS],
      cwd: dir,
      env: fakeEnv(),
      initialize: {},
      handlers: allowAllHandlers,
    });
    const [pid, holder] = readPids(pidFile);
    assert.equal(pid, proc.pid);
    const holderStart = startTicksOf(holder!);
    t.after(() => killIfSame(holder!, holderStart));
    const closing = proc.close({ graceMs: 600 });
    assert.ok(await waitReaped(pid!, 3000), 'the child exited on stdin EOF');
    const victim = spawnWithPid(pid!);
    if (!victim) {
      await closing;
      return t.skip('the kernel did not hand out the freed pid');
    }
    t.after(() => victim.kill('SIGKILL'));
    const info = await closing;
    assert.deepEqual(info, { code: 0, signal: null });
    assert.equal(await exitedWithin(victim, 300), undefined, `group ${pid} (a new process that reused the pid) was signalled`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * libuv reaps every exited child (waitpid) before it reports any of them, so inside one child's
 * 'exit' handler — and the microtasks after it, e.g. a `process.exit()` whose exit hook sweeps
 * the tracked children, or bin/run.ts's shutdownTrackedChildren() after main() resolved — a
 * sibling can already be reaped while Node still shows it running (exitCode and signalCode
 * null): its pid is free, yet signalChild() took the "alive" path and sent kill(-pid) (or
 * kill(pid) via child.kill()) unchecked. Leaders that die together (one SIGKILL sweep) make the
 * window near-certain; each case retries a few rounds and skips if it never opens.
 */
describe('a child libuv reaped but Node has not reported yet (L1)', () => {
  const ROUNDS = 25;

  type Kid = ReturnType<typeof spawn>;

  /**
   * Spawns `n` tracked detached leaders, waits for `ready`, SIGKILLs them all at once (by handle)
   * and calls `inWindow(sibling)` from the first 'exit' handler for the first sibling that is
   * already gone from /proc while Node still shows it running. Resolves with what `inWindow`
   * returned, or undefined when the window did not open in this round.
   */
  async function inReapWindow<T>(spawnLeader: () => Kid, inWindow: (sibling: Kid) => T | undefined, ready?: (kids: Kid[]) => Promise<void>, n = 6): Promise<T | undefined> {
    const kids = Array.from({ length: n }, spawnLeader);
    for (const k of kids) trackChild(k, true, { graceful: false });
    const exits = Promise.all(kids.map((k) => (k.exitCode !== null || k.signalCode !== null ? Promise.resolve() : once(k, 'exit'))));
    if (ready) await ready(kids);
    let result: T | undefined;
    let done = false;
    for (const k of kids) {
      k.once('exit', () => {
        if (done) return;
        for (const o of kids) {
          if (o === k || o.exitCode !== null || o.signalCode !== null || fs.existsSync(`/proc/${o.pid}`)) continue;
          done = true;
          result = inWindow(o);
          return;
        }
      });
    }
    for (const k of kids) k.kill('SIGKILL');
    await exits;
    return result;
  }

  for (const group of [true, false]) {
    it(`signalChild(${group ? 'group' : 'leader only'}) in that window does not signal a new process that reused the pid`, reuse, async (t) => {
      for (let round = 0; round < ROUNDS; round++) {
        const hit = await inReapWindow(
          () => spawn('sleep', ['30'], { ...groupSpawnOptions(), stdio: 'ignore' }),
          (o) => {
            const victim = spawnWithPid(o.pid!);
            if (!victim) return undefined;
            return { victim, pid: o.pid!, signalled: signalChild(o, 'SIGKILL', group) };
          },
          // Start times have a 10 ms resolution: a real reuse takes a full turn of the pid
          // counter, so the leaders must not die (and be replaced) within their first tick.
          () => new Promise((r) => setTimeout(r, 40)),
        );
        if (!hit) continue;
        t.after(() => hit.victim.kill('SIGKILL'));
        assert.equal(await exitedWithin(hit.victim, 300), undefined, `pid ${hit.pid} (a new process that reused it) was killed`);
        assert.equal(hit.signalled, false);
        return;
      }
      t.skip('the reap window (or the freed pid) never came up');
    });
  }

  it("signalChild() in that window still kills the members left in the reaped leader's group", linux, async (t) => {
    const members: Array<{ pid: number; start: number | undefined }> = [];
    t.after(() => {
      for (const m of members) killIfSame(m.pid, m.start);
    });
    for (let round = 0; round < ROUNDS; round++) {
      // Each leader leaves a member in its group (its pid on stdout), then becomes `sleep`.
      const memberOf = new Map<Kid, number>();
      const hit = await inReapWindow(
        () => {
          const c = spawn('sh', ['-c', 'sleep 30 & echo $!; exec sleep 30'], { ...groupSpawnOptions(), stdio: ['ignore', 'pipe', 'ignore'] });
          let out = '';
          c.stdout!.on('data', (d: Buffer) => {
            out += d.toString();
            const m = Number.parseInt(out, 10);
            if (/\d+\n/.test(out) && !memberOf.has(c)) {
              memberOf.set(c, m);
              members.push({ pid: m, start: startTicksOf(m) });
            }
          });
          return c;
        },
        (o) => {
          const member = memberOf.get(o);
          if (member === undefined || !alive(member)) return undefined;
          return { member, signalled: signalChild(o, 'SIGKILL', true) };
        },
        async (kids) => {
          for (let i = 0; i < 300 && memberOf.size < kids.length; i++) await new Promise((r) => setTimeout(r, 10));
          await new Promise((r) => setTimeout(r, 30)); // let `exec sleep` replace the shells
        },
      );
      for (const c of memberOf.keys()) c.stdout!.destroy();
      if (!hit) continue;
      assert.equal(hit.signalled, true, 'the group was signalled');
      for (let i = 0; i < 100 && alive(hit.member); i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(alive(hit.member), false, 'the leftover member was killed');
      return;
    }
    t.skip('the reap window never came up');
  });

  it('process.exit() in that window: the exit hook does not SIGKILL a new process that reused a tracked pid', reuse, async (t) => {
    const dir = mkTmp();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const driver = path.join(dir, 'exit-in-window.mjs');
    const lifecycle = builtModule('claude/lifecycle.js');
    const helpers = fileURLToPath(new URL('./pid-reuse-helpers.js', import.meta.url));
    // Like kiro-claude reacting to one child's exit by exiting while other tracked children die
    // with it: the exit hook sweeps the tracked children, one of them already reaped by libuv.
    fs.writeFileSync(
      driver,
      `import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { groupSpawnOptions, trackChild } from ${JSON.stringify(pathToFileURL(lifecycle).href)};
import { spawnWithPid, startTicksOf } from ${JSON.stringify(pathToFileURL(helpers).href)};
for (let round = 0; round < ${ROUNDS}; round++) {
  const kids = Array.from({ length: 6 }, () => spawn('sleep', ['30'], { ...groupSpawnOptions(), stdio: 'ignore' }));
  for (const k of kids) trackChild(k, true, { graceful: false });
  await new Promise((r) => setTimeout(r, 40));
  const exits = Promise.all(kids.map((k) => new Promise((r) => k.once('exit', r))));
  for (const k of kids) {
    k.once('exit', () => {
      for (const o of kids) {
        if (o === k || o.exitCode !== null || o.signalCode !== null || fs.existsSync('/proc/' + o.pid)) continue;
        const v = spawnWithPid(o.pid);
        if (!v) return;
        fs.writeSync(1, JSON.stringify({ victim: v.pid, start: startTicksOf(v.pid) }) + '\\n');
        process.exit(0); // still in the window: o is tracked and looks running
      }
    });
  }
  for (const k of kids) k.kill('SIGKILL');
  await exits;
}
process.stdout.write(JSON.stringify({ skipped: true }) + '\\n');
`,
    );
    const r = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    r.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    await once(r, 'close');
    const line = JSON.parse(out.trim().split('\n')[0] ?? '{}') as { victim?: number; start?: number; skipped?: boolean };
    if (!line.victim) return t.skip('the reap window (or the freed pid) never came up');
    t.after(() => killIfSame(line.victim!, line.start));
    await new Promise((res) => setTimeout(res, 200));
    assert.notEqual(line.start, undefined);
    assert.equal(startTicksOf(line.victim), line.start, `pid ${line.victim} (a new process that reused it) was killed by the exit hook`);
  });
});

describe('ownsExitedGroup (L1, pure)', () => {
  const P = 4242;
  const EXIT = 100_000;
  const member = (o: Partial<ProcInfo> = {}): ProcInfo => ({ pid: 5000, pgid: P, sid: P, state: 'S', startTicks: EXIT - 50, ...o });

  it('a member of the group and session that started before the leader exited: ours', () => {
    assert.equal(ownsExitedGroup(P, [member(), { pid: 1, pgid: 1, sid: 1, state: 'S', startTicks: 0 }], EXIT), true);
    assert.equal(ownsExitedGroup(P, [member({ startTicks: EXIT })], EXIT), true, 'same tick as the exit');
    assert.equal(ownsExitedGroup(P, [member({ pid: 5001, startTicks: EXIT + 30 }), member()], EXIT), true, 'a later member does not hide an earlier one');
  });

  it('a live process with the leader\'s pid: the number was handed out again', () => {
    assert.equal(ownsExitedGroup(P, [member(), { pid: P, pgid: P, sid: P, state: 'S', startTicks: EXIT + 10 }], EXIT), false);
    assert.equal(ownsExitedGroup(P, [{ pid: P, pgid: 77, sid: 77, state: 'R' }], EXIT), false, 'not even a leader of its own group');
    assert.equal(ownsExitedGroup(P, [{ pid: 5000, pgid: P }, { pid: P, pgid: P }], undefined), false, 'ps listing');
  });

  it('only members that started after the exit: may be a reused group, not signalled', () => {
    assert.equal(ownsExitedGroup(P, [member({ startTicks: EXIT + 1 })], EXIT), false);
    assert.equal(ownsExitedGroup(P, [member()], undefined), false, 'exit time unknown');
  });

  it('a group of that id in another session (a job-control shell job) is not ours', () => {
    assert.equal(ownsExitedGroup(P, [member({ sid: 3100 })], EXIT), false);
  });

  it('no live member: nothing to signal', () => {
    assert.equal(ownsExitedGroup(P, [], EXIT), false);
    assert.equal(ownsExitedGroup(P, [member({ state: 'Z' })], EXIT), false);
    assert.equal(ownsExitedGroup(P, [{ pid: 5000, pgid: 77, sid: 77, state: 'S', startTicks: 1 }], EXIT), false);
  });

  it('ps listing (no session, no start time): membership decides', () => {
    assert.equal(ownsExitedGroup(P, [{ pid: 5000, pgid: P }], undefined), true);
  });
});

describe('process table (L1)', () => {
  it('parseProcStat reads pid, state, group, session and start time; comm may hold spaces and parentheses', () => {
    const rest = ['S', '1', '4242', '4100', '0', '-1', '4194304', ...Array(12).fill('0'), '987654', '1', '2'];
    assert.deepEqual(parseProcStat(`5000 (a) b (c)) ${rest.join(' ')}\n`), { pid: 5000, pgid: 4242, sid: 4100, state: 'S', startTicks: 987654 });
    assert.equal(parseProcStat('garbage'), undefined);
  });

  it('/proc lists this process with its group and session', linux, () => {
    const table = readProcessTable('proc');
    assert.ok(table && table.length > 0);
    const self = parseProcStat(fs.readFileSync('/proc/self/stat', 'utf8'))!;
    const me = table.find((p) => p.pid === process.pid);
    assert.ok(me, 'this process is listed');
    assert.equal(me.pgid, self.pgid);
    assert.equal(me.sid, self.sid);
    assert.equal(typeof me.startTicks, 'number', 'start times are in the ticks of /proc/uptime');
  });

  it('the POSIX ps fallback lists this process with the same group', { skip: isWin }, (t) => {
    const ps = readProcessTable('ps');
    if (!ps) return t.skip('no ps');
    const me = ps.find((p) => p.pid === process.pid);
    assert.ok(me, 'this process is listed');
    if (isLinux) assert.equal(me.pgid, parseProcStat(fs.readFileSync('/proc/self/stat', 'utf8'))!.pgid);
  });
});
