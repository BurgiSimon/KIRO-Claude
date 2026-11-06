/**
 * KiroCrew probe contract (08 §2.2) against the BUILT binary as a subprocess, under KiroCrew's
 * credential-minimal probe environment (08 §1 V5: allow-listed env, NO_COLOR=1, TERM=dumb,
 * stdin at EOF). Outputs are checked with re-implementations of KiroCrew's own parsers.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { builtBin, fakeClaudePath, makeEnv, spawnCli, type TestEnv } from './helpers.js';

let t: TestEnv;
let probeEnv: NodeJS.ProcessEnv;

before(() => {
  t = makeEnv();
  probeEnv = {
    HOME: t.home,
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    NO_COLOR: '1',
    TERM: 'dumb',
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    XDG_CACHE_HOME: path.join(t.root, 'cache'),
    XDG_RUNTIME_DIR: path.join(t.root, 'run'),
    FAKE_CLAUDE_LOG: t.fakeLog,
  };
});
after(() => t.cleanup());

/** kiro_crew.mcp_hot_reload.parse_kiro_cli_version: regex at the start of the last token. */
function parseKiroCliVersion(text: string): [number, number, number] | undefined {
  const tokens = text.trim().split(/\s+/);
  const last = tokens[tokens.length - 1] ?? '';
  const m = /^(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?(?!\d)/.exec(last);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

/** kiro_crew.kiro_cli.chat_agent_engines */
function chatAgentEngines(help: string): string[] {
  const at = help.indexOf('--agent-engine');
  if (at < 0) return [];
  const end = help.indexOf('\n      --', at + 1);
  const block = help.slice(at, end > 0 ? end : undefined);
  const m = /\[possible values:\s*([^\]]*)\]/.exec(block);
  return m ? m[1]!.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** kiro_crew.cloud.login_target.parse_whoami_output: the leading JSON object only. */
function parseWhoami(raw: string): Record<string, string> {
  const start = raw.indexOf('{');
  if (start < 0) return {};
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) return {};
  const d = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of ['email', 'accountType', 'startUrl']) if (typeof d[k] === 'string' && d[k]) out[k] = d[k] as string;
  return out;
}

test('the built binary exists', () => {
  assert.ok(fs.existsSync(builtBin()), builtBin());
});

test('KC-CLI-01 --version', () => {
  const r = spawnCli(['--version'], probeEnv);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'kiro-claude 0.1.0 (kiro-cli 1.26.0)\n');
  const v = parseKiroCliVersion(r.stdout)!;
  assert.deepEqual(v, [1, 26, 0]);
  assert.ok(r.ms < 5000, `took ${r.ms} ms`);
});

test('KC-CLI-03 chat --help: engines (v1, v2), no v3', () => {
  const r = spawnCli(['chat', '--help'], probeEnv);
  assert.equal(r.code, 0);
  assert.deepEqual(chatAgentEngines(`${r.stdout}\n${r.stderr}`), ['v1', 'v2']);
  assert.ok(!r.stdout.includes('v3'));
});

test('KC-CLI-04/05 whoami signed in and signed out', () => {
  const r = spawnCli(['whoami'], probeEnv);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'Logged in with Claude Code (claude.ai)\n');
  const j = spawnCli(['whoami', '--format', 'json'], probeEnv);
  assert.equal(j.code, 0);
  assert.deepEqual(parseWhoami(j.stdout), {});
  assert.equal(j.stdout, '{}\n');
  const jp = spawnCli(['whoami', '-f', 'json-pretty'], probeEnv);
  assert.equal(jp.code, 0);
  assert.deepEqual(JSON.parse(jp.stdout), {});
  const out = spawnCli(['whoami'], { ...probeEnv, FAKE_CLAUDE_LOGGED_OUT: '1' });
  assert.equal(out.code, 1);
  assert.ok(`${out.stdout}${out.stderr}`.toLowerCase().includes('not logged in'));
  assert.equal(out.stderr, 'Not logged in. Run "kiro-claude login" to sign in to Claude Code.\n');
  const outJson = spawnCli(['whoami', '--format', 'json'], { ...probeEnv, FAKE_CLAUDE_LOGGED_OUT: '1' });
  assert.equal(outJson.code, 1);
  assert.equal(outJson.stdout, '');
  assert.deepEqual(parseWhoami(outJson.stdout), {});
  const missing = spawnCli(['whoami'], { ...probeEnv, KIRO_CLAUDE_BIN: '/nonexistent/claude' });
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr, 'Not logged in: Claude Code not found (/nonexistent/claude)\n');
});

test('KC-CLI-06 chat --list-models --format json --no-interactive', () => {
  const r = spawnCli(['chat', '--list-models', '--format', 'json', '--no-interactive'], probeEnv);
  assert.equal(r.code, 0);
  const d = JSON.parse(r.stdout) as { models: Array<Record<string, unknown>> };
  assert.ok(!Array.isArray(d) && Array.isArray(d.models));
  const ids = d.models.map((m) => m.model_id);
  assert.ok(ids.includes('claude-haiku-5.5'));
  for (const m of d.models) {
    for (const k of ['model_name', 'model_id', 'description', 'context_window_tokens', 'rate_multiplier']) assert.ok(k in m, k);
    assert.ok(typeof m.context_window_tokens === 'number' && m.context_window_tokens > 0);
    assert.ok(typeof m.rate_multiplier === 'number' && m.rate_multiplier > 0);
  }
  assert.ok(!fs.existsSync(t.fakeLog) || !fs.readFileSync(t.fakeLog, 'utf8').includes('"stream"'));
});

test('KC-CLI-07 /usage answered locally, no model turn', () => {
  const before = fs.existsSync(t.fakeLog) ? fs.readFileSync(t.fakeLog, 'utf8') : '';
  const r = spawnCli(['chat', '--no-interactive', '--agent-engine', 'v2', '--agent', 'kirocrew-lite', '/usage'], probeEnv);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'Claude Code subscription usage is not reported as Kiro credits. Run /usage inside kiro-claude chat.\n');
  assert.ok(!r.stdout.includes('Estimated Usage'));
  const after = fs.existsSync(t.fakeLog) ? fs.readFileSync(t.fakeLog, 'utf8') : '';
  assert.equal(after, before, 'claude was not spawned');
});

test('KC-CLI-08 update with stdin at EOF', () => {
  const r = spawnCli(['update'], probeEnv, { timeoutMs: 5000 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'kiro-claude is updated by its installer; nothing to do. Update Claude Code with: claude update\n');
});

test('KC-CLI-09 agent validate --path', () => {
  const good = t.write('specs/kirocrew.json', { name: 'kirocrew', tools: ['*'], allowedTools: ['fs_read'], mcpServers: {} });
  const r = spawnCli(['agent', 'validate', '--path', good], probeEnv);
  assert.equal(r.code, 0);
  assert.equal(r.stdout + r.stderr, '');
  const bad = t.write('specs/bad.json', { name: 'bad', tools: 5 });
  const b = spawnCli(['agent', 'validate', '--path', bad], probeEnv);
  assert.equal(b.code, 1);
  assert.ok(b.stdout.includes('is invalid'));
  assert.equal(b.stdout, `Error: Json supplied at ${bad} is invalid: /tools: expected array of strings, found number\n`);
});

test('KC-CLI-10 (chat) --agent-engine v3 rejected quickly', () => {
  const r = spawnCli(['chat', '--agent-engine', 'v3'], probeEnv);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.startsWith("error: invalid value 'v3' for '--agent-engine <ENGINE>'\n  [possible values: v1, v2]\n"));
});

test('usage errors exit 2 in the subprocess too', () => {
  const r = spawnCli(['--bogus-flag'], probeEnv);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^error: unexpected argument '--bogus-flag' found\n/);
});
