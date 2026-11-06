import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  crewPaths,
  crewStateDir,
  findPackageRoot,
  hiddenDirContaining,
  identityStorePath,
  inLinkedGitWorktree,
  isSubmoduleCheckout,
  isUnderTmp,
  kirocrewConfigFile,
  kirocrewHome,
  probeHiddenDirs,
  resolveCheckout,
} from '../../src/crew/paths.js';

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-paths-')));
}

describe('crew paths (08 §3.1)', () => {
  it('state dir: KIRO_CLAUDE_CREW_HOME > XDG_DATA_HOME > ~/.local/share', () => {
    assert.equal(crewStateDir({ HOME: '/h' }), '/h/.local/share/kiro-claude/crew');
    assert.equal(crewStateDir({ HOME: '/h', XDG_DATA_HOME: '/x' }), '/x/kiro-claude/crew');
    assert.equal(crewStateDir({ HOME: '/h', XDG_DATA_HOME: 'rel' }), '/h/.local/share/kiro-claude/crew');
    assert.equal(crewStateDir({ HOME: '/h', KIRO_CLAUDE_CREW_HOME: '/cs' }), '/cs');
  });

  it('every §3.1 file lives where the table says', () => {
    const p = crewPaths({ HOME: '/h' });
    const cs = '/h/.local/share/kiro-claude/crew';
    assert.deepEqual(
      { shim: p.shim, state: p.stateFile, out: p.gatewayOut, err: p.gatewayErr, ready: p.readyFile, token: p.tokenFile, adapter: p.membersAdapter, own: p.ownCheckout },
      {
        shim: `${cs}/bin/kiro-claude`,
        state: `${cs}/crew.json`,
        out: `${cs}/run/gateway.out`,
        err: `${cs}/run/gateway.err`,
        ready: `${cs}/run/ready.json`,
        token: `${cs}/run/token`,
        adapter: `${cs}/node/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`,
        own: `${cs}/KiroCrew`,
      },
    );
  });

  it('KiroCrew data home and config.json', () => {
    assert.equal(kirocrewHome({ HOME: '/h' }), '/h/.kiro/crew');
    assert.equal(kirocrewHome({ HOME: '/h', KIROCREW_HOME: '/k' }), '/k');
    assert.equal(kirocrewConfigFile({ HOME: '/h' }), '/h/.kiro/crew/config.json');
  });

  it('identity store anchors are fixed per platform (never XDG_DATA_HOME)', () => {
    assert.equal(identityStorePath('/h', 'linux'), '/h/.local/share/kiro-cli/data.sqlite3');
    assert.equal(identityStorePath('/h', 'darwin'), '/h/Library/Application Support/kiro-cli/data.sqlite3');
    assert.equal(identityStorePath('/h', 'win32'), path.join('/h', 'AppData', 'Local', 'kiro-cli', 'data.sqlite3'));
  });

  it('probe-hidden dirs (KC-BIN-02) and the guard', () => {
    const env = { HOME: '/h', KIROCREW_HOME: '/data/kc' };
    assert.deepEqual(probeHiddenDirs(env), ['/data/kc', '/h/.kiro/crew', '/h/.kirocrew', '/h/.local/share/kiro-cli', '/h/Library/Application Support/kiro-cli', '/h/.aws']);
    assert.equal(hiddenDirContaining('/h/.local/share/kiro-claude/crew/bin/kiro-claude', env), undefined);
    assert.equal(hiddenDirContaining('/h/.kiro/crew/bin/kiro-claude', env), '/h/.kiro/crew');
    assert.equal(hiddenDirContaining('/data/kc/x', env), '/data/kc');
    assert.equal(hiddenDirContaining('/h/.aws', env), '/h/.aws');
  });

  it('linked-worktree detection mirrors KiroCrew (V9): .git dir = clone, gitdir …/worktrees/… = worktree, submodule = clone', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'clone', '.git'), { recursive: true });
    fs.mkdirSync(path.join(d, 'clone', 'vendor', 'KiroCrew'), { recursive: true });
    fs.writeFileSync(path.join(d, 'clone', 'vendor', 'KiroCrew', '.git'), 'gitdir: ../../.git/modules/vendor/KiroCrew\n');
    assert.equal(inLinkedGitWorktree(path.join(d, 'clone')), false);
    assert.equal(inLinkedGitWorktree(path.join(d, 'clone', 'vendor', 'KiroCrew')), false);
    fs.mkdirSync(path.join(d, 'wt', 'vendor', 'KiroCrew'), { recursive: true });
    fs.writeFileSync(path.join(d, 'wt', '.git'), 'gitdir: /repo/.git/worktrees/wt\n');
    fs.writeFileSync(path.join(d, 'wt', 'vendor', 'KiroCrew', '.git'), 'gitdir: /repo/.git/worktrees/wt/modules/vendor/KiroCrew\n');
    assert.equal(inLinkedGitWorktree(path.join(d, 'wt')), true);
    assert.equal(inLinkedGitWorktree(path.join(d, 'wt', 'vendor', 'KiroCrew')), true);
    assert.equal(inLinkedGitWorktree(path.join(d, 'wt', 'vendor', 'KiroCrew', 'missing', 'sub')), true);
    fs.writeFileSync(path.join(d, 'win.git'), '');
    fs.mkdirSync(path.join(d, 'win'));
    fs.writeFileSync(path.join(d, 'win', '.git'), 'gitdir: C:\\repo\\.git\\worktrees\\w\n');
    assert.equal(inLinkedGitWorktree(path.join(d, 'win')), true);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('linked-worktree detection agrees with real git worktrees (temp repo)', (t) => {
    const git = spawnSync('git', ['--version']);
    if (git.status !== 0) return t.skip('git not available');
    const d = tmp();
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const run = (...a: string[]) => {
      const r = spawnSync('git', a, { cwd: path.join(d, 'main'), env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    fs.mkdirSync(path.join(d, 'main'));
    run('init', '-q');
    fs.writeFileSync(path.join(d, 'main', 'f'), 'x');
    run('add', 'f');
    run('commit', '-q', '-m', 'init');
    run('worktree', 'add', '-q', path.join(d, 'linked'));
    assert.equal(inLinkedGitWorktree(path.join(d, 'main')), false);
    assert.equal(inLinkedGitWorktree(path.join(d, 'linked')), true);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('isUnderTmp compares raw and realpath forms', () => {
    const base = tmp();
    assert.equal(isUnderTmp(path.join(base, 'x'), os.tmpdir()), true);
    assert.equal(isUnderTmp('/home/someone/x', '/tmp'), false);
    assert.equal(isUnderTmp('/tmp', '/tmp'), true);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('checkout resolution order: --dir > KIRO_CLAUDE_CREW_DIR > submodule > $CS/KiroCrew', () => {
    const d = tmp();
    const root = path.join(d, 'kiro-claude');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitmodules'), '[submodule "vendor/KiroCrew"]\n\tpath = vendor/KiroCrew\n\turl = https://github.com/kirodotdev/KiroCrew.git\n');
    const env = { HOME: '/h' };
    assert.deepEqual(resolveCheckout({ flagDir: 'kc', cwd: '/w', env, packageRoot: root }), { dir: '/w/kc', source: 'flag' });
    assert.deepEqual(resolveCheckout({ cwd: '/w', env: { ...env, KIRO_CLAUDE_CREW_DIR: '/e/kc' }, packageRoot: root }), { dir: '/e/kc', source: 'env' });
    assert.deepEqual(resolveCheckout({ cwd: '/w', env, packageRoot: root }), { dir: path.join(root, 'vendor', 'KiroCrew'), source: 'submodule', superproject: root });
    assert.equal(isSubmoduleCheckout(root), true);
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    assert.equal(isSubmoduleCheckout(root), false, 'not a git checkout (npm install)');
    assert.deepEqual(resolveCheckout({ cwd: '/w', env, packageRoot: root }), { dir: '/h/.local/share/kiro-claude/crew/KiroCrew', source: 'state-dir' });
    assert.deepEqual(resolveCheckout({ cwd: '/w', env, packageRoot: null }), { dir: '/h/.local/share/kiro-claude/crew/KiroCrew', source: 'state-dir' });
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('findPackageRoot walks up to package.json named kiro-claude', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), '{"name":"kiro-claude"}');
    fs.mkdirSync(path.join(d, 'dist', 'src', 'crew'), { recursive: true });
    fs.mkdirSync(path.join(d, 'dist', 'src', 'x'), { recursive: true });
    fs.writeFileSync(path.join(d, 'dist', 'src', 'x', 'package.json'), '{"name":"other"}');
    assert.equal(findPackageRoot(path.join(d, 'dist', 'src', 'crew')), d);
    assert.equal(findPackageRoot(path.join(d, 'dist', 'src', 'x')), d);
    fs.rmSync(d, { recursive: true, force: true });
  });
});
