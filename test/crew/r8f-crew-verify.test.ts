/**
 * Round 8, crew finding #3, verifier: other ways a Kiro Crew checkout inside crew's own build
 * caches or claude-agent-acp bridge was lost after the fix (r8f-crew-checkout-dirs.test.ts).
 *
 * The fix refused a `crew setup` whose OWN checkout is there and made `--purge` keep it, but a
 * build of another checkout still empties `$CS/cache/npm` and `$CS/cache/pip` afterwards, and the
 * bridge install (`npm i --prefix $CS/node`) still lets real npm remove what is not a package in
 * `node_modules`. So a checkout that an earlier kiro-claude left there (crew.json named it; the
 * refusal says to put the checkout elsewhere) was deleted by the very next `crew setup --dir
 * <elsewhere>` or `crew doctor --fix`, which reported success. Now the build and the bridge
 * install do not start while such a directory holds something that looks like a Kiro Crew
 * checkout (`bin/kirocrew` or a `.git`), and `crew setup` says so at preflight, before anything
 * is fetched or written.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildKiroCrew, installMembersAdapter } from '../../src/crew/build.js';
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

function setup(fe: FakeEnv, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return crew(fe, ['setup', '--allow-tmp', '--yes', ...args], { deps });
}

/** A built checkout at `dir` holding uncommitted work; returns the work file. */
function checkoutWithWork(fe: FakeEnv, dir: string, built = true): string {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fe.makeCheckout(dir, { built });
  const work = path.join(dir, WORK);
  fs.writeFileSync(work, 'uncommitted work');
  return work;
}

/**
 * What an earlier kiro-claude could leave: crew.json naming a checkout at `dest` (set up
 * elsewhere, then moved there and crew.json repointed). Returns the work file inside it.
 */
async function earlierSetupAt(fe: FakeEnv, dest: string): Promise<string> {
  const first = path.join(fe.root, 'first-KiroCrew');
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

/** The build commands the fake tools saw (npm ci, pip install, make). */
function buildCalls(fe: FakeEnv): string[] {
  return fe
    .calls()
    .filter((c) => (c.tool === 'npm' && c.args[0] === 'ci') || c.tool === 'pip' || c.tool === 'make')
    .map((c) => `${c.tool} ${c.args.join(' ')}`);
}

describe('r8f crew verify: a build does not empty a cache that holds a Kiro Crew checkout', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  for (const cache of ['npm', 'pip']) {
    it(`crew.json names a checkout in $CS/cache/${cache}; "setup --dir <elsewhere>" (as the refusal advises) is refused at preflight and the checkout survives`, async () => {
      const fe = fakeEnv();
      try {
        const old = path.join(fe.cs, 'cache', cache, 'KiroCrew');
        const work = await earlierSetupAt(fe, old);
        // The re-run without --dir is refused (the fix); the advice is another --dir.
        const rerun = await setup(fe, []);
        assert.equal(rerun.code, 1, `${rerun.stdout}\n${rerun.stderr}`);
        assert.match(rerun.stderr, /Put the Kiro Crew checkout elsewhere/);
        const stateFile = path.join(fe.cs, 'crew.json');
        const before = fs.readFileSync(stateFile, 'utf8');
        const elsewhere = path.join(fe.root, 'new-KiroCrew');
        fe.makeCheckout(elsewhere, { built: false });
        const callsBefore = buildCalls(fe).length;
        const r = await setup(fe, ['--dir', elsewhere]);
        assert.equal(fs.existsSync(work), true, `the earlier checkout in the ${cache} cache was deleted by the build:\n${r.stdout}\n${r.stderr}`);
        assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
        assert.match(r.stderr, new RegExp(`❌ preflight: ${esc(old)} looks like a Kiro Crew checkout \\(bin/kirocrew or \\.git\\) and is in ${esc(path.join(fe.cs, 'cache', cache))}, crew's ${cache} build cache, which the build empties\\. Move it out of there first\\.`), r.stderr);
        assert.deepEqual(buildCalls(fe).slice(callsBefore), [], 'no build command ran');
        assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'crew.json is not rewritten');
        // Once it is moved out, the setup goes on and builds.
        fs.renameSync(old, path.join(fe.root, 'moved-out'));
        const ok = await setup(fe, ['--dir', elsewhere]);
        assert.equal(ok.code, 0, `${ok.stdout}\n${ok.stderr}`);
        assert.equal(fs.existsSync(path.join(fe.root, 'moved-out', WORK)), true);
      } finally {
        fe.cleanup();
      }
    });
  }

  it('without crew.json: a checkout found by its .git in $CS/cache/pip stops a fresh setup before the fetch', async () => {
    const fe = fakeEnv();
    try {
      const stray = path.join(fe.cs, 'cache', 'pip', 'some', 'KiroCrew');
      fs.mkdirSync(path.join(stray, '.git'), { recursive: true });
      fs.writeFileSync(path.join(stray, WORK), 'w');
      const r = await setup(fe, []);
      assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, new RegExp(`preflight: ${esc(stray)} looks like a Kiro Crew checkout`));
      assert.equal(fs.readFileSync(path.join(stray, WORK), 'utf8'), 'w');
      assert.deepEqual(fe.callsOf('git').filter((c) => c.args.includes('clone') || c.args.includes('fetch')), [], 'nothing was fetched');
      assert.equal(fs.existsSync(path.join(fe.cs, 'crew.json')), false);
    } finally {
      fe.cleanup();
    }
  });

  it('control: leftovers in the caches that are no checkout do not stop the build, which still empties the caches', async () => {
    const fe = fakeEnv();
    try {
      for (const d of ['npm', 'pip']) {
        fs.mkdirSync(path.join(fe.cs, 'cache', d, '_cacache', 'tmp'), { recursive: true });
        fs.writeFileSync(path.join(fe.cs, 'cache', d, '_cacache', 'blob'), 'x');
      }
      const dir = path.join(fe.root, 'KiroCrew');
      fe.makeCheckout(dir, { built: false });
      const r = await setup(fe, ['--dir', dir]);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.notDeepEqual(buildCalls(fe), []);
      assert.equal(fs.existsSync(path.join(fe.cs, 'cache')), false, 'the build emptied its caches');
    } finally {
      fe.cleanup();
    }
  });

  it('crew doctor --fix does not rebuild over a checkout in $CS/cache/pip; the row says why', async () => {
    const fe = fakeEnv();
    try {
      const dir = path.join(fe.root, 'KiroCrew');
      fe.makeCheckout(dir, { built: true });
      const s = await setup(fe, ['--dir', dir]);
      assert.equal(s.code, 0, `${s.stdout}\n${s.stderr}`);
      const stray = path.join(fe.cs, 'cache', 'pip', 'Old');
      const work = checkoutWithWork(fe, stray);
      fs.rmSync(path.join(dir, '.venv'), { recursive: true });
      const callsBefore = buildCalls(fe).length;
      const r = await crew(fe, ['doctor', '--fix'], { deps });
      assert.equal(fs.existsSync(work), true, `doctor --fix's rebuild deleted the checkout in the pip cache:\n${r.stdout}`);
      assert.deepEqual(buildCalls(fe).slice(callsBefore), [], 'no build command ran');
      assert.match(r.stdout, new RegExp(`fixed: rebuild failed: ${esc(stray)} looks like a Kiro Crew checkout`), r.stdout);
    } finally {
      fe.cleanup();
    }
  });
});

describe('r8f crew verify: the bridge install does not run while $CS/node holds a Kiro Crew checkout', () => {
  it('crew setup that would install the bridge is refused at preflight; npm is never called', { skip: PY ? false : 'no python3 with sqlite3' }, async () => {
    const fe = fakeEnv();
    try {
      const old = path.join(fe.cs, 'node', 'node_modules', 'KiroCrew');
      const work = checkoutWithWork(fe, old);
      const dir = path.join(fe.root, 'KiroCrew');
      fe.makeCheckout(dir, { built: true });
      const r = await setup(fe, ['--dir', dir]);
      assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, new RegExp(`❌ preflight: ${esc(old)} looks like a Kiro Crew checkout \\(bin/kirocrew or \\.git\\) and is in ${esc(path.join(fe.cs, 'node'))}, crew's claude-agent-acp bridge, where npm removes what is not a package when it installs the bridge\\. Move it out of there first\\.`), r.stderr);
      assert.deepEqual(fe.callsOf('npm'), []);
      assert.equal(fs.existsSync(work), true);
      // --members none needs no bridge: that setup goes on.
      const none = await setup(fe, ['--dir', dir, '--members', 'none']);
      assert.equal(none.code, 0, `${none.stdout}\n${none.stderr}`);
      assert.equal(fs.existsSync(work), true);
    } finally {
      fe.cleanup();
    }
  });

  it('installMembersAdapter (also crew doctor --fix\'s forced reinstall) and buildKiroCrew throw before any command', async () => {
    const root = removeOnExit(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kc-r8f-crew-verify-')));
    const env = { HOME: root, KIRO_CLAUDE_CREW_HOME: path.join(root, 'crew') };
    const paths = crewPaths(env);
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
    const inBridge = path.join(paths.membersPrefix, 'node_modules', 'KiroCrew');
    fs.mkdirSync(path.join(inBridge, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(inBridge, 'bin', 'kirocrew'), '#!/bin/sh\n');
    await assert.rejects(
      installMembersAdapter({ runner, npm: 'npm', env, paths, force: true }),
      (e: unknown) => e instanceof CrewStepError && e.step === 'members' && e.message.startsWith(`${inBridge} looks like a Kiro Crew checkout`),
    );
    const inCache = path.join(paths.npmCache, 'x', 'KiroCrew');
    fs.mkdirSync(inCache, { recursive: true });
    fs.writeFileSync(path.join(inCache, '.git'), 'gitdir: /elsewhere\n');
    const dir = path.join(root, 'KiroCrew');
    fs.mkdirSync(path.join(dir, 'website'), { recursive: true });
    for (const kind of ['light', 'full'] as const) {
      await assert.rejects(
        buildKiroCrew({ dir, kind, python: '/usr/bin/python3', npm: 'npm', runner, env, paths }),
        (e: unknown) => e instanceof CrewStepError && e.step === 'build' && e.message.startsWith(`${inCache} looks like a Kiro Crew checkout`),
      );
    }
    assert.deepEqual(ran, []);
    assert.equal(fs.existsSync(path.join(inCache, '.git')), true);
    assert.equal(fs.existsSync(path.join(inBridge, 'bin', 'kirocrew')), true);
  });
});

describe('r8f crew verify: the docs describe what a refused setup writes and the build keep rule', () => {
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

  it('ARCHITECTURE.md: only run/setup.log is written before the refusal; the build and the bridge install refuse a checkout in their directories', () => {
    const arch = fs.readFileSync(path.join(repoRoot(), 'docs', 'ARCHITECTURE.md'), 'utf8');
    const where = flat(arch.split(/\n\n/).find((p) => p.startsWith('**Where the checkout may live.**')) ?? '');
    assert.doesNotMatch(where, /before anything is written/);
    assert.match(where, /only `run\/setup\.log` is written before/);
    assert.match(where, /looks like a Kiro Crew checkout \(`bin\/kirocrew` or a `\.git`\)/);
    const readme = flat(fs.readFileSync(path.join(repoRoot(), 'README.md'), 'utf8'));
    assert.match(readme, /nor does it build or install the bridge while one of them holds a Kiro Crew checkout/);
  });

  it('crew setup --help says setup does not build or install the bridge over a checkout there', async () => {
    const fe = fakeEnv();
    try {
      const s = await crew(fe, ['setup', '--help']);
      assert.equal(s.code, 0);
      assert.match(flat(s.stdout), /setup does not build while those caches, or install the bridge while node\/, hold a Kiro Crew checkout\./);
    } finally {
      fe.cleanup();
    }
  });
});
