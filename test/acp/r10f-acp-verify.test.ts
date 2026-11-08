/**
 * Round 10, verification of the acp group's fix for #4 (an ACP setter's answer agrees with what
 * the session reports afterwards). The ACP server with the REAL session module and the fake
 * Claude Code CLI.
 *
 * A `session/set_model` of the model the session already has, whose `set_model` control request
 * Claude Code never answers (the child dies during it; the 60 s timeout takes the same path), is
 * what KiroCrew sends at a session's start and at a warm-pool claim (it pins its model whatever
 * the session reports). The session keeps that model, saves it and starts its next child
 * with it, so the answer is `{}` with its `config_option_update`, as for any other kept switch. An
 * error there (it was `-32603`) reaches KiroCrew's session handle within its 3 s wait, which
 * records the pin as refused (`model_pin_refused`) while kiro-claude runs it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TestClient, tmpEnv, until, type Frame, type TmpEnv } from './helpers.js';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(15_000)));
});

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

/** The pid of the fake child that received a `set_model` control request, once one has. */
function setModelPid(log: string): number | undefined {
  const hit = fakeLog(log).find((x) => x.event === 'stdin' && x.line?.type === 'control_request' && x.line?.request?.subtype === 'set_model');
  return typeof hit?.pid === 'number' ? hit.pid : undefined;
}

/** SIGKILL `pid`, but only while it is this test process's own child (a session's Claude child). */
function killOwnChild(pid: number): void {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  assert.equal(ppid, process.pid, `pid ${pid} is not a child of this test`);
  process.kill(pid, 'SIGKILL');
}

interface Env {
  t: TmpEnv;
  c: TestClient;
  log: string;
}

async function server(): Promise<Env> {
  // every set_model control request is held (never answered)
  const t = tmpEnv({ FAKE_CLAUDE_PERSIST: '1', FAKE_CLAUDE_CONTROL_DELAYS: JSON.stringify({ set_model: 200_000 }) });
  const log = path.join(t.root, 'fake-claude.jsonl');
  t.env.FAKE_CLAUDE_LOG = log;
  const run = path.join(t.root, 'run');
  fs.mkdirSync(run, { mode: 0o700 });
  t.env.XDG_RUNTIME_DIR = run;
  const c = new TestClient({ args: [], env: t.env, cwd: t.work });
  clients.push(c);
  await c.initialize();
  return { t, c, log };
}

const modelOf = (opts: Frame[]): string => String(opts.find((o) => o.id === 'model')!.currentValue);
const record = (e: Env, sid: string): Frame => JSON.parse(fs.readFileSync(path.join(e.t.kiroHome, 'sessions', 'cli', `${sid}.json`), 'utf8')) as Frame;
const modelUpdates = (e: Env, sid: string, from: number): string[] =>
  e.c.frames
    .slice(from)
    .filter((f) => f.method === 'session/update' && f.params?.sessionId === sid && f.params.update?.sessionUpdate === 'config_option_update')
    .map((f) => modelOf(f.params.update.configOptions as Frame[]));

test('set_model of the model the session already has, whose Claude child dies mid-request, answers {} with its config_option_update', { timeout: 120_000 }, async () => {
  const e = await server();
  // an advertised haiku id, read from a first session
  const probe = await e.c.call('session/new', { cwd: e.t.work, mcpServers: [] }, 30_000);
  const mo = (probe.configOptions as Frame[]).find((o) => o.id === 'model')!;
  const target = (mo.options as Frame[]).map((o) => String(o.value)).find((v) => /haiku/.test(v) && v !== mo.currentValue);
  assert.ok(target, 'an advertised haiku model');
  await e.c.call('_kiro.dev/session/terminate', { sessionId: probe.sessionId }, 30_000);
  // the session KiroCrew pins: it already runs `target` (as after a session/load of a record on it)
  const r = await e.c.call('session/new', { cwd: e.t.work, mcpServers: [], _meta: { kiro: { modelId: target } } }, 30_000);
  const sid = r.sessionId as string;
  assert.equal(modelOf(r.configOptions as Frame[]), target);
  const from = e.c.frames.length;
  const pending = e.c.request('session/set_model', { sessionId: sid, modelId: target }, 30_000);
  await until(() => setModelPid(e.log) !== undefined, 15_000, 'the set_model control request reaching Claude Code');
  killOwnChild(setModelPid(e.log)!);
  const answer = await pending;
  assert.equal(answer.error, undefined, `the session kept the model it was asked for, so the answer says so: ${JSON.stringify(answer.error)}`);
  assert.deepEqual(answer.result, {});
  assert.deepEqual(modelUpdates(e, sid, from), [target], 'the config_option_update of a kept switch');
  // configOptions, the record and the next child agree
  const cfg = await e.c.call('session/set_config_option', { sessionId: sid, configId: 'effort', value: 'high' }, 30_000);
  assert.equal(modelOf(cfg.configOptions as Frame[]), target);
  assert.equal(record(e, sid).model, target);
  const prompted = await e.c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hello' }] }, 30_000);
  assert.equal(prompted.result?.stopReason, 'end_turn', JSON.stringify(prompted));
  const starts = fakeLog(e.log).filter((x) => x.event === 'start' && Array.isArray(x.argv) && x.argv.includes('-p'));
  const last = starts[starts.length - 1]!.argv as string[];
  assert.equal(String(last[last.indexOf('--model') + 1]).includes('haiku'), true, `the respawned child runs the model: ${last.join(' ')}`);
  assert.equal(await e.c.close(20_000), 0);
  assert.deepEqual(e.c.nonJson, [], 'stdout carries only JSON-RPC frames');
});

test('commands/execute model of the model the session already has, whose Claude child dies mid-request, answers success', { timeout: 120_000 }, async () => {
  const e = await server();
  const r = await e.c.call('session/new', { cwd: e.t.work, mcpServers: [] }, 30_000);
  const sid = r.sessionId as string;
  const current = modelOf(r.configOptions as Frame[]);
  const pending = e.c.request('_kiro.dev/commands/execute', { sessionId: sid, command: { command: 'model', args: { value: current } } }, 30_000);
  await until(() => setModelPid(e.log) !== undefined, 15_000, 'the set_model control request reaching Claude Code');
  killOwnChild(setModelPid(e.log)!);
  const answer = await pending;
  assert.deepEqual(answer.result, { success: true, message: `Model set to ${current}`, data: { model: { id: current } } }, JSON.stringify(answer));
  assert.equal(await e.c.close(20_000), 0);
});
