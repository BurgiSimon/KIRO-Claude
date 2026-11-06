import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { makeEnv, run, type TestEnv } from './helpers.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv({ EDITOR: 'true' });
  fs.mkdirSync(path.join(t.cwd, '.kiro'), { recursive: true });
});
afterEach(() => t.cleanup());

const globalCli = (): string => path.join(t.kiroHome, 'settings', 'cli.json');
const wsCli = (): string => path.join(t.cwd, '.kiro', 'settings', 'cli.json');
const readJson = (f: string): Record<string, unknown> => JSON.parse(fs.readFileSync(f, 'utf8'));

test('set: JSON-or-string values (Kiro semantics), silent success', async () => {
  const cases: Array<[string, string, unknown]> = [
    ['chat.defaultModel', 'claude-sonnet-4.6', 'claude-sonnet-4.6'],
    ['chat.greeting.enabled', 'false', false],
    ['mcp.initTimeout', '5000', 5000],
    ['chat.modelDefaults', '{"claude-opus-5.5":{"output_config":{"effort":"high"}}}', { 'claude-opus-5.5': { output_config: { effort: 'high' } } }],
    ['knowledge.defaultIncludePatterns', '["*.md"]', ['*.md']],
  ];
  for (const [k, v, want] of cases) {
    const r = await run(t, ['settings', k, v]);
    assert.equal(r.code, 0, k);
    assert.equal(r.stdout + r.stderr, '', k);
    assert.deepEqual(readJson(globalCli())[k], want, k);
  }
});

test('get: strings raw, others pretty JSON; missing ⇒ error exit 1, json ⇒ null', async () => {
  await run(t, ['settings', 'chat.defaultModel', 'claude-haiku-5.5']);
  await run(t, ['settings', 'chat.modelDefaults', '{"a":{"b":1}}']);
  const s = await run(t, ['settings', 'chat.defaultModel']);
  assert.equal(s.stdout, 'claude-haiku-5.5\n');
  const o = await run(t, ['settings', 'chat.modelDefaults']);
  assert.equal(o.stdout, '{\n  "a": {\n    "b": 1\n  }\n}\n');
  const j = await run(t, ['settings', 'chat.modelDefaults', '-f', 'json']);
  assert.equal(j.stdout, '{"a":{"b":1}}\n');
  const js = await run(t, ['settings', '--format', 'json', 'chat.defaultModel']);
  assert.equal(js.stdout, '"claude-haiku-5.5"\n');
  const missing = await run(t, ['settings', 'chat.enableNotifications']);
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr, 'error: No value associated with chat.enableNotifications\n');
  const nullJson = await run(t, ['settings', 'chat.enableNotifications', '--format', 'json-pretty']);
  assert.equal(nullJson.code, 0);
  assert.equal(nullJson.stdout, 'null\n');
  const nothing = await run(t, ['settings']);
  assert.equal(nothing.code, 0);
  assert.equal(nothing.stdout + nothing.stderr, '');
});

test('workspace scope overrides global; global-only keys refuse --workspace', async () => {
  await run(t, ['settings', 'chat.defaultAgent', 'g']);
  const w = await run(t, ['settings', '--workspace', 'chat.defaultAgent', 'w']);
  assert.equal(w.code, 0);
  assert.equal(readJson(wsCli())['chat.defaultAgent'], 'w');
  assert.equal((await run(t, ['settings', 'chat.defaultAgent'])).stdout, 'w\n');
  assert.equal((await run(t, ['settings', 'chat.defaultAgent', '--global'])).stdout, 'g\n');
  const go = await run(t, ['settings', '--workspace', 'acp.agentEngine', 'v2']);
  assert.equal(go.code, 1);
  assert.match(go.stderr, /^error: Setting 'acp\.agentEngine' can only be set globally/);
  const both = await run(t, ['settings', '--global', '--workspace', 'x']);
  assert.equal(both.code, 2);
});

test('adapter keys go to kiro-claude.json; unknown keys warn', async () => {
  const r = await run(t, ['settings', 'kiroClaude.allowApiKey', 'true']);
  assert.equal(r.code, 0);
  assert.equal(readJson(path.join(t.kiroHome, 'settings', 'kiro-claude.json'))['kiroClaude.allowApiKey'], true);
  assert.ok(!fs.existsSync(globalCli()) || readJson(globalCli())['kiroClaude.allowApiKey'] === undefined);
  const u = await run(t, ['settings', 'my.custom.key', 'x']);
  assert.equal(u.code, 0);
  assert.equal(u.stderr, "WARNING: 'my.custom.key' is not a known setting; storing it anyway\n");
});

test('delete: glob; 0 / 1 / many matches (Q texts); errors', async () => {
  await run(t, ['settings', 'chat.a', '1']);
  await run(t, ['settings', 'chat.b', '2']);
  await run(t, ['settings', 'mcp.initTimeout', '3']);
  const one = await run(t, ['settings', '--delete', 'mcp.initTimeout']);
  assert.equal(one.code, 0);
  assert.equal(one.stdout, 'Removing "mcp.initTimeout"\n');
  const many = await run(t, ['settings', '-d', 'chat.*']);
  assert.equal(many.stdout, 'Removing `chat.a`\nRemoving `chat.b`\n');
  assert.deepEqual(readJson(globalCli()), {});
  const none = await run(t, ['settings', '--delete', 'nothing.*']);
  assert.equal(none.code, 1);
  assert.equal(none.stderr, 'error: No settings found matching nothing.*\n');
  const noKey = await run(t, ['settings', '--delete']);
  assert.equal(noKey.code, 1);
  assert.equal(noKey.stderr, "error: the argument '--delete' requires a <KEY>\n Usage: kiro-claude settings --delete <KEY>\n");
  const withValue = await run(t, ['settings', '--delete', 'chat.a', 'x']);
  assert.equal(withValue.code, 1);
  assert.match(withValue.stderr, /cannot be used with '\[VALUE\]'/);
});

test('list: plain / json / json-pretty; scopes; --all', async () => {
  await run(t, ['settings', 'chat.defaultModel', 'auto']);
  await run(t, ['settings', 'chat.greeting.enabled', 'false']);
  await run(t, ['settings', '--workspace', 'chat.defaultAgent', 'w']);
  const p = await run(t, ['settings', 'list']);
  assert.equal(p.stdout, 'chat.defaultAgent = "w"\nchat.defaultModel = "auto"\nchat.greeting.enabled = false\n');
  const g = await run(t, ['settings', 'list', '--global']);
  assert.equal(g.stdout, 'chat.defaultModel = "auto"\nchat.greeting.enabled = false\n');
  const j = await run(t, ['settings', 'list', '-f', 'json']);
  assert.deepEqual(JSON.parse(j.stdout), { 'chat.defaultAgent': 'w', 'chat.defaultModel': 'auto', 'chat.greeting.enabled': false });
  const jp = await run(t, ['settings', '--format', 'json-pretty', 'list']);
  assert.ok(jp.stdout.includes('\n  "chat.defaultModel": "auto"'));
  const hidden = await run(t, ['settings', 'all']);
  assert.equal(hidden.stdout, p.stdout);
  const all = await run(t, ['settings', 'list', '--all']);
  assert.match(all.stdout, /^chat\.allowAnimations\n {2}Description: .+\n {2}Current: not set\n\n/m);
  assert.match(all.stdout, /^chat\.defaultModel\n {2}Description: .+\n {2}Current: "auto"\n/m);
  const allJson = await run(t, ['settings', 'list', '--all', '--format', 'json']);
  const rows = JSON.parse(allJson.stdout) as Array<{ key: string; description: string; current_value: unknown }>;
  const dm = rows.find((r) => r.key === 'chat.defaultModel')!;
  assert.equal(dm.current_value, 'auto');
  assert.equal(rows.find((r) => r.key === 'chat.allowAnimations')!.current_value, null);
});

test('open: $EDITOR on the scope file (created as {})', async () => {
  const r = await run(t, ['settings', 'open']);
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(globalCli(), 'utf8'), '{}\n');
  const w = await run(t, ['settings', 'open', '--workspace']);
  assert.equal(w.code, 0);
  assert.ok(fs.existsSync(wsCli()));
  const failing = await run(t, ['settings', 'open'], { env: { EDITOR: 'false' } });
  assert.equal(failing.code, 1);
});

test('setting alias and invalid settings file', async () => {
  const r = await run(t, ['setting', 'chat.defaultModel', 'x']);
  assert.equal(r.code, 0);
  fs.writeFileSync(globalCli(), '{ broken');
  const w = await run(t, ['settings', 'chat.defaultModel', 'y']);
  assert.equal(w.code, 1);
  assert.match(w.stderr, /^error: Refusing to modify/);
});
