/**
 * Process-level: `kiro-claude whoami` against a `claude` that never answers must exit within
 * the whoami cap (20 s, 08 KC-CLI-04) + 2 s with the signed-out text ("not logged in", which
 * KiroCrew's 30 s whoami probe looks for) and exit 1 — the abandoned probe children (and their
 * pipe-holding grandchildren) must neither keep the process alive nor survive it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WHOAMI_TIMEOUT_MS } from '../../src/cli/commands/auth.js';
import { makeEnv } from '../cli/helpers.js';
import { builtModule, isWin, readPids, reap, spawnNode, waitDead, writeHangFake } from './hang-helpers.js';

const LIMIT_MS = WHOAMI_TIMEOUT_MS + 2_000;

describe('whoami with a hanging claude (process level)', { concurrency: true }, () => {
  const cases = [
    // `claude --version` itself hangs (and ignores SIGTERM; a grandchild holds the pipes).
    { name: 'claude --version never answers', fake: { mode: 'all' as const, grandchild: true, ignoreTerm: true } },
    // `--version` answers after 6 s, `auth status` hangs: the 20 s cap fires while the auth
    // probe (15 s timeout, started at ~6 s) is still running — the reported symptom.
    { name: 'claude auth status never answers (cap path)', fake: { mode: 'auth' as const, versionDelayMs: 6_000, grandchild: true, ignoreTerm: true } },
  ];
  for (const c of cases) {
    it(`${c.name}: exits within cap + 2 s, signed out, exit 1`, { skip: isWin, timeout: 60_000 }, async () => {
      const t = makeEnv();
      const { bin, pidFile } = writeHangFake(t.root, c.fake);
      const run = spawnNode([builtModule('bin/kiro-claude.js'), 'whoami'], {
        env: { ...t.env, KIRO_CLAUDE_BIN: bin },
        cwd: t.cwd,
        capMs: 40_000,
      });
      const res = await run.done;
      const pids = readPids(pidFile);
      try {
        assert.equal(res.killedByTest, false, `kiro-claude stayed alive (stderr=${run.stderr()})`);
        assert.ok(res.ms <= LIMIT_MS, `exited after ${res.ms} ms (limit ${LIMIT_MS} ms)`);
        assert.equal(res.code, 1);
        assert.match(run.stderr(), /not logged in/i);
        assert.equal(run.stdout(), '');
        assert.ok(pids.length >= 2, 'the fake ran');
        assert.ok(await waitDead(pids, 2_000), 'no claude probe (or grandchild) outlives kiro-claude');
      } finally {
        reap(pids);
        t.cleanup();
      }
    });
  }
});
