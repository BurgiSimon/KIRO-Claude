/**
 * Round-8 verification of the "signals-docs" fix #6 (the built CLI over test/fixtures/fake-claude.mjs,
 * temp HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs through the r5f signal helpers): a SIGINT
 * after a SIGHUP / SIGTERM now cuts the chat's close short in its main phase too, so the close
 * leaves its lock behind (and the SessionEnd hook is killed). The conversation is not lost by it:
 * the record a turn saved is still listed (only a chat that never had a message is dropped by the
 * session index), and `chat --resume` takes the stale lock over and continues the conversation.
 * The exitSignals.ts module doc says so (it said every record left behind is skipped).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, mkRoot, sessionEndHook, sleep, type Cli } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';

const skip = process.platform === 'win32' ? 'POSIX signals' : false;

const clis: Cli[] = [];
afterEach(() => {
  for (const c of clis.splice(0)) c.dispose();
});

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'repl', 'exitSignals.ts')) && fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

test('r8f verify: chat (piped): a SIGINT after a SIGTERM cuts the close short and leaves the lock; `chat --resume` takes it over and continues the conversation', { skip, timeout: 90_000 }, async () => {
  const r = mkRoot({ turns: [{ repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] }] });
  removeOnExit(r.root);
  const done = path.join(r.root, 'end.done');
  sessionEndHook(r, `cat > /dev/null; sleep 1.5; touch '${done}'`);
  const c = cli(r, ['chat']);
  clis.push(c);
  await c.waitFor(/> $/);
  c.line('remember PELICAN');
  await c.waitFor(/ANSWER history=\[remember PELICAN\] END[\s\S]*> $/);
  const ids = r.records().map((x) => x.sessionId);
  assert.equal(ids.length, 1, JSON.stringify(r.records()));
  c.kill('SIGTERM');
  await sleep(200);
  c.kill('SIGINT');
  const e = await c.exit;
  assert.equal(e.signal, 'SIGTERM', `${JSON.stringify(e)}\n${c.o()}`);
  assert.ok(!fs.existsSync(done), 'the close was not cut short (the SessionEnd hook completed)');
  // the close was cut short: its lock is left behind, by a process that is gone
  assert.deepEqual(r.locks(), [`${ids[0]}.lock`]);

  const again = cli(r, ['chat', '--resume']);
  clis.push(again);
  await again.waitFor(/> $/, 0, 30_000);
  again.line('and now?');
  // (the fake joins the conversation's user texts with ' | ')
  await again.waitFor(/ANSWER history=\[remember PELICAN \| and now\?\] END[\s\S]*> $/, 0, 30_000);
  assert.doesNotMatch(again.o(), /active in another process/, again.o());
  again.line('/quit');
  const e2 = await again.exit;
  assert.equal(e2.code, 0, again.o());
  assert.deepEqual(r.locks(), [], 'the resumed chat left a lock');
  assert.deepEqual(r.records().map((x) => x.sessionId), ids, 'the conversation was not continued in its own record');
});

test('r8f verify: exitSignals.ts module doc: only a chat that never had a message is dropped when left behind; a stale lock is taken over', () => {
  const src = fs.readFileSync(path.join(repoRoot(), 'src', 'repl', 'exitSignals.ts'), 'utf8');
  const doc = src.slice(0, src.indexOf('*/')).replace(/\n\s*\*(?!\/)/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(doc, /A record left anyway \([^)]*\) is skipped by the session index/, 'every record left behind is said to be skipped');
  assert.match(doc, /never had a message[^.]*left[^.]*session index/, doc);
  assert.match(doc, /stale lock is taken over/, doc);
});
