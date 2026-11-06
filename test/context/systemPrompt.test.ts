import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AGENT_PROMPT_PREFIX,
  DEFAULT_PREAMBLE,
  HOOK_CONTEXT_INTRO,
  buildSystemPrompt,
  formatContextEntries,
  formatHookContext,
  formatSteeringIndexEntry,
  orderSteering,
  steeringBaseDir,
  steeringCondition,
  type SystemPromptInput,
} from '../../src/context/systemPrompt.js';
import { estimateTokens } from '../../src/context/tokens.js';
import { agent, steering, tmpWorkspace, write } from './helpers.js';

function input(over: Partial<SystemPromptInput> & Pick<SystemPromptInput, 'ws'>): SystemPromptInput {
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

describe('systemPrompt: Q wrappers', () => {
  it('formatContextEntries is Q exact', () => {
    assert.equal(
      formatContextEntries([
        { path: '/a', content: 'A' },
        { path: '/b', content: 'B\n' },
      ]),
      '--- CONTEXT ENTRY BEGIN ---\n[/a]\nA\n[/b]\nB\n\n--- CONTEXT ENTRY END ---\n\n',
    );
    assert.equal(formatContextEntries([]), '');
  });

  it('formatHookContext agentSpawn form (06 §3.7)', () => {
    assert.equal(
      formatHookContext(['one', 'two'], true),
      '--- CONTEXT ENTRY BEGIN ---\n' +
        'This section (like others) contains important information that I want you to use in your responses. ' +
        'I have gathered this context from valuable programmatic script hooks. You must follow any requests and ' +
        'consider all of the information in this section for the entire conversation\n\n' +
        'one\n\ntwo\n\n--- CONTEXT ENTRY END ---\n\n',
    );
  });
  it('formatHookContext userPromptSubmit form has no suffix', () => {
    const s = formatHookContext(['x'], false)!;
    assert.ok(s.includes(`${HOOK_CONTEXT_INTRO}\n\nx\n\n`));
    assert.ok(!s.includes('entire conversation'));
  });
  it('formatHookContext: all empty -> undefined; empty kept when one is non-empty', () => {
    assert.equal(formatHookContext([], true), undefined);
    assert.equal(formatHookContext(['', ''], true), undefined);
    assert.ok(formatHookContext(['', 'x'], true)!.includes('section for the entire conversation\n\n\n\nx\n\n--- CONTEXT ENTRY END'));
  });
});

describe('systemPrompt: conditional steering index (03 §3)', () => {
  it('manual entry', () => {
    assert.equal(
      formatSteeringIndexEntry(steering({ path: '/w/.kiro/steering/api.md', name: 'api', inclusion: 'manual', description: 'API rules' })),
      'CONDITIONAL GUIDE, NOT ACTIVE INSTRUCTIONS. Only when the user explicitly requests #api or this guide.\n' +
        'Read /w/.kiro/steering/api.md with the file tool when that condition holds, then apply its full current contents.\n' +
        'Description: API rules',
    );
  });
  it('fileMatch entry with one and several patterns', () => {
    const one = formatSteeringIndexEntry(
      steering({ path: '/w/s/react.md', name: 'react', inclusion: 'fileMatch', fileMatchPatterns: ['*.tsx'] }),
    );
    assert.equal(
      one,
      'CONDITIONAL GUIDE, NOT ACTIVE INSTRUCTIONS. Only before working on a file matching fileMatchPattern; an empty pattern never matches.\n' +
        'Read /w/s/react.md with the file tool when that condition holds, then apply its full current contents.\n' +
        'Description:\n' +
        'fileMatchPattern: *.tsx',
    );
    const many = formatSteeringIndexEntry(
      steering({ path: '/w/s/ts.md', name: 'ts', inclusion: 'fileMatch', fileMatchPatterns: ['**/*.ts', '**/*.tsx'] }),
    );
    assert.ok(many.endsWith('fileMatchPattern: ["**/*.ts","**/*.tsx"]'));
    const none = formatSteeringIndexEntry(steering({ path: '/w/s/n.md', name: 'n', inclusion: 'fileMatch' }));
    assert.ok(none.endsWith('\nfileMatchPattern:'));
  });
  it('auto entry, multi-line description collapsed', () => {
    const e = formatSteeringIndexEntry(
      steering({ path: '/g/db.md', name: 'db', inclusion: 'auto', description: 'Database\n  migrations' }),
    );
    assert.equal(
      e,
      'CONDITIONAL GUIDE, NOT ACTIVE INSTRUCTIONS. Only when the description is relevant to the current task; an empty description requires an explicit request.\n' +
        'Read /g/db.md with the file tool when that condition holds, then apply its full current contents.\n' +
        'Description: Database migrations',
    );
  });
  it('steeringCondition covers every mode', () => {
    assert.equal(steeringCondition({ inclusion: 'always', name: 'x' }), 'Always.');
    assert.match(steeringCondition({ inclusion: 'manual', name: 'x' }), /#x/);
  });
});

describe('systemPrompt: helpers', () => {
  it('orderSteering puts global, legacy, workspace (stable)', () => {
    const files = [
      steering({ path: '/w1', name: 'w1', scope: 'workspace' }),
      steering({ path: '/g1', name: 'g1', scope: 'global' }),
      steering({ path: '/l1', name: 'l1', scope: 'legacy' }),
      steering({ path: '/w2', name: 'w2', scope: 'workspace' }),
      steering({ path: '/g2', name: 'g2', scope: 'global' }),
    ];
    assert.deepEqual(orderSteering(files).map((f) => f.name), ['g1', 'g2', 'l1', 'w1', 'w2']);
  });
  it('steeringBaseDir follows 02 §4', () => {
    const ws = tmpWorkspace();
    assert.equal(steeringBaseDir(ws, { scope: 'global', path: path.join(ws.kiroHome, 'steering', 'sub', 'a.md') }), path.join(ws.kiroHome, 'steering'));
    assert.equal(steeringBaseDir(ws, { scope: 'workspace', path: path.join(ws.cwd, '.kiro', 'steering', 'a.md') }), ws.workspaceRoot);
    assert.equal(steeringBaseDir(ws, { scope: 'legacy', path: '/x/rules/a.md' }), ws.workspaceRoot);
    assert.equal(steeringBaseDir(ws, { scope: 'global', path: '/q/sub/AGENTS.md' }), '/q/sub');
  });
});

describe('systemPrompt: buildSystemPrompt golden', () => {
  it('full layout in 00 §6.1 order with exact wrappers', () => {
    const ws = tmpWorkspace();
    const gPath = write(path.join(ws.kiroHome, 'steering', 'global.md'), 'ignored on disk');
    const wPath = path.join(ws.cwd, '.kiro', 'steering', 'product.md');
    const agentsMd = write(path.join(ws.cwd, 'AGENTS.md'), '---\ntitle: x\n---\nAgents rules\n');
    const res1 = write(path.join(ws.cwd, 'docs', 'a.md'), 'Resource A');
    const sess1 = write(path.join(ws.cwd, 'notes.txt'), 'Session note');
    const manual = steering({ path: path.join(ws.cwd, '.kiro', 'steering', 'api.md'), name: 'api', inclusion: 'manual', description: 'API' });
    const r = buildSystemPrompt(
      input({
        ws,
        agent: agent({ prompt: 'You are a helpful agent.' }),
        steering: [
          steering({ path: wPath, name: 'product', scope: 'workspace', body: 'Workspace steering' }),
          manual,
          steering({ path: gPath, name: 'global', scope: 'global', body: 'Global steering' }),
        ],
        agentsMd: [agentsMd],
        resourceFiles: [{ pattern: 'docs/*.md', paths: [res1] }],
        sessionContext: [{ pattern: 'notes.txt', paths: [sess1] }],
        agentSpawnOutputs: ['spawn says hi'],
        preamble: 'PREAMBLE LINE',
      }),
    );
    const expected =
      '--- CONTEXT ENTRY BEGIN ---\n' +
      `[${gPath}]\nGlobal steering\n` +
      `[${wPath}]\nWorkspace steering\n` +
      `[${agentsMd}]\nAgents rules\n\n` +
      `[${res1}]\nResource A\n` +
      `[${sess1}]\nSession note\n` +
      '--- CONTEXT ENTRY END ---\n\n' +
      `${formatSteeringIndexEntry(manual)}\n\n` +
      formatHookContext(['spawn says hi'], true) +
      'PREAMBLE LINE\n\n' +
      'Follow this instruction: You are a helpful agent.\n';
    assert.equal(r.text, expected);
    assert.deepEqual(
      r.included.map((f) => [f.path, f.origin]),
      [
        [gPath, 'steering'],
        [wPath, 'steering'],
        [agentsMd, 'agents-md'],
        [res1, 'resource'],
        [sess1, 'session'],
      ],
    );
    assert.deepEqual(r.dropped, []);
    assert.deepEqual(r.conditionalSteering, [manual]);
    assert.equal(r.totalTokens, estimateTokens(r.text));
    assert.deepEqual(r.warnings, []);
  });

  it('agent prompt is last, in Q form, and verbatim', () => {
    const ws = tmpWorkspace();
    const r = buildSystemPrompt(input({ ws, agent: agent({ prompt: 'Line 1\nLine 2' }), preamble: undefined }));
    assert.ok(r.text.startsWith(DEFAULT_PREAMBLE));
    assert.ok(r.text.endsWith(`\n\n${AGENT_PROMPT_PREFIX}Line 1\nLine 2\n`));
  });

  it('default preamble is at most 5 lines and names Kiro tools', () => {
    const lines = DEFAULT_PREAMBLE.split('\n');
    assert.ok(lines.length <= 5);
    for (const name of ['read', 'write', 'shell', 'web_fetch', 'web_search', 'subagent', 'todo_list', '@server/tool']) {
      assert.ok(DEFAULT_PREAMBLE.includes(name), name);
    }
  });

  it('empty input with empty preamble -> empty text', () => {
    const ws = tmpWorkspace();
    const r = buildSystemPrompt(input({ ws, agent: agent({ prompt: '   ' }) }));
    assert.equal(r.text, '');
    assert.equal(r.totalTokens, 0);
  });

  it('no context files -> no context block, hook block first', () => {
    const ws = tmpWorkspace();
    const r = buildSystemPrompt(input({ ws, agentSpawnOutputs: ['out'] }));
    assert.equal(r.text, formatHookContext(['out'], true)!.replace(/\n+$/, '') + '\n');
  });

  it('empty agentSpawn outputs produce no hook block', () => {
    const ws = tmpWorkspace();
    const r = buildSystemPrompt(input({ ws, agentSpawnOutputs: ['', ''], agent: agent({ prompt: 'P' }) }));
    assert.equal(r.text, 'Follow this instruction: P\n');
  });

  it('dedupes by realpath; first origin wins', () => {
    const ws = tmpWorkspace();
    const p = write(path.join(ws.cwd, '.kiro', 'steering', 'x.md'), 'X');
    const link = path.join(ws.cwd, 'link.md');
    fs.symlinkSync(p, link);
    const r = buildSystemPrompt(
      input({
        ws,
        steering: [steering({ path: p, name: 'x', body: 'X body' })],
        resourceFiles: [{ pattern: '.kiro/steering/*.md', paths: [p] }],
        sessionContext: [{ pattern: 'link.md', paths: [link] }],
      }),
    );
    assert.deepEqual(r.included.map((f) => f.origin), ['steering']);
    assert.equal((r.text.match(/X body/g) ?? []).length, 1);
  });

  it('expandRefs is applied to steering and AGENTS.md with the right base dirs, not to resources', () => {
    const ws = tmpWorkspace();
    const sub = path.join(ws.cwd, 'pkg');
    const agentsMd = write(path.join(sub, 'AGENTS.md'), 'see #[[file:a]]');
    const res = write(path.join(ws.cwd, 'r.md'), 'resource #[[file:a]]');
    const calls: string[] = [];
    const r = buildSystemPrompt(
      input({
        ws,
        steering: [
          steering({ path: path.join(ws.kiroHome, 'steering', 'g.md'), name: 'g', scope: 'global', body: 'g #[[file:a]]' }),
          steering({ path: path.join(ws.cwd, '.kiro', 'steering', 'w.md'), name: 'w', body: 'w #[[file:a]]' }),
        ],
        agentsMd: [agentsMd],
        resourceFiles: [{ pattern: 'r.md', paths: [res] }],
        expandRefs: (body, base) => {
          calls.push(base);
          return body.replace('#[[file:a]]', `<${path.basename(base)}>`);
        },
      }),
    );
    assert.deepEqual(calls, [path.join(ws.kiroHome, 'steering'), ws.workspaceRoot, sub]);
    assert.ok(r.text.includes('g <steering>'));
    assert.ok(r.text.includes(`w <${path.basename(ws.workspaceRoot)}>`));
    assert.ok(r.text.includes('see <pkg>'));
    assert.ok(r.text.includes('resource #[[file:a]]'));
  });

  it('expandRefs failure keeps the raw body and warns', () => {
    const ws = tmpWorkspace();
    const r = buildSystemPrompt(
      input({
        ws,
        steering: [steering({ path: '/s/a.md', name: 'a', body: 'raw' })],
        expandRefs: () => {
          throw new Error('boom');
        },
      }),
    );
    assert.ok(r.text.includes('[/s/a.md]\nraw\n'));
    assert.equal(r.warnings.length, 1);
  });

  it('steering index entries keep global → workspace order and skip always files', () => {
    const ws = tmpWorkspace();
    const r = buildSystemPrompt(
      input({
        ws,
        steering: [
          steering({ path: '/w/b.md', name: 'b', inclusion: 'fileMatch', fileMatchPatterns: ['*.ts'] }),
          steering({ path: '/g/a.md', name: 'a', inclusion: 'auto', scope: 'global', description: 'A' }),
          steering({ path: '/w/c.md', name: 'c', inclusion: 'always', body: 'C' }),
        ],
      }),
    );
    assert.deepEqual(r.conditionalSteering.map((f) => f.name), ['a', 'b']);
    assert.ok(r.text.indexOf('Read /g/a.md') < r.text.indexOf('Read /w/b.md'));
    assert.ok(!r.text.includes('Read /w/c.md'));
  });
});

describe('systemPrompt: 75% cap and Q drop algorithm', () => {
  it('drops what does not fit with a tiny window, keeps output order', () => {
    const ws = tmpWorkspace();
    // window 100 -> limit 75 tokens. sizes: a=40 tok (160 B), b=30 tok (120 B), c=20 tok (80 B)
    const a = write(path.join(ws.cwd, 'a.txt'), 'a'.repeat(160));
    const b = write(path.join(ws.cwd, 'b.txt'), 'b'.repeat(120));
    const c = write(path.join(ws.cwd, 'c.txt'), 'c'.repeat(80));
    const r = buildSystemPrompt(
      input({ ws, contextWindowTokens: 100, resourceFiles: [{ pattern: '*.txt', paths: [c, a, b] }] }),
    );
    assert.deepEqual(r.included.map((f) => [path.basename(f.path), f.tokens]), [
      ['a.txt', 40],
      ['b.txt', 30],
    ]);
    assert.deepEqual(r.dropped, [c]);
    assert.ok(!r.text.includes('ccc'));
    // output order is input order, not size order
    const r2 = buildSystemPrompt(
      input({ ws, contextWindowTokens: 1000, resourceFiles: [{ pattern: '*.txt', paths: [c, a, b] }] }),
    );
    assert.deepEqual(r2.included.map((f) => path.basename(f.path)), ['c.txt', 'a.txt', 'b.txt']);
    assert.deepEqual(r2.dropped, []);
  });

  it('a steering file can be dropped too; oversize files are dropped unread', () => {
    const ws = tmpWorkspace();
    const huge = write(path.join(ws.cwd, 'huge.txt'), 'h'.repeat(4000)); // 1000 tokens
    const r = buildSystemPrompt(
      input({
        ws,
        contextWindowTokens: 100,
        steering: [steering({ path: '/s/big.md', name: 'big', body: 's'.repeat(400) })], // 100 tokens > 75
        resourceFiles: [{ pattern: 'huge.txt', paths: [huge] }],
        agentSpawnOutputs: ['kept'],
      }),
    );
    assert.deepEqual(r.included, []);
    assert.deepEqual(new Set(r.dropped), new Set(['/s/big.md', huge]));
    assert.equal(r.dropped[0], huge); // largest evaluated first
    assert.ok(!r.text.includes('--- CONTEXT ENTRY BEGIN ---\n['));
    assert.ok(r.text.includes('kept'));
  });

  it('default window when contextWindowTokens is 0', () => {
    const ws = tmpWorkspace();
    const f = write(path.join(ws.cwd, 'f.txt'), 'x'.repeat(1000));
    const r = buildSystemPrompt(input({ ws, contextWindowTokens: 0, resourceFiles: [{ pattern: 'f.txt', paths: [f] }] }));
    assert.equal(r.included.length, 1);
  });
});

describe('systemPrompt: unreadable / binary context files (06 §4.2 deviation)', () => {
  it('skips invalid UTF-8, missing files and directories with warnings', () => {
    const ws = tmpWorkspace();
    const bin = write(path.join(ws.cwd, 'bin.dat'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    const ok = write(path.join(ws.cwd, 'ok.txt'), 'fine');
    const dir = path.join(ws.cwd, 'adir');
    fs.mkdirSync(dir);
    const r = buildSystemPrompt(
      input({
        ws,
        resourceFiles: [{ pattern: '*', paths: [bin, ok, path.join(ws.cwd, 'missing.txt'), dir] }],
      }),
    );
    assert.deepEqual(r.included.map((f) => f.path), [ok]);
    assert.equal(r.warnings.length, 3);
    assert.ok(r.warnings.some((w) => w.includes('not valid UTF-8')));
    assert.ok(r.warnings.some((w) => w.includes('ENOENT')));
    assert.ok(r.warnings.some((w) => w.includes('not a regular file')));
  });

  it('AGENTS.md: BOM and CRLF normalized, front matter stripped', () => {
    const ws = tmpWorkspace();
    const a = write(path.join(ws.cwd, 'AGENTS.md'), '﻿---\r\nx: 1\r\n---\r\nHello\r\nWorld');
    const r = buildSystemPrompt(input({ ws, agentsMd: [a] }));
    assert.ok(r.text.includes(`[${a}]\nHello\nWorld\n--- CONTEXT ENTRY END ---`));
  });

  it('resource files are verbatim (CRLF kept, empty file included)', () => {
    const ws = tmpWorkspace();
    const crlf = write(path.join(ws.cwd, 'w.txt'), 'a\r\nb');
    const empty = write(path.join(ws.cwd, 'e.txt'), '');
    const r = buildSystemPrompt(input({ ws, resourceFiles: [{ pattern: '*', paths: [crlf, empty] }] }));
    assert.ok(r.text.includes(`[${crlf}]\na\r\nb\n[${empty}]\n\n`));
    assert.deepEqual(r.included.map((f) => f.tokens), [0, 0]);
  });
});

describe('systemPrompt: system-prompt file (00 §6.1)', () => {
  it('writes <runtime dir>/<sid>/context.md with mode 0600 and replaces it atomically', async () => {
    const { systemPromptFilePath, writeSystemPromptFile } = await import('../../src/context/systemPrompt.js');
    const ws = tmpWorkspace();
    const env = { HOME: ws.home, XDG_RUNTIME_DIR: path.join(ws.tmp, 'run') };
    fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true });
    const p = writeSystemPromptFile('sid-1', 'first', env);
    assert.equal(p, systemPromptFilePath('sid-1', env));
    assert.ok(p.startsWith(env.XDG_RUNTIME_DIR));
    assert.ok(p.endsWith(path.join('sid-1', 'context.md')));
    assert.equal(fs.readFileSync(p, 'utf8'), 'first');
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
    writeSystemPromptFile('sid-1', 'second', env);
    assert.equal(fs.readFileSync(p, 'utf8'), 'second');
    assert.throws(() => systemPromptFilePath('../x', env), /Invalid session id/);
    assert.throws(() => systemPromptFilePath('a/b', env), /Invalid session id/);
  });
});
