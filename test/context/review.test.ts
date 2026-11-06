/**
 * Adversarial review tests for src/context/** (plus a few models/ and session/store checks):
 * boundary conditions, unicode, ordering, symlinks, error paths and the research test vectors
 * (06 §3.7 / §4.3–4.5, 03 §3–4, 01 §4.4, 00 §3.13 / §6 / §7) not covered by the module tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CONTEXT_ENTRY_BEGIN,
  CONTEXT_ENTRY_END,
  buildSystemPrompt,
  formatContextEntries,
  formatHookContext,
  formatSteeringIndexEntry,
  orderSteering,
  systemPromptFilePath,
  type SystemPromptInput,
} from '../../src/context/systemPrompt.js';
import {
  MAX_FILE_REF_BYTES,
  MAX_IMAGE_BYTES,
  base64Length,
  codeRanges,
  errorMessage,
  errorText,
  expandAtRefs,
  expandHashRefs,
  findSteering,
  readTextForRef,
  renderDirTree,
} from '../../src/context/refs.js';
import {
  SteeringActivator,
  composeUserTurn,
  composeUserTurnText,
  fileMatchMatches,
  formatSteeringBlock,
  type ComposeUserTurnInput,
} from '../../src/context/userTurn.js';
import { contextFilesLimit, estimateTokens, estimateTokensFromBytes, selectWithinLimit } from '../../src/context/tokens.js';
import { buildModelList, claudeToKiroModelId, formatModelList, kiroToClaudeModel } from '../../src/models/models.js';
import { SessionStore, previewText } from '../../src/session/store.js';
import type { ModelInfo } from '../../src/claude/protocol.js';
import type { SteeringFile } from '../../src/types.js';
import { agent, steering, tmpWorkspace, write } from './helpers.js';

const HOOK_INTRO =
  'This section (like others) contains important information that I want you to use in your responses. ' +
  'I have gathered this context from valuable programmatic script hooks. ' +
  'You must follow any requests and consider all of the information in this section';

function spInput(over: Partial<SystemPromptInput> & Pick<SystemPromptInput, 'ws'>): SystemPromptInput {
  return {
    agent: agent(),
    steering: [],
    resourceFiles: [],
    sessionContext: [],
    agentsMd: [],
    agentSpawnOutputs: [],
    contextWindowTokens: 200_000,
    preamble: '',
    ...over,
  };
}

// ───────────────────────────── tokens (06 §4.3) ─────────────────────────────

describe('review: tokens', () => {
  const vectors: [number, number][] = [
    [0, 0], [3, 0], [19, 0], [20, 10], [59, 10], [60, 20], [99, 20], [100, 30], [4000, 1000], [4019, 1000], [4020, 1010],
  ];
  for (const [bytes, want] of vectors) {
    it(`${bytes} bytes -> ${want} tokens (round10(bytes/4))`, () => {
      assert.equal(estimateTokensFromBytes(bytes), want);
      assert.equal(estimateTokens('x'.repeat(bytes)), want);
    });
  }
  it('emoji are 4 UTF-8 bytes; CJK 3 bytes', () => {
    assert.equal(estimateTokens('😀'.repeat(20)), 20); // 80 bytes -> 20
    assert.equal(estimateTokens('漢'.repeat(20)), 20); // 60 bytes -> 15 -> 20
    assert.equal(estimateTokens('é'.repeat(10)), 10); // 20 bytes
  });
  it('limit: 75% of the window, integer; bogus windows fall back to 200 000', () => {
    assert.equal(contextFilesLimit(1_000_000), 750_000);
    assert.equal(contextFilesLimit(401), 300);
    assert.equal(contextFilesLimit(1), 0);
    for (const w of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(contextFilesLimit(w), 150_000);
  });
  it('ties are evaluated in UTF-8 byte order, not UTF-16 order', () => {
    // U+FF5E (EF BD BE) sorts before U+1F600 (F0 9F 98 80) in bytes; UTF-16 says the opposite.
    const r = selectWithinLimit(
      [
        { path: '/😀', tokens: 10 },
        { path: '/～', tokens: 10 },
      ],
      10,
    );
    assert.deepEqual(r.kept.map((x) => x.path), ['/～']);
    assert.deepEqual(r.dropped.map((x) => x.path), ['/😀']);
  });
  it('the greedy fit keeps a later small file after skipping a big one and does not mutate the input', () => {
    const items = [
      { path: '/a', tokens: 50 },
      { path: '/b', tokens: 40 },
      { path: '/c', tokens: 30 },
      { path: '/d', tokens: 10 },
    ];
    const copy = items.map((x) => ({ ...x }));
    const r = selectWithinLimit(items, 65);
    assert.deepEqual(r.kept.map((x) => x.path), ['/a', '/d']);
    assert.deepEqual(r.dropped.map((x) => x.path), ['/b', '/c']);
    assert.equal(r.total, 60);
    assert.deepEqual(items, copy);
  });
});

// ───────────────────────────── system prompt (00 §6.1) ─────────────────────────────

describe('review: Q wrappers and index entries (exact strings)', () => {
  it('formatHookContext keeps empty outputs as blank blocks (06 §3.7)', () => {
    assert.equal(
      formatHookContext(['A', '', 'B'], true),
      `--- CONTEXT ENTRY BEGIN ---\n${HOOK_INTRO} for the entire conversation\n\nA\n\n\n\nB\n\n--- CONTEXT ENTRY END ---\n\n`,
    );
    assert.equal(formatHookContext([], true), undefined);
    assert.equal(formatHookContext([''], false), undefined);
  });
  it('formatContextEntries keeps content verbatim (no trimming of trailing newlines)', () => {
    assert.equal(
      formatContextEntries([
        { path: '/a', content: 'x\n' },
        { path: '/b', content: '' },
      ]),
      `${CONTEXT_ENTRY_BEGIN}\n[/a]\nx\n\n[/b]\n\n${CONTEXT_ENTRY_END}\n\n`,
    );
    assert.equal(formatContextEntries([]), '');
  });
  it('index entries per mode (03 §3, verbatim condition sentences)', () => {
    const manual = steering({ path: '/w/.kiro/steering/api.md', name: 'api', inclusion: 'manual' });
    assert.equal(
      formatSteeringIndexEntry(manual),
      'CONDITIONAL GUIDE, NOT ACTIVE INSTRUCTIONS. Only when the user explicitly requests #api or this guide.\n' +
        'Read /w/.kiro/steering/api.md with the file tool when that condition holds, then apply its full current contents.\n' +
        'Description:',
    );
    const fm = steering({ path: '/w/r.md', name: 'r', inclusion: 'fileMatch', fileMatchPatterns: [], description: 'React\n  rules' });
    assert.equal(
      formatSteeringIndexEntry(fm),
      'CONDITIONAL GUIDE, NOT ACTIVE INSTRUCTIONS. Only before working on a file matching fileMatchPattern; an empty pattern never matches.\n' +
        'Read /w/r.md with the file tool when that condition holds, then apply its full current contents.\n' +
        'Description: React rules\n' +
        'fileMatchPattern:',
    );
    const auto = steering({ path: '/w/db.md', name: 'db', inclusion: 'auto', description: 'Database work' });
    assert.equal(
      formatSteeringIndexEntry(auto),
      'CONDITIONAL GUIDE, NOT ACTIVE INSTRUCTIONS. Only when the description is relevant to the current task; an empty description requires an explicit request.\n' +
        'Read /w/db.md with the file tool when that condition holds, then apply its full current contents.\n' +
        'Description: Database work',
    );
  });
});

describe('review: buildSystemPrompt edge cases', () => {
  it('interleaved scopes come out global → legacy → workspace, stable within a scope', () => {
    const files = [
      steering({ path: '/w1', name: 'w1', scope: 'workspace' }),
      steering({ path: '/l1', name: 'l1', scope: 'legacy' }),
      steering({ path: '/g1', name: 'g1', scope: 'global' }),
      steering({ path: '/w2', name: 'w2', scope: 'workspace' }),
      steering({ path: '/g2', name: 'g2', scope: 'global' }),
    ];
    assert.deepEqual(orderSteering(files).map((f) => f.name), ['g1', 'g2', 'l1', 'w1', 'w2']);
    const ws = tmpWorkspace();
    const r = buildSystemPrompt(spInput({ ws, steering: files.map((f) => ({ ...f, body: f.name })) }));
    assert.deepEqual(r.included.map((f) => f.path), ['/g1', '/g2', '/l1', '/w1', '/w2']);
  });

  it('one index entry per conditional file even when it is listed twice or through a symlink', () => {
    const ws = tmpWorkspace();
    const real = write(path.join(ws.cwd, '.kiro', 'steering', 'api.md'), 'x');
    const link = path.join(ws.cwd, 'api-link.md');
    fs.symlinkSync(real, link);
    const a = steering({ path: real, name: 'api', inclusion: 'manual' });
    const b = steering({ path: link, name: 'api-link', inclusion: 'manual' });
    const r = buildSystemPrompt(spInput({ ws, steering: [a, a, b] }));
    assert.equal(r.text.split('CONDITIONAL GUIDE').length - 1, 1);
    assert.deepEqual(r.conditionalSteering, [a]);
  });

  it('an AGENTS.md symlinked to an always-steering file is included once (steering wins)', () => {
    const ws = tmpWorkspace();
    const s = write(path.join(ws.cwd, '.kiro', 'steering', 'rules.md'), 'Rules');
    const agentsMd = path.join(ws.cwd, 'AGENTS.md');
    fs.symlinkSync(s, agentsMd);
    const res = path.join(ws.cwd, 'res.md');
    fs.symlinkSync(s, res);
    const r = buildSystemPrompt(
      spInput({
        ws,
        steering: [steering({ path: s, name: 'rules', body: 'Rules' })],
        agentsMd: [agentsMd],
        resourceFiles: [{ pattern: 'res.md', paths: [res] }],
        sessionContext: [{ pattern: 'rules', paths: [s] }],
      }),
    );
    assert.deepEqual(r.included.map((f) => [f.path, f.origin]), [[s, 'steering']]);
    assert.equal(r.text.split('Rules').length - 1, 1);
  });

  it('cap boundary: total == limit fits, one more file is dropped', () => {
    const ws = tmpWorkspace();
    // window 400 -> limit 300; 1219 bytes -> 300 tokens (304+5)/10*10; 40 bytes -> 10 tokens
    const big = write(path.join(ws.cwd, 'big.txt'), 'b'.repeat(1219));
    const small = write(path.join(ws.cwd, 'small.txt'), 's'.repeat(40));
    const r = buildSystemPrompt(spInput({ ws, contextWindowTokens: 400, resourceFiles: [{ pattern: '*', paths: [small, big] }] }));
    assert.deepEqual(r.included.map((f) => [path.basename(f.path), f.tokens]), [['big.txt', 300]]);
    assert.deepEqual(r.dropped, [small]);
    // 1220 bytes -> 310 tokens > 300: oversize, dropped, the small one now fits
    fs.writeFileSync(big, 'b'.repeat(1220));
    const r2 = buildSystemPrompt(spInput({ ws, contextWindowTokens: 400, resourceFiles: [{ pattern: '*', paths: [small, big] }] }));
    assert.deepEqual(r2.included.map((f) => path.basename(f.path)), ['small.txt']);
    assert.deepEqual(r2.dropped, [big]);
  });

  it('a resource file keeps its BOM and CRLF (Q reads files verbatim)', () => {
    const ws = tmpWorkspace();
    const f = write(path.join(ws.cwd, 'bom.txt'), Buffer.from('﻿a\r\nb', 'utf8'));
    const r = buildSystemPrompt(spInput({ ws, resourceFiles: [{ pattern: 'bom.txt', paths: [f] }] }));
    assert.ok(r.text.includes(`[${f}]\n﻿a\r\nb\n`));
    assert.equal(r.included[0]!.tokens, estimateTokensFromBytes(fs.statSync(f).size));
  });

  it('steering tokens are counted after #[[file:]] expansion', () => {
    const ws = tmpWorkspace();
    const r = buildSystemPrompt(
      spInput({
        ws,
        steering: [steering({ path: '/s.md', name: 's', body: 'short' })],
        expandRefs: () => 'x'.repeat(400),
      }),
    );
    assert.equal(r.included[0]!.tokens, 100);
  });

  it('expandRefs throwing a non-Error value is reported, not rethrown', () => {
    const ws = tmpWorkspace();
    const r = buildSystemPrompt(
      spInput({
        ws,
        steering: [steering({ path: '/s.md', name: 's', body: 'raw body' })],
        expandRefs: () => {
          throw 'plain string'; // eslint-disable-line no-throw-literal
        },
      }),
    );
    assert.ok(r.text.includes('raw body'));
    assert.deepEqual(r.warnings, ['Steering file /s.md: plain string']);
  });

  it('whitespace-only prompt and preamble are omitted; nothing at all gives an empty text', () => {
    const ws = tmpWorkspace();
    const r = buildSystemPrompt(spInput({ ws, agent: agent({ prompt: ' \n\t' }), preamble: '  \n ' }));
    assert.equal(r.text, '');
    assert.equal(r.totalTokens, 0);
  });

  it('prompt trailing newlines collapse to exactly one final newline; inner text verbatim', () => {
    const ws = tmpWorkspace();
    const r = buildSystemPrompt(spInput({ ws, agent: agent({ prompt: '  Be terse.\n\nReally.\n\n\n' }) }));
    assert.equal(r.text, 'Follow this instruction:   Be terse.\n\nReally.\n');
  });

  it('section separators: index entries and hook block are each followed by one blank line', () => {
    const ws = tmpWorkspace();
    const m = steering({ path: '/m.md', name: 'm', inclusion: 'manual' });
    const r = buildSystemPrompt(spInput({ ws, steering: [m], agentSpawnOutputs: ['out'], preamble: 'P', agent: agent({ prompt: 'X' }) }));
    assert.equal(
      r.text,
      `${formatSteeringIndexEntry(m)}\n\n${formatHookContext(['out'], true)}P\n\nFollow this instruction: X\n`,
    );
  });

  it('a directory or FIFO listed as a context path is skipped with a warning (never blocks)', () => {
    const ws = tmpWorkspace();
    const dir = path.join(ws.cwd, 'adir');
    fs.mkdirSync(dir);
    const r = buildSystemPrompt(spInput({ ws, sessionContext: [{ pattern: 'adir', paths: [dir] }] }));
    assert.deepEqual(r.included, []);
    assert.deepEqual(r.warnings, [`Skipping context file ${dir}: not a regular file`]);
  });

  it('systemPromptFilePath rejects ids that could escape the runtime dir', () => {
    const env = { XDG_RUNTIME_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'kc-rt-')) };
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a..b', ' x']) {
      assert.throws(() => systemPromptFilePath(bad, env), /Invalid session id/, bad);
    }
    assert.ok(systemPromptFilePath('3f1c9a2e-0000-4000-8000-000000000000', env).endsWith(path.join('3f1c9a2e-0000-4000-8000-000000000000', 'context.md')));
  });
});

// ───────────────────────────── @ references (01 §4.4) ─────────────────────────────

describe('review: expandAtRefs', () => {
  it('a 250KB file is not truncated; 250KB + 1 byte is, with the exact Kiro warning', () => {
    const ws = tmpWorkspace();
    write(path.join(ws.cwd, 'exact.txt'), 'a'.repeat(MAX_FILE_REF_BYTES));
    write(path.join(ws.cwd, 'over.txt'), 'a'.repeat(MAX_FILE_REF_BYTES + 1));
    const ok = expandAtRefs('@exact.txt', { cwd: ws.cwd });
    assert.deepEqual(ok.warnings, []);
    assert.ok(!ok.blocks[0]!.includes('[truncated'));
    const over = expandAtRefs('@over.txt', { cwd: ws.cwd });
    assert.deepEqual(over.warnings, ["⚠ File 'over.txt' was truncated (exceeds 250KB limit)"]);
    assert.ok(over.blocks[0]!.includes('[truncated: file exceeds 250KB limit]'));
  });

  it('reads files whose stat size is 0 (procfs) instead of inlining nothing', { skip: !fs.existsSync('/proc/self/status') }, () => {
    const r = readTextForRef('/proc/self/status');
    assert.ok(r.content && r.content.includes('Name:'), JSON.stringify(r));
    assert.equal(r.truncated, false);
  });

  it('readTextForRef truncates on a character boundary for any maxBytes', () => {
    const ws = tmpWorkspace();
    const p = write(path.join(ws.cwd, 'u.txt'), '😀😀😀'); // 12 bytes
    for (let max = 0; max <= 12; max++) {
      const r = readTextForRef(p, max);
      assert.equal(r.content, '😀'.repeat(Math.floor(max / 4)), `max=${max}`);
      assert.equal(r.truncated, max < 12);
    }
  });

  it('invalid UTF-8 and NUL bytes are binary (exact warning); NUL beyond 8 KB is still text', () => {
    const ws = tmpWorkspace();
    write(path.join(ws.cwd, 'bad.txt'), Buffer.from([0x61, 0xc3, 0x28]));
    write(path.join(ws.cwd, 'late-nul.txt'), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]));
    const r = expandAtRefs('@bad.txt @late-nul.txt', { cwd: ws.cwd });
    assert.deepEqual(r.warnings, ["⚠ File 'bad.txt' is a binary file and was not included"]);
    assert.equal(r.blocks.length, 1);
  });

  it('the same file referenced three ways yields one block', () => {
    const ws = tmpWorkspace();
    const p = write(path.join(ws.cwd, 'a.ts'), 'A');
    const r = expandAtRefs(`@a.ts @./a.ts @${p} @"a.ts"`, { cwd: ws.cwd });
    assert.equal(r.blocks.length, 1);
  });

  it('refs in double-backtick spans and ~~~ fences are ignored; CRLF and tabs separate tokens', () => {
    const ws = tmpWorkspace();
    write(path.join(ws.cwd, 'a.ts'), 'A');
    assert.equal(expandAtRefs('``x ` @a.ts``', { cwd: ws.cwd }).blocks.length, 0);
    assert.equal(expandAtRefs('~~~\n@a.ts\n~~~', { cwd: ws.cwd }).blocks.length, 0);
    assert.equal(expandAtRefs('see\r\n@a.ts\r\n', { cwd: ws.cwd }).blocks.length, 1);
    assert.equal(expandAtRefs('see\t@a.ts', { cwd: ws.cwd }).blocks.length, 1);
    const ranges = codeRanges('a `b` c\n```\nd\n```\n');
    assert.deepEqual(ranges, [
      [2, 5],
      [8, 18],
    ]);
  });

  it('a symlink to a file is inlined under the link path; a FIFO is left alone', () => {
    const ws = tmpWorkspace();
    const target = write(path.join(ws.cwd, 'real.txt'), 'REAL');
    fs.symlinkSync(target, path.join(ws.cwd, 'link.txt'));
    const r = expandAtRefs('@link.txt', { cwd: ws.cwd });
    assert.equal(r.blocks.length, 1);
    assert.ok(r.blocks[0]!.startsWith(`<file path="${path.join(ws.cwd, 'link.txt')}">`));
    assert.ok(r.blocks[0]!.includes('REAL'));
  });

  it('file block escapes the path attribute and picks a fence longer than any backtick run', () => {
    const ws = tmpWorkspace();
    write(path.join(ws.cwd, 'q"&<.md'), 'x ```` y');
    const r = expandAtRefs('@\'q"&<.md\'', { cwd: ws.cwd });
    assert.equal(r.blocks[0], `<file path="${path.join(ws.cwd, 'q&quot;&amp;&lt;.md')}">\n\`\`\`\`\`markdown\nx \`\`\`\` y\n\`\`\`\`\`\n</file>`);
  });

  it('prompt names: case-insensitive, ≤ 50 chars, only at the start, args shlex-split', () => {
    const prompts = [{ name: 'Review', path: '/p/Review.md', scope: 'workspace' as const, body: '' }];
    const ws = tmpWorkspace();
    assert.deepEqual(expandAtRefs('\n  @review "a b" c', { cwd: ws.cwd, prompts }).promptExpansion, { name: 'Review', args: ['a b', 'c'] });
    assert.equal(expandAtRefs('@review-x', { cwd: ws.cwd, prompts }).promptExpansion, undefined);
    assert.equal(expandAtRefs('@review:', { cwd: ws.cwd, prompts }).promptExpansion, undefined);
    assert.equal(expandAtRefs('please @review', { cwd: ws.cwd, prompts }).promptExpansion, undefined);
    const long = 'x'.repeat(51);
    assert.equal(expandAtRefs(`@${long}`, { cwd: ws.cwd, prompts: [{ ...prompts[0]!, name: long }] }).promptExpansion, undefined);
    assert.deepEqual(expandAtRefs(`@${long.slice(1)}`, { cwd: ws.cwd, prompts: [{ ...prompts[0]!, name: long.slice(1) }] }).promptExpansion?.args, []);
  });

  it('images: base64Length vectors and the encoded-size boundary', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(base64Length), [0, 4, 4, 4, 8, 8, 8]);
    const ws = tmpWorkspace();
    const maxRaw = (MAX_IMAGE_BYTES / 4) * 3; // encodes to exactly MAX_IMAGE_BYTES
    write(path.join(ws.cwd, 'ok.png'), Buffer.alloc(maxRaw, 1));
    write(path.join(ws.cwd, 'big.png'), Buffer.alloc(maxRaw + 1, 1));
    const r = expandAtRefs('@ok.png @big.png', { cwd: ws.cwd });
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0]!.dataBase64.length, MAX_IMAGE_BYTES);
    assert.deepEqual(r.warnings, ["⚠ Image 'big.png' was not attached (exceeds the 5MB image limit once encoded)"]);
    assert.equal(r.blocks.length, 0);
  });

  it('image extensions are case-insensitive; .svg / .bmp are text or binary files, not images', () => {
    const ws = tmpWorkspace();
    write(path.join(ws.cwd, 'A.PNG'), Buffer.from([0x89, 0x50]));
    write(path.join(ws.cwd, 'x.svg'), '<svg/>');
    const r = expandAtRefs('@A.PNG @x.svg', { cwd: ws.cwd });
    assert.deepEqual(r.images.map((i) => i.mediaType), ['image/png']);
    assert.equal(r.blocks.length, 1);
  });

  it('drag-and-drop: names with a literal backslash work; text around the path disables it', () => {
    const ws = tmpWorkspace();
    const p = write(path.join(ws.cwd, 'back\\slash.png'), Buffer.from([1, 2, 3]));
    assert.equal(expandAtRefs(p, { cwd: ws.cwd }).images.length, 1);
    assert.equal(expandAtRefs(`${p}   `, { cwd: ws.cwd }).images.length, 1);
    assert.equal(expandAtRefs(`${p} please`, { cwd: ws.cwd }).images.length, 0);
    assert.equal(expandAtRefs(`${p}\n${p}`, { cwd: ws.cwd }).images.length, 0);
  });

  it('never throws on empty or degenerate input', () => {
    const ws = tmpWorkspace();
    for (const t of ['', '@', '@@', '@"', "@'", '@ ', '``', '```', '"@x"', '@\u0000']) {
      const r = expandAtRefs(t, { cwd: ws.cwd });
      assert.equal(r.text, t);
      assert.deepEqual(r.blocks, []);
    }
  });
});

describe('review: directory trees', () => {
  it('names are in UTF-8 byte order (uppercase before lowercase, U+FF5E before emoji)', () => {
    const ws = tmpWorkspace();
    const d = path.join(ws.cwd, 't');
    for (const n of ['b', 'B', '😀', '～', 'é', 'a']) write(path.join(d, n), '');
    assert.equal(renderDirTree(d, 't'), ['t/', '├── B', '├── a', '├── b', '├── é', '├── ～', '└── 😀'].join('\n'));
  });
  it('empty directory: label only; ignored names are skipped at every depth; symlinked dirs are not followed', () => {
    const ws = tmpWorkspace();
    const d = path.join(ws.cwd, 'e');
    fs.mkdirSync(d);
    assert.equal(renderDirTree(d, 'e/'), 'e/');
    write(path.join(d, 'pkg', 'build', 'x.js'), '');
    write(path.join(d, 'pkg', 'src', 'i.ts'), '');
    fs.symlinkSync(path.join(d, 'pkg'), path.join(d, 'zlink'));
    assert.equal(renderDirTree(d, 'e'), ['e/', '├── pkg/', '│   └── src/', '│       └── i.ts', '└── zlink'].join('\n'));
  });
  it('exactly 10 entries: no more-items line; 11: one hidden', () => {
    const ws = tmpWorkspace();
    const d = path.join(ws.cwd, 'ten');
    for (let i = 0; i < 10; i++) write(path.join(d, `f${i}`), '');
    const t = renderDirTree(d, 'ten');
    assert.ok(!t.includes('more items'));
    assert.ok(t.endsWith('└── f9'));
    write(path.join(d, 'f9z'), '');
    assert.ok(renderDirTree(d, 'ten').endsWith('├── f9\n└── ... (1 more items)'));
  });
});

// ───────────────────────────── # providers (03 §4) ─────────────────────────────

describe('review: expandHashRefs', () => {
  function setup() {
    const ws = tmpWorkspace();
    const sdir = path.join(ws.cwd, '.kiro', 'steering');
    const files: SteeringFile[] = [
      steering({ path: path.join(sdir, 'api.md'), name: 'api', inclusion: 'manual', body: 'API' }),
      steering({ path: path.join(sdir, 'guide.md'), name: 'Auto Guide', inclusion: 'auto', description: 'd', body: 'G' }),
      steering({ path: path.join(sdir, 'react.md'), name: 'react', inclusion: 'fileMatch', fileMatchPatterns: ['*.tsx'], body: 'R' }),
      steering({ path: path.join(sdir, 'product.md'), name: 'product', inclusion: 'always', body: 'P' }),
    ];
    return { ws, files };
  }

  it('#Steering: is case-insensitive; quoted names; paths; always files are silently skipped', async () => {
    const { ws, files } = setup();
    const r = await expandHashRefs('#Steering:API #steering:"Auto Guide" #steering:.kiro/steering/react.md #steering:product', {
      ws,
      steering: files,
    });
    assert.deepEqual(r.steeringNames, ['api', 'Auto Guide', 'react']);
    assert.deepEqual(r.notices, []);
  });

  it('bare #<stem> finds an auto file whose front-matter name differs; fileMatch files need #steering:', async () => {
    const { ws, files } = setup();
    const r = await expandHashRefs('#guide #react', { ws, steering: files });
    assert.deepEqual(r.steeringNames, ['Auto Guide']);
  });

  it('precedence: steering > spec > file; spec > file of the same name', async () => {
    const { ws, files } = setup();
    write(path.join(ws.cwd, '.kiro', 'specs', 'api', 'tasks.md'), '- [ ] 1. t');
    write(path.join(ws.cwd, '.kiro', 'specs', 'feat', 'design.md'), '# D');
    write(path.join(ws.cwd, 'feat'), 'file named feat');
    const r = await expandHashRefs('#api #feat', { ws, steering: files });
    assert.deepEqual(r.steeringNames, ['api']);
    assert.equal(r.blocks.length, 1);
    assert.ok(r.blocks[0]!.startsWith('<spec name="feat"'));
    assert.ok(!r.blocks[0]!.includes('file named feat'));
  });

  it('#spec: errors: traversal, empty spec dir, repeated reference', async () => {
    const { ws } = setup();
    fs.mkdirSync(path.join(ws.cwd, '.kiro', 'specs', 'empty'), { recursive: true });
    write(path.join(ws.cwd, '.kiro', 'specs', 'x', 'requirements.md'), 'R');
    const specsDir = path.join(ws.cwd, '.kiro', 'specs');
    const r = await expandHashRefs('#spec:../x #spec:empty #spec:x #spec:X.', { ws, steering: [] });
    assert.deepEqual(r.notices, [
      `Spec '../x' not found in ${specsDir}`,
      "Spec 'empty' has no requirements, design or tasks documents",
    ]);
    assert.equal(r.blocks.length, 1);
  });

  it('#git diff runs once per message, any spelling; never inside code; exact command order', async () => {
    const { ws } = setup();
    const calls: string[][] = [];
    const runGit = async (args: string[]): Promise<string> => {
      calls.push(args);
      return args[0] === 'status' ? ' M a.ts\n' : 'diff --git a/a.ts b/a.ts\n';
    };
    const r = await expandHashRefs('#git diff #Git Diff #gitdiff #git-diff `#git diff`', { ws, steering: [], runGit });
    assert.deepEqual(calls, [
      ['status', '--short'],
      ['diff', 'HEAD'],
    ]);
    assert.deepEqual(r.blocks, ['<git_diff>\n$ git status --short\n M a.ts\n\n$ git diff HEAD\ndiff --git a/a.ts b/a.ts\n</git_diff>']);
  });

  it('#git diff: a runner rejecting with a non-Error value gives a notice instead of throwing', async () => {
    const { ws } = setup();
    const r1 = await expandHashRefs('#git diff', { ws, steering: [], runGit: () => Promise.reject('boom\nmore') });
    assert.deepEqual(r1.notices, ['#git diff: boom']);
    const r2 = await expandHashRefs('#git diff', { ws, steering: [], runGit: () => Promise.reject(undefined) });
    assert.deepEqual(r2.notices, ['#git diff: undefined']);
    const r3 = await expandHashRefs('#git diff', {
      ws,
      steering: [],
      runGit: (a) => (a[0] === 'status' ? Promise.resolve('') : Promise.reject(new Error(''))),
    });
    assert.deepEqual(r3.notices, ['#git diff: git diff failed']);
    const r4 = await expandHashRefs('#git diff', {
      ws,
      steering: [],
      runGit: () => {
        throw new Error('sync failure');
      },
    });
    assert.deepEqual(r4.notices, ['#git diff: sync failure']);
  });

  it('#git diff: whitespace-only output is "(no changes)"', async () => {
    const { ws } = setup();
    const r = await expandHashRefs('#git diff', { ws, steering: [], runGit: async () => ' \n\n' });
    assert.deepEqual(r.blocks, ['<git_diff>\n(no changes)\n</git_diff>']);
  });

  it('#code: uses a fence longer than the snippet; dedupes identical snippets; refs inside are not expanded', async () => {
    const { ws } = setup();
    write(path.join(ws.cwd, 'a.ts'), 'A');
    const r = await expandHashRefs('#code:x ``` #a.ts', { ws, steering: [] });
    assert.deepEqual(r.blocks, ['````\nx ``` #a.ts\n````']);
    const r2 = await expandHashRefs('#code: let a = 1; \n#code:let a = 1;', { ws, steering: [] });
    assert.deepEqual(r2.blocks, ['```\nlet a = 1;\n```']);
  });

  it('#url: strips trailing punctuation; quoted urls verbatim; hints are deduped', async () => {
    const { ws } = setup();
    const r = await expandHashRefs('(see #url:https://a.b/c). #url:https://a.b/c, #url:"https://a.b/c)." #mcp:git #mcp:git #codebase #codebase', {
      ws,
      steering: [],
    });
    assert.deepEqual(r.blocks, [
      'Fetch https://a.b/c with the web_fetch tool (WebFetch) and use its content when answering.',
      'Fetch https://a.b/c). with the web_fetch tool (WebFetch) and use its content when answering.',
      'Use tools from MCP server git.',
      'Search the codebase (Grep/Glob) to find the relevant files before answering.',
    ]);
  });

  it('#file: / #folder: type mismatches and missing paths give notices; bare missing names stay text', async () => {
    const { ws } = setup();
    write(path.join(ws.cwd, 'a.ts'), 'A');
    fs.mkdirSync(path.join(ws.cwd, 'lib'));
    const r = await expandHashRefs('#folder:a.ts #file:lib #file:nope #nope #123 #fff', { ws, steering: [] });
    assert.deepEqual(r.notices, ["#folder: 'a.ts' not found", "#file: 'lib' not found", "#file: 'nope' not found"]);
    assert.deepEqual(r.blocks, []);
  });

  it('headings, "# ", shebangs and mid-word # are not references; # at any line start is', async () => {
    const { ws } = setup();
    write(path.join(ws.cwd, 'a.ts'), 'A');
    const r = await expandHashRefs('# a.ts\n###### a.ts\n#!/bin/sh\nx#a.ts\nok\n#a.ts', { ws, steering: [] });
    assert.equal(r.blocks.length, 1);
    assert.ok(r.blocks[0]!.includes('<file path='));
  });

  it('findSteering: .md suffix in any case, basename, relative path', () => {
    const { ws, files } = setup();
    assert.equal(findSteering(files, 'API.MD')?.name, 'api');
    assert.equal(findSteering(files, 'guide')?.name, 'Auto Guide');
    assert.equal(findSteering(files, '.kiro/steering/react.md', ws.cwd)?.name, 'react');
    assert.equal(findSteering(files, 'missing'), undefined);
  });

  it('errorText / errorMessage never throw', () => {
    assert.equal(errorText(Object.assign(new Error('m'), { code: 'ENOENT' })), 'ENOENT');
    assert.equal(errorText(new Error('m')), 'm');
    assert.equal(errorMessage('s'), 's');
    assert.equal(errorMessage(null), 'null');
    assert.equal(errorMessage({ message: 'obj' }), 'obj');
    assert.equal(errorMessage(Object.create(null)), 'unknown error');
  });
});

// ───────────────────────────── user turn (00 §6.2, 06 §4.5) ─────────────────────────────

function turn(over: Partial<ComposeUserTurnInput>): ComposeUserTurnInput {
  return { text: 'hello', hookOutputs: [], agentPrompts: [], steeringBlocks: [], refBlocks: [], ...over };
}

describe('review: composeUserTurn', () => {
  it('the user text keeps inner/trailing whitespace inside the wrapper (Q trims only the whole message)', () => {
    assert.equal(composeUserTurnText(turn({ text: 'hi  \n', refBlocks: ['R'] })), 'R\n\n--- USER MESSAGE BEGIN ---\nhi  \n--- USER MESSAGE END ---');
  });
  it('hook block with an empty output keeps Q blank lines, then exactly one extra newline', () => {
    const t = composeUserTurnText(turn({ hookOutputs: ['', 'X'] }));
    assert.equal(
      t,
      `--- CONTEXT ENTRY BEGIN ---\n${HOOK_INTRO}\n\n\n\nX\n\n--- CONTEXT ENTRY END ---\n\n\n--- USER MESSAGE BEGIN ---\nhello--- USER MESSAGE END ---`,
    );
  });
  it('only whitespace context blocks do not trigger the wrapper', () => {
    assert.equal(composeUserTurnText(turn({ refBlocks: ['  \n', ''], extraContext: ['\n'], steeringBlocks: [] })), 'hello');
  });
  it('extraContext alone triggers the wrapper; an empty text with context still has the wrapper', () => {
    assert.equal(composeUserTurnText(turn({ extraContext: ['E'] })), 'E\n\n--- USER MESSAGE BEGIN ---\nhello--- USER MESSAGE END ---');
    assert.equal(composeUserTurnText(turn({ text: '', refBlocks: ['R'] })), 'R\n\n--- USER MESSAGE BEGIN ---\n--- USER MESSAGE END ---');
  });
  it('images with context: image blocks first then the wrapped text; multiple images keep order', () => {
    const r = composeUserTurn(
      turn({
        refBlocks: ['R'],
        images: [
          { mediaType: 'image/png', dataBase64: '1' },
          { mediaType: 'image/webp', dataBase64: '2' },
        ],
      }),
    );
    assert.ok(Array.isArray(r));
    assert.deepEqual(
      (r as { type: string }[]).map((b) => b.type),
      ['image', 'image', 'text'],
    );
  });
  it('formatSteeringBlock escapes & " < in the name and trims trailing body whitespace only', () => {
    assert.equal(formatSteeringBlock({ name: 'a"&<b', body: '\n  body \n\n' }), '<steering name="a&quot;&amp;&lt;b">\n\n  body\n</steering>');
  });
});

describe('review: SteeringActivator', () => {
  function setup() {
    const ws = tmpWorkspace();
    const sdir = path.join(ws.cwd, '.kiro', 'steering');
    const files: SteeringFile[] = [
      steering({ path: path.join(sdir, 'api.md'), name: 'api', inclusion: 'manual', body: 'API' }),
      steering({ path: path.join(sdir, 'café.md'), name: 'café', inclusion: 'manual', body: 'CAFE' }),
      steering({ path: path.join(sdir, 'guide.md'), name: 'Auto Guide', inclusion: 'auto', description: 'd', body: 'G' }),
      steering({ path: path.join(sdir, 'react.md'), name: 'react', inclusion: 'fileMatch', fileMatchPatterns: ['*.tsx'], body: 'R' }),
      steering({ path: path.join(sdir, 'docs.md'), name: 'docs', inclusion: 'fileMatch', fileMatchPatterns: ['docs/**/*.md'], body: 'D' }),
      steering({ path: path.join(sdir, 'abs.md'), name: 'abs', inclusion: 'fileMatch', fileMatchPatterns: ['/opt/conf/*.conf'], body: 'ABS' }),
    ];
    return { ws, files, act: new SteeringActivator(files, ws) };
  }
  const names = (r: { name: string }[]): string[] => r.map((b) => b.name);

  it('agrees with expandHashRefs on #steering: forms (case, quotes, paths, .md)', () => {
    for (const ref of ['#Steering:react', '#STEERING:React.MD', '#steering:"react.md"', "#steering:'react'", '#steering:.kiro/steering/react.md', '#steering:react,']) {
      const { act } = setup();
      assert.deepEqual(names(act.forPrompt(`use ${ref}`)), ['react'], ref);
    }
  });
  it('unicode names, trailing punctuation and a trailing .md. are recognised', () => {
    const { act } = setup();
    assert.deepEqual(names(act.forPrompt('apply #café, and #api.md.')), ['api', 'café']);
  });
  it('#<stem> and #"name" reach an auto file whose name differs from its stem', () => {
    assert.deepEqual(names(setup().act.forPrompt('#guide')), ['Auto Guide']);
    assert.deepEqual(names(setup().act.forPrompt('#"Auto Guide"')), ['Auto Guide']);
    assert.deepEqual(names(setup().act.forPrompt('/guide')), ['Auto Guide']);
  });
  it('not references: /steering:x, paths with slashes, mid-word, parentheses, fenced code', () => {
    const { act } = setup();
    assert.deepEqual(act.forPrompt('/steering:react a/api (#api) x#api /api/v1 #api/x\n```\n#api\n```'), []);
    assert.deepEqual(act.activated, []);
  });
  it('fileMatch through quoted paths with spaces and Windows separators', () => {
    assert.deepEqual(names(setup().act.forPrompt('open "docs/my guide/intro.md"')), ['docs']);
    assert.deepEqual(names(setup().act.forPrompt('edit src\\components\\App.tsx')), ['react']);
  });
  it('a URL is not a path token', () => {
    assert.deepEqual(setup().act.forPrompt('see https://example.com/App.tsx'), []);
  });
  it('forToolPath: several matching files in one call, then nothing; absolute patterns; reset', () => {
    const { ws, files } = setup();
    const both = files.map((f) => (f.name === 'docs' ? { ...f, fileMatchPatterns: ['*.tsx'] } : f));
    const act = new SteeringActivator(both, ws);
    const t = act.forToolPath(path.join(ws.cwd, 'src', 'A.tsx'))!;
    assert.equal(
      t,
      'Kiro steering for files matching src/A.tsx (apply it while working on such files):\n\n' +
        '<steering name="react">\nR\n</steering>\n\n<steering name="docs">\nD\n</steering>',
    );
    assert.equal(act.forToolPath(path.join(ws.cwd, 'src', 'B.tsx')), undefined);
    assert.ok(act.forToolPath('/opt/conf/x.conf')!.includes('ABS'));
    act.reset();
    assert.ok(act.forToolPath(path.join(ws.cwd, 'B.tsx'))!.includes('<steering name="react">'));
  });
  it('activated is a copy; always files passed to the constructor are ignored', () => {
    const { ws, files } = setup();
    const act = new SteeringActivator([...files, steering({ path: '/x/always.md', name: 'always', body: 'A' })], ws);
    act.forPrompt('#api #always');
    const a = act.activated;
    a.push('mutated');
    assert.deepEqual(act.activated, ['api']);
  });
  it('forNames accepts stems and .md names, case-insensitively', () => {
    assert.deepEqual(names(setup().act.forNames(['GUIDE.md', 'REACT', 'unknown'])), ['Auto Guide', 'react']);
  });
  it('fileMatchMatches: brace + match-base, ./ prefix, empty and whitespace patterns', () => {
    assert.equal(fileMatchMatches(['  *.{ts,tsx}  '], 'a/b/c.tsx'), true);
    assert.equal(fileMatchMatches(['   '], 'a.ts'), false);
    assert.equal(fileMatchMatches(['./docs/*.md'], 'docs/a.md'), true);
    assert.equal(fileMatchMatches(['docs/*.md'], 'docs/x/a.md'), false);
    assert.equal(fileMatchMatches(['**/test/**'], 'pkg/test/a/b.ts'), true);
    assert.equal(fileMatchMatches(['{'], 'a'), false); // unbalanced brace never throws
  });
});

// ───────────────────────────── models (00 §3.13) and store (00 §7) ─────────────────────────────

describe('review: models', () => {
  it('claudeToKiroModelId vectors (00 §3.13)', () => {
    const v: [string, string][] = [
      ['claude-opus-4-1-20250805', 'claude-opus-4.1'],
      ['claude-opus-4-5-20251101', 'claude-opus-4.5'],
      ['claude-sonnet-4-20250514', 'claude-sonnet-4'],
      ['claude-3-5-haiku-20241022', 'claude-3.5-haiku'],
      ['  claude-opus-5-5  ', 'claude-opus-5.5'],
      ['CLAUDE-OPUS-4-8[1M]', 'claude-opus-4.8'],
      ['default', 'auto'],
      ['sonnet', 'sonnet'],
      ['gpt-5', 'gpt-5'],
    ];
    for (const [id, want] of v) assert.equal(claudeToKiroModelId(id), want, id);
  });
  it('kiroToClaudeModel uses the live list (undated Kiro id finds the dated Claude id)', () => {
    const live: ModelInfo[] = [
      { value: 'default', resolvedModel: 'claude-opus-5-5' },
      { value: 'claude-sonnet-4-20250514' },
      { value: 'claude-haiku-4-5-20251001' },
    ];
    assert.deepEqual(kiroToClaudeModel('claude-sonnet-4', live), { value: 'claude-sonnet-4-20250514' });
    assert.deepEqual(kiroToClaudeModel('claude-haiku-4.5', live), { value: 'claude-haiku-4-5-20251001' });
    assert.deepEqual(kiroToClaudeModel(' Auto ', live), {});
    const err = kiroToClaudeModel('glm-5', live).error!;
    assert.equal(err, "Model 'glm-5' does not exist. Available models: auto, claude-sonnet-4, claude-haiku-4.5");
  });
  it('--list-models json satisfies the KiroCrew admission rules (08a §2.2)', () => {
    for (const live of [undefined, [{ value: 'default', resolvedModel: 'claude-opus-5-5' }, { value: 'weird-model' }] as ModelInfo[]]) {
      const d = JSON.parse(formatModelList(buildModelList(live), 'json')) as { models: Record<string, unknown>[] };
      assert.ok(d && typeof d === 'object' && !Array.isArray(d) && Array.isArray(d.models) && d.models.length > 0);
      for (const row of d.models) {
        assert.equal(row.model_id, row.model_name);
        assert.ok(Number.isInteger(row.context_window_tokens) && (row.context_window_tokens as number) > 0, JSON.stringify(row));
        assert.ok(Number.isFinite(row.rate_multiplier) && (row.rate_multiplier as number) > 0);
        assert.equal(typeof row.description, 'string');
      }
    }
  });
});

describe('review: session store', () => {
  function mk() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-review-store-')));
    const cwd = path.join(root, 'proj');
    fs.mkdirSync(cwd);
    return { root, cwd, s: new SessionStore(path.join(root, 'sessions')) };
  }
  it('list ignores JSON that is not an object, temp files and directories named *.json', () => {
    const { s, cwd } = mk();
    const rec = s.create({ origin: 'repl', cwd, agent: 'kiro_default', model: 'auto' });
    fs.writeFileSync(path.join(s.dir, 'arr.json'), '[1]');
    fs.writeFileSync(path.join(s.dir, 'null.json'), 'null');
    fs.writeFileSync(path.join(s.dir, `.${rec.sessionId}.json.123.tmp`), '{}');
    fs.mkdirSync(path.join(s.dir, 'dir.json'));
    assert.deepEqual(s.list().map((r) => r.sessionId), [rec.sessionId]);
  });
  it('cwd filter matches through a symlinked directory', () => {
    const { s, cwd, root } = mk();
    const rec = s.create({ origin: 'acp', cwd, agent: 'a', model: 'auto' });
    const link = path.join(root, 'link');
    fs.symlinkSync(cwd, link);
    assert.equal(s.latest(link)?.sessionId, rec.sessionId);
    assert.equal(s.list({ cwd: root }).length, 0);
  });
  it('write refuses unsafe ids; read/delete of unsafe ids are harmless', () => {
    const { s, cwd } = mk();
    const rec = s.create({ origin: 'repl', cwd, agent: 'a', model: 'auto' });
    assert.throws(() => s.write({ ...rec, sessionId: '../evil' }), /Invalid session id/);
    assert.equal(s.read('../evil'), undefined);
    assert.equal(s.delete('../evil'), false);
  });
  it('previewText counts code points and never splits an emoji', () => {
    assert.equal(previewText('😀'.repeat(10), 5), `${'😀'.repeat(4)}…`);
    assert.equal(previewText('  a \n\t b  '), 'a b');
  });
});
