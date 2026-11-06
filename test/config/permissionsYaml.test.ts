import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  addPermissionRule,
  CAPABILITIES,
  DEFAULT_SHELL_ALLOW,
  formatPermissionsYaml,
  loadPermissionScopes,
  parsePermissionRule,
  parsePermissionsYaml,
  permissionsPaths,
  presetRules,
  PRESETS,
  savePermissionsFile,
  setWorkspaceTrusted,
  workspaceRootHash,
} from '../../src/config/permissionsYaml.js';
import { codes, makeFixture, type Fixture } from './helpers.js';

/** The 02 §2.8 rule-schema example, verbatim. */
const EXAMPLE_02_2_8 = `rules:
  - capability: shell            # required
    match: ["npm *", "git *"]    # optional glob list; absent = everything for that capability
    exclude: ["npm publish*"]    # optional; patterns that must NOT match
    effect: allow                # required: allow | ask | deny | evaluate
policies:                        # optional (user/workspace files only): preset IDs
  - approve-for-me
workspaceTrusted: true           # workspace-root file only (written by trust screen)
`;

describe('config/permissionsYaml parsing (02 §2.8)', () => {
  it('parses the 02 §2.8 example', () => {
    const r = parsePermissionsYaml(EXAMPLE_02_2_8, 'workspace', '/p.yaml');
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.rules, [{ capability: 'shell', match: ['npm *', 'git *'], exclude: ['npm publish*'], effect: 'allow', scope: 'workspace' }]);
    assert.deepEqual(r.presets, ['approve-for-me']);
    assert.equal(r.workspaceTrusted, true);
  });

  it('empty and comment-only documents', () => {
    for (const t of ['', '# nothing\n', '---\n']) {
      const r = parsePermissionsYaml(t, 'user');
      assert.deepEqual([r.rules, r.presets, r.warnings], [[], [], []], JSON.stringify(t));
    }
  });

  it('match/exclude accept a scalar string', () => {
    const r = parsePermissionsYaml('rules:\n  - capability: fs_write\n    match: .env\n    exclude: "docs/**"\n    effect: deny\n', 'user');
    assert.deepEqual(r.rules, [{ capability: 'fs_write', match: ['.env'], exclude: ['docs/**'], effect: 'deny', scope: 'user' }]);
  });

  it('invalid rules, unknown presets and wrong shapes warn and are dropped', () => {
    const text = `rules:
  - capability: shell
    effect: maybe
  - effect: allow
  - "just a string"
  - capability: mcp
    match: [1, 2]
    effect: allow
  - capability: web_fetch
    effect: evaluate
policies: [read-all, no-such-preset, read-all]
workspaceTrusted: "yes"
`;
    const r = parsePermissionsYaml(text, 'user', '/u.yaml');
    assert.deepEqual(r.rules, [{ capability: 'web_fetch', effect: 'evaluate', scope: 'user' }]);
    assert.deepEqual(r.presets, ['read-all']);
    assert.equal(r.workspaceTrusted, undefined);
    assert.deepEqual(codes(r.warnings), ['permissions-invalid', 'permissions-invalid', 'permissions-invalid', 'permissions-invalid', 'unknown-preset']);
    assert.ok(r.warnings.every((w) => w.path === '/u.yaml'));
    assert.match(r.warnings[0]!.message, /invalid effect "maybe" \(allow\|ask\|deny\|evaluate\)/);
  });

  it('invalid YAML and non-mapping roots', () => {
    const bad = parsePermissionsYaml('rules: [\n', 'user', '/u.yaml');
    assert.deepEqual(codes(bad.warnings), ['invalid-yaml']);
    assert.match(bad.warnings[0]!.message, /^\/u\.yaml: .* at line \d+$/);
    assert.deepEqual(codes(parsePermissionsYaml('- a\n- b\n', 'user').warnings), ['permissions-invalid']);
    assert.deepEqual(codes(parsePermissionsYaml('rules: {a: 1}\n', 'user').warnings), ['permissions-invalid']);
    assert.deepEqual(codes(parsePermissionsYaml('policies: {a: 1}\n', 'user').warnings), ['permissions-invalid']);
  });

  const ruleTable: [unknown, string | undefined][] = [
    [{ capability: 'shell', effect: 'allow' }, undefined],
    [{ capability: ' shell ', effect: 'ask' }, undefined],
    [{ capability: 'all', effect: 'deny', match: [] }, undefined],
    [{ capability: '', effect: 'allow' }, 'rule needs a "capability"'],
    [{ capability: 'shell' }, `rule for 'shell' has invalid effect undefined (allow|ask|deny|evaluate)`],
    [{ capability: 'shell', effect: 'ALLOW' }, `rule for 'shell' has invalid effect "ALLOW" (allow|ask|deny|evaluate)`],
    [{ capability: 'shell', effect: 'allow', exclude: 5 }, `rule for 'shell': "exclude" must be a string or a list of strings`],
    [null, 'rule must be a mapping'],
    [['x'], 'rule must be a mapping'],
  ];
  for (const [raw, err] of ruleTable) {
    it(`parsePermissionRule(${JSON.stringify(raw)})`, () => {
      const r = parsePermissionRule(raw, 'agent');
      assert.equal(r.error, err);
      if (!err) assert.equal(r.rule!.scope, 'agent');
    });
  }

  it('capability names are trimmed', () => {
    assert.equal(parsePermissionRule({ capability: ' shell ', effect: 'ask' }, 'user').rule!.capability, 'shell');
  });
});

describe('config/permissionsYaml presets (02 §2.8)', () => {
  it('has every documented preset id', () => {
    assert.deepEqual(Object.keys(PRESETS).sort(), ['allow-all', 'approve-for-me', 'dev-shell', 'edit-workspace', 'read-all', 'read-only-shell', 'read-workspace']);
    for (const rules of Object.values(PRESETS)) for (const r of rules) assert.equal(r.scope, 'preset');
  });

  it('rule shapes', () => {
    assert.deepEqual(PRESETS['allow-all'], [{ capability: 'all', effect: 'allow', scope: 'preset' }]);
    assert.deepEqual(PRESETS['read-workspace'], [{ capability: 'fs_read', match: ['./**'], effect: 'allow', scope: 'preset' }]);
    assert.deepEqual(
      PRESETS['edit-workspace']!.map((r) => [r.capability, r.match, r.effect]),
      [
        ['fs_read', ['./**'], 'allow'],
        ['fs_write', ['./**'], 'allow'],
      ],
    );
    assert.deepEqual(PRESETS['read-all']!.map((r) => [r.capability, r.match, r.effect]), [
      ['fs_read', undefined, 'allow'],
      ['web_fetch', undefined, 'allow'],
      ['web_search', undefined, 'allow'],
    ]);
  });

  it('read-only-shell ⊂ dev-shell; default shell allow-list ⊂ read-only-shell', () => {
    const ro = PRESETS['read-only-shell']![0]!.match!;
    const dev = PRESETS['dev-shell']![0]!.match!;
    for (const m of DEFAULT_SHELL_ALLOW) assert.ok(ro.includes(m), m);
    for (const m of ro) assert.ok(dev.includes(m), m);
    for (const m of ['git status*', 'pwd', 'whoami']) assert.ok(ro.includes(m), m);
    for (const m of ['npm *', 'cargo *', 'mkdir *', 'git commit*']) assert.ok(dev.includes(m), m);
    assert.ok(!ro.includes('npm *'));
  });

  it('approve-for-me = edit-workspace + read-only-shell + evaluate for everything (no classifier ⇒ ask)', () => {
    const r = PRESETS['approve-for-me']!;
    assert.deepEqual(r.slice(0, 2), PRESETS['edit-workspace']);
    assert.deepEqual(r[2], PRESETS['read-only-shell']![0]);
    assert.deepEqual(r[3], { capability: 'all', effect: 'evaluate', scope: 'preset' });
  });

  it('presetRules copies (callers cannot mutate PRESETS) and skips unknown ids', () => {
    const rules = presetRules(['read-workspace', 'nope', 'allow-all']);
    assert.deepEqual(rules.map((r) => r.capability), ['fs_read', 'all']);
    rules[0]!.match!.push('MUTATED');
    assert.deepEqual(PRESETS['read-workspace']![0]!.match, ['./**']);
  });

  it('CAPABILITIES lists concrete and meta capabilities', () => {
    for (const c of ['fs_read', 'fs_write', 'shell', 'web_fetch', 'web_search', 'mcp', 'subagent', 'skill', 'all', 'builtin', 'filesystem', 'sandbox_network']) {
      assert.ok(CAPABILITIES.includes(c), c);
    }
  });
});

describe('config/permissionsYaml files', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('workspaceRootHash = sha256(realpath(root)) first 16 hex; paths under KIRO_HOME', () => {
    fx = makeFixture();
    fx.mkdir('proj/.kiro');
    const ws = fx.ctx();
    const want = createHash('sha256').update(fs.realpathSync(fx.ws)).digest('hex').slice(0, 16);
    assert.equal(workspaceRootHash(ws), want);
    assert.match(want, /^[0-9a-f]{16}$/);
    assert.deepEqual(permissionsPaths(ws), {
      user: path.join(fx.kiroHome, 'settings', 'permissions.yaml'),
      workspace: path.join(fx.kiroHome, 'workspace-roots', want, 'permissions.yaml'),
    });
    // same root through a symlink ⇒ same hash
    fs.symlinkSync(fx.ws, path.join(fx.root, 'proj-link'));
    assert.equal(workspaceRootHash(fx.ctx(path.join(fx.root, 'proj-link'))), want);
  });

  it('loadPermissionScopes reads user + workspace files and merges presets', () => {
    fx = makeFixture();
    const ws = fx.ctx();
    const p = permissionsPaths(ws);
    fx.write(p.user, 'rules:\n  - capability: shell\n    match: ["ls *"]\n    effect: allow\npolicies: [read-all]\n');
    fx.write(p.workspace, EXAMPLE_02_2_8 + 'policies_extra: ignored\n');
    const r = loadPermissionScopes(ws);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.user, [{ capability: 'shell', match: ['ls *'], effect: 'allow', scope: 'user' }]);
    assert.deepEqual(r.workspace.map((x) => x.scope), ['workspace']);
    assert.deepEqual(r.presets, ['read-all', 'approve-for-me']);
    assert.equal(r.workspaceTrusted, true);
  });

  it('no files ⇒ empty scopes, no warnings; bad files ⇒ warnings', () => {
    fx = makeFixture();
    const ws = fx.ctx();
    assert.deepEqual(loadPermissionScopes(ws), { user: [], workspace: [], presets: [], warnings: [] });
    fx.write(permissionsPaths(ws).user, 'rules: [\n');
    const r = loadPermissionScopes(ws);
    assert.deepEqual(codes(r.warnings), ['invalid-yaml']);
    assert.equal(r.warnings[0]!.path, permissionsPaths(ws).user);
  });

  it('writers round-trip and dedupe; trust flag recorded with the workspace root', () => {
    fx = makeFixture();
    const ws = fx.ctx();
    const f = addPermissionRule(ws, 'user', { capability: 'shell', match: ['npm test'], effect: 'allow' });
    addPermissionRule(ws, 'user', { capability: 'shell', match: ['npm test'], effect: 'allow', scope: 'session' });
    addPermissionRule(ws, 'user', { capability: 'fs_write', match: ['.env', 'secrets/**'], exclude: ['x "quoted"'], effect: 'deny' });
    assert.equal(f, permissionsPaths(ws).user);
    let r = loadPermissionScopes(ws);
    assert.deepEqual(r.user, [
      { capability: 'shell', match: ['npm test'], effect: 'allow', scope: 'user' },
      { capability: 'fs_write', match: ['.env', 'secrets/**'], exclude: ['x "quoted"'], effect: 'deny', scope: 'user' },
    ]);
    assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600');
    const wf = setWorkspaceTrusted(ws, true);
    assert.equal(wf, permissionsPaths(ws).workspace);
    r = loadPermissionScopes(ws);
    assert.equal(r.workspaceTrusted, true);
    assert.ok(fs.readFileSync(wf, 'utf8').includes(`workspaceRoot: ${JSON.stringify(fs.realpathSync(fx.ws))}`));
    addPermissionRule(ws, 'workspace', { capability: 'mcp', match: ['git/*'], effect: 'ask' });
    r = loadPermissionScopes(ws);
    assert.equal(r.workspaceTrusted, true);
    assert.deepEqual(r.workspace, [{ capability: 'mcp', match: ['git/*'], effect: 'ask', scope: 'workspace' }]);
    setWorkspaceTrusted(ws, false);
    assert.equal(loadPermissionScopes(ws).workspaceTrusted, false);
    assert.equal(loadPermissionScopes(ws).workspace.length, 1);
  });

  it('writers refuse to clobber an unparsable file', () => {
    fx = makeFixture();
    const ws = fx.ctx();
    fx.write(permissionsPaths(ws).user, 'rules: [\n');
    assert.throws(() => addPermissionRule(ws, 'user', { capability: 'shell', effect: 'allow' }), /Refusing to rewrite/);
    assert.equal(fs.readFileSync(permissionsPaths(ws).user, 'utf8'), 'rules: [\n');
  });

  it('formatPermissionsYaml output parses back identically', () => {
    const data = {
      rules: [
        { capability: 'shell', match: ['git *', 'a: b', "it's"], effect: 'allow' as const },
        { capability: 'all', effect: 'evaluate' as const },
      ],
      presets: ['read-all'],
      workspaceTrusted: false,
      workspaceRoot: '/x/[y] z',
    };
    const text = formatPermissionsYaml(data);
    const back = parsePermissionsYaml(text, 'workspace');
    assert.deepEqual(back.warnings, []);
    assert.deepEqual(back.rules, data.rules.map((r) => ({ ...r, scope: 'workspace' })));
    assert.deepEqual(back.presets, ['read-all']);
    assert.equal(back.workspaceTrusted, false);
    assert.equal(back.workspaceRoot, '/x/[y] z');
    assert.equal(formatPermissionsYaml({ rules: [] }), '# Kiro permissions (written by kiro-claude)\nrules: []\n');
  });

  it('savePermissionsFile creates parent directories', () => {
    fx = makeFixture();
    const f = path.join(fx.root, 'a', 'b', 'permissions.yaml');
    savePermissionsFile(f, { rules: [{ capability: 'shell', effect: 'deny' }] });
    assert.deepEqual(parsePermissionsYaml(fs.readFileSync(f, 'utf8'), 'user').rules, [{ capability: 'shell', effect: 'deny', scope: 'user' }]);
  });
});
