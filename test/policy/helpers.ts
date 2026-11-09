/** Shared fixtures for policy tests: temp workspaces, agents, a fake hook runner. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { removeOnExit } from '../tmpdirs.js';
import type {
  AgentSpawnHookResult,
  HookRunContext,
  HookRunnerLike,
  KiroAgent,
  KiroHook,
  KiroToolCall,
  PostToolHookResult,
  PreToolHookResult,
  SessionTrust,
  StopHookResult,
  ToolOutcome,
  UserPromptHookResult,
  WorkspaceContext,
} from '../../src/types.js';

export interface TempWs {
  ws: WorkspaceContext;
  root: string;
  home: string;
  cleanup(): void;
}

/** Temp workspace: `<tmp>/home` (HOME, with `.kiro`), `<tmp>/home/proj` (cwd + workspace root with `.kiro/`). */
export function makeWs(opts: { cwdSub?: string; kiroHome?: string } = {}): TempWs {
  const base = removeOnExit(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-policy-'))));
  const home = path.join(base, 'home');
  const root = path.join(home, 'proj');
  fs.mkdirSync(path.join(root, '.kiro'), { recursive: true });
  fs.mkdirSync(path.join(home, '.kiro'), { recursive: true });
  const cwd = opts.cwdSub ? path.join(root, opts.cwdSub) : root;
  fs.mkdirSync(cwd, { recursive: true });
  const kiroHome = opts.kiroHome ?? path.join(home, '.kiro');
  const ws: WorkspaceContext = {
    cwd,
    workspaceRoot: root,
    kiroHome,
    home,
    env: { HOME: home, KIRO_HOME: kiroHome, PROJ: root },
  };
  return { ws, root, home, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export function makeAgent(p: Partial<KiroAgent> = {}): KiroAgent {
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
    ...p,
  };
}

export function emptyTrust(p: Partial<SessionTrust> = {}): SessionTrust {
  return { trustAll: false, allowedTools: [], rules: [], ...p };
}

export interface HookCallLog {
  pre: KiroToolCall[];
  post: { call: KiroToolCall; outcome: ToolOutcome }[];
  file: { trigger: string; path: string; call: KiroToolCall }[];
}

/** Programmable fake HookRunnerLike. */
export class FakeHooks implements HookRunnerLike {
  readonly hooks: readonly KiroHook[] = [];
  readonly log: HookCallLog = { pre: [], post: [], file: [] };
  pre: (call: KiroToolCall) => PreToolHookResult | Promise<PreToolHookResult> = () => ({ blocked: false, warnings: [] });
  post: (call: KiroToolCall, o: ToolOutcome) => PostToolHookResult = () => ({ warnings: [] });
  fileHook: (trigger: string, p: string) => PostToolHookResult = () => ({ warnings: [] });

  async runSessionStart(_ctx: HookRunContext): Promise<AgentSpawnHookResult> {
    return { outputs: [], agentPrompts: [], warnings: [] };
  }
  async runUserPromptSubmit(_ctx: HookRunContext & { prompt: string }): Promise<UserPromptHookResult> {
    return { outputs: [], agentPrompts: [], warnings: [] };
  }
  async runPreToolUse(_ctx: HookRunContext, call: KiroToolCall): Promise<PreToolHookResult> {
    this.log.pre.push(call);
    return this.pre(call);
  }
  async runPostToolUse(_ctx: HookRunContext, call: KiroToolCall, outcome: ToolOutcome): Promise<PostToolHookResult> {
    this.log.post.push({ call, outcome });
    return this.post(call, outcome);
  }
  async runStop(): Promise<StopHookResult> {
    return { warnings: [] };
  }
  async runSessionEnd(): Promise<{ warnings: [] }> {
    return { warnings: [] };
  }
  async runFileHook(
    _ctx: HookRunContext,
    trigger: 'PostFileCreate' | 'PostFileSave' | 'PostFileDelete',
    filePath: string,
    call: KiroToolCall,
  ): Promise<PostToolHookResult> {
    this.log.file.push({ trigger, path: filePath, call });
    return this.fileHook(trigger, filePath);
  }
  async runTaskHook(): Promise<{ blocked: boolean; agentPrompts: string[]; warnings: [] }> {
    return { blocked: false, agentPrompts: [], warnings: [] };
  }
  async runManual(): Promise<{ found: boolean; warnings: [] }> {
    return { found: false, warnings: [] };
  }
}
