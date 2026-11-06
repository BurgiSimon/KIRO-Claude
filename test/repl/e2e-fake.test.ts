/**
 * End to end: the real runRepl (session/kiroSession createSession, spec slash commands) driving
 * test/fixtures/fake-claude.mjs. No model, no real ~/.claude.
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
import { tempEnv } from './harness.js';

async function drive(script: unknown, lines: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; log: Record<string, unknown>[]; t: ReturnType<typeof tempEnv> }> {
  const t = tempEnv();
  const logFile = path.join(t.root, 'fake.log');
  const env = fakeEnv({
    ...t.env,
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script),
    FAKE_CLAUDE_LOG: logFile,
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    ...extraEnv,
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
  stdin.end(lines.map((l) => `${l}\n`).join(''));
  const code = await exit;
  const log = fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  return { code, out: stripAnsi(out), log, t };
}

test('e2e: chat turn with a tool approval through the real session and fake claude', { timeout: 60_000 }, async () => {
  const script = {
    turns: [
      {
        steps: [
          { text: 'Creating the file.' },
          { tool: { name: 'Bash', input: { command: 'touch made-by-test.txt', description: 'Create a file' } } },
          { text: 'Tool said: {{lastToolResult}}' },
        ],
      },
    ],
  };
  const { code, out, log, t } = await drive(script, ['make a file', 'y', '/quit']);
  try {
    assert.equal(code, 0, out);
    assert.ok(out.includes('> Creating the file.'), out);
    assert.ok(out.includes('🛠️  Using tool: shell'), out);
    assert.ok(out.includes("Allow this action? Use 't' to trust (always allow) this tool for the session. [y/n/t]:"), out);
    assert.ok(out.includes('Completed in'), out);
    assert.ok(out.includes('Tool said:'), out);
    assert.match(out, /To resume this session: kiro-claude chat --resume-id [0-9a-f-]{36}\n$/);
    const sent = log.filter((e) => e.event === 'stdin').map((e) => e.line as Record<string, unknown>);
    const answers = sent.filter((l) => l.type === 'control_response');
    assert.ok(answers.some((a) => JSON.stringify(a).includes('"behavior":"allow"')), JSON.stringify(answers));
  } finally {
    t.cleanup();
  }
});

test('e2e: n denies with Kiro text; unknown /x is not forwarded', { timeout: 60_000 }, async () => {
  const script = {
    turns: [{ steps: [{ tool: { name: 'Bash', input: { command: 'rm -rf build' } } }, { text: 'model saw: {{lastToolResult}}' }] }],
  };
  const { code, out, log, t } = await drive(script, ['/definitely-unknown', 'clean', 'n', '/quit']);
  try {
    assert.equal(code, 0, out);
    assert.ok(out.includes('Unknown command: /definitely-unknown'));
    assert.ok(out.includes('I deny this tool request. Ask a follow up question clarifying the expected action'), out);
    const users = log.filter((e) => e.event === 'stdin' && (e.line as { type?: string }).type === 'user');
    assert.equal(users.length, 1, 'only the real prompt reached claude');
    assert.ok(!JSON.stringify(users).includes('definitely-unknown'));
  } finally {
    t.cleanup();
  }
});

test('e2e: a free-text answer redirects once (sent by the session, not duplicated by the REPL)', { timeout: 60_000 }, async () => {
  const script = {
    turns: [
      { match: '^clean', steps: [{ tool: { name: 'Bash', input: { command: 'rm -rf build' } } }, { text: 'never reached' }] },
      { match: 'git clean', steps: [{ text: 'OK, using git clean.' }] },
    ],
  };
  const { code, out, log, t } = await drive(script, ['clean the build', 'use git clean instead', '/quit']);
  try {
    assert.equal(code, 0, out);
    assert.ok(out.includes('OK, using git clean.'), out);
    const users = log.filter((e) => e.event === 'stdin' && (e.line as { type?: string }).type === 'user');
    assert.equal(users.filter((u) => JSON.stringify(u).includes('use git clean instead')).length, 1, JSON.stringify(users));
  } finally {
    t.cleanup();
  }
});
