/**
 * Round 9, finding #7 (gate side): a phase document kiro-claude refuses for a reason the gate
 * does not check itself (not a regular file, unreadable: spec/workflow.restrictionFor leaves it
 * out of `allowedWritePaths`, r8 #9 verifier) got no reason at the gate. checkSpecWrite returned
 * `{ok:false}` with no `refused` note, so in plan mode the gate took the plan-mode branch and the
 * revision turn's write was denied as "Plan mode is read-only. Exit plan mode … to make changes"
 * (leaving plan mode does not help), and outside plan mode as "only (nothing) may be written now"
 * with no reason.
 *
 * Now the restriction carries the documents it left out with their reason
 * (`specPhase.refusedWritePaths`), checkSpecWrite returns `refused: <why>` for a subject that names
 * one (its path as written or its canonical path, the document itself or a path inside it), and
 * the gate gives the spec-phase denial with that reason in both modes, as for a symbolic link.
 * Nothing becomes more permissive: such a subject is refused even if an allowed entry would
 * match it, and every other call keeps its decision.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { HookInput } from '../../src/claude/protocol.js';
import type { KiroAgent, KiroSessionOptions, WorkspaceContext } from '../../src/types.js';
import { Gate, PLAN_MODE_DENY, type GateDeps } from '../../src/policy/gate.js';
import { checkSpecWrite } from '../../src/policy/specwrite.js';
import { FakeHooks, emptyTrust, makeAgent, makeWs } from './helpers.js';
import { removeOnExit } from '../tmpdirs.js';

type Phase = NonNullable<KiroSessionOptions['specPhase']>;

interface Rig {
  ws: WorkspaceContext;
  root: string;
  dir: string;
  gate: Gate;
  state: { agent: KiroAgent; plan: boolean; spec: Phase | undefined };
  cleanup(): void;
}

function rig(): Rig {
  const tw = makeWs();
  removeOnExit(path.dirname(tw.home));
  const state: Rig['state'] = { agent: makeAgent({ name: 'main' }), plan: false, spec: undefined };
  const deps: GateDeps = {
    ws: tw.ws,
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
  const dir = path.join(tw.root, '.kiro', 'specs', 'feat');
  fs.mkdirSync(dir, { recursive: true });
  return { ws: tw.ws, root: tw.root, dir, gate: new Gate(deps), state, cleanup: tw.cleanup };
}

let R: Rig;
beforeEach(() => {
  R = rig();
});
afterEach(() => R.cleanup());

let seq = 0;
async function decide(tool_name: string, tool_input: Record<string, unknown>, cwd = R.ws.cwd): Promise<string> {
  const input: HookInput = { hook_event_name: 'PreToolUse', session_id: 'c', cwd, permission_mode: 'default', tool_name, tool_input, tool_use_id: `toolu_${++seq}` };
  const d = (await R.gate.preToolUse(input)).decision;
  return d.kind === 'allow' ? 'allow' : `${d.kind}: ${(d as { reason?: string }).reason ?? ''}`;
}
const write = (file_path: string, cwd?: string): Promise<string> => decide('Write', { file_path, content: 'x' }, cwd);
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The bugfix phase of a spec whose bugfix.md is a directory: nothing allowed, bugfix.md left out with its reason. */
function dirDoc(): { doc: string; why: string } {
  const doc = path.join(R.dir, 'bugfix.md');
  fs.mkdirSync(doc);
  const why = `${doc} is not a regular file`;
  R.state.spec = { name: 'bugfix', allowedWritePaths: [], refusedWritePaths: [{ path: doc, why }] };
  return { doc, why };
}

for (const plan of [false, true]) {
  describe(`r9f #7: a phase document left out of the allowance, plan mode ${plan ? 'on' : 'off'}`, () => {
    beforeEach(() => {
      R.state.plan = plan;
    });

    it('its write gets the spec-phase denial with the reason, never the plan-mode denial', async () => {
      const { doc, why } = dirDoc();
      const want = `deny: Spec phase bugfix: only (nothing) may be written now (${why})`;
      assert.equal(await write(doc), want);
      // a path inside it (the document is a directory), and the path written relative to the cwd
      assert.equal(await write(path.join(doc, 'notes.md')), want);
      assert.equal(await write(path.relative(R.ws.cwd, doc)), want);
      for (const [tool, input] of [
        ['Edit', { file_path: doc, old_string: 'a', new_string: 'b' }],
        ['MultiEdit', { file_path: doc, edits: [{ old_string: 'a', new_string: 'b' }] }],
        ['NotebookEdit', { notebook_path: doc, new_source: 'x' }],
      ] as const) {
        assert.equal(await decide(tool, input as Record<string, unknown>), want, tool);
      }
    });

    it('a write that names no left-out document keeps its decision', async () => {
      dirDoc();
      const other = path.join(R.root, 'src', 'x.ts');
      assert.equal(await write(other), plan ? `deny: ${PLAN_MODE_DENY}` : 'deny: Spec phase bugfix: only (nothing) may be written now');
      // a sibling whose name starts like the document is not inside it
      assert.equal(await write(`${path.join(R.dir, 'bugfix.md')}x`), plan ? `deny: ${PLAN_MODE_DENY}` : 'deny: Spec phase bugfix: only (nothing) may be written now');
    });

    it('the other documents of the phase are still allowed; the left-out one is named with its reason', async () => {
      const req = path.join(R.dir, 'requirements.md');
      const design = path.join(R.dir, 'design.md');
      fs.mkdirSync(design);
      const why = `${design} is not a regular file`;
      R.state.spec = { name: 'requirements', allowedWritePaths: [req], refusedWritePaths: [{ path: design, why }] };
      assert.equal(await write(req), 'allow');
      assert.equal(await write(design), `deny: Spec phase requirements: only ${req} may be written now (${why})`);
      assert.equal(await write(path.join(design, 'inner.md')), `deny: Spec phase requirements: only ${req} may be written now (${why})`);
    });

    it('a symbolic-link spec folder: the document written by its real path gets the reason too', async () => {
      const real = path.join(R.root, '.kiro', 'specs-real');
      fs.mkdirSync(path.join(real, 'feat', 'bugfix.md'), { recursive: true });
      fs.rmSync(R.dir, { recursive: true });
      fs.symlinkSync(path.join(real, 'feat'), R.dir);
      const doc = path.join(R.dir, 'bugfix.md');
      const why = `${doc} is not a regular file`;
      R.state.spec = { name: 'bugfix', allowedWritePaths: [], refusedWritePaths: [{ path: doc, why }] };
      assert.equal(await write(path.join(real, 'feat', 'bugfix.md')), `deny: Spec phase bugfix: only (nothing) may be written now (${why})`);
      assert.equal(await write(doc), `deny: Spec phase bugfix: only (nothing) may be written now (${why})`);
    });
  });
}

describe('r9f #7: checkSpecWrite and refused documents', () => {
  it('a subject naming a refused document is refused with its reason, also when an allowed entry names it (never more permissive)', () => {
    const doc = path.join(R.dir, 'bugfix.md');
    fs.mkdirSync(doc);
    const why = `${doc} is not a regular file`;
    const call = (p: string) => ({ claudeName: 'Write', input: { file_path: p }, subjects: [p], cwd: R.ws.cwd });
    assert.deepEqual(checkSpecWrite(call(doc), [], R.ws, [{ path: doc, why }]), { ok: false, refused: why });
    assert.deepEqual(checkSpecWrite(call(doc), [doc], R.ws, [{ path: doc, why }]), { ok: false, refused: why });
    assert.deepEqual(checkSpecWrite(call(path.join(doc, 'a.md')), [R.dir], R.ws, [{ path: doc, why }]), { ok: false, refused: why });
    // without the list: as before
    assert.deepEqual(checkSpecWrite(call(doc), [], R.ws), { ok: false });
    // a document that is not refused is unaffected
    const req = path.join(R.dir, 'requirements.md');
    assert.deepEqual(checkSpecWrite(call(req), [req], R.ws, [{ path: doc, why }]), { ok: true });
    assert.deepEqual(checkSpecWrite({ claudeName: 'Write', input: {}, subjects: [], cwd: R.ws.cwd }, [], R.ws, [{ path: doc, why }]), { ok: false });
  });

  it('the denial text is the spec-phase one (regression guard for the plan-mode wording)', async () => {
    R.state.plan = true;
    const { doc } = dirDoc();
    assert.doesNotMatch(await write(doc), new RegExp(esc(PLAN_MODE_DENY)));
  });
});
