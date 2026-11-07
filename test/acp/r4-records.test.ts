/**
 * r4 #10 (ACP / KiroCrew Layer B): a copy of a session record and journal (KiroCrew's
 * `_rewrite_layer_b_envelope` + `_write_layer_b_files`: new sid, `cwd` '', title null, jsonl
 * byte-exact) holds the conversation as it was when copied, also when the copied record's last
 * turn was cancelled before any answer (`session/cancel`: the turn has no assistant uuid) or its
 * journal ends with a compaction. Its first `session/load` forks the original's Claude session
 * pinned at that point (`--resume-session-at`), never the whole source: the original may have
 * been loaded and prompted again since the copy.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestClient, sleep, tmpEnv, writeAgent, type Frame } from './helpers.js';

const SCRIPT = {
  turns: [
    { repeat: true, match: 'RECALL', steps: [{ text: 'claude-context: {{historyUserTexts}}' }] },
    { repeat: true, match: 'SLOWPOKE', steps: [{ sleepMs: 4000 }, { text: 'late answer' }] },
  ],
  default: { steps: [{ text: 'ack' }] },
};

const open: TestClient[] = [];
after(async () => {
  await Promise.allSettled(open.filter((c) => c.exitCode === undefined).map((c) => c.close(15_000)));
});

function setup(): { c: TestClient; dir: string; work: string; log: string } {
  const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT), FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_COMPACT_MS: '5', KIROCREW_SPAWNED: '1' });
  const log = path.join(t.root, 'fake.jsonl');
  t.env.FAKE_CLAUDE_LOG = log;
  writeAgent(path.join(t.work, '.kiro'), 'crew', { description: 'crew agent', tools: ['*'], allowedTools: [], includeMcpJson: false });
  const c = new TestClient({ args: ['--agent-engine', 'v2', '--agent', 'crew'], env: t.env, cwd: t.work });
  open.push(c);
  return { c, dir: path.join(t.kiroHome, 'sessions', 'cli'), work: t.work, log };
}

async function say(c: TestClient, sid: string, text: string): Promise<string> {
  const from = c.frames.length;
  const r = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] }, 30_000);
  assert.ok(!r.error, JSON.stringify(r.error));
  return c.frames
    .slice(from)
    .filter((f: Frame) => f.method === 'session/update' && f.params.sessionId === sid && f.params.update.sessionUpdate === 'agent_message_chunk' && !f.params.update._meta?.kiro?.replay)
    .map((f: Frame) => f.params.update.content.text as string)
    .join('');
}

function layerBCopy(dir: string, sid: string): string {
  const e = JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8')) as Record<string, unknown>;
  const nsid = randomUUID();
  const now = new Date().toISOString();
  const out: Record<string, unknown> = { ...e, session_id: nsid, cwd: '', created_at: now, updated_at: now, title: null };
  const ss = { ...((out.session_state as Record<string, unknown> | undefined) ?? {}) };
  ss.agent_name = 'crew';
  out.session_state = ss;
  fs.writeFileSync(path.join(dir, `${nsid}.json`), JSON.stringify(out), { mode: 0o600 });
  fs.copyFileSync(path.join(dir, `${sid}.jsonl`), path.join(dir, `${nsid}.jsonl`));
  return nsid;
}

interface Copied {
  ctx: string;
  last: { userUuid: string; assistantUuid?: string; preview: string };
  forkArgv: string[] | undefined;
}

async function copyThenOriginalRunsOn(lastStep: (c: TestClient, x: string) => Promise<void>): Promise<Copied> {
  const { c, dir, work, log } = setup();
  await c.initialize();
  const { sessionId: x } = (await c.call('session/new', { cwd: work, mcpServers: [] }, 30_000)) as { sessionId: string };
  await say(c, x, 'alpha');
  await lastStep(c, x);
  await c.call('_kiro.dev/session/terminate', { sessionId: x });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, `${x}.json`), 'utf8')) as { turns: Copied['last'][] };
  const y = layerBCopy(dir, x);
  // the original is reopened and continued after the copy
  await c.call('session/load', { sessionId: x, cwd: work, mcpServers: [] }, 30_000);
  await say(c, x, 'gamma-later');
  await c.call('_kiro.dev/session/terminate', { sessionId: x });
  // the copy's first open
  await c.call('session/load', { sessionId: y, cwd: work, mcpServers: [] }, 30_000);
  const ctx = await say(c, y, 'RECALL');
  await c.close(20_000);
  const starts = fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { event: string; argv?: string[] })
    .filter((l) => l.event === 'start' && l.argv?.includes('--fork-session'));
  return { ctx, last: rec.turns.at(-1)!, forkArgv: starts.at(-1)?.argv };
}

function pin(argv: string[] | undefined): string | undefined {
  const i = argv?.indexOf('--resume-session-at') ?? -1;
  return i >= 0 ? argv![i + 1] : undefined;
}

test('r4 #10 control: a copy whose last turn was answered is pinned at that answer', { timeout: 90_000 }, async () => {
  const { ctx, last, forkArgv } = await copyThenOriginalRunsOn(async (c, x) => {
    await say(c, x, 'beta');
  });
  assert.equal(pin(forkArgv), last.assistantUuid);
  assert.match(ctx, /alpha \| beta \| RECALL/);
  assert.ok(!ctx.includes('gamma-later'), ctx);
});

test('r4 #10: a copy whose last turn was cancelled before any answer does not see the original\'s later turns', { timeout: 90_000 }, async () => {
  const { ctx, last, forkArgv } = await copyThenOriginalRunsOn(async (c, x) => {
    const p = c.request('session/prompt', { sessionId: x, prompt: [{ type: 'text', text: 'SLOWPOKE beta' }] }, 30_000);
    await sleep(400);
    c.notify('session/cancel', { sessionId: x });
    const r = await p;
    assert.equal(r.result?.stopReason, 'cancelled');
  });
  assert.equal(last.preview, 'SLOWPOKE beta');
  assert.equal(last.assistantUuid, undefined, 'precondition: no answer recorded');
  assert.equal(pin(forkArgv), last.userUuid, `pinned at the cancelled line: ${forkArgv?.join(' ')}`);
  assert.match(ctx, /alpha \| SLOWPOKE beta \| RECALL/);
  assert.ok(!ctx.includes('gamma-later'), `the copy sees a turn the original made after the copy: ${ctx}`);
});

test('r4 #10: a copy whose journal ends with a compaction does not see the original\'s later turns', { timeout: 90_000 }, async () => {
  const { ctx, last, forkArgv } = await copyThenOriginalRunsOn(async (c, x) => {
    await say(c, x, 'beta');
    await c.call('_kiro.dev/commands/execute', { sessionId: x, command: { command: 'compact', args: {} } }, 30_000);
  });
  assert.equal(pin(forkArgv), last.assistantUuid, `pinned at the last turn: ${forkArgv?.join(' ')}`);
  assert.match(ctx, /alpha \| beta \| RECALL/);
  assert.ok(!ctx.includes('gamma-later'), `the copy sees a turn the original made after the copy: ${ctx}`);
});
