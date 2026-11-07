/**
 * Round 5 fixes, group policy, item #3 (gate side): the spec-phase write allowance (the
 * spec-phase auto-allow and the plan-mode exception for a phase's own documents) is anchored to
 * the spec folder and never follows a link at the document (policy/specwrite.ts). Before the fix
 * both sides were realpath'ed, so a spec document a repository commits as a symlink made its
 * target writable without asking, outside the workspace and in plan mode; a document linked to a
 * directory allowed the whole directory; a write through the symlinked name followed the link;
 * an absolute entry with glob characters in the workspace path was matched as a glob.
 *
 * Every case runs with plan mode off and on. When the allowance does not apply, the call gets
 * the normal decision for a write outside the spec rule: the spec-phase denial (plan mode off) or
 * the plan-mode denial (plan mode on); a call that names a phase document the allowance refused
 * gets the spec-phase denial with the reason in parentheses in both modes.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { HookInput } from '../../src/claude/protocol.js';
import type { KiroAgent, SessionTrust, WorkspaceContext } from '../../src/types.js';
import { Gate, PLAN_MODE_DENY, type GateDeps } from '../../src/policy/gate.js';
import { checkSpecWrite, dotDotAfterLink } from '../../src/policy/specwrite.js';
import { FakeHooks, emptyTrust, makeAgent, makeWs } from './helpers.js';

interface Rig {
  ws: WorkspaceContext;
  root: string;
  home: string;
  dir: string;
  gate: Gate;
  trust: SessionTrust;
  state: { agent: KiroAgent; plan: boolean; spec: { name: string; allowedWritePaths: string[] } | undefined };
  cleanup(): void;
}

function gateFor(ws: WorkspaceContext, state: Rig['state'], trust: SessionTrust): Gate {
  const deps: GateDeps = {
    ws,
    sessionId: () => 'sess-1',
    agent: () => state.agent,
    resolveAgent: () => undefined,
    hooks: () => new FakeHooks(),
    trust,
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

function rig(): Rig {
  const tw = makeWs();
  const trust = emptyTrust();
  const state: Rig['state'] = { agent: makeAgent({ name: 'main' }), plan: false, spec: undefined };
  const dir = path.join(tw.root, '.kiro', 'specs', 'feat');
  fs.mkdirSync(dir, { recursive: true });
  return { ws: tw.ws, root: tw.root, home: tw.home, dir, gate: gateFor(tw.ws, state, trust), trust, state, cleanup: tw.cleanup };
}

let R: Rig;
beforeEach(() => {
  R = rig();
});
afterEach(() => R.cleanup());

let seq = 0;
async function decideOn(gate: Gate, cwd: string, tool_name: string, tool_input: Record<string, unknown>): Promise<string> {
  const input: HookInput = { hook_event_name: 'PreToolUse', session_id: 'c', cwd, permission_mode: 'default', tool_name, tool_input, tool_use_id: `toolu_${++seq}` };
  const d = (await gate.preToolUse(input)).decision;
  return d.kind === 'allow' ? 'allow' : `${d.kind}: ${(d as { reason?: string }).reason ?? ''}`;
}
const decide = (tool: string, input: Record<string, unknown>): Promise<string> => decideOn(R.gate, R.ws.cwd, tool, input);
const write = (file_path: string): Promise<string> => decide('Write', { file_path, content: 'x' });

/** Every write tool shape on `p`. */
function shapes(p: string): [string, Record<string, unknown>][] {
  return [
    ['Write', { file_path: p, content: 'x' }],
    ['Edit', { file_path: p, old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: p, edits: [{ old_string: 'a', new_string: 'b' }] }],
    ['NotebookEdit', { notebook_path: p, new_source: 'x' }],
  ];
}

const design = (): string => path.join(R.dir, 'design.md');
const phase = (allowed: string[] = [design()]): { name: string; allowedWritePaths: string[] } => ({ name: 'design', allowedWritePaths: allowed });
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The spec-phase denial, optionally with the refusal reason in parentheses. */
function specDeny(why?: RegExp): RegExp {
  const base = `^deny: Spec phase design: only ${esc(design())} may be written now`;
  return new RegExp(why ? `${base} \\(.*${why.source}.*\\)$` : `${base}$`);
}
/** What a write outside the allowance gets: the spec-phase denial, or the plan-mode denial. */
function outsideDeny(plan: boolean): RegExp {
  return plan ? new RegExp(`^deny: ${esc(PLAN_MODE_DENY)}$`) : specDeny();
}

for (const plan of [false, true]) {
  describe(`r5f #3: spec-phase allowance, plan mode ${plan ? 'on' : 'off'}`, () => {
    beforeEach(() => {
      R.state.plan = plan;
      R.state.spec = phase();
    });

    it('control: a regular phase document is allowed for every write tool shape; another file is not', async () => {
      fs.writeFileSync(design(), '# Design\n');
      for (const [t, i] of shapes(design())) assert.equal(await decide(t, i), 'allow', t);
      assert.equal(await write(`${R.dir}/../feat/design.md`), 'allow', 'a lexical .. without links');
      assert.equal(await write(`${design()}/`), 'allow', 'a trailing slash');
      assert.match(await write(path.join(R.dir, 'tasks.md')), outsideDeny(plan));
      assert.match(await write(path.join(R.home, 'other.txt')), outsideDeny(plan));
    });

    it('a document committed as a symlink to a file outside the workspace: neither the target nor the link name is writable', async () => {
      const outside = path.join(R.home, '.bashrc');
      fs.writeFileSync(outside, 'export PATH=$PATH\n');
      fs.symlinkSync(outside, design());
      assert.match(await write(outside), outsideDeny(plan), 'the target, by its own path');
      for (const [t, i] of shapes(design())) assert.match(await decide(t, i), specDeny(/design\.md is a symbolic link/), `${t} through the link`);
      assert.match(await write(`${design()}/`), specDeny(/is a symbolic link/), 'trailing slash');
      assert.match(await write(`${R.dir}/../feat/design.md`), specDeny(/is a symbolic link/), 'via ..');
      assert.match(await decideOn(R.gate, R.dir, 'Write', { file_path: 'design.md', content: 'x' }), specDeny(/is a symbolic link/), 'relative to a cwd in the spec folder');
    });

    it('a document symlinked to a directory does not make the directory writable', async () => {
      const ssh = path.join(R.home, '.ssh');
      fs.mkdirSync(ssh);
      fs.symlinkSync(ssh, design());
      assert.match(await write(path.join(ssh, 'authorized_keys')), outsideDeny(plan));
      assert.match(await write(path.join(design(), 'authorized_keys')), specDeny(/authorized_keys resolves to .*\.ssh\/authorized_keys, outside the workspace/), 'through the link name');
      assert.match(await write(design()), specDeny(/is a symbolic link/));
    });

    it('a dangling link and a link chain at the document are refused', async () => {
      const missing = path.join(R.home, 'not-there-yet.sh');
      fs.symlinkSync(missing, design());
      assert.match(await write(design()), specDeny(/is a symbolic link/), 'dangling');
      assert.match(await write(missing), outsideDeny(plan), 'the dangling target');
      fs.unlinkSync(design());
      const target = path.join(R.home, 'profile');
      fs.writeFileSync(target, 'x');
      const hop = path.join(R.home, 'hop');
      fs.symlinkSync(target, hop);
      fs.symlinkSync(hop, design());
      assert.match(await write(design()), specDeny(/is a symbolic link/), 'chain');
      assert.match(await write(target), outsideDeny(plan));
      assert.match(await write(hop), outsideDeny(plan));
    });

    it('a document linked to another file inside the spec folder is refused too (never through a link)', async () => {
      fs.writeFileSync(path.join(R.dir, 'requirements.md'), '# R\n');
      fs.symlinkSync('requirements.md', design());
      assert.match(await write(design()), specDeny(/is a symbolic link/));
      assert.match(await write(path.join(R.dir, 'requirements.md')), outsideDeny(plan));
    });

    it('a symlinked spec folder that stays inside the workspace keeps working; .kiro/specs itself symlinked too', async () => {
      const real = path.join(R.root, 'docs', 'specs', 'feat');
      fs.mkdirSync(real, { recursive: true });
      fs.rmSync(R.dir, { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(R.dir), real), R.dir);
      for (const [t, i] of shapes(design())) assert.equal(await decide(t, i), 'allow', t);
      assert.equal(await write(path.join(real, 'design.md')), 'allow', 'the same document by its real path');
      assert.match(await write(path.join(real, 'tasks.md')), outsideDeny(plan));
      // .kiro/specs as a whole is a link inside the workspace
      const specs = path.join(R.root, '.kiro', 'specs');
      fs.rmSync(specs, { recursive: true });
      fs.symlinkSync(path.join(R.root, 'docs', 'specs'), specs);
      assert.equal(await write(design()), 'allow');
    });

    it('a symlinked spec folder that leaves the workspace is refused with a clear denial', async () => {
      const real = path.join(R.home, 'elsewhere', 'feat');
      fs.mkdirSync(real, { recursive: true });
      fs.rmSync(R.dir, { recursive: true });
      fs.symlinkSync(real, R.dir);
      for (const [t, i] of shapes(design())) assert.match(await decide(t, i), specDeny(/resolves to .*elsewhere\/feat\/design\.md, outside the workspace/), t);
      assert.match(await write(path.join(real, 'design.md')), specDeny(/elsewhere\/feat\/design\.md is outside the workspace/), 'the real path outside');
    });

    it("a '..' right after a symbolic link is refused (the OS and a lexical normalization disagree)", async () => {
      const ssh = path.join(R.home, '.ssh');
      fs.mkdirSync(ssh);
      fs.symlinkSync(ssh, path.join(R.dir, 'sub'));
      fs.writeFileSync(design(), '# D\n');
      const raw = `${R.dir}/sub/../design.md`;
      assert.match(await write(raw), specDeny(/has '\.\.' after the symbolic link/));
      assert.equal(await write(`${R.dir}/real/../design.md`), 'allow', 'a .. after a missing (non-link) component');
    });

    it('case: on a case-sensitive file system another case is another file (not the document)', async (t) => {
      fs.writeFileSync(design(), '# D\n');
      if (fs.existsSync(path.join(R.dir, 'DESIGN.md'))) return t.skip('case-insensitive file system');
      assert.match(await write(path.join(R.dir, 'DESIGN.md')), outsideDeny(plan));
    });

    it('a hard link is a regular file at its own path (no special case)', async () => {
      const other = path.join(R.root, 'notes.md');
      fs.writeFileSync(other, 'x');
      fs.linkSync(other, design());
      assert.equal(await write(design()), 'allow');
    });

    it('folder and pattern entries: a link inside them or a folder that leaves the workspace allows nothing', async () => {
      const outside = path.join(R.home, '.bashrc');
      fs.writeFileSync(outside, 'x');
      fs.symlinkSync(outside, path.join(R.dir, 'notes.md'));
      R.state.spec = { name: 'design', allowedWritePaths: ['.kiro/specs/feat', '.kiro/specs/other/*.md'] };
      assert.equal(await write(path.join(R.dir, 'tasks.md')), 'allow', 'a file in the folder entry');
      assert.match(await write(path.join(R.dir, 'notes.md')), /^deny: Spec phase design: .*\(.*notes\.md is a symbolic link\)$/);
      assert.match(await write(outside), plan ? outsideDeny(true) : /^deny: Spec phase design: only .* may be written now$/);
      const away = path.join(R.home, 'away');
      fs.mkdirSync(away);
      fs.symlinkSync(away, path.join(R.root, '.kiro', 'specs', 'other'));
      assert.match(await write(path.join(R.root, '.kiro', 'specs', 'other', 'design.md')), /^deny: Spec phase design: .*outside the workspace.*\)$/);
      // the real path matches the pattern (its literal prefix is resolved) but leaves the workspace
      assert.match(await write(path.join(away, 'design.md')), /^deny: Spec phase design: .*outside the workspace.*\)$/);
      // a folder entry that is itself a link (here one that stays in the workspace) allows nothing below it
      fs.unlinkSync(path.join(R.root, '.kiro', 'specs', 'other'));
      fs.mkdirSync(path.join(R.root, 'docs-other'));
      fs.symlinkSync(path.join('..', '..', 'docs-other'), path.join(R.root, '.kiro', 'specs', 'other'));
      R.state.spec = { name: 'design', allowedWritePaths: ['.kiro/specs/other'] };
      assert.match(await write(path.join(R.root, '.kiro', 'specs', 'other', 'design.md')), /^deny: Spec phase design: .*\(.*other is a symbolic link\)$/);
      assert.match(await write(path.join(R.root, 'docs-other', 'design.md')), plan ? outsideDeny(true) : /^deny: Spec phase design: only .* may be written now$/);
    });

    it('a write outside a spec phase is unaffected (no phase: the normal policy)', async () => {
      R.state.spec = undefined;
      fs.writeFileSync(design(), '# D\n');
      assert.match(await write(design()), plan ? outsideDeny(true) : /^ask: /);
    });
  });
}

describe('r5f #3 also-claim: an absolute entry is a literal path even when the workspace path holds glob characters', () => {
  for (const plan of [false, true]) {
    it(`workspace proj[1] next to proj1, plan mode ${plan ? 'on' : 'off'}`, async () => {
      const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-r5f-policy-')));
      try {
        const home = path.join(base, 'home');
        const mine = path.join(home, 'proj[1]');
        const other = path.join(home, 'proj1');
        for (const w of [mine, other]) fs.mkdirSync(path.join(w, '.kiro', 'specs', 'feat'), { recursive: true });
        const ws: WorkspaceContext = { cwd: mine, workspaceRoot: mine, kiroHome: path.join(home, '.kiro'), home, env: { HOME: home } };
        const state: Rig['state'] = { agent: makeAgent({ name: 'main' }), plan, spec: undefined };
        const gate = gateFor(ws, state, emptyTrust());
        const doc = path.join(mine, '.kiro', 'specs', 'feat', 'design.md');
        state.spec = { name: 'design', allowedWritePaths: [doc] };
        assert.equal(await decideOn(gate, mine, 'Write', { file_path: doc, content: 'x' }), 'allow', "the phase's own document");
        const foreign = await decideOn(gate, mine, 'Write', { file_path: path.join(other, '.kiro', 'specs', 'feat', 'design.md'), content: 'x' });
        assert.match(foreign, /^deny: /, "the other workspace's document");
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
  }
});

describe('r5f #3: checkSpecWrite and dotDotAfterLink units', () => {
  it('no subject or no allowed path is never ok', () => {
    const call = { claudeName: 'Write', input: {}, subjects: [] as string[], cwd: R.ws.cwd };
    assert.deepEqual(checkSpecWrite(call, [design()], R.ws), { ok: false });
    assert.deepEqual(checkSpecWrite({ ...call, subjects: [design()] }, [], R.ws), { ok: false });
    assert.deepEqual(checkSpecWrite({ ...call, subjects: [design()] }, [design()], R.ws), { ok: true });
  });
  it('dotDotAfterLink finds only a .. that follows a link', () => {
    fs.symlinkSync(R.home, path.join(R.dir, 'up'));
    assert.equal(dotDotAfterLink(`${R.dir}/up/../design.md`, R.ws.cwd, R.ws.env), path.join(R.dir, 'up'));
    assert.equal(dotDotAfterLink('.kiro/specs/feat/up/../x', R.root, R.ws.env), path.join(R.dir, 'up'));
    assert.equal(dotDotAfterLink(`${R.dir}/../feat/design.md`, R.ws.cwd, R.ws.env), undefined);
    assert.equal(dotDotAfterLink(`${R.dir}/up/design.md`, R.ws.cwd, R.ws.env), undefined);
  });
});
