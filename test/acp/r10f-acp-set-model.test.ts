/**
 * Round 10 fixes, group acp (#4): an ACP setter's answer agrees with what the session reports
 * afterwards. The ACP server with the REAL session module and the fake Claude Code CLI.
 *
 * - `session/set_model` (and `set_config_option` `model`, `commands/execute model`) of an
 *   advertised id whose `set_model` control request gets no answer (the Claude Code child dies
 *   during it, or the request times out) is answered as applied (`{}`, the new configOptions,
 *   `success:true`) with a `config_option_update`: the session kept the choice, saved it, and its
 *   next child starts with it. `Invalid model ID` (-32602) stays for an id we do not advertise and
 *   for a switch Claude Code refuses (the model stays what it was, no `config_option_update`).
 * - A mode change (`session/set_mode`) whose agent swap took place but whose Claude Code restart
 *   failed answers `{}` and reports the new mode (`current_mode_update`, `_kiro.dev/agent/switched`):
 *   the session runs that agent, and the next prompt starts Claude Code with it.
 *
 * The 60 s timeout itself (claude/process.ts's bounded running timeout) has no injection seam in
 * the session, so that case runs only with KIRO_CLAUDE_SLOW_TESTS=1; the dead child takes the same
 * path (setModel keeps the model for both) and is fast.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TestClient, tmpEnv, until, writeAgent, type Frame, type TmpEnv } from './helpers.js';
import { fakeClaudePath } from '../claude/helpers.js';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(15_000)));
});

const slow = process.env.KIRO_CLAUDE_SLOW_TESTS === '1' ? false : 'the 60 s control-request timeout runs only with KIRO_CLAUDE_SLOW_TESTS=1';

interface Real {
  t: TmpEnv;
  c: TestClient;
  log: string;
  sid: string;
  /** The model the session started on (configOptions). */
  before: string;
  /** An advertised haiku id. */
  target: string;
}

function fakeLog(file: string): Frame[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Frame);
  } catch {
    return [];
  }
}

/** The pid of the fake child that received the `set_model` control request, once it has. */
function setModelPid(log: string): number | undefined {
  const hit = fakeLog(log).find((x) => x.event === 'stdin' && x.line?.type === 'control_request' && x.line?.request?.subtype === 'set_model');
  return typeof hit?.pid === 'number' ? hit.pid : undefined;
}

/** SIGKILL `pid`, but only while it is this test process's own child (the session's Claude child). */
function killOwnChild(pid: number): void {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  assert.equal(ppid, process.pid, `pid ${pid} is not a child of this test`);
  process.kill(pid, 'SIGKILL');
}

async function start(env: Record<string, string> = {}, bin?: (t: TmpEnv) => string): Promise<Real> {
  const t = tmpEnv({ FAKE_CLAUDE_PERSIST: '1', ...env });
  const log = path.join(t.root, 'fake-claude.jsonl');
  t.env.FAKE_CLAUDE_LOG = log;
  if (bin) t.env.KIRO_CLAUDE_BIN = bin(t);
  writeAgent(t.kiroHome, 'other', { description: 'another agent', tools: ['*'], includeMcpJson: false });
  const c = new TestClient({ args: [], env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  const r = await c.call('session/new', { cwd: t.work, mcpServers: [] }, 30_000);
  const mo = (r.configOptions as Frame[]).find((o) => o.id === 'model')!;
  const target = (mo.options as Frame[]).map((o) => String(o.value)).find((v) => /haiku/.test(v) && v !== mo.currentValue);
  assert.ok(target, 'an advertised haiku model');
  return { t, c, log, sid: r.sessionId as string, before: String(mo.currentValue), target };
}

/** The model configOptions report now (a harmless effort write answers them). */
async function currentModel(e: Real): Promise<string> {
  const r = await e.c.call('session/set_config_option', { sessionId: e.sid, configId: 'effort', value: 'high' }, 30_000);
  return String((r.configOptions as Frame[]).find((o) => o.id === 'model')!.currentValue);
}

const record = (e: Real): Frame => JSON.parse(fs.readFileSync(path.join(e.t.kiroHome, 'sessions', 'cli', `${e.sid}.json`), 'utf8')) as Frame;
const modelUpdates = (e: Real, from: number): string[] =>
  e.c.frames
    .slice(from)
    .filter((f) => f.method === 'session/update' && f.params?.sessionId === e.sid && f.params.update?.sessionUpdate === 'config_option_update')
    .map((f) => String((f.params.update.configOptions as Frame[]).find((o) => o.id === 'model')!.currentValue));

/** Sends `method` and kills the Claude child once it holds the unanswered set_model request. */
async function withChildKilled(e: Real, method: string, params: Record<string, unknown>): Promise<Frame> {
  const pending = e.c.request(method, params, 30_000);
  await until(() => setModelPid(e.log) !== undefined, 15_000, 'the set_model control request reaching Claude Code');
  killOwnChild(setModelPid(e.log)!);
  return pending;
}

async function finish(e: Real): Promise<void> {
  assert.equal(await e.c.close(20_000), 0);
  assert.deepEqual(e.c.nonJson, [], 'stdout carries only JSON-RPC frames');
}

const HOLD_SET_MODEL = { FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ set_model: 200_000 }) };

test('set_model whose Claude child dies mid-request answers {} and reports the model the session kept', async () => {
  const e = await start(HOLD_SET_MODEL);
  const from = e.c.frames.length;
  const r = await withChildKilled(e, 'session/set_model', { sessionId: e.sid, modelId: e.target });
  assert.equal(r.error, undefined, `an advertised id the session kept is not an error: ${JSON.stringify(r.error)}`);
  assert.deepEqual(r.result, {});
  // the config_option_update of any switch, before the answer
  assert.deepEqual(modelUpdates(e, from), [e.target]);
  const upd = e.c.frames.findIndex((f, i) => i >= from && f.params?.update?.sessionUpdate === 'config_option_update');
  assert.ok(upd < e.c.frames.indexOf(r), 'the update comes before the answer');
  assert.equal(await currentModel(e), e.target, 'configOptions agree with the answer');
  assert.equal(record(e).model, e.target, 'the record holds the kept model');
  // the next child starts with it
  const prompted = await e.c.request('session/prompt', { sessionId: e.sid, prompt: [{ type: 'text', text: 'hello' }] }, 30_000);
  assert.equal(prompted.result?.stopReason, 'end_turn', JSON.stringify(prompted));
  const starts = fakeLog(e.log).filter((x) => x.event === 'start' && Array.isArray(x.argv) && x.argv.includes('-p'));
  const last = starts[starts.length - 1]!.argv as string[];
  assert.match(String(last[last.indexOf('--model') + 1]), /haiku/, `the respawned child runs the kept model: ${last.join(' ')}`);
  await finish(e);
});

test('set_config_option model whose Claude child dies mid-request returns configOptions naming the kept model', async () => {
  const e = await start(HOLD_SET_MODEL);
  const from = e.c.frames.length;
  const r = await withChildKilled(e, 'session/set_config_option', { sessionId: e.sid, configId: 'model', value: e.target });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal((r.result.configOptions as Frame[]).find((o) => o.id === 'model')!.currentValue, e.target);
  assert.deepEqual(modelUpdates(e, from), [e.target]);
  assert.equal(await currentModel(e), e.target);
  await finish(e);
});

test('commands/execute model whose Claude child dies mid-request answers success with the kept model', async () => {
  const e = await start(HOLD_SET_MODEL);
  const r = await withChildKilled(e, '_kiro.dev/commands/execute', { sessionId: e.sid, command: { command: 'model', args: { value: e.target } } });
  assert.deepEqual(r.result, { success: true, message: `Model set to ${e.target}`, data: { model: { id: e.target } } });
  assert.equal(await currentModel(e), e.target);
  await finish(e);
});

test('a set_model Claude Code refuses stays -32602 Invalid model ID, keeps the old model and sends no config_option_update', async () => {
  const e = await start({ FAKE_CLAUDE_CONTROL_ERRORS: JSON.stringify({ set_model: 'model not available' }) });
  const from = e.c.frames.length;
  const r = await e.c.request('session/set_model', { sessionId: e.sid, modelId: e.target }, 30_000);
  assert.equal(r.error?.code, -32602, JSON.stringify(r));
  assert.equal(r.error.message, `Invalid model ID: ${e.target}`);
  assert.match(String(r.error.data), /model not available/);
  assert.deepEqual(modelUpdates(e, from), []);
  assert.equal(await currentModel(e), e.before);
  const cfg = await e.c.request('session/set_config_option', { sessionId: e.sid, configId: 'model', value: e.target }, 30_000);
  assert.equal(cfg.error?.code, -32602);
  assert.equal(await currentModel(e), e.before);
  await finish(e);
});

test('an id we do not advertise stays -32602 Invalid model ID', async () => {
  const e = await start();
  const r = await e.c.request('session/set_model', { sessionId: e.sid, modelId: 'bogus-model-9' }, 30_000);
  assert.equal(r.error?.code, -32602);
  assert.match(r.error.message, /Invalid model ID: bogus-model-9/);
  assert.equal(await currentModel(e), e.before);
  await finish(e);
});

test('set_model whose control request times out (60 s) answers {} and reports the kept model', { skip: slow, timeout: 150_000 }, async () => {
  const e = await start(HOLD_SET_MODEL);
  const from = e.c.frames.length;
  const t0 = Date.now();
  const r = await e.c.request('session/set_model', { sessionId: e.sid, modelId: e.target }, 120_000);
  assert.ok(Date.now() - t0 >= 59_000, 'answered after the control request timed out');
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(r.result, {});
  assert.deepEqual(modelUpdates(e, from), [e.target]);
  assert.equal(await currentModel(e), e.target);
  await finish(e);
});

test('set_mode whose agent swap took place but whose Claude Code restart failed answers {} and reports the new mode', async () => {
  // a wrapper around the fake that refuses to start a session child while `flag` exists
  let flag = '';
  const e = await start({}, (t) => {
    flag = path.join(t.root, 'refuse-start');
    const wrapper = path.join(t.root, 'claude-wrapper.mjs');
    fs.writeFileSync(
      wrapper,
      [
        '#!/usr/bin/env node',
        "import fs from 'node:fs';",
        `if (process.argv.includes('--input-format') && fs.existsSync(${JSON.stringify(flag)})) {`,
        "  process.stderr.write('wrapper: refusing to start\\n');",
        '  process.exit(1);',
        '}',
        `await import(${JSON.stringify(pathToFileURL(fakeClaudePath()).href)});`,
        '',
      ].join('\n'),
    );
    fs.chmodSync(wrapper, 0o755);
    return wrapper;
  });
  const from = e.c.frames.length;
  fs.writeFileSync(flag, '');
  const r = await e.c.request('session/set_mode', { sessionId: e.sid, modeId: 'other' }, 30_000);
  assert.equal(r.error, undefined, `the session switched, so the answer says so: ${JSON.stringify(r.error)}`);
  assert.deepEqual(r.result, {});
  const modes = e.c.frames.slice(from).filter((f) => f.params?.update?.sessionUpdate === 'current_mode_update').map((f) => f.params.update.currentModeId);
  assert.deepEqual(modes, ['other']);
  assert.ok(e.c.frames.slice(from).some((f) => f.method === '_kiro.dev/agent/switched' && f.params.agentName === 'other'));
  assert.equal(record(e).agent, 'other', 'the record names the agent the answer reported, at once');
  // the next prompt starts Claude Code with the new agent
  fs.rmSync(flag);
  const p = await e.c.request('session/prompt', { sessionId: e.sid, prompt: [{ type: 'text', text: 'hello' }] }, 30_000);
  assert.equal(p.result?.stopReason, 'end_turn', JSON.stringify(p));
  assert.equal(record(e).agent, 'other');
  await finish(e);
});

test('control: set_mode to an agent that does not exist is still an error and changes nothing', async () => {
  const e = await start();
  const from = e.c.frames.length;
  const r = await e.c.request('session/set_mode', { sessionId: e.sid, modeId: 'ghost' }, 30_000);
  assert.equal(r.error?.code, -32603);
  assert.deepEqual(e.c.frames.slice(from).filter((f) => f.params?.update?.sessionUpdate === 'current_mode_update'), []);
  await finish(e);
});
