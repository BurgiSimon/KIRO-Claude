import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { editorCommand, importOptional, openInEditor, parseOrExit, readAll, readLine } from '../../src/cli/io.js';
import type { CommandDef } from '../../src/cli/args.js';
import { makeCtx, makeEnv, type TestEnv } from './helpers.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

test('readLine: successive lines, remainder kept, EOF ⇒ undefined', async () => {
  const s = new PassThrough();
  s.end('one\r\ntwo\nthree');
  assert.equal(await readLine(s), 'one');
  assert.equal(await readLine(s), 'two');
  assert.equal(await readLine(s), 'three');
  assert.equal(await readLine(s), undefined);
});

test('readAll', async () => {
  const s = new PassThrough();
  s.write('a');
  s.end(Buffer.from('é'));
  assert.equal(await readAll(s), 'aé');
});

test('editor: $EDITOR with arguments, fallback vi, exit codes', () => {
  assert.equal(editorCommand({}), 'vi');
  assert.equal(editorCommand({ EDITOR: '  code -w ' }), 'code -w');
  const file = t.write('f.txt', 'x');
  const script = t.write('ed.sh', '#!/bin/sh\necho "$2" > "$1"\n');
  fs.chmodSync(script, 0o755);
  // `$EDITOR` may carry arguments: the file path is appended (quoted)
  const r = openInEditor(file, { ...t.env, EDITOR: `sh -c 'printf edited > "$0"'` });
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'edited');
  assert.equal(openInEditor(file, { ...t.env, EDITOR: 'false' }).code, 1);
  const spaced = t.write('dir with space/f.txt', 'y');
  assert.equal(openInEditor(spaced, { ...t.env, EDITOR: `sh -c 'printf z > "$0"'` }).code, 0);
  assert.equal(fs.readFileSync(spaced, 'utf8'), 'z');
  assert.ok(path.isAbsolute(script));
});

test('parseOrExit: help to stdout (0), usage error to stderr (2)', () => {
  const def: CommandDef = { name: 'x', about: 'X', args: [{ id: 'a', long: 'a', kind: 'bool' }] };
  const h = makeCtx(t);
  assert.equal(parseOrExit(def, ['--help'], h.ctx), 0);
  assert.match(h.stdout.text, /^X\n\nUsage: kiro-claude x \[OPTIONS\]/);
  const e = makeCtx(t);
  assert.equal(parseOrExit(def, ['--b'], e.ctx), 2);
  assert.match(e.stderr.text, /^error: unexpected argument '--b' found/);
  const ok = parseOrExit(def, ['--a'], makeCtx(t).ctx);
  assert.ok(typeof ok !== 'number' && ok.has('a'));
});

test('importOptional: a missing dependency of an existing module is rethrown as is', async () => {
  const mod = t.write('mods/has-missing-dep.mjs', "import './nope-dep.mjs';\nexport const x = 1;\n");
  await assert.rejects(importOptional(path.basename(mod), 'x', new URL(`file://${path.dirname(mod)}/`).href), (e: unknown) => {
    return e instanceof Error && !/is not available in this build/.test(e.message) && /nope-dep/.test(e.message);
  });
});
