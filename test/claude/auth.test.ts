import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
  extractJsonObject,
  getAuthStatus,
  isAuthError,
  parseAuthJson,
  parseAuthText,
  runAuthCommand,
} from '../../src/claude/auth.js';
import { ClaudeNotFoundError } from '../../src/claude/binary.js';
import { fakeBinary, fakeEnv, mkTmp, readJsonl } from './helpers.js';

describe('getAuthStatus (fake-claude)', () => {
  it('logged in', async () => {
    const s = await getAuthStatus(fakeBinary(), fakeEnv());
    assert.equal(s.loggedIn, true);
    assert.equal(s.authMethod, 'claude.ai');
    assert.equal(s.apiProvider, 'firstParty');
    assert.deepEqual(s.raw, { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' });
  });

  it('logged out (non-zero exit) does not throw', async () => {
    const s = await getAuthStatus(fakeBinary(), fakeEnv({ FAKE_CLAUDE_LOGGED_OUT: '1' }));
    assert.equal(s.loggedIn, false);
    assert.equal(s.authMethod, 'none');
  });

  it('invokes `auth status --json`', async () => {
    const log = path.join(mkTmp(), 'log.jsonl');
    await getAuthStatus(fakeBinary(), fakeEnv({ FAKE_CLAUDE_LOG: log }));
    const start = readJsonl(log).find((e) => e.event === 'start');
    assert.deepEqual(start?.argv, ['auth', 'status', '--json']);
  });

  it('defaults to the scrubbed child env', async () => {
    const log = path.join(mkTmp(), 'log.jsonl');
    const saved = { ...process.env };
    process.env.FAKE_CLAUDE_LOG = log;
    process.env.CLAUDECODE = '1';
    try {
      await getAuthStatus(fakeBinary());
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    const start = readJsonl(log).find((e) => e.event === 'start') as { env: Record<string, string> };
    assert.equal(start.env.CLAUDECODE, undefined);
    assert.equal(start.env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
  });

  it('falls back to text when --json is rejected', async () => {
    const dir = mkTmp();
    const old = path.join(dir, 'old-claude.mjs');
    fs.writeFileSync(
      old,
      [
        "const a = process.argv.slice(2);",
        "if (a.includes('--json')) { console.error(\"error: unknown option '--json'\"); process.exit(1); }",
        "console.log('Login method: Claude Pro account');",
        "console.log('Email: me@example.com');",
      ].join('\n'),
    );
    const s = await getAuthStatus({ path: old, version: '1.0.0', rawVersion: '1.0.0' }, fakeEnv());
    assert.equal(s.loggedIn, true);
    assert.equal(s.authMethod, 'Claude Pro account');
    assert.equal(s.email, 'me@example.com');
    assert.equal(s.raw, undefined);
  });

  it('parses plain text output when JSON is absent', async () => {
    const dir = mkTmp();
    const t = path.join(dir, 'text-claude.mjs');
    fs.writeFileSync(t, "console.log('Not logged in. Run claude auth login.'); process.exit(1);\n");
    const s = await getAuthStatus({ path: t, version: '1.0.0', rawVersion: '' }, fakeEnv());
    assert.equal(s.loggedIn, false);
    assert.match(s.text ?? '', /Not logged in/);
  });

  it('throws ClaudeNotFoundError when the binary cannot run', async () => {
    await assert.rejects(getAuthStatus({ path: '/nonexistent/claude', version: '0', rawVersion: '' }, {}), ClaudeNotFoundError);
  });
});

describe('runAuthCommand', () => {
  it('returns the exit code', async () => {
    const quiet = fakeEnv({ FAKE_CLAUDE_AUTH_EXIT: '0' });
    // stdio is inherited: the fake writes one line to stderr, which is fine in test output.
    assert.equal(await runAuthCommand(fakeBinary(), 'login', ['--claudeai'], quiet), 0);
    assert.equal(await runAuthCommand(fakeBinary(), 'logout', [], fakeEnv({ FAKE_CLAUDE_AUTH_EXIT: '3' })), 3);
  });
  it('passes the subcommand and args', async () => {
    const log = path.join(mkTmp(), 'log.jsonl');
    await runAuthCommand(fakeBinary(), 'login', ['--email', 'a@b.c'], fakeEnv({ FAKE_CLAUDE_LOG: log }));
    assert.deepEqual(readJsonl(log).find((e) => e.event === 'start')?.argv, ['auth', 'login', '--email', 'a@b.c']);
  });
  it('rejects when the binary is missing', async () => {
    await assert.rejects(runAuthCommand({ path: '/nonexistent/claude', version: '0', rawVersion: '' }, 'logout', [], {}), ClaudeNotFoundError);
  });
});

describe('parseAuthJson / parseAuthText / extractJsonObject', () => {
  it('maps the real 2.1.318 shape', () => {
    const s = parseAuthJson({
      loggedIn: true,
      authMethod: 'oauth_token',
      apiProvider: 'firstParty',
      analyticsDisabled: false,
      projectsDirectory: '/root/.claude/projects',
    });
    assert.equal(s.loggedIn, true);
    assert.equal(s.authMethod, 'oauth_token');
    assert.equal(s.apiProvider, 'firstParty');
    assert.equal(s.email, undefined);
  });
  it('reads nested account fields and treats missing loggedIn as false', () => {
    const s = parseAuthJson({ account: { email: 'x@y.z', subscriptionType: 'max' } });
    assert.equal(s.loggedIn, false);
    assert.equal(s.email, 'x@y.z');
    assert.equal(s.subscriptionType, 'max');
  });
  it('extracts JSON surrounded by noise', () => {
    assert.deepEqual(extractJsonObject('Warning: x\n{"loggedIn":true}\n'), { loggedIn: true });
    assert.equal(extractJsonObject('nope'), undefined);
    assert.equal(extractJsonObject('[1,2]'), undefined);
  });
  it('text parse needs a positive marker and exit 0', () => {
    assert.equal(parseAuthText('Login method: Claude API account\nProxy: x', 0).loggedIn, true);
    assert.equal(parseAuthText('Login method: Claude API account', 1).loggedIn, false);
    assert.equal(parseAuthText('', 0).loggedIn, false);
    assert.equal(parseAuthText('You are not logged in', 0).loggedIn, false);
  });
});

describe('isAuthError (00 §2.1)', () => {
  it('assistant authentication_failed', () => {
    assert.equal(isAuthError({ type: 'assistant', error: 'authentication_failed', message: { content: [] } }), true);
    assert.equal(isAuthError({ type: 'assistant', error: 'rate_limit', message: { content: [] } }), false);
    assert.equal(isAuthError({ type: 'assistant', message: { content: [] } }), false);
  });
  it('result is_error with login text', () => {
    assert.equal(isAuthError({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }), true);
    assert.equal(isAuthError({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth token revoked' }), true);
    assert.equal(isAuthError({ type: 'result', is_error: true, result: 'Invalid API key · Fix external API key' }), true);
    assert.equal(isAuthError({ type: 'result', is_error: false, result: 'Please run /login' }), false);
    assert.equal(isAuthError({ type: 'result', is_error: true, result: 'Reached maximum number of turns' }), false);
  });
  it('plain text', () => {
    assert.equal(isAuthError('Please run /login'), true);
    assert.equal(isAuthError('all good'), false);
  });
  it('other values', () => {
    assert.equal(isAuthError(null), false);
    assert.equal(isAuthError(42), false);
    assert.equal(isAuthError({ type: 'system', subtype: 'init' }), false);
  });
});
