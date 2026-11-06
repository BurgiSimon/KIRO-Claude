/**
 * Hardening tests for session/: `--resume` (latest) never takes over ACP / KiroCrew sessions,
 * journal growth caps (tool output, images) with replay of capped records, kiroClaude.* settings
 * read through the SettingsStore only, and no leaked lock / record / runtime dir / child on any
 * failure path of createSession.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildReplay } from '../../src/acp/replay.js';
import { isAuthError } from '../../src/claude/auth.js';
import { openSettings } from '../../src/config/settings.js';
import {
  JOURNAL_IMAGE_MAX_BYTES_PER_RECORD,
  JOURNAL_TOOL_RESULT_MAX_BYTES,
  capToolResultText,
  journalHistoryText,
  promptRecord,
  readJournal,
  replayItems,
  toolResultsRecord,
  writeJournalRecords,
  type JournalBlock,
} from '../../src/session/kiroFiles.js';
import { importSessionExport, KiroSessionImpl, NO_SAVED_SESSIONS, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { isLatestResumeCandidate, LATEST_RESUME_SKIPPED_ORIGINS, pidAlive, SessionStore } from '../../src/session/store.js';
import type { SessionRecord, SettingsStore } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, fakeClaudePath, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

async function open(sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<{ s: KiroSessionImpl; ui: RecordingUI }> {
  const s = await KiroSessionImpl.create({
    ws: sb.ws,
    origin: 'repl',
    interactive: true,
    ui,
    binary: fakeBinary(),
    caps: await fakeCaps(),
    env: sb.env,
    ...over,
  });
  return { s, ui };
}

const U = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function turn(preview: string): SessionRecord['turns'][number] {
  return { userUuid: U(9), preview, at: '2026-01-01T00:00:00.000Z' };
}

/** Every `session-*` runtime dir under the sandbox runtime base. */
function runtimeSessionDirs(sb: Sandbox): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    let names: string[];
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith('session-')) out.push(path.join(d, n));
      else if (depth < 2) walk(path.join(d, n), depth + 1);
    }
  };
  walk(path.join(sb.root, 'run'), 0);
  return out;
}

/** pids of every fake-claude main process that is still running. */
function liveChildren(sb: Sandbox): number[] {
  return sb
    .log()
    .filter((e) => e.event === 'start' && Array.isArray(e.argv) && (e.argv as string[]).includes('-p'))
    .map((e) => e.pid as number)
    .filter((pid) => pidAlive(pid));
}

function sessionFiles(sb: Sandbox): string[] {
  return fs.existsSync(sb.sessionsDir) ? fs.readdirSync(sb.sessionsDir).sort() : [];
}

function assertNoLeaks(sb: Sandbox, opts: { keep?: string[] } = {}): void {
  assert.deepEqual(sessionFiles(sb), [...(opts.keep ?? [])].sort(), 'no lock / record / journal left behind');
  assert.deepEqual(runtimeSessionDirs(sb), [], 'runtime dir removed');
  assert.deepEqual(liveChildren(sb), [], 'no orphan claude child');
}

// ───────────────────────────── 1. resume latest vs ACP sessions ─────────────────────────────

describe('hardening: --resume (latest) never takes over ACP / KiroCrew sessions', () => {
  it('store: latestResumable skips origin acp (and tangents); latest/list keep every origin', () => {
    const sb = mkSandbox();
    const store = new SessionStore(sb.sessionsDir);
    const repl = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'a', model: 'auto', updatedAt: '2026-01-01T00:00:00.000Z' });
    const headless = store.create({ origin: 'headless', cwd: sb.cwd, agent: 'a', model: 'auto', updatedAt: '2026-02-01T00:00:00.000Z' });
    const acp = store.create({ origin: 'acp', cwd: sb.cwd, agent: 'a', model: 'auto', updatedAt: '2026-06-01T00:00:00.000Z' });
    assert.deepEqual([...LATEST_RESUME_SKIPPED_ORIGINS], ['acp']);
    assert.equal(isLatestResumeCandidate(acp), false);
    assert.equal(isLatestResumeCandidate(repl), true);
    assert.equal(store.latestResumable(sb.cwd)?.sessionId, headless.sessionId);
    assert.equal(store.latest(sb.cwd)?.sessionId, acp.sessionId, 'latest() is unchanged (any origin)');
    assert.deepEqual(store.list({ cwd: sb.cwd }).map((r) => r.sessionId), [acp.sessionId, headless.sessionId, repl.sessionId], 'listing keeps everything');
    const spec = store.create({ origin: 'spec', cwd: sb.cwd, agent: 'a', model: 'auto', updatedAt: '2026-07-01T00:00:00.000Z' });
    assert.equal(store.latestResumable(sb.cwd)?.sessionId, spec.sessionId);
    store.create({ origin: 'repl', cwd: sb.cwd, agent: 'a', model: 'auto', updatedAt: '2026-08-01T00:00:00.000Z', forkKind: 'tangent', parentId: spec.sessionId });
    assert.equal(store.latestResumable(sb.cwd)?.sessionId, spec.sessionId, 'tangents are still skipped');
    assert.equal(store.latestResumable(path.join(sb.root, 'elsewhere')), undefined);
  });

  it('createSession resume latest picks the newest chat session, not a newer KiroCrew one; the ACP record is untouched', async () => {
    const sb = mkSandbox();
    const store = new SessionStore(sb.sessionsDir);
    const mine = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'kiro_default', model: 'auto', updatedAt: '2026-01-01T00:00:00.000Z', title: 'mine', turns: [turn('mine')], messageCount: 1 });
    const crew = store.create({ origin: 'acp', cwd: sb.cwd, agent: 'kiro_default', model: 'auto', updatedAt: '2026-06-01T00:00:00.000Z', title: 'crew', turns: [turn('crew')], messageCount: 1 });
    // a real kiro-cli session file (no kind): ignored as before, never touched
    const foreign = path.join(sb.sessionsDir, `${U(7)}.json`);
    fs.writeFileSync(foreign, JSON.stringify({ session_id: U(7), cwd: sb.cwd, updated_at: '2026-12-01T00:00:00.000Z' }));
    const crewBefore = fs.readFileSync(store.pathFor(crew.sessionId), 'utf8');
    const foreignBefore = fs.readFileSync(foreign, 'utf8');
    const { s } = await open(sb, { resume: { latest: true } });
    try {
      assert.equal(s.id, mine.sessionId);
      assert.equal(flagValue(sb.starts()[0]!, '--resume'), mine.claudeSessionId);
      assert.equal(store.lockInfo(crew.sessionId), undefined, 'the KiroCrew session is not locked by us');
    } finally {
      await closeAll(s);
    }
    assert.equal(fs.readFileSync(store.pathFor(crew.sessionId), 'utf8'), crewBefore, 'the ACP record is byte-identical');
    assert.equal(fs.readFileSync(foreign, 'utf8'), foreignBefore);
    // an explicit id still opens the ACP session
    const { s: byId } = await open(sb, { resume: { sessionId: crew.sessionId } });
    try {
      assert.equal(byId.id, crew.sessionId);
      assert.equal(byId.record.origin, 'acp', 'origin is kept');
    } finally {
      await closeAll(byId);
    }
  });

  it('only ACP sessions in the directory ⇒ resume latest starts a new session with the Kiro notice', async () => {
    const sb = mkSandbox();
    const store = new SessionStore(sb.sessionsDir);
    const crew = store.create({ origin: 'acp', cwd: sb.cwd, agent: 'kiro_default', model: 'auto', turns: [turn('crew')], messageCount: 1 });
    const before = fs.readFileSync(store.pathFor(crew.sessionId), 'utf8');
    const { s, ui } = await open(sb, { resume: { latest: true } });
    try {
      assert.notEqual(s.id, crew.sessionId);
      assert.ok(ui.notices.some((n) => n.message === NO_SAVED_SESSIONS));
      assert.equal(flagValue(sb.starts()[0]!, '--resume'), undefined);
    } finally {
      await closeAll(s);
    }
    assert.equal(fs.readFileSync(store.pathFor(crew.sessionId), 'utf8'), before);
  });
});

// ───────────────────────────── 2. journal growth ─────────────────────────────

describe('hardening: journal growth caps', () => {
  it('tool-result text over the cap is cut on a UTF-8 boundary with a clear marker; short text is verbatim', () => {
    assert.equal(JOURNAL_TOOL_RESULT_MAX_BYTES, 256 * 1024);
    assert.equal(capToolResultText('short'), 'short');
    const exact = 'a'.repeat(JOURNAL_TOOL_RESULT_MAX_BYTES);
    assert.equal(capToolResultText(exact), exact);
    const big = '€'.repeat(100_000); // 300 000 bytes
    const capped = capToolResultText(big);
    assert.match(capped, /\[kiro-claude: tool output truncated in the session journal: \d+ of 300000 bytes omitted\]$/);
    const body = capped.slice(0, capped.indexOf('\n… [kiro-claude:'));
    assert.ok(Buffer.byteLength(body, 'utf8') <= JOURNAL_TOOL_RESULT_MAX_BYTES);
    assert.ok(/^€+$/.test(body), 'no broken multi-byte character');
    assert.ok(Buffer.byteLength(capped, 'utf8') < JOURNAL_TOOL_RESULT_MAX_BYTES + 200);
    const rec = toolResultsRecord([
      { toolUseId: 'toolu_big', text: big, isError: false },
      { toolUseId: 'toolu_small', text: 'tiny', isError: true },
    ]);
    const items = rec.data.content as Extract<JournalBlock, { kind: 'toolResult' }>[];
    assert.equal((items[0]!.data.content[0] as { data: string }).data, capped);
    assert.equal((items[1]!.data.content[0] as { data: string }).data, 'tiny');
    assert.equal(items[1]!.data.status, 'error');
  });

  it('images: at most 5 MiB per record; the rest become text placeholders (order kept)', () => {
    assert.equal(JOURNAL_IMAGE_MAX_BYTES_PER_RECORD, 5 * 1024 * 1024);
    const b64 = (n: number, fill = 7): string => Buffer.alloc(n, fill).toString('base64');
    const small = b64(10);
    const r1 = promptRecord('look', { images: [{ mediaType: 'image/png', dataBase64: small }] });
    assert.deepEqual(r1.data.content![1], { kind: 'image', data: { format: 'png', source: { kind: 'bytes', data: Array(10).fill(7) } } });
    // the budget is per record (small budget here so the test does not expand megabytes)
    const r2 = promptRecord('two', {
      maxImageBytes: 100,
      images: [
        { mediaType: 'image/png', dataBase64: b64(60) },
        { mediaType: 'image/jpeg', dataBase64: b64(60) },
        { mediaType: 'image/gif', dataBase64: small },
      ],
    });
    const c = r2.data.content!;
    assert.deepEqual(c.map((b) => b.kind), ['text', 'image', 'text', 'image'], 'a later image that still fits is kept');
    assert.deepEqual(c[2], { kind: 'text', data: '[image not stored in the session journal: jpeg, 60 bytes; images over 100 bytes per message are not kept]' });
    assert.equal(promptRecord('', { maxImageBytes: 100, images: [{ mediaType: 'image/png', dataBase64: b64(100) }] }).data.content![1]!.kind, 'image', 'exactly at the limit is kept');
    // the real default: one image just over 5 MiB is not stored at all
    const over = JOURNAL_IMAGE_MAX_BYTES_PER_RECORD + 1;
    const r3 = promptRecord('', { images: [{ mediaType: 'image/webp', dataBase64: b64(over) }] });
    assert.deepEqual(r3.data.content![1], { kind: 'text', data: `[image not stored in the session journal: webp, ${over} bytes; images over 5242880 bytes per message are not kept]` });
    assert.ok(Buffer.byteLength(JSON.stringify(r3), 'utf8') < 1024, 'nothing of the oversized image is stored');
  });

  it('replay (kiroFiles + ACP session/load) works on capped records', () => {
    const sb = mkSandbox();
    const big = 'x'.repeat(JOURNAL_TOOL_RESULT_MAX_BYTES + 5000);
    const recs = [
      promptRecord('see this', { messageId: 'p1', images: [{ mediaType: 'image/png', dataBase64: Buffer.alloc(JOURNAL_IMAGE_MAX_BYTES_PER_RECORD + 10).toString('base64') }] }),
      { version: 1 as const, kind: 'AssistantMessage', timestamp: '2026-01-01T00:00:00.000Z', data: { message_id: 'a1', content: [{ kind: 'text', data: 'reading' }, { kind: 'toolUse', data: { toolUseId: 'toolu_1', name: 'Read', input: { file_path: path.join(sb.cwd, 'a.txt') } } }] } },
      toolResultsRecord([{ toolUseId: 'toolu_1', text: big, isError: false }]),
    ];
    writeJournalRecords(sb.sessionsDir, U(5), recs);
    const items = replayItems(readJournal(sb.sessionsDir, U(5)));
    assert.deepEqual(items.map((i) => i.type), ['user', 'assistant', 'tool_use', 'tool_result']);
    const user = items[0] as Extract<(typeof items)[number], { type: 'user' }>;
    assert.match(user.text, /^see this\n\[image not stored in the session journal: png, \d+ bytes;/);
    assert.deepEqual(user.images, []);
    const tr = items[3] as Extract<(typeof items)[number], { type: 'tool_result' }>;
    assert.match(tr.text, /tool output truncated in the session journal: 5000 of \d+ bytes omitted\]$/);
    assert.match(journalHistoryText(readJournal(sb.sessionsDir, U(5)))!, /User: see this\n\[image not stored/);
    const r = buildReplay({ sessionsDir: sb.sessionsDir, sessionId: U(5), cwd: sb.cwd, env: sb.env });
    assert.equal(r.source, 'journal');
    const kinds = r.updates.map((u) => u.sessionUpdate);
    assert.deepEqual(kinds, ['user_message_chunk', 'user_message_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update']);
    assert.match(JSON.stringify(r.updates[1]), /image not stored in the session journal/);
    assert.ok(!r.updates.some((u) => (u.content as { type?: string } | undefined)?.type === 'image'));
    assert.equal(r.updates.at(-1)!.status, 'completed');
  });

  it('a live session journals capped tool output and images (the model still gets everything)', async () => {
    const sb = mkSandbox();
    const big = 'y'.repeat(300 * 1024);
    const scriptFile = sb.write(path.join(sb.root, 'script.json'), JSON.stringify({
      turns: [{ match: '^read', steps: [{ tool: { name: 'Read', id: 'toolu_big', input: { file_path: '{{cwd}}/big.txt' }, result: big } }, { text: 'done' }] }],
    }));
    sb.refresh({ FAKE_CLAUDE_SCRIPT: scriptFile, FAKE_CLAUDE_SCRIPT_JSON: undefined });
    const { s } = await open(sb);
    try {
      const { events } = await drain(s.prompt({ text: 'read it' }));
      assert.ok(events.some((e) => e.type === 'tool_end'));
      const img = Buffer.alloc(JOURNAL_IMAGE_MAX_BYTES_PER_RECORD + 1, 3).toString('base64');
      await drain(s.prompt({ text: 'look at this', images: [{ mediaType: 'image/png', dataBase64: img }] }));
      const sent = sb.userLines().at(-1)!;
      assert.ok(JSON.stringify(sent).includes(img.slice(0, 64)), 'Claude received the full image');
      const journal = readJournal(sb.sessionsDir, s.id);
      const tr = journal.find((r) => r.kind === 'ToolResults')!;
      const text = ((tr.data.content![0] as Extract<JournalBlock, { kind: 'toolResult' }>).data.content[0] as { data: string }).data;
      assert.ok(text.startsWith('y'.repeat(1000)));
      assert.match(text, /tool output truncated in the session journal/);
      assert.ok(Buffer.byteLength(text, 'utf8') < JOURNAL_TOOL_RESULT_MAX_BYTES + 200);
      const prompt = journal.filter((r) => r.kind === 'Prompt').at(-1)!;
      assert.deepEqual(prompt.data.content!.map((b) => b.kind), ['text', 'text']);
      assert.ok(fs.statSync(path.join(sb.sessionsDir, `${s.id}.jsonl`)).size < 1024 * 1024, 'the journal stays small');
    } finally {
      await closeAll(s);
    }
  });
});

// ───────────────────────────── 3. kiroClaude.* settings through the store ─────────────────────────────

describe('hardening: kiroClaude.* launch settings are read through the SettingsStore only', () => {
  it('values in the workspace kiro-claude.json the store does not return never reach the launch', async () => {
    // no $KIRO_CLAUDE_BIN (it outranks the setting): the binary must come from the store's claudePath
    const sb = mkSandbox({ env: { KIRO_CLAUDE_BIN: undefined, ANTHROPIC_API_KEY: 'dummy-test-value' } });
    sb.write('.kiro/settings/kiro-claude.json', JSON.stringify({
      'kiroClaude.extraClaudeArgs': ['--name', 'from-workspace-file'],
      'kiroClaude.claudeSettingSources': 'project,local',
      'kiroClaude.claudePath': path.join(path.sep, 'nonexistent', 'workspace-claude'),
      'kiroClaude.allowApiKey': true,
    }));
    const real = openSettings(sb.ws);
    const asked: string[] = [];
    // a store that answers kiroClaude.* from its own (global-only) table, everything else from the real store
    const table: Record<string, unknown> = {
      'kiroClaude.extraClaudeArgs': ['--name', 'from-store'],
      'kiroClaude.claudeSettingSources': 'user',
      'kiroClaude.claudePath': fakeClaudePath(),
      'kiroClaude.allowApiKey': false,
    };
    const pick = (k: string): unknown => {
      if (k.startsWith('kiroClaude.')) {
        asked.push(k);
        return table[k];
      }
      return real.get(k);
    };
    const settings: SettingsStore = {
      get: pick,
      getString: (k) => {
        const v = pick(k);
        return typeof v === 'string' ? v : undefined;
      },
      getBoolean: (k, d) => {
        const v = pick(k);
        return typeof v === 'boolean' ? v : d;
      },
      getNumber: (k, d) => {
        const v = pick(k);
        return typeof v === 'number' ? v : d;
      },
      set: () => undefined,
      delete: () => [],
      list: () => ({}),
      pathFor: (k, scope) => real.pathFor(k, scope),
    };
    const s = await KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), env: sb.env, settings });
    try {
      const start = sb.log().filter((e) => e.event === 'start' && (e.argv as string[]).includes('-p')).at(-1)!;
      const argv = start.argv as string[];
      assert.equal(flagValue(argv, '--name'), 'from-store');
      assert.ok(!argv.includes('from-workspace-file'));
      assert.equal(flagValue(argv, '--setting-sources'), 'user');
      assert.ok(!('ANTHROPIC_API_KEY' in (start.env as Record<string, unknown>)), 'allowApiKey came from the store (false)');
      for (const k of ['kiroClaude.extraClaudeArgs', 'kiroClaude.claudeSettingSources', 'kiroClaude.claudePath', 'kiroClaude.allowApiKey']) {
        assert.ok(asked.includes(k), `${k} is read through the store`);
      }
    } finally {
      await closeAll(s);
    }
  });
});

// ───────────────────────────── 4. createSession failure paths ─────────────────────────────

describe('hardening: createSession failure paths leak nothing', () => {
  it('initialize timeout: rejects, kills the child, removes record, lock and runtime dir', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_NO_INIT_RESPONSE: '1' } });
    await assert.rejects(open(sb, { initializeTimeoutMs: 300 }), /initialize/i);
    assert.ok(sb.starts().length >= 1, 'a child was spawned');
    assertNoLeaks(sb);
  });

  it('initialize timeout with a child that ignores EOF and SIGTERM: escalates to SIGKILL', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_NO_INIT_RESPONSE: '1', FAKE_CLAUDE_HANG_ON_EOF: '1', FAKE_CLAUDE_IGNORE_SIGTERM: '1' } });
    await assert.rejects(open(sb, { initializeTimeoutMs: 200 }), /initialize/i);
    assertNoLeaks(sb);
  });

  it('auth failure at start (child exits "Not logged in"): an auth error, nothing left behind', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_EXIT_ON_START: '1', FAKE_CLAUDE_STDERR: 'Not logged in · Please run /login' } });
    let err: unknown;
    await open(sb).catch((e: unknown) => (err = e));
    assert.ok(err instanceof Error);
    const detail = `${(err as Error).message}\n${(err as { stderr?: string }).stderr ?? ''}`;
    assert.ok(isAuthError(detail), 'callers can tell it is an auth failure');
    assertNoLeaks(sb);
  });

  it('auth failure answered to initialize: nothing left behind', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_INIT_ERROR: 'Invalid API key · Please run /login' } });
    await assert.rejects(open(sb), (e: unknown) => e instanceof Error && isAuthError(e.message));
    assertNoLeaks(sb);
  });

  it('spawn failure of a resumed session keeps its record, releases the lock and removes the runtime dir', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_EXIT_ON_START: '3', FAKE_CLAUDE_STDERR: 'kaboom' } });
    const store = new SessionStore(sb.sessionsDir);
    const rec = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'kiro_default', model: 'auto', turns: [turn('old')], messageCount: 1 });
    await assert.rejects(open(sb, { resume: { sessionId: rec.sessionId } }), /kaboom|exit/i);
    assertNoLeaks(sb, { keep: [`${rec.sessionId}.json`] });
    assert.equal(store.read(rec.sessionId)?.messageCount, 1);
  });

  it('a missing claude binary: rejects before anything is spawned, nothing left behind', async () => {
    const sb = mkSandbox({ env: { KIRO_CLAUDE_BIN: path.join(path.sep, 'nonexistent-kc', 'no-such-claude') } });
    await assert.rejects(KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), env: sb.env }), /not usable|not found|ENOENT/i);
    assertNoLeaks(sb);
  });

  for (const kind of ['new', 'fork'] as const) {
    it(`lock acquisition failing after the ${kind} record was created removes that record`, async () => {
      const sb = mkSandbox();
      const store = new SessionStore(sb.sessionsDir);
      const parent = kind === 'fork' ? store.create({ origin: 'repl', cwd: sb.cwd, agent: 'kiro_default', model: 'auto', turns: [turn('p')], messageCount: 1 }) : undefined;
      const orig = SessionStore.prototype.acquireLock;
      SessionStore.prototype.acquireLock = function (): never {
        throw new Error('Failed to start session: simulated lock failure');
      };
      try {
        await assert.rejects(
          open(sb, kind === 'fork' ? { fork: { fromClaudeSessionId: parent!.claudeSessionId, kind: 'rewind', parentId: parent!.sessionId } } : {}),
          /simulated lock failure/,
        );
      } finally {
        SessionStore.prototype.acquireLock = orig;
      }
      assertNoLeaks(sb, { keep: parent ? [`${parent.sessionId}.json`] : [] });
    });
  }
});

// ───────────────────────────── verifier: further edge cases ─────────────────────────────

/** A process that is alive and is not us (a lock holder `heldByOther` must respect). */
function sleeper(): { pid: number; stop(): void } {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  return { pid: c.pid!, stop: () => void c.kill('SIGKILL') };
}

/** Every `*.jsonl` under the sandbox Claude config dir (transcripts). */
function claudeTranscripts(sb: Sandbox): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(path.join(sb.claudeConfig, 'projects'));
  return out;
}

describe('hardening (verifier): locks held by a live KiroCrew process', () => {
  it('resume by id of a session another live process holds: rejects, keeps the record and that lock, spawns nothing', async () => {
    const sb = mkSandbox();
    const store = new SessionStore(sb.sessionsDir);
    const rec = store.create({ origin: 'acp', cwd: sb.cwd, agent: 'kiro_default', model: 'auto', turns: [turn('crew')], messageCount: 1 });
    const before = fs.readFileSync(store.pathFor(rec.sessionId), 'utf8');
    const holder = sleeper();
    try {
      const lockText = `${JSON.stringify({ pid: holder.pid, started_at: '2026-01-01T00:00:00.000Z', host: os.hostname() })}\n`;
      fs.writeFileSync(store.lockPathFor(rec.sessionId), lockText);
      await assert.rejects(open(sb, { resume: { sessionId: rec.sessionId } }), new RegExp(`active in another process \\(PID ${holder.pid}\\)`));
      assert.equal(sb.starts().length, 0, 'nothing spawned');
      assertNoLeaks(sb, { keep: [`${rec.sessionId}.json`, `${rec.sessionId}.lock`] });
      assert.equal(fs.readFileSync(store.pathFor(rec.sessionId), 'utf8'), before, 'the record is untouched (not deleted, not rewritten)');
      assert.equal(fs.readFileSync(store.lockPathFor(rec.sessionId), 'utf8'), lockText, "the other process's lock is untouched");
    } finally {
      holder.stop();
    }
  });

  it('resume latest while KiroCrew holds its newer session: opens the user chat; the KiroCrew lock is untouched', async () => {
    const sb = mkSandbox();
    const store = new SessionStore(sb.sessionsDir);
    const mine = store.create({ origin: 'headless', cwd: sb.cwd, agent: 'kiro_default', model: 'auto', updatedAt: '2026-01-01T00:00:00.000Z', turns: [turn('mine')], messageCount: 1 });
    const crew = store.create({ origin: 'acp', cwd: sb.cwd, agent: 'kiro_default', model: 'auto', updatedAt: '2026-06-01T00:00:00.000Z', turns: [turn('crew')], messageCount: 1 });
    const holder = sleeper();
    try {
      const lockText = `${JSON.stringify({ pid: holder.pid, started_at: '2026-01-01T00:00:00.000Z', host: os.hostname() })}\n`;
      fs.writeFileSync(store.lockPathFor(crew.sessionId), lockText);
      const { s } = await open(sb, { resume: { latest: true } });
      try {
        assert.equal(s.id, mine.sessionId);
      } finally {
        await closeAll(s);
      }
      assert.equal(fs.readFileSync(store.lockPathFor(crew.sessionId), 'utf8'), lockText);
    } finally {
      holder.stop();
    }
  });
});

describe('hardening (verifier): more createSession failure paths', () => {
  it('spawn failure of a fork drops the fork record, keeps the parent, removes the runtime dir', async () => {
    const sb = mkSandbox({ env: { FAKE_CLAUDE_EXIT_ON_START: '3', FAKE_CLAUDE_STDERR: 'kaboom' } });
    const store = new SessionStore(sb.sessionsDir);
    const parent = store.create({ origin: 'repl', cwd: sb.cwd, agent: 'kiro_default', model: 'auto', turns: [turn('p')], messageCount: 1 });
    const before = fs.readFileSync(store.pathFor(parent.sessionId), 'utf8');
    await assert.rejects(open(sb, { fork: { fromClaudeSessionId: parent.claudeSessionId, kind: 'rewind', parentId: parent.sessionId } }), /kaboom|exit/i);
    assertNoLeaks(sb, { keep: [`${parent.sessionId}.json`] });
    assert.equal(fs.readFileSync(store.pathFor(parent.sessionId), 'utf8'), before);
  });

  for (const how of ['lock', 'spawn'] as const) {
    it(`import (/chat load) failing at ${how}: no record, journal or re-keyed transcript is left`, async () => {
      const sb = mkSandbox(how === 'spawn' ? { env: { FAKE_CLAUDE_EXIT_ON_START: '3', FAKE_CLAUDE_STDERR: 'kaboom' } } : {});
      const src = U(4);
      const exported = {
        version: 1,
        kind: 'kiro-claude-export',
        exportedAt: '2026-01-01T00:00:00.000Z',
        session: { kind: 'kiro-claude-session', sessionId: src, claudeSessionId: src, cwd: sb.cwd, agent: 'kiro_default', model: 'auto', turns: [turn('x')], messageCount: 1 },
        claudeTranscript: `${JSON.stringify({ type: 'user', sessionId: src, uuid: U(3), message: { role: 'user', content: 'x' } })}\n`,
        kiroJournal: `${JSON.stringify(promptRecord('x'))}\n`,
      };
      sb.write('saved.json', JSON.stringify(exported));
      const orig = SessionStore.prototype.acquireLock;
      if (how === 'lock') {
        SessionStore.prototype.acquireLock = function (): never {
          throw new Error('Failed to start session: simulated lock failure');
        };
      }
      try {
        await assert.rejects(
          importSessionExport('saved.json', { ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), env: sb.env }),
          how === 'lock' ? /simulated lock failure/ : /kaboom|exit/i,
        );
      } finally {
        SessionStore.prototype.acquireLock = orig;
      }
      assertNoLeaks(sb);
      assert.deepEqual(claudeTranscripts(sb), [], 'the re-keyed transcript is removed');
    });
  }
});

describe('hardening (verifier): settings through the real SettingsStore', () => {
  it('launch keys in the workspace kiro-claude.json are ignored end to end; the global ones apply', async () => {
    const sb = mkSandbox({ env: { KIRO_CLAUDE_BIN: undefined, ANTHROPIC_API_KEY: 'dummy-test-value' } });
    sb.write('.kiro/settings/kiro-claude.json', JSON.stringify({
      'kiroClaude.extraClaudeArgs': ['--name', 'from-workspace-file'],
      'kiroClaude.claudeSettingSources': 'project,local',
      'kiroClaude.claudePath': path.join(path.sep, 'nonexistent', 'workspace-claude'),
      'kiroClaude.allowApiKey': true,
    }));
    sb.write(path.join(sb.kiroHome, 'settings', 'kiro-claude.json'), JSON.stringify({
      'kiroClaude.extraClaudeArgs': ['--name', 'from-global'],
      'kiroClaude.claudeSettingSources': 'user',
      'kiroClaude.claudePath': fakeClaudePath(),
    }));
    // no `settings` option: the session opens the real store itself
    const s = await KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), env: sb.env });
    try {
      const start = sb.log().filter((e) => e.event === 'start' && (e.argv as string[]).includes('-p')).at(-1)!;
      const argv = start.argv as string[];
      assert.equal(flagValue(argv, '--name'), 'from-global');
      assert.ok(!argv.includes('from-workspace-file'));
      assert.equal(flagValue(argv, '--setting-sources'), 'user');
      assert.ok(!('ANTHROPIC_API_KEY' in (start.env as Record<string, unknown>)), 'the workspace allowApiKey is ignored');
    } finally {
      await closeAll(s);
    }
  });
});

describe('hardening (verifier): tool-result cap at a 4-byte character boundary', () => {
  it('never splits a surrogate pair; the omitted count is exact', () => {
    const text = `a${'😀'.repeat(70_000)}`; // 1 + 280 000 bytes; the cap falls inside an emoji
    const capped = capToolResultText(text);
    const body = capped.slice(0, capped.indexOf('\n… [kiro-claude:'));
    assert.ok(!body.includes('�'));
    assert.match(body, /^a(😀)+$/u);
    const kept = Buffer.byteLength(body, 'utf8');
    assert.ok(kept <= JOURNAL_TOOL_RESULT_MAX_BYTES && kept > JOURNAL_TOOL_RESULT_MAX_BYTES - 4);
    assert.match(capped, new RegExp(`: ${280_001 - kept} of 280001 bytes omitted\\]$`));
  });
});
