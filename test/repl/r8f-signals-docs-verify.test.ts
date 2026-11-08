/**
 * Round-8 verification of the "signals-docs" fixes (#5, #6): what the README, docs/ARCHITECTURE.md
 * ("Fatal signals") and the exitSignals.ts module doc say about a Ctrl+C after a SIGHUP / SIGTERM.
 *
 * The fix makes a SIGINT after a SIGHUP / SIGTERM a second signal in every phase (ExitSignals holds
 * SIGINT from the first SIGHUP / SIGTERM on). The docs then said that in the interactive chat a
 * Ctrl+C is a key, not a signal, without saying where: the chat's input is in raw mode only from
 * its first prompt on, and not while a `!cmd` (or `$EDITOR`) holds the terminal. While the chat
 * is still starting (no line reader yet) and while a `!cmd` runs (cooked mode, kiro-claude's own
 * process group), a Ctrl+C is the terminal's SIGINT, which reaches kiro-claude too and ends it at
 * once (r8f-signals-docs-verify-pty.test.ts shows both over a real pty). The docs must name those
 * cases instead of saying a Ctrl+C in the interactive chat never is a signal.
 *
 * Reads README.md, docs/ and src/ from the repository root (tests run from there).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'repl', 'exitSignals.ts')) && fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

const ROOT = repoRoot();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Prose with line breaks (and a doc comment's ` * `) folded into spaces. */
const flat = (s: string): string => s.replace(/\n\s*\*(?!\/)/g, ' ').replace(/\s+/g, ' ');
const moduleDoc = (rel: string): string => {
  const src = read(rel);
  return flat(src.slice(0, src.indexOf('*/')));
};

/** The first bullet of ARCHITECTURE's "Fatal signals" section: which SIGINTs ExitSignals handles. */
function fatalSignalsFirstBullet(): string {
  const md = read('docs/ARCHITECTURE.md');
  const at = md.indexOf('### Fatal signals: close, then die of the signal');
  assert.ok(at >= 0, 'the "Fatal signals" section is gone');
  const from = md.indexOf('\n* ', at);
  const to = md.indexOf('\n* ', from + 3);
  return flat(md.slice(from, to));
}

test('r8f verify: README: a Ctrl+C while the chat is still starting or while a `!cmd` runs is a SIGINT (a second signal), a key only at the prompt and while the chat answers', () => {
  const readme = flat(read('README.md'));
  const at = readme.indexOf('A second signal ends it at once');
  assert.ok(at >= 0, 'README no longer has the second-signal sentence');
  const para = readme.slice(at, readme.indexOf('Details:', at));
  // the claim that was too broad: every Ctrl+C in the interactive chat is a key
  assert.doesNotMatch(para, /in the interactive chat that includes Ctrl\+C, which is a key there/, para);
  // where Ctrl+C is the terminal's SIGINT after all
  assert.match(para, /SIGINT \([^)]*`kill -INT`[^)]*still starting[^)]*`!cmd`[^)]*\) after a SIGHUP or SIGTERM is such a second signal/, para);
  // where it is a key
  assert.match(para, /prompt and while it answers[^.]*Ctrl\+C, which is a key there/, para);
});

test('r8f verify: ARCHITECTURE "Fatal signals": raw mode from the first prompt on; a Ctrl+C while the chat starts or while a `!cmd` / `$EDITOR` holds the terminal is a SIGINT', () => {
  const b = fatalSignalsFirstBullet();
  assert.doesNotMatch(b, /the chat's input stays in raw mode, during its final close/, `the old, too broad claim: ${b}`);
  assert.match(b, /raw mode from its first prompt on/, b);
  assert.match(b, /cooked mode[^.]*still starting[^.]*`!cmd` or `\$EDITOR`[^.]*process group/, b);
  // what the REPL's own SIGINT handler does during a turn, not only at a read
  assert.match(b, /ends its muted read or interrupts the turn being closed/, b);
});

test('r8f verify: exitSignals.ts module doc: the same cases', () => {
  const doc = moduleDoc('src/repl/exitSignals.ts');
  assert.match(doc, /raw mode from its first prompt on/, doc);
  assert.match(doc, /cooked mode \([^)]*still starting[^)]*`!cmd`[^)]*process group\)/, doc);
  assert.match(doc, /ends its muted read \([^)]*\) or interrupts the turn being closed/, doc);
});
