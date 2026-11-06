/**
 * Edge cases of the hang-proof probes and child lifecycle (src/claude/binary.ts runCaptured,
 * src/claude/lifecycle.ts) found by the adversarial review of the lifecycle fixes.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { CAPTURE_DRAIN_MS, runCaptured } from '../../src/claude/binary.js';
import { mkTmp } from './helpers.js';
import { isWin, readPids, reap } from './hang-helpers.js';

describe('runCaptured: exit before the timeout', () => {
  it('a child that exited before the timeout is not reported as timed out while a grandchild holds the pipes', { skip: isWin }, async () => {
    const dir = mkTmp();
    const bin = path.join(dir, 'quick-claude');
    const pidFile = path.join(dir, 'pids');
    const exitedAt = path.join(dir, 'exited-at');
    // `sh` starts in a few ms: the child exits long before the timeout, but its background
    // `sleep` (stdout/stderr inherited) keeps the pipes open past it.
    fs.writeFileSync(
      bin,
      `#!/bin/sh
echo "2.1.318 (Claude Code)"
sleep 30 &
echo $! >> ${JSON.stringify(pidFile)}
node -e 'process.stdout.write(String(Date.now()))' > ${JSON.stringify(exitedAt)} 2>/dev/null || date +%s000 > ${JSON.stringify(exitedAt)}
exit 0
`,
    );
    fs.chmodSync(bin, 0o755);
    const timeoutMs = Math.floor(CAPTURE_DRAIN_MS * 0.8);
    // Up to 3 attempts: an attempt is conclusive only when the child really exited (well) before
    // the timeout (a loaded machine may start `sh` late).
    for (let attempt = 0; attempt < 3; attempt++) {
      fs.rmSync(exitedAt, { force: true });
      const t0 = Date.now();
      const r = await runCaptured(bin, ['--version'], { timeoutMs });
      const pids = readPids(pidFile);
      reap(pids);
      const exitMs = Number.parseInt(fs.existsSync(exitedAt) ? fs.readFileSync(exitedAt, 'utf8') : '', 10) - t0;
      if (!(exitMs >= 0 && exitMs < timeoutMs - 60)) continue; // inconclusive
      assert.equal(r.code, 0);
      assert.match(r.stdout, /2\.1\.318/);
      assert.equal(r.timedOut, false, `exited after ~${exitMs} ms, timeout ${timeoutMs} ms: not a timeout`);
      return;
    }
    assert.fail('no conclusive attempt (the child never exited well before the timeout)');
  });
});
