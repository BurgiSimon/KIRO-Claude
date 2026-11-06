/**
 * Cancellation reaches Kiro tool hooks (review C12 (a)): Gate.preToolUse / postToolUse /
 * hookCallback take the hook_callback's cancel signal and hand it to the hook runner as
 * HookRunContext.signal, so the hook command's process group is SIGKILLed when Claude withdraws
 * the callback or the turn is cancelled. A preToolUse whose hooks were cancelled never turns
 * into `allow`.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { GATE_CALLBACK_IDS, Gate, USER_CANCEL_MESSAGE, type GateDeps } from '../../src/policy/gate.js';
import { HookRunner } from '../../src/hooks/runner.js';
import type { HookInput } from '../../src/claude/protocol.js';
import type { HookRunContext, HookRunnerLike, KiroHook, KiroToolCall, PostToolHookResult, PreToolHookResult, ToolOutcome } from '../../src/types.js';
import { FakeHooks, emptyTrust, makeAgent, makeWs, type TempWs } from './helpers.js';

const unix = process.platform === 'win32' ? { skip: 'POSIX process groups' } : {};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** FakeHooks that also records the HookRunContext of every call. */
class CtxHooks extends FakeHooks {
  readonly ctxs: { kind: string; ctx: HookRunContext }[] = [];
  override async runPreToolUse(ctx: HookRunContext, call: KiroToolCall): Promise<PreToolHookResult> {
    this.ctxs.push({ kind: 'pre', ctx });
    return super.runPreToolUse(ctx, call);
  }
  override async runPostToolUse(ctx: HookRunContext, call: KiroToolCall, outcome: ToolOutcome): Promise<PostToolHookResult> {
    this.ctxs.push({ kind: 'post', ctx });
    return super.runPostToolUse(ctx, call, outcome);
  }
  override async runFileHook(
    ctx: HookRunContext,
    trigger: 'PostFileCreate' | 'PostFileSave' | 'PostFileDelete',
    filePath: string,
    call: KiroToolCall,
  ): Promise<PostToolHookResult> {
    this.ctxs.push({ kind: 'file', ctx });
    return super.runFileHook(ctx, trigger, filePath, call);
  }
}

let tw: TempWs;
beforeEach(() => {
  tw = makeWs();
});
afterEach(() => tw.cleanup());

function gateWith(hooks: HookRunnerLike, p: { interactive?: boolean; trustAll?: boolean } = {}): { gate: Gate; notes: string[] } {
  const notes: string[] = [];
  const deps: GateDeps = {
    ws: tw.ws,
    sessionId: () => 'sess-1',
    agent: () => makeAgent({ name: 'main' }),
    resolveAgent: () => undefined,
    hooks: () => hooks,
    trust: emptyTrust({ trustAll: p.trustAll ?? true }),
    interactive: p.interactive ?? true,
    v3Scopes: () => ({ userRules: [], workspaceRules: [], presetRules: [] }),
    mcpServerNames: () => ({}),
    mcpAutoApprove: () => [],
    planMode: () => false,
    specPhase: () => undefined,
    notify: (_l, m) => notes.push(m),
  };
  return { gate: new Gate(deps), notes };
}

let seq = 0;
function preInput(tool_name: string, tool_input: Record<string, unknown>): HookInput {
  return { hook_event_name: 'PreToolUse', session_id: 'c', cwd: tw.ws.cwd, permission_mode: 'default', tool_name, tool_input, tool_use_id: `toolu_${++seq}` };
}

describe('gate: tool hooks get the hook_callback cancel signal', () => {
  it('preToolUse(input, signal) passes the signal to the preToolUse hooks', async () => {
    const hooks = new CtxHooks();
    const { gate } = gateWith(hooks);
    const ac = new AbortController();
    await gate.preToolUse(preInput('Bash', { command: 'ls' }), ac.signal);
    assert.equal(hooks.ctxs.length, 1);
    assert.equal(hooks.ctxs[0]!.ctx.signal, ac.signal);
    assert.equal(hooks.ctxs[0]!.ctx.sessionId, 'sess-1');
  });

  it('postToolUse(input, failed, signal) passes it to postToolUse and file hooks', async () => {
    const hooks = new CtxHooks();
    const { gate } = gateWith(hooks);
    const f = path.join(tw.ws.cwd, 'a.txt');
    const i = preInput('Write', { file_path: f, content: 'x' });
    await gate.preToolUse(i);
    fs.writeFileSync(f, 'x');
    const ac = new AbortController();
    await gate.postToolUse({ ...i, hook_event_name: 'PostToolUse', tool_response: { type: 'create' } }, false, ac.signal);
    const post = hooks.ctxs.filter((c) => c.kind !== 'pre');
    assert.deepEqual(post.map((c) => c.kind), ['post', 'file']);
    for (const c of post) assert.equal(c.ctx.signal, ac.signal);
  });

  it('hookCallback(id, input, signal) forwards the signal for every gate callback id', async () => {
    const hooks = new CtxHooks();
    const { gate } = gateWith(hooks);
    const ac = new AbortController();
    const i = preInput('Bash', { command: 'ls' });
    await gate.hookCallback(GATE_CALLBACK_IDS.pre, i, ac.signal);
    await gate.hookCallback(GATE_CALLBACK_IDS.post, { ...i, hook_event_name: 'PostToolUse', tool_response: 'ok' }, ac.signal);
    await gate.hookCallback(GATE_CALLBACK_IDS.postFail, { ...i, hook_event_name: 'PostToolUseFailure', error: 'boom' }, ac.signal);
    assert.deepEqual(hooks.ctxs.map((c) => c.kind), ['pre', 'post', 'post']);
    for (const c of hooks.ctxs) assert.equal(c.ctx.signal, ac.signal);
  });

  it('without a signal the hook context has none (existing callers unchanged)', async () => {
    const hooks = new CtxHooks();
    const { gate } = gateWith(hooks);
    await gate.preToolUse(preInput('Bash', { command: 'ls' }));
    assert.equal('signal' in hooks.ctxs[0]!.ctx, false);
  });

  it('a call whose preToolUse hooks were cancelled is denied, never allowed', async () => {
    const hooks = new FakeHooks();
    const ac = new AbortController();
    hooks.pre = () => {
      ac.abort();
      return { blocked: false, warnings: [] };
    };
    const { gate } = gateWith(hooks, { trustAll: true });
    const r = await gate.preToolUse(preInput('Bash', { command: 'ls' }), ac.signal);
    assert.equal(r.decision.kind, 'deny');
    assert.equal(r.decision.kind === 'deny' ? r.decision.reason : '', USER_CANCEL_MESSAGE);
    // a block by the hooks themselves still wins over the cancellation
    hooks.pre = () => ({ blocked: true, blockReason: 'nope', warnings: [] });
    const r2 = await gate.preToolUse(preInput('Bash', { command: 'ls' }), ac.signal);
    assert.equal(r2.decision.kind === 'deny' ? r2.decision.reason : '', 'PreToolHook blocked the tool execution: nope');
  });
});

describe('gate + HookRunner: cancelling kills a running hook command', () => {
  /** pids of live processes whose argv contains `tag` (Linux /proc; elsewhere skipped). */
  function liveWith(tag: string): number[] {
    const out: number[] = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        if (!fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(tag)) continue;
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
        if (state !== 'Z' && state !== 'X') out.push(Number(d));
      } catch {
        /* gone */
      }
    }
    return out;
  }
  const procfs = fs.existsSync('/proc/self/cmdline') && process.platform !== 'win32' ? unix : { skip: 'needs /proc' };

  function preHook(command: string, timeoutMs: number): KiroHook {
    return {
      dialect: 'v2',
      source: 'agent',
      name: 'preToolUse-0',
      trigger: 'PreToolUse',
      rawTrigger: 'preToolUse',
      action: { type: 'command', command },
      timeoutMs,
      maxOutputBytes: 10_240,
      cacheTtlSec: 0,
      enabled: true,
      agentName: 'main',
    };
  }

  it('aborting the signal SIGKILLs the preToolUse hook group; no warning, no allow', procfs, async (t) => {
    const tag = `31.${process.pid}7`;
    t.after(() => {
      for (const pid of liveWith(tag)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    });
    const marker = path.join(tw.root, 'hook-started');
    tw.ws.env.PATH = process.env.PATH;
    const runner = new HookRunner([preHook(`touch '${marker}'; sleep ${tag}; echo done`, 60_000)]);
    const { gate, notes } = gateWith(runner, { trustAll: true });
    const ac = new AbortController();
    const p = gate.preToolUse(preInput('Bash', { command: 'ls' }), ac.signal);
    for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await sleep(25);
    assert.ok(liveWith(tag).length > 0, 'hook started');
    const t0 = Date.now();
    ac.abort();
    const r = await Promise.race([p, sleep(3000).then(() => undefined)]);
    assert.ok(r, 'preToolUse did not settle after the abort');
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(r.decision.kind, 'deny');
    for (let i = 0; i < 40 && liveWith(tag).length; i++) await sleep(25);
    assert.deepEqual(liveWith(tag), [], 'hook command still running after the cancel');
    assert.deepEqual(notes, [], 'a cancelled hook is not reported as a failure');
  });
});
