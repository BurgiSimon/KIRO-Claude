/**
 * Verifier guard for K1 through the REPL: the continuation a /spec flow hands to the chat carries
 * main's conversation. When its first prompt hangs and the second Ctrl+C stops Claude Code (the
 * forced stop), the REPL re-creates the stopped session from its record: the record must still
 * be there (it was dropped as an untouched copy of its parent), or the chat restarts empty.
 * Real runRepl + session over test/fixtures/fake-claude.mjs; no real ~/.kiro or ~/.claude.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import { openSettings } from '../../src/config/settings.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { runRepl } from '../../src/repl/repl.js';
import type { CliContext } from '../../src/types.js';
import { stripAnsi } from '../../src/util/ansi.js';
import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';
import { tempEnv } from '../repl/harness.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SCRIPT = {
  turns: [
    { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTED' }] },
    { repeat: true, match: 'slow thing', steps: [{ text: 'working' }, { sleepMs: 100_000 }] },
  ],
  default: { steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
};

test('K1 (verifier): a forced stop of the first prompt in the continuation a /spec flow handed over keeps main\'s conversation in the chat', { timeout: 90_000 }, async () => {
  const t = tempEnv();
  const run = path.join(t.root, 'run');
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  const kiroHome = path.join(t.home, '.kiro');
  fs.mkdirSync(kiroHome, { recursive: true });
  const env = fakeEnv({
    ...t.env,
    KIRO_HOME: kiroHome,
    XDG_RUNTIME_DIR: run,
    XDG_CACHE_HOME: path.join(t.root, 'cache'),
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT),
    FAKE_CLAUDE_LOG: path.join(t.root, 'fake.log'),
    FAKE_CLAUDE_PERSIST: '1',
    // Claude Code does not stop after the interrupt: the second press stops it
    FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ interrupt: 120_000 }),
    KIRO_CLAUDE_BIN: fakeClaudePath(),
  });
  const ws = createWorkspaceContext(t.wsDir, env);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  stdout.on('data', (d: Buffer) => (out += d.toString()));
  const ctx: CliContext = {
    ws,
    settings: openSettings(ws),
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    progName: 'kiro-claude',
    verbosity: 0,
  };
  const exit = runRepl({ ctx, sessionOptions: { env, claudePath: fakeClaudePath() } });
  const o = (): string => stripAnsi(out);
  const waitFor = async (re: RegExp, from = 0, ms = 20_000): Promise<void> => {
    const t0 = Date.now();
    while (!re.test(o().slice(from))) {
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}\n--- out:\n${o()}`);
      await sleep(25);
    }
  };
  const line = (s: string): boolean => stdin.write(`${s}\n`);
  try {
    await waitFor(/> $/);
    line('remember CODEWORD_1');
    await waitFor(/ANSWER history=\[remember CODEWORD_1\] END[\s\S]*> $/);
    let mark = o().length;
    line('/spec new first-spec --type feature --workflow requirements-first a csv export');
    await waitFor(/Stop here/, mark);
    line('Stop');
    await waitFor(/Stopped at the requirements\.md checkpoint[\s\S]*> $/, mark);
    mark = o().length;
    line('run the slow thing');
    await waitFor(/working/, mark);
    await sleep(300);
    stdin.write('\u0003\n');
    await sleep(500);
    stdin.write('\u0003\n');
    await waitFor(/Claude Code did not stop after the interrupt; stopping it\.[\s\S]*> $/, mark, 20_000);
    mark = o().length;
    line('which code word?');
    await waitFor(/ANSWER history=\[[\s\S]*?\] END[\s\S]*> $/, mark, 20_000);
    const h = /ANSWER history=\[([\s\S]*?)\] END/.exec(o().slice(mark))![1]!;
    assert.match(h, /^remember CODEWORD_1 \| /, `the chat restarted without main's conversation: ${h.slice(0, 300)}`);
    assert.match(h, /which code word\?$/);
    line('/quit');
    assert.equal(await exit, 0);
  } finally {
    stdin.end();
    await exit.catch(() => undefined);
    t.cleanup();
  }
});
