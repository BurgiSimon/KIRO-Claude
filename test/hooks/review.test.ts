/**
 * Adversarial review tests for src/hooks (boundaries, quoting, unicode, ordering, error paths,
 * research vectors not covered by the per-module suites).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_STOP_CONTINUE_TEXT, wrapHookContext } from '../../src/hooks/format.js';
import { compileHookRegex, matchesFileGlobs, matchesFileHook, matchesV2, matchesV3 } from '../../src/hooks/matcher.js';
import { buildPayload, toKiroToolResponse, toV2ToolInput, toV3ToolInput } from '../../src/hooks/payload.js';
import {
  FILE_PATH_TEMPLATE,
  HookRunner,
  effectiveMaxOutputBytes,
  effectiveTimeoutMs,
  parseConfirmCommandOutput,
  parseStopDecision,
  quoteStyleForShell,
  sanitizeUserPrompt,
  substituteFilePath,
  truncateHookOutput,
} from '../../src/hooks/runner.js';
import type { HookRunContext, KiroHook, WorkspaceContext } from '../../src/types.js';
import { mkCall, mkWs, q, rmWs, v2Hook, v3Hook } from './helpers.js';

function ctxFor(ws: ReturnType<typeof mkWs>, extra: Partial<HookRunContext> = {}): HookRunContext {
  return { ws, sessionId: 'sid-r', ...extra };
}

function withWs(name: string, fn: (ws: ReturnType<typeof mkWs>) => Promise<void>, sub?: string): void {
  test(name, async () => {
    const ws = mkWs(sub);
    try {
      await fn(ws);
    } finally {
      rmWs(ws);
    }
  });
}

const lines = (f: string): string[] => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);

// ───────────────────────────── {{filePath}} quoting ─────────────────────────────

const NASTY_PATHS = [
  '/ws/plain.ts',
  '/ws/a b.ts',
  "/ws/it's.ts",
  '/ws/say "hi".ts',
  '/ws/$HOME.ts',
  '/ws/`id`.ts',
  '/ws/back\\slash.ts',
  '/ws/ünï cødé ✓.ts',
  '/ws/a\nb.ts',
  '/ws/!bang.ts',
  '/ws/*.ts',
  "/ws/mixed '\"$`\\ x.ts",
];

/** Templates and the single argument bash must see for path `p`. */
const TEMPLATES: [string, (p: string) => string][] = [
  [FILE_PATH_TEMPLATE, (p) => p],
  [`"${FILE_PATH_TEMPLATE}"`, (p) => p],
  [`'${FILE_PATH_TEMPLATE}'`, (p) => p],
  [`"pre-${FILE_PATH_TEMPLATE}-post"`, (p) => `pre-${p}-post`],
  [`'pre-${FILE_PATH_TEMPLATE}-post'`, (p) => `pre-${p}-post`],
  [`x=${FILE_PATH_TEMPLATE}`, (p) => `x=${p}`],
  [`\\"${FILE_PATH_TEMPLATE}\\"`, (p) => `"${p}"`], // escaped quotes: placeholder is unquoted
  [`"a\\"${FILE_PATH_TEMPLATE}"`, (p) => `a"${p}`], // \" inside "…" does not close the string
];

test('substituteFilePath (posix): every template yields exactly the path as ONE bash argument', () => {
  for (const p of NASTY_PATHS) {
    for (const [tpl, want] of TEMPLATES) {
      const cmd = substituteFilePath(`printf '%s\\0' ${tpl}`, p, 'posix');
      const out = execFileSync('bash', ['-c', cmd], { encoding: 'utf8' });
      assert.deepEqual(out.split('\0').slice(0, -1), [want(p)], `template ${tpl} / path ${JSON.stringify(p)} / cmd ${JSON.stringify(cmd)}`);
    }
  }
});

test('substituteFilePath: several placeholders in different contexts, none, and pure-function shapes', () => {
  const p = "/ws/a b's.ts";
  assert.equal(substituteFilePath('echo hi', p), 'echo hi');
  assert.equal(substituteFilePath(`a ${FILE_PATH_TEMPLATE} "${FILE_PATH_TEMPLATE}" '${FILE_PATH_TEMPLATE}'`, p), `a '/ws/a b'"'"'s.ts' "/ws/a b's.ts" '/ws/a b'\\''s.ts'`);
  const cmd = substituteFilePath(`printf '%s\\0' ${FILE_PATH_TEMPLATE} "${FILE_PATH_TEMPLATE}" '${FILE_PATH_TEMPLATE}'`, p);
  assert.deepEqual(execFileSync('bash', ['-c', cmd], { encoding: 'utf8' }).split('\0').slice(0, -1), [p, p, p]);
  // Safe paths stay unquoted (POSIX `shellQuote`).
  assert.equal(substituteFilePath(`eslint ${FILE_PATH_TEMPLATE}`, '/ws/src/a.ts'), 'eslint /ws/src/a.ts');
  // A dangling `\` right before the placeholder does not swallow it.
  assert.equal(substituteFilePath(`x\\${FILE_PATH_TEMPLATE}`, '/a'), 'x\\/a');
});

test('substituteFilePath: cmd and PowerShell quoting', () => {
  const sp = 'C:\\My Files\\a.ts';
  assert.equal(substituteFilePath(`eslint ${FILE_PATH_TEMPLATE}`, sp, 'cmd'), 'eslint "C:\\My Files\\a.ts"');
  assert.equal(substituteFilePath(`eslint "${FILE_PATH_TEMPLATE}"`, sp, 'cmd'), `eslint "${sp}"`);
  assert.equal(substituteFilePath(`eslint ${FILE_PATH_TEMPLATE}`, 'C:\\ws\\a.ts', 'cmd'), 'eslint C:\\ws\\a.ts');
  assert.equal(substituteFilePath(`x ${FILE_PATH_TEMPLATE}`, "C:\\it's.ts", 'pwsh'), "x 'C:\\it''s.ts'");
  assert.equal(substituteFilePath(`x '${FILE_PATH_TEMPLATE}'`, "C:\\it's.ts", 'pwsh'), "x 'C:\\it''s.ts'");
  assert.equal(substituteFilePath(`x "${FILE_PATH_TEMPLATE}"`, 'C:\\$a`b.ts', 'pwsh'), 'x "C:\\`$a``b.ts"');
});

test('quoteStyleForShell', () => {
  const rows: [string | undefined, NodeJS.Platform, string][] = [
    [undefined, 'linux', 'posix'],
    [undefined, 'darwin', 'posix'],
    [undefined, 'win32', 'cmd'],
    ['/bin/sh', 'linux', 'posix'],
    ['C:\\Windows\\System32\\cmd.exe', 'win32', 'cmd'],
    ['pwsh', 'linux', 'pwsh'],
    ['powershell.exe', 'win32', 'pwsh'],
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'win32', 'posix'],
  ];
  for (const [shell, plat, want] of rows) assert.equal(quoteStyleForShell(shell, plat), want, `${shell} on ${plat}`);
});

withWs('file hook: "{{filePath}}" (IDE idiom) receives the exact path even with quotes/spaces/$', async (ws) => {
  const out = path.join(ws.dir, 'args.bin');
  const file = path.join(ws.workspaceRoot, 'src', `we"ird $it's ✓.ts`);
  const runner = new HookRunner([
    v3Hook('PostFileSave', `printf '%s\\0' "{{filePath}}" '{{filePath}}' {{filePath}} > ${q(out)}`, { matcher: '\\.ts$' }),
  ]);
  const r = await runner.runFileHook(ctxFor(ws), 'PostFileSave', file, mkCall('Write', { file_path: file, content: '' }, ws.cwd));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(fs.readFileSync(out, 'utf8').split('\0').slice(0, -1), [file, file, file]);
});

// ───────────────────────────── limits hardening ─────────────────────────────

test('effectiveMaxOutputBytes / effectiveTimeoutMs', () => {
  const rows: [number, number][] = [
    [10240, 10240],
    [0, 0],
    [7.9, 7],
    [Number.NaN, 10240],
    [-1, 10240],
    [Number.POSITIVE_INFINITY, 10240],
  ];
  for (const [v, want] of rows) assert.equal(effectiveMaxOutputBytes({ maxOutputBytes: v }), want, String(v));
  assert.equal(effectiveTimeoutMs({ timeoutMs: 0, dialect: 'v3' }), 0);
  assert.equal(effectiveTimeoutMs({ timeoutMs: 1500, dialect: 'v2' }), 1500);
  assert.equal(effectiveTimeoutMs({ timeoutMs: Number.NaN, dialect: 'v2' }), 30000);
  assert.equal(effectiveTimeoutMs({ timeoutMs: -5, dialect: 'v3' }), 60000);
  assert.equal(effectiveTimeoutMs({ timeoutMs: Number.POSITIVE_INFINITY, dialect: 'v3' }), 0);
});

withWs('malformed limits never garble output (NaN / negative maxOutputBytes, NaN timeout)', async (ws) => {
  const runner = new HookRunner([
    v3Hook('SessionStart', 'printf hello', { maxOutputBytes: Number.NaN, timeoutMs: Number.NaN }),
    v3Hook('SessionStart', 'printf world', { maxOutputBytes: -3 }),
  ]);
  assert.deepEqual((await runner.runSessionStart(ctxFor(ws))).outputs, ['hello', 'world']);
});

withWs('V3 timeout 0 = no timeout (hook outlives a short default)', async (ws) => {
  const runner = new HookRunner([v3Hook('SessionStart', 'sleep 0.3; printf done', { timeoutMs: 0 })]);
  assert.deepEqual((await runner.runSessionStart(ctxFor(ws))).outputs, ['done']);
});

// ───────────────────────────── text helpers at unicode boundaries ─────────────────────────────

test('truncateHookOutput: 4-byte characters are never split', () => {
  assert.equal(truncateHookOutput('😀😀', 8), '😀😀');
  assert.equal(truncateHookOutput('😀😀', 7), '😀 ... truncated');
  assert.equal(truncateHookOutput('😀😀', 4), '😀 ... truncated');
  assert.equal(truncateHookOutput('😀😀', 3), ' ... truncated');
  assert.equal(truncateHookOutput('', 0), '');
});

test('sanitizeUserPrompt: NUL, DEL, C1 removed; emoji at the 4096-byte boundary kept whole or dropped', () => {
  assert.equal(sanitizeUserPrompt('a\u0000b\u007fc\u0085d\u009fe'), 'abcde');
  assert.equal(sanitizeUserPrompt('tab\there\r\nok'), 'tab\there\r\nok');
  const s = sanitizeUserPrompt(`${'x'.repeat(4094)}😀`); // 4094 + 4 bytes > 4096 ⇒ emoji dropped
  assert.equal(s, 'x'.repeat(4094));
  assert.equal(sanitizeUserPrompt(`${'x'.repeat(4092)}😀`), `${'x'.repeat(4092)}😀`); // exactly 4096
  assert.equal(sanitizeUserPrompt(''), '');
});

test('wrapHookContext: unicode and multi-line outputs are kept verbatim', () => {
  const w = wrapHookContext(['ünï ✓\nline2'], true);
  assert.ok(w.includes('\n\nünï ✓\nline2\n\n--- CONTEXT ENTRY END ---\n\n'));
});

// ───────────────────────────── Stop / confirm parsing ─────────────────────────────

test('parseStopDecision: whitespace, non-string reason, nested and non-object JSON', () => {
  assert.deepEqual(parseStopDecision('\n  {"decision":"block","reason":"r"}  \n'), { block: true, reason: 'r' });
  assert.deepEqual(parseStopDecision('{"decision":"block","reason":42}'), { block: true });
  assert.deepEqual(parseStopDecision('{"decision":"Block"}'), { block: false });
  assert.deepEqual(parseStopDecision('null'), { block: false });
  assert.deepEqual(parseStopDecision(''), { block: false });
  assert.deepEqual(parseStopDecision('{"decision":"block","reason":"✓ ünï"}'), { block: true, reason: '✓ ünï' });
});

test('parseConfirmCommandOutput: edge shapes fall back to static', () => {
  assert.equal(parseConfirmCommandOutput('{"question":5}'), undefined);
  assert.equal(parseConfirmCommandOutput('{"options":[]}'), undefined);
  assert.deepEqual(parseConfirmCommandOutput('{"skip":"true","question":"Q"}'), { skip: false, question: 'Q' });
  assert.deepEqual(parseConfirmCommandOutput('  {"skip":true}\n'), { skip: true });
  assert.equal(parseConfirmCommandOutput(''), undefined);
});

withWs('Stop: decision JSON larger than maxOutputBytes is still parsed (decision capture)', async (ws) => {
  const reason = 'r'.repeat(20000);
  fs.writeFileSync(path.join(ws.dir, 'big.json'), JSON.stringify({ decision: 'block', reason }));
  const runner = new HookRunner([v3Hook('Stop', `cat ${q(path.join(ws.dir, 'big.json'))}`)]);
  const r = await runner.runStop({ ...ctxFor(ws), hookDrivenContinuations: 0 });
  assert.equal(r.continueWith, reason);
});

withWs('Stop: warnings aggregated in definition order (confirmCommand failure first, slow)', async (ws) => {
  const runner = new HookRunner([
    v3Hook('Stop', 'true', { name: 'c', confirm: { question: 'Q?', options: [], confirmCommand: 'sleep 0.3; echo cc >&2; exit 3' } }),
    v3Hook('Stop', 'echo plain >&2; exit 4', { name: 'p' }),
  ]);
  const r = await runner.runStop({ ...ctxFor(ws), hookDrivenContinuations: 0 });
  assert.deepEqual(
    r.warnings.map((w) => w.hook),
    ['c', 'p'],
  );
  assert.match(r.warnings[0]!.message, /^✗ Stop "sleep 0\.3; echo cc >&2; exit 3" failed with exit code: 3, stderr: cc\)$/);
  assert.equal(r.confirm?.hook, 'c');
});

withWs('Stop confirm: the continuation cap also applies to a confirmed run', async (ws) => {
  const runner = new HookRunner([v3Hook('Stop', 'exit 1', { name: 'c', confirm: { question: 'Go?', options: [{ id: 'y', label: 'y', run: true }] } })]);
  const ctx = { ...ctxFor(ws), hookDrivenContinuations: 3 };
  await runner.runStop(ctx);
  const r = await runner.resolveStopConfirm(ctx, 'c', 'y');
  assert.equal(r.continueWith, undefined);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!.message, /consecutive hook-driven continuations/);
});

withWs('Stop: V3 exit 1 alongside a V3 block decision and an agent action (definition order)', async (ws) => {
  const runner = new HookRunner([
    v3Hook('Stop', { prompt: 'Agent says go.' }),
    v3Hook('Stop', 'sleep 0.2; exit 1'),
    v3Hook('Stop', `echo '{"decision":"block","reason":"Agent says go."}'`),
  ]);
  const r = await runner.runStop({ ...ctxFor(ws), hookDrivenContinuations: 0 });
  assert.equal(r.continueWith, `Agent says go.\n\n${DEFAULT_STOP_CONTINUE_TEXT}`);
});

// ───────────────────────────── env / stdin edge cases ─────────────────────────────

withWs('USER_PROMPT: NUL / control chars in the prompt never break spawning; unicode survives', async (ws) => {
  const f = path.join(ws.dir, 'p.json');
  const prompt = 'zéro\u0000one\u0007 ✓';
  const runner = new HookRunner([v3Hook('UserPromptSubmit', `cat > ${q(f)}; printf %s "$USER_PROMPT"`)]);
  const r = await runner.runUserPromptSubmit({ ...ctxFor(ws), prompt });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.outputs, ['zéroone ✓']);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).prompt, prompt, 'payload prompt is raw');
});

withWs('USER_PROMPT: byte-exact 4096 cap seen by the hook', async (ws) => {
  const runner = new HookRunner([v3Hook('UserPromptSubmit', 'printf %s "$USER_PROMPT" | wc -c | tr -d " \\n"')]);
  const r = await runner.runUserPromptSubmit({ ...ctxFor(ws), prompt: `${'é'.repeat(3000)}` }); // 6000 bytes
  assert.deepEqual(r.outputs, ['4096']);
});

withWs('USER_PROMPT inherited from the parent env does not leak into tool hooks', async (ws) => {
  const env = { ...ws.env, USER_PROMPT: 'stale' };
  const runner = new HookRunner([v2Hook('PreToolUse', 'printf %s "${USER_PROMPT-unset}" >&2; exit 2')]);
  const r = await runner.runPreToolUse({ ws: { ...ws, env }, sessionId: 's' }, mkCall('Read'));
  assert.equal(r.blockReason, 'unset');
});

withWs('a hook that ignores a huge stdin payload neither hangs nor fails', async (ws) => {
  const big = 'x'.repeat(2 * 1024 * 1024);
  const runner = new HookRunner([v2Hook('PreToolUse', 'printf ok')]);
  const t0 = Date.now();
  const r = await runner.runPreToolUse(ctxFor(ws), mkCall('Write', { file_path: '/ws/a', content: big }));
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(r, { blocked: false, warnings: [] });
});

withWs('stdin payload round-trips unicode exactly (V2 tool input)', async (ws) => {
  const f = path.join(ws.dir, 'in.json');
  const runner = new HookRunner([v2Hook('PreToolUse', `cat > ${q(f)}`)]);
  await runner.runPreToolUse(ctxFor(ws), mkCall('Bash', { command: 'echo "ünï ✓ 😀"', description: 'Ünï' }, ws.cwd));
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).tool_input, { command: 'echo "ünï ✓ 😀"', summary: 'Ünï' });
});

withWs('exit 0 output is stdout only, even with stderr noise; unicode output exact', async (ws) => {
  const runner = new HookRunner([v3Hook('SessionStart', "echo noise >&2; printf 'héllo ✓ 😀'")]);
  assert.deepEqual((await runner.runSessionStart(ctxFor(ws))).outputs, ['héllo ✓ 😀']);
});

// ───────────────────────────── error paths ─────────────────────────────

withWs('signal already aborted: nothing runs, no warnings, no block, no cache', async (ws) => {
  const marker = path.join(ws.dir, 'ran');
  const runner = new HookRunner([v3Hook('PreToolUse', `touch ${q(marker)}; exit 2`), v3Hook('SessionStart', `touch ${q(marker)}`)]);
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await runner.runPreToolUse(ctxFor(ws, { signal: ac.signal }), mkCall('Read')), { blocked: false, warnings: [] });
  assert.deepEqual(await runner.runSessionStart(ctxFor(ws, { signal: ac.signal })), { outputs: [], agentPrompts: [], warnings: [] });
  assert.equal(fs.existsSync(marker), false);
  // Not cached as a success: a later un-aborted run executes.
  await runner.runSessionStart(ctxFor(ws));
  assert.equal(fs.existsSync(marker), true);
});

withWs('missing shell program => Q spawn-error warning, never blocks', async (ws) => {
  const runner = new HookRunner([v3Hook('PreToolUse', 'exit 2')], { shell: path.join(ws.dir, 'no-such-shell') });
  const r = await runner.runPreToolUse(ctxFor(ws), mkCall('Read'));
  assert.equal(r.blocked, false);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!.message, /^✗ exit 2 failed after \d+\.\d\d s: failed to execute command: /);
});

withWs('PreToolUse: exit 2 with empty stderr still blocks (empty reason); stdout is not the reason', async (ws) => {
  const runner = new HookRunner([v3Hook('PreToolUse', 'echo on-stdout; exit 2')]);
  const r = await runner.runPreToolUse(ctxFor(ws), mkCall('Bash', { command: 'ls' }));
  assert.equal(r.blocked, true);
  assert.equal(r.blockReason, '');
});

withWs('SessionEnd: the cap bounds hooks with long configured timeouts too', async (ws) => {
  const runner = new HookRunner([v3Hook('SessionEnd', 'sleep 10', { timeoutMs: 60_000 })], { sessionEndCapMs: 250 });
  const t0 = Date.now();
  const r = await runner.runSessionEnd(ctxFor(ws));
  assert.ok(Date.now() - t0 < 3000);
  assert.match(r.warnings[0]!.message, /command timed out after 250 ms/);
});

withWs('UserPromptSubmit: aggregation follows definition order, not completion order', async (ws) => {
  const runner = new HookRunner([
    v3Hook('UserPromptSubmit', 'sleep 0.4; printf one'),
    v3Hook('UserPromptSubmit', 'sleep 0.2; printf two'),
    v3Hook('UserPromptSubmit', 'printf three'),
  ]);
  assert.deepEqual((await runner.runUserPromptSubmit({ ...ctxFor(ws), prompt: 'p' })).outputs, ['one', 'two', 'three']);
});

// ───────────────────────────── cache keys ─────────────────────────────

withWs('V2 PreToolUse ttl cache: identical call cached, different input re-runs, exit 2 never cached', async (ws) => {
  let now = 5_000;
  const ok = path.join(ws.dir, 'ok.count');
  const blk = path.join(ws.dir, 'blk.count');
  const runner = new HookRunner(
    [
      v2Hook('PreToolUse', `echo x >> ${q(ok)}`, { cacheTtlSec: 60, matcher: 'fs_read' }),
      v2Hook('PreToolUse', `echo x >> ${q(blk)}; echo no >&2; exit 2`, { cacheTtlSec: 60, matcher: 'shell' }),
    ],
    { now: () => now },
  );
  const a = mkCall('Read', { file_path: '/ws/a' });
  await runner.runPreToolUse(ctxFor(ws), a);
  await runner.runPreToolUse(ctxFor(ws), a);
  await runner.runPreToolUse(ctxFor(ws), mkCall('Read', { file_path: '/ws/b' }));
  assert.equal(lines(ok).length, 2);
  for (let i = 0; i < 3; i++) {
    const r = await runner.runPreToolUse(ctxFor(ws), mkCall('Bash', { command: 'rm x' }));
    assert.equal(r.blocked, true);
  }
  assert.equal(lines(blk).length, 3);
  now += 61_000;
  await runner.runPreToolUse(ctxFor(ws), a);
  assert.equal(lines(ok).length, 3);
});

// ───────────────────────────── file hooks ─────────────────────────────

withWs('file hooks: relative path resolved against the session cwd; legacy glob outside the workspace never fires', async (ws) => {
  const log = path.join(ws.dir, 'ran.log');
  const legacy = { ...v3Hook('PostFileSave', `echo {{filePath}} >> ${q(log)}`, { source: 'legacy-ide' }), filePatterns: ['**/*.ts'] } as KiroHook;
  const runner = new HookRunner([legacy]);
  const call = mkCall('Edit', {}, ws.cwd);
  await runner.runFileHook(ctxFor(ws), 'PostFileSave', 'x.ts', call);
  assert.deepEqual(lines(log), [path.join(ws.cwd, 'x.ts')]);
  await runner.runFileHook(ctxFor(ws), 'PostFileSave', path.join(ws.dir, 'outside.ts'), call);
  assert.deepEqual(lines(log), [path.join(ws.cwd, 'x.ts')]);
}, 'pkg');

// ───────────────────────────── matchers ─────────────────────────────

const WS: Pick<WorkspaceContext, 'cwd' | 'workspaceRoot'> = { cwd: '/ws', workspaceRoot: '/ws' };

test('legacy globs: outside-workspace files never match relative globs; absolute globs still do', () => {
  const rows: [string, string, boolean][] = [
    ['**/*.ts', '/tmp/x.ts', false],
    ['*.ts', '/tmp/x.ts', false],
    ['*.ts', '/wsx/a.ts', false], // sibling dir sharing the prefix
    ['**/*.ts', '/ws/a.ts', true],
    ['/tmp/*.ts', '/tmp/x.ts', true],
    ['/src/*.ts', '/ws/src/a.ts', true], // root-anchored (gitignore style)
    ['src\\*.ts', '/ws/src/a.ts', true], // Windows separators in the pattern
    ['./././src/*.ts', '/ws/src/a.ts', true],
    ['{src,lib}/**/*.ts', '/ws/lib/x/y.ts', true],
    ['{src,lib}/**/*.ts', '/ws/test/y.ts', false],
    ['*.TS', '/ws/a.ts', process.platform === 'win32'],
    ['*', '/ws/.env', true], // dot files match (glob crate require_literal_leading_dot=false)
    ['**/ünï/*.md', '/ws/docs/ünï/a.md', true],
    ['{', '/ws/{', true], // unbalanced braces: literal
  ];
  for (const [g, p, want] of rows) assert.equal(matchesFileHook(g, p, WS, 'glob'), want, `${g} vs ${p}`);
  assert.equal(matchesFileGlobs(['**/*.ts', ''], '/tmp/x.ts', WS), false);
});

test('V3 file regex: unaffected by the workspace guard (tested against the absolute path too)', () => {
  assert.equal(matchesFileHook('\\.ts$', '/tmp/x.ts', WS), true);
  assert.equal(matchesFileHook('^\\.\\./', '/tmp/x.ts', WS), true); // relative form of an outside path
  assert.equal(matchesFileHook('(?i)README', '/ws/readme.md', WS), true);
});

test('02 §7.4 migration vectors: converted V2 matchers select the intended Claude tools', () => {
  const calls = {
    Read: mkCall('Read'),
    Glob: mkCall('Glob'),
    Grep: mkCall('Grep'),
    Write: mkCall('Write'),
    Edit: mkCall('Edit'),
    NotebookEdit: mkCall('NotebookEdit'),
    Bash: mkCall('Bash'),
    WebFetch: mkCall('WebFetch'),
    WebSearch: mkCall('WebSearch'),
    Agent: mkCall('Agent', { subagent_type: 'x' }),
  };
  const table: [string, (keyof typeof calls)[]][] = [
    ['read', ['Read', 'Glob', 'Grep']],
    ['^(read_file|list_directory)$', ['Read']],
    ['grep_search', ['Grep']],
    ['file_search', ['Glob']],
    ['write', ['Write', 'Edit', 'NotebookEdit']],
    ['^(fs_write|fs_append|str_replace|delete_file)$', ['Write', 'Edit', 'NotebookEdit']],
    ['shell', ['Bash']],
    ['remote_web_search', ['WebSearch']],
    ['web', ['WebFetch', 'WebSearch']],
    ['subagent', ['Agent']],
    ['@builtin', ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Agent']],
  ];
  for (const [m, want] of table) {
    const got = (Object.keys(calls) as (keyof typeof calls)[]).filter((k) => matchesV3(m, calls[k]));
    assert.deepEqual(got, want, m);
  }
});

test('V2 matcher: whitespace and case are significant (Q exact/glob semantics)', () => {
  const w = mkCall('Write');
  assert.equal(matchesV2(' fs_write', w), false);
  assert.equal(matchesV2('FS_WRITE', w), false);
  assert.equal(matchesV2('Write', w), false);
  assert.equal(matchesV2('fs_w*', w), true);
  assert.equal(matchesV2('@builtin', mkCall('mcp__builtin__x')), true); // Q: names starting with @builtin are not MCP
  assert.equal(matchesV2('@*', mkCall('mcp__s__t')), true);
  assert.equal(matchesV2('*', mkCall('mcp__s__t')), true);
});

test('V3 matcher: unicode MCP names and case-insensitive @ selectors', () => {
  const call = mkCall('mcp__Dätä__Gét Thing');
  assert.equal(matchesV3('@mcp', call), true);
  assert.equal(matchesV3('@dätä', call), true);
  assert.equal(matchesV3('@DÄTÄ/gét thing', call), true);
  assert.equal(matchesV3('@Dätä/*', call), true);
  assert.equal(matchesV3('^mcp_dt_gt_thing$', call), true); // non-[A-Za-z0-9_] dropped in the V3 id
});

test('compileHookRegex: unsupported Rust constructs never throw', () => {
  for (const src of ['a(?i)b', '(?x) a b', '[[:alpha:]]+', '\\p{L}+', '(?<!x)y', 'a{2,', '\\']) {
    assert.doesNotThrow(() => compileHookRegex(src));
  }
  assert.ok(compileHookRegex('\\p{L}+')!.test('ü'));
});

// ───────────────────────────── payloads ─────────────────────────────

test('Read tool_input: zero / negative limit => end_line -1 (00 §4.4 `limit ? … : -1`)', () => {
  for (const limit of [0, -3]) {
    assert.deepEqual(toV2ToolInput(mkCall('Read', { file_path: '/a', offset: 5, limit })), {
      operations: [{ mode: 'Line', path: '/a', start_line: 5, end_line: -1 }],
    });
  }
  assert.deepEqual(toV2ToolInput(mkCall('Read', { file_path: '/a', limit: 1 })), {
    operations: [{ mode: 'Line', path: '/a', start_line: 1, end_line: 1 }],
  });
});

test('tool inputs tolerate missing / wrongly typed fields', () => {
  assert.deepEqual(toV2ToolInput(mkCall('Bash', {})), { command: '' });
  assert.deepEqual(toV2ToolInput(mkCall('Bash', { command: 5, description: null })), { command: '' });
  assert.deepEqual(toV3ToolInput(mkCall('Write', { file_path: '' })), { path: '', content: '' });
  assert.deepEqual(toV2ToolInput(mkCall('Read', { file_path: '/a', offset: 'x', limit: Number.NaN })), {
    operations: [{ mode: 'Line', path: '/a', start_line: 1, end_line: -1 }],
  });
  assert.deepEqual(toV3ToolInput(mkCall('Agent', { subagent_type: '' })), { agent_name: 'general-purpose', task: '' });
  assert.deepEqual(toV2ToolInput(mkCall('MultiEdit', { file_path: '/a', edits: [] })), { command: 'str_replace', path: '/a', old_str: '', new_str: '' });
});

test('tool_response: error text wins over response on failure; Bash object without fields', () => {
  assert.deepEqual(toKiroToolResponse(mkCall('Bash'), { success: false, error: 'E', response: 'R' }), {
    success: false,
    error: ['An error occurred processing the tool: \nE'],
  });
  assert.deepEqual(toKiroToolResponse(mkCall('Bash'), { success: true, response: {} }), { success: true, result: [{ exit_status: '0', stdout: '', stderr: '' }] });
  assert.deepEqual(toKiroToolResponse(mkCall('Read'), { success: true, response: { file: { content: 5 } } }), {
    success: true,
    result: ['{"file":{"content":5}}'],
  });
  const circ: Record<string, unknown> = {};
  circ.self = circ;
  assert.doesNotThrow(() => toKiroToolResponse(mkCall('Write'), { success: true, response: circ }));
});

test('V3 payload never carries prompt outside UserPromptSubmit; V2 never carries session_id', () => {
  const ws: WorkspaceContext = { cwd: '/w', workspaceRoot: '/w', kiroHome: '/h', home: '/h', env: {} };
  for (const trigger of ['SessionStart', 'Stop', 'SessionEnd', 'PreToolUse'] as const) {
    const p = buildPayload(v3Hook(trigger, 'x'), { trigger, ws, sessionId: 's', prompt: 'p', ...(trigger === 'PreToolUse' ? { call: mkCall('Read') } : {}) });
    assert.equal('prompt' in p, false, trigger);
    assert.equal(p.session_id, 's');
  }
  for (const trigger of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const) {
    const p = buildPayload(v2Hook(trigger, 'x'), { trigger, ws, sessionId: 's', ...(trigger.endsWith('ToolUse') ? { call: mkCall('Read') } : {}) });
    assert.equal('session_id' in p, false, trigger);
  }
});
