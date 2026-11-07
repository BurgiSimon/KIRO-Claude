/**
 * Adversarial checks of the final-review fixes in session/ (F1, F7, F8, F9), on paths the
 * guards in finalreview.test.ts do not reach: the child cannot be restarted before the line is
 * written (F1 case 2), a cancelled first prompt in a tangent that holds a copy of main's carry
 * (F1 × F9), a mixed allow/deny batch of asked Agent calls and an approval prompt Claude
 * withdraws itself (F7), and the order of a carry after the restored history of a `/chat load`
 * that starts a fresh Claude session (F8).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { importSessionExport, KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
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

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const TANGENT_SCRIPT = {
  turns: [{ repeat: true, match: '^Summarize the findings', steps: [{ text: 'SUMMARY: the tangent found FOUND_X' }] }],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

describe('F1 (verify): a carry survives a prompt whose Claude child cannot be restarted', () => {
  it('ensureProcess fails after the turn was composed: the carry stays queued (memory and disk) and reaches the next line once', async () => {
    const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb);
    try {
      await drain(s.prompt({ text: 'm1' }));
      const mainId = s.id;
      await s.enterTangent('research');
      await drain(s.prompt({ text: 'finding FOUND_X' }));
      await s.exitTangent('merge');
      // the child dies, and the next spawn fails
      const proc = s.process!;
      sb.env.FAKE_CLAUDE_EXIT_ON_START = '1';
      process.kill(proc.pid!, 'SIGKILL');
      await waitFor(() => !proc.running);
      const before = sb.userLines().length;
      await assert.rejects(drain(s.prompt({ text: 'lost?' })));
      assert.equal(sb.userLines().length, before, 'Claude never got the line');
      assert.match((s.record.pendingContext ?? []).join('\n'), /tangent-summary/, 'still queued in memory');
      assert.match(new SessionStore(sb.sessionsDir).read(mainId)?.pendingContext?.join('\n') ?? '', /tangent-summary/, 'still queued on disk');
      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      await drain(s.prompt({ text: 'after restart' }));
      const sent = lastUserText(sb);
      assert.match(sent, /<tangent-summary name="research">[\s\S]*FOUND_X[\s\S]*after restart/);
      assert.equal(count(sent, '<tangent-summary'), 1);
      await drain(s.prompt({ text: 'again' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary/);
    } finally {
      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      await closeAll(s);
    }
  });
});

describe('F1 × F9 (verify): the tangent copy of a carry survives a cancelled first tangent prompt', () => {
  it('the tangent gets its copy on its next line, main still gets its own exactly once', async () => {
    const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    sb.agent('slowhook', { tools: ['*'], hooks: { userPromptSubmit: [{ command: 'if grep -q SLOW; then sleep 5; fi; true' }] } });
    const { s } = await open(sb, { agentName: 'slowhook' });
    try {
      await drain(s.prompt({ text: 'm1' }));
      const mainId = s.id;
      await s.enterTangent('first');
      await drain(s.prompt({ text: 'finding FOUND_X' }));
      await s.exitTangent('merge');
      await s.enterTangent('second');
      const tangentId = s.id;
      const p = drain(s.prompt({ text: 'SLOW in second' }));
      await sleep(400);
      await s.interrupt();
      assert.equal((await p).result.stopReason, 'cancelled');
      assert.match(new SessionStore(sb.sessionsDir).read(tangentId)?.pendingContext?.join('\n') ?? '', /tangent-summary/, 'the tangent copy is back on disk');
      await drain(s.prompt({ text: 'what did first find?' }));
      assert.match(lastUserText(sb), /<tangent-summary name="first">[\s\S]*FOUND_X[\s\S]*what did first find\?/);
      await s.exitTangent('discard');
      assert.equal(s.id, mainId);
      await drain(s.prompt({ text: 'back-in-main' }));
      const sent = lastUserText(sb);
      assert.equal(count(sent, '<tangent-summary name="first">'), 1);
      await drain(s.prompt({ text: 'later' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary/);
    } finally {
      await closeAll(s);
    }
  });
});

describe('F7 (verify): asked Agent calls', () => {
  const agentTool = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: 'Agent',
    input: { description: `task ${id}`, prompt: `Do ${id}.`, subagent_type: 'general-purpose' },
    result: `${id} done`,
    ...extra,
  });

  it('a parallel batch, one approved and one denied: only the approved call is a subagent', async () => {
    const sb = mkSandbox({ script: { turns: [{ match: '^GO', steps: [{ parallel: [agentTool('toolu_a'), agentTool('toolu_b')] }, { text: 'done' }] }] } });
    sb.agent('probe', { tools: ['*'], allowedTools: [] });
    const ui = recordingUI();
    ui.answers.push(async (r) => (r.call.toolUseId === 'toolu_b' ? { kind: 'deny' } : { kind: 'allow-once' }));
    ui.answers.push(async (r) => (r.call.toolUseId === 'toolu_b' ? { kind: 'deny' } : { kind: 'allow-once' }));
    const { s } = await open(sb, { agentName: 'probe' }, ui);
    try {
      const { events } = await drain(s.prompt({ text: 'GO both' }));
      assert.equal(ui.approvals.length, 2);
      const sub = events.filter((e) => e.type === 'subagent') as Extract<SessionEvent, { type: 'subagent' }>[];
      assert.deepEqual(
        sub.map((e) => `${e.toolUseId}:${e.state}`),
        ['toolu_a:started', 'toolu_a:finished'],
      );
      assert.equal(sub[1]!.isError, false);
    } finally {
      await closeAll(s);
    }
  });

  it('Claude withdraws the approval prompt (control_cancel_request): no subagent at all', async () => {
    const sb = mkSandbox({ script: { turns: [{ match: '^GO', steps: [{ tool: agentTool('toolu_w', { cancelAfterMs: 150 }) }, { text: 'after' }] }] } });
    sb.agent('probe', { tools: ['*'], allowedTools: [] });
    const ui = recordingUI();
    ui.answers.push(
      (_r, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ kind: 'deny' }), { once: true });
        }),
    );
    const { s } = await open(sb, { agentName: 'probe' }, ui);
    try {
      const { events } = await drain(s.prompt({ text: 'GO withdrawn' }));
      assert.equal(ui.approvals.length, 1, 'the call asked');
      assert.deepEqual(events.filter((e) => e.type === 'subagent'), []);
    } finally {
      await closeAll(s);
    }
  });
});

describe('F8 (verify): /chat load into a fresh Claude session', () => {
  it('the carry follows the restored history on the first line, once', async () => {
    const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { s } = await open(sb);
    let file: string;
    try {
      await drain(s.prompt({ text: 'm1 HISTORY_MARK' }));
      await s.enterTangent('research');
      await drain(s.prompt({ text: 'finding FOUND_X' }));
      await s.exitTangent('merge');
      file = await s.exportTo(path.join(sb.root, 'exp.json'), false);
    } finally {
      await closeAll(s);
    }
    // no usable transcript: neither embedded nor findable under the exported id
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeTranscript?: string; session: { claudeSessionId: string } };
    data.claudeTranscript = '';
    data.session.claudeSessionId = 'not-a-uuid';
    fs.writeFileSync(file, JSON.stringify(data));
    const imported = await importSessionExport(file, { ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), env: sb.env });
    try {
      await drain(imported.prompt({ text: 'after load' }));
      const sent = lastUserText(sb);
      assert.match(sent, /HISTORY_MARK/, 'restored history');
      assert.equal(count(sent, '<tangent-summary'), 1);
      assert.ok(sent.indexOf('HISTORY_MARK') < sent.indexOf('<tangent-summary'), 'history first, then the carry');
      assert.ok(sent.indexOf('<tangent-summary') < sent.lastIndexOf('after load'));
      await drain(imported.prompt({ text: 'next' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary|HISTORY_MARK/);
    } finally {
      await closeAll(imported);
    }
  });
});
