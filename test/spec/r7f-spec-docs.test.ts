/**
 * Round 7, finding #10 (docs) and the docs of #6, #7, #8: README.md promised the reason
 * `cannot be accessed (permission denied)` for a spec folder link "into a folder you cannot
 * enter", which the code gave only for a link whose target is BEHIND such a folder. After #6 the
 * code refuses both that link and a folder or document that itself cannot be read; README.md and
 * docs/ARCHITECTURE.md now say exactly that, and what a named spec under a refused `.kiro/specs`
 * prints (#7) and what the spec CLI's resume hints name (#8). Reads the files from the repository
 * root (tests run from there).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { SPEC_ACCESS_RULE } from '../../src/spec/docfs.js';

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'spec', 'docfs.ts')) && fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

const ROOT = repoRoot();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = (s: string): string => s.replace(/\s+/g, ' ');

/** The text under `heading` up to the next heading of that level or higher. */
function section(md: string, heading: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l === heading);
  assert.ok(start >= 0, `heading ${JSON.stringify(heading)} not found`);
  const level = /^#+/.exec(heading)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return flat(lines.slice(start, end).join('\n'));
}

test('README §Specs: the access reason is promised for a link behind a folder you cannot enter and for a folder or document you cannot read', () => {
  const s = section(read('README.md'), '## Specs');
  assert.doesNotMatch(s, /into a folder you cannot enter: the reason then says/, 'the old, too broad promise is still there');
  assert.match(s, /whose target is behind a folder you cannot enter/);
  assert.match(s, /a spec document you cannot read \(whatever its size\)/);
  assert.match(s, /a feature folder or `\.kiro\/specs` you cannot enter, also one a link points at/);
  assert.match(s, /never takes them for missing ones/);
  assert.match(s, /the reason says `cannot be accessed \(permission denied\)`/);
  assert.match(s, /`\.kiro\/specs` you may enter but not read/);
  assert.match(s, /not "not found"/);
  assert.match(s, /`kiro-claude spec` names its own commands/);
});

test('ARCHITECTURE §Specs: the symbolic-link bullet covers unreadable documents and folders, named specs under a refused .kiro/specs, and the resume hints', () => {
  const s = section(read('docs/ARCHITECTURE.md'), '## Specs');
  assert.match(s, /a document the user cannot read \(whatever its size: every document is checked\)/);
  assert.match(s, /a feature folder or `\.kiro\/specs` the user cannot enter \(also one a link points at, or one under such a folder\)/);
  assert.match(s, /`<p> cannot be accessed \(permission denied\)`/);
  assert.ok(s.includes(SPEC_ACCESS_RULE), 'the access advice is not quoted');
  assert.match(s, /a `\.kiro\/specs` the user may enter but not read/);
  assert.match(s, /instead of "not found … Create it with … new"/);
  assert.match(s, /SpecRuntime\.resumeHint/);
  assert.match(s, /`kiro-claude spec approve <name> · kiro-claude spec revise <name> <feedback>`/);
  assert.match(s, /`#spec:<name>` gives the same reasons/);
});
