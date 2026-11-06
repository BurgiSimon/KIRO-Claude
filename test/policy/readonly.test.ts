/**
 * Q read-only command detection — every `requires_acceptance` vector from 06 Appendix A
 * (execute/mod.rs tests: readonly, windows, allowedCommands) plus the shlex vectors.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isReadonlyCommand, READONLY_COMMANDS, requiresAcceptance } from '../../src/policy/readonly.js';
import { shlexSplit } from '../../src/util/shlex.js';

describe('shlex 1.3.0 with comments (Appendix A)', () => {
  it('vectors', () => {
    assert.deepEqual(shlexSplit(`echo 'Hello, world!'`, { comments: true }), ['echo', 'Hello, world!']);
    assert.deepEqual(shlexSplit(`ls # ; rm x`, { comments: true }), ['ls']);
    assert.deepEqual(shlexSplit(`a "b\\$c\\x"`, { comments: true }), ['a', 'b$c\\x']);
    assert.equal(shlexSplit(`echo 'abc`, { comments: true }), null);
    assert.equal(shlexSplit(`echo abc\\`, { comments: true }), null);
  });
});

const READONLY_VECTORS: Array<[string, boolean]> = [
  ['ls ~', false], ['ls -al ~', false], ['pwd', false], ["echo 'Hello, world!'", false], ['which aws', false],
  ['echo hi > myimportantfile', true], ['ls -al >myimportantfile', true], ['echo hi 2> myimportantfile', true],
  ['echo hi >> myimportantfile', true], ['echo $(rm myimportantfile)', true], ['echo `rm myimportantfile`', true],
  ['echo hello && rm myimportantfile', true], ['echo hello&&rm myimportantfile', true],
  ['ls nonexistantpath || rm myimportantfile', true], ['echo myimportantfile | xargs rm', true],
  ['echo myimportantfile|args rm', true], ['echo <(rm myimportantfile)', true],
  ["cat <<< 'some string here' > myimportantfile", true], ["echo '\n#!/usr/bin/env bash\necho hello\n' > myscript.sh", true],
  ['cat <<EOF > myimportantfile\nhello world\nEOF', true], ['which ls\ntouch asdf', true], ['which ls\rtouch asdf', true],
  [`IFS=';'; for cmd in "which ls;touch asdf"; do eval "$cmd"; done`, true],
  ["find . -name '*.rs' | grep main", false], ['ls -la | grep .git', false], ['cat file.txt | grep pattern | head -n 5', false],
  ["find . -name '*.rs' | rm", true], ['ls -la | grep .git | rm -rf', true], ['echo hello | sudo rm -rf /', true],
  ['find important-dir/ -exec rm {} \\;', true], ["find . -name '*.c' -execdir gcc -o '{}.out' '{}' \\;", true],
  ['find important-dir/ -delete', true], ['find important-dir/ -fls /etc/passwd', true],
  ['echo y | find . -type f -maxdepth 1 -okdir open -a Calculator {} +', true], ["find important-dir/ -name '*.txt'", false],
  [`find / -fprintf "/path/to/file" <data-to-write> -quit`, true], ['find . -${t}exec touch asdf \\{\\} +', true],
  ['find . -${t:=exec} touch asdf2 \\{\\} +', true], [`find /tmp -name "*"  -exe$9c touch /tmp/find_result {} +`, true],
  [`echo 'test data' | grep -P '(?{system("date")})'`, true], [`echo 'test data' | grep --perl-regexp '(?{system("date")})'`, true],
];

const WINDOWS_VECTORS: Array<[string, boolean]> = [
  ['dir', false], ['type file.txt', false], ['echo Hello, world!', false], ['del file.txt', true], ['rmdir /s /q folder', true],
  ['rd /s /q folder', true], ['format c:', true], ['erase file.txt', true], ['copy file.txt > important.txt', true],
  ['move file.txt destination', true], ['dir | findstr txt', true], ['type file.txt | findstr pattern', true],
  ['dir | del', true], ['type file.txt | del', true],
];

const ALLOWED = ['git status', 'root', 'command subcommand a=[0-9]{10} b=[0-9]{10}', 'command subcommand && command subcommand'];
const ALLOWED_VECTORS: Array<[string, boolean]> = [
  ['root', false], ['root subcommand', true], ['git', true], ['git status', false],
  ['command subcommand a=0123456789 b=0123456789', false], ['command subcommand a=0123456789 b=012345678', true],
  ['command subcommand alternate a=0123456789 b=0123456789', true], ["echo 'test<(data'", true], ["echo 'test$(data)'", true],
  ["echo 'test`data`'", true], ["echo 'test' > output.txt", true], ["echo 'test data' && touch main.py", true],
  ["echo 'test' || rm file", true], ["echo 'test' & background", true], ["echo 'test data'; touch main.py", true],
  ['echo $HOME', true], ["echo 'test\nrm file'", true], ["echo 'test\rrm file'", true], ['IFS=/ malicious', true],
];

describe('requiresAcceptance — readonly vectors (allowReadOnly=true)', () => {
  for (const [c, e] of READONLY_VECTORS) {
    it(JSON.stringify(c), () => assert.equal(requiresAcceptance(c, undefined, true), e));
  }
});

describe('requiresAcceptance — windows vectors', () => {
  for (const [c, e] of WINDOWS_VECTORS) {
    it(JSON.stringify(c), () => assert.equal(requiresAcceptance(c, undefined, true), e));
  }
});

describe('requiresAcceptance — allowedCommands vectors', () => {
  for (const [c, e] of ALLOWED_VECTORS) {
    it(JSON.stringify(c), () => assert.equal(requiresAcceptance(c, ALLOWED, true), e));
  }
});

describe('requiresAcceptance — defaults', () => {
  it('without allowReadOnly every non-empty command needs acceptance', () => {
    assert.equal(requiresAcceptance('ls', undefined, false), true);
    assert.equal(requiresAcceptance('pwd', [], false), true);
  });
  it('empty command needs no acceptance', () => {
    assert.equal(requiresAcceptance('', undefined, false), false);
    assert.equal(requiresAcceptance('   ', undefined, false), false);
  });
  it('comment hides the rest of the line (shlex comments on)', () => {
    assert.equal(requiresAcceptance('ls # ; rm x', undefined, true), false);
  });
  it('allowedCommands match the full original command, anchored', () => {
    assert.equal(requiresAcceptance('npm test', ['npm test'], false), false);
    assert.equal(requiresAcceptance('npm test --watch', ['npm test'], false), true);
    assert.equal(requiresAcceptance('npm test --watch', ['npm test.*'], false), false);
  });
  it('invalid allow regexes are ignored', () => {
    assert.equal(requiresAcceptance('ls', ['(?=ls)ls'], false), true);
  });
  it('quoted pipe inside a word needs acceptance', () => {
    assert.equal(requiresAcceptance("grep 'a|b' file", undefined, true), true);
  });
});

describe('isReadonlyCommand', () => {
  it('list', () => assert.deepEqual([...READONLY_COMMANDS], ['ls', 'cat', 'echo', 'pwd', 'which', 'head', 'tail', 'find', 'grep', 'dir', 'type']));
  const table: Array<[string, boolean]> = [
    ['ls -la', true], ['cat a | grep b | head -n 3', true], ['git status', false], ['rm -rf /', false],
    ['echo hi > f', false], ['find . -delete', false], ['grep -P x', false], ['', true],
  ];
  for (const [c, e] of table) it(JSON.stringify(c), () => assert.equal(isReadonlyCommand(c), e));
});
