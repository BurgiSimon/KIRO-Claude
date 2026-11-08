/**
 * Round 7, finding #6 (spec): the reasons kiro-claude's own spec I/O gives for a spec file or
 * folder the user cannot access (policy/specwrite.deniedWhy: `<p> cannot be accessed (permission
 * denied)`, or `<p>: <folder> cannot be accessed (permission denied)` for a folder above it) get
 * the access advice (docfs.SPEC_ACCESS_RULE), never the replace/move advice of a link problem; a
 * link whose target is behind a folder the user cannot enter keeps its own reason and advice
 * (r6 #7). The real-permission cases are in test/spec/r7f-spec-access.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { deniedWhy, isAccessRefusal, isLinkAccessRefusal, specFileRefusal, specFolderRefusal } from '../../src/policy/specwrite.js';
import { SPEC_ACCESS_RULE, SPEC_LINK_ACCESS_RULE, SPEC_LINK_RULE, specRefusalText } from '../../src/spec/docfs.js';

test('an access reason gets the access advice; a link-access reason and the link reasons keep theirs (also with a newline in a path)', () => {
  for (const base of ['/w/proj', '/w/my\nproj']) {
    const doc = `${base}/.kiro/specs/feat/requirements.md`;
    const own = deniedWhy(doc);
    const above = `${doc}: ${deniedWhy(`${base}/.kiro/specs`)}`;
    for (const why of [own, above]) {
      assert.ok(isAccessRefusal(why), JSON.stringify(why));
      assert.ok(!isLinkAccessRefusal(why), JSON.stringify(why));
      assert.equal(specRefusalText(why), `${why}: ${SPEC_ACCESS_RULE}`);
    }
    const link = `${base}/.kiro/specs/feat`;
    const linkAccess = `${link}: the target of the symbolic link ${link} cannot be accessed (permission denied)`;
    assert.ok(isLinkAccessRefusal(linkAccess));
    assert.ok(!isAccessRefusal(linkAccess));
    assert.equal(specRefusalText(linkAccess), `${linkAccess}: ${SPEC_LINK_ACCESS_RULE}`);
    for (const why of [`${doc} is a symbolic link`, `${link}: the symbolic link ${link} resolves to nothing (dangling, or a loop)`, `${doc} is outside the workspace ${base}`]) {
      assert.ok(!isAccessRefusal(why), why);
      assert.equal(specRefusalText(why), `${why}: ${SPEC_LINK_RULE}`);
    }
  }
  assert.equal(deniedWhy('/x/a.md'), '/x/a.md cannot be accessed (permission denied)');
  assert.doesNotMatch(SPEC_ACCESS_RULE, /replace it with a regular file|move the spec folder/);
});

test('readable files and folders are not refused (also a missing document and a missing feature folder)', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r7f-words-')));
  try {
    const dir = path.join(root, '.kiro', 'specs', 'feat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'requirements.md'), '# R\n');
    assert.equal(specFolderRefusal(dir, root), undefined);
    assert.equal(specFolderRefusal(path.join(root, '.kiro', 'specs'), root), undefined);
    assert.equal(specFolderRefusal(path.join(root, '.kiro', 'specs', 'missing'), root), undefined);
    assert.equal(specFileRefusal(path.join(dir, 'requirements.md'), root), undefined);
    assert.equal(specFileRefusal(path.join(dir, 'design.md'), root), undefined);
    assert.equal(specFileRefusal(path.join(root, '.kiro', 'specs', 'missing', 'design.md'), root), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
