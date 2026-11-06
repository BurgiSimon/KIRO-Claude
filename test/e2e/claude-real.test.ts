/**
 * End-to-end tests against the REAL installed Claude Code CLI (model calls on your account).
 * Skipped unless KIRO_CLAUDE_E2E=1.
 *
 *   KIRO_CLAUDE_E2E=1 node --test dist/test/e2e/claude-real.test.js
 *
 * Model: ${KIRO_CLAUDE_E2E_MODEL:-haiku}. Temp dirs (and the Claude project dirs the real CLI creates
 * for them) are removed afterwards unless KIRO_CLAUDE_E2E_KEEP=1 (see ./helpers.ts).
 *
 * Covers: findClaudeBinary + probeCapabilities + buildChildEnv + ClaudeProcess
 * (00 §3.1 spawn, §3.3 initialize, §3.4 user turn, §3.5 hook_callback deny — VERIFIED 07).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { findClaudeBinary, probeCapabilities, type ClaudeBinary, type ClaudeCapabilities } from '../../src/claude/binary.js';
import { buildChildEnv } from '../../src/claude/env.js';
import { ClaudeProcess, type ClaudeHandlers } from '../../src/claude/process.js';
import {
  isUserFrame,
  toolResultText,
  toolResults,
  type CanUseToolRequest,
  type ClaudeFrame,
  type HookCallbackRequest,
  type ResultFrame,
  type UserFrame,
} from '../../src/claude/protocol.js';
import { KEEP, MODEL, removeClaudeProjectDir } from './helpers.js';

const E2E = process.env.KIRO_CLAUDE_E2E === '1';
const TURN_TIMEOUT_MS = 150_000;

function baseArgs(caps: ClaudeCapabilities, tools: string): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio',
    '--model', MODEL,
    '--permission-mode', 'default',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--tools', tools,
    ...(caps.has('--no-session-persistence') ? ['--no-session-persistence'] : []),
    '--session-id', randomUUID(),
  ];
}

async function runTurn(proc: ClaudeProcess, text: string): Promise<{ frames: ClaudeFrame[]; result: ResultFrame }> {
  const frames: ClaudeFrame[] = [];
  const gen = proc.turn(text);
  const timer = setTimeout(() => void proc.interrupt().catch(() => undefined), TURN_TIMEOUT_MS);
  try {
    for (;;) {
      const r = await gen.next();
      if (r.done) return { frames, result: r.value };
      frames.push(r.value);
    }
  } finally {
    clearTimeout(timer);
  }
}

describe('real Claude Code CLI (KIRO_CLAUDE_E2E=1)', { skip: E2E ? false : 'set KIRO_CLAUDE_E2E=1 to run' }, () => {
  let bin: ClaudeBinary;
  let caps: ClaudeCapabilities;
  const procs: ClaudeProcess[] = [];
  const dirs: string[] = [];

  before(async () => {
    bin = await findClaudeBinary();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-e2e-cache-'));
    dirs.push(cacheDir);
    caps = await probeCapabilities(bin, { cacheDir });
  });

  after(async () => {
    await Promise.all(procs.map((p) => p.close().catch(() => undefined)));
    if (KEEP) return;
    for (const d of dirs) {
      removeClaudeProjectDir(d);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('finds a usable claude and probes the flags the adapter needs', () => {
    assert.match(bin.version, /^\d+\.\d+\.\d+/);
    for (const f of ['--print', '--input-format', '--output-format', '--verbose', '--permission-prompt-tool', '--setting-sources', '--tools', '--model']) {
      assert.ok(caps.has(f), `missing ${f}`);
    }
  });

  it('one text turn', { timeout: 200_000 }, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-e2e-'));
    dirs.push(cwd);
    const handlers: ClaudeHandlers = {
      onHookCallback: async () => ({}),
      onCanUseTool: async () => ({ behavior: 'deny', message: 'no tools in this test' }),
    };
    const proc = await ClaudeProcess.start({
      binary: bin,
      args: baseArgs(caps, ''),
      cwd,
      env: buildChildEnv(process.env),
      initialize: {},
      handlers,
    });
    procs.push(proc);
    assert.ok(Array.isArray(proc.initializeResponse.models) && proc.initializeResponse.models.length > 0, 'initialize lists models');

    const { frames, result } = await runTurn(proc, 'Reply with exactly the word PONG and nothing else.');
    assert.equal(result.is_error, false, `turn failed: ${JSON.stringify(result).slice(0, 500)}`);
    assert.match(result.result ?? '', /PONG/);
    assert.ok(frames.some((f) => f.type === 'system' && (f as { subtype?: string }).subtype === 'init'));
    assert.equal(proc.lastInit?.apiKeySource, 'none', 'subscription auth (no API key) expected');
    assert.equal(proc.sessionId, proc.lastInit?.session_id);
    const info = await proc.close();
    assert.equal(info.code, 0);
  });

  it('gate: a PreToolUse hook callback denies Read and the model sees the reason', { timeout: 200_000 }, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-e2e-gate-'));
    dirs.push(cwd);
    fs.writeFileSync(path.join(cwd, 'secret.txt'), 'TOPSECRET-1234\n');
    const reason = 'KIRO-GATE-7731 reading secret files is blocked by policy';
    const hookCalls: HookCallbackRequest[] = [];
    const permCalls: CanUseToolRequest[] = [];
    const handlers: ClaudeHandlers = {
      onHookCallback: async (req) => {
        hookCalls.push(req);
        if (req.input.hook_event_name === 'PreToolUse' && req.input.tool_name === 'Read') {
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
        }
        return {};
      },
      onCanUseTool: async (req) => {
        permCalls.push(req);
        return { behavior: 'deny', message: 'unexpected can_use_tool' };
      },
    };
    const proc = await ClaudeProcess.start({
      binary: bin,
      args: baseArgs(caps, 'Read'),
      cwd,
      env: buildChildEnv(process.env),
      initialize: { hooks: { PreToolUse: [{ hookCallbackIds: ['kiro_pre'], timeout: 600, onFailure: 'block' }] } },
      handlers,
    });
    procs.push(proc);

    const { frames, result } = await runTurn(
      proc,
      'Use the Read tool to read the file secret.txt in the current directory. ' +
        'If the tool call fails, reply with the exact error text you received, verbatim, and nothing else.',
    );
    assert.equal(result.is_error, false, `turn failed: ${JSON.stringify(result).slice(0, 500)}`);

    const pre = hookCalls.filter((c) => c.callback_id === 'kiro_pre' && c.input.hook_event_name === 'PreToolUse');
    assert.ok(pre.length >= 1, 'PreToolUse callback fired');
    assert.equal(pre[0]!.input.tool_name, 'Read');
    assert.match(String(pre[0]!.input.tool_input?.file_path), /secret\.txt$/);
    assert.equal(permCalls.length, 0, 'deny never reaches can_use_tool');

    const denied = frames
      .filter(isUserFrame)
      .flatMap((f) => toolResults(f as UserFrame))
      .filter((b) => b.is_error === true)
      .map(toolResultText);
    assert.ok(
      denied.some((t) => t.includes(`PreToolUse:Read hook error: ${reason}`)),
      `tool_result seen by the model: ${JSON.stringify(denied)}`,
    );
    assert.ok(result.permission_denials?.some((d) => d.tool_name === 'Read'), 'listed in permission_denials');
    assert.match(result.result ?? '', /KIRO-GATE-7731/, 'the model repeated the denial reason');
    assert.doesNotMatch(result.result ?? '', /TOPSECRET-1234/, 'the file was not read');
  });
});
