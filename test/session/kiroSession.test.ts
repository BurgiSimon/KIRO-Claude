import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { NON_INTERACTIVE_DENY, PLAN_MODE_DENY, USER_DENY_MESSAGE } from '../../src/policy/gate.js';
import { readJournal } from '../../src/session/kiroFiles.js';
import {
  AgentNotFoundError,
  createSession,
  KiroSessionImpl,
  PLAN_MODE_BLOCK,
  SessionNotFoundError,
  ModelNotFoundError,
  type KiroSessionInternalOptions,
} from '../../src/session/kiroSession.js';
import type { SessionEvent } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, semantic, type RecordingUI, type Sandbox } from './helpers.js';

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

describe('session: a full turn', () => {
  it('maps the frame stream to events, dedupes streamed text, records the turn and the KiroCrew files', async () => {
    const sb = mkSandbox({
      script: {
        turns: [
          {
            match: '^hello',
            steps: [{ text: 'Hi there' }, { tool: { name: 'Read', id: 'toolu_r1', input: { file_path: '{{cwd}}/a.txt' } } }, { text: 'Done reading' }],
          },
        ],
      },
    });
    const { s } = await open(sb);
    const emitted: SessionEvent[] = [];
    s.on('event', (e: SessionEvent) => emitted.push(e));
    try {
      const { events, result } = await drain(s.prompt({ text: 'hello world' }));
      assert.deepEqual(emitted, events, 'every event is also emitted');
      const sem = semantic(events);
      const types = sem.map((e) => e.type);
      assert.deepEqual(types, ['text_delta', 'text_delta', 'tool_start', 'tool_end', 'text_delta', 'text_delta']);
      assert.equal(sem.filter((e) => e.type === 'text').length, 0, 'streamed text is not repeated');
      const start = sem[2] as Extract<SessionEvent, { type: 'tool_start' }>;
      assert.equal(start.toolUseId, 'toolu_r1');
      assert.equal(start.trusted, true);
      assert.equal(start.call.kiro2Name, 'read');
      assert.equal(start.call.claudeName, 'Read');
      const end = sem[3] as Extract<SessionEvent, { type: 'tool_end' }>;
      assert.equal(end.isError, false);
      assert.equal(end.output, `1\tcontents of ${sb.cwd}/a.txt`);
      assert.equal(typeof end.durationMs, 'number');
      assert.equal((end.response as { type: string }).type, 'text');
      assert.ok(events.some((e) => e.type === 'raw'));
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(result.isError, false);
      assert.equal(result.text, 'Done reading');
      assert.equal(result.claudeSessionId, s.claudeSessionId);
      assert.ok(result.usage && result.usage.inputTokens > 0);
      assert.deepEqual(result.permissionDenials, []);
      // index record
      assert.equal(s.record.turns.length, 1);
      assert.equal(s.record.title, 'hello world');
      assert.ok(s.record.turns[0]!.assistantUuid);
      assert.equal(s.record.messageCount, 1);
      // KiroCrew files
      const json = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${s.id}.json`), 'utf8')) as Record<string, unknown>;
      assert.equal(json.session_id, s.id);
      assert.equal((json.session_state as { agent_name: string }).agent_name, 'kiro_default');
      const jsonl = path.join(sb.sessionsDir, `${s.id}.jsonl`);
      assert.ok(fs.statSync(jsonl).size >= 10);
      assert.equal(fs.statSync(jsonl).mode & 0o777, 0o600);
      const recs = readJournal(sb.sessionsDir, s.id);
      assert.deepEqual(recs.map((r) => r.kind), ['Prompt', 'AssistantMessage', 'ToolResults', 'AssistantMessage']);
      assert.deepEqual(recs[0]!.data.content, [{ kind: 'text', data: 'hello world' }]);
      assert.deepEqual(recs[1]!.data.content![0], { kind: 'text', data: 'Hi there' });
      assert.equal((recs[1]!.data.content![1] as { kind: string }).kind, 'toolUse');
      assert.equal((recs[2]!.data.content![0] as { data: { toolUseId: string; status: string } }).data.toolUseId, 'toolu_r1');
      assert.ok(recs.every((r) => !Number.isNaN(Date.parse(r.timestamp))));
      // the session id is a UUID and the filename stem
      assert.match(s.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    } finally {
      await closeAll(s);
    }
  });

  it('emits complete text blocks when Claude streamed no deltas, and thinking', async () => {
    const sb = mkSandbox({ script: { default: { steps: [{ thinking: 'hmm' }, { text: 'answer' }] } } });
    const { s } = await open(sb);
    try {
      // drop --include-partial-messages by spoofing an old CLI: no deltas at all
      await s.close();
      const caps = await fakeCaps();
      const noPartial = { ...caps, has: (f: string) => f !== '--include-partial-messages' && caps.has(f) };
      const s2 = await KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps: noPartial, env: sb.env });
      try {
        const { events } = await drain(s2.prompt({ text: 'q' }));
        assert.deepEqual(semantic(events), [
          { type: 'thinking_delta', text: 'hmm' },
          { type: 'text', text: 'answer' },
        ]);
      } finally {
        await closeAll(s2);
      }
    } finally {
      await closeAll(s);
    }
  });

  it('sessions are found through $KIRO_CLAUDE_BIN; env passthrough minus the scrub list (KC-ENV-01)', async () => {
    const sb = mkSandbox({ env: { KIROCREW_SPAWNED: '1', CLAUDECODE: '1', KIRO_API_KEY: 'k', CLAUDE_CODE_SESSION_ID: 'parent' } });
    const s = await createSession({ ws: sb.ws, origin: 'acp', interactive: true, ui: recordingUI(), env: sb.env });
    try {
      await drain(s.prompt({ text: 'hi' }));
      const start = sb.log().find((e) => e.event === 'start' && (e.argv as string[]).includes('-p'))!;
      const env = start.env as Record<string, string>;
      assert.equal(env.KIROCREW_SPAWNED, '1');
      assert.equal(env.CLAUDECODE, undefined);
      assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
      assert.equal(env.KIRO_API_KEY, undefined);
      assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
    } finally {
      await closeAll(s);
    }
  });

  it('turn text: @file refs, /prompt and @prompt expansion, /skill inline, images', async () => {
    const sb = mkSandbox();
    sb.write('notes.md', 'NOTE-BODY');
    sb.write('.kiro/prompts/greet.md', 'Say hello to ${1}');
    sb.write('.kiro/skills/deploy/SKILL.md', '---\nname: deploy\n---\nDeploy steps');
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'read @notes.md please' }));
      await drain(s.prompt({ text: '/greet Bob' }));
      await drain(s.prompt({ text: '@greet Alice' }));
      await drain(s.prompt({ text: '/deploy prod' }));
      await drain(s.prompt({ text: 'look', images: [{ mediaType: 'image/png', dataBase64: Buffer.from([1, 2, 3]).toString('base64') }] }));
      const lines = sb.userLines();
      assert.match(contentText(lines[0]!), /<file path="[^"]*notes\.md">[\s\S]*NOTE-BODY[\s\S]*--- USER MESSAGE BEGIN ---\nread @notes\.md please--- USER MESSAGE END ---/);
      assert.equal(contentText(lines[1]!), 'Say hello to Bob');
      assert.equal(contentText(lines[2]!), 'Say hello to Alice');
      assert.equal(contentText(lines[3]!), 'Deploy steps\n\nARGUMENTS: prod');
      const img = (lines[4]!.message as { content: { type: string }[] }).content;
      assert.deepEqual(img.map((b) => b.type), ['image', 'text']);
      const recs = readJournal(sb.sessionsDir, s.id).filter((r) => r.kind === 'Prompt');
      assert.equal(recs.length, 5);
      assert.deepEqual(recs[1]!.data.content, [{ kind: 'text', data: '/greet Bob' }], 'the journal keeps what the user typed');
      assert.equal((recs[4]!.data.content![1] as { kind: string }).kind, 'image');
    } finally {
      await closeAll(s);
    }
  });
});

describe('session: the gate', () => {
  const v2 = {
    tools: ['*'],
    allowedTools: ['fs_read'],
    toolsSettings: { execute_bash: { deniedCommands: ['rm .*'] }, fs_read: { deniedPaths: ['secret/**'] } },
  };

  it('allow (trusted), deny (policy, no tool_end), ask → approval → allow', async () => {
    const sb = mkSandbox({
      script: {
        turns: [
          {
            steps: [
              { tool: { name: 'Read', id: 't_ok', input: { file_path: '{{cwd}}/ok.txt' } } },
              { tool: { name: 'Bash', id: 't_rm', input: { command: 'rm -rf build' } } },
              { tool: { name: 'Read', id: 't_secret', input: { file_path: '{{cwd}}/secret/key' } } },
              { tool: { name: 'Bash', id: 't_touch', input: { command: 'touch f' } } },
              { text: 'end' },
            ],
          },
        ],
      },
    });
    sb.agent('v2', v2);
    const { s, ui } = await open(sb, { agentName: 'v2' });
    try {
      const { events, result } = await drain(s.prompt({ text: 'go' }));
      const sem = semantic(events).filter((e) => e.type.startsWith('tool'));
      const summary = sem.map((e) => `${e.type}:${'toolUseId' in e ? e.toolUseId : ''}${e.type === 'tool_start' ? `:${e.trusted}` : ''}`);
      assert.deepEqual(summary, ['tool_start:t_ok:true', 'tool_end:t_ok', 'tool_denied:t_rm', 'tool_denied:t_secret', 'tool_start:t_touch:false', 'tool_end:t_touch']);
      const denied = sem.find((e) => e.type === 'tool_denied' && e.toolUseId === 't_rm') as Extract<SessionEvent, { type: 'tool_denied' }>;
      assert.match(denied.reason, /^Command execute_bash is rejected because it matches one or more rules on the denied list:/);
      assert.equal(ui.approvals.length, 1);
      assert.equal(ui.approvals[0]!.call.claudeName, 'Bash');
      assert.equal(ui.approvals[0]!.agentName, 'v2');
      assert.deepEqual(result.permissionDenials.map((d) => d.toolName), ['shell', 'read']);
      assert.ok(result.permissionDenials[0]!.reason);
    } finally {
      await closeAll(s);
    }
  });

  it("'n' ⇒ Kiro's denial text reaches the model; turn continues", async () => {
    const sb = mkSandbox({ script: { turns: [{ steps: [{ tool: { name: 'Bash', input: { command: 'touch f' } } }, { text: 'saw: {{lastToolResult}}' }] }] } });
    const ui = recordingUI();
    ui.answers.push({ kind: 'deny' });
    const { s } = await open(sb, {}, ui);
    try {
      const { events, result } = await drain(s.prompt({ text: 'go' }));
      assert.equal(result.text, `saw: ${USER_DENY_MESSAGE}`);
      const end = semantic(events).find((e) => e.type === 'tool_end') as Extract<SessionEvent, { type: 'tool_end' }>;
      assert.equal(end.isError, true);
    } finally {
      await closeAll(s);
    }
  });

  it('redirect: the tool is cancelled, the turn interrupted, the text sent as the next turn', async () => {
    const sb = mkSandbox({
      script: {
        turns: [
          { match: '^start', steps: [{ tool: { name: 'Bash', input: { command: 'touch f' } } }, { text: 'never' }] },
          { match: '^do something else', steps: [{ text: 'redirected ok' }] },
        ],
      },
    });
    const ui = recordingUI();
    ui.answers.push({ kind: 'redirect', text: 'do something else' });
    const { s } = await open(sb, {}, ui);
    try {
      const { result } = await drain(s.prompt({ text: 'start' }));
      assert.equal(result.text, 'redirected ok');
      assert.equal(result.stopReason, 'end_turn');
      assert.deepEqual(sb.userLines().map(contentText), ['start', 'do something else']);
      assert.equal(s.record.turns.length, 2);
    } finally {
      await closeAll(s);
    }
  });

  it('non-interactive sessions deny instead of asking, with the V3 headless text', async () => {
    const sb = mkSandbox({ script: { turns: [{ steps: [{ tool: { name: 'Bash', input: { command: 'touch f' } } }, { text: 'saw: {{lastToolResult}}' }] }] } });
    const { s, ui } = await open(sb, { interactive: false, origin: 'headless' });
    try {
      const { events, result } = await drain(s.prompt({ text: 'go' }));
      assert.equal(ui.approvals.length, 0);
      const d = semantic(events).find((e) => e.type === 'tool_denied') as Extract<SessionEvent, { type: 'tool_denied' }>;
      assert.equal(d.reason, NON_INTERACTIVE_DENY);
      assert.equal(result.text, `saw: PreToolUse:Bash hook error: ${NON_INTERACTIVE_DENY}`);
    } finally {
      await closeAll(s);
    }
  });

  it('--trust-all-tools and t (allow-always) make later calls trusted; trust is persisted', async () => {
    const sb = mkSandbox({
      script: { turns: [{ steps: [{ tool: { name: 'Bash', input: { command: 'touch a' } } }, { tool: { name: 'Bash', input: { command: 'touch b' } } }, { text: 'x' }] }] },
    });
    const ui = recordingUI();
    ui.answers.push({ kind: 'allow-always' });
    const { s } = await open(sb, {}, ui);
    try {
      const { events } = await drain(s.prompt({ text: 'go' }));
      const starts = semantic(events).filter((e) => e.type === 'tool_start') as Extract<SessionEvent, { type: 'tool_start' }>[];
      assert.deepEqual(starts.map((e) => e.trusted), [false, true]);
      assert.equal(ui.approvals.length, 1);
      const disk = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${s.id}.json`), 'utf8')) as { trust: { allowedTools: string[] } };
      assert.ok(disk.trust.allowedTools.includes('execute_bash'));
      assert.ok(s.toolListing().find((t) => t.name === 'shell')!.permission === 'trusted');
    } finally {
      await closeAll(s);
    }
    const sb2 = mkSandbox({ script: { turns: [{ steps: [{ tool: { name: 'Bash', input: { command: 'touch a' } } }, { text: 'x' }] }] } });
    const { s: s2, ui: ui2 } = await open(sb2, { trustAllTools: true });
    try {
      const { events } = await drain(s2.prompt({ text: 'go' }));
      assert.equal(ui2.approvals.length, 0);
      assert.equal((semantic(events).find((e) => e.type === 'tool_start') as { trusted: boolean }).trusted, true);
    } finally {
      await closeAll(s2);
    }
  });

  it('plan mode: block in the user turn; mutating tools denied', async () => {
    const sb = mkSandbox({ script: { turns: [{ steps: [{ tool: { name: 'Write', input: { file_path: '{{cwd}}/x', content: 'c' } } }, { text: '{{lastToolResult}}' }] }] } });
    const { s } = await open(sb);
    try {
      s.planMode = true;
      const { result } = await drain(s.prompt({ text: 'plan it' }));
      assert.ok(contentText(sb.userLines()[0]!).startsWith(PLAN_MODE_BLOCK));
      assert.equal(result.text, `PreToolUse:Write hook error: ${PLAN_MODE_DENY}`);
      assert.equal(s.record.planMode, true);
    } finally {
      await closeAll(s);
    }
  });

  it('interrupt() during an approval prompt cancels it and the turn', async () => {
    const sb = mkSandbox({ script: { turns: [{ steps: [{ tool: { name: 'Bash', input: { command: 'touch f' } } }, { text: 'never' }] }] } });
    const ui = recordingUI();
    let sess: KiroSessionImpl | undefined;
    ui.answers.push(
      (_r, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true });
          setTimeout(() => void sess!.interrupt(), 20);
        }),
    );
    const { s } = await open(sb, {}, ui);
    sess = s;
    try {
      const { result } = await drain(s.prompt({ text: 'go' }));
      assert.equal(result.stopReason, 'cancelled');
      assert.equal(result.isError, false);
      // the process is still usable
      const r2 = await drain(s.prompt({ text: 'again' }));
      assert.equal(r2.result.stopReason, 'end_turn');
    } finally {
      await closeAll(s);
    }
  });
});

describe('session: hooks', () => {
  it('agentSpawn output goes into the system prompt; agent-action prompt prefixes the first turn only; userPromptSubmit wraps', async () => {
    const sb = mkSandbox();
    sb.agent('hooky', {
      tools: ['*'],
      hooks: { agentSpawn: [{ command: 'echo SPAWN-OUT' }], userPromptSubmit: [{ command: 'echo PROMPT-HOOK-OUT' }] },
    });
    sb.write('.kiro/hooks/first.json', JSON.stringify({ version: 'v1', hooks: [{ name: 'first', trigger: 'SessionStart', action: { type: 'agent', prompt: 'FIRST-TURN-PROMPT' } }] }));
    const { s } = await open(sb, { agentName: 'hooky' });
    try {
      const sp = fs.readFileSync(s.lastLaunch!.files.systemPrompt, 'utf8');
      assert.match(sp, /SPAWN-OUT/);
      assert.match(sp, /for the entire conversation/);
      await drain(s.prompt({ text: 'one' }));
      await drain(s.prompt({ text: 'two' }));
      const [l1, l2] = sb.userLines().map(contentText);
      assert.match(l1!, /PROMPT-HOOK-OUT/);
      assert.match(l1!, /FIRST-TURN-PROMPT/);
      assert.match(l1!, /--- USER MESSAGE BEGIN ---\none--- USER MESSAGE END ---$/);
      assert.match(l2!, /PROMPT-HOOK-OUT/);
      assert.equal(l2!.includes('FIRST-TURN-PROMPT'), false);
      // agentSpawn ran before the child was spawned: one process only
      assert.equal(sb.starts().length, 1);
    } finally {
      await closeAll(s);
    }
  });

  it('postToolUse hook runs after Bash (KC-SPEC-05)', async () => {
    const sb = mkSandbox({ script: { turns: [{ steps: [{ tool: { name: 'Bash', input: { command: 'echo hi' } } }, { text: 'ok' }] }] } });
    const audit = path.join(sb.root, 'audit.log');
    sb.agent('crew', { tools: ['*'], allowedTools: ['execute_bash'], hooks: { postToolUse: [{ matcher: 'execute_bash', command: `cat >> ${audit}` }] } });
    const { s } = await open(sb, { agentName: 'crew' });
    try {
      await drain(s.prompt({ text: 'go' }));
      const line = JSON.parse(fs.readFileSync(audit, 'utf8')) as Record<string, unknown>;
      assert.equal(line.tool_name, 'execute_bash');
      assert.equal(line.hook_event_name, 'postToolUse');
    } finally {
      await closeAll(s);
    }
  });

  it('Stop hook (V3 decision:block) ⇒ a continuation turn with the reason', async () => {
    const sb = mkSandbox({ script: { turns: [{ match: '^start', steps: [{ text: 'first' }] }, { match: '^keep going', steps: [{ text: 'continued' }] }] } });
    const marker = path.join(sb.root, 'stop-once');
    sb.write(
      '.kiro/hooks/stop.json',
      JSON.stringify({
        version: 'v1',
        hooks: [{ name: 'more', trigger: 'Stop', action: { type: 'command', command: `if [ ! -f ${marker} ]; then touch ${marker}; echo '{"decision":"block","reason":"keep going"}'; fi` } }],
      }),
    );
    const { s } = await open(sb);
    try {
      const { events, result } = await drain(s.prompt({ text: 'start' }));
      assert.equal(result.text, 'continued');
      assert.deepEqual(sb.userLines().map(contentText), ['start', 'keep going']);
      assert.deepEqual(semantic(events).filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join(''), 'firstcontinued');
      assert.equal(s.record.turns.length, 2);
    } finally {
      await closeAll(s);
    }
  });

  it('Stop hook continuations stop after 3 (the runner limit) and confirm pickers go to the UI', async () => {
    const sb = mkSandbox({ script: { default: { steps: [{ text: 'again' }] } } });
    sb.write(
      '.kiro/hooks/stop.json',
      JSON.stringify({
        version: 'v1',
        hooks: [
          { name: 'loop', trigger: 'Stop', action: { type: 'command', command: `echo '{"decision":"block","reason":"loop"}'` } },
          { name: 'ask', trigger: 'Stop', action: { type: 'command', command: 'true' }, confirm: { question: 'Run checks?', options: [{ id: 'y', label: 'Yes', run: true }, { id: 'n', label: 'No', run: false }] } },
        ],
      }),
    );
    const ui = recordingUI();
    ui.confirmAnswer = 'n';
    const { s } = await open(sb, {}, ui);
    try {
      await drain(s.prompt({ text: 'start' }));
      assert.equal(sb.userLines().length, 4, 'the user turn + 3 continuations');
      assert.ok(ui.confirms.length >= 1);
      assert.equal(ui.confirms[0]!.question, 'Run checks?');
      assert.ok(ui.notices.some((n) => /continu/i.test(n.message)));
    } finally {
      await closeAll(s);
    }
  });

  it('SessionEnd hooks run on close; the lock and the runtime dir are removed', async () => {
    const sb = mkSandbox();
    const marker = path.join(sb.root, 'ended');
    sb.write('.kiro/hooks/end.json', JSON.stringify({ version: 'v1', hooks: [{ name: 'end', trigger: 'SessionEnd', action: { type: 'command', command: `touch ${marker}` } }] }));
    const { s } = await open(sb);
    await drain(s.prompt({ text: 'hi' }));
    const rt = s.runtimeDir;
    assert.ok(fs.existsSync(path.join(sb.sessionsDir, `${s.id}.lock`)));
    await s.close();
    assert.ok(fs.existsSync(marker));
    assert.equal(fs.existsSync(path.join(sb.sessionsDir, `${s.id}.lock`)), false);
    assert.equal(fs.existsSync(rt), false);
    assert.ok(fs.existsSync(path.join(sb.sessionsDir, `${s.id}.json`)), 'terminate keeps the files');
    assert.ok(fs.existsSync(path.join(sb.sessionsDir, `${s.id}.jsonl`)));
    await s.close(); // idempotent
  });

  it('an empty REPL chat leaves no index entry; an empty ACP session keeps it', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    const id = s.id;
    await s.close();
    assert.equal(fs.existsSync(path.join(sb.sessionsDir, `${id}.json`)), false);
    const { s: a } = await open(sb, { origin: 'acp' });
    await a.close();
    assert.ok(fs.existsSync(path.join(sb.sessionsDir, `${a.id}.json`)));
  });
});

describe('session: events and tracking', () => {
  it('todo tracking from TaskCreate / TaskUpdate', async () => {
    const sb = mkSandbox({
      script: {
        turns: [
          {
            steps: [
              { tool: { name: 'TaskCreate', input: { subject: 'Write tests', description: 'd' }, tool_use_result: { task: { id: '1', subject: 'Write tests' } } } },
              { tool: { name: 'TaskCreate', input: { subject: 'Ship', description: 'd' }, result: 'Task #2 created successfully: Ship' } },
              { tool: { name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } } },
              { tool: { name: 'TaskUpdate', input: { taskId: '2', status: 'deleted' } } },
              { text: 'ok' },
            ],
          },
        ],
      },
    });
    const { s } = await open(sb);
    try {
      const { events } = await drain(s.prompt({ text: 'plan' }));
      const updates = semantic(events).filter((e) => e.type === 'todo_update');
      assert.equal(updates.length, 4);
      assert.deepEqual(s.todos(), [{ id: '1', subject: 'Write tests', status: 'in_progress' }]);
      const starts = semantic(events).filter((e) => e.type === 'tool_start') as Extract<SessionEvent, { type: 'tool_start' }>[];
      assert.ok(starts.every((e) => e.trusted), 'todo tools are always allowed');
    } finally {
      await closeAll(s);
    }
  });

  it('subagent events, rate limits (rejected ⇒ notice), auth errors', async () => {
    const sb = mkSandbox({
      script: {
        turns: [
          {
            match: '^sub',
            steps: [
              { tool: { name: 'Agent', id: 'toolu_a', input: { description: 'review', prompt: 'p', subagent_type: 'general-purpose' } } },
              { frame: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1794081600, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1 } } } } },
              { text: 'ok' },
            ],
          },
          { match: '^auth', steps: [{ error: 'authentication_failed' }] },
        ],
      },
    });
    const { s } = await open(sb);
    try {
      const { events } = await drain(s.prompt({ text: 'sub' }));
      const sem = semantic(events);
      assert.deepEqual(sem.filter((e) => e.type === 'subagent').map((e) => (e as { state: string }).state), ['started', 'finished']);
      const rl = sem.find((e) => e.type === 'rate_limit') as Extract<SessionEvent, { type: 'rate_limit' }>;
      assert.deepEqual(rl, { type: 'rate_limit', status: 'rejected', resetsAt: 1794081600, utilization: 1 });
      assert.ok(sem.some((e) => e.type === 'notice' && e.level === 'error' && /usage limit/.test(e.message)));
      const usage = await s.usage();
      assert.equal(usage.rateLimit?.status, 'rejected');
      assert.equal(usage.rateLimit?.window, 'five_hour');
      const auth = await drain(s.prompt({ text: 'auth' }));
      assert.equal(auth.result.authError, true);
      assert.equal(auth.result.isError, true);
      assert.equal(auth.result.stopReason, 'error');
    } finally {
      await closeAll(s);
    }
  });

  it('steer() injects with priority "next" into the running turn', async () => {
    const sb = mkSandbox({ script: { turns: [{ match: '^long', steps: [{ tool: { name: 'Read', input: { file_path: '{{cwd}}/x' }, durationMs: 300 } }, { text: 'done' }] }] } });
    const { s } = await open(sb);
    try {
      const gen = s.prompt({ text: 'long job' });
      let steered = false;
      for (;;) {
        const r = await gen.next();
        if (r.done) {
          assert.equal(r.value.text, 'done');
          break;
        }
        if (!steered && r.value.type === 'tool_start') {
          s.steer('also check y');
          steered = true;
        }
      }
      const lines = sb.userLines();
      const steer = lines.find((l) => contentText(l) === 'also check y')!;
      assert.equal(steer.priority, 'next');
      // the next turn works (no stale busy state)
      const r2 = await drain(s.prompt({ text: 'next' }));
      assert.equal(r2.result.stopReason, 'end_turn');
      assert.equal(readJournal(sb.sessionsDir, s.id).filter((r) => r.kind === 'Prompt').length, 3);
    } finally {
      await closeAll(s);
    }
  });

  it('steer() while idle is folded into the next prompt', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    try {
      s.steer('remember this');
      await drain(s.prompt({ text: 'main' }));
      assert.equal(contentText(sb.userLines()[0]!), 'main\n\nremember this');
    } finally {
      await closeAll(s);
    }
  });

  it('a crashed child ends the turn with an error and is respawned with --resume next time', async () => {
    const sb = mkSandbox({ script: { turns: [{ match: '^ok', steps: [{ text: 'fine' }] }, { match: '^crash', steps: [{ exit: 3, stderr: 'boom' }] }] } });
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'ok' }));
      const { result } = await drain(s.prompt({ text: 'crash' }));
      assert.equal(result.isError, true);
      assert.equal(result.stopReason, 'error');
      assert.match(result.error!, /boom|exit/i);
      const r3 = await drain(s.prompt({ text: 'ok again' }));
      assert.equal(r3.result.stopReason, 'end_turn');
      const starts = sb.starts();
      assert.equal(starts.length, 2);
      assert.equal(flagValue(starts[1]!, '--resume'), s.claudeSessionId);
      assert.ok(s.record.turns.length >= 2);
    } finally {
      await closeAll(s);
    }
  });

  it('compact(): compaction events, /compact text, Compaction journal record', async () => {
    const sb = mkSandbox();
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'hello' }));
      const { events, result } = await drain(s.compact('focus on tests'));
      const sem = semantic(events).filter((e) => e.type === 'compaction');
      assert.deepEqual(sem.map((e) => (e as { state: string }).state), ['started', 'finished']);
      assert.equal(result.stopReason, 'local_command');
      assert.equal(result.localCommand, 'compact');
      assert.equal(contentText(sb.userLines()[1]!), '/compact focus on tests');
      const recs = readJournal(sb.sessionsDir, s.id);
      assert.equal(recs[recs.length - 1]!.kind, 'Compaction');
      assert.equal(s.record.turns.length, 1, 'local commands are not turns');
    } finally {
      await closeAll(s);
    }
  });

  it('usage(), mcpStatus(), toolListing(), listModels(), hooks()', async () => {
    const sb = mkSandbox();
    sb.agent('m', { tools: ['read', 'shell', '@srv'], mcpServers: { srv: { command: 'srv' }, off: { command: 'o', disabled: true } } });
    const { s } = await open(sb, { agentName: 'm' });
    try {
      await drain(s.prompt({ text: 'hi' }));
      const u = await s.usage();
      assert.equal(typeof u.contextTokens, 'number');
      assert.ok(u.contextWindowTokens! > 0);
      assert.equal(typeof u.contextPercent, 'number');
      assert.equal(u.model, 'auto');
      assert.equal(typeof u.sessionCostUsd, 'number');
      const st = await s.mcpStatus();
      assert.ok(st.some((e) => e.name === 'srv'));
      assert.ok(st.some((e) => e.name === 'off' && e.status === 'disabled'));
      const tools = s.toolListing();
      assert.deepEqual(tools.filter((t) => t.source === 'builtin').map((t) => t.name), ['read', 'glob', 'grep', 'shell']);
      assert.equal(tools.find((t) => t.name === 'shell')!.permission, 'not trusted');
      const models = await s.listModels();
      assert.equal(models[0]!.kiroId, 'auto');
      assert.ok(models.some((m) => m.kiroId === 'claude-haiku-5.5'));
      assert.deepEqual(s.hooks(), []);
      await assert.rejects(s.runManualHook('nope'), /No manual hook named nope/);
    } finally {
      await closeAll(s);
    }
  });
});

describe('session: configuration errors', () => {
  it('missing --agent: fatal (exit 4) when non-interactive, Q fallback text when interactive', async () => {
    const sb = mkSandbox();
    await assert.rejects(open(sb, { agentName: 'nope', interactive: false }), (e: unknown) => e instanceof AgentNotFoundError && e.exitCode === 4);
    const { s, ui } = await open(sb, { agentName: 'nope' });
    try {
      assert.equal(s.agent.name, 'kiro_default');
      assert.ok(ui.notices.some((n) => n.message === 'Error: no agent with name nope found. Falling back to user specified default'));
    } finally {
      await closeAll(s);
    }
  });

  it('unknown --resume-id ⇒ SessionNotFoundError; invalid --model ⇒ ModelNotFoundError', async () => {
    const sb = mkSandbox();
    await assert.rejects(open(sb, { resume: { sessionId: '11111111-1111-4111-8111-111111111111' } }), SessionNotFoundError);
    await assert.rejects(open(sb, { model: 'gpt-5' }), (e: unknown) => e instanceof ModelNotFoundError && /Model 'gpt-5' does not exist/.test((e as Error).message));
    assert.deepEqual(fs.existsSync(sb.sessionsDir) ? fs.readdirSync(sb.sessionsDir).filter((f) => f.endsWith('.lock')) : [], []);
  });

  it('a spec that fails to load names the file when non-interactive (no silent fallback)', async () => {
    const sb = mkSandbox();
    sb.write(path.join(sb.kiroHome, 'agents', 'broken.json'), '{ not json');
    await assert.rejects(open(sb, { agentName: 'broken', interactive: false, origin: 'acp' }), (e: unknown) => e instanceof AgentNotFoundError && /broken\.json/.test((e as Error).message));
  });

  it('a claude child that fails to start rejects createSession and releases the lock', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_EXIT_ON_START: '1', FAKE_CLAUDE_STDERR: 'kaboom' } });
    await assert.rejects(open(sb), /kaboom|exit/i);
    const left = fs.existsSync(sb.sessionsDir) ? fs.readdirSync(sb.sessionsDir) : [];
    assert.deepEqual(left, [], 'no lock and no empty record left behind');
  });
});
