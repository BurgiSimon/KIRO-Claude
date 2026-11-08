/**
 * Round 7, verifier of the crew group's fixes for findings #4 and #5 (what `crew uninstall --purge`
 * prints must match what happened to `$CS`; `Purged $CS` only when lstat($CS) finds nothing).
 *
 * - Another entry point to #5's cause (a decision about `$CS` made by a call that follows a link):
 *   the purge without crew.json said `$CS does not exist` for a `$CS` that is a dangling symbolic
 *   link, which lstat sees. It now names the dangling link and keeps it (exit 0, idempotent).
 * - Real file-system guards for the rmdir-failure branch (the fixer simulated EBUSY): an immutable
 *   parent (chattr +i) lets crew's entries go but makes rmdir($CS) fail with EPERM, on both purge
 *   paths; an immutable `$CS` keeps everything, so nothing may be named as purged.
 * - ARCHITECTURE.md describes the report as the code prints it: the checkout is labelled only on
 *   the path with crew.json (which names it), `Purged <dir>` means lstat fails with ENOENT, and the
 *   dangling link is described.
 */
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { defaultSys } from '../../src/crew/runner.js';
import { crew, makeFakeEnv, realPython, type FakeEnv } from './helpers.js';

const PY = realPython();
/** Setup's free-disk preflight is about the real disk; these tests build nothing. */
const plentyOfDisk = { sys: { ...defaultSys, freeBytes: () => 64 * 1024 ** 3 } };

/** The lines of `stdout` that report the purge. */
function purgeLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => /^(Purged |Nothing to purge)/.test(l));
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Sets the immutable attribute on `dir` (+i) or clears it (-i); false where that is not possible. */
function chattr(flag: '+i' | '-i', dir: string): boolean {
  const r = spawnSync('chattr', [flag, dir], { encoding: 'utf8' });
  return r.status === 0;
}

/** Whether an immutable directory can be made here (root, chattr, an ext-like file system). */
function canMakeImmutable(fe: FakeEnv): boolean {
  const probe = path.join(fe.root, 'immutable-probe');
  fs.mkdirSync(probe);
  try {
    if (!chattr('+i', probe)) return false;
    let refused = false;
    try {
      fs.mkdirSync(path.join(probe, 'x'));
    } catch {
      refused = true;
    }
    chattr('-i', probe);
    return refused;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

async function setUp(fe: FakeEnv, dir: string): Promise<void> {
  fs.writeFileSync(path.join(fe.home, '.fake-claude-login'), '');
  const s = await crew(fe, ['setup', '--dir', dir, '--allow-tmp'], { deps: plentyOfDisk });
  assert.equal(s.code, 0, `${s.stdout}\n${s.stderr}`);
}

describe('r7f crew verify: a dangling symbolic link at $CS is not reported as missing', () => {
  it('uninstall --purge names the dangling link, keeps it, exit 0, and says the same on the next run', async () => {
    const fe = makeFakeEnv();
    try {
      const gone = path.join(fe.root, 'unmounted-disk', 'crew');
      fs.mkdirSync(path.dirname(fe.cs), { recursive: true });
      fs.symlinkSync(gone, fe.cs);
      for (let i = 0; i < 2; i++) {
        const r = await crew(fe, ['uninstall', '--purge']);
        assert.equal(r.code, 0, r.stderr);
        assert.doesNotMatch(r.stdout, /does not exist\./, r.stdout);
        assert.match(r.stdout, new RegExp(`^Nothing to purge: ${fe.cs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is a dangling symbolic link \\(to ${gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\); kept the link\\.$`, 'm'), r.stdout);
        assert.equal(fs.lstatSync(fe.cs).isSymbolicLink(), true, 'the link is kept');
        assert.equal(fs.readlinkSync(fe.cs), gone);
        assert.equal(exists(gone), false, 'nothing is created at the target');
      }
      const plain = await crew(fe, ['uninstall']);
      assert.equal(plain.code, 1, 'a plain uninstall still says setup has not run');
    } finally {
      fe.cleanup();
    }
  });

  it('control: a $CS that really does not exist still reads "does not exist"', async () => {
    const fe = makeFakeEnv();
    try {
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^Nothing to purge: .* does not exist\.$/m);
    } finally {
      fe.cleanup();
    }
  });
});

describe('r7f crew verify: rmdir($CS) failing for real (immutable directories)', () => {
  it('without crew.json: an immutable parent -> bin/ is purged, $CS stays with EPERM, run 2 has nothing to purge', async (t) => {
    const fe = makeFakeEnv();
    const parent = path.dirname(fe.cs);
    try {
      if (!canMakeImmutable(fe)) return t.skip('chattr +i is not available here (needs root and an ext-like file system)');
      fs.mkdirSync(path.join(fe.cs, 'bin'), { recursive: true });
      assert.ok(chattr('+i', parent));
      const r1 = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r1.code, 0, r1.stderr);
      assert.equal(exists(path.join(fe.cs, 'bin')), false);
      assert.equal(fs.statSync(fe.cs).isDirectory(), true);
      assert.deepEqual(purgeLines(r1.stdout), [`Purged bin from ${fe.cs}; could not remove the directory itself (EPERM)`], r1.stdout);
      const r2 = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r2.code, 0, r2.stderr);
      assert.deepEqual(purgeLines(r2.stdout), [`Nothing to purge in ${fe.cs}; could not remove the directory itself (EPERM)`], r2.stdout);
    } finally {
      chattr('-i', parent);
      fe.cleanup();
    }
  });

  it('without crew.json: an immutable $CS keeps everything, so nothing is named as purged', async (t) => {
    const fe = makeFakeEnv();
    try {
      if (!canMakeImmutable(fe)) return t.skip('chattr +i is not available here (needs root and an ext-like file system)');
      fs.mkdirSync(path.join(fe.cs, 'bin'), { recursive: true });
      assert.ok(chattr('+i', fe.cs));
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(fs.statSync(path.join(fe.cs, 'bin')).isDirectory(), true);
      assert.deepEqual(purgeLines(r.stdout), [`Nothing to purge in ${fe.cs}; kept bin`], r.stdout);
    } finally {
      chattr('-i', fe.cs);
      fe.cleanup();
    }
  });

  it('with crew.json: an immutable parent -> bin and node are purged, $CS stays with EPERM, never "Purged $CS"', { skip: PY ? false : 'no python3 with sqlite3' }, async (t) => {
    const fe = makeFakeEnv();
    const parent = path.dirname(fe.cs);
    try {
      if (!canMakeImmutable(fe)) return t.skip('chattr +i is not available here (needs root and an ext-like file system)');
      await setUp(fe, path.join(fe.root, 'KiroCrew'));
      assert.ok(chattr('+i', parent));
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.deepEqual(fs.readdirSync(fe.cs), []);
      assert.deepEqual(purgeLines(r.stdout), [`Purged bin, node from ${fe.cs}; could not remove the directory itself (EPERM)`], r.stdout);
      const again = await crew(fe, ['uninstall', '--purge']);
      assert.equal(again.code, 0, again.stderr);
      assert.deepEqual(purgeLines(again.stdout), [`Nothing to purge in ${fe.cs}; could not remove the directory itself (EPERM)`], again.stdout);
    } finally {
      chattr('-i', parent);
      fe.cleanup();
    }
  });
});

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md')) && fs.existsSync(path.join(dir, 'README.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

describe('r7f crew verify: ARCHITECTURE.md describes the purge report as printed', () => {
  const arch = fs.readFileSync(path.join(repoRoot(), 'docs', 'ARCHITECTURE.md'), 'utf8');
  const para = (arch.split(/\n\n/).find((p) => p.startsWith('**Uninstalling.**')) ?? '').replace(/\s+/g, ' ');

  it('the checkout label is described for the purge with crew.json only (the path without it does not label)', async () => {
    assert.ok(para, 'the Uninstalling paragraph');
    const fe = makeFakeEnv();
    try {
      fs.mkdirSync(path.join(fe.cs, 'KiroCrew', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(fe.cs, 'KiroCrew', 'bin', 'kirocrew'), '#!/bin/sh\n');
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(purgeLines(r.stdout), [`Nothing to purge in ${fe.cs}; kept KiroCrew`], r.stdout);
    } finally {
      fe.cleanup();
    }
    assert.doesNotMatch(para, /\(a checkout inside is labelled as such\)/, 'an unqualified claim covers both paths');
    assert.match(para, /with `crew\.json`, the checkout it names is labelled/);
  });

  it('"Purged <dir>" is said to mean lstat fails with ENOENT, and the dangling link is described', () => {
    assert.match(para, /`Purged <dir>` only when the state directory is really gone \(lstat fails with `ENOENT`\)/);
    assert.match(para, /dangling symbolic link/);
  });
});
