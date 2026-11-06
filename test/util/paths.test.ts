import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  expandTilde,
  findWorkspaceRoot,
  homeDir,
  isSubpath,
  kiroClaudeDataDir,
  kiroHome,
  realpathDeep,
  realpathSafe,
  resolvePath,
  runtimeDir,
  toPosixPath,
} from '../../src/util/paths.js';

const posix = process.platform === 'win32' ? { skip: 'POSIX paths' } : {};

describe('paths: home and KIRO_HOME (02 §1.1)', () => {
  it('homeDir prefers HOME, then USERPROFILE, then os.homedir()', () => {
    assert.equal(homeDir({ HOME: '/h/one', USERPROFILE: '/h/two' }), path.resolve('/h/one'));
    assert.equal(homeDir({ USERPROFILE: '/h/two' }), path.resolve('/h/two'));
    assert.equal(homeDir({ HOME: '' }), os.homedir());
    assert.equal(homeDir({}), os.homedir());
  });

  it('kiroHome honors an absolute KIRO_HOME', posix, () => {
    assert.equal(kiroHome({ HOME: '/home/u' }), '/home/u/.kiro');
    assert.equal(kiroHome({ HOME: '/home/u', KIRO_HOME: '/opt/kiro' }), '/opt/kiro');
    assert.equal(kiroHome({ HOME: '/home/u', KIRO_HOME: '/opt/kiro/' }), '/opt/kiro');
    assert.equal(kiroHome({ HOME: '/home/u', KIRO_HOME: '/home/u/custom' }), '/home/u/custom');
  });

  it('kiroHome ignores relative, root, home and home-ancestor values', posix, () => {
    for (const bad of ['relative/dir', '/', '/home/u', '/home', '']) {
      assert.equal(kiroHome({ HOME: '/home/u', KIRO_HOME: bad }), '/home/u/.kiro', bad);
    }
  });

  it('kiroClaudeDataDir', posix, () => {
    assert.equal(kiroClaudeDataDir({ HOME: '/home/u' }), '/home/u/.kiro/kiro-claude');
    assert.equal(kiroClaudeDataDir({ HOME: '/home/u', KIRO_HOME: '/k' }), '/k/kiro-claude');
  });
});

describe('paths: tilde and resolution', () => {
  const env = { HOME: '/home/u' };
  it('expandTilde', posix, () => {
    assert.equal(expandTilde('~', env), '/home/u');
    assert.equal(expandTilde('~/x/y', env), '/home/u/x/y');
    assert.equal(expandTilde('~user/x', env), '~user/x');
    assert.equal(expandTilde('a/~/b', env), 'a/~/b');
    assert.equal(expandTilde('/abs', env), '/abs');
    assert.equal(expandTilde('', env), '');
  });
  it('resolvePath', posix, () => {
    assert.equal(resolvePath('~/x', '/base', env), '/home/u/x');
    assert.equal(resolvePath('rel/../y', '/base', env), '/base/y');
    assert.equal(resolvePath('/abs', '/base', env), '/abs');
  });
  it('isSubpath', posix, () => {
    assert.equal(isSubpath('/a/b', '/a'), true);
    assert.equal(isSubpath('/a', '/a'), true);
    assert.equal(isSubpath('/a/', '/a'), true);
    assert.equal(isSubpath('/ab', '/a'), false);
    assert.equal(isSubpath('/a/../b', '/a'), false);
    assert.equal(isSubpath('/', '/a'), false);
    assert.equal(isSubpath('/a/..b', '/a'), true);
    assert.equal(isSubpath('/anything', '/'), true);
  });
  it('toPosixPath', () => {
    assert.equal(toPosixPath('C:\\x\\y'), 'C:/x/y');
    assert.equal(toPosixPath('/a/b'), '/a/b');
  });
});

describe('paths: realpath helpers', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-paths-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('realpathSafe resolves symlinks and falls back to path.resolve', posix, () => {
    fs.mkdirSync(path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
    const realDir = fs.realpathSync(dir);
    assert.equal(realpathSafe(path.join(dir, 'link')), path.join(realDir, 'real'));
    assert.equal(realpathSafe(path.join(dir, 'link', 'missing')), path.join(dir, 'link', 'missing'));
    assert.equal(realpathDeep(path.join(dir, 'link', 'missing', 'x')), path.join(realDir, 'real', 'missing', 'x'));
  });
});

describe('paths: findWorkspaceRoot (02 §1.3)', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  before(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-home-')));
    env = { HOME: home, USERPROFILE: home };
    for (const d of ['.kiro', 'proj/.kiro', 'proj/src/deep', 'plain/sub', 'legacy/.amazonq', 'legacy/inner', 'fileonly']) {
      fs.mkdirSync(path.join(home, d), { recursive: true });
    }
    fs.writeFileSync(path.join(home, 'fileonly', '.kiro'), 'not a dir');
    fs.mkdirSync(path.join(home, 'fileonly', 'x'));
  });
  after(() => fs.rmSync(home, { recursive: true, force: true }));

  it('cwd with .kiro is the root', () => {
    assert.equal(findWorkspaceRoot(path.join(home, 'proj'), env), path.join(home, 'proj'));
  });
  it('walks up to the nearest ancestor with .kiro/', () => {
    assert.equal(findWorkspaceRoot(path.join(home, 'proj', 'src', 'deep'), env), path.join(home, 'proj'));
  });
  it('never returns the home directory (its .kiro is user config)', () => {
    assert.equal(findWorkspaceRoot(path.join(home, 'plain', 'sub'), env), path.join(home, 'plain', 'sub'));
    assert.equal(findWorkspaceRoot(home, env), home);
  });
  it('cwd with a legacy .amazonq/ is its own root', () => {
    assert.equal(findWorkspaceRoot(path.join(home, 'legacy'), env), path.join(home, 'legacy'));
    assert.equal(findWorkspaceRoot(path.join(home, 'legacy', 'inner'), env), path.join(home, 'legacy', 'inner'));
  });
  it('a .kiro FILE does not count', () => {
    assert.equal(findWorkspaceRoot(path.join(home, 'fileonly', 'x'), env), path.join(home, 'fileonly', 'x'));
  });
  it('outside home: walks to the filesystem root but never returns an ancestor of home', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-out-')));
    try {
      fs.mkdirSync(path.join(outside, 'ws', '.kiro'), { recursive: true });
      fs.mkdirSync(path.join(outside, 'ws', 'a', 'b'), { recursive: true });
      const fakeHome = path.join(outside, 'ws', 'a'); // home below the candidate ⇒ candidate is an ancestor of home
      assert.equal(findWorkspaceRoot(path.join(outside, 'ws', 'a', 'b'), { HOME: path.join(outside, 'elsewhere') }), path.join(outside, 'ws'));
      assert.equal(findWorkspaceRoot(path.join(outside, 'ws', 'a', 'b'), { HOME: fakeHome }), path.join(outside, 'ws', 'a', 'b'));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('paths: runtimeDir', () => {
  it('creates a private 0700 directory under XDG_RUNTIME_DIR and caches it', posix, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-rt-'));
    try {
      const d = runtimeDir({ XDG_RUNTIME_DIR: base });
      assert.equal(path.dirname(d), base);
      assert.match(path.basename(d), /^kiro-claude-/);
      const st = fs.statSync(d);
      assert.ok(st.isDirectory());
      assert.equal(st.mode & 0o777, 0o700);
      assert.equal(runtimeDir({ XDG_RUNTIME_DIR: base }), d);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('tightens permissions of an existing directory we own', posix, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-rt2-'));
    try {
      const uid = process.getuid?.();
      const pre = path.join(base, `kiro-claude-${uid}`);
      fs.mkdirSync(pre, { mode: 0o755 });
      fs.chmodSync(pre, 0o755);
      const d = runtimeDir({ XDG_RUNTIME_DIR: base });
      assert.equal(d, pre);
      assert.equal(fs.statSync(d).mode & 0o777, 0o700);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not reuse a squatted path that is not a directory', posix, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-rt3-'));
    try {
      const uid = process.getuid?.();
      fs.writeFileSync(path.join(base, `kiro-claude-${uid}`), 'squatter');
      const d = runtimeDir({ XDG_RUNTIME_DIR: base });
      assert.notEqual(d, path.join(base, `kiro-claude-${uid}`));
      assert.ok(fs.statSync(d).isDirectory());
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('falls back to the temp dir when XDG_RUNTIME_DIR is relative', () => {
    const d = runtimeDir({ XDG_RUNTIME_DIR: 'relative' });
    assert.ok(path.isAbsolute(d));
    assert.ok(fs.statSync(d).isDirectory());
  });
});
