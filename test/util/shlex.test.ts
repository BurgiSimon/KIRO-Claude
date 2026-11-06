import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommand, shellJoin, shellQuote, shlexSplit, splitCompoundCommand } from '../../src/util/shlex.js';

describe('shlex: shlexSplit (Rust shlex 1.3.0, 06 §1.4.1)', () => {
  /** SPLIT_TEST_ITEMS from shlex-1.3.0/src/lib.rs (Rust semantics ⇒ comments: true). */
  const CRATE: Array<[string, string[] | null]> = [
    ['foo$baz', ['foo$baz']],
    ['foo baz', ['foo', 'baz']],
    ['foo"bar"baz', ['foobarbaz']],
    ['foo "bar"baz', ['foo', 'barbaz']],
    ['   foo \nbar', ['foo', 'bar']],
    ['foo\\\nbar', ['foobar']],
    ['"foo\\\nbar"', ['foobar']],
    ["'baz\\$b'", ['baz\\$b']],
    ["'baz\\''", null],
    ['\\', null],
    ['"\\', null],
    ["'\\", null],
    ['"', null],
    ["'", null],
    ['foo #bar\nbaz', ['foo', 'baz']],
    ['foo #bar', ['foo']],
    ['foo#bar', ['foo#bar']],
    ['foo"#bar', null],
    ["'\\n'", ['\\n']],
    ["'\\\\n'", ['\\\\n']],
  ];
  for (const [input, want] of CRATE) {
    it(`crate vector ${JSON.stringify(input)}`, () => assert.deepEqual(shlexSplit(input, { comments: true }), want));
  }

  it('comments are off by default (Python shlex.split behaviour)', () => {
    assert.deepEqual(shlexSplit('foo #bar'), ['foo', '#bar']);
    assert.deepEqual(shlexSplit('/fix #123 now'), ['/fix', '#123', 'now']);
    assert.deepEqual(shlexSplit('ls # ; rm x'), ['ls', '#', ';', 'rm', 'x']);
    assert.deepEqual(shlexSplit('ls # ; rm x', { comments: true }), ['ls']);
  });

  it('quoting rules', () => {
    assert.deepEqual(shlexSplit(`a "b c" 'd e' f\\ g`), ['a', 'b c', 'd e', 'f g']);
    assert.deepEqual(shlexSplit('"a\\"b"'), ['a"b']);
    assert.deepEqual(shlexSplit('"a\\$b\\`c\\\\d\\xe"'), ['a$b`c\\d\\xe']);
    assert.deepEqual(shlexSplit(`'it''s'`), ['its']);
    assert.deepEqual(shlexSplit(`""`), ['']);
    assert.deepEqual(shlexSplit(`'' x`), ['', 'x']);
    assert.deepEqual(shlexSplit('a\tb\nc'), ['a', 'b', 'c']);
    assert.deepEqual(shlexSplit('a\rb'), ['a\rb']); // \r is not whitespace in shlex 1.3.0
    assert.deepEqual(shlexSplit(''), []);
    assert.deepEqual(shlexSplit('   '), []);
    assert.deepEqual(shlexSplit('"unterminated'), null);
  });

  it('prompt argument example (02 §6.1)', () => {
    assert.deepEqual(shlexSplit('/analyze "performance issue" "detailed"'), ['/analyze', 'performance issue', 'detailed']);
  });

  it('Q execute_bash words: operators survive as words (06 §1.4.1)', () => {
    assert.deepEqual(shlexSplit("find . -name '*.rs' | grep main", { comments: true }), ['find', '.', '-name', '*.rs', '|', 'grep', 'main']);
    assert.deepEqual(shlexSplit('echo hello&&rm f', { comments: true }), ['echo', 'hello&&rm', 'f']);
    assert.deepEqual(shlexSplit("echo 'test' & background", { comments: true }), ['echo', 'test', '&', 'background']);
    assert.deepEqual(shlexSplit('echo $(rm f)', { comments: true }), ['echo', '$(rm', 'f)']);
  });
});

describe('shlex: shellQuote / shellJoin', () => {
  const table: Array<[string, string]> = [
    ['', "''"],
    ['abc', 'abc'],
    ['a/b.c-d_e@f%g+h=i:j,k', 'a/b.c-d_e@f%g+h=i:j,k'],
    ['a b', "'a b'"],
    ["it's", `'it'"'"'s'`],
    ['$HOME', "'$HOME'"],
    ['*.md', "'*.md'"],
    ['a\nb', "'a\nb'"],
    ['ünï', "'ünï'"],
  ];
  for (const [input, want] of table) {
    it(`quotes ${JSON.stringify(input)}`, () => assert.equal(shellQuote(input), want));
  }
  it('round-trips through shlexSplit', () => {
    const args = ['plain', 'with space', "quote's", 'dollar $x', 'back\\slash', 'tab\there', '', '#hash', '"dq"', 'new\nline'];
    assert.deepEqual(shlexSplit(shellJoin(args), { comments: true }), args);
  });
});

describe('shlex: splitCompoundCommand (02 §2.8 shell parsing)', () => {
  const table: Array<[string, string[] | null]> = [
    ['git status', ['git status']],
    ['  git status  ', ['git status']],
    ['', []],
    ['git add . && git commit -m "x; y"', ['git add .', 'git commit -m "x; y"']],
    ['a; b && c || d | e & f', ['a', 'b', 'c', 'd', 'e', 'f']],
    ['a |& b', ['a', 'b']],
    ['a\nb\r\nc', ['a', 'b', 'c']],
    ['a ;; ; b', ['a', 'b']],
    ["echo 'a && b' | wc -l", ["echo 'a && b'", 'wc -l']],
    ['echo "a | b"', ['echo "a | b"']],
    ['echo a\\;b', ['echo a\\;b']],
    ['npm test 2>&1 | tee log', ['npm test 2>&1', 'tee log']],
    ['cmd >&2', ['cmd >&2']],
    ['cmd &>out.txt', ['cmd &>out.txt']],
    ['cmd &>>out.txt', ['cmd &>>out.txt']],
    ['cat <&3', ['cat <&3']],
    ['echo x >| file', ['echo x >| file']],
    ['(cd sub && make)', ['cd sub', 'make']],
    ['{ echo a; echo b; }', ['echo a', 'echo b']],
    ['echo {a,b}', ['echo {a,b}']],
    ['git status # check; rm -rf /', ['git status']],
    ['echo a#b', ['echo a#b']],
    ["echo 'a'#b", ["echo 'a'#b"]],
    ['echo x;#c\nls', ['echo x', 'ls']],
    ['git \\\n  status', ['git status']],
    ['rm  -rf \t /', ['rm -rf /']],
    ['echo "a   b"   c', ['echo "a   b" c']],
    ['echo "multi\nline" && ls', ['echo "multi\nline"', 'ls']],
    ["echo $'it\\'s' && ls", ["echo $'it\\'s'", 'ls']],
    ['echo ${HOME} $USER', ['echo ${HOME} $USER']],
    ['cat <<< "here string" | wc', ['cat <<< "here string"', 'wc']],
    ['FOO=1 bar --x', ['FOO=1 bar --x']],
    // here-documents: bodies are data
    ["cat <<'EOF' | grep x\n$(rm -rf /)\n`boom`\nEOF\necho done", ["cat <<'EOF'", 'grep x', 'echo done']],
    ['cat <<EOF\nplain body; rm x\nEOF', ['cat <<EOF']],
    ['cat <<-EOF\n\tindented\n\tEOF\nls', ['cat <<-EOF', 'ls']],
    ['cat <<"E O"\nx\nE O\nls', ['cat <<"E O"', 'ls']],
    ['cat <<A <<B\na\nA\nb\nB\nls', ['cat <<A <<B', 'ls']],
    // unparseable
    ['echo $(rm -rf /)', null],
    ['echo `whoami`', null],
    ['echo "$(whoami)"', null],
    ['echo "`whoami`"', null],
    ['diff <(ls a) <(ls b)', null],
    ['tee >(gzip > x.gz)', null],
    ['echo $((1+2))', null],
    ['echo "unterminated', null],
    ["echo 'unterminated", null],
    ['echo trailing\\', null],
    ['cat <<EOF\nbody without end', null],
    ['cat <<EOF', null],
    ['cat <<EOF\n$(whoami)\nEOF', null], // unquoted delimiter: body expands
    ['cat <<', null],
  ];
  for (const [input, want] of table) {
    it(`${JSON.stringify(input)}`, () => assert.deepEqual(splitCompoundCommand(input), want));
  }

  it('normalizeCommand strips quoting so deny rules cannot be dodged', () => {
    assert.equal(normalizeCommand('"rm" -rf  /'), 'rm -rf /');
    assert.equal(normalizeCommand("r''m -rf /"), 'rm -rf /');
    assert.equal(normalizeCommand('\\rm -rf /'), 'rm -rf /');
    assert.equal(normalizeCommand('git commit -m "a b"'), 'git commit -m a b');
    assert.equal(normalizeCommand('echo "x'), null);
  });

  it('literal $( inside single quotes is fine', () => {
    assert.deepEqual(splitCompoundCommand("echo '$(not run)' `"), null);
    assert.deepEqual(splitCompoundCommand("grep '$(x)' f"), ["grep '$(x)' f"]);
    assert.deepEqual(splitCompoundCommand("echo '<(x)'"), ["echo '<(x)'"]);
    assert.deepEqual(splitCompoundCommand('echo "<(x)"'), ['echo "<(x)"']);
  });
});
