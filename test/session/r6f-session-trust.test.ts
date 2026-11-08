/**
 * r6 #0 (session group): per-tool trust and the agent are session state shared with the
 * conversations a tangent returns to (Q 06 §1.1, §6.4: a tangent's checkpoint holds the
 * conversation, not tool permissions or the agent), like plan mode (r5 #0). A change made inside a
 * tangent — `/tools trust`, `/tools untrust`, `/tools reset`, `/tools trust-all` (and what a spec
 * flow's carryRestrictions reaches through them), `/agent swap` — is written at once to every
 * record of the tangent stack, so a crash inside the tangent (SIGKILL, the OOM killer: no clean
 * close) never resumes the main conversation with a revoked tool trusted again or on the agent the
 * user left. Trust-all stays per invocation: a resume without `--trust-all-tools` clears it.
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
  default: { steps: [{ text: 'ok' }] },
};

function sandbox(): Sandbox {
  const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
  // a stricter agent: no tool pre-trusted
  sb.agent('strict', { description: 'strict', tools: ['*'], allowedTools: [] });
  sb.refresh();
  return sb;
}

const open = (sb: Sandbox, over: Partial<KiroSessionInternalOptions> = {}, ui: RecordingUI = recordingUI()): Promise<KiroSessionImpl> =>
  KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env, ...over });
const read = (sb: Sandbox, id: string): SessionRecord => {
  const r = new SessionStore(sb.sessionsDir).read(id);
  assert.ok(r, `record ${id} exists`);
  return r;
};

describe('r6 #0: trust changed inside a tangent is saved at once on the records under it', () => {
  it('/tools untrust inside a tangent: main\'s record no longer trusts the tool (before any exit)', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'hello' }));
      s.trustTools(['execute_bash']);
      assert.deepEqual(read(sb, mainId).trust.allowedTools, ['execute_bash'], 'precondition: trusted in main');
      await s.enterTangent('side');
      s.untrustTools(['execute_bash']);
      assert.deepEqual(read(sb, mainId).trust.allowedTools, [], "main's record on disk still trusts the tool revoked inside the tangent");
      assert.deepEqual(read(sb, s.id).trust.allowedTools, [], 'the tangent record too');
    } finally {
      await closeAll(s);
    }
  });

  it('nested tangents: every record of the stack gets the revocation, /tools reset too', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'hello' }));
      s.trustTools(['execute_bash', 'fs_write']);
      await s.enterTangent('outer');
      const outerId = s.id;
      await drain(s.prompt({ text: 'outer line' }));
      await s.enterTangent('inner');
      s.untrustTools(['execute_bash']);
      for (const id of [mainId, outerId]) assert.deepEqual(read(sb, id).trust.allowedTools, ['fs_write'], `record ${id === mainId ? 'main' : 'outer'}`);
      s.resetTrust();
      for (const id of [mainId, outerId]) {
        const t = read(sb, id).trust;
        assert.deepEqual([t.allowedTools, t.rules, t.trustAll], [[], [], false], `record ${id === mainId ? 'main' : 'outer'} after /tools reset`);
      }
    } finally {
      await closeAll(s);
    }
  });

  it('/tools trust and trust-all inside a tangent are written too (what a clean return gives main)', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'hello' }));
      s.setTrustAll(true);
      await s.enterTangent('side');
      s.setTrustAll(false);
      assert.equal(read(sb, mainId).trust.trustAll, false, 'trust-all turned off inside the tangent');
      s.trustTools(['fs_write']);
      assert.deepEqual(read(sb, mainId).trust.allowedTools, ['fs_write']);
    } finally {
      await closeAll(s);
    }
  });

  it('/agent swap inside a tangent: main\'s record names the agent and holds its per-tool trust at once', async () => {
    const sb = sandbox();
    const s = await open(sb);
    try {
      const mainId = s.id;
      await drain(s.prompt({ text: 'hello' }));
      s.trustTools(['execute_bash']);
      await s.enterTangent('side');
      await s.swapAgent('strict');
      const main = read(sb, mainId);
      assert.equal(main.agent, 'strict', "main's record on disk names the agent the user left");
      assert.deepEqual(main.trust.allowedTools, [], "the active agent's per-tool trust (strict trusts nothing)");
      assert.deepEqual(main.trust.byAgent?.['kiro_default']?.allowedTools, ['execute_bash'], "the previous agent's trust is parked");
    } finally {
      await closeAll(s);
    }
  });
});

// ── a real crash inside the tangent (no close), then `chat --resume` ──

const moduleUrl = (rel: string): string => new URL(rel, import.meta.url).href;

/**
 * A child node process drives a session (main: hello, trust Bash, Bash runs trusted; tangent: the
 * change, an approval is asked) and SIGKILLs itself. Returns what it saw.
 */
function crashInTangent(sb: Sandbox, mode: 'untrust' | 'agent' | 'trustall'): { mainId: string; mainRun: string; tangentApprovals: number } {
  const outFile = path.join(sb.root, 'out.json');
  const code = `
    import * as fs from 'node:fs';
    const { KiroSessionImpl } = await import(${JSON.stringify(moduleUrl('../../src/session/kiroSession.js'))});
    const { createWorkspaceContext } = await import(${JSON.stringify(moduleUrl('../../src/config/workspace.js'))});
    const { fakeBinary, fakeCaps, recordingUI, drain } = await import(${JSON.stringify(moduleUrl('./helpers.js'))});
    const cfg = JSON.parse(process.env.R6F_CFG);
    const ws = createWorkspaceContext(cfg.cwd, process.env);
    const ui = recordingUI();
    const s = await KiroSessionImpl.create({ ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps: await fakeCaps(), env: process.env });
    const said = (r) => /TOOL-SAID ([\\s\\S]*?) END/.exec(r.result.text)?.[1] ?? r.result.text;
    const out = { mainId: s.id };
    await drain(s.prompt({ text: 'hello' }));
    if (cfg.mode === 'trustall') s.setTrustAll(true); else s.trustTools(['execute_bash']);
    out.mainRun = said(await drain(s.prompt({ text: 'run it' })));
    const before = ui.approvals.length;
    await s.enterTangent('side');
    if (cfg.mode === 'untrust') s.untrustTools(['execute_bash']);
    else if (cfg.mode === 'agent') await s.swapAgent('strict');
    else s.setTrustAll(false);
    ui.answers.push({ kind: 'deny' });
    await drain(s.prompt({ text: 'run it' }));
    out.tangentApprovals = ui.approvals.length - before;
    fs.writeFileSync(cfg.outFile, JSON.stringify(out));
    process.kill(process.pid, 'SIGKILL');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...sb.env, KIRO_CLAUDE_FAKE: fakeClaudePath(), R6F_CFG: JSON.stringify({ cwd: sb.cwd, mode, outFile }) },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(r.signal, 'SIGKILL', `the child did not crash as planned: status ${r.status}, stderr ${r.stderr}`);
  return JSON.parse(fs.readFileSync(outFile, 'utf8')) as { mainId: string; mainRun: string; tangentApprovals: number };
}

/** `chat --no-interactive --resume 'run it'`: what the model's Bash got, and the agent. */
async function resumeAndRun(sb: Sandbox): Promise<{ id: string; agent: string; said: string }> {
  const s = await open(sb, { interactive: false, resume: { latest: true } });
  try {
    const { result } = await drain(s.prompt({ text: 'run it' }));
    return { id: s.id, agent: s.agent.name, said: /TOOL-SAID ([\s\S]*?) END/.exec(result.text)?.[1] ?? result.text };
  } finally {
    await closeAll(s);
  }
}

describe('r6 #0: a crash inside the tangent, then chat --resume (opens main)', () => {
  it('/tools untrust inside the tangent: the resumed main asks for the tool (denied in non-interactive mode)', async () => {
    const sb = sandbox();
    const out = crashInTangent(sb, 'untrust');
    assert.equal(out.mainRun, '(Bash completed with no output)', 'precondition: trusted Bash ran in main');
    assert.equal(out.tangentApprovals, 1, 'precondition: the revocation is in effect in the tangent');
    const r = await resumeAndRun(sb);
    assert.equal(r.id, out.mainId, 'precondition: --resume opens main');
    assert.match(r.said, /not supported in non-interactive mode/, 'the tool revoked inside the tangent ran as trusted after the resume');
  });

  it('/agent swap inside the tangent: main resumes on that agent, and the previous agent\'s trust does not apply', async () => {
    const sb = sandbox();
    const out = crashInTangent(sb, 'agent');
    assert.equal(out.tangentApprovals, 1, 'precondition: strict asks for Bash in the tangent');
    const r = await resumeAndRun(sb);
    assert.equal(r.id, out.mainId);
    assert.equal(r.agent, 'strict', 'main resumed on the agent the user left inside the tangent');
    assert.match(r.said, /not supported in non-interactive mode/);
  });

  it('control: trust-all is per invocation (off inside the tangent, or not): the resume never trusts all', async () => {
    const sb = sandbox();
    const out = crashInTangent(sb, 'trustall');
    assert.equal(out.mainRun, '(Bash completed with no output)', 'precondition: trust-all Bash ran in main');
    assert.equal(out.tangentApprovals, 1, 'precondition: trust-all is off in the tangent');
    const r = await resumeAndRun(sb);
    assert.equal(r.id, out.mainId);
    assert.match(r.said, /not supported in non-interactive mode/);
  });
});
