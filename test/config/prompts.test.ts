import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import type { PromptFile } from '../../src/types.js';
import {
  expandPrompt,
  findPrompt,
  hasPromptPlaceholders,
  loadPrompts,
  parsePromptInvocation,
  PROMPT_NAME_RE,
  promptDirs,
  substituteArgs,
} from '../../src/config/prompts.js';
import { makeFixture, type Fixture } from './helpers.js';

const P = (body: string): PromptFile => ({ name: 'p', path: '/x/p.md', scope: 'workspace', body });

describe('config/prompts expandPrompt (00 §2.2, §8 C4)', () => {
  // [body, args, expected]
  const table: [string, string[], string][] = [
    ['Review ${1} for ${2}.', ['auth.ts', 'security'], 'Review auth.ts for security.'],
    ['All: $ARGUMENTS', ['performance issue', 'detailed'], 'All: performance issue detailed'],
    ['All: ${@}', ['a', 'b', 'c'], 'All: a b c'],
    ['${1}|${2}|${3}', ['only'], 'only||'],
    ['${10} ${1}', ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'ten'], 'ten 1'],
    ['${11} stays', ['x'], '${11} stays'],
    ['$1 is not a placeholder; ${1} is', ['v'], '$1 is not a placeholder; v is'],
    ['$ARGUMENTSX stays, $ARGUMENTS goes', ['z'], '$ARGUMENTSX stays, z goes'],
    ['${1}${1}', ['ab'], 'abab'],
    ['No placeholders here.', ['ignored', 'args'], 'No placeholders here.'],
    ['Empty args: [$ARGUMENTS] [${1}]', [], 'Empty args: [] []'],
    ['${0} is literal', ['a'], '${0} is literal'],
    ['Dollar $ ${ } {1}', ['a'], 'Dollar $ ${ } {1}'],
  ];
  for (const [body, args, want] of table) {
    it(`${JSON.stringify(body)} ${JSON.stringify(args)}`, () => assert.equal(expandPrompt(P(body), args), want));
  }

  it('hasPromptPlaceholders is stable across calls (global regex state)', () => {
    for (let i = 0; i < 3; i++) {
      assert.equal(hasPromptPlaceholders('x ${1}'), true);
      assert.equal(hasPromptPlaceholders('x'), false);
      assert.equal(hasPromptPlaceholders('$ARGUMENTS'), true);
      assert.equal(hasPromptPlaceholders('${@}'), true);
    }
  });

  it('substituteArgs with an explicit raw argument string', () => {
    assert.equal(substituteArgs('[$ARGUMENTS] [${@}] [${2}]', ['a', 'b c'], 'a "b c"'), '[a "b c"] [a "b c"] [b c]');
  });
});

describe('config/prompts parsePromptInvocation (06 §8.1)', () => {
  const table: [string, unknown][] = [
    ['@review src/a.ts', { name: 'review', args: ['src/a.ts'], rawArgs: 'src/a.ts' }],
    ['/analyze "performance issue" "detailed"', { name: 'analyze', args: ['performance issue', 'detailed'], rawArgs: '"performance issue" "detailed"' }],
    ['  @fix   #123  now ', { name: 'fix', args: ['#123', 'now'], rawArgs: '#123  now' }],
    ['plain', { name: 'plain', args: [], rawArgs: '' }],
    ['@', { error: 'Prompt name needs to be specified' }],
    ['/   ', { error: 'Prompt name needs to be specified' }],
    ['@x "unterminated', { error: 'Error splitting prompt command' }],
  ];
  for (const [input, want] of table) it(JSON.stringify(input), () => assert.deepEqual(parsePromptInvocation(input), want));
});

describe('config/prompts loading and lookup', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('workspace beats global; front matter description; sorted; only .md', () => {
    fx = makeFixture();
    fx.write('proj/.kiro/prompts/review.md', '---\ndescription: Workspace review\n---\nWS review ${1}\n');
    fx.write('proj/.kiro/prompts/Build.md', 'Build it');
    fx.write('home/.kiro/prompts/review.md', 'global review');
    fx.write('home/.kiro/prompts/deploy.md', 'deploy\r\nnow');
    fx.write('home/.kiro/prompts/notes.txt', 'not a prompt');
    fx.write('home/.kiro/prompts/._x.md', 'sidecar');
    fx.mkdir('home/.kiro/prompts/dir.md');
    const ps = loadPrompts(fx.ctx());
    assert.deepEqual(
      ps.map((p) => [p.name, p.scope, p.body, p.description]),
      [
        ['Build', 'workspace', 'Build it', undefined],
        ['deploy', 'global', 'deploy\nnow', undefined],
        ['review', 'workspace', 'WS review ${1}\n', 'Workspace review'],
      ],
    );
    assert.equal(ps[2]!.path, path.join(fx.ws, '.kiro', 'prompts', 'review.md'));
  });

  it('findPrompt is case-insensitive with exact case first', () => {
    const ps: PromptFile[] = [
      { name: 'Review', path: '/a', scope: 'global', body: 'A' },
      { name: 'review', path: '/b', scope: 'global', body: 'B' },
      { name: 'deploy', path: '/c', scope: 'global', body: 'C' },
    ];
    assert.equal(findPrompt(ps, 'review')!.path, '/b');
    assert.equal(findPrompt(ps, 'Review')!.path, '/a');
    assert.equal(findPrompt(ps, 'DEPLOY')!.path, '/c');
    assert.equal(findPrompt(ps, 'nope'), undefined);
  });

  it('legacy .amazonq prompt dirs are used only when the Kiro dirs are absent', () => {
    fx = makeFixture();
    fx.write('proj/.amazonq/prompts/qlocal.md', 'q local');
    fx.write('home/.aws/amazonq/prompts/qglobal.md', 'q global');
    fx.mkdir('proj/.kiro');
    let names = loadPrompts(fx.ctx()).map((p) => `${p.name}:${p.scope}`);
    assert.deepEqual(names, ['qglobal:global', 'qlocal:workspace']);
    fx.write('proj/.kiro/prompts/k.md', 'k');
    fx.write('home/.kiro/prompts/g.md', 'g');
    names = loadPrompts(fx.ctx()).map((p) => `${p.name}:${p.scope}`);
    assert.deepEqual(names, ['g:global', 'k:workspace']);
  });

  it('promptDirs from home lists the global dir once', () => {
    fx = makeFixture();
    fx.write('home/.kiro/prompts/g.md', 'g');
    const dirs = promptDirs(fx.ctx(fx.home));
    assert.deepEqual(dirs, [{ dir: path.join(fx.kiroHome, 'prompts'), scope: 'global' }]);
    assert.deepEqual(loadPrompts(fx.ctx(fx.home)).map((p) => p.name), ['g']);
  });

  it('prompt name rule (Q: 1-50 of [A-Za-z0-9_-])', () => {
    for (const ok of ['a', 'my-prompt_2', 'x'.repeat(50)]) assert.ok(PROMPT_NAME_RE.test(ok), ok);
    for (const bad of ['', 'has space', 'dot.name', 'x'.repeat(51), 'slash/name']) assert.ok(!PROMPT_NAME_RE.test(bad), bad);
  });
});
