/**
 * Round 5, group spec-policy (scratchpad r4f-gaps.md), end to end: the real runRepl and
 * session/kiroSession over test/fixtures/fake-claude.mjs, everything in a temp root
 * (test/spec/liveRepl.ts). Unit-level guards of the same items: test/spec/r5-spec-policy*.test.ts.
 *
 *  - T1: `/tools` trust state survives a /spec flow: a `/tools untrust` of a launch --trust-tools
 *    tool or of an agent-allowed tool holds in the phase turns and after Stop; a `t` answered in a
 *    phase turn reaches the chat's continuation.
 *  - T2: in a plan-mode chat (--trust-all-tools) a phase turn's Bash is denied (plan mode), its own
 *    document write is allowed, and the session the checkpoint runs in is in plan mode (Shift+Tab
 *    there leaves it: the prompt is redrawn as `!> `).
 *  - T3: `/spec run` in plan mode is refused (no task session starts, tasks.md unchanged).
 *  - T4: `/spec new` inside a tangent is refused; `/tangent` then returns to the main conversation.
 *  - T5: after two flows and a quit the index holds the chat's records only (main and the two
 *    continuations); each continuation still resumes with its spec turns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createWorkspaceContext } from '../../src/config/workspace.js';
import { createSession } from '../../src/session/kiroSession.js';
import type { SessionRecord, SessionUI } from '../../src/types.js';
import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';
import type { TempEnv } from './harness.js';
import { liveRepl, seedTodoExport, type LiveRepl } from '../spec/liveRepl.js';

const ASK = /\[y\/n\/t\]:/;
const SHIFT_TAB = '\u001b[Z';
/** The prompt the output ends with (a redraw starts its line with `\r`). */
const lastPrompt = (out: string): string | undefined => /(?:^|[\r\n])([^\r\n]*> )$/.exec(out)?.[1];
const promptOf = (out: string): string | undefined => /(?:^|\n)([^\n]*> )$/.exec(out)?.[1];
const FLOW = '/spec new first-spec --type feature --workflow requirements-first a csv export';
const CHECKPOINT = /Stop here \(resume later with \/spec first-spec\)[\s\S]*> $/;

const trustScript = {
  turns: [
    { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ tool: { name: 'Bash', input: { command: 'rm -rf build', description: 'clean' } } }, { text: 'PHASE-SAID {{lastToolResult}} END' }] },
    { repeat: true, match: 'run it', steps: [{ tool: { name: 'Bash', input: { command: 'rm -rf build', description: 'clean' } } }, { text: 'TOOL-SAID {{lastToolResult}} END' }] },
    { repeat: true, steps: [{ text: 'ANSWER' }] },
  ],
};

/** Send `line`; answer every approval prompt with `answer`; return the output up to the next main prompt. */
async function turn(r: LiveRepl, line: string, done: RegExp, answer = 'n'): Promise<{ out: string; asked: number }> {
  const from = r.o().length;
  r.line(line);
  let asked = 0;
  for (;;) {
    const out = await r.waitFor(new RegExp(`(${ASK.source})|(${done.source})`), 30_000, from);
    const n = (out.match(new RegExp(ASK.source, 'g')) ?? []).length;
    if (n > asked) {
      asked = n;
      r.line(answer);
      continue;
    }
    if (done.test(out)) return { out, asked };
    await new Promise((res) => setTimeout(res, 25));
  }
}

// ───────────────────────────── T1 ─────────────────────────────

test('r5 T1 e2e: `/tools untrust` of a launch --trust-tools tool holds through a /spec flow: in the phase turn and after Stop', { timeout: 120_000 }, async () => {
  const r = liveRepl(trustScript, { sessionOptions: { trustTools: ['shell'] } });
  try {
    await r.waitFor(/> $/);
    const control = await turn(r, 'run it (trusted at launch)', /TOOL-SAID [\s\S]*? END[\s\S]*> $/);
    assert.equal(control.asked, 0, `precondition: --trust-tools shell trusts it\n${control.out}`);
    await r.send('/tools untrust shell', /> $/);
    const before = await turn(r, 'run it (before)', /TOOL-SAID [\s\S]*? END[\s\S]*> $/);
    assert.equal(before.asked, 1, `precondition: untrusted shell asks\n${before.out}`);
    const flow = await turn(r, FLOW, CHECKPOINT);
    assert.equal(flow.asked, 1, `the phase turn's shell call ran without asking (launch --trust-tools again):\n${flow.out}`);
    await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
    const after = await turn(r, 'run it (after)', /TOOL-SAID [\s\S]*? END[\s\S]*> $/);
    assert.equal(after.asked, 1, `the untrusted shell tool runs without asking after the /spec flow:\n${after.out}`);
    assert.doesNotMatch(after.out, /Using tool: shell \(trusted\)/);
  } finally {
    await r.close();
  }
});

test("r5 T1 e2e: `/tools untrust` of an agent's allowedTools tool holds through a /spec flow", { timeout: 120_000 }, async () => {
  const r = liveRepl(trustScript, {
    sessionOptions: { agentName: 'dev' },
    before: (t: TempEnv) => {
      fs.mkdirSync(path.join(t.wsDir, '.kiro', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(t.wsDir, '.kiro', 'agents', 'dev.json'), JSON.stringify({ name: 'dev', description: 'dev agent', tools: ['*'], allowedTools: ['shell'] }));
    },
  });
  try {
    await r.waitFor(/> $/);
    const control = await turn(r, 'run it (agent-allowed)', /TOOL-SAID [\s\S]*? END[\s\S]*> $/);
    assert.match(control.out, /Using tool: shell \(trusted\)/, `precondition: the agent allows shell\n${control.out}`);
    await r.send('/tools untrust shell', /> $/);
    const flow = await turn(r, FLOW, CHECKPOINT);
    assert.equal(flow.asked, 1, `the phase turn ran the revoked agent tool without asking:\n${flow.out}`);
    await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
    const after = await turn(r, 'run it (after)', /TOOL-SAID [\s\S]*? END[\s\S]*> $/);
    assert.equal(after.asked, 1, `the revoked agent tool runs without asking after the /spec flow:\n${after.out}`);
  } finally {
    await r.close();
  }
});

test('r5 T1 e2e: a `t` answered in a phase turn (the chat\'s session then) reaches the continuation', { timeout: 120_000 }, async () => {
  const r = liveRepl(trustScript);
  try {
    await r.waitFor(/> $/);
    const flow = await turn(r, FLOW, CHECKPOINT, 't');
    assert.equal(flow.asked, 1, flow.out);
    await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
    const after = await turn(r, 'run it (after)', /TOOL-SAID [\s\S]*? END[\s\S]*> $/);
    assert.equal(after.asked, 0, `the trust given with \`t\` during the flow was dropped by the hand-over:\n${after.out}`);
    assert.match(after.out, /Using tool: shell \(trusted\)/);
  } finally {
    await r.close();
  }
});

// ───────────────────────────── T2 ─────────────────────────────

test('r5 T2 e2e: in a plan-mode chat (--trust-all-tools) a phase turn may write its document but its Bash is denied; the checkpoint is in plan mode (Shift+Tab leaves it)', { timeout: 120_000 }, async () => {
  const r = liveRepl(
    (t: TempEnv) => ({
      turns: [
        {
          repeat: true,
          match: 'Phase: REQUIREMENTS',
          steps: [
            { tool: { name: 'Write', input: { file_path: path.join(t.wsDir, '.kiro', 'specs', 'first-spec', 'requirements.md'), content: '# Requirements\n' } } },
            { text: 'WRITE-SAID {{lastToolResult}} END' },
            { tool: { name: 'Bash', input: { command: 'touch made-in-plan-mode.txt', description: 'Create a file' } } },
            { text: 'BASH-SAID {{lastToolResult}} END' },
          ],
        },
        { repeat: true, steps: [{ text: 'OK' }] },
      ],
    }),
    // a terminal: the checkpoint question is read with the chat's prompt (`[plan] !> `)
    { tty: true, sessionOptions: { trustAllTools: true } },
  );
  try {
    await r.waitFor(/!> $/);
    await r.send('/plan', /Entered plan mode[\s\S]*\[plan\] !> $/);
    const flow = await r.send(FLOW, CHECKPOINT);
    const wrote = /WRITE-SAID ([\s\S]*?) END/.exec(flow)?.[1] ?? '';
    const bash = /BASH-SAID ([\s\S]*?) END/.exec(flow)?.[1] ?? '';
    assert.doesNotMatch(wrote, /Plan mode is read-only|denied|only .* may be written/i, `the phase could not write its document in plan mode:\n${flow}`);
    assert.match(wrote.replace(/\s+/g, ''), /^Filecreatedsuccessfullyat:.*requirements\.md$/, `the phase's document write was not allowed:\n${flow}`);
    assert.match(bash, /Plan mode is read-only/, `a phase turn's Bash ran in a plan-mode chat:\n${flow}`);
    // the turn told the model the phase document may still be written
    const phaseLine = r.userLines().find((l) => l.includes('Phase: REQUIREMENTS'))!;
    assert.match(phaseLine, /<kiro-plan-mode>[\s\S]*<kiro-spec-plan-mode>/);
    // the phase session the chat is in shows the chat's true plan mode: Shift+Tab at the checkpoint
    // LEAVES plan mode (the prompt is redrawn as `!> `), a second press enters it again
    let mark = r.o().length;
    r.raw(SHIFT_TAB);
    const left = await r.waitFor(/!> $/, 10_000, mark);
    assert.equal(lastPrompt(left), '!> ', `Shift+Tab at the checkpoint of a plan-mode chat did not leave plan mode:\n${left}`);
    mark = r.o().length;
    r.raw(SHIFT_TAB);
    assert.equal(lastPrompt(await r.waitFor(/\[plan\] !> $/, 10_000, mark)), '[plan] !> ');
    const stopped = await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
    assert.equal(promptOf(stopped), '[plan] !> ');
  } finally {
    await r.close();
  }
});

// ───────────────────────────── T3 ─────────────────────────────

test('r5 T3 e2e: /spec run in plan mode is refused: no task session starts, tasks.md unchanged', { timeout: 90_000 }, async () => {
  const r = liveRepl({ turns: [{ repeat: true, steps: [{ text: 'Implemented.\nTASK_RESULT: completed' }] }] }, { before: (t) => void seedTodoExport(t.wsDir) });
  try {
    await r.waitFor(/> $/);
    await r.send('/plan', /Entered plan mode[\s\S]*\[plan\] > $/);
    const tasks = path.join(r.t.wsDir, '.kiro', 'specs', 'todo-export', 'tasks.md');
    const before = fs.readFileSync(tasks, 'utf8');
    const starts = r.starts();
    const out = await r.send('/spec run todo-export --all', /> $/);
    assert.match(out, /Plan mode is read-only: running spec tasks implements code[\s\S]*Exit plan mode \(\/plan or Shift\+Tab\), then run \/spec run todo-export again\./, out);
    assert.equal(r.starts(), starts, 'a task session was started in plan mode');
    assert.equal(fs.readFileSync(tasks, 'utf8'), before);
    assert.equal(promptOf(out), '[plan] > ');
  } finally {
    await r.close();
  }
});

// ───────────────────────────── T4 ─────────────────────────────

test('r5 T4 e2e: /spec new inside a tangent is refused; /tangent then returns to the main conversation', { timeout: 120_000 }, async () => {
  const r = liveRepl({
    turns: [
      { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTED' }] },
      { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
    ],
  });
  try {
    await r.waitFor(/> $/);
    await r.send('main MAINLINE', /ANSWER history=\[main MAINLINE\] END[\s\S]*> $/);
    await r.send('/tangent side', /Created a conversation checkpoint[\s\S]*> $/);
    await r.send('side SIDELINE', /ANSWER history=\[main MAINLINE \| side SIDELINE\] END[\s\S]*> $/);
    const out = await r.send(FLOW, /> $/);
    assert.match(out, /Spec drafting is disabled while in tangent mode/, out);
    assert.equal(fs.existsSync(path.join(r.t.wsDir, '.kiro', 'specs', 'first-spec')), false, 'the refused flow created its spec folder');
    assert.ok(!r.userLines().some((l) => l.includes('Phase: REQUIREMENTS')), 'a phase turn was sent');
    await r.send('/tangent', /> $/);
    const h = await r.send('where am I?', /ANSWER history=\[[\s\S]*?\] END[\s\S]*> $/);
    assert.equal(/ANSWER history=\[([\s\S]*?)\] END/.exec(h)![1], 'main MAINLINE | where am I?', 'after /tangent the chat is not back in main');
  } finally {
    await r.close();
  }
});

test('r5 T4 e2e: /spec new in a tangent with no message of its own leaves it first; the spec continues main, and the prompt says so', { timeout: 120_000 }, async () => {
  const r = liveRepl({
    turns: [
      { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTED' }] },
      { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
    ],
  });
  try {
    await r.waitFor(/> $/);
    await r.send('main MAINLINE', /ANSWER history=\[main MAINLINE\] END[\s\S]*> $/);
    const entered = await r.send('/tangent side', /Created a conversation checkpoint[\s\S]*> $/);
    assert.match(promptOf(entered)!, /↯/);
    const flow = await r.send(FLOW, CHECKPOINT);
    assert.match(flow, /Left the tangent \(↯\): it had no messages of its own, so the spec continues the main conversation\./, flow);
    const stopped = await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
    assert.doesNotMatch(promptOf(stopped)!, /↯/, 'the prompt still shows a tangent');
    const h = await r.send('which?', /ANSWER history=\[[\s\S]*?\] END[\s\S]*> $/);
    const hist = /ANSWER history=\[([\s\S]*?)\] END/.exec(h)![1]!;
    assert.ok(hist.startsWith('main MAINLINE | '), hist.slice(0, 200));
    assert.equal(hist.match(/Phase: REQUIREMENTS\./g)?.length, 1, hist.slice(0, 400));
    assert.ok(hist.endsWith(' | which?'));
  } finally {
    await r.close();
  }
});

// ───────────────────────────── T5 ─────────────────────────────

test('r5 T5 e2e: after two /spec flows and a quit the index holds main and the two continuations only; each still resumes with its spec turns', { timeout: 180_000 }, async () => {
  const script = {
    turns: [
      { repeat: true, match: 'kiro-spec-mode', steps: [{ text: 'PHASE DONE' }] },
      { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
    ],
  };
  const r = liveRepl(script);
  const sessionsDir = path.join(r.t.home, '.kiro', 'sessions', 'cli');
  const records = (): SessionRecord[] =>
    fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')) as SessionRecord);
  try {
    await r.waitFor(/> $/);
    await r.send('remember PELICAN', /ANSWER [\s\S]*> $/);
    await r.send('/spec new spec-one --type feature --workflow requirements-first a csv export', /Stop here \(resume later with \/spec spec-one\)[\s\S]*> $/);
    await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
    await r.send('/spec new spec-two --type feature --workflow requirements-first a tsv export', /Stop here \(resume later with \/spec spec-two\)[\s\S]*> $/);
    await r.send('Stop', /Stopped at the requirements\.md checkpoint[\s\S]*> $/);
    const quit = await r.send('/quit', /--resume-id [0-9a-f-]{36}/);
    assert.equal(await r.exit, 0);
    const hinted = /--resume-id ([0-9a-f-]{36})/.exec(quit)![1]!;
    const recs = records();
    const summary = recs.map((x) => `${x.sessionId.slice(0, 8)}:${x.origin}:${x.turns.length}`).join(', ');
    assert.deepEqual(recs.filter((x) => x.origin === 'spec'), [], `phase records the continuations hold are still listed: ${summary}`);
    assert.equal(recs.length, 3, `expected main + two continuations: ${summary}`);
    for (const x of recs) assert.ok(fs.existsSync(path.join(sessionsDir, `${x.sessionId}.jsonl`)), `journal of ${x.sessionId} missing`);
    const byTurns = [...recs].sort((a, b) => a.turns.length - b.turns.length);
    const [main, c1, c2] = byTurns as [SessionRecord, SessionRecord, SessionRecord];
    assert.equal(hinted, c2.sessionId, 'the exit hint does not name the last continuation');
    assert.deepEqual([main.turns.length, c1.turns.length, c2.turns.length], [1, 2, 3], summary);
    // resume each continuation (same env as the REPL's): its conversation includes its spec turns
    const env = fakeEnv({
      ...r.t.env,
      KIRO_HOME: r.kiroHome,
      XDG_RUNTIME_DIR: path.join(r.t.root, 'run'),
      XDG_CACHE_HOME: path.join(r.t.root, 'cache'),
      FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script),
      FAKE_CLAUDE_LOG: path.join(r.t.root, 'fake.log'),
      FAKE_CLAUDE_PERSIST: '1',
      KIRO_CLAUDE_BIN: fakeClaudePath(),
    });
    const ws = createWorkspaceContext(r.t.wsDir, env);
    const ui: SessionUI = { requestApproval: async () => ({ kind: 'deny' }), notice: () => undefined };
    for (const [rec, specs] of [
      [c1, ['spec-one']],
      [c2, ['spec-one', 'spec-two']],
    ] as const) {
      const s = await createSession({ ws, origin: 'repl', interactive: false, ui, env, resume: { sessionId: rec.sessionId } });
      try {
        let text = '';
        const g = s.prompt({ text: 'what do you know?' });
        for (;;) {
          const n = await g.next();
          if (n.done) {
            text = n.value.text;
            break;
          }
        }
        const hist = /ANSWER history=\[([\s\S]*?)\] END/.exec(text)?.[1] ?? text;
        assert.match(hist, /^remember PELICAN \| /, hist.slice(0, 200));
        for (const name of specs) assert.ok(hist.includes(`on the spec "${name}"`), `resumed ${rec.sessionId} lost the ${name} spec turn: ${hist.slice(0, 400)}`);
        assert.match(hist, /\| what do you know\?$/);
      } finally {
        await s.close();
      }
    }
  } finally {
    await r.close();
  }
});
