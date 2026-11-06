import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionStore } from '../../src/session/store.js';
import type { KiroSession } from '../../src/types.js';
import { compactInstructions } from '../../src/repl/commands/conversation.js';
import { looksLikePlan } from '../../src/repl/commands/plan.js';
import { promptArguments } from '../../src/repl/commands/prompts.js';
import { formatToolListing, toolNameMatches } from '../../src/repl/commands/tools.js';
import { formatHooks, formatUsage } from '../../src/repl/commands/info.js';
import { formatContextReport } from '../../src/repl/commands/context.js';
import { setColorEnabled } from '../../src/util/ansi.js';
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
  assert.ok(r.out.includes("No hook named 'ghost'."));
  assert.ok(r.out.includes('/hooks add is not supported in kiro-claude'));
  assert.deepEqual(s2.called('runManualHook'), [['lint']]);
  assert.equal(formatHooks([]).includes('No hooks are configured.'), true);
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
  assert.ok(withFree.includes('█'.repeat(7) + '█'.repeat(63) + '  10.00%'), withFree);
  assert.ok(withFree.includes('█ Messages: ~100 tokens (10.00%)\n█ Free space: ~900 tokens (90.00%)\n'));
  assert.ok(formatUsage({ model: 'auto', contextPercent: 5.5 }, 80).includes('Current context window (5.5% used)'));
  assert.ok(formatUsage({ model: 'auto', contextTokens: 300, contextWindowTokens: 100, contextPercent: 300 }, 80).includes('300.00%'));
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
