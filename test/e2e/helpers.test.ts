/**
 * Self-tests of the e2e helpers (./helpers.ts). They make NO model calls and never run the real
 * `claude` (KIRO_CLAUDE_BIN = the fake, HOME and CLAUDE_CONFIG_DIR = temp dirs), so unlike the
 * real-claude cases they always run. They guard the two helper behaviours that can hurt the
 * user's machine: deleting the Claude project dirs of temp cwds (only ever those), and stopping
 * the CLI children of a temp project before that project is removed (otherwise a failed or
 * timed-out case leaves `claude` writing transcripts into the user's Claude config after the
 * cleanup ran).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';

import { sanitizeProjectDir } from '../../src/claude/transcript.js';
import { fakeClaudePath } from '../claude/helpers.js';
import { AcpClient, CliProc, KEEP, e2eEnv, makeProject, removeClaudeProjectDir, trackChild } from './helpers.js';

const KEEP_SKIP = KEEP ? 'KIRO_CLAUDE_E2E_KEEP=1 turns cleanup off' : false;

let base: string;
let claudeConfig: string;
let projects: string;
const saved: Record<string, string | undefined> = {};

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-helpers-')));
  claudeConfig = path.join(base, 'claude-config');
  projects = path.join(claudeConfig, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  // Whatever a helper resolves from process.env must land in the temp dirs, never in ~/.claude.
  for (const k of ['CLAUDE_CONFIG_DIR', 'HOME']) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  process.env.HOME = path.join(base, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

/** Isolated env for a CLI child: the fake claude, temp HOME / CLAUDE_CONFIG_DIR. */
function fakeProjectEnv(): Record<string, string> {
  return { HOME: process.env.HOME!, CLAUDE_CONFIG_DIR: claudeConfig, KIRO_CLAUDE_BIN: fakeClaudePath() };
}

test('removeClaudeProjectDir also removes the dir claude names after the realpath of a symlinked temp cwd', { skip: process.platform === 'win32' ? 'symlinked dirs need privileges on Windows' : KEEP_SKIP }, () => {
  // macOS: os.tmpdir() is /var/folders/… (a symlink to /private/var/…); claude names the project
  // dir after its getcwd(), i.e. the realpath.
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, 'dir');
  const root = fs.mkdtempSync(path.join(link, 'kc-e2e-'));
  const realRoot = fs.realpathSync(root);
  assert.notEqual(root, realRoot);
  const viaLink = path.join(projects, sanitizeProjectDir(root));
  const viaReal = path.join(projects, sanitizeProjectDir(realRoot));
  const unrelated = path.join(projects, '-home-someone-real-project');
  for (const d of [viaLink, viaReal, unrelated]) fs.mkdirSync(path.join(d, 'memory'), { recursive: true });

  removeClaudeProjectDir(root);

  assert.equal(fs.existsSync(viaReal), false, 'the realpath-named project dir (the one claude creates) was left behind');
  assert.equal(fs.existsSync(viaLink), false);
  assert.ok(fs.existsSync(unrelated), 'an unrelated project dir was removed');
});

test('removeClaudeProjectDir never removes a dir for a non kc-e2e-* root or a cwd outside the root', { skip: KEEP_SKIP }, () => {
  const other = fs.mkdtempSync(path.join(base, 'other-'));
  const e2eRoot = fs.mkdtempSync(path.join(base, 'kc-e2e-'));
  const outside = fs.mkdtempSync(path.join(base, 'elsewhere-'));
  const dirs = [other, outside].map((d) => path.join(projects, sanitizeProjectDir(d)));
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });

  removeClaudeProjectDir(other); // root is not a kc-e2e-* temp dir
  removeClaudeProjectDir(outside, e2eRoot); // cwd outside the unique root

  for (const d of dirs) assert.ok(fs.existsSync(d), `${path.basename(d)} must survive`);
});

test('e2eEnv drops kiro-claude / fake-claude overrides and FORCE_COLOR but keeps HOME and CLAUDE_CONFIG_DIR', () => {
  const keys = ['KIRO_CLAUDE_BIN', 'KIRO_HOME', 'FAKE_CLAUDE_SCRIPT', 'FORCE_COLOR'];
  const prev = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) process.env[k] = 'x';
    const env = e2eEnv({ KIRO_HOME: '/tmp/kh' });
    for (const k of ['KIRO_CLAUDE_BIN', 'FAKE_CLAUDE_SCRIPT', 'FORCE_COLOR']) assert.equal(env[k], undefined, k);
    assert.equal(env.KIRO_HOME, '/tmp/kh');
    assert.equal(env.NO_COLOR, '1');
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.CLAUDE_CONFIG_DIR, claudeConfig);
  } finally {
    keys.forEach((k, i) => {
      if (prev[i] === undefined) delete process.env[k];
      else process.env[k] = prev[i];
    });
  }
});

test('cleanup() stops the CLI children still running in the project before removing it', async () => {
  const p = makeProject(undefined, fakeProjectEnv());
  const repl = new CliProc(['acp'], { cwd: p.project, env: p.env });
  const acp = new AcpClient([], { cwd: p.project, env: p.env });
  const init = await acp.call('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30_000);
  assert.equal(init.result.protocolVersion, 1);
  // any other child started in the project (e.g. by runCli) is tracked the same way
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: p.project, stdio: 'ignore' });
  trackChild(other, p.project);
  try {
    assert.ok(repl.alive && acp.child.exitCode === null && other.exitCode === null, 'children are running');
    await p.cleanup();
    assert.equal(repl.alive, false, 'the CliProc child was still running after cleanup()');
    assert.ok(acp.child.exitCode !== null || acp.child.signalCode !== null, 'the AcpClient child was still running after cleanup()');
    assert.ok(other.exitCode !== null || other.signalCode !== null, 'a tracked child was still running after cleanup()');
    if (!KEEP) assert.equal(fs.existsSync(p.root), false, 'the temp root was not removed');
  } finally {
    repl.kill();
    acp.kill();
    other.kill('SIGKILL');
  }
});

test('cleanup() leaves children of other projects alone', async () => {
  const a = makeProject(undefined, fakeProjectEnv());
  const b = makeProject(undefined, fakeProjectEnv());
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: b.project, stdio: 'ignore' });
  trackChild(other, b.project);
  try {
    await a.cleanup();
    assert.equal(other.exitCode, null, 'a child of another project was stopped');
    assert.equal(other.signalCode, null);
  } finally {
    other.kill('SIGKILL');
    await b.cleanup();
  }
});
