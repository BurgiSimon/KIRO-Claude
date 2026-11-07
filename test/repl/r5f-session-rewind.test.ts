/**
 * r5 #2 (session group), end to end: `/rewind` in the untouched continuation a /spec flow handed
 * over (its parent phase record removed by discardSuperseded) keeps that continuation, the only
 * record of the spec turns, and the REPL names a record that exists ("The original conversation
 * is kept as <id>"); also after a local `/effort` in it. And the command itself: when the rewind
 * dropped the record it left (an untouched copy whose parent holds it all), the message names the
 * parent; it never names an id that is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createWorkspaceContext } from '../../src/config/workspace.js';
import { rewindCommand } from '../../src/repl/commands/conversation.js';
import type { ReplContext } from '../../src/repl/types.js';
import { SessionStore, sessionsDir } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { stripAnsi } from '../../src/util/ansi.js';
import { liveRepl } from '../spec/liveRepl.js';
import { tempEnv } from './harness.js';

const SCRIPT = {
  turns: [
    { repeat: true, match: 'kiro-spec-mode', steps: [{ text: 'phase answer SPEC_TURN' }] },
    { repeat: true, steps: [{ text: 'HIST<<{{historyUserTexts}}>>' }] },
  ],
};

function records(dir: string): SessionRecord[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SessionRecord);
}

for (const variant of ['plain', 'after a local /effort']) {
  test(`/rewind in an untouched /spec continuation keeps it and names it (${variant})`, { timeout: 120_000 }, async () => {
    const r = liveRepl(SCRIPT);
    const dir = path.join(r.t.home, '.kiro', 'sessions', 'cli');
    try {
      await r.waitFor(/> $/);
      await r.send('first chat line', /HIST<<first chat line>>[\s\S]*> $/);
      await r.send('second chat line', /HIST<<first chat line \| second chat line>>[\s\S]*> $/);
      await r.send('/spec new spec-one --type feature --workflow requirements-first a csv export', /Stop here \(resume later with \/spec [^)]+\)[\s\S]*> $/, 30_000);
      await r.send('Stop', /Stopped[\s\S]*> $/, 30_000);
      if (variant !== 'plain') await r.send('/effort high', /> $/);
      const before = records(dir);
      const cont = before.find((x) => x.turns.length === 3);
      assert.ok(cont, `precondition: a 3-turn continuation: ${JSON.stringify(before.map((x) => [x.origin, x.turns.length]))}`);
      assert.ok(!before.some((x) => x.origin === 'spec'), 'precondition: the phase records were discarded');
      const out = await r.send('/rewind 1', /Rewound[\s\S]*> $/, 30_000);
      const named = /kept as ([0-9a-f-]{36})/.exec(out)?.[1];
      assert.equal(named, cont.sessionId, out);
      const after = records(dir);
      assert.ok(after.some((x) => x.sessionId === named && x.turns.length === 3), 'the 3-turn spec conversation is gone');
      const next = await r.send('after the rewind', /HIST<<[^>]*>>[\s\S]*> $/, 30_000);
      assert.match(next, /HIST<<first chat line \| after the rewind>>/, next);
    } finally {
      await r.close();
    }
  });
}

/** rewindCommand on a stand-in session whose rewind drops the record it leaves (or not). */
async function runRewind(drop: boolean): Promise<{ out: string; parentId: string; leftId: string }> {
  const t = tempEnv();
  try {
    const ws = createWorkspaceContext(t.wsDir, t.env);
    const store = new SessionStore(sessionsDir(ws));
    const turn = (n: number) => ({ userUuid: `00000000-0000-4000-8000-00000000000${n}`, assistantUuid: `00000000-0000-4000-8000-00000000010${n}`, preview: `q${n}`, at: '' });
    const parent = store.create({ origin: 'repl', cwd: t.wsDir, agent: 'kiro_default', model: 'auto', claudeSessionId: '11111111-1111-4111-8111-111111111111', turns: [turn(1), turn(2)], messageCount: 2 });
    const left = store.create({ origin: 'repl', cwd: t.wsDir, agent: 'kiro_default', model: 'auto', claudeSessionId: '22222222-2222-4222-8222-222222222222', parentId: parent.sessionId, turns: [turn(1), turn(2)], messageCount: 2 });
    let current: SessionRecord = left;
    let out = '';
    const session = {
      get id() {
        return current.sessionId;
      },
      get record() {
        return current;
      },
      async rewind(n: number) {
        const rec = store.create({ origin: 'repl', cwd: t.wsDir, agent: 'kiro_default', model: 'auto', claudeSessionId: '33333333-3333-4333-8333-333333333333', parentId: left.sessionId, forkKind: 'rewind', turns: left.turns.slice(0, n), messageCount: n });
        if (drop) store.delete(left.sessionId);
        current = rec;
      },
    };
    const r = { session, ws, write: (s: string) => (out += s), refreshUsage: async () => undefined } as unknown as ReplContext;
    await rewindCommand.run(['1'], '/rewind 1', r);
    return { out: stripAnsi(out), parentId: parent.sessionId, leftId: left.sessionId };
  } finally {
    t.cleanup();
  }
}

test('/rewind names the record it left when that record is kept', async () => {
  const { out, leftId } = await runRewind(false);
  assert.match(out, new RegExp(`Rewound the conversation to turn 1\\. The original conversation is kept as ${leftId}\\.`), out);
});

test('/rewind that dropped the untouched copy it left names the parent that holds it, not the deleted id', async () => {
  const { out, leftId, parentId } = await runRewind(true);
  assert.doesNotMatch(out, new RegExp(leftId), out);
  assert.match(out, new RegExp(`The original conversation is kept as ${parentId}\\.`), out);
});
