import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JsonRenderer, TextRenderer, toolStartLines } from '../../src/headless/render.js';
import { renderContextReport, renderHooks, renderMcpStatus, renderModelList } from '../../src/headless/local.js';
import { Capture } from '../cli/helpers.js';
import { call } from './mockSession.js';

function text(): { r: TextRenderer; out: Capture; err: Capture } {
  const out = new Capture();
  const err = new Capture();
  let now = 1000;
  const r = new TextRenderer(out, err, () => (now += 250));
  return { r, out, err };
}

test('text then a tool: the text line is terminated before the tool starts', () => {
  const { r, out } = text();
  r.event({ type: 'text_delta', text: 'partial' });
  r.event({ type: 'tool_start', toolUseId: 'a', call: call(), trusted: false });
  r.event({ type: 'tool_end', toolUseId: 'a', isError: false, output: '' });
  r.event({ type: 'text_delta', text: 'next' });
  r.result({ stopReason: 'end_turn', isError: false, text: 'next', permissionDenials: [] });
  assert.equal(out.text, 'partial\nnext\n');
});

test('tool end without durationMs uses the clock; denial without start prints the header', () => {
  const { r, err } = text();
  r.event({ type: 'tool_start', toolUseId: 'a', call: call({ input: {} }), trusted: false });
  r.event({ type: 'tool_end', toolUseId: 'a', isError: false, output: '' });
  assert.ok(err.text.includes(' ● Completed in 0.250s'));
  assert.ok(!err.text.includes('Purpose'));
  r.event({ type: 'tool_denied', call: call(), reason: 'nope' });
  assert.ok(err.text.endsWith('🛠️  Using tool: shell\n ⋮ \n ● I will run the following shell command: ls -la\n ⋮ \n ↳ Purpose: List files\n ⋮ \n ● Denied: nope\n\n'));
});

test('errors are not echoed on stdout; rate limits and compaction on stderr', () => {
  const { r, out, err } = text();
  r.result({ stopReason: 'error', isError: true, text: 'Not logged in', permissionDenials: [] });
  assert.equal(out.text, '');
  r.event({ type: 'rate_limit', status: 'rejected', resetsAt: 1_800_000_000 });
  assert.match(err.text, /WARNING: Claude Code usage limit reached \(resets 2027-01-15T08:00:00\.000Z\)/);
  r.event({ type: 'rate_limit', status: 'allowed' });
  r.event({ type: 'thinking_delta', text: 'hmm' });
  r.event({ type: 'subagent', state: 'started', agentType: 'general-purpose' });
  r.event({ type: 'notice', level: 'warn', message: 'warned' });
  assert.ok(err.text.endsWith('warned\n'));
  assert.ok(!err.text.includes('hmm'));
  r.error('boom');
  assert.ok(err.text.endsWith('boom\n'));
});

test('toolStartLines: empty summary', () => {
  assert.equal(toolStartLines(call({ summary: '', input: {} }), false), '\n🛠️  Using tool: shell\n ⋮ \n ● \n');
});

test('JsonRenderer: unserializable events degrade to a marker line', () => {
  const out = new Capture();
  const r = new JsonRenderer(out);
  r.event({ type: 'raw', frame: {} });
  r.event({ type: 'todo_update', todos: [{ id: '1', subject: 's', status: 'pending' }] });
  r.event({ type: 'notice', level: 'info', message: 1n as unknown as string });
  const lines = out.text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(lines[0], { type: 'todo_update', todos: [{ id: '1', subject: 's', status: 'pending' }] });
  assert.deepEqual(lines[1], { type: 'notice', error: 'unserializable event' });
});

test('local renderers', () => {
  assert.equal(renderMcpStatus([]), 'No MCP servers configured.');
  assert.equal(renderMcpStatus([{ name: 'a', status: 'connected', toolCount: 1 }]), 'a  connected  1 tool');
  assert.equal(renderModelList([], 'auto'), 'No models available');
  assert.equal(
    renderHooks([
      {
        dialect: 'v3', source: 'workspace-file', name: 'lint', trigger: 'PostToolUse', rawTrigger: 'PostToolUse', matcher: 'fs_write',
        action: { type: 'agent', prompt: 'check lint' }, timeoutMs: 60000, maxOutputBytes: 10240, cacheTtlSec: 0, enabled: false,
      },
    ]),
    'PostToolUse  lint [fs_write] (disabled): (agent) check lint',
  );
  const ctx = renderContextReport('dev', {
    agentEntries: [],
    sessionEntries: [{ pattern: 'src/**/*.ts', files: [{ path: '/w/src/a.ts', tokens: 3 }, { path: '/w/src/b.ts', tokens: 4 }] }],
    steering: [],
    hookOutputs: [{ tokens: 9 }],
    droppedFiles: ['/w/big.txt'],
    totalTokens: 16,
    contextWindowTokens: 0,
  });
  assert.equal(
    ctx,
    [
      '👤 Agent (dev):',
      '    <none>',
      '',
      '💬 Session (temporary):',
      '    src/**/*.ts (2 matches)',
      '        /w/src/a.ts (~3 tkns)',
      '        /w/src/b.ts (~4 tkns)',
      '',
      '🪝 Hook output:',
      '    agentSpawn #1 (~9 tkns)',
      '',
      'Some context files are dropped due to size limit:',
      '    /w/big.txt',
      '',
      'Total: ~16 tokens (0.0% of the context window)',
    ].join('\n'),
  );
});

test('a failed compaction closes "Compacting conversation..." on stderr (r5x X2)', () => {
  const { r, out, err } = text();
  r.event({ type: 'compaction', state: 'started' });
  r.event({ type: 'compaction_failed', reason: 'Not enough messages to compact.\x1b[31m\x07' });
  assert.equal(err.text, 'Compacting conversation...\nCompaction failed: Not enough messages to compact.\n');
  r.event({ type: 'compaction', state: 'started' });
  r.event({ type: 'compaction_failed', reason: 'Compaction cancelled', cancelled: true });
  r.event({ type: 'compaction', state: 'started' });
  r.event({ type: 'compaction_failed', reason: 'Compaction failed' });
  assert.ok(err.text.endsWith('Compacting conversation...\nCompaction cancelled.\nCompacting conversation...\nCompaction failed.\n'));
  assert.ok(!err.text.includes('✔'));
  assert.equal(out.text, '');
});
