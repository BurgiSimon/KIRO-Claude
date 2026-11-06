/**
 * Agent `resources` resolution (02 §2.9–2.11, 06 §4.2, 00 §2.2).
 *
 * `file://` rules (Q `process_path`, with the 00 DECISION that relative paths resolve
 * against the workspace root, not the cwd):
 *  - `~/` expands (`~/.kiro/…` ⇒ `$KIRO_HOME/…`); absolute paths are used as is;
 *  - a spec with glob meta (`*`, `?`, `[`) is expanded with the Rust `glob`-crate dialect
 *    (util/glob.walkGlob: `*` within one component, `**` = any directories, no braces) and
 *    only regular files are kept;
 *  - a plain path that is a file ⇒ that file; a directory ⇒ its files, non-recursively;
 *    missing ⇒ no paths (silently, like Q);
 *  - each path is listed once (first rule wins); `.kiroignore`d paths are dropped.
 *
 * Default resources (00 §2.2, §8 C5): when `agent.inheritDefaultResources` is true, steering
 * files and AGENTS.md files are owned by config/steering.ts (front matter, inclusion modes),
 * so any of them matched by a `file://` rule here is dropped to avoid loading it twice; the
 * default skill dirs are covered by `discoverSkills(…, { includeDefaults: true })`. The
 * README.md / AmazonQ.md defaults exist only in the built-in `kiro_default` agent's own
 * `resources` (02 §2.11 decision), so nothing else is added here.
 *
 * `skill://` entries are returned verbatim in `skillUris` (resolve with
 * config/skills.discoverSkills); knowledge-base objects in `knowledgeBases` (unsupported by
 * kiro-claude: listed only).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentResource, ConfigWarning, KiroAgent, WorkspaceContext } from '../types.js';
import { validateGlob, walkGlob } from '../util/glob.js';
import { realpathSafe } from '../util/paths.js';
import { loadKiroIgnore } from './kiroignore.js';
import { findAgentsMd, loadSteering } from './steering.js';
import { resolveSpec, stripScheme } from './uri.js';

export interface ResolvedResources {
  /** One entry per `file://` rule, `pattern` = the rule without its scheme. */
  files: { pattern: string; paths: string[] }[];
  skillUris: string[];
  knowledgeBases: AgentResource[];
  warnings: ConfigWarning[];
}

/** Expand one `file://` spec (without scheme) to absolute file paths (see module doc). */
export function expandFileSpec(spec: string, ws: WorkspaceContext): { paths: string[]; error?: string } {
  const r = resolveSpec(spec.trim(), ws);
  if (r.glob) {
    const err = validateGlob(r.pattern.replace(/\\/g, '/'), 'path', { windows: false });
    if (err) return { paths: [], error: err };
    return { paths: walkGlob(r.pattern, { cwd: r.cwd, env: ws.env, onlyFiles: true }) };
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(r.abs);
  } catch {
    return { paths: [] };
  }
  if (st.isFile()) return { paths: [r.abs] };
  if (st.isDirectory()) {
    let names: string[];
    try {
      names = fs.readdirSync(r.abs).sort();
    } catch {
      return { paths: [] };
    }
    return {
      paths: names
        .map((n) => path.join(r.abs, n))
        .filter((p) => {
          try {
            return fs.statSync(p).isFile();
          } catch {
            return false;
          }
        }),
    };
  }
  return { paths: [] };
}

/** Real paths of every file config/steering.ts loads by default (steering + AGENTS.md). */
export function defaultContextPaths(ws: WorkspaceContext): Set<string> {
  const out = new Set<string>();
  for (const f of loadSteering(ws).files) out.add(realpathSafe(f.path));
  for (const p of findAgentsMd(ws)) out.add(realpathSafe(p));
  return out;
}

/** Resolve an agent's resources (see module doc). */
export function resolveResources(ws: WorkspaceContext, agent: Pick<KiroAgent, 'resources' | 'inheritDefaultResources' | 'name'>): ResolvedResources {
  const out: ResolvedResources = { files: [], skillUris: [], knowledgeBases: [], warnings: [] };
  const ignore = loadKiroIgnore(ws);
  let defaults: Set<string> | undefined;
  const skip = (p: string): boolean => {
    if (!agent.inheritDefaultResources) return false;
    defaults ??= defaultContextPaths(ws);
    return defaults.has(realpathSafe(p));
  };
  const seen = new Set<string>();
  for (const r of agent.resources) {
    if (r.kind === 'file') {
      const spec = stripScheme(r.uri, 'file') ?? r.uri;
      const res = expandFileSpec(spec, ws);
      if (res.error) {
        out.warnings.push({ code: 'resource-glob', message: `Agent '${agent.name}': invalid resource ${r.uri}: ${res.error}` });
      }
      const paths: string[] = [];
      for (const p of res.paths) {
        const real = realpathSafe(p);
        if (seen.has(real)) continue;
        seen.add(real);
        if (ignore.isIgnored(p) || skip(p)) continue;
        paths.push(p);
      }
      out.files.push({ pattern: spec, paths });
    } else if (r.kind === 'skill') {
      if (!out.skillUris.includes(r.uri)) out.skillUris.push(r.uri);
    } else {
      out.knowledgeBases.push(r);
    }
  }
  return out;
}
