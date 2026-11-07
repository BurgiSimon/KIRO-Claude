/**
 * Round-5 fix "signals", `chat --no-interactive` (built CLI over test/fixtures/fake-claude.mjs,
 * temp HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs):
 *  - #5: a SIGTERM while the end-of-run SessionEnd hook runs (the front end's own close had begun)
 *    no longer sweeps the tracked children: the hook finishes inside the grace, nothing more is
 *    printed (a failure notice of a hook that ends during the grace is dropped too, text and
 *    stream-json), kiro-claude dies of SIGTERM.
 *  - #6: a SIGINT (a terminal Ctrl+C) in the same window closes first like SIGTERM: the lock and
 *    the runtime dir are released, the hook completes, then kiro-claude dies of SIGINT.
 *  - g3: with `installSignalHandlers: false` (an embedder) a SIGTERM during the turn is the
 *    lifecycle forwarder's (dyingSignal()): the turn's error is not printed.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, mkRoot, sessionEndHook, sleep, waitFile, type Cli } from './r5f-signals-helpers.js';

const ANSWER = { turns: [{ repeat: true, steps: [{ text: 'THE-ANSWER' }] }] };

/** Every CLI child started here: SIGKILLed after each test should one still run (a failed test). */
const clis: Cli[] = [];
afterEach(() => {
  for (const c of clis.splice(0)) c.dispose();
});

/** After the answer, wait for the SessionEnd hook of the final close to start, plus `ms`. */
async function duringFinalClose(c: Cli, started: string, ms: number): Promise<{ out: number; err: number }> {
  await waitFile(started, `the SessionEnd hook never started\n${c.o()}`);
  await sleep(ms);
  assert.match(c.out(), /THE-ANSWER/);
  return { out: c.out().length, err: c.err().length };
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  test(`r5f #5/#6: ${sig} while the end-of-run SessionEnd hook runs lets the hook finish, prints nothing more, releases the lock and the runtime dir, then dies of ${sig}`, { timeout: 60_000 }, async () => {
    const r = mkRoot(ANSWER);
    try {
      const started = path.join(r.root, 'end.started');
      const done = path.join(r.root, 'end.done');
      sessionEndHook(r, `touch '${started}'; cat > /dev/null; sleep 1; touch '${done}'`);
      const c = cli(r, ['chat', '--no-interactive', 'a question'], { stdin: 'ignore' });
      clis.push(c);
      const at = await duringFinalClose(c, started, 150);
      const t0 = Date.now();
      c.kill(sig);
      const e = await c.exit;
      const ms = Date.now() - t0;
      const info = `exit ${JSON.stringify(e)} after ${ms} ms\n${c.o()}`;
      assert.equal(e.signal, sig, info);
      assert.ok(ms < 3000, info);
      assert.equal(c.out().slice(at.out), '', `stdout after the signal\n${info}`);
      assert.equal(c.err().slice(at.err), '', `stderr after the signal\n${info}`);
      assert.ok(fs.existsSync(done), `the SessionEnd hook was killed (kiro-claude died ${ms} ms after the signal, inside the grace)`);
      assert.deepEqual(r.locks(), [], `lock left\n${info}`);
      assert.deepEqual(r.runtimeLeft(), [], `runtime dir left\n${info}`);
    } finally {
      r.cleanup();
    }
  });
}

for (const format of ['text', 'stream-json'] as const) {
  test(`r5f #5: a SessionEnd hook failing during the grace of a SIGTERM prints no failure notice (${format})`, { timeout: 60_000 }, async () => {
    const r = mkRoot(ANSWER);
    try {
      const started = path.join(r.root, 'end.started');
      sessionEndHook(r, `touch '${started}'; cat > /dev/null; sleep 0.6; echo boom >&2; exit 3`);
      const args = ['chat', '--no-interactive', ...(format === 'stream-json' ? ['--output-format', 'stream-json'] : []), 'a question'];
      const c = cli(r, args, { stdin: 'ignore' });
      clis.push(c);
      const at = await duringFinalClose(c, started, 150);
      c.kill('SIGTERM');
      const e = await c.exit;
      const info = `exit ${JSON.stringify(e)}\n${c.o()}`;
      assert.equal(e.signal, 'SIGTERM', info);
      assert.equal(c.out().slice(at.out), '', `stdout after the signal\n${info}`);
      assert.equal(c.err().slice(at.err), '', `stderr after the signal\n${info}`);
      assert.deepEqual(r.locks(), [], info);
    } finally {
      r.cleanup();
    }
  });
}

test('r5f #5: a SIGTERM during the turn still ends the running children and closes (no regression)', { timeout: 60_000 }, async () => {
  const r = mkRoot({ turns: [{ steps: [{ text: 'partial ' }, { sleepMs: 60_000 }, { text: 'never' }] }] });
  try {
    const endFile = path.join(r.root, 'ended.txt');
    sessionEndHook(r, `cat > /dev/null; echo end >> '${endFile}'`);
    const c = cli(r, ['chat', '--no-interactive', 'a question'], { stdin: 'ignore' });
      clis.push(c);
    await c.waitFor(/partial/);
    await sleep(200);
    const at = c.o().length;
    const t0 = Date.now();
    c.kill('SIGTERM');
    const e = await c.exit;
    assert.equal(e.signal, 'SIGTERM', c.o());
    assert.ok(Date.now() - t0 < 4000);
    assert.equal(c.o().slice(at), '', 'printed after the signal');
    assert.deepEqual(r.locks(), []);
    assert.equal(fs.existsSync(endFile) ? fs.readFileSync(endFile, 'utf8').trim() : '', 'end');
  } finally {
    r.cleanup();
  }
});

// ───────────────────────────── g3: lifecycle-owned shutdown (dyingSignal) ─────────────────────────────

const BUILD_ROOT = new URL('../../', import.meta.url).href;

/** `chat` run in-process by a child script, with the front ends' signal handling switched off. */
const EMBEDDER = `
const B = process.argv[2];
const { createCliContext } = await import(B + 'src/cli/main.js');
const { runChatCommand } = await import(B + 'src/cli/commands/chat.js');
const { runHeadless } = await import(B + 'src/headless/run.js');
const { runReplWith } = await import(B + 'src/repl/core.js');
const { createSession } = await import(B + 'src/session/kiroSession.js');
const ctx = createCliContext({ cwd: process.cwd() }, 0);
const code = await runChatCommand(process.argv.slice(3), ctx, {
  runHeadless: (o) => runHeadless({ ...o, installSignalHandlers: false }),
  runRepl: (o) => runReplWith(o, { createSession, installSignalHandlers: false }),
});
process.exitCode = code;
`;

for (const front of ['headless', 'repl'] as const) {
  test(`r5f g3: ${front}, no front-end signal handling: a SIGTERM the lifecycle forwarder owns ends the turn without printing its error`, { timeout: 60_000 }, async () => {
    // a PreToolUse hook that ignores SIGTERM keeps the forwarder waiting (≤ its 1 s grace) after
    // Claude Code died of the signal: the turn's error reaches the front end meanwhile
    const r = mkRoot({ turns: [{ steps: [{ text: 'partial ' }, { tool: { name: 'Bash', input: { command: 'ls' }, permission: 'allow' } }, { text: 'never' }] }] });
    try {
      const started = path.join(r.root, 'pre.started');
      fs.writeFileSync(
        path.join(r.ws, '.kiro', 'hooks', 'pre.json'),
        JSON.stringify({ version: 'v1', hooks: [{ name: 'pre', trigger: 'PreToolUse', timeout: 0, action: { type: 'command', command: `trap '' TERM; touch '${started}'; sleep 5` } }] }),
      );
      const script = path.join(r.root, 'embedder.mjs');
      fs.writeFileSync(script, EMBEDDER);
      const args = front === 'headless' ? ['--no-interactive', '--trust-all-tools', 'a question'] : ['--trust-all-tools'];
      const c = cli(r, [BUILD_ROOT, ...args], { script });
      clis.push(c);
      if (front === 'repl') {
        await c.waitFor(/> $/);
        c.line('a question');
      }
      await waitFile(started, `the PreToolUse hook never started\n${c.o()}`);
      await sleep(200);
      const at = c.o().length;
      c.kill('SIGTERM');
      const e = await c.exit;
      const after = c.o().slice(at);
      assert.equal(e.signal, 'SIGTERM', `exit ${JSON.stringify(e)}\n${c.o()}`);
      assert.equal(after.trim(), '', `printed while dying of the forwarded signal:\n${JSON.stringify(after)}`);
    } finally {
      r.cleanup();
    }
  });
}
