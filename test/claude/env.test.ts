import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  API_KEY_VARS,
  SESSION_VARS,
  apiKeyOverrides,
  buildChildEnv,
  isScrubbedSessionVar,
} from '../../src/claude/env.js';

describe('buildChildEnv (00 §3.2)', () => {
  it('removes every exact session variable', () => {
    const parent: NodeJS.ProcessEnv = { PATH: '/bin' };
    for (const v of SESSION_VARS) parent[v] = 'x';
    const env = buildChildEnv(parent, { platform: 'linux' });
    for (const v of SESSION_VARS) {
      if (v === 'CLAUDE_CODE_ENTRYPOINT') continue; // re-set to sdk-ts
      assert.equal(env[v], undefined, v);
    }
    assert.equal(env.PATH, '/bin');
  });

  it('contains exactly the documented exact-name list', () => {
    assert.deepEqual([...SESSION_VARS].sort(), [
      'AI_AGENT',
      'CLAUDECODE',
      'CLAUDE_AFTER_LAST_COMPACT',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_DIAGNOSTICS_FILE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_MESSAGING_SOCKET',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_CODE_SESSION_ATTENDED',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_SSE_PORT',
      'CLAUDE_CODE_TEE_SDK_STDOUT',
      'CLAUDE_EFFORT',
      'CLAUDE_ENV_FILE',
      'CLAUDE_PID',
      'CLAUDE_PROJECT_DIR',
      'DEBUG',
      'NODE_OPTIONS',
    ]);
  });

  it('removes prefixed parent cloud-session variables', () => {
    const env = buildChildEnv(
      {
        CLAUDE_CODE_REMOTE: '1',
        CLAUDE_CODE_REMOTE_SESSION_ID: 'abc',
        CLAUDE_CODE_CCR_EVENT_FLUSH_POLICY: 'x',
        CCR_ENABLE_TRACING: '1',
        CLAUDE_SESSION_INGRESS_TOKEN_FILE: '/f',
        CLAUDE_CODE_USE_CCR_V2: '1', // not a listed prefix: kept
      },
      { platform: 'linux' },
    );
    assert.equal(env.CLAUDE_CODE_REMOTE, undefined);
    assert.equal(env.CLAUDE_CODE_REMOTE_SESSION_ID, undefined);
    assert.equal(env.CLAUDE_CODE_CCR_EVENT_FLUSH_POLICY, undefined);
    assert.equal(env.CCR_ENABLE_TRACING, undefined);
    assert.equal(env.CLAUDE_SESSION_INGRESS_TOKEN_FILE, undefined);
    assert.equal(env.CLAUDE_CODE_USE_CCR_V2, '1');
  });

  it('removes API-key/provider switches unless allowApiKey', () => {
    const parent: NodeJS.ProcessEnv = {};
    for (const v of API_KEY_VARS) parent[v] = '1';
    const scrubbed = buildChildEnv(parent, { platform: 'linux' });
    for (const v of API_KEY_VARS) assert.equal(scrubbed[v], undefined, v);
    const kept = buildChildEnv(parent, { allowApiKey: true, platform: 'linux' });
    for (const v of API_KEY_VARS) assert.equal(kept[v], '1', v);
  });

  it('keeps user configuration (config dir, OAuth token, proxies, CA, base URL)', () => {
    const parent = {
      CLAUDE_CONFIG_DIR: '/cfg',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      HTTPS_PROXY: 'http://p:1',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      ANTHROPIC_BASE_URL: 'https://x',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9000',
      HOME: '/home/u',
    };
    const env = buildChildEnv(parent, { platform: 'linux' });
    for (const [k, v] of Object.entries(parent)) assert.equal(env[k], v, k);
  });

  it('sets the three adapter variables, overriding parent values', () => {
    const env = buildChildEnv(
      { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' },
      { platform: 'linux' },
    );
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
    assert.equal(env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, '1');
    assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  });

  it('applies extra last: strings set, undefined deletes', () => {
    const env = buildChildEnv(
      { KEEP: '1', DROP: '2' },
      { extra: { NEW: 'n', DROP: undefined, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' }, platform: 'linux' },
    );
    assert.equal(env.NEW, 'n');
    assert.equal(env.DROP, undefined);
    assert.equal('DROP' in env, false);
    assert.equal(env.KEEP, '1');
    assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '0');
  });

  it('does not mutate the parent and skips undefined values', () => {
    const parent: NodeJS.ProcessEnv = { CLAUDECODE: '1', A: undefined, B: 'b' };
    const copy = { ...parent };
    const env = buildChildEnv(parent, { platform: 'linux' });
    assert.deepEqual(parent, copy);
    assert.equal('A' in env, false);
    assert.equal(env.B, 'b');
  });

  it('is case-sensitive on POSIX', () => {
    const env = buildChildEnv({ claudecode: '1', Anthropic_Api_Key: 'k' }, { platform: 'linux' });
    assert.equal(env.claudecode, '1');
    assert.equal(env.Anthropic_Api_Key, 'k');
  });

  it('is case-insensitive on Windows', () => {
    const env = buildChildEnv(
      { ClaudeCode: '1', anthropic_api_key: 'k', Ccr_Thing: 'x', claude_code_entrypoint: 'cli', Path: 'C:\\x' },
      { platform: 'win32' },
    );
    assert.equal(env.ClaudeCode, undefined);
    assert.equal(env.anthropic_api_key, undefined);
    assert.equal(env.Ccr_Thing, undefined);
    assert.equal(env.claude_code_entrypoint, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
    assert.equal(env.Path, 'C:\\x');
  });

  it('on Windows, extra replaces differently-cased duplicates', () => {
    const env = buildChildEnv({ path: 'a' }, { extra: { PATH: 'b' }, platform: 'win32' });
    assert.equal(env.path, undefined);
    assert.equal(env.PATH, 'b');
  });
});

describe('isScrubbedSessionVar', () => {
  it('matches exact names and prefixes', () => {
    assert.equal(isScrubbedSessionVar('CLAUDECODE', 'linux'), true);
    assert.equal(isScrubbedSessionVar('CCR_X', 'linux'), true);
    assert.equal(isScrubbedSessionVar('CLAUDE_CONFIG_DIR', 'linux'), false);
    assert.equal(isScrubbedSessionVar('ANTHROPIC_API_KEY', 'linux'), false);
  });
});

describe('apiKeyOverrides', () => {
  it('lists set override variables', () => {
    assert.deepEqual(apiKeyOverrides({ ANTHROPIC_API_KEY: 'sk', PATH: '/bin' }), ['ANTHROPIC_API_KEY']);
    assert.deepEqual(
      apiKeyOverrides({ ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_PROFILE: 'p' }).sort(),
      ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_USE_BEDROCK'],
    );
  });
  it('ignores empty values and falsy provider switches', () => {
    assert.deepEqual(
      apiKeyOverrides({
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '   ',
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_USE_VERTEX: 'false',
        CLAUDE_CODE_USE_FOUNDRY: 'off',
      }),
      [],
    );
  });
  it('does not treat OAuth token or config dir as overrides', () => {
    assert.deepEqual(apiKeyOverrides({ CLAUDE_CODE_OAUTH_TOKEN: 'x', CLAUDE_CONFIG_DIR: '/c' }), []);
  });
  it('returns nothing for a scrubbed child env', () => {
    assert.deepEqual(apiKeyOverrides(buildChildEnv({ ANTHROPIC_API_KEY: 'sk', CLAUDE_CODE_USE_VERTEX: '1' })), []);
  });
});
