import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assistantText,
  isAssistantFrame,
  isConversationReset,
  isRateLimitEvent,
  isResultFrame,
  isStreamEvent,
  isSystemInit,
  isUserFrame,
  toolResultText,
  toolResults,
  toolUses,
  type AssistantFrame,
  type UserFrame,
} from '../../src/claude/protocol.js';

describe('protocol type guards', () => {
  it('recognise frames and reject junk without throwing', () => {
    assert.equal(isSystemInit({ type: 'system', subtype: 'init', session_id: 's' }), true);
    assert.equal(isSystemInit({ type: 'system', subtype: 'status' }), false);
    assert.equal(isAssistantFrame({ type: 'assistant', message: { content: [] } }), true);
    assert.equal(isAssistantFrame({ type: 'assistant' }), false);
    assert.equal(isUserFrame({ type: 'user', message: { role: 'user', content: 'x' } }), true);
    assert.equal(isResultFrame({ type: 'result', is_error: false }), true);
    assert.equal(isStreamEvent({ type: 'stream_event', event: { type: 'message_stop' } }), true);
    assert.equal(isStreamEvent({ type: 'stream_event' }), false);
    assert.equal(isConversationReset({ type: 'conversation_reset', new_conversation_id: 'n' }), true);
    assert.equal(isConversationReset({ type: 'conversation_reset' }), false);
    assert.equal(isRateLimitEvent({ type: 'rate_limit_event' }), true);
    for (const junk of [null, undefined, 3, 'x', [], {}]) {
      assert.equal(isSystemInit(junk), false);
      assert.equal(isResultFrame(junk), false);
      assert.equal(isAssistantFrame(junk), false);
    }
  });
});

describe('content helpers', () => {
  const a: AssistantFrame = {
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Hello ' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'text', text: 'world' },
        { type: 'mystery', foo: 1 },
      ],
    },
  };
  it('assistantText joins text blocks only', () => {
    assert.equal(assistantText(a), 'Hello world');
    assert.equal(assistantText({ type: 'assistant', message: { content: undefined as never } }), '');
  });
  it('toolUses extracts tool_use blocks', () => {
    assert.deepEqual(toolUses(a).map((t) => t.name), ['Bash']);
  });
  it('toolResults / toolResultText handle string and block content', () => {
    const u: UserFrame = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'plain', is_error: false },
          { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'A' }, { type: 'image' }, { type: 'text', text: 'B' }] },
          { type: 'text', text: 'not a result' },
        ],
      },
    };
    const rs = toolResults(u);
    assert.equal(rs.length, 2);
    assert.equal(toolResultText(rs[0]!), 'plain');
    assert.equal(toolResultText(rs[1]!), 'AB');
    assert.deepEqual(toolResults({ type: 'user', message: { role: 'user', content: 'x' } }), []);
  });
});
