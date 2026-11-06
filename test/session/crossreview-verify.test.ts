/**
 * Adversarial follow-ups to the session cross-review fixes (C6 per-agent trust, C7 tangent
 * carry, C9 close during a respawn): paths the first guards did not cover.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionEvent, TurnResult } from '../../src/types.js';
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

function toolStart(events: SessionEvent[]): Extract<SessionEvent, { type: 'tool_start' }> | undefined {
  return events.find((e) => e.type === 'tool_start') as Extract<SessionEvent, { type: 'tool_start' }> | undefined;
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

/** A Bash call on every prompt starting with "run"; any other prompt gets a plain answer. */
const BASH_SCRIPT = {
  turns: [{ repeat: true, match: '^run', steps: [{ tool: { name: 'Bash', input: { command: 'echo hi' } } }, { text: 'done' }] }],
  default: { steps: [{ text: 'ok' }] },
};

describe('C6 follow-up: an /agent swap made inside a tangent', () => {
  it('stays the active agent after the tangent ends, and the main record names it (no trust leak on resume)', async () => {
    const sb = mkSandbox({ script: BASH_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    sb.agent('a', { tools: ['*'] });
    sb.agent('b', { tools: ['*'] });
    const { s } = await open(sb, { agentName: 'a' });
    let mainId: string;
    try {
      await drain(s.prompt({ text: 'm1' }));
      mainId = s.id;
      await s.enterTangent('side');
      await s.swapAgent('b');
      s.trustTools(['shell']); // granted under b
      await s.exitTangent('discard');
      // Q's tangent checkpoint holds the conversation only (06 §6.4): the swapped agent stays
      assert.equal(s.agent.name, 'b');
      assert.equal(s.record.agent, 'b', 'the main record names the agent that runs it');
    } finally {
      await closeAll(s);
    }
    assert.equal(new SessionStore(sb.sessionsDir).read(mainId)!.agent, 'b');
    // resume main without --agent: b, with b's trust; a never got shell trusted
    const ui = recordingUI();
    const { s: r } = await open(sb, { resume: { sessionId: mainId } }, ui);
    try {
      assert.equal(r.agent.name, 'b');
      const t1 = await drain(r.prompt({ text: 'run1' }));
      assert.equal(toolStart(t1.events)?.trusted, true, "b keeps the trust granted under b");
      await r.swapAgent('a');
      ui.answers.push({ kind: 'deny' });
      const t2 = await drain(r.prompt({ text: 'run2' }));
      assert.equal(toolStart(t2.events)?.trusted, false, `shell granted under b is trusted under a: ${JSON.stringify(r.trust)}`);
      assert.equal(ui.approvals.length, 1);
    } finally {
      await closeAll(r);
    }
  });

  it("the main agent's own trust survives a swap inside a tangent and a resume", async () => {
    const sb = mkSandbox({ script: BASH_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    sb.agent('a', { tools: ['*'] });
    sb.agent('b', { tools: ['*'] });
    const { s } = await open(sb, { agentName: 'a' });
    let mainId: string;
    try {
      s.trustTools(['shell']); // granted under a
      await drain(s.prompt({ text: 'm1' }));
      mainId = s.id;
      await s.enterTangent('side');
      await s.swapAgent('b');
      await s.exitTangent('discard');
    } finally {
      await closeAll(s);
    }
    const ui = recordingUI();
    const { s: r } = await open(sb, { resume: { sessionId: mainId } }, ui);
    try {
      ui.answers.push({ kind: 'deny' });
      const t1 = await drain(r.prompt({ text: 'run1' }));
      assert.equal(toolStart(t1.events)?.trusted, false, `${r.agent.name} (never trusted shell) runs it trusted`);
      await r.swapAgent('a');
      const t2 = await drain(r.prompt({ text: 'run2' }));
      assert.equal(toolStart(t2.events)?.trusted, true, `a lost its own trust: ${JSON.stringify(r.trust)}`);
      assert.equal(ui.approvals.length, 1);
    } finally {
      await closeAll(r);
    }
  });
});

describe('C6 follow-up: quitting inside a tangent after an /agent swap', () => {
  it("the main record is written naming the active agent, so its trust stays attributed", async () => {
    const sb = mkSandbox({ script: BASH_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    sb.agent('a', { tools: ['*'] });
    sb.agent('b', { tools: ['*'] });
    const { s } = await open(sb, { agentName: 'a' });
    let mainId: string;
    try {
      s.trustTools(['shell']); // granted under a
      await drain(s.prompt({ text: 'm1' }));
      mainId = s.id;
      await s.enterTangent('side');
      await s.swapAgent('b');
    } finally {
      await closeAll(s); // quit without leaving the tangent
    }
    const main = new SessionStore(sb.sessionsDir).read(mainId)!;
    assert.equal(main.agent, 'b');
    assert.deepEqual(main.trust.allowedTools, [], "b's (empty) trust is the flat part");
    assert.deepEqual(main.trust.byAgent?.a?.allowedTools, ['execute_bash']);
    const ui = recordingUI();
    const { s: r } = await open(sb, { resume: { sessionId: mainId } }, ui);
    try {
      ui.answers.push({ kind: 'deny' });
      const t1 = await drain(r.prompt({ text: 'run1' }));
      assert.equal(toolStart(t1.events)?.trusted, false);
      await r.swapAgent('a');
      const t2 = await drain(r.prompt({ text: 'run2' }));
      assert.equal(toolStart(t2.events)?.trusted, true);
    } finally {
      await closeAll(r);
    }
  });
});

describe('C6 follow-up: the saved agent no longer exists on resume', () => {
  it('the fallback agent does not inherit its trust, which stays parked under its name', async () => {
    const sb = mkSandbox({ script: BASH_SCRIPT });
    const file = sb.agent('gone', { tools: ['*'] });
    const { s } = await open(sb, { agentName: 'gone' });
    const id = s.id;
    try {
      s.trustTools(['shell']);
      await drain(s.prompt({ text: 'run1' }));
    } finally {
      await closeAll(s);
    }
    fs.rmSync(file);
    const ui = recordingUI();
    ui.answers.push({ kind: 'deny' });
    const { s: r } = await open(sb, { resume: { sessionId: id } }, ui);
    try {
      assert.notEqual(r.agent.name, 'gone');
      assert.ok(ui.notices.some((n) => /Agent gone of the saved session is no longer available/.test(n.message)));
      const t = await drain(r.prompt({ text: 'run2' }));
      assert.equal(toolStart(t.events)?.trusted, false);
      assert.deepEqual(r.trust.byAgent?.gone?.allowedTools, ['execute_bash']);
    } finally {
      await closeAll(r);
    }
  });
});

describe("C14 follow-up: a subagent's call to its own inline server goes through the gate", () => {
  it('maps back to the Kiro server (also under a renamed Claude name) and enforces the subagent selection', async () => {
    const call = (name: string, id: string): Record<string, unknown> => ({ tool: { name, id, input: {}, result: 'TOKEN', agent_id: 'ag1', agent_type: 'own' } });
    const sb = mkSandbox({
      script: {
        turns: [
          { match: '^go', steps: [call('mcp__own__get_token', 'toolu_1'), call('mcp__own__drop_table', 'toolu_2'), call('mcp__gsrv_2__get_token', 'toolu_3'), { text: 'done' }] },
        ],
      },
    });
    sb.agent('lead', { tools: ['read', '@gsrv', 'subagent/own'], includeMcpJson: false, mcpServers: { gsrv: { command: 'parent-cmd' } } });
    sb.agent('own', {
      tools: ['read', '@own/get_token', '@gsrv'],
      includeMcpJson: false,
      mcpServers: { own: { command: 'own-cmd' }, gsrv: { command: 'child-cmd' } },
    });
    const ui = recordingUI();
    const { s } = await open(sb, { agentName: 'lead' }, ui);
    try {
      assert.equal(s.lastLaunch?.mcpNameMap.own, 'own');
      assert.equal(s.lastLaunch?.mcpNameMap.gsrv_2, 'gsrv');
      const { events } = await drain(s.prompt({ text: 'go' }));
      // get_token: selected for `own`, not trusted by anyone ⇒ asks, as @own/get_token inside agent own
      const asked = ui.approvals.map((a) => ({ server: a.call.mcp?.server, tool: a.call.mcp?.tool, agent: a.agentName }));
      assert.deepEqual(asked, [
        { server: 'own', tool: 'get_token', agent: 'own' },
        { server: 'gsrv', tool: 'get_token', agent: 'own' },
      ]);
      // drop_table: not in the subagent's selection ⇒ denied without asking
      const denied = events.filter((e) => e.type === 'tool_denied') as Extract<SessionEvent, { type: 'tool_denied' }>[];
      assert.equal(denied.length, 1, JSON.stringify(denied));
      assert.match(JSON.stringify(denied[0]), /@own\/drop_table is not enabled for agent own/);
    } finally {
      await closeAll(s);
    }
  });
});

describe("C14 follow-up: a subagent server's own autoApprove list", () => {
  it('is used for its calls, also when a parent server of the same Kiro name has a different one', async () => {
    const sub = (name: string, id: string): Record<string, unknown> => ({ tool: { name, id, input: {}, result: 'TOKEN', agent_id: 'ag1', agent_type: 'own' } });
    const sb = mkSandbox({
      script: {
        turns: [
          {
            match: '^go',
            steps: [
              sub('mcp__own__get_token', 'toolu_1'),
              sub('mcp__gsrv_2__get_token', 'toolu_2'),
              { tool: { name: 'mcp__gsrv__get_token', id: 'toolu_3', input: {}, result: 'TOKEN' } },
              { text: 'done' },
            ],
          },
        ],
      },
    });
    sb.agent('lead', { tools: ['read', '@gsrv', 'subagent/own'], includeMcpJson: false, mcpServers: { gsrv: { command: 'parent-cmd' } } });
    sb.agent('own', {
      tools: ['read', '@own', '@gsrv'],
      includeMcpJson: false,
      mcpServers: { own: { command: 'own-cmd', autoApprove: ['get_*'] }, gsrv: { command: 'child-cmd', autoApprove: ['get_token'] } },
    });
    const ui = recordingUI();
    const { s } = await open(sb, { agentName: 'lead' }, ui);
    try {
      assert.deepEqual({ ...s.lastLaunch?.mcpAutoApprove }, { gsrv: [], own: ['get_*'], gsrv_2: ['get_token'] });
      const { events } = await drain(s.prompt({ text: 'go' }));
      // only the parent's own gsrv (no autoApprove) asks; the subagent's servers approve themselves
      assert.deepEqual(
        ui.approvals.map((a) => a.call.claudeName),
        ['mcp__gsrv__get_token'],
      );
      assert.equal(events.filter((e) => e.type === 'tool_denied').length, 0);
    } finally {
      await closeAll(s);
    }
  });
});

describe("C20 follow-up: Claude's '/login' advice is no answer anywhere", () => {
  it('the session list preview and the tangent tail do not carry it', async () => {
    const sb = mkSandbox({ script: { turns: [{ match: '^hi', steps: [{ error: 'authentication_failed' }] }], default: { steps: [{ text: 'ok' }] } } });
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'first' }));
      await s.enterTangent('t');
      const { result } = await drain(s.prompt({ text: 'hi there' }));
      assert.equal(result.authError, true);
      assert.doesNotMatch(s.record.lastPreview, /\/login/, 'shown by /chat and --list-sessions as the last message');
      assert.equal(s.record.lastPreview, 'hi there');
      await s.exitTangent('tail');
      assert.doesNotMatch(JSON.stringify(s.record.pendingContext ?? []), /\/login/);
    } finally {
      await closeAll(s);
    }
  });
});

describe('C7 follow-up: several tangents merged before main speaks again', () => {
  it('main gets every carry, in order, once', async () => {
    const sb = mkSandbox({
      script: {
        turns: [
          { repeat: true, match: '^Summarize the findings', steps: [{ text: 'SUMMARY {{historyUserTexts}}' }] },
        ],
        default: { steps: [{ text: 'ok' }] },
      },
      env: { FAKE_CLAUDE_PERSIST: '1' },
    });
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'm1' }));
      await s.enterTangent('one');
      await drain(s.prompt({ text: 'FIND_ONE' }));
      await s.exitTangent('merge');
      await s.enterTangent('two');
      await drain(s.prompt({ text: 'FIND_TWO' }));
      await s.exitTangent('tail');
      await drain(s.prompt({ text: 'back' }));
      const lines = sb.userLines();
      const last = contentText(lines[lines.length - 1]!);
      assert.match(last, /<tangent-summary name="one">[\s\S]*FIND_ONE[\s\S]*<tangent-tail name="two">[\s\S]*FIND_TWO[\s\S]*back/);
      await drain(s.prompt({ text: 'again' }));
      assert.doesNotMatch(contentText(sb.userLines().at(-1)!), /tangent-/);
    } finally {
      await closeAll(s);
    }
  });
});

describe('C11 follow-up: /tangent merge is interruptible before Claude starts the summary turn', () => {
  it('an interrupt right after the merge starts cancels it and stays in the tangent', async () => {
    const sb = mkSandbox({
      script: {
        turns: [{ repeat: true, match: '^Summarize the findings', steps: [{ sleepMs: 3000 }, { text: 'SUMMARY' }] }],
        default: { steps: [{ text: 'ok' }] },
      },
      env: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 800 }) },
    });
    const { s } = await open(sb);
    const pids = (): number[] => [...new Set(sb.log().filter((e) => e.event === 'start' && (e.argv as string[]).includes('-p')).map((e) => e.pid as number))];
    try {
      await drain(s.prompt({ text: 'm1' }));
      await s.enterTangent('one');
      await drain(s.prompt({ text: 'FIND_ONE' }));
      // the tangent's child died: the merge first respawns it (slow initialize), so a Ctrl+C
      // lands while there is no busy child to interrupt
      const before = pids().length;
      process.kill(pids().at(-1)!, 'SIGKILL');
      assert.ok(await waitFor(() => s.process?.running !== true, 5_000), 'the child is gone');
      const t0 = Date.now();
      const merge = s.exitTangent('merge');
      merge.catch(() => undefined);
      assert.ok(await waitFor(() => pids().length > before, 10_000), 'the merge respawned claude');
      await s.interrupt();
      await assert.rejects(merge, /Merge cancelled — interrupted/);
      assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms: the summary turn ran to its end`);
      assert.equal(s.record.forkKind, 'tangent', 'still in the tangent');
      // the session is usable afterwards
      const { result } = await drain(s.prompt({ text: 'after' }));
      assert.equal(result.isError, false);
    } finally {
      await closeAll(s);
    }
  });
});

describe('C9 follow-up: close() while a crashed child is being respawned for a prompt', () => {
  it('leaves no claude child and no runtime dir behind', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 400 }) } });
    const { s } = await open(sb);
    const pids = (): number[] => [...new Set(sb.log().filter((e) => e.event === 'start' && (e.argv as string[]).includes('-p')).map((e) => e.pid as number))];
    try {
      assert.equal(pids().length, 1);
      process.kill(pids()[0]!, 'SIGKILL');
      assert.ok(await waitFor(() => s.process?.running !== true, 5_000), 'the first child is gone');
      const turn: Promise<TurnResult | Error> = drain(s.prompt({ text: 'hi' })).then(
        (r) => r.result,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );
      assert.ok(await waitFor(() => pids().length >= 2, 10_000), 'the prompt respawned claude');
      await s.close();
      const r = await turn;
      // the turn ends as an error (or throws): never as a normal answer from a closed session
      assert.ok(r instanceof Error ? /closed/i.test(r.message) : r.isError === true, `turn result: ${JSON.stringify(r)}`);
      const gone = await waitFor(() => pids().every((p) => !alive(p)), 5_000);
      assert.ok(gone, `claude children still running after close: ${pids().filter(alive).join(', ')}`);
      assert.equal(s.process, undefined);
      assert.equal(fs.existsSync(s.runtimeDir), false, 'no runtime dir left behind');
    } finally {
      for (const p of pids()) if (alive(p)) process.kill(p, 'SIGKILL');
      await closeAll(s);
    }
  });
});
