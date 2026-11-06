import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { AGENT_ENGINE_V3_ERROR, parseTrustTools, resolveSessionId, runChatCommand, type ChatDeps } from '../../src/cli/commands/chat.js';
import { CHAT_DEF } from '../../src/cli/commands/chatArgs.js';
import { renderHelp } from '../../src/cli/args.js';
import { writeModelCache } from '../../src/models/models.js';
import { SessionStore, sessionsDir } from '../../src/session/store.js';
import type { CliContext } from '../../src/types.js';
import type { FrontEndSessionOptions } from '../../src/cli/entries.js';
import { HEADLESS_USAGE_TEXT } from '../../src/headless/local.js';
import { makeCtx, makeEnv, run, type TestEnv } from './helpers.js';

let t: TestEnv;
beforeEach(() => {
  t = makeEnv();
});
afterEach(() => t.cleanup());

interface Recorded {
  repl: Array<{ sessionOptions: FrontEndSessionOptions; initialInput?: string; wrap?: string }>;
  headless: Array<{ sessionOptions: FrontEndSessionOptions; input: string; outputFormat?: string; requireMcpStartup?: boolean }>;
}

function deps(): { deps: ChatDeps; rec: Recorded } {
  const rec: Recorded = { repl: [], headless: [] };
  return {
    rec,
    deps: {
      runRepl: async (o) => {
        rec.repl.push({ sessionOptions: o.sessionOptions, ...(o.initialInput !== undefined ? { initialInput: o.initialInput } : {}), ...(o.wrap ? { wrap: o.wrap } : {}) });
        return 0;
      },
      runHeadless: async (o) => {
        rec.headless.push({
          sessionOptions: o.sessionOptions,
          input: o.input,
          ...(o.outputFormat ? { outputFormat: o.outputFormat } : {}),
          ...(o.requireMcpStartup ? { requireMcpStartup: true } : {}),
        });
        return 0;
      },
    },
  };
}

async function chat(args: string[], opts: { stdin?: string; ctx?: CliContext } = {}) {
  const { ctx, stdout, stderr } = makeCtx(t, opts.stdin !== undefined ? { stdin: opts.stdin } : {});
  const d = deps();
  const code = await runChatCommand(args, opts.ctx ?? ctx, d.deps);
  return { code, stdout: stdout.text, stderr: stderr.text, rec: d.rec };
}

function writeAgent(name: string, body: object, scope: 'global' | 'workspace' = 'global'): string {
  const dir = scope === 'global' ? path.join(t.kiroHome, 'agents') : path.join(t.cwd, '.kiro', 'agents');
  return t.write(path.join(dir, `${name}.json`), body);
}

test('chat --help: KiroCrew-parsable --agent-engine block, no v3 anywhere', async () => {
  const r = await chat(['--help']);
  assert.equal(r.code, 0);
  const text = r.stdout;
  // KiroCrew kiro_cli.chat_agent_engines()
  const at = text.indexOf('--agent-engine');
  assert.ok(at > 0);
  const end = text.indexOf('\n      --', at + 1);
  const block = text.slice(at, end > 0 ? end : undefined);
  const m = /\[possible values:\s*([^\]]*)\]/.exec(block);
  assert.ok(m);
  assert.deepEqual(m[1]!.split(',').map((s) => s.trim()), ['v1', 'v2']);
  assert.ok(!text.includes('v3'));
  assert.ok(text.includes('      --agent-engine <ENGINE>\n          Agent harness (accepted for compatibility; kiro-claude has one engine)\n\n          [possible values: v1, v2]\n'));
  assert.ok(text.startsWith('AI assistant in your terminal\n\nUsage: kiro-claude chat [OPTIONS] [INPUT]\n'));
  for (const hidden of ['--v2', '--tui', '--classic', '--legacy-ui', '--cloud', '--sandbox', '--profile', '--non-interactive']) {
    assert.ok(!text.includes(`${hidden}\n`) && !text.includes(`${hidden} `), hidden);
  }
  const short = await chat(['-h']);
  assert.ok(!short.stdout.includes('v3'));
  assert.match(short.stdout, /--agent-engine <ENGINE> +Agent harness .*\[possible values: v1, v2\]/);
});

test('--agent-engine v3 is rejected with the 08 wording, exit 2; v1/v2 accepted', async () => {
  for (const args of [['--agent-engine', 'v3'], ['--agent-engine=v3', 'hi']]) {
    const r = await chat(args);
    assert.equal(r.code, 2);
    assert.equal(r.stderr, `${AGENT_ENGINE_V3_ERROR}\n`);
  }
  assert.equal(AGENT_ENGINE_V3_ERROR, "error: invalid value 'v3' for '--agent-engine <ENGINE>'\n  [possible values: v1, v2]\n\nkiro-claude has no v3 (KAS) agent engine.");
  const ok = await chat(['--agent-engine', 'v2', '--no-interactive', 'hi']);
  assert.equal(ok.code, 0);
  assert.equal(ok.rec.headless.length, 1);
  const bad = await chat(['--agent-engine', 'v9']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /invalid value 'v9' for '--agent-engine <ENGINE>'/);
  const conflict = await chat(['--v2', '--v3']);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /the argument '--v2' cannot be used with '--v3'/);
});

test('unknown flag ⇒ clap error, exit 2', async () => {
  const r = await chat(['--agnt', 'x']);
  assert.equal(r.code, 2);
  assert.equal(
    r.stderr,
    "error: unexpected argument '--agnt' found\n\n  tip: a similar argument exists: '--agent'\n\nUsage: kiro-claude chat [OPTIONS] [INPUT]\n\nFor more information, try '--help'.\n",
  );
});

test('--list-models --format json: one JSON object {models:[…]} (static fallback)', async () => {
  for (const args of [
    ['--list-models', '--format', 'json', '--no-interactive'],
    ['--no-interactive', '--format=json', '--list-models'],
    ['--list-models', '-f', 'json-pretty'],
  ]) {
    const r = await chat(args);
    assert.equal(r.code, 0, args.join(' '));
    const d = JSON.parse(r.stdout) as { models: Array<Record<string, unknown>> };
    assert.ok(d && typeof d === 'object' && !Array.isArray(d));
    assert.ok(Array.isArray(d.models) && d.models.length > 0);
    const ids = d.models.map((m) => m.model_id);
    for (const id of ['auto', 'claude-opus-5.5', 'claude-sonnet-5.5', 'claude-haiku-5.5', 'claude-fable-5.1']) assert.ok(ids.includes(id), id);
    for (const m of d.models) {
      assert.equal(m.model_name, m.model_id);
      assert.equal(typeof m.description, 'string');
      assert.ok(Number.isInteger(m.context_window_tokens) && (m.context_window_tokens as number) > 0);
      assert.equal(m.rate_multiplier, 1);
    }
    assert.equal(r.rec.headless.length + r.rec.repl.length, 0);
  }
  assert.ok(!fs.existsSync(t.fakeLog), 'claude must not be spawned');
});

test('--list-models uses the model cache when present; plain format', async () => {
  writeModelCache(
    {
      models: [
        { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus' },
        { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Fast' },
      ],
      contextWindows: { 'claude-haiku-5.5': 200000 },
    },
    t.env,
  );
  const r = await chat(['--list-models', '--format', 'json']);
  const d = JSON.parse(r.stdout) as { models: Array<{ model_id: string; context_window_tokens: number }> };
  assert.deepEqual(d.models.map((m) => m.model_id), ['auto', 'claude-haiku-5.5']);
  assert.equal(d.models[1]!.context_window_tokens, 200000);
  const p = await chat(['--list-models']);
  assert.match(p.stdout, /^\* auto +Default \(recommended\) +1M +Opus\n {2}claude-haiku-5\.5 +Haiku +200K +Fast\n$/);
});

test('--list-sessions / --delete-session', async () => {
  const store = new SessionStore(sessionsDir(makeCtx(t).ctx.ws));
  const empty = await chat(['--list-sessions']);
  assert.equal(empty.stdout, 'No saved chat sessions for this directory.\n');
  const rec = store.create({ origin: 'repl', cwd: t.cwd, agent: 'kiro_default', model: 'auto', title: 'fix the build' });
  store.create({ origin: 'repl', cwd: t.root, agent: 'kiro_default', model: 'auto', title: 'elsewhere' });
  const plain = await chat(['--list-sessions']);
  assert.match(plain.stdout, new RegExp(`^${rec.sessionId}  \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}  0 messages  fix the build\\n$`));
  const json = await chat(['--list-sessions', '--format', 'json']);
  const rows = JSON.parse(json.stdout) as Array<{ sessionId: string }>;
  assert.deepEqual(rows.map((x) => x.sessionId), [rec.sessionId]);
  const pretty = await chat(['--list-sessions', '-f', 'json-pretty']);
  assert.ok(pretty.stdout.includes('\n  {\n'));
  const del = await chat(['--delete-session', rec.sessionId]);
  assert.equal(del.code, 0);
  assert.equal(del.stdout, `Deleted chat session ${rec.sessionId}\n`);
  assert.equal(store.read(rec.sessionId), undefined);
  const again = await chat(['--delete-session', rec.sessionId]);
  assert.equal(again.code, 1);
  assert.equal(again.stderr, `error: no saved chat session with id '${rec.sessionId}'\n`);
});

test('interactive ⇒ runRepl with resolved agent, input, wrap; headless ⇒ runHeadless', async () => {
  const r = await chat(['-w', 'never', 'hello there']);
  assert.equal(r.code, 0);
  assert.equal(r.rec.repl.length, 1);
  assert.equal(r.rec.repl[0]!.initialInput, 'hello there');
  assert.equal(r.rec.repl[0]!.wrap, 'never');
  assert.equal(r.rec.repl[0]!.sessionOptions.agentName, 'kiro_default');
  assert.equal(r.rec.repl[0]!.sessionOptions.env, t.env);

  const h = await chat(['--no-interactive', '--output-format', 'stream-json', '--require-mcp-startup', '-a', '--model', 'claude-sonnet-5.5', '--effort', 'high', 'do it']);
  assert.equal(h.code, 0);
  const o = h.rec.headless[0]!;
  assert.equal(o.input, 'do it');
  assert.equal(o.outputFormat, 'stream-json');
  assert.equal(o.requireMcpStartup, true);
  assert.equal(o.sessionOptions.trustAllTools, true);
  assert.equal(o.sessionOptions.model, 'claude-sonnet-5.5');
  assert.equal(o.sessionOptions.effort, 'high');
  const absent = await chat(['--no-interactive']);
  assert.equal(absent.rec.headless[0]!.input, '');
  const nonint = await chat(['--non-interactive', 'x']);
  assert.equal(nonint.rec.headless.length, 1);
});

test('agent selection: missing --agent in --no-interactive ⇒ exit 4; interactive falls back with Q text', async () => {
  const h = await chat(['--no-interactive', '--agent', 'ghost', 'hi']);
  assert.equal(h.code, 4);
  assert.equal(h.stderr, 'Error: no agent with name ghost found\nstopping (exit 4)\n');
  assert.equal(h.rec.headless.length, 0);

  const i = await chat(['--agent', 'ghost']);
  assert.equal(i.code, 0);
  assert.match(i.stderr, /Error: no agent with name ghost found\. Falling back to user specified default/);
  assert.equal(i.rec.repl[0]!.sessionOptions.agentName, 'kiro_default');

  writeAgent('dev', { name: 'dev', tools: ['*'] });
  const ok = await chat(['--no-interactive', '--agent', 'dev', 'hi']);
  assert.equal(ok.code, 0);
  assert.equal(ok.rec.headless[0]!.sessionOptions.agentName, 'dev');

  const ws = writeAgent('dev', { name: 'dev', tools: ['read'] }, 'workspace');
  assert.ok(fs.existsSync(ws));
  const both = await chat(['--agent', 'dev']);
  assert.equal(both.rec.repl[0]!.sessionOptions.agentName, 'dev');
});

test('missing chat.defaultAgent: exit 4 on a fresh headless run; broken agent file names its reason', async () => {
  const { ctx } = makeCtx(t);
  ctx.settings.set('chat.defaultAgent', 'nobody');
  const h = await chat(['--no-interactive', 'hi']);
  assert.equal(h.code, 4);
  assert.match(h.stderr, /no agent with name nobody found\nstopping \(exit 4\)/);

  t.write(path.join(t.kiroHome, 'agents', 'broken.json'), '{ "name": ');
  const b = await chat(['--no-interactive', '--agent', 'broken', 'hi']);
  assert.equal(b.code, 4);
  assert.match(b.stderr, /^Error: agent broken could not be loaded: Json supplied at .*broken\.json is invalid: /);
});

test('/usage in headless is answered before agent resolution (KiroCrew probe)', async () => {
  const { ctx, stdout, stderr } = makeCtx(t, { stdin: '' });
  const code = await runChatCommand(['--no-interactive', '--agent-engine', 'v2', '--agent', 'kirocrew-lite', '/usage'], ctx);
  assert.equal(code, 0);
  assert.equal(stdout.text, `${HEADLESS_USAGE_TEXT}\n`);
  assert.equal(stderr.text, '');
  assert.ok(!fs.existsSync(t.fakeLog));
});

test('headless local commands read from piped stdin are answered before agent resolution, like INPUT', async () => {
  // a missing agent would stop a model run with exit 4; local answers never need one
  for (const argv of [['--no-interactive', '--agent', 'ghost'], ['--no-interactive', '--agent-engine', 'v2', '--agent', 'kirocrew-lite']]) {
    const { ctx, stdout, stderr } = makeCtx(t, { stdin: '/usage\n' });
    const code = await runChatCommand(argv, ctx);
    assert.equal(code, 0, stderr.text);
    assert.equal(stdout.text, `${HEADLESS_USAGE_TEXT}\n`);
    assert.equal(stderr.text, '');
  }
  const { ctx: c2 } = makeCtx(t);
  c2.settings.set('chat.defaultAgent', 'nobody');
  for (const [input, want] of [['/usage', HEADLESS_USAGE_TEXT], ['/help', 'Commands available with --no-interactive:']] as const) {
    for (const how of ['stdin', 'INPUT'] as const) {
      const { ctx, stdout, stderr } = makeCtx(t, { stdin: how === 'stdin' ? `  ${input}  \n` : '' });
      const code = await runChatCommand(how === 'stdin' ? ['--no-interactive'] : ['--no-interactive', input], ctx);
      assert.equal(code, 0, `${input} via ${how}: ${stderr.text}`);
      assert.ok(stdout.text.startsWith(want), `${input} via ${how}: ${stdout.text}`);
      assert.equal(stderr.text, '', `${input} via ${how}`);
    }
  }
  const { ctx: cq, stdout: oq, stderr: eq } = makeCtx(t, { stdin: '/quit\n' });
  assert.equal(await runChatCommand(['--no-interactive', '--output-format', 'stream-json'], cq), 0, eq.text);
  assert.equal((JSON.parse(oq.text.trim()) as { localCommand: string }).localCommand, '/quit');
  assert.ok(!fs.existsSync(t.fakeLog), 'no claude spawn');
  // a real task from stdin still goes through agent resolution (exit 4) ...
  const h = await chat(['--no-interactive'], { stdin: 'do the thing\n' });
  assert.equal(h.code, 4);
  assert.equal(h.rec.headless.length, 0);
  // ... and reaches the runner as its input once an agent resolves
  c2.settings.set('chat.defaultAgent', 'kiro_default');
  const ok = await chat(['--no-interactive'], { stdin: 'do the thing\n' });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.rec.headless[0]!.input, 'do the thing\n');
});

test('--model: non-Claude ids fail with Q text, exit 1', async () => {
  const r = await chat(['--model', 'gpt-5.6-sol', '--no-interactive', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: Model 'gpt-5\.6-sol' does not exist\. Available models: auto, /);
  for (const m of ['auto', 'sonnet', 'claude-opus-4.8', 'claude-haiku-4-5']) {
    const ok = await chat(['--model', m, '--no-interactive', 'x']);
    assert.equal(ok.code, 0, m);
  }
});

test('--trust-tools parsing and warnings', async () => {
  assert.deepEqual(parseTrustTools(''), { tools: [], warnings: [] });
  assert.deepEqual(parseTrustTools('fs_read, execute_bash ,@git/status,@fetch'), { tools: ['fs_read', 'execute_bash', '@git/status', '@fetch'], warnings: [] });
  assert.deepEqual(parseTrustTools('mytool').warnings, ['WARNING: --trust-tools arg for custom tool mytool needs to be prepended with @{MCPSERVERNAME}/']);
  const none = await chat(['--trust-tools=', '--no-interactive', 'x']);
  assert.deepEqual(none.rec.headless[0]!.sessionOptions.trustTools, []);
  const some = await chat(['--trust-tools', 'read_file,custom', '--no-interactive', 'x']);
  assert.deepEqual(some.rec.headless[0]!.sessionOptions.trustTools, ['read_file', 'custom']);
  assert.match(some.stderr, /custom tool custom needs to be prepended/);
  const absent = await chat(['--no-interactive', 'x']);
  assert.equal(absent.rec.headless[0]!.sessionOptions.trustTools, undefined);
});

test('resume: --resume newest for this cwd, none ⇒ message; --resume-id exact/prefix/unknown', async () => {
  const none = await chat(['--resume', '--no-interactive', 'x']);
  assert.equal(none.code, 0);
  assert.equal(none.stderr, 'No saved chat sessions for this directory. Starting a new session.\n');
  assert.equal(none.rec.headless[0]!.sessionOptions.resume, undefined);

  const store = new SessionStore(sessionsDir(makeCtx(t).ctx.ws));
  const older = store.create({ origin: 'repl', cwd: t.cwd, agent: 'dev', model: 'auto', updatedAt: '2026-01-01T00:00:00.000Z' });
  const newer = store.create({ origin: 'repl', cwd: t.cwd, agent: 'dev', model: 'auto', updatedAt: '2026-06-01T00:00:00.000Z' });
  const r = await chat(['-r', '--no-interactive', 'continue']);
  assert.deepEqual(r.rec.headless[0]!.sessionOptions.resume, { sessionId: newer.sessionId });
  // a resumed session keeps its stored agent unless --agent is given
  assert.equal(r.rec.headless[0]!.sessionOptions.agentName, undefined);

  const byId = await chat(['--resume-id', older.sessionId, '--no-interactive', 'x']);
  assert.deepEqual(byId.rec.headless[0]!.sessionOptions.resume, { sessionId: older.sessionId });
  const prefix = await chat(['--resume-id', older.sessionId.slice(0, 8), '--no-interactive', 'x']);
  assert.equal(prefix.code, 0);
  assert.deepEqual(prefix.rec.headless[0]!.sessionOptions.resume, { sessionId: older.sessionId });
  const unknown = await chat(['--resume-id', 'deadbeef-0000-4000-8000-000000000000', 'x']);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stderr, "error: no saved chat session with id 'deadbeef-0000-4000-8000-000000000000'\n");
  assert.equal(resolveSessionId(store, 'ab').error, "error: no saved chat session with id 'ab'");

  const conflict = await chat(['--resume', '--resume-id', older.sessionId]);
  assert.equal(conflict.code, 2);
});

test('--resume skips newer KiroCrew/ACP sessions in the same directory; --resume-id still opens them', async () => {
  const store = new SessionStore(sessionsDir(makeCtx(t).ctx.ws));
  const acpOnly = store.create({ origin: 'acp', cwd: t.cwd, agent: 'kirocrew', model: 'auto', updatedAt: '2026-03-01T00:00:00.000Z' });
  const onlyAcp = await chat(['--resume', '--no-interactive', 'x']);
  assert.equal(onlyAcp.stderr, 'No saved chat sessions for this directory. Starting a new session.\n');
  assert.equal(onlyAcp.rec.headless[0]!.sessionOptions.resume, undefined);

  const mine = store.create({ origin: 'repl', cwd: t.cwd, agent: 'dev', model: 'auto', updatedAt: '2026-04-01T00:00:00.000Z' });
  store.create({ origin: 'acp', cwd: t.cwd, agent: 'kirocrew', model: 'auto', updatedAt: '2026-09-01T00:00:00.000Z' });
  const r = await chat(['--resume', '--no-interactive', 'continue']);
  assert.deepEqual(r.rec.headless[0]!.sessionOptions.resume, { sessionId: mine.sessionId });

  const byId = await chat(['--resume-id', acpOnly.sessionId, '--no-interactive', 'x']);
  assert.deepEqual(byId.rec.headless[0]!.sessionOptions.resume, { sessionId: acpOnly.sessionId });
});

test('--resume-picker: numbered prompt on stderr, choice from stdin', async () => {
  const store = new SessionStore(sessionsDir(makeCtx(t).ctx.ws));
  const a = store.create({ origin: 'repl', cwd: t.cwd, agent: 'kiro_default', model: 'auto', title: 'first', updatedAt: '2026-01-01T00:00:00.000Z' });
  store.create({ origin: 'repl', cwd: t.cwd, agent: 'kiro_default', model: 'auto', title: 'second', updatedAt: '2026-02-01T00:00:00.000Z' });
  const r = await chat(['--resume-picker'], { stdin: 'x\n2\n' });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /Saved chat sessions for this directory:\n {3}1\) second/);
  assert.match(r.stderr, /Please enter a number between 1 and 2\./);
  assert.deepEqual(r.rec.repl[0]!.sessionOptions.resume, { sessionId: a.sessionId });
  const cancel = await chat(['--resume-picker'], { stdin: '\n' });
  assert.match(cancel.stderr, /No session selected\. Starting a new session\./);
  assert.equal(cancel.rec.repl[0]!.sessionOptions.resume, undefined);
  const headless = await chat(['--resume-picker', '--no-interactive', 'x']);
  assert.equal(headless.code, 1);
});

test('not supported / accepted-and-ignored flags', async () => {
  const cloud = await chat(['--cloud', '--repo', 'o/r']);
  assert.equal(cloud.code, 1);
  assert.match(cloud.stderr, /cloud sessions are not supported/);
  const sandbox = await chat(['--sandbox', '--no-interactive', 'x']);
  assert.equal(sandbox.code, 1);
  const ignored = await chat(['--v2', '--tui', '--classic', '--trust-workspace', '--no-interactive', 'x']);
  assert.equal(ignored.code, 0);
  const prof = await chat(['--profile', 'kiro_default', '--no-interactive', 'x']);
  assert.match(prof.stderr, /WARNING: --profile is deprecated, use --agent instead/);
  assert.equal(prof.rec.headless[0]!.sessionOptions.agentName, 'kiro_default');
  const sj = await chat(['--output-format', 'stream-json', 'x']);
  assert.equal(sj.code, 2);
  const key = await chat(['--use-api-key', '--no-interactive', 'x']);
  assert.equal(key.rec.headless[0]!.sessionOptions.allowApiKey, true);
});

test('KIRO_API_KEY is ignored with a warning', async () => {
  const { ctx, stderr } = makeCtx(t);
  ctx.ws.env.KIRO_API_KEY = 'ksk_secret';
  const r = await chat(['--no-interactive', 'x'], { ctx });
  assert.equal(r.code, 0);
  assert.equal(stderr.text, 'WARNING: KIRO_API_KEY is ignored: kiro-claude uses your Claude Code login\n');
  assert.ok(!stderr.text.includes('ksk_secret'));
});

test('root-level chat flags through runCli (fast paths)', async () => {
  const r = await run(t, ['--list-models', '--format', 'json']);
  assert.equal(r.code, 0);
  assert.ok(Array.isArray((JSON.parse(r.stdout) as { models: unknown[] }).models));
  const u = await run(t, ['--no-interactive', '/usage']);
  assert.equal(u.stdout, `${HEADLESS_USAGE_TEXT}\n`);
  const h = await run(t, ['chat', '--no-interactive', '--agent', 'ghost', 'x']);
  assert.equal(h.code, 4);
  const root = await run(t, ['--agent', 'ghost', '--no-interactive', 'x']);
  assert.equal(root.code, 4);
});

test('help render matches CHAT_DEF', () => {
  assert.equal(renderHelp(CHAT_DEF, 'kiro-claude', 'long').includes('v3'), false);
});
