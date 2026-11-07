import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { buildModelList } from '../../src/models/models.js';
import { openSettings } from '../../src/config/settings.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { runRepl } from '../../src/repl/repl.js';
import { SessionStore } from '../../src/session/store.js';
import type { CliContext, KiroHook, KiroSession } from '../../src/types.js';
import { compactInstructions } from '../../src/repl/commands/conversation.js';
import { looksLikePlan } from '../../src/repl/commands/plan.js';
import { promptArguments } from '../../src/repl/commands/prompts.js';
import { formatToolListing, toolNameMatches } from '../../src/repl/commands/tools.js';
import { formatHooks, formatUsage } from '../../src/repl/commands/info.js';
import { formatContextReport } from '../../src/repl/commands/context.js';
import { setColorEnabled, stripAnsi } from '../../src/util/ansi.js';
import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';
import { runToEnd, startRepl, tempEnv } from './harness.js';
import { MockSession, agentOf } from './mockSession.js';

setColorEnabled(false);

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

const temps: { cleanup(): void }[] = [];
after(() => {
  for (const t of temps) t.cleanup();
});

function tempEnvT(): ReturnType<typeof tempEnv> {
  const t = tempEnv();
  temps.push(t);
  return t;
}

async function cmd(input: string[], o: Parameters<typeof runToEnd>[0] = {}): Promise<{ out: string; s: MockSession; run: Awaited<ReturnType<typeof runToEnd>>['run'] }> {
  const s = o.session ?? new MockSession();
  const r = await runToEnd({ ...o, session: s, input });
  temps.push(r.run.t);
  return { out: r.out, s, run: r.run };
}

// ───────────────────────────── /clear ─────────────────────────────

test('/clear asks [y/n]; y clears, n and Ctrl+C keep', async () => {
  const q = 'Are you sure? This will erase the conversation history and context from hooks for the current session. [y/n]:';
  let r = await cmd(['/clear', 'y']);
  assert.ok(r.out.includes(`\n${q}\n\n> y\n`), r.out);
  assert.ok(r.out.includes('\nConversation history cleared.\n\n'));
  assert.equal(r.s.called('clear').length, 1);
  r = await cmd(['/clear', 'n']);
  assert.equal(r.s.called('clear').length, 0);
  assert.ok(!r.out.includes('cleared.'));
  r = await cmd(['/clear', '\u0003', 'hello']);
  assert.equal(r.s.called('clear').length, 0);
  assert.equal(r.s.prompts.length, 1, 'a Ctrl+C in the dialog does not exit');
});

test('/clear also forgets the REPL copy of the conversation: /copy, /reply, /transcript', async () => {
  const t = tempEnvT();
  t.env.EDITOR = 'true'; // an unchanged reply is not submitted (never blocks the test)
  const s = new MockSession().script({ result: { text: 'erased answer' } });
  const r = await cmd(['question one', '/clear', 'y', '/copy', '/reply', '/transcript', '/transcript save after.json --json'], { session: s, t });
  assert.ok(r.out.includes('Conversation history cleared.'), r.out);
  assert.ok(r.out.includes('No assistant message found to copy.'), r.out);
  assert.ok(r.out.includes('No assistant message found to reply to.'), r.out);
  assert.ok(r.out.includes('The transcript is empty.'), r.out);
  assert.ok(!r.run.raw().includes(Buffer.from('erased answer').toString('base64')), 'nothing erased reaches the clipboard');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.wsDir, 'after.json'), 'utf8')), []);
  assert.equal(s.prompts.length, 1);
  // a later turn is recorded again
  const s2 = new MockSession().script({ result: { text: 'old' } }, { result: { text: 'new answer' } });
  const t2 = tempEnvT();
  const r2 = await cmd(['q1', '/clear', 'y', 'q2', '/transcript save t.json --json', '/copy'], { session: s2, t: t2 });
  const j = JSON.parse(fs.readFileSync(path.join(t2.wsDir, 't.json'), 'utf8')) as Array<{ role: string; text: string }>;
  assert.deepEqual(j.map((e) => [e.role, e.text]), [['user', 'q2'], ['assistant', 'new answer']]);
  assert.ok(r2.run.raw().includes(Buffer.from('new answer').toString('base64')));
  // answering n keeps everything
  const s3 = new MockSession().script({ result: { text: 'kept answer' } });
  const r3 = await cmd(['q', '/clear', 'n', '/copy', '/transcript'], { session: s3 });
  assert.ok(r3.out.includes('✔ Copied the last response to the clipboard.'), r3.out);
  assert.ok(r3.out.includes('kept answer\n'), r3.out);
  assert.equal(s3.called('clear').length, 0);
});

// ───────────────────────────── /context ─────────────────────────────

test('/context show (06 §4.6 layout)', async () => {
  const { out } = await cmd(['/context']);
  assert.ok(out.includes('👤 Agent (kiro_default):\n    AGENTS.md (1 match)\n'), out);
  assert.ok(out.includes('💬 Session (temporary):\n    <none>\n'));
  assert.ok(out.includes('2 matched files in use:\n👤 /work/.kiro/steering/style.md (~40 tkns)\n👤 /work/AGENTS.md (~120 tkns)\n'));
  assert.ok(out.includes('\nTotal: ~160 tokens\n'));
  const empty = formatContextReport(
    { agentEntries: [], sessionEntries: [], steering: [{ path: '/s.md', inclusion: 'manual', tokens: 3 }], hookOutputs: [{ tokens: 7 }], droppedFiles: Array.from({ length: 12 }, (_, i) => `/f${i}`), totalTokens: 0, contextWindowTokens: 200000 },
    'dev',
    false,
  );
  assert.ok(empty.includes('    <none>'));
  assert.ok(empty.includes('📝 Steering (loaded when referenced):\n    /s.md (manual)'));
  assert.ok(empty.includes('No files in the current directory matched the rules above.'));
  assert.ok(empty.includes('🔧 Hook output (~7 tkns)'));
  assert.ok(empty.includes('Total token count exceeds limit: 150000.'));
  assert.ok(empty.includes('(2 more files)'));
});

test('/context add validates, rejects duplicates, --force; rm; clear', async () => {
  const t = tempEnvT();
  t.write('proj/src/a.ts', 'x');
  let r = await cmd(['/context add missing.txt', '/context add src/*.ts', '/context add src/*.ts', '/context add -f nothing/**', '/context rm nope', '/context rm src/*.ts', '/context clear'], { t });
  assert.ok(r.out.includes("Error: Invalid path 'missing.txt': Path 'missing.txt' does not exist. Use --force to add anyway."), r.out);
  assert.ok(r.out.includes('\nAdded 1 path(s) to context.\nNote: Context modifications via slash command is temporary.\n'));
  assert.ok(r.out.includes("Error: Rule 'src/*.ts' already exists."));
  assert.deepEqual(r.s.called('addContext'), [[['src/*.ts']], [['nothing/**']]]);
  assert.ok(r.out.includes('Error: None of the specified paths were found in the context'));
  assert.ok(r.out.includes('\nRemoved 1 path(s) from context.\n\nNote: Context modifications via slash command is temporary.\n'));
  assert.ok(r.out.includes('\nCleared context\nNote: Context modifications via slash command is temporary.\n'));
  assert.equal(r.s.called('clearContext').length, 1);
  r = await cmd(['/context add', '/context bogus']);
  assert.ok(r.out.includes('Error: No paths specified.'));
  assert.ok(r.out.includes('Unknown subcommand: /context bogus'));
});

// ───────────────────────────── /model, /effort ─────────────────────────────

test('/model picker, by id, unknown id, set-current-as-default, fallback', async () => {
  const t = tempEnvT();
  const r = await cmd(['/model', '2', '/model claude-sonnet-4.6', '/model gpt-5.6-sol', '/model set-current-as-default', '/model fallback', '/model'], { t });
  assert.ok(r.out.includes('Select a model for this chat session\n  1. auto (active) | Default (recommended): Claude Code default\n  2. Opus 5.5 [claude-opus-5.5] | Complex work\n'), r.out);
  assert.ok(r.out.includes('\n Using Opus 5.5\n'));
  assert.ok(r.out.includes('\n Using Sonnet 4.6\n'));
  assert.ok(r.out.includes("Model 'gpt-5.6-sol' does not exist. Available models: auto, claude-opus-5.5, claude-haiku-4.5, claude-sonnet-4.6"));
  assert.deepEqual(r.s.called('setModel'), [['claude-opus-5.5'], ['claude-sonnet-4.6']]);
  assert.ok(r.out.includes("✓ Default model set to 'claude-sonnet-4.6'. This will take effect the next time kiro-claude chat is launched."));
  const g = JSON.parse(fs.readFileSync(path.join(t.kiroHome, 'settings', 'cli.json'), 'utf8'));
  assert.equal(g['chat.defaultModel'], 'claude-sonnet-4.6');
  assert.ok(r.out.includes("This session's credentials cannot configure model fallbacks."));
  // the last bare /model got EOF: cancelled without change
  assert.equal(r.s.called('setModel').length, 2);
});

test('/model <display name> resolves the whole name, never just its first word (C8)', async () => {
  // claude 2.1.318 initialize.models: the newest model of a family carries the bare alias
  // ('haiku', 'sonnet') as its value, so the first word alone would match a different model
  const live = [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'x' },
    { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'x' },
    { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'x' },
    { value: 'claude-sonnet-4-6', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'x' },
  ];
  const s = new MockSession();
  s.models = buildModelList(live);
  const r = await cmd(['/model Haiku 4.5', '/model Sonnet 4.6', '/model Haiku 9.9', '/model "Haiku 4.5"', '/model haiku'], { session: s });
  assert.deepEqual(s.called('setModel'), [['claude-haiku-4.5'], ['claude-sonnet-4.6'], ['claude-haiku-4.5'], ['claude-haiku-5.5']], r.out);
  assert.ok(r.out.includes('\n Using Haiku 4.5\n'), r.out);
  assert.ok(r.out.includes('\n Using Sonnet 4.6\n'), r.out);
  assert.ok(r.out.includes("Model 'Haiku 9.9' does not exist. Available models: "), r.out);
  assert.equal(count(r.out, ' Using Haiku 5.5'), 1, 'only the bare alias selects Haiku 5.5');
  assert.equal(count(r.out, ' Using Sonnet 5.5'), 0, r.out);
});

test('/effort levels, per-model support, picker, set-current-as-default', async () => {
  const t = tempEnvT();
  const s = new MockSession({ model: 'claude-sonnet-4.6' });
  const r = await cmd(['/effort high', '/effort xhigh', '/effort turbo', '/effort set-current-as-default', '/effort', '1'], { t, session: s });
  assert.deepEqual(s.called('setEffort'), [['high'], ['low']]);
  assert.ok(r.out.includes('\n Effort set to high\n'));
  assert.ok(r.out.includes("Effort level 'xhigh' is not supported by claude-sonnet-4.6. Supported levels: low, medium, high, max"));
  assert.ok(r.out.includes("Invalid effort level 'turbo'. Valid levels: low, medium, high, xhigh, max"));
  assert.ok(r.out.includes("✓ Default effort for claude-sonnet-4.6 set to 'high'."));
  const g = JSON.parse(fs.readFileSync(path.join(t.kiroHome, 'settings', 'cli.json'), 'utf8'));
  assert.deepEqual(g['chat.modelDefaults'], { 'claude-sonnet-4.6': { output_config: { effort: 'high' } } });
  assert.ok(r.out.includes('Current effort: high\n'));
  assert.ok(r.out.includes('  3. high (active)'));
  const h = await cmd(['/effort low', '/effort set-current-as-default'], { session: new MockSession({ model: 'claude-haiku-4.5' }) });
  assert.ok(h.out.includes('The model claude-haiku-4.5 does not support effort levels.'));
  assert.ok(h.out.includes('No effort level is set for this session.'));
});

// ───────────────────────────── /agent ─────────────────────────────

test('/agent list, swap, set-default, schema', async () => {
  const t = tempEnvT();
  t.write('proj/.kiro/agents/dev.json', JSON.stringify({ name: 'dev', description: 'Dev agent', tools: ['*'], welcomeMessage: 'hi dev' }));
  const r = await cmd(['/agent list', '/agent swap dev', '/agent swap dev', '/agent swap ghost', '/agent set-default dev', '/agent schema', '/agent'], { t });
  assert.ok(/\* kiro_default/.test(r.out), r.out);
  assert.ok(/  dev\s+Dev agent/.test(r.out));
  assert.ok(r.out.includes('kiro_planner'));
  assert.deepEqual(r.s.called('swapAgent'), [['dev']]);
  assert.ok(r.out.includes('✔ Switched to agent dev'));
  assert.ok(r.out.includes('Welcome from dev'));
  assert.ok(r.out.includes('Already using agent dev.'));
  assert.ok(r.out.includes('Error: no agent with name ghost found'));
  assert.ok(r.out.includes("✓ Default agent set to 'dev'. This will take effect the next time kiro-claude chat is launched."));
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.kiroHome, 'settings', 'cli.json'), 'utf8'))['chat.defaultAgent'], 'dev');
  assert.ok(r.out.includes('"$schema"') || r.out.includes('"properties"'));
  assert.ok(r.out.includes('[dev] > '), 'prompt shows the swapped agent');
});

test('/agent swap picker', async () => {
  const t = tempEnvT();
  t.write('proj/.kiro/agents/alpha.json', JSON.stringify({ name: 'alpha', tools: [] }));
  const r = await cmd(['/agent swap', '1'], { t });
  assert.ok(r.out.includes('Choose one of the following agents'));
  assert.equal(r.s.called('swapAgent').length, 1);
});

test('/agent create writes the template, refuses duplicates, runs $EDITOR', async () => {
  const t = tempEnvT();
  let r = await cmd(['/agent create helper -D "Helps" -d workspace', '/agent create helper -d workspace', '/agent create'], { t });
  const file = path.join(t.wsDir, '.kiro', 'agents', 'helper.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.name, 'helper');
  assert.equal(j.description, 'Helps');
  assert.deepEqual(j.tools, ['*']);
  assert.ok(r.out.includes(`📁 Created agent helper '${file}'`));
  assert.ok(r.out.includes('Agent with name helper already exists. Aborting'));
  assert.ok(r.out.includes('error: the agent name is required'));
  // global default + editor that edits the file
  const t2 = tempEnvT();
  const ed = t2.write('editor.sh', '#!/bin/sh\nsed -i \'s/"description": ""/"description": "edited"/\' "$1"\n');
  fs.chmodSync(ed, 0o755);
  t2.env.EDITOR = ed;
  r = await cmd(['/agent create g1'], { t: t2 });
  const g = JSON.parse(fs.readFileSync(path.join(t2.kiroHome, 'agents', 'g1.json'), 'utf8'));
  assert.equal(g.description, 'edited');
  // an editor that breaks the JSON
  const t3 = tempEnvT();
  const bad = t3.write('bad.sh', '#!/bin/sh\necho "{ broken" > "$1"\n');
  fs.chmodSync(bad, 0o755);
  t3.env.EDITOR = bad;
  r = await cmd(['/agent create b1'], { t: t3 });
  assert.ok(r.out.includes("Post write validation failed for agent 'b1' at path:"), r.out);
});

test('/agent edit keeps the original on invalid JSON; built-ins cannot be edited', async () => {
  const t = tempEnvT();
  const f = t.write('proj/.kiro/agents/dev.json', '{"name":"dev"}\n');
  const bad = t.write('bad.sh', '#!/bin/sh\necho "{ nope" > "$1"\n');
  fs.chmodSync(bad, 0o755);
  t.env.EDITOR = bad;
  const r = await cmd(['/agent edit dev', '/agent edit kiro_default'], { t });
  assert.ok(r.out.includes("Post write validation failed for agent 'dev'"));
  assert.equal(fs.readFileSync(f, 'utf8'), '{"name":"dev"}\n');
  assert.ok(r.out.includes('The built-in agent kiro_default cannot be edited.'));
});

// ───────────────────────────── /chat, /save, /load, /sessions ─────────────────────────────

test('/chat save and /save (exists, -f, failure)', async () => {
  const t = tempEnvT();
  t.write('proj/exists.json', '{}');
  const r = await cmd(['/chat save out.json', '/chat save exists.json', '/save exists.json -f', '/chat save'], { t });
  assert.ok(r.out.includes('\n✔ Exported conversation state to out.json\n'));
  assert.ok(r.out.includes('\nFile at exists.json already exists. To overwrite, use -f or --force\n'));
  assert.ok(r.out.includes('\n✔ Exported conversation state to exists.json\n'));
  assert.deepEqual(r.s.called('exportTo'), [[path.join(t.wsDir, 'out.json'), false], [path.join(t.wsDir, 'exists.json'), true]]);
  assert.ok(r.out.includes('Usage: /chat save <path> [-f|--force]'));
  const s = new MockSession();
  s.exportTo = async () => {
    throw new Error('disk full');
  };
  const f = await cmd(['/save x.json'], { session: s });
  assert.ok(f.out.includes('Failed to export to x.json: disk full'));
});

test('/chat load and /load replace the session (path, path.json, missing)', async () => {
  const t = tempEnvT();
  t.write('proj/saved.json', '{}');
  const imported: string[] = [];
  const next = new MockSession();
  const r = await cmd(['/chat load saved', '/load nope'], {
    t,
    importSessionExport: async (p, opts) => {
      imported.push(p);
      next.ui = opts.ui;
      return next as unknown as KiroSession;
    },
  });
  assert.deepEqual(imported, [path.join(t.wsDir, 'saved.json')]);
  assert.ok(r.out.includes('\n✔ Imported conversation state from saved\n'));
  assert.ok(r.out.includes('Failed to import from nope: No such file or directory'));
  assert.equal(r.s.closed, true);
  assert.equal(next.started, true);
  assert.ok(r.out.includes(`--resume-id ${next.id}`));
  // import errors
  const t2 = tempEnvT();
  t2.write('proj/s.json', '{}');
  const e = await cmd(['/load s.json'], { t: t2, importSessionExport: async () => { throw new Error('bad export'); } });
  assert.ok(e.out.includes('Failed to import from s.json: bad export'));
});

test('/chat new creates a fresh session with the same agent/model/effort and sends the prompt', async () => {
  const first = new MockSession({ agent: agentOf('dev'), model: 'claude-opus-5.5', effort: 'high' });
  const second = new MockSession();
  second.script({ result: { text: 'new answer' } });
  const r = await runToEnd({ session: first, nextSession: () => second, input: ['/chat new hello there'], sessionOptions: { trustTools: ['read'], resume: { latest: true } } });
  const o = r.run.created[1]!;
  assert.equal(o.agentName, 'dev');
  assert.equal(o.model, 'claude-opus-5.5');
  assert.equal(o.effort, 'high');
  assert.deepEqual(o.trustTools, ['read']);
  assert.equal(o.resume, undefined);
  assert.equal(first.closed, true);
  assert.deepEqual(second.prompts.map((p) => p.text), ['hello there']);
  assert.ok(r.out.includes('✔ Started a new chat session'));
  r.run.t.cleanup();
});

test('/chat resume picks a stored session of this directory; /sessions lists them', async () => {
  const t = tempEnvT();
  const store = new SessionStore(t.env.KIRO_CLAUDE_SESSIONS_DIR!);
  const rec = store.create({ origin: 'repl', cwd: t.wsDir, agent: 'dev', model: 'claude-opus-5.5', title: 'old work' });
  const r = await runToEnd({ t, input: ['/sessions', '/chat resume', '1', '/chat'] });
  assert.ok(r.out.includes(`${rec.sessionId}`));
  assert.ok(r.out.includes('old work'));
  assert.ok(r.out.includes('Select a session to resume'));
  const o = r.run.created[1]!;
  assert.deepEqual(o.resume, { sessionId: rec.sessionId });
  assert.equal(o.agentName, 'dev');
  assert.ok(r.out.includes('Picking up where we left off...'));
  assert.ok(r.out.includes('/chat new [prompt…]'));
  t.cleanup();
  const none = await cmd(['/chat resume']);
  assert.ok(none.out.includes('No saved chat sessions for this directory.'));
});

test('/chat save-via-script and load-via-script', async () => {
  const t = tempEnvT();
  const dump = path.join(t.root, 'dump.json');
  const next = new MockSession();
  const r = await cmd([`/chat save-via-script cat > ${dump}`, `/chat load-via-script cat ${dump}`, '/chat save-via-script exit 4'], {
    t,
    importSessionExport: async () => next as unknown as KiroSession,
  });
  assert.ok(fs.readFileSync(dump, 'utf8').includes('kiro-claude-export'));
  assert.ok(r.out.includes(`✔ Exported conversation state via cat > ${dump}`));
  assert.ok(r.out.includes(`✔ Imported conversation state via cat ${dump}`));
  assert.ok(r.out.includes('Failed to export via exit 4: exit status 4'));
});

// ───────────────────────────── /tools ─────────────────────────────

test('/tools listing, trust, untrust, trust-all, reset, schema, /acceptall', async () => {
  const r = await cmd(['/tools', '/tools trust read', '/tools trust read bogus', '/tools trust a b', '/tools untrust shell', '/tools trust fs_read @github/create_issue', '/tools reset', '/tools trust-all', '/tools schema', '/acceptall']);
  assert.match(r.out, /\nTool {22}Permission\n▔{80}\n/);
  assert.match(r.out, /Built-in:\n- read {20}trusted\n- shell {19}not trusted\n- write {19}not trusted\n\ngithub \(MCP\):\n- @github\/create_issue {4}not trusted\n/);
  assert.ok(r.out.includes("\nTool 'read' is now trusted. I will not ask for confirmation before running this tool.\n"));
  assert.ok(r.out.includes("\nCannot trust 'bogus', it does not exist.\n"));
  assert.ok(r.out.includes("\nCannot trust 'a', 'b', they do not exist.\n"));
  assert.ok(r.out.includes("\nTool 'shell' is set to per-request confirmation.\n"));
  assert.ok(r.out.includes("Tools 'fs_read', '@github/create_issue' are now trusted. I will not ask for confirmation before running these tools."));
  assert.deepEqual(r.s.called('trustTools'), [[['read']], [['read']], [['fs_read', '@github/create_issue']]]);
  assert.deepEqual(r.s.called('untrustTools'), [[['shell']]]);
  assert.ok(r.out.includes('\nReset all tools to the permission levels as defined in agent.\n'));
  assert.equal(count(r.out, 'All tools are now trusted (!).'), 2);
  assert.ok(r.out.includes('/acceptall is deprecated. Use /tools trust-all instead.'));
  assert.ok(r.out.includes('"claudeName": "mcp__github__create_issue"'));
  assert.ok(r.out.includes('!> '));
});

test('/tools helpers', () => {
  const e = { name: 'read', claudeName: 'Read', source: 'builtin' as const, permission: 'trusted' };
  assert.ok(toolNameMatches('read', e));
  assert.ok(toolNameMatches('Read', e));
  assert.ok(toolNameMatches('fs_read', e));
  assert.ok(!toolNameMatches('write', e));
  const m = { name: '@srv/t', claudeName: 'mcp__srv__t', source: 'mcp' as const, server: 'srv', permission: 'x' };
  assert.ok(toolNameMatches('@srv/t', m));
  assert.ok(toolNameMatches('@srv', m));
  const empty = formatToolListing([], 80);
  assert.ok(empty.includes('No tools are currently enabled.'));
  const pend = formatToolListing([e], 80, ['slow']);
  assert.ok(pend.includes('Servers loading (Some of these might need auth. See /mcp for details)\n- slow\n'));
});

// ───────────────────────────── /hooks, /mcp, /usage, /todos, /transcript ─────────────────────────────

test('/hooks list and run', async () => {
  const s = new MockSession();
  let r = await cmd(['/hooks'], { session: s });
  assert.ok(r.out.includes('No hooks are configured.\n\nRefer to the documentation for how to add hooks to your agent:'));
  const s2 = new MockSession();
  s2.hookList = [
    { dialect: 'v2', source: 'agent', name: 'agentSpawn-0', trigger: 'SessionStart', rawTrigger: 'agentSpawn', action: { type: 'command', command: 'git status' }, timeoutMs: 30000, maxOutputBytes: 10240, cacheTtlSec: 0, enabled: true },
    { dialect: 'v3', source: 'workspace-file', name: 'lint', trigger: 'Manual', rawTrigger: 'Manual', action: { type: 'command', command: 'npm run lint' }, timeoutMs: 60000, maxOutputBytes: 10240, cacheTtlSec: 0, enabled: true, matcher: 'x' },
  ];
  r = await cmd(['/hooks', '/hooks run lint', '/hooks run ghost', '/hooks add x'], { session: s2 });
  assert.ok(r.out.includes('agentSpawn:\n  - agentSpawn-0: git status\nManual:\n  - lint: npm run lint [matcher: x]\n'), r.out);
  assert.ok(r.out.includes('\noutput of lint\n'));
  assert.ok(r.out.includes("No manual hook named 'ghost'."));
  assert.ok(r.out.includes('/hooks add is not supported in kiro-claude'));
  assert.deepEqual(s2.called('runManualHook'), [['lint'], ['ghost']]);
  assert.equal(formatHooks([]).includes('No hooks are configured.'), true);
});

test('/hooks run with an agent action sends its prompt as a user turn (C17)', async () => {
  const s = new MockSession();
  s.hookList = [
    { dialect: 'v3', source: 'workspace-file', name: 'review', trigger: 'Manual', rawTrigger: 'Manual', action: { type: 'agent', prompt: 'Review the diff' }, timeoutMs: 60000, maxOutputBytes: 10240, cacheTtlSec: 0, enabled: true },
  ];
  const r = await cmd(['/hooks run review'], { session: s });
  assert.deepEqual(s.prompts.map((p) => p.text), ['Review the diff'], 'the prompt reached the model');
  assert.ok(!r.out.includes('\nReview the diff\n\n'), 'the prompt is not just printed');
});

const hook = (name: string, trigger: KiroHook['trigger'], action: KiroHook['action'], enabled = true): KiroHook => ({
  dialect: 'v3',
  source: 'workspace-file',
  name,
  trigger,
  rawTrigger: trigger,
  action,
  timeoutMs: 60000,
  maxOutputBytes: 10240,
  cacheTtlSec: 0,
  enabled,
});

test('/hooks run branches on the Manual hook that ran, never on a same-named hook of another trigger (F5)', async () => {
  const s = new MockSession();
  s.hookList = [
    hook('lint', 'Stop', { type: 'agent', prompt: 'Check the lint results' }, false),
    hook('lint', 'Manual', { type: 'command', command: 'echo LINT' }),
    hook('review', 'PostToolUse', { type: 'command', command: 'true' }, false),
    hook('review', 'Manual', { type: 'agent', prompt: 'Please review the diff now' }),
    hook('stop-only', 'Stop', { type: 'agent', prompt: 'never run by /hooks run' }),
  ];
  const r = await cmd(['/hooks run lint', '/hooks run review', '/hooks run stop-only'], { session: s });
  assert.deepEqual(s.prompts.map((p) => p.text), ['Please review the diff now'], 'only the Manual agent hook reached the model');
  assert.ok(r.out.includes('\noutput of lint\n'), r.out);
  assert.ok(!r.out.includes('\nPlease review the diff now\n\n'), 'the agent prompt is not just printed');
  assert.ok(r.out.includes("No manual hook named 'stop-only'."), r.out);
  assert.deepEqual(s.called('runManualHook'), [['lint'], ['review'], ['stop-only']]);
});

test('/hooks run on a disabled Manual hook shows only the disabled warning (F11)', async () => {
  const s = new MockSession();
  s.hookList = [hook('off', 'Manual', { type: 'agent', prompt: 'Review the code' }, false), hook('cmdoff', 'Manual', { type: 'command', command: 'echo hi' }, false)];
  const r = await cmd(['/hooks run off', '/hooks run cmdoff'], { session: s });
  assert.deepEqual(s.prompts, [], 'a disabled hook sends nothing');
  assert.ok(!r.out.includes('empty prompt'), r.out);
  assert.ok(!r.out.includes('produced no output'), r.out);
  // nothing at all after either line (the session shows the disabled warning; this mock has none)
  assert.ok(r.out.includes('> /hooks run off\n> /hooks run cmdoff\n> '), r.out);
  assert.deepEqual(s.called('runManualHook'), [['off'], ['cmdoff']]);
});

test('/hooks run through the real session and fake claude: name collisions across triggers, case-insensitive and disabled hooks (F5, F11)', { timeout: 60_000 }, async () => {
  const t = tempEnvT();
  t.write(
    'proj/.kiro/hooks/a.json',
    JSON.stringify({
      version: 'v1',
      hooks: [
        { name: 'lint', trigger: 'Stop', enabled: false, action: { type: 'agent', prompt: 'Check the lint results' } },
        { name: 'lint', trigger: 'Manual', action: { type: 'command', command: 'echo LINT-OUTPUT-42' } },
        { name: 'review', trigger: 'PostToolUse', enabled: false, action: { type: 'command', command: 'true' } },
        { name: 'review', trigger: 'Manual', action: { type: 'agent', prompt: 'Please review the diff now' } },
        { name: 'off', trigger: 'Manual', enabled: false, action: { type: 'agent', prompt: 'Do the thing' } },
      ],
    }),
  );
  const logFile = path.join(t.root, 'fake.log');
  const env = fakeEnv({
    ...t.env,
    KIRO_HOME: t.kiroHome,
    XDG_RUNTIME_DIR: path.join(t.root, 'run'),
    XDG_CACHE_HOME: path.join(t.root, 'cache'),
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    FAKE_CLAUDE_LOG: logFile,
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify({ turns: [], default: { steps: [{ text: 'MODEL GOT: {{userText}}' }] } }),
  });
  fs.mkdirSync(env.XDG_RUNTIME_DIR!, { recursive: true, mode: 0o700 });
  const ws = createWorkspaceContext(t.wsDir, env);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  stdout.on('data', (d: Buffer) => (out += d.toString()));
  stderr.on('data', (d: Buffer) => (out += d.toString()));
  const ctx: CliContext = { ws, settings: openSettings(ws), stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream, progName: 'kiro-claude', verbosity: 0 };
  const exit = runRepl({ ctx, sessionOptions: { env, claudePath: fakeClaudePath() } });
  stdin.end(['/hooks run lint', '/hooks run REVIEW', '/hooks run off', '/quit'].map((l) => `${l}\n`).join(''));
  assert.equal(await exit, 0);
  out = stripAnsi(out);
  const users = (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [])
    .map((l) => JSON.parse(l) as { event?: string; line?: { type?: string; message?: { content?: unknown } } })
    .filter((e) => e.event === 'stdin' && e.line?.type === 'user')
    .map((e) => {
      const c = e.line!.message!.content;
      return typeof c === 'string' ? c : (c as { text?: string }[]).map((b) => b.text ?? '').join('');
    });
  // 'lint': the Manual command hook ran and its output was printed (a Stop agent 'lint' is not it)
  assert.match(out, /LINT-OUTPUT-42/);
  assert.ok(!users.some((u) => u.includes('LINT-OUTPUT-42')), `command output was sent to the model: ${JSON.stringify(users)}`);
  // 'REVIEW': the Manual agent hook 'review' (case-insensitive, as HookRunner.runManual) sent its prompt
  assert.equal(users.filter((u) => u.includes('Please review the diff now')).length, 1, JSON.stringify(users));
  assert.match(out, /MODEL GOT: .*Please review the diff now/);
  // 'off': disabled — the warning, no "empty prompt", nothing sent
  assert.match(out, /Hook "off" is disabled\./);
  assert.doesNotMatch(out, /empty prompt|produced no output/);
  assert.ok(!users.some((u) => u.includes('Do the thing')));
});

/** `/hooks run` lines through the real runRepl + session + fake claude; what was printed and sent. */
async function realHooksRun(hooks: unknown[], lines: string[]): Promise<{ out: string; users: string[] }> {
  const t = tempEnvT();
  t.write('proj/.kiro/hooks/a.json', JSON.stringify({ version: 'v1', hooks }));
  const logFile = path.join(t.root, 'fake.log');
  const env = fakeEnv({
    ...t.env,
    KIRO_HOME: t.kiroHome,
    XDG_RUNTIME_DIR: path.join(t.root, 'run'),
    XDG_CACHE_HOME: path.join(t.root, 'cache'),
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    FAKE_CLAUDE_LOG: logFile,
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify({ turns: [], default: { steps: [{ text: 'MODEL GOT: {{userText}}' }] } }),
  });
  fs.mkdirSync(env.XDG_RUNTIME_DIR!, { recursive: true, mode: 0o700 });
  const ws = createWorkspaceContext(t.wsDir, env);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  stdout.on('data', (d: Buffer) => (out += d.toString()));
  stderr.on('data', (d: Buffer) => (out += d.toString()));
  const ctx: CliContext = { ws, settings: openSettings(ws), stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream, progName: 'kiro-claude', verbosity: 0 };
  const exit = runRepl({ ctx, sessionOptions: { env, claudePath: fakeClaudePath() } });
  stdin.end([...lines, '/quit'].map((l) => `${l}\n`).join(''));
  assert.equal(await exit, 0);
  const users = (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [])
    .map((l) => JSON.parse(l) as { event?: string; line?: { type?: string; message?: { content?: unknown } } })
    .filter((e) => e.event === 'stdin' && e.line?.type === 'user')
    .map((e) => {
      const c = e.line!.message!.content;
      return typeof c === 'string' ? c : (c as { text?: string }[]).map((b) => b.text ?? '').join('');
    });
  return { out: stripAnsi(out), users };
}

test('/hooks run through the real session: a disabled command hook, a timed-out command and an exact vs case-insensitive pick (F5, F11)', { timeout: 60_000 }, async () => {
  const { out, users } = await realHooksRun(
    [
      { name: 'Lint', trigger: 'Manual', enabled: false, action: { type: 'command', command: 'echo UPPER-LINT' } },
      { name: 'lint', trigger: 'Manual', action: { type: 'command', command: 'echo LOWER-LINT' } },
      { name: 'cmdoff', trigger: 'Manual', enabled: false, action: { type: 'command', command: 'echo never' } },
      { name: 'slow', trigger: 'Manual', timeout: 0.3, action: { type: 'command', command: 'sleep 5; echo late' } },
    ],
    ['/hooks run lint', '/hooks run LINT', '/hooks run cmdoff', '/hooks run slow'],
  );
  const printedAfter = (line: string): string => {
    const i = out.indexOf(`> ${line}\n`);
    assert.ok(i >= 0, out);
    const rest = out.slice(i + line.length + 3);
    const j = rest.indexOf('\n> ');
    return j >= 0 ? rest.slice(0, j) : rest;
  };
  // the exact name wins over a case-insensitive match (HookRunner.runManual)
  assert.match(printedAfter('/hooks run lint'), /LOWER-LINT/);
  // no exact 'LINT': the first case-insensitive Manual hook is the disabled 'Lint' — only its warning
  assert.equal(printedAfter('/hooks run LINT').trim(), 'Hook "Lint" is disabled.');
  // a disabled command hook: only the warning, never "produced no output" (F11)
  assert.equal(printedAfter('/hooks run cmdoff').trim(), 'Hook "cmdoff" is disabled.');
  // a command that ran and timed out is a command with no output, not a disabled hook
  assert.match(printedAfter('/hooks run slow'), /timed out[\s\S]*Hook 'slow' produced no output\./);
  assert.doesNotMatch(out, /UPPER-LINT/);
  assert.deepEqual(users, [], 'nothing was sent to the model');
});

test('/mcp status', async () => {
  const s = new MockSession();
  s.mcp = [
    { name: 'github', status: 'connected', toolCount: 3 },
    { name: 'slow', status: 'pending' },
    { name: 'broken', status: 'failed', error: 'spawn ENOENT' },
  ];
  const r = await cmd(['/mcp', '/mcp auth github'], { session: s });
  assert.ok(r.out.includes('✓ github  connected (3 tools)'), r.out);
  assert.ok(r.out.includes('◌ slow    pending'));
  assert.ok(r.out.includes('✗ broken  failed: spawn ENOENT'));
  assert.ok(r.out.includes('/mcp auth is not supported in kiro-claude'));
  const s2 = new MockSession();
  s2.mcp = [];
  assert.ok((await cmd(['/mcp'], { session: s2 })).out.includes('No MCP servers configured.'));
});

test('/usage', async () => {
  const s = new MockSession();
  s.usageReport = {
    model: 'claude-opus-5.5',
    contextTokens: 12000,
    contextWindowTokens: 200000,
    contextPercent: 6,
    categories: [{ name: 'System prompt', tokens: 3000 }, { name: 'Messages', tokens: 9000 }],
    sessionCostUsd: 0.1234,
    rateLimit: { status: 'allowed', utilization: 0.42, window: '5-hour', resetsAt: 1_800_000_000 },
  };
  const r = await cmd(['/usage'], { session: s });
  assert.ok(r.out.includes('Current context window (12000 of 200k tokens used)'), r.out);
  assert.ok(r.out.includes('  6.00%'));
  assert.ok(r.out.includes('█ System prompt: ~3000 tokens (1.50%)'));
  assert.ok(r.out.includes('Claude subscription usage: allowed, 42% used of the 5-hour window, resets '));
  assert.ok(r.out.includes('Session cost estimate at API list prices: $0.12 (not what your subscription pays)'));
  assert.ok(r.out.includes('💡 Pro Tips:\nRun /compact to replace the conversation history with its summary'));
  assert.ok(formatUsage({ model: 'auto' }, 80).includes('Context window usage is not available yet'));
  const withFree = formatUsage({ model: 'auto', contextTokens: 100, contextWindowTokens: 1000, contextPercent: 10, categories: [{ name: 'Messages', tokens: 100 }, { name: 'Free space', tokens: 900 }] }, 80);
  // colours are off in this file: the free-space filler is '░' (see the colour-mode test below)
  assert.ok(withFree.includes('█'.repeat(7) + '░'.repeat(63) + '  10.00%'), withFree);
  assert.ok(withFree.includes('█ Messages: ~100 tokens (10.00%)\n░ Free space: ~900 tokens (90.00%)\n'));
  assert.ok(formatUsage({ model: 'auto', contextPercent: 5.5 }, 80).includes('Current context window (5.5% used)'));
  assert.ok(formatUsage({ model: 'auto', contextTokens: 300, contextWindowTokens: 100, contextPercent: 300 }, 80).includes('300.00%'));
});

test('/usage bar: free space is a grey █ with colours, ░ without (never confusable with used cells)', () => {
  const report = { model: 'auto', contextTokens: 100, contextWindowTokens: 1000, contextPercent: 10, categories: [{ name: 'Messages', tokens: 100 }, { name: 'Free space', tokens: 900 }] };
  const bar = (s: string): string => s.split('\n').find((l) => l.endsWith('  10.00%'))!;
  setColorEnabled(true);
  let colored: string;
  try {
    colored = formatUsage(report, 80);
  } finally {
    setColorEnabled(false);
  }
  const line = bar(colored);
  // used cells in the category colour (cyan), the filler in grey; both drawn with █
  assert.ok(line.startsWith(`\u001b[36m${'█'.repeat(7)}\u001b[39m\u001b[90m${'█'.repeat(63)}\u001b[39m`), JSON.stringify(line));
  assert.ok(!line.includes('░'));
  assert.equal(stripAnsi(line), `${'█'.repeat(70)}  10.00%`);
  const plainText = formatUsage(report, 80);
  const plain = bar(plainText);
  assert.equal(plain, `${'█'.repeat(7)}${'░'.repeat(63)}  10.00%`);
  assert.ok(!plain.includes('\u001b'));
  // the legend uses the same glyphs as the bar
  assert.ok(plainText.includes('█ Messages: ~100 tokens (10.00%)\n░ Free space: ~900 tokens (90.00%)\n'), plainText);
  assert.ok(colored.includes(`\u001b[90m█ Free space: ~900 tokens (90.00%)\u001b[39m\n`), JSON.stringify(colored));
  // nothing used yet: the whole bar is filler
  const empty = bar(formatUsage({ model: 'auto', contextTokens: 0, contextWindowTokens: 1000, contextPercent: 0, categories: [] }, 80).replace('0.00%', '10.00%'));
  assert.equal(empty, `${'░'.repeat(70)}  10.00%`);
});

test('/todos view and resume; /transcript', async () => {
  const s = new MockSession();
  s.todoList = [
    { id: '1', subject: 'write code', status: 'completed' },
    { id: '2', subject: 'test code', status: 'pending' },
  ];
  s.script({ result: { text: 'continuing' } });
  const t = tempEnvT();
  const r = await cmd(['/todos', '/todo resume', '/todos clear-finished', '/transcript', '/transcript save tr.md', '/transcript save tr.json --json'], { session: s, t });
  assert.ok(r.out.includes('TODO:\n[x] write code\n[ ] test code\n'));
  assert.ok(r.out.includes('⟳ Resuming: test code'));
  assert.ok(s.prompts[0]!.text.startsWith('[SYSTEM NOTE: This is an automated request, not from the user]'));
  assert.ok(r.out.includes('/todos clear-finished is not supported'));
  assert.ok(r.out.includes('continuing'));
  assert.ok(fs.readFileSync(path.join(t.wsDir, 'tr.md'), 'utf8').includes('continuing'));
  const j = JSON.parse(fs.readFileSync(path.join(t.wsDir, 'tr.json'), 'utf8'));
  assert.equal(j[1].role, 'assistant');
  const e = await cmd(['/todos', '/transcript']);
  assert.ok(e.out.includes('No to-do lists to view!'));
  assert.ok(e.out.includes('The transcript is empty.'));
});

test('/transcript shows the model text without terminal escape sequences (the saved file keeps them)', async () => {
  const s = new MockSession().script({ steps: [{ type: 'text_delta', text: 'a\u001b]0;pwned\u0007b\u001b[2Jc' }] });
  const t = tempEnvT();
  const r = await cmd(['ask', '/transcript', '/transcript save raw.md'], { session: s, t });
  assert.ok(r.out.includes('> ask\n\nabc\n'), r.out);
  assert.ok(!r.run.raw().includes('\u001b]0;pwned') && !r.run.raw().includes('\u001b[2J') && !r.run.raw().includes('\u0007'), JSON.stringify(r.run.raw()));
  assert.equal(fs.readFileSync(path.join(t.wsDir, 'raw.md'), 'utf8'), '> ask\n\na\u001b]0;pwned\u0007b\u001b[2Jc\n');
});

// ───────────────────────────── /compact, /tangent, /rewind ─────────────────────────────

test('/compact strips Kiro flags and renders compaction once', async () => {
  const r = await cmd(['/compact focus on tests --show-summary --messages-to-exclude 3 --truncate-large-messages=true']);
  assert.deepEqual(r.s.called('compact'), [['focus on tests']]);
  assert.equal(count(r.out, 'compacted successfully'), 1);
  assert.equal(compactInstructions([]), '');
  assert.equal(compactInstructions(['--max-message-length', '9', 'keep', 'API']), 'keep API');
  const s = new MockSession().script({ result: { stopReason: 'local_command' } });
  const r2 = await cmd(['/compact'], { session: s });
  assert.deepEqual(s.called('compact'), [[undefined]]);
  assert.equal(count(r2.out, 'compacted successfully'), 1, 'fallback message when no compaction event');
});

test('/tangent enter / exit / tail / merge / root / ls', async () => {
  const empty = await cmd(['/tangent']);
  assert.ok(empty.out.includes("Can't branch an empty chat."));
  assert.equal(empty.s.called('enterTangent').length, 0);
  const s = new MockSession();
  s.record.messageCount = 2;
  s.record.turns.push({ userUuid: 'u', preview: 'q', at: '' });
  const r = await cmd(['/tangent', '/tangent ls', '/tangent', '/tangent tail', '/tangent side', '/tangent tail', '/tangent merge', '/tangent root', '/tangent named', '/tangent merge', '/tangent root'], { session: s });
  assert.ok(r.out.includes('Created a conversation checkpoint (↯). Use /tangent to restore the conversation later.\nNote: this functionality is experimental and may change or be removed in the future.'));
  assert.ok(r.out.includes('↯ > /tangent ls'), 'prompt shows the tangent marker');
  assert.ok(r.out.includes('Restored conversation from checkpoint (↯). - Returned to main conversation.'));
  assert.ok(r.out.includes('You need to be in tangent mode to use tail.'));
  assert.ok(r.out.includes('Restored conversation from checkpoint (↯) with last conversation entry preserved.'));
  assert.ok(r.out.includes('Already on the root session — nothing to merge into'));
  assert.ok(r.out.includes('Already on the root session.'));
  assert.ok(r.out.includes("Merged the tangent's findings into the main conversation (↯)."));
  assert.deepEqual(s.called('enterTangent'), [[undefined], ['side'], ['named']]);
  assert.deepEqual(s.called('exitTangent'), [['discard'], ['tail'], ['merge']]);
  assert.ok(r.out.includes('* main'));
});

test('/rewind N, invalid, picker, nothing yet', async () => {
  const s = new MockSession();
  s.record.turns.push({ userUuid: 'u1', preview: 'first question', at: '' }, { userUuid: 'u2', preview: 'second question', at: '' });
  const r = await cmd(['/rewind 1', '/rewind 7', '/rewind', '1'], { session: s });
  // the picker lists turns oldest first, so the number typed is the turn number
  assert.deepEqual(s.called('rewind'), [[1], [1]]);
  assert.ok(r.out.includes('✔ Rewound the conversation to turn 1.'));
  assert.ok(r.out.includes("Invalid turn number '7'. Choose a number between 1 and 2."));
  assert.ok(r.out.includes('  1. first question\n  2. second question\n'), r.out);
  assert.ok((await cmd(['/rewind'])).out.includes('Nothing to rewind yet.'));
});

// ───────────────────────────── /editor, /reply ─────────────────────────────

test('/editor submits the edited content; empty and failing editors', async () => {
  const t = tempEnvT();
  const ed = t.write('ed.sh', '#!/bin/sh\nprintf "%s plus edits" "$(cat "$1")" > "$1"\n');
  fs.chmodSync(ed, 0o755);
  t.env.EDITOR = ed;
  const s = new MockSession().script({});
  const r = await cmd(['/editor initial words'], { t, session: s });
  assert.ok(r.out.includes('\nContent loaded from editor. Submitting prompt...\n\n> initial words plus edits\n'), r.out);
  assert.deepEqual(s.prompts.map((p) => p.text), ['initial words plus edits']);
  const t2 = tempEnvT();
  const empty = t2.write('e.sh', '#!/bin/sh\n: > "$1"\n');
  fs.chmodSync(empty, 0o755);
  t2.env.EDITOR = empty;
  assert.ok((await cmd(['/editor'], { t: t2 })).out.includes('Empty content from editor, not submitting.'));
  const t3 = tempEnvT();
  t3.env.EDITOR = 'false';
  assert.ok((await cmd(['/editor'], { t: t3 })).out.includes('Error opening editor: false exited with status 1'));
  const t4 = tempEnvT();
  t4.env.EDITOR = '/no/such/editor';
  assert.ok((await cmd(['/editor'], { t: t4 })).out.includes('Error opening editor: '));
});

test('/reply quotes the last answer; unchanged and missing', async () => {
  assert.ok((await cmd(['/reply'])).out.includes('No assistant message found to reply to.'));
  const t = tempEnvT();
  const ed = t.write('ed.sh', '#!/bin/sh\nprintf "\\nmy reply" >> "$1"\n');
  fs.chmodSync(ed, 0o755);
  t.env.EDITOR = ed;
  const s = new MockSession().script({ steps: [{ type: 'text_delta', text: 'line A\nline B' }] }, {});
  const r = await cmd(['question', '/reply'], { t, session: s });
  assert.equal(s.prompts[1]!.text, '> line A\n> line B\n\n\nmy reply');
  assert.ok(r.out.includes('Content loaded from editor. Submitting prompt...'));
  const t2 = tempEnvT();
  t2.env.EDITOR = 'true';
  const s2 = new MockSession().script({ result: { text: 'answer' } });
  assert.ok((await cmd(['q', '/reply'], { t: t2, session: s2 })).out.includes('No changes made in editor, not submitting.'));
});

// ───────────────────────────── /prompts ─────────────────────────────

test('/prompts list, details, get, create, edit, remove', async () => {
  const t = tempEnvT();
  t.write('proj/.kiro/prompts/review.md', '---\ndescription: Review code\n---\nReview ${1} with care. $ARGUMENTS');
  t.write('home/.kiro/prompts/global-one.md', 'Global body');
  const s = new MockSession().script({});
  const r = await cmd(['/prompts', '/prompts list rev', '/prompts details review', '/prompts get review src/a.ts', '/prompts get ghost', '/prompts create -n fresh --content "Fresh body"', '/prompts create -n "bad name"', '/prompts create -n fresh --content x', '/prompts remove fresh', '/prompts remove fresh'], { t, session: s });
  assert.ok(r.out.includes('Local (.kiro/prompts):\n- review'), r.out);
  assert.ok(r.out.includes('Global (~/.kiro/prompts):\n- global-one'));
  assert.ok(r.out.includes('Review code'));
  assert.ok(r.out.includes('${1}, $ARGUMENTS'));
  assert.ok(r.out.includes('2 prompts'));
  assert.ok(r.out.includes('1 prompt\n'));
  assert.ok(r.out.includes('Arguments: ${1}, $ARGUMENTS'));
  assert.deepEqual(s.prompts.map((p) => p.text), ['Review src/a.ts with care. src/a.ts']);
  assert.ok(r.out.includes('Prompt ghost not found. Use /prompts list to see available prompts.'));
  assert.ok(r.out.includes("✔ Created prompt 'fresh'"));
  assert.ok(r.out.includes("Invalid prompt name 'bad name'"));
  assert.ok(r.out.includes("Prompt 'fresh' already exists"));
  assert.ok(r.out.includes("✔ Removed prompt 'fresh'"));
  assert.ok(r.out.includes('Prompt fresh not found in .kiro/prompts.'));
  assert.ok(!fs.existsSync(path.join(t.wsDir, '.kiro', 'prompts', 'fresh.md')));
  assert.deepEqual(promptArguments('a ${2} ${1} ${2} ${@} $ARGUMENTS'), ['${2}', '${1}', '${@}', '$ARGUMENTS']);
  assert.ok((await cmd(['/prompts'])).out.includes('No prompts available.'));
});

// ───────────────────────────── misc ─────────────────────────────

test('/session-id, /issue, /knowledge, /profile, stubs, /settings, /copy, /title', async () => {
  const s = new MockSession().script({ result: { text: 'copy me' } });
  const r = await cmd(['/session-id', '/issue', '/feedback', '/knowledge show', '/profile', '/theme', '/spawn x', '/settings', '/copy', 'q', '/copy', '/title My Task', '/title --clear'], { session: s, settings: { 'chat.defaultAgent': 'kiro_default' } });
  assert.ok(r.out.includes(`> /session-id\n${s.id}\n`));
  assert.equal(count(r.out, 'https://github.com/BurgiSimon/KIRO-Claude/issues'), 2);
  assert.ok(r.out.includes('/knowledge is not supported in kiro-claude (Claude Code backend).'));
  assert.ok(r.out.includes('This command has been deprecated. Use /agent instead.'));
  assert.ok(r.out.includes('/theme is not supported in kiro-claude (Claude Code backend).'));
  assert.ok(r.out.includes('/spawn is not supported in kiro-claude (Claude Code backend).'));
  assert.ok(r.out.includes('chat.defaultAgent  "kiro_default"'));
  assert.ok(r.out.includes('No assistant message found to copy.'));
  assert.ok(r.out.includes('✔ Copied the last response to the clipboard.'));
  assert.ok(r.run.raw().includes(`\u001b]52;c;${Buffer.from('copy me').toString('base64')}\u0007`));
  assert.ok(r.run.raw().includes('\u001b]0;kiro: My Task\u0007'));
  assert.ok(r.run.raw().includes('\u001b]0;\u0007'));
  // stubs are hidden from /help, real commands are listed
  const h = await cmd(['/help']);
  assert.ok(!h.out.includes('/theme '));
  for (const name of ['/quit', '/clear', '/context', '/model', '/effort', '/agent', '/chat', '/tools', '/prompts', '/hooks', '/mcp', '/compact', '/usage', '/tangent', '/rewind', '/todos', '/plan', '/editor', '/reply', '/issue', '/knowledge', '/session-id']) {
    assert.ok(h.out.includes(name), name);
  }
  assert.ok(h.out.includes('(aliases: /exit, /q)'));
  assert.ok(h.out.includes('Tips:'));
  assert.ok(h.out.includes('!{command}'));
});

test('command errors are reported, not fatal', async () => {
  const s = new MockSession();
  s.swapAgent = async () => {
    throw new Error('respawn failed');
  };
  const t = tempEnvT();
  t.write('proj/.kiro/agents/dev.json', JSON.stringify({ name: 'dev' }));
  const r = await cmd(['/agent swap dev', '/tools trust "unbalanced', 'still alive'], { session: s, t });
  assert.ok(r.out.includes('\nFailed to execute command: respawn failed\n'));
  // unbalanced quotes fall back to a whitespace split (free-text commands must accept "don't")
  assert.ok(r.out.includes(`Cannot trust '"unbalanced', it does not exist.`), r.out);
  assert.equal(s.prompts.length, 1);
});

test('plan helper recognizes Kiro plans only', () => {
  assert.ok(looksLikePlan('**Implementation Plan - X**\n...'));
  assert.ok(looksLikePlan('## Implementation Plan\nstuff'));
  assert.ok(looksLikePlan('**Task Breakdown:**\nTask 1: a'));
  assert.ok(looksLikePlan('Task 1: do a\nTask 2: do b'));
  assert.ok(!looksLikePlan('Here is the answer to your question.'));
  assert.ok(!looksLikePlan('Task 1: only one task'));
  assert.ok(!looksLikePlan(''));
});

test('startRepl helper sanity: waitFor times out with output', async () => {
  const run = startRepl({ input: [] });
  await run.exit;
  await assert.rejects(run.waitFor('never appears', 20), /timed out/);
  run.t.cleanup();
});
