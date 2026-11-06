import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  expandFileRefs,
  FILE_REF_MAX_BYTES,
  fileMatchMatches,
  findAgentsMd,
  loadSteering,
  loadSteeringPaths,
  parseFileRef,
  parseInclusion,
  parseSteeringText,
  steeringDirs,
  steeringRefBase,
  steeringScopeOf,
} from '../../src/config/steering.js';
import { codes, makeFixture, type Fixture } from './helpers.js';

describe('config/steering parseInclusion (03 §3)', () => {
  const table: [unknown, string | undefined][] = [
    ['always', 'always'],
    ['Always', 'always'],
    [' ALWAYS ', 'always'],
    ['fileMatch', 'fileMatch'],
    ['filematch', 'fileMatch'],
    ['file_match', 'fileMatch'],
    ['file-match', 'fileMatch'],
    ['manual', 'manual'],
    ['Manual', 'manual'],
    ['auto', 'auto'],
    ['automatic', 'auto'],
    ['sometimes', undefined],
    ['', undefined],
    [5, undefined],
    [null, undefined],
    [['always'], undefined],
  ];
  for (const [raw, want] of table) it(`${JSON.stringify(raw)} ⇒ ${want}`, () => assert.equal(parseInclusion(raw), want));
});

describe('config/steering parseSteeringText (front matter variants)', () => {
  const P = '/ws/.kiro/steering/tech.md';
  const parse = (text: string) => parseSteeringText(text, { path: P, scope: 'workspace' });

  it('no front matter ⇒ always, body verbatim', () => {
    const r = parse('# Tech\nUse TypeScript.\n');
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.file, {
      path: P,
      scope: 'workspace',
      name: 'tech',
      inclusion: 'always',
      fileMatchPatterns: [],
      body: '# Tech\nUse TypeScript.\n',
    });
  });

  it('explicit always, front matter stripped', () => {
    const r = parse('---\ninclusion: always\n---\nBody\n');
    assert.equal(r.file.inclusion, 'always');
    assert.equal(r.file.body, 'Body\n');
  });

  it('fileMatch with a single pattern string', () => {
    const r = parse('---\ninclusion: fileMatch\nfileMatchPattern: "components/**/*.tsx"\n---\nReact rules\n');
    assert.equal(r.file.inclusion, 'fileMatch');
    assert.deepEqual(r.file.fileMatchPatterns, ['components/**/*.tsx']);
    assert.equal(r.file.body, 'React rules\n');
  });

  it('fileMatch with a list of patterns', () => {
    const r = parse('---\ninclusion: fileMatch\nfileMatchPattern: ["**/*.ts", "**/*.tsx", 5, ""]\n---\nx');
    assert.deepEqual(r.file.fileMatchPatterns, ['**/*.ts', '**/*.tsx']);
  });

  it('fileMatchPatterns alias and missing pattern', () => {
    assert.deepEqual(parse('---\ninclusion: fileMatch\nfileMatchPatterns:\n  - "*.md"\n---\nx').file.fileMatchPatterns, ['*.md']);
    const r = parse('---\ninclusion: fileMatch\n---\nx');
    assert.equal(r.file.inclusion, 'fileMatch');
    assert.deepEqual(r.file.fileMatchPatterns, []);
  });

  it('manual keeps the file stem as name', () => {
    const r = parse('---\ninclusion: manual\nname: ignored-for-manual\n---\nManual body');
    assert.equal(r.file.inclusion, 'manual');
    assert.equal(r.file.name, 'tech');
  });

  it('auto uses front matter name + description', () => {
    const r = parse('---\ninclusion: auto\nname: api-design\ndescription: REST API conventions\n---\nAPI body');
    assert.equal(r.file.inclusion, 'auto');
    assert.equal(r.file.name, 'api-design');
    assert.equal(r.file.description, 'REST API conventions');
    assert.deepEqual(r.warnings, []);
  });

  it('auto without description warns (still auto)', () => {
    const r = parse('---\ninclusion: auto\n---\nx');
    assert.equal(r.file.inclusion, 'auto');
    assert.equal(r.file.name, 'tech');
    assert.deepEqual(codes(r.warnings), ['steering-auto']);
  });

  it('unknown inclusion ⇒ always + warning', () => {
    const r = parse('---\ninclusion: sometimes\n---\nx');
    assert.equal(r.file.inclusion, 'always');
    assert.deepEqual(codes(r.warnings), ['steering-inclusion']);
    assert.match(r.warnings[0]!.message, /unknown inclusion "sometimes" \(treated as always\)/);
  });

  it('BOM and CRLF are normalized', () => {
    const r = parse('\uFEFF---\r\ninclusion: manual\r\n---\r\nLine 1\r\nLine 2\r\n');
    assert.equal(r.file.inclusion, 'manual');
    assert.equal(r.file.body, 'Line 1\nLine 2\n');
  });

  it('broken YAML front matter warns and defaults to always', () => {
    const r = parse('---\ninclusion: [manual\n---\nBody');
    assert.equal(r.file.inclusion, 'always');
    assert.equal(r.file.body, 'Body');
    assert.deepEqual(codes(r.warnings), ['steering-front-matter']);
  });

  it('front matter must start at the first byte', () => {
    const r = parse('\n---\ninclusion: manual\n---\nBody');
    assert.equal(r.file.inclusion, 'always');
    assert.equal(r.file.body, '\n---\ninclusion: manual\n---\nBody');
  });

  it('description is optional for other modes', () => {
    assert.equal(parse('---\ndescription: "  Hi  "\n---\nx').file.description, 'Hi');
    assert.equal(parse('---\ndescription: ""\n---\nx').file.description, undefined);
  });
});

describe('config/steering loadSteering', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('global first, legacy, workspace last; sorted, nested, filtered', () => {
    fx = makeFixture();
    fx.write('home/.kiro/steering/zeta.md', 'g-zeta');
    fx.write('home/.kiro/steering/alpha.md', '---\ninclusion: manual\n---\ng-alpha');
    fx.write('home/.kiro/steering/sub/deep.md', 'g-deep');
    fx.write('home/.kiro/steering/AGENTS.md', 'global agents (owned by findAgentsMd)');
    fx.write('home/.kiro/steering/._junk.md', 'sidecar');
    fx.write('home/.kiro/steering/notes.txt', 'not markdown');
    fx.write('proj/.amazonq/rules/legacy.md', 'legacy rule');
    fx.write('proj/.kiro/steering/product.md', 'w-product');
    fx.write('proj/.kiro/steering/tech.md', '---\ninclusion: fileMatch\nfileMatchPattern: "*.ts"\n---\nw-tech');
    fx.write('proj/.kiro/steering/node_modules/x.md', 'never');
    const r = loadSteering(fx.ctx());
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(
      r.files.map((f) => [path.relative(fx.root, f.path), f.scope, f.name, f.inclusion, f.body]),
      [
        ['home/.kiro/steering/alpha.md', 'global', 'alpha', 'manual', 'g-alpha'],
        ['home/.kiro/steering/sub/deep.md', 'global', 'deep', 'always', 'g-deep'],
        ['home/.kiro/steering/zeta.md', 'global', 'zeta', 'always', 'g-zeta'],
        ['proj/.amazonq/rules/legacy.md', 'legacy', 'legacy', 'always', 'legacy rule'],
        ['proj/.kiro/steering/product.md', 'workspace', 'product', 'always', 'w-product'],
        ['proj/.kiro/steering/tech.md', 'workspace', 'tech', 'fileMatch', 'w-tech'],
      ],
    );
    assert.deepEqual(r.files[5]!.fileMatchPatterns, ['*.ts']);
  });

  it('collects front matter warnings with paths', () => {
    fx = makeFixture();
    const p = fx.write('proj/.kiro/steering/bad.md', '---\ninclusion: nope\n---\nx');
    const r = loadSteering(fx.ctx());
    assert.equal(r.warnings[0]!.path, p);
  });

  it('nothing configured ⇒ nothing loaded', () => {
    fx = makeFixture();
    assert.deepEqual(loadSteering(fx.ctx()), { files: [], warnings: [] });
  });

  it('KIRO_HOME pointing at the workspace .kiro loads each file once (global scope)', () => {
    fx = makeFixture();
    fx.write('proj/.kiro/steering/a.md', 'A');
    const ws = fx.ctx(undefined, { KIRO_HOME: path.join(fx.ws, '.kiro') });
    const r = loadSteering(ws);
    assert.deepEqual(r.files.map((f) => [f.name, f.scope]), [['a', 'global']]);
    assert.equal(steeringDirs(ws).length, 2); // global + legacy (.amazonq), no workspace duplicate
  });

  it('running from home: only the global dir', () => {
    fx = makeFixture();
    fx.write('home/.kiro/steering/g.md', 'G');
    const r = loadSteering(fx.ctx(fx.home));
    assert.deepEqual(r.files.map((f) => [f.name, f.scope]), [['g', 'global']]);
  });

  it('workspace root found by walking up from a subdirectory', () => {
    fx = makeFixture();
    fx.write('proj/.kiro/steering/w.md', 'W');
    const sub = fx.mkdir('proj/src/deep');
    assert.deepEqual(loadSteering(fx.ctx(sub)).files.map((f) => f.name), ['w']);
  });
});

describe('config/steering file references (03 §3, 02 §4)', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  const refTable: [string, { path: string; start?: number; end?: number }][] = [
    ['src/a.ts', { path: 'src/a.ts' }],
    ['src/a.ts:12', { path: 'src/a.ts', start: 12, end: 12 }],
    ['src/a.ts:3-7', { path: 'src/a.ts', start: 3, end: 7 }],
    [' docs/x.md ', { path: 'docs/x.md' }],
    ['C:/x.ts', { path: 'C:/x.ts' }],
    ['weird:name.md', { path: 'weird:name.md' }],
    [':12', { path: ':12' }],
  ];
  for (const [spec, want] of refTable) it(`parseFileRef(${JSON.stringify(spec)})`, () => assert.deepEqual(parseFileRef(spec), want));

  it('expands file, line and range references relative to baseDir', () => {
    fx = makeFixture();
    fx.write('proj/src/a.ts', 'l1\nl2\nl3\nl4\nl5\n');
    const ws = fx.ctx();
    const body = 'Before\n#[[file:src/a.ts]]\nMid #[[file:src/a.ts:2]] and #[[file:src/a.ts:2-4]]\nAfter';
    assert.equal(
      expandFileRefs(body, fx.ws, ws),
      'Before\n[src/a.ts]\nl1\nl2\nl3\nl4\nl5\nMid [src/a.ts:2]\nl2 and [src/a.ts:2-4]\nl2\nl3\nl4\nAfter',
    );
  });

  it('ranges are clamped and normalized', () => {
    fx = makeFixture();
    fx.write('proj/a.txt', 'one\ntwo\nthree');
    const ws = fx.ctx();
    assert.equal(expandFileRefs('#[[file:a.txt:2-99]]', fx.ws, ws), '[a.txt:2-99]\ntwo\nthree');
    assert.equal(expandFileRefs('#[[file:a.txt:3-2]]', fx.ws, ws), '[a.txt:2-3]\ntwo\nthree');
    assert.equal(expandFileRefs('#[[file:a.txt:0]]', fx.ws, ws), '[a.txt:1]\none');
    assert.equal(expandFileRefs('#[[file:a.txt:9]]', fx.ws, ws), '[a.txt:9]\n');
  });

  it('folder references list one level, directories suffixed with /', () => {
    fx = makeFixture();
    fx.write('proj/docs/b.md', 'b');
    fx.write('proj/docs/a.md', 'a');
    fx.write('proj/docs/sub/c.md', 'c');
    const ws = fx.ctx();
    assert.equal(expandFileRefs('#[[folder:docs]]', fx.ws, ws), '[docs/]\na.md\nb.md\nsub/');
    assert.equal(expandFileRefs('#[[folder:docs/]]', fx.ws, ws), '[docs/]\na.md\nb.md\nsub/');
  });

  it('missing targets leave a short note; text without refs is unchanged', () => {
    fx = makeFixture();
    const ws = fx.ctx();
    assert.equal(expandFileRefs('x #[[file:nope.md]] y', fx.ws, ws), 'x [missing: nope.md] y');
    assert.equal(expandFileRefs('#[[folder:nope]]', fx.ws, ws), '[missing: nope]');
    fx.mkdir('proj/adir');
    assert.equal(expandFileRefs('#[[file:adir]]', fx.ws, ws), '[missing: adir]');
    assert.equal(expandFileRefs('plain text #[[ not a ref', fx.ws, ws), 'plain text #[[ not a ref');
    assert.equal(expandFileRefs('#[[url:http://x]]', fx.ws, ws), '#[[url:http://x]]');
  });

  it('~ and absolute paths, CRLF/BOM normalized', () => {
    fx = makeFixture();
    fx.write('home/notes/n.md', '\uFEFFhome\r\nnote\r\n');
    const abs = fx.write('elsewhere/x.md', 'abs');
    const ws = fx.ctx();
    assert.equal(expandFileRefs('#[[file:~/notes/n.md]]', fx.ws, ws), '[~/notes/n.md]\nhome\nnote');
    assert.equal(expandFileRefs(`#[[file:${abs}]]`, fx.ws, ws), `[${abs}]\nabs`);
  });

  it('.kiroignored files are not inlined', () => {
    fx = makeFixture();
    fx.write('proj/.kiroignore', 'secret.txt\nprivate/\n');
    fx.write('proj/secret.txt', 'TOP SECRET');
    fx.write('proj/private/p.md', 'p');
    fx.write('proj/pub/ok.md', 'ok');
    fx.write('proj/pub/secret.txt', 'hidden too');
    const ws = fx.ctx();
    assert.equal(expandFileRefs('#[[file:secret.txt]]', fx.ws, ws), '[ignored: secret.txt]');
    assert.equal(expandFileRefs('#[[folder:private]]', fx.ws, ws), '[ignored: private]');
    assert.equal(expandFileRefs('#[[folder:pub]]', fx.ws, ws), '[pub/]\nok.md');
  });

  it('large files are truncated with a note', () => {
    fx = makeFixture();
    fx.write('proj/big.txt', 'x'.repeat(FILE_REF_MAX_BYTES + 10));
    const out = expandFileRefs('#[[file:big.txt]]', fx.ws, fx.ctx());
    assert.ok(out.endsWith('\n[truncated]'));
    assert.equal(out.length, '[big.txt]\n'.length + FILE_REF_MAX_BYTES + '\n[truncated]'.length);
  });

  it('steeringRefBase: global ⇒ ~/.kiro/steering, AGENTS.md ⇒ its dir, workspace ⇒ root', () => {
    fx = makeFixture();
    const ws = fx.ctx();
    assert.equal(steeringRefBase(ws, { scope: 'global', path: path.join(fx.kiroHome, 'steering/x.md') }), path.join(fx.kiroHome, 'steering'));
    assert.equal(steeringRefBase(ws, { scope: 'workspace', path: path.join(fx.ws, 'pkg/AGENTS.md') }), path.join(fx.ws, 'pkg'));
    assert.equal(steeringRefBase(ws, { scope: 'workspace', path: path.join(fx.ws, '.kiro/steering/t.md') }), fx.ws);
    assert.equal(steeringRefBase(ws, { scope: 'legacy', path: path.join(fx.ws, '.amazonq/rules/t.md') }), fx.ws);
  });
});

describe('config/steering findAgentsMd', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('global, root, then nested files (sorted, bounded, skipping vendored/hidden/ignored dirs)', () => {
    fx = makeFixture();
    fx.write('home/.kiro/steering/AGENTS.md', 'g');
    fx.write('proj/AGENTS.md', 'root');
    fx.write('proj/packages/b/AGENTS.md', 'b');
    fx.write('proj/packages/a/AGENTS.md', 'a');
    fx.write('proj/src/AGENTS.md', 'src');
    fx.write('proj/node_modules/dep/AGENTS.md', 'no');
    fx.write('proj/.git/AGENTS.md', 'no');
    fx.write('proj/.hidden/AGENTS.md', 'no');
    fx.write('proj/vendor/AGENTS.md', 'ignored');
    fx.write('proj/.kiroignore', 'vendor/\n');
    fx.mkdir('proj/.kiro');
    const got = findAgentsMd(fx.ctx()).map((p) => path.relative(fx.root, p));
    assert.deepEqual(got, [
      'home/.kiro/steering/AGENTS.md',
      'proj/AGENTS.md',
      'proj/packages/a/AGENTS.md',
      'proj/packages/b/AGENTS.md',
      'proj/src/AGENTS.md',
    ]);
  });

  it('none present ⇒ []', () => {
    fx = makeFixture();
    assert.deepEqual(findAgentsMd(fx.ctx()), []);
  });

  it('a directory named AGENTS.md is not a file', () => {
    fx = makeFixture();
    fx.mkdir('proj/AGENTS.md');
    assert.deepEqual(findAgentsMd(fx.ctx()), []);
  });

  it('from home: global + ~/AGENTS.md only, no walk of the home tree', () => {
    fx = makeFixture();
    fx.write('home/AGENTS.md', 'home root');
    fx.write('home/project/AGENTS.md', 'not walked');
    const got = findAgentsMd(fx.ctx(fx.home)).map((p) => path.relative(fx.root, p));
    assert.deepEqual(got, ['home/AGENTS.md']);
  });

  it('symlinked duplicates are listed once', () => {
    fx = makeFixture();
    fx.write('proj/AGENTS.md', 'root');
    fx.mkdir('proj/link');
    fs.symlinkSync(path.join(fx.ws, 'AGENTS.md'), path.join(fx.ws, 'link', 'AGENTS.md'));
    assert.deepEqual(findAgentsMd(fx.ctx()).map((p) => path.relative(fx.root, p)), ['proj/AGENTS.md']);
  });
});

describe('config/steering fileMatchMatches (03 §3)', () => {
  const table: [string[], string, boolean][] = [
    [['*.tsx'], 'src/components/Button.tsx', true],
    [['*.tsx'], 'Button.tsx', true],
    [['*.tsx'], 'src/Button.ts', false],
    [['components/**/*.tsx'], 'components/Button.tsx', true],
    [['components/**/*.tsx'], 'components/a/b/Button.tsx', true],
    [['components/**/*.tsx'], 'src/components/Button.tsx', false],
    [['**/*.ts', '**/*.tsx'], 'a/b.tsx', true],
    [['**/*.ts'], 'b.ts', true],
    [['src/*.ts'], 'src/a/b.ts', false],
    [['src/*.ts'], './src/a.ts', true],
    [['./src/*.ts'], 'src/a.ts', true],
    [['README*'], 'docs/README.md', true],
    [['*.{ts,tsx}'], 'x/y.tsx', true],
    [['docs'], 'docs/guide.md', true],
    [[], 'a.ts', false],
    [[''], 'a.ts', false],
    [['*.ts'], '', false],
    [['src\\*.ts'], 'src\\a.ts', true],
  ];
  for (const [pats, p, want] of table) {
    it(`${JSON.stringify(pats)} ~ ${JSON.stringify(p)} ⇒ ${want}`, () => assert.equal(fileMatchMatches(pats, p), want));
  }
});

describe('config/steering steering files reached through resources', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('steeringScopeOf and loadSteeringPaths', () => {
    fx = makeFixture();
    const g = fx.write('home/.kiro/steering/g.md', '---\ninclusion: manual\n---\nG');
    const w = fx.write('proj/.kiro/steering/sub/w.md', 'W');
    const l = fx.write('proj/.amazonq/rules/l.md', 'L');
    const other = fx.write('proj/docs/x.md', 'X');
    const txt = fx.write('proj/.kiro/steering/n.txt', 'N');
    const ws = fx.ctx();
    assert.equal(steeringScopeOf(ws, g), 'global');
    assert.equal(steeringScopeOf(ws, w), 'workspace');
    assert.equal(steeringScopeOf(ws, l), 'legacy');
    assert.equal(steeringScopeOf(ws, other), undefined);
    assert.equal(steeringScopeOf(ws, txt), undefined);
    assert.equal(steeringScopeOf(ws, path.join(fx.ws, '.kiro/steering')), undefined);
    const r = loadSteeringPaths(ws, [g, w, w, other, path.join(fx.ws, 'missing.md')]);
    assert.deepEqual(
      r.files.map((f) => [f.name, f.scope, f.inclusion, f.body]),
      [
        ['g', 'global', 'manual', 'G'],
        ['w', 'workspace', 'always', 'W'],
        ['x', 'workspace', 'always', 'X'],
      ],
    );
    assert.deepEqual(codes(r.warnings), ['steering-read']);
  });
});
