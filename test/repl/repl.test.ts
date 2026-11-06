import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApprovalResponse, SlashCommand, ReplHost, SessionEvent } from '../../src/types.js';
import { APPROVAL_QUESTION } from '../../src/repl/prompt.js';
import { exitStatusText } from '../../src/repl/core.js';
import { runToEnd, startRepl } from './harness.js';
import { MockSession, agentOf, call } from './mockSession.js';

const text = (t: string): SessionEvent => ({ type: 'text_delta', text: t });

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

test('repl: greeting, prompt, exit hint, session lifecycle', async () => {
  const { code, out, run } = await runToEnd({ input: [] });
  assert.equal(code, 0);
  assert.ok(out.startsWith('Welcome to Kiro (Claude Code backend)!\n'), out);
  assert.ok(out.includes('Did you know?'));
  assert.ok(out.includes('🤖 You are chatting with auto\n'));
  assert.ok(out.includes('Model calls run on your installed Claude Code and its subscription.'));
  assert.ok(out.endsWith(`> \nTo resume this session: kiro-claude chat --resume-id ${run.session.id}\n`), out);
  const o = run.created[0]!;
  assert.equal(o.origin, 'repl');
  assert.equal(o.interactive, true);
  assert.equal(o.ws, run.ws);
  assert.ok(o.ui && typeof o.ui.requestApproval === 'function' && typeof o.ui.notice === 'function');
  assert.equal(run.session.started, true);
  assert.equal(run.session.closed, true);
  run.t.cleanup();
});

test('repl: session options are passed through; resumed greeting; welcome message; model name', async () => {
  const s = new MockSession({ agent: agentOf('dev', { welcomeMessage: 'Hello from dev' }), model: 'claude-opus-5.5' });
  s.record.messageCount = 4;
  const { out, run } = await runToEnd({ session: s, input: [], sessionOptions: { agentName: 'dev', model: 'claude-opus-5.5', resume: { latest: true } } });
  assert.equal(run.created[0]!.agentName, 'dev');
  assert.deepEqual(run.created[0]!.resume, { latest: true });
  assert.ok(out.startsWith('Picking up where we left off...'));
  assert.ok(out.includes('You are chatting with Opus 5.5 (claude-opus-5.5)'));
  assert.ok(out.includes('Hello from dev\n'));
  assert.ok(out.includes('[dev] > '));
  run.t.cleanup();
});

test('repl: --resume without history greets as a new session', async () => {
  const { out, run } = await runToEnd({ input: [], sessionOptions: { resume: { latest: true } } });
  assert.ok(out.startsWith('Welcome to Kiro'));
  run.t.cleanup();
});

test('repl: Tab completes slash commands, prompts and @paths in terminal mode', async () => {
  const s = new MockSession().script({}, {});
  const run = startRepl({ session: s, tty: true, keepOpen: true });
  run.t.write('proj/.kiro/prompts/zebra-prompt.md', 'Zebra body');
  run.t.write('proj/somefile-unique.txt', 'x');
  await run.waitFor('> ');
  run.stdin.write('/session-i\t');
  await new Promise((r) => setTimeout(r, 20));
  run.stdin.write('\r');
  await run.waitFor(s.id);
  run.stdin.write('/zebra-p\t');
  await new Promise((r) => setTimeout(r, 20));
  run.stdin.write('\r');
  await run.waitFor('Zebra body');
  run.stdin.write('see @somefile-u\t');
  await new Promise((r) => setTimeout(r, 20));
  run.stdin.write('\r');
  await new Promise((r) => setTimeout(r, 50));
  run.stdin.write('\u0004');
  await new Promise((r) => setTimeout(r, 20));
  run.stdin.write('\u0004');
  await run.exit;
  assert.deepEqual(s.prompts.map((p) => p.text), ['Zebra body', 'see @somefile-unique.txt']);
  run.t.cleanup();
});

test('repl: greeting settings off', async () => {
  const { out, run } = await runToEnd({ input: [], settings: { 'chat.greeting.enabled': false } });
  assert.ok(!out.includes('Welcome'));
  assert.ok(out.startsWith('🤖 You are chatting with auto'));
  run.t.cleanup();
  const r2 = await runToEnd({ input: [], settings: { 'chat.enablePromptHints': false } });
  assert.ok(r2.out.includes('Welcome'));
  assert.ok(!r2.out.includes('Did you know?'));
  r2.run.t.cleanup();
});

test('repl: session start failure exits 1 with the error', async () => {
  const { code, out, run } = await runToEnd({ input: ['hello'], createFails: new Error('Failed to start session: Session is active in another process (PID 42)') });
  assert.equal(code, 1);
  assert.equal(out, 'Failed to start session: Session is active in another process (PID 42)\n');
  run.t.cleanup();
});

test('repl: a user turn is sent and rendered', async () => {
  const s = new MockSession().script({ steps: [text('Hello '), text('**there**')], result: { text: 'Hello there' } });
  const { out, run } = await runToEnd({ session: s, input: ['  hello world  '] });
  assert.deepEqual(s.prompts, [{ text: 'hello world' }]);
  assert.ok(out.includes('>   hello world  \n\n> Hello there\n\n> \n'), out);
  run.t.cleanup();
});

test('repl: initial input is processed first', async () => {
  const s = new MockSession().script({ result: { text: 'first answer' } }, { result: { text: 'second' } });
  const { out, run } = await runToEnd({ session: s, input: ['next'], initialInput: 'from argv' });
  assert.deepEqual(s.prompts.map((p) => p.text), ['from argv', 'next']);
  assert.ok(out.indexOf('first answer') < out.indexOf('> next'));
  run.t.cleanup();
});

test('repl: empty lines re-prompt; unknown command never reaches the model', async () => {
  const s = new MockSession();
  const { out, run } = await runToEnd({ session: s, input: ['', '   ', '/nope arg', '/'] });
  assert.equal(s.prompts.length, 0);
  assert.ok(out.includes('Unknown command: /nope\n'));
  assert.ok(out.includes('Unknown command: /\n'));
  run.t.cleanup();
});

test('repl: /quit, /exit, /q stop the loop', async () => {
  for (const q of ['/quit', '/exit', '/q', '/QUIT']) {
    const s = new MockSession();
    const { code, run } = await runToEnd({ session: s, input: [q, 'never sent'] });
    assert.equal(code, 0);
    assert.equal(s.prompts.length, 0, q);
    assert.equal(s.closed, true);
    run.t.cleanup();
  }
});

test('repl: Ctrl+C / Ctrl+D at the idle prompt (hint, then exit)', async () => {
  for (const key of ['\u0003', '\u0004']) {
    const s = new MockSession();
    const { out, run } = await runToEnd({ session: s, input: [key, key, 'not reached'] });
    assert.equal(count(out, '(To exit the CLI, press Ctrl+C or Ctrl+D again or type /quit)'), 1);
    assert.equal(s.prompts.length, 0);
    run.t.cleanup();
  }
  // a successful line resets the count
  const s = new MockSession().script({ result: { text: 'ok' } });
  const { out, run } = await runToEnd({ session: s, input: ['\u0003', 'hello', '\u0003'] });
  assert.equal(count(out, '(To exit the CLI'), 2);
  assert.equal(s.prompts.length, 1);
  run.t.cleanup();
});

test('repl: Ctrl+C during a turn interrupts the session', async () => {
  let run!: ReturnType<typeof startRepl>;
  const s = new MockSession().script({
    steps: [text('working...'), { run: () => run.send('\u0003') }, { waitInterrupt: true }],
    result: { stopReason: 'cancelled' },
  });
  run = startRepl({ session: s, input: ['long task'], keepOpen: true });
  await run.waitFor('working...');
  await new Promise((r) => setTimeout(r, 20));
  run.end();
  assert.equal(await run.exit, 0);
  assert.equal(s.interrupted, 1);
  run.t.cleanup();
});

test('repl: multi-line input (trailing backslash, code fences)', async () => {
  const s = new MockSession().script({}, {});
  const { run } = await runToEnd({ session: s, input: ['line one\\', 'line two', '```', 'code here', '```'] });
  assert.deepEqual(s.prompts.map((p) => p.text), ['line one\nline two', '```\ncode here\n```']);
  run.t.cleanup();
});

test('repl: approvals y / t / n / free text / Ctrl+C', async () => {
  const cases: [string, ApprovalResponse][] = [
    ['y', { kind: 'allow-once' }],
    ['t', { kind: 'allow-always' }],
    ['n', { kind: 'deny' }],
    ['\u0003', { kind: 'cancelled' }],
  ];
  for (const [answer, want] of cases) {
    const s = new MockSession().script({ steps: [{ approval: call('Bash', { command: 'touch x' }) }] });
    const { out, run } = await runToEnd({ session: s, input: ['make a file', answer] });
    assert.deepEqual(s.approvals, [want], JSON.stringify(answer));
    assert.ok(out.includes(`🛠️  Using tool: shell\n ⋮ \n ● I will run the following shell command: touch x\n\n${APPROVAL_QUESTION}\n\n> `), out);
    run.t.cleanup();
  }
});

test('repl: free-text answer is sent as the next turn unless the session already did', async () => {
  // session does NOT send it ⇒ the REPL sends it
  const s1 = new MockSession().script({ steps: [{ approval: call('Bash', { command: 'rm -rf build' }) }], result: { stopReason: 'cancelled' } }, { result: { text: 'ok, using git clean' } });
  const r1 = await runToEnd({ session: s1, input: ['clean up', 'use git clean instead'] });
  assert.deepEqual(s1.approvals, [{ kind: 'redirect', text: 'use git clean instead' }]);
  assert.deepEqual(s1.prompts.map((p) => p.text), ['clean up', 'use git clean instead']);
  r1.run.t.cleanup();
  // session sent it inside the same prompt() (its record shows it) ⇒ no duplicate
  const s2 = new MockSession();
  s2.script({
    noRecord: true,
    steps: [
      { approval: call('Bash', { command: 'rm -rf build' }) },
      {
        run: ({ session }) => {
          session.record.turns.push({ userUuid: 'u1', preview: 'clean up', at: '' }, { userUuid: 'u2', preview: 'use git clean instead', at: '' });
        },
      },
    ],
  });
  const r2 = await runToEnd({ session: s2, input: ['clean up', 'use git clean instead'] });
  assert.deepEqual(s2.prompts.map((p) => p.text), ['clean up']);
  r2.run.t.cleanup();
});

test('repl: approval prompt re-asks after empty lines, runs slash commands and !cmd, header shown once', async () => {
  const c1 = call('Bash', { command: 'ls' }, 'tu1');
  const s = new MockSession().script({ steps: [{ type: 'tool_start', toolUseId: 'tu1', call: c1, trusted: false }, { approval: c1 }] });
  const { out, run } = await runToEnd({ session: s, input: ['go', '', '/tools trust-all', '!echo from-shell', 'y'] });
  assert.deepEqual(s.approvals, [{ kind: 'allow-once' }]);
  assert.equal(count(out, '🛠️  Using tool: shell'), 1);
  assert.equal(count(out, APPROVAL_QUESTION), 3);
  assert.deepEqual(s.called('setTrustAll'), [[true]]);
  assert.ok(out.includes('from-shell'));
  assert.ok(out.includes('!> y'), 'prompt shows ! after trust-all');
  run.t.cleanup();
});

test('repl: /quit at the approval prompt cancels and exits', async () => {
  const s = new MockSession().script({ steps: [{ approval: call('Bash', { command: 'ls' }) }] });
  const { run } = await runToEnd({ session: s, input: ['go', '/quit', 'never'] });
  assert.deepEqual(s.approvals, [{ kind: 'cancelled' }]);
  assert.equal(s.prompts.length, 1);
  run.t.cleanup();
});

test('repl: concurrent approval requests are serialized', async () => {
  const s = new MockSession();
  const answers: ApprovalResponse[] = [];
  s.script({
    steps: [
      {
        run: async ({ session, signal }) => {
          const a = session.ui!.requestApproval({ call: call('Bash', { command: 'one' }, 'a'), requestId: 'r1', reasons: [], agentName: 'kiro_default' }, signal);
          const b = session.ui!.requestApproval({ call: call('Bash', { command: 'two' }, 'b'), requestId: 'r2', reasons: [], agentName: 'kiro_default' }, signal);
          answers.push(...(await Promise.all([a, b])));
        },
      },
    ],
  });
  const { out, run } = await runToEnd({ session: s, input: ['go', 'y', 'n'] });
  assert.deepEqual(answers, [{ kind: 'allow-once' }, { kind: 'deny' }]);
  assert.ok(out.indexOf('command: one') < out.indexOf('> y') && out.indexOf('> y') < out.indexOf('command: two'), out);
  run.t.cleanup();
});

test('repl: a withdrawn approval (abort) resolves cancelled', async () => {
  const s = new MockSession();
  let got: ApprovalResponse | undefined;
  s.script({
    steps: [
      {
        run: async ({ session }) => {
          const ac = new AbortController();
          const p = session.ui!.requestApproval({ call: call('Bash', { command: 'x' }, 'z'), requestId: 'r', reasons: [], agentName: 'kiro_default' }, ac.signal);
          setTimeout(() => ac.abort(), 10);
          got = await p;
        },
      },
    ],
  });
  const { run } = await runToEnd({ session: s, input: [], keepOpen: false, initialInput: 'go' });
  assert.deepEqual(got, { kind: 'cancelled' });
  run.t.cleanup();
});

test('repl: @prompt at the approval prompt rejects and sends the prompt', async () => {
  const s = new MockSession().script({ steps: [{ approval: call('Bash', { command: 'ls' }) }] }, {});
  const run0 = startRepl({ session: s, input: ['go', '@fix now'] });
  run0.t.write('proj/.kiro/prompts/fix.md', 'Please fix ${1}');
  await run0.exit;
  assert.deepEqual(s.approvals, [{ kind: 'redirect', text: 'Please fix now' }]);
  assert.deepEqual(s.prompts.map((p) => p.text), ['go', 'Please fix now']);
  run0.t.cleanup();
});

test('repl: !cmd runs in the shell and is not sent to the model', async () => {
  const s = new MockSession();
  const { out, run } = await runToEnd({ session: s, input: ['!echo hi-there', '!exit 3', '!kill -9 $$'] });
  assert.equal(s.prompts.length, 0);
  assert.ok(out.includes('hi-there\n'));
  assert.ok(out.includes('Self exited with status: exit status: 3\n'), out);
  assert.ok(out.includes('Self exited with status: signal: 9 (SIGKILL)\n'), out);
  assert.equal(exitStatusText(1, null), 'exit status: 1');
  run.t.cleanup();
});

test('repl: @prompt and /prompt expansion (prompts first), @file passthrough', async () => {
  const s = new MockSession().script({}, {}, {}, {});
  const run = startRepl({ session: s, input: ['@greet Bob', '/greet "Ann Lee" x', '@GREET', '@src/a.ts explain'] });
  run.t.write('proj/.kiro/prompts/greet.md', 'Say hello to ${1}.');
  await run.exit;
  assert.deepEqual(s.prompts.map((p) => p.text), ['Say hello to Bob.', 'Say hello to Ann Lee.', 'Say hello to .', '@src/a.ts explain']);
  assert.ok(run.out().includes('Say hello to Bob.'), 'prompt content shown');
  run.t.cleanup();
});

test('repl: /<skill> args and /<steering> are sent; built-ins win over prompts', async () => {
  const s = new MockSession().script({}, {}, {});
  const run = startRepl({ session: s, input: ['/deploy prod', '/style tidy this', '/help'] });
  run.t.write('proj/.kiro/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Deploy things\n---\nDeploy the app.');
  run.t.write('proj/.kiro/steering/style.md', '---\ninclusion: manual\n---\nUse tabs.');
  run.t.write('proj/.kiro/prompts/help.md', 'should not run');
  await run.exit;
  assert.deepEqual(s.prompts, [
    { text: 'Deploy the app.\n\nARGUMENTS: prod' },
    // never raw `/style`: Claude would treat leading-slash text as its own command
    { text: '#steering:style tidy this', steeringRefs: ['style'] },
  ]);
  assert.ok(run.out().includes('Commands:'));
  run.t.cleanup();
});

test('repl: plan mode toggle, [plan] prompt, Execute this plan? y', async () => {
  const plan = '**Implementation Plan - Cache**\n**Problem Statement:** slow\n**Task Breakdown:**\nTask 1: add cache';
  const s = new MockSession().script({ steps: [text(plan)], result: { text: plan } }, { result: { text: 'implemented' } });
  const { out, run } = await runToEnd({ session: s, input: ['/plan', 'design a cache', 'y'] });
  assert.ok(out.includes('Entered plan mode.'));
  assert.ok(out.includes('[plan] > design a cache'));
  assert.ok(out.includes('Execute this plan? [y/n]'));
  assert.deepEqual(s.prompts.map((p) => p.text), ['design a cache', 'Implement the plan above.']);
  assert.equal(s.planMode, false);
  run.t.cleanup();
});

test('repl: plan declined stays in plan mode; non-plan answers do not ask; /plan <prompt>', async () => {
  const plan = '**Implementation Plan - X**\nTask 1: a\nTask 2: b';
  const s = new MockSession().script({ result: { text: plan } }, { result: { text: 'just a question answer' } });
  const { out, run } = await runToEnd({ session: s, input: ['/plan do x', 'n', 'what about y?', '/plan'] });
  assert.deepEqual(s.prompts.map((p) => p.text), ['do x', 'what about y?']);
  assert.equal(count(out, 'Execute this plan?'), 1);
  assert.ok(out.includes('Exited plan mode.'));
  assert.equal(s.planMode, false);
  run.t.cleanup();
});

test('repl: Shift+Tab toggles plan mode in terminal mode', async () => {
  const s = new MockSession();
  const run = startRepl({ session: s, tty: true, keepOpen: true });
  await run.waitFor('> ');
  run.stdin.write('\u001b[Z');
  await run.waitFor('[plan] > ');
  assert.equal(s.planMode, true);
  run.stdin.write('\u0004');
  run.stdin.write('\u0004');
  assert.equal(await run.exit, 0);
  run.t.cleanup();
});

test('repl: terminal mode reads typed lines and records history', async () => {
  const s = new MockSession().script({ result: { text: 'answer' } });
  const run = startRepl({ session: s, tty: true, keepOpen: true });
  await run.waitFor('> ');
  run.stdin.write('hello tty\r');
  await run.waitFor('answer');
  run.stdin.write('\u0003');
  run.stdin.write('\u0003');
  assert.equal(await run.exit, 0);
  assert.deepEqual(s.prompts.map((p) => p.text), ['hello tty']);
  const hist = path.join(run.t.kiroHome, 'kiro-claude', 'history', `${s.id}.jsonl`);
  assert.equal(fs.readFileSync(hist, 'utf8'), '"hello tty"\n');
  run.t.cleanup();
});

test('repl: global history mode', async () => {
  const s = new MockSession().script({});
  const run = startRepl({ session: s, tty: true, keepOpen: true, settings: { 'chat.historyMode': 'global' } });
  await run.waitFor('> ');
  run.stdin.write('/session-id\r');
  await run.waitFor(s.id);
  run.stdin.write('\u0004\u0004');
  await run.exit;
  assert.equal(fs.readFileSync(path.join(run.t.kiroHome, 'kiro-claude', 'history', 'global.jsonl'), 'utf8'), '"/session-id"\n');
  run.t.cleanup();
});

test('repl: context usage indicator in the prompt and lengthy warning', async () => {
  const s = new MockSession().script({
    steps: [
      {
        run: ({ session }) => {
          session.usageReport = { model: 'auto', contextPercent: 93 };
        },
      },
    ],
    result: { text: 'x' },
  });
  s.usageReport = { model: 'auto', contextPercent: 6.4 };
  const run = startRepl({ session: s, input: ['hi'], settings: { 'chat.enableContextUsageIndicator': true } });
  await run.exit;
  assert.ok(run.out().includes('6% > hi'));
  assert.ok(run.out().includes('⚠️ This conversation is getting lengthy.'));
  assert.ok(run.out().includes('93% > '));
  run.t.cleanup();
  // off by default: usage() is never called
  const s2 = new MockSession();
  const r2 = await runToEnd({ session: s2, input: [] });
  assert.equal(s2.called('usage').length, 0);
  r2.run.t.cleanup();
});

test('repl: trust-all session shows the warning and the ! prompt', async () => {
  const s = new MockSession();
  s.trust.trustAll = true;
  const { out, run } = await runToEnd({ session: s, input: [] });
  assert.ok(out.includes('All tools are now trusted (!). Kiro will execute tools without asking for confirmation.'));
  assert.ok(out.includes('!> '));
  run.t.cleanup();
});

test('repl: tangent prompt marker', async () => {
  const s = new MockSession();
  s.tangent = { name: null, parentId: 'p' };
  const { out, run } = await runToEnd({ session: s, input: [] });
  assert.ok(out.includes('↯ > '));
  run.t.cleanup();
});

test('repl: auth error ends the REPL with exit code 1', async () => {
  const s = new MockSession().script({ result: { isError: true, stopReason: 'error', authError: true, error: 'Not logged in' } });
  const { code, out, run } = await runToEnd({ session: s, input: ['hi', 'never'] });
  assert.equal(code, 1);
  assert.ok(out.includes('You are not logged in, please log in with kiro-claude login'));
  assert.equal(s.prompts.length, 1);
  assert.ok(out.includes('To resume this session'));
  run.t.cleanup();
});

test('repl: generator errors become an error line, the REPL continues', async () => {
  const s = new MockSession().script({ steps: [{ run: () => { throw new Error('child crashed'); } }] }, { result: { text: 'fine' } });
  const { code, out, run } = await runToEnd({ session: s, input: ['a', 'b'] });
  assert.equal(code, 0);
  assert.ok(out.includes('Kiro is having trouble responding right now: child crashed'));
  assert.ok(out.includes('fine'));
  run.t.cleanup();
});

test('repl: every SessionEvent kind renders through the REPL', async () => {
  const c1 = call('Bash', { command: 'npm test' }, 'x1');
  const s = new MockSession().script({
    steps: [
      { type: 'thinking_delta', text: 'hmm' },
      text('Running tests.'),
      { type: 'tool_start', toolUseId: 'x1', call: c1, trusted: true },
      { type: 'tool_end', toolUseId: 'x1', call: c1, isError: false, output: '3 passing', durationMs: 2500 },
      { type: 'tool_denied', toolUseId: 'x2', call: call('Write', { file_path: '/etc/x', content: '' }, 'x2'), reason: 'Kiro does not allow this operation' },
      { type: 'todo_update', todos: [{ id: '1', subject: 'write tests', status: 'completed' }] },
      { type: 'compaction', state: 'finished' },
      { type: 'notice', level: 'error', message: 'boom notice' },
      { type: 'subagent', state: 'started', agentType: 'helper' },
      { type: 'rate_limit', status: 'rejected' },
      { type: 'session_id', claudeSessionId: 'new' },
      { type: 'raw', frame: { type: 'x' } },
      { type: 'text', text: 'All done.' },
    ],
  });
  const { out, run } = await runToEnd({ session: s, input: ['test it'] });
  for (const want of ['hmm', '> Running tests.', 'Using tool: shell (trusted)', '3 passing', 'Completed in 2.500s', 'Using tool: write', 'Kiro does not allow this operation', 'TODO:', '[x] write tests', 'compacted successfully', 'boom notice', 'Subagent helper started', 'You have reached your Claude usage limit.', '> All done.']) {
    assert.ok(out.includes(want), `${want} missing in:\n${out}`);
  }
  run.t.cleanup();
});

test('repl: ui.notice while idle and from session start', async () => {
  const s = new MockSession();
  const orig = s.start.bind(s);
  s.start = async () => {
    await orig();
    s.ui!.notice('warn', 'WARNING: Agent conflict for dev. Using workspace version.');
  };
  const run = startRepl({ session: s, keepOpen: true });
  await run.waitFor('> ');
  s.ui!.notice('info', 'background note');
  run.end();
  await run.exit;
  assert.ok(run.out().includes('WARNING: Agent conflict for dev. Using workspace version.\n'));
  assert.ok(run.out().includes('background note\n'));
  run.t.cleanup();
});

test('repl: Stop-hook confirm picker', async () => {
  let chosen: string | undefined;
  const s = new MockSession().script({
    steps: [
      {
        run: async ({ session }) => {
          chosen = await session.ui!.confirmStopHook!({ hook: 'h', question: 'Run the tests?', options: [{ id: 'yes', label: 'Yes', run: true }, { id: 'no', label: 'No', run: false }] });
        },
      },
    ],
  });
  const { out, run } = await runToEnd({ session: s, input: ['go', '2'] });
  assert.equal(chosen, 'no');
  assert.ok(out.includes('Run the tests?\n  1. Yes\n  2. No\n'));
  run.t.cleanup();
});

test('repl: contributed commands get a working ReplHost', async () => {
  const seen: Record<string, unknown> = {};
  const spec: SlashCommand = {
    name: 'spec',
    summary: 'Spec workflow',
    usage: '/spec new <name>',
    async run(args, raw, host: ReplHost) {
      seen.args = args;
      seen.raw = raw;
      seen.ask = await host.ask('Feature name:');
      seen.confirm = await host.confirm('Use it?', true);
      seen.confirmDefault = await host.confirm('Default yes?', true);
      seen.choose = await host.choose('Kind?', ['feature', 'bugfix']);
      seen.chooseBad = await host.choose('Kind?', ['a', 'b']);
      host.print('printed line');
      const r = await host.runTurn({ text: 'spec phase', extraContext: ['ctx'] });
      seen.result = r.text;
      const child = await host.createSession({ specPhase: { name: 'tasks', allowedWritePaths: [] } });
      seen.childOrigin = (child as MockSession).opts?.origin;
      seen.childPhase = (child as MockSession).opts?.specPhase;
      seen.childUi = (child as MockSession).opts?.ui === (host.session as MockSession).ui;
      host.replaceSession(child);
      seen.replaced = host.session === child;
      seen.settings = typeof host.settings.get;
      seen.ws = host.ws.cwd;
    },
  };
  const s = new MockSession().script({ result: { text: 'phase done' } });
  const { out, run } = await runToEnd({ session: s, extraCommands: [spec], input: ['/spec new "my feat"', 'my-feature', 'y', '', '2', '9', '', '/help'] });
  assert.deepEqual(seen.args, ['new', 'my feat']);
  assert.equal(seen.raw, 'new "my feat"');
  assert.equal(seen.ask, 'my-feature');
  assert.equal(seen.confirm, true);
  assert.equal(seen.confirmDefault, true);
  assert.equal(seen.choose, 1);
  assert.equal(seen.chooseBad, undefined);
  assert.equal(seen.result, 'phase done');
  assert.equal(seen.childOrigin, 'repl');
  assert.deepEqual(seen.childPhase, { name: 'tasks', allowedWritePaths: [] });
  assert.equal(seen.childUi, true);
  assert.equal(seen.replaced, true);
  assert.deepEqual(s.prompts, [{ text: 'spec phase', extraContext: ['ctx'] }]);
  assert.ok(out.includes('printed line\n'));
  assert.ok(out.includes("Invalid choice '9'"));
  assert.ok(out.includes('/spec'), 'listed in /help');
  // the replaced session is the one closed at exit
  assert.equal(run.sessions[1]!.closed, true);
  run.t.cleanup();
});

test('repl: a contributed command cannot shadow a built-in; --help prints usage', async () => {
  let ran = false;
  const evil: SlashCommand = { name: 'help', summary: 'x', async run() { ran = true; } };
  const { out, run } = await runToEnd({ extraCommands: [evil], input: ['/help', '/context --help', '/help tools', '/help nope'] });
  assert.equal(ran, false);
  assert.ok(out.includes('Commands:'));
  assert.ok(out.includes('/context — Manage context files'));
  assert.ok(out.includes('/context show [--expand]'));
  assert.ok(out.includes('/tools trust <names…>'));
  assert.ok(out.includes('Unknown command: /nope'));
  run.t.cleanup();
});

test('repl: wrapping (--wrap always) and raw output (chat.disableMarkdownRendering)', async () => {
  const s = new MockSession().script({ steps: [text('aaaa bbbb cccc dddd eeee ffff')] });
  const { out, run } = await runToEnd({ session: s, input: ['x'], wrap: 'always', columns: 16 });
  assert.ok(out.includes('> aaaa bbbb cccc\ndddd eeee ffff\n'), out);
  run.t.cleanup();
  const s2 = new MockSession().script({ steps: [text('**raw**')] });
  const r2 = await runToEnd({ session: s2, input: ['x'], settings: { 'chat.disableMarkdownRendering': true } });
  assert.ok(r2.out.includes('> **raw**\n'));
  r2.run.t.cleanup();
  const s3 = new MockSession().script({ steps: [{ type: 'thinking_delta', text: 'secret thoughts' }, text('visible')] });
  const r3 = await runToEnd({ session: s3, input: ['x'], settings: { 'chat.showThinking': false } });
  assert.ok(!r3.out.includes('secret thoughts'));
  r3.run.t.cleanup();
});
