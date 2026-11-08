/**
 * Round 8, group crew, finding #3: `crew uninstall --purge` removed the npm and pip build caches
 * (`$CS/cache/npm`, `$CS/cache/pip`) and the claude-agent-acp bridge prefix (`$CS/node`, whenever
 * its package.json and top-level entries are crew's) recursively, without looking for the Kiro
 * Crew checkout, and setup accepted a `--dir` inside them. A checkout there was deleted while the
 * report said "the checkout ... were kept".
 *
 * Fixed in two layers:
 * 1. `crew setup` refuses a checkout (`--dir`, KIRO_CLAUDE_CREW_DIR, or the one an earlier setup
 *    recorded) that is or is inside one of these directories, compared as given and by real
 *    path, before anything is written; the build itself (also run by `crew doctor --fix`) does not
 *    start in one.
 * 2. Both purge paths keep a target that is or holds the checkout crew.json names (resolved and
 *    real paths), or any directory in it that looks like a Kiro Crew checkout (bin/kirocrew or a
 *    .git; symbolic links are not followed), and the report lists it as kept and labelled. The
 *    closing line says the checkout was kept only while it exists.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildKiroCrew } from '../../src/crew/build.js';
import { CrewStepError } from '../../src/crew/fetch.js';
import { crewPaths } from '../../src/crew/paths.js';
import { defaultSys, type CrewRunner, type RunResult } from '../../src/crew/runner.js';
import { removeOnExit } from '../tmpdirs.js';
import { crew, makeFakeEnv, realPython, type FakeEnv } from './helpers.js';

const PY = realPython();
const deps = { sys: { ...defaultSys, freeBytes: () => 64 * 1024 ** 3 } };
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORK = 'MY-LOCAL-WORK.txt';

function fakeEnv(): FakeEnv {
  const fe = makeFakeEnv();
  removeOnExit(fe.root);
  fs.writeFileSync(path.join(fe.home, '.fake-claude-login'), '');
  return fe;
}

/** The lines of `stdout` that report the purge. */
function purgeLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => /^(Purged |Nothing to purge)/.test(l));
}

function setup(fe: FakeEnv, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return crew(fe, ['setup', '--allow-tmp', '--yes', ...args], { deps, env });
}

/** A built checkout at `dir` holding uncommitted work; returns the work file. */
function checkoutWithWork(fe: FakeEnv, dir: string): string {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fe.makeCheckout(dir, { built: true });
  const work = path.join(dir, WORK);
  fs.writeFileSync(work, 'uncommitted work');
  return work;
}

/**
 * A crew.json naming a checkout at `dest` as an earlier kiro-claude (without the setup check)
 * could write it: setup with a checkout elsewhere, then the checkout moved to `dest` and
 * crew.json's kirocrew.dir pointed there. Returns the work file inside the checkout.
 */
async function setUpThenMove(fe: FakeEnv, dest: string): Promise<string> {
  const first = path.join(fe.root, 'KiroCrew');
  fe.makeCheckout(first, { built: true });
  const s = await setup(fe, ['--dir', first]);
  assert.equal(s.code, 0, `${s.stdout}\n${s.stderr}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(first, dest);
  const stateFile = path.join(fe.cs, 'crew.json');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { kirocrew: { dir: string } };
  st.kirocrew.dir = dest;
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), { mode: 0o600 });
  const work = path.join(dest, WORK);
  fs.writeFileSync(work, 'uncommitted work');
  return work;
}

describe('r8f crew: setup refuses a checkout inside crew\'s build caches or bridge prefix', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  const cases: Array<[string, RegExp]> = [
    ['cache/npm/KiroCrew', /crew's npm build cache/],
    ['cache/pip/KiroCrew', /crew's pip build cache/],
    ['cache/npm', /crew's npm build cache/],
    ['node', /crew's claude-agent-acp bridge/],
    ['node/node_modules/KiroCrew', /crew's claude-agent-acp bridge/],
  ];
  for (const [rel, what] of cases) {
    it(`--dir $CS/${rel}: exit 1 at preflight, naming why; nothing written or removed`, async () => {
      const fe = fakeEnv();
      try {
        const dir = path.join(fe.cs, ...rel.split('/'));
        const work = checkoutWithWork(fe, dir);
        const r = await setup(fe, ['--dir', dir]);
        assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
        // r9 #5: the bridge prefix is refused only as itself ("is $CS/node"); what npm prunes is its node_modules.
        const held = rel === 'node' ? `is ${esc(path.join(fe.cs, 'node'))}` : `is in ${esc(path.join(fe.cs, ...(rel.startsWith('node') ? ['node', 'node_modules'] : rel.split('/').slice(0, 2))))}`;
        assert.match(r.stderr, new RegExp(`❌ preflight: ${esc(dir)} ${held}, `), r.stderr);
        assert.match(r.stderr, what, r.stderr);
        assert.match(r.stderr, /Put the Kiro Crew checkout elsewhere \(--dir <path>, or KIRO_CLAUDE_CREW_DIR\)/, r.stderr);
        assert.equal(fs.readFileSync(work, 'utf8'), 'uncommitted work', 'the checkout is untouched');
        assert.equal(fs.existsSync(path.join(fe.cs, 'crew.json')), false, 'no crew.json is written');
        assert.equal(fs.existsSync(path.join(fe.cs, 'bin', 'kiro-claude')), false, 'no shim is written');
        assert.deepEqual(fe.callsOf('npm'), [], 'neither the build nor the bridge install ran');
      } finally {
        fe.cleanup();
      }
    });
  }

  it('a second setup moving the checkout into the installed bridge ($CS/node/node_modules/KiroCrew) is refused; crew.json keeps the first', async () => {
    const fe = fakeEnv();
    try {
      const first = await setup(fe, []);
      assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
      const stateFile = path.join(fe.cs, 'crew.json');
      const before = fs.readFileSync(stateFile, 'utf8');
      const dir = path.join(fe.cs, 'node', 'node_modules', 'KiroCrew');
      const work = checkoutWithWork(fe, dir);
      const r = await setup(fe, ['--dir', dir]);
      assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, new RegExp(`preflight: ${esc(dir)} is in ${esc(path.join(fe.cs, 'node', 'node_modules'))}, crew's claude-agent-acp bridge`));
      assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'crew.json still names the first checkout');
      assert.equal(fs.existsSync(work), true);
    } finally {
      fe.cleanup();
    }
  });

  it('KIRO_CLAUDE_CREW_DIR inside the pip cache is refused the same way', async () => {
    const fe = fakeEnv();
    try {
      const dir = path.join(fe.cs, 'cache', 'pip', 'KiroCrew');
      const work = checkoutWithWork(fe, dir);
      const r = await setup(fe, [], { KIRO_CLAUDE_CREW_DIR: dir });
      assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /crew's pip build cache/);
      assert.equal(fs.existsSync(work), true);
      assert.equal(fs.existsSync(path.join(fe.cs, 'crew.json')), false);
    } finally {
      fe.cleanup();
    }
  });

  it('a --dir that reaches the bridge prefix through a symbolic link is refused (real path)', async () => {
    const fe = fakeEnv();
    try {
      const real = path.join(fe.cs, 'node', 'node_modules', 'KiroCrew');
      const work = checkoutWithWork(fe, real);
      const link = path.join(fe.root, 'link-to-bridge');
      fs.symlinkSync(path.join(fe.cs, 'node'), link);
      const r = await setup(fe, ['--dir', path.join(link, 'node_modules', 'KiroCrew')]);
      assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /crew's claude-agent-acp bridge/);
      assert.equal(fs.existsSync(work), true);
      assert.deepEqual(fe.callsOf('npm'), []);
    } finally {
      fe.cleanup();
    }
  });

  it('a re-run without --dir of a setup that recorded such a checkout is refused; crew.json is unchanged', async () => {
    const fe = fakeEnv();
    try {
      const dest = path.join(fe.cs, 'cache', 'npm', 'KiroCrew');
      const work = await setUpThenMove(fe, dest);
      const stateFile = path.join(fe.cs, 'crew.json');
      const before = fs.readFileSync(stateFile, 'utf8');
      const r = await setup(fe, []);
      assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, new RegExp(`preflight: ${esc(dest)} is in ${esc(path.join(fe.cs, 'cache', 'npm'))}, crew's npm build cache`));
      assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
      assert.equal(fs.existsSync(work), true);
    } finally {
      fe.cleanup();
    }
  });

  it('control: --dir $CS/cache/KiroCrew (beside the caches) is accepted, and --purge keeps it labelled', async () => {
    const fe = fakeEnv();
    try {
      const dir = path.join(fe.cs, 'cache', 'KiroCrew');
      const work = checkoutWithWork(fe, dir);
      const s = await setup(fe, ['--dir', dir]);
      assert.equal(s.code, 0, `${s.stdout}\n${s.stderr}`);
      const r = await crew(fe, ['uninstall', '--purge'], { deps });
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.existsSync(work), true);
      assert.deepEqual(purgeLines(r.stdout), [`Purged bin, node from ${fe.cs}; kept cache (holds the Kiro Crew checkout)`], r.stdout);
      assert.match(r.stdout, new RegExp(`the checkout ${esc(dir)} were kept\\.`));
    } finally {
      fe.cleanup();
    }
  });
});

describe('r8f crew: the build does not start inside crew\'s caches (crew doctor --fix rebuilds too)', () => {
  it('buildKiroCrew in $CS/cache/pip/KiroCrew fails before any command; the checkout survives', async () => {
    const root = removeOnExit(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kc-r8f-crew-build-')));
    const env = { HOME: root, KIRO_CLAUDE_CREW_HOME: path.join(root, 'crew') };
    const paths = crewPaths(env);
    const dir = path.join(paths.pipCache, 'KiroCrew');
    fs.mkdirSync(path.join(dir, 'website'), { recursive: true });
    fs.writeFileSync(path.join(dir, WORK), 'uncommitted work');
    const ran: string[] = [];
    const ok: RunResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 0 };
    const runner: CrewRunner = {
      run: async (file, args) => {
        ran.push([file, ...args].join(' '));
        return ok;
      },
      spawnDetached: () => {
        throw new Error('not used');
      },
    };
    for (const kind of ['light', 'full'] as const) {
      await assert.rejects(
        buildKiroCrew({ dir, kind, python: '/usr/bin/python3', npm: 'npm', runner, env, paths }),
        (e: unknown) => e instanceof CrewStepError && e.step === 'build' && /is in .*cache\/pip, crew's pip build cache/.test(e.message),
      );
    }
    assert.deepEqual(ran, [], 'no build command ran');
    assert.equal(fs.readFileSync(path.join(dir, WORK), 'utf8'), 'uncommitted work');
  });
});

describe('r8f crew: uninstall --purge with crew.json never removes the checkout it names', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  const cases: Array<[string, string, string]> = [
    // [checkout under $CS, the other crew cache (removed), purge line after `Purged `]
    ['cache/pip/KiroCrew', 'cache/npm', 'bin, cache/npm, node from {CS}; kept cache (holds the Kiro Crew checkout)'],
    ['cache/npm/KiroCrew', 'cache/pip', 'bin, cache/pip, node from {CS}; kept cache (holds the Kiro Crew checkout)'],
    ['node/node_modules/KiroCrew', 'cache/npm', 'bin, cache from {CS}; kept node (holds the Kiro Crew checkout)'],
  ];
  for (const [rel, other, line] of cases) {
    it(`checkout at $CS/${rel}: kept, labelled, "were kept" true; ${other} still goes; a second purge keeps it too`, async () => {
      const fe = fakeEnv();
      try {
        const dest = path.join(fe.cs, ...rel.split('/'));
        const work = await setUpThenMove(fe, dest);
        fs.mkdirSync(path.join(fe.cs, ...other.split('/')), { recursive: true });
        fs.writeFileSync(path.join(fe.cs, ...other.split('/'), 'blob'), 'x');
        const r = await crew(fe, ['uninstall', '--purge'], { deps });
        assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
        assert.equal(fs.readFileSync(work, 'utf8'), 'uncommitted work', `the checkout crew.json names is kept:\n${r.stdout}`);
        assert.equal(fs.existsSync(path.join(dest, 'bin', 'kirocrew')), true);
        assert.equal(fs.existsSync(path.join(fe.cs, ...other.split('/'))), false, `${other} is crew's and goes`);
        assert.deepEqual(purgeLines(r.stdout), [`Purged ${line.replace('{CS}', fe.cs)}`], r.stdout);
        assert.match(r.stdout, new RegExp(`^Kiro Crew's data home and the checkout ${esc(dest)} were kept\\.$`, 'm'));
        // Without crew.json now: the checkout is found by its bin/kirocrew and kept again.
        const again = await crew(fe, ['uninstall', '--purge'], { deps });
        assert.equal(again.code, 0, again.stderr);
        assert.equal(fs.existsSync(work), true, again.stdout);
        const top = rel.split('/')[0]!;
        assert.deepEqual(purgeLines(again.stdout), [`Nothing to purge in ${fe.cs}; kept ${top} (holds a Kiro Crew checkout)`], again.stdout);
      } finally {
        fe.cleanup();
      }
    });
  }

  it('the named checkout is matched by real path (a $CS that is a symbolic link), even without bin/kirocrew or .git', async () => {
    const fe = fakeEnv();
    try {
      const target = path.join(fe.root, 'other-disk', 'crew');
      fs.mkdirSync(target, { recursive: true });
      fs.mkdirSync(path.dirname(fe.cs), { recursive: true });
      fs.symlinkSync(target, fe.cs);
      const realDest = path.join(target, 'cache', 'pip', 'KiroCrew');
      const work = await setUpThenMove(fe, realDest);
      // Only crew.json's word makes it the checkout now (no bin/kirocrew, .venv/bin/kirocrew or .git).
      for (const d of ['bin', '.venv', '.git']) fs.rmSync(path.join(realDest, d), { recursive: true });
      const r = await crew(fe, ['uninstall', '--purge'], { deps });
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.existsSync(work), true, r.stdout);
      assert.deepEqual(purgeLines(r.stdout), [`Purged bin, node from ${fe.cs}; kept cache (holds the Kiro Crew checkout)`], r.stdout);
      assert.match(r.stdout, new RegExp(`the checkout ${esc(realDest)} were kept\\.`));
    } finally {
      fe.cleanup();
    }
  });

  it('a cache that is a symbolic link to the directory holding the named checkout stays and is labelled', async () => {
    const fe = fakeEnv();
    try {
      const elsewhere = path.join(fe.root, 'elsewhere', 'pip');
      const dest = path.join(elsewhere, 'KiroCrew');
      const work = await setUpThenMove(fe, dest);
      fs.mkdirSync(path.join(fe.cs, 'cache'), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(fe.cs, 'cache', 'pip'));
      const r = await crew(fe, ['uninstall', '--purge'], { deps });
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.existsSync(work), true);
      assert.equal(fs.lstatSync(path.join(fe.cs, 'cache', 'pip')).isSymbolicLink(), true, 'the link that reaches the checkout is kept');
      assert.deepEqual(purgeLines(r.stdout), [`Purged bin, node from ${fe.cs}; kept cache (holds the Kiro Crew checkout)`], r.stdout);
    } finally {
      fe.cleanup();
    }
  });

  for (const args of [['uninstall'], ['uninstall', '--purge']]) {
    it(`${args.join(' ')}: a checkout crew.json names that no longer exists is not said to be kept`, async () => {
      const fe = fakeEnv();
      try {
        const dir = path.join(fe.root, 'KiroCrew');
        fe.makeCheckout(dir, { built: true });
        const s = await setup(fe, ['--dir', dir]);
        assert.equal(s.code, 0, `${s.stdout}\n${s.stderr}`);
        fs.rmSync(dir, { recursive: true });
        const r = await crew(fe, args, { deps });
        assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
        assert.doesNotMatch(r.stdout, /were kept/, r.stdout);
        assert.match(r.stdout, new RegExp(`^Kiro Crew's data home was kept; the checkout ${esc(dir)} does not exist\\.$`, 'm'));
      } finally {
        fe.cleanup();
      }
    });
  }
});

describe('r8f crew: uninstall --purge without crew.json keeps a target that holds a Kiro Crew checkout', () => {
  /** What a plain uninstall leaves: an empty bin/, crew's own bridge, the two caches with a blob. */
  function leftovers(fe: FakeEnv): void {
    fs.mkdirSync(path.join(fe.cs, 'bin'), { recursive: true });
    const bridge = path.join(fe.cs, 'node');
    fs.mkdirSync(path.join(bridge, 'node_modules', '@agentclientprotocol', 'claude-agent-acp'), { recursive: true });
    fs.writeFileSync(path.join(bridge, 'package.json'), JSON.stringify({ dependencies: { '@agentclientprotocol/claude-agent-acp': '^0.101.0' } }));
    fs.writeFileSync(path.join(bridge, 'package-lock.json'), '{}');
    for (const d of ['npm', 'pip']) {
      fs.mkdirSync(path.join(fe.cs, 'cache', d), { recursive: true });
      fs.writeFileSync(path.join(fe.cs, 'cache', d, 'blob'), 'x');
    }
  }

  it('a checkout found by bin/kirocrew deep in cache/pip and by a .git in node_modules: both kept and labelled; the npm cache goes', async () => {
    const fe = fakeEnv();
    try {
      leftovers(fe);
      const a = path.join(fe.cs, 'cache', 'pip', 'some', 'where', 'KiroCrew');
      fs.mkdirSync(path.join(a, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(a, 'bin', 'kirocrew'), '#!/bin/sh\n');
      fs.writeFileSync(path.join(a, WORK), 'a');
      const b = path.join(fe.cs, 'node', 'node_modules', 'KiroCrew');
      fs.mkdirSync(path.join(b, '.git'), { recursive: true });
      fs.writeFileSync(path.join(b, WORK), 'b');
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.readFileSync(path.join(a, WORK), 'utf8'), 'a');
      assert.equal(fs.readFileSync(path.join(b, WORK), 'utf8'), 'b');
      assert.equal(fs.existsSync(path.join(fe.cs, 'cache', 'npm')), false, 'the npm cache holds no checkout and goes');
      assert.deepEqual(purgeLines(r.stdout), [`Purged bin, cache/npm from ${fe.cs}; kept cache (holds a Kiro Crew checkout), node (holds a Kiro Crew checkout)`], r.stdout);
      assert.match(r.stdout, /^Kiro Crew's data home and any Kiro Crew checkout were kept\.$/m);
      const again = await crew(fe, ['uninstall', '--purge']);
      assert.equal(again.code, 0, again.stderr);
      assert.deepEqual(purgeLines(again.stdout), [`Nothing to purge in ${fe.cs}; kept cache (holds a Kiro Crew checkout), node (holds a Kiro Crew checkout)`], again.stdout);
    } finally {
      fe.cleanup();
    }
  });

  it('a .git file (a submodule or worktree checkout) in the npm cache keeps it', async () => {
    const fe = fakeEnv();
    try {
      leftovers(fe);
      const a = path.join(fe.cs, 'cache', 'npm', 'KiroCrew');
      fs.mkdirSync(a, { recursive: true });
      fs.writeFileSync(path.join(a, '.git'), 'gitdir: /elsewhere/.git/modules/KiroCrew\n');
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.existsSync(path.join(a, '.git')), true);
      assert.deepEqual(purgeLines(r.stdout), [`Purged bin, cache/pip, node from ${fe.cs}; kept cache (holds a Kiro Crew checkout)`], r.stdout);
    } finally {
      fe.cleanup();
    }
  });

  it('a symbolic link in a cache to a checkout elsewhere is not followed: the cache goes, the checkout stays', async () => {
    const fe = fakeEnv();
    try {
      leftovers(fe);
      const elsewhere = path.join(fe.root, 'elsewhere', 'KiroCrew');
      fs.mkdirSync(path.join(elsewhere, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(elsewhere, 'bin', 'kirocrew'), '#!/bin/sh\n');
      fs.writeFileSync(path.join(elsewhere, WORK), 'w');
      fs.symlinkSync(elsewhere, path.join(fe.cs, 'cache', 'pip', 'KiroCrew'));
      const r = await crew(fe, ['uninstall', '--purge']);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.equal(fs.readFileSync(path.join(elsewhere, WORK), 'utf8'), 'w', 'the link target is untouched');
      assert.deepEqual(purgeLines(r.stdout), [`Purged ${fe.cs}`], r.stdout);
    } finally {
      fe.cleanup();
    }
  });
});

describe('r8f crew: the help and docs describe where the checkout may live and what --purge keeps', () => {
  function repoRoot(): string {
    let dir = process.cwd();
    for (;;) {
      if (fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md')) && fs.existsSync(path.join(dir, 'README.md'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error('run the tests from the repository root');
      dir = parent;
    }
  }
  const flat = (s: string): string => s.replace(/\s+/g, ' ');

  it('setup --help names the refused places; uninstall --help says a cache or bridge holding a checkout is kept', async () => {
    const fe = fakeEnv();
    try {
      const s = await crew(fe, ['setup', '--help']);
      assert.equal(s.code, 0);
      // r9 #5: of the bridge, node/node_modules and node/ itself (a directory beside node_modules is fine).
      assert.match(flat(s.stdout), /must not be in a linked git worktree, nor under the system temp directory without --allow-tmp, nor in crew's build caches \(cache\/npm, cache\/pip\) in the crew state directory, which every build empties, nor in node\/node_modules, where npm keeps only packages when it installs the claude-agent-acp bridge, nor be node\/ itself/);
      const u = await crew(fe, ['uninstall', '--help']);
      assert.equal(u.code, 0);
      assert.match(flat(u.stdout), /A cache or the bridge that holds a Kiro Crew checkout is kept\./);
    } finally {
      fe.cleanup();
    }
  });

  it('README and ARCHITECTURE.md state both rules', () => {
    const root = repoRoot();
    const readme = flat(fs.readFileSync(path.join(root, 'README.md'), 'utf8'));
    assert.match(readme, /Setup refuses a checkout inside crew's own build caches \(`cache\/npm`, `cache\/pip`; every build empties them\) or the claude-agent-acp bridge's `node\/node_modules` \(npm keeps only packages there\), or at the bridge prefix `node\/` itself/);
    assert.match(readme, /a cache or the bridge that holds a Kiro Crew checkout stays, and is named as such/);
    const arch = fs.readFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');
    const where = flat(arch.split(/\n\n/).find((p) => p.startsWith('**Where the checkout may live.**')) ?? '');
    assert.match(where, /is or is inside one of crew's own directories under the state directory, compared as given and by real path/);
    assert.match(where, /`crewDirHolding`/);
    const un = flat(arch.split(/\n\n/).find((p) => p.startsWith('**Uninstalling.**')) ?? '');
    assert.match(un, /a cache or the bridge that is or holds the checkout `crew\.json` names \(compared as given and by real path\), or a directory that looks like a Kiro Crew checkout \(it has `bin\/kirocrew` or a `\.git`; symbolic links are not followed\), is not removed/);
    assert.match(un, /`cache \(holds a Kiro Crew checkout\)`/);
    assert.match(un, /The closing line says the checkout was kept only while it exists/);
  });
});
