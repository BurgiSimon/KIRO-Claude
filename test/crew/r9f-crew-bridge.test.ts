/**
 * Round 9, crew finding #5: what crew's claude-agent-acp bridge owns in `$CS/node` is what npm
 * touches there. `npm i --prefix $CS/node <bridge>` prunes `$CS/node/node_modules` (it keeps only
 * packages there) and writes `package.json` and `package-lock.json` beside it; a directory
 * directly in `$CS/node`, beside node_modules, is left alone, and `crew uninstall --purge` keeps
 * all of `$CS/node` while it holds anything but the bridge. crew treated all of `$CS/node` as at
 * risk: `crew setup --dir $CS/node/KiroCrew` (an earlier kiro-claude allowed it) was refused, and
 * while such a checkout existed every setup that installs the bridge, and doctor --fix's
 * reinstall, stopped, with a reason that is not true ("npm removes what is not a package there").
 * Now setup refuses `$CS/node` itself, its node_modules and what is in it, and npm's two files
 * there, each with its true reason; the bridge install waits only while node_modules holds a Kiro
 * Crew checkout or `$CS/node` itself is one. A purge that keeps `$CS/node` for a checkout beside
 * node_modules labels it.
 *
 * The real-npm part drives crew itself (setup, a bridge pin change, doctor --fix, uninstall and
 * both purge paths) with the npm next to this node, against a local registry serving a stand-in
 * bridge package (no network); it is skipped when that npm does not run.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CrewStepError } from '../../src/crew/fetch.js';
import { crewDirCheckout, crewDirHolding, installMembersAdapter, membersAdapterVersion } from '../../src/crew/build.js';
import { crewPaths } from '../../src/crew/paths.js';
import { CLAUDE_AGENT_ACP } from '../../src/crew/pin.js';
import { defaultSys, type CrewRunner, type RunResult } from '../../src/crew/runner.js';
import { removeOnExit } from '../tmpdirs.js';
import { crew, makeFakeEnv, realPython, type FakeEnv } from './helpers.js';

const PY = realPython();
const deps = { sys: { ...defaultSys, freeBytes: () => 64 * 1024 ** 3 } };
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const flat = (s: string): string => s.replace(/\s+/g, ' ');
const WORK = 'MY-LOCAL-WORK.txt';
const SCRATCH = removeOnExit(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'kc-r9f-crew-')));

function fakeEnv(opts: { tools?: string[] } = {}): FakeEnv {
  const fe = makeFakeEnv(opts);
  removeOnExit(fe.root);
  fs.writeFileSync(path.join(fe.home, '.fake-claude-login'), '');
  return fe;
}

function setup(fe: FakeEnv, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return crew(fe, ['setup', '--allow-tmp', '--yes', ...args], { deps });
}

/** A built checkout at `dir` holding uncommitted work; returns the work file. */
function checkoutWithWork(fe: FakeEnv, dir: string): string {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fe.makeCheckout(dir, { built: true });
  const work = path.join(dir, WORK);
  fs.writeFileSync(work, 'uncommitted work');
  return work;
}

/** Every part of the checkout at `dir` that marks it and holds work is still there. */
function intact(dir: string): boolean {
  return fs.existsSync(path.join(dir, WORK)) && fs.existsSync(path.join(dir, '.git', 'FAKE_HEAD')) && fs.existsSync(path.join(dir, 'bin', 'kirocrew'));
}

/** The lines of `stdout` that report the purge. */
function purgeLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => /^(Purged |Nothing to purge)/.test(l));
}

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md')) && fs.existsSync(path.join(dir, 'README.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

describe('r9f crew: a Kiro Crew checkout directly in $CS/node, beside node_modules, is not crew\'s', { skip: PY ? false : 'no python3 with sqlite3' }, () => {
  it('a setup with its checkout elsewhere installs the bridge while $CS/node/KiroCrew exists; both purge paths keep it, labelled', async () => {
    const fe = fakeEnv();
    const old = path.join(fe.cs, 'node', 'KiroCrew');
    checkoutWithWork(fe, old);
    const dir = path.join(fe.root, 'KC');
    fe.makeCheckout(dir, { built: true });
    const r = await setup(fe, ['--dir', dir]);
    assert.doesNotMatch(r.stderr, /npm removes what is not a package/, 'npm never touches $CS/node/KiroCrew');
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(
      fe.callsOf('npm').map((c) => c.args.slice(0, 3)),
      [['i', '--prefix', path.join(fe.cs, 'node')]],
      'the bridge install ran',
    );
    assert.equal(fs.existsSync(path.join(fe.cs, 'node', 'node_modules', ...CLAUDE_AGENT_ACP.name.split('/'), ...CLAUDE_AGENT_ACP.entry.split('/'))), true);
    assert.equal(intact(old), true);
    // crew.json names the checkout elsewhere: node/ is kept (it holds more than the bridge), and says why.
    const u = await crew(fe, ['uninstall', '--purge'], { deps });
    assert.equal(u.code, 0, `${u.stdout}\n${u.stderr}`);
    assert.deepEqual(purgeLines(u.stdout), [`Purged bin from ${fe.cs}; kept node (holds a Kiro Crew checkout)`], u.stdout);
    assert.equal(intact(old), true);
    // Without crew.json: the same.
    const again = await crew(fe, ['uninstall', '--purge'], { deps });
    assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`);
    assert.deepEqual(purgeLines(again.stdout), [`Nothing to purge in ${fe.cs}; kept node (holds a Kiro Crew checkout)`], again.stdout);
    assert.equal(intact(old), true);
  });

  it('crew setup --dir $CS/node/KiroCrew is accepted (also re-run without --dir); --purge keeps node, labelled as holding the checkout', async () => {
    const fe = fakeEnv();
    const dir = path.join(fe.cs, 'node', 'KiroCrew');
    checkoutWithWork(fe, dir);
    const r = await setup(fe, ['--dir', dir]);
    assert.doesNotMatch(r.stderr, /npm removes what is not a package there/, r.stderr);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    const st = JSON.parse(fs.readFileSync(path.join(fe.cs, 'crew.json'), 'utf8')) as { kirocrew: { dir: string } };
    assert.equal(st.kirocrew.dir, dir);
    assert.equal(fe.callsOf('npm').length, 1, 'the bridge was installed beside the checkout');
    const rerun = await setup(fe, []);
    assert.equal(rerun.code, 0, `${rerun.stdout}\n${rerun.stderr}`);
    assert.equal(intact(dir), true);
    const u = await crew(fe, ['uninstall', '--purge'], { deps });
    assert.equal(u.code, 0, `${u.stdout}\n${u.stderr}`);
    assert.deepEqual(purgeLines(u.stdout), [`Purged bin from ${fe.cs}; kept node (holds the Kiro Crew checkout)`], u.stdout);
    assert.match(u.stdout, new RegExp(`^Kiro Crew's data home and the checkout ${esc(dir)} were kept\\.$`, 'm'));
    assert.equal(intact(dir), true);
  });

  const refused: Array<[string, (cs: string, dir: string) => string]> = [
    ['node', (cs, dir) => `${dir} is ${path.join(cs, 'node')}, crew's claude-agent-acp bridge prefix: npm writes the bridge's package.json, package-lock.json and node_modules there when it installs the bridge.`],
    ['node/node_modules', (cs, dir) => `${dir} is in ${path.join(cs, 'node', 'node_modules')}, crew's claude-agent-acp bridge: npm removes what is not a package there when it installs the bridge.`],
    ['node/node_modules/KiroCrew', (cs, dir) => `${dir} is in ${path.join(cs, 'node', 'node_modules')}, crew's claude-agent-acp bridge: npm removes what is not a package there when it installs the bridge.`],
    ['node/package.json/KiroCrew', (cs, dir) => `${dir} is in ${path.join(cs, 'node')}, crew's claude-agent-acp bridge prefix: npm writes the bridge's package.json, package-lock.json and node_modules there when it installs the bridge.`],
    ['node/package-lock.json', (cs, dir) => `${dir} is in ${path.join(cs, 'node')}, crew's claude-agent-acp bridge prefix: npm writes the bridge's package.json, package-lock.json and node_modules there when it installs the bridge.`],
  ];
  for (const [rel, reason] of refused) {
    it(`--dir $CS/${rel} is still refused at preflight, with the true reason; nothing written`, async () => {
      const fe = fakeEnv();
      const dir = path.join(fe.cs, ...rel.split('/'));
      checkoutWithWork(fe, dir);
      const r = await setup(fe, ['--dir', dir]);
      assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, new RegExp(`❌ preflight: ${esc(reason(fe.cs, dir))} Put the Kiro Crew checkout elsewhere`), r.stderr);
      assert.equal(intact(dir), true);
      assert.equal(fs.existsSync(path.join(fe.cs, 'crew.json')), false);
      assert.deepEqual(fe.callsOf('npm'), []);
    });
  }

  it('$CS/node that is itself a Kiro Crew checkout (an earlier kiro-claude\'s) stops the bridge install, with the true reason', async () => {
    const fe = fakeEnv();
    const prefix = path.join(fe.cs, 'node');
    checkoutWithWork(fe, prefix);
    const dir = path.join(fe.root, 'KC');
    fe.makeCheckout(dir, { built: true });
    const r = await setup(fe, ['--dir', dir]);
    assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(
      r.stderr,
      new RegExp(`❌ preflight: ${esc(prefix)} looks like a Kiro Crew checkout \\(bin/kirocrew or \\.git\\) and is crew's claude-agent-acp bridge prefix, where npm writes the bridge's package\\.json, package-lock\\.json and node_modules when it installs the bridge\\. Move it out of there first\\.`),
      r.stderr,
    );
    assert.deepEqual(fe.callsOf('npm'), []);
    assert.equal(intact(prefix), true);
    // The purge without crew.json keeps it and says what it is (run/ holds the refused setup's log).
    const p = await crew(fe, ['uninstall', '--purge'], { deps });
    assert.equal(p.code, 0, `${p.stdout}\n${p.stderr}`);
    assert.deepEqual(purgeLines(p.stdout), [`Purged run from ${fe.cs}; kept node (a Kiro Crew checkout)`], p.stdout);
    assert.equal(intact(prefix), true);
  });
});

describe('r9f crew: crewDirHolding and crewDirCheckout name only what npm touches in $CS/node', () => {
  const root = path.join(SCRATCH, 'unit');
  const env = { HOME: root, KIRO_CLAUDE_CREW_HOME: path.join(root, 'crew') };
  const paths = crewPaths(env);

  it('crewDirHolding: node/ itself, node_modules and npm\'s two files, also through a symbolic link; not a directory beside node_modules', () => {
    fs.mkdirSync(path.join(paths.membersPrefix, 'node_modules'), { recursive: true });
    const link = path.join(root, 'link-to-node');
    fs.symlinkSync(paths.membersPrefix, link);
    const holder = (d: string): string | undefined => crewDirHolding(d, paths)?.path;
    const nm = path.join(paths.membersPrefix, 'node_modules');
    assert.equal(holder(paths.membersPrefix), paths.membersPrefix);
    assert.equal(holder(link), paths.membersPrefix, 'a link to node/ is node/ by real path');
    assert.equal(holder(path.join(paths.membersPrefix, 'package.json')), paths.membersPrefix);
    assert.equal(holder(path.join(paths.membersPrefix, 'package-lock.json', 'x')), paths.membersPrefix);
    assert.equal(holder(nm), nm);
    assert.equal(holder(path.join(link, 'node_modules', 'KiroCrew')), nm);
    for (const d of [path.join(paths.membersPrefix, 'KiroCrew'), path.join(link, 'KiroCrew'), path.join(paths.membersPrefix, 'node_modules2'), path.join(paths.membersPrefix, 'package.jsonx')]) {
      assert.equal(holder(d), undefined, d);
    }
    // The caches stay as they were (r8): what is in them is crew's.
    assert.equal(holder(path.join(paths.pipCache, 'a', 'KiroCrew')), paths.pipCache);
  });

  it('crewDirCheckout(members): a checkout in node_modules or at node/ itself (also a link to one); not one beside node_modules', () => {
    const fresh = (name: string) => {
      const r = path.join(SCRATCH, name);
      return crewPaths({ HOME: r, KIRO_CLAUDE_CREW_HOME: path.join(r, 'crew') });
    };
    const mark = (d: string, how: 'git' | 'bin'): void => {
      if (how === 'git') fs.mkdirSync(path.join(d, '.git'), { recursive: true });
      else {
        fs.mkdirSync(path.join(d, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(d, 'bin', 'kirocrew'), '#!/bin/sh\n');
      }
    };
    const beside = fresh('beside');
    mark(path.join(beside.membersPrefix, 'KiroCrew'), 'git');
    mark(path.join(beside.membersPrefix, 'other', 'deep', 'KiroCrew'), 'bin');
    fs.mkdirSync(path.join(beside.membersPrefix, 'node_modules', 'pkg'), { recursive: true });
    assert.equal(crewDirCheckout(beside, 'members'), undefined);
    assert.equal(crewDirCheckout(beside, 'build'), undefined);

    const inside = fresh('inside');
    const stray = path.join(inside.membersPrefix, 'node_modules', '@scope', 'KiroCrew');
    mark(stray, 'bin');
    assert.match(crewDirCheckout(inside, 'members') ?? '', new RegExp(`^${esc(stray)} looks like a Kiro Crew checkout \\(bin/kirocrew or \\.git\\) and is in ${esc(path.join(inside.membersPrefix, 'node_modules'))}, crew's claude-agent-acp bridge, where npm removes what is not a package when it installs the bridge\\. Move it out of there first\\.$`));

    const top = fresh('top');
    mark(top.membersPrefix, 'git');
    assert.match(crewDirCheckout(top, 'members') ?? '', new RegExp(`^${esc(top.membersPrefix)} looks like a Kiro Crew checkout \\(bin/kirocrew or \\.git\\) and is crew's claude-agent-acp bridge prefix, `));

    // npm writes through a link at node/: one that points at a checkout is one too.
    const linked = fresh('linked');
    const elsewhere = path.join(SCRATCH, 'linked-target');
    mark(elsewhere, 'bin');
    fs.mkdirSync(linked.stateDir, { recursive: true });
    fs.symlinkSync(elsewhere, linked.membersPrefix);
    assert.match(crewDirCheckout(linked, 'members') ?? '', /looks like a Kiro Crew checkout .* and is crew's claude-agent-acp bridge prefix, /);
  });

  it('installMembersAdapter (crew doctor --fix\'s forced reinstall) runs npm with a checkout beside node_modules, and not with one inside', async () => {
    const r = path.join(SCRATCH, 'install');
    const p = crewPaths({ HOME: r, KIRO_CLAUDE_CREW_HOME: path.join(r, 'crew') });
    fs.mkdirSync(path.join(p.membersPrefix, 'KiroCrew', '.git'), { recursive: true });
    const ran: string[] = [];
    const ok: RunResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 0 };
    const runner: CrewRunner = {
      run: async (file, args) => {
        ran.push([file, ...args].join(' '));
        fs.mkdirSync(path.dirname(p.membersAdapter), { recursive: true });
        fs.writeFileSync(p.membersAdapter, '');
        return ok;
      },
      spawnDetached: () => {
        throw new Error('not used');
      },
    };
    const res = await installMembersAdapter({ runner, npm: 'npm', env: {}, paths: p, force: true });
    assert.equal(res.installed, true);
    assert.equal(ran.length, 1);
    const stray = path.join(p.membersPrefix, 'node_modules', 'KiroCrew');
    fs.mkdirSync(path.join(stray, '.git'), { recursive: true });
    await assert.rejects(
      installMembersAdapter({ runner, npm: 'npm', env: {}, paths: p, force: true }),
      (e: unknown) => e instanceof CrewStepError && e.step === 'members' && e.message.startsWith(`${stray} looks like a Kiro Crew checkout`),
    );
    assert.equal(ran.length, 1, 'npm did not run again');
  });
});

describe('r9f crew: the help and docs give the true reason', () => {
  it('setup --help: node/ itself and node/node_modules are refused, a directory beside node_modules is fine; no "npm delete what is there"', async () => {
    const fe = fakeEnv();
    const s = await crew(fe, ['setup', '--help']);
    assert.equal(s.code, 0);
    const help = flat(s.stdout);
    assert.doesNotMatch(help, /the build and npm delete what is there/);
    assert.match(help, /nor in crew's build caches \(cache\/npm, cache\/pip\) in the crew state directory, which every build empties, nor in node\/node_modules, where npm keeps only packages when it installs the claude-agent-acp bridge, nor be node\/ itself, where npm installs it \(a directory beside node_modules in node\/ is fine\)\./);
    assert.match(help, /setup does not build while those caches hold a Kiro Crew checkout, nor install the bridge while node\/node_modules holds one or node\/ is one\./);
  });

  it('README and ARCHITECTURE.md: the bridge\'s own area is node/node_modules and node/ itself; a directory beside node_modules is allowed', () => {
    const root = repoRoot();
    const readme = flat(fs.readFileSync(path.join(root, 'README.md'), 'utf8'));
    assert.doesNotMatch(readme, /where the build and npm would delete it/);
    assert.match(readme, /Setup refuses a checkout inside crew's own build caches \(`cache\/npm`, `cache\/pip`; every build empties them\) or the claude-agent-acp bridge's `node\/node_modules` \(npm keeps only packages there\), or at the bridge prefix `node\/` itself \(npm installs the bridge there\), under `~\/\.local\/share\/kiro-claude\/crew\/`; a directory beside `node_modules` in `node\/` is fine\./);
    assert.match(readme, /`--purge` also removes the private claude-agent-acp bridge \(while `node\/` holds nothing else\)/);
    const arch = fs.readFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');
    const where = flat(arch.split(/\n\n/).find((p) => p.startsWith('**Where the checkout may live.**')) ?? '');
    assert.doesNotMatch(where, /the build or npm would delete it/);
    assert.doesNotMatch(where, /claude-agent-acp bridge prefix \(`node\/`; npm keeps only packages in its `node_modules`\)/);
    assert.match(where, /the claude-agent-acp bridge's `node\/node_modules` \(npm keeps only packages there\), or that is the bridge prefix `node\/` itself or one of the two files npm writes in it \(`package\.json`, `package-lock\.json`\)/);
    assert.match(where, /a directory beside `node_modules`, such as `node\/KiroCrew`, is allowed/);
    assert.match(where, /while `node\/node_modules` holds one or `node\/` itself is one \(`crewDirCheckout`\)/);
    assert.match(where, /the build would delete it from a cache, npm from `node_modules`, and npm would write the bridge into a `node\/` that is one/);
    const un = flat(arch.split(/\n\n/).find((p) => p.startsWith('**Uninstalling.**')) ?? '');
    assert.match(un, /`node \(a Kiro Crew checkout\)` for a `node\/` that is one/);
  });
});

// ───────────────────────────── real npm ─────────────────────────────

/** The npm next to this node, or on PATH, when it runs; undefined otherwise. */
function findRealNpm(): string | undefined {
  const home = path.join(SCRATCH, 'npm-probe-home');
  fs.mkdirSync(home, { recursive: true });
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)];
  for (const d of dirs) {
    const npm = path.join(d, 'npm');
    if (!fs.existsSync(npm)) continue;
    const r = spawnSync(npm, ['--version'], { encoding: 'utf8', timeout: 60_000, env: { HOME: home, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), npm_config_update_notifier: 'false' } });
    if (r.status === 0) return npm;
  }
  return undefined;
}

const NPM = PY ? findRealNpm() : undefined;
const PIN = CLAUDE_AGENT_ACP.version;
const OLD_PIN = '0.100.0';

interface Registry {
  url: string;
  close(): Promise<void>;
}

/** A local npm registry serving a stand-in bridge package at `versions`. */
async function startRegistry(npm: string, versions: string[]): Promise<Registry> {
  const root = path.join(SCRATCH, 'registry');
  const env = { HOME: path.join(root, 'home'), PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false' };
  fs.mkdirSync(env.HOME, { recursive: true });
  const tarballs = new Map<string, { buf: Buffer; integrity: string; shasum: string }>();
  for (const v of versions) {
    const src = path.join(root, `src-${v}`);
    fs.mkdirSync(path.join(src, path.dirname(CLAUDE_AGENT_ACP.entry)), { recursive: true });
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: CLAUDE_AGENT_ACP.name, version: v, main: CLAUDE_AGENT_ACP.entry }));
    fs.writeFileSync(path.join(src, ...CLAUDE_AGENT_ACP.entry.split('/')), `// stand-in claude-agent-acp ${v}\n`);
    const r = spawnSync(npm, ['pack', '--json', '--pack-destination', root], { cwd: src, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    const file = path.join(root, (JSON.parse(r.stdout) as Array<{ filename: string }>)[0]!.filename);
    const buf = fs.readFileSync(file);
    tarballs.set(v, { buf, integrity: `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`, shasum: crypto.createHash('sha1').update(buf).digest('hex') });
  }
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const u = decodeURIComponent(req.url ?? '');
    if (u === `/${CLAUDE_AGENT_ACP.name}`) {
      const all: Record<string, unknown> = {};
      for (const [v, t] of tarballs) all[v] = { name: CLAUDE_AGENT_ACP.name, version: v, main: CLAUDE_AGENT_ACP.entry, dist: { tarball: `${base}/t/${v}.tgz`, integrity: t.integrity, shasum: t.shasum } };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: CLAUDE_AGENT_ACP.name, 'dist-tags': { latest: PIN }, versions: all }));
      return;
    }
    const t = /^\/t\/(.+)\.tgz$/.exec(u);
    const tb = t ? tarballs.get(t[1]!) : undefined;
    if (tb) {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(tb.buf);
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('r9f crew: with real npm, nothing crew does to $CS/node removes a checkout beside node_modules', { skip: !PY ? 'no python3 with sqlite3' : !NPM ? 'no runnable npm' : false }, () => {
  let reg: Registry;
  before(async () => {
    reg = await startRegistry(NPM!, [OLD_PIN, PIN]);
  });
  after(async () => {
    await reg?.close();
  });

  /** A fake env whose npm and node are the real ones, pointed at the local registry. */
  function realNpmEnv(): FakeEnv {
    const fe = fakeEnv({ tools: ['git', 'python3', 'make', 'xdg-open', 'open'] });
    const realBin = path.join(fe.root, 'real-bin');
    fs.mkdirSync(realBin);
    fs.symlinkSync(process.execPath, path.join(realBin, 'node'));
    fs.symlinkSync(NPM!, path.join(realBin, 'npm'));
    fe.env.PATH = [fe.bin, realBin].join(path.delimiter);
    fe.env.npm_config_registry = reg.url;
    fe.env.npm_config_cache = path.join(fe.root, 'npm-cache');
    fe.env.npm_config_update_notifier = 'false';
    return fe;
  }

  /** `npm i --prefix $CS/node <bridge>@<version>` as an earlier kiro-claude (another pin) ran it. */
  function npmInstall(fe: FakeEnv, version: string): Promise<{ code: number | null; out: string }> {
    const prefix = path.join(fe.cs, 'node');
    fs.mkdirSync(prefix, { recursive: true });
    return new Promise((resolve) => {
      const ch = spawn(NPM!, ['i', '--prefix', prefix, `${CLAUDE_AGENT_ACP.name}@${version}`, '--omit=optional', '--no-audit', '--no-fund'], { cwd: fe.root, env: fe.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      ch.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
      ch.stderr.on('data', (b: Buffer) => (out += b.toString('utf8')));
      ch.on('close', (code) => resolve({ code, out }));
    });
  }

  const version = (fe: FakeEnv): string | undefined => membersAdapterVersion(crewPaths({ ...fe.env }));

  it('checkout elsewhere, an old one at $CS/node/KiroCrew: setup over an older bridge pin, doctor --fix, uninstall, purge without crew.json', { timeout: 300_000 }, async () => {
    const fe = realNpmEnv();
    const old = path.join(fe.cs, 'node', 'KiroCrew');
    checkoutWithWork(fe, old);
    // What real npm does: a checkout in node_modules is pruned, the one beside it is not.
    const inNm = path.join(fe.cs, 'node', 'node_modules', 'KiroCrew');
    checkoutWithWork(fe, inNm);
    const first = await npmInstall(fe, OLD_PIN);
    assert.equal(first.code, 0, first.out);
    assert.equal(fs.existsSync(inNm), false, 'npm removed the checkout in node_modules (why crew refuses one there)');
    assert.equal(intact(old), true, 'npm left $CS/node/KiroCrew alone');
    assert.equal(version(fe), OLD_PIN);

    const dir = path.join(fe.root, 'KC');
    fe.makeCheckout(dir, { built: true });
    const s = await setup(fe, ['--dir', dir]);
    assert.equal(s.code, 0, `${s.stdout}\n${s.stderr}`);
    assert.match(s.stdout, new RegExp(`installed claude-agent-acp in ${esc(path.join(fe.cs, 'node'))}`));
    assert.equal(version(fe), PIN, 'the pin change reinstalled the bridge');
    assert.equal(intact(old), true);

    const back = await npmInstall(fe, OLD_PIN);
    assert.equal(back.code, 0, back.out);
    const d = await crew(fe, ['doctor', '--fix', '--no-gateway'], { deps });
    assert.match(d.stdout, /fixed: reinstalled claude-agent-acp/, d.stdout);
    assert.equal(version(fe), PIN);
    assert.equal(intact(old), true);

    const u = await crew(fe, ['uninstall'], { deps });
    assert.equal(u.code, 0, `${u.stdout}\n${u.stderr}`);
    assert.equal(intact(old), true);
    const p = await crew(fe, ['uninstall', '--purge'], { deps });
    assert.equal(p.code, 0, `${p.stdout}\n${p.stderr}`);
    assert.deepEqual(purgeLines(p.stdout), [`Purged bin from ${fe.cs}; kept node (holds a Kiro Crew checkout)`], p.stdout);
    assert.equal(intact(old), true);
    assert.equal(version(fe), PIN, 'the bridge is kept with node/');
  });

  it('crew setup --dir $CS/node/KiroCrew: install, a pin change on re-run, doctor --fix, purge with and without crew.json', { timeout: 300_000 }, async () => {
    const fe = realNpmEnv();
    const dir = path.join(fe.cs, 'node', 'KiroCrew');
    checkoutWithWork(fe, dir);
    const s = await setup(fe, ['--dir', dir]);
    assert.equal(s.code, 0, `${s.stdout}\n${s.stderr}`);
    assert.equal(version(fe), PIN);
    assert.equal(intact(dir), true);
    assert.deepEqual(fs.readdirSync(path.join(fe.cs, 'node')).sort(), ['KiroCrew', 'node_modules', 'package-lock.json', 'package.json']);

    const older = await npmInstall(fe, OLD_PIN);
    assert.equal(older.code, 0, older.out);
    const rerun = await setup(fe, []);
    assert.equal(rerun.code, 0, `${rerun.stdout}\n${rerun.stderr}`);
    assert.equal(version(fe), PIN);
    assert.equal(intact(dir), true);

    const back = await npmInstall(fe, OLD_PIN);
    assert.equal(back.code, 0, back.out);
    const d = await crew(fe, ['doctor', '--fix', '--no-gateway'], { deps });
    assert.match(d.stdout, /fixed: reinstalled claude-agent-acp/, d.stdout);
    assert.equal(version(fe), PIN);
    assert.equal(intact(dir), true);

    const p = await crew(fe, ['uninstall', '--purge'], { deps });
    assert.equal(p.code, 0, `${p.stdout}\n${p.stderr}`);
    assert.deepEqual(purgeLines(p.stdout), [`Purged bin from ${fe.cs}; kept node (holds the Kiro Crew checkout)`], p.stdout);
    assert.match(p.stdout, new RegExp(`the checkout ${esc(dir)} were kept\\.`));
    assert.equal(intact(dir), true);
    const again = await crew(fe, ['uninstall', '--purge'], { deps });
    assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`);
    assert.deepEqual(purgeLines(again.stdout), [`Nothing to purge in ${fe.cs}; kept node (holds a Kiro Crew checkout)`], again.stdout);
    assert.equal(intact(dir), true);
  });
});
