import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GLOBAL_ONLY_KEYS,
  openSettings,
  parseSettingValue,
  SETTINGS_SCHEMA,
  SettingsError,
  settingDefault,
  isAdapterKey,
} from '../../src/config/settings.js';
import { makeFixture, type Fixture } from './helpers.js';

const readJson = (p: string): unknown => JSON.parse(fs.readFileSync(p, 'utf8'));

describe('config/settings parseSettingValue (Kiro JSON-or-string)', () => {
  const table: [string, unknown][] = [
    ['true', true],
    ['false', false],
    ['5000', 5000],
    ['-1.5', -1.5],
    ['null', null],
    ['["a","b"]', ['a', 'b']],
    ['{"x":1}', { x: 1 }],
    ['"quoted"', 'quoted'],
    [' 42 ', 42],
    ['claude-sonnet-4.6', 'claude-sonnet-4.6'],
    ['True', 'True'], // booleans must be lowercase
    ['yes', 'yes'],
    ['', ''],
    ['[unclosed', '[unclosed'],
    ['kiro_default', 'kiro_default'],
  ];
  for (const [raw, want] of table) {
    it(`${JSON.stringify(raw)} ⇒ ${JSON.stringify(want)}`, () => assert.deepEqual(parseSettingValue(raw), want));
  }
});

describe('config/settings schema', () => {
  it('covers the adapter keys with the required types/defaults', () => {
    assert.equal(SETTINGS_SCHEMA['kiroClaude.claudePath']!.type, 'string');
    assert.equal(SETTINGS_SCHEMA['kiroClaude.allowApiKey']!.type, 'boolean');
    assert.equal(SETTINGS_SCHEMA['kiroClaude.allowApiKey']!.default, false);
    assert.equal(SETTINGS_SCHEMA['kiroClaude.claudeSettingSources']!.type, 'string');
    assert.equal(SETTINGS_SCHEMA['kiroClaude.claudeSettingSources']!.default, '');
    assert.equal(SETTINGS_SCHEMA['kiroClaude.extraClaudeArgs']!.type, 'array');
    for (const k of ['kiroClaude.spec.defaultWorkflow', 'kiroClaude.spec.maxParallelTasks', 'kiroClaude.autonomy']) {
      assert.ok(SETTINGS_SCHEMA[k], k);
    }
    for (const k of ['chat.defaultModel', 'chat.defaultAgent', 'chat.disableInheritingDefaultResources', 'mcp.initTimeout', 'chat.greeting.enabled']) {
      assert.ok(SETTINGS_SCHEMA[k], k);
    }
    for (const [k, v] of Object.entries(SETTINGS_SCHEMA)) assert.ok(v.description.length > 0, k);
  });
  it('global-only keys per 01 §7.1', () => {
    for (const k of ['chat.agentEngine', 'chat.uiMode', 'chat.terminalTitle', 'chat.screenReader', 'chat.enableAutoAgentUpgrade', 'app.warnOnElevatedPrivileges', 'acp.agentEngine']) {
      assert.ok(GLOBAL_ONLY_KEYS.has(k), k);
    }
    assert.ok(!GLOBAL_ONLY_KEYS.has('chat.defaultModel'));
  });
  it('defaults and adapter-key detection', () => {
    assert.equal(settingDefault('mcp.initTimeout'), 5000);
    assert.equal(settingDefault('nope'), undefined);
    assert.equal(isAdapterKey('kiroClaude.x'), true);
    assert.equal(isAdapterKey('chat.x'), false);
  });
});

describe('config/settings store', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('reads nothing when no files exist', () => {
    fx = makeFixture();
    const s = openSettings(fx.ctx());
    assert.equal(s.get('chat.defaultModel'), undefined);
    assert.deepEqual(s.list(), {});
    assert.deepEqual(s.warnings, []);
    assert.equal(s.getBoolean('chat.greeting.enabled', true), true);
    assert.equal(s.getNumber('mcp.initTimeout', 5000), 5000);
  });

  it('workspace overrides global; global-only keys ignore workspace values', () => {
    fx = makeFixture();
    fx.write('home/.kiro/settings/cli.json', { 'chat.defaultModel': 'g-model', 'chat.agentEngine': 'v2', 'chat.greeting.enabled': true });
    fx.write('proj/.kiro/settings/cli.json', { 'chat.defaultModel': 'w-model', 'chat.agentEngine': 'v1', 'chat.disableWrap': true });
    const s = openSettings(fx.ctx());
    assert.equal(s.get('chat.defaultModel'), 'w-model');
    assert.equal(s.get('chat.agentEngine'), 'v2');
    assert.equal(s.getBoolean('chat.disableWrap', false), true);
    assert.deepEqual(s.list('effective'), {
      'chat.agentEngine': 'v2',
      'chat.defaultModel': 'w-model',
      'chat.disableWrap': true,
      'chat.greeting.enabled': true,
    });
    assert.deepEqual(Object.keys(s.list('global')), ['chat.agentEngine', 'chat.defaultModel', 'chat.greeting.enabled']);
    assert.deepEqual(Object.keys(s.list('workspace')), ['chat.agentEngine', 'chat.defaultModel', 'chat.disableWrap']);
  });

  it('set parses strings as JSON-or-string, writes sorted pretty JSON, and sees external edits', () => {
    fx = makeFixture();
    const s = openSettings(fx.ctx());
    s.set('chat.greeting.enabled', 'false');
    s.set('mcp.initTimeout', '9000');
    s.set('chat.defaultModel', 'claude-sonnet-4.6');
    s.set('knowledge.defaultIncludePatterns', '["*.md"]');
    s.set('chat.modelDefaults', { 'claude-opus-5.5': { output_config: { effort: 'high' } } });
    const p = path.join(fx.kiroHome, 'settings', 'cli.json');
    assert.deepEqual(readJson(p), {
      'chat.defaultModel': 'claude-sonnet-4.6',
      'chat.greeting.enabled': false,
      'chat.modelDefaults': { 'claude-opus-5.5': { output_config: { effort: 'high' } } },
      'knowledge.defaultIncludePatterns': ['*.md'],
      'mcp.initTimeout': 9000,
    });
    assert.equal(fs.readFileSync(p, 'utf8').endsWith('\n'), true);
    assert.equal(s.getBoolean('chat.greeting.enabled', true), false);
    assert.equal(s.getNumber('mcp.initTimeout', 1), 9000);
    assert.equal(s.getString('mcp.initTimeout'), '9000');
    // external edit is picked up (size changes)
    fs.writeFileSync(p, JSON.stringify({ 'chat.defaultModel': 'external-model-id' }));
    assert.equal(s.get('chat.defaultModel'), 'external-model-id');
  });

  it('getters coerce strings and fall back on wrong types', () => {
    fx = makeFixture();
    fx.write('home/.kiro/settings/cli.json', { a: 'true', b: 'false', c: '12', d: 'x', e: [1], f: 3.5, g: true });
    const s = openSettings(fx.ctx());
    assert.equal(s.getBoolean('a', false), true);
    assert.equal(s.getBoolean('b', true), false);
    assert.equal(s.getBoolean('d', true), true);
    assert.equal(s.getNumber('c', 0), 12);
    assert.equal(s.getNumber('d', 7), 7);
    assert.equal(s.getNumber('f', 0), 3.5);
    assert.equal(s.getString('e'), undefined);
    assert.equal(s.getString('g'), 'true');
  });

  it('routes kiroClaude.* keys to kiro-claude.json (global and workspace)', () => {
    fx = makeFixture();
    fx.mkdir('proj/.kiro');
    const s = openSettings(fx.ctx());
    s.set('kiroClaude.allowApiKey', 'true');
    s.set('kiroClaude.spec.defaultWorkflow', 'design-first', 'workspace');
    // launch keys (claude argv/env/binary/credentials) are global-only
    assert.throws(() => s.set('kiroClaude.extraClaudeArgs', '["--debug"]', 'workspace'), /only be set globally/);
    s.set('chat.defaultAgent', 'reviewer', 'workspace');
    assert.deepEqual(readJson(path.join(fx.kiroHome, 'settings', 'kiro-claude.json')), { 'kiroClaude.allowApiKey': true });
    assert.equal(fs.existsSync(path.join(fx.kiroHome, 'settings', 'cli.json')), false);
    assert.deepEqual(readJson(path.join(fx.ws, '.kiro', 'settings', 'kiro-claude.json')), { 'kiroClaude.spec.defaultWorkflow': 'design-first' });
    assert.deepEqual(readJson(path.join(fx.ws, '.kiro', 'settings', 'cli.json')), { 'chat.defaultAgent': 'reviewer' });
    assert.equal(s.getBoolean('kiroClaude.allowApiKey', false), true);
    assert.equal(s.get('kiroClaude.spec.defaultWorkflow'), 'design-first');
    assert.deepEqual(s.get('kiroClaude.extraClaudeArgs'), undefined);
    assert.equal(s.pathFor('kiroClaude.x', 'global'), path.join(fx.kiroHome, 'settings', 'kiro-claude.json'));
    assert.equal(s.pathFor('chat.x', 'workspace'), path.join(fx.ws, '.kiro', 'settings', 'cli.json'));
    assert.deepEqual(Object.keys(s.list()), ['chat.defaultAgent', 'kiroClaude.allowApiKey', 'kiroClaude.spec.defaultWorkflow']);
  });

  it('a kiroClaude.* key hand-written in cli.json is read, and moved on set', () => {
    fx = makeFixture();
    const cli = fx.write('home/.kiro/settings/cli.json', { 'kiroClaude.claudePath': '/opt/c', 'chat.x': 1 });
    const s = openSettings(fx.ctx());
    assert.equal(s.get('kiroClaude.claudePath'), '/opt/c');
    s.set('kiroClaude.claudePath', '/usr/bin/claude');
    assert.equal(s.get('kiroClaude.claudePath'), '/usr/bin/claude');
    assert.deepEqual(readJson(cli), { 'chat.x': 1 });
  });

  it('delete takes a glob and returns deleted keys sorted (both files of the scope)', () => {
    fx = makeFixture();
    fx.write('home/.kiro/settings/cli.json', { 'chat.a': 1, 'chat.b.c': 2, 'mcp.initTimeout': 3 });
    fx.write('home/.kiro/settings/kiro-claude.json', { 'kiroClaude.autonomy': 'supervised', 'kiroClaude.spec.maxParallelTasks': 2 });
    const s = openSettings(fx.ctx());
    assert.deepEqual(s.delete('chat.*'), ['chat.a', 'chat.b.c']);
    assert.deepEqual(s.delete('nothing.*'), []);
    assert.deepEqual(s.delete('kiroClaude.spec.*'), ['kiroClaude.spec.maxParallelTasks']);
    assert.deepEqual(s.delete('mcp.initTimeout'), ['mcp.initTimeout']);
    assert.deepEqual(s.delete('mcp.init?imeout'), []);
    assert.deepEqual(s.list('global'), { 'kiroClaude.autonomy': 'supervised' });
    assert.deepEqual(s.delete('*'), ['kiroClaude.autonomy']);
  });

  it('workspace delete only touches workspace files', () => {
    fx = makeFixture();
    fx.write('home/.kiro/settings/cli.json', { 'chat.a': 1 });
    fx.write('proj/.kiro/settings/cli.json', { 'chat.a': 2 });
    const s = openSettings(fx.ctx());
    assert.equal(s.get('chat.a'), 2);
    assert.deepEqual(s.delete('chat.a', 'workspace'), ['chat.a']);
    assert.equal(s.get('chat.a'), 1);
  });

  it('rejects workspace scope for global-only keys and empty keys', () => {
    fx = makeFixture();
    fx.mkdir('proj/.kiro');
    const s = openSettings(fx.ctx());
    assert.throws(() => s.set('chat.agentEngine', 'v2', 'workspace'), SettingsError);
    assert.throws(() => s.set('', 'x'), SettingsError);
    s.set('chat.agentEngine', 'v2');
    assert.equal(s.get('chat.agentEngine'), 'v2');
  });

  it('invalid JSON: reads as empty with a line/column warning; writes are refused', () => {
    fx = makeFixture();
    const p = fx.write('home/.kiro/settings/cli.json', '{\n  "chat.a": 1,\n  oops\n}\n');
    const s = openSettings(fx.ctx());
    assert.equal(s.get('chat.a'), undefined);
    const w = s.warnings;
    assert.equal(w.length, 1);
    assert.equal(w[0]!.code, 'invalid-settings');
    assert.match(w[0]!.message, /line 3 column 3/);
    assert.throws(() => s.set('chat.b', 1), /Refusing to modify/);
    assert.equal(fs.readFileSync(p, 'utf8'), '{\n  "chat.a": 1,\n  oops\n}\n');
  });

  it('non-object root warns', () => {
    fx = makeFixture();
    fx.write('home/.kiro/settings/cli.json', '[1,2]');
    const s = openSettings(fx.ctx());
    assert.equal(s.warnings[0]!.code, 'invalid-settings');
  });

  it('at home, workspace scope writes the global file', () => {
    fx = makeFixture();
    const s = openSettings(fx.ctx(fx.home));
    assert.equal(s.files.workspace, undefined);
    s.set('chat.defaultModel', 'm', 'workspace');
    assert.deepEqual(readJson(path.join(fx.kiroHome, 'settings', 'cli.json')), { 'chat.defaultModel': 'm' });
    assert.equal(s.get('chat.defaultModel'), 'm');
    assert.deepEqual(s.list('workspace'), {});
  });

  it('honors KIRO_HOME', () => {
    fx = makeFixture();
    const kh = fx.mkdir('custom-kiro');
    const s = openSettings(fx.ctx(undefined, { KIRO_HOME: kh }));
    s.set('chat.defaultAgent', 'x');
    assert.deepEqual(readJson(path.join(kh, 'settings', 'cli.json')), { 'chat.defaultAgent': 'x' });
  });
});
