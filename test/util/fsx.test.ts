import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureDir,
  exists,
  findJsonErrorOffset,
  isDirectory,
  isFile,
  JsonFileError,
  mkdirp,
  parseJsonText,
  positionToLineColumn,
  readJsonFile,
  readJsonIfExists,
  readTextIfExists,
  writeFileAtomic,
  writeJsonAtomic,
} from '../../src/util/fsx.js';

const posix = process.platform === 'win32' ? { skip: 'POSIX modes' } : {};

describe('fsx', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-fsx-'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('exists / isFile / isDirectory', () => {
    const f = path.join(dir, 'f.txt');
    fs.writeFileSync(f, 'x');
    assert.equal(exists(f), true);
    assert.equal(isFile(f), true);
    assert.equal(isDirectory(f), false);
    assert.equal(isDirectory(dir), true);
    assert.equal(isFile(dir), false);
    assert.equal(exists(path.join(dir, 'nope')), false);
    assert.equal(isFile(path.join(f, 'below-a-file')), false);
  });

  it('readTextIfExists', () => {
    const f = path.join(dir, 't.txt');
    fs.writeFileSync(f, 'héllo');
    assert.equal(readTextIfExists(f), 'héllo');
    assert.equal(readTextIfExists(path.join(dir, 'missing')), undefined);
    assert.equal(readTextIfExists(path.join(f, 'x')), undefined); // ENOTDIR
    assert.equal(readTextIfExists(dir), undefined); // EISDIR
  });

  it('readJsonFile parses strict JSON with BOM', () => {
    const f = path.join(dir, 'a.json');
    fs.writeFileSync(f, '﻿{"a": [1, 2], "b": {"c": null}}');
    assert.deepEqual(readJsonFile(f), { a: [1, 2], b: { c: null } });
  });

  it('readJsonFile reports line/column of syntax errors', () => {
    const f = path.join(dir, 'bad.json');
    fs.writeFileSync(f, '{\n  "a": 1,\n  "b": 2,\n}\n');
    let caught: unknown;
    try {
      readJsonFile(f);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof JsonFileError);
    assert.equal(caught.path, f);
    assert.equal(caught.line, 4);
    assert.equal(caught.column, 1);
    assert.match(caught.message, new RegExp(`^${f.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}: invalid JSON: .* at line 4 column 1$`));
  });

  it('readJsonFile: missing file throws the fs error (ENOENT)', () => {
    assert.throws(() => readJsonFile(path.join(dir, 'none.json')), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
  });

  it('readJsonIfExists', () => {
    assert.equal(readJsonIfExists(path.join(dir, 'none.json')), undefined);
    const f = path.join(dir, 'ok.json');
    fs.writeFileSync(f, '[1]');
    assert.deepEqual(readJsonIfExists(f), [1]);
    fs.writeFileSync(f, '[1');
    assert.throws(() => readJsonIfExists(f), JsonFileError);
  });

  it('findJsonErrorOffset table', () => {
    const table: Array<[string, number]> = [
      ['{}', -1],
      ['[1, 2.5e-3, -0, "x\\u00e9\\n", true, false, null]', -1],
      ['  {"a": {"b": []}}  ', -1],
      ['', 0],
      ['   ', 3],
      ['{', 1],
      ['{"a" 1}', 5],
      ['{"a": 1,}', 8],
      ['[1,]', 3],
      ['[1 2]', 3],
      ['tru', 3],
      ['nul', 3],
      ['01', 1],
      ['1.', 2],
      ['-', 1],
      ['1e', 2],
      ['"abc', 4],
      ['"a\\x"', 3],
      ['"\\u12G4"', 5],
      ['"tab\there"', 4],
      ['{} x', 3],
      ["{'a': 1}", 1],
      ['NaN', 0],
    ];
    for (const [text, want] of table) {
      assert.equal(findJsonErrorOffset(text), want, JSON.stringify(text));
      if (want === -1) assert.doesNotThrow(() => JSON.parse(text));
      else assert.throws(() => JSON.parse(text));
    }
  });

  it('positionToLineColumn', () => {
    assert.deepEqual(positionToLineColumn('abc', 0), { line: 1, column: 1 });
    assert.deepEqual(positionToLineColumn('abc', 2), { line: 1, column: 3 });
    assert.deepEqual(positionToLineColumn('a\nbc', 3), { line: 2, column: 2 });
    assert.deepEqual(positionToLineColumn('a\n', 2), { line: 2, column: 1 });
    assert.deepEqual(positionToLineColumn('a', 99), { line: 1, column: 2 });
  });

  it('parseJsonText reports end-of-input errors at the end', () => {
    try {
      parseJsonText('{\n "a": [1,\n', 'mem.json');
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof JsonFileError);
      assert.equal(e.line, 3);
      assert.equal(e.column, 1);
    }
  });

  it('ensureDir creates nested directories (idempotent)', () => {
    const d = path.join(dir, 'x', 'y', 'z');
    ensureDir(d);
    ensureDir(d);
    assert.equal(isDirectory(d), true);
  });

  it('mkdirp: errors instead of looping on odd filesystems; ENOTDIR on files', () => {
    const f = path.join(dir, 'plainfile');
    fs.writeFileSync(f, 'x');
    assert.throws(() => mkdirp(path.join(f, 'sub', 'deeper')), (e: NodeJS.ErrnoException) => e.code === 'ENOTDIR');
    if (process.platform === 'linux' && fs.existsSync('/proc/self')) {
      // fs.mkdirSync('/proc/a/b', { recursive: true }) never returns on some kernels/sandboxes
      assert.throws(() => mkdirp('/proc/kc-not-creatable/x'));
    }
    mkdirp(path.join(dir, 'm', 'n'));
    mkdirp(path.join(dir, 'm', 'n'));
    assert.equal(isDirectory(path.join(dir, 'm', 'n')), true);
  });

  it('ensureDir mode', posix, () => {
    const d = path.join(dir, 'private', 'leaf');
    ensureDir(d, 0o700);
    assert.equal(fs.statSync(d).mode & 0o777, 0o700);
  });

  it('writeFileAtomic writes, replaces and creates parents; no temp files left', () => {
    const f = path.join(dir, 'atomic', 'deep', 'file.txt');
    writeFileAtomic(f, 'one');
    assert.equal(fs.readFileSync(f, 'utf8'), 'one');
    writeFileAtomic(f, 'two');
    assert.equal(fs.readFileSync(f, 'utf8'), 'two');
    writeFileAtomic(f, new Uint8Array([104, 105]));
    assert.equal(fs.readFileSync(f, 'utf8'), 'hi');
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ['file.txt']);
  });

  it('writeFileAtomic modes: explicit, and preserved from the existing file', posix, () => {
    const f = path.join(dir, 'modes', 'secret.json');
    writeFileAtomic(f, 'a', { mode: 0o600 });
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    writeFileAtomic(f, 'b');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'mode kept on rewrite');
    writeFileAtomic(f, 'c', { mode: 0o644 });
    assert.equal(fs.statSync(f).mode & 0o777, 0o644);
  });

  it('writeFileAtomic replaces through rename (readers never see partial content)', () => {
    const f = path.join(dir, 'race.txt');
    writeFileAtomic(f, 'A'.repeat(100000));
    const ino1 = fs.statSync(f).ino;
    writeFileAtomic(f, 'B'.repeat(100000));
    const st = fs.statSync(f);
    if (process.platform !== 'win32') assert.notEqual(st.ino, ino1);
    assert.equal(fs.readFileSync(f, 'utf8'), 'B'.repeat(100000));
  });

  it('writeFileAtomic cleans up the temp file on failure', () => {
    const target = path.join(dir, 'is-a-dir');
    fs.mkdirSync(path.join(target, 'child'), { recursive: true });
    assert.throws(() => writeFileAtomic(target, 'x'));
    assert.deepEqual(
      fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
      [],
    );
  });

  it('writeJsonAtomic formats with 2 spaces and a trailing newline', () => {
    const f = path.join(dir, 'out.json');
    writeJsonAtomic(f, { a: [1, { b: 'c' }] });
    assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "a": [\n    1,\n    {\n      "b": "c"\n    }\n  ]\n}\n');
    assert.throws(() => writeJsonAtomic(f, undefined), TypeError);
  });
});
