import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  allHooksFor,
  convertLegacyHook,
  fileGlobsToRegex,
  loadHookFiles,
  normalizeAgentHooks,
  normalizeHookTrigger,
  toolTypesToMatcher,
  type LoadedKiroHook,
} from '../../src/config/hooks.js';
import type { ConfigWarning, KiroHook } from '../../src/types.js';
import { codes, makeFixture, type Fixture } from './helpers.js';

describe('config/hooks trigger aliases', () => {
  const table: [string, string | undefined][] = [
    ['agentSpawn', 'SessionStart'],
    ['AgentSpawn', 'SessionStart'],
    ['SessionStart', 'SessionStart'],
    ['sessionStart', 'SessionStart'],
    ['conversation_start', 'SessionStart'],
    ['userPromptSubmit', 'UserPromptSubmit'],
    ['promptSubmit', 'UserPromptSubmit'],
    ['per_prompt', 'UserPromptSubmit'],
    ['preToolUse', 'PreToolUse'],
    ['PostToolUse', 'PostToolUse'],
    ['stop', 'Stop'],
    ['agentStop', 'Stop'],
    ['SessionEnd', 'SessionEnd'],
    ['PostFileCreate', 'PostFileCreate'],
    ['fileCreated', 'PostFileCreate'],
    ['fileEdited', 'PostFileSave'],
    ['PostFileSave', 'PostFileSave'],
    ['fileDeleted', 'PostFileDelete'],
    ['preTaskExecution', 'PreTaskExec'],
    ['PostTaskExec', 'PostTaskExec'],
    ['userTriggered', 'Manual'],
    ['Manual', 'Manual'],
    ['nonsense', undefined],
  ];
  for (const [raw, want] of table) it(`${raw} ⇒ ${want}`, () => assert.equal(normalizeHookTrigger(raw), want));
});

describe('config/hooks normalizeAgentHooks', () => {
  it('V2 object form: defaults, names, matcher, snake_case fields', () => {
    const r = normalizeAgentHooks(
      {
        agentSpawn: [{ command: 'git status' }],
        userPromptSubmit: [{ command: 'date', cache_ttl_seconds: 60 }],
        preToolUse: [
          { command: 'a', matcher: 'fs_*', timeout_ms: 5000, max_output_size: 100 },
          { command: 'b', matcher: '@git' },
        ],
        postToolUse: [{ command: 'c', disabled: true }],
        stop: [{ command: 'd' }],
      },
      'agentX',
      '/p/agentX.json',
    );
    assert.deepEqual(r.warnings, []);
    const h = r.hooks;
    assert.deepEqual(
      h.map((x) => [x.name, x.trigger, x.rawTrigger, x.timeoutMs, x.maxOutputBytes, x.cacheTtlSec, x.matcher, x.enabled]),
      [
        ['agentSpawn-0', 'SessionStart', 'agentSpawn', 30000, 10240, 0, undefined, true],
        ['userPromptSubmit-0', 'UserPromptSubmit', 'userPromptSubmit', 30000, 10240, 60, undefined, true],
        ['preToolUse-0', 'PreToolUse', 'preToolUse', 5000, 100, 0, 'fs_*', true],
        ['preToolUse-1', 'PreToolUse', 'preToolUse', 30000, 10240, 0, '@git', true],
        ['postToolUse-0', 'PostToolUse', 'postToolUse', 30000, 10240, 0, undefined, false],
        ['stop-0', 'Stop', 'stop', 30000, 10240, 0, undefined, true],
      ],
    );
    for (const x of h) {
      assert.equal(x.dialect, 'v2');
      assert.equal(x.source, 'agent');
      assert.equal(x.agentName, 'agentX');
      assert.equal(x.sourcePath, '/p/agentX.json');
      assert.equal(x.action.type, 'command');
    }
  });

  it('V2 object form: invalid entries and unknown triggers warn', () => {
    const r = normalizeAgentHooks(
      { agentSpawn: [{ nope: 1 }, 'x'], bogus: [{ command: 'x' }], SessionEnd: [{ command: 'y' }], stop: 'x', preToolUse: [{ command: 'z', timeout_ms: -5 }] },
      'a',
    );
    assert.deepEqual(codes(r.warnings), ['hook-invalid', 'hook-invalid', 'hook-trigger', 'hook-trigger', 'hook-invalid', 'hook-invalid']);
    assert.equal(r.hooks.length, 1);
    assert.equal(r.hooks[0]!.timeoutMs, 30000);
  });

  it('V3 array form: action types, timeout seconds (0 = none), enabled, confirm only on Stop command hooks', () => {
    const r = normalizeAgentHooks(
      [
        { name: 'lint', trigger: 'PreToolUse', matcher: 'write', action: { type: 'command', command: 'npm run lint' }, timeout: 30 },
        { name: 'ctx', trigger: 'agentSpawn', action: { type: 'agent', prompt: 'Look around' } },
        { name: 'forever', trigger: 'Stop', action: { type: 'command', command: 'x' }, timeout: 0, enabled: false },
        {
          name: 'submit',
          trigger: 'Stop',
          action: { type: 'command', command: './submit.sh' },
          confirm: {
            question: "Submit this session's results?",
            confirmCommand: './confirm-options.sh',
            options: [
              { id: 'submit', label: 'Yes, submit', run: true },
              { id: 'dismiss', label: 'Not this time', run: false },
            ],
          },
        },
        { name: 'bad-confirm', trigger: 'PreToolUse', action: { type: 'command', command: 'x' }, confirm: { question: 'q' } },
        { name: 'file', trigger: 'PostFileSave', matcher: '\\.ts$', action: { type: 'command', command: 'tsc {{filePath}}' } },
      ],
      'v3agent',
    );
    assert.deepEqual(codes(r.warnings), ['hook-invalid']);
    const by = Object.fromEntries(r.hooks.map((h) => [h.name, h]));
    assert.equal(by.lint!.timeoutMs, 30000);
    assert.equal(by.lint!.matcher, 'write');
    assert.equal(by.lint!.dialect, 'v3');
    assert.equal(by.ctx!.timeoutMs, 60000);
    assert.equal(by.ctx!.rawTrigger, 'agentSpawn');
    assert.equal(by.ctx!.trigger, 'SessionStart');
    assert.deepEqual(by.ctx!.action, { type: 'agent', prompt: 'Look around' });
    assert.equal(by.forever!.timeoutMs, 0);
    assert.equal(by.forever!.enabled, false);
    assert.deepEqual(by.submit!.confirm, {
      question: "Submit this session's results?",
      confirmCommand: './confirm-options.sh',
      options: [
        { id: 'submit', label: 'Yes, submit', run: true },
        { id: 'dismiss', label: 'Not this time', run: false },
      ],
    });
    assert.equal(by['bad-confirm']!.confirm, undefined);
    assert.equal(by.file!.trigger, 'PostFileSave');
    for (const h of r.hooks) {
      assert.equal(h.maxOutputBytes, 10240);
      assert.equal(h.cacheTtlSec, 0);
      assert.equal(h.agentName, 'v3agent');
    }
  });

  it('V3 array form: missing name/trigger/action', () => {
    const r = normalizeAgentHooks(
      [
        { trigger: 'Stop', action: { type: 'command', command: 'x' } },
        { name: 'a', action: { type: 'command', command: 'x' } },
        { name: 'b', trigger: 'Nope', action: { type: 'command', command: 'x' } },
        { name: 'c', trigger: 'Stop', action: { type: 'shell', command: 'x' } },
        { name: 'd', trigger: 'Stop', command: 'lenient' },
        'junk',
      ],
      'a',
    );
    assert.deepEqual(r.hooks.map((h) => h.name), ['Stop-0', 'd']);
    assert.deepEqual(codes(r.warnings), ['hook-invalid', 'hook-trigger', 'hook-trigger', 'hook-invalid', 'hook-invalid']);
  });

  it('null/undefined ⇒ no hooks; scalars warn', () => {
    assert.deepEqual(normalizeAgentHooks(undefined, 'a'), { hooks: [], warnings: [] });
    assert.deepEqual(normalizeAgentHooks(null, 'a'), { hooks: [], warnings: [] });
    assert.equal(normalizeAgentHooks('x', 'a').warnings[0]!.code, 'hook-invalid');
  });
});

describe('config/hooks legacy conversion (03 §2.3)', () => {
  const conv = (raw: unknown): { h?: LoadedKiroHook; w: ConfigWarning[] } => {
    const w: ConfigWarning[] = [];
    const h = convertLegacyHook(raw, 'x.kiro.hook', '/ws/.kiro/hooks/x.kiro.hook', w);
    return h ? { h, w } : { w };
  };

  const table: [string, string][] = [
    ['fileEdited', 'PostFileSave'],
    ['fileCreated', 'PostFileCreate'],
    ['fileDeleted', 'PostFileDelete'],
    ['promptSubmit', 'UserPromptSubmit'],
    ['agentStop', 'Stop'],
    ['preToolUse', 'PreToolUse'],
    ['postToolUse', 'PostToolUse'],
    ['preTaskExecution', 'PreTaskExec'],
    ['postTaskExecution', 'PostTaskExec'],
    ['userTriggered', 'Manual'],
    ['sessionStart', 'SessionStart'],
    ['agentSpawn', 'SessionStart'],
  ];
  for (const [when, trig] of table) {
    it(`when.type ${when} ⇒ ${trig}`, () => {
      const { h } = conv({ name: 'n', version: '1', when: { type: when }, then: { type: 'runCommand', command: 'x' } });
      assert.equal(h!.trigger, trig);
      assert.equal(h!.rawTrigger, trig);
    });
  }

  it('lint-on-save example (askAgent + patterns)', () => {
    const { h, w } = conv({
      enabled: true,
      name: 'Lint and Format on Save',
      description: 'Automatically lint',
      version: '1',
      when: { type: 'fileEdited', patterns: ['**/*.ts', 'src/**/*.js', '*.css', 'cdk.json'] },
      then: { type: 'askAgent', prompt: 'A code file has been saved.' },
    });
    assert.deepEqual(w, []);
    assert.equal(h!.dialect, 'v3');
    assert.equal(h!.source, 'legacy-ide');
    assert.equal(h!.name, 'Lint and Format on Save');
    assert.equal(h!.description, 'Automatically lint');
    assert.deepEqual(h!.action, { type: 'agent', prompt: 'A code file has been saved.' });
    assert.equal(h!.timeoutMs, 60000);
    assert.deepEqual(h!.filePatterns, ['**/*.ts', 'src/**/*.js', '*.css', 'cdk.json']);
    const re = new RegExp(h!.matcher!);
    for (const p of ['a.ts', 'src/x/a.ts', 'src/a.js', 'src/deep/er/a.js', 'styles/site.css', 'cdk.json', 'sub/cdk.json', '/abs/ws/a.ts']) {
      assert.ok(re.test(p), p);
    }
    for (const p of ['a.tsx', 'lib/a.js', 'a.cssx', 'cdk.json5']) assert.ok(!re.test(p), p);
  });

  it('toolTypes: single entry verbatim, several ⇒ regex alternation; runCommand', () => {
    const one = conv({ name: 'audit', when: { type: 'postToolUse', toolTypes: ['write'] }, then: { type: 'runCommand', command: 'audit.sh' } }).h!;
    assert.equal(one.matcher, 'write');
    assert.deepEqual(one.toolTypes, ['write']);
    assert.deepEqual(one.action, { type: 'command', command: 'audit.sh' });
    const many = conv({ name: 'm', when: { type: 'preToolUse', toolTypes: ['write', 'shell', '.*delete.*', '@github'] }, then: { type: 'askAgent', prompt: 'check' } }).h!;
    const re = new RegExp(many.matcher!);
    for (const id of ['fs_write', 'str_replace', 'execute_bash', 'delete_file', 'mcp_github_create_issue']) assert.ok(re.test(id), id);
    for (const id of ['read_file', 'web_fetch', 'mcp_git_status']) assert.ok(!re.test(id), id);
  });

  it('unusable legacy hooks warn', () => {
    assert.equal(conv({ name: 'x', when: { type: 'weird' }, then: { type: 'runCommand', command: 'x' } }).h, undefined);
    assert.equal(conv({ name: 'x', when: { type: 'fileEdited' }, then: { type: 'askAgent' } }).h, undefined);
    assert.equal(conv('str').w[0]!.code, 'hook-invalid');
  });

  it('enabled false, then.timeout, default name from file', () => {
    const { h } = conv({ enabled: false, when: { type: 'userTriggered' }, then: { type: 'runCommand', command: 'x', timeout: 5 } });
    assert.equal(h!.enabled, false);
    assert.equal(h!.timeoutMs, 5000);
    assert.equal(h!.name, 'x');
  });
});

describe('config/hooks matcher helpers', () => {
  it('toolTypesToMatcher edge cases', () => {
    assert.equal(toolTypesToMatcher([]), undefined);
    assert.equal(toolTypesToMatcher(['  ']), undefined);
    assert.equal(toolTypesToMatcher(['*']), '*');
    const re = new RegExp(toolTypesToMatcher(['read', '*'])!);
    assert.ok(re.test('anything'));
    const re2 = new RegExp(toolTypesToMatcher(['subagent', '@builtin'])!);
    assert.ok(re2.test('invoke_sub_agent'));
    assert.ok(re2.test('subagent/reviewer'));
    assert.ok(re2.test('read_file'));
    const re3 = new RegExp(toolTypesToMatcher(['@mcp', 'web'])!);
    assert.ok(re3.test('mcp_x_y'));
    assert.ok(re3.test('remote_web_search'));
    assert.ok(!re3.test('read_file'));
  });

  const globTable: [string[], string[], string[]][] = [
    [['*.md'], ['README.md', 'docs/a.md'], ['a.mdx', 'md']],
    [['/top.txt'], ['top.txt'], ['a/top.txt']],
    [['./src/*.ts'], ['src/a.ts'], ['src/a/b.ts', 'a.ts']],
    [['src/**'], ['src/a', 'src/a/b/c'], ['srcx/a']],
    [['**/test/*.ts'], ['test/a.ts', 'x/test/a.ts'], ['test/x/a.ts']],
    [['*.{ts,tsx}'], ['a.ts', 'b/c.tsx'], ['a.js']],
    [['[ab].txt'], ['a.txt', 'b.txt'], ['c.txt']],
    [['file?.log'], ['file1.log'], ['file12.log']],
    [['a+b(c).txt'], ['a+b(c).txt'], ['aab(c).txt']],
  ];
  for (const [globs, yes, no] of globTable) {
    it(`fileGlobsToRegex ${JSON.stringify(globs)}`, () => {
      const re = new RegExp(fileGlobsToRegex(globs)!);
      for (const p of yes) assert.ok(re.test(p), `should match ${p}`);
      for (const p of no) assert.ok(!re.test(p), `should not match ${p}`);
    });
  }
  it('fileGlobsToRegex of nothing', () => assert.equal(fileGlobsToRegex(['', ' ']), undefined));
});

describe('config/hooks files', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('loads global v1, workspace v1 and legacy .kiro.hook files in order', () => {
    fx = makeFixture();
    fx.write('home/.kiro/hooks/g.json', {
      version: 'v1',
      hooks: [{ name: 'g1', trigger: 'Stop', action: { type: 'command', command: 'g' } }],
    });
    fx.write('proj/.kiro/hooks/b.json', {
      version: 'v1',
      hooks: [
        { name: 'w1', trigger: 'PreToolUse', matcher: 'read', action: { type: 'command', command: 'w1' }, timeout: 10 },
        { name: 'w2', trigger: 'PostFileSave', action: { type: 'agent', prompt: 'w2' } },
      ],
    });
    fx.write('proj/.kiro/hooks/a.json', { version: 'v1', hooks: [{ name: 'w0', trigger: 'SessionEnd', action: { type: 'command', command: 'w0' } }] });
    fx.write('proj/.kiro/hooks/legacy.kiro.hook', {
      name: 'Security Check on Write',
      version: '1.0.0',
      when: { type: 'preToolUse', toolTypes: ['write'] },
      then: { type: 'askAgent', prompt: 'Before writing this file, quickly check' },
    });
    fx.write('proj/.kiro/hooks/when-then.json', {
      version: 'v1',
      hooks: [{ name: 'wt', when: { type: 'fileEdited', patterns: ['*.py'] }, then: { type: 'command', command: 'black {{filePath}}' } }],
    });
    fx.write('proj/.kiro/hooks/bad.json', '{ nope');
    fx.write('proj/.kiro/hooks/noshape.json', { something: 1 });
    const ws = fx.ctx();
    const r = loadHookFiles(ws);
    assert.deepEqual(
      r.hooks.map((h) => [h.name, h.source, h.dialect]),
      [
        ['g1', 'global-file', 'v3'],
        ['w0', 'workspace-file', 'v3'],
        ['w1', 'workspace-file', 'v3'],
        ['w2', 'workspace-file', 'v3'],
        ['wt', 'workspace-file', 'v3'],
        ['Security Check on Write', 'legacy-ide', 'v3'],
      ],
    );
    assert.deepEqual(codes(r.warnings).sort(), ['hook-file', 'invalid-json']);
    const w1 = r.hooks.find((h) => h.name === 'w1')!;
    assert.equal(w1.timeoutMs, 10000);
    assert.equal(w1.sourcePath, path.join(fx.ws, '.kiro', 'hooks', 'b.json'));
    const wt = r.hooks.find((h) => h.name === 'wt')! as LoadedKiroHook;
    assert.equal(wt.trigger, 'PostFileSave');
    assert.deepEqual(wt.action, { type: 'command', command: 'black {{filePath}}' });
    assert.deepEqual(wt.filePatterns, ['*.py']);

    const agentHook: KiroHook = {
      dialect: 'v2',
      source: 'agent',
      name: 'stop-0',
      trigger: 'Stop',
      rawTrigger: 'stop',
      action: { type: 'command', command: 'a' },
      timeoutMs: 30000,
      maxOutputBytes: 10240,
      cacheTtlSec: 0,
      enabled: true,
    };
    assert.deepEqual(
      allHooksFor(ws, { hooks: [agentHook] }).map((h) => h.name),
      ['g1', 'w0', 'w1', 'w2', 'wt', 'stop-0', 'Security Check on Write'],
    );
  });

  it('a bare legacy object in a .json file is converted; unknown version warns', () => {
    fx = makeFixture();
    fx.write('proj/.kiro/hooks/x.json', { name: 'bare', when: { type: 'agentStop' }, then: { type: 'runCommand', command: 'x' } });
    fx.write('proj/.kiro/hooks/y.json', { version: 'v2', hooks: [{ name: 'y', trigger: 'Stop', action: { type: 'command', command: 'y' } }] });
    const r = loadHookFiles(fx.ctx());
    assert.deepEqual(r.hooks.map((h) => [h.name, h.source]), [
      ['bare', 'workspace-file'],
      ['y', 'workspace-file'],
    ]);
    assert.deepEqual(codes(r.warnings), ['hook-file']);
  });

  it('at home, ~/.kiro/hooks is loaded once', () => {
    fx = makeFixture();
    fx.write('home/.kiro/hooks/g.json', { version: 'v1', hooks: [{ name: 'g', trigger: 'Stop', action: { type: 'command', command: 'g' } }] });
    assert.deepEqual(loadHookFiles(fx.ctx(fx.home)).hooks.map((h) => h.name), ['g']);
  });
});
