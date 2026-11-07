/**
 * Round 5 fixes, group policy, item #3 through the headless `kiro-claude spec` command (the real
 * createSession over test/fixtures/fake-claude.mjs; the fake answers "File created successfully"
 * only for a Write the gate allowed, and headless denies anything the gate would ask about):
 *  - a new spec's phase still writes its document, also when `.kiro/specs` is a symlink that
 *    stays inside the workspace;
 *  - `spec revise` of a spec whose design.md is committed as a symlink to ~/.bashrc writes neither
 *    through design.md nor to ~/.bashrc.
 * And known gap g1, unit level: NextPress, the `spec run` next Ctrl+C (the e2e tests are in
 * r5f-policy-spec-run-signals.test.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { CliContext, HookRunnerLike } from '../../src/types.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';
import { NextPress, runSpecCommandWith } from '../../src/spec/cli.js';
import { fakeClaudePath, fakeEnv } from '../claude/helpers.js';
import { DESIGN_MD, REQ_MD, makeWs, mockSettings, type Ws } from './helpers.js';

class Capture extends Writable {
  data = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += chunk.toString();
    cb();
  }
}

/** Run `kiro-claude spec <args>` headless in `w` over the fake with `script`. */
async function headless(w: Ws, args: string[], script: unknown): Promise<{ code: number; out: string; err: string }> {
  const claudeConfig = path.join(w.root, 'claude-config');
  const runtime = path.join(w.root, 'run');
  fs.mkdirSync(claudeConfig, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const env = fakeEnv({
    HOME: w.home,
    USERPROFILE: w.home,
    KIRO_HOME: path.join(w.home, '.kiro'),
    CLAUDE_CONFIG_DIR: claudeConfig,
    XDG_RUNTIME_DIR: runtime,
    XDG_CACHE_HOME: path.join(w.root, 'cache'),
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    FAKE_CLAUDE_SCRIPT_JSON: JSON.stringify(script),
    FAKE_CLAUDE_LOG: path.join(w.root, 'fake.log'),
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_EFFORT_LEVEL: undefined,
    KIRO_CLAUDE_SESSIONS_DIR: undefined,
  });
  const out = new Capture();
  const err = new Capture();
  const ctx: CliContext = {
    ws: createWorkspaceContext(w.proj, env),
    settings: mockSettings(),
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout: out as unknown as NodeJS.WriteStream,
    stderr: err as unknown as NodeJS.WriteStream,
    progName: 'kiro-claude',
    verbosity: 0,
  };
  const code = await runSpecCommandWith(args, ctx);
  return { code, out: out.data, err: err.data };
}

/** A phase turn (`match`) that writes each file and prints the tool result as `W<i>[…]`. */
function writes(match: string, files: string[]): unknown {
  return {
    turns: [
      {
        repeat: true,
        match,
        steps: files.flatMap((f, i) => [
          { tool: { name: 'Write', input: { file_path: f, content: '# Doc\n' } } },
          { text: `W${i}[{{lastToolResult}}]` },
        ]),
      },
      { repeat: true, steps: [{ text: 'ANSWER' }] },
    ],
  };
}

function result(out: string, i: number): string {
  return (new RegExp(`W${i}\\[([\\s\\S]*?)\\]`).exec(out)?.[1] ?? '').replace(/\s+/g, ' ');
}

test('headless spec new: the requirements phase writes its document; a write elsewhere is denied (regular .kiro/specs)', { timeout: 60_000 }, async () => {
  const w = makeWs('kc-r5f-policy-');
  try {
    const doc = path.join(w.specs, 'demo', 'requirements.md');
    const r = await headless(w, ['new', 'demo', '--description', 'demo'], writes('Phase: REQUIREMENTS', [doc, path.join(w.home, 'notes.md')]));
    assert.match(result(r.out, 0), /File created successfully at: .*demo\/requirements\.md/, r.out + r.err);
    assert.match(result(r.out, 1), /Spec phase requirements: only .*requirements\.md may be written now$/);
  } finally {
    w.cleanup();
  }
});

test('headless spec new: a .kiro/specs symlinked inside the workspace still writes the phase document', { timeout: 60_000 }, async () => {
  const w = makeWs('kc-r5f-policy-');
  try {
    const real = path.join(w.proj, 'docs', 'specs');
    fs.mkdirSync(real, { recursive: true });
    fs.rmSync(w.specs, { recursive: true });
    fs.symlinkSync(path.join('..', 'docs', 'specs'), w.specs);
    const doc = path.join(w.specs, 'demo', 'requirements.md');
    const r = await headless(w, ['new', 'demo', '--description', 'demo'], writes('Phase: REQUIREMENTS', [doc]));
    assert.ok(fs.existsSync(path.join(real, 'demo', '.config.kiro')), 'the spec folder was created through the link');
    assert.match(result(r.out, 0), /File created successfully at: .*\.kiro\/specs\/demo\/requirements\.md/, r.out + r.err);
  } finally {
    w.cleanup();
  }
});

test('headless spec revise: design.md committed as a symlink to ~/.bashrc writes neither through it nor to ~/.bashrc', { timeout: 60_000 }, async () => {
  const w = makeWs('kc-r5f-policy-');
  try {
    const dir = path.join(w.specs, 'feat');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'requirements.md'), REQ_MD);
    const bashrc = path.join(w.home, '.bashrc');
    fs.writeFileSync(bashrc, DESIGN_MD);
    fs.symlinkSync(bashrc, path.join(dir, 'design.md'));
    const r = await headless(w, ['revise', 'feat', 'make', 'it', 'shorter'], writes('kiro-spec-mode', [path.join(dir, 'design.md'), bashrc]));
    assert.match(result(r.out, 0), /Spec phase design: only .*design\.md may be written now \(.*design\.md is a symbolic link\)/, r.out + r.err);
    assert.match(result(r.out, 1), /Spec phase design: only .*design\.md may be written now$/);
    assert.doesNotMatch(r.out, /File created successfully/);
  } finally {
    w.cleanup();
  }
});

test('g1 unit: NextPress hands out one signal per press, counts task hooks under it, and passes other calls through', async () => {
  const p = new NextPress();
  assert.equal(p.press(), false, 'nothing handed out');
  const s1 = p.signal();
  assert.equal(p.signal(), s1, 'the same signal until a press');
  const inner = {
    tag: 'inner',
    runTaskHook(ctx: { signal?: AbortSignal }): Promise<string> {
      return new Promise((resolve) => {
        if (!ctx.signal) return resolve('no-signal');
        ctx.signal.addEventListener('abort', () => resolve('killed'), { once: true });
      });
    },
    who(this: { tag: string }): string {
      return this.tag;
    },
  };
  const runner = p.track(inner as unknown as HookRunnerLike) as unknown as typeof inner;
  assert.equal(runner.who(), 'inner', 'other methods keep their receiver');
  assert.equal(await runner.runTaskHook({}), 'no-signal');
  const other = new AbortController();
  void runner.runTaskHook({ signal: other.signal });
  assert.equal(p.press(), false, 'a hook under another signal is not ours');
  assert.equal(s1.aborted, true, 'the press aborted the signal handed out');
  other.abort();
  const s2 = p.signal();
  assert.notEqual(s2, s1, 'a fresh signal after the press');
  const run = runner.runTaskHook({ signal: s2 });
  assert.equal(p.press(), true, 'a task hook ran under the signal');
  assert.equal(await run, 'killed');
  p.signal();
  assert.equal(p.press(), false, 'it is no longer counted once it ended');
});
