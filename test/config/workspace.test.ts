import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createWorkspaceContext, samePath, workspaceAmazonqDir, workspaceKiroDir, legacyGlobalDir } from '../../src/config/workspace.js';
import { makeFixture, type Fixture } from './helpers.js';

describe('config/workspace', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('builds a context with realpaths, kiroHome and home from env', () => {
    fx = makeFixture();
    fx.mkdir('proj/.kiro');
    const ws = createWorkspaceContext(fx.ws, fx.env);
    assert.equal(ws.cwd, fx.ws);
    assert.equal(ws.workspaceRoot, fx.ws);
    assert.equal(ws.home, fx.home);
    assert.equal(ws.kiroHome, path.join(fx.home, '.kiro'));
    assert.equal(ws.env, fx.env);
  });

  it('walks up to the nearest .kiro ancestor', () => {
    fx = makeFixture();
    fx.mkdir('proj/.kiro');
    const sub = fx.mkdir('proj/src/deep');
    const ws = createWorkspaceContext(sub, fx.env);
    assert.equal(ws.cwd, sub);
    assert.equal(ws.workspaceRoot, fx.ws);
  });

  it('cwd without any .kiro ancestor is its own root', () => {
    fx = makeFixture();
    const sub = fx.mkdir('proj/a');
    assert.equal(createWorkspaceContext(sub, fx.env).workspaceRoot, sub);
  });

  it('honors an absolute KIRO_HOME and ignores a relative one', () => {
    fx = makeFixture();
    const kh = fx.mkdir('kh');
    assert.equal(createWorkspaceContext(fx.ws, { ...fx.env, KIRO_HOME: kh }).kiroHome, kh);
    assert.equal(createWorkspaceContext(fx.ws, { ...fx.env, KIRO_HOME: 'rel/kh' }).kiroHome, path.join(fx.home, '.kiro'));
  });

  it('workspaceKiroDir is undefined when the workspace is home or equals KIRO_HOME', () => {
    fx = makeFixture();
    fx.mkdir('home/.kiro');
    const atHome = createWorkspaceContext(fx.home, fx.env);
    assert.equal(workspaceKiroDir(atHome), undefined);
    assert.equal(workspaceAmazonqDir(atHome), undefined);
    const wsKiro = fx.mkdir('proj/.kiro');
    const same = createWorkspaceContext(fx.ws, { ...fx.env, KIRO_HOME: wsKiro });
    assert.equal(workspaceKiroDir(same), undefined);
    const normal = createWorkspaceContext(fx.ws, fx.env);
    assert.equal(workspaceKiroDir(normal), wsKiro);
    assert.equal(workspaceAmazonqDir(normal), path.join(fx.ws, '.amazonq'));
    assert.equal(legacyGlobalDir(normal), path.join(fx.home, '.aws', 'amazonq'));
  });

  it('samePath compares through symlinks', () => {
    fx = makeFixture();
    const real = fx.mkdir('real');
    const link = path.join(fx.root, 'link');
    fs.symlinkSync(real, link);
    assert.equal(samePath(real, link), true);
    assert.equal(samePath(real, fx.ws), false);
  });
});
