/**
 * r7 #3 (session group), end to end (the real runRepl over the fake claude): the model is session
 * state like the agent. `/agent swap` to an agent that pins a model, inside a tangent, then
 * `/tangent`: the main conversation runs that agent on its model (01 §5.4 "Agent swap keeps the
 * model unless target agent sets one"), as the same swap made in main does; so does a `/model`
 * and an `/effort` made inside the tangent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { liveRepl } from '../spec/liveRepl.js';

const script = { default: { steps: [{ text: 'MODEL={{model}} EFFORT={{effort}}' }] } };
const pinned = {
  before(_t: unknown, kiroHome: string): void {
    fs.mkdirSync(path.join(kiroHome, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(kiroHome, 'agents', 'pinned.json'), JSON.stringify({ name: 'pinned', description: 'pinned', tools: ['read'], model: 'claude-haiku-4.5' }));
  },
};
const answerOf = (out: string): string | undefined => /MODEL=\S+ EFFORT=\S*/.exec(out)?.[0];

test('control: /agent swap pinned in main runs the agent on its model', { timeout: 120_000 }, async () => {
  const r = liveRepl(script, pinned);
  try {
    await r.waitFor(/> $/);
    await r.send('hello', /MODEL=[\s\S]*> $/);
    await r.send('/agent swap pinned', /Switched to agent pinned[\s\S]*\[pinned\] > $/);
    const out = await r.send('in main', /MODEL=[\s\S]*\[pinned\] > $/);
    assert.match(answerOf(out) ?? '', /^MODEL=claude-haiku-4-5-20251001 /, out);
  } finally {
    await r.close();
  }
});

test('/agent swap pinned inside a tangent, then /tangent: main runs the agent on its model', { timeout: 120_000 }, async () => {
  const r = liveRepl(script, pinned);
  try {
    await r.waitFor(/> $/);
    const first = await r.send('hello', /MODEL=[\s\S]*> $/);
    assert.doesNotMatch(answerOf(first) ?? '', /haiku/, 'precondition: main starts on another model');
    await r.send('/tangent', /Created a conversation checkpoint[\s\S]*↯ > $/);
    await r.send('/agent swap pinned', /Switched to agent pinned[\s\S]*\[pinned\] ↯ > $/);
    const side = await r.send('in tangent', /MODEL=[\s\S]*\[pinned\] ↯ > $/);
    assert.match(answerOf(side) ?? '', /^MODEL=claude-haiku-4-5-20251001 /, side);
    await r.send('/tangent', /Restored conversation from checkpoint[\s\S]*\[pinned\] > $/);
    const back = await r.send('back in main', /MODEL=[\s\S]*\[pinned\] > $/);
    assert.match(answerOf(back) ?? '', /^MODEL=claude-haiku-4-5-20251001 /, `main runs agent pinned on another model:\n${back}`);
  } finally {
    await r.close();
  }
});

test('/model and /effort inside a tangent, then /tangent: kept in the main conversation', { timeout: 120_000 }, async () => {
  const r = liveRepl(script, pinned);
  try {
    await r.waitFor(/> $/);
    await r.send('hello', /MODEL=[\s\S]*> $/);
    await r.send('/tangent', /Created a conversation checkpoint[\s\S]*↯ > $/);
    await r.send('/model claude-sonnet-4.6', /claude-sonnet-4\.6[\s\S]*↯ > $/);
    await r.send('/effort low', /low[\s\S]*↯ > $/);
    await r.send('/tangent', /Restored conversation from checkpoint[\s\S]*> $/);
    const back = await r.send('back in main', /MODEL=[\s\S]*> $/);
    assert.equal(answerOf(back), 'MODEL=claude-sonnet-4-6 EFFORT=low', back);
  } finally {
    await r.close();
  }
});
