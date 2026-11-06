/**
 * Tests of the fake-claude test double itself (test/fixtures/fake-claude.mjs), exercised
 * through ClaudeProcess and the transcript utilities, since every later suite relies on it.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { ClaudeProcess, ClaudeProcessError } from '../../src/claude/process.js';
import { isUserFrame, type SystemInitFrame } from '../../src/claude/protocol.js';
import { findTranscript, readTranscript, rewriteTranscriptSessionId, transcriptPath } from '../../src/claude/transcript.js';
import { collectTurn, mkTmp, startFake, type FakeHandle, type StartFakeOptions } from './helpers.js';

const open: ClaudeProcess[] = [];
async function fake(opts: StartFakeOptions = {}): Promise<FakeHandle> {
  const h = await startFake(opts);
  open.push(h.proc);
  return h;
}
after(async () => {
  await Promise.all(open.map((p) => p.close({ graceMs: 200 }).catch(() => undefined)));
});

const SID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const SID2 = '6ba7b811-9dad-41d1-80b4-00c04fd430c8';
const COUNT = { default: { steps: [{ text: 'history={{historyCount}} [{{historyUserTexts}}]' }] } };

function persistEnv(cfg: string): Record<string, string> {
  return { FAKE_CLAUDE_PERSIST: '1', CLAUDE_CONFIG_DIR: cfg };
}

describe('fake-claude persistence (--session-id / --resume / --fork-session / --resume-session-at)', () => {
  const cfg = mkTmp('kc-fake-cfg-');
  const cwd = fs.realpathSync(mkTmp('kc-fake-cwd-'));
  const env = { CLAUDE_CONFIG_DIR: cfg };
  let firstAssistantUuid = '';

  it('writes a transcript where transcript.ts expects it', async () => {
    const h = await fake({ cwd, args: ['--session-id', SID], env: persistEnv(cfg), script: COUNT });
    const r1 = await collectTurn(h.proc.turn('alpha'));
    assert.equal(r1.result.result, 'history=1 [alpha]');
    firstAssistantUuid = r1.frames.find((f) => f.type === 'assistant')!.uuid!;
    const r2 = await collectTurn(h.proc.turn('beta'));
    assert.equal(r2.result.result, 'history=2 [alpha | beta]');
    await h.proc.close();
    const file = transcriptPath(SID, cwd, env);
    assert.ok(fs.existsSync(file), file);
    assert.equal(findTranscript(SID, { cwd, env }), file);
    const lines = readTranscript(file) as Array<{ type: string; sessionId: string; uuid: string }>;
    assert.deepEqual(lines.map((l) => l.type), ['user', 'assistant', 'user', 'assistant']);
    assert.ok(lines.every((l) => l.sessionId === SID));
    const userUuids = h.stdinLines().filter((l) => l.type === 'user').map((l) => l.uuid);
    assert.deepEqual([lines[0]!.uuid, lines[2]!.uuid], userUuids, 'user line uuid = the uuid we sent (00 §3.10)');
  });

  it('--session-id with an existing id fails like the real CLI', async () => {
    await assert.rejects(
      startFake({ cwd, args: ['--session-id', SID], env: persistEnv(cfg) }),
      (e: unknown) => e instanceof ClaudeProcessError && /Session ID .* is already in use/.test(e.stderr) && e.exitCode === 1,
    );
  });

  it('--resume keeps the id and the history', async () => {
    const h = await fake({ cwd, args: ['--resume', SID], env: persistEnv(cfg), script: COUNT });
    const r = await collectTurn(h.proc.turn('gamma'));
    assert.equal(r.result.result, 'history=3 [alpha | beta | gamma]');
    assert.equal(r.result.session_id, SID);
    await h.proc.close();
  });

  it('--resume of an unknown id fails with "No conversation found"', async () => {
    await assert.rejects(
      startFake({ cwd, args: ['--resume', '00000000-0000-4000-8000-000000000000'], env: persistEnv(cfg) }),
      (e: unknown) => e instanceof ClaudeProcessError && /No conversation found with session ID/.test(e.stderr),
    );
  });

  it('--fork-session copies history under a new id and leaves the original untouched', async () => {
    const before = fs.readFileSync(transcriptPath(SID, cwd, env), 'utf8');
    const h = await fake({ cwd, args: ['--resume', SID, '--fork-session'], env: persistEnv(cfg), script: COUNT });
    const r = await collectTurn(h.proc.turn('delta'));
    assert.equal(r.result.result, 'history=4 [alpha | beta | gamma | delta]');
    assert.notEqual(h.proc.sessionId, SID);
    await h.proc.close();
    assert.equal(fs.readFileSync(transcriptPath(SID, cwd, env), 'utf8'), before);
    assert.ok(findTranscript(h.proc.sessionId!, { cwd, env }));
  });

  it('--resume-session-at truncates after that message (inclusive)', async () => {
    const h = await fake({
      cwd,
      args: ['--resume', SID, '--resume-session-at', firstAssistantUuid, '--fork-session'],
      env: persistEnv(cfg),
      script: COUNT,
    });
    const r = await collectTurn(h.proc.turn('rewound'));
    assert.equal(r.result.result, 'history=2 [alpha | rewound]');
  });

  it('a transcript re-keyed with rewriteTranscriptSessionId can be resumed (/chat load flow)', async () => {
    const text = fs.readFileSync(transcriptPath(SID, cwd, env), 'utf8');
    const target = transcriptPath(SID2, cwd, env);
    fs.writeFileSync(target, rewriteTranscriptSessionId(text, SID2));
    const h = await fake({ cwd, args: ['--resume', SID2], env: persistEnv(cfg), script: COUNT });
    const r = await collectTurn(h.proc.turn('loaded'));
    assert.equal(r.result.result, 'history=4 [alpha | beta | gamma | loaded]');
    assert.equal(r.result.session_id, SID2);
  });

  it('/clear starts a new transcript', async () => {
    const h = await fake({ cwd, args: ['--resume', SID], env: persistEnv(cfg), script: COUNT });
    await collectTurn(h.proc.turn('/clear'));
    const r = await collectTurn(h.proc.turn('fresh'));
    assert.equal(r.result.result, 'history=1 [fresh]');
    await h.proc.close();
    assert.ok(findTranscript(h.proc.sessionId!, { cwd, env }));
  });
});

describe('fake-claude argument validation', () => {
  const cases: Array<[string, string[], RegExp]> = [
    ['unknown option', ['--no-optional-locks'], /unknown option '--no-optional-locks'/],
    ['bad permission mode', ['--permission-mode', 'bogus'], /argument 'bogus' is invalid/],
    ['bad effort', ['--effort', 'turbo'], /argument 'turbo' is invalid/],
    ['resume-session-at without resume', ['--resume-session-at', SID], /requires --resume/],
    ['invalid session id', ['--session-id', 'abc'], /Invalid session ID/],
    ['bad setting source', ['--setting-sources', 'user,bogus'], /Invalid setting source/],
  ];
  for (const [name, args, re] of cases) {
    it(name, async () => {
      await assert.rejects(startFake({ args }), (e: unknown) => e instanceof ClaudeProcessError && re.test(e.stderr));
    });
  }

  it('accepts the full 00 §3.1 launch argv', async () => {
    const h = await fake({
      args: [
        '--include-partial-messages', '--permission-mode', 'default', '--setting-sources', '', '--strict-mcp-config',
        '--mcp-config', JSON.stringify({ mcpServers: { s: { command: 'x', fakeTools: ['t1', 't2'] } } }),
        '--tools', 'Read,Glob,Grep,Write,Edit,NotebookEdit,Bash,WebFetch,WebSearch,Agent,TaskCreate,TaskUpdate,TaskList,TaskGet',
        '--disallowedTools', 'mcp__s__t2', '--append-system-prompt-file', '/tmp/ctx.md', '--system-prompt-snapshot', 'off',
        '--model', 'sonnet', '--effort', 'high', '--agents', '{}', '--add-dir', '/tmp/a', '--add-dir', '/tmp/b',
        '--session-id', SID,
      ],
    });
    const { frames } = await collectTurn(h.proc.turn('x'));
    const init = frames.find((f) => f.type === 'system') as SystemInitFrame;
    assert.equal(init.model, 'claude-sonnet-5-5');
    assert.equal(init.permissionMode, 'default');
    assert.equal(init.apiKeySource, 'none');
    assert.deepEqual(init.tools, [
      'Task', 'Bash', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskStop',
      'TaskUpdate', 'WebFetch', 'WebSearch', 'Write', 'mcp__s__t1',
    ]);
    assert.deepEqual(init.mcp_servers, [{ name: 's', status: 'connected', source: 'dynamic' }]);
  });

  it('--tools "" means no tools; ANTHROPIC_API_KEY shows in apiKeySource', async () => {
    const h = await fake({ args: ['--tools', ''], env: { ANTHROPIC_API_KEY: 'sk-test' } });
    const { frames } = await collectTurn(h.proc.turn('x'));
    const init = frames.find((f) => f.type === 'system') as SystemInitFrame;
    assert.deepEqual(init.tools, []);
    assert.equal(init.apiKeySource, 'ANTHROPIC_API_KEY');
  });
});

describe('fake-claude scripting', () => {
  it('match regexes pick turns; unmatched turns stay available; repeat is reusable', async () => {
    const h = await fake({
      script: {
        turns: [
          { match: '^deploy', steps: [{ text: 'deploying' }] },
          { match: 'status', flags: 'i', repeat: true, steps: [{ text: 'green' }] },
          { steps: [{ text: 'first generic' }] },
        ],
        default: { steps: [{ text: 'fallback' }] },
      },
    });
    const say = async (t: string): Promise<string | undefined> => (await collectTurn(h.proc.turn(t))).result.result;
    assert.equal(await say('hello'), 'first generic');
    assert.equal(await say('STATUS?'), 'green');
    assert.equal(await say('status again'), 'green');
    assert.equal(await say('deploy now'), 'deploying');
    assert.equal(await say('deploy again'), 'fallback');
  });

  it('FAKE_CLAUDE_STATE_FILE carries consumed turns across processes', async () => {
    const state = path.join(mkTmp(), 'state.json');
    const script = { turns: [{ steps: [{ text: 'one' }] }, { steps: [{ text: 'two' }] }] };
    const a = await fake({ script, env: { FAKE_CLAUDE_STATE_FILE: state } });
    assert.equal((await collectTurn(a.proc.turn('x'))).result.result, 'one');
    await a.proc.close();
    const b = await fake({ script, env: { FAKE_CLAUDE_STATE_FILE: state } });
    assert.equal((await collectTurn(b.proc.turn('x'))).result.result, 'two');
  });

  it('--max-turns stops with error_max_turns', async () => {
    const h = await fake({
      args: ['--max-turns', '1'],
      script: { default: { steps: [{ tool: { name: 'Read', input: { file_path: '/a' } } }, { text: 'never' }] } },
    });
    const { result } = await collectTurn(h.proc.turn('x'));
    assert.equal(result.subtype, 'error_max_turns');
    assert.equal(result.is_error, true);
  });

  it('result overrides and --replay-user-messages', async () => {
    const h = await fake({
      args: ['--replay-user-messages'],
      script: { default: { steps: [{ text: 'hi' }, { result: { stop_reason: 'refusal', total_cost_usd: 1.5 } }] } },
    });
    const { frames, result } = await collectTurn(h.proc.turn('echo me'));
    assert.equal(result.stop_reason, 'refusal');
    assert.equal(result.total_cost_usd, 1.5);
    assert.ok(frames.some((f) => isUserFrame(f) && f.isReplay === true));
  });

  it('logs argv, an env subset and stdin lines to FAKE_CLAUDE_LOG', async () => {
    const h = await fake({ args: ['--model', 'haiku'], env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', ANTHROPIC_API_KEY: 'secret' } });
    await collectTurn(h.proc.turn('logged'));
    const start = h.log().find((e) => e.event === 'start') as { argv: string[]; env: Record<string, string> };
    assert.ok(start.argv.includes('--model'));
    assert.equal(start.env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
    assert.equal(start.env.ANTHROPIC_API_KEY, '<set>', 'secrets are masked');
    assert.ok(h.stdinLines().some((l) => l.type === 'user'));
  });
});
