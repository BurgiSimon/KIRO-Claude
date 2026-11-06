/**
 * THE GATE end to end (00 §5.1, §2.3, §3.3–§3.6): PreToolUse decisions with a fake
 * HookRunnerLike, can_use_tool approval mapping with a fake UI, serialization of concurrent
 * prompts, plan mode, spec phase, trust-all vs deny, non-interactive, subagent stricter-wins,
 * PostToolUse hooks (incl. derived PostFileCreate / PostFileSave), trust helpers, /tools labels.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanUseToolRequest, HookInput } from '../../src/claude/protocol.js';
import type { ApprovalRequest, ApprovalResponse, KiroAgent, KiroToolCall, PermissionRule } from '../../src/types.js';
import {
  ALLOW_REASON,
  GATE_CALLBACK_IDS,
  Gate,
  NON_INTERACTIVE_DENY,
  PLAN_MODE_DENY,
  USER_CANCEL_MESSAGE,
  USER_DENY_MESSAGE,
  buildInitializeHooks,
  deniedRulesText,
  forbiddenMessage,
  hookBlockedMessage,
  sessionRuleForName,
  trustToolsWarning,
  type GateDeps,
} from '../../src/policy/gate.js';
import { presetRules } from '../../src/policy/capengine.js';
import { toKiroCall } from '../../src/policy/toolmap.js';
import { FakeHooks, emptyTrust, makeAgent, makeWs, type TempWs } from './helpers.js';

// ───────────────────────────── harness ─────────────────────────────

interface Harness {
  tw: TempWs;
  gate: Gate;
  deps: GateDeps;
  hooks: FakeHooks;
  notes: Array<[string, string]>;
  denied: Array<{ call: KiroToolCall; reasons: string[] }>;
  state: {
    agent: KiroAgent;
    agents: Record<string, KiroAgent>;
    plan: boolean;
    spec: { name: string; allowedWritePaths: string[] } | undefined;
    userRules: PermissionRule[];
    workspaceRules: PermissionRule[];
    presetRules: PermissionRule[];
    autoApprove: Record<string, string[]>;
    ignored: string[];
    postContext?: (c: KiroToolCall) => string | undefined;
  };
}

let H: Harness;

function harness(p: { agent?: Partial<KiroAgent>; interactive?: boolean; agents?: KiroAgent[]; failAgent?: boolean } = {}): Harness {
  const tw = makeWs();
  const hooks = new FakeHooks();
  const notes: Array<[string, string]> = [];
  const denied: Array<{ call: KiroToolCall; reasons: string[] }> = [];
  const state: Harness['state'] = {
    agent: makeAgent({ name: 'main', ...p.agent }),
    agents: Object.fromEntries((p.agents ?? []).map((a) => [a.name, a])),
    plan: false,
    spec: undefined,
    userRules: [],
    workspaceRules: [],
    presetRules: [],
    autoApprove: {},
    ignored: [],
  };
  const deps: GateDeps = {
    ws: tw.ws,
    sessionId: () => 'sess-1',
    agent: () => {
      if (p.failAgent) throw new Error('agent store exploded');
      return state.agent;
    },
    resolveAgent: (n) => state.agents[n],
    hooks: () => hooks,
    trust: emptyTrust(),
    interactive: p.interactive ?? true,
    v3Scopes: () => ({ userRules: state.userRules, workspaceRules: state.workspaceRules, presetRules: state.presetRules }),
    mcpServerNames: () => ({ my_srv: 'my.srv', git: 'git' }),
    mcpAutoApprove: (s) => state.autoApprove[s] ?? [],
    isIgnored: (q) => state.ignored.some((d) => q === d || q.startsWith(`${d}/`)),
    planMode: () => state.plan,
    specPhase: () => state.spec,
    onPostToolContext: (c) => state.postContext?.(c),
    notify: (l, m) => notes.push([l, m]),
    onDenied: (call, reasons) => denied.push({ call, reasons }),
  };
  return { tw, gate: new Gate(deps), deps, hooks, notes, denied, state };
}

let seq = 0;
function pre(tool_name: string, tool_input: Record<string, unknown>, extra: Partial<HookInput> = {}): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'claude-sid',
    cwd: H.tw.ws.cwd,
    permission_mode: 'default',
    tool_name,
    tool_input,
    tool_use_id: `toolu_${++seq}`,
    ...extra,
  };
}

function post(i: HookInput, tool_response: unknown = { ok: true }, extra: Partial<HookInput> = {}): HookInput {
  return { ...i, hook_event_name: 'PostToolUse', tool_response, duration_ms: 12, ...extra };
}

function cut(i: HookInput, extra: Partial<CanUseToolRequest> = {}): CanUseToolRequest {
  return { subtype: 'can_use_tool', tool_name: i.tool_name!, input: i.tool_input!, tool_use_id: i.tool_use_id!, request_id: `req-${i.tool_use_id}`, ...extra };
}

const live = (): AbortSignal => new AbortController().signal;
const answer = (r: ApprovalResponse) => async (_req: ApprovalRequest): Promise<ApprovalResponse> => r;
const decide = async (name: string, input: Record<string, unknown>, extra: Partial<HookInput> = {}) => (await H.gate.preToolUse(pre(name, input, extra))).decision;
const bash = (command: string) => ({ command, description: 'd' });

beforeEach(() => {
  H = harness();
});
afterEach(() => H.tw.cleanup());

// ───────────────────────────── protocol constants ─────────────────────────────

describe('initialize hooks and exact strings', () => {
  it('buildInitializeHooks is 00 §3.3 exactly', () => {
    assert.deepEqual(buildInitializeHooks(), {
      PreToolUse: [{ hookCallbackIds: ['kiro_pre'], timeout: 600, onFailure: 'block' }],
      PostToolUse: [{ hookCallbackIds: ['kiro_post'], timeout: 600 }],
      PostToolUseFailure: [{ hookCallbackIds: ['kiro_post_fail'], timeout: 600 }],
    });
    assert.deepEqual({ ...GATE_CALLBACK_IDS }, { pre: 'kiro_pre', post: 'kiro_post', postFail: 'kiro_post_fail' });
  });
  it('strings', () => {
    assert.equal(NON_INTERACTIVE_DENY, '[denied] tool permission approval is not supported in non-interactive mode. Use --trust-all-tools to auto-approve.');
    assert.equal(PLAN_MODE_DENY, 'Plan mode is read-only. Exit plan mode (/plan or Shift+Tab) to make changes.');
    assert.equal(USER_DENY_MESSAGE, 'I deny this tool request. Ask a follow up question clarifying the expected action');
    assert.equal(USER_CANCEL_MESSAGE, 'Tool use was cancelled by the user');
    assert.equal(forbiddenMessage('execute_bash'), 'Tool use with execute_bash was rejected because the arguments supplied were forbidden');
    assert.equal(hookBlockedMessage('nope'), 'PreToolHook blocked the tool execution: nope');
    assert.equal(deniedRulesText('execute_bash', ['\\Agit .*\\z', 'x']), 'Command execute_bash is rejected because it matches one or more rules on the denied list:\n  - \\Agit .*\\z\n  - x');
    assert.equal(trustToolsWarning('foo'), 'WARNING: --trust-tools arg for custom tool foo needs to be prepended with @{MCPSERVERNAME}/');
  });
});

// ───────────────────────────── PreToolUse ─────────────────────────────

describe('preToolUse: outputs (00 §3.5)', () => {
  it('allow', async () => {
    H.state.agent = makeAgent({ name: 'main', allowedTools: ['shell'] });
    const r = await H.gate.preToolUse(pre('Bash', bash('make')));
    assert.deepEqual(r.decision, { kind: 'allow' });
    assert.deepEqual(r.output, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: ALLOW_REASON } });
    assert.equal(r.call.claudeName, 'Bash');
    assert.equal(r.call.v2Name, 'execute_bash');
    assert.equal(r.call.toolUseId, `toolu_${seq}`);
  });
  it('ask (interactive)', async () => {
    const r = await H.gate.preToolUse(pre('Bash', bash('make')));
    assert.deepEqual(r.decision, { kind: 'ask', reason: 'kiro: approval required for shell' });
    assert.deepEqual(r.output, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'kiro: approval required for shell' } });
    assert.equal(H.gate.callFor(`toolu_${seq}`)?.claudeName, 'Bash', 'pending ask remembered by tool_use_id');
  });
  it('deny by policy: Q sentence to the model, rule reasons to onDenied', async () => {
    H.state.agent = makeAgent({ name: 'main', toolsSettings: { execute_bash: { deniedCommands: ['git .*'] } } });
    const r = await H.gate.preToolUse(pre('Bash', bash('git push')));
    assert.deepEqual(r.decision, { kind: 'deny', reason: 'Tool use with execute_bash was rejected because the arguments supplied were forbidden' });
    assert.equal(r.output.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(H.denied.length, 1);
    assert.deepEqual(H.denied[0]!.reasons, ['\\Agit .*\\z']);
    assert.equal(H.gate.callFor(`toolu_${seq}`), undefined, 'denied calls are not remembered');
  });
  it('V3 deny uses the V3 tool id in the sentence', async () => {
    H.state.agent = makeAgent({ name: 'main', dialect: 'v3', permissions: [{ capability: 'shell', match: ['rm *'], effect: 'deny' }] });
    assert.deepEqual(await decide('Bash', bash('rm -rf /')), { kind: 'deny', reason: forbiddenMessage('execute_bash') });
    assert.deepEqual(await decide('mcp__git__push', {}, {}), { kind: 'ask', reason: 'kiro: approval required for @git/push' });
    H.state.agent = makeAgent({ name: 'main', dialect: 'v3', permissions: [{ capability: 'mcp', effect: 'deny' }] });
    assert.deepEqual(await decide('mcp__git__push', {}), { kind: 'deny', reason: forbiddenMessage('mcp_git_push') });
  });
  it('tools kiro-claude never exposes are denied', async () => {
    for (const t of ['ToolSearch', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']) {
      const d = await decide(t, {});
      assert.equal(d.kind, 'deny', t);
    }
  });
});

describe('preToolUse: Kiro preToolUse hooks run first', () => {
  it('blocked (exit 2) ⇒ deny with the Q text; policy not consulted', async () => {
    H.state.agent = makeAgent({ name: 'main', toolsSettings: { execute_bash: { deniedCommands: ['.*'] } } });
    H.hooks.pre = () => ({ blocked: true, blockReason: 'no shell today', warnings: [] });
    const r = await H.gate.preToolUse(pre('Bash', bash('ls')));
    assert.deepEqual(r.decision, { kind: 'deny', reason: 'PreToolHook blocked the tool execution: no shell today' });
    assert.equal(H.denied.length, 0);
    assert.equal(H.hooks.log.pre.length, 1);
    assert.equal(H.hooks.log.pre[0]!.claudeName, 'Bash');
  });
  it('agent-action prompts become additionalContext on every outcome', async () => {
    H.hooks.pre = () => ({ blocked: false, additionalContext: 'remember the style guide', warnings: [] });
    H.state.agent = makeAgent({ name: 'main', allowedTools: ['shell'] });
    const a = await H.gate.preToolUse(pre('Bash', bash('make')));
    assert.deepEqual(a.output, {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'kiro', additionalContext: 'remember the style guide' },
    });
    H.state.agent = makeAgent({ name: 'main' });
    assert.equal((await decide('Bash', bash('make'))).additionalContext, 'remember the style guide');
    H.state.plan = true;
    assert.equal((await decide('Bash', bash('make'))).additionalContext, 'remember the style guide');
  });
  it('hook warnings go to notify; a throwing runner warns and the gate continues', async () => {
    H.hooks.pre = () => ({ blocked: false, warnings: [{ hook: 'h', message: 'hook h failed with exit code 1' }] });
    await decide('Read', { file_path: path.join(H.tw.root, 'a') });
    assert.deepEqual(H.notes, [['warn', 'hook h failed with exit code 1']]);
    H.hooks.pre = () => {
      throw new Error('spawn EACCES');
    };
    const d = await decide('Read', { file_path: path.join(H.tw.root, 'a') });
    assert.equal(d.kind, 'allow');
    assert.match(H.notes[1]![1], /preToolUse hooks failed: spawn EACCES/);
  });
});

describe('preToolUse: hard rules', () => {
  it('invariants deny beats trust-all; always-ask beats allow', async () => {
    H.deps.trust.trustAll = true;
    const target = path.join(H.tw.ws.kiroHome, 'settings', 'cli.json');
    assert.deepEqual(await decide('Write', { file_path: target, content: '{}' }), { kind: 'deny', reason: `Kiro does not allow this operation: ${target}` });
    assert.equal(H.denied.length, 0, 'invariants are not rule denials');
    assert.equal((await decide('Edit', { file_path: path.join(H.tw.root, '.git', 'config') })).kind, 'ask');
    assert.equal((await decide('Write', { file_path: path.join(H.tw.root, 'src.ts') })).kind, 'allow');
  });
  it('.kiroignore denies reads', async () => {
    H.state.ignored = [path.join(H.tw.root, 'private')];
    assert.equal((await decide('Read', { file_path: path.join(H.tw.root, 'private', 'k') })).kind, 'deny');
    assert.equal((await decide('Grep', { pattern: 'x', path: path.join(H.tw.root, 'private') })).kind, 'deny');
    assert.equal((await decide('Read', { file_path: path.join(H.tw.root, 'public') })).kind, 'allow');
  });
  it('plan mode denies mutating tools only', async () => {
    H.state.plan = true;
    H.deps.trust.trustAll = true;
    for (const [t, i] of [
      ['Write', { file_path: path.join(H.tw.root, 'a') }],
      ['Edit', { file_path: path.join(H.tw.root, 'a') }],
      ['NotebookEdit', { notebook_path: path.join(H.tw.root, 'a.ipynb') }],
      ['Bash', bash('ls')],
      ['mcp__git__status', {}],
      ['Agent', { subagent_type: 'x', prompt: 'p' }],
    ] as const) {
      assert.deepEqual(await decide(t, i as Record<string, unknown>), { kind: 'deny', reason: PLAN_MODE_DENY }, t);
    }
    for (const [t, i] of [
      ['Read', { file_path: path.join(H.tw.root, 'a') }],
      ['Glob', { pattern: '*' }],
      ['Grep', { pattern: 'x' }],
      ['WebFetch', { url: 'https://x' }],
      ['WebSearch', { query: 'q' }],
      ['TaskCreate', { subject: 's' }],
    ] as const) {
      assert.equal((await decide(t, i as Record<string, unknown>)).kind, 'allow', t);
    }
  });
  it('spec phase: phase doc auto-allowed, other writes denied, policy deny still wins', async () => {
    H.state.spec = { name: 'requirements', allowedWritePaths: ['.kiro/specs/feat/requirements.md'] };
    const doc = path.join(H.tw.root, '.kiro', 'specs', 'feat', 'requirements.md');
    assert.deepEqual(await decide('Write', { file_path: doc, content: '# R' }), { kind: 'allow' });
    assert.deepEqual(await decide('Edit', { file_path: path.join(H.tw.root, 'src', 'a.ts') }), {
      kind: 'deny',
      reason: 'Spec phase requirements: only .kiro/specs/feat/requirements.md may be written now',
    });
    assert.equal((await decide('Bash', bash('make'))).kind, 'ask', 'shell follows normal rules');
    assert.equal((await decide('Read', { file_path: doc })).kind, 'allow');
    H.state.agent = makeAgent({ name: 'main', toolsSettings: { fs_write: { deniedPaths: ['**/*.md'] } } });
    assert.equal((await decide('Write', { file_path: doc })).kind, 'deny');
  });
  it('spec phase with a directory and a glob', async () => {
    H.state.spec = { name: 'tasks', allowedWritePaths: ['.kiro/specs/feat', '.kiro/specs/other/*.md'] };
    assert.equal((await decide('Write', { file_path: path.join(H.tw.root, '.kiro/specs/feat/tasks.md') })).kind, 'allow');
    assert.equal((await decide('Write', { file_path: path.join(H.tw.root, '.kiro/specs/other/design.md') })).kind, 'allow');
    assert.equal((await decide('Write', { file_path: path.join(H.tw.root, '.kiro/specs/other/x.txt') })).kind, 'deny');
    H.state.spec = { name: 'design', allowedWritePaths: [] };
    assert.deepEqual(await decide('Write', { file_path: path.join(H.tw.root, 'x') }), { kind: 'deny', reason: 'Spec phase design: only (nothing) may be written now' });
  });
  it('agent tools selection: unselected MCP tools and subagents are denied', async () => {
    H.state.agent = makeAgent({ name: 'main', tools: ['@builtin', '@git/status'], excludedTools: ['subagent/secret'], allowedTools: ['@git', 'subagent'] });
    assert.equal((await decide('mcp__git__status', {})).kind, 'allow');
    assert.deepEqual(await decide('mcp__git__push', {}), { kind: 'deny', reason: 'Tool @git/push is not enabled for agent main' });
    assert.equal((await decide('Agent', { subagent_type: 'reviewer', prompt: 'p' })).kind, 'allow');
    assert.deepEqual(await decide('Agent', { subagent_type: 'secret', prompt: 'p' }), { kind: 'deny', reason: "Agent 'secret' is not available to agent main" });
  });
});

describe('preToolUse: trust-all, non-interactive, MCP', () => {
  it('trust-all allows everything except deny results (V2 and V3)', async () => {
    H.deps.trust.trustAll = true;
    H.state.agent = makeAgent({ name: 'main', toolsSettings: { shell: { deniedCommands: ['git push.*'] } } });
    assert.equal((await decide('Bash', bash('rm -rf build'))).kind, 'allow');
    assert.equal((await decide('Bash', bash('git push'))).kind, 'deny');
    H.state.agent = makeAgent({ name: 'main', dialect: 'v3', permissions: [{ capability: 'shell', match: ['git push*'], effect: 'deny' }] });
    assert.equal((await decide('Bash', bash('rm -rf build'))).kind, 'allow');
    // a substitution could hide `git push`: with a conditional deny rule, unparseable ⇒ deny
    assert.equal((await decide('Bash', bash('echo "$(git push)"'))).kind, 'deny', 'unparseable vs deny rule');
    assert.equal((await decide('Bash', bash('git push origin'))).kind, 'deny');
    H.state.agent = makeAgent({ name: 'main', dialect: 'v3', permissions: [] });
    assert.equal((await decide('Bash', bash('echo "$(date)"'))).kind, 'allow', 'unparseable under trust-all, no deny rules');
    H.state.userRules = [{ capability: 'web_fetch', effect: 'deny', scope: 'user' }];
    assert.equal((await decide('WebFetch', { url: 'https://x' })).kind, 'deny', 'user YAML deny');
  });
  it('non-interactive: ask ⇒ deny with the V3 headless text, allow stays allow', async () => {
    H = harness({ interactive: false });
    assert.deepEqual(await decide('Bash', bash('make')), { kind: 'deny', reason: NON_INTERACTIVE_DENY });
    assert.deepEqual(await decide('Read', { file_path: path.join(H.tw.root, 'a') }), { kind: 'allow' });
    assert.deepEqual(await decide('Edit', { file_path: path.join(H.tw.root, '.vscode', 'settings.json') }), { kind: 'deny', reason: NON_INTERACTIVE_DENY });
    H.deps.trust.trustAll = true;
    assert.deepEqual(await decide('Bash', bash('make')), { kind: 'allow' });
    assert.equal(H.gate.callFor(`toolu_${seq}`)?.claudeName, 'Bash');
  });
  it('MCP: server names mapped back, autoApprove honored (V2 and V3)', async () => {
    const r = await H.gate.preToolUse(pre('mcp__my_srv__fetch', { a: 1 }));
    assert.deepEqual(r.call.mcp, { server: 'my.srv', tool: 'fetch' });
    assert.equal(r.decision.kind, 'ask');
    H.state.autoApprove = { 'my.srv': ['fetch'] };
    assert.equal((await decide('mcp__my_srv__fetch', {})).kind, 'allow');
    assert.equal((await decide('mcp__my_srv__other', {})).kind, 'ask');
    H.state.agent = makeAgent({ name: 'main', dialect: 'v3' });
    assert.equal((await decide('mcp__my_srv__fetch', {})).kind, 'allow');
    assert.equal((await decide('mcp__my_srv__other', {})).kind, 'ask');
    H.state.agent = makeAgent({ name: 'main', dialect: 'v3', permissions: [{ capability: 'mcp', match: ['my.srv/fetch'], effect: 'deny' }] });
    assert.equal((await decide('mcp__my_srv__fetch', {})).kind, 'deny', 'deny beats autoApprove');
  });
  it('MCP: Claude\'s mcp_server.name fills gaps in the server-name map', async () => {
    const r = await H.gate.preToolUse(pre('mcp__team_tools__run', {}, { mcp_server: { name: 'team tools', source: 'dynamic' } }));
    assert.deepEqual(r.call.mcp, { server: 'team tools', tool: 'run' });
    const k = await H.gate.preToolUse(pre('mcp__my_srv__run', {}, { mcp_server: { name: 'my_srv' } }));
    assert.deepEqual(k.call.mcp, { server: 'my.srv', tool: 'run' }, 'configured map wins');
  });
  it('V3 presets and workspace rules from v3Scopes()', async () => {
    H.state.agent = makeAgent({ name: 'main', dialect: 'v3' });
    assert.equal((await decide('Write', { file_path: path.join(H.tw.root, 'a') })).kind, 'ask');
    H.state.presetRules = presetRules('edit-workspace')!;
    assert.equal((await decide('Write', { file_path: path.join(H.tw.root, 'a') })).kind, 'allow');
    H.state.workspaceRules = [{ capability: 'fs_write', match: ['./a'], effect: 'ask', scope: 'workspace' }];
    assert.equal((await decide('Write', { file_path: path.join(H.tw.root, 'a') })).kind, 'ask');
  });
  it('gate errors: interactive ⇒ ask, non-interactive ⇒ deny; both notify', async () => {
    H = harness({ failAgent: true });
    const d = await decide('Read', { file_path: '/x' });
    assert.equal(d.kind, 'ask');
    assert.equal(H.notes[0]![0], 'error');
    assert.match(H.notes[0]![1], /permission gate failed: agent store exploded/);
    H.tw.cleanup();
    H = harness({ failAgent: true, interactive: false });
    assert.deepEqual(await decide('Read', { file_path: '/x' }), { kind: 'deny', reason: NON_INTERACTIVE_DENY });
  });
});

describe('preToolUse: subagents — parent and child policies, stricter wins', () => {
  const child = (p: Partial<KiroAgent>) => makeAgent({ name: 'reviewer', ...p });
  it('child deny beats parent allow', async () => {
    H = harness({
      agent: { allowedTools: ['shell'] },
      agents: [child({ dialect: 'v3', permissions: [{ capability: 'shell', match: ['rm *'], effect: 'deny' }] })],
    });
    assert.equal((await decide('Bash', bash('rm x'), { agent_type: 'reviewer', agent_id: 'a1' })).kind, 'deny');
    assert.equal((await decide('Bash', bash('rm x'))).kind, 'allow', 'outside the subagent only the parent counts');
    assert.equal(H.denied[0]!.call.subagent?.type, 'reviewer');
    assert.equal(H.denied[0]!.call.subagent?.id, 'a1');
  });
  it('parent ask beats child allow', async () => {
    H = harness({ agents: [child({ allowedTools: ['shell'] })] });
    assert.equal((await decide('Bash', bash('make'), { agent_type: 'reviewer' })).kind, 'ask');
  });
  it('both allow ⇒ allow; unknown agent types use the parent only', async () => {
    H = harness({ agent: { allowedTools: ['shell'] }, agents: [child({ allowedTools: ['shell'] })] });
    assert.equal((await decide('Bash', bash('make'), { agent_type: 'reviewer' })).kind, 'allow');
    assert.equal((await decide('Bash', bash('make'), { agent_type: 'general-purpose' })).kind, 'allow');
  });
  it('child tool selection applies to MCP calls inside the subagent', async () => {
    H = harness({ agent: { allowedTools: ['@git'] }, agents: [child({ tools: ['@git/status'], allowedTools: ['@git'] })] });
    assert.equal((await decide('mcp__git__status', {}, { agent_type: 'reviewer' })).kind, 'allow');
    assert.equal((await decide('mcp__git__push', {}, { agent_type: 'reviewer' })).kind, 'deny');
    assert.equal((await decide('mcp__git__push', {})).kind, 'allow');
  });
  it('ApprovalRequest.agentName is the subagent type inside a subagent', async () => {
    H = harness({ agents: [child({})] });
    const i = pre('Bash', bash('make'), { agent_type: 'reviewer', agent_id: 'a9' });
    await H.gate.preToolUse(i);
    let seen: ApprovalRequest | undefined;
    await H.gate.canUseTool(cut(i), async (r) => ((seen = r), { kind: 'allow-once' }), live());
    assert.equal(seen?.agentName, 'reviewer');
    const j = pre('Bash', bash('make'));
    await H.gate.preToolUse(j);
    await H.gate.canUseTool(cut(j), async (r) => ((seen = r), { kind: 'allow-once' }), live());
    assert.equal(seen?.agentName, 'main');
  });
});

// ───────────────────────────── can_use_tool ─────────────────────────────

describe('canUseTool: approval mapping (00 §2.3)', () => {
  async function asked(cmd = 'make'): Promise<HookInput> {
    const i = pre('Bash', bash(cmd));
    const r = await H.gate.preToolUse(i);
    assert.equal(r.decision.kind, 'ask');
    return i;
  }
  it('y ⇒ allow with the original input; the UI sees the remembered call', async () => {
    const i = await asked();
    const remembered = H.gate.callFor(i.tool_use_id!);
    let seen: ApprovalRequest | undefined;
    const r = await H.gate.canUseTool(cut(i), async (req) => ((seen = req), { kind: 'allow-once' }), live());
    assert.deepEqual(r, { result: { behavior: 'allow', updatedInput: i.tool_input } });
    assert.equal(seen?.call, remembered);
    assert.equal(seen?.requestId, `req-${i.tool_use_id}`);
    assert.deepEqual(seen?.reasons, ['execute_bash is not trusted']);
    assert.equal(H.deps.trust.allowedTools.length, 0);
  });
  it('t ⇒ session trust + allow; later calls of the tool are allowed by the gate', async () => {
    const i = await asked();
    const r = await H.gate.canUseTool(cut(i), answer({ kind: 'allow-always' }), live());
    assert.equal(r.result.behavior, 'allow');
    assert.deepEqual(H.deps.trust.allowedTools, ['execute_bash']);
    assert.deepEqual(H.deps.trust.rules, [{ capability: 'shell', effect: 'allow', scope: 'session' }]);
    assert.equal((await decide('Bash', bash('rm x'))).kind, 'allow');
  });
  it('t on an MCP tool trusts @server/tool', async () => {
    const i = pre('mcp__git__push', {});
    await H.gate.preToolUse(i);
    await H.gate.canUseTool(cut(i), answer({ kind: 'allow-always' }), live());
    assert.deepEqual(H.deps.trust.allowedTools, ['@git/push']);
    assert.deepEqual(H.deps.trust.rules, [{ capability: 'mcp', match: ['git/push'], effect: 'allow', scope: 'session' }]);
    assert.equal((await decide('mcp__git__push', {})).kind, 'allow');
    assert.equal((await decide('mcp__git__status', {})).kind, 'ask');
  });
  it('t under a V3 agent adds the session rule the capability engine uses', async () => {
    H.state.agent = makeAgent({ name: 'main', dialect: 'v3' });
    const i = await asked();
    await H.gate.canUseTool(cut(i), answer({ kind: 'allow-always' }), live());
    assert.equal((await decide('Bash', bash('npm run build'))).kind, 'allow');
  });
  it('n ⇒ deny with the Q message, no interrupt; custom message honored', async () => {
    const i = await asked();
    assert.deepEqual(await H.gate.canUseTool(cut(i), answer({ kind: 'deny' }), live()), { result: { behavior: 'deny', message: USER_DENY_MESSAGE } });
    const j = await asked();
    assert.deepEqual(await H.gate.canUseTool(cut(j), answer({ kind: 'deny', message: 'nope' }), live()), { result: { behavior: 'deny', message: 'nope' } });
    assert.equal(H.gate.callFor(j.tool_use_id!), undefined, 'pending entry dropped');
  });
  it('other text ⇒ deny interrupt + redirectText', async () => {
    const i = await asked();
    assert.deepEqual(await H.gate.canUseTool(cut(i), answer({ kind: 'redirect', text: 'use pnpm instead' }), live()), {
      result: { behavior: 'deny', message: USER_CANCEL_MESSAGE, interrupt: true },
      redirectText: 'use pnpm instead',
    });
  });
  it('cancelled / UI error / aborted signal ⇒ deny interrupt', async () => {
    const want = { result: { behavior: 'deny', message: USER_CANCEL_MESSAGE, interrupt: true } };
    assert.deepEqual(await H.gate.canUseTool(cut(await asked()), answer({ kind: 'cancelled' }), live()), want);
    assert.deepEqual(
      await H.gate.canUseTool(cut(await asked()), async () => {
        throw new Error('tty closed');
      }, live()),
      want,
    );
    const ac = new AbortController();
    const r = H.gate.canUseTool(cut(await asked()), async () => {
      ac.abort();
      return { kind: 'allow-once' };
    }, ac.signal);
    assert.deepEqual(await r, want, 'abort while prompting wins over the answer');
    const pre2 = new AbortController();
    pre2.abort();
    let called = false;
    assert.deepEqual(await H.gate.canUseTool(cut(await asked()), async () => ((called = true), { kind: 'allow-once' }), pre2.signal), want);
    assert.equal(called, false);
  });
  it('non-interactive gate never prompts', async () => {
    H = harness({ interactive: false });
    const i = pre('Bash', bash('make'));
    let called = false;
    const r = await H.gate.canUseTool(cut(i), async () => ((called = true), { kind: 'allow-once' }), live());
    assert.deepEqual(r, { result: { behavior: 'deny', message: NON_INTERACTIVE_DENY } });
    assert.equal(called, false);
  });
  it('without a remembered PreToolUse the call is built from the request', async () => {
    let seen: ApprovalRequest | undefined;
    const r = await H.gate.canUseTool(
      { tool_name: 'mcp__my_srv__fetch', input: { q: 1 }, tool_use_id: 'toolu_x', agent_id: 'a2', agent_type: 'reviewer' },
      async (req) => ((seen = req), { kind: 'allow-once' }),
      live(),
    );
    assert.equal(r.result.behavior, 'allow');
    assert.equal(seen?.call.claudeName, 'mcp__my_srv__fetch');
    assert.deepEqual(seen?.call.mcp, { server: 'my.srv', tool: 'fetch' });
    assert.deepEqual(seen?.call.subagent, { id: 'a2', type: 'reviewer' });
    assert.equal(seen?.requestId, 'toolu_x');
  });
  it('policy is re-checked before prompting (allowed ⇒ no prompt, denied ⇒ deny)', async () => {
    const i = await asked();
    H.deps.trust.trustAll = true;
    let called = false;
    assert.equal((await H.gate.canUseTool(cut(i), async () => ((called = true), { kind: 'deny' }), live())).result.behavior, 'allow');
    assert.equal(called, false);
    H.deps.trust.trustAll = false;
    const j = await asked();
    H.state.plan = true;
    assert.deepEqual(await H.gate.canUseTool(cut(j), answer({ kind: 'allow-once' }), live()), { result: { behavior: 'deny', message: PLAN_MODE_DENY } });
  });
  it('always-ask invariant still prompts after t on fs_write', async () => {
    const i = pre('Write', { file_path: path.join(H.tw.root, '.git', 'config'), content: '' });
    assert.equal((await H.gate.preToolUse(i)).decision.kind, 'ask');
    let n = 0;
    await H.gate.canUseTool(cut(i), async () => (n++, { kind: 'allow-always' }), live());
    const j = pre('Write', { file_path: path.join(H.tw.root, '.git', 'HEAD'), content: '' });
    assert.equal((await H.gate.preToolUse(j)).decision.kind, 'ask');
    await H.gate.canUseTool(cut(j), async () => (n++, { kind: 'allow-once' }), live());
    assert.equal(n, 2);
  });
});

describe('canUseTool: prompts are serialized', () => {
  it('one prompt at a time, in arrival order', async () => {
    const inputs = [pre('Bash', bash('a')), pre('Bash', bash('b')), pre('Write', { file_path: path.join(H.tw.root, 'c') })];
    for (const i of inputs) await H.gate.preToolUse(i);
    let active = 0;
    let max = 0;
    const order: string[] = [];
    const ui = async (r: ApprovalRequest): Promise<ApprovalResponse> => {
      active++;
      max = Math.max(max, active);
      order.push(r.call.summary);
      await new Promise((res) => setTimeout(res, 15));
      active--;
      return { kind: 'allow-once' };
    };
    const rs = await Promise.all(inputs.map((i) => H.gate.canUseTool(cut(i), ui, live())));
    assert.equal(max, 1);
    assert.deepEqual(order, ['a', 'b', path.join(H.tw.root, 'c')]);
    for (const r of rs) assert.equal(r.result.behavior, 'allow');
  });
  it('t on the first prompt covers a queued call of the same tool', async () => {
    const a = pre('Bash', bash('a'));
    const b = pre('Bash', bash('b'));
    await H.gate.preToolUse(a);
    await H.gate.preToolUse(b);
    let prompts = 0;
    const ui = async (): Promise<ApprovalResponse> => (prompts++, { kind: 'allow-always' });
    const [ra, rb] = await Promise.all([H.gate.canUseTool(cut(a), ui, live()), H.gate.canUseTool(cut(b), ui, live())]);
    assert.equal(ra.result.behavior, 'allow');
    assert.equal(rb.result.behavior, 'allow');
    assert.equal(prompts, 1);
  });
  it('a queued request whose signal aborts is cancelled without prompting; the queue continues', async () => {
    const a = pre('Bash', bash('a'));
    const b = pre('Bash', bash('b'));
    const c = pre('Bash', bash('c'));
    for (const i of [a, b, c]) await H.gate.preToolUse(i);
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    const prompted: string[] = [];
    const ui = async (r: ApprovalRequest): Promise<ApprovalResponse> => {
      prompted.push(r.call.summary);
      if (r.call.summary === 'a') await gateOpen;
      return { kind: 'allow-once' };
    };
    const acB = new AbortController();
    const pa = H.gate.canUseTool(cut(a), ui, live());
    const pb = H.gate.canUseTool(cut(b), ui, acB.signal);
    const pc = H.gate.canUseTool(cut(c), ui, live());
    await new Promise((r) => setTimeout(r, 5));
    acB.abort();
    const rb = await pb;
    assert.deepEqual(rb, { result: { behavior: 'deny', message: USER_CANCEL_MESSAGE, interrupt: true } });
    assert.deepEqual(prompted, ['a'], 'c waits for a');
    release();
    const [ra, rc] = await Promise.all([pa, pc]);
    assert.equal(ra.result.behavior, 'allow');
    assert.equal(rc.result.behavior, 'allow');
    assert.deepEqual(prompted, ['a', 'c']);
  });
});

// ───────────────────────────── PostToolUse ─────────────────────────────

describe('postToolUse', () => {
  it('runs Kiro postToolUse hooks with the outcome; no context ⇒ {}', async () => {
    const i = pre('Read', { file_path: path.join(H.tw.root, 'a') });
    await H.gate.preToolUse(i);
    const out = await H.gate.postToolUse(post(i, { type: 'text', file: { content: 'x' } }));
    assert.deepEqual(out, {});
    assert.equal(H.hooks.log.post.length, 1);
    const { call, outcome } = H.hooks.log.post[0]!;
    assert.equal(call.claudeName, 'Read');
    assert.deepEqual(outcome, { success: true, response: { type: 'text', file: { content: 'x' } }, durationMs: 12 });
    assert.equal(H.hooks.log.file.length, 0);
    assert.equal(H.gate.callFor(i.tool_use_id!), undefined, 'pending entry consumed');
  });
  it('Write to a new file ⇒ PostFileCreate; to an existing file ⇒ PostFileSave (existence at PreToolUse)', async () => {
    const f = path.join(H.tw.root, 'new.txt');
    const i = pre('Write', { file_path: f, content: 'x' });
    H.deps.trust.trustAll = true;
    await H.gate.preToolUse(i);
    fs.writeFileSync(f, 'x'); // the tool ran
    await H.gate.postToolUse(post(i, { type: 'update' }));
    const j = pre('Edit', { file_path: f, old_string: 'x', new_string: 'y' });
    await H.gate.preToolUse(j);
    await H.gate.postToolUse(post(j));
    assert.deepEqual(H.hooks.log.file.map((e) => [e.trigger, e.path]), [['PostFileCreate', f], ['PostFileSave', f]]);
  });
  it('without a remembered PreToolUse: Write response type decides', async () => {
    const f = path.join(H.tw.root, 'z.txt');
    await H.gate.postToolUse(post(pre('Write', { file_path: f }), { type: 'create' }));
    await H.gate.postToolUse(post(pre('Write', { file_path: f }), { type: 'update' }));
    await H.gate.postToolUse(post(pre('NotebookEdit', { notebook_path: f })));
    assert.deepEqual(H.hooks.log.file.map((e) => e.trigger), ['PostFileCreate', 'PostFileSave', 'PostFileSave']);
  });
  it('contexts are joined in order: postToolUse hooks, file hooks, onPostToolContext', async () => {
    H.hooks.post = () => ({ additionalContext: 'A', warnings: [{ hook: 'p', message: 'post warn' }] });
    H.hooks.fileHook = (t, p) => ({ additionalContext: `File ${p} was saved. B (${t})`, warnings: [] });
    H.state.postContext = (c) => (c.claudeName === 'Write' ? 'C' : undefined);
    const f = path.join(H.tw.root, 'q.txt');
    const out = await H.gate.postToolUse(post(pre('Write', { file_path: f }), { type: 'create' }));
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `A\n\nFile ${f} was saved. B (PostFileCreate)\n\nC` } });
    assert.deepEqual(H.notes, [['warn', 'post warn']]);
  });
  it('failed tools (kiro_post_fail): failure outcome, no file hooks, no post context', async () => {
    H.hooks.post = () => ({ additionalContext: 'A', warnings: [] });
    H.state.postContext = () => 'C';
    const i = pre('Write', { file_path: path.join(H.tw.root, 'x') });
    const out = await H.gate.hookCallback('kiro_post_fail', { ...i, hook_event_name: 'PostToolUseFailure', error: 'EACCES' });
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'A' } });
    assert.deepEqual(H.hooks.log.post[0]!.outcome, { success: false, error: 'EACCES' });
    assert.equal(H.hooks.log.file.length, 0);
  });
  it('hook runner errors become warnings', async () => {
    H.hooks.post = () => {
      throw new Error('boom');
    };
    H.hooks.fileHook = () => {
      throw new Error('fboom');
    };
    const out = await H.gate.postToolUse(post(pre('Edit', { file_path: path.join(H.tw.root, 'x') })));
    assert.deepEqual(out, {});
    assert.deepEqual(H.notes.map((n) => n[1]), ['postToolUse hooks failed: boom', 'PostFileSave hooks failed: fboom']);
  });
});

describe('hookCallback dispatch', () => {
  it('kiro_pre / kiro_post / kiro_post_fail / unknown', async () => {
    H.state.agent = makeAgent({ name: 'main', allowedTools: ['shell'] });
    const i = pre('Bash', bash('make'));
    assert.equal((await H.gate.hookCallback('kiro_pre', i)).hookSpecificOutput?.permissionDecision, 'allow');
    assert.deepEqual(await H.gate.hookCallback('kiro_post', post(i)), {});
    assert.equal(H.hooks.log.post.length, 1);
    assert.deepEqual(await H.gate.hookCallback('something_else', i), {});
  });
});

// ───────────────────────────── trust helpers ─────────────────────────────

describe('trust helpers (06 §1.7, 00 §4.3)', () => {
  it('trustTools normalizes, appends rules, warns for non-native names without @', () => {
    const r = H.gate.trustTools(['read', 'shell', '@git', '@git/status', 'foo', '', '  ', 'read_file', 'shell']);
    assert.deepEqual(r, ['fs_read', 'execute_bash', '@git', '@git/status', 'foo', 'fs_read', 'execute_bash']);
    assert.deepEqual(H.deps.trust.allowedTools, ['fs_read', 'execute_bash', '@git', '@git/status', 'foo']);
    assert.deepEqual(H.deps.trust.rules, [
      { capability: 'fs_read', effect: 'allow', scope: 'session' },
      { capability: 'shell', effect: 'allow', scope: 'session' },
      { capability: 'mcp', match: ['git/*'], effect: 'allow', scope: 'session' },
      { capability: 'mcp', match: ['git/status'], effect: 'allow', scope: 'session' },
    ]);
    assert.deepEqual(H.notes, [['warn', trustToolsWarning('foo')]]);
  });
  it('trusting a V3 MCP tool id works for the matching call', async () => {
    H.gate.trustTools(['mcp_git_status']);
    assert.equal(H.notes.length, 0);
    assert.equal((await decide('mcp__git__status', {})).kind, 'allow');
    assert.equal((await decide('mcp__git__push', {})).kind, 'ask');
    H.state.agent = makeAgent({ name: 'main', dialect: 'v3' });
    assert.equal((await decide('mcp__git__status', {})).kind, 'allow');
  });
  it('untrustTools removes names and their session rules', async () => {
    H.gate.trustTools(['shell', '@git']);
    assert.deepEqual(H.gate.untrustTools(['execute_cmd', 'nothing']), ['execute_bash']);
    assert.deepEqual(H.deps.trust.allowedTools, ['@git']);
    assert.deepEqual(H.deps.trust.rules, [{ capability: 'mcp', match: ['git/*'], effect: 'allow', scope: 'session' }]);
    assert.equal((await decide('Bash', bash('make'))).kind, 'ask');
  });
  it('setTrustAll / resetTrust', async () => {
    H.gate.setTrustAll(true);
    assert.equal(H.deps.trust.trustAll, true);
    assert.equal((await decide('Bash', bash('make'))).kind, 'allow');
    H.gate.trustTools(['shell']);
    H.gate.resetTrust();
    assert.deepEqual(H.deps.trust, { trustAll: false, allowedTools: [], rules: [] });
    assert.equal(H.gate.trust, H.deps.trust);
    assert.equal((await decide('Bash', bash('make'))).kind, 'ask');
  });
  it('sessionRuleForName', () => {
    assert.deepEqual(sessionRuleForName('*'), { capability: 'builtin', effect: 'allow', scope: 'session' });
    assert.deepEqual(sessionRuleForName('@builtin/fs_write'), { capability: 'fs_write', effect: 'allow', scope: 'session' });
    assert.deepEqual(sessionRuleForName('@mcp'), { capability: 'mcp', effect: 'allow', scope: 'session' });
    assert.deepEqual(sessionRuleForName('glob'), { capability: 'fs_read', effect: 'allow', scope: 'session' });
    assert.deepEqual(sessionRuleForName('use_subagent'), { capability: 'subagent', effect: 'allow', scope: 'session' });
    assert.deepEqual(sessionRuleForName('web_search'), { capability: 'web_search', effect: 'allow', scope: 'session' });
    assert.equal(sessionRuleForName('todo_list'), undefined);
    assert.equal(sessionRuleForName('@'), undefined);
  });
});

describe('describeTool (/tools permission labels)', () => {
  const c = (name: string, input: Record<string, unknown> = {}) =>
    toKiroCall(name, input, { cwd: H.tw.ws.cwd, mcpServerNames: H.deps.mcpServerNames() });
  it('V2 labels (06 §1.6)', () => {
    assert.equal(H.gate.describeTool(c('Read')), 'trust working directory');
    assert.equal(H.gate.describeTool(c('Glob')), 'trust working directory');
    assert.equal(H.gate.describeTool(c('Write')), 'not trusted');
    assert.equal(H.gate.describeTool(c('Bash')), 'not trusted');
    assert.equal(H.gate.describeTool(c('TaskCreate')), 'trusted');
    assert.equal(H.gate.describeTool(c('mcp__git__status')), 'not trusted');
    assert.equal(H.gate.describeTool(c('ToolSearch')), 'denied');
    H.state.agent = makeAgent({ name: 'main', allowedTools: ['read', '@git'], toolsSettings: { shell: { autoAllowReadonly: true } } });
    assert.equal(H.gate.describeTool(c('Read')), 'trusted');
    assert.equal(H.gate.describeTool(c('Grep')), 'trusted');
    assert.equal(H.gate.describeTool(c('Bash')), 'read-only commands');
    assert.equal(H.gate.describeTool(c('mcp__git__status')), 'trusted');
    H.state.autoApprove = { 'my.srv': ['*'] };
    assert.equal(H.gate.describeTool(c('mcp__my_srv__x')), 'trusted');
    H.gate.setTrustAll(true);
    assert.equal(H.gate.describeTool(c('Write')), 'trusted');
    H.state.plan = true;
    assert.equal(H.gate.describeTool(c('Write')), 'denied (plan mode)');
    assert.equal(H.gate.describeTool(c('Read')), 'trusted');
  });
  it('V3 labels', () => {
    H.state.agent = makeAgent({ name: 'main', dialect: 'v3' });
    assert.equal(H.gate.describeTool(c('Read')), 'trust working directory');
    assert.equal(H.gate.describeTool(c('Bash')), 'read-only commands');
    assert.equal(H.gate.describeTool(c('Write')), 'not trusted');
    assert.equal(H.gate.describeTool(c('TaskList')), 'trusted');
    assert.equal(H.gate.describeTool(c('WebFetch')), 'not trusted');
    H.state.agent = makeAgent({
      name: 'main',
      dialect: 'v3',
      permissions: [
        { capability: 'fs_write', effect: 'allow' },
        { capability: 'web_fetch', effect: 'deny' },
        { capability: 'shell', match: ['npm *'], effect: 'allow' },
        { capability: 'mcp', match: ['git/*'], effect: 'allow' },
      ],
    });
    assert.equal(H.gate.describeTool(c('Write')), 'trusted');
    assert.equal(H.gate.describeTool(c('WebFetch')), 'denied');
    assert.equal(H.gate.describeTool(c('Bash')), 'partially trusted');
    assert.equal(H.gate.describeTool(c('mcp__git__x')), 'partially trusted');
    assert.equal(H.gate.describeTool(c('mcp__other__x')), 'not trusted');
    H.gate.setTrustAll(true);
    assert.equal(H.gate.describeTool(c('mcp__other__x')), 'trusted');
    assert.equal(H.gate.describeTool(c('WebFetch')), 'denied');
  });
});
