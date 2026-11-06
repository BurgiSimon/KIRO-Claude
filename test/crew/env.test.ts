import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeGatewayEnv, defaultStateEnv, isRelocatedXdgDataHome, parseEnvPair, probeEnv } from '../../src/crew/env.js';

const STATE = {
  claude: '/opt/claude-code/bin/claude',
  members: { backend: 'claude' as const },
  env: defaultStateEnv(),
};

describe('gateway env (08 §3.7)', () => {
  it('starts from the process env, scrubs 00 §3.2 session vars, sets the crew vars', () => {
    const base = {
      HOME: '/h',
      PATH: '/usr/bin',
      KEEP_ME: '1',
      KIROCREW_HOME: '/k',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_REMOTE_SESSION_ID: 'r',
      CCR_FOO: 'x',
      CLAUDE_SESSION_INGRESS_TOKEN: 'y',
      NODE_OPTIONS: '--inspect',
      CLAUDE_CODE_OAUTH_TOKEN: 'kept',
    };
    const { env, warnings } = computeGatewayEnv(base, { shim: '/cs/bin/kiro-claude', state: STATE, membersAdapter: '/cs/node/x/dist/index.js' });
    assert.deepEqual(warnings, []);
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CCR_FOO', 'CLAUDE_SESSION_INGRESS_TOKEN', 'NODE_OPTIONS']) {
      assert.equal(env[k], undefined, k);
    }
    assert.equal(env.KEEP_ME, '1');
    assert.equal(env.KIROCREW_HOME, '/k', 'a user KIROCREW_HOME is kept, never invented');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'kept');
    assert.equal(env.KIROCREW_KIRO_BIN, '/cs/bin/kiro-claude');
    assert.equal(env.KIROCREW_SKIP_MODEL_DOWNLOAD, '1');
    assert.equal(env.KIROCREW_SKIP_APP_STORE_FETCH, '1');
    assert.equal(env.PYTHONUNBUFFERED, '1');
    assert.equal(env.CLAUDE_AGENT_ACP_BIN, '/cs/node/x/dist/index.js');
    assert.equal(env.CLAUDE_CODE_EXECUTABLE, '/opt/claude-code/bin/claude');
    assert.equal(env.KIRO_HOME, undefined);
    assert.equal(base.CLAUDECODE, '1', 'input not mutated');
  });

  it('drops a relocated XDG_DATA_HOME with a warning, keeps the default one (V7)', () => {
    let r = computeGatewayEnv({ HOME: '/h', XDG_DATA_HOME: '/elsewhere' }, { shim: '/s', state: STATE });
    assert.equal(r.env.XDG_DATA_HOME, undefined);
    assert.match(r.warnings[0]!, /XDG_DATA_HOME \(\/elsewhere\) is not \/h\/.local\/share/);
    r = computeGatewayEnv({ HOME: '/h', XDG_DATA_HOME: '/h/.local/share/' }, { shim: '/s', state: STATE });
    assert.equal(r.env.XDG_DATA_HOME, '/h/.local/share/');
    assert.deepEqual(r.warnings, []);
    assert.equal(isRelocatedXdgDataHome({ HOME: '/h' }), false);
    assert.equal(isRelocatedXdgDataHome({ HOME: '/h', XDG_DATA_HOME: '' }), false);
  });

  it('warns about a non-default KIRO_HOME but keeps it (V13)', () => {
    const r = computeGatewayEnv({ HOME: '/h', KIRO_HOME: '/other' }, { shim: '/s', state: STATE });
    assert.equal(r.env.KIRO_HOME, '/other');
    assert.match(r.warnings.join(), /KIRO_HOME/);
    assert.deepEqual(computeGatewayEnv({ HOME: '/h', KIRO_HOME: '/h/.kiro' }, { shim: '/s', state: STATE }).warnings, []);
  });

  it('--with-embeddings / --app-store drop the skips; inherited values then survive', () => {
    const se = defaultStateEnv({ withEmbeddings: true, appStore: true });
    assert.deepEqual(se, {});
    let r = computeGatewayEnv({ HOME: '/h' }, { shim: '/s', state: { ...STATE, env: se } });
    assert.equal(r.env.KIROCREW_SKIP_MODEL_DOWNLOAD, undefined);
    assert.equal(r.env.KIROCREW_SKIP_APP_STORE_FETCH, undefined);
    r = computeGatewayEnv({ HOME: '/h', KIROCREW_SKIP_MODEL_DOWNLOAD: '0' }, { shim: '/s', state: STATE });
    assert.equal(r.env.KIROCREW_SKIP_MODEL_DOWNLOAD, '1', 'crew.json wins over the inherited value');
  });

  it('members none: no CLAUDE_AGENT_ACP_BIN; --kiro-bin and --env K=V applied last', () => {
    const r = computeGatewayEnv(
      { HOME: '/h' },
      { shim: '/s', kiroBin: '/fake/kiro-claude', state: { ...STATE, members: { backend: 'none' } }, membersAdapter: '/a', extra: { KIRO_CLAUDE_FORCE_MODEL: 'haiku', PYTHONUNBUFFERED: '0' } },
    );
    assert.equal(r.env.CLAUDE_AGENT_ACP_BIN, undefined);
    assert.equal(r.env.KIROCREW_KIRO_BIN, '/fake/kiro-claude');
    assert.equal(r.env.KIRO_CLAUDE_FORCE_MODEL, 'haiku');
    assert.equal(r.env.PYTHONUNBUFFERED, '0');
  });

  it('parseEnvPair', () => {
    assert.deepEqual(parseEnvPair('A=b=c'), ['A', 'b=c']);
    assert.deepEqual(parseEnvPair('A='), ['A', '']);
    for (const bad of ['=x', 'A', '1A=x', 'A-B=x']) assert.throws(() => parseEnvPair(bad), /invalid --env/);
  });

  it('probe env is the §2.0 $PROBE allowlist', () => {
    assert.deepEqual(probeEnv('/h'), { HOME: '/h', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NO_COLOR: '1', TERM: 'dumb' });
  });
});
