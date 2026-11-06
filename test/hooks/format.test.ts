import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STOP_CONTINUE_TEXT,
  MAX_HOOK_CONTINUATIONS,
  fileTriggerVerb,
  formatContinuationLimitWarning,
  formatFileHookContext,
  formatHookError,
  formatHookFailure,
  formatHookWarning,
  formatHooksFinished,
  formatHooksProgress,
  formatPromptHookErrorNote,
  formatPromptHookExitNote,
  formatSeconds,
  hookSpawnError,
  hookTimeoutError,
  preToolBlockMessage,
  wrapHookContext,
} from '../../src/hooks/format.js';

const PRE =
  'This section (like others) contains important information that I want you to use in your responses. I have gathered this context from valuable programmatic script hooks. You must follow any requests and consider all of the information in this section';

test('wrapHookContext: agentSpawn variant (06 §3.7 exact)', () => {
  assert.equal(
    wrapHookContext(['out1', 'out2'], true),
    `--- CONTEXT ENTRY BEGIN ---\n${PRE} for the entire conversation\n\nout1\n\nout2\n\n--- CONTEXT ENTRY END ---\n\n`,
  );
});

test('wrapHookContext: userPromptSubmit variant (no suffix)', () => {
  assert.equal(wrapHookContext(['x\n'], false), `--- CONTEXT ENTRY BEGIN ---\n${PRE}\n\nx\n\n\n--- CONTEXT ENTRY END ---\n\n`);
});

test('wrapHookContext: nothing non-empty => empty string (Q None)', () => {
  assert.equal(wrapHookContext([], true), '');
  assert.equal(wrapHookContext(['', ''], false), '');
});

test('wrapHookContext: empty outputs still emitted when one is non-empty (Q)', () => {
  assert.equal(wrapHookContext(['', 'a'], false), `--- CONTEXT ENTRY BEGIN ---\n${PRE}\n\n\n\na\n\n--- CONTEXT ENTRY END ---\n\n`);
});

test('formatHookFailure: Q line with stray paren and trimEnd', () => {
  assert.equal(formatHookFailure('agentSpawn', 'git status', 1, 'fatal: not a repo\n\n'), '✗ agentSpawn "git status" failed with exit code: 1, stderr: fatal: not a repo)');
  assert.equal(formatHookFailure('preToolUse', 'x', 2, ''), '✗ preToolUse "x" failed with exit code: 2, stderr: )');
});

test('formatHookError / timeout / spawn strings', () => {
  assert.equal(formatSeconds(1234), '1.23');
  assert.equal(formatSeconds(5), '0.01');
  assert.equal(hookTimeoutError(300), 'command timed out after 300 ms');
  assert.equal(hookSpawnError('ENOENT'), 'failed to execute command: ENOENT');
  assert.equal(formatHookError('sleep 5', 300.4, hookTimeoutError(300)), '✗ sleep 5 failed after 0.30 s: command timed out after 300 ms');
});

test('formatHookWarning dispatches to the error or failure line', () => {
  assert.equal(formatHookWarning({ trigger: 'stop', command: 'c', exitCode: 3, output: 'e\n' }), '✗ stop "c" failed with exit code: 3, stderr: e)');
  assert.equal(formatHookWarning({ trigger: 'stop', command: 'c', error: 'command timed out after 5 ms', durationMs: 10 }), '✗ c failed after 0.01 s: command timed out after 5 ms');
  assert.equal(formatHookWarning({ trigger: 'stop', command: 'c' }), '✗ stop "c" failed with exit code: -1, stderr: )');
});

test('progress and summary lines', () => {
  assert.equal(formatHooksProgress(1, 3), '1 of 3 hooks finished');
  assert.equal(formatHooksFinished(3, 3, 120, true), '✓ 3 of 3 hooks finished in 0.12 s');
  assert.equal(formatHooksFinished(2, 3, 1500, false), '✗ 2 of 3 hooks finished in 1.50 s');
});

test('preToolBlockMessage (02 App. B)', () => {
  assert.equal(preToolBlockMessage('no writes here'), 'PreToolHook blocked the tool execution: no writes here');
});

test('UserPromptSubmit V3 notes', () => {
  assert.equal(formatPromptHookExitNote('UserPromptSubmit', 'lint', 3, 'bad\n'), 'UserPromptSubmit hook "lint" exited with code 3:\nbad');
  assert.equal(formatPromptHookExitNote('UserPromptSubmit', 'lint', 1, '  \n'), 'UserPromptSubmit hook "lint" exited with code 1');
  assert.equal(formatPromptHookErrorNote('UserPromptSubmit', 'lint', 'command timed out after 5 ms'), 'UserPromptSubmit hook "lint" failed: command timed out after 5 ms');
});

test('file trigger context text (03 §2.5)', () => {
  assert.equal(fileTriggerVerb('PostFileSave'), 'saved');
  assert.equal(fileTriggerVerb('PostFileCreate'), 'created');
  assert.equal(fileTriggerVerb('PostFileDelete'), 'deleted');
  assert.equal(formatFileHookContext('PostFileSave', '/ws/a.ts', 'Lint it.'), 'File /ws/a.ts was saved. Lint it.');
  assert.equal(formatFileHookContext('PostFileCreate', '/ws/b.ts', 'Add tests.'), 'File /ws/b.ts was created. Add tests.');
});

test('Stop constants', () => {
  assert.equal(DEFAULT_STOP_CONTINUE_TEXT, 'Continue working; the stop hook requested more work.');
  assert.equal(MAX_HOOK_CONTINUATIONS, 3);
  assert.match(formatContinuationLimitWarning(), /3 consecutive hook-driven continuations/);
});
