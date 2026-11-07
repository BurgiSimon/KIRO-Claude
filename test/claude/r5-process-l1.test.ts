/**
 * Review round 5, H1 guard: the sweep of a claude child's group after its leader exited goes
 * through signalChild, so it never signals a group whose number another process holds now (L1:
 * a pid that is in use again was handed out again). No pid is steered here
 * (/proc/sys/kernel/ns_last_pid is not touched): the "reuse" is modelled by a ChildProcess
 * stand-in whose pid is that of an unrelated live group leader we started ourselves.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { membersSettled, trackChild } from '../../src/claude/lifecycle.js';
import { alive, isLinux } from './hang-helpers.js';

describe("the post-exit sweep of a claude child's group (r5 H1, L1)", () => {
  it('never signals a group whose leader number is held by another process', { skip: !isLinux }, async () => {
    // An unrelated group: its leader `sh` (pid = pgid) and a member, all started before "our" exit.
    const other = spawn('sh', ['-c', 'sleep 30 & sleep 30; wait'], { detached: true, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 100));
      const fake = new EventEmitter() as EventEmitter & { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(): boolean };
      fake.pid = other.pid;
      fake.exitCode = null;
      fake.signalCode = null;
      fake.kill = () => false;
      trackChild(fake as unknown as ChildProcess, true, { sweepMembers: true });
      fake.exitCode = 0;
      fake.emit('exit', 0, null);
      const t0 = Date.now();
      await membersSettled(fake as unknown as ChildProcess);
      assert.ok(Date.now() - t0 < 2_000);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(alive(other.pid!), 'the sweep signalled a group whose number belongs to another process');
      assert.equal(other.exitCode, null);
      assert.equal(other.signalCode, null);
    } finally {
      try {
        process.kill(-other.pid!, 'SIGKILL'); // our own live child's group
      } catch {
        /* gone */
      }
    }
  });
});
