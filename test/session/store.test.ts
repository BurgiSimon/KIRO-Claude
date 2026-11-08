import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SESSION_KIND,
  SessionStore,
  compareSessionsNewestFirst,
  formatListTime,
  formatSessionList,
  fromDiskJson,
  isSafeSessionId,
  pidAlive,
  previewText,
  sessionsDir,
  toDiskJson,
} from '../../src/session/store.js';
import type { SessionRecord, WorkspaceContext } from '../../src/types.js';
import { removeOnExit } from '../tmpdirs.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function tmp(): string {
  return removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-store-'))));
}

function ws(root: string, env: NodeJS.ProcessEnv = {}): WorkspaceContext {
  return { cwd: path.join(root, 'proj'), workspaceRoot: path.join(root, 'proj'), kiroHome: path.join(root, 'home', '.kiro'), home: path.join(root, 'home'), env };
}

function store(): { dir: string; root: string; s: SessionStore; cwd: string } {
  const root = tmp();
  const dir = path.join(root, 'kiro', 'sessions', 'cli');
  const cwd = path.join(root, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  return { root, dir, cwd, s: new SessionStore(dir) };
}

function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    c.on('exit', () => resolve(c.pid!));
  });
}

describe('store: sessionsDir', () => {
  it('defaults to <kiroHome>/sessions/cli', () => {
    const w = ws('/r');
    assert.equal(sessionsDir(w), '/r/home/.kiro/sessions/cli');
  });
  it('KIRO_CLAUDE_SESSIONS_DIR overrides (relative to cwd, ~ expanded)', () => {
    assert.equal(sessionsDir(ws('/r', { KIRO_CLAUDE_SESSIONS_DIR: '/x/s' })), '/x/s');
    assert.equal(sessionsDir(ws('/r', { KIRO_CLAUDE_SESSIONS_DIR: 'rel' })), '/r/proj/rel');
    assert.equal(sessionsDir(ws('/r', { KIRO_CLAUDE_SESSIONS_DIR: '~/s', HOME: '/hh' })), '/hh/s');
    assert.equal(sessionsDir(ws('/r', { KIRO_CLAUDE_SESSIONS_DIR: '  ' })), '/r/home/.kiro/sessions/cli');
  });
});

describe('store: create / read / write', () => {
  it('create persists a full record with UUID ids, realpath cwd, 0600 file in a 0700 dir', () => {
    const { s, dir, root, cwd } = store();
    const link = path.join(root, 'link');
    fs.symlinkSync(cwd, link);
    const rec = s.create({ origin: 'repl', cwd: link, agent: 'kiro_default', model: 'auto', effort: 'high' });
    assert.match(rec.sessionId, UUID_RE);
    assert.equal(rec.claudeSessionId, rec.sessionId);
    assert.equal(rec.cwd, cwd);
    assert.equal(rec.kind, SESSION_KIND);
    assert.equal(rec.version, 1);
    assert.equal(rec.effort, 'high');
    assert.deepEqual(rec.trust, { trustAll: false, allowedTools: [], rules: [] });
    assert.equal(rec.forkKind, 'main');
    assert.equal(rec.parentId, null);
    const file = path.join(dir, `${rec.sessionId}.json`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(s.read(rec.sessionId), rec);
    assert.deepEqual(fs.readdirSync(dir), [`${rec.sessionId}.json`]); // no temp files left
  });

  it('on-disk file carries the kiro-cli envelope KiroCrew reads (08a §4.2)', () => {
    const { s, dir, cwd } = store();
    const rec = s.create({ origin: 'acp', cwd, agent: 'kirocrew', model: 'claude-opus-5.5', title: 'T' });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${rec.sessionId}.json`), 'utf8'));
    assert.equal(raw.kind, 'kiro-claude-session');
    assert.equal(raw.session_id, rec.sessionId);
    assert.equal(raw.cwd, cwd);
    assert.equal(raw.title, 'T');
    assert.equal(raw.created_at, rec.createdAt);
    assert.equal(raw.updated_at, rec.updatedAt);
    assert.deepEqual(raw.session_state, {
      agent_name: 'kirocrew',
      permissions: { filesystem: { allowed_read_paths: [], allowed_write_paths: [] } },
      conversation_metadata: {},
    });
    assert.deepEqual(raw.kiro_claude, { claudeSessionId: rec.sessionId, model: 'claude-opus-5.5', effort: null });
  });

  it('create honors provided fields', () => {
    const { s, cwd } = store();
    const rec = s.create({
      origin: 'headless',
      cwd,
      agent: 'a',
      model: 'm',
      sessionId: '11111111-2222-4333-8444-555555555555',
      claudeSessionId: 'c-1',
      parentId: 'p',
      forkKind: 'rewind',
      trust: { trustAll: true, allowedTools: ['fs_read'], rules: [] },
      contextRules: [{ rule: 'src/**', origin: 'session' }],
      planMode: true,
    });
    const back = s.read('11111111-2222-4333-8444-555555555555')!;
    assert.equal(back.claudeSessionId, 'c-1');
    assert.equal(back.parentId, 'p');
    assert.equal(back.forkKind, 'rewind');
    assert.equal(back.trust.trustAll, true);
    assert.deepEqual(back.contextRules, [{ rule: 'src/**', origin: 'session' }]);
    assert.equal(back.planMode, true);
    assert.deepEqual(back, rec);
  });

  it('create refuses an id that already exists (ours or foreign)', () => {
    const { s, dir, cwd } = store();
    const rec = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto' });
    assert.throws(() => s.create({ origin: 'repl', cwd, agent: 'b', model: 'auto', sessionId: rec.sessionId }), /already exists/);
    assert.equal(s.read(rec.sessionId)!.agent, 'a');
    const foreign = '77777777-7777-4777-8777-777777777777';
    fs.writeFileSync(path.join(dir, `${foreign}.json`), '{}');
    assert.throws(() => s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto', sessionId: foreign }), /already exists/);
    assert.equal(fs.readFileSync(path.join(dir, `${foreign}.json`), 'utf8'), '{}');
  });

  it('write updates updatedAt and persists atomically', async () => {
    const { s, dir, cwd } = store();
    const rec = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
    rec.model = 'claude-sonnet-5.5';
    s.write(rec);
    assert.ok(Date.parse(rec.updatedAt) > Date.parse('2021-01-01'));
    assert.equal(s.read(rec.sessionId)!.model, 'claude-sonnet-5.5');
    assert.equal(s.read(rec.sessionId)!.updatedAt, rec.updatedAt);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  });

  it('write never moves updatedAt backwards', () => {
    const { s, cwd } = store();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const rec = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto', updatedAt: future });
    s.write(rec);
    assert.equal(rec.updatedAt, future);
  });

  it('read ignores foreign kiro-cli files, malformed JSON, unsafe ids and missing files', () => {
    const { s, dir } = store();
    fs.mkdirSync(dir, { recursive: true });
    const foreign = '22222222-2222-4222-8222-222222222222';
    fs.writeFileSync(path.join(dir, `${foreign}.json`), JSON.stringify({ session_id: foreign, cwd: '/x', session_state: { agent_name: 'k' } }));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    assert.equal(s.read(foreign), undefined);
    assert.equal(s.read('bad'), undefined);
    assert.equal(s.read('../etc/passwd'), undefined);
    assert.equal(s.read('nope'), undefined);
    assert.throws(() => s.pathFor('../x'), /Invalid session id/);
  });

  it('envelope values win when a third party rewrote them; the stem is the id', () => {
    const { s, dir, cwd } = store();
    const rec = s.create({ origin: 'acp', cwd, agent: 'old-agent', model: 'auto' });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${rec.sessionId}.json`), 'utf8'));
    const newId = '33333333-3333-4333-8333-333333333333';
    raw.session_id = newId;
    raw.session_state.agent_name = 'new-agent';
    raw.updated_at = '2030-01-01T00:00:00+00:00';
    raw.created_at = '2029-01-01T00:00:00+00:00';
    fs.writeFileSync(path.join(dir, `${newId}.json`), JSON.stringify(raw));
    const copy = s.read(newId)!;
    assert.equal(copy.sessionId, newId);
    assert.equal(copy.claudeSessionId, rec.sessionId);
    assert.equal(copy.agent, 'new-agent');
    assert.equal(copy.updatedAt, '2030-01-01T00:00:00+00:00');
    assert.equal(copy.createdAt, '2029-01-01T00:00:00+00:00');
  });

  it('fromDiskJson fills defaults for sparse records (05 §8 legacy shape)', () => {
    const r = fromDiskJson({ kind: SESSION_KIND, cwd: '/w', agent: 'x', model: 'auto', effort: 'medium', turns: [{ userUuid: 'u', preview: 'p', at: 't', assistantUuid: 'a' }, 7] }, 'id1')!;
    assert.equal(r.sessionId, 'id1');
    assert.equal(r.claudeSessionId, 'id1');
    assert.equal(r.origin, 'repl');
    assert.equal(r.forkKind, 'main');
    assert.equal(r.messageCount, 1);
    assert.deepEqual(r.turns, [{ userUuid: 'u', preview: 'p', at: 't', assistantUuid: 'a' }]);
    assert.equal(r.effort, 'medium');
    assert.equal(fromDiskJson({ kind: 'other' }, 'x'), undefined);
    assert.equal(fromDiskJson(null, 'x'), undefined);
    assert.equal(fromDiskJson([], 'x'), undefined);
  });

  it('toDiskJson / fromDiskJson round-trip', () => {
    const { s, cwd } = store();
    const rec = s.create({ origin: 'spec', cwd, agent: 'a', model: 'm', effort: 'max', tangentName: 't', forkKind: 'tangent', parentId: 'p' });
    assert.deepEqual(fromDiskJson(JSON.parse(JSON.stringify(toDiskJson(rec))), rec.sessionId), rec);
  });

  it('isSafeSessionId', () => {
    for (const ok of ['a', 'abc-DEF_1.2', '6f0c4c2e-1111-4222-8333-444455556666']) assert.ok(isSafeSessionId(ok), ok);
    for (const bad of ['', '.x', '../x', 'a/b', 'a\\b', 'a..b', 'x'.repeat(201), 'a b']) assert.ok(!isSafeSessionId(bad), bad);
  });
});

describe('store: list / latest / delete', () => {
  it('lists newest updatedAt first, filters by realpath cwd, ignores foreign and non-json files', () => {
    const { s, dir, root, cwd } = store();
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    const a = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto', updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' });
    const b = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto', updatedAt: '2026-03-01T00:00:00.000Z', createdAt: '2026-01-02T00:00:00.000Z' });
    const c = s.create({ origin: 'acp', cwd: other, agent: 'a', model: 'auto', updatedAt: '2026-02-01T00:00:00.000Z', createdAt: '2026-01-03T00:00:00.000Z' });
    fs.writeFileSync(path.join(dir, '44444444-4444-4444-8444-444444444444.json'), JSON.stringify({ session_id: 'x', cwd }));
    fs.writeFileSync(path.join(dir, `${a.sessionId}.jsonl`), '{"version":1,"kind":"Prompt"}\n');
    fs.writeFileSync(path.join(dir, `${a.sessionId}.lock`), '{"pid":1}');
    assert.deepEqual(s.list().map((r) => r.sessionId), [b.sessionId, c.sessionId, a.sessionId]);
    assert.deepEqual(s.list({ cwd }).map((r) => r.sessionId), [b.sessionId, a.sessionId]);
    const link = path.join(root, 'cwd-link');
    fs.symlinkSync(cwd, link);
    assert.deepEqual(s.list({ cwd: link }).map((r) => r.sessionId), [b.sessionId, a.sessionId]);
    assert.deepEqual(s.list({ cwd: path.join(root, 'nowhere') }), []);
    assert.equal(s.latest(cwd)!.sessionId, b.sessionId);
    assert.equal(s.latest(other)!.sessionId, c.sessionId);
    assert.equal(s.latest(path.join(root, 'nowhere')), undefined);
  });

  it('list of a missing directory is empty', () => {
    assert.deepEqual(new SessionStore(path.join(tmp(), 'none')).list(), []);
  });

  it('latest skips tangent sessions', () => {
    const { s, cwd } = store();
    const main = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto', updatedAt: '2026-01-01T00:00:00.000Z' });
    s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto', updatedAt: '2026-06-01T00:00:00.000Z', forkKind: 'tangent', parentId: main.sessionId });
    assert.equal(s.latest(cwd)!.sessionId, main.sessionId);
    assert.equal(s.list({ cwd }).length, 2);
  });

  it('ordering ties: createdAt then id', () => {
    const t = '2026-01-01T00:00:00.000Z';
    const mk = (id: string, created: string): SessionRecord => fromDiskJson({ kind: SESSION_KIND, updatedAt: t, createdAt: created }, id)!;
    const list = [mk('b', '2025-01-01T00:00:00Z'), mk('a', '2025-01-01T00:00:00Z'), mk('c', '2025-06-01T00:00:00Z')].sort(compareSessionsNewestFirst);
    assert.deepEqual(list.map((r) => r.sessionId), ['c', 'a', 'b']);
  });

  it('delete removes only our index file and lock; never foreign files or transcripts', async () => {
    const { s, dir, cwd } = store();
    const rec = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto' });
    fs.writeFileSync(path.join(dir, `${rec.sessionId}.lock`), JSON.stringify({ pid: await deadPid(), started_at: 'x' }));
    fs.writeFileSync(path.join(dir, `${rec.sessionId}.jsonl`), 'mirror');
    assert.equal(s.delete(rec.sessionId), true);
    assert.deepEqual(fs.readdirSync(dir), [`${rec.sessionId}.jsonl`]);
    assert.equal(s.delete(rec.sessionId), false);
    const foreign = '55555555-5555-4555-8555-555555555555';
    fs.writeFileSync(path.join(dir, `${foreign}.json`), JSON.stringify({ session_id: foreign }));
    assert.equal(s.delete(foreign), false);
    assert.ok(fs.existsSync(path.join(dir, `${foreign}.json`)));
    assert.equal(s.delete('../x'), false);
  });

  it('delete keeps a lock held by another live process', () => {
    const { s, dir, cwd } = store();
    const rec = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto' });
    const lock = path.join(dir, `${rec.sessionId}.lock`);
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, started_at: 'x', host: os.hostname() }));
    assert.equal(s.delete(rec.sessionId), true);
    assert.ok(fs.existsSync(lock));
  });
});

describe('store: locks', () => {
  it('acquire writes {pid, started_at, host}; release removes it; release is idempotent', () => {
    const { s, dir, cwd } = store();
    const rec = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto' });
    const lock = s.acquireLock(rec.sessionId);
    const p = path.join(dir, `${rec.sessionId}.lock`);
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(data.pid, process.pid);
    assert.equal(data.host, os.hostname());
    assert.ok(!Number.isNaN(Date.parse(data.started_at)));
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.deepEqual(s.lockInfo(rec.sessionId), { pid: process.pid, startedAt: data.started_at, host: os.hostname(), live: true });
    lock.release();
    assert.ok(!fs.existsSync(p));
    lock.release();
    assert.equal(s.lockInfo(rec.sessionId), undefined);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
  });

  it('a live foreign PID blocks with the Kiro message', async () => {
    const { s, dir } = store();
    const id = '66666666-6666-4666-8666-666666666666';
    fs.mkdirSync(dir, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => child.once('spawn', r));
      fs.writeFileSync(path.join(dir, `${id}.lock`), JSON.stringify({ pid: child.pid, started_at: new Date().toISOString(), host: os.hostname() }));
      assert.throws(() => s.acquireLock(id), { message: `Failed to start session: Session is active in another process (PID ${child.pid})` });
      // lock untouched
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${id}.lock`), 'utf8')).pid, child.pid);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('a lock without host (kiro-cli shape) from a live PID also blocks', () => {
    const { s, dir } = store();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'abc.lock'), JSON.stringify({ pid: 1, started_at: 'x' }));
    assert.throws(() => s.acquireLock('abc'), /Session is active in another process \(PID 1\)/);
  });

  it('a stale lock from a dead PID is taken over', async () => {
    const { s, dir } = store();
    fs.mkdirSync(dir, { recursive: true });
    const pid = await deadPid();
    assert.equal(pidAlive(pid), false);
    fs.writeFileSync(path.join(dir, 'abc.lock'), JSON.stringify({ pid, started_at: 'x', host: os.hostname() }));
    const lock = s.acquireLock('abc');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'abc.lock'), 'utf8')).pid, process.pid);
    lock.release();
  });

  it('corrupt locks are taken over', () => {
    const { s, dir } = store();
    fs.mkdirSync(dir, { recursive: true });
    for (const junk of ['', 'garbage', '{"pid":"7"}', '{"pid":-3}']) {
      fs.writeFileSync(path.join(dir, 'abc.lock'), junk);
      const lock = s.acquireLock('abc');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'abc.lock'), 'utf8')).pid, process.pid, junk);
      lock.release();
    }
  });

  it('a lock from another host is respected', () => {
    const { s, dir } = store();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'abc.lock'), JSON.stringify({ pid: 999999, started_at: 'x', host: `${os.hostname()}-elsewhere` }));
    assert.throws(() => s.acquireLock('abc'), /PID 999999/);
  });

  it('re-acquiring in the same process takes over; the old handle no longer releases', () => {
    const { s, dir } = store();
    const l1 = s.acquireLock('abc');
    const l2 = s.acquireLock('abc');
    l1.release();
    assert.ok(fs.existsSync(path.join(dir, 'abc.lock')));
    l2.release();
    assert.ok(!fs.existsSync(path.join(dir, 'abc.lock')));
  });

  it('release does not remove a lock that now belongs to someone else', () => {
    const { s, dir } = store();
    const l = s.acquireLock('abc');
    fs.writeFileSync(path.join(dir, 'abc.lock'), JSON.stringify({ pid: 1, started_at: 'other' }));
    l.release();
    assert.ok(fs.existsSync(path.join(dir, 'abc.lock')));
  });

  it('acquireLock rejects unsafe ids and creates the directory', () => {
    const { s, dir } = store();
    assert.throws(() => s.acquireLock('../x'), /Invalid session id/);
    const l = s.acquireLock('fresh');
    assert.ok(fs.existsSync(dir));
    l.release();
  });

  it('pidAlive', () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(1), true);
  });
});

describe('store: appendTurn', () => {
  it('appends turns, counts messages, sets title from the first prompt (≤60) and lastPreview', () => {
    const { s, cwd } = store();
    const rec = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto', updatedAt: '2020-01-01T00:00:00.000Z' });
    const long = 'Please refactor the authentication module so that it uses the new token service and add tests';
    const r1 = s.appendTurn(rec, { userUuid: 'u1', assistantUuid: 'a1', preview: long, at: '2026-11-06T00:00:00Z' }, 'Done.\nRefactored.');
    assert.equal(r1, rec);
    assert.equal(rec.turns.length, 1);
    assert.equal(rec.messageCount, 1);
    assert.equal([...rec.title].length, 60);
    assert.ok(rec.title.endsWith('…'));
    assert.ok(long.startsWith(rec.title.slice(0, -1)));
    assert.equal(rec.lastPreview, 'Done. Refactored.');
    assert.ok(Date.parse(rec.updatedAt) > Date.parse('2021-01-01'));
    s.appendTurn(rec, { userUuid: 'u2', preview: 'second', at: 'x' }, 'ok');
    assert.equal(rec.title.endsWith('…'), true); // title kept
    assert.equal(rec.messageCount, 2);
    const back = s.read(rec.sessionId)!;
    assert.deepEqual(back.turns.map((t) => [t.userUuid, t.assistantUuid]), [['u1', 'a1'], ['u2', undefined]]);
    assert.equal(back.lastPreview, 'ok');
  });

  it('short first prompt becomes the title verbatim; empty preview falls back', () => {
    const { s, cwd } = store();
    const rec = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto' });
    s.appendTurn(rec, { userUuid: 'u', preview: '  fix   the bug ', at: 'x' }, 'reply');
    assert.equal(rec.title, 'fix the bug');
    const rec2 = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto' });
    s.appendTurn(rec2, { userUuid: 'u', preview: '', at: 'x' }, 'assistant text');
    assert.equal(rec2.title, 'assistant text');
  });

  it('previewText caps at 200 code points by default', () => {
    assert.equal(previewText('a\n\tb'), 'a b');
    assert.equal([...previewText('😀'.repeat(300))].length, 200);
    assert.equal(previewText('abcdef', 4), 'abc…');
  });
});

describe('store: formatSessionList (01 §6)', () => {
  const recs = (): SessionRecord[] => {
    const a = fromDiskJson({ kind: SESSION_KIND, title: 'Fix login', updatedAt: '2026-11-06T10:05:00.000Z', messageCount: 3, cwd: '/w', agent: 'kiro_default', model: 'auto' }, 'aaaaaaaa-0000-4000-8000-000000000001')!;
    const b = fromDiskJson({ kind: SESSION_KIND, title: '', lastPreview: 'last words', updatedAt: '2026-11-05T09:00:00.000Z', messageCount: 1, forkKind: 'tangent', tangentName: 'idea' }, 'bbbbbbbb-0000-4000-8000-000000000002')!;
    const c = fromDiskJson({ kind: SESSION_KIND, updatedAt: '2026-11-04T09:00:00.000Z', messageCount: 12 }, 'cccccccc-0000-4000-8000-000000000003')!;
    return [a, b, c];
  };
  it('plain', () => {
    const [a, b, c] = recs();
    assert.equal(
      formatSessionList([a!, b!, c!], 'plain'),
      [
        `${a!.sessionId}  ${formatListTime(a!.updatedAt)}  3 messages   Fix login`,
        `${b!.sessionId}  ${formatListTime(b!.updatedAt)}  1 message    [tangent: idea] last words`,
        `${c!.sessionId}  ${formatListTime(c!.updatedAt)}  12 messages  (untitled)`,
      ].join('\n'),
    );
  });
  it('plain empty', () => {
    assert.equal(formatSessionList([], 'plain'), 'No saved chat sessions for this directory.');
  });
  it('json rows', () => {
    const [a] = recs();
    assert.deepEqual(JSON.parse(formatSessionList([a!], 'json')), [
      {
        sessionId: a!.sessionId,
        title: 'Fix login',
        cwd: '/w',
        agent: 'kiro_default',
        model: 'auto',
        createdAt: a!.createdAt,
        updatedAt: '2026-11-06T10:05:00.000Z',
        messageCount: 3,
        lastPreview: '',
        parentId: null,
        forkKind: 'main',
      },
    ]);
    assert.equal(formatSessionList([], 'json'), '[]');
  });
  it('formatListTime is local YYYY-MM-DD HH:MM; invalid passes through', () => {
    const d = new Date(2026, 0, 2, 3, 4);
    assert.equal(formatListTime(d.toISOString()), '2026-01-02 03:04');
    assert.equal(formatListTime('garbage'), 'garbage');
  });
});
