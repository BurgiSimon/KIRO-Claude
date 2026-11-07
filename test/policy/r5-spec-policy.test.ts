/**
 * Round 5, group spec-policy, policy half:
 *  - T2: a spec phase of a plan-mode chat (the phase sessions take the chat's plan mode) denies
 *    every mutating tool with the plan-mode text, except an `fs_write` of only the phase's own
 *    allowed paths, which the spec-phase rule then allows (also under trust-all).
 *  - T1: cloneTrust (KiroSessionOptions.initialTrust) copies every part of SessionTrust and shares
 *    nothing with the source.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import type { HookInput } from '../../src/claude/protocol.js';
import type { KiroAgent, SessionTrust } from '../../src/types.js';
import { Gate, PLAN_MODE_DENY, cloneTrust, type GateDeps } from '../../src/policy/gate.js';
import { FakeHooks, emptyTrust, makeAgent, makeWs, type TempWs } from './helpers.js';

interface Rig {
  tw: TempWs;
  gate: Gate;
  trust: SessionTrust;
  state: { agent: KiroAgent; plan: boolean; spec: { name: string; allowedWritePaths: string[] } | undefined };
}

let R: Rig;

function rig(): Rig {
  const tw = makeWs();
  const trust = emptyTrust();
  const state: Rig['state'] = { agent: makeAgent({ name: 'main' }), plan: false, spec: undefined };
  const deps: GateDeps = {
    ws: tw.ws,
    sessionId: () => 'sess-1',
    agent: () => state.agent,
    resolveAgent: () => undefined,
    hooks: () => new FakeHooks(),
    trust,
    interactive: true,
    v3Scopes: () => ({ userRules: [], workspaceRules: [], presetRules: [] }),
    mcpServerNames: () => ({ git: 'git' }),
    mcpAutoApprove: () => [],
    planMode: () => state.plan,
    specPhase: () => state.spec,
    notify: () => undefined,
  };
  return { tw, gate: new Gate(deps), trust, state };
}

let seq = 0;
async function decide(tool_name: string, tool_input: Record<string, unknown>): Promise<{ kind: string; reason?: string }> {
  const input: HookInput = {
    hook_event_name: 'PreToolUse',
    session_id: 'claude-sid',
    cwd: R.tw.ws.cwd,
    permission_mode: 'default',
    tool_name,
    tool_input,
    tool_use_id: `toolu_${++seq}`,
  };
  const d = (await R.gate.preToolUse(input)).decision;
  return d.kind === 'allow' ? { kind: 'allow' } : { kind: d.kind, reason: (d as { reason: string }).reason };
}

beforeEach(() => {
  R = rig();
});
afterEach(() => R.tw.cleanup());

describe('r5 T2: plan mode during a spec phase', () => {
  const doc = (): string => path.join(R.tw.root, '.kiro', 'specs', 'feat', 'requirements.md');
  const phase = (): { name: string; allowedWritePaths: string[] } => ({ name: 'requirements', allowedWritePaths: [doc()] });

  for (const trustAll of [false, true]) {
    it(`only the phase's own document writes are allowed; every other mutating tool gets the plan-mode denial${trustAll ? ' (trust-all)' : ''}`, async () => {
      R.state.plan = true;
      R.state.spec = phase();
      R.trust.trustAll = trustAll;
      assert.deepEqual(await decide('Write', { file_path: doc(), content: '# R' }), { kind: 'allow' }, 'the phase document');
      assert.deepEqual(await decide('Edit', { file_path: doc(), old_string: 'a', new_string: 'b' }), { kind: 'allow' }, 'an edit of the phase document');
      for (const [t, i] of [
        ['Bash', { command: 'touch made-in-plan-mode.txt', description: 'd' }],
        ['Bash', { command: 'ls', description: 'd' }],
        ['Write', { file_path: path.join(R.tw.root, 'src', 'a.ts'), content: 'x' }],
        ['Edit', { file_path: path.join(R.tw.root, '.kiro', 'specs', 'feat', 'design.md'), old_string: 'a', new_string: 'b' }],
        ['NotebookEdit', { notebook_path: path.join(R.tw.root, 'a.ipynb') }],
        ['mcp__git__status', {}],
        ['Agent', { subagent_type: 'x', prompt: 'p' }],
      ] as const) {
        assert.deepEqual(await decide(t, i as Record<string, unknown>), { kind: 'deny', reason: PLAN_MODE_DENY }, `${t} ${JSON.stringify(i).slice(0, 60)}`);
      }
      assert.equal((await decide('Read', { file_path: doc() })).kind, 'allow', 'reads stay allowed');
    });
  }

  it('a phase with nothing writable (analyze, quick questions) allows no write in plan mode', async () => {
    R.state.plan = true;
    R.state.spec = { name: 'analyze', allowedWritePaths: [] };
    assert.deepEqual(await decide('Write', { file_path: doc(), content: 'x' }), { kind: 'deny', reason: PLAN_MODE_DENY });
  });

  it('plan mode without a spec phase still denies the spec document write; a policy deny still wins inside the phase', async () => {
    R.state.plan = true;
    assert.deepEqual(await decide('Write', { file_path: doc(), content: 'x' }), { kind: 'deny', reason: PLAN_MODE_DENY });
    R.state.spec = phase();
    R.state.agent = makeAgent({ name: 'main', toolsSettings: { fs_write: { deniedPaths: ['**/*.md'] } } });
    assert.equal((await decide('Write', { file_path: doc(), content: 'x' })).kind, 'deny');
  });

  it('outside plan mode the spec phase rule is unchanged (phase doc allowed, others named in the denial)', async () => {
    R.state.spec = phase();
    assert.deepEqual(await decide('Write', { file_path: doc(), content: 'x' }), { kind: 'allow' });
    const other = await decide('Write', { file_path: path.join(R.tw.root, 'x.ts'), content: 'x' });
    assert.equal(other.kind, 'deny');
    assert.match(other.reason!, /^Spec phase requirements: only /);
    assert.equal((await decide('Bash', { command: 'make', description: 'd' })).kind, 'ask');
  });
});

describe('r5 T1: cloneTrust', () => {
  it('copies trust-all, per-tool trust, session rules, revocations and other agents\' trust, sharing nothing', () => {
    const src: SessionTrust = {
      trustAll: true,
      allowedTools: ['fs_read', '@git/status'],
      rules: [{ capability: 'shell', match: ['ls *'], exclude: ['ls /'], effect: 'allow', scope: 'session' }],
      revokedTools: ['execute_bash'],
      byAgent: { other: { allowedTools: ['fs_write'], rules: [{ capability: 'fs_write', effect: 'allow', scope: 'session' }], revokedTools: ['fs_read'] } },
    };
    const c = cloneTrust(src);
    assert.deepEqual(c, src);
    c.allowedTools.push('x');
    c.rules[0]!.match!.push('y');
    c.revokedTools!.push('z');
    c.byAgent!.other!.allowedTools.push('w');
    c.byAgent!.other!.rules.push({ capability: 'shell', effect: 'deny' });
    assert.deepEqual(src.allowedTools, ['fs_read', '@git/status']);
    assert.deepEqual(src.rules[0]!.match, ['ls *']);
    assert.deepEqual(src.revokedTools, ['execute_bash']);
    assert.deepEqual(src.byAgent!.other!.allowedTools, ['fs_write']);
    assert.equal(src.byAgent!.other!.rules.length, 1);
    // an agent named like a prototype key stays an own entry
    const proto = cloneTrust({ trustAll: false, allowedTools: [], rules: [], byAgent: JSON.parse('{"__proto__":{"allowedTools":["fs_write"],"rules":[]}}') as SessionTrust['byAgent'] });
    assert.ok(Object.prototype.hasOwnProperty.call(proto.byAgent, '__proto__'));
    assert.equal(Object.getPrototypeOf(proto.byAgent), Object.prototype);
  });
});
