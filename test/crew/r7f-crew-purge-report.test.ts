/**
 * Round 7, group crew, findings #4 and #5: what `crew uninstall --purge` prints must match what
 * happened to `$CS`.
 *
 * #4: the full purge (crew.json present) printed `Purged $CS` even when `$CS` stayed: a bridge
 * prefix holding another package is kept (ownership rule), a shared KIRO_CLAUDE_CREW_HOME keeps
 * the user's files, a checkout inside `$CS` is kept. It now gives the same removed/kept report as
 * the purge without crew.json, naming the checkout among the kept entries.
 *
 * #5: the purge without crew.json decided from a listing that reads through a link, so a `$CS`
 * that is a symbolic link (or an empty directory rmdir cannot remove, such as a mount point:
 * EBUSY) was reported as `Purged $CS` on every run although it stayed. `Purged $CS` now means
 * lstat($CS) fails with ENOENT; otherwise the report names what was removed (or says Nothing to
 * purge) and why the directory itself is kept. Both paths stay idempotent and remove only
 * crew-named entries (through a link at `$CS` too, never the link or the target's other files).
 */
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { defaultSys } from '../../src/crew/runner.js';
import { crew, makeFakeEnv, realPython, type FakeEnv } from './helpers.js';

const PY = realPython();
const cjsFs = createRequire(import.meta.url)('node:fs') as typeof fs;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

async function setUp(fe: FakeEnv, dir: string, env: NodeJS.ProcessEnv = {}): Promise<void> {
  fs.writeFileSync(path.join(fe.home, '.fake-claude-login'), '');
  // Setup's free-disk preflight is about the real disk; these tests build nothing.
  const s = await crew(fe, ['setup', '--dir', dir, '--allow-tmp'], { env, deps: { sys: { ...defaultSys, freeBytes: () => 64 * 1024 ** 3 } } });
  assert.equal(s.code, 0, `${s.stdout}\n${s.stderr}`);
}

/** Makes `$CS` a symbolic link to `<root>/other-disk/crew` (created, empty). */
function linkCs(fe: FakeEnv): string {
  const target = path.join(fe.root, 'other-disk', 'crew');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.dirname(fe.cs), { recursive: true });
  fs.symlinkSync(target, fe.cs);
  return target;
}

describe('r7f crew: uninstall --purge with crew.json reports what it removed and kept', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  it('a bridge prefix holding another package is kept: names it, never "Purged $CS"; a second purge agrees', async () => {
    const fe = makeFakeEnv();
    try {
      await setUp(fe, path.join(fe.root, 'KiroCrew'));
      const pj = path.join(fe.cs, 'node', 'package.json');
      const j = JSON.parse(fs.readFileSync(pj, 'utf8')) as { dependencies?: Record<string, string> };
      j.dependencies = { ...j.dependencies, 'left-pad': '^1.0.0' };
      fs.writeFileSync(pj, JSON.stringify(j));
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.ok(fs.existsSync(pj), 'the foreign bridge is kept (ownership rule)');
      assert.deepEqual(purgeLines(r.stdout), [`Purged bin from ${fe.cs}; kept node`], r.stdout);
      assert.deepEqual(fs.readdirSync(fe.cs), ['node']);
      const again = await crew(fe, ['uninstall', '--purge']);
      assert.equal(again.code, 0, again.stderr);
      assert.deepEqual(purgeLines(again.stdout), [`Nothing to purge in ${fe.cs}; kept node`], again.stdout);
    } finally {
      fe.cleanup();
    }
  });

  it('a shared KIRO_CLAUDE_CREW_HOME keeps the user files and says so, never "Purged <dir>"', async () => {
    const fe = makeFakeEnv();
    const shared = path.join(fe.root, 'shared-crew-home');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'notes.txt'), 'user data');
    const env = { KIRO_CLAUDE_CREW_HOME: shared };
    try {
      await setUp(fe, path.join(fe.root, 'KiroCrew'), env);
      const r = await crew(fe, ['uninstall', '--purge'], { env });
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.readFileSync(path.join(shared, 'notes.txt'), 'utf8'), 'user data');
      assert.deepEqual(fs.readdirSync(shared), ['notes.txt']);
      assert.deepEqual(purgeLines(r.stdout), [`Purged bin, node from ${shared}; kept notes.txt`], r.stdout);
    } finally {
      fe.cleanup();
    }
  });

  it('a checkout inside $CS is kept and named as the checkout', async () => {
    const fe = makeFakeEnv();
    try {
      const checkout = path.join(fe.cs, 'KiroCrew');
      await setUp(fe, checkout);
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.existsSync(path.join(checkout, 'bin', 'kirocrew')), true, 'the checkout is kept');
      assert.deepEqual(fs.readdirSync(fe.cs), ['KiroCrew']);
      assert.deepEqual(purgeLines(r.stdout), [`Purged bin, node from ${fe.cs}; kept KiroCrew (the Kiro Crew checkout)`], r.stdout);
      assert.match(r.stdout, new RegExp(`the checkout ${esc(checkout)} were kept`));
    } finally {
      fe.cleanup();
    }
  });

  it('a $CS that is a symbolic link: crew entries go, the link and its target stay, and the report says why', async () => {
    const fe = makeFakeEnv();
    try {
      const target = linkCs(fe);
      await setUp(fe, path.join(fe.root, 'KiroCrew'));
      assert.deepEqual(fs.readdirSync(target).sort(), ['bin', 'crew.json', 'node', 'run'], 'setup wrote through the link');
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.lstatSync(fe.cs).isSymbolicLink(), true, 'the link is kept');
      assert.deepEqual(fs.readdirSync(target), [], 'every crew entry is gone from the target');
      assert.deepEqual(purgeLines(r.stdout), [`Purged bin, node from ${fe.cs}; kept the directory itself (a symbolic link)`], r.stdout);
      const again = await crew(fe, ['uninstall', '--purge']);
      assert.equal(again.code, 0, again.stderr);
      assert.deepEqual(purgeLines(again.stdout), [`Nothing to purge in ${fe.cs}; kept the directory itself (a symbolic link)`], again.stdout);
    } finally {
      fe.cleanup();
    }
  });

  it('control: only crew files in $CS -> exactly "Purged $CS", $CS gone, then Nothing to purge', async () => {
    const fe = makeFakeEnv();
    try {
      await setUp(fe, path.join(fe.root, 'KiroCrew'));
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(exists(fe.cs), false);
      assert.deepEqual(purgeLines(r.stdout), [`Purged ${fe.cs}`], r.stdout);
      const again = await crew(fe, ['uninstall', '--purge']);
      assert.equal(again.code, 0, again.stderr);
      assert.match(again.stdout, /Nothing to purge: .* does not exist/);
    } finally {
      fe.cleanup();
    }
  });
});

describe('r7f crew: uninstall --purge without crew.json says "Purged $CS" only when $CS is gone', () => {
  it('a $CS that is a symbolic link: run 1 names the removed bin/, later runs say Nothing to purge', async () => {
    const fe = makeFakeEnv();
    try {
      const target = linkCs(fe);
      fs.mkdirSync(path.join(target, 'bin'));
      const r1 = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r1.code, 0, r1.stderr);
      assert.equal(exists(path.join(target, 'bin')), false, 'the empty bin/ is removed');
      assert.equal(fs.lstatSync(fe.cs).isSymbolicLink(), true, 'the link is kept');
      assert.equal(fs.statSync(target).isDirectory(), true, 'the target is kept');
      assert.deepEqual(purgeLines(r1.stdout), [`Purged bin from ${fe.cs}; kept the directory itself (a symbolic link)`], r1.stdout);
      for (let i = 0; i < 2; i++) {
        const r = await crew(fe, ['uninstall', '--purge']);
        assert.equal(r.code, 0, r.stderr);
        assert.doesNotMatch(r.stdout, new RegExp(`^Purged ${esc(fe.cs)}\\s*$`, 'm'), r.stdout);
        assert.deepEqual(purgeLines(r.stdout), [`Nothing to purge in ${fe.cs}; kept the directory itself (a symbolic link)`], r.stdout);
        assert.equal(fs.lstatSync(fe.cs).isSymbolicLink(), true);
      }
    } finally {
      fe.cleanup();
    }
  });

  it("a $CS that is a symbolic link: only crew-named entries of the target go; the user's files stay", async () => {
    const fe = makeFakeEnv();
    try {
      const target = linkCs(fe);
      fs.mkdirSync(path.join(target, 'bin'));
      fs.mkdirSync(path.join(target, 'cache', 'npm'), { recursive: true });
      fs.writeFileSync(path.join(target, 'cache', 'npm', 'blob'), 'x');
      fs.writeFileSync(path.join(target, 'notes.txt'), 'user data');
      fs.mkdirSync(path.join(target, 'project'));
      fs.writeFileSync(path.join(target, 'project', 'main.py'), 'print(1)');
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(fs.readdirSync(target).sort(), ['notes.txt', 'project']);
      assert.equal(fs.readFileSync(path.join(target, 'project', 'main.py'), 'utf8'), 'print(1)');
      assert.equal(fs.lstatSync(fe.cs).isSymbolicLink(), true);
      assert.deepEqual(purgeLines(r.stdout), [`Purged bin, cache from ${fe.cs}; kept notes.txt, project`], r.stdout);
      const again = await crew(fe, ['uninstall', '--purge']);
      assert.deepEqual(purgeLines(again.stdout), [`Nothing to purge in ${fe.cs}; kept notes.txt, project`], again.stdout);
    } finally {
      fe.cleanup();
    }
  });

  it('an empty $CS that rmdir cannot remove (EBUSY, as for a mount point) is not reported as purged', async () => {
    const fe = makeFakeEnv();
    const orig = cjsFs.rmdirSync;
    try {
      fs.mkdirSync(path.join(fe.cs, 'bin'), { recursive: true });
      // A mount point cannot be made without privileges: rmdir of exactly $CS fails as it would.
      cjsFs.rmdirSync = ((p: fs.PathLike, ...rest: unknown[]) => {
        if (path.resolve(String(p)) === fe.cs) {
          throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${String(p)}'`), { code: 'EBUSY', errno: -16, syscall: 'rmdir', path: String(p) });
        }
        return (orig as (...a: unknown[]) => void)(p, ...rest);
      }) as typeof fs.rmdirSync;
      syncBuiltinESMExports();
      const r1 = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r1.code, 0, r1.stderr);
      assert.equal(exists(path.join(fe.cs, 'bin')), false);
      assert.equal(fs.statSync(fe.cs).isDirectory(), true);
      assert.deepEqual(purgeLines(r1.stdout), [`Purged bin from ${fe.cs}; could not remove the directory itself (EBUSY)`], r1.stdout);
      const r2 = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r2.code, 0, r2.stderr);
      assert.deepEqual(purgeLines(r2.stdout), [`Nothing to purge in ${fe.cs}; could not remove the directory itself (EBUSY)`], r2.stdout);
    } finally {
      cjsFs.rmdirSync = orig;
      syncBuiltinESMExports();
      fe.cleanup();
    }
  });

  it('control: a real $CS holding an empty bin/ is removed and reported as exactly "Purged $CS"', async () => {
    const fe = makeFakeEnv();
    try {
      fs.mkdirSync(path.join(fe.cs, 'bin'), { recursive: true });
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(exists(fe.cs), false);
      assert.deepEqual(purgeLines(r.stdout), [`Purged ${fe.cs}`], r.stdout);
    } finally {
      fe.cleanup();
    }
  });

  it('the uninstall help says --purge prints what it removed and what it kept', async () => {
    const fe = makeFakeEnv();
    try {
      const r = await crew(fe, ['uninstall', '--help']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout.replace(/\s+/g, ' '), /prints? what it removed and what it kept/);
    } finally {
      fe.cleanup();
    }
  });
});
