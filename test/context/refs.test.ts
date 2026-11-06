import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CODEBASE_HINT,
  MAX_FILE_REF_BYTES,
  codeRanges,
  expandAtRefs,
  expandHashRefs,
  findSteering,
  formatFileBlock,
  imageMediaType,
  renderDirTree,
} from '../../src/context/refs.js';
import type { PromptFile } from '../../src/types.js';
import { steering, tmpWorkspace, write } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function prompt(name: string): PromptFile {
  return { name, path: `/p/${name}.md`, scope: 'workspace', body: 'body' };
}

describe('refs: codeRanges', () => {
  it('finds inline spans and fences', () => {
    const t = 'a `b` c\n```\n@x\n```\nd ``e`f`` g';
    const r = codeRanges(t);
    const inCode = (s: string): boolean => {
      const i = t.indexOf(s);
      return r.some(([a, b]) => i >= a && i < b);
    };
    assert.ok(inCode('b`'));
    assert.ok(inCode('@x'));
    assert.ok(inCode('e`f'));
    assert.ok(!inCode('a `'));
    assert.ok(!inCode('d '));
    assert.ok(!inCode(' g'));
  });
  it('unclosed fence runs to the end; unmatched backtick is not code', () => {
    const t = 'x `y\n~~~\nz';
    const r = codeRanges(t);
    assert.ok(r.some(([a, b]) => a <= t.indexOf('z') && t.indexOf('z') < b));
    assert.ok(!r.some(([a, b]) => a <= t.indexOf('y') && t.indexOf('y') < b));
  });
});

describe('refs: expandAtRefs files', () => {
  it('inlines a text file as a fenced block (abs path, language)', () => {
    const ws = tmpWorkspace();
    const f = write(path.join(ws.cwd, 'src', 'index.ts'), 'export const x = 1;\n');
    const r = expandAtRefs('explain @src/index.ts please', { cwd: ws.cwd });
    assert.equal(r.text, 'explain @src/index.ts please');
    assert.deepEqual(r.blocks, [`<file path="${f}">\n\`\`\`typescript\nexport const x = 1;\n\`\`\`\n</file>`]);
    assert.deepEqual(r.images, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.promptExpansion, undefined);
  });

  it('uses a longer fence when the content contains backticks', () => {
    const b = formatFileBlock('/x/readme', 'a ```js``` b');
    assert.equal(b, '<file path="/x/readme">\n````\na ```js``` b\n````\n</file>');
  });

  it('absolute paths, quoted paths with spaces, trailing punctuation', () => {
    const ws = tmpWorkspace();
    const a = write(path.join(ws.cwd, 'my file.txt'), 'spaced');
    const b = write(path.join(ws.cwd, 'b.md'), 'bee');
    const c = write(path.join(ws.tmp, 'abs.txt'), 'abs');
    const r = expandAtRefs(`look at @"my file.txt", @b.md, and @${c}.`, { cwd: ws.cwd });
    assert.equal(r.blocks.length, 3);
    assert.ok(r.blocks[0]!.startsWith(`<file path="${a}">`));
    assert.ok(r.blocks[1]!.startsWith(`<file path="${b}">\n\`\`\`markdown\nbee`));
    assert.ok(r.blocks[2]!.startsWith(`<file path="${c}">`));
    const q = expandAtRefs("@'my file.txt'", { cwd: ws.cwd });
    assert.equal(q.blocks.length, 1);
  });

  it('ignores emails, missing paths, code spans and duplicates', () => {
    const ws = tmpWorkspace();
    write(path.join(ws.cwd, 'a.txt'), 'A');
    const r = expandAtRefs('mail me@a.txt or @missing.txt; `@a.txt` and\n```\n@a.txt\n```\n@a.txt @a.txt', { cwd: ws.cwd });
    assert.equal(r.blocks.length, 1);
  });

  it('truncates files over 250KB with the Kiro warning', () => {
    const ws = tmpWorkspace();
    write(path.join(ws.cwd, 'large-file.json'), 'x'.repeat(MAX_FILE_REF_BYTES + 100));
    const r = expandAtRefs('@large-file.json', { cwd: ws.cwd });
    assert.deepEqual(r.warnings, ["⚠ File 'large-file.json' was truncated (exceeds 250KB limit)"]);
    assert.equal(r.blocks.length, 1);
    assert.ok(r.blocks[0]!.includes('x'.repeat(MAX_FILE_REF_BYTES) + '\n```\n[truncated: file exceeds 250KB limit]\n</file>'));
    assert.ok(!r.blocks[0]!.includes('x'.repeat(MAX_FILE_REF_BYTES + 1)));
  });

  it('truncation never splits a multi-byte character', () => {
    const ws = tmpWorkspace();
    write(path.join(ws.cwd, 'u.txt'), 'a' + '€'.repeat(MAX_FILE_REF_BYTES / 3 + 10));
    const r = expandAtRefs('@u.txt', { cwd: ws.cwd });
    assert.equal(r.warnings.length, 1);
    assert.ok(!r.blocks[0]!.includes('�'));
  });

  it('binary files are not included', () => {
    const ws = tmpWorkspace();
    write(path.join(ws.cwd, 'x.bin'), Buffer.from([1, 2, 0, 3]));
    write(path.join(ws.cwd, 'y.bin'), Buffer.from([0xc3, 0x28, 0x41]));
    const r = expandAtRefs('@x.bin @y.bin', { cwd: ws.cwd });
    assert.deepEqual(r.blocks, []);
    assert.deepEqual(r.warnings, [
      "⚠ File 'x.bin' is a binary file and was not included",
      "⚠ File 'y.bin' is a binary file and was not included",
    ]);
  });
});

describe('refs: directory trees (depth 3 × 10 items)', () => {
  it('renders a tree with ignores and the more-items line', () => {
    const ws = tmpWorkspace();
    const d = path.join(ws.cwd, 'src');
    for (let i = 0; i < 12; i++) write(path.join(d, `f${String(i).padStart(2, '0')}.ts`), '');
    write(path.join(d, 'node_modules', 'x.js'), '');
    write(path.join(d, '.git', 'HEAD'), '');
    write(path.join(d, 'dist', 'x.js'), '');
    const tree = renderDirTree(d, 'src/');
    const lines = tree.split('\n');
    assert.equal(lines[0], 'src/');
    assert.equal(lines[1], '├── f00.ts');
    assert.equal(lines[10], '├── f09.ts');
    assert.equal(lines[11], '└── ... (2 more items)');
    assert.equal(lines.length, 12);
    assert.ok(!tree.includes('node_modules') && !tree.includes('.git') && !tree.includes('dist'));
  });

  it('nests with connectors and stops below depth 3', () => {
    const ws = tmpWorkspace();
    const d = path.join(ws.cwd, 'pkg');
    write(path.join(d, 'a', 'b', 'c', 'd', 'deep.txt'), '');
    write(path.join(d, 'a', 'b', 'c', 'leaf.txt'), '');
    write(path.join(d, 'z.txt'), '');
    assert.equal(
      renderDirTree(d, 'pkg'),
      ['pkg/', '├── a/', '│   └── b/', '│       └── c/', '└── z.txt'].join('\n'),
    );
    assert.equal(
      renderDirTree(d, 'pkg', { maxDepth: 4 }),
      ['pkg/', '├── a/', '│   └── b/', '│       └── c/', '│           ├── d/', '│           └── leaf.txt', '└── z.txt'].join('\n'),
    );
  });

  it('@dir/ produces a directory block', () => {
    const ws = tmpWorkspace();
    write(path.join(ws.cwd, 'lib', 'a.ts'), '');
    const r = expandAtRefs('see @lib/', { cwd: ws.cwd });
    assert.deepEqual(r.blocks, [`<directory path="${path.join(ws.cwd, 'lib')}">\nlib/\n└── a.ts\n</directory>`]);
  });
});

describe('refs: images', () => {
  it('png/jpg/jpeg/gif/webp media types', () => {
    assert.equal(imageMediaType('a.PNG'), 'image/png');
    assert.equal(imageMediaType('a.jpg'), 'image/jpeg');
    assert.equal(imageMediaType('a.jpeg'), 'image/jpeg');
    assert.equal(imageMediaType('a.gif'), 'image/gif');
    assert.equal(imageMediaType('a.webp'), 'image/webp');
    assert.equal(imageMediaType('a.svg'), undefined);
    assert.equal(imageMediaType('png'), undefined);
  });

  it('@image becomes an image block, not a text block', () => {
    const ws = tmpWorkspace();
    const p = write(path.join(ws.cwd, 'shot.png'), PNG);
    const r = expandAtRefs('what is in @shot.png?', { cwd: ws.cwd });
    assert.deepEqual(r.blocks, []);
    assert.deepEqual(r.images, [{ mediaType: 'image/png', dataBase64: PNG.toString('base64'), path: p }]);
  });

  it('drag-and-drop: a message that is just an image path (quoted or escaped)', () => {
    const ws = tmpWorkspace();
    const p = write(path.join(ws.cwd, 'my shot.jpg'), PNG);
    for (const msg of [`'${p}'`, `"${p}"`, p.replace(/ /g, '\\ ')]) {
      const r = expandAtRefs(msg, { cwd: ws.cwd });
      assert.equal(r.images.length, 1, msg);
      assert.equal(r.images[0]!.mediaType, 'image/jpeg');
      assert.equal(r.text, msg);
    }
    assert.equal(expandAtRefs(`look ${p}`, { cwd: ws.cwd }).images.length, 0);
  });

  it('at most 10 images per message', () => {
    const ws = tmpWorkspace();
    const refs: string[] = [];
    for (let i = 0; i < 11; i++) {
      write(path.join(ws.cwd, `i${i}.gif`), PNG);
      refs.push(`@i${i}.gif`);
    }
    const r = expandAtRefs(refs.join(' '), { cwd: ws.cwd });
    assert.equal(r.images.length, 10);
    assert.deepEqual(r.warnings, ["⚠ Image 'i10.gif' was not attached (at most 10 images per message)"]);
  });
});

describe('refs: @prompt invocation (prompts first)', () => {
  const prompts = [prompt('review'), prompt('Deploy_App')];
  it('reports the prompt and shlex-split args without expanding', () => {
    const ws = tmpWorkspace();
    write(path.join(ws.cwd, 'review'), 'a file named like the prompt');
    const r = expandAtRefs('@review src/a.ts "two words"', { cwd: ws.cwd, prompts });
    assert.deepEqual(r.promptExpansion, { name: 'review', args: ['src/a.ts', 'two words'] });
    assert.deepEqual(r.blocks, []);
  });
  it('case-insensitive name, no args, leading whitespace', () => {
    const r = expandAtRefs('  @deploy_app', { cwd: '/', prompts });
    assert.deepEqual(r.promptExpansion, { name: 'Deploy_App', args: [] });
  });
  it('unbalanced quotes fall back to whitespace split', () => {
    const r = expandAtRefs('@review "oops', { cwd: '/', prompts });
    assert.deepEqual(r.promptExpansion, { name: 'review', args: ['"oops'] });
  });
  it('only at the start; @./name forces a file; unknown names are files', () => {
    const ws = tmpWorkspace();
    write(path.join(ws.cwd, 'review'), 'file');
    assert.equal(expandAtRefs('please @review', { cwd: ws.cwd, prompts }).promptExpansion, undefined);
    const f = expandAtRefs('@./review', { cwd: ws.cwd, prompts });
    assert.equal(f.promptExpansion, undefined);
    assert.equal(f.blocks.length, 1);
    assert.equal(expandAtRefs('@other', { cwd: ws.cwd, prompts }).promptExpansion, undefined);
    assert.equal(expandAtRefs('@review', { cwd: ws.cwd }).promptExpansion, undefined);
  });
});

describe('refs: expandHashRefs', () => {
  function setup() {
    const ws = tmpWorkspace();
    const files = [
      steering({ path: path.join(ws.cwd, '.kiro/steering/api.md'), name: 'api', inclusion: 'manual', body: 'API' }),
      steering({ path: path.join(ws.cwd, '.kiro/steering/db.md'), name: 'db', inclusion: 'auto', description: 'DB', body: 'DB' }),
      steering({ path: path.join(ws.cwd, '.kiro/steering/react.md'), name: 'react', inclusion: 'fileMatch', fileMatchPatterns: ['*.tsx'], body: 'R' }),
      steering({ path: path.join(ws.cwd, '.kiro/steering/product.md'), name: 'product', inclusion: 'always', body: 'P' }),
    ];
    return { ws, files };
  }

  it('#name and #steering:name collect conditional steering names', async () => {
    const { ws, files } = setup();
    const r = await expandHashRefs('use #API and #db, plus #steering:react.md and #steering:product and #react', { ws, steering: files });
    assert.deepEqual(r.steeringNames, ['api', 'db', 'react']);
    assert.deepEqual(r.blocks, []);
    assert.deepEqual(r.notices, []);
  });

  it('#steering:<unknown> gives a notice', async () => {
    const { ws, files } = setup();
    const r = await expandHashRefs('#steering:nope', { ws, steering: files });
    assert.deepEqual(r.notices, ["Steering file 'nope' not found"]);
  });

  it('#spec:<name> inlines the spec documents in order; unknown spec -> notice', async () => {
    const { ws, files } = setup();
    const dir = path.join(ws.cwd, '.kiro', 'specs', 'user-auth');
    const req = write(path.join(dir, 'requirements.md'), '# Req\n');
    const design = write(path.join(dir, 'design.md'), 'Design #[[file:x]]');
    const tasks = write(path.join(dir, 'tasks.md'), '- [ ] 1. Do it\n');
    const r = await expandHashRefs('#spec:user-auth implement task 2.3', {
      ws,
      steering: files,
      expandRefs: (b) => b.replace('#[[file:x]]', 'EXPANDED'),
    });
    assert.deepEqual(r.blocks, [
      `<spec name="user-auth" path="${dir}">\n[${req}]\n# Req\n\n[${design}]\nDesign EXPANDED\n\n[${tasks}]\n- [ ] 1. Do it\n</spec>`,
    ]);
    write(path.join(ws.cwd, '.kiro', 'outside', 'requirements.md'), 'secret');
    const esc = await expandHashRefs('#spec:../outside', { ws, steering: files });
    assert.deepEqual(esc.blocks, []);
    assert.match(esc.notices[0]!, /^Spec '\.\.\/outside' not found/);
    const miss = await expandHashRefs('#spec:nope', { ws, steering: files });
    assert.deepEqual(miss.blocks, []);
    assert.equal(miss.notices.length, 1);
    assert.match(miss.notices[0]!, /^Spec 'nope' not found/);
  });

  it('bare #<spec-name> resolves after steering; bugfix specs include bugfix.md', async () => {
    const { ws, files } = setup();
    const dir = path.join(ws.cwd, '.kiro', 'specs', 'login-bug');
    write(path.join(dir, 'bugfix.md'), 'Bug');
    const r = await expandHashRefs('fix #login-bug', { ws, steering: files });
    assert.equal(r.blocks.length, 1);
    assert.ok(r.blocks[0]!.includes('bugfix.md]\nBug'));
  });

  it('#file and #dir aliases of @path; #file: / #folder: forms', async () => {
    const { ws, files } = setup();
    const f = write(path.join(ws.cwd, 'auth.ts'), 'code');
    write(path.join(ws.cwd, 'components', 'x.tsx'), '');
    const r = await expandHashRefs('#auth.ts and #components/ and #file:auth.ts and #folder:components', { ws, steering: files });
    assert.equal(r.blocks.length, 2); // deduped
    assert.ok(r.blocks[0]!.startsWith(`<file path="${f}">`));
    assert.ok(r.blocks[1]!.startsWith(`<directory path="${path.join(ws.cwd, 'components')}">\ncomponents/\n└── x.tsx`));
    const nf = await expandHashRefs('#file:nope.ts', { ws, steering: files });
    assert.deepEqual(nf.notices, ["#file: 'nope.ts' not found"]);
  });

  it('#git diff runs status + diff HEAD through the injected runner', async () => {
    const { ws, files } = setup();
    const calls: string[][] = [];
    const runGit = async (args: string[]): Promise<string> => {
      calls.push(args);
      return args[0] === 'status' ? ' M a.ts\n' : 'diff --git a/a.ts b/a.ts\n+x\n';
    };
    const r = await expandHashRefs('review #Git Diff now, and #git diff again', { ws, steering: files, runGit });
    assert.deepEqual(calls, [['status', '--short'], ['diff', 'HEAD']]);
    assert.deepEqual(r.blocks, ['<git_diff>\n$ git status --short\n M a.ts\n\n$ git diff HEAD\ndiff --git a/a.ts b/a.ts\n+x\n</git_diff>']);
  });

  it('#git diff: no commits falls back to git diff; clean tree; failures', async () => {
    const { ws, files } = setup();
    const noHead = async (args: string[]): Promise<string> => {
      if (args[0] === 'diff' && args[1] === 'HEAD') throw new Error("fatal: bad revision 'HEAD'");
      return args[0] === 'status' ? '?? new.txt' : '';
    };
    const r1 = await expandHashRefs('#git diff', { ws, steering: files, runGit: noHead });
    assert.deepEqual(r1.blocks, ['<git_diff>\n$ git status --short\n?? new.txt\n\n$ git diff\n(no diff)\n</git_diff>']);
    const r2 = await expandHashRefs('#git diff', { ws, steering: files, runGit: async () => '' });
    assert.deepEqual(r2.blocks, ['<git_diff>\n(no changes)\n</git_diff>']);
    const r3 = await expandHashRefs('#git diff', {
      ws,
      steering: files,
      runGit: async () => {
        throw new Error('fatal: not a git repository (or any of the parent directories): .git\nmore');
      },
    });
    assert.deepEqual(r3.blocks, []);
    assert.deepEqual(r3.notices, ['#git diff: fatal: not a git repository (or any of the parent directories): .git']);
  });

  it('#git diff output is capped at 250KB', async () => {
    const { ws, files } = setup();
    const r = await expandHashRefs('#git diff', {
      ws,
      steering: files,
      runGit: async (a) => (a[0] === 'status' ? 'M x' : '+'.repeat(MAX_FILE_REF_BYTES * 2)),
    });
    assert.ok(r.blocks[0]!.length < MAX_FILE_REF_BYTES + 200);
    assert.ok(r.blocks[0]!.endsWith('[truncated: diff exceeds 250KB limit]\n</git_diff>'));
  });

  it('#git diff with the real git runner in a temp repository', async () => {
    const { ws, files } = setup();
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('git', ['init', '-q'], { cwd: ws.cwd });
    } catch {
      return; // git not installed
    }
    write(path.join(ws.cwd, 'n.txt'), 'new');
    const r = await expandHashRefs('#git diff', { ws, steering: files });
    assert.equal(r.notices.length, 0);
    assert.ok(r.blocks[0]!.includes('?? '));
  });

  it('hints: #codebase, #url:, #mcp:, #code:', async () => {
    const { ws, files } = setup();
    const r = await expandHashRefs('#codebase #url:https://example.com/a?b=1. #mcp:github #code:const x = 1;', { ws, steering: files });
    assert.deepEqual(r.blocks, [
      CODEBASE_HINT,
      'Fetch https://example.com/a?b=1 with the web_fetch tool (WebFetch) and use its content when answering.',
      'Use tools from MCP server github.',
      '```\nconst x = 1;\n```',
    ]);
  });

  it('#repository renders the workspace tree', async () => {
    const { ws, files } = setup();
    write(path.join(ws.cwd, 'src', 'a.ts'), '');
    const r = await expandHashRefs('#repository', { ws, steering: files });
    assert.equal(r.blocks.length, 1);
    assert.ok(r.blocks[0]!.startsWith(`<repository path="${ws.workspaceRoot}">\nws/\n`));
    assert.ok(r.blocks[0]!.includes('└── src/'));
  });

  it('unsupported providers and missing arguments -> one-line notices', async () => {
    const { ws, files } = setup();
    const r = await expandHashRefs('#terminal #problems #current #spec #url #terminal', { ws, steering: files });
    assert.deepEqual(r.notices, [
      '#terminal is not supported in kiro-claude and was ignored',
      '#problems is not supported in kiro-claude and was ignored',
      '#current is not supported in kiro-claude and was ignored',
      '#spec needs an argument, e.g. #spec:<name>',
      '#url needs an argument, e.g. #url:<url>',
    ]);
    assert.deepEqual(r.blocks, []);
  });

  it('not references: headings, "# ", mid-word #, code, unknown names', async () => {
    const { ws, files } = setup();
    write(path.join(ws.cwd, 'api'), 'a file named api');
    const r = await expandHashRefs('# Title\n## api\nfoo#api `#api` issue #123 and #unknown-thing\n```\n#api\n```', {
      ws,
      steering: files,
      runGit: async () => {
        throw new Error('should not run');
      },
    });
    assert.deepEqual(r, { blocks: [], steeringNames: [], notices: [] });
  });

  it('precedence: steering name beats a same-named file', async () => {
    const { ws, files } = setup();
    write(path.join(ws.cwd, 'api'), 'file');
    const r = await expandHashRefs('#api', { ws, steering: files });
    assert.deepEqual(r.steeringNames, ['api']);
    assert.deepEqual(r.blocks, []);
  });

  it('#image path suggests @', async () => {
    const { ws, files } = setup();
    write(path.join(ws.cwd, 'pic.png'), PNG);
    const r = await expandHashRefs('#pic.png', { ws, steering: files });
    assert.deepEqual(r.notices, ['#pic.png is an image; use @pic.png to attach it']);
  });

  it('findSteering by name, file name and path', () => {
    const { ws, files } = setup();
    assert.equal(findSteering(files, 'API')?.name, 'api');
    assert.equal(findSteering(files, 'db.md')?.name, 'db');
    assert.equal(findSteering(files, '.kiro/steering/react.md', ws.cwd)?.name, 'react');
    assert.equal(findSteering(files, 'nope'), undefined);
  });

  it('git runner default works with a missing directory (notice, no throw)', async () => {
    const { ws, files } = setup();
    const gone = path.join(ws.tmp, 'gone');
    const r = await expandHashRefs('#git diff', { ws: { ...ws, cwd: gone }, steering: files });
    assert.equal(r.blocks.length, 0);
    assert.equal(r.notices.length, 1);
    assert.ok(!fs.existsSync(gone));
  });
});
