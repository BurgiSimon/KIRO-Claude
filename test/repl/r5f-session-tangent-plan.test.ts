/**
 * r5 #0 (session group), end to end (the real runRepl over the fake claude, --trust-all-tools):
 * plan mode the user turns on inside a tangent holds when the tangent is left, also by the T4
 * auto-exit of `/spec new` in an empty tangent (the spec's phase turn and the chat after Stop
 * stay read-only), and by a plain `/tangent`. Control: the same flow without a tangent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { liveRepl, type LiveRepl } from '../spec/liveRepl.js';

const ASK = /\[y\/n\/t\]:/;
const FLOW = '/spec new first-spec --type feature --workflow requirements-first a csv export';
const CHECKPOINT = /Stop here \(resume later with \/spec first-spec\)[\s\S]*> $/;
const promptOf = (out: string): string | undefined => /(?:^|\n)([^\n]*> )$/.exec(out)?.[1];

const script = {
  turns: [
    { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ tool: { name: 'Bash', input: { command: 'touch made-in-phase.txt', description: 'touch' } } }, { text: 'PHASE-SAID {{lastToolResult}} END' }] },
    { repeat: true, match: 'run it', steps: [{ tool: { name: 'Bash', input: { command: 'touch made-in-chat.txt', description: 'touch' } } }, { text: 'TOOL-SAID {{lastToolResult}} END' }] },
    { repeat: true, steps: [{ text: 'ANSWER' }] },
  ],
};

/** Type `line`, answer `n` at every approval prompt, wait for `done`. */
async function turn(r: LiveRepl, line: string, done: RegExp): Promise<string> {
  const from = r.o().length;
  r.line(line);
  let asked = 0;
  for (;;) {
    const out = await r.waitFor(new RegExp(`(${ASK.source})|(${done.source})`), 30_000, from);
    const n = (out.match(new RegExp(ASK.source, 'g')) ?? []).length;
    if (n > asked) {
      asked = n;
      r.line('n');
      continue;
    }
    if (done.test(out)) return out;
    await new Promise((res) => setTimeout(res, 25));
  }
}

test('control: /plan in main, then /spec new: the phase Bash is denied and the chat stays in plan mode', { timeout: 120_000 }, async () => {
  const r = liveRepl(script, { sessionOptions: { trustAllTools: true } });
  try {
    await r.waitFor(/!> $/);
    await r.send('main MAINLINE', /ANSWER[\s\S]*!> $/);
    await r.send('/plan', /Entered plan mode[\s\S]*\[plan\] !> $/);
    const flow = await turn(r, FLOW, CHECKPOINT);
    assert.match(/PHASE-SAID ([\s\S]*?) END/.exec(flow)?.[1] ?? '', /Plan mode is read-only/, flow);
    const stopped = await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
    assert.equal(promptOf(stopped), '[plan] !> ');
  } finally {
    await r.close();
  }
});

test('/plan inside an empty tangent, then /spec new (T4 leaves the tangent): the phase and the chat stay in plan mode', { timeout: 120_000 }, async () => {
  const r = liveRepl(script, { sessionOptions: { trustAllTools: true } });
  try {
    await r.waitFor(/!> $/);
    await r.send('main MAINLINE', /ANSWER[\s\S]*!> $/);
    await r.send('/tangent side', /Created a conversation checkpoint[\s\S]*↯ !> $/);
    const entered = await r.send('/plan', /Entered plan mode[\s\S]*> $/);
    assert.match(promptOf(entered) ?? '', /^\[plan\] ↯ !> $/, entered);
    const flow = await turn(r, FLOW, CHECKPOINT);
    assert.match(flow, /Left the tangent \(↯\)/, flow);
    const phase = /PHASE-SAID ([\s\S]*?) END/.exec(flow)?.[1] ?? '';
    assert.match(phase, /Plan mode is read-only/, `the phase turn's Bash ran after the user turned plan mode on:\n${flow}`);
    const stopped = await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
    assert.equal(promptOf(stopped), '[plan] !> ', 'plan mode was dropped after the flow');
    const chat = await turn(r, 'run it', /TOOL-SAID [\s\S]*? END[\s\S]*> $/);
    assert.match(/TOOL-SAID ([\s\S]*?) END/.exec(chat)?.[1] ?? '', /Plan mode is read-only/, chat);
  } finally {
    await r.close();
  }
});

for (const exit of ['/tangent', '/tangent tail']) {
  test(`/plan inside a tangent, then ${exit}: plan mode holds in the main conversation`, { timeout: 120_000 }, async () => {
    const r = liveRepl(script, { sessionOptions: { trustAllTools: true } });
    try {
      await r.waitFor(/!> $/);
      await r.send('main MAINLINE', /ANSWER[\s\S]*!> $/);
      await r.send('/tangent side', /Created a conversation checkpoint[\s\S]*↯ !> $/);
      await r.send('tangent line', /ANSWER[\s\S]*↯ !> $/);
      const entered = await r.send('/plan', /Entered plan mode[\s\S]*> $/);
      assert.match(promptOf(entered) ?? '', /^\[plan\] ↯ !> $/, entered);
      const back = await r.send(exit, /Restored conversation[\s\S]*> $/);
      assert.equal(promptOf(back), '[plan] !> ', `plan mode was dropped silently by leaving the tangent:\n${back}`);
      const chat = await turn(r, 'run it', /TOOL-SAID [\s\S]*? END[\s\S]*> $/);
      assert.match(/TOOL-SAID ([\s\S]*?) END/.exec(chat)?.[1] ?? '', /Plan mode is read-only/, `Bash ran after the user turned plan mode on:\n${chat}`);
    } finally {
      await r.close();
    }
  });
}
