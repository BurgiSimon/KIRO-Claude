/**
 * Guards for the third review's findings fixed in session/:
 *  - G1: a fork of a record (the spec driver forks main for every phase session and for the
 *    continuation it hands back to the REPL) carries the record's queued `/tangent merge|tail`
 *    carry, like a tangent does since F9, and delivers it exactly once to the conversation the
 *    user continues in.
 *  - G2: the `<kiro-restored-history>` block queued after a fallback to a fresh Claude session
 *    belongs to the record (conversation) it restores: `/clear` drops it, `/rewind` and `/tangent`
 *    neither resurrect rewound turns nor send the history twice, a respawn before the first line
 *    does not queue a second copy.
 *  - G5: a carry consumed by a prompt whose session is closed before Claude received the line
 *    (the REPL's forced stop) is still on the saved record.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { importSessionExport, KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import { SpecSessionDriver, type SessionPort } from '../../src/spec/workflow.js';
import type { KiroSession } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env };
}

async function open(sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> {
  return KiroSessionImpl.create({ ...baseOptions(sb, ui), ...over });
}

/** A fork of `parent`'s conversation, the way SpecSessionDriver.fork asks for one. */
async function forkOf(sb: Sandbox, parent: KiroSession, over: Partial<KiroSessionInternalOptions> = {}): Promise<KiroSessionImpl> {
  return open(sb, { origin: 'spec', ...over, fork: { fromClaudeSessionId: parent.claudeSessionId!, kind: 'main', parentId: parent.id } });
}

function contentText(line: Record<string, unknown>): string {
  const c = (line.message as { content: unknown }).content;
  if (typeof c === 'string') return c;
  return (c as { type: string; text?: string }[]).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');
}

const userTexts = (sb: Sandbox): string[] => sb.userLines().map(contentText);
const lastUserText = (sb: Sandbox): string => userTexts(sb).at(-1) ?? '';
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

const TANGENT_SCRIPT = {
  turns: [{ repeat: true, match: '^Summarize the findings', steps: [{ text: 'SUMMARY: the tangent found FOUND_X' }] }],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};

/** main `m1`, `/tangent research`, `finding FOUND_X`, `/tangent <mode>`: main holds the carry. */
async function mainWithCarry(sb: Sandbox, mode: 'merge' | 'tail'): Promise<KiroSessionImpl> {
  const s = await open(sb);
  await drain(s.prompt({ text: 'm1' }));
  await s.enterTangent('research');
  await drain(s.prompt({ text: 'finding FOUND_X' }));
  await s.exitTangent(mode);
  return s;
}

// ───────────────────────────── G1 ─────────────────────────────

describe('G1: a fork of a record carries its queued tangent carry, delivered once', () => {
  for (const mode of ['merge', 'tail'] as const) {
    const tag = mode === 'merge' ? 'tangent-summary' : 'tangent-tail';

    it(`/tangent ${mode}, then a fork of main: the fork's first line carries it; a fork of that fork does not get it again`, async () => {
      const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
      const s = await mainWithCarry(sb, mode);
      let a: KiroSessionImpl | undefined;
      let b: KiroSessionImpl | undefined;
      try {
        const mainId = s.id;
        a = await forkOf(sb, s);
        assert.match(a.record.pendingContext?.join('\n') ?? '', new RegExp(`<${tag} name="research">`), 'the fork holds its own copy');
        await drain(a.prompt({ text: 'phase one' }));
        const first = lastUserText(sb);
        assert.match(first, new RegExp(`<${tag} name="research">[\\s\\S]*FOUND_X[\\s\\S]*phase one`));
        assert.equal(count(first, `<${tag}`), 1);
        assert.equal(new SessionStore(sb.sessionsDir).read(a.id)?.pendingContext, undefined, 'delivered: gone from the fork record on disk');
        await drain(a.prompt({ text: 'phase one again' }));
        assert.doesNotMatch(lastUserText(sb), new RegExp(tag), 'delivered once in the fork');
        // the continuation (a fork of the fork) has it in its Claude history, not as a second copy
        b = await forkOf(sb, a);
        assert.equal(b.record.pendingContext, undefined);
        const { result } = await drain(b.prompt({ text: 'continued' }));
        assert.doesNotMatch(lastUserText(sb), new RegExp(tag), 'not sent again to the continuation');
        assert.match(result.text, new RegExp(`${tag}[\\s\\S]*phase one`), 'part of the continued conversation');
        // main keeps its own copy for its own conversation (delivered once there, like F9)
        assert.match(new SessionStore(sb.sessionsDir).read(mainId)?.pendingContext?.join('\n') ?? '', new RegExp(tag));
        await drain(s.prompt({ text: 'back in main' }));
        assert.equal(count(lastUserText(sb), `<${tag}`), 1);
      } finally {
        await closeAll(b, a, s);
      }
    });
  }

  it('the REPL spec flow (SpecSessionDriver over real sessions): merge, a phase turn, finish(keep), a prompt: the summary reaches Claude once and stays in the continued conversation', async () => {
    const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const main = await mainWithCarry(sb, 'merge');
    let active: KiroSession = main;
    const all: KiroSession[] = [main];
    const port: SessionPort = {
      active: () => active,
      async create(o) {
        const s = await KiroSessionImpl.create({ ...baseOptions(sb), origin: 'spec', ...o } as KiroSessionInternalOptions);
        all.push(s);
        return s;
      },
      activate(s) {
        active = s;
      },
      async run(s, input) {
        return (await drain(s.prompt(input))).result;
      },
    };
    try {
      const before = sb.userLines().length;
      const driver = new SpecSessionDriver(port);
      await driver.runTurn({ text: 'draft the requirements' }, { name: 'requirements', allowedWritePaths: ['.kiro/specs/x/requirements.md'] });
      await driver.finish('keep');
      assert.notEqual(active, main, 'the REPL continues in the continuation fork');
      const { result } = await drain(active.prompt({ text: 'what did the tangent find?' }));
      const after = userTexts(sb).slice(before);
      assert.equal(after.filter((t) => t.includes('<tangent-summary')).length, 1, `exactly one line carries the summary: ${JSON.stringify(after.map((t) => t.slice(0, 80)))}`);
      assert.match(after[0]!, /<tangent-summary name="research">[\s\S]*FOUND_X[\s\S]*draft the requirements/, 'the first spec phase line');
      assert.match(result.text, /tangent-summary[\s\S]*what did the tangent find\?/, 'the continued conversation contains it');
    } finally {
      await closeAll(...all.reverse());
    }
  });
});

// ───────────────────────────── G2 ─────────────────────────────

const BLOCK = '<kiro-restored-history>';

/** A saved session with `prompts`, its Claude transcripts deleted, resumed: the fallback queued the history. */
async function resumedWithoutTranscript(prompts: string[], script?: object): Promise<{ sb: Sandbox; s: KiroSessionImpl }> {
  const sb = mkSandbox({ ...(script ? { script } : {}), env: { FAKE_CLAUDE_PERSIST: '1' } });
  const first = await open(sb);
  let id: string;
  try {
    for (const p of prompts) await drain(first.prompt({ text: p }));
    id = first.id;
  } finally {
    await closeAll(first);
  }
  fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });
  const ui = recordingUI();
  const s = await open(sb, { resume: { sessionId: id } }, ui);
  assert.ok(ui.notices.some((n) => /could not find the saved conversation/i.test(n.message)), 'the resume fell back to a fresh Claude session');
  return { sb, s };
}

describe('G2: the restored history belongs to the conversation it restores', () => {
  it('control: the next line carries it once, the one after does not', async () => {
    const { sb, s } = await resumedWithoutTranscript(['first ALPHA_1', 'second BETA_2']);
    try {
      await drain(s.prompt({ text: 'next' }));
      const t = lastUserText(sb);
      assert.equal(count(t, BLOCK), 1);
      assert.match(t, /ALPHA_1[\s\S]*BETA_2[\s\S]*<\/kiro-restored-history>[\s\S]*next/);
      await drain(s.prompt({ text: 'after' }));
      assert.equal(count(lastUserText(sb), BLOCK), 0);
    } finally {
      await closeAll(s);
    }
  });

  it('/clear drops it', async () => {
    const { sb, s } = await resumedWithoutTranscript(['first ALPHA_1']);
    try {
      await s.clear();
      await drain(s.prompt({ text: 'after clear' }));
      const t = lastUserText(sb);
      assert.equal(count(t, BLOCK), 0, `the cleared conversation was sent again: ${JSON.stringify(t.slice(0, 160))}`);
      assert.doesNotMatch(t, /ALPHA_1/);
    } finally {
      await closeAll(s);
    }
  });

  it('/chat load without a usable transcript, then /clear: the loaded history is dropped', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_PERSIST: '1' } });
    const first = await open(sb);
    let file: string;
    try {
      await drain(first.prompt({ text: 'first ALPHA_1' }));
      file = await first.exportTo(path.join(sb.root, 'exp.json'), false);
    } finally {
      await closeAll(first);
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeTranscript?: string; session: { claudeSessionId: string } };
    data.claudeTranscript = '';
    data.session.claudeSessionId = 'gone';
    fs.writeFileSync(file, JSON.stringify(data));
    const s = await importSessionExport(file, baseOptions(sb));
    try {
      await s.clear();
      await drain(s.prompt({ text: 'after clear' }));
      assert.equal(count(lastUserText(sb), BLOCK), 0);
    } finally {
      await closeAll(s);
    }
  });

  it('/rewind 1: the rewound-away turn is not sent again, the kept history once', async () => {
    const { sb, s } = await resumedWithoutTranscript(['first ALPHA_1', 'second BETA_2']);
    try {
      await s.rewind(1);
      await drain(s.prompt({ text: 'after rewind' }));
      const t = lastUserText(sb);
      assert.match(t, /ALPHA_1/, 'turn 1 is kept');
      assert.doesNotMatch(t, /BETA_2/, `turn 2 was rewound away but is sent again (${count(t, BLOCK)} blocks)`);
      assert.equal(count(t, BLOCK), 1);
    } finally {
      await closeAll(s);
    }
  });

  it('/tangent: the tangent gets the history once; main still gets its own once after the return', async () => {
    const { sb, s } = await resumedWithoutTranscript(['first ALPHA_1']);
    try {
      const mainId = s.id;
      await s.enterTangent('side');
      await drain(s.prompt({ text: 'in tangent' }));
      const t = lastUserText(sb);
      assert.equal(count(t, BLOCK), 1, 'tangent: the history once');
      assert.equal(count(t, 'ALPHA_1'), 1);
      await s.exitTangent('discard');
      assert.equal(s.id, mainId);
      await drain(s.prompt({ text: 'back in main' }));
      const m = lastUserText(sb);
      assert.equal(count(m, BLOCK), 1, 'main never got its history yet');
      assert.doesNotMatch(m, /in tangent/, "the discarded tangent's turn is not main's history");
      await drain(s.prompt({ text: 'later' }));
      assert.equal(count(lastUserText(sb), BLOCK), 0);
    } finally {
      await closeAll(s);
    }
  });

  it('a /tangent whose fork cannot start leaves main with its history, queued once', async () => {
    const { sb, s } = await resumedWithoutTranscript(['first ALPHA_1']);
    try {
      sb.env.FAKE_CLAUDE_EXIT_ON_START = '1';
      await assert.rejects(s.enterTangent('side'));
      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      await drain(s.prompt({ text: 'still main' }));
      assert.equal(count(lastUserText(sb), BLOCK), 1);
      await drain(s.prompt({ text: 'later' }));
      assert.equal(count(lastUserText(sb), BLOCK), 0, 'the respawn of main did not queue a second copy');
    } finally {
      delete sb.env.FAKE_CLAUDE_EXIT_ON_START;
      await closeAll(s);
    }
  });

  it('a respawn before the first line (crashed child) does not queue a second copy', async () => {
    const { sb, s } = await resumedWithoutTranscript(['first ALPHA_1']);
    try {
      const proc = s.process!;
      process.kill(proc.pid!, 'SIGKILL');
      await waitFor(() => !proc.running);
      await drain(s.prompt({ text: 'after crash' }));
      assert.equal(count(lastUserText(sb), BLOCK), 1);
      await drain(s.prompt({ text: 'later' }));
      assert.equal(count(lastUserText(sb), BLOCK), 0, 'delivered once');
    } finally {
      await closeAll(s);
    }
  });
});

// ───────────────────────────── G5 ─────────────────────────────

describe('G5: a carry survives a session closed before Claude received the line that consumed it', () => {
  it('main child dies, the next prompt respawns it, close() hits the respawn: the saved record keeps the carry, the resumed main gets it once', async () => {
    const sb = mkSandbox({ script: TANGENT_SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await mainWithCarry(sb, 'merge');
    const mainId = s.id;
    let r: KiroSessionImpl | undefined;
    try {
      assert.match(new SessionStore(sb.sessionsDir).read(mainId)?.pendingContext?.join('\n') ?? '', /tangent-summary/, 'precondition');
      // the child dies between turns; its respawn takes a while (the real claude: seconds)
      const proc = s.process!;
      sb.env.FAKE_CLAUDE_CONTROL_DELAYS = JSON.stringify({ initialize: 1500 });
      process.kill(proc.pid!, 'SIGKILL');
      await waitFor(() => !proc.running);
      const starts = sb.starts().length;
      const p = drain(s.prompt({ text: 'second main question' })).then(
        () => undefined,
        (e: unknown) => e,
      );
      await waitFor(() => sb.starts().length > starts);
      await s.close(); // the REPL's forced stop (second Ctrl+C)
      await p;
      delete sb.env.FAKE_CLAUDE_CONTROL_DELAYS;
      assert.ok(!userTexts(sb).some((t) => t.includes('second main question')), 'Claude never got the line');
      assert.match(new SessionStore(sb.sessionsDir).read(mainId)?.pendingContext?.join('\n') ?? '', /tangent-summary/, 'still on the saved record');
      r = await open(sb, { resume: { sessionId: mainId } });
      await drain(r.prompt({ text: 'what did the tangent find?' }));
      const sent = lastUserText(sb);
      assert.match(sent, /<tangent-summary name="research">[\s\S]*FOUND_X[\s\S]*what did the tangent find\?/);
      assert.equal(count(sent, '<tangent-summary'), 1);
      await drain(r.prompt({ text: 'again' }));
      assert.doesNotMatch(lastUserText(sb), /tangent-summary/, 'delivered once');
    } finally {
      delete sb.env.FAKE_CLAUDE_CONTROL_DELAYS;
      await closeAll(r, s);
    }
  });
});
