/**
 * `crew.json` — the state written by `crew setup` and read by every crew command
 * (08-kirocrew-integration §3.2). Mode 0600, atomic replace. Never holds secrets (§3.7 item 5):
 * the dashboard token lives only in `run/token` / `run/ready.json`.
 *
 * Shape (§3.2, plus three fields of ours, marked):
 * ```json
 * {"version":1,
 *  "kirocrew":{"dir","url","commit","build":"light|full|none","python","source"(ours)},
 *  "shim","node","entry","claude",
 *  "members":{"backend":"claude|none","adapter"},
 *  "port":5476,
 *  "identityStub":{"created":true,"path","optOut"(ours),"createdDir"(ours)},
 *  "previousConfig":{"agent.acp_backend":null,…},
 *  "env":{"KIROCREW_SKIP_MODEL_DOWNLOAD":"1","KIROCREW_SKIP_APP_STORE_FETCH":"1"},
 *  "kiroBinOverride"(ours: the test-only `crew start --kiro-bin`)}
 * ```
 */
import * as fs from 'node:fs';

import { writeJsonAtomic } from '../util/fsx.js';
import type { CheckoutSource } from './paths.js';

export type BuildKind = 'light' | 'full' | 'none';
export type MembersBackend = 'claude' | 'none';

export interface CrewState {
  version: 1;
  kirocrew: {
    dir: string;
    url: string;
    commit: string;
    build: BuildKind;
    python?: string;
    source?: CheckoutSource;
  };
  shim: string;
  node: string;
  entry: string;
  claude: string;
  members: { backend: MembersBackend; adapter?: string };
  port: number;
  identityStub: { created: boolean; path: string; optOut?: boolean; createdDir?: boolean };
  /** Values the config keys had in KiroCrew's config.json before the first setup (`null` = absent). */
  previousConfig: Record<string, unknown>;
  /** Extra gateway env recorded by setup (`--with-embeddings` / `--app-store` drop the skips). */
  env: Record<string, string>;
  kiroBinOverride?: string;
}

export class CrewStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrewStateError';
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Validates a parsed crew.json (lenient on optional fields, strict on the ones commands need). */
export function parseState(data: unknown, file: string): CrewState {
  if (!isObj(data)) throw new CrewStateError(`${file} is not a JSON object`);
  if (data.version !== 1) throw new CrewStateError(`${file}: unsupported version ${JSON.stringify(data.version)}`);
  const kc = data.kirocrew;
  if (!isObj(kc) || !str(kc.dir)) throw new CrewStateError(`${file}: missing kirocrew.dir`);
  const members = isObj(data.members) ? data.members : {};
  const stub = isObj(data.identityStub) ? data.identityStub : {};
  const env: Record<string, string> = {};
  if (isObj(data.env)) for (const [k, v] of Object.entries(data.env)) if (typeof v === 'string') env[k] = v;
  const build = kc.build === 'full' || kc.build === 'none' ? kc.build : 'light';
  const state: CrewState = {
    version: 1,
    kirocrew: {
      dir: kc.dir as string,
      url: str(kc.url) ?? '',
      commit: str(kc.commit) ?? '',
      build,
      python: str(kc.python),
      source: str(kc.source) as CheckoutSource | undefined,
    },
    shim: str(data.shim) ?? '',
    node: str(data.node) ?? '',
    entry: str(data.entry) ?? '',
    claude: str(data.claude) ?? '',
    members: {
      backend: members.backend === 'none' ? 'none' : 'claude',
      adapter: str(members.adapter),
    },
    port: typeof data.port === 'number' && Number.isInteger(data.port) && data.port > 0 && data.port < 65536 ? data.port : 5476,
    identityStub: {
      created: stub.created === true,
      path: str(stub.path) ?? '',
      optOut: stub.optOut === true ? true : undefined,
      createdDir: stub.createdDir === true ? true : undefined,
    },
    previousConfig: isObj(data.previousConfig) ? { ...data.previousConfig } : {},
    env,
    kiroBinOverride: str(data.kiroBinOverride),
  };
  return state;
}

/** Reads crew.json; `undefined` when it does not exist. Throws {@link CrewStateError} when unreadable/invalid. */
export function readState(file: string): CrewState | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CrewStateError(`cannot read ${file}: ${(e as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new CrewStateError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  return parseState(data, file);
}

/** Writes crew.json atomically with mode 0600 (undefined optional fields are dropped). */
export function writeState(file: string, state: CrewState): void {
  const clean = JSON.parse(JSON.stringify(state)) as unknown;
  writeJsonAtomic(file, clean, { mode: 0o600 });
}
