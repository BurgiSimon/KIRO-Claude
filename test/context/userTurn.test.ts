import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { formatHookContext } from '../../src/context/systemPrompt.js';
import {
  SteeringActivator,
  composeUserTurn,
  composeUserTurnText,
  fileMatchMatches,
  formatSteeringBlock,
  promptPathTokens,
  type ComposeUserTurnInput,
} from '../../src/context/userTurn.js';
import { steering, tmpWorkspace } from './helpers.js';

function turn(over: Partial<ComposeUserTurnInput>): ComposeUserTurnInput {
  return { text: 'hello', hookOutputs: [], agentPrompts: [], steeringBlocks: [], refBlocks: [], ...over };
}

const HOOK = formatHookContext(['hook out'], false)!;

describe('userTurn: composeUserTurn table (00 §6.2, Q contentWithContext)', () => {
  const cases: [string, Partial<ComposeUserTurnInput>, string][] = [
    ['plain text only', {}, 'hello'],
    ['text is trimmed (Q c.trim())', { text: '  hi  \n' }, 'hi'],
    [
      'hook output -> wrapper + extra newline + USER MESSAGE wrapper without newline before END',
      { hookOutputs: ['hook out'] },
      `${HOOK}\n--- USER MESSAGE BEGIN ---\nhello--- USER MESSAGE END ---`,
    ],
    ['all-empty hook outputs add nothing', { hookOutputs: ['', ''] }, 'hello'],
    [
      'steering block',
      { steeringBlocks: [{ name: 'api', body: 'Use REST.\n\n' }] },
      '<steering name="api">\nUse REST.\n</steering>\n\n--- USER MESSAGE BEGIN ---\nhello--- USER MESSAGE END ---',
    ],
    [
      'ref blocks',
      { refBlocks: ['<file path="/a">\nA\n</file>\n', ''] },
      '<file path="/a">\nA\n</file>\n\n--- USER MESSAGE BEGIN ---\nhello--- USER MESSAGE END ---',
    ],
    [
      'full order: hook, extra, steering, refs, user',
      {
        hookOutputs: ['hook out'],
        extraContext: ['<kiro-plan-mode>plan</kiro-plan-mode>'],
        steeringBlocks: [{ name: 's', body: 'S' }],
        refBlocks: ['REF'],
      },
      `${HOOK}\n<kiro-plan-mode>plan</kiro-plan-mode>\n\n<steering name="s">\nS\n</steering>\n\nREF\n\n` +
        '--- USER MESSAGE BEGIN ---\nhello--- USER MESSAGE END ---',
    ],
    ['agent prompts appended to user text (no context)', { agentPrompts: ['Also lint.', ''] }, 'hello\n\nAlso lint.'],
    [
      'agent prompts appended inside the wrapper',
      { agentPrompts: ['P1', 'P2'], refBlocks: ['R'] },
      'R\n\n--- USER MESSAGE BEGIN ---\nhello\n\nP1\n\nP2--- USER MESSAGE END ---',
    ],
    ['empty text with agent prompt', { text: '', agentPrompts: ['Only prompt'] }, 'Only prompt'],
    ['empty everything', { text: '' }, ''],
  ];
  for (const [name, over, want] of cases) {
    it(name, () => {
      assert.equal(composeUserTurnText(turn(over)), want);
      assert.equal(composeUserTurn(turn(over)), want);
    });
  }

  it('images turn the result into content blocks (images first, then text)', () => {
    const r = composeUserTurn(turn({ images: [{ mediaType: 'image/png', dataBase64: 'AAA' }], refBlocks: ['R'] }));
    assert.deepEqual(r, [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'text', text: 'R\n\n--- USER MESSAGE BEGIN ---\nhello--- USER MESSAGE END ---' },
    ]);
  });
  it('image-only turn has no empty text block', () => {
    const r = composeUserTurn(turn({ text: '', images: [{ mediaType: 'image/gif', dataBase64: 'B' }] }));
    assert.deepEqual(r, [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'B' } }]);
  });
  it('empty images array keeps a string', () => {
    assert.equal(composeUserTurn(turn({ images: [] })), 'hello');
  });
  it('formatSteeringBlock escapes the name attribute', () => {
    assert.equal(formatSteeringBlock({ name: 'a"b<c', body: 'x' }), '<steering name="a&quot;b&lt;c">\nx\n</steering>');
  });
});

describe('userTurn: fileMatchMatches (03 §3)', () => {
  const cases: [string[], string, boolean][] = [
    [['*.tsx'], 'src/components/Button.tsx', true], // match-base
    [['*.tsx'], 'Button.tsx', true],
    [['*.tsx'], 'src/a.ts', false],
    [['README*'], 'docs/README.md', true],
    [['components/**/*.tsx'], 'components/ui/Button.tsx', true],
    [['components/**/*.tsx'], 'components/Button.tsx', true],
    [['components/**/*.tsx'], 'src/components/Button.tsx', false],
    [['src/*.ts'], 'src/a/b.ts', false], // `*` does not cross '/'
    [['src/*.ts'], 'src/b.ts', true],
    [['**/*.ts'], 'a.ts', true],
    [['**/*.ts'], 'x/y/a.ts', true],
    [['**/*.{ts,tsx}'], 'x/a.tsx', true], // brace expansion
    [['*.{md,txt}'], 'notes.txt', true],
    [['./src/*.ts'], 'src/a.ts', true],
    [[''], 'a.ts', false], // empty pattern never matches
    [[], 'a.ts', false],
    [['*.ts', '*.py'], 'tool.py', true],
  ];
  for (const [pats, rel, want] of cases) {
    it(`${JSON.stringify(pats)} vs ${rel} -> ${want}`, () => assert.equal(fileMatchMatches(pats, rel), want));
  }
  it('absolute patterns match absolute subjects', () => {
    assert.equal(fileMatchMatches(['/opt/x/*.conf'], '/opt/x/a.conf', '/opt/x/a.conf'), true);
    assert.equal(fileMatchMatches(['/opt/x/*.conf'], 'a.conf', '/ws/a.conf'), false);
  });
});

describe('userTurn: promptPathTokens', () => {
  it('extracts @, #, quoted, back-ticked and bare path-like tokens', () => {
    const t = promptPathTokens('fix @src/a.ts and #lib/b.tsx, see "docs/my file.md" and `pkg/c.rs`; also README.md. hello world https://x.io/a.ts');
    for (const want of ['src/a.ts', 'lib/b.tsx', 'docs/my file.md', 'pkg/c.rs', 'README.md']) assert.ok(t.includes(want), want);
    assert.ok(!t.includes('hello'));
    assert.ok(!t.some((x) => x.startsWith('https')));
  });
});

describe('userTurn: SteeringActivator once-per-session semantics', () => {
  function setup() {
    const ws = tmpWorkspace();
    const sp = (n: string): string => path.join(ws.cwd, '.kiro', 'steering', `${n}.md`);
    const files = [
      steering({ path: sp('api'), name: 'api', inclusion: 'manual', body: 'API body' }),
      steering({ path: sp('db'), name: 'db', inclusion: 'auto', description: 'DB', body: 'DB body' }),
      steering({ path: sp('react'), name: 'react', inclusion: 'fileMatch', fileMatchPatterns: ['*.tsx'], body: 'React body' }),
      steering({ path: sp('tests'), name: 'tests', inclusion: 'fileMatch', fileMatchPatterns: ['test/**/*.ts'], body: 'Test body' }),
      steering({ path: sp('always'), name: 'always', inclusion: 'always', body: 'never injected' }),
    ];
    return { ws, files, act: new SteeringActivator(files, ws) };
  }

  it('manual on #name and /name (case-insensitive), once', () => {
    const { act } = setup();
    assert.deepEqual(act.forPrompt('please follow #API'), [{ name: 'api', body: 'API body' }]);
    assert.deepEqual(act.forPrompt('again #api and /api'), []);
    assert.deepEqual(act.activated, ['api']);
  });
  it('/name must be a whole token', () => {
    const { act } = setup();
    assert.deepEqual(act.forPrompt('open /api/v1/users'), []);
    assert.deepEqual(act.forPrompt('/api'), [{ name: 'api', body: 'API body' }]);
  });
  it('auto via #name or /name; always files never injected', () => {
    const { act } = setup();
    assert.deepEqual(act.forPrompt('/db then #always'), [{ name: 'db', body: 'DB body' }]);
  });
  it('a plain word or a mention inside code does not activate', () => {
    const { act } = setup();
    assert.deepEqual(act.forPrompt('the api is slow; `#api`'), []);
  });
  it('#steering:<name> activates any conditional file, including fileMatch', () => {
    const { act } = setup();
    assert.deepEqual(act.forPrompt('#steering:react.md'), [{ name: 'react', body: 'React body' }]);
  });
  it('fileMatch on prompt path tokens (match-base and relative patterns)', () => {
    const { act } = setup();
    assert.deepEqual(act.forPrompt('edit @src/components/Button.tsx and test/unit/a.ts'), [
      { name: 'react', body: 'React body' },
      { name: 'tests', body: 'Test body' },
    ]);
    assert.deepEqual(act.forPrompt('edit src/Other.tsx'), []);
  });
  it('fileMatch relative to the workspace root when cwd is a subdirectory', () => {
    const { ws, files } = setup();
    const act = new SteeringActivator(files, { ...ws, cwd: path.join(ws.cwd, 'test') });
    assert.deepEqual(act.forPrompt('look at unit/x.ts'), [{ name: 'tests', body: 'Test body' }]);
  });
  it('forToolPath injects fileMatch steering once per file and shares state with forPrompt', () => {
    const { ws, act } = setup();
    const txt = act.forToolPath(path.join(ws.cwd, 'src', 'App.tsx'));
    assert.equal(
      txt,
      'Kiro steering for files matching src/App.tsx (apply it while working on such files):\n\n<steering name="react">\nReact body\n</steering>',
    );
    assert.equal(act.forToolPath(path.join(ws.cwd, 'src', 'Other.tsx')), undefined);
    assert.equal(act.forToolPath(path.join(ws.cwd, 'README.md')), undefined);
    assert.deepEqual(act.forPrompt('edit test/a/b.ts'), [{ name: 'tests', body: 'Test body' }]);
    assert.equal(act.forToolPath(path.join(ws.cwd, 'test', 'z.ts')), undefined);
  });
  it('manual files are never activated by tool paths', () => {
    const { ws, act } = setup();
    assert.equal(act.forToolPath(path.join(ws.cwd, 'api.md')), undefined);
  });
  it('files outside the workspace match only basename patterns', () => {
    const { ws, act } = setup();
    assert.ok(act.forToolPath(path.join(ws.tmp, 'elsewhere', 'X.tsx'))!.includes('React body'));
    assert.equal(act.forToolPath(path.join(ws.tmp, 'test', 'x.ts')), undefined);
  });
  it('reset() allows injecting again', () => {
    const { act } = setup();
    assert.equal(act.forPrompt('#api').length, 1);
    act.reset();
    assert.deepEqual(act.activated, []);
    assert.equal(act.forPrompt('#api').length, 1);
  });
  it('forNames injects by name once', () => {
    const { act } = setup();
    assert.deepEqual(act.forNames(['API', 'react.md', 'always', 'nope']).map((b) => b.name), ['api', 'react']);
    assert.deepEqual(act.forNames(['api']), []);
  });
  it('expandRefs is applied with the steering base dir', () => {
    const { ws, files } = setup();
    const seen: string[] = [];
    const act = new SteeringActivator(files, ws, {
      expandRefs: (b, d) => {
        seen.push(d);
        return `${b}!`;
      },
    });
    assert.deepEqual(act.forPrompt('#api'), [{ name: 'api', body: 'API body!' }]);
    assert.deepEqual(seen, [ws.workspaceRoot]);
  });
});
