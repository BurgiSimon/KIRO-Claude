/**
 * The fake (test/fixtures/fake-claude.mjs) answers a fork onto a `--session-id` whose transcript
 * exists (`--resume X --fork-session --session-id T`, T already written) the way the real claude
 * 2.1.319 does (VERIFIED by the session verifier, r3g-gaps.md): stderr
 * `Error: Session ID T is already in use.`, exit 1, nothing written, and that check comes BEFORE
 * the source lookup (the same answer when X has no transcript); the same for
 * `--continue --fork-session --session-id T`, while a fork onto the id it resumes (X = T) is exempt
 * (both VERIFIED by the fixtures verifier, no model call). Before, the fake forked X again
 * and overwrote T, so the session path this refusal drives had no faithful test: a fork whose
 * first turn Claude wrote but that never completed a turn in kiro-claude's view (the child died
 * mid-turn) stays pending, its respawn (or a resume of its record after a quit, S3) re-forks the
 * source, Claude refuses (it wrote the fork), and the session resumes the fork instead, keeping
 * what Claude wrote into it.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import type { ClaudeProcess } from '../../src/claude/process.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { KiroSession } from '../../src/types.js';
import { collectTurn, fakeEnv, mkTmp, startFake, STREAM_ARGS } from '../claude/helpers.js';
import { closeAll, drain, fakeBinary, fakeCaps, fakeClaudePath, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from '../session/helpers.js';

const SRC = '3a1c5e70-2b4d-4f6a-8c9e-0d1f2a3b4c5d';
const FORK = '4b2d6f81-3c5e-4a7b-9d0f-1e2a3b4c5d6e';
const FRESH = '5c3e7a92-4d6f-4b8c-8e1a-2f3b4c5d6e7f';
const NOSUCH = '6d4f8ba3-5e7a-4c9d-9f2b-3a4c5d6e7f80';
const COUNT = { default: { steps: [{ text: 'history={{historyCount}} [{{historyUserTexts}}]' }] } };
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface RawRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The fake run directly (no ClaudeProcess), stdin closed at once, killed after `ms`. */
function runFake(args: string[], cwd: string, env: NodeJS.ProcessEnv, ms = 8000): Promise<RawRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fakeClaudePath(), ...STREAM_ARGS, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('error', reject);
    child.on('exit', () => clearTimeout(timer));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

describe('fake-claude: a fork onto a --session-id whose transcript exists (real claude 2.1.319)', () => {
  const cfg = mkTmp('kc-spec-refork-cfg-');
  const cwd = fs.realpathSync(mkTmp('kc-spec-refork-cwd-'));
  const persistEnv = { FAKE_CLAUDE_PERSIST: '1', CLAUDE_CONFIG_DIR: cfg };
  const env = fakeEnv(persistEnv);
  const projectDir = path.join(cfg, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const file = (sid: string): string => path.join(projectDir, `${sid}.jsonl`);
  let srcBefore = '';
  let forkBefore = '';
  const open: ClaudeProcess[] = [];

  before(async () => {
    const h = await startFake({ cwd, args: ['--session-id', SRC], env: persistEnv, script: COUNT });
    open.push(h.proc);
    await collectTurn(h.proc.turn('alpha'));
    await h.proc.close();
    // the fork, written by its first line (Claude writes a fork's transcript with its first message)
    const f = await startFake({ cwd, args: ['--resume', SRC, '--fork-session', '--session-id', FORK], env: persistEnv, script: COUNT });
    open.push(f.proc);
    const r = await collectTurn(f.proc.turn('in the fork'));
    assert.equal(r.result.result, 'history=2 [alpha | in the fork]');
    await f.proc.close();
    srcBefore = fs.readFileSync(file(SRC), 'utf8');
    forkBefore = fs.readFileSync(file(FORK), 'utf8');
  });
  after(async () => {
    await Promise.all(open.map((p) => p.close({ graceMs: 200 }).catch(() => undefined)));
    fs.rmSync(cfg, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  for (const [label, source] of [
    ['the source exists', SRC],
    ['the source has no transcript (checked before the source)', NOSUCH],
  ] as const) {
    it(`re-forking onto it is refused (${label}): 'Session ID … is already in use.', exit 1, nothing written`, async () => {
      const r = await runFake(['--resume', source, '--fork-session', '--session-id', FORK], cwd, env);
      assert.equal(r.code, 1, `exit code (stderr: ${JSON.stringify(r.stderr.slice(0, 200))})`);
      assert.match(r.stderr, new RegExp(`^Error: Session ID ${escapeRe(FORK)} is already in use\\.$`, 'm'));
      assert.doesNotMatch(r.stderr, /No conversation found/);
      assert.equal(r.stdout.trim(), '', 'nothing on stdout');
      assert.deepEqual(fs.readdirSync(projectDir).sort(), [`${SRC}.jsonl`, `${FORK}.jsonl`].sort(), 'no transcript was written');
      assert.equal(fs.readFileSync(file(FORK), 'utf8'), forkBefore, 'the fork is not overwritten');
      assert.equal(fs.readFileSync(file(SRC), 'utf8'), srcBefore, 'the source is untouched');
    });
  }

  // VERIFIED against the real claude 2.1.319 (verifier, no model call, stdin closed): its check is
  // `!(forkSession && resume === sessionId) && <cwd project dir>/<sessionId>.jsonl exists`, made
  // for every --session-id (a new start, --resume or --continue with --fork-session) before any
  // session is loaded; a fork onto the very id it resumes is exempt (exit 0, transcript untouched)
  it('a fork onto the id it resumes (--resume T --fork-session --session-id T) is not refused: T keeps its history', async () => {
    const r = await runFake(['--resume', FORK, '--fork-session', '--session-id', FORK], cwd, env);
    assert.equal(r.code, 0, `exit code (stderr: ${JSON.stringify(r.stderr.slice(0, 200))})`);
    assert.doesNotMatch(r.stderr, /already in use/);
    assert.equal(fs.readFileSync(file(FORK), 'utf8'), forkBefore, 'no line: nothing written');
    const h = await startFake({ cwd, args: ['--resume', FORK, '--fork-session', '--session-id', FORK], env: persistEnv, script: COUNT });
    open.push(h.proc);
    const t = await collectTurn(h.proc.turn('onto itself'));
    assert.equal(t.result.result, 'history=3 [alpha | in the fork | onto itself]');
    await h.proc.close();
    fs.writeFileSync(file(FORK), forkBefore);
  });

  it("--continue --fork-session --session-id onto an existing transcript is refused the same way (before the newest transcript is picked)", async () => {
    const r = await runFake(['--continue', '--fork-session', '--session-id', FORK], cwd, env);
    assert.equal(r.code, 1, `exit code (stderr: ${JSON.stringify(r.stderr.slice(0, 200))})`);
    assert.match(r.stderr, new RegExp(`^Error: Session ID ${escapeRe(FORK)} is already in use\\.$`, 'm'));
    assert.equal(r.stdout.trim(), '', 'nothing on stdout');
    assert.deepEqual(fs.readdirSync(projectDir).sort(), [`${SRC}.jsonl`, `${FORK}.jsonl`].sort(), 'no transcript was written');
    assert.equal(fs.readFileSync(file(FORK), 'utf8'), forkBefore);
    assert.equal(fs.readFileSync(file(SRC), 'utf8'), srcBefore);
  });

  it('--continue --session-id without --fork-session is rejected like --resume --session-id', async () => {
    const r = await runFake(['--continue', '--session-id', FRESH], cwd, env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Error: --session-id can only be used with --continue or --resume if --fork-session is also specified\.$/m);
    assert.ok(!fs.existsSync(file(FRESH)));
  });

  it('control: a fork onto an unused --session-id still copies the source', async () => {
    const h = await startFake({ cwd, args: ['--resume', SRC, '--fork-session', '--session-id', FRESH], env: persistEnv, script: COUNT });
    open.push(h.proc);
    const r = await collectTurn(h.proc.turn('fresh fork'));
    assert.equal(r.result.result, 'history=2 [alpha | fresh fork]');
    await h.proc.close();
    fs.rmSync(file(FRESH), { force: true });
  });

  it('control: --resume of the fork itself keeps its own history', async () => {
    const h = await startFake({ cwd, args: ['--resume', FORK], env: persistEnv, script: COUNT });
    open.push(h.proc);
    const r = await collectTurn(h.proc.turn('back'));
    assert.equal(r.result.result, 'history=3 [alpha | in the fork | back]');
    await h.proc.close();
    fs.writeFileSync(file(FORK), forkBefore);
  });

  it('control: a fork whose own transcript was never written (no first line) can be forked again', async () => {
    const idle = '7e5a9cb4-6f8b-4dae-8a3c-4b5d6e7f8091';
    const r1 = await runFake(['--resume', SRC, '--fork-session', '--session-id', idle], cwd, env);
    assert.equal(r1.code, 0, r1.stderr);
    assert.ok(!fs.existsSync(file(idle)), 'precondition: a fork without a message leaves no transcript');
    const h = await startFake({ cwd, args: ['--resume', SRC, '--fork-session', '--session-id', idle], env: persistEnv, script: COUNT });
    open.push(h.proc);
    const r = await collectTurn(h.proc.turn('second try'));
    assert.equal(r.result.result, 'history=2 [alpha | second try]');
    await h.proc.close();
    fs.rmSync(file(idle), { force: true });
  });

  it('without persistence nothing is checked (no transcripts)', async () => {
    const h = await startFake({ cwd, args: ['--resume', SRC, '--fork-session', '--session-id', FORK], script: COUNT });
    open.push(h.proc);
    const r = await collectTurn(h.proc.turn('hi'));
    assert.equal(r.result.result, 'history=1 [hi]');
    await h.proc.close();
  });
});

// ───────── the session path: Claude wrote the fork, so the re-fork turns into a resume ─────────

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

/** The first line of a fork crashes the child after Claude read (and wrote) it. */
const SCRIPT = {
  turns: [{ repeat: true, match: 'crash me', steps: [{ exit: 1, stderr: 'boom' }] }],
  default: { steps: [{ text: 'hist=[{{historyUserTexts}}]' }] },
};

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env };
}

async function open(sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> {
  return KiroSessionImpl.create({ ...baseOptions(sb, ui), ...over });
}

/** A fork of `parent`'s conversation, the way SpecSessionDriver.fork asks for one (from its forkSource). */
async function specForkOf(sb: Sandbox, parent: KiroSession): Promise<KiroSessionImpl> {
  const src = parent.forkSource()!;
  return open(sb, { origin: 'spec', fork: { fromClaudeSessionId: src.from, ...(src.at ? { at: src.at } : {}), kind: 'main', parentId: parent.id } });
}

const transcriptOf = (sb: Sandbox, sid: string): string => {
  const dir = path.join(sb.claudeConfig, 'projects', sb.cwd.replace(/[^A-Za-z0-9]/g, '-'));
  return fs.readFileSync(path.join(dir, `${sid}.jsonl`), 'utf8');
};

/**
 * The respawn after `crash me` (or the resume after a quit): the re-fork of the source onto the
 * fork's id is refused, and the fork is resumed. `startsFrom` = sb.starts() index of the re-fork.
 */
function assertReforkBecameResume(sb: Sandbox, startsFrom: number, source: string, forkId: string): void {
  const argvs = sb.starts().slice(startsFrom);
  assert.equal(argvs.length, 2, `the re-fork, then the resume: ${JSON.stringify(argvs.map((a) => a.filter((x) => /^--(resume|fork-session|session-id)$/.test(x) || /^[0-9a-f-]{36}$/.test(x))))}`);
  const [refork, resume] = argvs as [string[], string[]];
  assert.equal(flagValue(refork, '--resume'), source, 'the pending fork forked its source again');
  assert.ok(refork.includes('--fork-session'));
  assert.equal(flagValue(refork, '--session-id'), forkId);
  assert.equal(flagValue(resume, '--resume'), forkId, 'Claude wrote the fork: it is resumed');
  assert.ok(!resume.includes('--fork-session'), 'and not forked a third time');
  assert.ok(!resume.includes('--session-id'));
}

describe('session: a fork Claude wrote but no turn completed in is resumed, not forked again (already in use)', () => {
  it('tangent: its first line crashed the child; the respawn re-forks main, is refused, and resumes the tangent (the crashed line stays in it)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const ui = recordingUI();
    const s = await open(sb, {}, ui);
    try {
      await drain(s.prompt({ text: 'main ALPHA' }));
      const main = s.claudeSessionId!;
      await s.enterTangent('side');
      const tangent = s.claudeSessionId!;
      assert.notEqual(tangent, main);
      assert.deepEqual(s.forkSource(), { from: main }, 'precondition: the tangent is a pending fork');
      const crashed = await drain(s.prompt({ text: 'crash me BETA' }));
      assert.equal(crashed.result.isError, true, 'the child died mid-turn');
      assert.match(transcriptOf(sb, tangent), /crash me BETA/, 'precondition: Claude wrote the fork with its first line');
      assert.deepEqual(s.forkSource(), { from: main }, 'precondition: no turn completed in it, so it is still pending');
      const startsBefore = sb.starts().length;
      const { result } = await drain(s.prompt({ text: 'after GAMMA' }));
      assertReforkBecameResume(sb, startsBefore, main, tangent);
      assert.equal(result.isError, false, result.error);
      assert.equal(result.text, 'hist=[main ALPHA | crash me BETA | after GAMMA]', 'the fork Claude wrote, not a fresh copy of main');
      assert.equal(s.claudeSessionId, tangent);
      assert.deepEqual(s.forkSource(), { from: tangent }, 'a turn completed: no longer a pending fork');
      assert.ok(!ui.notices.some((n) => /could not find the saved conversation/i.test(n.message)), 'no journal fallback');
    } finally {
      await closeAll(s);
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('tangent whose source transcript is gone by the respawn: the in-use check comes first, so the tangent is resumed (no journal fallback)', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const ui = recordingUI();
    const s = await open(sb, {}, ui);
    try {
      await drain(s.prompt({ text: 'main ALPHA' }));
      const main = s.claudeSessionId!;
      await s.enterTangent('side');
      const tangent = s.claudeSessionId!;
      const crashed = await drain(s.prompt({ text: 'crash me BETA' }));
      assert.equal(crashed.result.isError, true, 'the child died mid-turn');
      assert.match(transcriptOf(sb, tangent), /crash me BETA/, 'precondition: Claude wrote the fork with its first line');
      const mainFile = path.join(sb.claudeConfig, 'projects', sb.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${main}.jsonl`);
      fs.rmSync(mainFile);
      const startsBefore = sb.starts().length;
      const { result } = await drain(s.prompt({ text: 'after GAMMA' }));
      assertReforkBecameResume(sb, startsBefore, main, tangent);
      assert.equal(result.isError, false, result.error);
      assert.equal(result.text, 'hist=[main ALPHA | crash me BETA | after GAMMA]', 'the fork Claude wrote, not a new conversation');
      assert.ok(!ui.notices.some((n) => /could not find the saved conversation/i.test(n.message)), 'no journal fallback');
      assert.ok(!fs.existsSync(mainFile), 'the source was not recreated');
    } finally {
      await closeAll(s);
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('spec-phase fork (create({fork})): the same on the respawn', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const parent = await open(sb);
    let f: KiroSessionImpl | undefined;
    try {
      await drain(parent.prompt({ text: 'main ALPHA' }));
      const main = parent.claudeSessionId!;
      f = await specForkOf(sb, parent);
      const forkId = f.claudeSessionId!;
      const crashed = await drain(f.prompt({ text: 'crash me PHASE' }));
      assert.equal(crashed.result.isError, true);
      assert.match(transcriptOf(sb, forkId), /crash me PHASE/, 'precondition: Claude wrote the fork');
      const startsBefore = sb.starts().length;
      const { result } = await drain(f.prompt({ text: 'phase again' }));
      assertReforkBecameResume(sb, startsBefore, main, forkId);
      assert.equal(result.text, 'hist=[main ALPHA | crash me PHASE | phase again]');
      assert.equal(new SessionStore(sb.sessionsDir).read(f.id)?.pendingFork, undefined, 'the record names no pending fork any more');
    } finally {
      await closeAll(f, parent);
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('S3: a /rewind fork whose first line crashed, quit and resumed by id: the re-fork at the rewind point is refused and the fork is resumed', async () => {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const s = await open(sb);
    let g: KiroSessionImpl | undefined;
    try {
      await drain(s.prompt({ text: 'main ALPHA' }));
      await drain(s.prompt({ text: 'main REWOUND' }));
      const main = s.claudeSessionId!;
      const point = s.record.turns[0]!.assistantUuid!;
      await s.rewind(1);
      const id = s.id;
      const forkId = s.claudeSessionId!;
      assert.notEqual(forkId, main);
      const crashed = await drain(s.prompt({ text: 'crash me QUIT' }));
      assert.equal(crashed.result.isError, true);
      await closeAll(s);
      const saved = new SessionStore(sb.sessionsDir).read(id);
      assert.deepEqual(saved?.pendingFork, { from: main, at: point }, 'precondition: the record still names its fork source and point');
      assert.match(transcriptOf(sb, forkId), /crash me QUIT/, 'precondition: Claude wrote the fork');
      const startsBefore = sb.starts().length;
      g = await open(sb, { resume: { sessionId: id } });
      const { result } = await drain(g.prompt({ text: 'resumed' }));
      assertReforkBecameResume(sb, startsBefore, main, forkId);
      assert.equal(flagValue(sb.starts()[startsBefore]!, '--resume-session-at'), point, 'the re-fork named the rewind point');
      assert.equal(result.text, 'hist=[main ALPHA | crash me QUIT | resumed]', 'the fork Claude wrote (the rewound turn stays away)');
      assert.equal(g.claudeSessionId, forkId);
      assert.equal(new SessionStore(sb.sessionsDir).read(id)?.pendingFork, undefined, 'no pending fork any more');
    } finally {
      await closeAll(g, s);
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });
});
