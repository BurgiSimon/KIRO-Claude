/**
 * r9 #4 (session group): a `/chat load` of an export without a transcript is a fork only when its
 * pending fork's source or its exported Claude session still has a transcript. Otherwise
 * importSessionExport starts a new conversation (mode 'new': a fresh Claude id with no
 * transcript, the exported turns, the saved history as `pendingHistory`, no `pendingFork`). A
 * crash while that Claude Code starts (or a quit before the import's first message) makes
 * `chat --resume` run `--resume <that id>`, which Claude Code refuses (`No conversation found`),
 * and fall back on the saved history with its warning. docs/ARCHITECTURE.md (Rewind) and the
 * SessionRecord.pendingFork doc in src/types.ts counted every transcript-less import as a fork
 * that never falls back like that.
 *
 * DECISION (docs, not code): the docs now say what the code does, checked here against the
 * behaviour: the fallback (history once), and a transcript Claude Code has by then (the first
 * line reached it before the crash, also when the record still shows the history pending; a
 * local command such as a refused `/compact`) is resumed, never replaced. Starting such a reopen
 * new at once (without the failed `--resume` and its warning) was not done: the R4 #1 tests
 * (r4-history.test.ts) assert that warning for the same records on disk (a reopen of a resume
 * that fell back), which cannot be told apart from an import.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { findTranscript } from '../../src/claude/transcript.js';
import { importSessionExport, KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, fakeClaudePath, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = {
  turns: [{ repeat: true, match: 'slow', steps: [{ sleepMs: 60_000 }, { text: 'never' }] }],
  default: { steps: [{ text: 'HIST[{{historyUserTexts}}]' }] },
};
const FALLBACK = /could not find the saved conversation/i;

const sandbox = (): Sandbox => mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: false, ui, binary: fakeBinary(), caps, env: sb.env, ...over });
/** Options for an in-process `/chat load` on the fake (the internal options carry its binary). */
const importOpts = (sb: Sandbox): KiroSessionInternalOptions => ({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env: sb.env });
const loseTranscripts = (sb: Sandbox): void => fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });

function textOf(line: Record<string, unknown> | undefined): string {
  const c = (line?.message as { content?: unknown } | undefined)?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text) : '')).join('');
}
const blocks = (text: string): number => (text.match(/<kiro-restored-history>/g) ?? []).length;
/** The session-selecting flags of each start since `from`: `--resume X [--fork-session]`, `--session-id X`. */
const startModes = (sb: Sandbox, from: number): string[][] =>
  sb
    .starts()
    .slice(from)
    .map((a) => a.filter((x, i) => /^--(resume|fork-session|session-id)$/.test(x) || /^--(resume|session-id)$/.test(a[i - 1] ?? '')));

/** A chat ('alpha', 'beta') whose Claude transcript is gone when it is saved: the export has none. */
async function exportWithoutTranscript(sb: Sandbox): Promise<string> {
  const chat = await open(sb, { interactive: true });
  let id: string;
  let file: string;
  try {
    await drain(chat.prompt({ text: 'alpha' }));
    await drain(chat.prompt({ text: 'beta' }));
    loseTranscripts(sb);
    file = await chat.exportTo(path.join(sb.root, 'saved.json'), true);
    id = chat.id;
  } finally {
    await closeAll(chat);
  }
  loseTranscripts(sb);
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeTranscript: string }).claudeTranscript, '', 'precondition: the export has no transcript');
  new SessionStore(sb.sessionsDir).delete(id); // only the import is left for chat --resume
  return file;
}

const moduleUrl = (rel: string): string => new URL(rel, import.meta.url).href;

type Crash = 'start' | 'turn';
interface CrashOut {
  rec?: SessionRecord;
  claudeId?: string;
}

/**
 * A child node process makes the export, loads it, and dies of SIGKILL: while the import's
 * Claude Code initializes (`start`), or once the import's first line reached Claude Code and is
 * in its transcript (`turn`: that Claude Code is killed with it, so nothing more is written).
 */
function crashImport(sb: Sandbox, crash: Crash): CrashOut {
  const outFile = path.join(sb.root, 'out.json');
  const code = `
    import * as fs from 'node:fs';
    import * as path from 'node:path';
    const { KiroSessionImpl, importSessionExport } = await import(${JSON.stringify(moduleUrl('../../src/session/kiroSession.js'))});
    const { SessionStore } = await import(${JSON.stringify(moduleUrl('../../src/session/store.js'))});
    const { findTranscript } = await import(${JSON.stringify(moduleUrl('../../src/claude/transcript.js'))});
    const { createWorkspaceContext } = await import(${JSON.stringify(moduleUrl('../../src/config/workspace.js'))});
    const { fakeBinary, fakeCaps, recordingUI, drain } = await import(${JSON.stringify(moduleUrl('./helpers.js'))});
    const cfg = JSON.parse(process.env.R9F_CFG);
    const env = { ...process.env };
    const ws = createWorkspaceContext(cfg.cwd, env);
    const caps = await fakeCaps();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const chat = await KiroSessionImpl.create({ ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env });
    await drain(chat.prompt({ text: 'alpha' }));
    await drain(chat.prompt({ text: 'beta' }));
    fs.rmSync(path.join(cfg.claudeConfig, 'projects'), { recursive: true, force: true });
    const file = await chat.exportTo(path.join(cfg.root, 'saved.json'), true);
    const chatId = chat.id;
    await chat.close();
    fs.rmSync(path.join(cfg.claudeConfig, 'projects'), { recursive: true, force: true });
    const store = new SessionStore(cfg.sessionsDir);
    store.delete(chatId);
    const out = {};
    if (cfg.crash === 'start') {
      const slow = { ...env, FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ initialize: 4000 }) };
      void importSessionExport(file, { ws, interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env: slow, origin: 'repl' }).catch(() => {});
      for (let i = 0; i < 500 && !out.rec; i++) {
        await sleep(10);
        out.rec = store.list({ cwd: ws.cwd })[0];
      }
      await sleep(300);
      out.rec = out.rec && store.read(out.rec.sessionId);
    } else {
      const s = await importSessionExport(file, { ws, interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env, origin: 'repl' });
      out.claudeId = s.claudeSessionId;
      void drain(s.prompt({ text: 'slow first' })).catch(() => {});
      for (let i = 0; i < 1000; i++) {
        await sleep(10);
        const t = findTranscript(s.claudeSessionId, { cwd: ws.cwd, env });
        if (t && fs.readFileSync(t, 'utf8').includes('slow first')) break;
      }
      out.rec = store.read(s.id);
      fs.writeFileSync(cfg.outFile, JSON.stringify(out));
      process.kill(s.process.pid, 'SIGKILL'); // its Claude Code (a child of this process) dies with it
    }
    fs.writeFileSync(cfg.outFile, JSON.stringify(out));
    process.kill(process.pid, 'SIGKILL');
  `;
  // the SIGKILLed child cannot remove its own temp dirs: keep them inside the sandbox
  const childTmp = path.join(sb.root, 'tmp');
  fs.mkdirSync(childTmp, { recursive: true });
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: {
      ...sb.env,
      TMPDIR: childTmp,
      KIRO_CLAUDE_FAKE: fakeClaudePath(),
      R9F_CFG: JSON.stringify({ cwd: sb.cwd, root: sb.root, claudeConfig: sb.claudeConfig, sessionsDir: sb.sessionsDir, outFile, crash }),
    },
    encoding: 'utf8',
    timeout: 90_000,
  });
  assert.equal(r.signal, 'SIGKILL', `the child did not crash as planned: status ${r.status}, stderr ${r.stderr}`);
  return JSON.parse(fs.readFileSync(outFile, 'utf8')) as CrashOut;
}

describe('r9 #4: a /chat load of an export without a transcript, in mode new', () => {
  it('a crash while its Claude Code starts: chat --resume falls back on the saved history (with the warning), once, no fork', async () => {
    const sb = sandbox();
    const out = crashImport(sb, 'start');
    assert.ok(out.rec, 'precondition: the import record was on disk while its Claude Code started');
    assert.equal(out.rec.turns.length, 2);
    assert.equal(out.rec.pendingFork, undefined, 'precondition: not a fork (nothing to fork from)');
    assert.ok(out.rec.pendingHistory, 'precondition: the saved history waits for the first line');
    assert.equal(findTranscript(out.rec.claudeSessionId, { cwd: sb.cwd, env: sb.env }), undefined);
    const from = sb.starts().length;
    const ui = recordingUI();
    const s = await open(sb, { resume: { latest: true } }, ui);
    try {
      assert.equal(s.id, out.rec.sessionId);
      const { result } = await drain(s.prompt({ text: 'gamma' }));
      assert.equal(ui.notices.filter((n) => FALLBACK.test(n.message)).length, 1, JSON.stringify(ui.notices));
      assert.deepEqual(
        startModes(sb, from),
        [
          ['--resume', out.rec.claudeSessionId],
          ['--session-id', out.rec.claudeSessionId],
        ],
        'the resume of the fresh id Claude Code never had, then the new conversation (no fork)',
      );
      const line = textOf(sb.userLines().at(-1));
      assert.equal(blocks(line), 1, 'the saved history once');
      assert.match(line, /alpha[\s\S]*beta[\s\S]*gamma/);
      assert.match(result.text, /^HIST\[/);
      assert.equal(new SessionStore(sb.sessionsDir).read(s.id)?.pendingHistory, undefined, 'delivered');
    } finally {
      await closeAll(s);
    }
  });

  it('a crash after its first line reached Claude Code: chat --resume resumes that transcript, never replaces it', async () => {
    const sb = sandbox();
    const out = crashImport(sb, 'turn');
    assert.ok(out.rec && out.claudeId, 'precondition: the import ran its first line');
    const transcript = findTranscript(out.claudeId, { cwd: sb.cwd, env: sb.env });
    assert.ok(transcript, 'precondition: Claude Code wrote the line into the transcript');
    const written = fs.readFileSync(transcript, 'utf8');
    assert.match(written, /slow first/);
    const from = sb.starts().length;
    const ui = recordingUI();
    const s = await open(sb, { resume: { latest: true } }, ui);
    try {
      assert.equal(s.id, out.rec.sessionId);
      const { result } = await drain(s.prompt({ text: 'gamma' }));
      assert.ok(!ui.notices.some((n) => FALLBACK.test(n.message)), JSON.stringify(ui.notices));
      assert.deepEqual(startModes(sb, from), [['--resume', out.claudeId]]);
      assert.match(result.text, /slow first[\s\S]*gamma\]$/, 'the resumed conversation holds the first line');
      assert.equal(blocks(textOf(sb.userLines().at(-1))), 0, 'the history went with the first line');
      assert.ok(fs.readFileSync(transcript, 'utf8').startsWith(written), 'the transcript was kept and continued');
    } finally {
      await closeAll(s);
    }
  });

  it('a crash between that line and the record\'s save (the history still pending): the transcript is resumed, not replaced', async () => {
    const sb = sandbox();
    const out = crashImport(sb, 'turn');
    assert.ok(out.rec && out.claudeId, 'precondition: the import ran its first line');
    const store = new SessionStore(sb.sessionsDir);
    const rec = store.read(out.rec.sessionId)!;
    assert.equal(rec.pendingHistory, undefined, 'precondition: the record was saved once the line was written');
    // as if kiro-claude died between the line's write and that save
    rec.pendingHistory = '<kiro-restored-history>\nUser: alpha\n</kiro-restored-history>';
    store.write(rec);
    const transcript = findTranscript(out.claudeId, { cwd: sb.cwd, env: sb.env })!;
    const written = fs.readFileSync(transcript, 'utf8');
    const from = sb.starts().length;
    const ui = recordingUI();
    const s = await open(sb, { resume: { latest: true } }, ui);
    try {
      const { result } = await drain(s.prompt({ text: 'gamma' }));
      assert.ok(!ui.notices.some((n) => FALLBACK.test(n.message)), JSON.stringify(ui.notices));
      assert.deepEqual(startModes(sb, from), [['--resume', out.claudeId]], 'the transcript that exists is resumed');
      assert.match(result.text, /slow first/, 'the resumed conversation holds the first line');
      assert.ok(fs.readFileSync(transcript, 'utf8').startsWith(written), 'the transcript was kept and continued');
    } finally {
      await closeAll(s);
    }
  });

  it('a quit before its first message: chat --resume falls back on the saved history the same way', async () => {
    const sb = sandbox();
    const file = await exportWithoutTranscript(sb);
    const imported = await importSessionExport(file, importOpts(sb));
    const id = imported.id;
    const claudeId = imported.claudeSessionId!;
    await closeAll(imported);
    const rec = new SessionStore(sb.sessionsDir).read(id);
    assert.ok(rec?.pendingHistory && !rec.pendingFork, 'precondition: an import in mode new, kept with its history pending');
    const from = sb.starts().length;
    const ui = recordingUI();
    const s = await open(sb, { resume: { latest: true } }, ui);
    try {
      assert.equal(s.id, id);
      await drain(s.prompt({ text: 'gamma' }));
      assert.equal(ui.notices.filter((n) => FALLBACK.test(n.message)).length, 1, JSON.stringify(ui.notices));
      assert.deepEqual(startModes(sb, from), [
        ['--resume', claudeId],
        ['--session-id', claudeId],
      ]);
      const line = textOf(sb.userLines().at(-1));
      assert.equal(blocks(line), 1);
      assert.match(line, /alpha[\s\S]*beta[\s\S]*gamma/);
    } finally {
      await closeAll(s);
    }
  });

  it('a local command Claude Code wrote into the fresh session (a refused /compact): the reopen resumes it, the history still goes with the first line', async () => {
    const sb = sandbox();
    const file = await exportWithoutTranscript(sb);
    const imported = await importSessionExport(file, importOpts(sb));
    const id = imported.id;
    const claudeId = imported.claudeSessionId!;
    try {
      const { result } = await drain(imported.compact());
      assert.equal(result.isError, true, 'precondition: nothing to compact yet');
    } finally {
      await closeAll(imported);
    }
    assert.ok(findTranscript(claudeId, { cwd: sb.cwd, env: sb.env }), 'precondition: Claude Code wrote the fresh session for the local command');
    assert.ok(new SessionStore(sb.sessionsDir).read(id)?.pendingHistory, 'precondition: the history still waits');
    const from = sb.starts().length;
    const ui = recordingUI();
    const s = await open(sb, { resume: { latest: true } }, ui);
    try {
      await drain(s.prompt({ text: 'gamma' }));
      assert.ok(!ui.notices.some((n) => FALLBACK.test(n.message)), JSON.stringify(ui.notices));
      assert.deepEqual(startModes(sb, from), [['--resume', claudeId]]);
      const line = textOf(sb.userLines().at(-1));
      assert.equal(blocks(line), 1);
      assert.match(line, /alpha[\s\S]*beta[\s\S]*gamma/);
    } finally {
      await closeAll(s);
    }
  });
});

// ── the docs say what the code above does (read from the repository root; tests run from there) ──

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'session', 'kiroSession.ts')) && fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}
const source = (rel: string): string => fs.readFileSync(path.join(repoRoot(), rel), 'utf8');
const oneLine = (text: string): string => text.replace(/\s+/g, ' ');

describe('r9 #4: docs/ARCHITECTURE.md and SessionRecord.pendingFork on a /chat load of an export without a transcript', () => {
  it('the Rewind bullet counts such an import as a fork only while a Claude session it could fork has a transcript, and says the other one falls back', () => {
    const doc = source('docs/ARCHITECTURE.md');
    const at = doc.indexOf('* **Rewind.**');
    assert.ok(at > 0, 'the Rewind bullet');
    const bullet = oneLine(doc.slice(at, doc.indexOf('\n* **', at + 1)));
    assert.doesNotMatch(bullet, /a `\/chat load` of an export without a transcript\. A crash/, 'every transcript-less import listed as a fork');
    assert.match(bullet, /a `\/chat load` of an export without a transcript whose Claude session \(or the source of its pending fork\) still has one\./);
    assert.match(bullet, /whose Claude sessions are gone too is no fork: it starts a new conversation with the export's saved history/);
    assert.match(bullet, /makes `chat --resume` try that new conversation, which Claude Code does not have yet, and fall back on the saved history with the warning above/);
    assert.match(bullet, /is resumed, never replaced/);
  });

  it('the SessionRecord.pendingFork doc in src/types.ts names only the fork-mode import', () => {
    const src = source('src/types.ts');
    const at = src.indexOf('pendingFork?: { from: string; at?: string };');
    assert.ok(at > 0);
    const open = src.lastIndexOf('/**', at);
    const docText = oneLine(src.slice(open, at).replace(/\n\s*\*\s?/g, ' '));
    assert.doesNotMatch(docText, /a `\/chat load` import without a transcript\)/);
    assert.match(docText, /a `\/chat load` import without a transcript whose Claude session or pending fork's source still has one; an import whose Claude sessions are all gone starts a new conversation with `pendingHistory` instead, no fork/);
  });
});
