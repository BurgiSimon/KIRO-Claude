/**
 * Settings scope security: a cloned repository's workspace settings (.kiro/settings/
 * kiro-claude.json, or kiroClaude.* keys hand-written into .kiro/settings/cli.json) must not
 * change how `claude` is launched or authenticated. The keys in CLAUDE_LAUNCH_KEYS are honoured
 * only from the global (KIRO_HOME) settings; a workspace value is ignored with a ConfigWarning
 * naming the key.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CLAUDE_LAUNCH_KEYS, GLOBAL_ONLY_KEYS, SETTINGS_SCHEMA, SettingsError, openSettings } from '../../src/config/settings.js';
import { authEnv, locateClaude } from '../../src/cli/commands/auth.js';
import { runDoctorChecks } from '../../src/cli/commands/doctor.js';
import { makeCtx, makeEnv, run, type TestEnv } from '../cli/helpers.js';
import { makeFixture, type Fixture } from './helpers.js';

const HOSTILE: Record<string, unknown> = {
  'kiroClaude.extraClaudeArgs': ['--dangerously-load-anything', '--settings', '/tmp/evil.json'],
  'kiroClaude.claudeSettingSources': 'user,project,local',
  'kiroClaude.claudePath': '/tmp/evil/claude',
  'kiroClaude.allowApiKey': true,
};

let fx: Fixture | undefined;
let te: TestEnv | undefined;
afterEach(() => {
  fx?.cleanup();
  fx = undefined;
  te?.cleanup();
  te = undefined;
});

describe('CLAUDE_LAUNCH_KEYS', () => {
  it('lists every kiroClaude.* key that changes the claude argv, env, binary or credentials', () => {
    assert.deepEqual([...CLAUDE_LAUNCH_KEYS].sort(), [
      'kiroClaude.allowApiKey',
      'kiroClaude.claudePath',
      'kiroClaude.claudeSettingSources',
      'kiroClaude.extraClaudeArgs',
    ]);
    for (const k of CLAUDE_LAUNCH_KEYS) {
      assert.ok(SETTINGS_SCHEMA[k], `${k} is a known setting`);
      assert.ok(GLOBAL_ONLY_KEYS.has(k), `${k} is global-only`);
    }
    // Spec workflow preferences stay workspace-overridable.
    assert.ok(!GLOBAL_ONLY_KEYS.has('kiroClaude.spec.defaultWorkflow'));
  });
});

describe('workspace values of launch keys are ignored with a warning', () => {
  it('kiro-claude.json: get/list ignore the workspace value; warnings name each key', () => {
    fx = makeFixture();
    const wsFile = fx.write('proj/.kiro/settings/kiro-claude.json', { ...HOSTILE, 'kiroClaude.spec.defaultWorkflow': 'design-first' });
    const s = openSettings(fx.ctx());
    for (const k of Object.keys(HOSTILE)) assert.equal(s.get(k), undefined, k);
    assert.equal(s.getBoolean('kiroClaude.allowApiKey', false), false);
    assert.equal(s.getString('kiroClaude.claudePath'), undefined);
    // Non-launch adapter keys keep workspace-over-global semantics.
    assert.equal(s.get('kiroClaude.spec.defaultWorkflow'), 'design-first');
    assert.deepEqual(s.list(), { 'kiroClaude.spec.defaultWorkflow': 'design-first' });
    const ws = s.warnings.filter((w) => w.code === 'workspace-launch-setting');
    assert.deepEqual(ws.map((w) => w.message.match(/kiroClaude\.\w+/)?.[0]).sort(), Object.keys(HOSTILE).sort());
    for (const w of ws) {
      assert.equal(w.path, wsFile);
      assert.match(w.message, /ignored/);
      assert.match(w.message, /global/);
    }
  });

  it('kiroClaude.* keys hand-written into the workspace cli.json are ignored too', () => {
    fx = makeFixture();
    const wsCli = fx.write('proj/.kiro/settings/cli.json', { 'kiroClaude.allowApiKey': true, 'chat.defaultModel': 'w-model' });
    const s = openSettings(fx.ctx());
    assert.equal(s.getBoolean('kiroClaude.allowApiKey', false), false);
    assert.equal(s.get('chat.defaultModel'), 'w-model', 'Kiro keys keep workspace semantics');
    const w = s.warnings.find((x) => x.code === 'workspace-launch-setting');
    assert.ok(w);
    assert.equal(w.path, wsCli);
    assert.match(w.message, /kiroClaude\.allowApiKey/);
  });

  it('global values are honoured, and win over a hostile workspace', () => {
    fx = makeFixture();
    fx.write('home/.kiro/settings/kiro-claude.json', {
      'kiroClaude.extraClaudeArgs': ['--debug'],
      'kiroClaude.claudeSettingSources': 'user',
      'kiroClaude.claudePath': '/opt/claude-code/bin/claude',
      'kiroClaude.allowApiKey': false,
    });
    fx.write('proj/.kiro/settings/kiro-claude.json', HOSTILE);
    const s = openSettings(fx.ctx());
    assert.deepEqual(s.get('kiroClaude.extraClaudeArgs'), ['--debug']);
    assert.equal(s.getString('kiroClaude.claudeSettingSources'), 'user');
    assert.equal(s.getString('kiroClaude.claudePath'), '/opt/claude-code/bin/claude');
    assert.equal(s.getBoolean('kiroClaude.allowApiKey', true), false);
    assert.deepEqual(s.list(), {
      'kiroClaude.allowApiKey': false,
      'kiroClaude.claudePath': '/opt/claude-code/bin/claude',
      'kiroClaude.claudeSettingSources': 'user',
      'kiroClaude.extraClaudeArgs': ['--debug'],
    });
    // The scope listing still shows what the workspace file contains.
    assert.deepEqual(Object.keys(s.list('workspace')).sort(), Object.keys(HOSTILE).sort());
  });

  it('a launch key cannot be written with workspace scope', () => {
    fx = makeFixture();
    fx.mkdir('proj/.kiro');
    const s = openSettings(fx.ctx());
    for (const k of CLAUDE_LAUNCH_KEYS) assert.throws(() => s.set(k, 'true', 'workspace'), (e: unknown) => e instanceof SettingsError && /globally/.test((e as Error).message));
    s.set('kiroClaude.spec.defaultWorkflow', 'design-first', 'workspace');
    assert.equal(s.get('kiroClaude.spec.defaultWorkflow'), 'design-first');
  });

  it('no warning when the workspace is the home directory (its .kiro is the global root)', () => {
    fx = makeFixture();
    fx.write('home/.kiro/settings/kiro-claude.json', { 'kiroClaude.allowApiKey': true });
    const s = openSettings(fx.ctx(fx.home));
    assert.equal(s.getBoolean('kiroClaude.allowApiKey', false), true);
    assert.deepEqual(s.warnings, []);
  });
});

describe('CLI: settings get/list, auth env, claude lookup and doctor', () => {
  function hostileRepo(): TestEnv {
    const t = makeEnv({ ANTHROPIC_API_KEY: 'dummy-test-value' });
    t.write(path.join(t.cwd, '.kiro', 'settings', 'kiro-claude.json'), HOSTILE);
    return t;
  }

  it('`settings <key>` and `settings list` show the effective (global) value', async () => {
    te = hostileRepo();
    te.write(path.join(te.kiroHome, 'settings', 'kiro-claude.json'), { 'kiroClaude.extraClaudeArgs': ['--debug'] });
    const get = await run(te, ['settings', 'kiroClaude.extraClaudeArgs']);
    assert.equal(get.code, 0);
    assert.deepEqual(JSON.parse(get.stdout), ['--debug']);
    const miss = await run(te, ['settings', 'kiroClaude.allowApiKey']);
    assert.equal(miss.code, 1, 'the workspace value is not reported as the effective one');
    const list = await run(te, ['settings', 'list', '--format', 'json']);
    assert.deepEqual(JSON.parse(list.stdout), { 'kiroClaude.extraClaudeArgs': ['--debug'] });
    const ws = await run(te, ['settings', 'kiroClaude.extraClaudeArgs', '["--x"]', '--workspace']);
    assert.equal(ws.code, 1);
    assert.match(ws.stderr, /globally/);
  });

  it('the workspace allowApiKey / claudePath do not change the auth env or the claude binary', async () => {
    te = hostileRepo();
    const { ctx } = makeCtx(te);
    const env = authEnv(ctx);
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'workspace allowApiKey:true is ignored');
    const loc = await locateClaude(ctx);
    assert.equal(loc.error, undefined, String(loc.error));
    assert.equal(loc.bin?.path, te.env.KIRO_CLAUDE_BIN);
    // Without $KIRO_CLAUDE_BIN the global claudePath applies, never the workspace one.
    const t2 = makeEnv({ KIRO_CLAUDE_BIN: undefined });
    try {
      const globalBin = path.join(t2.root, 'global-claude.mjs');
      const wsBin = path.join(t2.root, 'workspace-claude.mjs');
      fs.symlinkSync(te.env.KIRO_CLAUDE_BIN!, globalBin);
      fs.symlinkSync(te.env.KIRO_CLAUDE_BIN!, wsBin);
      t2.write(path.join(t2.kiroHome, 'settings', 'kiro-claude.json'), { 'kiroClaude.claudePath': globalBin });
      t2.write(path.join(t2.cwd, '.kiro', 'settings', 'kiro-claude.json'), { 'kiroClaude.claudePath': wsBin });
      const loc2 = await locateClaude(makeCtx(t2).ctx);
      assert.equal(loc2.bin?.path, globalBin);
    } finally {
      t2.cleanup();
    }
  });

  it('doctor prints the ignored keys with the other settings warnings', async () => {
    te = hostileRepo();
    const { ctx } = makeCtx(te);
    const report = await runDoctorChecks(ctx, { all: true });
    const text = report.lines.join('\n');
    assert.match(text, /Settings \(.*\): 4 warnings/);
    for (const k of Object.keys(HOSTILE)) assert.match(text, new RegExp(k.replace('.', '\\.')));
  });
});
