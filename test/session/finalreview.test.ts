/**
 * Guards for the final-review findings fixed in session/: F1 (a queued carry survives a prompt
 * Claude never received), F4 (non-interactive sessions take `mcp.noInteractiveTimeout`), F6 (a
 * prompt's usage covers every Claude turn it ran), F7 (a subagent is listed only once its Agent
 * call may run), F8 (`/chat load` keeps a pending tangent carry), F9 (a tangent opened before
 * main's next prompt sees what was merged into main).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { claudeSettingsEnv, importSessionExport, KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionEvent } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

async function open(sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<{ s: KiroSessionImpl; ui: RecordingUI }> {
  const s = await KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, ...over });
  return { s, ui };
}

function contentText(line: Record<string, unknown>): string {
  const c = (line.message as { content: unknown }).content;
  if (typeof c === 'string') return c;
  return (c as { type: string; text?: string }[]).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');
}

function lastUserText(sb: Sandbox): string {
  const lines = sb.userLines();
  return contentText(lines[lines.length - 1]!);
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const TANGENT_SCRIPT = {
  turns: [{ repeat: true, match: '^Summarize the findings', steps: [{ text: 'SUMMARY: the tangent found FOUND_X' }] }],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};

// ───────────────────────────── F1 ─────────────────────────────

describe('F1: queued context is consumed only by a line Claude actually received', () => {
  const SLOW_HOOK = { userPromptSubmit: [{ command: 'if grep -q SLOW; then sleep 5; fi; true' }] };

  for (const mode of ['merge', 'tail'] as const) {
    it(`a /tangent ${mode} carry survives a main prompt cancelled during its userPromptSubmit hook`, async () => {
      const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
      sb.agent('slowhook', { tools: ['*'], hooks: SLOW_HOOK });
      const { s } = await open(sb, { agentName: 'slowhook' });
      const tag = mode === 'merge' ? 'tangent-summary' : 'tangent-tail';
      try {
        await drain(s.prompt({ text: 'm1' }));
        const mainId = s.id;
        await s.enterTangent('research');
        await drain(s.prompt({ text: 'finding FOUND_X' }));
        await s.exitTangent(mode);
        const p = drain(s.prompt({ text: 'SLOW question' }));
        await sleep(400);
        await s.interrupt();
        const { result } = await p;
        assert.equal(result.stopReason, 'cancelled');
        assert.ok(!sb.userLines().some((l) => contentText(l).includes('SLOW question')), 'Claude never received the cancelled prompt');
        assert.match((s.record.pendingContext ?? []).join('\n'), new RegExp(tag), 'still queued in memory');
        assert.match(new SessionStore(sb.sessionsDir).read(mainId)?.pendingContext?.join('\n') ?? '', new RegExp(tag), 'still queued on disk');
        await drain(s.prompt({ text: 'what did the tangent find?' }));
        const sent = lastUserText(sb);
        assert.match(sent, new RegExp(`<${tag} name="research">[\\s\\S]*FOUND_X[\\s\\S]*what did the tangent find\\?`));
        assert.equal(count(sent, `<${tag}`), 1, 'restored once, not doubled');
        assert.equal(s.record.pendingContext, undefined, 'consumed by the line Claude got');
        await drain(s.prompt({ text: 'again' }));
        assert.doesNotMatch(lastUserText(sb), new RegExp(tag), 'delivered once');
      } finally {
        await closeAll(s);
      }
    });
  }

  it('a first-turn agent-action prompt survives a first prompt cancelled before it was sent', async () => {
    const sb = mkSandbox();
    sb.agent('slowhook', { tools: ['*'], hooks: SLOW_HOOK });
    sb.write('.kiro/hooks/first.json', JSON.stringify({ version: 'v1', hooks: [{ name: 'first', trigger: 'SessionStart', action: { type: 'agent', prompt: 'FIRST-TURN-PROMPT' } }] }));
    const { s } = await open(sb, { agentName: 'slowhook' });
    try {
      const p = drain(s.prompt({ text: 'SLOW start' }));
      await sleep(400);
      await s.interrupt();
      assert.equal((await p).result.stopReason, 'cancelled');
      assert.equal(sb.userLines().length, 0, 'nothing reached Claude');
      await drain(s.prompt({ text: 'one' }));
      assert.match(lastUserText(sb), /FIRST-TURN-PROMPT/);
      await drain(s.prompt({ text: 'two' }));
      assert.doesNotMatch(lastUserText(sb), /FIRST-TURN-PROMPT/);
    } finally {
      await closeAll(s);
    }
  });
});

// ───────────────────────────── F4 ─────────────────────────────

describe('F4: the MCP start-up limit follows the session kind', () => {
  const stub = (vals: Record<string, unknown>) => ({ get: (k: string) => vals[k] });

  it('non-interactive: mcp.noInteractiveTimeout (only when set), never mcp.initTimeout', () => {
    const ni = { interactive: false };
    assert.deepEqual(claudeSettingsEnv(stub({ 'mcp.initTimeout': 1500, 'mcp.noInteractiveTimeout': 60000 }), ni), { MCP_TIMEOUT: '60000' });
    assert.deepEqual(claudeSettingsEnv(stub({ 'mcp.initTimeout': 1500 }), ni), {});
    assert.deepEqual(claudeSettingsEnv(stub({ 'mcp.noInteractiveTimeout': '4500' }), ni), { MCP_TIMEOUT: '4500' });
    assert.deepEqual(claudeSettingsEnv(stub({ 'mcp.noInteractiveTimeout': 0 }), ni), {});
    assert.deepEqual(claudeSettingsEnv(stub({}), ni), {});
  });

  it('interactive: mcp.initTimeout never shortens Claude Code’s own 30 s limit; noInteractiveTimeout is ignored', () => {
    assert.deepEqual(claudeSettingsEnv(stub({ 'mcp.initTimeout': 1500 })), {});
    assert.deepEqual(claudeSettingsEnv(stub({ 'mcp.initTimeout': 30000 }), { interactive: true }), {});
    assert.deepEqual(claudeSettingsEnv(stub({ 'mcp.initTimeout': 45000, 'mcp.noInteractiveTimeout': 1000 }), { interactive: true }), { MCP_TIMEOUT: '45000' });
    assert.deepEqual(claudeSettingsEnv(stub({ 'mcp.noInteractiveTimeout': 60000 }), { interactive: true }), {});
  });

  it('a non-interactive session hands its child noInteractiveTimeout; the user env still wins', async () => {
    const sb = mkSandbox();
    sb.write('.kiro/settings/cli.json', JSON.stringify({ 'mcp.initTimeout': 1500, 'mcp.noInteractiveTimeout': 60000 }));
    const { s } = await open(sb, { interactive: false, origin: 'headless' });
    const childEnv = (): NodeJS.ProcessEnv => (s as unknown as { childEnv(): NodeJS.ProcessEnv }).childEnv();
    try {
      assert.equal(childEnv().MCP_TIMEOUT, '60000');
      sb.env.MCP_TIMEOUT = '1234';
      assert.equal(childEnv().MCP_TIMEOUT, '1234');
    } finally {
      delete sb.env.MCP_TIMEOUT;
      await closeAll(s);
    }
    const { s: i } = await open(sb);
    try {
      assert.equal((i as unknown as { childEnv(): NodeJS.ProcessEnv }).childEnv().MCP_TIMEOUT, undefined, 'interactive: a 1.5 s initTimeout is no hard limit');
    } finally {
      await closeAll(i);
    }
  });
});

// ───────────────────────────── F6 ─────────────────────────────

describe('F6: a prompt reports the usage of every Claude turn it ran', () => {
  function claudeResults(sb: Sandbox): Array<{ usage?: { input_tokens?: number; output_tokens?: number }; num_turns?: number }> {
    return sb
      .log()
      .filter((e) => e.event === 'stdout' && (e.frame as { type?: string } | undefined)?.type === 'result')
      .map((e) => e.frame as { usage?: { input_tokens?: number; output_tokens?: number }; num_turns?: number });
  }
  const sum = (rs: ReturnType<typeof claudeResults>, k: 'input_tokens' | 'output_tokens'): number => rs.reduce((a, r) => a + (r.usage?.[k] ?? 0), 0);

  it('Stop-hook continuation: usage and numTurns are summed', async () => {
    const sb = mkSandbox({
      script: { turns: [{ match: '^start', steps: [{ text: 'first answer with several words in it' }] }, { match: '^keep going', steps: [{ text: 'continued' }] }] },
      env: { FAKE_CLAUDE_LOG_STDOUT: '1' },
    });
    const marker = path.join(sb.root, 'stop-once');
    sb.write(
      '.kiro/hooks/stop.json',
      JSON.stringify({ version: 'v1', hooks: [{ name: 'more', trigger: 'Stop', action: { type: 'command', command: `if [ ! -f ${marker} ]; then touch ${marker}; echo '{"decision":"block","reason":"keep going"}'; fi` } }] }),
    );
    const { s } = await open(sb);
    try {
      const { result } = await drain(s.prompt({ text: 'start' }));
      const rs = claudeResults(sb);
      assert.equal(rs.length, 2, 'the Stop hook ran a continuation turn');
      assert.ok(rs.every((r) => (r.usage?.output_tokens ?? 0) > 0));
      assert.equal(result.usage?.outputTokens, sum(rs, 'output_tokens'));
      assert.equal(result.usage?.inputTokens, sum(rs, 'input_tokens'));
      assert.equal(result.numTurns, rs.reduce((a, r) => a + (r.num_turns ?? 0), 0));
      assert.equal(result.text, 'continued', 'the text stays the last answer');
    } finally {
      await closeAll(s);
    }
  });

  it('redirect turn: usage covers the interrupted turn and the redirect', async () => {
    const sb = mkSandbox({
      script: {
        turns: [
          { match: '^go', steps: [{ text: 'let me run it' }, { tool: { name: 'Bash', id: 'toolu_b', input: { command: 'touch f' } } }, { text: 'never' }] },
          { match: 'instead', steps: [{ text: 'redirected answer' }] },
        ],
      },
      env: { FAKE_CLAUDE_LOG_STDOUT: '1' },
    });
    const ui = recordingUI();
    ui.answers.push({ kind: 'redirect', text: 'do it differently instead' });
    const { s } = await open(sb, {}, ui);
    try {
      const { result } = await drain(s.prompt({ text: 'go' }));
      const rs = claudeResults(sb);
      assert.equal(rs.length, 2);
      assert.equal(result.text, 'redirected answer');
      assert.equal(result.usage?.outputTokens, sum(rs, 'output_tokens'));
      assert.equal(result.usage?.inputTokens, sum(rs, 'input_tokens'));
      assert.deepEqual(result.permissionDenials.map((d) => d.toolName), ['shell'], 'the redirected call is still reported');
    } finally {
      await closeAll(s);
    }
  });

  it('a single turn is unchanged', async () => {
    const sb = mkSandbox({ script: { default: { steps: [{ text: 'hello there' }] } }, env: { FAKE_CLAUDE_LOG_STDOUT: '1' } });
    const { s } = await open(sb);
    try {
      const { result } = await drain(s.prompt({ text: 'hi' }));
      const rs = claudeResults(sb);
      assert.equal(rs.length, 1);
      assert.equal(result.usage?.outputTokens, rs[0]!.usage?.output_tokens);
      assert.equal(result.numTurns, rs[0]!.num_turns);
    } finally {
      await closeAll(s);
    }
  });
});

// ───────────────────────────── F7 ─────────────────────────────

describe('F7: an Agent call is a subagent only once it may run', () => {
  const AGENT_INPUT = { description: 'count files', prompt: 'Count the files.', subagent_type: 'general-purpose' };
  const SCRIPT = { turns: [{ match: '^GO', steps: [{ tool: { id: 'toolu_sub1', name: 'Agent', input: AGENT_INPUT, result: 'There are 3 files.' } }, { text: 'done' }] }] };

  async function run(answer: 'deny' | 'trusted'): Promise<{ events: SessionEvent[]; ui: RecordingUI }> {
    const sb = mkSandbox({ script: SCRIPT });
    sb.agent('probe', { tools: ['*'], allowedTools: [] });
    const ui = recordingUI();
    if (answer === 'deny') ui.answers.push({ kind: 'deny' });
    const { s } = await open(sb, { agentName: 'probe', ...(answer === 'trusted' ? { trustAllTools: true } : {}) }, ui);
    try {
      const { events, result } = await drain(s.prompt({ text: 'GO delegate' }));
      assert.equal(result.stopReason, 'end_turn');
      return { events, ui };
    } finally {
      await closeAll(s);
    }
  }

  it('denied at the approval prompt: no subagent started or failed', async () => {
    const { events, ui } = await run('deny');
    assert.equal(ui.approvals.length, 1, 'the Agent call asked');
    assert.deepEqual(events.filter((e) => e.type === 'subagent'), []);
    assert.ok(events.some((e) => e.type === 'tool_start'), 'the call itself is still shown');
    assert.ok(events.some((e) => e.type === 'tool_end' && e.isError), 'and its denial');
  });

  it('approved: started only after the approval, then finished', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    sb.agent('probe', { tools: ['*'], allowedTools: [] });
    const seq: string[] = [];
    const ui = recordingUI();
    ui.answers.push(async () => {
      seq.push('approval');
      await sleep(100);
      seq.push('approved');
      return { kind: 'allow-once' };
    });
    const { s } = await open(sb, { agentName: 'probe' }, ui);
    s.on('event', (e: SessionEvent) => {
      if (e.type === 'subagent') seq.push(`subagent:${e.state}`);
      else if (e.type === 'tool_start') seq.push('tool_start');
    });
    try {
      await drain(s.prompt({ text: 'GO delegate' }));
      assert.deepEqual(seq, ['tool_start', 'approval', 'approved', 'subagent:started', 'subagent:finished']);
    } finally {
      await closeAll(s);
    }
  });

  it('control: a trusted call is started then finished, as before', async () => {
    const { events } = await run('trusted');
    const sub = events.filter((e) => e.type === 'subagent') as Extract<SessionEvent, { type: 'subagent' }>[];
    assert.deepEqual(sub.map((e) => e.state), ['started', 'finished']);
    assert.equal(sub[0]!.toolUseId, 'toolu_sub1');
    assert.equal(sub[0]!.prompt, 'Count the files.');
    assert.equal(sub[1]!.isError, false);
  });
});

// ───────────────────────────── F8 ─────────────────────────────

describe('F8: /chat load keeps a carry that was still pending when /chat save ran', () => {
  for (const [mode, re] of [
    ['merge', /<tangent-summary name="research">[\s\S]*FOUND_X[\s\S]*after load/],
    ['tail', /<tangent-tail name="research">[\s\S]*User: finding FOUND_X[\s\S]*after load/],
  ] as const) {
    it(`${mode}, save, load: the loaded conversation's next prompt carries it once`, async () => {
      const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
      const { s } = await open(sb);
      let file: string;
      try {
        await drain(s.prompt({ text: 'm1' }));
        await s.enterTangent('research');
        await drain(s.prompt({ text: 'finding FOUND_X' }));
        await s.exitTangent(mode);
        file = await s.exportTo(path.join(sb.root, 'exp.json'), false);
      } finally {
        await closeAll(s);
      }
      assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file, 'utf8')).session.pendingContext));
      const imported = await importSessionExport(file, { ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), env: sb.env });
      try {
        assert.match(imported.record.pendingContext?.join('\n') ?? '', /FOUND_X/, 'the new record holds the carry');
        await drain(imported.prompt({ text: 'after load' }));
        assert.match(lastUserText(sb), re);
        await drain(imported.prompt({ text: 'next' }));
        assert.doesNotMatch(lastUserText(sb), /tangent-(summary|tail)/);
      } finally {
        await closeAll(imported);
      }
    });
  }
});

// ───────────────────────────── F9 ─────────────────────────────

describe('F9: a tangent opened before main speaks again sees what was merged into main', () => {
  it('merge, new tangent: its first turn carries the summary; main still gets it exactly once', async () => {
    const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'm1' }));
      const mainId = s.id;
      await s.enterTangent('first');
      await drain(s.prompt({ text: 'finding FOUND_X' }));
      await s.exitTangent('merge');
      await s.enterTangent('second');
      await drain(s.prompt({ text: 'what did the first tangent find?' }));
      assert.match(lastUserText(sb), /<tangent-summary name="first">[\s\S]*FOUND_X[\s\S]*what did the first tangent find\?/);
      await drain(s.prompt({ text: 'more in second' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary/, 'once in the tangent too');
      await s.exitTangent('discard');
      assert.equal(s.id, mainId);
      await drain(s.prompt({ text: 'back-in-main' }));
      const sent = lastUserText(sb);
      assert.match(sent, /<tangent-summary name="first">[\s\S]*FOUND_X[\s\S]*back-in-main/);
      assert.equal(count(sent, '<tangent-summary'), 1);
      await drain(s.prompt({ text: 'later' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary/);
    } finally {
      await closeAll(s);
    }
  });

  it('tail, new tangent, merge it back: main gets the tail once plus the new summary', async () => {
    const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'm1' }));
      await s.enterTangent('first');
      await drain(s.prompt({ text: 'side TAIL_Y' }));
      await s.exitTangent('tail');
      await s.enterTangent('second');
      await drain(s.prompt({ text: 'what was the last side question?' }));
      assert.match(lastUserText(sb), /<tangent-tail name="first">[\s\S]*User: side TAIL_Y[\s\S]*what was the last side question\?/);
      await s.exitTangent('merge');
      await drain(s.prompt({ text: 'back-in-main' }));
      const sent = lastUserText(sb);
      assert.equal(count(sent, '<tangent-tail name="first">'), 1, 'main gets its own copy once');
      assert.equal(count(sent, '<tangent-summary name="second">'), 1);
      assert.ok(sent.indexOf('<tangent-tail') < sent.indexOf('<tangent-summary'), 'in the order they returned');
    } finally {
      await closeAll(s);
    }
  });

  it('the copy is the tangent’s own: a discarded tangent that never spoke leaves main’s carry alone', async () => {
    const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'm1' }));
      await s.enterTangent('first');
      await drain(s.prompt({ text: 'finding FOUND_X' }));
      await s.exitTangent('merge');
      await s.enterTangent('second');
      assert.match(s.record.pendingContext?.join('\n') ?? '', /FOUND_X/);
      await s.exitTangent('discard');
      assert.equal(s.record.pendingContext?.length, 1);
      await drain(s.prompt({ text: 'back-in-main' }));
      assert.equal(count(lastUserText(sb), '<tangent-summary'), 1);
    } finally {
      await closeAll(s);
    }
  });
});
