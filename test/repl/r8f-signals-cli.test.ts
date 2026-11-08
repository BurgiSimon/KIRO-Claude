/**
 * Round-8 fix "signals-docs" #6, end to end (the built CLI over test/fixtures/fake-claude.mjs,
 * temp HOME / KIRO_HOME / CLAUDE_CONFIG_DIR / XDG dirs through the r5f signal helpers): from the
 * first SIGHUP / SIGTERM on, a SIGINT (`kill -INT`, a Ctrl+C in cooked mode) is a second signal
 * also in the main phase of the chat and of a headless run, where the front end holds SIGINT:
 * one 200 ms after it (inside the duplicate window) re-raises the first signal at once, and the
 * slow SessionEnd hook is cut short. It used to reach only the front end (the REPL's muted read,
 * headless's interrupt handler), and the close ran to its end. The front ends' own SIGINT
 * handling still runs and does no harm: nothing is printed after the first signal, and the
 * REPL's interrupt of its muted read sends no turn. Controls: a lone SIGTERM still waits for the close; after
 * `/quit` (the final close) a SIGINT after a SIGTERM re-raises at once, as before.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DUPLICATE_SIGNAL_WINDOW_MS } from '../../src/repl/exitSignals.js';
import { cli, mkRoot, sessionEndHook, sleep, waitFile, type Cli, type Exit, type Root } from '../headless/r5f-signals-helpers.js';
import { removeOnExit } from '../tmpdirs.js';

const skip = process.platform === 'win32' ? 'POSIX signals' : false;

const ANSWER = { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] };
const SLOW_TURN = { repeat: true, match: 'slow thing', steps: [{ text: 'WORKING' }, { sleepMs: 100_000 }] };

const clis: Cli[] = [];
afterEach(() => {
  for (const c of clis.splice(0)) c.dispose();
});

function root(script: unknown): { r: Root; started: string; done: string } {
  const r = mkRoot(script);
  removeOnExit(r.root);
  const started = path.join(r.root, 'end.started');
  const done = path.join(r.root, 'end.done');
  sessionEndHook(r, `cat > /dev/null; touch '${started}'; sleep 1.5; touch '${done}'`);
  return { r, started, done };
}

/** The prompts the fake claude got (its persisted transcripts under `home`'s CLAUDE_CONFIG_DIR). */
function promptsSent(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const o = JSON.parse(line) as { type?: string; isMeta?: boolean; localCommand?: boolean; message?: { content?: unknown } };
          if (o.type !== 'user' || o.isMeta || o.localCommand) continue;
          const c = o.message?.content;
          if (typeof c === 'string') out.push(c);
          else if (Array.isArray(c)) for (const b of c as { type?: string; text?: string }[]) if (b.type === 'text' && b.text) out.push(b.text);
        }
      }
    }
  };
  walk(path.join(home, '.claude', 'projects'));
  return out;
}

/** The documented rule: the SIGINT inside the window re-raises the first signal at once. */
function assertCutShort(first: NodeJS.Signals, e: Exit, ms: number, done: string, info: string): void {
  assert.equal(e.signal, first, info);
  assert.ok(!fs.existsSync(done), `the SIGINT did not cut the close short: the 1.5 s SessionEnd hook completed (died ${ms} ms after the ${first})\n${info}`);
  assert.ok(ms < 1000, `died ${ms} ms after the ${first}, not at once after the SIGINT\n${info}`);
}

for (const first of ['SIGHUP', 'SIGTERM'] as const) {
  test(`r8f #6: chat (piped) at its prompt: ${first}, then SIGINT 200 ms later re-raises the ${first} at once; nothing printed, nothing sent`, { skip, timeout: 60_000 }, async () => {
    const { r, started, done } = root({ turns: [ANSWER] });
    const c = cli(r, ['chat']);
    clis.push(c);
    await c.waitFor(/> $/);
    c.line('remember PELICAN');
    await c.waitFor(/ANSWER history=\[remember PELICAN\] END[\s\S]*> $/);
    assert.ok(200 < DUPLICATE_SIGNAL_WINDOW_MS);
    const at = c.o().length;
    const t0 = Date.now();
    c.kill(first);
    // (no input meanwhile: a line ends the muted read, and the REPL's final close holds SIGINT anyway)
    await sleep(200);
    c.kill('SIGINT');
    const e = await c.exit;
    const ms = Date.now() - t0;
    const info = `exit ${JSON.stringify(e)} after ${ms} ms; hook started ${fs.existsSync(started)}; locks ${JSON.stringify(r.locks())}\n${c.o()}`;
    assertCutShort(first, e, ms, done, info);
    assert.equal(c.o().slice(at), '', `printed after the ${first}:\n${info}`);
    // the REPL's own SIGINT handling (an interrupt of the muted read) started no turn: Claude Code
    // got the one prompt only
    await sleep(200);
    assert.deepEqual(promptsSent(r.home), ['remember PELICAN'], info);
  });

  test(`r8f #6: chat --no-interactive during the turn: ${first}, then SIGINT 200 ms later re-raises the ${first} at once; nothing printed`, { skip, timeout: 60_000 }, async () => {
    const { r, started, done } = root({ turns: [SLOW_TURN, ANSWER] });
    const c = cli(r, ['chat', '--no-interactive', '--trust-all-tools', 'run the slow thing'], { stdin: 'ignore' });
    clis.push(c);
    await c.waitFor(/WORKING/);
    await sleep(200);
    const at = c.o().length;
    const t0 = Date.now();
    c.kill(first);
    await sleep(200);
    c.kill('SIGINT');
    const e = await c.exit;
    const ms = Date.now() - t0;
    const info = `exit ${JSON.stringify(e)} after ${ms} ms; hook started ${fs.existsSync(started)}; locks ${JSON.stringify(r.locks())}\n${c.o()}`;
    assertCutShort(first, e, ms, done, info);
    assert.equal(c.o().slice(at), '', `printed after the ${first}:\n${info}`);
  });
}

test('r8f #6 control: a lone SIGTERM at the chat\'s prompt still waits for the close (the hook completes, no lock left)', { skip, timeout: 60_000 }, async () => {
  const { r, done } = root({ turns: [ANSWER] });
  const c = cli(r, ['chat']);
  clis.push(c);
  await c.waitFor(/> $/);
  c.line('remember PELICAN');
  await c.waitFor(/ANSWER history=\[remember PELICAN\] END[\s\S]*> $/);
  c.kill('SIGTERM');
  const e = await c.exit;
  assert.equal(e.signal, 'SIGTERM', `${JSON.stringify(e)}\n${c.o()}`);
  assert.ok(fs.existsSync(done), 'the SessionEnd hook was cut short');
  assert.deepEqual(r.locks(), []);
});

test('r8f #6 control: during the final close (after /quit) a SIGINT after a SIGTERM re-raises at once, as before', { skip, timeout: 60_000 }, async () => {
  const { r, started, done } = root({ turns: [ANSWER] });
  const c = cli(r, ['chat']);
  clis.push(c);
  await c.waitFor(/> $/);
  c.line('remember PELICAN');
  await c.waitFor(/ANSWER history=\[remember PELICAN\] END[\s\S]*> $/);
  c.line('/quit');
  await waitFile(started, `the SessionEnd hook never started\n${c.o()}`);
  const t0 = Date.now();
  c.kill('SIGTERM');
  await sleep(200);
  c.kill('SIGINT');
  const e = await c.exit;
  const ms = Date.now() - t0;
  assertCutShort('SIGTERM', e, ms, done, `exit ${JSON.stringify(e)} after ${ms} ms; locks ${JSON.stringify(r.locks())}\n${c.o()}`);
});
