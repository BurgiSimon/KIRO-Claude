import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentResource, KiroAgent } from '../../src/types.js';
import { builtinAgents } from '../../src/config/agents.js';
import { defaultContextPaths, expandFileSpec, resolveResources } from '../../src/config/resources.js';
import { DEFAULT_SKILL_URIS } from '../../src/config/skills.js';
import { codes, makeFixture, type Fixture } from './helpers.js';

type A = Pick<KiroAgent, 'resources' | 'inheritDefaultResources' | 'name'>;
const files = (...uris: string[]): AgentResource[] => uris.map((uri) => ({ kind: 'file', uri }));
const agent = (resources: AgentResource[], inherit = false): A => ({ name: 't', resources, inheritDefaultResources: inherit });

describe('config/resources expandFileSpec (06 §4.2, glob crate dialect)', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('plain file, directory (non-recursive), missing, globs relative to the workspace root', () => {
    fx = makeFixture();
    fx.write('proj/README.md', 'r');
    fx.write('proj/docs/a.md', 'a');
    fx.write('proj/docs/b.txt', 'b');
    fx.write('proj/docs/sub/c.md', 'c');
    fx.write('proj/docs/.hidden.md', 'h');
    const sub = fx.mkdir('proj/src/deep');
    fx.mkdir('proj/.kiro');
    const ws = fx.ctx(sub); // cwd below the root: relative specs still use the root
    const rel = (ps: string[]) => ps.map((p) => path.relative(fx.ws, p));
    assert.deepEqual(rel(expandFileSpec('README.md', ws).paths), ['README.md']);
    assert.deepEqual(rel(expandFileSpec('./README.md', ws).paths), ['README.md']);
    assert.deepEqual(rel(expandFileSpec('docs', ws).paths), ['docs/.hidden.md', 'docs/a.md', 'docs/b.txt']);
    assert.deepEqual(rel(expandFileSpec('nope.md', ws).paths), []);
    assert.deepEqual(rel(expandFileSpec('docs/*.md', ws).paths), ['docs/.hidden.md', 'docs/a.md']);
    assert.deepEqual(rel(expandFileSpec('docs/**/*.md', ws).paths), ['docs/.hidden.md', 'docs/a.md', 'docs/sub/c.md']);
    assert.deepEqual(rel(expandFileSpec('**/c.md', ws).paths), ['docs/sub/c.md']);
    assert.deepEqual(rel(expandFileSpec('docs/{a,b}.md', ws).paths), []); // no braces in the glob crate
  });

  it('~ and ~/.kiro (KIRO_HOME) and absolute specs', () => {
    fx = makeFixture();
    fx.write('home/notes.md', 'n');
    const kh = fx.mkdir('kh');
    fx.write('kh/steering/s.md', 's');
    const abs = fx.write('abs/x.md', 'x');
    const ws = fx.ctx(undefined, { KIRO_HOME: kh });
    assert.deepEqual(expandFileSpec('~/notes.md', ws).paths, [path.join(fx.home, 'notes.md')]);
    assert.deepEqual(expandFileSpec('~/.kiro/steering/*.md', ws).paths, [path.join(kh, 'steering', 's.md')]);
    assert.deepEqual(expandFileSpec(abs, ws).paths, [abs]);
    assert.deepEqual(expandFileSpec(path.join(fx.root, 'abs', '*.md'), ws).paths, [abs]);
  });

  it('invalid glob reports an error', () => {
    fx = makeFixture();
    const r = expandFileSpec('docs/a**.md', fx.ctx());
    assert.deepEqual(r.paths, []);
    assert.ok(r.error);
  });
});

describe('config/resources resolveResources', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('one entry per file:// rule, first rule wins, .kiroignore applies; skill/KB passthrough', () => {
    fx = makeFixture();
    fx.write('proj/a.md', 'a');
    fx.write('proj/docs/b.md', 'b');
    fx.write('proj/docs/secret.md', 's');
    fx.write('proj/.kiroignore', 'secret.md\n');
    const kb: AgentResource = { kind: 'knowledgeBase', source: 'file://./docs', name: 'Docs' };
    const r = resolveResources(
      fx.ctx(),
      agent([
        ...files('file://a.md', 'file://docs/*.md', 'file://**/*.md', 'file://missing.md'),
        { kind: 'skill', uri: 'skill://x' },
        { kind: 'skill', uri: 'skill://x' },
        kb,
      ]),
    );
    const rel = (ps: string[]) => ps.map((p) => path.relative(fx.ws, p));
    assert.deepEqual(
      r.files.map((f) => [f.pattern, rel(f.paths)]),
      [
        ['a.md', ['a.md']],
        ['docs/*.md', ['docs/b.md']],
        ['**/*.md', []],
        ['missing.md', []],
      ],
    );
    assert.deepEqual(r.skillUris, ['skill://x']);
    assert.deepEqual(r.knowledgeBases, [kb]);
    assert.deepEqual(r.steeringFiles, []);
    assert.deepEqual(r.warnings, []);
  });

  it('inheriting defaults: steering + AGENTS.md matches are dropped (owned by steering.ts), default skill URIs added', () => {
    fx = makeFixture();
    fx.write('proj/AGENTS.md', 'agents');
    fx.write('proj/README.md', 'readme');
    fx.write('proj/.kiro/steering/tech.md', 'tech');
    fx.write('home/.kiro/steering/g.md', 'g');
    fx.write('proj/.amazonq/rules/r.md', 'r');
    const ws = fx.ctx();
    const def = builtinAgents(ws)[0]!;
    const r = resolveResources(ws, def);
    const all = r.files.flatMap((f) => f.paths.map((p) => path.relative(fx.root, p)));
    assert.deepEqual(all, ['proj/README.md']);
    assert.deepEqual(r.steeringFiles, []);
    assert.deepEqual(r.skillUris, [...DEFAULT_SKILL_URIS]);
    assert.deepEqual(
      r.files.map((f) => f.pattern),
      ['AGENTS.md', 'README.md', 'AmazonQ.md', '.kiro/steering/**/*.md', '~/.kiro/steering/**/*.md', '.amazonq/rules/**/*.md'],
    );
    const dcp = defaultContextPaths(ws);
    for (const p of ['proj/AGENTS.md', 'proj/.kiro/steering/tech.md', 'home/.kiro/steering/g.md', 'proj/.amazonq/rules/r.md']) {
      assert.ok(dcp.has(fs.realpathSync(path.join(fx.root, p))), p);
    }
  });

  it('not inheriting: steering matches go to steeringFiles, AGENTS.md is a plain file, no default skills', () => {
    fx = makeFixture();
    fx.write('proj/AGENTS.md', 'agents');
    fx.write('proj/.kiro/steering/tech.md', '---\ninclusion: manual\n---\ntech');
    fx.write('proj/.kiro/steering/sub/x.md', 'x');
    const r = resolveResources(fx.ctx(), agent(files('file://AGENTS.md', 'file://.kiro/steering/**/*.md', 'file://.kiro/steering/tech.md'), false));
    assert.deepEqual(
      r.files.map((f) => [f.pattern, f.paths.map((p) => path.relative(fx.ws, p))]),
      [
        ['AGENTS.md', ['AGENTS.md']],
        ['.kiro/steering/**/*.md', []],
        ['.kiro/steering/tech.md', []],
      ],
    );
    assert.deepEqual(r.steeringFiles.map((p) => path.relative(fx.ws, p)), ['.kiro/steering/sub/x.md', '.kiro/steering/tech.md']);
    assert.deepEqual(r.skillUris, []);
  });

  it('invalid globs warn with the agent name', () => {
    fx = makeFixture();
    const r = resolveResources(fx.ctx(), agent(files('file://x/a**b')));
    assert.deepEqual(codes(r.warnings), ['resource-glob']);
    assert.match(r.warnings[0]!.message, /^Agent 't': invalid resource file:\/\/x\/a\*\*b: /);
  });

  it('scheme is case-insensitive', () => {
    fx = makeFixture();
    fx.write('proj/a.md', 'a');
    const r = resolveResources(fx.ctx(), agent(files('FILE://a.md')));
    assert.deepEqual(r.files.map((f) => f.pattern), ['a.md']);
    assert.equal(r.files[0]!.paths.length, 1);
  });
});
