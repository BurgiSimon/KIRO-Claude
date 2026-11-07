/**
 * Round-5 fix "signals", the interactive chat (built CLI in line mode over
 * test/fixtures/fake-claude.mjs, temp HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs):
 *  - #6: a SIGINT after `/quit` while the final close runs its SessionEnd hook closes first (the
 *    hook completes, the resume hint is printed, the lock and the runtime dir are released), then
 *    kiro-claude dies of SIGINT, as with SIGTERM.
 *  - g2: from a fatal signal on, the REPL prints nothing of its own (no re-prompt, no turn error,
 *    no 'Failed to restart Claude Code: kiro-claude is exiting') and dispatches no input typed
 *    during the grace.
 *  - g1: the closing REPL's makeNewest rewrite of the user's record holds the record's lock.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, mkRoot, sessionEndHook, sleep, waitFile, type Cli, type Root } from '../headless/r5f-signals-helpers.js';

const ANSWER = { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] };

/** Every CLI child started here: SIGKILLed after each test should one still run (a failed test). */
const clis: Cli[] = [];
afterEach(() => {
  for (const c of clis.splice(0)) c.dispose();
});

async function chatWithConversation(r: Root, env: Record<string, string> = {}, nodeArgs: string[] = []): Promise<{ c: Cli; mainId: string }> {
  const c = cli(r, ['chat'], { env, nodeArgs });
  clis.push(c);
  await c.waitFor(/> $/);
  c.line('remember PELICAN');
  await c.waitFor(/ANSWER history=\[remember PELICAN\] END[\s\S]*> $/);
  const recs = r.records();
  assert.equal(recs.length, 1, recs.map((x) => x.sessionId).join(','));
  return { c, mainId: recs[0]!.sessionId };
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  test(`r5f #6: ${sig} after /quit while the SessionEnd hook runs: the hook completes, the resume hint is printed, nothing is left, then kiro-claude dies of ${sig}`, { timeout: 60_000 }, async () => {
    const r = mkRoot({ turns: [ANSWER] });
    try {
      const started = path.join(r.root, 'end.started');
      const done = path.join(r.root, 'end.done');
      sessionEndHook(r, `touch '${started}'; cat > /dev/null; sleep 1; touch '${done}'`);
      const { c } = await chatWithConversation(r);
      c.line('/quit');
      await waitFile(started, `the SessionEnd hook never started\n${c.o()}`);
      await sleep(200);
      c.kill(sig);
      const e = await c.exit;
      const info = `exit ${JSON.stringify(e)}; locks ${JSON.stringify(r.locks())}; runtime ${JSON.stringify(r.runtimeLeft())}\n${c.o()}`;
      assert.equal(e.signal, sig, info);
      assert.ok(fs.existsSync(done), `the SessionEnd hook did not complete\n${info}`);
      assert.match(c.o(), /To resume this session: kiro-claude chat --resume-id /, `no resume hint\n${info}`);
      assert.deepEqual(r.locks(), [], `lock left\n${info}`);
      assert.deepEqual(r.runtimeLeft(), [], `runtime dir left\n${info}`);
    } finally {
      r.cleanup();
    }
  });
}

test('r5f g2: after a SIGTERM during a turn the REPL prints nothing (no turn error, no re-prompt) and runs no input typed during the grace', { timeout: 60_000 }, async () => {
  const r = mkRoot({ turns: [{ repeat: true, match: 'slow', steps: [{ text: 'WORKING' }, { sleepMs: 60_000 }] }, ANSWER] });
  try {
    const endFile = path.join(r.root, 'ended.txt');
    // a slow SessionEnd hook: the grace lasts ~1 s, long enough to type during it
    sessionEndHook(r, `cat > /dev/null; sleep 1; echo end >> '${endFile}'`);
    const fakeLog = path.join(r.root, 'fake.log');
    const { c } = await chatWithConversation(r, { FAKE_CLAUDE_LOG: fakeLog });
    c.line('run the slow thing');
    await c.waitFor(/WORKING/);
    await sleep(200);
    const at = c.o().length;
    c.kill('SIGTERM');
    await sleep(300);
    c.line('typed during the grace');
    c.line('/chat save typed.json');
    const e = await c.exit;
    const after = c.o().slice(at);
    assert.equal(e.signal, 'SIGTERM', `exit ${JSON.stringify(e)}\n${c.o()}`);
    assert.equal(after, '', `printed after the signal:\n${JSON.stringify(after)}`);
    assert.equal(fs.readFileSync(endFile, 'utf8').trim(), 'end');
    assert.deepEqual(r.locks(), []);
    assert.equal(fs.existsSync(path.join(r.ws, 'typed.json')), false, 'a command typed during the grace ran');
    const sent = fs
      .readFileSync(fakeLog, 'utf8')
      .split('\n')
      .filter((l) => l.includes('typed during the grace'));
    assert.deepEqual(sent, [], 'input typed during the grace reached Claude Code');
    // the fake logs its own exit last: let it, so nothing is written into the root after cleanup
    for (let i = 0; i < 120 && !/"event":"exit"/.test(fs.readFileSync(fakeLog, 'utf8')); i++) await sleep(25);
  } finally {
    r.cleanup();
  }
});

const SLOW_TURN = { repeat: true, match: 'slow thing', steps: [{ text: 'WORKING' }, { sleepMs: 100_000 }] };
const IGNORE_INTERRUPT = { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }) };

// (guard: on the code before the fix the re-raise won the race against the refused restart's
// 'Failed to restart Claude Code: kiro-claude is exiting' here; the line is now dropped by
// construction: Repl.write() is silent after the signal and nothing typed after it is dispatched)
test('r5f g2: a SIGTERM right after a forced stop, with the next input typed before and after it, prints no restart failure', { timeout: 90_000 }, async () => {
  const r = mkRoot({ turns: [SLOW_TURN, ANSWER] });
  try {
    const started = path.join(r.root, 'end.started');
    // closes (the forced stop's, then the signal's of the restarted session) run this hook
    sessionEndHook(r, `touch '${started}'; cat > /dev/null; sleep 1.5`);
    const { c } = await chatWithConversation(r, IGNORE_INTERRUPT);
    clis.push(c);
    const mark = c.o().length;
    c.line('run the slow thing');
    await c.waitFor(/WORKING/, mark);
    await sleep(300);
    c.line('\u0003');
    await sleep(300);
    c.line('\u0003');
    await c.waitFor(/did not stop after the interrupt; stopping it\.[\s\S]*> $/, mark, 15_000);
    await waitFile(started, `the forced stop's SessionEnd hook never started\n${c.o()}`);
    c.line('next please');
    await sleep(300);
    const at = c.o().length;
    c.kill('SIGTERM');
    await sleep(100);
    c.line('and once more');
    const e = await c.exit;
    const after = c.o().slice(at);
    assert.equal(e.signal, 'SIGTERM', `exit ${JSON.stringify(e)}\n${c.o()}`);
    assert.doesNotMatch(after, /Failed to restart|exiting/, `printed after the signal:\n${JSON.stringify(after)}`);
    assert.equal(after, '', `printed after the signal:\n${JSON.stringify(after)}`);
    assert.deepEqual(r.locks(), []);
  } finally {
    r.cleanup();
  }
});

// ───────────────────────────── g1: makeNewest holds the record's lock ─────────────────────────────

/** Preload: log every SessionStore.write() with the pid in the record's lock file at that moment. */
const PRELOAD = `
import * as fs from 'node:fs';
import * as path from 'node:path';
const { SessionStore } = await import(process.env.R5F_STORE_URL);
const orig = SessionStore.prototype.write;
SessionStore.prototype.write = function (rec) {
  let lock = null;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(this.dir, rec.sessionId + '.lock'), 'utf8')).pid;
  } catch {}
  fs.appendFileSync(process.env.R5F_WRITE_LOG, JSON.stringify({ id: rec.sessionId, lock, self: process.pid }) + '\\n');
  return orig.call(this, rec);
};
`;

test('r5f g1: SIGTERM at a /spec checkpoint: the rewrite that makes the chat\'s record the newest holds its lock; nothing is left and `chat --resume` reaches the chat', { timeout: 120_000 }, async () => {
  const r = mkRoot({ turns: [{ repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTED-REQS' }] }, ANSWER] });
  try {
    const preload = path.join(r.root, 'preload.mjs');
    fs.writeFileSync(preload, PRELOAD);
    const log = path.join(r.root, 'writes.jsonl');
    const env = { R5F_STORE_URL: new URL('../../src/session/store.js', import.meta.url).href, R5F_WRITE_LOG: log };
    const { c, mainId } = await chatWithConversation(r, env, ['--import', preload]);
    const mark = c.o().length;
    c.line('/spec new my-feature --type feature --workflow requirements-first a csv export');
    await c.waitFor(/Stop here[\s\S]*> $/, mark);
    await sleep(200);
    const before = fs.readFileSync(log, 'utf8').length;
    c.kill('SIGTERM');
    const e = await c.exit;
    assert.equal(e.signal, 'SIGTERM', `exit ${JSON.stringify(e)}\n${c.o().slice(-600)}`);
    assert.deepEqual(r.locks(), []);
    const writes = fs
      .readFileSync(log, 'utf8')
      .slice(before)
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { id: string; lock: number | null; self: number });
    const mine = writes.filter((w) => w.id === mainId);
    assert.ok(mine.length >= 2, `expected the chat's close and the makeNewest rewrite: ${JSON.stringify(writes)}`);
    const last = mine[mine.length - 1]!;
    assert.equal(last.lock, last.self, `the last write of the chat's record did not hold its lock: ${JSON.stringify(writes)}`);
    // `chat --resume` reaches the user's conversation
    fs.rmSync(path.join(r.ws, '.kiro', 'hooks'), { recursive: true, force: true });
    const again = cli(r, ['chat', '--resume']);
    clis.push(again);
    again.line('which?');
    again.line('/quit');
    again.child.stdin!.end();
    const e2 = await again.exit;
    assert.equal(e2.code, 0, again.o());
    assert.match(again.o(), /ANSWER history=\[remember PELICAN \| which\?\] END/, again.o().slice(-800));
  } finally {
    r.cleanup();
  }
});
