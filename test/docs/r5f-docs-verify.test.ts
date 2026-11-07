/**
 * Round-5 fix "docs", verifier: claims of README.md and docs/ARCHITECTURE.md that the fixer's
 * test (r5f-docs.test.ts) does not hold against the code. Each case checks what the code does,
 * then that the docs say it.
 *
 *  - `/spec` in a tangent: only a tangent of the main conversation that has no message of its own
 *    is left first; an empty tangent nested in another tangent is refused like one with messages
 *    (spec/slash.ts emptyTangent). The docs said "an empty tangent is left".
 *  - `/rewind N` across a compaction: only a rewind to a turn BEFORE the one the compaction
 *    followed falls back on the saved history (with its warning); a rewind to the turn the
 *    compaction followed forks at the compaction. The docs said every rewind to a turn a
 *    compaction followed loses that turn.
 *  - `/spec run`: a task its PreTaskExec hook blocks (exit 2) is skipped and the run goes on. The
 *    docs said the run stops at the first task that does not complete.
 *  - Symlinked spec folders: one that resolves outside the workspace is refused. The README said
 *    "a symlinked `.kiro/specs` folder inside the workspace works", which every such link is.
 *  - A quick spec drafts its three documents with one checkpoint at the end. The docs said every
 *    phase is followed by a review.
 *  - `/tangent` in a chat with no message is refused (`Can't branch an empty chat.`). The docs
 *    described quitting inside such a tangent as something the chat does.
 *  - Tangent carries (docs only, the behaviour is test/session/r5f-session-merge and
 *    r5f-session-verify): a `tail` carries the tangent's own exchange also after a return from a
 *    tangent nested in it, and what a nested tangent left for its parent reaches the main
 *    conversation only when that parent is merged.
 *
 * Reads README.md, docs/ and src/ from the repository root (tests run from there).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeCapabilities } from '../../src/claude/binary.js';
import { checkSpecWrite } from '../../src/policy/specwrite.js';
import { KiroSessionImpl } from '../../src/session/kiroSession.js';
import { createReplRuntime, runSpecTasks } from '../../src/spec/workflow.js';
import { makeWs as policyWs } from '../policy/helpers.js';
import { closeAll, drain, fakeBinary, fakeCaps, mkSandbox, recordingUI } from '../session/helpers.js';
import { liveRepl } from '../spec/liveRepl.js';
import { DESIGN_MD, MockHost, REQ_MD, TASKS_MD, makeWs, recordingHooks, taskHook, writeSpec } from '../spec/helpers.js';

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md')) && fs.existsSync(path.join(dir, 'README.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

const ROOT = repoRoot();
const ARCH = fs.readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
/** Prose with line breaks folded into spaces (a phrase may wrap). */
const flat = (s: string): string => s.replace(/\s+/g, ' ');
/** A source file's comments folded the same way (the ` * ` of each comment line dropped). */
const flatSource = (s: string): string => flat(s.replace(/\n\s*\* ?/g, ' '));

/** The text under `heading` (matched exactly) up to the next heading of that level or higher. */
function section(md: string, heading: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l === heading);
  assert.ok(start >= 0, `heading ${JSON.stringify(heading)} not found`);
  const level = /^#+/.exec(heading)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+) /.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return flat(lines.slice(start, end).join('\n'));
}

/** The `* **<label>.**` bullet of a flattened section. */
function bullet(s: string, label: string): string {
  const at = s.indexOf(`* **${label}.**`);
  assert.ok(at >= 0, `no **${label}.** bullet`);
  const next = s.indexOf('* **', at + 4);
  return s.slice(at, next < 0 ? undefined : next);
}

const FLOW = '/spec new first-spec --type feature --workflow requirements-first a csv export';

describe('r5f docs verify: /spec in an empty tangent', () => {
  it('an empty tangent nested in a tangent is refused, not left; the docs say only one of the main conversation is left', { timeout: 120_000 }, async () => {
    const r = liveRepl({
      turns: [
        { repeat: true, match: 'Phase: REQUIREMENTS', steps: [{ text: 'DRAFTED' }] },
        { repeat: true, steps: [{ text: 'ANSWER history=[{{historyUserTexts}}] END' }] },
      ],
    });
    try {
      await r.waitFor(/> $/);
      await r.send('main MAINLINE', /ANSWER history=\[main MAINLINE\] END[\s\S]*> $/);
      await r.send('/tangent side', /Created a conversation checkpoint[\s\S]*> $/);
      await r.send('side SIDELINE', /ANSWER history=\[main MAINLINE \| side SIDELINE\] END[\s\S]*> $/);
      await r.send('/tangent deeper', /Created a conversation checkpoint[\s\S]*> $/);
      const out = await r.send(FLOW, /> $/);
      assert.match(out, /Spec drafting is disabled while in tangent mode/, out);
      assert.doesNotMatch(out, /Left the tangent/, out);
      assert.ok(!r.userLines().some((l) => l.includes('Phase: REQUIREMENTS')), 'a phase turn was sent');
    } finally {
      await r.close();
    }
    const arch = bullet(section(ARCH, '## Specs'), 'Tangents');
    assert.doesNotMatch(arch, /A tangent with no message of its own yet is left first/, arch);
    assert.match(arch, /tangent of the main conversation that has no message of its own/, arch);
    assert.match(arch, /nested/, arch);
    const readme = section(README, '## Specs');
    assert.doesNotMatch(readme, /An empty tangent is left/, readme);
    assert.match(readme, /nested/, readme);
  });
});

describe('r5f docs verify: /tangent in a chat with no message', () => {
  it('the chat refuses it, so the docs do not describe quitting inside such a tangent as a chat action', { timeout: 60_000 }, async () => {
    const r = liveRepl({ turns: [{ repeat: true, steps: [{ text: 'ANSWER' }] }] });
    try {
      await r.waitFor(/> $/);
      await r.send('/effort low', /> $/);
      const out = await r.send('/tangent side', /> $/);
      assert.match(out, /Can't branch an empty chat\./, out);
      assert.doesNotMatch(out, /Created a conversation checkpoint/, out);
    } finally {
      await r.close();
    }
    const t = bullet(section(ARCH, '## Sessions: tangents, rewind, compaction'), 'Tangents');
    assert.doesNotMatch(t, /Quitting inside a tangent that never had a message, of a chat that never had one either/, t);
    assert.match(t, /Can't branch an empty chat\./, t);
  });
});

describe('r5f docs verify: /rewind across a compaction', () => {
  let caps: ClaudeCapabilities;
  before(async () => {
    caps = await fakeCaps();
  });
  it('only a rewind to a turn before the one the compaction followed falls back; the docs say so', async () => {
    const warnsAfter = async (n: number): Promise<string[]> => {
      const sb = mkSandbox({ script: { default: { steps: [{ text: 'hist={{historyUserTexts}}' }] } }, env: { FAKE_CLAUDE_PERSIST: '1' } });
      const ui = recordingUI();
      const s = await KiroSessionImpl.create({ ws: sb.ws, origin: 'repl', interactive: true, ui, binary: fakeBinary(), caps, env: sb.env });
      try {
        await drain(s.prompt({ text: 'alpha ALPHA_1' }));
        await drain(s.prompt({ text: 'beta BETA_2' }));
        assert.equal((await drain(s.compact())).result.isError, false, 'precondition: compacted after turn 2');
        await s.rewind(n);
        return ui.notices.filter((x) => x.level === 'warn').map((x) => x.message);
      } finally {
        await closeAll(s);
      }
    };
    assert.deepEqual(await warnsAfter(2), [], 'a rewind to the turn the compaction followed fell back');
    assert.ok((await warnsAfter(1)).some((m) => /compacted after turn 1/.test(m)), 'a rewind to an earlier turn did not fall back');
    const rewind = bullet(section(ARCH, '## Sessions: tangents, rewind, compaction'), 'Rewind');
    assert.doesNotMatch(rewind, /When the conversation was compacted after turn N, Claude Code no longer holds that turn/, rewind);
    assert.match(rewind, /the turn the compaction followed/, rewind);
  });
});

describe('r5f docs verify: /spec run and a skipped task', () => {
  it('a task its PreTaskExec hook blocks is skipped and the run goes on; the docs say so', async () => {
    const w = makeWs('kc-r5f-docs-v-skip-');
    try {
      writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
      const host = new MockHost(w.ctx, async () => ({ text: 'TASK_RESULT: completed' }), { hooks: [taskHook('PreTaskExec')] });
      const hooks = recordingHooks({ block: (id) => (id === '1.1' ? 'lint first' : undefined) });
      const r = await runSpecTasks(createReplRuntime(host, { openEditor: null, hookRunnerFactory: () => hooks }), 'todo-export', { kind: 'ids', ids: ['1.1', '1.2'] });
      assert.deepEqual(r.outcomes.map((o) => [o.id, o.status]), [['1.1', 'skipped'], ['1.2', 'completed']]);
    } finally {
      w.cleanup();
    }
    const run = bullet(section(ARCH, '## Specs'), 'Running tasks');
    assert.doesNotMatch(run, /the run stops at the first task that does not complete/, run);
    assert.match(run, /skip/, run);
  });
});

describe('r5f docs verify: symlinked spec folders', () => {
  it('a .kiro/specs link that resolves outside the workspace is refused; the README says the link must resolve inside it', () => {
    const tw = policyWs();
    const outside = fs.mkdtempSync(path.join(path.dirname(tw.root), 'kc-r5f-docs-v-out-'));
    try {
      fs.mkdirSync(path.join(tw.root, '.kiro'), { recursive: true });
      const doc = path.join(tw.root, '.kiro', 'specs', 'feat', 'design.md');
      const call = { claudeName: 'Write', input: { file_path: doc, content: 'x' }, subjects: [doc], cwd: tw.ws.cwd };
      fs.mkdirSync(path.join(outside, 'feat'));
      fs.symlinkSync(outside, path.join(tw.root, '.kiro', 'specs'));
      const out = checkSpecWrite(call, [doc], tw.ws);
      assert.equal(out.ok, false, 'a spec folder linked outside the workspace was allowed');
      assert.match(out.refused ?? '', /outside the workspace/);
      fs.unlinkSync(path.join(tw.root, '.kiro', 'specs'));
      const inside = path.join(tw.root, 'specs-here');
      fs.mkdirSync(path.join(inside, 'feat'), { recursive: true });
      fs.symlinkSync(inside, path.join(tw.root, '.kiro', 'specs'));
      assert.equal(checkSpecWrite(call, [doc], tw.ws).ok, true, 'a spec folder linked inside the workspace was refused');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      tw.cleanup();
    }
    const readme = section(README, '## Specs');
    assert.doesNotMatch(readme, /a symlinked `\.kiro\/specs` folder inside the workspace works/, readme);
    assert.match(readme, /resolves inside the workspace/, readme);
    assert.match(readme, /outside/, readme);
  });
});

describe('r5f docs verify: quick specs', () => {
  it('the docs say a quick spec has one checkpoint at the end, as workflow.ts does', () => {
    const wf = fs.readFileSync(path.join(ROOT, 'src', 'spec', 'workflow.ts'), 'utf8');
    assert.match(flatSource(wf), /quick spec: clarifying questions → requirements → design → tasks with no gates in between, one final checkpoint on tasks/);
    const arch = section(ARCH, '## Specs');
    assert.match(arch, /quick spec[^.]*one checkpoint at the end/i, arch.slice(0, 600));
    const readme = section(README, '## Specs');
    assert.match(readme, /quick spec[^.]*one review at the end/i, readme.slice(0, 600));
  });
});

describe('r5f docs verify: tangent tail and carries', () => {
  it('the Sessions section says what a tail carries and when a nested carry reaches main', () => {
    const t = bullet(section(ARCH, '## Sessions: tangents, rewind, compaction'), 'Tangents');
    // a tail carries the tangent's own exchange: also after a return from a nested tangent, and
    // after a /rewind inside it (any tangent), never a turn rewound away
    assert.doesNotMatch(t, /A `tail` out of a nested tangent carries/, t);
    assert.match(t, /after a return from a tangent nested in it/, t);
    assert.match(t, /never a turn rewound away/, t);
    // a nested tangent's carry reaches main through its parent's merge only
    assert.match(t, /when that parent is merged/, t);
    assert.match(t, /stays on the parent's record/, t);
    const kiroSession = flatSource(fs.readFileSync(path.join(ROOT, 'src', 'session', 'kiroSession.ts'), 'utf8'));
    assert.match(kiroSession, /A carry queued on the tangent stays on its record with a tail, as with a plain `\/tangent`/);
  });
});
