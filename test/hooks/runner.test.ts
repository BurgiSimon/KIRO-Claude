import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_STOP_CONTINUE_TEXT, wrapHookContext } from '../../src/hooks/format.js';
import { HookRunner, parseConfirmCommandOutput, parseStopDecision, sanitizeUserPrompt, truncateHookOutput } from '../../src/hooks/runner.js';
import type { HookRunContext, KiroHook } from '../../src/types.js';
import { mkCall, mkWs, q, rmWs, sleep, v2Hook, v3Hook } from './helpers.js';

function ctxFor(ws: ReturnType<typeof mkWs>, extra: Partial<HookRunContext> = {}): HookRunContext {
  return { ws, sessionId: 'sid-1', ...extra };
}

function withWs(name: string, fn: (ws: ReturnType<typeof mkWs>) => Promise<void>, sub?: string): void {
  test(name, async () => {
    const ws = mkWs(sub);
    try {
      await fn(ws);
    } finally {
      rmWs(ws);
    }
  });
}

// ───────────────────────────── pure helpers ─────────────────────────────

test('sanitizeUserPrompt: 4096-byte cap on a char boundary, control chars removed except \\n\\r\\t', () => {
  assert.equal(sanitizeUserPrompt('a\u0007b\n\tc\r\u001b[0m'), 'ab\n\tc\r[0m');
  assert.equal(sanitizeUserPrompt('x'.repeat(5000)).length, 4096);
  const s = sanitizeUserPrompt(`${'x'.repeat(4095)}é`); // é = 2 bytes => cut before it
  assert.equal(s, 'x'.repeat(4095));
});

test('truncateHookOutput: Q truncate_safe + suffix', () => {
  assert.equal(truncateHookOutput('hello', 10), 'hello');
  assert.equal(truncateHookOutput('hello', 5), 'hello');
  assert.equal(truncateHookOutput('hello!', 5), 'hello ... truncated');
  assert.equal(truncateHookOutput('ééé', 5), 'éé ... truncated');
  assert.equal(truncateHookOutput('abc', 0), ' ... truncated');
  assert.equal(truncateHookOutput('abc', 10, true), 'abc ... truncated');
});

test('parseStopDecision', () => {
  assert.deepEqual(parseStopDecision('{"decision":"block","reason":"fix tests"}\n'), { block: true, reason: 'fix tests' });
  assert.deepEqual(parseStopDecision('{"decision":"block"}'), { block: true });
  assert.deepEqual(parseStopDecision('{"decision":"block","reason":"  "}'), { block: true });
  assert.deepEqual(parseStopDecision('{"decision":"approve","reason":"x"}'), { block: false });
  assert.deepEqual(parseStopDecision('done'), { block: false });
  assert.deepEqual(parseStopDecision('{bad json'), { block: false });
  assert.deepEqual(parseStopDecision('["decision"]'), { block: false });
});

test('parseConfirmCommandOutput', () => {
  assert.deepEqual(parseConfirmCommandOutput('{"skip":true}'), { skip: true });
  assert.deepEqual(parseConfirmCommandOutput('{"question":"Q?","options":[{"id":"a","label":"A","run":true},{"id":"b"},{"x":1}]}'), {
    skip: false,
    question: 'Q?',
    options: [
      { id: 'a', label: 'A', run: true },
      { id: 'b', label: 'b', run: false },
    ],
  });
  assert.equal(parseConfirmCommandOutput('nope'), undefined);
  assert.equal(parseConfirmCommandOutput('{}'), undefined);
  assert.equal(parseConfirmCommandOutput('[1]'), undefined);
});

// ───────────────────────────── SessionStart ─────────────────────────────

withWs('SessionStart: outputs in definition order, warnings with Q string, agent prompts, disabled skipped', async (ws) => {
  const runner = new HookRunner([
    v2Hook('SessionStart', 'sleep 0.3; printf first'),
    v2Hook('SessionStart', 'printf second'),
    v2Hook('SessionStart', 'echo oops >&2; exit 1'),
    v2Hook('SessionStart', 'printf ""'),
    v3Hook('SessionStart', { prompt: 'Say hello first.' }),
    v2Hook('SessionStart', 'printf disabled', { enabled: false }),
    v2Hook('UserPromptSubmit', 'printf other-trigger'),
  ]);
  const r = await runner.runSessionStart(ctxFor(ws));
  assert.deepEqual(r.outputs, ['first', 'second']);
  assert.deepEqual(r.agentPrompts, ['Say hello first.']);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0]!.message, '✗ agentSpawn "echo oops >&2; exit 1" failed with exit code: 1, stderr: oops)');
  assert.match(r.warnings[0]!.hook, /^agentSpawn-/);
  assert.match(wrapHookContext(r.outputs, true), /for the entire conversation\n\nfirst\n\nsecond\n\n--- CONTEXT ENTRY END ---\n\n$/);
});

withWs('hooks of one event run concurrently', async (ws) => {
  const runner = new HookRunner([
    v3Hook('SessionStart', 'sleep 0.5; printf a'),
    v3Hook('SessionStart', 'sleep 0.5; printf b'),
    v3Hook('SessionStart', 'sleep 0.5; printf c'),
  ]);
  const t0 = Date.now();
  const r = await runner.runSessionStart(ctxFor(ws));
  const dt = Date.now() - t0;
  assert.deepEqual(r.outputs, ['a', 'b', 'c']);
  assert.ok(dt < 1400, `took ${dt} ms (sequential would be >= 1500)`);
});

withWs('SessionStart: exit-0 results cached for the runner lifetime; failures re-run; clearCache re-runs', async (ws) => {
  const ok = path.join(ws.dir, 'ok.count');
  const bad = path.join(ws.dir, 'bad.count');
  const runner = new HookRunner([
    v2Hook('SessionStart', `echo x >> ${q(ok)}; wc -l < ${q(ok)} | tr -d ' \\n'`),
    v2Hook('SessionStart', `echo x >> ${q(bad)}; exit 3`),
  ]);
  const r1 = await runner.runSessionStart(ctxFor(ws));
  const r2 = await runner.runSessionStart(ctxFor(ws, { prompt: 'different prompt' }));
  assert.deepEqual(r1.outputs, ['1']);
  assert.deepEqual(r2.outputs, ['1']);
  assert.equal(fs.readFileSync(ok, 'utf8').split('\n').filter(Boolean).length, 1);
  assert.equal(fs.readFileSync(bad, 'utf8').split('\n').filter(Boolean).length, 2);
  assert.equal(r2.warnings.length, 1);
  runner.clearCache();
  const r3 = await runner.runSessionStart(ctxFor(ws));
  assert.deepEqual(r3.outputs, ['2']);
});

withWs('V2 SessionStart gets the pending prompt (payload + USER_PROMPT); V3 does not', async (ws) => {
  const v2out = path.join(ws.dir, 'v2.json');
  const v3out = path.join(ws.dir, 'v3.json');
  const runner = new HookRunner([
    v2Hook('SessionStart', `cat > ${q(v2out)}; printf %s "$USER_PROMPT"`),
    v3Hook('SessionStart', `cat > ${q(v3out)}; printf %s "\${USER_PROMPT-unset}"`, { rawTrigger: 'agentSpawn' }),
  ]);
  const r = await runner.runSessionStart(ctxFor(ws, { prompt: 'first question' }));
  assert.deepEqual(r.outputs, ['first question', 'unset']);
  assert.deepEqual(JSON.parse(fs.readFileSync(v2out, 'utf8')), { hook_event_name: 'agentSpawn', cwd: ws.cwd, prompt: 'first question' });
  assert.deepEqual(JSON.parse(fs.readFileSync(v3out, 'utf8')), { hook_event_name: 'agentSpawn', cwd: ws.cwd, session_id: 'sid-1' });
  assert.equal(fs.readFileSync(v2out, 'utf8').endsWith('\n'), false, 'single line, no trailing newline');
});

withWs('working directory: V3 hooks run in the workspace root, V2 in the session cwd', async (ws) => {
  const runner = new HookRunner([v3Hook('SessionStart', 'pwd'), v2Hook('SessionStart', 'pwd')]);
  const r = await runner.runSessionStart(ctxFor(ws));
  assert.deepEqual(r.outputs, [`${ws.workspaceRoot}\n`, `${ws.cwd}\n`]);
}, 'pkg/app');

// ───────────────────────────── UserPromptSubmit ─────────────────────────────

withWs('UserPromptSubmit: USER_PROMPT env truncated + sanitized, payload prompt raw', async (ws) => {
  const payloadFile = path.join(ws.dir, 'p.json');
  const prompt = `a\u0007b\n${'z'.repeat(5000)}`;
  const runner = new HookRunner([v3Hook('UserPromptSubmit', `cat > ${q(payloadFile)}; printf %s "$USER_PROMPT"`)]);
  const r = await runner.runUserPromptSubmit({ ...ctxFor(ws), prompt });
  assert.equal(r.outputs.length, 1);
  assert.equal(r.outputs[0], sanitizeUserPrompt(prompt));
  assert.equal(Buffer.byteLength(r.outputs[0]!), 4096 - 1); // BEL removed after truncation
  assert.ok(r.outputs[0]!.startsWith('ab\nzzz'));
  assert.equal(JSON.parse(fs.readFileSync(payloadFile, 'utf8')).prompt, prompt);
});

withWs('UserPromptSubmit: V3 non-zero forwards output + exit code; V2 non-zero only warns; agent prompts', async (ws) => {
  const runner = new HookRunner([
    v2Hook('UserPromptSubmit', 'printf ctx-v2'),
    v3Hook('UserPromptSubmit', 'printf ctx-v3'),
    v2Hook('UserPromptSubmit', 'echo v2bad >&2; exit 2'),
    v3Hook('UserPromptSubmit', 'echo v3bad >&2; exit 3', { name: 'lint' }),
    v3Hook('UserPromptSubmit', 'echo only-stdout; exit 1', { name: 'out' }),
    v3Hook('UserPromptSubmit', 'sleep 5', { name: 'slow', timeoutMs: 200 }),
    v3Hook('UserPromptSubmit', { prompt: 'Also run the linter.' }),
  ]);
  const r = await runner.runUserPromptSubmit({ ...ctxFor(ws), prompt: 'hello' });
  assert.deepEqual(r.outputs, [
    'ctx-v2',
    'ctx-v3',
    'UserPromptSubmit hook "lint" exited with code 3:\nv3bad',
    'UserPromptSubmit hook "out" exited with code 1:\nonly-stdout',
    'UserPromptSubmit hook "slow" failed: command timed out after 200 ms',
  ]);
  assert.deepEqual(r.agentPrompts, ['Also run the linter.']);
  assert.equal(r.warnings.length, 4);
  assert.equal(r.warnings[0]!.message, '✗ userPromptSubmit "echo v2bad >&2; exit 2" failed with exit code: 2, stderr: v2bad)');
  assert.equal(r.warnings[1]!.message, '✗ UserPromptSubmit "echo v3bad >&2; exit 3" failed with exit code: 3, stderr: v3bad)');
  assert.match(r.warnings[3]!.message, /^✗ sleep 5 failed after \d+\.\d\d s: command timed out after 200 ms$/);
});

withWs('v2 cache_ttl_seconds: keyed by (hook, payload), expires with the injected clock, failures not cached; v3 never cached', async (ws) => {
  let now = 1_000_000;
  const c2 = path.join(ws.dir, 'v2.count');
  const c3 = path.join(ws.dir, 'v3.count');
  const cf = path.join(ws.dir, 'fail.count');
  const counter = (f: string): string => `echo x >> ${q(f)}; wc -l < ${q(f)} | tr -d ' \\n'`;
  const runner = new HookRunner(
    [
      v2Hook('UserPromptSubmit', counter(c2), { cacheTtlSec: 10 }),
      v3Hook('UserPromptSubmit', counter(c3)),
      v2Hook('UserPromptSubmit', `echo x >> ${q(cf)}; exit 1`, { cacheTtlSec: 10 }),
    ],
    { now: () => now },
  );
  const run = (prompt: string) => runner.runUserPromptSubmit({ ...ctxFor(ws), prompt });
  assert.deepEqual((await run('p')).outputs, ['1', '1']);
  now += 9_000;
  assert.deepEqual((await run('p')).outputs, ['1', '2']); // v2 cached, v3 re-ran
  assert.deepEqual((await run('other')).outputs, ['2', '3']); // different payload => different key
  now += 1_001; // 10.001 s after the first run
  assert.deepEqual((await run('p')).outputs, ['3', '4']); // expired
  assert.equal(fs.readFileSync(cf, 'utf8').split('\n').filter(Boolean).length, 4);
});

// ───────────────────────────── PreToolUse ─────────────────────────────

withWs('PreToolUse: exit 2 blocks with stderr (first blocking hook in definition order)', async (ws) => {
  const runner = new HookRunner([
    v2Hook('PreToolUse', 'sleep 0.3; printf first-block >&2; exit 2', { matcher: 'shell' }),
    v3Hook('PreToolUse', 'printf second-block >&2; exit 2', { matcher: 'shell' }),
    v3Hook('PreToolUse', 'printf fine', { matcher: 'shell' }),
  ]);
  const r = await runner.runPreToolUse(ctxFor(ws), mkCall('Bash', { command: 'rm -rf /' }, ws.cwd));
  assert.equal(r.blocked, true);
  assert.equal(r.blockReason, 'first-block');
  assert.equal(r.warnings.length, 2); // Q prints the failure line for exit 2 too
  assert.equal(r.warnings[0]!.message, '✗ preToolUse "sleep 0.3; printf first-block >&2; exit 2" failed with exit code: 2, stderr: first-block)');
  assert.equal(r.additionalContext, undefined);
});

withWs('PreToolUse: other non-zero, timeouts and spawn errors warn but never block', async (ws) => {
  const runner = new HookRunner([
    v2Hook('PreToolUse', 'echo nope >&2; exit 1'),
    v2Hook('PreToolUse', 'sleep 10', { timeoutMs: 200 }),
    v2Hook('PreToolUse', 'kill -9 $$'),
  ]);
  const t0 = Date.now();
  const r = await runner.runPreToolUse(ctxFor(ws), mkCall('Read', { file_path: '/x' }, ws.cwd));
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(r.blocked, false);
  assert.equal(r.blockReason, undefined);
  assert.equal(r.warnings.length, 3);
  assert.equal(r.warnings[0]!.message, '✗ preToolUse "echo nope >&2; exit 1" failed with exit code: 1, stderr: nope)');
  assert.match(r.warnings[1]!.message, /^✗ sleep 10 failed after 0\.\d\d s: command timed out after 200 ms$/);
  assert.equal(r.warnings[2]!.message, '✗ preToolUse "kill -9 $$" failed with exit code: -1, stderr: )');
});

withWs('PreToolUse: spawn failure warning', async (ws) => {
  const bad = { ...ws, workspaceRoot: path.join(ws.dir, 'missing') };
  const runner = new HookRunner([v3Hook('PreToolUse', 'true')]);
  const r = await runner.runPreToolUse({ ws: bad, sessionId: 's' }, mkCall('Read'));
  assert.equal(r.blocked, false);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!.message, /^✗ true failed after \d+\.\d\d s: failed to execute command: /);
});

withWs('timeout kills the whole process group (grandchildren too)', async (ws) => {
  const marker = path.join(ws.dir, 'late');
  const runner = new HookRunner([v3Hook('PreToolUse', `(sleep 0.8; touch ${q(marker)}) & sleep 0.8; touch ${q(marker)}.parent`, { timeoutMs: 200 })]);
  const t0 = Date.now();
  const r = await runner.runPreToolUse(ctxFor(ws), mkCall('Bash', { command: 'ls' }));
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(r.blocked, false);
  assert.match(r.warnings[0]!.message, /command timed out after 200 ms/);
  await sleep(1200);
  assert.equal(fs.existsSync(marker), false, 'grandchild survived the timeout');
  assert.equal(fs.existsSync(`${marker}.parent`), false);
});

withWs('PreToolUse: matchers filter hooks per dialect', async (ws) => {
  const log = path.join(ws.dir, 'ran.log');
  const mark = (tag: string): string => `echo ${tag} >> ${q(log)}`;
  const runner = new HookRunner([
    v2Hook('PreToolUse', mark('v2-read'), { matcher: 'read' }),
    v2Hook('PreToolUse', mark('v2-fs_read'), { matcher: 'fs_read' }),
    v2Hook('PreToolUse', mark('v2-write'), { matcher: 'fs_write' }),
    v2Hook('PreToolUse', mark('v2-mcp'), { matcher: '@git' }),
    v3Hook('PreToolUse', mark('v3-read'), { matcher: 'read' }),
    v3Hook('PreToolUse', mark('v3-fs_read'), { matcher: 'fs_read' }),
    v3Hook('PreToolUse', mark('v3-regex'), { matcher: '^read_file$' }),
    v3Hook('PreToolUse', mark('v3-all')),
  ]);
  await runner.runPreToolUse(ctxFor(ws), mkCall('Read', { file_path: '/a' }));
  const ran = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).sort();
  assert.deepEqual(ran, ['v2-fs_read', 'v2-read', 'v3-all', 'v3-read', 'v3-regex']);
});

withWs('PreToolUse: agent actions => additionalContext joined in definition order', async (ws) => {
  const runner = new HookRunner([
    v3Hook('PreToolUse', { prompt: 'Check for secrets first.' }, { matcher: 'write' }),
    v3Hook('PreToolUse', { prompt: 'Never touch generated files.' }, { matcher: 'write' }),
    v3Hook('PreToolUse', { prompt: 'Not for reads.' }, { matcher: 'read' }),
  ]);
  const r = await runner.runPreToolUse(ctxFor(ws), mkCall('Write', { file_path: '/ws/a', content: '' }));
  assert.equal(r.blocked, false);
  assert.equal(r.additionalContext, 'Check for secrets first.\n\nNever touch generated files.');
});

withWs('PreToolUse payload reaches the hook on stdin (V2 + V3)', async (ws) => {
  const f2 = path.join(ws.dir, 'v2.json');
  const f3 = path.join(ws.dir, 'v3.json');
  const runner = new HookRunner([v2Hook('PreToolUse', `cat > ${q(f2)}`), v3Hook('PreToolUse', `cat > ${q(f3)}`)]);
  await runner.runPreToolUse(ctxFor(ws), mkCall('Bash', { command: 'git status', description: 'Show status' }, ws.cwd));
  assert.deepEqual(JSON.parse(fs.readFileSync(f2, 'utf8')), {
    hook_event_name: 'preToolUse',
    cwd: ws.cwd,
    tool_name: 'execute_bash',
    tool_tags: ['shell', '@builtin'],
    tool_input: { command: 'git status', summary: 'Show status' },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(f3, 'utf8')), {
    hook_event_name: 'PreToolUse',
    cwd: ws.cwd,
    session_id: 'sid-1',
    tool_name: 'execute_bash',
    tool_input: { command: 'git status' },
  });
});

withWs('output truncation to maxOutputBytes with " ... truncated" (small and > capture size)', async (ws) => {
  const runner = new HookRunner([
    v2Hook('SessionStart', "head -c 20000 /dev/zero | tr '\\0' a", { maxOutputBytes: 100 }),
    v2Hook('SessionStart', "head -c 200000 /dev/zero | tr '\\0' b"),
    v2Hook('SessionStart', "printf 'ééé'", { maxOutputBytes: 5 }),
    v2Hook('SessionStart', 'printf exact', { maxOutputBytes: 5 }),
  ]);
  const r = await runner.runSessionStart(ctxFor(ws));
  assert.equal(r.outputs[0], `${'a'.repeat(100)} ... truncated`);
  assert.equal(r.outputs[1], `${'b'.repeat(10240)} ... truncated`);
  assert.equal(r.outputs[2], 'éé ... truncated');
  assert.equal(r.outputs[3], 'exact');
  const pre = new HookRunner([v2Hook('PreToolUse', "head -c 50 /dev/zero | tr '\\0' e >&2; exit 2", { maxOutputBytes: 10 })]);
  const p = await pre.runPreToolUse(ctxFor(ws), mkCall('Read'));
  assert.equal(p.blockReason, 'eeeeeeeeee ... truncated');
});

// ───────────────────────────── PostToolUse ─────────────────────────────

withWs('PostToolUse: tool_response in payload, output ignored, warnings, agent context', async (ws) => {
  const f = path.join(ws.dir, 'post.json');
  const runner = new HookRunner([
    v2Hook('PostToolUse', `cat > ${q(f)}; echo ignored`, { matcher: 'shell' }),
    v3Hook('PostToolUse', 'echo post-fail >&2; exit 2'),
    v3Hook('PostToolUse', { prompt: 'Summarize the command output.' }, { matcher: 'shell' }),
    v3Hook('PostToolUse', { prompt: 'never' }, { matcher: 'web' }),
  ]);
  const call = mkCall('Bash', { command: 'echo hi' }, ws.cwd);
  const r = await runner.runPostToolUse(ctxFor(ws), call, { success: true, response: { stdout: 'hi\n', stderr: '', interrupted: false } });
  assert.equal(r.additionalContext, 'Summarize the command output.');
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0]!.message, '✗ PostToolUse "echo post-fail >&2; exit 2" failed with exit code: 2, stderr: post-fail)');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).tool_response, { success: true, result: [{ exit_status: '0', stdout: 'hi\n', stderr: '' }] });

  const fail = await runner.runPostToolUse(ctxFor(ws), call, { success: false, error: 'Exit code 1' });
  assert.equal(fail.warnings.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).tool_response, { success: false, error: ['An error occurred processing the tool: \nExit code 1'] });
});

// ───────────────────────────── Stop ─────────────────────────────

interface StopRow {
  name: string;
  hooks: KiroHook[];
  continuations?: number;
  continueWith?: string;
  warnings: number;
}

const STOP_ROWS: StopRow[] = [
  { name: 'V3 exit 0, no output', hooks: [v3Hook('Stop', 'true')], warnings: 0 },
  { name: 'V3 exit 0, plain text', hooks: [v3Hook('Stop', 'echo all done')], warnings: 0 },
  { name: 'V3 exit 0, decision block + reason', hooks: [v3Hook('Stop', `echo '{"decision":"block","reason":"Tests are failing; fix them."}'`)], continueWith: 'Tests are failing; fix them.', warnings: 0 },
  { name: 'V3 exit 0, decision block without reason', hooks: [v3Hook('Stop', `echo '{"decision":"block"}'`)], continueWith: DEFAULT_STOP_CONTINUE_TEXT, warnings: 0 },
  { name: 'V3 exit 0, decision approve', hooks: [v3Hook('Stop', `echo '{"decision":"approve","reason":"x"}'`)], warnings: 0 },
  { name: 'V3 exit 1 => default continuation', hooks: [v3Hook('Stop', 'echo why >&2; exit 1')], continueWith: DEFAULT_STOP_CONTINUE_TEXT, warnings: 0 },
  { name: 'V3 exit 1 with JSON reason', hooks: [v3Hook('Stop', `echo '{"decision":"block","reason":"More."}'; exit 1`)], continueWith: 'More.', warnings: 0 },
  { name: 'V3 exit 2 => finished, warning', hooks: [v3Hook('Stop', `echo '{"decision":"block","reason":"x"}'; exit 2`)], warnings: 1 },
  { name: 'V3 exit 3 => finished, warning', hooks: [v3Hook('Stop', 'exit 3')], warnings: 1 },
  { name: 'V3 timeout => finished, warning', hooks: [v3Hook('Stop', 'sleep 5', { timeoutMs: 150 })], warnings: 1 },
  { name: 'V2 decision block ignored', hooks: [v2Hook('Stop', `echo '{"decision":"block","reason":"x"}'`)], warnings: 0 },
  { name: 'V2 exit 1 => warning only', hooks: [v2Hook('Stop', 'exit 1')], warnings: 1 },
  { name: 'agent action => new turn', hooks: [v3Hook('Stop', { prompt: 'Now write the changelog.' })], continueWith: 'Now write the changelog.', warnings: 0 },
  {
    name: 'several requests joined in definition order, duplicates dropped',
    hooks: [
      v3Hook('Stop', 'sleep 0.2; exit 1'),
      v3Hook('Stop', `echo '{"decision":"block","reason":"Run lint."}'`),
      v3Hook('Stop', 'exit 1'),
    ],
    continueWith: `${DEFAULT_STOP_CONTINUE_TEXT}\n\nRun lint.`,
    warnings: 0,
  },
  { name: 'cap: 2 previous continuations still continue', hooks: [v3Hook('Stop', 'exit 1')], continuations: 2, continueWith: DEFAULT_STOP_CONTINUE_TEXT, warnings: 0 },
  { name: 'cap: 3 previous continuations => no continuation + warning', hooks: [v3Hook('Stop', 'exit 1')], continuations: 3, warnings: 1 },
  { name: 'cap applies to agent actions too', hooks: [v3Hook('Stop', { prompt: 'again' })], continuations: 5, warnings: 1 },
];

for (const row of STOP_ROWS) {
  withWs(`Stop: ${row.name}`, async (ws) => {
    const runner = new HookRunner(row.hooks);
    const r = await runner.runStop({ ...ctxFor(ws), hookDrivenContinuations: row.continuations ?? 0, assistantText: 'done' });
    assert.equal(r.continueWith, row.continueWith);
    assert.equal(r.warnings.length, row.warnings, JSON.stringify(r.warnings));
    assert.equal(r.confirm, undefined);
  });
}

withWs('Stop: V3 warning strings and payload', async (ws) => {
  const f = path.join(ws.dir, 'stop.json');
  const runner = new HookRunner([v3Hook('Stop', `cat > ${q(f)}; echo bad >&2; exit 4`, { rawTrigger: 'agentStop' })]);
  const r = await runner.runStop({ ...ctxFor(ws), hookDrivenContinuations: 0 });
  assert.equal(r.warnings[0]!.message, `✗ agentStop "cat > ${q(f)}; echo bad >&2; exit 4" failed with exit code: 4, stderr: bad)`);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { hook_event_name: 'agentStop', cwd: ws.cwd, session_id: 'sid-1' });
  assert.match(
    (await new HookRunner([v3Hook('Stop', 'exit 1')]).runStop({ ...ctxFor(ws), hookDrivenContinuations: 3 })).warnings[0]!.message,
    /consecutive hook-driven continuations/,
  );
});

// ───────────────────────────── Stop confirm ─────────────────────────────

const CONFIRM = {
  question: "Submit this session's results?",
  options: [
    { id: 'submit', label: 'Yes, submit', run: true },
    { id: 'dismiss', label: 'Not this time', run: false },
  ],
};

withWs('Stop confirm: static picker, run option executes the command with Stop semantics', async (ws) => {
  const marker = path.join(ws.dir, 'submitted');
  const hook = v3Hook('Stop', `touch ${q(marker)}; exit 1`, { name: 'submit', confirm: CONFIRM });
  const runner = new HookRunner([hook, v3Hook('Stop', 'true')]);
  const ctx = { ...ctxFor(ws), hookDrivenContinuations: 0 };
  const r = await runner.runStop(ctx);
  assert.equal(fs.existsSync(marker), false, 'confirm hooks do not run before the user answers');
  assert.deepEqual(r.confirm, { hook: 'submit', question: CONFIRM.question, options: CONFIRM.options });
  assert.equal(r.continueWith, undefined);
  assert.equal(runner.pendingConfirms.length, 1);
  const done = await runner.resolveStopConfirm(ctx, 'submit', 'submit');
  assert.equal(fs.existsSync(marker), true);
  assert.equal(done.continueWith, DEFAULT_STOP_CONTINUE_TEXT);
  assert.equal(done.confirm, undefined);
  assert.equal(runner.pendingConfirms.length, 0);
});

withWs('Stop confirm: run:false option, dismissal and unknown hook do nothing', async (ws) => {
  const marker = path.join(ws.dir, 'ran');
  const runner = new HookRunner([v3Hook('Stop', `touch ${q(marker)}`, { name: 'c', confirm: CONFIRM })]);
  const ctx = { ...ctxFor(ws), hookDrivenContinuations: 0 };
  await runner.runStop(ctx);
  const r = await runner.resolveStopConfirm(ctx, 'c', 'dismiss');
  assert.equal(r.continueWith, undefined);
  assert.equal(fs.existsSync(marker), false);
  await runner.runStop(ctx);
  await runner.resolveStopConfirm(ctx, 'c', undefined);
  assert.equal(fs.existsSync(marker), false);
  const none = await runner.resolveStopConfirm(ctx, 'nope', 'submit');
  assert.deepEqual(none, { warnings: [] });
});

withWs('Stop confirm: confirmCommand skip / replace / failure fallback / default options / queue', async (ws) => {
  const ctx = { ...ctxFor(ws), hookDrivenContinuations: 0 };
  const skip = new HookRunner([v3Hook('Stop', 'true', { name: 's', confirm: { ...CONFIRM, confirmCommand: `echo '{"skip": true}'` } })]);
  assert.equal((await skip.runStop(ctx)).confirm, undefined);

  const replace = new HookRunner([
    v3Hook('Stop', 'true', {
      name: 'r',
      confirm: { ...CONFIRM, confirmCommand: `echo '{"question":"Deploy now?","options":[{"id":"go","label":"Go","run":true}]}'` },
    }),
  ]);
  assert.deepEqual((await replace.runStop(ctx)).confirm, { hook: 'r', question: 'Deploy now?', options: [{ id: 'go', label: 'Go', run: true }] });

  const failing = new HookRunner([v3Hook('Stop', 'true', { name: 'f', confirm: { ...CONFIRM, confirmCommand: 'echo broken >&2; exit 1' } })]);
  const fr = await failing.runStop(ctx);
  assert.deepEqual(fr.confirm, { hook: 'f', question: CONFIRM.question, options: CONFIRM.options });
  assert.equal(fr.warnings.length, 1);
  assert.equal(fr.warnings[0]!.message, '✗ Stop "echo broken >&2; exit 1" failed with exit code: 1, stderr: broken)');

  const invalid = new HookRunner([v3Hook('Stop', 'true', { name: 'i', confirm: { ...CONFIRM, confirmCommand: 'echo not-json' } })]);
  assert.deepEqual((await invalid.runStop(ctx)).confirm?.options, CONFIRM.options);

  const noOpts = new HookRunner([v3Hook('Stop', 'true', { name: 'n', confirm: { question: 'Run?', options: [] } })]);
  assert.deepEqual((await noOpts.runStop(ctx)).confirm?.options.map((o) => o.run), [true, false]);

  const marker = path.join(ws.dir, 'second');
  const queue = new HookRunner([
    v3Hook('Stop', 'true', { name: 'first', confirm: CONFIRM }),
    v3Hook('Stop', `touch ${q(marker)}`, { name: 'second', confirm: { question: 'Second?', options: [{ id: 'y', label: 'y', run: true }] } }),
  ]);
  const q1 = await queue.runStop(ctx);
  assert.equal(q1.confirm?.hook, 'first');
  const q2 = await queue.resolveStopConfirm(ctx, 'first', 'dismiss');
  assert.equal(q2.confirm?.hook, 'second');
  const q3 = await queue.resolveStopConfirm(ctx, 'second', 'y');
  assert.equal(q3.confirm, undefined);
  assert.equal(fs.existsSync(marker), true);
});

// ───────────────────────────── SessionEnd ─────────────────────────────

withWs('SessionEnd: best effort with a cap even for timeout 0', async (ws) => {
  const marker = path.join(ws.dir, 'ended');
  const runner = new HookRunner(
    [v3Hook('SessionEnd', `touch ${q(marker)}`), v3Hook('SessionEnd', 'sleep 10', { timeoutMs: 0 }), v3Hook('SessionEnd', { prompt: 'ignored' })],
    { sessionEndCapMs: 300 },
  );
  const t0 = Date.now();
  const r = await runner.runSessionEnd(ctxFor(ws));
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!.message, /command timed out after 300 ms/);
});

// ───────────────────────────── file triggers ─────────────────────────────

withWs('file hooks: {{filePath}} shell-quoted, matcher filtering, payload, agent context, depth guard', async (ws) => {
  const out = path.join(ws.dir, 'arg.txt');
  const payload = path.join(ws.dir, 'file.json');
  const file = path.join(ws.workspaceRoot, "src/it's here.ts");
  const runner = new HookRunner([
    v3Hook('PostFileSave', `printf %s {{filePath}} > ${q(out)}; cat > ${q(payload)}`, { matcher: '\\.ts$', rawTrigger: 'fileEdited' }),
    v3Hook('PostFileSave', 'echo never >&2; exit 1', { matcher: '\\.py$' }),
    v3Hook('PostFileSave', { prompt: 'Lint {{filePath}}.' }),
    v3Hook('PostFileCreate', 'exit 1'),
  ]);
  const call = mkCall('Edit', { file_path: file, old_string: 'a', new_string: 'b' }, ws.cwd);
  const r = await runner.runFileHook(ctxFor(ws), 'PostFileSave', file, call);
  assert.equal(fs.readFileSync(out, 'utf8'), file);
  assert.deepEqual(JSON.parse(fs.readFileSync(payload, 'utf8')), {
    hook_event_name: 'fileEdited',
    cwd: ws.cwd,
    session_id: 'sid-1',
    file_path: file,
    tool_name: 'str_replace',
  });
  assert.equal(r.warnings.length, 0);
  assert.equal(r.additionalContext, `File ${file} was saved. Lint ${file}.`);
  const deep = await runner.runFileHook({ ...ctxFor(ws), hookDepth: 1 }, 'PostFileSave', file, call);
  assert.equal(deep.additionalContext, undefined);
});

withWs('file hooks: legacy glob patterns and relative paths', async (ws) => {
  const log = path.join(ws.dir, 'ran.log');
  const legacy = {
    ...v3Hook('PostFileCreate', `echo {{filePath}} >> ${q(log)}`, { source: 'legacy-ide', matcher: '(?:^|/)[^/]*\\.css$' }),
    filePatterns: ['*.css'],
  } as KiroHook;
  const runner = new HookRunner([legacy, v3Hook('PostFileCreate', { prompt: 'Check styles.' }, { matcher: '^styles/' })]);
  const call = mkCall('Write', { file_path: 'styles/site.css', content: '' }, ws.workspaceRoot);
  const r = await runner.runFileHook(ctxFor(ws), 'PostFileCreate', 'styles/site.css', call);
  const abs = path.join(ws.workspaceRoot, 'styles/site.css');
  assert.equal(fs.readFileSync(log, 'utf8'), `${abs}\n`);
  assert.equal(r.additionalContext, `File ${abs} was created. Check styles.`);
  const miss = await runner.runFileHook(ctxFor(ws), 'PostFileCreate', 'a.js', call);
  assert.equal(miss.additionalContext, undefined);
  assert.equal(fs.readFileSync(log, 'utf8'), `${abs}\n`);
});

// ───────────────────────────── task triggers ─────────────────────────────

withWs('task hooks: PreTaskExec exit 2 blocks; PostTaskExec exit 2 warns; payload; agent prompts', async (ws) => {
  const f = path.join(ws.dir, 'task.json');
  const task = { specName: 'auth', taskId: '2.1', title: 'Create models' };
  const runner = new HookRunner([
    v3Hook('PreTaskExec', `cat > ${q(f)}; echo 'tests missing' >&2; exit 2`),
    v3Hook('PreTaskExec', { prompt: 'Write tests first.' }),
    v3Hook('PostTaskExec', 'echo post >&2; exit 2'),
    v3Hook('PostTaskExec', { prompt: 'Verify spec alignment.' }),
  ]);
  const pre = await runner.runTaskHook(ctxFor(ws), 'PreTaskExec', task);
  assert.equal(pre.blocked, true);
  assert.equal(pre.blockReason, 'tests missing\n');
  assert.deepEqual(pre.agentPrompts, ['Write tests first.']);
  assert.equal(pre.warnings.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), {
    hook_event_name: 'PreTaskExec',
    cwd: ws.cwd,
    session_id: 'sid-1',
    spec_name: 'auth',
    spec_dir: path.join(ws.workspaceRoot, '.kiro', 'specs', 'auth'),
    task_id: '2.1',
    task_title: 'Create models',
    task_optional: false,
  });
  const post = await runner.runTaskHook(ctxFor(ws), 'PostTaskExec', task);
  assert.equal(post.blocked, false);
  assert.deepEqual(post.agentPrompts, ['Verify spec alignment.']);
  assert.equal(post.warnings.length, 1);
});

// ───────────────────────────── Manual ─────────────────────────────

withWs('runManual: by name (exact, then case-insensitive), agent, disabled, not found', async (ws) => {
  const runner = new HookRunner([
    v3Hook('Manual', 'printf manual-out', { name: 'Gen Docs' }),
    v3Hook('Manual', 'echo bad >&2; exit 5', { name: 'broken' }),
    v3Hook('Manual', { prompt: 'Write a commit message.' }, { name: 'commit-message' }),
    v3Hook('Manual', 'true', { name: 'off', enabled: false }),
    v3Hook('Stop', 'printf not-manual', { name: 'stop-hook' }),
  ]);
  const ctx = ctxFor(ws);
  assert.deepEqual(await runner.runManual(ctx, 'Gen Docs'), { found: true, output: 'manual-out', exitCode: 0, warnings: [] });
  assert.equal((await runner.runManual(ctx, 'gen docs')).output, 'manual-out');
  const b = await runner.runManual(ctx, 'broken');
  assert.equal(b.output, 'bad\n');
  assert.equal(b.exitCode, 5);
  assert.equal(b.warnings[0]!.message, '✗ Manual "echo bad >&2; exit 5" failed with exit code: 5, stderr: bad)');
  assert.deepEqual(await runner.runManual(ctx, 'commit-message'), { found: true, agentPrompt: 'Write a commit message.', warnings: [] });
  const off = await runner.runManual(ctx, 'off');
  assert.equal(off.found, true);
  assert.equal(off.output, undefined);
  assert.equal(off.warnings.length, 1);
  assert.deepEqual(await runner.runManual(ctx, 'stop-hook'), { found: false, warnings: [] });
  assert.deepEqual(await runner.runManual(ctx, 'missing'), { found: false, warnings: [] });
});

// ───────────────────────────── misc ─────────────────────────────

withWs('abort signal: running hooks are killed, no warnings, no block', async (ws) => {
  const runner = new HookRunner([v3Hook('PreToolUse', 'sleep 5; exit 2')]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const t0 = Date.now();
  const r = await runner.runPreToolUse(ctxFor(ws, { signal: ac.signal }), mkCall('Bash', { command: 'x' }));
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(r, { blocked: false, warnings: [] });
});

test('hooks list is exposed read-only and in definition order', () => {
  const hooks = [v3Hook('Stop', 'a'), v2Hook('SessionStart', 'b')];
  const runner = new HookRunner(hooks);
  assert.deepEqual(runner.hooks, hooks);
  assert.notEqual(runner.hooks, hooks);
  assert.throws(() => (runner.hooks as KiroHook[]).push(hooks[0]!));
});

withWs('no hooks => empty results', async (ws) => {
  const runner = new HookRunner([]);
  assert.deepEqual(await runner.runSessionStart(ctxFor(ws)), { outputs: [], agentPrompts: [], warnings: [] });
  assert.deepEqual(await runner.runUserPromptSubmit({ ...ctxFor(ws), prompt: 'x' }), { outputs: [], agentPrompts: [], warnings: [] });
  assert.deepEqual(await runner.runPreToolUse(ctxFor(ws), mkCall('Read')), { blocked: false, warnings: [] });
  assert.deepEqual(await runner.runPostToolUse(ctxFor(ws), mkCall('Read'), { success: true }), { warnings: [] });
  assert.deepEqual(await runner.runStop({ ...ctxFor(ws), hookDrivenContinuations: 0 }), { warnings: [] });
  assert.deepEqual(await runner.runSessionEnd(ctxFor(ws)), { warnings: [] });
  assert.deepEqual(await runner.runFileHook(ctxFor(ws), 'PostFileSave', '/x', mkCall('Write')), { warnings: [] });
  assert.deepEqual(await runner.runTaskHook(ctxFor(ws), 'PreTaskExec', { specName: 's', taskId: '1', title: 't' }), { blocked: false, agentPrompts: [], warnings: [] });
});

withWs('custom shell option', async (ws) => {
  const runner = new HookRunner([v3Hook('SessionStart', 'printf "%s" "$0"')], { shell: '/bin/sh' });
  const r = await runner.runSessionStart(ctxFor(ws));
  assert.deepEqual(r.outputs, ['/bin/sh']);
});

// ───────────────────────────── Manual: cancellation (G3/G4) ─────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(file: string, ms = 5000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const s = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
    if (/^\d+$/.test(s)) return Number(s);
    if (Date.now() - t0 > ms) throw new Error(`the hook never wrote ${file}`);
    await sleep(20);
  }
}

for (const [label, timeoutMs] of [['timeout 0 (no limit)', 0], ['the default timeout', 60_000]] as const) {
  withWs(`runManual: the abort signal kills a running command (${label}, SIGTERM ignored); the result says aborted, no output, no warning (G3/G4)`, async (ws) => {
    const pidFile = path.join(ws.dir, 'manual.pid');
    const done = path.join(ws.dir, 'manual.done');
    // the shell and its child ignore SIGTERM/SIGINT/SIGHUP: only SIGKILL of the group ends them
    const command = `trap '' TERM INT HUP; echo $$ > ${q(pidFile)}; sleep 30; touch ${q(done)}; echo SLOW-DONE`;
    const runner = new HookRunner([v3Hook('Manual', command, { name: 'slow', timeoutMs })]);
    const ac = new AbortController();
    const running = runner.runManual(ctxFor(ws, { signal: ac.signal }), 'slow');
    const pid = await readPid(pidFile);
    const t0 = Date.now();
    ac.abort();
    const r = await running;
    assert.ok(Date.now() - t0 < 2000, `the aborted hook ended after ${Date.now() - t0} ms`);
    assert.deepEqual(r, { found: true, aborted: true, warnings: [] });
    const t1 = Date.now();
    while (pidAlive(pid) && Date.now() - t1 < 2000) await sleep(20);
    assert.ok(!pidAlive(pid), `hook process ${pid} still runs`);
    assert.ok(!fs.existsSync(done));
  });
}

withWs('runManual: a signal aborted before the run starts runs nothing and says aborted (G3/G4)', async (ws) => {
  const marker = path.join(ws.dir, 'ran');
  const runner = new HookRunner([v3Hook('Manual', `touch ${q(marker)}`, { name: 'late' })]);
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await runner.runManual(ctxFor(ws, { signal: ac.signal }), 'late'), { found: true, aborted: true, warnings: [] });
  assert.ok(!fs.existsSync(marker));
  // a finished run is not reported as aborted, even with a signal that is aborted afterwards
  const ac2 = new AbortController();
  const ok = await runner.runManual(ctxFor(ws, { signal: ac2.signal }), 'late');
  ac2.abort();
  assert.deepEqual(ok, { found: true, output: '', exitCode: 0, warnings: [] });
});

const SETSID = ['/usr/bin/setsid', '/bin/setsid'].find((p) => fs.existsSync(p));

withWs('runManual: an abort ends the run even when a process outside the hook group keeps its pipes open (pipe grace; G3/G4)', async (ws) => {
  if (!SETSID) return; // no setsid(1) here (macOS): nothing can leave the group this way
  const escPid = path.join(ws.dir, 'esc.pid');
  const shPid = path.join(ws.dir, 'sh.pid');
  // the escaped child holds the hook's stdout/stderr; the group kill cannot reach it
  const command = `${SETSID} sleep 30 & echo $! > ${q(escPid)}; echo $$ > ${q(shPid)}; sleep 30; echo SLOW-DONE`;
  const runner = new HookRunner([v3Hook('Manual', command, { name: 'esc', timeoutMs: 0 })]);
  const ac = new AbortController();
  const running = runner.runManual(ctxFor(ws, { signal: ac.signal }), 'esc');
  const esc = await readPid(escPid);
  const sh = await readPid(shPid);
  try {
    const t0 = Date.now();
    ac.abort();
    const r = await running;
    assert.ok(Date.now() - t0 < 2000, `the aborted hook ended after ${Date.now() - t0} ms`);
    assert.deepEqual(r, { found: true, aborted: true, warnings: [] });
    const t1 = Date.now();
    while (pidAlive(sh) && Date.now() - t1 < 2000) await sleep(20);
    assert.ok(!pidAlive(sh), `the hook shell ${sh} still runs`);
  } finally {
    try {
      process.kill(esc, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});
