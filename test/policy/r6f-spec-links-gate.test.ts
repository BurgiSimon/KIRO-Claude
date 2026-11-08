/**
 * Round 6, finding #7, gate side (policy/specwrite.ts checkSpecWrite shares the link helpers with
 * kiro-claude's own spec I/O): a phase-document write through a spec folder link (or a linked
 * `.kiro/specs`) whose target realpath cannot reach (EACCES, EPERM: a folder the user cannot
 * enter) is still denied, in plan mode too, also when the link points OUTSIDE the workspace
 * (realpathDeep's lexical fallback would otherwise place it inside), and the denial's reason says
 * the link's target cannot be accessed, not that the link dangles; the texts are the same as
 * specFileRefusal's. realpath is made to fail the way it does for an unprivileged user.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { HookInput } from '../../src/claude/protocol.js';
import type { KiroAgent, WorkspaceContext } from '../../src/types.js';
import { Gate, type GateDeps } from '../../src/policy/gate.js';
import { checkSpecWrite, specFileRefusal } from '../../src/policy/specwrite.js';
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

type RealpathNative = (p: fs.PathLike, ...rest: unknown[]) => string;
const rp = fs.realpathSync as unknown as { native: RealpathNative };
let restore: (() => void) | undefined;

/** realpath throws `code` for every path in `blocked` and below it. */
function failRealpath(blocked: string[], code = 'EACCES'): void {
  const real = rp.native;
  rp.native = (p, ...rest) => {
    const s = String(p);
    if (blocked.some((b) => s === b || s.startsWith(`${b}${path.sep}`))) throw Object.assign(new Error(`${code}: realpath '${s}'`), { code });
    return real(p, ...rest);
  };
  restore = () => {
    rp.native = real;
    restore = undefined;
  };
}

let T: ReturnType<typeof makeWs>;
let state: State;
let gate: Gate;
let specs: string;
let dir: string;
let design: string;
beforeEach(() => {
  T = makeWs();
  state = { agent: makeAgent({ name: 'main' }), plan: false, spec: undefined };
  gate = gateFor(T.ws, state);
  specs = path.join(T.root, '.kiro', 'specs');
  dir = path.join(specs, 'feat');
  design = path.join(dir, 'design.md');
  fs.mkdirSync(specs, { recursive: true });
});
afterEach(() => {
  restore?.();
  T.cleanup();
});

let seq = 0;
async function decide(tool_name: string, tool_input: Record<string, unknown>): Promise<string> {
  const input: HookInput = { hook_event_name: 'PreToolUse', session_id: 'c', cwd: T.ws.cwd, permission_mode: 'default', tool_name, tool_input, tool_use_id: `toolu_r6f${++seq}` };
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
const deniedFor = (link: string): RegExp =>
  new RegExp(`^deny: Spec phase design: only ${esc(design)} may be written now \\(${esc(design)}: the target of the symbolic link ${esc(link)} cannot be accessed \\(permission denied\\)\\)$`);

for (const plan of [false, true]) {
  describe(`r6f #7: a link on the way to the phase document whose target cannot be accessed, plan mode ${plan ? 'on' : 'off'}`, () => {
    beforeEach(() => {
      state.plan = plan;
      state.spec = { name: 'design', allowedWritePaths: [design] };
    });

    it('control: the same folder link, accessible, is allowed', async () => {
      const real = path.join(T.root, 'private', 'feat');
      fs.mkdirSync(real, { recursive: true });
      fs.symlinkSync(path.join('..', '..', 'private', 'feat'), dir);
      for (const [t, i] of shapes(design)) assert.equal(await decide(t, i), 'allow', t);
    });

    it('the spec folder links to a folder inside the workspace the user cannot enter: denied, not called dangling', async () => {
      const real = path.join(T.root, 'private', 'feat');
      fs.mkdirSync(real, { recursive: true });
      fs.symlinkSync(path.join('..', '..', 'private', 'feat'), dir);
      failRealpath([dir, path.dirname(real)]);
      for (const [t, i] of shapes(design)) assert.match(await decide(t, i), deniedFor(dir), t);
    });

    it('EPERM at the spec folder link: denied with the same reason', async () => {
      fs.mkdirSync(path.join(T.root, 'private', 'feat'), { recursive: true });
      fs.symlinkSync(path.join('..', '..', 'private', 'feat'), dir);
      failRealpath([dir, path.join(T.root, 'private')], 'EPERM');
      assert.match(await decide('Write', { file_path: design, content: 'x' }), deniedFor(dir));
    });

    it('the spec folder links OUTSIDE the workspace behind a folder the user cannot enter: denied', async () => {
      const outside = path.join(T.home, 'outside', 'feat');
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, dir);
      failRealpath([dir, path.dirname(outside)]);
      for (const [t, i] of shapes(design)) assert.match(await decide(t, i), deniedFor(dir), t);
    });

    it('.kiro/specs links to a folder the user cannot enter: denied with that link named', async () => {
      fs.rmSync(specs, { recursive: true });
      const real = path.join(T.root, 'private', 'specs');
      fs.mkdirSync(path.join(real, 'feat'), { recursive: true });
      fs.symlinkSync(path.join('..', 'private', 'specs'), specs);
      failRealpath([specs, path.join(T.root, 'private')]);
      assert.match(await decide('Write', { file_path: design, content: 'x' }), deniedFor(specs));
    });
  });
}

describe('r6f #7: checkSpecWrite unit', () => {
  it('EACCES above the subject is never ok, and its reason is specFileRefusal\'s', () => {
    const call = { claudeName: 'Write', input: { file_path: design }, subjects: [design], cwd: T.ws.cwd };
    const outside = path.join(T.home, 'outside', 'feat');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, dir);
    failRealpath([dir, path.dirname(outside)]);
    const r = checkSpecWrite(call, [design], T.ws);
    assert.equal(r.ok, false);
    assert.equal(r.refused, `${design}: the target of the symbolic link ${dir} cannot be accessed (permission denied)`);
    assert.equal(r.refused, specFileRefusal(design, T.root));
  });
});
