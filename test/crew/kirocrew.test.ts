import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  configValueArg,
  configValueEquals,
  desiredConfig,
  dottedGet,
  editConfigJson,
  gatewayRunning,
  isMissing,
  parseGatewayPid,
  parseTokenUrl,
  readRawConfigValues,
  tokenFromUrl,
} from '../../src/crew/kirocrew.js';
import { parseReadyLine, findOrphanAgents, browserOpener } from '../../src/crew/gateway.js';
import { chatHelpEnginesOk, parseKiroCliVersion, parseKiroCrewDoctor } from '../../src/crew/doctor.js';
import { parseSse, summarizePrerequisite, prerequisiteProblems, backendInstalled, backendRow } from '../../src/crew/api.js';
import { parseToolVersion, atLeast, pythonCandidates } from '../../src/crew/build.js';
import { parseEnviron, type ProcessInfo } from '../../src/crew/runner.js';

describe('KiroCrew CLI parsing', () => {
  it('desired config keys (08 §3.6), member key only for members=claude', () => {
    assert.deepEqual(desiredConfig('claude'), [
      ['agent.acp_backend', 'kiro'],
      ['agent.kas_bundle', false],
      ['agent.member_acp_backend', 'claude'],
      ['auto_update', false],
    ]);
    assert.deepEqual(desiredConfig('none').map(([k]) => k), ['agent.acp_backend', 'agent.kas_bundle', 'auto_update']);
    assert.equal(configValueArg(false), 'false');
    assert.equal(configValueArg('kiro'), 'kiro');
    assert.equal(configValueArg({ a: 1 }), '{"a":1}');
  });

  it('config value comparison tolerates Python reprs', () => {
    assert.equal(configValueEquals(false, false), true);
    assert.equal(configValueEquals('False', false), true);
    assert.equal(configValueEquals('false', false), true);
    assert.equal(configValueEquals(true, false), false);
    assert.equal(configValueEquals('kiro', 'kiro'), true);
    assert.equal(configValueEquals('kas', 'kiro'), false);
    assert.equal(configValueEquals(0, false), false);
  });

  it('dotted lookups and raw config.json reads (absent → null)', () => {
    const o = { agent: { acp_backend: 'kiro', n: null }, auto_update: false };
    assert.equal(dottedGet(o, 'agent.acp_backend'), 'kiro');
    assert.equal(dottedGet(o, 'agent.n'), null);
    assert.equal(isMissing(dottedGet(o, 'agent.nope')), true);
    assert.equal(isMissing(dottedGet(o, 'auto_update.x')), true);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-kc-'));
    const f = path.join(d, 'config.json');
    assert.deepEqual(readRawConfigValues(f, ['agent.acp_backend', 'auto_update']), { 'agent.acp_backend': null, auto_update: null });
    fs.writeFileSync(f, JSON.stringify(o));
    assert.deepEqual(readRawConfigValues(f, ['agent.acp_backend', 'auto_update', 'agent.kas_bundle']), { 'agent.acp_backend': 'kiro', auto_update: false, 'agent.kas_bundle': null });
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('editConfigJson deletes/sets dotted keys, keeps everything else and the file mode', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-kc-'));
    const f = path.join(d, 'config.json');
    assert.equal(editConfigJson(f, { a: 1 }), false, 'missing file: nothing to edit');
    fs.writeFileSync(f, JSON.stringify({ meta: { v: 1 }, agent: { acp_backend: 'kiro', apps: ['x'] }, auto_update: false }), { mode: 0o640 });
    fs.chmodSync(f, 0o640);
    assert.equal(editConfigJson(f, { 'agent.acp_backend': undefined, auto_update: undefined, 'hooks.auto_approve_subagent_spawn': true, 'no.such.parent': undefined }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { meta: { v: 1 }, agent: { apps: ['x'] }, hooks: { auto_approve_subagent_spawn: true } });
    assert.equal(fs.statSync(f).mode & 0o777, 0o640);
    fs.writeFileSync(f, '[1]');
    assert.throws(() => editConfigJson(f, { a: 1 }), /not a JSON object/);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('gateway-pid answers (SRC cli_server_stop.py)', () => {
    assert.deepEqual(parseGatewayPid('{"holder": "process", "pid": 42, "alive": true, "source": "lock"}\n', 0), { holder: 'process', pid: 42, alive: true, source: 'lock' });
    assert.deepEqual(parseGatewayPid('{"holder": "nobody"}\n', 0), { holder: 'nobody' });
    assert.deepEqual(parseGatewayPid('noise\n{"holder": "held", "reason": "draining"}\n', 0), { holder: 'held', reason: 'draining' });
    assert.equal(parseGatewayPid('{"holder": "indeterminate", "reason": "x"}', 2).holder, 'indeterminate');
    assert.equal(parseGatewayPid('', 1).holder, 'indeterminate');
    assert.equal(gatewayRunning({ holder: 'process', pid: 1, alive: true }), true);
    assert.equal(gatewayRunning({ holder: 'process', pid: 1, alive: false }), false);
    assert.equal(gatewayRunning({ holder: 'held' }), true);
    assert.equal(gatewayRunning({ holder: 'nobody' }), false);
  });

  it('token URLs', () => {
    const url = parseTokenUrl('\nhttp://localhost:5476?token=eyJ.a.b\n');
    assert.equal(url, 'http://localhost:5476?token=eyJ.a.b');
    assert.equal(tokenFromUrl(url!), 'eyJ.a.b');
    assert.equal(parseTokenUrl('❌ Gateway not running'), undefined);
    assert.equal(tokenFromUrl('nonsense'), undefined);
  });

  it('READY line (08b §2.2)', () => {
    assert.deepEqual(parseReadyLine('boot\nKIROCREW_READY:{"port":5476,"token":"t","pid":9,"home":"/h"}\nmore'), { port: 5476, token: 't', pid: 9, home: '/h' });
    assert.equal(parseReadyLine('KIROCREW_READY:{bad'), undefined);
    assert.equal(parseReadyLine(' KIROCREW_READY:{"a":1}'), undefined, 'must start the line');
  });

  it('orphan agents: kiro-claude acp + KIROCREW_SPAWNED=1 + same HOME only', () => {
    const procs: ProcessInfo[] = [
      { pid: 1, argv: ['/n/node', '/e/kiro-claude.js', 'acp', '--agent-engine', 'v2'], env: { KIROCREW_SPAWNED: '1', HOME: '/h' } },
      { pid: 2, argv: ['/n/node', '/e/kiro-claude.js', 'acp'], env: { KIROCREW_SPAWNED: '1', HOME: '/other' } },
      { pid: 3, argv: ['/n/node', '/e/kiro-claude.js', 'chat'], env: { KIROCREW_SPAWNED: '1', HOME: '/h' } },
      { pid: 4, argv: ['/n/node', '/e/kiro-claude.js', 'acp'], env: { HOME: '/h' } },
      { pid: 5, argv: ['/usr/bin/python', 'acp'], env: { KIROCREW_SPAWNED: '1', HOME: '/h' } },
      { pid: 6, argv: ['/x/kiro-claude', 'acp'], env: { KIROCREW_SPAWNED: '1', HOME: '/h' } },
      { pid: 7, argv: ['/n/node', '/e/kiro-claude.js', 'acp'], env: { KIROCREW_SPAWNED: '1', HOME: '/h' } },
      { pid: 8, argv: ['/n/node', '/e/kiro-claude.js', 'acp'] },
    ];
    assert.deepEqual(findOrphanAgents(procs, { home: '/h', entry: '/e/kiro-claude.js', selfPid: 7 }).map((p) => p.pid), [1, 6]);
  });

  it('kiro-cli version parsing matches KiroCrew (V8: start of the LAST token)', () => {
    assert.deepEqual(parseKiroCliVersion('kiro-claude 0.1.0 (kiro-cli 1.26.0)\n'), [1, 26, 0]);
    assert.equal(parseKiroCliVersion('kiro-claude 0.1.0 ((1.26.0)'), undefined);
    assert.deepEqual(parseKiroCliVersion('kiro-claude 0.1.0'), [0, 1, 0]);
  });

  it('chat --help engine block (KC-CLI-03)', () => {
    assert.equal(chatHelpEnginesOk('Options:\n      --agent-engine <ENGINE>\n          x\n\n          [possible values: v1, v2]\n      --other\n'), true);
    assert.equal(chatHelpEnginesOk('Options:\n      --agent-engine <ENGINE>\n          x\n      --other\n          [possible values: v1, v2]\n'), false);
    assert.equal(chatHelpEnginesOk('no engine'), false);
  });

  it("KiroCrew's doctor rows (D12)", () => {
    const rows = parseKiroCrewDoctor('Kiro Crew doctor\n  kiro-cli:    ✅ kiro-claude 0.1.0\n  kiro-cli-chat: ❌ Kiro CLI is broken: no kiro-cli-chat\n  kiro auth:   ✅ ok\n  claude-acp:  ⏭  x not found (optional agent backend)\n  session bus: ❌ unrelated\n');
    assert.deepEqual(rows.map((r) => [r.name, r.status]), [['kiro-cli', 'ok'], ['kiro-cli-chat', 'fail'], ['kiro auth', 'ok'], ['claude-acp', 'skip']]);
    assert.equal(parseKiroCrewDoctor('  claude-acp:  ⚠️  could not check')[0]!.status, 'warn');
  });

  it('dashboard API helpers', () => {
    assert.deepEqual(parseSse('data: {"type":"x"}\n\nevent: y\ndata: nope\ndata: {"type":"assistant","content":"hi"}\ndata: [DONE]\ndata: {"after":1}\n'), [{ type: 'x' }, { type: 'assistant', content: 'hi' }]);
    const p = summarizePrerequisite({ installed: true, authenticated: false, ready: false, missing_agent_specs: ['kirocrew.json'], rejected_agent_specs: [] })!;
    assert.deepEqual(prerequisiteProblems(p), ['not signed in (whoami failed)', 'missing agent specs: kirocrew.json']);
    assert.deepEqual(prerequisiteProblems({ installed: true, authenticated: true, ready: true, missingAgentSpecs: [], rejectedAgentSpecs: [] }), []);
    assert.equal(summarizePrerequisite([]), undefined);
    const be = { backends: [{ id: 'kiro', installed: 'installed' }, { id: 'claude', installed: 'missing' }] };
    assert.equal(backendInstalled(backendRow(be, 'kiro')), true);
    assert.equal(backendInstalled(backendRow(be, 'claude')), false);
    assert.equal(backendInstalled(backendRow(be, 'nope')), false);
  });

  it('tool versions and python candidates', () => {
    assert.equal(parseToolVersion('v22.23.4'), '22.23.4');
    assert.equal(parseToolVersion('Python 3.13.1'), '3.13.1');
    assert.equal(parseToolVersion('git version 2.43.0 (Apple Git-154)'), '2.43.0');
    assert.equal(parseToolVersion('Python 3.12'), '3.12.0');
    assert.equal(atLeast('22.12.0', '22.12.0'), true);
    assert.equal(atLeast('22.11.9', '22.12.0'), false);
    assert.equal(atLeast(undefined, '1.0.0'), false);
    assert.deepEqual(pythonCandidates({ KIRO_CLAUDE_CREW_PYTHON: '/opt/py' }), ['/opt/py', 'python3.13', 'python3.12', 'python3.14', 'python3']);
  });

  it('misc', () => {
    assert.deepEqual(parseEnviron(Buffer.from('A=1\0B=x=y\0\0bad\0')), { A: '1', B: 'x=y' });
    assert.deepEqual(browserOpener('linux', 'u'), { file: 'xdg-open', args: ['u'] });
    assert.deepEqual(browserOpener('darwin', 'u'), { file: 'open', args: ['u'] });
  });
});
