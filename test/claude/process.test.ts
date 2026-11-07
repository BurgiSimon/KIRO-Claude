import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { isAuthError } from '../../src/claude/auth.js';
import {
  ClaudeControlError,
  ClaudeProcess,
  ClaudeProcessError,
  LineSplitter,
  isUuid,
  resultMatchesUuid,
  resultUserUuids,
  sessionIdFromArgs,
} from '../../src/claude/process.js';
import {
  isAssistantFrame,
  isResultFrame,
  isStreamEvent,
  isUserFrame,
  toolResultText,
  toolResults,
  type CanUseToolRequest,
  type ClaudeFrame,
  type HookCallbackRequest,
  type UserFrame,
} from '../../src/claude/protocol.js';
import { STREAM_ARGS, collectTurn, fakeEnv, mkTmp, startFake, waitFor, type FakeHandle } from './helpers.js';

const open: ClaudeProcess[] = [];
async function fake(opts: Parameters<typeof startFake>[0] = {}): Promise<FakeHandle> {
  const h = await startFake(opts);
  open.push(h.proc);
  return h;
}
after(async () => {
  await Promise.all(open.map((p) => p.close({ graceMs: 200 }).catch(() => undefined)));
});

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HOOKS = {
  PreToolUse: [{ hookCallbackIds: ['kiro_pre'], timeout: 600, onFailure: 'block' as const }],
  PostToolUse: [{ hookCallbackIds: ['kiro_post'], timeout: 600 }],
  PostToolUseFailure: [{ hookCallbackIds: ['kiro_post_fail'], timeout: 600 }],
};

function toolResultFrames(frames: ClaudeFrame[]): Array<{ content: string; is_error: boolean }> {
  return frames
    .filter(isUserFrame)
    .flatMap((f) => toolResults(f as UserFrame))
    .map((b) => ({ content: toolResultText(b), is_error: b.is_error === true }));
}

function controlResponsesFor(h: FakeHandle, requestId: string): Array<Record<string, unknown>> {
  return h
    .stdinLines()
    .filter((l) => l.type === 'control_response' && (l.response as { request_id?: string }).request_id === requestId);
}

/* ------------------------------------------------------------------------------------------ */

describe('pure helpers', () => {
  it('isUuid', () => {
    assert.equal(isUuid(SID), true);
    assert.equal(isUuid('11111111-1111-4111-8111-111111111111'), true);
    assert.equal(isUuid('not-a-uuid'), false);
    assert.equal(isUuid(undefined), false);
  });

  it('sessionIdFromArgs', () => {
    assert.equal(sessionIdFromArgs(['-p', '--session-id', SID]), SID);
    assert.equal(sessionIdFromArgs(['--session-id=' + SID]), SID);
    assert.equal(sessionIdFromArgs(['--resume', SID]), SID);
    assert.equal(sessionIdFromArgs(['-r', SID]), SID);
    assert.equal(sessionIdFromArgs(['--resume', SID, '--fork-session']), undefined);
    assert.equal(sessionIdFromArgs(['--fork-session', '--resume', SID, '--session-id', 'x']), 'x');
    assert.equal(sessionIdFromArgs(['-p']), undefined);
    assert.equal(sessionIdFromArgs(['--resume']), undefined);
  });

  it('resultUserUuids / resultMatchesUuid', () => {
    assert.deepEqual(resultUserUuids({ user_message_uuid: 'a', user_message_uuids: ['a', 'b'] }), ['a', 'b']);
    assert.deepEqual(resultUserUuids({ user_message_uuid: 'c' }), ['c']);
    assert.deepEqual(resultUserUuids({ user_message_uuids: ['a', 3, 'b'] }), ['a', 'b']);
    assert.equal(resultMatchesUuid({}, 'x'), true, 'no uuid info => first result matches');
    assert.equal(resultMatchesUuid({ user_message_uuids: ['x', 'y'] }, 'y'), true);
    assert.equal(resultMatchesUuid({ user_message_uuids: ['x'] }, 'y'), false);
  });

  it('LineSplitter handles partial lines, CRLF, blank lines and split UTF-8', () => {
    const s = new LineSplitter();
    assert.deepEqual(s.push(Buffer.from('{"a":1}\n{"b"')), ['{"a":1}']);
    assert.deepEqual(s.push(Buffer.from(':2}\r\n\n')), ['{"b":2}', '']);
    const euro = Buffer.from('{"t":"€"}\n');
    assert.deepEqual(s.push(euro.subarray(0, 7)), []);
    assert.deepEqual(s.push(euro.subarray(7)), ['{"t":"€"}']);
    assert.deepEqual(s.push(Buffer.from('tail-without-newline')), []);
    assert.deepEqual(s.end(), ['tail-without-newline']);
    assert.deepEqual(s.end(), []);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('ClaudeProcess.start / initialize', () => {
  it('writes initialize as the first line and exposes the response', async () => {
    const h = await fake({ initialize: { hooks: HOOKS, skills: ['kiro:x'] }, args: ['--session-id', SID] });
    const lines = h.stdinLines();
    assert.equal(lines[0]!.type, 'control_request');
    const req = lines[0]!.request as Record<string, unknown>;
    assert.equal(req.subtype, 'initialize');
    assert.deepEqual(req.hooks, HOOKS);
    assert.deepEqual(req.skills, ['kiro:x']);
    const r = h.proc.initializeResponse;
    assert.equal(r.claude_code_version, '2.1.318');
    assert.ok(r.models?.some((m) => m.value === 'haiku' && m.resolvedModel === 'claude-haiku-5-5'));
    assert.ok(r.commands?.some((c) => c.name === 'compact'));
    assert.equal(r.hooks_applied, true);
    assert.equal(typeof h.proc.pid, 'number');
    assert.equal(h.proc.sessionId, SID, 'seeded from --session-id');
    assert.equal(h.proc.busy, false);
    assert.equal(h.proc.lastInit, undefined);
    assert.equal(h.proc.running, true);
  });

  it('rejects with stderr tail when the child exits before answering', async () => {
    await assert.rejects(
      startFake({ env: { FAKE_CLAUDE_EXIT_ON_START: '2', FAKE_CLAUDE_STDERR: 'Error: Session ID x is already in use.' } }),
      (e: unknown) =>
        e instanceof ClaudeProcessError && e.exitCode === 2 && /already in use/.test(e.stderr) && /already in use/.test(e.message),
    );
  });

  it('rejects when an argument is invalid (child prints usage error)', async () => {
    await assert.rejects(startFake({ args: ['--hard-fail'] }), (e: unknown) => e instanceof ClaudeProcessError && /unknown option '--hard-fail'/.test(e.stderr));
  });

  it('rejects and kills the child on initialize timeout', async () => {
    const t0 = Date.now();
    let err: unknown;
    try {
      await startFake({ env: { FAKE_CLAUDE_NO_INIT_RESPONSE: '1' }, initializeTimeoutMs: 300 });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ClaudeProcessError, String(err));
    assert.match((err as Error).message, /failed to initialize.*timed out/);
    assert.ok(Date.now() - t0 < 8000);
  });

  it('rejects on an initialize error response', async () => {
    await assert.rejects(startFake({ env: { FAKE_CLAUDE_INIT_ERROR: 'bad hooks' } }), /failed to initialize: bad hooks/);
  });

  it('rejects clearly when the working directory is missing', async () => {
    await assert.rejects(
      startFake({ cwd: '/nonexistent/kc-cwd-xyz' }),
      (e: unknown) => e instanceof ClaudeProcessError && /Working directory does not exist/.test(e.message),
    );
  });

  it('converts synchronous spawn errors (NUL byte in argv)', async () => {
    await assert.rejects(startFake({ args: ['--model', 'bad\u0000model'] }), (e: unknown) => e instanceof ClaudeProcessError && /Failed to start/.test(e.message));
  });

  it('rejects when the binary cannot be spawned', async () => {
    await assert.rejects(
      ClaudeProcess.start({
        binary: { path: '/nonexistent/dir/claude', version: '2.1.318', rawVersion: '' },
        args: [...STREAM_ARGS],
        cwd: mkTmp(),
        env: fakeEnv(),
        initialize: {},
        handlers: { onHookCallback: async () => ({}), onCanUseTool: async () => ({ behavior: 'allow' }) },
      }),
      (e: unknown) => e instanceof ClaudeProcessError && /Failed to start Claude Code/.test(e.message),
    );
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('turns', () => {
  it('streams frames until the matching result and tracks session/busy state', async () => {
    const h = await fake({
      args: ['--session-id', SID, '--include-partial-messages'],
      script: { turns: [{ steps: [{ thinking: 'pondering' }, { text: 'Hello world' }] }] },
    });
    const gen = h.proc.turn('hi there');
    assert.equal(h.proc.busy, true);
    assert.throws(() => h.proc.turn('again'), /busy/);
    const { frames, result } = await collectTurn(gen);
    assert.equal(result.type, 'result');
    assert.equal(result.is_error, false);
    assert.equal(result.result, 'Hello world');
    assert.equal(frames[frames.length - 1], result, 'result is yielded last');
    assert.ok(frames.some((f) => f.type === 'system' && (f as { subtype?: string }).subtype === 'init'));
    const deltas = frames.filter(isStreamEvent).map((f) => f.event.delta?.text).filter(Boolean).join('');
    assert.equal(deltas, 'Hello world');
    assert.ok(frames.filter(isAssistantFrame).length >= 2);
    assert.equal(h.proc.busy, false);
    assert.equal(h.proc.sessionId, SID);
    assert.equal(h.proc.lastInit?.session_id, SID);

    const userLine = h.stdinLines().find((l) => l.type === 'user')!;
    assert.deepEqual(Object.keys(userLine).sort(), ['message', 'parent_tool_use_id', 'session_id', 'type', 'uuid']);
    assert.deepEqual(userLine.message, { role: 'user', content: 'hi there' });
    assert.equal(userLine.parent_tool_use_id, null);
    assert.equal(userLine.session_id, '');
    assert.ok(isUuid(userLine.uuid));
    assert.deepEqual(result.user_message_uuids, [userLine.uuid]);
  });

  it('runs several turns sequentially and emits every frame as an event', async () => {
    const h = await fake({ script: { default: { steps: [{ text: 'turn {{turnIndex}}: {{userText}}' }] } } });
    const seen: ClaudeFrame[] = [];
    h.proc.on('frame', (f) => seen.push(f));
    const r1 = await collectTurn(h.proc.turn('one'));
    const r2 = await collectTurn(h.proc.turn('two', { uuid: '11111111-1111-4111-8111-111111111111' }));
    assert.equal(r1.result.result, 'turn 1: one');
    assert.equal(r2.result.result, 'turn 2: two');
    assert.deepEqual(r2.result.user_message_uuids, ['11111111-1111-4111-8111-111111111111']);
    await waitFor(() => seen.filter((f) => f.type === 'command_lifecycle').length >= 6, 3000, 'lifecycle frames');
    assert.ok(seen.filter(isResultFrame).length === 2);
  });

  it('sends content blocks verbatim', async () => {
    const h = await fake({ script: { default: { steps: [{ text: 'got {{userText}}' }] } } });
    const blocks = [
      { type: 'text' as const, text: 'look:' },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ];
    const { result } = await collectTurn(h.proc.turn(blocks));
    assert.equal(result.result, 'got look:[image]');
    const line = h.stdinLines().find((l) => l.type === 'user')!;
    assert.deepEqual((line.message as { content: unknown }).content, blocks);
  });

  it('validates sendUserMessage arguments', async () => {
    const h = await fake();
    assert.throws(() => h.proc.sendUserMessage('x', { uuid: 'nope' }), /must be a UUID/);
    assert.throws(() => h.proc.sendUserMessage([]), /non-empty array/);
    const u = h.proc.sendUserMessage('x', { uuid: SID });
    assert.equal(u, SID);
    assert.throws(() => h.proc.sendUserMessage('y', { uuid: SID }), /already pending/);
    await waitFor(() => !h.proc.busy, 5000, 'result');
  });

  it('sendUserMessage + command_lifecycle/result settle busy without turn()', async () => {
    const h = await fake({ script: { default: { steps: [{ text: 'ok' }] } } });
    const results: ClaudeFrame[] = [];
    h.proc.on('frame', (f) => isResultFrame(f) && results.push(f));
    h.proc.sendUserMessage('a');
    h.proc.sendUserMessage('b');
    assert.equal(h.proc.busy, true);
    await waitFor(() => results.length === 2 && !h.proc.busy, 5000, 'two results');
  });

  it('priority "next" with no tool boundary left is answered in its own turn, inside the same turn()', async () => {
    // claude 2.1.319 folds a `next` line in only at a tool boundary; otherwise it runs it right
    // after the result (VERIFIED), and turn() continues through that turn (see steer-queue.test.ts)
    const h = await fake({ script: { turns: [{ steps: [{ sleepMs: 300 }, { text: 'done' }] }] } });
    const steerUuid = '22222222-2222-4222-8222-222222222222';
    const gen = h.proc.turn('long task');
    const p = collectTurn(gen);
    await new Promise((r) => setTimeout(r, 60));
    h.proc.sendUserMessage('also do X', { uuid: steerUuid, priority: 'next' });
    const { frames, result } = await p;
    assert.ok(result.user_message_uuids?.includes(steerUuid));
    assert.equal(frames.filter((f) => f.type === 'result').length, 2);
    assert.equal(h.proc.busy, false);
    assert.equal(h.stdinLines().find((l) => l.uuid === steerUuid)!.priority, 'next');
  });

  it('local commands: /effort, /model, /clear (new session id), /compact', async () => {
    const h = await fake({ args: ['--session-id', SID] });
    const eff = await collectTurn(h.proc.turn('/effort high'));
    assert.equal(eff.result.local_command, 'effort');
    assert.match(eff.result.result ?? '', /Set effort level to high/);
    assert.equal(eff.result.num_turns, 0);
    assert.deepEqual(((await h.proc.getSettings()) as { applied: { effort: string } }).applied.effort, 'high');

    const mod = await collectTurn(h.proc.turn('/model haiku'));
    assert.equal(mod.result.local_command, 'model');
    assert.equal(h.proc.lastInit?.model, 'claude-opus-5-5', 'init precedes the switch');

    const clr = await collectTurn(h.proc.turn('/clear'));
    assert.equal(clr.result.local_command, 'clear');
    const reset = clr.frames.find((f) => f.type === 'conversation_reset') as { new_conversation_id: string; session_id: string };
    assert.ok(reset);
    assert.equal(reset.session_id, SID);
    assert.notEqual(reset.new_conversation_id, SID);
    assert.equal(h.proc.sessionId, reset.new_conversation_id);
    assert.equal(clr.result.session_id, reset.new_conversation_id);

    // claude 2.1.319 refuses /compact of a conversation with no messages (VERIFIED): right after
    // /clear it answers a failed local command and writes no boundary
    const empty = await collectTurn(h.proc.turn('/compact'));
    assert.equal(empty.result.local_command, 'compact');
    assert.ok(!empty.frames.some((f) => f.type === 'system' && (f as { subtype?: string }).subtype === 'compact_boundary'));
    assert.ok(empty.frames.some((f) => f.type === 'assistant' && (f as { local_command_outcome?: { kind?: string } }).local_command_outcome?.kind === 'failed'));

    await collectTurn(h.proc.turn('remember the API notes'));
    const cmp = await collectTurn(h.proc.turn('/compact keep the API notes'));
    assert.equal(cmp.result.local_command, 'compact');
    assert.ok(cmp.frames.some((f) => f.type === 'system' && (f as { subtype?: string }).subtype === 'compact_boundary'));
    assert.ok(cmp.frames.some((f) => isUserFrame(f) && (f as UserFrame).isSynthetic === true));
    assert.equal(h.proc.sessionId, reset.new_conversation_id, '/compact keeps the session id');
  });

  it('auth failure frames are classified by isAuthError', async () => {
    const h = await fake({ script: { turns: [{ steps: [{ error: 'authentication_failed' }] }] } });
    const { frames, result } = await collectTurn(h.proc.turn('hello'));
    assert.equal(result.is_error, true);
    assert.equal(result.terminal_reason, 'api_error');
    assert.ok(isAuthError(result));
    assert.ok(frames.some((f) => isAssistantFrame(f) && isAuthError(f)));
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('hook_callback gate', () => {
  const bashTool = { tool: { name: 'Bash', input: { command: 'touch x.txt', description: 'Create x' }, result: 'made it' } };

  it('allow: tool runs, no can_use_tool; PostToolUse gets tool_response', async () => {
    const hookCalls: HookCallbackRequest[] = [];
    let canUse = 0;
    const h = await fake({
      initialize: { hooks: HOOKS },
      script: { turns: [{ steps: [bashTool, { text: 'ctx={{lastHookContext}}' }] }] },
      handlers: {
        onHookCallback: async (req) => {
          hookCalls.push(req);
          if (req.input.hook_event_name === 'PostToolUse') {
            return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'POST-NOTE' } };
          }
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'kiro' } };
        },
        onCanUseTool: async () => {
          canUse++;
          return { behavior: 'allow' };
        },
      },
    });
    const { frames, result } = await collectTurn(h.proc.turn('do it'));
    assert.equal(canUse, 0);
    assert.deepEqual(hookCalls.map((c) => [c.callback_id, c.input.hook_event_name]), [
      ['kiro_pre', 'PreToolUse'],
      ['kiro_post', 'PostToolUse'],
    ]);
    const pre = hookCalls[0]!;
    assert.equal(pre.input.tool_name, 'Bash');
    assert.deepEqual(pre.input.tool_input, { command: 'touch x.txt', description: 'Create x' });
    assert.equal(pre.tool_use_id, pre.input.tool_use_id);
    assert.equal(pre.input.session_id, h.proc.sessionId);
    assert.ok(hookCalls[1]!.input.tool_response !== undefined);
    assert.deepEqual(toolResultFrames(frames), [{ content: 'made it', is_error: false }]);
    assert.equal(result.result, 'ctx=POST-NOTE');
    assert.deepEqual(result.permission_denials, []);
  });

  it('deny: model sees "PreToolUse:<Tool> hook error: <reason>" and the call is a permission denial', async () => {
    const h = await fake({
      initialize: { hooks: HOOKS },
      script: { turns: [{ steps: [bashTool, { text: 'saw: {{lastToolResult}}' }] }] },
      handlers: {
        onHookCallback: async () => ({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Kiro says no' },
        }),
      },
    });
    const { frames, result } = await collectTurn(h.proc.turn('do it'));
    assert.deepEqual(toolResultFrames(frames), [{ content: 'PreToolUse:Bash hook error: Kiro says no', is_error: true }]);
    assert.equal(result.result, 'saw: PreToolUse:Bash hook error: Kiro says no');
    assert.equal(result.permission_denials?.length, 1);
    assert.equal(result.permission_denials?.[0]?.tool_name, 'Bash');
    assert.equal(result.is_error, false, 'a denial does not fail the turn');
  });

  it('ask -> can_use_tool -> allow with updatedInput', async () => {
    const perms: CanUseToolRequest[] = [];
    const h = await fake({
      initialize: { hooks: HOOKS },
      script: { turns: [{ steps: [{ tool: { name: 'Read', input: { file_path: '/abs/secret.txt' } } }] }] },
      handlers: {
        onHookCallback: async (req) =>
          req.input.hook_event_name === 'PreToolUse'
            ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'kiro: approval required for read' } }
            : {},
        onCanUseTool: async (req) => {
          perms.push(req);
          return { behavior: 'allow', updatedInput: { file_path: '/abs/other.txt' } };
        },
      },
    });
    const { frames } = await collectTurn(h.proc.turn('read it'));
    assert.equal(perms.length, 1);
    assert.equal(perms[0]!.tool_name, 'Read');
    assert.equal(perms[0]!.decision_reason, 'kiro: approval required for read');
    assert.equal(perms[0]!.decision_reason_type, 'hook');
    assert.equal(perms[0]!.blocked_path, '/abs/secret.txt');
    assert.deepEqual(toolResultFrames(frames), [{ content: '1\tcontents of /abs/other.txt', is_error: false }]);
  });

  it('ask -> can_use_tool -> deny: message shown verbatim, turn continues', async () => {
    const h = await fake({
      initialize: { hooks: HOOKS },
      script: { turns: [{ steps: [bashTool, { text: 'after deny' }] }] },
      handlers: {
        onHookCallback: async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }),
        onCanUseTool: async () => ({ behavior: 'deny', message: 'I deny this tool request. Ask a follow up question clarifying the expected action' }),
      },
    });
    const { frames, result } = await collectTurn(h.proc.turn('go'));
    assert.deepEqual(toolResultFrames(frames), [
      { content: 'I deny this tool request. Ask a follow up question clarifying the expected action', is_error: true },
    ]);
    assert.equal(result.is_error, false);
    assert.equal(result.result, 'after deny');
    assert.equal(result.permission_denials?.length, 1);
  });

  it('deny + interrupt ends the turn with error_during_execution', async () => {
    const h = await fake({
      script: { turns: [{ steps: [bashTool, { text: 'never' }] }] },
      handlers: { onCanUseTool: async () => ({ behavior: 'deny', message: 'Tool use was cancelled by the user', interrupt: true }) },
    });
    const { frames, result } = await collectTurn(h.proc.turn('go'));
    assert.equal(result.is_error, true);
    assert.equal(result.subtype, 'error_during_execution');
    assert.equal(result.terminal_reason, 'aborted_tools');
    assert.ok(!frames.some((f) => isAssistantFrame(f) && JSON.stringify(f).includes('never')));
    const again = await collectTurn(h.proc.turn('still alive?'));
    assert.equal(again.result.is_error, false, 'process is reusable');
  });

  it('a throwing hook handler is answered with an error (onFailure block => deny)', async () => {
    const h = await fake({
      initialize: { hooks: HOOKS },
      script: { turns: [{ steps: [bashTool] }] },
      handlers: {
        onHookCallback: async () => {
          throw new Error('gate exploded');
        },
      },
    });
    const { frames } = await collectTurn(h.proc.turn('go'));
    // Text VERIFIED against claude 2.1.318 (the host's error message is not shown to the model).
    assert.deepEqual(toolResultFrames(frames), [
      {
        content:
          'PreToolUse:Bash hook error: [callback]: failed; blocking because onFailure is "block"\n' +
          'Hook callback kiro_pre failed: the SDK host replied with an error or an invalid answer.',
        is_error: true,
      },
    ]);
    const errs = h.stdinLines().filter((l) => l.type === 'control_response' && (l.response as { subtype: string }).subtype === 'error');
    assert.equal(errs.length, 1);
    assert.equal((errs[0]!.response as { error: string }).error, 'gate exploded');
  });

  it('a synchronous throw and an invalid PermissionResult are answered with errors', async () => {
    let calls = 0;
    const onCanUseTool = ((): Promise<never> => {
      if (calls++ === 0) throw new Error('sync boom');
      return Promise.resolve({ behavior: 'maybe' } as never);
    }) as unknown as (req: CanUseToolRequest) => Promise<never>;
    const h = await fake({ script: { turns: [{ steps: [bashTool] }, { steps: [bashTool] }] }, handlers: { onCanUseTool } });
    const a = await collectTurn(h.proc.turn('one'));
    assert.deepEqual(toolResultFrames(a.frames), [{ content: 'Permission request failed: sync boom', is_error: true }]);
    const b = await collectTurn(h.proc.turn('two'));
    assert.deepEqual(toolResultFrames(b.frames), [{ content: 'Permission request failed: invalid PermissionResult behavior: maybe', is_error: true }]);
  });

  it('every CLI request is answered exactly once', async () => {
    const h = await fake({
      initialize: { hooks: HOOKS },
      script: { turns: [{ steps: [bashTool, bashTool, { tool: { name: 'Read', input: { file_path: '/f' } } }] }] },
      handlers: {
        onHookCallback: async (req) =>
          req.input.hook_event_name === 'PreToolUse'
            ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: req.input.tool_name === 'Read' ? 'ask' : 'allow' } }
            : {},
      },
    });
    await collectTurn(h.proc.turn('go'));
    const sent = h
      .log()
      .filter((e) => e.event === 'stdin' && (e.line as { type?: string })?.type === 'control_response')
      .map((e) => ((e.line as { response: { request_id: string } }).response.request_id));
    assert.equal(sent.length, 3 + 3 + 1, '3 PreToolUse + 3 PostToolUse + 1 can_use_tool');
    assert.equal(new Set(sent).size, sent.length, 'no duplicates');
    assert.equal(h.log().filter((e) => e.event === 'unmatched_control_response').length, 0);
  });

  it('parallel tool calls: hook callbacks are handled concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = await fake({
      initialize: { hooks: { PreToolUse: HOOKS.PreToolUse } },
      script: {
        turns: [
          {
            steps: [
              { parallel: [{ name: 'Read', input: { file_path: '/a' } }, { name: 'Read', input: { file_path: '/b' } }] },
              { text: 'both done' },
            ],
          },
        ],
      },
      handlers: {
        onHookCallback: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (inFlight === 2) release();
          await gate;
          inFlight--;
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
        },
      },
    });
    const { frames, result } = await collectTurn(h.proc.turn('read both'));
    assert.equal(maxInFlight, 2);
    assert.equal(toolResultFrames(frames).length, 2);
    assert.equal(result.result, 'both done');
  });

  it('other CLI requests: default error, or onOtherControlRequest', async () => {
    const script = { default: { steps: [{ control: { subtype: 'elicitation', message: 'pick' } }, { text: '{{lastControlResponse}}' }] } };
    const h = await fake({ script });
    const a = await collectTurn(h.proc.turn('x'));
    const resp = JSON.parse(a.result.result ?? '{}') as { subtype: string; error: string };
    assert.equal(resp.subtype, 'error');
    assert.equal(resp.error, 'Unsupported control request subtype: elicitation');

    const seen: string[] = [];
    const h2 = await fake({
      script,
      handlers: {
        onOtherControlRequest: (subtype, request) => {
          seen.push(`${subtype}:${String(request.message)}`);
          return Promise.resolve({ action: 'decline' });
        },
      },
    });
    const b = await collectTurn(h2.proc.turn('x'));
    const ok = JSON.parse(b.result.result ?? '{}') as { subtype: string; response: unknown };
    assert.equal(ok.subtype, 'success');
    assert.deepEqual(ok.response, { action: 'decline' });
    assert.deepEqual(seen, ['elicitation:pick']);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('cancellation and interrupts', () => {
  it('control_cancel_request aborts the handler signal and the request is not answered', async () => {
    let captured: { requestId: string; signal: AbortSignal } | undefined;
    const h = await fake({
      script: { turns: [{ steps: [{ tool: { name: 'Bash', input: { command: 'rm -rf x' }, cancelAfterMs: 150 } }, { text: 'never' }] }] },
      handlers: {
        onCanUseTool: (req, ctx) => {
          captured = ctx;
          void req;
          return new Promise((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve({ behavior: 'allow' }));
          });
        },
      },
    });
    const { result } = await collectTurn(h.proc.turn('go'));
    assert.ok(captured);
    assert.equal(captured.signal.aborted, true);
    assert.equal(result.is_error, true);
    assert.equal(result.subtype, 'error_during_execution');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(controlResponsesFor(h, captured.requestId), [], 'cancelled request never answered');
    assert.ok(h.log().some((e) => e.event === 'cancel_sent' && e.request_id === captured!.requestId));
  });

  it('interrupt() during a running turn ends it; the process stays usable', async () => {
    const h = await fake({ script: { turns: [{ steps: [{ text: 'starting' }, { sleepMs: 5000 }, { text: 'never' }] }], default: { steps: [{ text: 'ALIVE' }] } } });
    const p = collectTurn(h.proc.turn('slow'));
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await h.proc.interrupt();
    const { result } = await p;
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(result.is_error, true);
    assert.equal(result.subtype, 'error_during_execution');
    assert.equal(result.terminal_reason, 'aborted_streaming');
    const next = await collectTurn(h.proc.turn('ping'));
    assert.equal(next.result.result, 'ALIVE');
  });

  it('interrupt while can_use_tool is pending withdraws the prompt', async () => {
    let signal: AbortSignal | undefined;
    const h = await fake({
      script: { turns: [{ steps: [{ tool: { name: 'Write', input: { file_path: '/w.txt', content: 'w' } } }] }] },
      handlers: {
        onCanUseTool: (_req, ctx) => {
          signal = ctx.signal;
          return new Promise(() => undefined); // user never answers
        },
      },
    });
    const p = collectTurn(h.proc.turn('write'));
    await waitFor(() => signal !== undefined, 3000, 'can_use_tool');
    await h.proc.interrupt();
    const { result } = await p;
    assert.equal(signal!.aborted, true);
    assert.equal(result.terminal_reason, 'aborted_tools');
  });

  it('aborting the turn signal sends interrupt', async () => {
    const h = await fake({ script: { turns: [{ steps: [{ tool: { name: 'Bash', input: { command: 'sleep 9' }, durationMs: 5000 } }] }] } });
    const ac = new AbortController();
    const p = collectTurn(h.proc.turn('go', { signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    const { result, frames } = await p;
    assert.equal(result.is_error, true);
    assert.equal(result.terminal_reason, 'aborted_tools');
    assert.ok(h.stdinLines().some((l) => l.type === 'control_request' && (l.request as { subtype: string }).subtype === 'interrupt'));
    assert.match(toolResultFrames(frames)[0]!.content, /stopped while running/);
  });

  it('an already-aborted signal throws before sending', async () => {
    const h = await fake();
    const ac = new AbortController();
    ac.abort(new Error('nope'));
    assert.throws(() => h.proc.turn('x', { signal: ac.signal }), /nope/);
    assert.equal(h.proc.busy, false);
  });

  it('breaking out of a turn early keeps busy until the result arrives', async () => {
    const h = await fake({ script: { turns: [{ steps: [{ text: 'a' }, { sleepMs: 200 }, { text: 'b' }] }], default: { steps: [{ text: 'next' }] } } });
    for await (const f of h.proc.turn('x')) {
      if (isAssistantFrame(f)) break;
    }
    assert.equal(h.proc.busy, true);
    await waitFor(() => !h.proc.busy, 5000, 'result after break');
    const { result } = await collectTurn(h.proc.turn('y'));
    assert.equal(result.result, 'next');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('robustness', () => {
  it('child crash mid-turn: frames so far are yielded, then ClaudeProcessError', async () => {
    const h = await fake({ script: { turns: [{ steps: [{ text: 'partial answer' }, { exit: 7, stderr: 'FATAL: boom' }] }] } });
    const exits: unknown[] = [];
    h.proc.on('exit', (i) => exits.push(i));
    const gen = h.proc.turn('go');
    const frames: ClaudeFrame[] = [];
    let err: unknown;
    try {
      for await (const f of gen) frames.push(f);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ClaudeProcessError, String(err));
    assert.equal(err.exitCode, 7);
    assert.match(err.stderr, /FATAL: boom/);
    assert.match(err.message, /exit code 7.*FATAL: boom/);
    assert.ok(frames.some((f) => isAssistantFrame(f)));
    assert.deepEqual(exits, [{ code: 7, signal: null }]);
    assert.equal(h.proc.busy, false);
    assert.equal(h.proc.running, false);
    assert.deepEqual(await h.proc.exited, { code: 7, signal: null });
    await assert.rejects(h.proc.request('get_settings'), ClaudeProcessError);
    assert.throws(() => h.proc.sendUserMessage('x'), ClaudeProcessError);
    assert.deepEqual(await h.proc.close(), { code: 7, signal: null });
  });

  it('pending host requests reject and handler signals abort when the child exits', async () => {
    let signal: AbortSignal | undefined;
    const h = await fake({
      env: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ get_context_usage: 5000 }) },
      script: { turns: [{ steps: [{ tool: { name: 'Write', input: { file_path: '/w', content: '' } } }] }] },
      handlers: {
        onCanUseTool: (_r, ctx) => {
          signal = ctx.signal;
          return new Promise(() => undefined);
        },
      },
    });
    const turn = collectTurn(h.proc.turn('w')).catch((e: unknown) => e);
    await waitFor(() => signal !== undefined, 3000, 'can_use_tool');
    const ctxReq = h.proc.getContextUsage();
    const closed = h.proc.close({ graceMs: 2000 });
    await assert.rejects(ctxReq, ClaudeProcessError);
    assert.equal(signal!.aborted, true);
    const turnOutcome = await turn;
    // The fake aborts the turn on EOF, so the turn either completes with an error result or the
    // process exits first; both are acceptable, but it must settle.
    assert.ok(turnOutcome instanceof ClaudeProcessError || (turnOutcome as { result?: { is_error?: boolean } }).result?.is_error === true);
    await closed;
  });

  it('malformed lines raise protocolError and are skipped; unknown frames pass through', async () => {
    const h = await fake({
      script: {
        turns: [
          {
            steps: [
              { raw: 'this is not json' },
              { raw: '[1,2,3]' },
              { raw: '{"no_type":true}' },
              { raw: '{"type":"active_goal","goal":"x"}\r' },
              { raw: '' },
              { frame: { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } } },
              { text: 'still fine' },
            ],
          },
        ],
      },
    });
    const errs: Array<[string, string]> = [];
    h.proc.on('protocolError', (e, line) => errs.push([e.message, line]));
    const { frames, result } = await collectTurn(h.proc.turn('go'));
    assert.equal(result.result, 'still fine');
    assert.deepEqual(errs.map(([, l]) => l), ['this is not json', '[1,2,3]', '{"no_type":true}']);
    assert.match(errs[0]![0], /Non-JSON/);
    assert.ok(frames.some((f) => f.type === 'active_goal'));
    assert.ok(frames.some((f) => f.type === 'rate_limit_event'));
  });

  it('a throwing frame listener does not break the reader', async () => {
    const h = await fake({ script: { default: { steps: [{ text: 'a' }, { text: 'b' }] } } });
    let thrown = 0;
    const errs: string[] = [];
    h.proc.on('protocolError', (e) => errs.push(e.message));
    h.proc.on('frame', (f) => {
      if (isAssistantFrame(f) && thrown++ === 0) throw new Error('listener bug');
    });
    const { result } = await collectTurn(h.proc.turn('go'));
    assert.equal(result.result, 'ab');
    assert.ok(errs.some((m) => /Frame handler threw: listener bug/.test(m)));
  });

  it('emits stderr chunks and keeps a tail', async () => {
    const chunks: string[] = [];
    const h = await fake({ env: { FAKE_CLAUDE_STDERR: 'startup warning' }, script: { default: { steps: [{ stderr: 'mid-turn note' }, { text: 'ok' }] } } });
    h.proc.on('stderr', (c) => chunks.push(c));
    await collectTurn(h.proc.turn('go'));
    await waitFor(() => /mid-turn note/.test(h.proc.stderrTail), 2000, 'stderr');
    assert.match(h.proc.stderrTail, /startup warning/);
    assert.ok(chunks.join('').includes('mid-turn note'));
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('host control requests', () => {
  it('matches responses by request_id even when answered out of order', async () => {
    const h = await fake({
      args: ['--mcp-config', JSON.stringify({ mcpServers: { kecho: { command: 'node', fakeTools: ['echo'] }, bad: { command: 'x', fakeStatus: 'failed' } } })],
      env: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ get_context_usage: 150 }) },
    });
    const order: string[] = [];
    const ctx = h.proc.getContextUsage().then((v) => (order.push('ctx'), v));
    const mcp = h.proc.mcpStatus().then((v) => (order.push('mcp'), v));
    const settings = h.proc.getSettings().then((v) => (order.push('settings'), v));
    const [c, m, s] = await Promise.all([ctx, mcp, settings]);
    assert.equal(order[order.length - 1], 'ctx');
    assert.equal(typeof c.maxTokens, 'number');
    assert.equal(c.maxTokens, 1_000_000);
    assert.ok(c.percentage >= 0);
    assert.deepEqual(m.mcpServers.map((x) => [x.name, x.status]), [['kecho', 'connected'], ['bad', 'failed']]);
    assert.deepEqual(m.mcpServers[0]!.tools?.map((t) => t.name), ['echo']);
    assert.ok((s as { applied: { model: string } }).applied.model);
    const ids = h.stdinLines().filter((l) => l.type === 'control_request').map((l) => l.request_id);
    assert.equal(new Set(ids).size, ids.length, 'unique request ids');
  });

  it('rejects with ClaudeControlError on an error answer', async () => {
    const h = await fake();
    await assert.rejects(
      h.proc.request('bogus_subtype'),
      (e: unknown) => e instanceof ClaudeControlError && e.message === 'Unsupported control request subtype: bogus_subtype' && e.subtype === 'bogus_subtype',
    );
  });

  it('times out; a late response is ignored', async () => {
    const h = await fake({ env: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ get_settings: 300 }) } });
    await assert.rejects(h.proc.request('get_settings', {}, { timeoutMs: 50 }), (e: unknown) => e instanceof ClaudeControlError && e.timedOut);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(await h.proc.getSettings());
  });

  it('payload cannot override the subtype; resolves undefined for empty answers', async () => {
    const h = await fake();
    assert.equal(await h.proc.request('set_max_thinking_tokens', { subtype: 'evil', max_thinking_tokens: 0 }), undefined);
    const line = h.stdinLines().find((l) => (l.request as { subtype?: string } | undefined)?.subtype === 'set_max_thinking_tokens');
    assert.ok(line);
  });

  it('setModel switches the model for the next turn; null resets', async () => {
    const h = await fake();
    assert.deepEqual(await h.proc.setModel('haiku'), { model: 'claude-haiku-5-5' });
    await collectTurn(h.proc.turn('x'));
    assert.equal(h.proc.lastInit?.model, 'claude-haiku-5-5');
    assert.deepEqual(await h.proc.setModel(null), { model: 'claude-opus-5-5' });
    const line = h.stdinLines().filter((l) => (l.request as { subtype?: string } | undefined)?.subtype === 'set_model').pop()!;
    assert.deepEqual(line.request, { model: null, subtype: 'set_model' });
  });

  it('interrupt() when idle resolves', async () => {
    const h = await fake();
    await h.proc.interrupt();
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('close()', () => {
  it('ends stdin and resolves with exit code 0; idempotent', async () => {
    const h = await fake();
    await collectTurn(h.proc.turn('x'));
    const a = h.proc.close();
    const b = h.proc.close();
    assert.equal(a, b);
    assert.deepEqual(await a, { code: 0, signal: null });
    assert.ok(h.log().some((e) => e.event === 'stdin_end'));
    await assert.rejects(h.proc.getSettings(), ClaudeProcessError);
  });

  it('exit code 1 when the last result was an error', async () => {
    const h = await fake({ script: { default: { steps: [{ error: 'authentication_failed' }] } } });
    await collectTurn(h.proc.turn('x'));
    assert.deepEqual(await h.proc.close(), { code: 1, signal: null });
  });

  it('escalates to SIGTERM after the grace period', async () => {
    const h = await fake({ env: { FAKE_CLAUDE_HANG_ON_EOF: '1' } });
    const t0 = Date.now();
    const info = await h.proc.close({ graceMs: 100 });
    assert.deepEqual(info, { code: 143, signal: null });
    assert.ok(h.log().some((e) => e.event === 'sigterm'));
    assert.ok(Date.now() - t0 < 2000);
  });

  it('escalates to SIGKILL when SIGTERM is ignored', { skip: process.platform === 'win32' }, async () => {
    const h = await fake({ env: { FAKE_CLAUDE_HANG_ON_EOF: '1', FAKE_CLAUDE_IGNORE_SIGTERM: '1' } });
    const info = await h.proc.close({ graceMs: 50 });
    assert.deepEqual(info, { code: null, signal: 'SIGKILL' });
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('session id tracking', () => {
  it('fork: unknown until init, then the new id', async () => {
    const h = await fake({ args: ['--resume', SID, '--fork-session'] });
    assert.equal(h.proc.sessionId, undefined);
    await collectTurn(h.proc.turn('x'));
    assert.ok(h.proc.sessionId && h.proc.sessionId !== SID);
  });
  it('resume keeps the id', async () => {
    const h = await fake({ args: ['--resume', SID] });
    assert.equal(h.proc.sessionId, SID);
    const { result } = await collectTurn(h.proc.turn('x'));
    assert.equal(result.session_id, SID);
  });
});

