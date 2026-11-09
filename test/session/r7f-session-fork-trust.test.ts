/**
 * r7 #1 (session group): a fork record (`/rewind N`, `/tangent`, also a `/rewind` inside a
 * tangent) is on disk from the moment it exists with everything the session holds that must not
 * be weaker there: its trust (`/tools untrust` revocations, other agents' parked trust), agent,
 * model, effort, plan mode and tangent name, and the fork it still has to make (`pendingFork`).
 * The record used to be created with the default trust and get the real one only when its new
 * Claude child had started (closeProc + spawn + initialize, seconds with a real claude): a crash
 * (SIGKILL, the OOM killer, power loss) in that window made `chat --resume` (which opens the
 * newest top-level record, the rewind one) run an agent-granted tool the user revoked as trusted.
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
import { closeAll, drain, fakeBinary, fakeCaps, fakeClaudePath, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

const SCRIPT = {
  turns: [{ repeat: true, match: 'run it', steps: [{ tool: { name: 'Bash', input: { command: 'touch made.txt', description: 'touch' } } }, { text: 'TOOL-SAID {{lastToolResult}} END' }] }],
  default: { steps: [{ text: 'HIST[{{historyUserTexts}}]' }] },
};

function sandbox(): Sandbox {
  const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
  // an agent that pre-trusts the shell: `/tools untrust execute_bash` revokes it (revokedTools)
  sb.agent('trusting', { description: 'trusting', tools: ['*'], allowedTools: ['execute_bash'] });
  sb.refresh();
  return sb;
}

const open = (sb: Sandbox, env: NodeJS.ProcessEnv, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env, ...over });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The session state the fork record must hold on disk: kiro_default trusted fs_write (parked), trusting's shell revoked. */
async function setUp(s: KiroSessionImpl): Promise<void> {
  s.trustTools(['fs_write']);
  await s.swapAgent('trusting');
  s.untrustTools(['execute_bash']);
  await s.setEffort('low');
}

/** Wait for a record of `kind` that is not in `known` (the fork being made), read it from disk. */
async function newRecord(sb: Sandbox, known: Set<string>, kind: SessionRecord['forkKind']): Promise<SessionRecord> {
  const store = new SessionStore(sb.sessionsDir);
  for (let i = 0; i < 400; i++) {
    const r = store.list({ cwd: sb.cwd }).find((x) => !known.has(x.sessionId) && x.forkKind === kind);
    if (r) return r;
    await sleep(10);
  }
  assert.fail(`no ${kind} record appeared`);
}

function assertHolds(rec: SessionRecord, want: { tangentName: string | null; pendingFork: { from: string; at?: string } }): void {
  assert.deepEqual(rec.trust.revokedTools, ['execute_bash'], `the revocation is on disk while the child starts: ${JSON.stringify(rec.trust)}`);
  assert.deepEqual(rec.trust.byAgent?.['kiro_default']?.allowedTools, ['fs_write'], "the other agent's parked trust too");
  assert.equal(rec.agent, 'trusting');
  assert.equal(rec.effort, 'low');
  assert.equal(rec.planMode, true);
  assert.equal(rec.tangentName, want.tangentName);
  assert.deepEqual(rec.pendingFork, want.pendingFork, 'the fork still to be made (a resume after a crash forks its source again)');
}

describe('r7 #1: a fork record on disk while its Claude child starts', () => {
  it('/rewind N: the rewind record holds the trust, agent, effort, plan mode and its fork from the start', async () => {
    const sb = sandbox();
    const env = { ...sb.env };
    const s = await open(sb, env);
    try {
      await drain(s.prompt({ text: 'one' }));
      await drain(s.prompt({ text: 'two' }));
      await setUp(s);
      s.planMode = true;
      const from = s.claudeSessionId!;
      const at = s.record.turns[0]!.assistantUuid!;
      const known = new Set([s.id]);
      env.FAKE_CLAUDE_CONTROL_DELAYS = JSON.stringify({ initialize: 1500 });
      const p = s.rewind(1);
      const rew = await newRecord(sb, known, 'rewind');
      assert.equal(new SessionStore(sb.sessionsDir).latestResumable(sb.cwd)?.sessionId, rew.sessionId, 'precondition: chat --resume would open it');
      await p;
      assertHolds(rew, { tangentName: null, pendingFork: { from, at } });
    } finally {
      await closeAll(s);
    }
  });

  it('/tangent: the tangent record holds them from the start', async () => {
    const sb = sandbox();
    const env = { ...sb.env };
    const s = await open(sb, env);
    try {
      await drain(s.prompt({ text: 'one' }));
      await setUp(s);
      s.planMode = true;
      const from = s.claudeSessionId!;
      const known = new Set([s.id]);
      env.FAKE_CLAUDE_CONTROL_DELAYS = JSON.stringify({ initialize: 1500 });
      const p = s.enterTangent('side');
      const tan = await newRecord(sb, known, 'tangent');
      await p;
      assertHolds(tan, { tangentName: 'side', pendingFork: { from } });
    } finally {
      await closeAll(s);
    }
  });

  it('/rewind inside a tangent: the rewound record keeps the tangent name and holds them from the start', async () => {
    const sb = sandbox();
    const env = { ...sb.env };
    const s = await open(sb, env);
    try {
      await drain(s.prompt({ text: 'one' }));
      await s.enterTangent('side');
      await drain(s.prompt({ text: 'side one' }));
      await setUp(s);
      s.planMode = true;
      const from = s.claudeSessionId!;
      const at = s.record.turns[1]!.assistantUuid!;
      const known = new Set(new SessionStore(sb.sessionsDir).list({ cwd: sb.cwd }).map((r) => r.sessionId));
      env.FAKE_CLAUDE_CONTROL_DELAYS = JSON.stringify({ initialize: 1500 });
      const p = s.rewind(2);
      const rew = await newRecord(sb, known, 'rewind');
      await p;
      assertHolds(rew, { tangentName: 'side', pendingFork: { from, at } });
    } finally {
      await closeAll(s);
    }
  });
});

describe('r7 #1: the other records a session creates', () => {
  it('create({ fork }) (a /spec phase session or continuation): plan mode and the chat\'s trust on disk while its child starts', async () => {
    const sb = sandbox();
    const env = { ...sb.env };
    const chat = await open(sb, env, { agentName: 'trusting' });
    let fork: KiroSessionImpl | undefined;
    try {
      await drain(chat.prompt({ text: 'one' }));
      chat.untrustTools(['execute_bash']);
      chat.planMode = true;
      const known = new Set([chat.id]);
      env.FAKE_CLAUDE_CONTROL_DELAYS = JSON.stringify({ initialize: 1500 });
      const p = open(sb, env, {
        origin: 'spec',
        agentName: 'trusting',
        initialTrust: { trust: chat.trust, agent: 'trusting' },
        fork: { fromClaudeSessionId: chat.claudeSessionId!, kind: 'main', parentId: chat.id },
      });
      const rec = await newRecord(sb, known, 'main');
      fork = await p;
      assert.equal(rec.planMode, true, "the parent's plan mode, before the spec driver sets the flow's");
      assert.deepEqual(rec.trust.revokedTools, ['execute_bash'], 'the initial trust');
    } finally {
      await closeAll(fork, chat);
    }
  });
});

// ── a real crash while the rewind's child starts, then `chat --no-interactive --resume` ──

const moduleUrl = (rel: string): string => new URL(rel, import.meta.url).href;

/** A child node process drives the session and SIGKILLs itself while the rewind's child starts. */
function crashDuringRewind(sb: Sandbox, inTangent: boolean): { mainId: string; rewindId?: string } {
  const outFile = path.join(sb.root, 'out.json');
  const code = `
    import * as fs from 'node:fs';
    const { KiroSessionImpl } = await import(${JSON.stringify(moduleUrl('../../src/session/kiroSession.js'))});
    const { SessionStore } = await import(${JSON.stringify(moduleUrl('../../src/session/store.js'))});
    const { createWorkspaceContext } = await import(${JSON.stringify(moduleUrl('../../src/config/workspace.js'))});
    const { fakeBinary, fakeCaps, recordingUI, drain } = await import(${JSON.stringify(moduleUrl('./helpers.js'))});
    const cfg = JSON.parse(process.env.R7F_CFG);
    const env = { ...process.env };
    const ws = createWorkspaceContext(cfg.cwd, env);
    const s = await KiroSessionImpl.create({ ws, origin: 'repl', interactive: true, ui: recordingUI(), binary: fakeBinary(), caps: await fakeCaps(), env, agentName: 'trusting' });
    const out = { mainId: s.id };
    await drain(s.prompt({ text: 'one' }));
    if (cfg.inTangent) { await s.enterTangent('side'); await drain(s.prompt({ text: 'side one' })); }
    else await drain(s.prompt({ text: 'two' }));
    s.untrustTools(['execute_bash']);
    env.FAKE_CLAUDE_CONTROL_DELAYS = JSON.stringify({ initialize: 3000 });
    const store = new SessionStore(cfg.sessionsDir);
    const known = new Set(store.list({ cwd: ws.cwd }).map((r) => r.sessionId));
    void s.rewind(cfg.inTangent ? 2 : 1).catch(() => {});
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const r = store.list({ cwd: ws.cwd }).find((x) => !known.has(x.sessionId));
      if (r) { out.rewindId = r.sessionId; break; }
    }
    await new Promise((r) => setTimeout(r, 500));
    fs.writeFileSync(cfg.outFile, JSON.stringify(out));
    process.kill(process.pid, 'SIGKILL');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...sb.env, TMPDIR: sb.root, KIRO_CLAUDE_FAKE: fakeClaudePath(), R7F_CFG: JSON.stringify({ cwd: sb.cwd, sessionsDir: sb.sessionsDir, inTangent, outFile }) },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.signal, 'SIGKILL', `the child did not crash as planned: status ${r.status}, stderr ${r.stderr}`);
  return JSON.parse(fs.readFileSync(outFile, 'utf8')) as { mainId: string; rewindId?: string };
}

describe('r7 #1: a crash while the /rewind child starts, then chat --no-interactive --resume', () => {
  for (const inTangent of [false, true]) {
    it(`${inTangent ? '/rewind inside a tangent' : '/rewind'}: the revoked tool asks (denied), and the resume forks the rewound conversation`, async () => {
      const sb = sandbox();
      const out = crashDuringRewind(sb, inTangent);
      assert.ok(out.rewindId, 'precondition: the rewind record was written before the crash');
      const store = new SessionStore(sb.sessionsDir);
      assert.deepEqual(store.read(out.mainId)?.trust.revokedTools, ['execute_bash'], 'precondition: main holds the revocation');
      const ui = recordingUI();
      const s = await open(sb, sb.env, { interactive: false, resume: { latest: true } }, ui);
      try {
        assert.equal(s.id, out.rewindId, 'precondition: --resume opens the rewind record');
        const hist = await drain(s.prompt({ text: 'where' }));
        assert.equal(hist.result.text, `HIST[${inTangent ? 'one | side one' : 'one'} | where]`, 'the rewound conversation (its fork made again), not the journal fallback');
        assert.ok(!ui.notices.some((n) => /could not find the saved conversation/.test(n.message)), JSON.stringify(ui.notices));
        const { result } = await drain(s.prompt({ text: 'run it' }));
        const said = /TOOL-SAID ([\s\S]*?) END/.exec(result.text)?.[1] ?? result.text;
        assert.match(said, /not supported in non-interactive mode/, `the revoked tool ran as trusted after the resume: ${said}`);
      } finally {
        await closeAll(s);
      }
    });
  }
});
