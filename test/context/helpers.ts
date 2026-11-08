import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KiroAgent, SteeringFile, WorkspaceContext } from '../../src/types.js';
import { removeOnExit } from '../tmpdirs.js';

/** Temp workspace: `<tmp>/home` (HOME), `<tmp>/home/.kiro` (KIRO_HOME), `<tmp>/ws` (cwd/root). */
export function tmpWorkspace(): WorkspaceContext & { tmp: string } {
  const tmp = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-context-'))));
  const home = path.join(tmp, 'home');
  const kiroHome = path.join(home, '.kiro');
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(kiroHome, { recursive: true });
  fs.mkdirSync(path.join(ws, '.kiro'), { recursive: true });
  return { tmp, cwd: ws, workspaceRoot: ws, kiroHome, home, env: { HOME: home, KIRO_HOME: kiroHome } };
}

export function write(p: string, content: string | Buffer): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

export function agent(over: Partial<KiroAgent> = {}): KiroAgent {
  return {
    name: 'test-agent',
    format: 'json',
    scope: 'workspace',
    dialect: 'v2',
    tools: ['*'],
    excludedTools: [],
    mcpServers: {},
    includeMcpJson: false,
    useLegacyMcpJson: false,
    resources: [],
    hooks: [],
    permissions: [],
    allowedTools: [],
    toolsSettings: {},
    toolAliases: {},
    inheritDefaultResources: true,
    warnings: [],
    ...over,
  };
}

export function steering(over: Partial<SteeringFile> & Pick<SteeringFile, 'path' | 'name'>): SteeringFile {
  return { scope: 'workspace', inclusion: 'always', fileMatchPatterns: [], body: '', ...over };
}
