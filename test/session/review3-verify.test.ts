/**
 * Adversarial checks of the third review's session/ fixes (G1, G2, G5) on paths the guards in
 * review3.test.ts do not reach:
 *  - G2 × /rewind after the fallback session spoke: the turns saved before the fallback name
 *    assistant messages of the lost transcript. The real claude 2.1.319 refuses such a fork
 *    (`--resume <id> --resume-session-at <uuid not in it> --fork-session` → stderr
 *    `No message found with message.uuid of: <uuid>`, an `error_during_execution` result, exit 1;
 *    VERIFIED). The rewind must then start its record fresh with the kept turns as restored
 *    history, not fail, and never bring back the turns rewound away. The stock fake keeps the
 *    full history for an unknown uuid, so these tests wrap it to answer like the real claude.
 *  - G1 × the spec driver: a phase turn cancelled before it was sent, a second phase key, or no
 *    turn reaching Claude at all: the carry still reaches the conversation the user continues in
 *    exactly once.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ClaudeBinary, ClaudeCapabilities } from '../../src/claude/binary.js';
import { KiroSessionImpl, type KiroSessionInternalOptions } from '../../src/session/kiroSession.js';
import { SpecSessionDriver, type SessionPort, type SpecPhaseRestriction } from '../../src/spec/workflow.js';
import type { KiroSession } from '../../src/types.js';
import { closeAll, drain, fakeBinary, fakeCaps, fakeClaudePath, flagValue, mkSandbox, recordingUI, type RecordingUI, type Sandbox } from './helpers.js';

let caps: ClaudeCapabilities;
before(async () => {
  caps = await fakeCaps();
});

/**
 * The fake, answering a fork at a message uuid its source transcript does not hold the way the
 * real claude 2.1.319 does (VERIFIED, see the module doc). Everything else goes to the fake.
 */
function realForkAtBinary(sb: Sandbox): ClaudeBinary {
  const p = path.join(sb.root, 'claude-fork-at.mjs');
  fs.writeFileSync(
    p,
    `import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const at = val('--resume-session-at');
const from = val('--resume');
if (at && from && process.env.CLAUDE_CONFIG_DIR) {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), from + '.jsonl');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = undefined; }
  const has = text === undefined || text.split('\\n').some((l) => { try { return JSON.parse(l).uuid === at; } catch { return false; } });
  if (!has) {
    const msg = 'No message found with message.uuid of: ' + at;
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: val('--session-id') ?? from, errors: [msg] }) + '\\n');
    process.stderr.write(msg + '\\n');
    process.exit(1);
  }
}
const child = spawn(process.execPath, [${JSON.stringify(fakeClaudePath())}, ...argv], { stdio: 'inherit' });
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => child.kill(s));
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 143 : 0)));
`,
  );
  return { ...fakeBinary(), path: p };
}

function baseOptions(sb: Sandbox, ui: RecordingUI = recordingUI(), binary: ClaudeBinary = fakeBinary()): KiroSessionInternalOptions {
  return { ws: sb.ws, origin: 'repl', interactive: true, ui, binary, caps, env: sb.env };
}

function contentText(line: Record<string, unknown>): string {
  const c = (line.message as { content: unknown }).content;
  if (typeof c === 'string') return c;
  return (c as { type: string; text?: string }[]).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');
}

const userTexts = (sb: Sandbox): string[] => sb.userLines().map(contentText);
const lastUserText = (sb: Sandbox): string => userTexts(sb).at(-1) ?? '';
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
const BLOCK = '<kiro-restored-history>';

const SCRIPT = {
  turns: [{ repeat: true, match: '^Summarize the findings', steps: [{ text: 'SUMMARY: the tangent found FOUND_X' }] }],
  default: { steps: [{ text: 'hist={{historyUserTexts}}' }] },
};

// ───────────────────────────── G2 × /rewind ─────────────────────────────

describe('G2 (verify): /rewind to a turn saved before a fallback to a fresh Claude session', () => {
  /** `prompts` saved, the Claude transcripts deleted, resumed (fallback), then `after` sent. */
  async function fellBackAndSpoke(prompts: string[], after: string): Promise<{ sb: Sandbox; s: KiroSessionImpl; ui: RecordingUI }> {
    const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
    const bin = realForkAtBinary(sb);
    const first = await KiroSessionImpl.create(baseOptions(sb, recordingUI(), bin));
    let id: string;
    try {
      for (const p of prompts) await drain(first.prompt({ text: p }));
      id = first.id;
    } finally {
      await closeAll(first);
    }
    fs.rmSync(path.join(sb.claudeConfig, 'projects'), { recursive: true, force: true });
    const ui = recordingUI();
    const s = await KiroSessionImpl.create({ ...baseOptions(sb, ui, bin), resume: { sessionId: id } });
    assert.ok(ui.notices.some((n) => /could not find the saved conversation/i.test(n.message)), 'the resume fell back to a fresh Claude session');
    await drain(s.prompt({ text: after }));
    assert.equal(count(lastUserText(sb), BLOCK), 1, 'precondition: the fallback session got the history');
    return { sb, s, ui };
  }

  it('/rewind 1: the rewind starts fresh with turn 1 as history; turns 2 and 3 never come back', async () => {
    const { sb, s } = await fellBackAndSpoke(['first ALPHA_1', 'second BETA_2'], 'third GAMMA_3');
    try {
      const oldId = s.id;
      await s.rewind(1);
      assert.notEqual(s.id, oldId, 'the rewind is a record of its own');
      assert.deepEqual(
        s.record.turns.map((t) => t.preview),
        ['first ALPHA_1'],
      );
      const { result } = await drain(s.prompt({ text: 'after rewind' }));
      const t = lastUserText(sb);
      assert.equal(count(t, BLOCK), 1, `the kept history once: ${JSON.stringify(t.slice(0, 200))}`);
      assert.match(t, /User: first ALPHA_1[\s\S]*<\/kiro-restored-history>[\s\S]*after rewind/);
      assert.doesNotMatch(t, /BETA_2|GAMMA_3/, 'a turn rewound away was sent again');
      assert.doesNotMatch(result.text, /BETA_2|GAMMA_3/, 'a turn rewound away is in the rewound conversation');
      await drain(s.prompt({ text: 'later' }));
      assert.equal(count(lastUserText(sb), BLOCK), 0, 'delivered once');
    } finally {
      await closeAll(s);
    }
  });

  it('/rewind 3 (a turn of the fresh Claude session) still forks at it: no fallback, no block', async () => {
    const { sb, s, ui } = await fellBackAndSpoke(['first ALPHA_1', 'second BETA_2'], 'third GAMMA_3');
    try {
      const notices = ui.notices.length;
      await s.rewind(3);
      const argv = sb.starts().at(-1)!;
      assert.ok(argv.includes('--fork-session'));
      assert.ok(flagValue(argv, '--resume-session-at'), 'forked at the turn');
      assert.equal(ui.notices.slice(notices).filter((n) => /could not find/i.test(n.message)).length, 0);
      const { result } = await drain(s.prompt({ text: 'after rewind' }));
      assert.equal(count(lastUserText(sb), BLOCK), 0, 'the forked history already holds it');
      assert.match(result.text, /ALPHA_1[\s\S]*BETA_2[\s\S]*third GAMMA_3[\s\S]*after rewind/);
    } finally {
      await closeAll(s);
    }
  });
});

// ───────────────────────────── G1 × spec driver ─────────────────────────────

describe('G1 (verify): the spec driver delivers a merged carry once whatever the flow does', () => {
  const P1: SpecPhaseRestriction = { name: 'requirements', allowedWritePaths: ['.kiro/specs/x/requirements.md'] };
  const P2: SpecPhaseRestriction = { name: 'design', allowedWritePaths: ['.kiro/specs/x/design.md'] };

  for (const variant of ['cancelled, then the same phase', 'cancelled, then another phase', 'no turn reached Claude'] as const) {
    it(`${variant}: the continued conversation gets the summary exactly once`, async () => {
      const sb = mkSandbox({ script: SCRIPT, env: { FAKE_CLAUDE_PERSIST: '1' } });
      const main = await KiroSessionImpl.create(baseOptions(sb));
      let active: KiroSession = main;
      const all: KiroSession[] = [main];
      const port: SessionPort = {
        active: () => active,
        async create(o) {
          const s = await KiroSessionImpl.create({ ...baseOptions(sb), origin: 'spec', ...o } as KiroSessionInternalOptions);
          all.push(s);
          return s;
        },
        activate(s) {
          active = s;
        },
        async run(s, input) {
          return (await drain(s.prompt(input))).result;
        },
      };
      try {
        await drain(main.prompt({ text: 'm1' }));
        await main.enterTangent('research');
        await drain(main.prompt({ text: 'finding FOUND_X' }));
        await main.exitTangent('merge');
        const before = sb.userLines().length;
        const driver = new SpecSessionDriver(port);
        const pressed = new AbortController();
        pressed.abort();
        assert.equal((await driver.runTurn({ text: 'phase one' }, P1, { signal: pressed.signal })).stopReason, 'cancelled');
        if (variant === 'cancelled, then the same phase') await driver.runTurn({ text: 'phase one again' }, P1);
        if (variant === 'cancelled, then another phase') await driver.runTurn({ text: 'phase two' }, P2);
        await driver.finish('keep');
        assert.equal(active === main, variant === 'no turn reached Claude', 'the REPL keeps main only when no turn reached Claude');
        const { result } = await drain(active.prompt({ text: 'what did the tangent find?' }));
        const after = userTexts(sb).slice(before);
        assert.equal(after.filter((t) => t.includes('<tangent-summary')).length, 1, JSON.stringify(after.map((t) => t.slice(0, 60))));
        assert.match(result.text, /tangent-summary[\s\S]*FOUND_X[\s\S]*what did the tangent find\?/, 'part of the continued conversation');
        await drain(active.prompt({ text: 'again' }));
        assert.doesNotMatch(lastUserText(sb), /tangent-summary/, 'delivered once');
      } finally {
        await closeAll(...all.reverse());
      }
    });
  }
});
