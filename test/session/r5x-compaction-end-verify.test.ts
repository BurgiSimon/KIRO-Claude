/**
 * r5x X2 verifier (group compaction-end), KiroSession: a compaction Claude reports `started` and
 * never ends (no failed status, no boundary) was closed only when the turn's frames ended, so its
 * `compaction_failed` came AFTER the answer Claude streamed once it went on. Claude streams
 * nothing of its own while it compacts (VERIFIED 2.1.319 /compact capture: status compacting,
 * status null + compact_result, system/init, compact_boundary, the synthetic summary; no
 * stream_event or assistant frame), so main-thread output while a compaction is open means it
 * ended without compacting: its end now goes BEFORE that output. KiroCrew's dashboard reads a
 * compaction terminal as a segment boundary and drops the text before it (KC
 * dashboard/chat_turn/session_events.py), so an end after the answer erased the answer; the REPL
 * printed "Compaction failed" under the answer.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import type { SessionEvent } from '../../src/types.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, semantic, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const COMPACTING = { frame: { type: 'system', subtype: 'status', status: 'compacting' } };
const SCRIPT = {
  turns: [
    { repeat: true, match: '^dangling-text', steps: [{ text: 'before ' }, COMPACTING, { text: 'ANSWER dangling' }] },
    { repeat: true, match: '^dangling-tool', steps: [COMPACTING, { tool: { name: 'Read', input: { file_path: '/etc/hostname' } } }, { text: 'ANSWER after the tool' }] },
    { repeat: true, match: '^dangling-thinking', steps: [COMPACTING, { thinking: 'hmm' }, { text: 'ANSWER after thinking' }] },
    { repeat: true, match: '^dangling-quiet', steps: [{ text: 'only before ' }, COMPACTING] },
  ],
  default: { steps: [{ text: 'ok' }] },
};

const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, ...over });

const iOf = (events: SessionEvent[], pred: (e: SessionEvent) => boolean): number => events.findIndex(pred);
const isText = (e: SessionEvent): boolean => (e.type === 'text' || e.type === 'text_delta') && e.text !== '';

describe('r5x X2 verifier: a compaction Claude never ends is closed before the output that follows it', () => {
  it('text after it: compaction_failed before the answer\'s first text (text before the compaction stays before its start)', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb);
    try {
      const { events, result } = await drain(s.prompt({ text: 'dangling-text' }));
      assert.equal(result.isError, false, JSON.stringify(result));
      const sem = semantic(events);
      const iStart = iOf(sem, (e) => e.type === 'compaction' && e.state === 'started');
      const iEnd = iOf(sem, (e) => e.type === 'compaction_failed');
      const iAnswer = iOf(sem, (e) => isText(e) && /ANSWER/.test((e as { text: string }).text));
      assert.ok(iStart >= 0 && iEnd > iStart, JSON.stringify(sem));
      assert.ok(iAnswer > iEnd, `the end of the compaction came after the answer Claude streamed once it went on: ${JSON.stringify(sem)}`);
      assert.match((sem[iEnd] as { reason: string }).reason, /did not finish/i);
      assert.equal(sem.filter((e) => e.type === 'compaction_failed').length, 1, 'one end per start');
      // (the fake's bare status frame does not close the open message: one message holds both texts)
      assert.match(result.text, /ANSWER dangling$/);
    } finally {
      await closeAll(s);
    }
  });

  it('a tool call after it: compaction_failed before tool_start', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb);
    try {
      const { events } = await drain(s.prompt({ text: 'dangling-tool' }));
      const sem = semantic(events);
      const iEnd = iOf(sem, (e) => e.type === 'compaction_failed');
      const iTool = iOf(sem, (e) => e.type === 'tool_start');
      assert.ok(iEnd >= 0 && iTool > iEnd, JSON.stringify(sem));
      assert.equal(sem.filter((e) => e.type === 'compaction_failed').length, 1);
    } finally {
      await closeAll(s);
    }
  });

  it('thinking after it: compaction_failed before the thinking', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb);
    try {
      const { events } = await drain(s.prompt({ text: 'dangling-thinking' }));
      const sem = semantic(events);
      const iEnd = iOf(sem, (e) => e.type === 'compaction_failed');
      const iThink = iOf(sem, (e) => e.type === 'thinking_delta');
      assert.ok(iEnd >= 0 && iThink > iEnd, JSON.stringify(sem));
    } finally {
      await closeAll(s);
    }
  });

  it('nothing after it (control): still one compaction_failed when the turn ends, after the text before it', async () => {
    const sb = mkSandbox({ script: SCRIPT });
    const s = await open(sb);
    try {
      const { events, result } = await drain(s.prompt({ text: 'dangling-quiet' }));
      assert.equal(result.isError, false, JSON.stringify(result));
      const sem = semantic(events);
      const ends = sem.filter((e) => e.type === 'compaction_failed');
      assert.equal(ends.length, 1, JSON.stringify(sem));
      assert.ok(iOf(sem, (e) => e.type === 'compaction_failed') > iOf(sem, isText));
      // and the next compaction is reported from its start
      const { events: again } = await drain(s.prompt({ text: 'dangling-text' }));
      assert.equal(semantic(again).filter((e) => e.type === 'compaction' && e.state === 'started').length, 1);
    } finally {
      await closeAll(s);
    }
  });
});
