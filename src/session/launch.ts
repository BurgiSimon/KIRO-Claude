/**
 * Launch builder: everything one `claude` child needs — argv, the `initialize` request and the
 * generated files — for one Kiro agent (00 §3.1 spawn, §3.3 initialize, §2.2–2.3 decision
 * tables, §4.2 selectors, §6.1 system-prompt file; 08 KC-ENV-02/03/04, KC-SPEC-01/02).
 *
 * argv, in the 00 §3.1 order (every flag outside the core set is capability-gated through
 * `caps.has`, so only flags the installed Claude Code accepts are passed):
 *
 * ```
 * -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio
 * --include-partial-messages --permission-mode default --setting-sources <kiroClaude.claudeSettingSources|''>
 * --strict-mcp-config [--mcp-config <runtimeDir>/mcp.json]
 * --tools <list>                       always explicit ('' = none; tools: [] ⇒ zero tools, no MCP)
 * [--disallowedTools mcp__s__t,…]      excluded / disabledTools MCP tools
 * --append-system-prompt-file <runtimeDir>/context.md
 * --system-prompt-snapshot off
 * [--model <claude value>]             KIRO_CLAUDE_FORCE_MODEL wins over the requested Kiro model
 * [--effort <level>]
 * [--agents <runtimeDir>/agents.json]  other Kiro agents allowed as subagents (00 §2.5)
 * [--plugin-dir <runtimeDir>/kiro]     Kiro skills (00 §2.2)
 * [--add-dir <d>]…
 * --resume <id> [--fork-session] [--resume-session-at <uuid>] [--session-id <new id when forking>]
 *   | --session-id <id>
 * <kiroClaude.extraClaudeArgs…>        never --bare / --dangerously-skip-permissions / --allowedTools
 * ```
 *
 * MCP (02 §5, 08 KC-ENV-02, KC-SPEC-01): config/mcp `resolveMcpServers` (agent > workspace >
 * global, `includeMcpJson`, legacy files) merged with the client's `extraMcpServers` (ACP
 * `session/new.mcpServers`; a name clash is won by the client), disabled servers dropped,
 * then filtered by the agent's `tools` / `excludedTools` (policy/toolmap `expandToolSelectors`).
 * Servers named in `$ASBX_KIRO_MANDATORY_MCPS` get `alwaysLoad: true` (08 KC-ENV-03; accepted by
 * claude 2.1.318, checked during this work with a no-model `mcp_status` probe). The file is
 * written 0600 inside the 0700 runtime dir (it may carry per-session tokens).
 *
 * Context (00 §6.1): steering + AGENTS.md (when the agent inherits default resources, 00 §8
 * C5), agent `file://` resources, `/context` session globs and the SessionStart outputs are
 * rendered by context/systemPrompt `buildSystemPrompt` and written to `context.md` (0600).
 *
 * Subagents (00 §2.5 "Subagents" row): when the agent exposes `Agent`, every other loadable
 * Kiro agent its selectors allow becomes `{"<name>":{description, prompt, tools?, model}}` in a
 * JSON file passed with `--agents <file>` (the real CLI accepts a file path with `--print`,
 * which keeps large prompts out of argv). `prompt` = the agent's own `file://` resources as
 * Q context entries (≤ 64 KiB) + `Follow this instruction: <prompt>`; `tools` = its `--tools`
 * expansion without `Agent` (omitted for `*`, which inherits); `model` = mapped or `inherit`.
 *
 * Skills: config/skills `buildSkillsPluginDir` creates `<runtimeDir>/kiro` and
 * `initialize.skills` lists `kiro:<name>` for each (an empty list hides Claude's bundled
 * skills, which Kiro does not have).
 *
 * Pure apart from reading Kiro config files and writing into `runtimeDir`.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ClaudeBinary, ClaudeCapabilities } from '../claude/binary.js';
import type { InitializeRequest, ModelInfo } from '../claude/protocol.js';
import { discoverSkills, buildSkillsPluginDir, pluginSkillDirNames } from '../config/skills.js';
import { claudeMcpNameMap, resolveMcpServers, toClaudeMcpConfig } from '../config/mcp.js';
import { expandFileSpec, resolveResources } from '../config/resources.js';
import { expandFileRefs, findAgentsMd, loadSteering, loadSteeringPaths } from '../config/steering.js';
import { loadKiroIgnore } from '../config/kiroignore.js';
import { buildSystemPrompt, formatContextEntries, AGENT_PROMPT_PREFIX } from '../context/systemPrompt.js';
import { kiroToClaudeModel } from '../models/models.js';
import { buildInitializeHooks } from '../policy/gate.js';
import { expandToolSelectors, type ToolSelection } from '../policy/toolmap.js';
import type { KiroAgent, McpServerConfig, SettingsStore, SkillInfo, SteeringFile, WorkspaceContext } from '../types.js';
import { mkdirp, writeFileAtomic } from '../util/fsx.js';
import { shlexSplit } from '../util/shlex.js';

/** Flags every launch passes (not capability-gated: kiro-claude cannot work without them). */
export const CORE_ARGS: readonly string[] = Object.freeze([
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-prompt-tool',
  'stdio',
]);

/** Claude effort levels accepted by `--effort` / `/effort` (00 §3.8). */
export const EFFORT_LEVELS: readonly string[] = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** `kiroClaude.extraClaudeArgs` entries that would break Kiro semantics (00 §3.1 "Never pass"). */
export const FORBIDDEN_EXTRA_ARGS: readonly string[] = Object.freeze([
  '--bare',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--allowedTools',
  '--allowed-tools',
  '--permission-mode',
  '--no-optional-locks',
  '--hard-fail',
]);

/** Cap for the resource block of one subagent prompt. */
export const SUBAGENT_RESOURCE_MAX_BYTES = 64 * 1024;

export interface LaunchInput {
  ws: WorkspaceContext;
  settings: SettingsStore;
  agent: KiroAgent;
  allAgents: ReadonlyMap<string, KiroAgent>;
  binary: ClaudeBinary;
  caps: ClaudeCapabilities;
  /** New session id (`--session-id`), or the id of the new fork when `resume.fork`. */
  claudeSessionId?: string;
  resume?: { claudeSessionId: string; fork?: boolean; at?: string };
  /** Kiro model id (`auto`/undefined ⇒ no `--model`). */
  model?: string;
  effort?: string;
  /** `/context add` globs (session scope). */
  sessionContextGlobs: string[];
  /** SessionStart / agentSpawn outputs (system-prompt hook block). */
  agentSpawnOutputs: string[];
  /** Client MCP servers (ACP); win over same-named agent/config servers. */
  extraMcpServers?: McpServerConfig[];
  additionalDirectories?: string[];
  contextWindowTokens: number;
  /** Private per-session directory for the generated files (created 0700). */
  runtimeDir: string;
  liveModels?: ModelInfo[];
  /** Environment for `KIRO_CLAUDE_FORCE_MODEL` / `ASBX_KIRO_MANDATORY_MCPS` (default `ws.env`). */
  env?: NodeJS.ProcessEnv;
}

export interface LaunchResult {
  args: string[];
  initialize: InitializeRequest;
  files: { systemPrompt: string; mcpConfig?: string; pluginDir?: string; agents?: string };
  systemPrompt: ReturnType<typeof buildSystemPrompt>;
  /** Servers passed to Claude (enabled + selected), Kiro names. */
  mcpServers: McpServerConfig[];
  /** Every configured server incl. disabled / unselected ones (for /mcp). */
  allMcpServers: McpServerConfig[];
  /** Claude-normalized server name ⇒ Kiro server name. */
  mcpNameMap: Record<string, string>;
  toolSelection: ToolSelection;
  skills: SkillInfo[];
  conditionalSteering: SteeringFile[];
  /** All steering files that were considered (always + conditional). */
  steering: SteeringFile[];
  agentsMd: string[];
  resources: { pattern: string; paths: string[] }[];
  sessionContext: { pattern: string; paths: string[] }[];
  /** Agents exposed through `--agents`. */
  subagents: string[];
  /** Value passed with `--model` (undefined = Claude default) and whether it was forced. */
  model: { claudeValue?: string; forced: boolean };
  /** Effort passed with `--effort` (undefined = none). */
  effort?: string;
  /** The Claude session id this launch starts (`--session-id`), undefined when resuming in place. */
  sessionId?: string;
  warnings: string[];
}

function strList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.trim() !== '') return shlexSplit(v) ?? v.trim().split(/\s+/);
  return undefined;
}

/** `kiroClaude.extraClaudeArgs` without the forbidden flags (and their values when given as `--x=v`). */
export function sanitizeExtraArgs(raw: unknown, warnings: string[]): string[] {
  const list = strList(raw) ?? [];
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    const name = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (FORBIDDEN_EXTRA_ARGS.includes(name)) {
      warnings.push(`kiroClaude.extraClaudeArgs: ${name} is not allowed and was ignored`);
      // drop the separate value(s): `--permission-mode <mode>` takes one, `--allowedTools
      // <tools...>` is variadic in the real CLI (every following non-option word is a tool;
      // leaving one behind would turn it into a positional prompt)
      if (name === '--permission-mode' && !a.includes('=')) {
        const next = list[i + 1];
        if (next !== undefined && !next.startsWith('-')) i++;
      } else if (name === '--allowedTools' || name === '--allowed-tools') {
        // variadic: commander keeps consuming words after `--allowedTools=x` too
        while (list[i + 1] !== undefined && !list[i + 1]!.startsWith('-')) i++;
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * The extra args with `--settings {"disableSkillShellExecution":true,…}` enforced. Claude Code
 * runs a skill's inline `` !`cmd` `` blocks while it builds the skill prompt, outside any tool
 * call, so the Kiro gate never sees them (skills.ts sanitizes the plugin's SKILL.md; this is the
 * second guard, and it also covers commands loaded via kiroClaude.claudeSettingSources). A
 * `--settings` the user put in kiroClaude.extraClaudeArgs (inline JSON or a JSON file) is merged
 * instead of being overridden, since claude keeps only the last `--settings`. Unreadable user
 * settings are dropped with a warning: the safety setting wins.
 */
export function withSkillShellDisabled(extra: readonly string[], supported: boolean, cwd: string, warnings: string[]): string[] {
  if (!supported) return [...extra];
  const out: string[] = [];
  let user: Record<string, unknown> = {};
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i]!;
    let value: string | undefined;
    if (a === '--settings') value = extra[++i];
    else if (a.startsWith('--settings=')) value = a.slice('--settings='.length);
    else {
      out.push(a);
      continue;
    }
    if (value === undefined) continue;
    try {
      const text = value.trim().startsWith('{') ? value : fs.readFileSync(path.resolve(cwd, value), 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
      user = { ...user, ...(parsed as Record<string, unknown>) };
    } catch (e) {
      warnings.push(`kiroClaude.extraClaudeArgs: --settings ${value} could not be read (${e instanceof Error ? e.message : String(e)}) and was ignored`);
    }
  }
  out.push('--settings', JSON.stringify({ ...user, disableSkillShellExecution: true }));
  return out;
}

/** Names from `$ASBX_KIRO_MANDATORY_MCPS` (comma/space separated). */
export function mandatoryMcpNames(env: NodeJS.ProcessEnv): string[] {
  const v = env.ASBX_KIRO_MANDATORY_MCPS;
  if (!v) return [];
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Merge client servers over configured ones (client wins on a name clash, 08 §2.5). */
export function mergeMcpServers(configured: readonly McpServerConfig[], extra: readonly McpServerConfig[] = []): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>();
  for (const s of configured) byName.set(s.name, s);
  for (const s of extra) byName.set(s.name, s);
  return [...byName.values()];
}

function invert(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[v] = k;
  return out;
}

function readSmall(p: string, max: number): string | undefined {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > max) return undefined;
    const text = fs.readFileSync(p, 'utf8');
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * `--agents` entry for one Kiro agent (see module doc). `opts.inheritModel` (set while
 * `KIRO_CLAUDE_FORCE_MODEL` is in effect) makes every subagent `inherit` the forced model, so a
 * pinned subagent model cannot escape the cost bound (08 KC-ENV-04: every child runs the forced model).
 */
export function subagentDefinition(
  ws: WorkspaceContext,
  sub: KiroAgent,
  liveModels: ModelInfo[] | undefined,
  opts: { inheritModel?: boolean } = {},
): { description: string; prompt: string; tools?: string[]; model: string } {
  const entries: { path: string; content: string }[] = [];
  let budget = SUBAGENT_RESOURCE_MAX_BYTES;
  try {
    const res = resolveResources(ws, { ...sub, inheritDefaultResources: false });
    for (const g of res.files) {
      for (const p of g.paths) {
        const text = readSmall(p, budget);
        if (text === undefined) continue;
        const n = Buffer.byteLength(text, 'utf8');
        if (n > budget) continue;
        budget -= n;
        entries.push({ path: p, content: text });
      }
    }
  } catch {
    /* resources are best effort for subagents */
  }
  const parts: string[] = [];
  if (entries.length) parts.push(formatContextEntries(entries).replace(/\n+$/, ''));
  const prompt = sub.prompt?.trim()
    ? `${AGENT_PROMPT_PREFIX}${sub.prompt}`
    : `You are the Kiro agent "${sub.name}".${sub.description ? ` ${sub.description}` : ''}`;
  parts.push(prompt);
  const def: { description: string; prompt: string; tools?: string[]; model: string } = {
    description: sub.description?.trim() || `Kiro agent ${sub.name}`,
    prompt: parts.join('\n\n'),
    model: 'inherit',
  };
  if (!sub.tools.includes('*')) {
    const sel = expandToolSelectors({ tools: sub.tools, excludedTools: sub.excludedTools, skillsLoaded: false, mcpServers: [], agentNames: [] });
    def.tools = sel.claudeTools.filter((t) => t !== 'Agent');
  }
  if (!opts.inheritModel && sub.model && sub.model.trim() !== '' && sub.model !== 'auto') {
    const m = kiroToClaudeModel(sub.model, liveModels);
    if (m.value) def.model = m.value;
  }
  return def;
}

/** Build the launch for one agent (see module doc). */
export function buildLaunch(input: LaunchInput): LaunchResult {
  const { ws, settings, agent, caps } = input;
  const env = input.env ?? ws.env;
  const warnings: string[] = [];
  const has = (f: string): boolean => caps.has(f);
  mkdirp(input.runtimeDir, 0o700);
  try {
    fs.chmodSync(input.runtimeDir, 0o700);
  } catch {
    /* best effort */
  }

  // ── context sources ──
  const res = resolveResources(ws, agent);
  for (const w of res.warnings) warnings.push(w.message);
  if (res.knowledgeBases.length) warnings.push(`Agent '${agent.name}': knowledge base resources are not supported in kiro-claude and were ignored`);
  const ignore = loadKiroIgnore(ws);
  let steering: SteeringFile[] = [];
  let agentsMd: string[] = [];
  if (agent.inheritDefaultResources) {
    const st = loadSteering(ws);
    steering = st.files;
    for (const w of st.warnings) warnings.push(w.message);
    agentsMd = findAgentsMd(ws);
  }
  if (res.steeringFiles.length) {
    const extra = loadSteeringPaths(ws, res.steeringFiles);
    steering = [...steering, ...extra.files];
    for (const w of extra.warnings) warnings.push(w.message);
  }
  const sessionContext = input.sessionContextGlobs.map((g) => {
    const r = expandFileSpec(g, ws);
    if (r.error) warnings.push(`Context rule ${g}: ${r.error}`);
    return { pattern: g, paths: r.paths.filter((p) => !ignore.isIgnored(p)) };
  });
  const skills = discoverSkills(ws, res.skillUris, { includeDefaults: agent.inheritDefaultResources });

  // ── MCP servers + tool selection ──
  const resolved = resolveMcpServers(ws, agent);
  for (const w of resolved.warnings) warnings.push(w.message);
  const allMcpServers = mergeMcpServers(resolved.servers, input.extraMcpServers);
  const enabled = allMcpServers.filter((s) => !s.disabled);
  const otherAgents = [...input.allAgents.keys()].filter((n) => n !== agent.name);
  const selInput = (servers: McpServerConfig[]): Parameters<typeof expandToolSelectors>[0] => {
    const k2c = invert(claudeMcpNameMap(servers));
    return {
      tools: agent.tools,
      excludedTools: agent.excludedTools,
      skillsLoaded: skills.length > 0,
      mcpServers: servers.map((s) => ({ name: s.name, claudeName: k2c[s.name] ?? s.name, disabledTools: s.disabledTools })),
      agentNames: otherAgents,
    };
  };
  const sel1 = expandToolSelectors(selInput(enabled));
  for (const w of sel1.warnings) warnings.push(w);
  const mcpServers = enabled.filter((s) => sel1.mcpServers.includes(s.name));
  // Claude names are assigned over the servers actually passed (collision suffixes must match).
  const sel2 = expandToolSelectors(selInput(mcpServers));
  const toolSelection: ToolSelection = { ...sel1, disallowedTools: sel2.disallowedTools };
  const mcpNameMap = claudeMcpNameMap(mcpServers);

  const files: LaunchResult['files'] = { systemPrompt: path.join(input.runtimeDir, 'context.md') };
  if (mcpServers.length) {
    const cfg = toClaudeMcpConfig(mcpServers);
    const k2c = invert(mcpNameMap);
    for (const n of mandatoryMcpNames(env)) {
      const c = k2c[n];
      if (c !== undefined && cfg.mcpServers[c]) cfg.mcpServers[c]!.alwaysLoad = true;
    }
    files.mcpConfig = path.join(input.runtimeDir, 'mcp.json');
    writeFileAtomic(files.mcpConfig, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  } else {
    try {
      fs.rmSync(path.join(input.runtimeDir, 'mcp.json'), { force: true });
    } catch {
      /* ignore */
    }
  }

  // ── system prompt file ──
  const systemPrompt = buildSystemPrompt({
    ws,
    agent,
    steering,
    resourceFiles: res.files,
    sessionContext,
    agentsMd,
    agentSpawnOutputs: input.agentSpawnOutputs,
    contextWindowTokens: input.contextWindowTokens,
    expandRefs: (b, d) => expandFileRefs(b, d, ws, ignore),
  });
  for (const w of systemPrompt.warnings) warnings.push(w);
  writeFileAtomic(files.systemPrompt, systemPrompt.text, { mode: 0o600 });

  // ── subagents ──
  const forced = env.KIRO_CLAUDE_FORCE_MODEL?.trim();
  let subagents: string[] = [];
  if (toolSelection.claudeTools.includes('Agent')) {
    const wanted = toolSelection.subagents === 'all' ? otherAgents : toolSelection.subagents;
    subagents = wanted.filter((n) => n !== agent.name && input.allAgents.has(n));
  }
  const agentsPath = path.join(input.runtimeDir, 'agents.json');
  if (subagents.length && has('--agents')) {
    const defs: Record<string, ReturnType<typeof subagentDefinition>> = {};
    for (const n of subagents) defs[n] = subagentDefinition(ws, input.allAgents.get(n)!, input.liveModels, { inheritModel: !!forced });
    files.agents = agentsPath;
    writeFileAtomic(agentsPath, JSON.stringify(defs, null, 2) + '\n', { mode: 0o600 });
  } else {
    if (subagents.length) warnings.push('This Claude Code does not support --agents; Kiro agents are not available as subagents');
    subagents = has('--agents') ? subagents : [];
    try {
      fs.rmSync(agentsPath, { force: true });
    } catch {
      /* ignore */
    }
  }

  // ── skills ──
  let skillNames: string[] = [];
  if (skills.length) {
    if (has('--plugin-dir')) {
      const dir = buildSkillsPluginDir(skills, input.runtimeDir);
      if (dir) {
        files.pluginDir = dir;
        skillNames = pluginSkillDirNames(skills).map((n) => `kiro:${n}`);
      }
    } else {
      warnings.push('This Claude Code does not support --plugin-dir; Kiro skills are only available as /<skill> commands');
    }
  }

  // ── model / effort ──
  const model: LaunchResult['model'] = { forced: !!forced };
  if (forced) model.claudeValue = forced;
  else if (input.model && input.model.trim() !== '') {
    const m = kiroToClaudeModel(input.model, input.liveModels);
    if (m.error) warnings.push(m.error);
    else if (m.value) model.claudeValue = m.value;
  }
  let effort: string | undefined;
  if (input.effort && input.effort.trim() !== '') {
    const e = input.effort.trim().toLowerCase();
    // per-model support from the live list (`supportedEffortLevels: null` ⇒ no effort, 00 §2.5)
    const liveEntry = model.claudeValue ? input.liveModels?.find((m) => m.value === model.claudeValue) : input.liveModels?.find((m) => m.value === 'default');
    const levels = liveEntry ? liveEntry.supportedEffortLevels : undefined;
    if (!EFFORT_LEVELS.includes(e)) warnings.push(`Unknown effort level '${input.effort}' (expected ${EFFORT_LEVELS.join(', ')}); ignored`);
    else if (!has('--effort')) warnings.push('This Claude Code does not support --effort; effort ignored');
    else if (liveEntry && (levels === null || levels === undefined || (Array.isArray(levels) && levels.length === 0))) {
      warnings.push(`Model ${model.claudeValue ?? 'default'} does not support effort levels; effort '${e}' ignored`);
    } else if (Array.isArray(levels) && !levels.includes(e)) {
      warnings.push(`Model ${model.claudeValue ?? 'default'} does not support effort '${e}' (supported: ${levels.join(', ')}); ignored`);
    } else effort = e;
  }

  // ── argv ──
  const args: string[] = [...CORE_ARGS];
  if (has('--include-partial-messages')) args.push('--include-partial-messages');
  args.push('--permission-mode', 'default');
  if (has('--setting-sources')) {
    const src = settings.getString('kiroClaude.claudeSettingSources');
    args.push('--setting-sources', src ?? '');
  }
  if (has('--strict-mcp-config')) args.push('--strict-mcp-config');
  if (files.mcpConfig) args.push('--mcp-config', files.mcpConfig);
  if (has('--tools')) args.push('--tools', toolSelection.claudeTools.join(','));
  else warnings.push('This Claude Code does not support --tools; the agent tool selection cannot be applied');
  if (toolSelection.disallowedTools.length && has('--disallowedTools')) args.push('--disallowedTools', toolSelection.disallowedTools.join(','));
  if (has('--append-system-prompt-file')) args.push('--append-system-prompt-file', files.systemPrompt);
  else if (systemPrompt.text !== '' && has('--append-system-prompt')) args.push('--append-system-prompt', systemPrompt.text);
  if (has('--system-prompt-snapshot')) args.push('--system-prompt-snapshot', 'off');
  if (model.claudeValue) args.push('--model', model.claudeValue);
  if (effort) args.push('--effort', effort);
  if (files.agents) args.push('--agents', files.agents);
  if (files.pluginDir) args.push('--plugin-dir', files.pluginDir);
  for (const d of input.additionalDirectories ?? []) {
    if (has('--add-dir')) args.push('--add-dir', d);
  }
  let sessionId: string | undefined;
  if (input.resume) {
    args.push('--resume', input.resume.claudeSessionId);
    if (input.resume.fork) args.push('--fork-session');
    if (input.resume.at) {
      if (has('--resume-session-at')) args.push('--resume-session-at', input.resume.at);
      else warnings.push('This Claude Code does not support --resume-session-at; the whole conversation was kept');
    }
    if (input.resume.fork && input.claudeSessionId) {
      args.push('--session-id', input.claudeSessionId);
      sessionId = input.claudeSessionId;
    }
  } else {
    sessionId = input.claudeSessionId ?? randomUUID();
    args.push('--session-id', sessionId);
  }
  const extra = sanitizeExtraArgs(settings.get('kiroClaude.extraClaudeArgs'), warnings);
  args.push(...withSkillShellDisabled(extra, has('--settings'), input.ws.cwd, warnings));

  const result: LaunchResult = {
    args,
    initialize: { hooks: buildInitializeHooks(), skills: skillNames },
    files,
    systemPrompt,
    mcpServers,
    allMcpServers,
    mcpNameMap,
    toolSelection,
    skills,
    conditionalSteering: systemPrompt.conditionalSteering,
    steering,
    agentsMd,
    resources: res.files,
    sessionContext,
    subagents,
    model,
    warnings: [...new Set(warnings)],
  };
  if (effort) result.effort = effort;
  if (sessionId) result.sessionId = sessionId;
  return result;
}
