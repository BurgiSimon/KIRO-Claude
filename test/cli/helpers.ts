/**
 * Helpers for the CLI and headless suites: isolated temp homes, captured streams, an in-process
 * runner (cli/main runCli) and a subprocess runner for the built binary.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { createCliContext, runCli } from '../../src/cli/main.js';
import type { CliContext } from '../../src/types.js';
import { fakeClaudePath } from '../claude/helpers.js';

// Keep the shared file logger away from the real temp dirs.
process.env.KIRO_CHAT_LOG_FILE ??= path.join(os.tmpdir(), `kc-cli-test-${process.pid}.log`);

export { fakeClaudePath };

/** A writable that records everything (and claims not to be a TTY). */
export class Capture extends Writable {
  text = '';
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

/** A readable stdin with fixed content (`isTTY` configurable). */
export function stdinOf(text: string | undefined, isTTY = false): NodeJS.ReadStream {
  const r = Readable.from(text === undefined ? [] : [Buffer.from(text)]) as unknown as NodeJS.ReadStream & { isTTY?: boolean };
  r.isTTY = isTTY;
  return r;
}

export interface TestEnv {
  root: string;
  home: string;
  cwd: string;
  kiroHome: string;
  env: NodeJS.ProcessEnv;
  fakeLog: string;
  /** Lines of the fake-claude log. */
  fakeLogLines(): Array<Record<string, unknown>>;
  write(rel: string, content: string | object): string;
  cleanup(): void;
}

/** Fresh temp home + workspace; KIRO_CLAUDE_BIN points at fake-claude. */
export function makeEnv(extra: Record<string, string | undefined> = {}): TestEnv {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-cli-')));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const fakeLog = path.join(root, 'fake.log');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    LANG: 'C.UTF-8',
    KIRO_CLAUDE_BIN: fakeClaudePath(),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_RUNTIME_DIR: path.join(root, 'run'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    KIRO_CHAT_LOG_FILE: path.join(root, 'kiro.log'),
    FAKE_CLAUDE_LOG: fakeLog,
    NO_COLOR: '1',
    ...extra,
  };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return {
    root,
    home,
    cwd,
    kiroHome: path.join(home, '.kiro'),
    env,
    fakeLog,
    fakeLogLines() {
      try {
        return fs
          .readFileSync(fakeLog, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => JSON.parse(l) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
    write(rel: string, content: string | object): string {
      const p = path.isAbsolute(rel) ? rel : path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      return p;
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in-process with captured streams. */
export async function run(
  t: TestEnv,
  argv: string[],
  opts: { stdin?: string; stdinTTY?: boolean; argv1?: string; cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const env = { ...t.env, ...(opts.env ?? {}) };
  for (const [k, v] of Object.entries(opts.env ?? {})) if (v === undefined) delete env[k];
  const code = await runCli(argv, {
    stdin: stdinOf(opts.stdin, opts.stdinTTY ?? false),
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    env,
    cwd: opts.cwd ?? t.cwd,
    argv1: opts.argv1 ?? '/usr/local/bin/kiro-claude',
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** A CliContext with captured streams (for calling command runners directly). */
export function makeCtx(
  t: TestEnv,
  opts: { stdin?: string; stdinTTY?: boolean; cwd?: string; progName?: string } = {},
): { ctx: CliContext; stdout: Capture; stderr: Capture } {
  const stdout = new Capture();
  const stderr = new Capture();
  const ctx = createCliContext(
    {
      stdin: stdinOf(opts.stdin, opts.stdinTTY ?? false),
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      env: t.env,
      cwd: opts.cwd ?? t.cwd,
      argv1: `/x/${opts.progName ?? 'kiro-claude'}`,
    },
    0,
  );
  return { ctx, stdout, stderr };
}

/** Path of the built CLI entry (this file is compiled to <out>/test/cli/helpers.js). */
export function builtBin(): string {
  return fileURLToPath(new URL('../../src/bin/kiro-claude.js', import.meta.url));
}

/** Run the built binary as a subprocess (stdin = /dev/null unless given). */
export function spawnCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  opts: { cwd?: string; input?: string; timeoutMs?: number } = {},
): RunResult & { ms: number } {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [builtBin(), ...argv], {
    env,
    cwd: opts.cwd,
    input: opts.input ?? '',
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 30_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}
