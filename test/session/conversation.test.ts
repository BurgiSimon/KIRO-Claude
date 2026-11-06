import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { transcriptPath } from '../../src/claude/transcript.js';
import { readJournal } from '../../src/session/kiroFiles.js';
import { importSessionExport, KiroSessionImpl, NO_SAVED_SESSIONS, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import type { KiroSession, SessionEvent } from '../../src/types.js';
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

describe('session: agent swap and context', () => {
  it('swapAgent respawns with --resume <claude sid>, --system-prompt-snapshot off and the new agent flags; SessionStart re-runs', async () => {
    const sb = mkSandbox();
    const spawnLog = path.join(sb.root, 'spawned');
    sb.agent('a', { tools: ['read'], hooks: { agentSpawn: [{ command: `echo a >> ${spawnLog}` }] } });
    sb.agent('b', { tools: ['shell'], prompt: 'I am B', model: 'claude-sonnet-4.6', hooks: { agentSpawn: [{ command: `echo b >> ${spawnLog}; echo B-SPAWN` }] } });
    const { s } = await open(sb, { agentName: 'a' });
    try {
      await drain(s.prompt({ text: 'one' }));
      const sid = s.claudeSessionId!;
      await s.swapAgent('b');
      const starts = sb.starts();
      assert.equal(starts.length, 2);
      const argv = starts[1]!;
      assert.equal(flagValue(argv, '--resume'), sid);
      assert.equal(argv.includes('--session-id'), false);
      assert.equal(flagValue(argv, '--system-prompt-snapshot'), 'off');
      assert.equal(flagValue(argv, '--tools'), 'Bash');
      assert.equal(flagValue(argv, '--model'), 'claude-sonnet-4-6');
      assert.equal(s.agent.name, 'b');
      assert.equal(s.record.agent, 'b');
      assert.equal(s.model, 'claude-sonnet-4.6');
      assert.equal(s.claudeSessionId, sid);
      assert.deepEqual(fs.readFileSync(spawnLog, 'utf8').trim().split('\n'), ['a', 'b']);
      const sp = fs.readFileSync(s.lastLaunch!.files.systemPrompt, 'utf8');
      assert.match(sp, /B-SPAWN/);
      assert.match(sp, /Follow this instruction: I am B/);
      await assert.rejects(s.swapAgent('ghost'), /no agent with name ghost/);
      const disk = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${s.id}.json`), 'utf8')) as { session_state: { agent_name: string } };
      assert.equal(disk.session_state.agent_name, 'b');
    } finally {
      await closeAll(s);
    }
  });

  it('agents are re-read from $KIRO_HOME/agents at every spawn (KC-FS-01)', async () => {
    const sb = mkSandbox();
    sb.agent('kc', { tools: ['read'] });
    const { s } = await open(sb, { agentName: 'kc', origin: 'acp' });
    try {
      sb.agent('kirocrew-skill-view-0123456789abcdef01234567', { tools: ['shell'] });
      await s.swapAgent('kirocrew-skill-view-0123456789abcdef01234567');
      assert.equal(flagValue(last(sb.starts()), '--tools'), 'Bash');
      // the file changes again: the next respawn sees it
      sb.agent('kirocrew-skill-view-0123456789abcdef01234567', { tools: ['read', 'shell'] });
      await s.addContext(['nothing/*']);
      assert.equal(flagValue(last(sb.starts()), '--tools'), 'Read,Glob,Grep,Bash');
    } finally {
      await closeAll(s);
    }
  });

  it('addContext / removeContext / clearContext respawn and change the system prompt', async () => {
    const sb = mkSandbox();
    sb.write('src/a.ts', 'A-CONTENT');
    const { s } = await open(sb);
    try {
      const r = await s.addContext(['src/*.ts', 'src/*.ts']);
      assert.deepEqual(r.added, ['src/*.ts']);
      assert.deepEqual(r.matched, { 'src/*.ts': [path.join(sb.cwd, 'src', 'a.ts')] });
      assert.equal(sb.starts().length, 2);
      assert.match(fs.readFileSync(s.lastLaunch!.files.systemPrompt, 'utf8'), /A-CONTENT/);
      assert.deepEqual(s.record.contextRules, [{ rule: 'src/*.ts', origin: 'session' }]);
      const rep = await s.contextReport();
      assert.equal(rep.sessionEntries[0]!.pattern, 'src/*.ts');
      assert.equal(rep.sessionEntries[0]!.files[0]!.path, path.join(sb.cwd, 'src', 'a.ts'));
      assert.ok(rep.totalTokens > 0);
      assert.equal((await s.addContext(['src/*.ts'])).added.length, 0);
      assert.equal(sb.starts().length, 2, 'no respawn without a change');
      assert.deepEqual(await s.removeContext(['src/*.ts', 'other']), ['src/*.ts']);
      assert.equal(sb.starts().length, 3);
      assert.equal(fs.readFileSync(s.lastLaunch!.files.systemPrompt, 'utf8').includes('A-CONTENT'), false);
      await s.addContext(['src/*.ts']);
      await s.clearContext();
      assert.deepEqual(s.record.contextRules, []);
      assert.equal(sb.starts().length, 5);
      // no history yet ⇒ the respawns reuse --session-id
      assert.equal(flagValue(last(sb.starts()), '--session-id'), s.claudeSessionId);
    } finally {
      await closeAll(s);
    }
  });
});

describe('session: /clear, /tangent, /rewind', () => {
  it('clear(): new Claude session id tracked (session_id event, record), Kiro id kept, turns reset', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    const events: SessionEvent[] = [];
    s.on('event', (e: SessionEvent) => events.push(e));
    try {
      await drain(s.prompt({ text: 'one' }));
      const kiroId = s.id;
      const before = s.claudeSessionId;
      await s.clear();
      assert.notEqual(s.claudeSessionId, before);
      assert.equal(s.id, kiroId);
      assert.equal(s.record.claudeSessionId, s.claudeSessionId);
      assert.deepEqual(s.record.turns, []);
      assert.ok(events.some((e) => e.type === 'session_id' && e.claudeSessionId === s.claudeSessionId));
      assert.equal(contentText(last(sb.userLines())), '/clear');
      await drain(s.prompt({ text: 'two' }));
      const init = sb.log().filter((e) => e.event === 'turn');
      assert.ok(init.length >= 1);
      const disk = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${kiroId}.json`), 'utf8')) as { claudeSessionId: string };
      assert.equal(disk.claudeSessionId, s.claudeSessionId);
      const recs = readJournal(sb.sessionsDir, kiroId);
      assert.deepEqual(recs.map((r) => r.kind), ['Prompt', 'AssistantMessage', 'Compaction', 'Prompt', 'AssistantMessage']);
    } finally {
      await closeAll(s);
    }
  });

  it('enterTangent forks (--resume <parent> --fork-session --session-id <new>); exitTangent(tail) returns and carries the last exchange', async () => {
    const sb = mkSandbox({ script: { turns: [{ match: '^side', steps: [{ text: 'side answer' }] }], default: { steps: [{ text: 'ok' }] } } });
    const { s } = await open(sb);
    try {
      await assert.rejects(s.enterTangent(), /empty chat/);
      await drain(s.prompt({ text: 'main question' }));
      const parentId = s.id;
      const parentSid = s.claudeSessionId!;
      await s.enterTangent('explore');
      const argv = last(sb.starts());
      assert.equal(flagValue(argv, '--resume'), parentSid);
      assert.ok(argv.includes('--fork-session'));
      assert.equal(flagValue(argv, '--session-id'), s.claudeSessionId);
      assert.notEqual(s.claudeSessionId, parentSid);
      assert.notEqual(s.id, parentId);
      assert.deepEqual(s.tangent, { name: 'explore', parentId });
      assert.equal(s.record.forkKind, 'tangent');
      assert.equal(s.record.parentId, parentId);
      assert.equal(readJournal(sb.sessionsDir, s.id).filter((r) => r.kind === 'Prompt').length, 1, 'journal copied');
      await drain(s.prompt({ text: 'side question' }));
      const tangentId = s.id;
      await s.exitTangent('tail');
      assert.equal(s.id, parentId);
      assert.equal(s.tangent, undefined);
      const back = last(sb.starts());
      assert.equal(flagValue(back, '--resume'), parentSid);
      assert.equal(back.includes('--fork-session'), false);
      await drain(s.prompt({ text: 'back in main' }));
      const lastLine = contentText(last(sb.userLines()));
      assert.match(lastLine, /<tangent-tail name="explore">/);
      assert.match(lastLine, /User: side question\nAssistant: side answer/);
      assert.equal(s.record.turns.length, 2);
      // the tangent record stays (skipped by latest)
      assert.ok(fs.existsSync(path.join(sb.sessionsDir, `${tangentId}.json`)));
      assert.equal(fs.existsSync(path.join(sb.sessionsDir, `${tangentId}.lock`)), false);
      await assert.rejects(s.exitTangent('tail'), /You need to be in tangent mode to use tail\./);
      await assert.rejects(s.exitTangent('merge'), /Already on the root session/);
    } finally {
      await closeAll(s);
    }
  });

  it('exitTangent(merge) asks the tangent for a summary and hands it to the parent', async () => {
    const sb = mkSandbox({ script: { turns: [{ match: '^Summarize the findings', steps: [{ text: 'THE SUMMARY' }] }], default: { steps: [{ text: 'ok' }] } } });
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'main' }));
      await s.enterTangent();
      assert.deepEqual(s.tangent?.name, null);
      await assert.rejects(s.exitTangent('merge'), /Nothing to merge yet/);
      await drain(s.prompt({ text: 'explore' }));
      await s.exitTangent('merge');
      await drain(s.prompt({ text: 'continue' }));
      assert.match(contentText(last(sb.userLines())), /<tangent-summary>[\s\S]*THE SUMMARY/);
    } finally {
      await closeAll(s);
    }
  });

  it('rewind(N): --resume <sid> --fork-session --resume-session-at <turn N assistant uuid>; new rewind record', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'first' }));
      await drain(s.prompt({ text: 'second' }));
      const oldId = s.id;
      const oldSid = s.claudeSessionId!;
      const at = s.record.turns[0]!.assistantUuid!;
      await assert.rejects(s.rewind(3), /Invalid turn 3: choose 1-2/);
      await s.rewind(1);
      const argv = last(sb.starts());
      assert.equal(flagValue(argv, '--resume'), oldSid);
      assert.ok(argv.includes('--fork-session'));
      assert.equal(flagValue(argv, '--resume-session-at'), at);
      assert.equal(flagValue(argv, '--session-id'), s.claudeSessionId);
      assert.notEqual(s.id, oldId);
      assert.equal(s.record.forkKind, 'rewind');
      assert.equal(s.record.parentId, oldId);
      assert.equal(s.record.turns.length, 1);
      assert.equal(readJournal(sb.sessionsDir, s.id).filter((r) => r.kind === 'Prompt').length, 1);
      assert.equal(fs.existsSync(path.join(sb.sessionsDir, `${oldId}.lock`)), false, 'the old session is no longer active here');
      assert.ok(fs.existsSync(path.join(sb.sessionsDir, `${oldId}.json`)), 'the original is untouched');
    } finally {
      await closeAll(s);
    }
  });

  it('fork option: createSession({fork}) forks a Claude session into a new record', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb, { fork: { fromClaudeSessionId: 'cafebabe-0000-4000-8000-000000000000', kind: 'spawn' } });
    try {
      const argv = last(sb.starts());
      assert.equal(flagValue(argv, '--resume'), 'cafebabe-0000-4000-8000-000000000000');
      assert.ok(argv.includes('--fork-session'));
      assert.equal(flagValue(argv, '--session-id'), s.claudeSessionId);
      assert.equal(s.record.forkKind, 'spawn');
    } finally {
      await closeAll(s);
    }
  });
});

describe('session: resume, locks, export/import', () => {
  it('resume latest for this cwd: same Kiro id, --resume <claude sid>, stored agent/model/effort', async () => {
    const sb = mkSandbox();
    sb.agent('saved', { tools: ['read'] });
    const ui0 = recordingUI();
    const { s: none } = await open(sb, { resume: { latest: true } }, ui0);
    assert.ok(ui0.notices.some((n) => n.message === NO_SAVED_SESSIONS));
    await none.close();
    const { s } = await open(sb, { agentName: 'saved', model: 'claude-sonnet-4.6', effort: 'low' });
    await drain(s.prompt({ text: 'remember' }));
    const id = s.id;
    const sid = s.claudeSessionId!;
    await s.close();
    const { s: r } = await open(sb, { resume: { latest: true } });
    try {
      assert.equal(r.id, id);
      assert.equal(r.claudeSessionId, sid);
      assert.equal(r.agent.name, 'saved');
      assert.equal(r.model, 'claude-sonnet-4.6');
      assert.equal(r.effort, 'low');
      const argv = last(sb.starts());
      assert.equal(flagValue(argv, '--resume'), sid);
      assert.equal(flagValue(argv, '--model'), 'claude-sonnet-4-6');
      assert.equal(flagValue(argv, '--effort'), 'low');
      assert.equal(argv.includes('--session-id'), false);
      await drain(r.prompt({ text: 'again' }));
      assert.equal(r.record.turns.length, 2);
    } finally {
      await closeAll(r);
    }
  });

  it('a lock held by another live process ⇒ "Session is active in another process (PID N)"', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb, { origin: 'acp' });
    const id = s.id;
    await s.close();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(path.join(sb.sessionsDir, `${id}.lock`), JSON.stringify({ pid: child.pid, started_at: new Date().toISOString(), host: os.hostname() }));
      await assert.rejects(open(sb, { resume: { sessionId: id } }), new RegExp(`Failed to start session: Session is active in another process \\(PID ${child.pid}\\)`));
    } finally {
      child.kill('SIGKILL');
    }
    // a stale lock (dead pid) is taken over
    await new Promise((r) => child.once('exit', r));
    const { s: again } = await open(sb, { resume: { sessionId: id } });
    try {
      assert.equal(again.id, id);
      const lock = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${id}.lock`), 'utf8')) as { pid: number };
      assert.equal(lock.pid, process.pid);
    } finally {
      await closeAll(again);
    }
  });

  it('a resumed session whose transcript is gone restarts fresh with the journal as context', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb, { origin: 'acp' });
    await drain(s.prompt({ text: 'remember ALPHA' }));
    const id = s.id;
    const sid = s.claudeSessionId!;
    await s.close();
    fs.rmSync(transcriptPath(sid, sb.cwd, sb.env));
    const { s: r, ui } = await open(sb, { resume: { sessionId: id }, origin: 'acp' });
    try {
      const starts = sb.starts();
      assert.equal(flagValue(starts[starts.length - 2]!, '--resume'), sid);
      assert.equal(flagValue(last(starts), '--session-id'), sid);
      assert.ok(ui.notices.some((n) => /saved history as context/.test(n.message)));
      await drain(r.prompt({ text: 'what did I say?' }));
      assert.match(contentText(last(sb.userLines())), /<kiro-restored-history>[\s\S]*User: remember ALPHA/);
    } finally {
      await closeAll(r);
    }
  });

  it('a new session whose id already has a transcript falls back to --resume', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb, { origin: 'acp' });
    await drain(s.prompt({ text: 'x' }));
    const sid = s.claudeSessionId!;
    // forget that the record has history: a crash right after the first message
    s.record.turns = [];
    s.record.messageCount = 0;
    s.store.write(s.record);
    const id = s.id;
    await s.close();
    const { s: r } = await open(sb, { resume: { sessionId: id }, origin: 'acp' });
    try {
      const starts = sb.starts();
      assert.equal(flagValue(starts[starts.length - 2]!, '--session-id'), sid);
      assert.equal(flagValue(last(starts), '--resume'), sid);
    } finally {
      await closeAll(r);
    }
  });

  it('exportTo / importSessionExport round trip (transcript re-keyed under a new Claude id)', async () => {
    const sb = mkSandbox({
      env: { FAKE_CLAUDE_PERSIST: '1' },
      script: { turns: [{ repeat: true, match: '^what', steps: [{ text: 'history: {{historyUserTexts}}' }] }], default: { steps: [{ text: 'ok' }] } },
    });
    const { s } = await open(sb);
    await drain(s.prompt({ text: 'remember ALPHA' }));
    await s.addContext(['README.md']);
    const file = await s.exportTo('saved.json', false);
    assert.equal(file, path.join(sb.cwd, 'saved.json'));
    await assert.rejects(s.exportTo('saved.json', false), /File at saved\.json already exists\. To overwrite, use -f or --force/);
    await s.exportTo('saved.json', true);
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.equal(data.kind, 'kiro-claude-export');
    assert.equal(data.version, 1);
    assert.match(String(data.claudeTranscript), /remember ALPHA/);
    assert.match(String(data.kiroJournal), /"kind":"Prompt"/);
    const origSid = s.claudeSessionId!;
    const origId = s.id;
    await s.close();
    const imported: KiroSession = await importSessionExport('saved', { ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), env: sb.env });
    try {
      assert.notEqual(imported.id, origId);
      assert.notEqual(imported.claudeSessionId, origSid);
      const argv = last(sb.starts());
      assert.equal(flagValue(argv, '--resume'), imported.claudeSessionId);
      assert.ok(fs.existsSync(transcriptPath(imported.claudeSessionId!, sb.cwd, sb.env)));
      assert.deepEqual(imported.record.contextRules, [{ rule: 'README.md', origin: 'session' }]);
      assert.equal(imported.record.turns.length, 1);
      assert.deepEqual(imported.trust, { trustAll: false, allowedTools: [], rules: [] });
      const { result } = await drain(imported.prompt({ text: 'what did I say?' }));
      assert.match(result.text, /remember ALPHA/);
      assert.equal(readJournal(sb.sessionsDir, imported.id).filter((r) => r.kind === 'Prompt').length, 2);
    } finally {
      await closeAll(imported);
    }
    await assert.rejects(importSessionExport('missing.json', { ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), env: sb.env }), /Failed to import from missing\.json/);
    fs.writeFileSync(path.join(sb.cwd, 'bad.json'), '{"kind":"other"}');
    await assert.rejects(importSessionExport('bad.json', { ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), env: sb.env }), /not a kiro-claude session export/);
  });
});

describe('session: models and effort', () => {
  it('setModel ⇒ set_model control request; listModels from initialize.models', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    try {
      await s.setModel('claude-opus-5.5');
      const req = sb.stdin().filter((l) => l.type === 'control_request' && (l.request as { subtype: string }).subtype === 'set_model');
      assert.equal(req.length, 1);
      assert.ok(['opus', 'claude-opus-5-5'].includes((req[0]!.request as { model: string }).model));
      assert.equal(s.model, 'claude-opus-5.5');
      await s.setModel('auto');
      assert.equal(last(sb.stdin().filter((l) => l.type === 'control_request')).request && (last(sb.stdin().filter((l) => l.type === 'control_request')).request as { model: unknown }).model, null);
      assert.equal(s.model, 'auto');
      await assert.rejects(s.setModel('gpt-4o'), /Model 'gpt-4o' does not exist/);
      const disk = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${s.id}.json`), 'utf8')) as { kiro_claude: { model: string } };
      assert.equal(disk.kiro_claude.model, 'auto');
    } finally {
      await closeAll(s);
    }
  });

  it('setEffort ⇒ /effort <level> local command (no turn recorded); validation', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    try {
      await s.setEffort('HIGH');
      assert.equal(contentText(last(sb.userLines())), '/effort high');
      assert.equal(s.effort, 'high');
      assert.equal(s.record.turns.length, 0);
      await assert.rejects(s.setEffort('ultra'), /Invalid effort level 'ultra'/);
      await s.setModel('claude-haiku-4.5');
      await assert.rejects(s.setEffort('low'), /does not support effort/);
    } finally {
      await closeAll(s);
    }
  });

  it('KIRO_CLAUDE_FORCE_MODEL: every child gets --model <value>; setModel is recorded but not applied', async () => {
    const sb = mkSandbox({ env: { KIRO_CLAUDE_FORCE_MODEL: 'haiku' } });
    const { s } = await open(sb, { model: 'claude-sonnet-4.6' });
    try {
      assert.equal(flagValue(last(sb.starts()), '--model'), 'haiku');
      await s.setModel('claude-opus-5.5');
      assert.equal(s.model, 'claude-opus-5.5');
      assert.equal(sb.stdin().filter((l) => l.type === 'control_request' && (l.request as { subtype: string }).subtype === 'set_model').length, 0);
      await s.addContext(['x']);
      assert.equal(flagValue(last(sb.starts()), '--model'), 'haiku');
    } finally {
      await closeAll(s);
    }
  });

  it('effort from chat.modelDefaults.<model>.output_config.effort in the workspace cli.json (KC-FS-05)', async () => {
    const sb = mkSandbox();
    sb.write('.kiro/settings/cli.json', JSON.stringify({ 'chat.modelDefaults': { 'claude-sonnet-4.6': { output_config: { effort: 'high' } } } }));
    const { s } = await open(sb, { model: 'claude-sonnet-4.6' });
    try {
      assert.equal(flagValue(last(sb.starts()), '--effort'), 'high');
      assert.equal(s.effort, 'high');
    } finally {
      await closeAll(s);
    }
    const { s: s2 } = await open(sb, { model: 'claude-sonnet-4.6', effort: 'low' });
    try {
      assert.equal(flagValue(last(sb.starts()), '--effort'), 'low', '--effort wins');
    } finally {
      await closeAll(s2);
    }
  });

  it('agent model is used unless --model is given; invalid agent model warns and falls back', async () => {
    const sb = mkSandbox();
    sb.agent('pinned', { tools: ['read'], model: 'claude-haiku-5.5' });
    sb.agent('weird', { tools: ['read'], model: 'deepseek-r1' });
    const { s } = await open(sb, { agentName: 'pinned' });
    try {
      assert.equal(s.model, 'claude-haiku-5.5');
      // before any live model list is cached the dotted id maps by version; afterwards to the live value
      assert.ok(['haiku', 'claude-haiku-5-5'].includes(flagValue(last(sb.starts()), '--model')!));
    } finally {
      await closeAll(s);
    }
    const { s: w, ui } = await open(sb, { agentName: 'weird' });
    try {
      assert.equal(w.model, 'auto');
      assert.ok(ui.notices.some((n) => /Model 'deepseek-r1' does not exist/.test(n.message)));
      assert.equal(last(sb.starts()).includes('--model'), false);
    } finally {
      await closeAll(w);
    }
  });

  it('client MCP servers (ACP) reach --mcp-config and win over the agent definition (KC-ENV-02)', async () => {
    const sb = mkSandbox();
    sb.agent('crew', { tools: ['*'], includeMcpJson: false, mcpServers: { 'kirocrew-core': { command: 'spec-core' } } });
    const { s } = await open(sb, {
      agentName: 'crew',
      origin: 'acp',
      extraMcpServers: [
        { name: 'kirocrew-core', type: 'stdio', command: 'gateway-stub', args: ['--x'], env: { KIROCREW_STUB_SESSION_TOKEN: 'tok' }, headers: {}, disabled: false, autoApprove: [], disabledTools: [], origin: 'agent' },
      ],
    });
    try {
      const cfg = JSON.parse(fs.readFileSync(flagValue(last(sb.starts()), '--mcp-config')!, 'utf8')) as { mcpServers: Record<string, { command: string; env: Record<string, string> }> };
      assert.equal(cfg.mcpServers['kirocrew-core']!.command, 'gateway-stub');
      assert.equal(cfg.mcpServers['kirocrew-core']!.env.KIROCREW_STUB_SESSION_TOKEN, 'tok');
      const st = await s.mcpStatus();
      assert.ok(st.some((e) => e.name === 'kirocrew-core'));
    } finally {
      await closeAll(s);
    }
  });
});
