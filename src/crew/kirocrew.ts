/**
 * Runs KiroCrew's own CLI, `<KCDIR>/bin/kirocrew` (V16: the launcher sets `KIROCREW_PROJECT_DIR`
 * and execs `.venv/bin/kirocrew`), always with the gateway environment (08 §3.7).
 *
 * Used verbs (SRC, 08 §3.3 step 5, §3.8; 08b §2):
 * - `--version` → `kirocrew 0.13.0 (source checkout, not a release build)`;
 * - `config get` (no key) → the effective config as indented JSON (`config get <key>` prints
 *   Python reprs such as `False` for scalars, so the whole-dict form is parsed instead);
 * - `config set <key> <value>` — keyed only: `config set --file` REPLACES the whole config.json
 *   (V12), so it is never used;
 * - `gateway-pid` → one JSON object: `{"holder":"process","pid":N,"alive":true,"source":…}`,
 *   `{"holder":"nobody"}`, `{"holder":"held",…}` (exit 0) or `{"holder":"indeterminate",…}` (exit 2);
 * - `stop`, `token --port <p> --ttl <t>` (stdout carries only the URL), `doctor`.
 *
 * Keys absent from config.json cannot be removed with `config set` (KiroCrew has only get/set,
 * SRC `cli_parser_gateway.py:402-404`), so {@link editConfigJson} edits the file directly; callers
 * only do that while the gateway is stopped (08 §3.6, §3.8 `uninstall`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { extractJsonObject } from '../claude/auth.js';
import { writeJsonAtomic } from '../util/fsx.js';
import { kirocrewLauncher } from './paths.js';
import { KIROCREW_VERSION_RE } from './pin.js';
import type { CrewRunner, RunOptions, RunResult } from './runner.js';
import type { MembersBackend } from './state.js';

/** Python cold start of the KiroCrew CLI is ~4.6 s (08b §1.2); allow generous headroom. */
export const KIROCREW_CLI_TIMEOUT_MS = 180_000;

export type GatewayHolder =
  | { holder: 'process'; pid: number; alive: boolean; source?: string }
  | { holder: 'nobody' }
  | { holder: 'held'; reason?: string }
  | { holder: 'indeterminate'; reason: string };

/** True when the holder answer names a live gateway. */
export function gatewayRunning(h: GatewayHolder): boolean {
  return (h.holder === 'process' && h.alive) || h.holder === 'held';
}

/** The config keys crew owns, in setup order (08 §3.6; `member_acp_backend` only for members = claude). */
export function desiredConfig(members: MembersBackend): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [
    ['agent.acp_backend', 'kiro'],
    ['agent.kas_bundle', false],
  ];
  if (members === 'claude') out.push(['agent.member_acp_backend', 'claude']);
  out.push(['auto_update', false]);
  return out;
}

/** The value text passed to `kirocrew config set` (KiroCrew parses it as JSON when it can). */
export function configValueArg(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

const MISSING = Symbol('missing');

/** Dotted lookup (`agent.acp_backend`) in a nested object; `MISSING` when absent. */
export function dottedGet(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return MISSING;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function isMissing(v: unknown): boolean {
  return v === MISSING;
}

/** Loose equality for config values (`"false"` vs `false`, `"kiro"` vs `kiro`). */
export function configValueEquals(actual: unknown, wanted: unknown): boolean {
  if (actual === wanted) return true;
  if (typeof wanted === 'boolean') {
    if (typeof actual === 'string') return actual.trim().toLowerCase() === String(wanted);
    return false;
  }
  if (typeof wanted === 'string' && typeof actual === 'string') return actual.trim() === wanted;
  return false;
}

/** Raw values of `keys` in KiroCrew's config.json (`null` when absent or the file is missing). */
export function readRawConfigValues(configFile: string, keys: readonly string[]): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    data = undefined;
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = data === undefined ? MISSING : dottedGet(data, k);
    out[k] = v === MISSING ? null : v;
  }
  return out;
}

/**
 * Edits KiroCrew's config.json in place: `value === undefined` deletes the dotted key (empty parent
 * objects are kept), anything else sets it. Returns false when the file does not exist (nothing
 * to edit) and leaves an unparsable file untouched (throws).
 */
export function editConfigJson(configFile: string, edits: Record<string, unknown>): boolean {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  const data = JSON.parse(text) as unknown;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${configFile} is not a JSON object`);
  for (const [key, value] of Object.entries(edits)) {
    const parts = key.split('.');
    let cur = data as Record<string, unknown>;
    let ok = true;
    for (const p of parts.slice(0, -1)) {
      const next = cur[p];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        if (value === undefined) {
          ok = false;
          break;
        }
        cur[p] = {};
      }
      cur = cur[p] as Record<string, unknown>;
    }
    if (!ok) continue;
    const last = parts[parts.length - 1]!;
    if (value === undefined) delete cur[last];
    else cur[last] = value;
  }
  let mode = 0o600;
  try {
    mode = fs.statSync(configFile).mode & 0o777;
  } catch {
    // keep default
  }
  writeJsonAtomic(configFile, data, { mode });
  return true;
}

/**
 * argv: JSON list of dotted keys → prints `{"removed":[…]}`. Runs in KiroCrew's own venv so the
 * edit goes through `update_config_locked` (sidecar `config.json.lock`, provenance record), the
 * "locked JSON edit" of 08 §3.6/§3.8. Verified against the 08b build of KiroCrew 0.13.0.
 */
export const PY_REMOVE_CONFIG_KEYS = String.raw`
import json, sys
from kiro_crew.config.loader import update_config_locked, config_path
keys = json.loads(sys.argv[1])
removed = []
def mutate(cur):
    for key in keys:
        parts = key.split(".")
        d = cur
        for p in parts[:-1]:
            d = d.get(p) if isinstance(d, dict) else None
        if isinstance(d, dict) and parts[-1] in d:
            del d[parts[-1]]
            removed.append(key)
    return cur if removed else None
update_config_locked(config_path(), mutate=mutate)
print(json.dumps({"removed": removed}))
`;

/** Parses `kirocrew gateway-pid` stdout (last JSON object line). */
export function parseGatewayPid(stdout: string, code: number | null): GatewayHolder {
  const j = extractJsonObject(lastJsonLine(stdout) ?? stdout);
  if (!j) return { holder: 'indeterminate', reason: `gateway-pid printed no JSON (exit ${code ?? 'signal'})` };
  if (j.holder === 'process' && typeof j.pid === 'number') {
    return { holder: 'process', pid: j.pid, alive: j.alive !== false, source: typeof j.source === 'string' ? j.source : undefined };
  }
  if (j.holder === 'nobody') return { holder: 'nobody' };
  if (j.holder === 'held') return { holder: 'held', reason: typeof j.reason === 'string' ? j.reason : undefined };
  return { holder: 'indeterminate', reason: typeof j.reason === 'string' ? j.reason : `unexpected gateway-pid answer: ${JSON.stringify(j)}` };
}

function lastJsonLine(text: string): string | undefined {
  const lines = text.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim().startsWith('{')) return lines[i]!.trim();
  return undefined;
}

/** First `http(s)://…` URL printed by `kirocrew token`. */
export function parseTokenUrl(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /(https?:\/\/\S+)/.exec(line.trim());
    if (m) return m[1];
  }
  return undefined;
}

/** The `token` query parameter of a dashboard URL. */
export function tokenFromUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}

export class KiroCrewCli {
  readonly launcher: string;
  constructor(private readonly opts: { dir: string; env: NodeJS.ProcessEnv; runner: CrewRunner; cwd?: string }) {
    this.launcher = kirocrewLauncher(opts.dir);
  }

  get dir(): string {
    return this.opts.dir;
  }

  run(args: readonly string[], extra: RunOptions = {}): Promise<RunResult> {
    return this.opts.runner.run(this.launcher, args, {
      cwd: this.opts.cwd ?? this.opts.dir,
      env: this.opts.env,
      timeoutMs: KIROCREW_CLI_TIMEOUT_MS,
      ...extra,
    });
  }

  /** `--version`: `{ok, line}` (ok when it names the pinned 0.13.0). */
  async version(): Promise<{ ok: boolean; line: string; result: RunResult }> {
    const r = await this.run(['--version']);
    const line = (r.stdout.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
    return { ok: r.code === 0 && KIROCREW_VERSION_RE.test(r.stdout), line, result: r };
  }

  /** Effective config (`config get` with no key), or `undefined` when it cannot be read. */
  async configGetAll(): Promise<{ config?: Record<string, unknown>; result: RunResult }> {
    const r = await this.run(['config', 'get']);
    if (r.code !== 0) return { result: r };
    return { config: extractJsonObject(r.stdout), result: r };
  }

  configSet(key: string, value: unknown): Promise<RunResult> {
    return this.run(['config', 'set', key, configValueArg(value)]);
  }

  async gatewayPid(): Promise<GatewayHolder> {
    const r = await this.run(['gateway-pid'], { timeoutMs: 60_000 });
    if (r.error) return { holder: 'indeterminate', reason: `cannot run ${this.launcher}: ${r.error}` };
    if (r.timedOut) return { holder: 'indeterminate', reason: 'gateway-pid timed out' };
    return parseGatewayPid(r.stdout, r.code);
  }

  stop(): Promise<RunResult> {
    return this.run(['stop'], { timeoutMs: 120_000 });
  }

  /** `token --port <p> --ttl <ttl>` → the sign-in URL. */
  async token(port: number, ttl: string): Promise<{ url?: string; result: RunResult }> {
    const r = await this.run(['token', '--port', String(port), '--ttl', ttl], { timeoutMs: 60_000 });
    return { url: r.code === 0 ? parseTokenUrl(r.stdout) : undefined, result: r };
  }

  doctor(): Promise<RunResult> {
    return this.run(['doctor'], { timeoutMs: 300_000 });
  }

  /**
   * Removes dotted keys from config.json (KiroCrew has no `config unset`). Uses KiroCrew's locked
   * writer through `<dir>/.venv/bin/python` when the checkout is built; otherwise, or when that
   * fails, falls back to a direct atomic edit of `configFile` (callers do this only while the
   * gateway is stopped). Returns the keys removed and how.
   */
  async removeConfigKeys(keys: readonly string[], configFile: string): Promise<{ removed: string[]; via: 'kirocrew' | 'direct'; warning?: string }> {
    if (keys.length === 0) return { removed: [], via: 'direct' };
    const py = path.join(this.opts.dir, '.venv', 'bin', 'python');
    let warning: string | undefined;
    if (fs.existsSync(py)) {
      const r = await this.opts.runner.run(py, ['-I', '-c', PY_REMOVE_CONFIG_KEYS, JSON.stringify(keys)], {
        cwd: this.opts.cwd ?? this.opts.dir,
        env: this.opts.env,
        timeoutMs: 60_000,
      });
      const j = r.code === 0 ? extractJsonObject(lastJsonLine(r.stdout) ?? '') : undefined;
      if (j && Array.isArray(j.removed)) return { removed: j.removed.filter((k): k is string => typeof k === 'string'), via: 'kirocrew' };
      warning = `Kiro Crew's locked config writer failed (${r.error ?? `exit ${r.code ?? r.signal}`}: ${(r.stderr || r.stdout).trim().split(/\r?\n/).pop() ?? ''}); edited ${configFile} directly`;
    }
    const before = readRawConfigValues(configFile, keys);
    const edits: Record<string, undefined> = {};
    for (const k of keys) edits[k] = undefined;
    editConfigJson(configFile, edits);
    return { removed: keys.filter((k) => before[k] !== null), via: 'direct', warning };
  }
}
