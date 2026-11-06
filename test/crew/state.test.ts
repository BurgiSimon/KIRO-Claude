import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CrewStateError, parseState, readState, writeState, type CrewState } from '../../src/crew/state.js';

const SAMPLE: CrewState = {
  version: 1,
  kirocrew: { dir: '/home/u/KIRO-Claude/vendor/KiroCrew', url: 'https://github.com/kirodotdev/KiroCrew.git', commit: '665a0e4e4a6507de0f3e7cffd3160c9359900c7c', build: 'light', python: '/usr/local/bin/python3.13', source: 'submodule' },
  shim: '/home/u/.local/share/kiro-claude/crew/bin/kiro-claude',
  node: '/opt/node22/bin/node',
  entry: '/home/u/KIRO-Claude/dist/src/bin/kiro-claude.js',
  claude: '/opt/claude-code/bin/claude',
  members: { backend: 'claude', adapter: '/x/claude-agent-acp/dist/index.js' },
  port: 5476,
  identityStub: { created: true, path: '/home/u/.local/share/kiro-cli/data.sqlite3' },
  previousConfig: { 'agent.acp_backend': null, 'agent.kas_bundle': null, 'agent.member_acp_backend': null, auto_update: null },
  env: { KIROCREW_SKIP_MODEL_DOWNLOAD: '1', KIROCREW_SKIP_APP_STORE_FETCH: '1' },
};

describe('crew.json (08 §3.2)', () => {
  it('round-trips the §3.2 example; file mode 0600; atomic', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-state-'));
    const f = path.join(d, 'crew', 'crew.json');
    writeState(f, SAMPLE);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(readState(f), { ...SAMPLE, kiroBinOverride: undefined, identityStub: { ...SAMPLE.identityStub, optOut: undefined, createdDir: undefined } });
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(Object.keys(raw), ['version', 'kirocrew', 'shim', 'node', 'entry', 'claude', 'members', 'port', 'identityStub', 'previousConfig', 'env']);
    assert.equal(fs.readdirSync(path.dirname(f)).length, 1, 'no temp files left');
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('never stores secrets: there is no token field', () => {
    assert.ok(!JSON.stringify(SAMPLE).includes('token"'));
  });

  it('missing file → undefined; invalid → CrewStateError', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-state-'));
    assert.equal(readState(path.join(d, 'nope.json')), undefined);
    fs.writeFileSync(path.join(d, 'bad.json'), '{');
    assert.throws(() => readState(path.join(d, 'bad.json')), CrewStateError);
    assert.throws(() => parseState([], 'x'), /not a JSON object/);
    assert.throws(() => parseState({ version: 2 }, 'x'), /unsupported version/);
    assert.throws(() => parseState({ version: 1 }, 'x'), /missing kirocrew.dir/);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('is lenient about optional fields', () => {
    const s = parseState({ version: 1, kirocrew: { dir: '/kc' } }, 'x');
    assert.equal(s.port, 5476);
    assert.equal(s.members.backend, 'claude');
    assert.equal(s.kirocrew.build, 'light');
    assert.deepEqual(s.previousConfig, {});
    assert.equal(parseState({ version: 1, kirocrew: { dir: '/kc' }, port: 99999 }, 'x').port, 5476);
  });
});
