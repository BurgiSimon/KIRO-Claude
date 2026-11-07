/**
 * Review X1 verifier, end to end (the real runRepl over test/fixtures/fake-claude.mjs): a spec
 * whose requirements.md is committed as a link to ~/.bashrc while design.md is a regular file.
 * `/spec feat` stops at the design checkpoint; before the fix it said nothing about
 * requirements.md and offered "Approve and continue to tasks", whose tasks phase has the model
 * read requirements.md through the link. Now the checkpoint names the reason, offers no Approve,
 * no phase Claude process starts, and neither file changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { liveRepl } from './liveRepl.js';
import { DESIGN_MD, REQ_MD } from './helpers.js';

const SECRET = 'KC-LIVE-VERIFY-SECRET-0b7a';

test('/spec <name> in the live REPL: a refused requirements.md is named at the design checkpoint, which offers no Approve', { timeout: 120_000 }, async () => {
  let bashrc = '';
  let dir = '';
  const r = liveRepl({ turns: [{ repeat: true, steps: [{ text: 'ANSWER' }] }] }, {
    before: (t) => {
      dir = path.join(t.wsDir, '.kiro', 'specs', 'feat');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'design.md'), DESIGN_MD);
      bashrc = path.join(t.home, '.bashrc');
      fs.writeFileSync(bashrc, `${REQ_MD}\n${SECRET}\n`);
      fs.symlinkSync(bashrc, path.join(dir, 'requirements.md'));
    },
  });
  try {
    await r.waitFor(/> $/);
    const starts = r.starts();
    const cp = await r.send('/spec feat', /Stop here[\s\S]*> $/);
    assert.match(cp, /requirements\.md is a symbolic link: kiro-claude reads and writes spec documents only as regular files/);
    assert.doesNotMatch(cp, /Approve/, 'Approve was offered');
    const k = /(\d+)\. Stop here/.exec(cp)![1]!;
    await r.send(k, /> $/);
    assert.equal(r.starts(), starts, 'a phase session (a Claude process) was started');
    assert.equal(fs.existsSync(path.join(dir, 'tasks.md')), false);
    assert.ok(!r.o().includes(SECRET), 'the link target was printed');
    assert.equal(fs.readFileSync(bashrc, 'utf8'), `${REQ_MD}\n${SECRET}\n`);
  } finally {
    await r.close();
  }
});
