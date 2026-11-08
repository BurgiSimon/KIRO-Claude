/**
 * r7 #3 (session group): the model and the effort are session state, like the agent and plan mode
 * (Q keeps the model per process: a tangent's checkpoint holds the conversation, not settings,
 * 06 §6.4). `/agent swap` inside a tangent writes the new agent's model (when it pins a valid one,
 * 01 §5.4 "Agent swap keeps the model unless target agent sets one") to every record of the
 * tangent stack, as it writes the agent and its trust; a `/model` or `/effort` made inside a
 * tangent is written to every record under it too. Whichever way the chat leaves the tangent the
 * main conversation runs on what the user last set (one restart, with that `--model` /
 * `--effort`), and a crash inside the tangent resumes main on it.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionRecord } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, fakeClaudePath, flagValue, mkSandbox, recordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = { default: { steps: [{ text: 'MODEL={{model}} EFFORT={{effort}}' }] } };

function sandbox(env: Record<string, string> = {}): Sandbox {
  const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1', ...env } });
  sb.agent('pinned', { description: 'pinned', tools: ['read'], model: 'claude-haiku-4.5' });
  sb.refresh();
  return sb;
}
const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps, env: sb.env, ...over });
const read = (sb: Sandbox, id: string): SessionRecord => {
  const r = new SessionStore(sb.sessionsDir).read(id);
  assert.ok(r, `record ${id} exists`);
  return r;
};
const lastStart = (sb: Sandbox): string[] => {
  const st = sb.starts();
  return st[st.length - 1]!;
};
const answer = async (s: KiroSessionImpl, text: string): Promise<string> => (await drain(s.prompt({ text }))).result.text;

describe('r7 #3: /agent swap inside a tangent: the agent\'s pinned model goes with it', () => {
  it('control: the swap in main runs the agent on its model', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      await drain(s.prompt({ text: 'hello' }));
      await s.swapAgent('pinned');
      assert.equal(s.model, 'claude-haiku-4.5');
      assert.equal(read(sb, s.id).model, 'claude-haiku-4.5');
      assert.equal(flagValue(lastStart(sb), '--model'), 'claude-haiku-4-5-20251001');
    } finally {
      await closeAll(s);
    }
  });

  it("main's record on disk names the agent AND its model at once; every record of a nested stack", async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'hello' }));
      await s.enterTangent('outer');
      const outerId = s.id;
      await drain(s.prompt({ text: 'outer line' }));
      await s.enterTangent('inner');
      await s.swapAgent('pinned');
      assert.equal(s.model, 'claude-haiku-4.5', 'the tangent runs on the pinned model');
      for (const id of [mainId, outerId]) {
        const r = read(sb, id);
        assert.deepEqual([r.agent, r.model], ['pinned', 'claude-haiku-4.5'], `record ${id === mainId ? 'main' : 'outer'}`);
      }
    } finally {
      await closeAll(s);
    }
  });

  for (const mode of ['discard', 'tail'] as const) {
    it(`then /tangent${mode === 'tail' ? ' tail' : ''}: main runs the agent on its pinned model (one restart)`, async () => {
      const sb = sandbox();
      const s = await open(sb);
      try {
        await drain(s.prompt({ text: 'hello' }));
        await s.enterTangent('side');
        await s.swapAgent('pinned');
        await drain(s.prompt({ text: 'in tangent' }));
        const before = sb.starts().length;
        await s.exitTangent(mode);
        assert.equal(sb.starts().length, before + 1, 'the return restarts once');
        assert.equal(s.record.agent, 'pinned');
        assert.equal(s.model, 'claude-haiku-4.5', `main runs agent pinned on ${s.model}`);
        assert.equal(flagValue(lastStart(sb), '--model'), 'claude-haiku-4-5-20251001');
        assert.match(await answer(s, 'back in main'), /^MODEL=claude-haiku-4-5-20251001 /);
      } finally {
        await closeAll(s);
      }
    });
  }

  it('an agent whose model is invalid keeps the model, in the tangent and under it', async () => {
    const sb = sandbox();
    sb.agent('bogus', { description: 'bogus', tools: ['read'], model: 'no-such-model' });
    sb.refresh();
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'hello' }));
      await s.setModel('claude-sonnet-4.6');
      await s.enterTangent('side');
      await s.swapAgent('bogus');
      assert.equal(s.model, 'claude-sonnet-4.6');
      assert.deepEqual([read(sb, mainId).agent, read(sb, mainId).model], ['bogus', 'claude-sonnet-4.6']);
    } finally {
      await closeAll(s);
    }
  });
});

describe('r7 #3: /model and /effort inside a tangent are session state', () => {
  it('/model inside a tangent: written to every record under it at once and kept on return (its --model)', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'hello' }));
      await s.enterTangent('outer');
      const outerId = s.id;
      await drain(s.prompt({ text: 'outer line' }));
      await s.enterTangent('inner');
      await s.setModel('claude-sonnet-4.6');
      for (const id of [mainId, outerId]) assert.equal(read(sb, id).model, 'claude-sonnet-4.6', `record ${id === mainId ? 'main' : 'outer'}`);
      const before = sb.starts().length;
      await s.exitTangent('discard');
      assert.equal(sb.starts().length, before + 1, 'the return restarts once');
      assert.equal(s.id, outerId);
      assert.equal(s.model, 'claude-sonnet-4.6');
      assert.equal(flagValue(lastStart(sb), '--model'), 'claude-sonnet-4-6');
      await s.exitTangent('discard');
      assert.equal(s.id, mainId);
      assert.match(await answer(s, 'back in main'), /^MODEL=claude-sonnet-4-6 /);
    } finally {
      await closeAll(s);
    }
  });

  it('/effort inside a tangent: written to the records under it and kept on return (its --effort)', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'hello' }));
      await s.enterTangent('side');
      await s.setEffort('low');
      assert.equal(read(sb, mainId).effort, 'low');
      await s.exitTangent('discard');
      assert.equal(s.effort, 'low');
      assert.equal(flagValue(lastStart(sb), '--effort'), 'low');
      assert.match(await answer(s, 'back in main'), / EFFORT=low$/);
    } finally {
      await closeAll(s);
    }
  });

  it('a /model Claude refuses inside a tangent changes no record of the stack', async () => {
    const sb = sandbox({ FAKE_CLAUDE_CONTROL_ERRORS: JSON.stringify({ set_model: 'model not available' }) });
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'hello' }));
      const before = s.model;
      await s.enterTangent('side');
      await assert.rejects(s.setModel('claude-sonnet-4.6'), /model not available/);
      assert.equal(s.model, before);
      assert.equal(read(sb, mainId).model, before, "main's record on disk");
      s.untrustTools(['fs_write']); // writes the stack again: still the old model
      assert.equal(read(sb, mainId).model, before);
      await s.exitTangent('discard');
      assert.equal(s.model, before, 'main after the return');
    } finally {
      await closeAll(s);
    }
  });

  it('KIRO_CLAUDE_FORCE_MODEL: a /model inside a tangent is recorded on the records under it too', async () => {
    const sb = sandbox({ KIRO_CLAUDE_FORCE_MODEL: 'haiku' });
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'hello' }));
      await s.enterTangent('side');
      await s.setModel('claude-sonnet-4.6');
      assert.equal(read(sb, mainId).model, 'claude-sonnet-4.6');
      await s.exitTangent('discard');
      assert.equal(s.model, 'claude-sonnet-4.6');
      assert.equal(flagValue(lastStart(sb), '--model'), 'haiku', 'still forced');
    } finally {
      await closeAll(s);
    }
  });
});

// ── a real crash inside the tangent (no close), then `chat --no-interactive --resume` ──

const moduleUrl = (rel: string): string => new URL(rel, import.meta.url).href;

function crashInTangent(sb: Sandbox, change: 'swap' | 'model' | 'effort'): { mainId: string } {
  const outFile = path.join(sb.root, 'out.json');
  const code = `
    import * as fs from 'node:fs';
    const { KiroSessionImpl } = await import(${JSON.stringify(moduleUrl('../../src/session/kiroSession.js'))});
    const { createWorkspaceContext } = await import(${JSON.stringify(moduleUrl('../../src/config/workspace.js'))});
    const { fakeBinary, fakeCaps, recordingUI, drain } = await import(${JSON.stringify(moduleUrl('./helpers.js'))});
    const cfg = JSON.parse(process.env.R7F_CFG);
    const ws = createWorkspaceContext(cfg.cwd, process.env);
    const s = await KiroSessionImpl.create({ ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps: await fakeCaps(), env: process.env });
    const out = { mainId: s.id };
    await drain(s.prompt({ text: 'hello' }));
    await s.enterTangent('side');
    if (cfg.change === 'swap') await s.swapAgent('pinned');
    else if (cfg.change === 'model') await s.setModel('claude-sonnet-4.6');
    else await s.setEffort('low');
    await drain(s.prompt({ text: 'in tangent' }));
    fs.writeFileSync(cfg.outFile, JSON.stringify(out));
    process.kill(process.pid, 'SIGKILL');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...sb.env, KIRO_CLAUDE_FAKE: fakeClaudePath(), R7F_CFG: JSON.stringify({ cwd: sb.cwd, change, outFile }) },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.signal, 'SIGKILL', `the child did not crash as planned: status ${r.status}, stderr ${r.stderr}`);
  return JSON.parse(fs.readFileSync(outFile, 'utf8')) as { mainId: string };
}

describe('r7 #3: a crash inside the tangent, then chat --resume (opens main)', () => {
  const cases = [
    { change: 'swap', agent: 'pinned', answer: /^MODEL=claude-haiku-4-5-20251001 / },
    { change: 'model', agent: 'kiro_default', answer: /^MODEL=claude-sonnet-4-6 / },
    { change: 'effort', agent: 'kiro_default', answer: / EFFORT=low$/ },
  ] as const;
  for (const c of cases) {
    it(`${c.change === 'swap' ? '/agent swap' : c.change === 'model' ? '/model' : '/effort'} inside the tangent: main resumes on it`, async () => {
      const sb = sandbox();
      const out = crashInTangent(sb, c.change);
      const s = await open(sb, { interactive: false, resume: { latest: true } });
      try {
        assert.equal(s.id, out.mainId, 'precondition: --resume opens main');
        assert.equal(s.agent.name, c.agent);
        assert.match(await answer(s, 'after crash'), c.answer);
      } finally {
        await closeAll(s);
      }
    });
  }
});
