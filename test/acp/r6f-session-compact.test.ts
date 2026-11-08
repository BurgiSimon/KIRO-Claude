/**
 * r6 #4 (session group) seen from ACP: `_kiro.dev/commands/execute compact` withdrawn while Claude
 * compacts, with the frames real claude 2.1.319 sends for that interrupt (a failed status whose
 * `compact_error` is `API Error: Request was aborted.`, a synthetic `Compaction canceled.`, a
 * success result with `local_command:"compact"`; the fake's interrupted /compact): the answer is
 * `Command cancelled` and the `failed` compaction status says `Compaction cancelled` in `summary`
 * and `reason` (KiroCrew shows the top-level `reason`), never the API error.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TestClient, sleep, tmpEnv, type Frame } from './helpers.js';

const SCRIPT = { turns: [], default: { steps: [{ text: 'ok {{historyCount}}' }] } };

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(15_000)));
});

const compactStatuses = (c: TestClient, from: number): Frame[] => c.frames.slice(from).filter((f) => f.method === '_kiro.dev/compaction/status').map((f) => f.params);

describe('r6 #4: a withdrawn compaction with real 2.1.319 frames is cancelled, not an API error', () => {
  for (const how of ['$/cancel_request', 'session/cancel'] as const) {
    test(`commands/execute compact cancelled by ${how} while Claude compacts`, async () => {
      const t = tmpEnv({ FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(SCRIPT), FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_COMPACT_MS: '3000' });
      const c = new TestClient({ args: [], env: t.env, cwd: t.work });
      clients.push(c);
      await c.initialize();
      const { sessionId: sid } = (await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000)) as { sessionId: string };
      for (const text of ['first turn', 'second turn']) await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] }, 30_000);
      await sleep(100);
      const before = c.frames.length;
      const id = 620_001;
      const response = c.waitFor((f) => f.id === id && f.method === undefined && ('result' in f || 'error' in f), 30_000, 'compact answer', c.frames.length);
      c.send({ jsonrpc: '2.0', id, method: '_kiro.dev/commands/execute', params: { sessionId: sid, command: { command: 'compact', args: {} } } });
      await c.waitFor((f) => f.method === '_kiro.dev/compaction/status' && f.params.status.type === 'started', 10_000, 'started', before);
      await sleep(100);
      if (how === '$/cancel_request') c.notify('$/cancel_request', { requestId: id });
      else c.notify('session/cancel', { sessionId: sid });
      const r = await response;
      await sleep(300);
      const statuses = compactStatuses(c, before);
      const info = `answer ${JSON.stringify(r.result ?? r.error)}; statuses ${JSON.stringify(statuses)}`;
      assert.deepEqual(r.result, { success: false, message: 'Command cancelled' }, info);
      assert.deepEqual(statuses.map((p) => p.status.type), ['started', 'failed'], info);
      assert.equal(statuses[1]!.summary, 'Compaction cancelled', info);
      assert.equal(statuses[1]!.reason, 'Compaction cancelled', info);
      assert.ok(!JSON.stringify(c.frames.slice(before)).includes('Request was aborted'), `the API error reached the client: ${info}`);
      // nothing was compacted: the next turn still sees both earlier lines
      const from = c.frames.length;
      await c.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'after' }] }, 30_000);
      const text = c.frames.slice(from).filter((f) => f.method === 'session/update' && f.params.update.sessionUpdate === 'agent_message_chunk').map((f) => f.params.update.content.text).join('');
      assert.match(text, /^ok 3\b/, text);
      assert.equal(await c.close(15_000), 0);
    });
  }
});
