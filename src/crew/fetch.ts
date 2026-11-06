/**
 * `crew setup` step 1: get KiroCrew at the pinned commit (08-kirocrew-integration §0 item 7,
 * §3.3 step 1, §4.1; V1–V3: upstream `main` has moved on, so the pin is fetched by SHA).
 *
 * - In-repo submodule: `git -C <root> submodule update --init --depth 1 vendor/KiroCrew` (V1).
 * - In-repo `--slim` (V2): `submodule init`, then in `$KCDIR`: `init -q` + `remote add origin <url>`
 *   (skipped when `$KCDIR/.git` exists), `sparse-checkout set --no-cone '/*' '!/temp-screenshots/'`,
 *   `fetch --depth 1 --filter=blob:none origin <sha>`, `checkout -q --detach FETCH_HEAD`, then
 *   `git -C <root> submodule absorbgitdirs vendor/KiroCrew`.
 * - No superproject (npm installs, `--dir` to a new directory): the same `$KCDIR` commands without
 *   the `submodule` lines (sparse + blob filter only with `--slim`).
 * - Then verify `git -C $KCDIR rev-parse HEAD` equals the pin, else fail with
 *   `KiroCrew checkout is at <x>, expected 665a0e4…`.
 *
 * Idempotent: a checkout already at the pin is left alone. A checkout the user pointed us at
 * (`--dir`/`KIRO_CLAUDE_CREW_DIR`) is never moved to another commit; only our own `$CS/KiroCrew`
 * and the submodule are (re)fetched.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CheckoutLocation } from './paths.js';
import { KIROCREW_PIN, KIROCREW_SUBMODULE_PATH, shortSha } from './pin.js';
import { formatCommand, type CrewRunner, type RunResult } from './runner.js';

export class CrewStepError extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly command?: string,
    readonly output?: string,
  ) {
    super(message);
    this.name = 'CrewStepError';
  }
}

export interface FetchOptions {
  location: CheckoutLocation;
  runner: CrewRunner;
  git: string;
  env: NodeJS.ProcessEnv;
  slim?: boolean;
  logFile?: string;
  pin?: { url: string; commit: string };
}

export interface FetchResult {
  dir: string;
  commit: string;
  /** False when the checkout was already at the pin. */
  fetched: boolean;
  commands: string[];
}

/** `git -C <dir> rev-parse HEAD`, or `undefined` when `dir` is not a checkout. */
export async function gitHead(runner: CrewRunner, git: string, dir: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!fs.existsSync(path.join(dir, '.git'))) return undefined;
  const r = await runner.run(git, ['-C', dir, 'rev-parse', 'HEAD'], { env, timeoutMs: 60_000 });
  if (r.code !== 0) return undefined;
  const sha = r.stdout.trim().split(/\s+/)[0] ?? '';
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : undefined;
}

function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true; // missing counts as empty
  }
}

export async function fetchKiroCrew(opts: FetchOptions): Promise<FetchResult> {
  const pin = opts.pin ?? KIROCREW_PIN;
  const { location, runner, git, env } = opts;
  const dir = location.dir;
  const commands: string[] = [];

  const run = async (args: string[], what: string): Promise<RunResult> => {
    const cmd = formatCommand(git, args);
    commands.push(cmd);
    const r = await runner.run(git, args, { env, logFile: opts.logFile, timeoutMs: 30 * 60_000 });
    if (r.code !== 0) {
      const out = `${r.stdout}\n${r.stderr}`.trim();
      throw new CrewStepError('fetch', `${what} failed (${r.error ?? `exit ${r.code ?? r.signal}`})`, cmd, out);
    }
    return r;
  };

  const head = await gitHead(runner, git, dir, env);
  if (head === pin.commit) return { dir, commit: head, fetched: false, commands };

  const userDir = location.source === 'flag' || location.source === 'env';
  if (userDir && head !== undefined) {
    throw new CrewStepError(
      'fetch',
      `KiroCrew checkout is at ${shortSha(head)}, expected ${shortSha(pin.commit)} (${dir}). Check out ${pin.commit} there, or pass --no-fetch to use it as it is.`,
    );
  }
  // Any source: a non-empty directory that is not a git checkout (e.g. files copied into
  // vendor/KiroCrew) would make `submodule update` / `checkout` fail with a confusing error.
  if (head === undefined && !fs.existsSync(path.join(dir, '.git')) && !isEmptyDir(dir)) {
    throw new CrewStepError(
      'fetch',
      `${dir} exists but is not a git checkout; pass --no-fetch to use it as it is, or ${userDir ? 'choose an empty directory' : 'move it away'}.`,
    );
  }

  const shaFetch = async (): Promise<void> => {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.git'))) {
      await run(['-C', dir, 'init', '-q'], 'git init');
      await run(['-C', dir, 'remote', 'add', 'origin', pin.url], 'git remote add');
    } else {
      // An earlier run may have stopped between `init` and `remote add`.
      const r = await runner.run(git, ['-C', dir, 'remote', 'get-url', 'origin'], { env, timeoutMs: 60_000 });
      if (r.code !== 0) await run(['-C', dir, 'remote', 'add', 'origin', pin.url], 'git remote add');
    }
    if (opts.slim) await run(['-C', dir, 'sparse-checkout', 'set', '--no-cone', '/*', '!/temp-screenshots/'], 'git sparse-checkout');
    const fetchArgs = ['-C', dir, 'fetch', '--depth', '1'];
    if (opts.slim) fetchArgs.push('--filter=blob:none');
    fetchArgs.push('origin', pin.commit);
    await run(fetchArgs, `fetching KiroCrew ${shortSha(pin.commit)}`);
    await run(['-C', dir, 'checkout', '-q', '--detach', 'FETCH_HEAD'], 'git checkout');
  };

  if (location.source === 'submodule' && location.superproject) {
    const root = location.superproject;
    if (opts.slim) {
      await run(['-C', root, 'submodule', 'init', KIROCREW_SUBMODULE_PATH], 'git submodule init');
      await shaFetch();
      await run(['-C', root, 'submodule', 'absorbgitdirs', KIROCREW_SUBMODULE_PATH], 'git submodule absorbgitdirs');
    } else {
      await run(['-C', root, 'submodule', 'update', '--init', '--depth', '1', KIROCREW_SUBMODULE_PATH], 'git submodule update');
    }
  } else {
    await shaFetch();
  }

  const after = await gitHead(runner, git, dir, env);
  if (after !== pin.commit) {
    throw new CrewStepError('fetch', `KiroCrew checkout is at ${after ? shortSha(after) : 'an unknown commit'}, expected ${shortSha(pin.commit)} (${dir})`);
  }
  return { dir, commit: after, fetched: true, commands };
}
