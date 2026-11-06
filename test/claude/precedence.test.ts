/**
 * Which `claude` runs (claude/binary findClaudeBinary): an explicit command-line path beats
 * `$KIRO_CLAUDE_BIN` (exported by the KiroCrew shim, 08 KC-ENV-05), which beats the
 * `kiroClaude.claudePath` setting, which beats PATH / well-known locations.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { ClaudeNotFoundError, findClaudeBinary } from '../../src/claude/binary.js';
import { locateClaude } from '../../src/cli/commands/auth.js';
import { makeCtx, makeEnv, run } from '../cli/helpers.js';
import { fakeClaudePath, fakeEnv, mkTmp } from './helpers.js';

/** A `claude` double that reports `version` (and logs each run to `<dir>/<name>.ran`). */
function versionFake(dir: string, name: string, version: string): string {
  const p = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(
    p,
    `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(path.join(dir, `${name}.ran`))}, process.argv.slice(2).join(' ') + '\\n');
process.stdout.write(${JSON.stringify(`${version} (Claude Code)\n`)});
`,
  );
  return p;
}

describe('findClaudeBinary precedence', () => {
  const dir = mkTmp();
  const cli = versionFake(dir, 'cli', '2.1.401');
  const envBin = versionFake(dir, 'env', '2.1.402');
  const setting = versionFake(dir, 'setting', '2.1.403');

  it('$KIRO_CLAUDE_BIN wins over the kiroClaude.claudePath setting', async () => {
    const bin = await findClaudeBinary({ settingPath: setting, env: fakeEnv({ KIRO_CLAUDE_BIN: envBin }) });
    assert.equal(bin.path, envBin);
    assert.equal(bin.version, '2.1.402');
  });

  it('an explicit command-line path wins over both', async () => {
    const bin = await findClaudeBinary({ explicitPath: cli, settingPath: setting, env: fakeEnv({ KIRO_CLAUDE_BIN: envBin }) });
    assert.equal(bin.version, '2.1.401');
  });

  it('the setting is used when $KIRO_CLAUDE_BIN is unset (and beats PATH)', async () => {
    const pathDir = mkTmp();
    fs.symlinkSync(envBin, path.join(pathDir, 'claude'));
    const bin = await findClaudeBinary({
      settingPath: setting,
      env: fakeEnv({ KIRO_CLAUDE_BIN: undefined, PATH: `${pathDir}${path.delimiter}${process.env.PATH ?? ''}` }),
    });
    assert.equal(bin.version, '2.1.403');
  });

  it('a broken $KIRO_CLAUDE_BIN is an error even with a working setting (no silent fallback)', async () => {
    await assert.rejects(
      findClaudeBinary({ settingPath: setting, env: fakeEnv({ KIRO_CLAUDE_BIN: path.join(dir, 'missing-claude') }) }),
      (e: unknown) => e instanceof ClaudeNotFoundError && /KIRO_CLAUDE_BIN/.test(e.message),
    );
  });

  it('a broken setting is an error naming the setting', async () => {
    await assert.rejects(
      findClaudeBinary({ settingPath: path.join(dir, 'nope'), env: fakeEnv({ KIRO_CLAUDE_BIN: undefined }) }),
      (e: unknown) => e instanceof ClaudeNotFoundError && /kiroClaude\.claudePath/.test(e.message),
    );
  });

  it('chat sessions: $KIRO_CLAUDE_BIN beats the global kiroClaude.claudePath', async () => {
    const t = makeEnv();
    try {
      // Two working doubles: fake-claude.mjs logging to different files.
      const wrap = (name: string): { bin: string; log: string } => {
        const log = path.join(t.root, `${name}.log`);
        const bin = path.join(t.root, `${name}-claude.mjs`);
        fs.writeFileSync(bin, `process.env.FAKE_CLAUDE_LOG = ${JSON.stringify(log)};\nawait import(${JSON.stringify(pathToFileURL(fakeClaudePath()).href)});\n`);
        return { bin, log };
      };
      const fromEnv = wrap('env');
      const fromSetting = wrap('setting');
      t.write(path.join(t.kiroHome, 'settings', 'kiro-claude.json'), { 'kiroClaude.claudePath': fromSetting.bin });
      const r = await run(t, ['chat', '--no-interactive', 'say hi'], { env: { KIRO_CLAUDE_BIN: fromEnv.bin } });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(fs.existsSync(fromEnv.log), 'the $KIRO_CLAUDE_BIN claude ran the session');
      assert.ok(!fs.existsSync(fromSetting.log), 'the setting claude never ran');
      // Without $KIRO_CLAUDE_BIN the setting applies.
      const r2 = await run(t, ['chat', '--no-interactive', 'say hi'], { env: { KIRO_CLAUDE_BIN: undefined } });
      assert.equal(r2.code, 0, r2.stderr);
      assert.ok(fs.existsSync(fromSetting.log));
    } finally {
      t.cleanup();
    }
  });

  it('CLI commands (locateClaude): $KIRO_CLAUDE_BIN beats the global kiroClaude.claudePath', async () => {
    const t = makeEnv({ KIRO_CLAUDE_BIN: envBin });
    try {
      t.write(path.join(t.kiroHome, 'settings', 'kiro-claude.json'), { 'kiroClaude.claudePath': setting });
      const { ctx } = makeCtx(t);
      const loc = await locateClaude(ctx);
      assert.equal(loc.bin?.path, envBin);
      const t2 = makeEnv({ KIRO_CLAUDE_BIN: undefined });
      try {
        t2.write(path.join(t2.kiroHome, 'settings', 'kiro-claude.json'), { 'kiroClaude.claudePath': setting });
        const loc2 = await locateClaude(makeCtx(t2).ctx);
        assert.equal(loc2.bin?.path, setting, 'the setting applies without $KIRO_CLAUDE_BIN');
      } finally {
        t2.cleanup();
      }
    } finally {
      t.cleanup();
    }
  });
});
