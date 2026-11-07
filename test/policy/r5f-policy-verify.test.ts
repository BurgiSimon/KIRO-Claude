/**
 * Round 5 fixes, group policy, verifier (item #3, gate side): the spec-phase write allowance
 * (policy/specwrite.ts) resolves the spec folder with realpathDeep so that a symlinked folder
 * inside the workspace keeps working. realpathDeep resolves a path it cannot `realpath` through
 * its deepest existing ancestor and then appends the rest LEXICALLY, so a spec folder (or
 * `.kiro/specs`, or a hop of a link chain) that is a DANGLING symbolic link, or a link loop,
 * looked like a plain folder inside the workspace: a write of the phase document through it was
 * auto-allowed (and lifted the plan-mode denial) although the link points outside the workspace.
 * Such a folder resolves to nowhere, so the allowance refuses it with the spec-phase denial and
 * its reason, in both modes; the regular document and a live link inside the workspace still work.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { HookInput } from '../../src/claude/protocol.js';
import type { KiroAgent, WorkspaceContext } from '../../src/types.js';
import { Gate, PLAN_MODE_DENY, type GateDeps } from '../../src/policy/gate.js';
import { checkSpecWrite } from '../../src/policy/specwrite.js';
import { FakeHooks, emptyTrust, makeAgent, makeWs } from './helpers.js';

interface State {
  agent: KiroAgent;
  plan: boolean;
  spec: { name: string; allowedWritePaths: string[] } | undefined;
}

function gateFor(ws: WorkspaceContext, state: State): Gate {
  const deps: GateDeps = {
    ws,
    sessionId: () => 'sess-1',
    agent: () => state.agent,
    resolveAgent: () => undefined,
    hooks: () => new FakeHooks(),
    trust: emptyTrust(),
    interactive: true,
    v3Scopes: () => ({ userRules: [], workspaceRules: [], presetRules: [] }),
    mcpServerNames: () => ({}),
    mcpAutoApprove: () => [],
    planMode: () => state.plan,
    specPhase: () => state.spec,
    notify: () => undefined,
  };
  return new Gate(deps);
}

let T: ReturnType<typeof makeWs>;
let state: State;
let gate: Gate;
let dir: string;
let design: string;
beforeEach(() => {
  T = makeWs();
  state = { agent: makeAgent({ name: 'main' }), plan: false, spec: undefined };
  gate = gateFor(T.ws, state);
  dir = path.join(T.root, '.kiro', 'specs', 'feat');
  design = path.join(dir, 'design.md');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(path.join(T.home, 'outside'), { recursive: true });
});
afterEach(() => T.cleanup());

let seq = 0;
async function decide(tool_name: string, tool_input: Record<string, unknown>): Promise<string> {
  const input: HookInput = { hook_event_name: 'PreToolUse', session_id: 'c', cwd: T.ws.cwd, permission_mode: 'default', tool_name, tool_input, tool_use_id: `toolu_v${++seq}` };
  const d = (await gate.preToolUse(input)).decision;
  return d.kind === 'allow' ? 'allow' : `${d.kind}: ${(d as { reason?: string }).reason ?? ''}`;
}

function shapes(p: string): [string, Record<string, unknown>][] {
  return [
    ['Write', { file_path: p, content: 'x' }],
    ['Edit', { file_path: p, old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: p, edits: [{ old_string: 'a', new_string: 'b' }] }],
    ['NotebookEdit', { notebook_path: p, new_source: 'x' }],
  ];
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const refusedDeny = (why: RegExp): RegExp => new RegExp(`^deny: Spec phase design: only ${esc(design)} may be written now \\(.*${why.source}.*\\)$`);

for (const plan of [false, true]) {
  describe(`r5f verify #3: a dangling or looping link on the way to the phase document, plan mode ${plan ? 'on' : 'off'}`, () => {
    beforeEach(() => {
      state.plan = plan;
      state.spec = { name: 'design', allowedWritePaths: [design] };
    });

    it('control: a regular folder, and a live folder link inside the workspace, still work', async () => {
      fs.mkdirSync(dir);
      for (const [t, i] of shapes(design)) assert.equal(await decide(t, i), 'allow', t);
      fs.rmSync(dir, { recursive: true });
      const real = path.join(T.root, 'docs', 'feat');
      fs.mkdirSync(real, { recursive: true });
      fs.symlinkSync(real, dir);
      for (const [t, i] of shapes(design)) assert.equal(await decide(t, i), 'allow', `${t} through a live folder link`);
      // a new spec: neither the folder nor .kiro/specs exists yet
      fs.rmSync(path.join(T.root, '.kiro', 'specs'), { recursive: true });
      assert.equal(await decide('Write', { file_path: design, content: 'x' }), 'allow', 'a document of a folder that does not exist yet');
    });

    it('the spec folder is a dangling link to a folder outside the workspace', async () => {
      fs.symlinkSync(path.join(T.home, 'outside', 'newdir'), dir);
      for (const [t, i] of shapes(design)) assert.match(await decide(t, i), refusedDeny(/symbolic link .*feat.* resolves to nothing/), t);
    });

    it('.kiro/specs itself is a dangling link to a folder outside the workspace', async () => {
      const specs = path.join(T.root, '.kiro', 'specs');
      fs.rmSync(specs, { recursive: true });
      fs.symlinkSync(path.join(T.home, 'outside', 'specs'), specs);
      assert.match(await decide('Write', { file_path: design, content: 'x' }), refusedDeny(/specs resolves to nothing/));
    });

    it('a link chain whose last hop dangles (feat -> <ws>/hop -> outside/gone)', async () => {
      const hop = path.join(T.root, 'hop');
      fs.symlinkSync(hop, dir);
      fs.symlinkSync(path.join(T.home, 'outside', 'gone'), hop);
      assert.match(await decide('Write', { file_path: design, content: 'x' }), refusedDeny(/resolves to nothing/));
    });

    it('a link loop at the spec folder', async () => {
      const other = path.join(T.root, '.kiro', 'specs', 'loop');
      fs.symlinkSync(other, dir);
      fs.symlinkSync(dir, other);
      assert.match(await decide('Write', { file_path: design, content: 'x' }), refusedDeny(/resolves to nothing/));
    });

    it('a write to any other path is unaffected: the normal decision outside the spec rule', async () => {
      fs.symlinkSync(path.join(T.home, 'outside', 'newdir'), dir);
      const other = await decide('Write', { file_path: path.join(T.home, 'outside', 'newdir', 'design.md'), content: 'x' });
      assert.match(other, plan ? new RegExp(`^deny: ${esc(PLAN_MODE_DENY)}$`) : new RegExp(`^deny: Spec phase design: only ${esc(design)} may be written now$`));
    });
  });
}

describe('r5f verify #3: checkSpecWrite unit', () => {
  it('a dangling link above the subject is never ok, a live one inside the workspace is', () => {
    const call = (p: string) => ({ claudeName: 'Write', input: { file_path: p }, subjects: [p], cwd: T.ws.cwd });
    fs.symlinkSync(path.join(T.home, 'outside', 'newdir'), dir);
    const r = checkSpecWrite(call(design), [design], T.ws);
    assert.equal(r.ok, false);
    assert.match(r.refused ?? '', /resolves to nothing/);
    fs.mkdirSync(path.join(T.home, 'outside', 'newdir'));
    // now the link is live but leaves the workspace: refused for that reason
    assert.match(checkSpecWrite(call(design), [design], T.ws).refused ?? '', /outside the workspace/);
  });
});
