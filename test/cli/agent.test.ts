import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { renameMarkdownAgent, validateAgentFileText } from '../../src/cli/commands/agent.js';
import { makeCtx, makeEnv, run, type TestEnv } from './helpers.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv({ EDITOR: 'true' });
});
afterEach(() => t.cleanup());

const globalAgents = (): string => path.join(t.kiroHome, 'agents');

/** An "editor" script that replaces the file with `content`. */
function editorWriting(content: string): string {
  const data = t.write('editor-data.txt', content);
  const script = t.write('editor.sh', `#!/bin/sh\ncat '${data}' > "$1"\n`);
  fs.chmodSync(script, 0o755);
  return script;
}

test('agent / agent list: Q layout on stderr', async () => {
  t.write(path.join(globalAgents(), 'dev.json'), { name: 'dev', tools: ['*'] });
  t.write(path.join(t.cwd, '.kiro', 'agents', 'local.md'), '---\nname: local\ntools: ["read"]\n---\nBe local.');
  for (const argv of [['agent'], ['agent', 'list']]) {
    const r = await run(t, argv);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    const lines = r.stderr.trimEnd().split('\n');
    assert.deepEqual(
      lines.map((l) => l.split(/\s{4,}/)[0]!.trim()),
      ['local', 'dev', 'kiro_default', 'kiro_planner', 'kiro_help'],
    );
    assert.ok(lines[0]!.endsWith(path.join(t.cwd, '.kiro', 'agents')));
    assert.ok(lines[2]!.endsWith('**No path found**'));
  }
});

test('agent create: template, editor, validation, message; duplicates abort', async () => {
  const r = await run(t, ['agent', 'create', 'reviewer']);
  assert.equal(r.code, 0, r.stderr);
  const file = path.join(globalAgents(), 'reviewer.json');
  assert.equal(r.stdout, `\n📁 Created agent reviewer '${file}'\n\n`);
  const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(body.name, 'reviewer');
  assert.deepEqual(body.tools, ['*']);
  assert.equal(body.includeMcpJson, true);
  const again = await run(t, ['agent', 'create', 'reviewer']);
  assert.equal(again.code, 1);
  assert.equal(again.stderr, 'Agent with name reviewer already exists. Aborting\n');

  const ws = await run(t, ['agent', 'create', '--name', 'wsagent', '-d', 'workspace']);
  assert.equal(ws.code, 0);
  assert.ok(fs.existsSync(path.join(t.cwd, '.kiro', 'agents', 'wsagent.json')));
  const dir = await run(t, ['agent', 'create', 'pathy', '--directory', 'custom/dir']);
  assert.equal(dir.code, 0);
  assert.ok(fs.existsSync(path.join(t.cwd, 'custom', 'dir', 'pathy.json')));

  const from = await run(t, ['agent', 'create', 'copy', '--from', 'reviewer']);
  assert.equal(from.code, 0);
  assert.equal((JSON.parse(fs.readFileSync(path.join(globalAgents(), 'copy.json'), 'utf8')) as { name: string }).name, 'copy');
  const fromBuiltin = await run(t, ['agent', 'create', 'plan2', '-f', 'kiro_planner']);
  assert.equal(fromBuiltin.code, 0);
  const plan2 = JSON.parse(fs.readFileSync(path.join(globalAgents(), 'plan2.json'), 'utf8')) as { tools: string[]; prompt: string };
  assert.deepEqual(plan2.tools, ['read', 'web']);
  assert.match(plan2.prompt, /planning agent/);

  const missing = await run(t, ['agent', 'create']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /^error: the following required arguments were not provided:\n {2}<NAME>/);
  const bad = await run(t, ['agent', 'create', '../escape']);
  assert.equal(bad.code, 1);
  const noFrom = await run(t, ['agent', 'create', 'z', '--from', 'ghost']);
  assert.equal(noFrom.code, 1);
});

test('agent create --from <markdown agent>: only the front matter name changes; the body is never touched', async () => {
  const body = 'You review code.\nname: keep this body line\n\n---\nname: also body\n';
  t.write(path.join(globalAgents(), 'src1.md'), `---\ndescription: no name here\ntools: ["read"]\n---\n${body}`);
  const a = await run(t, ['agent', 'create', 'copy1', '--from', 'src1']);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(fs.readFileSync(path.join(globalAgents(), 'copy1.md'), 'utf8'), `---\nname: copy1\ndescription: no name here\ntools: ["read"]\n---\n${body}`);

  t.write(path.join(globalAgents(), 'src2.md'), `---\n# a comment\nname: src2\ntools: ["read"]\n---\n${body}`);
  const b = await run(t, ['agent', 'create', 'copy2', '--from', 'src2']);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(fs.readFileSync(path.join(globalAgents(), 'copy2.md'), 'utf8'), `---\n# a comment\nname: copy2\ntools: ["read"]\n---\n${body}`);
  const ls = await run(t, ['agent', 'list']);
  assert.match(ls.stderr, /^copy2 /m);
  assert.match(ls.stderr, /^copy1 /m);
});

test('renameMarkdownAgent: front matter only (quoted keys, multi-line values, CRLF, BOM, no front matter, YAML-unsafe names)', () => {
  assert.equal(renameMarkdownAgent('---\nname: old\ntools: ["*"]\n---\nname: body\n', 'new'), '---\nname: new\ntools: ["*"]\n---\nname: body\n');
  assert.equal(renameMarkdownAgent('---\r\nname: old\r\n---\r\nname: body\r\n', 'new'), '---\r\nname: new\r\n---\r\nname: body\r\n');
  assert.equal(renameMarkdownAgent('\ufeff---\ntools: []\n---\nbody\n', 'new'), '\ufeff---\nname: new\ntools: []\n---\nbody\n');
  assert.equal(renameMarkdownAgent('---\n"name": "old"\n---\nx', 'new'), '---\nname: new\n---\nx');
  assert.equal(renameMarkdownAgent("---\nname: >\n  folded\n  old name\ndescription: d\n---\nx", 'new'), '---\nname: new\ndescription: d\n---\nx');
  assert.equal(renameMarkdownAgent('---\ndescription: d\n  name: nested-looking continuation\n---\nx', 'new'), '---\nname: new\ndescription: d\n  name: nested-looking continuation\n---\nx');
  assert.equal(renameMarkdownAgent('---\n---\nbody', 'new'), '---\nname: new\n---\nbody');
  // no front matter: one is added, the body stays byte-for-byte
  assert.equal(renameMarkdownAgent('Just a prompt.\nname: body\n', 'new'), '---\nname: new\n---\nJust a prompt.\nname: body\n');
  assert.equal(renameMarkdownAgent('---\nnot closed\nname: x\n', 'new'), '---\nname: new\n---\n---\nnot closed\nname: x\n');
  // names YAML would read as something else are quoted
  for (const n of ['true', 'null', '123', '1e3', 'a: b', '#x', 'yes', '~']) {
    const out = renameMarkdownAgent('---\nname: old\n---\n', n);
    assert.equal(out, `---\nname: ${JSON.stringify(n)}\n---\n`, n);
  }
  assert.equal(renameMarkdownAgent('---\nname: old\n---\n', 'my-agent_2.v1'), '---\nname: my-agent_2.v1\n---\n');
});

test('agent create: an editor that breaks the file ⇒ post-write validation failure', async () => {
  const editor = editorWriting('{"name": "broken", "tools": 5}');
  const r = await run(t, ['agent', 'create', 'broken'], { env: { EDITOR: editor } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^Post write validation failed for agent 'broken' at path: .*broken\.json\. Malformed config detected: Json supplied at .* is invalid: \/tools: expected array of strings, found number\n$/);
});

test('agent edit: validated temp copy; original untouched on failure; built-ins refused', async () => {
  const file = t.write(path.join(globalAgents(), 'dev.json'), { name: 'dev', tools: ['*'] });
  const good = editorWriting(JSON.stringify({ name: 'dev', tools: ['read'], description: 'edited' }));
  const r = await run(t, ['agent', 'edit', 'dev'], { env: { EDITOR: good } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { description: string }).description, 'edited');
  const before = fs.readFileSync(file, 'utf8');
  const badEditor = editorWriting('{ not json');
  const bad = await run(t, ['agent', 'edit', 'dev'], { env: { EDITOR: badEditor } });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Post write validation failed .* The original file was not changed\.|The original file was not changed\./s);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const same = await run(t, ['agent', 'edit', '--path', file]);
  assert.equal(same.code, 0);
  assert.match(same.stdout, /No changes made/);
  const builtin = await run(t, ['agent', 'edit', 'kiro_default']);
  assert.equal(builtin.code, 1);
  assert.match(builtin.stderr, /built-in agent and cannot be edited/);
  const dflt = await run(t, ['agent', 'edit']);
  assert.equal(dflt.code, 1);
  const ghost = await run(t, ['agent', 'edit', 'ghost']);
  assert.equal(ghost.code, 1);
});

test('agent validate --path (08 KC-CLI-09)', async () => {
  const cases: Array<[string, string | object, RegExp | null]> = [
    ['ok.json', { name: 'ok', tools: ['*'], allowedTools: ['fs_read'], toolsSettings: { fs_write: { allowedPaths: ['~/x'] } } }, null],
    ['unknown-field.json', { name: 'u', tools: ['*'], someFutureField: 1 }, null],
    ['no-tools.json', { name: 'n' }, null],
    ['v3.json', { name: 'v3', tools: ['*'], permissions: { rules: [] } }, null],
    ['tools5.json', { name: 'b', tools: 5 }, /^Error: Json supplied at .*tools5\.json is invalid: \/tools: expected array of strings, found number$/],
    ['syntax.json', '{ "name": "x", ', /^Error: Json supplied at .*syntax\.json is invalid: /],
    ['array.json', '[1,2]', /^Error: Json supplied at .*array\.json is invalid: expected an object, found array$/],
    ['md-ok.md', '---\nname: m\ntools: ["read"]\n---\nPrompt body.', null],
    ['md-bad.md', '---\nname: [unclosed\n---\nbody', /^Error: Markdown agent supplied at .*md-bad\.md is invalid: /],
    ['badprompt.json', { name: 'p', tools: [], prompt: 'file://./missing.md' }, /^Error: Json supplied at .*badprompt\.json is invalid: File URI not found: file:\/\/\.\/missing\.md/],
  ];
  for (const [name, content, want] of cases) {
    const file = t.write(path.join('specs', name), content);
    const r = await run(t, ['agent', 'validate', '--path', file]);
    if (want === null) {
      assert.equal(r.code, 0, `${name}: ${r.stdout}`);
      assert.equal(r.stdout + r.stderr, '', name);
    } else {
      assert.equal(r.code, 1, name);
      assert.match(r.stdout.trimEnd(), want, name);
      assert.ok(r.stdout.includes('is invalid'));
    }
  }
  const rel = await run(t, ['agent', 'validate', '-p', path.relative(t.cwd, path.join(t.root, 'specs', 'tools5.json'))]);
  assert.equal(rel.code, 1);
  assert.ok(rel.stdout.includes('Json supplied at ../specs/tools5.json is invalid'));
  const missing = await run(t, ['agent', 'validate', '--path', path.join(t.root, 'nope.json')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /is invalid: Agent config not found/);
  const noPath = await run(t, ['agent', 'validate']);
  assert.equal(noPath.code, 2);
  assert.match(noPath.stderr, /--path <PATH>/);
  const { ctx } = makeCtx(t);
  assert.equal(validateAgentFileText(path.join(t.root, 'specs', 'ok.json'), ctx), undefined);
});

test('agent set-default writes chat.defaultAgent (global)', async () => {
  t.write(path.join(globalAgents(), 'dev.json'), { name: 'dev', tools: ['*'] });
  const r = await run(t, ['agent', 'set-default', 'dev']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "✓ Default agent set to 'dev'. This will take effect the next time kiro-claude chat is launched.\n");
  const cli = JSON.parse(fs.readFileSync(path.join(t.kiroHome, 'settings', 'cli.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(cli['chat.defaultAgent'], 'dev');
  const legacy = await run(t, ['agent', 'set-default', '-n', 'kiro_planner']);
  assert.equal(legacy.code, 0);
  const ghost = await run(t, ['agent', 'set-default', 'ghost']);
  assert.equal(ghost.code, 1);
  assert.equal(ghost.stderr, 'error: no agent with name ghost found\n');
});

test('agent schema prints the JSON schema', async () => {
  const r = await run(t, ['agent', 'schema']);
  assert.equal(r.code, 0);
  const s = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.equal(s.title, 'Agent');
  assert.ok(s.properties && typeof s.properties === 'object');
});

test('agent migrate: warning without --force; copies legacy agents with --force', async () => {
  const w = await run(t, ['agent', 'migrate']);
  assert.equal(w.code, 0);
  assert.equal(w.stderr, 'WARNING: manual migrate is potentially destructive to existing agent configs with name collision. Use --force to run\n');
  const nothing = await run(t, ['agent', 'migrate', '--force']);
  assert.equal(nothing.stdout, 'Info: Migration was not performed. Nothing to migrate\n');
  t.write(path.join(t.home, '.aws', 'amazonq', 'cli-agents', 'old.json'), { name: 'old', tools: ['*'] });
  t.write(path.join(t.home, '.aws', 'amazonq', 'cli-agents', 'two.json'), { name: 'two', tools: ['*'] });
  t.write(path.join(t.home, '.aws', 'amazonq', 'cli-agents', 'agent_config.json.example'), '{}');
  const r = await run(t, ['agent', 'migrate', '--force']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '✓ Success: Profile migration successful. Migrated 2 agent(s)\n');
  assert.ok(fs.existsSync(path.join(globalAgents(), 'old.json')));
  assert.ok(fs.existsSync(path.join(globalAgents(), 'two.json')));
});

test('agent: unknown subcommand ⇒ exit 2; upgrade not supported; --help', async () => {
  const u = await run(t, ['agent', 'frob']);
  assert.equal(u.code, 2);
  assert.match(u.stderr, /unrecognized subcommand 'frob'/);
  const up = await run(t, ['agent', 'upgrade', '.']);
  assert.equal(up.code, 1);
  const h = await run(t, ['agent', '--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Commands:\n {2}list +List the available agents/);
  const ch = await run(t, ['agent', 'create', '-h']);
  assert.match(ch.stdout, /Usage: kiro-claude agent create \[OPTIONS\] \[NAME\]/);
});
