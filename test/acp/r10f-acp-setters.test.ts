/**
 * Round 10 fixes, group acp (#4), with a mock session: every ACP setter answers what the session
 * reports afterwards. A setter call that fails after the session took the new value (a set_model
 * Claude Code never answered: the 60 s control-request timeout, the child that died; an effort
 * the session saved whose `/effort` line failed; an agent swap whose Claude Code restart failed)
 * is answered as applied, with the update frames of any change. One that fails with the session
 * unchanged stays an error: `Invalid model ID` (-32602) for an id we do not advertise and for a
 * switch Claude Code refused, `Internal error` (-32603) with the reason otherwise.
 *
 * The mocks reproduce KiroSessionImpl's own outcomes (setModel keeps the model on a timeout and
 * reverts it on a refusal, setEffort keeps a validated level, swapAgent switches before its
 * restart), so the 60 s timeout costs nothing here.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { ClaudeControlError, ClaudeProcessError } from '../../src/claude/process.js';
import { MockSession, createWorld, mockFactory, type MockWorld } from './mockSession.js';
import { TestClient, tmpEnv, writeAgent, type Frame, type TmpEnv } from './helpers.js';

const clients: TestClient[] = [];
after(async () => {
  await Promise.allSettled(clients.filter((c) => c.exitCode === undefined).map((c) => c.close(10_000)));
});

interface Setup {
  t: TmpEnv;
  world: MockWorld;
  c: TestClient;
  sid: string;
  ms: MockSession;
}

async function setup(): Promise<Setup> {
  const t = tmpEnv();
  writeAgent(path.join(t.work, '.kiro'), 'probe', { description: 'probe', tools: ['*'] });
  writeAgent(t.kiroHome, 'other', { description: 'another agent', tools: ['*'] });
  const world = createWorld();
  const c = new TestClient({ args: ['--agent', 'probe'], env: t.env, cwd: t.work, createSession: mockFactory(world) });
  clients.push(c);
  await c.initialize();
  const sid = (await c.call('session/new', { cwd: t.work, mcpServers: [] })).sessionId as string;
  return { t, world, c, sid, ms: world.sessions[0]! };
}

const TIMEOUT = (): ClaudeControlError => new ClaudeControlError("Control request 'set_model' timed out after 60000 ms", 'set_model', true);
const REFUSAL = (): ClaudeControlError => new ClaudeControlError('model not available', 'set_model');

const updatesFrom = (s: Setup, kind: string, from: number): Frame[] =>
  s.c.frames.slice(from).filter((f) => f.method === 'session/update' && f.params?.sessionId === s.sid && f.params.update?.sessionUpdate === kind).map((f) => f.params.update as Frame);
const option = (opts: Frame[], id: string): unknown => opts.find((o) => o.id === id)!.currentValue;

/**
 * configOptions as the session reports them now, from a harmless write of the other setter (the
 * one the test left alone): `effort` 'low' in the model tests, the current model in the effort tests.
 */
async function reported(s: Setup, via: 'effort' | 'model'): Promise<Frame[]> {
  const value = via === 'effort' ? 'low' : s.ms.model;
  return (await s.c.call('session/set_config_option', { sessionId: s.sid, configId: via, value })).configOptions as Frame[];
}

async function done(s: Setup): Promise<void> {
  assert.equal(await s.c.close(), 0);
}

// ───────────── model ─────────────

/** setModel as KiroSessionImpl does it when Claude Code never answers: the model is kept. */
function keepThenThrow(s: Setup, err: () => Error): void {
  s.ms.setModel = async (id: string) => {
    s.world.calls.push(`setModel:${id}`);
    s.ms.model = id;
    throw err();
  };
}

test('set_model that timed out after the session kept the model answers {} with a config_option_update', async () => {
  const s = await setup();
  keepThenThrow(s, TIMEOUT);
  const from = s.c.frames.length;
  const r = await s.c.request('session/set_model', { sessionId: s.sid, modelId: 'claude-haiku-5.5' });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(r.result, {});
  assert.deepEqual(updatesFrom(s, 'config_option_update', from).map((u) => option(u.configOptions, 'model')), ['claude-haiku-5.5']);
  assert.equal(option(await reported(s, 'effort'), 'model'), 'claude-haiku-5.5');
  await done(s);
});

test('set_config_option model and commands/execute model with a dead child the session survived answer the kept model', async () => {
  const s = await setup();
  keepThenThrow(s, () => new ClaudeProcessError('Claude Code exited (signal SIGKILL)', { signal: 'SIGKILL' }));
  const a = await s.c.request('session/set_config_option', { sessionId: s.sid, configId: 'model', value: 'claude-sonnet-5.5' });
  assert.equal(a.error, undefined, JSON.stringify(a.error));
  assert.equal(option(a.result.configOptions, 'model'), 'claude-sonnet-5.5');
  const b = await s.c.call('_kiro.dev/commands/execute', { sessionId: s.sid, command: { command: 'model', args: { value: 'claude-opus-5.5' } } });
  assert.deepEqual(b, { success: true, message: 'Model set to claude-opus-5.5', data: { model: { id: 'claude-opus-5.5' } } });
  await done(s);
});

test('a set_model Claude Code refused (model unchanged) stays -32602 Invalid model ID with no config_option_update', async () => {
  const s = await setup();
  s.ms.setModel = async () => {
    throw REFUSAL();
  };
  const from = s.c.frames.length;
  const r = await s.c.request('session/set_model', { sessionId: s.sid, modelId: 'claude-haiku-5.5' });
  assert.equal(r.error?.code, -32602);
  assert.equal(r.error.message, 'Invalid model ID: claude-haiku-5.5');
  assert.equal(r.error.data, 'model not available');
  assert.deepEqual(updatesFrom(s, 'config_option_update', from), []);
  assert.equal(option(await reported(s, 'effort'), 'model'), 'auto');
  await done(s);
});

test('a set_model that failed for another reason with the model unchanged is -32603 with the reason, not Invalid model ID', async () => {
  const s = await setup();
  s.ms.setModel = async () => {
    throw new Error('Claude Code failed to start');
  };
  const r = await s.c.request('session/set_model', { sessionId: s.sid, modelId: 'claude-haiku-5.5' });
  assert.equal(r.error?.code, -32603, JSON.stringify(r.error));
  assert.match(String(r.error.data), /Claude Code failed to start/);
  assert.equal(option(await reported(s, 'effort'), 'model'), 'auto');
  // as a command: {success:false} with the reason
  const c = await s.c.call('_kiro.dev/commands/execute', { sessionId: s.sid, command: { command: 'model', args: { value: 'claude-haiku-5.5' } } });
  assert.equal(c.success, false);
  assert.match(c.message, /Claude Code failed to start/);
  await done(s);
});

test('a timed-out set_model of the model the session already has answers {} with a config_option_update (r10 #4 verify)', async () => {
  // the session keeps the model it was asked for (KiroCrew sends its pin at a session's start and
  // a pool claim): an error would read as a refused pin while the session runs it
  const s = await setup();
  s.ms.setModel = async () => {
    throw TIMEOUT();
  };
  const from = s.c.frames.length;
  const r = await s.c.request('session/set_model', { sessionId: s.sid, modelId: 'auto' });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(r.result, {});
  assert.deepEqual(updatesFrom(s, 'config_option_update', from).map((u) => option(u.configOptions, 'model')), ['auto']);
  // a refusal of that model stays one
  s.ms.setModel = async () => {
    throw REFUSAL();
  };
  const refused = await s.c.request('session/set_model', { sessionId: s.sid, modelId: 'auto' });
  assert.equal(refused.error?.code, -32602, JSON.stringify(refused));
  await done(s);
});

// ───────────── effort ─────────────

test('set_config_option effort whose /effort line failed after the session saved the level answers the level with a config_option_update', async () => {
  const s = await setup();
  s.ms.setEffort = async (level: string) => {
    s.ms.effort = level;
    throw new Error('Claude Code exited (signal SIGKILL)');
  };
  const from = s.c.frames.length;
  const r = await s.c.request('session/set_config_option', { sessionId: s.sid, configId: 'effort', value: 'high' });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(option(r.result.configOptions, 'effortLevel'), 'high');
  assert.deepEqual(updatesFrom(s, 'config_option_update', from).map((u) => option(u.configOptions, 'effortLevel')), ['high']);
  const cmd = await s.c.call('_kiro.dev/commands/execute', { sessionId: s.sid, command: { command: 'effort', args: { level: 'max' } } });
  assert.deepEqual(cmd, { success: true, message: 'Effort set to max' });
  assert.equal(option(await reported(s, 'model'), 'effortLevel'), 'max');
  await done(s);
});

test('control: an effort the session refused (level unchanged) is still an error with no config_option_update', async () => {
  const s = await setup();
  s.ms.setEffort = async () => {
    throw new Error('Model claude-haiku-4.5 does not support effort levels');
  };
  const from = s.c.frames.length;
  const r = await s.c.request('session/set_config_option', { sessionId: s.sid, configId: 'effort', value: 'high' });
  assert.equal(r.error?.code, -32603);
  assert.match(String(r.error.data), /does not support effort levels/);
  assert.deepEqual(updatesFrom(s, 'config_option_update', from), []);
  assert.equal(option(await reported(s, 'model'), 'effortLevel'), 'medium');
  await done(s);
});

// ───────────── mode ─────────────

test('set_mode and set_config_option mode whose swap took place but whose restart failed answer success and report the new mode', async () => {
  const s = await setup();
  s.ms.swapAgent = async function (this: MockSession, name: string) {
    await MockSession.prototype.swapAgent.call(this, name);
    throw new ClaudeProcessError('Claude Code exited with code 1');
  };
  const from = s.c.frames.length;
  const r = await s.c.request('session/set_mode', { sessionId: s.sid, modeId: 'other' });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(r.result, {});
  assert.deepEqual(updatesFrom(s, 'current_mode_update', from).map((u) => u.currentModeId), ['other']);
  assert.ok(s.c.frames.slice(from).some((f) => f.method === '_kiro.dev/agent/switched' && f.params.agentName === 'other'));
  const from2 = s.c.frames.length;
  const r2 = await s.c.request('session/set_config_option', { sessionId: s.sid, configId: 'mode', value: 'probe' });
  assert.equal(r2.error, undefined, JSON.stringify(r2.error));
  assert.deepEqual(updatesFrom(s, 'current_mode_update', from2).map((u) => u.currentModeId), ['probe']);
  const cmd = await s.c.call('_kiro.dev/commands/execute', { sessionId: s.sid, command: { command: 'agent', args: { name: 'other' } } });
  assert.equal(cmd.success, true, JSON.stringify(cmd));
  assert.deepEqual(cmd.data, { agent: { name: 'other' } });
  await done(s);
});

test('control: a swap that did not happen (agent unchanged) is still an error with no current_mode_update', async () => {
  const s = await setup();
  s.ms.swapAgent = async () => {
    throw new Error('/agent swap is not possible while a turn is running');
  };
  const from = s.c.frames.length;
  const r = await s.c.request('session/set_mode', { sessionId: s.sid, modeId: 'other' });
  assert.equal(r.error?.code, -32603);
  assert.match(String(r.error.data), /Failed to switch to agent 'other'/);
  assert.deepEqual(updatesFrom(s, 'current_mode_update', from), []);
  assert.equal(s.ms.agent.name, 'probe');
  await done(s);
});
