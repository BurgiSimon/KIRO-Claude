import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_QUESTION,
  approvalQuestion,
  colorPrompt,
  exitHint,
  formatGreeting,
  formatTip,
  generatePrompt,
  notSupported,
  resumeHint,
  trustAllWarning,
} from '../../src/repl/prompt.js';
import { classifyApprovalInput } from '../../src/repl/approval.js';
import { setColorEnabled, stripAnsi } from '../../src/util/ansi.js';

setColorEnabled(false);

test('prompt: Q prompt_parser vectors (06 §5.1) + plan mode', () => {
  const V: [Parameters<typeof generatePrompt>[0], string][] = [
    [{ trustAll: false, tangent: false }, '> '],
    [{ trustAll: true, tangent: false }, '!> '],
    [{ trustAll: false, tangent: true }, '↯ > '],
    [{ trustAll: true, tangent: true }, '↯ !> '],
    [{ agentName: 'test-profile', trustAll: false, tangent: false }, '[test-profile] > '],
    [{ agentName: 'dev', trustAll: true, tangent: false }, '[dev] !> '],
    [{ agentName: 'dev', trustAll: true, tangent: true }, '[dev] ↯ !> '],
    [{ agentName: 'rust-agent', trustAll: false, tangent: false, usagePercent: 6.2 }, '[rust-agent] 6% > '],
    [{ agentName: 'rust-agent', trustAll: true, tangent: false, usagePercent: 15.7 }, '[rust-agent] 16% !> '],
    [{ trustAll: false, tangent: false, usagePercent: 25 }, '25% > '],
    [{ trustAll: false, tangent: true, usagePercent: 8.9 }, '9% ↯ > '],
    [{ agentName: 'kiro_default', trustAll: false, tangent: false }, '> '],
    [{ agentName: 'q_cli_default', trustAll: false, tangent: false }, '> '],
    [{ agentName: 'dev', trustAll: false, tangent: false, planMode: true }, '[plan] > '],
    [{ agentName: 'dev', trustAll: true, tangent: false, planMode: true, usagePercent: 3 }, '[plan] 3% !> '],
  ];
  for (const [s, want] of V) {
    assert.equal(generatePrompt(s), want, JSON.stringify(s));
    assert.equal(stripAnsi(colorPrompt(s)), want);
  }
});

test('prompt: colours by usage thresholds', () => {
  setColorEnabled(true);
  try {
    const pct = (p: number): string => colorPrompt({ trustAll: false, tangent: false, usagePercent: p });
    assert.ok(pct(49.9).startsWith('\u001b[32m'), 'green < 50');
    assert.ok(pct(50).startsWith('\u001b[33m'), 'yellow < 90');
    assert.ok(pct(89.9).startsWith('\u001b[33m'));
    assert.ok(pct(90).startsWith('\u001b[31m'), 'red >= 90');
    const p = colorPrompt({ agentName: 'dev', trustAll: true, tangent: true });
    assert.ok(p.includes('\u001b[36m[dev] '), 'agent cyan');
    assert.ok(p.includes('\u001b[33m↯ '), 'tangent yellow');
    assert.ok(p.includes('\u001b[31m!'), 'warning red');
    assert.ok(p.endsWith('\u001b[35m> \u001b[39m'), 'magenta >');
  } finally {
    setColorEnabled(false);
  }
});

test('prompt: fixed texts', () => {
  assert.equal(stripAnsi(approvalQuestion()), APPROVAL_QUESTION);
  assert.equal(APPROVAL_QUESTION, "Allow this action? Use 't' to trust (always allow) this tool for the session. [y/n/t]:");
  assert.equal(exitHint(), '\n(To exit the CLI, press Ctrl+C or Ctrl+D again or type /quit)\n\n');
  assert.equal(resumeHint('kiro-claude', 'abc'), 'To resume this session: kiro-claude chat --resume-id abc');
  assert.equal(resumeHint('kiro-cli', 'x'), 'To resume this session: kiro-cli chat --resume-id x');
  assert.equal(notSupported('knowledge'), '/knowledge is not supported in kiro-claude (Claude Code backend).');
  const w = trustAllWarning();
  assert.ok(w.startsWith('All tools are now trusted (!). Kiro will execute tools without asking for confirmation.\nAgents can sometimes do unexpected things so understand the risks.\n\nLearn more at '));
});

test('prompt: tip box and narrow tip', () => {
  const box = formatTip('Short tip', 80).trimEnd().split('\n');
  assert.equal(box.length, 5);
  for (const l of box) assert.equal([...l].length, 80, l);
  assert.ok(box[0]!.includes(' Did you know? '));
  assert.ok(box[2]!.includes('Short tip'));
  assert.equal(formatTip('Short tip', 60), '💡 Short tip\n');
  assert.equal(formatTip('x', 60, true), '* x\n');
  const long = formatTip('word '.repeat(40).trim(), 80).trimEnd().split('\n');
  assert.ok(long.length > 5);
  for (const l of long) assert.equal([...l].length, 80);
});

test('prompt: greeting variants', () => {
  const base = { resumed: false, columns: 80, greetingEnabled: true, promptHints: true, tip: 'A tip', trustAll: false, modelName: 'auto' };
  const g = formatGreeting(base);
  assert.ok(g.startsWith('Welcome to Kiro (Claude Code backend)!\n\n'));
  assert.ok(g.includes('Did you know?'));
  assert.ok(g.includes('/help all commands  •  ctrl + j new lines'));
  assert.ok(g.includes('━'.repeat(80)));
  assert.ok(g.includes('🤖 You are chatting with auto\n'));
  assert.ok(g.includes('Claude Code'));
  assert.ok(!g.includes('All tools are now trusted'));
  assert.ok(formatGreeting({ ...base, resumed: true }).startsWith('Picking up where we left off...'));
  const off = formatGreeting({ ...base, greetingEnabled: false });
  assert.ok(!off.includes('Welcome'));
  assert.ok(!off.includes('Did you know'));
  assert.ok(off.startsWith('🤖 You are chatting with auto'));
  assert.ok(!formatGreeting({ ...base, promptHints: false }).includes('Did you know'));
  assert.ok(formatGreeting({ ...base, trustAll: true }).includes('All tools are now trusted (!).'));
  assert.ok(formatGreeting({ ...base, welcomeMessage: '  Hi from agent  ' }).endsWith('Hi from agent\n\n'));
  const narrow = formatGreeting({ ...base, columns: 40 });
  assert.ok(narrow.includes('💡 A tip'));
  assert.ok(!narrow.includes('━'));
});

test('approval: answers (06 §2.2)', () => {
  const V: [string, unknown][] = [
    ['', { kind: 'empty' }],
    ['   ', { kind: 'empty' }],
    ['y', { kind: 'answer', response: { kind: 'allow-once' } }],
    ['Y', { kind: 'answer', response: { kind: 'allow-once' } }],
    [' y ', { kind: 'answer', response: { kind: 'allow-once' } }],
    ['t', { kind: 'answer', response: { kind: 'allow-always' } }],
    ['T', { kind: 'answer', response: { kind: 'allow-always' } }],
    ['n', { kind: 'answer', response: { kind: 'deny' } }],
    ['N', { kind: 'answer', response: { kind: 'deny' } }],
    ['yes', { kind: 'answer', response: { kind: 'redirect', text: 'yes' } }],
    ['no, use git status instead', { kind: 'answer', response: { kind: 'redirect', text: 'no, use git status instead' } }],
    ['/tools trust-all', { kind: 'command', text: '/tools trust-all' }],
    ['!ls -la', { kind: 'shell', command: 'ls -la' }],
    ['@review src', { kind: 'prompt', text: '@review src' }],
    ['y\u{E0041}', { kind: 'answer', response: { kind: 'allow-once' } }],
  ];
  for (const [input, want] of V) assert.deepEqual(classifyApprovalInput(input), want, JSON.stringify(input));
});
