import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillInfo } from '../../src/types.js';
import {
  buildSkillsPluginDir,
  DEFAULT_SKILL_URIS,
  discoverSkills,
  expandSkillInvocation,
  pluginSkillName,
  readSkill,
  readSkillBody,
  resolveSkillUri,
} from '../../src/config/skills.js';
import { makeFixture, type Fixture } from './helpers.js';

const skillMd = (name: string, description: string, body = `Instructions for ${name}.`): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

describe('config/skills discovery (02 §6.2)', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  it('workspace defaults, then resource URIs, then global defaults; first name wins', () => {
    fx = makeFixture();
    fx.write('proj/.kiro/skills/backend-patterns/SKILL.md', skillMd('backend-patterns', 'Workspace backend'));
    fx.write('proj/.kiro/skills/shared/SKILL.md', skillMd('shared', 'Workspace shared'));
    fx.write('proj/.kiro/skills/no-skill-file/README.md', 'x');
    fx.write('home/.kiro/skills/shared/SKILL.md', skillMd('shared', 'Global shared'));
    fx.write('home/.kiro/skills/global-only/SKILL.md', skillMd('global-only', 'Global only'));
    fx.write('proj/tools/extra/SKILL.md', skillMd('extra', 'From a resource path'));
    const ws = fx.ctx();
    const got = discoverSkills(ws, ['skill://tools/extra/SKILL.md'], { includeDefaults: true });
    assert.deepEqual(
      got.map((s) => [s.name, s.scope, s.description]),
      [
        ['backend-patterns', 'workspace', 'Workspace backend'],
        ['shared', 'workspace', 'Workspace shared'],
        ['extra', 'resource', 'From a resource path'],
        ['global-only', 'global', 'Global only'],
      ],
    );
    assert.equal(got[0]!.dir, path.join(fx.ws, '.kiro', 'skills', 'backend-patterns'));
    assert.equal(got[0]!.skillFile, path.join(fx.ws, '.kiro', 'skills', 'backend-patterns', 'SKILL.md'));
  });

  it('without defaults only the URIs count; default URIs keep their scope', () => {
    fx = makeFixture();
    fx.write('proj/.kiro/skills/a/SKILL.md', skillMd('a', 'A'));
    fx.write('home/.kiro/skills/b/SKILL.md', skillMd('b', 'B'));
    const ws = fx.ctx();
    assert.deepEqual(discoverSkills(ws, [], { includeDefaults: false }), []);
    const got = discoverSkills(ws, [...DEFAULT_SKILL_URIS], { includeDefaults: false });
    assert.deepEqual(got.map((s) => [s.name, s.scope]), [['a', 'workspace'], ['b', 'global']]);
  });

  it('default option is includeDefaults: true', () => {
    fx = makeFixture();
    fx.write('home/.kiro/skills/b/SKILL.md', skillMd('b', 'B'));
    assert.deepEqual(discoverSkills(fx.ctx(), []).map((s) => s.name), ['b']);
  });

  it('short names resolve workspace first, then global', () => {
    fx = makeFixture();
    fx.write('proj/.kiro/skills/backend-patterns/SKILL.md', skillMd('backend-patterns', 'ws'));
    fx.write('home/.kiro/skills/backend-patterns/SKILL.md', skillMd('backend-patterns', 'global'));
    fx.write('home/.kiro/skills/only-global/SKILL.md', skillMd('only-global', 'g'));
    const ws = fx.ctx();
    assert.deepEqual(resolveSkillUri(ws, 'skill://backend-patterns'), [path.join(fx.ws, '.kiro/skills/backend-patterns')]);
    assert.deepEqual(resolveSkillUri(ws, 'skill://only-global'), [path.join(fx.kiroHome, 'skills/only-global')]);
    assert.deepEqual(resolveSkillUri(ws, 'skill://missing'), []);
    assert.deepEqual(resolveSkillUri(ws, 'skill://'), []);
  });

  it('globs, ~ paths, directory URIs and SKILL.md URIs', () => {
    fx = makeFixture();
    fx.write('proj/.kiro/skills/x/SKILL.md', skillMd('x', 'x'));
    fx.write('proj/.kiro/skills/nested/deep/y/SKILL.md', skillMd('y', 'y'));
    fx.write('home/.kiro/skills/z/SKILL.md', skillMd('z', 'z'));
    fx.write('proj/lib/skill-dir/SKILL.md', skillMd('dirskill', 'd'));
    const ws = fx.ctx();
    const rel = (ps: string[]) => ps.map((p) => path.relative(fx.root, p));
    assert.deepEqual(rel(resolveSkillUri(ws, 'skill://.kiro/skills/**/SKILL.md')), ['proj/.kiro/skills/nested/deep/y', 'proj/.kiro/skills/x']);
    assert.deepEqual(rel(resolveSkillUri(ws, 'skill://~/.kiro/skills/*/SKILL.md')), ['home/.kiro/skills/z']);
    assert.deepEqual(rel(resolveSkillUri(ws, 'skill://lib/skill-dir')), ['proj/lib/skill-dir']);
    assert.deepEqual(rel(resolveSkillUri(ws, 'skill://./lib/skill-dir/SKILL.md')), ['proj/lib/skill-dir']);
    // a directory match must contain SKILL.md itself (`nested/` does not)
    assert.deepEqual(rel(resolveSkillUri(ws, 'skill://.kiro/skills/*')), ['proj/.kiro/skills/x']);
  });

  it('~/.kiro in skill URIs maps to KIRO_HOME', () => {
    fx = makeFixture();
    const kh = fx.mkdir('custom-kiro');
    fx.write('custom-kiro/skills/k/SKILL.md', skillMd('k', 'k'));
    const ws = fx.ctx(undefined, { KIRO_HOME: kh });
    assert.deepEqual(discoverSkills(ws, ['skill://~/.kiro/skills/*/SKILL.md'], { includeDefaults: false }).map((s) => [s.name, s.scope]), [['k', 'global']]);
  });

  it('readSkill: name defaults to the directory name; broken front matter tolerated', () => {
    fx = makeFixture();
    const d1 = path.dirname(fx.write('proj/s1/SKILL.md', 'No front matter body'));
    const d2 = path.dirname(fx.write('proj/s2/SKILL.md', '---\ndescription: [broken\n---\nbody'));
    const d3 = path.dirname(fx.write('proj/s3/SKILL.md', '---\nname: "  "\ndescription: " d "\n---\nbody'));
    assert.deepEqual(readSkill(d1, 'resource'), { name: 's1', dir: d1, skillFile: path.join(d1, 'SKILL.md'), scope: 'resource' });
    assert.equal(readSkill(d2, 'resource')!.name, 's2');
    assert.equal(readSkill(d2, 'resource')!.description, undefined);
    assert.equal(readSkill(d3, 'resource')!.name, 's3');
    assert.equal(readSkill(d3, 'resource')!.description, 'd');
    assert.equal(readSkill(path.join(fx.ws, 'none'), 'resource'), undefined);
  });

  it('the same directory reached twice is listed once', () => {
    fx = makeFixture();
    fx.write('proj/.kiro/skills/a/SKILL.md', skillMd('a', 'A'));
    const got = discoverSkills(fx.ctx(), ['skill://a', 'skill://.kiro/skills/a', 'skill://.kiro/skills/*/SKILL.md'], { includeDefaults: true });
    assert.deepEqual(got.map((s) => [s.name, s.scope]), [['a', 'workspace']]);
  });
});

describe('config/skills plugin dir (00 §2.2 Skills)', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  const mk = (fx: Fixture, name: string, dirName = name): SkillInfo => {
    const f = fx.write(`proj/.kiro/skills/${dirName}/SKILL.md`, skillMd(name, `${name} skill`));
    fx.write(`proj/.kiro/skills/${dirName}/scripts/run.sh`, 'echo hi\n');
    return readSkill(path.dirname(f), 'workspace')!;
  };

  it('layout: kiro/.claude-plugin/plugin.json + skills/<name> symlinks', () => {
    fx = makeFixture();
    const skills = [mk(fx, 'backend-patterns'), mk(fx, 'Weird Name!', 'weird')];
    const target = fx.mkdir('runtime');
    const dir = buildSkillsPluginDir(skills, target)!;
    assert.equal(dir, path.join(target, 'kiro'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')), { name: 'kiro', version: '0.0.0' });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')).sort(), ['backend-patterns', 'weird-name']);
    const link = path.join(dir, 'skills', 'backend-patterns');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.realpathSync(link), fs.realpathSync(skills[0]!.dir));
    assert.equal(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8'), skillMd('backend-patterns', 'backend-patterns skill'));
    assert.equal(fs.readFileSync(path.join(link, 'scripts', 'run.sh'), 'utf8'), 'echo hi\n');
  });

  it('no skills ⇒ undefined and nothing created', () => {
    fx = makeFixture();
    const target = path.join(fx.root, 'runtime');
    assert.equal(buildSkillsPluginDir([], target), undefined);
    assert.equal(fs.existsSync(target), false);
  });

  it('rebuilding replaces previous skills; name collisions get suffixes', () => {
    fx = makeFixture();
    const a = mk(fx, 'dup', 'dup1');
    const b = mk(fx, 'dup', 'dup2');
    const c = mk(fx, 'other');
    const target = fx.mkdir('runtime');
    buildSkillsPluginDir([c], target);
    const dir = buildSkillsPluginDir([a, b], target)!;
    assert.deepEqual(fs.readdirSync(path.join(dir, 'skills')).sort(), ['dup', 'dup-2']);
    assert.equal(fs.realpathSync(path.join(dir, 'skills', 'dup-2')), fs.realpathSync(b.dir));
  });

  const nameTable: [string, string][] = [
    ['backend-patterns', 'backend-patterns'],
    ['Backend Patterns', 'backend-patterns'],
    ['a_b.c', 'a-b-c'],
    ['--x--', 'x'],
    ['!!!', 'skill'],
    ['x'.repeat(80), 'x'.repeat(64)],
  ];
  for (const [n, want] of nameTable) it(`pluginSkillName(${JSON.stringify(n)})`, () => assert.equal(pluginSkillName(n), want));
});

describe('config/skills expandSkillInvocation (02 §6.2)', () => {
  let fx: Fixture;
  afterEach(() => fx?.cleanup());

  const skillWith = (fx: Fixture, body: string): SkillInfo =>
    readSkill(path.dirname(fx.write('proj/.kiro/skills/s/SKILL.md', `---\nname: s\ndescription: d\n---\n${body}`)), 'workspace')!;

  const table: [string, string, string][] = [
    ['Review $ARGUMENTS carefully.', 'src/a.ts "b c"', 'Review src/a.ts "b c" carefully.'],
    ['First ${1}, second ${2}, all ${@}', 'one "two words"', 'First one, second two words, all one "two words"'],
    ['Missing ${3}.', 'a b', 'Missing .'],
    ['Just do it.', 'with these args', 'Just do it.\n\nARGUMENTS: with these args'],
    ['Just do it.', '   ', 'Just do it.'],
    ['Body\r\nline 2\r\n', '', 'Body\nline 2'],
    ['Unbalanced ${1}', 'it\'s', "Unbalanced it's"],
  ];
  for (const [body, args, want] of table) {
    it(`${JSON.stringify(body)} + ${JSON.stringify(args)}`, () => {
      fx = makeFixture();
      assert.equal(expandSkillInvocation(skillWith(fx, body), args), want);
    });
  }

  it('readSkillBody strips front matter and trims', () => {
    fx = makeFixture();
    assert.equal(readSkillBody(skillWith(fx, '\n\n  Body text \n\n')), 'Body text');
  });
});
