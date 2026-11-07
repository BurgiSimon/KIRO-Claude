/**
 * Review X1 (spec-links), the primitives: util/fsx readRegularFileNoFollow and writeFileAtomic
 * `followLinks: false` (the default still writes through a link, for its other callers),
 * policy/specwrite specFileRefusal / specFolderRefusal (the checkSpecWrite subject rules for
 * kiro-claude's own I/O), and spec/docfs readSpecFile / writeSpecFile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readRegularFileNoFollow, writeFileAtomic } from '../../src/util/fsx.js';
import { checkSpecWrite, specFileRefusal, specFolderRefusal } from '../../src/policy/specwrite.js';
import { SPEC_LINK_RULE, SpecFileRefusedError, readSpecFile, specFolderRoot, writeSpecFile } from '../../src/spec/docfs.js';

function tmp(): { root: string; ws: string; outside: string; cleanup(): void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r5x-io-')));
  const ws = path.join(root, 'ws');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(ws, '.kiro', 'specs', 'feat'), { recursive: true });
  fs.mkdirSync(outside);
  return { root, ws, outside, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

test('readRegularFileNoFollow: regular file, missing, symbolic link (ELOOP), directory and FIFO (EFTYPE, no hang)', () => {
  const t = tmp();
  try {
    const f = path.join(t.ws, 'a.md');
    fs.writeFileSync(f, 'hello');
    assert.equal(readRegularFileNoFollow(f), 'hello');
    assert.equal(readRegularFileNoFollow(path.join(t.ws, 'missing.md')), undefined);
    assert.equal(readRegularFileNoFollow(path.join(f, 'below')), undefined, 'ENOTDIR is missing');
    const secret = path.join(t.outside, 'secret');
    fs.writeFileSync(secret, 'SECRET');
    fs.symlinkSync(secret, path.join(t.ws, 'link.md'));
    assert.equal(code(() => readRegularFileNoFollow(path.join(t.ws, 'link.md'))), 'ELOOP');
    assert.equal(code(() => readRegularFileNoFollow(t.ws)), 'EFTYPE');
    // a link in a FOLDER of the path is followed (only the last component is checked here)
    fs.symlinkSync(t.ws, path.join(t.root, 'wslink'));
    assert.equal(readRegularFileNoFollow(path.join(t.root, 'wslink', 'a.md')), 'hello');
    if (process.platform !== 'win32' && spawnSync('mkfifo', [path.join(t.ws, 'fifo')]).status === 0) {
      assert.equal(code(() => readRegularFileNoFollow(path.join(t.ws, 'fifo'))), 'EFTYPE');
    }
  } finally {
    t.cleanup();
  }
});

test('writeFileAtomic: followLinks:false replaces the link itself; the default still writes through it', () => {
  const t = tmp();
  try {
    const target = path.join(t.outside, 'target.json');
    fs.writeFileSync(target, 'OLD');
    const link = path.join(t.ws, 'doc.md');
    fs.symlinkSync(target, link);
    writeFileAtomic(link, 'NEW', { followLinks: false });
    assert.equal(fs.readFileSync(target, 'utf8'), 'OLD', 'the target was written');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(link, 'utf8'), 'NEW');
    // the default (settings, session index, …) is unchanged: through the link, which survives
    const link2 = path.join(t.ws, 'settings.json');
    fs.symlinkSync(target, link2);
    writeFileAtomic(link2, 'THROUGH');
    assert.equal(fs.readFileSync(target, 'utf8'), 'THROUGH');
    assert.equal(fs.lstatSync(link2).isSymbolicLink(), true);
    // a regular file keeps its mode with followLinks:false too
    const reg = path.join(t.ws, 'reg.md');
    fs.writeFileSync(reg, 'x', { mode: 0o640 });
    fs.chmodSync(reg, 0o640);
    writeFileAtomic(reg, 'y', { followLinks: false });
    if (process.platform !== 'win32') assert.equal(fs.statSync(reg).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(t.ws).filter((n) => n.endsWith('.tmp')), []);
  } finally {
    t.cleanup();
  }
});

test('specFileRefusal / specFolderRefusal: the checkSpecWrite subject rules for kiro-claude itself', () => {
  const t = tmp();
  try {
    const feat = path.join(t.ws, '.kiro', 'specs', 'feat');
    const doc = path.join(feat, 'design.md');
    assert.equal(specFileRefusal(doc, t.ws), undefined, 'a missing document in a regular folder may be created');
    fs.writeFileSync(doc, 'x');
    assert.equal(specFileRefusal(doc, t.ws), undefined);
    fs.rmSync(doc);
    fs.symlinkSync(path.join(feat, 'requirements.md'), doc);
    assert.match(specFileRefusal(doc, t.ws) ?? '', /design\.md is a symbolic link$/, 'also a link to another document of the folder');
    fs.rmSync(doc);
    fs.mkdirSync(doc);
    assert.match(specFileRefusal(doc, t.ws) ?? '', /design\.md is not a regular file$/);
    fs.rmSync(doc, { recursive: true });
    // folder linked out / inside / dangling / looping
    fs.rmSync(feat, { recursive: true });
    fs.symlinkSync(t.outside, feat);
    assert.match(specFolderRefusal(feat, t.ws) ?? '', /resolves to .*outside, outside the workspace/);
    assert.match(specFileRefusal(doc, t.ws) ?? '', /design\.md resolves to .*outside\/design\.md, outside the workspace/);
    fs.rmSync(feat);
    fs.mkdirSync(path.join(t.ws, 'docs', 'feat'), { recursive: true });
    fs.symlinkSync(path.join('..', '..', 'docs', 'feat'), feat);
    assert.equal(specFolderRefusal(feat, t.ws), undefined);
    assert.equal(specFileRefusal(doc, t.ws), undefined);
    fs.rmSync(feat);
    fs.symlinkSync(path.join(t.root, 'gone'), feat);
    assert.match(specFolderRefusal(feat, t.ws) ?? '', /the symbolic link .*feat resolves to nothing \(dangling, or a loop\)$/);
    assert.match(specFileRefusal(doc, t.ws) ?? '', /design\.md: the symbolic link .*feat resolves to nothing/);
    // the gate gives the same reasons in the same words
    const gate = checkSpecWrite({ claudeName: 'Write', input: { file_path: doc }, subjects: [doc], cwd: t.ws }, [doc], { workspaceRoot: t.ws, cwd: t.ws, env: { HOME: t.root }, home: t.root });
    assert.equal(gate.refused, specFileRefusal(doc, t.ws));
  } finally {
    t.cleanup();
  }
});

test('docfs: readSpecFile / writeSpecFile refuse with SpecFileRefusedError; the workspace is read from the spec path', () => {
  const t = tmp();
  try {
    const feat = path.join(t.ws, '.kiro', 'specs', 'feat');
    assert.equal(specFolderRoot(feat), t.ws);
    assert.equal(specFolderRoot(t.outside), t.outside, 'another folder is its own anchor');
    const doc = path.join(feat, 'tasks.md');
    assert.equal(readSpecFile(doc), undefined);
    writeSpecFile(doc, '- [ ] 1. A\n');
    assert.equal(readSpecFile(doc), '- [ ] 1. A\n');
    const target = path.join(t.outside, 'tasks.md');
    fs.writeFileSync(target, 'OUT');
    fs.rmSync(doc);
    fs.symlinkSync(target, doc);
    assert.throws(() => readSpecFile(doc), (e: unknown) => e instanceof SpecFileRefusedError && /tasks\.md is a symbolic link/.test(e.why) && e.message.includes(SPEC_LINK_RULE));
    assert.throws(() => writeSpecFile(doc, 'IN'), SpecFileRefusedError);
    assert.equal(fs.readFileSync(target, 'utf8'), 'OUT');
    assert.ok(fs.lstatSync(doc).isSymbolicLink(), 'a refused write leaves the link as it is');
  } finally {
    t.cleanup();
  }
});
