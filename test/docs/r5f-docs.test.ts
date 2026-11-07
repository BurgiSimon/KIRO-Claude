/**
 * Round-5 fix "docs" (#7, #9, #10, #12, #13, #14, #15, #16): what the project docs and the
 * user-visible help texts say matches what the code does.
 *
 *  - docs/ARCHITECTURE.md has sections on Ctrl+C and signals, signals and child processes, specs,
 *    ACP cancellation and `crew stop`, and every timing it names is the value the code uses
 *    (the constants are imported from the build, or read from the source when not exported).
 *  - The module map lists `crew/` and keeps its box aligned.
 *  - src/session/startSignal.ts's module doc names every module that sets a start signal.
 *  - README.md carries the short user-facing versions, and its links into ARCHITECTURE.md land on
 *    real headings.
 *  - `kiroClaude.spec.maxParallelTasks`: the settings description and the README row say it is
 *    `kiro-claude spec run`'s, since `/spec run` in chat runs one task at a time (checked).
 *  - `crew stop --help` describes the stop sequence; the README's `crew uninstall` paragraph says
 *    what a plain uninstall removes and what only `--purge` does (checked against a real uninstall
 *    over the fake KiroCrew).
 *
 * Reads README.md, docs/ and src/ from the repository root (tests run from there).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ErrorCodes } from '../../src/acp/jsonrpc.js';
import { KILL_GRACE_MS, MEMBER_GRACE_MS } from '../../src/claude/lifecycle.js';
import { SETTINGS_SCHEMA } from '../../src/config/settings.js';
import { FORCE_STOP_GRACE_MS } from '../../src/repl/core.js';
import { DUPLICATE_SIGNAL_WINDOW_MS, SIGNAL_CLOSE_GRACE_MS } from '../../src/repl/exitSignals.js';
import { PLAN_MODE_RUN_REFUSED, SPEC_IN_TANGENT_REFUSED, SPEC_TANGENT_LEFT, createReplRuntime, runSpecTasks } from '../../src/spec/workflow.js';
import { crew, freePort, makeFakeEnv, realPython } from '../crew/helpers.js';
import { DESIGN_MD, MockHost, REQ_MD, TASKS_MD, makeWs, mockSettings, writeSpec } from '../spec/helpers.js';

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'session', 'startSignal.ts')) && fs.existsSync(path.join(dir, 'docs', 'ARCHITECTURE.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

const ROOT = repoRoot();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ARCH = read('docs/ARCHITECTURE.md');
const README = read('README.md');

/** `ms` the way the docs write a duration: `2 s`, `500 ms`. */
function dur(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

/** The text under `heading` (a `## …` or `### …` line, matched exactly) up to the next heading of that level or higher. */
function section(md: string, heading: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l === heading);
  assert.ok(start >= 0, `heading ${JSON.stringify(heading)} not found`);
  const level = /^#+/.exec(heading)![0].length;
  let end = lines.length;
  let fenced = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('```')) fenced = !fenced;
    const m = fenced ? null : /^(#+) /.exec(lines[i]!);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Prose with line breaks folded into spaces (a phrase may wrap). */
const flat = (s: string): string => s.replace(/\s+/g, ' ');

/** A `const NAME = <number>;` of a source file (for constants the module does not export). */
function sourceConst(rel: string, name: string): number {
  const m = new RegExp(`const ${name}\\s*=\\s*([\\d_]+)\\s*;`).exec(read(rel));
  assert.ok(m, `${name} not found in ${rel}`);
  return Number(m[1]!.replace(/_/g, ''));
}

/** GitHub's anchor for a heading. */
function slug(heading: string): string {
  return heading
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

describe('r5f docs #7/#13: Ctrl+C, fatal signals and the start signal', () => {
  it("startSignal.ts's module doc names every module that sets a start signal, and what each passes", () => {
    const src = path.join(ROOT, 'src');
    const doc = /^\/\*\*[\s\S]*?\*\//.exec(read('src/session/startSignal.ts'))![0];
    const callers = tsFiles(src)
      .filter((f) => !f.endsWith(path.join('session', 'startSignal.ts')))
      .filter((f) => /\bwithStartSignal\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(src, f).split(path.sep).join('/'))
      .sort();
    assert.ok(callers.length >= 5, `callers: ${callers.join(', ')}`);
    const missing = callers.filter((rel) => !doc.includes(rel));
    assert.deepEqual(missing, [], `the module doc does not name: ${missing.join(', ')}`);
    // the REPL's own creations do take a signal of their own now (Repl.opening: the fatal-signal one)
    assert.doesNotMatch(flat(doc), /take no signal of their own/);
    for (const name of ['ExitSignals', 'nextPressSignal', 'createUnderPress', 'createUnderStop', '$/cancel_request']) {
      assert.ok(doc.includes(name), `the module doc does not mention ${name}`);
    }
  });

  it("ARCHITECTURE.md's 'Ctrl+C and signals' section gives the REPL's rules with the code's timings", () => {
    const s = flat(section(ARCH, '## Ctrl+C and signals'));
    // the first press, the command signal, the next press, the forced stop and its restart
    assert.match(s, /first (Ctrl\+C|press)[^.]*interrupts/i);
    assert.match(s, /commandSignal/);
    assert.match(s, /nextPressSignal/);
    assert.match(s, /second (Ctrl\+C|press)/i);
    assert.ok(s.includes(`${dur(FORCE_STOP_GRACE_MS)} later`), `the forced stop after ${dur(FORCE_STOP_GRACE_MS)} is not described`);
    assert.match(s, /--resume/);
    assert.match(s, /Restart cancelled \(Ctrl\+C\)/);
    assert.match(s, /F0/);
    // headless's two presses and exit status
    assert.match(s, /130/);
  });

  it("ARCHITECTURE.md's fatal-signal part says what is closed, in which order, for how long, and what is dropped", () => {
    const s = flat(section(ARCH, '### Fatal signals: close, then die of the signal'));
    for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT']) assert.ok(s.includes(sig), `${sig} missing`);
    assert.match(s, /ExitSignals/);
    assert.match(s, /user's chat first/);
    assert.match(s, /SessionEnd/);
    assert.match(s, /chat --resume/);
    assert.ok(s.includes(`${dur(SIGNAL_CLOSE_GRACE_MS)} from the signal`), `the ${dur(SIGNAL_CLOSE_GRACE_MS)} grace is not described`);
    assert.match(s, /re-raise/);
    assert.match(s, /128 \+ the signal number/);
    assert.ok(s.includes(`more than ${dur(DUPLICATE_SIGNAL_WINDOW_MS)} after`), `the ${dur(DUPLICATE_SIGNAL_WINDOW_MS)} duplicate window is not described`);
    assert.match(s, /prints nothing more/);
    assert.match(s, /EIO/);
    assert.match(s, /half-typed line/);
    assert.match(s, /final close/);
  });

  it('README.md has the short version and links to it', () => {
    const s = flat(section(README, '## Ctrl+C and signals'));
    assert.match(s, /Ctrl\+C[^.]*interrupts/);
    assert.match(s, /next Ctrl\+C/);
    assert.match(s, /second Ctrl\+C/);
    assert.match(s, /SIGHUP/);
    assert.match(s, /SIGTERM/);
    assert.ok(s.includes(dur(SIGNAL_CLOSE_GRACE_MS)), 'the close grace is not given');
    assert.match(s, /chat --resume/);
  });
});

describe('r5f docs #10: signals and child processes', () => {
  it("ARCHITECTURE.md's section matches claude/lifecycle.ts", () => {
    const s = flat(section(ARCH, '## Signals and child processes'));
    assert.match(s, /process group/);
    assert.match(s, /detached/);
    assert.ok(s.includes(`after ${dur(KILL_GRACE_MS)}`), `the forwarder's ${dur(KILL_GRACE_MS)} SIGKILL grace is not given`);
    const termAfter = sourceConst('src/claude/lifecycle.ts', 'MEMBER_TERM_AFTER_MS');
    assert.ok(s.includes(`${dur(termAfter)}`) && s.includes(`${dur(MEMBER_GRACE_MS)}`), `the sweep's ${dur(termAfter)} / ${dur(MEMBER_GRACE_MS)} are not given`);
    assert.match(s, /provably ours/);
    assert.match(s, /dyingSignal/);
    assert.match(s, /session of its own/);
    assert.match(s, /Bash tool command/);
  });
});

describe('r5f docs #9: specs', () => {
  it("ARCHITECTURE.md's Specs section covers phase sessions, trust and plan mode, tangents, records, links and Ctrl+C", () => {
    const s = flat(section(ARCH, '## Specs'));
    assert.match(s, /phase session/);
    assert.match(s, /continuation/);
    assert.match(s, /trust/);
    assert.ok(s.includes(PLAN_MODE_RUN_REFUSED), 'the plan-mode refusal is not quoted');
    assert.match(s, /no further task starts/);
    assert.ok(s.includes(SPEC_IN_TANGENT_REFUSED.slice(0, 60)), 'the tangent refusal is not quoted');
    assert.ok(s.includes(SPEC_TANGENT_LEFT.slice(0, 40)), 'leaving an empty tangent is not described');
    assert.match(s, /plan mode the user last set/);
    assert.match(s, /records? of (its|the) phase sessions/);
    assert.match(s, /symbolic link/);
    assert.match(s, /one task at a time/);
    assert.match(s, /nextPressSignal/);
  });

  it('README.md says how /spec behaves in plan mode and in a tangent', () => {
    const s = flat(section(README, '## Specs'));
    assert.match(s, /plan mode/);
    assert.match(s, /tangent/);
    assert.match(s, /one task at a time/);
    assert.match(s, /symbolic link/);
  });
});

describe('r5f docs #12: ACP cancellation of commands and session starts', () => {
  it("ARCHITECTURE.md's section gives the answers the server sends", () => {
    const s = flat(section(ARCH, '## Cancelling commands and session starts (ACP)'));
    const server = read('src/acp/server.ts');
    assert.ok(server.includes("message: 'Command cancelled'"));
    assert.match(s, /\{success:false,message:"Command cancelled"\}/);
    assert.match(s, /stopReason:"cancelled"/);
    assert.ok(s.includes(String(ErrorCodes.REQUEST_CANCELLED)), `${ErrorCodes.REQUEST_CANCELLED} not given`);
    for (const w of ['session/cancel', '$/cancel_request', '_kiro.dev/commands/execute', 'session/set_mode', 'session/new', 'session/load', 'compact_boundary', 'agentSpawn']) {
      assert.ok(s.includes(w), `${w} not mentioned`);
    }
  });

  it("README.md's ACP section mentions it", () => {
    const s = flat(section(README, '## Editors (ACP)'));
    assert.match(s, /Command cancelled/);
    assert.match(s, /\$\/cancel_request/);
  });
});

describe('r5f docs #14: crew/, crew stop and run/crashed.json', () => {
  it('the module map lists crew/ and every row of the box has the same width', () => {
    const lines = ARCH.split('\n');
    const s = lines.findIndex((l) => l.includes('┌'));
    const e = lines.findIndex((l) => l.includes('┘'));
    const box = lines.slice(s, e + 1);
    assert.ok(box.some((l) => /│ crew\/\s/.test(l)), 'no crew/ row');
    const widths = new Set(box.map((l) => [...l].length));
    assert.equal(widths.size, 1, `rows of different widths: ${[...widths].join(', ')}`);
  });

  it("ARCHITECTURE.md's KiroCrew section describes crew stop, crashed.json and its limits as the code has them", () => {
    const s = flat(section(ARCH, '## KiroCrew (persistent pipeline) on Claude Code'));
    const max = sourceConst('src/crew/gateway.ts', 'MAX_CRASHED');
    assert.match(s, /run\/crashed\.json/);
    assert.ok(s.includes(`at most ${max} gateways`), `the ${max}-entry limit is not given`);
    assert.match(s, /Linux only/);
    assert.match(s, /reboot/);
    assert.match(s, /no token/);
    assert.match(s, /which had already exited; <m> leftover process\(es\) of its process group retired/);
    assert.match(s, /of the process group of an earlier gateway \(pid <n>, which had already exited\) retired/);
    assert.match(s, /crew start` warns/);
    assert.match(s, /exits 1/);
    assert.match(s, /KIROCREW_SPAWNED=1/);
  });

  it('crew stop --help describes the stop sequence with the code\'s defaults', async () => {
    const timeout = /o\.timeoutSec \?\? (\d+)/.exec(read('src/crew/gateway.ts'));
    assert.ok(timeout);
    const kill = /killGraceMs:\s*([\d_]+)/.exec(read('src/crew/context.ts'));
    assert.ok(kill);
    const fe = makeFakeEnv();
    try {
      const r = await crew(fe, ['stop', '--help']);
      assert.equal(r.code, 0, r.stderr);
      const help = flat(r.stdout);
      assert.match(help, /^Stop the Kiro Crew gateway/);
      assert.match(help, /kirocrew stop/);
      assert.ok(help.includes(`default ${timeout[1]} s`), `the --timeout default (${timeout[1]} s) is not given:\n${r.stdout}`);
      assert.ok(help.includes(`${Number(kill[1]!.replace(/_/g, '')) / 1000} s later`), `the SIGKILL delay is not given:\n${r.stdout}`);
      assert.match(help, /crashed\.json/);
      assert.match(help, /Linux/);
      assert.match(help, /crew start warns/);
      assert.match(help, /Exit status: 0 .*1 /);
    } finally {
      fe.cleanup();
    }
  });

  it("README.md's KiroCrew section says crew stop retires what crashed gateways left", () => {
    const s = section(README, '## KiroCrew on Claude Code');
    const para = s.split('\n\n').find((p) => p.startsWith('`kiro-claude crew stop`'));
    assert.ok(para, 'no paragraph on `kiro-claude crew stop`');
    assert.match(para, /leftover/);
    assert.match(para, /run\/crashed\.json/);
    assert.match(para, /crew start` warns/);
  });
});

describe('r5f docs #15: kiroClaude.spec.maxParallelTasks', () => {
  it('/spec run in chat runs one task at a time with the setting at 2, and both texts say so', async () => {
    const w = makeWs('kc-r5f-docs-mpt-');
    try {
      writeSpec(w, 'todo-export', { requirements: REQ_MD, design: DESIGN_MD, tasks: TASKS_MD });
      let running = 0;
      let peak = 0;
      const script = async (): Promise<{ text: string }> => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        return { text: 'TASK_RESULT: completed' };
      };
      const host = new MockHost(w.ctx, script, { settings: mockSettings({ 'kiroClaude.spec.maxParallelTasks': 2 }) });
      const r = await runSpecTasks(createReplRuntime(host, { openEditor: null }), 'todo-export', { kind: 'ids', ids: ['1.1', '1.2'], includeOptional: true });
      assert.equal(r.status, 'completed');
      assert.equal(peak, 1, 'the chat ran tasks of one wave at once');
    } finally {
      w.cleanup();
    }
    assert.match(read('src/spec/cli.ts'), /getNumber\('kiroClaude\.spec\.maxParallelTasks'/, 'kiro-claude spec run reads the setting');
    const desc = SETTINGS_SCHEMA['kiroClaude.spec.maxParallelTasks']!.description;
    assert.match(desc, /kiro-claude spec run/);
    assert.match(desc, /\/spec run in chat runs one task at a time/);
    const row = README.split('\n').find((l) => l.startsWith('| `kiroClaude.spec.maxParallelTasks`'));
    assert.ok(row, 'README row present');
    assert.match(row, /`kiro-claude spec run`/);
    assert.match(row, /`\/spec run` in chat runs one task at a time/);
  });
});

describe('r5f docs #16: crew uninstall vs --purge', { skip: realPython() ? false : 'no python3 with sqlite3' }, () => {
  it('a plain uninstall removes the launcher, the logs and crashed.json; the README says so and gives --purge only the rest', async () => {
    const fe = makeFakeEnv();
    try {
      fs.writeFileSync(path.join(fe.home, '.fake-claude-login'), '');
      assert.equal((await crew(fe, ['setup', '--dir', path.join(fe.root, 'KiroCrew'), '--allow-tmp'])).code, 0);
      assert.equal((await crew(fe, ['start', '--port', String(await freePort())])).code, 0);
      const shim = path.join(fe.cs, 'bin', 'kiro-claude');
      const run = path.join(fe.cs, 'run');
      const files = ['gateway.out', 'gateway.err', 'setup.log', 'crashed.json'];
      fs.writeFileSync(path.join(run, 'crashed.json'), '{"version":1,"gateways":[]}\n');
      assert.ok(fs.existsSync(shim));
      const r = await crew(fe, ['uninstall']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(fs.existsSync(shim), false, 'the launcher is still there');
      assert.deepEqual(files.filter((f) => fs.existsSync(path.join(run, f))), [], 'run files left');
      assert.ok(fs.existsSync(fe.cs), 'the crew state dir is kept without --purge');
    } finally {
      fe.cleanup();
    }
    const para = flat(README.slice(README.indexOf('`kiro-claude crew uninstall`'), README.indexOf('\n## ', README.indexOf('`kiro-claude crew uninstall`'))));
    const purge = para.slice(para.indexOf('`--purge`'));
    const plain = para.slice(0, para.indexOf('`--purge`'));
    assert.match(plain, /launcher/);
    assert.match(plain, /crashed\.json/);
    assert.match(plain, /logs/);
    assert.match(purge, /claude-agent-acp/);
    assert.match(purge, /cache/);
    const purgeSentence = purge.slice(0, purge.search(/\.\s/) + 1);
    assert.doesNotMatch(purgeSentence, /launcher|logs/, purgeSentence);
  });
});

describe('r5f docs: README links into ARCHITECTURE.md', () => {
  it('every #anchor exists as a heading', () => {
    const anchors = new Set(ARCH.split('\n').filter((l) => /^#{1,6} /.test(l)).map(slug));
    const links = [...README.matchAll(/\(docs\/ARCHITECTURE\.md#([^)]+)\)/g)].map((m) => m[1]!);
    assert.ok(links.length >= 4, `links: ${links.join(', ')}`);
    const broken = links.filter((a) => !anchors.has(a));
    assert.deepEqual(broken, [], `anchors: ${[...anchors].join(', ')}`);
  });
});
