/**
 * Adversarial review tests for session/ (fake-claude driven, temp HOME/KIRO_HOME).
 * Each case targets a behaviour the first implementation got wrong or left untested.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { journalPrefix, promptRecord, assistantRecord, compactionRecord, readJournal, replayItems, textBlock, journalBeforeMessage } from '../../src/session/kiroFiles.js';
import { claudeSettingsEnv, importSessionExport, KiroSessionImpl, SessionNotFoundError, toolSearchEnv, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { sanitizeExtraArgs } from '../../src/session/launch.js';
import type { SessionEvent } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

async function open(sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<{ s: KiroSessionImpl; ui: RecordingUI }> {
  const s = await KiroSessionImpl.create({
    ws: sb.ws,
    origin: 'repl',
    interactive: true,
    ui,
    binary: fakeBinary(),
    caps: await fakeCaps(),
    env: sb.env,
    ...over,
  });
  return { s, ui };
}

function contentText(line: Record<string, unknown>): string {
  const c = (line.message as { content: unknown }).content;
  if (typeof c === 'string') return c;
  return (c as { type: string; text?: string }[]).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');
}

function last<T>(a: T[]): T {
  return a[a.length - 1]!;
}

function sessionFiles(sb: Sandbox): string[] {
  try {
    return fs.readdirSync(sb.sessionsDir).filter((n) => !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

describe('review: journal cut points', () => {
  it('journalBeforeMessage keeps everything before the Prompt with that message id (steers and clears do not shift it)', () => {
    const recs = [
      promptRecord('old', { messageId: 'u0' }),
      assistantRecord([textBlock('old reply')]),
      compactionRecord(''),
      promptRecord('a', { messageId: 'u1' }),
      promptRecord('steer', { messageId: 's1' }),
      assistantRecord([textBlock('reply a')]),
      promptRecord('b', { messageId: 'u2' }),
      assistantRecord([textBlock('reply b')]),
    ];
    const cut = journalBeforeMessage(recs, 'u2');
    assert.deepEqual(cut.map((r) => r.kind), ['Prompt', 'AssistantMessage', 'Compaction', 'Prompt', 'Prompt', 'AssistantMessage']);
    assert.deepEqual(replayItems(cut).filter((i) => i.type === 'assistant').map((i) => (i as { text: string }).text), ['reply a']);
    // unknown id ⇒ everything
    assert.equal(journalBeforeMessage(recs, 'nope').length, recs.length);
    // the old helper is unchanged
    assert.equal(journalPrefix(recs, 1).length, 3);
  });
});

describe('review: rewind / steer journal', () => {
  it('rewind(1) after /clear copies the post-clear turn, not the cleared conversation', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'before clear' }));
      await s.clear();
      await drain(s.prompt({ text: 'alpha' }));
      await drain(s.prompt({ text: 'beta' }));
      assert.equal(s.record.turns.length, 2);
      await s.rewind(1);
      const items = replayItems(readJournal(sb.sessionsDir, s.id));
      assert.deepEqual(items.filter((i) => i.type === 'user').map((i) => (i as { text: string }).text), ['alpha']);
      assert.equal(items.filter((i) => i.type === 'assistant').length, 1);
    } finally {
      await closeAll(s);
    }
  });

  it('a steered turn keeps its reply in a rewind copy, and the steer Prompt follows the tool results', async () => {
    const sb = mkSandbox({
      script: {
        turns: [{ match: '^long', steps: [{ tool: { name: 'Read', input: { file_path: '{{cwd}}/x' }, durationMs: 300 } }, { text: 'done' }] }],
        default: { steps: [{ text: 'ok' }] },
      },
    });
    const { s } = await open(sb);
    try {
      const gen = s.prompt({ text: 'long job' });
      for (;;) {
        const r = await gen.next();
        if (r.done) break;
        if (r.value.type === 'tool_start') s.steer('also check y');
      }
      await drain(s.prompt({ text: 'second' }));
      const kinds = readJournal(sb.sessionsDir, s.id).map((r) => r.kind);
      assert.deepEqual(kinds, ['Prompt', 'AssistantMessage', 'ToolResults', 'Prompt', 'AssistantMessage', 'Prompt', 'AssistantMessage']);
      await s.rewind(1);
      const copy = readJournal(sb.sessionsDir, s.id);
      assert.deepEqual(copy.map((r) => r.kind), ['Prompt', 'AssistantMessage', 'ToolResults', 'Prompt', 'AssistantMessage']);
    } finally {
      await closeAll(s);
    }
  });
});

describe('review: internal local turns are silent', () => {
  it("setEffort / clear do not leak Claude's local-command text on 'event'", async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    const events: SessionEvent[] = [];
    s.on('event', (e: SessionEvent) => events.push(e));
    try {
      await s.setEffort('high');
      await s.clear();
      const texts = events.filter((e) => e.type === 'text' || e.type === 'text_delta');
      assert.deepEqual(texts, []);
      assert.ok(events.some((e) => e.type === 'session_id'), '/clear still reports the new Claude session id');
    } finally {
      await closeAll(s);
    }
  });
});

describe('review: extraClaudeArgs', () => {
  it('a variadic forbidden flag drops all of its values', () => {
    const w: string[] = [];
    assert.deepEqual(sanitizeExtraArgs(['--allowedTools', 'Bash', 'Edit', '--verbose'], w), ['--verbose']);
    assert.deepEqual(sanitizeExtraArgs('--allowed-tools Read Write --max-budget-usd 1', w), ['--max-budget-usd', '1']);
    assert.deepEqual(sanitizeExtraArgs(['--permission-mode', 'bypassPermissions', 'x'], w), ['x']);
    assert.deepEqual(sanitizeExtraArgs(['--allowedTools=Bash', 'Edit', '--permission-mode=plan', 'y'], w), ['y']);
    assert.equal(w.length, 5);
  });
});

describe('review: failure cleanup', () => {
  it('a failed import leaves no index, journal or transcript behind', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb);
    await drain(s.prompt({ text: 'remember ALPHA' }));
    await s.exportTo('saved.json', false);
    await s.close();
    const before = sessionFiles(sb);
    const projects = path.join(sb.claudeConfig, 'projects');
    const countTranscripts = (): number => fs.readdirSync(projects, { recursive: true }).filter((n) => String(n).endsWith('.jsonl')).length;
    const tBefore = countTranscripts();
    await assert.rejects(
      importSessionExport('saved.json', { ws: sb.ws, origin: 'headless', interactive: false, ui: recordingUI(), env: sb.env, agentName: 'does-not-exist' }),
      /no agent with name does-not-exist/,
    );
    assert.deepEqual(sessionFiles(sb), before);
    assert.equal(countTranscripts(), tBefore);
  });

  it('enterTangent whose spawn fails leaves no orphan tangent record and the session recovers', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'main' }));
      const parentId = s.id;
      const before = sessionFiles(sb);
      sb.env.FAKE_CLAUDE_EXIT_ON_START = '7';
      await assert.rejects(s.enterTangent('x'));
      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      assert.equal(s.id, parentId);
      assert.equal(s.tangent, undefined);
      assert.deepEqual(sessionFiles(sb), before);
      const { result } = await drain(s.prompt({ text: 'again' }));
      assert.equal(result.stopReason, 'end_turn');
    } finally {
      await closeAll(s);
    }
  });

  it('rewind whose spawn fails leaves no orphan rewind record', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'one' }));
      await drain(s.prompt({ text: 'two' }));
      const id = s.id;
      const before = sessionFiles(sb);
      sb.env.FAKE_CLAUDE_EXIT_ON_START = '7';
      await assert.rejects(s.rewind(1));
      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      assert.equal(s.id, id);
      assert.deepEqual(sessionFiles(sb), before);
    } finally {
      await closeAll(s);
    }
  });
});

describe('review: close() while a turn runs', () => {
  it('the turn ends, nothing is written after close (no lock-less index rewrite)', async () => {
    const sb = mkSandbox({ script: { turns: [{ steps: [{ text: 'start' }, { sleepMs: 3000 }, { text: 'late' }] }] } });
    const { s } = await open(sb);
    const id = s.id;
    const gen = s.prompt({ text: 'slow' });
    const first = await gen.next();
    assert.equal(first.done, false);
    await s.close();
    const t0 = Date.now();
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
    }
    assert.ok(Date.now() - t0 < 2500, 'the generator finishes promptly');
    // the empty REPL chat was removed by close(); the cancelled turn must not resurrect it
    assert.equal(fs.existsSync(path.join(sb.sessionsDir, `${id}.json`)), false);
    assert.equal(fs.existsSync(path.join(sb.sessionsDir, `${id}.lock`)), false);
  });
});

describe('review: pending fork', () => {
  it('a respawn in a fresh tangent (no turn yet) re-forks the parent instead of resuming a transcript that may not exist', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'main' }));
      const parentSid = s.claudeSessionId!;
      await s.enterTangent();
      const tangentSid = s.claudeSessionId!;
      await s.addContext(['README.md']);
      const argv = last(sb.starts());
      assert.equal(flagValue(argv, '--resume'), parentSid);
      assert.ok(argv.includes('--fork-session'));
      assert.equal(flagValue(argv, '--session-id'), tangentSid);
      await drain(s.prompt({ text: 'side' }));
      await s.removeContext(['README.md']);
      const after = last(sb.starts());
      assert.equal(flagValue(after, '--resume'), tangentSid, 'after a turn the fork exists and is resumed');
      assert.equal(after.includes('--fork-session'), false);
    } finally {
      await closeAll(s);
    }
  });
});

describe('review: transferred session copies (08a §4.2)', () => {
  it('a <sid>.json copied under a new stem forks the Claude session instead of sharing it', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb, { origin: 'acp' });
    await drain(s.prompt({ text: 'remember ALPHA' }));
    const origId = s.id;
    const origSid = s.claudeSessionId!;
    await s.close();
    // KiroCrew peer transfer: rewrite the envelope under a new sid filename, copy the journal
    const newId = '6f1c2f4e-8a7b-4c1d-9e2f-0a1b2c3d4e5f';
    const raw = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${origId}.json`), 'utf8')) as Record<string, unknown>;
    raw.session_id = newId;
    fs.writeFileSync(path.join(sb.sessionsDir, `${newId}.json`), JSON.stringify(raw));
    fs.copyFileSync(path.join(sb.sessionsDir, `${origId}.jsonl`), path.join(sb.sessionsDir, `${newId}.jsonl`));
    const { s: copy } = await open(sb, { origin: 'acp', resume: { sessionId: newId } });
    try {
      assert.equal(copy.id, newId);
      const argv = last(sb.starts());
      assert.equal(flagValue(argv, '--resume'), origSid);
      assert.ok(argv.includes('--fork-session'), 'the copy forks');
      assert.notEqual(copy.claudeSessionId, origSid);
      assert.equal(flagValue(argv, '--session-id'), copy.claudeSessionId);
      const disk = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${newId}.json`), 'utf8')) as Record<string, unknown>;
      assert.equal(disk.sessionId, newId);
      assert.equal(disk.claudeSessionId, copy.claudeSessionId);
      // Claude Code writes a fork's transcript only with its first message (VERIFIED 2.1.319;
      // the fake models it): the copy speaks once, so its own Claude session exists
      await drain(copy.prompt({ text: 'in the copy' }));
    } finally {
      await closeAll(copy);
    }
    // resuming the copy again is a plain resume of its own Claude session
    const { s: again } = await open(sb, { origin: 'acp', resume: { sessionId: newId } });
    try {
      const argv = last(sb.starts());
      assert.equal(argv.includes('--fork-session'), false);
      assert.equal(flagValue(argv, '--resume'), again.claudeSessionId);
    } finally {
      await closeAll(again);
    }
  });
});

describe('review: misc contracts', () => {
  it('an unsafe --resume-id is "not found", never a path', async () => {
    const sb = mkSandbox();
    await assert.rejects(open(sb, { resume: { sessionId: '../../etc/passwd' } }), SessionNotFoundError);
  });

  it('a second concurrent prompt() is refused; the first completes', async () => {
    const sb = mkSandbox({ script: { turns: [{ steps: [{ sleepMs: 200 }, { text: 'one' }] }] } });
    const { s } = await open(sb);
    try {
      const g1 = s.prompt({ text: 'a' });
      const p1 = drain(g1);
      await new Promise((r) => setTimeout(r, 50));
      await assert.rejects(drain(s.prompt({ text: 'b' })), /while a turn is running/);
      const r1 = await p1;
      assert.equal(r1.result.text, 'one');
    } finally {
      await closeAll(s);
    }
  });

  it('a consumer that stops iterating early interrupts the turn; the next prompt works', async () => {
    const sb = mkSandbox({ script: { turns: [{ match: '^slow', steps: [{ text: 'start' }, { sleepMs: 3000 }, { text: 'late' }] }], default: { steps: [{ text: 'ok' }] } } });
    const { s } = await open(sb);
    try {
      const t0 = Date.now();
      for await (const ev of s.prompt({ text: 'slow' })) {
        if (ev.type === 'text' || ev.type === 'text_delta') break;
      }
      assert.ok(Date.now() - t0 < 2500);
      assert.ok(sb.stdin().some((l) => l.type === 'control_request' && (l.request as { subtype?: string }).subtype === 'interrupt'));
      const { result } = await drain(s.prompt({ text: 'next' }));
      assert.equal(result.text, 'ok');
    } finally {
      await closeAll(s);
    }
  });

  it('setEffort during a turn is applied as /effort before the next turn', async () => {
    const sb = mkSandbox({ script: { turns: [{ match: '^slow', steps: [{ sleepMs: 150 }, { text: 'one' }] }], default: { steps: [{ text: 'ok' }] } } });
    const { s } = await open(sb);
    try {
      const p = drain(s.prompt({ text: 'slow' }));
      await new Promise((r) => setTimeout(r, 40));
      await s.setEffort('low');
      await p;
      await drain(s.prompt({ text: 'next' }));
      const texts = sb.userLines().map(contentText);
      assert.deepEqual(texts, ['slow', '/effort low', 'next']);
      assert.equal(s.effort, 'low');
    } finally {
      await closeAll(s);
    }
  });
});

describe('review: tool listing, background turns, runtime dirs', () => {
  it('toolListing before the first turn includes MCP tools from the last mcpStatus (ACP `tools` after session/new)', async () => {
    const sb = mkSandbox();
    sb.agent('m', { tools: ['read', '@srv'], mcpServers: { srv: { command: 'srv' } } });
    const { s } = await open(sb, { agentName: 'm' });
    try {
      const proc = s.process! as unknown as { mcpStatus: () => Promise<unknown> };
      proc.mcpStatus = async () => ({ mcpServers: [{ name: 'srv', status: 'connected', tools: [{ name: 'echo' }, { name: 'mcp__srv__ping' }] }] });
      const st = await s.mcpStatus();
      assert.deepEqual(st.map((e) => [e.name, e.status, e.toolCount]), [['srv', 'connected', 2]]);
      const names = s.toolListing().map((t) => t.name);
      assert.ok(names.includes('@srv/echo') && names.includes('@srv/ping'), names.join(','));
      assert.ok(names.includes('read'));
    } finally {
      await closeAll(s);
    }
  });

  it('a CLI-initiated (background) turn that streamed its text is not emitted twice', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    const events: SessionEvent[] = [];
    s.on('event', (e: SessionEvent) => events.push(e));
    try {
      const onFrame = (s as unknown as { onFrame(f: unknown): void }).onFrame.bind(s);
      onFrame({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_bg' } } });
      onFrame({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'bg text' } } });
      onFrame({ type: 'assistant', parent_tool_use_id: null, uuid: 'u-bg', message: { id: 'msg_bg', role: 'assistant', content: [{ type: 'text', text: 'bg text' }] } });
      onFrame({ type: 'assistant', parent_tool_use_id: null, uuid: 'u-bg2', message: { id: 'msg_bg2', role: 'assistant', content: [{ type: 'text', text: 'unstreamed' }] } });
      const texts = events.filter((e) => e.type === 'text' || e.type === 'text_delta').map((e) => `${e.type}:${(e as { text: string }).text}`);
      assert.deepEqual(texts, ['text_delta:bg text', 'text:unstreamed']);
    } finally {
      await closeAll(s);
    }
  });

  it('two in-process session objects for one id do not share (and delete) one runtime dir', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb, { origin: 'acp' });
    await drain(s.prompt({ text: 'x' }));
    const { s: twin } = await open(sb, { origin: 'acp', resume: { sessionId: s.id } });
    try {
      assert.notEqual(s.runtimeDir, twin.runtimeDir);
      await s.close();
      assert.ok(fs.existsSync(twin.runtimeDir), 'the live twin keeps its launch files');
      assert.ok(fs.existsSync(twin.lastLaunch!.files.systemPrompt));
    } finally {
      await closeAll(s, twin);
    }
  });

  it('effort is normalized to lower case before it is stored', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb, { effort: 'High' });
    try {
      assert.equal(s.effort, 'high');
      assert.equal(flagValue(last(sb.starts()), '--effort'), 'high');
    } finally {
      await closeAll(s);
    }
  });
});

describe('review: forks of forks', () => {
  it('rewinding again before the rewound session has a turn forks the original source', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'one' }));
      await drain(s.prompt({ text: 'two' }));
      await drain(s.prompt({ text: 'three' }));
      const origSid = s.claudeSessionId!;
      const t1 = s.record.turns[0]!.assistantUuid!;
      await s.rewind(2);
      await s.rewind(1);
      const argv = last(sb.starts());
      assert.equal(flagValue(argv, '--resume'), origSid, 'fork from the materialized original');
      assert.equal(flagValue(argv, '--resume-session-at'), t1);
      assert.equal(s.record.turns.length, 1);
    } finally {
      await closeAll(s);
    }
  });

  it('a tangent opened right after a rewind forks the rewind source at the rewind point', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'one' }));
      await drain(s.prompt({ text: 'two' }));
      const origSid = s.claudeSessionId!;
      const at = s.record.turns[0]!.assistantUuid!;
      await s.rewind(1);
      const rewoundSid = s.claudeSessionId!;
      await s.enterTangent('t');
      const argv = last(sb.starts());
      assert.equal(flagValue(argv, '--resume'), origSid);
      assert.equal(flagValue(argv, '--resume-session-at'), at);
      await s.exitTangent('discard');
      const back = last(sb.starts());
      // the rewind itself is still unmaterialized: returning re-forks it under its own id
      assert.equal(flagValue(back, '--resume'), origSid);
      assert.equal(flagValue(back, '--session-id'), rewoundSid);
    } finally {
      await closeAll(s);
    }
  });
});

describe('review: toolSearch overlay (08 KC-FS-05)', () => {
  it('toolSearch.enabled / minPct reach the child as ENABLE_TOOL_SEARCH; an explicit env value wins', async () => {
    const stub = (vals: Record<string, unknown>) =>
      ({ get: (k: string) => vals[k] }) as unknown as Parameters<typeof toolSearchEnv>[0];
    assert.equal(toolSearchEnv(stub({})), undefined);
    assert.equal(toolSearchEnv(stub({ 'toolSearch.enabled': false })), 'false');
    assert.equal(toolSearchEnv(stub({ 'toolSearch.enabled': true, 'toolSearch.minPct': 5 })), 'auto:5');
    assert.equal(toolSearchEnv(stub({ 'toolSearch.enabled': true })), undefined);
    assert.equal(toolSearchEnv(stub({ 'toolSearch.enabled': true, 'toolSearch.minPct': 'x' })), undefined);
    const sb = mkSandbox();
    sb.write('.kiro/settings/cli.json', JSON.stringify({ 'toolSearch.enabled': true, 'toolSearch.minPct': 5, 'toolSearch.minTokens': 50000 }));
    const { s } = await open(sb);
    try {
      const env = (s as unknown as { childEnv(): NodeJS.ProcessEnv }).childEnv();
      assert.equal(env.ENABLE_TOOL_SEARCH, 'auto:5');
      sb.env.ENABLE_TOOL_SEARCH = 'true';
      assert.equal((s as unknown as { childEnv(): NodeJS.ProcessEnv }).childEnv().ENABLE_TOOL_SEARCH, 'true');
    } finally {
      delete sb.env.ENABLE_TOOL_SEARCH;
      await closeAll(s);
    }
  });
});

describe('C21: Kiro settings with a Claude Code equivalent reach the child env', () => {
  it('only when set; the user env wins; nonsense values are dropped', async () => {
    const stub = (vals: Record<string, unknown>) => ({ get: (k: string) => vals[k] });
    assert.deepEqual(claudeSettingsEnv(stub({})), {});
    assert.deepEqual(claudeSettingsEnv(stub({ 'chat.disableAutoCompaction': false, 'mcp.initTimeout': 0, 'api.timeout': 'x' })), {});
    // (interactive: mcp.initTimeout only raises Claude Code's own 30 s MCP start-up limit, F4)
    assert.deepEqual(claudeSettingsEnv(stub({ 'chat.disableAutoCompaction': 'true', 'mcp.initTimeout': '42000', 'api.timeout': 90 })), {
      DISABLE_AUTO_COMPACT: '1',
      MCP_TIMEOUT: '42000',
      API_TIMEOUT_MS: '90000',
    });
    const sb = mkSandbox();
    sb.write('.kiro/settings/cli.json', JSON.stringify({ 'chat.disableAutoCompaction': true, 'mcp.initTimeout': 40000, 'api.timeout': 600 }));
    const { s } = await open(sb);
    const childEnv = (): NodeJS.ProcessEnv => (s as unknown as { childEnv(): NodeJS.ProcessEnv }).childEnv();
    try {
      const env = childEnv();
      assert.equal(env.DISABLE_AUTO_COMPACT, '1');
      assert.equal(env.MCP_TIMEOUT, '40000');
      assert.equal(env.API_TIMEOUT_MS, '600000');
      sb.env.MCP_TIMEOUT = '1234';
      assert.equal(childEnv().MCP_TIMEOUT, '1234');
    } finally {
      delete sb.env.MCP_TIMEOUT;
      await closeAll(s);
    }
  });
});

describe('review: KIRO_CLAUDE_FORCE_MODEL reaches subagents (08 KC-ENV-04)', () => {
  it('pinned subagent models inherit the forced model; the child env forces the subagent model', async () => {
    const sb = mkSandbox({ env: { KIRO_CLAUDE_FORCE_MODEL: 'haiku' } });
    sb.agent('lead', { tools: ['read', 'subagent'] });
    sb.agent('helper', { tools: ['read'], model: 'claude-sonnet-4.6', prompt: 'help' });
    const { s } = await open(sb, { agentName: 'lead' });
    try {
      const argv = last(sb.starts());
      assert.equal(flagValue(argv, '--model'), 'haiku');
      const defs = JSON.parse(fs.readFileSync(flagValue(argv, '--agents')!, 'utf8')) as Record<string, { model: string }>;
      assert.equal(defs.helper!.model, 'inherit');
      const start = sb.log().filter((e) => e.event === 'start').pop()! as { env: Record<string, string> };
      assert.equal(start.env.CLAUDE_CODE_SUBAGENT_MODEL, 'haiku');
      assert.equal(start.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1');
    } finally {
      await closeAll(s);
    }
  });
});

describe('review: ACP prompt text is verbatim (08 KC-ACP-06)', () => {
  it('no @path / # provider expansion for ACP sessions; /prompt invocations still expand', async () => {
    const sb = mkSandbox();
    sb.write('notes.txt', 'SECRET FILE BODY');
    sb.write('.kiro/prompts/greet.md', 'Hello ${1}!');
    const { s } = await open(sb, { origin: 'acp' });
    try {
      const text = '[AGENT SYSTEM PROMPT]\nRead @notes.txt and #git diff and #notes.txt\n[END AGENT SYSTEM PROMPT]';
      await drain(s.prompt({ text }));
      assert.equal(contentText(last(sb.userLines())), text);
      await drain(s.prompt({ text: '/greet world' }));
      assert.equal(contentText(last(sb.userLines())), 'Hello world!');
    } finally {
      await closeAll(s);
    }
    // the REPL keeps expanding references
    const { s: repl } = await open(sb, { origin: 'repl' });
    try {
      await drain(repl.prompt({ text: 'Read @notes.txt' }));
      assert.match(contentText(last(sb.userLines())), /SECRET FILE BODY/);
    } finally {
      await closeAll(repl);
    }
  });
});

describe('review: trust-all is per invocation', () => {
  it('a resumed session does not inherit --trust-all-tools; per-tool trust is kept', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb, { trustAllTools: true });
    await drain(s.prompt({ text: 'x' }));
    s.trustTools(['shell']);
    const id = s.id;
    assert.equal(s.trust.trustAll, true);
    await s.close();
    const { s: r } = await open(sb, { resume: { sessionId: id } });
    try {
      assert.equal(r.trust.trustAll, false);
      assert.ok(r.trust.allowedTools.includes('execute_bash'));
    } finally {
      await closeAll(r);
    }
    const { s: r2 } = await open(sb, { resume: { sessionId: id }, trustAllTools: true });
    try {
      assert.equal(r2.trust.trustAll, true);
    } finally {
      await closeAll(r2);
    }
  });
});

describe('review: close() is idempotent', () => {
  it('concurrent close() calls share one shutdown (SessionEnd hooks run once)', async () => {
    const sb = mkSandbox();
    const marker = path.join(sb.root, 'end-count');
    sb.write('.kiro/hooks/end.json', JSON.stringify({ version: 'v1', hooks: [{ name: 'end', trigger: 'SessionEnd', action: { type: 'command', command: `echo x >> ${marker}` } }] }));
    const { s } = await open(sb, { origin: 'acp' });
    let resolved = 0;
    await Promise.all([s.close().then(() => resolved++), s.close().then(() => resolved++)]);
    assert.equal(resolved, 2);
    assert.equal(fs.existsSync(path.join(sb.sessionsDir, `${s.id}.lock`)), false);
    assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1);
  });
});

describe('review: session_id events for forks', () => {
  it('entering and leaving a tangent and rewinding report the Claude session id now in use', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    const ids: string[] = [];
    s.on('event', (e: SessionEvent) => {
      if (e.type === 'session_id') ids.push(e.claudeSessionId);
    });
    try {
      await drain(s.prompt({ text: 'one' }));
      const main = s.claudeSessionId!;
      assert.deepEqual(ids, [], 'no event while the id stays the same');
      await s.enterTangent();
      const tan = s.claudeSessionId!;
      await s.exitTangent('discard');
      await s.rewind(1);
      assert.deepEqual(ids, [tan, main, s.claudeSessionId!]);
    } finally {
      await closeAll(s);
    }
  });
});

describe('review: context window with subagent models in modelUsage', () => {
  it('the main model window wins over a subagent model listed after it', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'hi' }));
      const main = s.process!.lastInit!.model!;
      const onFrame = (s as unknown as { onFrame(f: unknown): void }).onFrame.bind(s);
      onFrame({ type: 'result', subtype: 'success', is_error: false, modelUsage: { [main]: { contextWindow: 1_000_000 }, 'claude-haiku-4-5-20251001': { contextWindow: 200_000 } } });
      assert.equal((await s.contextReport()).contextWindowTokens, 1_000_000);
    } finally {
      await closeAll(s);
    }
  });
});
