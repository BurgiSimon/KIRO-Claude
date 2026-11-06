/**
 * Temp-dir fixtures for config/ tests: a fake HOME (so `~/.kiro` is private), a workspace
 * outside it, and helpers to write files. Never touches the real ~/.kiro or ~/.claude.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkspaceContext } from '../../src/types.js';
import { createWorkspaceContext } from '../../src/config/workspace.js';

export interface Fixture {
  /** Temp root (realpath). */
  root: string;
  /** Fake HOME. */
  home: string;
  /** `<home>/.kiro` unless KIRO_HOME is overridden. */
  kiroHome: string;
  /** Workspace root (has `.kiro/` once something is written there). */
  ws: string;
  env: NodeJS.ProcessEnv;
  /** Write `content` (string or JSON value) to `p` (absolute, or relative to `root`). Returns the absolute path. */
  write(p: string, content: unknown): string;
  mkdir(p: string): string;
  ctx(cwd?: string, extraEnv?: NodeJS.ProcessEnv): WorkspaceContext;
  cleanup(): void;
}

export function makeFixture(prefix = 'kc-config-'): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH ?? '' };
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(root, p));
  return {
    root,
    home,
    kiroHome: path.join(home, '.kiro'),
    ws,
    env,
    write(p: string, content: unknown): string {
      const a = abs(p);
      fs.mkdirSync(path.dirname(a), { recursive: true });
      fs.writeFileSync(a, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
      return a;
    },
    mkdir(p: string): string {
      const a = abs(p);
      fs.mkdirSync(a, { recursive: true });
      return a;
    },
    ctx(cwd?: string, extraEnv?: NodeJS.ProcessEnv): WorkspaceContext {
      return createWorkspaceContext(cwd ?? ws, { ...env, ...(extraEnv ?? {}) });
    },
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Codes of a warning list (for compact assertions). */
export function codes(ws: readonly { code: string }[]): string[] {
  return ws.map((w) => w.code);
}
