/**
 * Review round 5, H1 (verifier guards). Probes with the real Claude Code 2.1.319 showed:
 *  - its stdio MCP servers run in the claude child's own process group, so a server's grandchild
 *    (a shell or `npx` wrapper's server that ignores stdin EOF and SIGTERM) used to outlive
 *    close() and is now swept (HEAD: alive 3 s after close(); fixed build: gone);
 *  - every Bash tool command runs under a wrapper shell that claude starts in a session of its
 *    own (claude → wrapper with pgid = sid = its pid → the command in a group of its own there),
 *    and claude kills it itself on exit or SIGTERM.
 * What claude starts in a session of its own may be meant to outlive it, so the sweep must leave
 * it to claude (lifecycle module doc (4)); and the sweep must cost nothing when claude's group
 * is empty (the common path).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { ClaudeProcess } from '../../src/claude/process.js';
import { MEMBER_GRACE_MS, membersSettled } from '../../src/claude/lifecycle.js';
import { STREAM_ARGS, allowAllHandlers, fakeBinary, fakeClaudePath, fakeEnv, mkTmp } from './helpers.js';
import { alive, isLinux, readPids, reap } from './hang-helpers.js';

const linux = { skip: !isLinux || !fs.existsSync('/usr/bin/setsid') };

/** Session id of `pid` (Linux, /proc), or undefined. */
function sidOf(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number.parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3] ?? '', 10);
  } catch {
    return undefined;
  }
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

describe('the sweep of the claude child\'s group after its exit: what it leaves alone (r5 H1, verifier)', () => {
  it('a process Claude Code started in a session of its own (as 2.1.319 does for Bash tool commands) is left to claude', linux, async () => {
    const dir = mkTmp();
    const pidFile = path.join(dir, 'detached.pid');
    const wrapper = path.join(dir, 'claude');
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh
case " $* " in *" -p "*) /usr/bin/setsid '${process.execPath}' -e "require('fs').writeFileSync(process.argv[1], process.pid + '\\\\n'); for (const s of ['SIGTERM','SIGHUP','SIGINT']) process.on(s, () => {}); setInterval(() => {}, 1000)" '${pidFile}' </dev/null >/dev/null 2>&1 & ;; esac
exec '${process.execPath}' '${fakeClaudePath()}' "$@"
`,
    );
    fs.chmodSync(wrapper, 0o755);
    const proc = await ClaudeProcess.start({
      binary: { path: wrapper, version: '2.1.318', rawVersion: '2.1.318 (Claude Code)' },
      args: [...STREAM_ARGS],
      cwd: dir,
      env: fakeEnv(),
      initialize: {},
      handlers: allowAllHandlers,
    });
    try {
      const pid = await waitPid(pidFile, 10_000);
      assert.notEqual(sidOf(pid), proc.pid, 'the process runs in a session of its own');
      const info = await proc.close();
      assert.equal(info.code, 0);
      await new Promise((r) => setTimeout(r, MEMBER_GRACE_MS + 100));
      assert.ok(alive(pid), 'the sweep signalled a process Claude Code had started in a session of its own');
    } finally {
      reap(readPids(pidFile));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an empty group (the common path): the sweep ends at once, close() adds no member wait", { skip: !isLinux }, async () => {
    const dir = mkTmp();
    const proc = await ClaudeProcess.start({
      binary: fakeBinary(),
      args: [...STREAM_ARGS],
      cwd: dir,
      env: fakeEnv(),
      initialize: {},
      handlers: allowAllHandlers,
    });
    try {
      let exitedAt = 0;
      proc.on('exit', () => (exitedAt = performance.now()));
      await proc.close();
      const waited = performance.now() - exitedAt;
      assert.ok(exitedAt > 0);
      assert.ok(waited < 50, `close() resolved ${waited.toFixed(1)} ms after Claude Code's exit with no member left`);
      const t0 = performance.now();
      await membersSettled((proc as unknown as { child: import('node:child_process').ChildProcess }).child);
      assert.ok(performance.now() - t0 < 20);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
