/**
 * Slash commands and prompt invocations in `chat --no-interactive` input.
 *
 * Kiro: slash commands are interactive-only, except that headless runs accept `/usage`
 * (01 §5.0); a first message `@<prompt> args` (and V3 `/<prompt> args`) runs a saved prompt,
 * also headless (06 §8.3, Kiro 2.33+). kiro-claude answers informational commands locally,
 * WITHOUT a model turn (task spec; 08 KC-CLI-07):
 *
 *  - `/usage` ⇒ exactly `Claude Code subscription usage is not reported as Kiro credits. Run
 *    /usage inside kiro-claude chat.` — no session, no `claude` spawn (08 KC-CLI-07 / KC-BIN-05;
 *    never prints `Estimated Usage`, which KiroCrew would parse as Kiro credits);
 *  - `/help`, `/agent [list]`, `/prompts [list [word]]` ⇒ from the configuration, no session;
 *  - `/quit`, `/exit`, `/q` ⇒ nothing, exit 0;
 *  - `/context [show]`, `/tools`, `/mcp`, `/model`, `/hooks` ⇒ answered from a started session
 *    (the `claude` child is spawned and initialized, but no user turn is sent);
 *  - `/compact [instructions]` ⇒ the session's compaction (useful with `--resume`);
 *  - other built-in Kiro commands ⇒ `error: /<cmd> is only available in interactive chat` (exit 1)
 *    (DECISION: never send Kiro command text to the model);
 *  - `/<name> args` / `@<name> args` naming a saved prompt ⇒ the expanded prompt is the turn;
 *    `/<name> args` naming one of the agent's skills ⇒ the skill body (resolved after the
 *    session started, because skills come from the agent's resources);
 *  - anything else ⇒ sent verbatim.
 */

import type { ContextReport, KiroHook, KiroSession, McpStatusEntry, ModelEntry, SettingsStore, ToolListingEntry, WorkspaceContext } from '../types.js';
import { DEFAULT_AGENT_NAME, agentLocation, loadAgents } from '../config/agents.js';
import { expandPrompt, findPrompt, loadPrompts, parsePromptInvocation } from '../config/prompts.js';
import { discoverSkills, expandSkillInvocation } from '../config/skills.js';

/** The `/usage` answer in headless mode (08 KC-CLI-07, exact). */
export const HEADLESS_USAGE_TEXT = 'Claude Code subscription usage is not reported as Kiro credits. Run /usage inside kiro-claude chat.';

/** Kiro built-in slash commands that only make sense in interactive chat (01 §5.1). */
export const INTERACTIVE_ONLY_COMMANDS: readonly string[] = [
  'clear', 'chat', 'save', 'load', 'editor', 'reply', 'tangent', 'rewind', 'plan', 'spec', 'checkpoint',
  'effort', 'settings', 'paste', 'copy', 'transcript', 'todos', 'todo', 'sessions', 'session-id', 'title',
  'theme', 'permissions', 'autonomous', 'goal', 'spawn', 'knowledge', 'code', 'experiment', 'logdump',
  'changelog', 'issue', 'feedback', 'config', 'acceptall', 'profile', 'fullscreen', 'guide', 'voice',
  'memories', 'sandbox', 'workflow', 'verbosity', 'upgrade-agent', 'powers', 'repo', 'disconnect', 'subscribe',
];

/** What the headless runner should do with the input. */
export type HeadlessAction =
  /** Print `text` and exit 0 without a session. */
  | { kind: 'output'; command: string; text: string }
  /** Exit 0 silently. */
  | { kind: 'quit' }
  /** Print `message` (stderr) and exit with `exitCode`. */
  | { kind: 'error'; message: string; exitCode: number }
  /** Start the session, run `run`, print its text; no user turn. */
  | { kind: 'session-local'; command: string; run: (s: KiroSession) => Promise<string> }
  /** `/compact [instructions]`. */
  | { kind: 'compact'; instructions?: string }
  /** Send `text` as the user turn (maybe after skill expansion when `skill` is set). */
  | { kind: 'prompt'; text: string; skill?: { name: string; rawArgs: string } };

const HELP_TEXT = [
  'Commands available with --no-interactive:',
  '  /usage             Where to find Claude Code usage',
  '  /context [show]    Context files of the agent',
  '  /tools             Tools and their permissions',
  '  /mcp               MCP server status',
  '  /model             Available models',
  '  /hooks             Configured hooks',
  '  /agent [list]      Agents',
  '  /prompts [list]    Saved prompts',
  '  /compact [text]    Summarize the conversation (with --resume)',
  '  /<prompt> [args]   Run a saved prompt (also @<prompt> [args])',
  '',
  'Other commands are only available in interactive chat.',
].join('\n');

/** `/tools` listing (06 §5.8 layout, uncoloured; rule width fixed at 60 without a terminal). */
export function renderToolListing(entries: readonly ToolListingEntry[]): string {
  if (entries.length === 0) return 'No tools are currently enabled.';
  const nameW = Math.max(20, ...entries.map((e) => e.name.length + 4));
  const lines = [`${'Tool'.padEnd(nameW + 2)}Permission`, '▔'.repeat(Math.max(60, nameW + 12))];
  const builtin = entries.filter((e) => e.source === 'builtin').sort((a, b) => a.name.localeCompare(b.name));
  const servers = [...new Set(entries.filter((e) => e.source === 'mcp').map((e) => e.server ?? ''))].sort();
  const row = (e: ToolListingEntry): string => `- ${e.name.padEnd(nameW)}${e.permission}`;
  if (builtin.length > 0) {
    lines.push('Built-in:');
    for (const e of builtin) lines.push(row(e));
  }
  for (const s of servers) {
    lines.push('', `${s} (MCP):`);
    for (const e of entries.filter((x) => x.source === 'mcp' && (x.server ?? '') === s).sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(row(e));
    }
  }
  return lines.join('\n');
}

/** `/mcp` status lines. */
export function renderMcpStatus(entries: readonly McpStatusEntry[]): string {
  if (entries.length === 0) return 'No MCP servers configured.';
  const w = Math.max(...entries.map((e) => e.name.length));
  return entries
    .map((e) => {
      const parts = [e.name.padEnd(w), e.status];
      if (e.toolCount !== undefined) parts.push(`${e.toolCount} ${e.toolCount === 1 ? 'tool' : 'tools'}`);
      if (e.error) parts.push(e.error);
      return parts.join('  ');
    })
    .join('\n');
}

/** `/context show` (01 §5.3 Classic layout). */
export function renderContextReport(agentName: string, r: ContextReport): string {
  const lines: string[] = [`👤 Agent (${agentName}):`];
  const section = (entries: ContextReport['agentEntries']): void => {
    if (entries.length === 0) {
      lines.push('    <none>');
      return;
    }
    for (const e of entries) {
      lines.push(`    ${e.pattern}${e.files.length > 0 ? ` (${e.files.length} ${e.files.length === 1 ? 'match' : 'matches'})` : ''}`);
      for (const f of e.files) lines.push(`        ${f.path} (~${f.tokens} tkns)`);
    }
  };
  section(r.agentEntries);
  lines.push('', '💬 Session (temporary):');
  section(r.sessionEntries);
  if (r.steering.length > 0) {
    lines.push('', '🧭 Steering:');
    for (const s of r.steering) lines.push(`    ${s.path} (${s.inclusion}, ~${s.tokens} tkns)`);
  }
  if (r.hookOutputs.length > 0) {
    lines.push('', '🪝 Hook output:');
    r.hookOutputs.forEach((h, i) => lines.push(`    agentSpawn #${i + 1} (~${h.tokens} tkns)`));
  }
  if (r.droppedFiles.length > 0) {
    lines.push('', 'Some context files are dropped due to size limit:');
    for (const d of r.droppedFiles) lines.push(`    ${d}`);
  }
  const pct = r.contextWindowTokens > 0 ? ((r.totalTokens / r.contextWindowTokens) * 100).toFixed(1) : '0.0';
  lines.push('', `Total: ~${r.totalTokens} tokens (${pct}% of the context window)`);
  return lines.join('\n');
}

/** `/model` listing with the current model marked `*`. */
export function renderModelList(entries: readonly ModelEntry[], current: string): string {
  if (entries.length === 0) return 'No models available';
  const w = Math.max(...entries.map((e) => e.kiroId.length));
  const cur = current.toLowerCase();
  return entries
    .map((e) => {
      const mark = e.kiroId.toLowerCase() === cur ? '*' : ' ';
      return `${mark} ${e.kiroId.padEnd(w)}  ${e.displayName}${e.description ? ` | ${e.description}` : ''}`;
    })
    .join('\n');
}

/** `/hooks` listing. */
export function renderHooks(hooks: readonly KiroHook[]): string {
  if (hooks.length === 0) return 'No hooks are configured.';
  const w = Math.max(...hooks.map((h) => h.rawTrigger.length));
  return hooks
    .map((h) => {
      const what = h.action.type === 'command' ? h.action.command : `(agent) ${h.action.prompt}`;
      return `${h.rawTrigger.padEnd(w)}  ${h.name}${h.matcher ? ` [${h.matcher}]` : ''}${h.enabled ? '' : ' (disabled)'}: ${what}`;
    })
    .join('\n');
}

function agentListText(ws: WorkspaceContext, settings: SettingsStore): string {
  const { agents } = loadAgents(ws, { settings });
  const def = settings.getString('chat.defaultAgent') || DEFAULT_AGENT_NAME;
  const names = [...agents.keys()];
  const w = Math.max(...names.map((n) => n.length));
  return names.map((n) => `${n === def ? '*' : ' '} ${n.padEnd(w)}    ${agentLocation(agents.get(n)!)}`).join('\n');
}

function promptListText(ws: WorkspaceContext, search?: string): string {
  let prompts = loadPrompts(ws);
  if (search) prompts = prompts.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
  if (prompts.length === 0) return 'No prompts found.';
  const w = Math.max(...prompts.map((p) => p.name.length));
  return prompts.map((p) => `${p.name.padEnd(w)}  ${p.scope}${p.description ? `  ${p.description}` : ''}`).join('\n');
}

/** Decide what to do with headless input (see module doc). `input` is trimmed and non-empty. */
export function classifyHeadlessInput(input: string, ws: WorkspaceContext, settings: SettingsStore): HeadlessAction {
  if (input.startsWith('@')) {
    const inv = parsePromptInvocation(input);
    if ('name' in inv) {
      const p = findPrompt(loadPrompts(ws), inv.name);
      if (p) return { kind: 'prompt', text: expandPrompt(p, inv.args) };
    }
    return { kind: 'prompt', text: input };
  }
  if (!input.startsWith('/') || input.startsWith('//')) return { kind: 'prompt', text: input };
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(input);
  if (!m) return { kind: 'prompt', text: input };
  const name = m[1]!;
  const rest = m[2]!.trim();
  const lower = name.toLowerCase();
  const words = rest === '' ? [] : rest.split(/\s+/);
  switch (lower) {
    case 'usage':
      return { kind: 'output', command: '/usage', text: HEADLESS_USAGE_TEXT };
    case 'help':
      return { kind: 'output', command: '/help', text: HELP_TEXT };
    case 'quit':
    case 'exit':
    case 'q':
      return { kind: 'quit' };
    case 'agent':
      if (words.length === 0 || words[0] === 'list') return { kind: 'output', command: '/agent', text: agentListText(ws, settings) };
      break;
    case 'prompts':
      if (words.length === 0 || words[0] === 'list') return { kind: 'output', command: '/prompts', text: promptListText(ws, words[1]) };
      break;
    case 'context':
      if (words.length === 0 || words[0] === 'show') {
        return { kind: 'session-local', command: '/context', run: async (s) => renderContextReport(s.agent.name, await s.contextReport()) };
      }
      break;
    case 'tools':
      if (words.length === 0) return { kind: 'session-local', command: '/tools', run: async (s) => renderToolListing(s.toolListing()) };
      break;
    case 'mcp':
      if (words.length === 0) return { kind: 'session-local', command: '/mcp', run: async (s) => renderMcpStatus(await s.mcpStatus()) };
      break;
    case 'model':
      if (words.length === 0) return { kind: 'session-local', command: '/model', run: async (s) => renderModelList(await s.listModels(), s.model) };
      break;
    case 'hooks':
      if (words.length === 0) return { kind: 'session-local', command: '/hooks', run: async (s) => renderHooks(s.hooks()) };
      break;
    case 'compact':
      return rest ? { kind: 'compact', instructions: rest } : { kind: 'compact' };
    default: {
      const inv = parsePromptInvocation(input);
      if ('name' in inv) {
        const p = findPrompt(loadPrompts(ws), inv.name);
        if (p) return { kind: 'prompt', text: expandPrompt(p, inv.args) };
      }
      if (INTERACTIVE_ONLY_COMMANDS.includes(lower)) {
        return { kind: 'error', message: `error: /${name} is only available in interactive chat`, exitCode: 1 };
      }
      return { kind: 'prompt', text: input, skill: { name, rawArgs: rest } };
    }
  }
  return { kind: 'error', message: `error: /${name} ${rest} is only available in interactive chat`, exitCode: 1 };
}

/** Expand `/<skill> args` against the session agent's skills; undefined when no such skill. */
export function expandSkillForSession(session: KiroSession, ws: WorkspaceContext, name: string, rawArgs: string): string | undefined {
  const uris = session.agent.resources.filter((r) => r.kind === 'skill').map((r) => (r as { uri: string }).uri);
  let skills;
  try {
    skills = discoverSkills(ws, uris, { includeDefaults: session.agent.inheritDefaultResources });
  } catch {
    return undefined;
  }
  const lower = name.toLowerCase();
  const s = skills.find((x) => x.name === name) ?? skills.find((x) => x.name.toLowerCase() === lower);
  if (!s) return undefined;
  try {
    return expandSkillInvocation(s, rawArgs);
  } catch {
    return undefined;
  }
}
