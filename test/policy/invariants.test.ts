/**
 * Kiro-scope invariants (02 §2.8, 00 §2.3) and `.kiroignore` read denial (02 §6.4).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkInvariants, isAlwaysAskWritePath, isDeniedWritePath } from '../../src/policy/invariants.js';
import { toKiroCall } from '../../src/policy/toolmap.js';
import { makeWs, type TempWs } from './helpers.js';

let tw: TempWs;
let kh: string;
before(() => {
  tw = makeWs();
  kh = tw.ws.kiroHome;
  fs.mkdirSync(path.join(kh, 'settings'), { recursive: true });
  fs.symlinkSync(path.join(kh, 'settings'), path.join(tw.root, 'settings-link'));
});
after(() => tw.cleanup());

const write = (p: string, name = 'Write') =>
  toKiroCall(name, name === 'NotebookEdit' ? { notebook_path: p } : { file_path: p, content: '' }, { cwd: tw.ws.cwd });

describe('write invariants: always deny', () => {
  const cases = (): string[] => [
    path.join(kh, 'settings', 'cli.json'),
    path.join(kh, 'settings', 'permissions.yaml'),
    path.join(tw.root, '.kiro', 'settings', 'mcp.json'),
    path.join(tw.root, 'nested', 'pkg', '.kiro', 'settings', 'cli.json'),
    path.join(kh, 'workspace-roots', 'abcdef0123456789', 'permissions.yaml'),
    path.join(tw.root, '.kiroignore'),
    path.join(tw.root, 'sub', '.kiroignore'),
    path.join(kh, 'powers', 'installed', 'aws', 'mcp.json'),
    path.join(kh, 'sandbox-state', 'x'),
    path.join(kh, 'web-session', 'x'),
    path.join(kh, 'cloud-cache', 'x'),
    path.join(kh, 'sandbox-curl', 'x'),
    path.join(kh, 'sessions', 'cli', 'abc.json'),
    path.join(kh, 'kiro-claude', 'state.json'),
  ];
  it('each protected path is denied for Write / Edit / NotebookEdit', () => {
    for (const p of cases()) {
      for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
        const r = checkInvariants(write(p, t), tw.ws);
        assert.deepEqual(r, { effect: 'deny', reason: `Kiro does not allow this operation: ${p}` }, `${t} ${p}`);
      }
    }
  });
  it('relative paths resolve against the call cwd', () => {
    const r = checkInvariants(write('.kiro/settings/cli.json'), tw.ws);
    assert.equal(r?.effect, 'deny');
    assert.equal(r?.reason, `Kiro does not allow this operation: ${path.join(tw.root, '.kiro', 'settings', 'cli.json')}`);
  });
  it('symlinks into protected dirs are resolved', () => {
    const r = checkInvariants(write(path.join(tw.root, 'settings-link', 'cli.json')), tw.ws);
    assert.equal(r?.effect, 'deny');
  });
  it('a custom KIRO_HOME is protected, and so is ~/.kiro', () => {
    const custom = makeWs({ kiroHome: path.join(tw.home, 'custom-kiro') });
    try {
      assert.equal(checkInvariants(write(path.join(custom.ws.kiroHome, 'settings', 'cli.json')), custom.ws)?.effect, 'deny');
      assert.equal(checkInvariants(write(path.join(custom.home, '.kiro', 'settings', 'cli.json')), custom.ws)?.effect, 'deny');
    } finally {
      custom.cleanup();
    }
  });
});

describe('write invariants: always ask', () => {
  const cases = (): string[] => [
    path.join(tw.root, '.git', 'config'),
    path.join(tw.root, '.git', 'hooks', 'pre-commit'),
    path.join(tw.root, 'vendor', 'lib', '.git', 'HEAD'),
    path.join(tw.root, '.vscode', 'settings.json'),
    path.join(tw.root, 'proj.code-workspace'),
    path.join(tw.root, '.kiro', 'agents', 'a.json'),
    path.join(tw.root, '.kiro', 'hooks', 'h.kiro.hook'),
    path.join(tw.root, '.kiro', 'workflows', 'w.yaml'),
    path.join(tw.root, '.kiro', 'powers', 'p', 'POWER.md'),
    path.join(kh, 'agents', 'global.json'),
    path.join(kh, 'hooks', 'x.json'),
    path.join(kh, 'powers', 'installed', 'aws', 'other.json'),
    path.join(kh, 'powers', 'installed', 'aws', 'nested', 'mcp.json'),
  ];
  it('each path asks', () => {
    for (const p of cases()) {
      const r = checkInvariants(write(p), tw.ws);
      assert.deepEqual(r, { effect: 'ask', reason: `Kiro always asks before writing to ${p}` }, p);
    }
  });
});

describe('not covered by invariants', () => {
  it('ordinary writes, steering, specs, reads, shell', () => {
    for (const p of [
      path.join(tw.root, 'src', 'a.ts'),
      path.join(tw.root, '.kiro', 'steering', 'a.md'),
      path.join(tw.root, '.kiro', 'specs', 'feat', 'requirements.md'),
      path.join(tw.root, '.gitignore'),
      path.join(tw.root, 'my.git', 'x'),
      path.join(tw.root, 'kiroignore'),
      path.join(kh, 'steering', 'x.md'),
      path.join(kh, 'prompts', 'p.md'),
    ]) {
      assert.equal(checkInvariants(write(p), tw.ws), undefined, p);
    }
    const read = toKiroCall('Read', { file_path: path.join(kh, 'settings', 'cli.json') }, { cwd: tw.ws.cwd });
    assert.equal(checkInvariants(read, tw.ws), undefined, 'reads of settings are fine');
    const bash = toKiroCall('Bash', { command: `echo x > ${path.join(kh, 'settings', 'cli.json')}` }, { cwd: tw.ws.cwd });
    assert.equal(checkInvariants(bash, tw.ws), undefined, 'shell is judged by policy, not invariants');
  });
  it('predicates', () => {
    assert.ok(isDeniedWritePath(path.join(tw.root, '.kiro', 'settings', 'x'), tw.ws));
    assert.ok(!isDeniedWritePath(path.join(tw.root, '.kiro', 'settingsX', 'x'), tw.ws));
    assert.ok(isAlwaysAskWritePath(path.join(tw.root, '.git'), tw.ws));
    assert.ok(!isAlwaysAskWritePath(path.join(tw.root, '.github', 'workflows', 'ci.yml'), tw.ws));
  });
});

describe('.kiroignore (reads, globs, greps)', () => {
  const ignoredDir = (): string => path.join(tw.root, 'private');
  const isIgnored = (p: string): boolean => p === ignoredDir() || p.startsWith(`${ignoredDir()}/`);
  it('Read of an ignored path is denied', () => {
    const p = path.join(ignoredDir(), 'key.txt');
    const c = toKiroCall('Read', { file_path: p }, { cwd: tw.ws.cwd });
    assert.deepEqual(checkInvariants(c, tw.ws, { isIgnored }), { effect: 'deny', reason: `Kiro does not allow this operation: ${p}` });
  });
  it('Glob / Grep rooted in an ignored path are denied; elsewhere fine', () => {
    for (const name of ['Glob', 'Grep']) {
      const c = toKiroCall(name, { pattern: 'x', path: ignoredDir() }, { cwd: tw.ws.cwd });
      assert.equal(checkInvariants(c, tw.ws, { isIgnored })?.effect, 'deny', name);
      const ok = toKiroCall(name, { pattern: 'x' }, { cwd: tw.ws.cwd });
      assert.equal(checkInvariants(ok, tw.ws, { isIgnored }), undefined, name);
    }
  });
  it('Glob whose pattern escapes into an ignored dir is denied', () => {
    const c = toKiroCall('Glob', { pattern: `${ignoredDir()}/**` }, { cwd: tw.ws.cwd });
    assert.equal(checkInvariants(c, tw.ws, { isIgnored })?.effect, 'deny');
  });
  it('without isIgnored nothing is denied; a throwing isIgnored is ignored', () => {
    const c = toKiroCall('Read', { file_path: path.join(ignoredDir(), 'k') }, { cwd: tw.ws.cwd });
    assert.equal(checkInvariants(c, tw.ws), undefined);
    assert.equal(checkInvariants(c, tw.ws, { isIgnored: () => { throw new Error('boom'); } }), undefined);
  });
  it('writes are not affected by .kiroignore', () => {
    const c = write(path.join(ignoredDir(), 'k'));
    assert.equal(checkInvariants(c, tw.ws, { isIgnored }), undefined);
  });
});
