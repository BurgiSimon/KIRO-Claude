/**
 * `#spec:<name>` in chat follows the rules of kiro-claude's own spec I/O (spec/docfs, r5x X1):
 * a document that is a symbolic link (also to another document of the folder), a spec folder
 * linked out of the workspace or to nothing, and a `.kiro/specs` linked out of the workspace are
 * not read; each refusal is a notice. A spec folder linked inside the workspace keeps working.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expandHashRefs, readTextForRef } from '../../src/context/refs.js';
import { removeOnExit } from '../tmpdirs.js';
import { tmpWorkspace, write } from './helpers.js';

const posix = process.platform !== 'win32';

function outsideDir(): string {
  return removeOnExit(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-specref-out-')));
}

describe('#spec:<name> and symbolic links (r5x X1)', { skip: !posix }, () => {
  it('a document linked outside the workspace is left out with a notice; the others are inlined', async () => {
    const ws = tmpWorkspace();
    const out = outsideDir();
    const secret = write(path.join(out, 'secret.txt'), 'TOP-SECRET-TEXT');
    const dir = path.join(ws.cwd, '.kiro', 'specs', 'feat');
    const req = write(path.join(dir, 'requirements.md'), '# Req\n');
    fs.symlinkSync(secret, path.join(dir, 'design.md'));
    const r = await expandHashRefs('#spec:feat go', { ws, steering: [] });
    assert.equal(r.blocks.length, 1);
    assert.ok(r.blocks[0]!.includes(`[${req}]\n# Req`));
    assert.ok(!r.blocks.join('').includes('TOP-SECRET-TEXT'));
    assert.equal(r.notices.length, 1);
    assert.match(r.notices[0]!, /^Spec 'feat': a document was left out: .*design\.md.*symbolic link.*never follows a symbolic link/);
  });

  it('a link to another document of the folder is refused too, and a spec of only links says so once per document', async () => {
    const ws = tmpWorkspace();
    const dir = path.join(ws.cwd, '.kiro', 'specs', 'feat');
    write(path.join(dir, 'requirements.md'), 'R');
    fs.symlinkSync('requirements.md', path.join(dir, 'tasks.md'));
    const r = await expandHashRefs('#spec:feat', { ws, steering: [] });
    assert.equal(r.blocks.length, 1);
    assert.equal((r.blocks[0]!.match(/\nR(\n|$)/g) ?? []).length, 1, 'requirements.md is inlined once');
    assert.equal(r.notices.length, 1);
    assert.match(r.notices[0]!, /tasks\.md/);

    const only = path.join(ws.cwd, '.kiro', 'specs', 'links');
    fs.mkdirSync(only, { recursive: true });
    fs.symlinkSync('/etc/hostname', path.join(only, 'requirements.md'));
    const o = await expandHashRefs('#spec:links', { ws, steering: [] });
    assert.deepEqual(o.blocks, []);
    assert.equal(o.notices.length, 1, 'no "has no documents" notice on top of the refusal');
    assert.match(o.notices[0]!, /^Spec 'links': a document was left out/);
  });

  it('a spec folder linked out of the workspace is not read at all', async () => {
    const ws = tmpWorkspace();
    const out = outsideDir();
    write(path.join(out, 'requirements.md'), 'OUTSIDE-REQ');
    fs.mkdirSync(path.join(ws.cwd, '.kiro', 'specs'), { recursive: true });
    fs.symlinkSync(out, path.join(ws.cwd, '.kiro', 'specs', 'feat'));
    const r = await expandHashRefs('#spec:feat', { ws, steering: [] });
    assert.deepEqual(r.blocks, []);
    assert.equal(r.notices.length, 1);
    assert.match(r.notices[0]!, /^Spec 'feat' was not read: .*outside the workspace/);
  });

  it('a .kiro/specs linked out of the workspace is not read', async () => {
    const ws = tmpWorkspace();
    const out = outsideDir();
    write(path.join(out, 'feat', 'requirements.md'), 'OUTSIDE-REQ');
    fs.mkdirSync(path.join(ws.cwd, '.kiro'), { recursive: true });
    fs.symlinkSync(out, path.join(ws.cwd, '.kiro', 'specs'));
    const r = await expandHashRefs('#spec:feat', { ws, steering: [] });
    assert.deepEqual(r.blocks, []);
    assert.ok(!JSON.stringify(r).includes('OUTSIDE-REQ'));
    assert.equal(r.notices.length, 1);
    assert.match(r.notices[0]!, /^Spec 'feat' was not read: /);
  });

  it('control: a spec folder linked inside the workspace is inlined', async () => {
    const ws = tmpWorkspace();
    const real = path.join(ws.cwd, 'specs-src', 'feat');
    const req = write(path.join(real, 'requirements.md'), 'INSIDE-REQ');
    fs.mkdirSync(path.join(ws.cwd, '.kiro', 'specs'), { recursive: true });
    fs.symlinkSync(real, path.join(ws.cwd, '.kiro', 'specs', 'feat'));
    const r = await expandHashRefs('#spec:feat', { ws, steering: [] });
    assert.deepEqual(r.notices, []);
    assert.equal(r.blocks.length, 1);
    assert.ok(r.blocks[0]!.includes('INSIDE-REQ'));
    assert.ok(r.blocks[0]!.includes(path.join(ws.cwd, '.kiro', 'specs', 'feat', 'requirements.md')) || r.blocks[0]!.includes(req));
  });

  it('readTextForRef noFollow: a link is ELOOP, a directory or FIFO is EFTYPE; the default still follows links', () => {
    const ws = tmpWorkspace();
    const f = write(path.join(ws.cwd, 'a.md'), 'A');
    const l = path.join(ws.cwd, 'l.md');
    fs.symlinkSync(f, l);
    assert.throws(() => readTextForRef(l, 100, true), (e: NodeJS.ErrnoException) => e.code === 'ELOOP');
    assert.throws(() => readTextForRef(ws.cwd, 100, true), (e: NodeJS.ErrnoException) => e.code === 'EFTYPE' || e.code === 'EISDIR');
    assert.equal(readTextForRef(l).content, 'A');
    assert.equal(readTextForRef(f, 100, true).content, 'A');
  });
});
