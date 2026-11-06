/**
 * Guards for the cross-module review findings fixed in session/ (C6 per-agent trust, C7 tangent
 * carry, C9 close during a respawn, C14 subagent MCP tools, C17 manual agent hooks, C18 turn
 * boundaries, C19 rate-limit notice, C20 auth-failure text).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { loadAgents } from '../../src/config/agents.js';
import { openSettings } from '../../src/config/settings.js';
import { readJournal } from '../../src/session/kiroFiles.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { buildLaunch, type LaunchInput } from '../../src/session/launch.js';
import { fromDiskJson, SessionStore } from '../../src/session/store.js';
import type { KiroAgent, SessionEvent } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, flagValue, mkSandbox, recordingUI, semantic, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

async function open(sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<{ s: KiroSessionImpl; ui: RecordingUI }> {
  const s = await KiroSessionImpl.create({
    ws: sb.ws,
    origin: 'repl',
    interactive: true,
    ui,
    binary: fakeBinary(),
    caps,
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

function lastUserText(sb: Sandbox): string {
  const lines = sb.userLines();
  return contentText(lines[lines.length - 1]!);
}

function toolStart(events: SessionEvent[]): Extract<SessionEvent, { type: 'tool_start' }> | undefined {
  return events.find((e) => e.type === 'tool_start') as Extract<SessionEvent, { type: 'tool_start' }> | undefined;
}

function texts(events: SessionEvent[]): string {
  return events
    .filter((e) => e.type === 'text' || e.type === 'text_delta')
    .map((e) => (e as { text: string }).text)
    .join('');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A Bash call on every prompt starting with "run". */
const BASH_SCRIPT = { turns: [{ repeat: true, match: '^run', steps: [{ tool: { name: 'Bash', input: { command: 'echo hi' } } }, { text: 'done' }] }] };

// ───────────────────────────── C6 ─────────────────────────────

describe('C6: per-tool trust belongs to the agent that granted it (Q Agents: allowed_tools of the active agent)', () => {
  it("t / ACP allow_always under agent a does not auto-approve under b; swapping back restores a's trust", async () => {
    const sb = mkSandbox({ script: BASH_SCRIPT });
    sb.agent('a', { tools: ['*'] });
    sb.agent('b', { tools: ['*'] });
    const { s, ui } = await open(sb, { agentName: 'a' });
    try {
      ui.answers.push({ kind: 'allow-always' });
      await drain(s.prompt({ text: 'run1' }));
      assert.equal(ui.approvals.length, 1, 'the first call asks');
      assert.equal(s.toolListing().find((t) => t.name === 'shell')?.permission, 'trusted');
      await s.swapAgent('b');
      assert.equal(s.toolListing().find((t) => t.name === 'shell')?.permission, 'not trusted', '/tools under b');
      ui.answers.push({ kind: 'deny' });
      const r2 = await drain(s.prompt({ text: 'run2' }));
      assert.equal(toolStart(r2.events)?.trusted, false, `shell trusted under b: ${JSON.stringify(s.trust)}`);
      assert.equal(ui.approvals.length, 2, 'b asks for shell');
      await s.swapAgent('a');
      assert.equal(s.toolListing().find((t) => t.name === 'shell')?.permission, 'trusted', '/tools under a again');
      const r3 = await drain(s.prompt({ text: 'run3' }));
      assert.equal(toolStart(r3.events)?.trusted, true, 'a keeps its trust');
      assert.equal(ui.approvals.length, 2);
    } finally {
      await closeAll(s);
    }
  });

  it('/tools trust under a does not carry to b; trust-all stays session-wide; swapping to the same agent keeps trust', async () => {
    const sb = mkSandbox({ script: BASH_SCRIPT });
    sb.agent('a', { tools: ['*'] });
    sb.agent('b', { tools: ['*'] });
    const { s, ui } = await open(sb, { agentName: 'a' });
    try {
      s.trustTools(['shell']);
      await s.swapAgent('a'); // ACP set_mode with the current id (KiroCrew, 08 KC-ACP-03)
      await drain(s.prompt({ text: 'run1' }));
      assert.equal(ui.approvals.length, 0);
      await s.swapAgent('b');
      ui.answers.push({ kind: 'deny' });
      const r2 = await drain(s.prompt({ text: 'run2' }));
      assert.equal(toolStart(r2.events)?.trusted, false);
      assert.equal(ui.approvals.length, 1);
      s.setTrustAll(true);
      await s.swapAgent('a');
      await s.swapAgent('b');
      const r3 = await drain(s.prompt({ text: 'run3' }));
      assert.equal(toolStart(r3.events)?.trusted, true, 'trust-all is session-wide');
      assert.equal(ui.approvals.length, 1);
    } finally {
      await closeAll(s);
    }
  });

  it("/tools untrust under a revokes only a's own allowedTools", async () => {
    const sb = mkSandbox({ script: BASH_SCRIPT });
    sb.agent('a', { tools: ['*'], allowedTools: ['execute_bash'] });
    sb.agent('b', { tools: ['*'], allowedTools: ['execute_bash'] });
    const { s, ui } = await open(sb, { agentName: 'a' });
    try {
      s.untrustTools(['shell']);
      ui.answers.push({ kind: 'deny' });
      const r1 = await drain(s.prompt({ text: 'run1' }));
      assert.equal(toolStart(r1.events)?.trusted, false, 'revoked under a');
      await s.swapAgent('b');
      const r2 = await drain(s.prompt({ text: 'run2' }));
      assert.equal(toolStart(r2.events)?.trusted, true, "b's own allowedTools still trust shell");
      await s.swapAgent('a');
      ui.answers.push({ kind: 'deny' });
      const r3 = await drain(s.prompt({ text: 'run3' }));
      assert.equal(toolStart(r3.events)?.trusted, false, 'a is still revoked');
      assert.equal(ui.approvals.length, 2);
    } finally {
      await closeAll(s);
    }
  });

  it('per-agent trust is persisted: a resume keeps the trust of the agent that granted it', async () => {
    const sb = mkSandbox({ script: BASH_SCRIPT });
    sb.agent('a', { tools: ['*'] });
    sb.agent('b', { tools: ['*'] });
    const { s } = await open(sb, { agentName: 'a' });
    const id = s.id;
    try {
      s.trustTools(['shell']);
      await drain(s.prompt({ text: 'run1' }));
      await s.swapAgent('b');
    } finally {
      await closeAll(s);
    }
    const disk = JSON.parse(fs.readFileSync(path.join(sb.sessionsDir, `${id}.json`), 'utf8')) as { trust: { allowedTools: string[]; byAgent?: Record<string, { allowedTools: string[] }> } };
    assert.deepEqual(disk.trust.allowedTools, [], 'the flat fields belong to the active agent b');
    assert.deepEqual(disk.trust.byAgent?.a?.allowedTools, ['execute_bash']);
    const back = new SessionStore(sb.sessionsDir).read(id)!;
    assert.deepEqual(back.trust.byAgent?.a?.allowedTools, ['execute_bash'], 'store reads byAgent back');

    // resume on b (the saved agent): asks
    const ui2 = recordingUI();
    ui2.answers.push({ kind: 'deny' });
    const { s: r } = await open(sb, { resume: { sessionId: id } }, ui2);
    try {
      assert.equal(r.agent.name, 'b');
      const t = await drain(r.prompt({ text: 'run2' }));
      assert.equal(toolStart(t.events)?.trusted, false);
      assert.equal(ui2.approvals.length, 1);
    } finally {
      await closeAll(r);
    }
    // resume with --agent a: a's trust comes back
    const ui3 = recordingUI();
    const { s: r2 } = await open(sb, { resume: { sessionId: id }, agentName: 'a' }, ui3);
    try {
      const t = await drain(r2.prompt({ text: 'run3' }));
      assert.equal(toolStart(t.events)?.trusted, true);
      assert.equal(ui3.approvals.length, 0);
    } finally {
      await closeAll(r2);
    }
  });

  it('an old record (no byAgent) resumed with another --agent: its trust stays with the saved agent', async () => {
    const sb = mkSandbox({ script: BASH_SCRIPT });
    sb.agent('a', { tools: ['*'] });
    sb.agent('b', { tools: ['*'] });
    const { s } = await open(sb, { agentName: 'a' });
    const id = s.id;
    try {
      s.trustTools(['shell']);
      await drain(s.prompt({ text: 'run1' }));
    } finally {
      await closeAll(s);
    }
    const file = path.join(sb.sessionsDir, `${id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { trust: Record<string, unknown> };
    assert.equal(raw.trust.byAgent, undefined, 'a session that never swapped writes no byAgent');
    assert.deepEqual(fromDiskJson(raw, id)?.trust.allowedTools, ['execute_bash']);
    const ui = recordingUI();
    ui.answers.push({ kind: 'deny' });
    const { s: r } = await open(sb, { resume: { sessionId: id }, agentName: 'b' }, ui);
    try {
      const t = await drain(r.prompt({ text: 'run2' }));
      assert.equal(toolStart(t.events)?.trusted, false, 'b does not inherit the trust granted under a');
      await r.swapAgent('a');
      const t2 = await drain(r.prompt({ text: 'run3' }));
      assert.equal(toolStart(t2.events)?.trusted, true);
      assert.equal(ui.approvals.length, 1);
    } finally {
      await closeAll(r);
    }
  });
});

// ───────────────────────────── C7 ─────────────────────────────

const TANGENT_SCRIPT = {
  turns: [{ repeat: true, match: '^Summarize the findings', steps: [{ text: 'SUMMARY: the tangent found FOUND_X' }] }],
  default: { steps: [{ text: 'hist={{historyCount}}: {{historyUserTexts}}' }] },
};

describe('C7: a /tangent merge or tail carry belongs to the parent conversation', () => {
  it('merge, quit, resume main: the summary reaches main', async () => {
    const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb);
    let mainId: string;
    try {
      await drain(s.prompt({ text: 'm1' }));
      mainId = s.id;
      await s.enterTangent('research');
      await drain(s.prompt({ text: 'finding FOUND_X' }));
      await s.exitTangent('merge');
      assert.equal(s.id, mainId);
    } finally {
      await closeAll(s);
    }
    const onDisk = new SessionStore(sb.sessionsDir).read(mainId)!;
    assert.match(onDisk.pendingContext?.join('\n') ?? '', /FOUND_X/, 'the carry is saved with the main record');
    const { s: r } = await open(sb, { resume: { sessionId: mainId } });
    try {
      await drain(r.prompt({ text: 'what did the tangent find?' }));
      assert.match(lastUserText(sb), /<tangent-summary name="research">[\s\S]*FOUND_X[\s\S]*what did the tangent find\?/);
      assert.equal(r.record.pendingContext, undefined, 'consumed');
      await drain(r.prompt({ text: 'again' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary/, 'delivered once');
    } finally {
      await closeAll(r);
    }
    assert.equal(new SessionStore(sb.sessionsDir).read(mainId)!.pendingContext, undefined);
  });

  it('merge, then a new tangent: the summary does not go into that tangent, main gets it after the return', async () => {
    const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'm1' }));
      const mainId = s.id;
      await s.enterTangent('research');
      await drain(s.prompt({ text: 'finding FOUND_X' }));
      await s.exitTangent('merge');
      await s.enterTangent('other');
      await drain(s.prompt({ text: 'unrelated question' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary/, 'the summary of "research" went into "other"');
      await s.exitTangent('discard');
      assert.equal(s.id, mainId);
      await drain(s.prompt({ text: 'back-in-main' }));
      assert.match(lastUserText(sb), /<tangent-summary name="research">[\s\S]*FOUND_X[\s\S]*back-in-main/);
    } finally {
      await closeAll(s);
    }
  });

  it('tail, then a new tangent: the last exchange does not go into that tangent; main gets it', async () => {
    const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'm1' }));
      await s.enterTangent('research');
      await drain(s.prompt({ text: 'finding FOUND_X' }));
      await s.exitTangent('tail');
      await s.enterTangent('other');
      await drain(s.prompt({ text: 'unrelated question' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-tail/);
      await s.exitTangent('discard');
      await drain(s.prompt({ text: 'back-in-main' }));
      assert.match(lastUserText(sb), /<tangent-tail name="research">[\s\S]*User: finding FOUND_X[\s\S]*back-in-main/);
    } finally {
      await closeAll(s);
    }
  });

  it('/clear drops a carry that was meant for the cleared conversation', async () => {
    const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'm1' }));
      await s.enterTangent('research');
      await drain(s.prompt({ text: 'finding FOUND_X' }));
      await s.exitTangent('merge');
      await s.clear();
      await drain(s.prompt({ text: 'fresh' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary/);
    } finally {
      await closeAll(s);
    }
  });
});

// ───────────────────────────── C9 ─────────────────────────────

describe('C9: close() while a respawn is starting the new claude child', () => {
  it('the new child is closed and the respawn fails with "The session is closed"', async () => {
    // a slow `initialize` keeps the respawn's ClaudeProcess.start in flight while close() runs
    const sb = mkSandbox({ env: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 400 }) } });
    sb.agent('alpha', { tools: ['*'] });
    sb.agent('beta', { tools: ['*'] });
    const { s } = await open(sb, { agentName: 'alpha' });
    const pids = (): number[] => [...new Set(sb.log().filter((e) => e.event === 'start' && (e.argv as string[]).includes('-p')).map((e) => e.pid as number))];
    try {
      const swap = s.swapAgent('beta');
      swap.catch(() => undefined);
      assert.ok(await waitFor(() => pids().length >= 2, 10_000), 'the respawn started a second child');
      await s.close();
      await assert.rejects(swap, /The session is closed/);
      assert.equal(s.process, undefined);
      const gone = await waitFor(() => pids().every((p) => !alive(p)), 5_000);
      assert.ok(gone, `claude children still running after close: ${pids().filter(alive).join(', ')}`);
      assert.equal(fs.existsSync(s.runtimeDir), false, 'no runtime dir left behind');
    } finally {
      for (const p of pids()) if (alive(p)) process.kill(p, 'SIGKILL');
      await closeAll(s);
    }
  });
});

// ───────────────────────────── C14 ─────────────────────────────

function agentsOf(sb: Sandbox): Map<string, KiroAgent> {
  return loadAgents(sb.ws, { settings: openSettings(sb.ws) }).agents;
}

function launchFor(sb: Sandbox, name: string, over: Partial<LaunchInput> = {}): ReturnType<typeof buildLaunch> {
  const all = agentsOf(sb);
  const agent = all.get(name);
  assert.ok(agent, `agent ${name} loaded`);
  return buildLaunch({
    ws: sb.ws,
    settings: openSettings(sb.ws),
    agent,
    allAgents: all,
    binary: fakeBinary(),
    caps,
    claudeSessionId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    sessionContextGlobs: [],
    agentSpawnOutputs: [],
    contextWindowTokens: 200_000,
    runtimeDir: path.join(sb.root, 'rt'),
    ...over,
  });
}

type Defs = Record<string, { tools?: string[]; mcpServers?: Record<string, Record<string, unknown>>[]; disallowedTools?: string[] }>;

function defsOf(l: ReturnType<typeof buildLaunch>): Defs {
  return JSON.parse(fs.readFileSync(flagValue(l.args, '--agents')!, 'utf8')) as Defs;
}

function mcpConfigOf(l: ReturnType<typeof buildLaunch>): Record<string, unknown> {
  const f = flagValue(l.args, '--mcp-config');
  return f ? ((JSON.parse(fs.readFileSync(f, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers) : {};
}

describe('C14: Kiro agents exposed as Claude subagents keep their MCP tools', () => {
  it('a subagent selecting @srv that the parent runs gets mcp__srv in its tools (no inline server)', () => {
    const sb = mkSandbox();
    sb.write('.kiro/settings/mcp.json', JSON.stringify({ mcpServers: { gsrv: { command: 'gsrv-cmd', args: ['x'] } } }));
    sb.agent('lead', { tools: ['read', '@gsrv', 'subagent/gsrv-user'] });
    sb.agent('gsrv-user', { tools: ['read', '@gsrv'] });
    const l = launchFor(sb, 'lead');
    assert.deepEqual(Object.keys(mcpConfigOf(l)), ['gsrv']);
    const d = defsOf(l)['gsrv-user']!;
    assert.deepEqual(d.tools, ['Read', 'Glob', 'Grep', 'mcp__gsrv']);
    assert.equal(d.mcpServers, undefined, 'the parent already runs gsrv with the same config');
  });

  it("a subagent's own mcpServers are defined inline and its tools name them", () => {
    const sb = mkSandbox();
    sb.agent('lead', { tools: ['read', 'subagent/own'], includeMcpJson: false });
    sb.agent('own', { tools: ['read', '@own'], includeMcpJson: false, mcpServers: { own: { command: 'own-cmd', args: ['--x'], env: { K: 'v' } } } });
    const l = launchFor(sb, 'lead');
    assert.equal(flagValue(l.args, '--mcp-config'), undefined, 'the parent runs no MCP server');
    const d = defsOf(l).own!;
    assert.deepEqual(d.tools, ['Read', 'Glob', 'Grep', 'mcp__own']);
    assert.deepEqual(d.mcpServers, [{ own: { type: 'stdio', command: 'own-cmd', args: ['--x'], env: { K: 'v' } } }]);
    assert.equal(l.mcpNameMap.own, 'own', 'tool calls of the inline server map back to the Kiro server');
    assert.equal(fs.statSync(flagValue(l.args, '--agents')!).mode & 0o777, 0o600);
  });

  it('@srv/tool selects that tool exactly; a tool glob selects the server (the gate enforces the glob); disabled and excluded tools are disallowed', () => {
    const sb = mkSandbox();
    sb.write('.kiro/settings/mcp.json', JSON.stringify({ mcpServers: { gsrv: { command: 'gsrv-cmd', disabledTools: ['nuke'] } } }));
    sb.agent('lead', { tools: ['*'] });
    sb.agent('exact', { tools: ['read', '@gsrv/get_token'] });
    sb.agent('globbed', { tools: ['read', '@gsrv/read_*'] });
    sb.agent('excl', { tools: ['read', '@gsrv'], excludedTools: ['@gsrv/drop_table'] });
    const defs = defsOf(launchFor(sb, 'lead'));
    assert.deepEqual(defs.exact!.tools, ['Read', 'Glob', 'Grep', 'mcp__gsrv__get_token']);
    assert.deepEqual(defs.globbed!.tools, ['Read', 'Glob', 'Grep', 'mcp__gsrv']);
    assert.deepEqual(defs.excl!.tools, ['Read', 'Glob', 'Grep', 'mcp__gsrv']);
    assert.deepEqual(defs.excl!.disallowedTools, ['mcp__gsrv__drop_table', 'mcp__gsrv__nuke']);
    assert.deepEqual(defs.exact!.disallowedTools, ['mcp__gsrv__nuke']);
  });

  it('a "*" subagent inherits the tools and still gets its own servers inline', () => {
    const sb = mkSandbox();
    sb.agent('lead', { tools: ['read', 'subagent/helper'], includeMcpJson: false });
    sb.agent('helper', { tools: ['*'], includeMcpJson: false, mcpServers: { hsrv: { command: 'h-cmd' } } });
    const d = defsOf(launchFor(sb, 'lead')).helper!;
    assert.equal(d.tools, undefined);
    assert.deepEqual(d.mcpServers, [{ hsrv: { type: 'stdio', command: 'h-cmd', args: [], env: {} } }]);
  });

  it("a subagent server named like a different parent server gets its own Claude name", () => {
    const sb = mkSandbox();
    sb.agent('lead', { tools: ['@gsrv', 'subagent/other'], includeMcpJson: false, mcpServers: { gsrv: { command: 'parent-cmd' } } });
    sb.agent('other', { tools: ['@gsrv'], includeMcpJson: false, mcpServers: { gsrv: { command: 'child-cmd' } } });
    const l = launchFor(sb, 'lead');
    assert.deepEqual(Object.keys(mcpConfigOf(l)), ['gsrv']);
    const d = defsOf(l).other!;
    assert.deepEqual(d.tools, ['mcp__gsrv_2']);
    assert.deepEqual(d.mcpServers, [{ gsrv_2: { type: 'stdio', command: 'child-cmd', args: [], env: {} } }]);
    assert.equal(l.mcpNameMap.gsrv, 'gsrv');
    assert.equal(l.mcpNameMap.gsrv_2, 'gsrv');
  });
});

// ───────────────────────────── C17 ─────────────────────────────

describe('C17: /hooks run on an agent-action Manual hook', () => {
  it('returns the prompt for the caller to send; it is never prepended to the next message', async () => {
    const sb = mkSandbox({ script: { turns: [], default: { steps: [{ text: 'got [{{userText}}]' }] } } });
    sb.write('.kiro/hooks/m.json', JSON.stringify({ version: 'v1', hooks: [{ name: 'ask', trigger: 'Manual', action: { type: 'agent', prompt: 'Review the code' } }] }));
    const { s } = await open(sb);
    try {
      assert.equal(await s.runManualHook('ask'), 'Review the code');
      assert.equal(sb.userLines().length, 0, 'running the hook sends nothing by itself');
      await drain(s.prompt({ text: 'what is 2+2' }));
      assert.doesNotMatch(lastUserText(sb), /Review the code/);
      assert.equal(lastUserText(sb), 'what is 2+2');
    } finally {
      await closeAll(s);
    }
  });
});

// ───────────────────────────── C18 ─────────────────────────────

function oneShotStop(sb: Sandbox): void {
  const marker = path.join(sb.root, 'stop-once');
  sb.write(
    '.kiro/hooks/stop.json',
    JSON.stringify({
      version: 'v1',
      hooks: [{ name: 'more', trigger: 'Stop', action: { type: 'command', command: `if [ ! -f ${marker} ]; then touch ${marker}; echo '{"decision":"block","reason":"keep going"}'; fi` } }],
    }),
  );
}

describe('C18: a Stop-hook continuation starts a new paragraph', () => {
  it('streamed text: the generator and the live event stream both see "first\\n\\ncontinued"', async () => {
    const sb = mkSandbox({ script: { turns: [{ match: '^start', steps: [{ text: 'first.' }] }, { match: '^keep going', steps: [{ text: 'continued.' }] }] } });
    oneShotStop(sb);
    const { s } = await open(sb);
    const live: SessionEvent[] = [];
    s.on('event', (ev: SessionEvent) => live.push(ev));
    try {
      const { events, result } = await drain(s.prompt({ text: 'start' }));
      assert.equal(texts(semantic(events)), 'first.\n\ncontinued.');
      assert.equal(texts(live), 'first.\n\ncontinued.');
      assert.equal(result.text, 'continued.', 'the turn result is untouched');
      const msgs = readJournal(sb.sessionsDir, s.id).filter((r) => r.kind === 'AssistantMessage');
      assert.doesNotMatch(JSON.stringify(msgs), /\\n\\ncontinued/, 'the journal keeps the real text');
    } finally {
      await closeAll(s);
    }
  });

  it('complete text blocks and an answer that already ends with a newline', async () => {
    const sb = mkSandbox({
      script: { turns: [{ match: '^start', steps: [{ text: 'first\n' }] }, { match: '^keep going', steps: [{ text: 'continued' }] }] },
    });
    oneShotStop(sb);
    // no --include-partial-messages (an older CLI): complete `text` events only
    const noPartial = { ...caps, has: (f: string) => f !== '--include-partial-messages' && caps.has(f) };
    const { s } = await open(sb, { caps: noPartial });
    try {
      const { events } = await drain(s.prompt({ text: 'start' }));
      assert.equal(texts(semantic(events)), 'first\n\ncontinued');
    } finally {
      await closeAll(s);
    }
  });

  it('a continuation that starts with a tool call adds no separator (the tool line is the boundary)', async () => {
    const sb = mkSandbox({
      script: {
        turns: [
          { match: '^start', steps: [{ text: 'first' }] },
          { match: '^keep going', steps: [{ tool: { name: 'Read', input: { file_path: '{{cwd}}/f.txt' } } }, { text: 'after tool' }] },
        ],
      },
    });
    sb.write('f.txt', 'x');
    oneShotStop(sb);
    const { s } = await open(sb);
    try {
      const { events } = await drain(s.prompt({ text: 'start' }));
      assert.equal(texts(semantic(events)), 'firstafter tool');
    } finally {
      await closeAll(s);
    }
  });
});

// ───────────────────────────── C19 / C20 ─────────────────────────────

describe('C19 / C20: Claude errors are reported once, in Kiro terms', () => {
  it('a rejected rate limit is one rate_limit event and no extra session notice', async () => {
    const sb = mkSandbox({
      script: { turns: [{ steps: [{ frame: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000, rateLimitType: 'five_hour' } } }, { text: 'x' }] }] },
    });
    const { s, ui } = await open(sb);
    try {
      const { events } = await drain(s.prompt({ text: 'hi' }));
      const sem = semantic(events);
      assert.deepEqual(sem.filter((e) => e.type === 'rate_limit'), [{ type: 'rate_limit', status: 'rejected', resetsAt: 1900000000 }]);
      assert.equal(sem.filter((e) => e.type === 'notice' && /usage limit/i.test(e.message)).length, 0);
      assert.equal(ui.notices.filter((n) => /usage limit/i.test(n.message)).length, 0);
      assert.equal((await s.usage()).rateLimit?.window, 'five_hour', '/usage still reports the window');
    } finally {
      await closeAll(s);
    }
  });

  it("an authentication_failed turn publishes no assistant text (Claude's '/login' advice is not the answer)", async () => {
    const sb = mkSandbox({ script: { turns: [{ steps: [{ error: 'authentication_failed' }] }] } });
    const { s } = await open(sb);
    try {
      const { events, result } = await drain(s.prompt({ text: 'hi' }));
      assert.deepEqual(semantic(events).filter((e) => e.type === 'text' || e.type === 'text_delta'), []);
      assert.equal(result.authError, true);
      assert.equal(result.isError, true);
      const journal = JSON.stringify(readJournal(sb.sessionsDir, s.id));
      assert.doesNotMatch(journal, /Please run \/login/, 'not journaled as an assistant answer');
    } finally {
      await closeAll(s);
    }
  });
});
