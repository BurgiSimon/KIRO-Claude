/**
 * Opt-in end-to-end suite: the BUILT kiro-claude CLI (run as a child process) against the REAL
 * `claude` on PATH with your existing Claude Code login. Every case makes a few small model
 * calls (`--model ${KIRO_CLAUDE_E2E_MODEL:-haiku}`) that bill your subscription, so the suite is
 * skipped unless KIRO_CLAUDE_E2E=1:
 *
 *   npm run build && KIRO_CLAUDE_E2E=1 node --test dist/test/e2e/cli-real.test.js
 *   (or: npm run test:e2e)
 *
 * Isolation: KIRO_HOME and the project (a `git init`ed temp dir used as cwd) are private to
 * each case; HOME and CLAUDE_CONFIG_DIR are NOT overridden (that would hide the login). See
 * ./helpers.ts.
 *
 * Cases (the real-claude smoke tests of the port, one test each):
 *   a) headless `chat --no-interactive` answers PONG;
 *   b) steering resource + agentSpawn hook output + agent prompt reach the system-prompt file
 *      (captured by a KIRO_CLAUDE_BIN wrapper that execs the real claude) and the model uses it;
 *   c) the V2 gate: fs_write allowedPaths, non-interactive denial text, deniedCommands,
 *      allowedCommands;
 *   d) REPL line mode with a `y` approval, `/quit`, resume hint;
 *   e) ACP: initialize / session/new / prompt / request_permission(allow_once) / EOF exit, then
 *      a new process: session/load replay + resumed memory;
 *   f) the kiro-cli session files written by (e);
 *   g) `spec new … --type quick --yes` writes requirements.md, design.md, tasks.md.
 */
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after } from 'node:test';

import {
  AcpClient,
  CliProc,
  MODEL,
  describeRun,
  e2eTest,
  makeProject,
  realClaudePath,
  runCli,
  shQuote,
  type E2EProject,
  type Frame,
} from './helpers.js';

/** Kiro texts the port must reproduce (literal on purpose: a change here is a regression). */
const NON_INTERACTIVE_DENY =
  '[denied] tool permission approval is not supported in non-interactive mode. Use --trust-all-tools to auto-approve.';
const DENIED_COMMANDS_TEXT = 'Command execute_bash is rejected because it matches one or more rules on the denied list:';
const APPROVAL_QUESTION = "Allow this action? Use 't' to trust (always allow) this tool for the session. [y/n/t]:";
const RESUME_HINT_RE = /To resume this session: kiro-claude chat --resume-id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/** Per-process limit inside a case (cases themselves are capped at 240 s, spec at 600 s). */
const RUN_MS = 180_000;

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

// ───────────────────────────── a) headless ─────────────────────────────

e2eTest('a) headless: chat --no-interactive answers PONG and exits 0', 240_000, async (t) => {
  const p = makeProject(t);
  const r = await runCli(['chat', '--no-interactive', '--model', MODEL, 'Reply with exactly the word PONG'], {
    cwd: p.project,
    env: p.env,
    timeoutMs: RUN_MS,
  });
  assert.equal(r.timedOut, false, `timed out\n${describeRun(r)}`);
  assert.equal(r.code, 0, describeRun(r));
  assert.match(r.stdout, /PONG/, describeRun(r));
});

// ───────────────────────────── b) context ─────────────────────────────

/** `sh` wrapper used as KIRO_CLAUDE_BIN: keeps the argv and a copy of the system-prompt file, then execs the real claude. */
function claudeWrapperScript(realClaude: string, captureDir: string): string {
  return [
    '#!/bin/sh',
    '# kiro-claude e2e: capture --append-system-prompt-file, then run the real claude',
    `cap=${shQuote(captureDir)}`,
    'printf \'%s\\n\' "$@" > "$cap/argv-$$.txt"',
    'prev=',
    'for a in "$@"; do',
    '  case "$a" in',
    '    --append-system-prompt-file=*) cp "${a#--append-system-prompt-file=}" "$cap/system-prompt.md" ;;',
    '  esac',
    '  if [ "$prev" = "--append-system-prompt-file" ]; then cp "$a" "$cap/system-prompt.md"; fi',
    '  prev=$a',
    'done',
    `exec ${shQuote(realClaude)} "$@"`,
    '',
  ].join('\n');
}

e2eTest('b) context: steering resource, agentSpawn hook output and agent prompt reach the system prompt', 240_000, async (t) => {
  if (process.platform === 'win32') {
    t.skip('the KIRO_CLAUDE_BIN capture wrapper is a POSIX sh script');
    return;
  }
  const p = makeProject(t);
  const captureDir = path.join(p.root, 'capture');
  fs.mkdirSync(captureDir);
  const wrapper = path.join(p.root, 'claude-wrapper');
  fs.writeFileSync(wrapper, claudeWrapperScript(realClaudePath(), captureDir), { mode: 0o755 });

  const codeword = `ZEBRA-${randomInt(1000, 10000)}`;
  const hookMark = `HOOK-SPAWN-${p.token}`;
  const promptMark = `AGENT-PROMPT-${p.token}`;
  p.write(path.join('.kiro', 'steering', 'project.md'), `# Project facts\n\nThe project codeword is ${codeword}.\n`);
  p.agent('ctx', {
    description: 'kiro-claude e2e context agent',
    prompt: `${promptMark}: you are a terse assistant; answer in one short line.`,
    tools: [],
    resources: ['file://.kiro/steering/**/*.md'],
    hooks: { agentSpawn: [{ command: `echo ${hookMark}` }] },
    includeMcpJson: false,
  });

  const r = await runCli(
    ['chat', '--no-interactive', '--agent', 'ctx', '--model', MODEL, 'Without tools, what is the codeword? Reply with just the codeword.'],
    { cwd: p.project, env: { ...p.env, KIRO_CLAUDE_BIN: wrapper }, timeoutMs: RUN_MS },
  );
  assert.equal(r.timedOut, false, `timed out\n${describeRun(r)}`);
  assert.equal(r.code, 0, describeRun(r));

  const captured = path.join(captureDir, 'system-prompt.md');
  const argvFiles = fs.readdirSync(captureDir).filter((f) => f.startsWith('argv-'));
  assert.ok(
    fs.existsSync(captured),
    `no --append-system-prompt-file seen by the wrapper; argv:\n${argvFiles.map((f) => fs.readFileSync(path.join(captureDir, f), 'utf8')).join('\n---\n')}`,
  );
  const sys = fs.readFileSync(captured, 'utf8');
  const show = `--- system prompt file ---\n${sys.slice(0, 6000)}`;
  assert.ok(sys.includes(`The project codeword is ${codeword}.`), `steering text missing\n${show}`);
  assert.ok(sys.includes(path.join(p.project, '.kiro', 'steering', 'project.md')), `steering entry has no [path] label\n${show}`);
  assert.ok(sys.includes(hookMark), `agentSpawn hook output missing\n${show}`);
  assert.ok(sys.includes(`Follow this instruction: ${promptMark}`), `agent prompt missing\n${show}`);
  assert.ok(sys.indexOf(hookMark) < sys.indexOf(promptMark), `the agent prompt comes last\n${show}`);
  assert.ok(sys.includes('--- CONTEXT ENTRY BEGIN ---') && sys.includes('--- CONTEXT ENTRY END ---'), `Q context entry markers missing\n${show}`);

  assert.ok(r.stdout.toUpperCase().includes(codeword), `the model did not use the steering context\n${describeRun(r)}`);
});

// ───────────────────────────── c) gate ─────────────────────────────

e2eTest('c) gate: allowedPaths write, non-interactive denial, deniedCommands, allowedCommands', 240_000, async (t) => {
  const p = makeProject(t);
  p.agent('gate', {
    description: 'kiro-claude e2e gate agent',
    tools: ['*'],
    allowedTools: ['fs_read'],
    toolsSettings: {
      execute_bash: { allowedCommands: ['echo .*'], deniedCommands: ['rm .*'] },
      fs_write: { allowedPaths: ['out/**'] },
    },
    includeMcpJson: false,
  });
  fs.mkdirSync(path.join(p.project, 'out'));
  const inside = path.join(p.project, 'out', 'a.txt');
  const outside = path.join(p.project, 'notes.txt');
  const run = async (prompt: string): Promise<Awaited<ReturnType<typeof runCli>>> => {
    const r = await runCli(['chat', '--no-interactive', '--agent', 'gate', '--model', MODEL, prompt], { cwd: p.project, env: p.env, timeoutMs: 100_000 });
    assert.equal(r.timedOut, false, `timed out\n${describeRun(r)}`);
    assert.equal(r.code, 0, describeRun(r));
    return r;
  };
  const noRetry = 'If the tool call is rejected, do not retry and do not use any other tool; reply with the error text you received.';

  // 1. fs_write inside allowedPaths: allowed without asking
  const r1 = await run('Use the Write tool to create the file out/a.txt containing exactly: inside. Do not use any other tool.');
  assert.ok(fs.existsSync(inside), `out/a.txt was not written\n${describeRun(r1)}`);
  assert.match(fs.readFileSync(inside, 'utf8'), /inside/);
  assert.doesNotMatch(r1.stderr, /Denied:/, describeRun(r1));

  // 2. fs_write outside allowedPaths: needs approval ⇒ denied in --no-interactive with Kiro's text
  const r2 = await run(`Use the Write tool to create the file notes.txt containing exactly: outside. ${noRetry}`);
  assert.ok(r2.stderr.includes(NON_INTERACTIVE_DENY), `no non-interactive denial\n${describeRun(r2)}`);
  assert.equal(fs.existsSync(outside), false, `notes.txt must not exist\n${describeRun(r2)}`);

  // 3. deniedCommands beats everything: the file survives
  const r3 = await run(`Use the Bash tool to run exactly this command: rm -f out/a.txt ${noRetry}`);
  assert.ok(r3.stderr.includes(DENIED_COMMANDS_TEXT), `no deniedCommands denial\n${describeRun(r3)}`);
  assert.ok(r3.stderr.includes('\\Arm .*\\z'), `the denied rule is not listed\n${describeRun(r3)}`);
  assert.ok(fs.existsSync(inside), `out/a.txt was deleted\n${describeRun(r3)}`);

  // 4. allowedCommands: runs without asking
  const r4 = await run('Use the Bash tool to run exactly this command: echo GATE_OK — then reply with its output.');
  assert.match(r4.stderr, /Using tool: shell/, describeRun(r4));
  assert.match(r4.stderr, /Completed in/, describeRun(r4));
  assert.doesNotMatch(r4.stderr, /Denied:/, describeRun(r4));
  assert.match(r4.stdout, /GATE_OK/, describeRun(r4));
});

// ───────────────────────────── d) REPL line mode ─────────────────────────────

e2eTest('d) REPL line mode: y at the approval prompt writes the file, /quit prints the resume hint', 240_000, async (t) => {
  const p = makeProject(t);
  const target = path.join(p.project, 'c.txt');
  const proc = new CliProc(['chat', '--model', MODEL], { cwd: p.project, env: p.env });
  t.after(() => proc.kill());

  proc.write('Use the Write tool to create the file c.txt containing exactly: repl-ok. Do not use any other tool.');
  await proc.waitUntil(() => proc.stdout.includes('[y/n/t]:'), 'the [y/n/t]: approval prompt', 150_000);
  let answered = count(proc.stdout, '[y/n/t]:');
  proc.write('y');
  // wait for the file and the idle prompt; answer any further approval of the same turn with y
  await proc.waitUntil(
    () => {
      const asked = count(proc.stdout, '[y/n/t]:');
      if (asked > answered) {
        answered = asked;
        proc.write('y');
      }
      return fs.existsSync(target) && /\n(?:\[[^\]\n]+\] )?(?:\d+% )?(?:↯ )?!?> $/.test(proc.stdout);
    },
    'c.txt and the idle prompt',
    150_000,
  );
  proc.write('/quit');
  proc.end();
  const exitTimer = setTimeout(() => proc.kill(), 60_000);
  const ex = await proc.exited;
  clearTimeout(exitTimer);
  const shown = describeRun({ code: ex.code, stdout: proc.stdout, stderr: proc.stderr });

  assert.equal(ex.code, 0, shown);
  assert.ok(proc.stdout.includes(APPROVAL_QUESTION), shown);
  assert.match(fs.readFileSync(target, 'utf8'), /repl-ok/);
  const hint = RESUME_HINT_RE.exec(proc.stdout);
  assert.ok(hint, `no resume hint\n${shown}`);
  assert.ok(fs.existsSync(path.join(p.kiroHome, 'sessions', 'cli', `${hint[1]}.json`)), `the hinted session is not in the index\n${shown}`);
});

// ───────────────────────────── e) + f) ACP ─────────────────────────────

interface AcpScenario {
  p: E2EProject;
  sessionId: string;
}

let acpScenario: Promise<AcpScenario> | undefined;
const acpClients: AcpClient[] = [];
const acpProjects: E2EProject[] = [];

after(() => {
  for (const c of acpClients) c.kill();
  for (const p of acpProjects) p.cleanup();
});

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'kiro-claude-e2e', version: '0.0.0' },
};
const FIRST_PROMPT = 'Reply with exactly the word PONG';
const textPrompt = (sessionId: string, text: string): Frame => ({ sessionId, prompt: [{ type: 'text', text }] });

/** (e)'s two ACP processes; shared with (f), which runs it itself when (e) did not. */
function runAcpScenario(): Promise<AcpScenario> {
  acpScenario ??= (async () => {
    const p = makeProject();
    acpProjects.push(p);
    const target = path.join(p.project, 'acp.txt');

    // ── process 1: initialize, session/new, PONG, a write behind request_permission, EOF
    const c1 = new AcpClient(['--model', MODEL], { cwd: p.project, env: p.env });
    acpClients.push(c1);
    const init = await c1.call('initialize', INIT_PARAMS, 60_000);
    assert.equal(init.result.protocolVersion, 1, c1.describe());
    assert.equal(init.result.agentCapabilities?.loadSession, true, c1.describe());

    const created = await c1.call('session/new', { cwd: p.project, mcpServers: [] }, 120_000);
    const sessionId = String(created.result.sessionId ?? '');
    assert.match(sessionId, /^[0-9a-f-]{36}$/, c1.describe());

    const pong = await c1.call('session/prompt', textPrompt(sessionId, FIRST_PROMPT), 120_000);
    assert.equal(pong.result.stopReason, 'end_turn', c1.describe());
    assert.match(c1.chunkText(sessionId, 'agent_message_chunk', pong.from, pong.to), /PONG/, c1.describe());

    const write = await c1.call(
      'session/prompt',
      textPrompt(sessionId, 'Use the Write tool to create the file acp.txt containing exactly: acp-ok. Do not use any other tool.'),
      150_000,
    );
    assert.equal(write.result.stopReason, 'end_turn', c1.describe());
    const asked = c1.frames.slice(write.from, write.to).filter((f) => f.method === 'session/request_permission');
    assert.ok(asked.length >= 1, `no session/request_permission\n${c1.describe()}`);
    const opts = (asked[0]!.params?.options ?? []) as Frame[];
    assert.ok(opts.some((o) => o.optionId === 'allow_once'), `no allow_once option\n${c1.describe()}`);
    assert.ok(fs.existsSync(target), `acp.txt was not written\n${c1.describe()}`);
    assert.match(fs.readFileSync(target, 'utf8'), /acp-ok/);
    assert.deepEqual(c1.nonJson, [], 'only JSON-RPC on stdout');

    const ex1 = await c1.endAndWait(30_000);
    assert.equal(ex1.timedOut, false, `acp did not exit on stdin EOF\n${c1.describe()}`);
    assert.equal(ex1.code, 0, c1.describe());

    // ── process 2: session/load replays the history and the conversation continues
    const c2 = new AcpClient(['--model', MODEL], { cwd: p.project, env: p.env });
    acpClients.push(c2);
    await c2.call('initialize', INIT_PARAMS, 60_000);
    const loaded = await c2.call('session/load', { sessionId, cwd: p.project, mcpServers: [] }, 120_000);
    assert.ok(c2.chunkText(sessionId, 'user_message_chunk', loaded.from, loaded.to).includes(FIRST_PROMPT), `no user_message_chunk replay\n${c2.describe()}`);
    assert.match(c2.chunkText(sessionId, 'agent_message_chunk', loaded.from, loaded.to), /PONG/, `no agent_message_chunk replay\n${c2.describe()}`);

    const recall = await c2.call(
      'session/prompt',
      textPrompt(sessionId, 'Without tools, what did you reply to my first message? Answer with just that reply.'),
      120_000,
    );
    assert.equal(recall.result.stopReason, 'end_turn', c2.describe());
    assert.match(c2.chunkText(sessionId, 'agent_message_chunk', recall.from, recall.to), /PONG/, `the resumed session lost its memory\n${c2.describe()}`);
    assert.deepEqual(c2.nonJson, [], 'only JSON-RPC on stdout');

    const ex2 = await c2.endAndWait(30_000);
    assert.equal(ex2.timedOut, false, `acp did not exit on stdin EOF\n${c2.describe()}`);
    assert.equal(ex2.code, 0, c2.describe());
    return { p, sessionId };
  })();
  return acpScenario;
}

e2eTest('e) ACP: initialize, session/new, prompt, request_permission allow_once, EOF exit; session/load replay + memory', 240_000, async () => {
  await runAcpScenario();
});

e2eTest('f) ACP session files: <sid>.json envelope and <sid>.jsonl journal', 240_000, async () => {
  const { p, sessionId } = await runAcpScenario();
  const dir = path.join(p.kiroHome, 'sessions', 'cli');
  const envelopeFile = path.join(dir, `${sessionId}.json`);
  const journalFile = path.join(dir, `${sessionId}.jsonl`);
  assert.ok(fs.existsSync(envelopeFile), `missing ${envelopeFile}; have ${fs.existsSync(dir) ? fs.readdirSync(dir).join(', ') : '(no dir)'}`);
  const env = JSON.parse(fs.readFileSync(envelopeFile, 'utf8')) as Record<string, unknown>;
  assert.equal(env.session_id, sessionId);
  assert.equal(env.cwd, p.project);
  assert.equal(env.kind, 'kiro-claude-session');

  assert.ok(fs.existsSync(journalFile), `missing ${journalFile}`);
  assert.ok(fs.statSync(journalFile).size >= 10, 'KiroCrew ignores journals under 10 bytes');
  const records = fs
    .readFileSync(journalFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { version?: number; kind?: string; data?: { content?: { kind?: string; data?: unknown }[] } });
  const kinds = new Set(records.map((r) => r.kind));
  for (const k of ['Prompt', 'AssistantMessage', 'ToolResults']) assert.ok(kinds.has(k), `no ${k} record; kinds: ${[...kinds].join(', ')}`);
  assert.ok(records.every((r) => r.version === 1), 'every record is version 1');
  const firstPrompt = records.find((r) => r.kind === 'Prompt');
  assert.ok(
    firstPrompt?.data?.content?.some((b) => b.kind === 'text' && String(b.data).includes(FIRST_PROMPT)),
    `first Prompt record: ${JSON.stringify(firstPrompt).slice(0, 500)}`,
  );
});

// ───────────────────────────── g) spec ─────────────────────────────

e2eTest('g) spec new --type quick --yes writes requirements.md, design.md and tasks.md', 600_000, async (t) => {
  const p = makeProject(t);
  const r = await runCli(
    [
      'spec', 'new', 'demo',
      'A tiny TypeScript module add.ts that exports add(a, b) returning the sum of two numbers.',
      '--type', 'quick', '--yes', '--trust-all-tools', '--model', MODEL,
    ],
    { cwd: p.project, env: p.env, timeoutMs: 560_000 },
  );
  assert.equal(r.timedOut, false, `timed out\n${describeRun(r)}`);
  assert.equal(r.code, 0, describeRun(r));
  const dir = path.join(p.project, '.kiro', 'specs', 'demo');
  for (const f of ['requirements.md', 'design.md', 'tasks.md']) {
    const file = path.join(dir, f);
    assert.ok(fs.existsSync(file), `missing ${f}; have ${fs.existsSync(dir) ? fs.readdirSync(dir).join(', ') : '(no spec dir)'}\n${describeRun(r)}`);
    assert.ok(fs.readFileSync(file, 'utf8').trim().length > 0, `${f} is empty`);
  }
});
