/**
 * Guards for the round-4 restored-history items (scratchpad r4-findings.json #1, #6):
 *  - #1: after a resume / fork fell back to a fresh Claude session (its transcript was gone), the
 *    record's saved history (`<kiro-restored-history>`) is pending until the line that carries it
 *    is written. It is kept on the record (`SessionRecord.pendingHistory`, saved like
 *    `pendingContext`), not only in memory: the real claude 2.1.319 writes a fresh session's
 *    transcript for a local command line (`/effort`, `/compact`, ...; the fake now does too), after
 *    which a `/tangent`, a spec-style fork and a reopen resume / fork it "successfully", so only
 *    the record still knows the history. A reopen re-sends it (once: never together with a block
 *    a second fallback builds from the journal), a tangent and `create({ fork })` copy it, `/clear`
 *    drops it, `/chat save` + `/chat load` carry it. A local `/effort` while it is pending is
 *    queued for the next prompt line (which carries the history), so it does not write first.
 *  - #6: a child that died between turns is respawned BEFORE the line is composed (first prompt,
 *    redirect, Stop-hook continuation), so a fallback of that respawn puts the history into that
 *    very line, not the next one; a child that dies while the line is being composed (its
 *    userPromptSubmit hooks run) has the line recomposed with the block the respawn's fallback
 *    queued. A close before the line keeps the block for the reopen.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { findTranscript } from '../../src/claude/transcript.js';
import { importSessionExport, KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { fromDiskJson, SESSION_KIND, SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const HIST = { turns: [], default: { steps: [{ text: 'hist=[{{historyUserTexts}}]' }] } };
const BLOCK = '<kiro-restored-history>';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env };
}

async function open(sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> {
  return KiroSessionImpl.create({ ...baseOptions(sb, ui), ...over });
}

function textOf(line: Record<string, unknown> | undefined): string {
  const c = (line?.message as { content?: unknown } | undefined)?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text) : '')).join('');
}
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
const lastUserText = (sb: Sandbox): string => textOf(sb.userLines().at(-1));
/** The last user line the fakes received that contains `needle` ('' when none). */
const lineFor = (sb: Sandbox, needle: string): string => sb.userLines().map(textOf).filter((t) => t.includes(needle)).at(-1) ?? '';
const fellBack = (ui: RecordingUI): boolean => ui.notices.some((n) => /could not find the saved conversation/i.test(n.message));
const onDisk = (sb: Sandbox, id: string): SessionRecord | undefined => new SessionStore(sb.sessionsDir).read(id);
const loseTranscripts = (sb: Sandbox): void => fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });
const hasTranscript = (sb: Sandbox, claudeId: string): boolean => !!findTranscript(claudeId, { cwd: sb.ws.cwd, env: sb.env });

async function killChild(s: KiroSessionImpl): Promise<void> {
  process.kill(s.process!.pid!, 'SIGKILL');
  const t0 = Date.now();
  while (s.process?.running && Date.now() - t0 < 5000) await sleep(20);
  assert.equal(s.process?.running, false, 'precondition: the child is dead');
}

async function waitFor(file: string, what: string): Promise<void> {
  const t0 = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - t0 > 10_000) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/**
 * A saved session with `prompts` whose Claude transcripts are then lost, reopened: the resume fell
 * back to a fresh Claude session, with the saved history pending for the next line.
 */
async function fallenBack(prompts = ['remember ALPHA_1']): Promise<{ sb: Sandbox; s: KiroSessionImpl; id: string }> {
  const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
  const first = await open(sb);
  const id = first.id;
  try {
    for (const p of prompts) await drain(first.prompt({ text: p }));
  } finally {
    await closeAll(first);
  }
  loseTranscripts(sb);
  const ui = recordingUI();
  const s = await open(sb, { resume: { sessionId: id } }, ui);
  assert.ok(fellBack(ui), 'precondition: the resume fell back to a fresh Claude session');
  return { sb, s, id };
}

/** The local commands after which the real claude 2.1.319 has written the fresh session's transcript. */
const LOCAL: { name: string; run(s: KiroSessionImpl): Promise<void> }[] = [
  { name: '/effort', run: (s) => s.setEffort('low') },
  { name: '/compact', run: async (s) => void (await drain(s.compact())) },
];

// ───────────────────────────── #1 ─────────────────────────────

describe('R4 #1: the pending restored history is kept on the record until its line is written', () => {
  it('the fallback saves it with the record; the line that carries it removes it (once)', async () => {
    const { sb, s, id } = await fallenBack();
    try {
      assert.match(onDisk(sb, id)?.pendingHistory ?? '', /<kiro-restored-history>[\s\S]*ALPHA_1[\s\S]*<\/kiro-restored-history>/, 'saved with the record');
      await drain(s.prompt({ text: 'next' }));
      const t = lastUserText(sb);
      assert.equal(count(t, BLOCK), 1);
      assert.match(t, /ALPHA_1[\s\S]*<\/kiro-restored-history>[\s\S]*next/);
      assert.equal(s.record.pendingHistory, undefined);
      assert.equal(onDisk(sb, id)?.pendingHistory, undefined, 'removed from the saved record once its line is written');
      await drain(s.prompt({ text: 'after' }));
      assert.equal(count(lastUserText(sb), BLOCK), 0);
    } finally {
      await closeAll(s);
    }
  });

  it('a local /effort while it is pending is queued: written right before the next prompt line, which carries the history', async () => {
    const { sb, s } = await fallenBack();
    try {
      const before = sb.userLines().length;
      await s.setEffort('low');
      assert.equal(s.effort, 'low');
      assert.equal(sb.userLines().length, before, 'no /effort line was written while the history is pending');
      assert.equal(hasTranscript(sb, s.claudeSessionId!), false, 'the fresh Claude session still has no transcript');
      await drain(s.prompt({ text: 'next' }));
      const lines = sb.userLines().slice(before).map(textOf);
      assert.equal(lines.length, 2, JSON.stringify(lines.map((l) => l.slice(0, 60))));
      assert.equal(lines[0], '/effort low');
      assert.match(lines[1]!, /<kiro-restored-history>[\s\S]*ALPHA_1[\s\S]*next/);
    } finally {
      await closeAll(s);
    }
  });

  it('the fake models the real claude: a local command writes a fresh session\'s transcript, and a pending fork\'s', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    try {
      await drain(s.compact());
      assert.ok(hasTranscript(sb, s.claudeSessionId!), 'a new session has a transcript after /compact');
      await drain(s.prompt({ text: 'remember ALPHA_1' }));
      await s.enterTangent('side');
      assert.equal(hasTranscript(sb, s.claudeSessionId!), false, 'precondition: the tangent fork has no transcript yet');
      await drain(s.compact());
      assert.ok(hasTranscript(sb, s.claudeSessionId!), 'a pending fork has a transcript after a local command');
      const { result } = await drain(s.prompt({ text: 'in tangent' }));
      assert.equal(result.text, 'hist=[remember ALPHA_1 | in tangent]', 'local-command entries are not listed as user messages');
    } finally {
      await closeAll(s);
    }
  });

  for (const local of LOCAL) {
    describe(`${local.name} while it is pending (Claude may write the fresh session's transcript)`, () => {
      it('then /tangent: the tangent gets the history once; main still gets its own copy once', async () => {
        const { sb, s } = await fallenBack();
        try {
          await local.run(s);
          await s.enterTangent('side');
          await drain(s.prompt({ text: 'in tangent' }));
          const t = lineFor(sb, 'in tangent');
          assert.equal(count(t, BLOCK), 1, `the tangent's first line: ${JSON.stringify(t.slice(0, 160))}`);
          assert.match(t, /ALPHA_1[\s\S]*<\/kiro-restored-history>[\s\S]*in tangent/);
          await s.exitTangent('discard');
          await drain(s.prompt({ text: 'back in main' }));
          const m = lineFor(sb, 'back in main');
          assert.equal(count(m, BLOCK), 1, "main's own copy, once");
          assert.doesNotMatch(m, /in tangent/);
          await drain(s.prompt({ text: 'later' }));
          assert.equal(count(lastUserText(sb), BLOCK), 0);
        } finally {
          await closeAll(s);
        }
      });

      it('then quit and reopen: the reopened chat gets the history once', async () => {
        const { sb, s, id } = await fallenBack();
        await local.run(s);
        await s.close();
        assert.match(onDisk(sb, id)?.pendingHistory ?? '', /ALPHA_1/, 'still pending on the saved record');
        const ui = recordingUI();
        const s2 = await open(sb, { resume: { sessionId: id } }, ui);
        try {
          const { result } = await drain(s2.prompt({ text: 'after reopen' }));
          const t = lineFor(sb, 'after reopen');
          assert.equal(count(t, BLOCK), 1, `the reopened chat's first line: ${JSON.stringify(t.slice(0, 160))}; fell back: ${fellBack(ui)}`);
          assert.match(t, /ALPHA_1[\s\S]*after reopen/);
          assert.match(result.text, /ALPHA_1/, 'Claude has the history');
          await drain(s2.prompt({ text: 'later' }));
          assert.equal(count(lastUserText(sb), BLOCK), 0);
        } finally {
          await closeAll(s2);
        }
      });

      it('then a spec-style fork (create({ fork }) from forkSource()): the fork gets the history once', async () => {
        const { sb, s } = await fallenBack();
        let f: KiroSessionImpl | undefined;
        try {
          await local.run(s);
          const src = s.forkSource();
          f = await open(sb, { fork: { fromClaudeSessionId: src.from, ...(src.at ? { at: src.at } : {}), kind: 'main', parentId: s.id } });
          await drain(f.prompt({ text: 'in phase' }));
          const t = lineFor(sb, 'in phase');
          assert.equal(count(t, BLOCK), 1, `the fork's first line: ${JSON.stringify(t.slice(0, 160))}`);
          assert.match(t, /ALPHA_1[\s\S]*in phase/);
          await f.close();
          await drain(s.prompt({ text: 'main again' }));
          assert.equal(count(lineFor(sb, 'main again'), BLOCK), 1, "the parent's own copy, once");
        } finally {
          await closeAll(f, s);
        }
      });
    });
  }

  it('a reopen whose resume falls back again sends it once (the saved block, never a second one from the journal)', async () => {
    const { sb, s, id } = await fallenBack(['remember ALPHA_1', 'second BETA_2']);
    await s.close(); // no line: the fresh Claude session still has no transcript
    const ui = recordingUI();
    const s2 = await open(sb, { resume: { sessionId: id } }, ui);
    try {
      assert.ok(fellBack(ui), 'precondition: the reopen fell back again');
      await drain(s2.prompt({ text: 'after reopen' }));
      const t = lineFor(sb, 'after reopen');
      assert.equal(count(t, BLOCK), 1);
      assert.equal(count(t, 'User: remember ALPHA_1'), 1);
      assert.match(t, /ALPHA_1[\s\S]*BETA_2[\s\S]*after reopen/);
    } finally {
      await closeAll(s2);
    }
  });

  it('/compact while pending, the transcript lost again, reopen: the saved history is sent (not the compaction of nothing), once', async () => {
    const { sb, s, id } = await fallenBack();
    await drain(s.compact());
    await s.close();
    loseTranscripts(sb);
    const ui = recordingUI();
    const s2 = await open(sb, { resume: { sessionId: id } }, ui);
    try {
      assert.ok(fellBack(ui), 'precondition: the reopen fell back');
      await drain(s2.prompt({ text: 'after reopen' }));
      const t = lineFor(sb, 'after reopen');
      assert.equal(count(t, BLOCK), 1);
      assert.match(t, /ALPHA_1[\s\S]*after reopen/);
    } finally {
      await closeAll(s2);
    }
  });

  it('/clear drops it, on the saved record too', async () => {
    const { sb, s, id } = await fallenBack();
    try {
      await s.clear();
      assert.equal(s.record.pendingHistory, undefined);
      assert.equal(onDisk(sb, id)?.pendingHistory, undefined);
      await drain(s.prompt({ text: 'after clear' }));
      const t = lastUserText(sb);
      assert.equal(count(t, BLOCK), 0);
      assert.doesNotMatch(t, /ALPHA_1/);
    } finally {
      await closeAll(s);
    }
  });

  for (const withTranscript of [false, true]) {
    it(`/chat save while pending, /chat load (${withTranscript ? 'the export holds the fresh session\'s transcript' : 'no transcript'}): the loaded chat gets the history once`, async () => {
      const { sb, s } = await fallenBack();
      let imported: KiroSessionImpl | undefined;
      try {
        if (withTranscript) await drain(s.compact()); // Claude writes the fresh session's transcript
        const file = await s.exportTo(path.join(sb.root, 'exp.json'), true);
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeTranscript: string; session: SessionRecord };
        assert.equal(data.claudeTranscript !== '', withTranscript, 'precondition: the transcript in the export');
        assert.match(data.session.pendingHistory ?? '', /ALPHA_1/, 'the export carries the pending history');
        imported = (await importSessionExport(file, baseOptions(sb))) as KiroSessionImpl;
        const { result } = await drain(imported.prompt({ text: 'loaded' }));
        const t = lineFor(sb, 'loaded');
        assert.equal(count(t, BLOCK), 1, JSON.stringify(t.slice(0, 160)));
        assert.match(t, /ALPHA_1[\s\S]*loaded/);
        assert.match(result.text, /ALPHA_1/);
        await drain(imported.prompt({ text: 'later' }));
        assert.equal(count(lastUserText(sb), BLOCK), 0);
      } finally {
        await closeAll(imported, s);
      }
    });
  }

  it('the record keeps a non-empty pending history string (store); anything else is dropped', () => {
    const base = { kind: SESSION_KIND, cwd: '/x', agent: 'a', model: 'auto' };
    assert.equal(fromDiskJson({ ...base, pendingHistory: '<kiro-restored-history>\nX\n</kiro-restored-history>' }, 'id1')?.pendingHistory, '<kiro-restored-history>\nX\n</kiro-restored-history>');
    for (const bad of [42, '  ', ['x'], { a: 1 }, null]) assert.equal(fromDiskJson({ ...base, pendingHistory: bad }, 'id2')?.pendingHistory, undefined, JSON.stringify(bad));
    const sb = mkSandbox();
    const store = new SessionStore(sb.sessionsDir);
    const rec = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'a', model: 'auto', pendingHistory: 'HIST' });
    assert.equal(rec.pendingHistory, 'HIST');
    assert.equal(store.read(rec.sessionId)?.pendingHistory, 'HIST');
  });
});

// ───────────────────────────── #6 ─────────────────────────────

describe('R4 #6: a respawn fallback inside a prompt puts the history into that prompt\'s line', () => {
  it('the child died between turns and its transcript is gone: the next prompt\'s line carries the history, the one after does not', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const ui = recordingUI();
    const s = await open(sb, {}, ui);
    try {
      await drain(s.prompt({ text: 'remember CODEWORD-PELICAN' }));
      await drain(s.prompt({ text: 'second line' }));
      loseTranscripts(sb);
      await killChild(s);
      const { result } = await drain(s.prompt({ text: 'which code word?' }));
      assert.ok(fellBack(ui), 'precondition: the respawn fell back to the journal');
      const t = lineFor(sb, 'which code word?');
      assert.equal(count(t, BLOCK), 1, `got ${JSON.stringify(t.slice(0, 200))}`);
      assert.match(t, /<kiro-restored-history>[\s\S]*CODEWORD-PELICAN[\s\S]*second line[\s\S]*<\/kiro-restored-history>[\s\S]*which code word\?/);
      assert.match(result.text, /CODEWORD-PELICAN/);
      await drain(s.prompt({ text: 'fourth line' }));
      assert.equal(count(lineFor(sb, 'fourth line'), BLOCK), 0, 'not sent again, one line late');
    } finally {
      await closeAll(s);
    }
  });

  it('…then a quit: the earlier turns come back on reopen', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    let s = await open(sb);
    const id = s.id;
    try {
      await drain(s.prompt({ text: 'remember CODEWORD-PELICAN' }));
      loseTranscripts(sb);
      await killChild(s);
      await drain(s.prompt({ text: 'second line' }));
      await s.close();
      s = await open(sb, { resume: { sessionId: id } });
      const { result } = await drain(s.prompt({ text: 'which code word?' }));
      assert.match(result.text, /CODEWORD-PELICAN/, `Claude has the first turn after the reopen: ${JSON.stringify(result.text.slice(0, 300))}`);
      assert.equal(count(result.text, BLOCK), 1, 'the history once');
    } finally {
      await closeAll(s);
    }
  });

  /** An agent whose userPromptSubmit hook, for a prompt containing WAITHOOK, waits for `go`. */
  function waitingHookAgent(sb: Sandbox): { started: string; go: string } {
    const started = path.join(sb.root, 'hook-started');
    const go = path.join(sb.root, 'hook-go');
    sb.agent('waithook', {
      tools: ['*'],
      hooks: { userPromptSubmit: [{ command: `if grep -q WAITHOOK; then touch '${started}'; while [ ! -f '${go}' ]; do sleep 0.02; done; fi; true` }] },
    });
    return { started, go };
  }

  it('the child dies while the line is being composed (its userPromptSubmit hook runs): the line is recomposed with the history, once', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { started, go } = waitingHookAgent(sb);
    const ui = recordingUI();
    const s = await open(sb, { agentName: 'waithook' }, ui);
    try {
      await drain(s.prompt({ text: 'remember CODEWORD-PELICAN' }));
      const p = drain(s.prompt({ text: 'WAITHOOK which code word?' }));
      await waitFor(started, 'the userPromptSubmit hook');
      loseTranscripts(sb);
      await killChild(s);
      fs.writeFileSync(go, '');
      const { result } = await p;
      assert.ok(fellBack(ui), 'precondition: the respawn fell back to the journal');
      const t = lineFor(sb, 'which code word?');
      assert.equal(count(t, BLOCK), 1, `got ${JSON.stringify(t.slice(0, 200))}`);
      assert.match(t, /CODEWORD-PELICAN[\s\S]*<\/kiro-restored-history>[\s\S]*which code word\?/);
      assert.match(result.text, /CODEWORD-PELICAN/);
      assert.equal(s.record.pendingHistory, undefined, 'delivered');
      await drain(s.prompt({ text: 'after' }));
      assert.equal(count(lineFor(sb, 'after'), BLOCK), 0, 'delivered once');
    } finally {
      fs.writeFileSync(go, '');
      await closeAll(s);
    }
  });

  it('the respawn\'s fallback queued the history, the prompt is cancelled before its line, a quit: the reopen sends it once', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const { started, go } = waitingHookAgent(sb);
    const ui = recordingUI();
    let s = await open(sb, { agentName: 'waithook' }, ui);
    const id = s.id;
    try {
      await drain(s.prompt({ text: 'remember CODEWORD-PELICAN' }));
      loseTranscripts(sb);
      await killChild(s);
      const p = drain(s.prompt({ text: 'WAITHOOK never sent' }));
      await waitFor(started, 'the userPromptSubmit hook');
      assert.ok(fellBack(ui), 'the respawn (before the line is composed) fell back');
      await s.interrupt();
      fs.writeFileSync(go, '');
      assert.equal((await p).result.stopReason, 'cancelled');
      assert.equal(lineFor(sb, 'never sent'), '', 'precondition: Claude never got the line');
      await s.close();
      assert.match(onDisk(sb, id)?.pendingHistory ?? '', /CODEWORD-PELICAN/, 'kept on the saved record');
      s = await open(sb, { resume: { sessionId: id }, agentName: 'waithook' });
      await drain(s.prompt({ text: 'which code word?' }));
      const t = lineFor(sb, 'which code word?');
      assert.equal(count(t, BLOCK), 1, `got ${JSON.stringify(t.slice(0, 200))}`);
      assert.match(t, /CODEWORD-PELICAN/);
    } finally {
      fs.writeFileSync(go, '');
      await closeAll(s);
    }
  });

  it('a Stop-hook continuation after the child died: the continuation line carries the history', async () => {
    const sb = mkSandbox({ script: HIST, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const armed = path.join(sb.root, 'stop-armed');
    const once = path.join(sb.root, 'stop-once');
    const started = path.join(sb.root, 'stop-started');
    const go = path.join(sb.root, 'stop-go');
    sb.write(
      '.kiro/hooks/stop.json',
      JSON.stringify({
        version: 'v1',
        hooks: [
          {
            name: 'more',
            trigger: 'Stop',
            action: {
              type: 'command',
              command: `if [ -f '${armed}' ] && [ ! -f '${once}' ]; then touch '${once}' '${started}'; while [ ! -f '${go}' ]; do sleep 0.02; done; echo '{"decision":"block","reason":"CONTINUE which code word?"}'; fi`,
            },
          },
        ],
      }),
    );
    const ui = recordingUI();
    const s = await open(sb, {}, ui);
    try {
      await drain(s.prompt({ text: 'remember CODEWORD-PELICAN' }));
      fs.writeFileSync(armed, '');
      const p = drain(s.prompt({ text: 'second line' }));
      await waitFor(started, 'the Stop hook');
      loseTranscripts(sb);
      await killChild(s);
      fs.writeFileSync(go, '');
      const { result } = await p;
      assert.ok(fellBack(ui), 'precondition: the respawn fell back to the journal');
      const t = lineFor(sb, 'CONTINUE which code word?');
      assert.equal(count(t, BLOCK), 1, `got ${JSON.stringify(t.slice(0, 200))}`);
      assert.match(t, /CODEWORD-PELICAN[\s\S]*second line[\s\S]*<\/kiro-restored-history>[\s\S]*CONTINUE which code word\?/);
      assert.match(result.text, /CODEWORD-PELICAN/);
    } finally {
      fs.writeFileSync(go, '');
      await closeAll(s);
    }
  });

  it('a redirect after the child died in the turn: the redirect line carries the history', async () => {
    const sb = mkSandbox({
      script: {
        turns: [{ match: '^start', steps: [{ tool: { name: 'Bash', input: { command: 'touch f' } } }, { text: 'never' }] }],
        default: { steps: [{ text: 'hist=[{{historyUserTexts}}]' }] },
      },
      env: { FAKE_CLAUDE_PERSIST: '1' },
    });
    const ui = recordingUI();
    const s = await open(sb, {}, ui);
    try {
      await drain(s.prompt({ text: 'remember CODEWORD-PELICAN' }));
      ui.answers.push(async () => {
        // the child dies with the turn; the redirect is the next line of this prompt
        loseTranscripts(sb);
        process.kill(s.process!.pid!, 'SIGKILL');
        return { kind: 'redirect', text: 'which code word?' };
      });
      const { result } = await drain(s.prompt({ text: 'start' }));
      assert.ok(fellBack(ui), 'precondition: the respawn fell back to the journal');
      const t = lineFor(sb, 'which code word?');
      assert.equal(count(t, BLOCK), 1, `got ${JSON.stringify(t.slice(0, 200))}`);
      assert.match(t, /CODEWORD-PELICAN[\s\S]*<\/kiro-restored-history>[\s\S]*which code word\?/);
      assert.match(result.text, /CODEWORD-PELICAN/);
    } finally {
      await closeAll(s);
    }
  });
});
