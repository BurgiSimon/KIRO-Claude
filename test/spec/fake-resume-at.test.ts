/**
 * The fake (test/fixtures/fake-claude.mjs) answers `--resume X --resume-session-at <uuid>` for a
 * uuid X's transcript does not hold the way the real claude 2.1.319 does (VERIFIED; the binary's
 * resume path: `No message found with message.uuid of: <uuid>` through the same error path as
 * `No conversation found`, exit 1), with or without `--fork-session`: stderr names the uuid, stdout
 * carries one `error_during_execution` result, the exit code is 1, and nothing is written. Before,
 * the fake kept the full history, so a stock-fake `/rewind` to a turn saved before a fallback to a
 * fresh Claude session brought the rewound turns back, which the real claude never does.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { ClaudeProcess } from '../../src/claude/process.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { collectTurn, fakeEnv, mkTmp, startFake, STREAM_ARGS } from '../claude/helpers.js';
import { closeAll, drain, fakeBinary, fakeCaps, fakeClaudePath, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from '../session/helpers.js';

const SID = '0f4e2a10-7c1d-4b2e-9a3f-5d6c7b8a9e01';
const BOGUS = '11111111-2222-4333-8444-555555555555';
const COUNT = { default: { steps: [{ text: 'history={{historyCount}} [{{historyUserTexts}}]' }] } };

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
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

describe('fake-claude: --resume-session-at a message the transcript does not hold (real claude 2.1.319)', () => {
  const cfg = mkTmp('kc-spec-fake-cfg-');
  const cwd = fs.realpathSync(mkTmp('kc-spec-fake-cwd-'));
  const env = fakeEnv({ FAKE_CLAUDE_PERSIST: '1', CLAUDE_CONFIG_DIR: cfg });
  const projectDir = path.join(cfg, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  let firstAssistantUuid = '';
  let transcriptBefore = '';
  const open: ClaudeProcess[] = [];

  before(async () => {
    const h = await startFake({ cwd, args: ['--session-id', SID], env: { FAKE_CLAUDE_PERSIST: '1', CLAUDE_CONFIG_DIR: cfg }, script: COUNT });
    open.push(h.proc);
    const r1 = await collectTurn(h.proc.turn('alpha'));
    firstAssistantUuid = r1.frames.find((f) => f.type === 'assistant')!.uuid!;
    await collectTurn(h.proc.turn('beta'));
    await h.proc.close();
    transcriptBefore = fs.readFileSync(path.join(projectDir, `${SID}.jsonl`), 'utf8');
  });
  after(async () => {
    await Promise.all(open.map((p) => p.close({ graceMs: 200 }).catch(() => undefined)));
    fs.rmSync(cfg, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  for (const fork of [true, false]) {
    it(`${fork ? 'with' : 'without'} --fork-session: stderr 'No message found…', an error_during_execution result, exit 1, nothing written`, async () => {
      const r = await runFake(['--resume', SID, '--resume-session-at', BOGUS, ...(fork ? ['--fork-session'] : [])], cwd, env);
      const msg = `No message found with message.uuid of: ${BOGUS}`;
      assert.equal(r.code, 1, `exit code (stderr: ${JSON.stringify(r.stderr.slice(0, 200))})`);
      assert.match(r.stderr, new RegExp(`^${msg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      const frames = r.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.equal(frames.length, 1, `one result frame on stdout: ${r.stdout.slice(0, 300)}`);
      const res = frames[0]!;
      assert.equal(res.type, 'result');
      assert.equal(res.subtype, 'error_during_execution');
      assert.equal(res.is_error, true);
      assert.deepEqual(res.errors, [msg]);
      assert.deepEqual(fs.readdirSync(projectDir).sort(), [`${SID}.jsonl`], 'no transcript was written');
      assert.equal(fs.readFileSync(path.join(projectDir, `${SID}.jsonl`), 'utf8'), transcriptBefore, 'the source transcript is untouched');
    });
  }

  it('control: a uuid the transcript holds still cuts the history after it (inclusive)', async () => {
    const h = await startFake({
      cwd,
      args: ['--resume', SID, '--resume-session-at', firstAssistantUuid, '--fork-session'],
      env: { FAKE_CLAUDE_PERSIST: '1', CLAUDE_CONFIG_DIR: cfg },
      script: COUNT,
    });
    open.push(h.proc);
    const r = await collectTurn(h.proc.turn('rewound'));
    assert.equal(r.result.result, 'history=2 [alpha | rewound]');
  });

  it('control: a missing transcript still reports No conversation found first', async () => {
    const r = await runFake(['--resume', '22222222-3333-4444-8555-666666666666', '--resume-session-at', BOGUS], cwd, env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No conversation found with session ID: 22222222-/);
    assert.doesNotMatch(r.stderr, /No message found/);
  });

  it('without persistence --resume-session-at is accepted (no transcript to cut)', async () => {
    const h = await startFake({ cwd, args: ['--resume', SID, '--resume-session-at', BOGUS], script: COUNT });
    open.push(h.proc);
    const r = await collectTurn(h.proc.turn('hi'));
    assert.equal(r.result.result, 'history=1 [hi]');
  });
});

// ───────── the flow the stock fake got wrong: /rewind to a turn saved before a fallback ─────────

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

function contentText(line: Record<string, unknown>): string {
  const c = (line.message as { content: unknown }).content;
  if (typeof c === 'string') return c;
  return (c as { type: string; text?: string }[]).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');
}

describe('stock fake: /rewind after a fallback to a fresh Claude session (as the real claude)', () => {
  it('/rewind 1: turn 1 is the restored history; the rewound-away turns 2 and 3 never come back', async () => {
    const sb: Sandbox = mkSandbox({ script: { default: { steps: [{ text: 'hist={{historyUserTexts}}' }] } }, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const base = (ui: RecordingUI): KiroSessionInternalOptions => ({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env });
    const first = await KiroSessionImpl.create(base(recordingUI()));
    let id: string;
    try {
      await drain(first.prompt({ text: 'first ALPHA_1' }));
      await drain(first.prompt({ text: 'second BETA_2' }));
      id = first.id;
    } finally {
      await closeAll(first);
    }
    fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });
    const ui = recordingUI();
    const s = await KiroSessionImpl.create({ ...base(ui), resume: { sessionId: id } });
    try {
      assert.ok(ui.notices.some((n) => /could not find the saved conversation/i.test(n.message)), 'precondition: the resume fell back');
      await drain(s.prompt({ text: 'third GAMMA_3' }));
      const starts = sb.starts().length;
      await s.rewind(1);
      const { result } = await drain(s.prompt({ text: 'after rewind' }));
      const forkArgv = sb.starts().slice(starts).find((a) => a.includes('--resume-session-at'));
      assert.ok(forkArgv, 'the rewind tried the fork at the saved uuid');
      assert.doesNotMatch(result.text, /BETA_2|GAMMA_3/, `the rewound turns came back: ${result.text}`);
      const sent = contentText(sb.userLines().at(-1)!);
      assert.match(sent, /ALPHA_1/, 'turn 1 is kept, as the restored history');
      assert.doesNotMatch(sent, /BETA_2|GAMMA_3/, 'nor are they sent as history');
    } finally {
      await closeAll(s);
      fs.rmSync(sb.root, { recursive: true, force: true });
    }
  });
});
