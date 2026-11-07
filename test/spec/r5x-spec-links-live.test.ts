/**
 * Review X1 (spec-links) end to end: the real runRepl (session/kiroSession over
 * test/fixtures/fake-claude.mjs) and `/spec`. A spec whose design.md is committed as a symbolic
 * link to ~/.bashrc and whose tasks.md links to a notes file outside the workspace:
 *  - `/spec view feat design` and `/spec status feat` never print the link target's text, and say why;
 *  - `/spec run feat --all` runs nothing (no task session: no new Claude process), does not
 *    repair or tick the outside notes file, and says why;
 *  - the REPL goes on (a later `/spec list` answers, with the phase `refused`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { liveRepl } from './liveRepl.js';
import { DESIGN_MD, REQ_MD } from './helpers.js';

const SECRET = 'KC-LIVE-SECRET-91c2';
const NOTES = `# notes ${SECRET}\n\n* [ ] 1. Outside task\n  * [ ] 1.1 Sub task\n`;

test('/spec view, status, run and list in the live REPL: linked documents are neither printed nor written', { timeout: 120_000 }, async () => {
  let bashrc = '';
  let notes = '';
  const r = liveRepl({ turns: [{ repeat: true, steps: [{ text: 'ANSWER' }] }] }, {
    before: (t) => {
      const dir = path.join(t.wsDir, '.kiro', 'specs', 'feat');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'requirements.md'), REQ_MD);
      bashrc = path.join(t.home, '.bashrc');
      fs.writeFileSync(bashrc, `${DESIGN_MD}\n${SECRET}\n`);
      fs.symlinkSync(bashrc, path.join(dir, 'design.md'));
      notes = path.join(t.root, 'notes.md');
      fs.writeFileSync(notes, NOTES);
      fs.symlinkSync(notes, path.join(dir, 'tasks.md'));
    },
  });
  try {
    await r.waitFor(/> $/);
    const view = await r.send('/spec view feat design', /symbolic link[\s\S]*> $/);
    assert.match(view, /design\.md is a symbolic link: kiro-claude reads and writes spec documents only as regular files inside the workspace/);
    const status = await r.send('/spec status feat', /Phase:[\s\S]*> $/);
    assert.match(status, /design\.md\s+⚠/);
    const starts = r.starts();
    const run = await r.send('/spec run feat --all', /cannot run[\s\S]*> $/);
    assert.match(run, /Spec 'feat' cannot run: .*(design|tasks)\.md is a symbolic link/);
    assert.equal(r.starts(), starts, 'a task session (a Claude process) was started');
    const list = await r.send('/spec list', /feat[\s\S]*> $/);
    assert.match(list, /feat\s+feature\s+refused\s+-/);
    assert.ok(!r.o().includes(SECRET), 'the link target was printed');
    assert.equal(fs.readFileSync(notes, 'utf8'), NOTES, 'the outside notes file was repaired or ticked');
    assert.equal(fs.readFileSync(bashrc, 'utf8'), `${DESIGN_MD}\n${SECRET}\n`);
  } finally {
    await r.close();
  }
});
