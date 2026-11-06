/**
 * What kiro-claude tells users matches what it does.
 *
 *  - C21: `settings list --all` prints SETTINGS_SCHEMA descriptions. A key described as having
 *    an effect must be read somewhere in src/ (outside the schema itself); keys kiro-claude
 *    accepts but does not implement say so (`not supported`, `accepted and ignored`,
 *    `no effect`), and the README never presents them as working.
 *  - C15: the README's description of `crew setup` matches the default (light) build in
 *    src/crew/build.ts; KiroCrew's own `make build` runs only with `--full`.
 *
 * Reads README.md and src/**.ts from the repository root (tests run from there).
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SETTINGS_SCHEMA } from '../../src/config/settings.js';
import { buildKiroCrew } from '../../src/crew/build.js';
import { crewPaths } from '../../src/crew/paths.js';
import type { CrewRunner } from '../../src/crew/runner.js';

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'src', 'config', 'settings.ts')) && fs.existsSync(path.join(dir, 'README.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('run the tests from the repository root');
    dir = parent;
  }
}

const ROOT = repoRoot();
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const UNSUPPORTED = /not supported|accepted and ignored|no effect/i;

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

/** Every '…' / "…" string literal in src/ outside config/settings.ts (comments do not count). */
function sourceLiterals(): Set<string> {
  const out = new Set<string>();
  const schema = path.join(ROOT, 'src', 'config', 'settings.ts');
  for (const f of tsFiles(path.join(ROOT, 'src'))) {
    if (f === schema) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/'([A-Za-z][\w.]*)'|"([A-Za-z][\w.]*)"/g)) out.add(m[1] ?? m[2]!);
  }
  return out;
}

describe('settings schema descriptions match the implementation (C21)', () => {
  const literals = sourceLiterals();

  it('every key described as having an effect is read somewhere in src/', () => {
    const unread = Object.entries(SETTINGS_SCHEMA)
      .filter(([k, v]) => !UNSUPPORTED.test(v.description) && !literals.has(k))
      .map(([k, v]) => `${k}: ${v.description}`);
    assert.deepEqual(unread, [], 'mark these "(not supported in kiro-claude)" or implement them');
  });

  it('no key marked unsupported is read in src/ (implementing one means updating its description)', () => {
    const stale = Object.entries(SETTINGS_SCHEMA)
      .filter(([k, v]) => UNSUPPORTED.test(v.description) && literals.has(k))
      .map(([k, v]) => `${k}: ${v.description}`);
    assert.deepEqual(stale, []);
  });

  it('the keys of the review finding say they are not supported', () => {
    for (const k of [
      'kiroClaude.autonomy',
      'chat.disableAutoCompaction',
      'mcp.initTimeout',
      'api.timeout',
      'chat.diffTool',
      'chat.terminalTitle',
      'chat.notificationMethod',
    ]) {
      const d = SETTINGS_SCHEMA[k]?.description ?? '';
      assert.ok(literals.has(k) || /\(not supported in kiro-claude\b/.test(d), `${k}: ${d}`);
    }
  });

  it('the README presents no unsupported setting as working', () => {
    const marked = Object.entries(SETTINGS_SCHEMA).filter(([, v]) => UNSUPPORTED.test(v.description)).map(([k]) => k);
    const claimed = marked.filter((k) => README.includes(`\`${k}\``));
    assert.deepEqual(claimed, []);
    // every kiro-claude setting the README documents exists and is implemented
    const documented = [...README.matchAll(/^\| `(kiroClaude\.[\w.]+)` \|/gm)].map((m) => m[1]!);
    assert.ok(documented.length >= 4, 'README settings table found');
    for (const k of documented) {
      assert.ok(SETTINGS_SCHEMA[k], `${k} is in the schema`);
      assert.ok(!UNSUPPORTED.test(SETTINGS_SCHEMA[k]!.description), `${k} is supported`);
      assert.ok(literals.has(k), `${k} is read in src/`);
    }
  });

  it('the README says how unsupported settings show up in `settings list --all`', () => {
    assert.match(README, /settings list --all[^\n]*\n?[^\n]*not supported or ignored/);
  });
});

describe('README: crew setup describes the build it runs (C15)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-docs-build-')));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function section(): string {
    const start = README.indexOf('What `crew setup` does:');
    assert.ok(start >= 0, 'section found');
    const end = README.indexOf('\n## ', start);
    return README.slice(start, end < 0 ? undefined : end);
  }

  /** Runs buildKiroCrew with a runner that records commands and succeeds. */
  async function commandsFor(kind: 'light' | 'full'): Promise<{ file: string; args: readonly string[] }[]> {
    const calls: { file: string; args: readonly string[] }[] = [];
    const runner: CrewRunner = {
      async run(file, args) {
        calls.push({ file, args });
        return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 0 };
      },
      spawnDetached() {
        throw new Error('not used');
      },
    };
    const env = { HOME: tmp, PATH: '/nonexistent', KIRO_CLAUDE_CREW_HOME: path.join(tmp, `cs-${kind}`) };
    await buildKiroCrew({ dir: path.join(tmp, 'kc'), kind, python: '/usr/bin/python3.13', npm: 'npm', runner, env, paths: crewPaths(env) });
    return calls;
  }

  it('the default (light) build never runs make; --full runs only `make -C <dir> build`', async () => {
    const light = await commandsFor('light');
    assert.ok(light.length > 0);
    assert.ok(!light.some((c) => path.basename(c.file) === 'make'), 'light build runs make');
    assert.deepEqual([light[0]!.file, ...light[0]!.args.slice(0, 1)], ['npm', 'ci']);
    assert.ok(light.some((c) => c.args.includes('-e')), 'pip install -e');
    assert.ok(light.some((c) => c.args.join(' ') === `-m kiro_crew.frontend stage ${path.join(tmp, 'kc')}`), 'frontend stage');
    const full = await commandsFor('full');
    assert.deepEqual(full.map((c) => [c.file, ...c.args]), [['make', '-C', path.join(tmp, 'kc'), 'build', 'PY=/usr/bin/python3.13']]);
  });

  it('README step 1 describes the light build, and `make build` only with --full', () => {
    const s = section();
    for (const sentence of s.split(/(?<=\.)\s+|\n\d+\.\s+/)) {
      if (sentence.includes('make build')) assert.match(sentence, /--full/, `"${sentence.trim()}"`);
    }
    assert.match(s, /npm ci/);
    assert.match(s, /npm run build/);
    assert.match(s, /pip install -e/);
    assert.match(s, /frontend/);
  });

  it('Requirements: make is needed only for crew setup --full', () => {
    const req = README.slice(README.indexOf('## Requirements'), README.indexOf('## Install'));
    const items = req.split(/\n\* /);
    const withMake = items.filter((i) => /`make`|\bmake\b/.test(i));
    assert.ok(withMake.length > 0, 'make is mentioned');
    for (const i of withMake) assert.match(i, /--full/, i);
  });
});
