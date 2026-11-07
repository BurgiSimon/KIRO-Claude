/**
 * Kiro settings store (`cli.json`) with Kiro semantics (01 §2.3, §7; 02 §8; 00 §2.1).
 *
 * Files (flat JSON objects whose keys are dotted strings):
 *  - global    `<kiroHome>/settings/cli.json`
 *  - workspace `<workspaceRoot>/.kiro/settings/cli.json` (overrides global, except for the
 *    global-only keys of 01 §7.1, whose workspace values are ignored and cannot be set)
 *  - security: the `kiroClaude.*` keys that change how `claude` is launched or authenticated
 *    ({@link CLAUDE_LAUNCH_KEYS}) are global-only too, and a workspace value of one of them
 *    (a cloned repository's `.kiro/settings/kiro-claude.json` or `cli.json`) is reported in
 *    `warnings` (code `workspace-launch-setting`) besides being ignored
 *  - adapter-only keys (prefix `kiroClaude.`) live in `kiro-claude.json` next to each
 *    `cli.json`, so the real kiro-cli never sees unknown keys (00 §2.1). Reads of a
 *    `kiroClaude.*` key fall back to `cli.json` when a user put it there by hand.
 *
 * Value semantics:
 *  - {@link parseSettingValue}: `serde_json::from_str(v).unwrap_or(json!(v))` — a value is
 *    parsed as JSON when possible, otherwise stored as the raw string (`true` ⇒ boolean,
 *    `5000` ⇒ number, `'["a"]'` ⇒ array, `claude-sonnet-4.6` ⇒ string) (01 §2.3).
 *  - `set()` applies that parsing to string values; non-string values are stored as is.
 *  - `delete()` takes a glob over keys (globset dialect, Q `settings --delete <glob>`).
 *
 * Every read re-checks the backing files (mtime/size), so settings written by another
 * process are seen. A file with invalid JSON is treated as empty for reads (a warning is
 * recorded in `warnings`) and writes to it are refused (throw) so the user's file is never
 * clobbered. Library code: never prints.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigWarning, SettingsScope, SettingsStore, WorkspaceContext } from '../types.js';
import { JsonFileError, parseJsonText, writeJsonAtomic } from '../util/fsx.js';
import { errorText, jsonErrorMessage, ownValue, setOwn } from './diag.js';
import { globMatch, hasGlobMeta } from '../util/glob.js';
import { workspaceKiroDir } from './workspace.js';

/** Prefix of adapter-only keys (stored in kiro-claude.json). */
export const ADAPTER_KEY_PREFIX = 'kiroClaude.';

export interface SettingSchemaEntry {
  type: 'boolean' | 'string' | 'number' | 'object' | 'array';
  default?: unknown;
  description: string;
  scope?: 'global-only';
}

/**
 * Known settings (Kiro keys from 01 §7.2 that kiro-claude honors or accepts, plus adapter
 * keys). Used by `settings list --all` and for type hints; unknown keys are still accepted
 * (forward compatibility, 01 §2.3 "Port"). A key kiro-claude stores but does not implement
 * says so in its description (`not supported in kiro-claude`, `accepted and ignored`, `no
 * effect`); every other key is read somewhere in src/ (test/config/docs-consistency.test.ts).
 */
export const SETTINGS_SCHEMA: Record<string, SettingSchemaEntry> = {
  // ── chat core ──
  'chat.defaultModel': { type: 'string', description: 'Default model id for new chat sessions (auto when unset)' },
  'chat.defaultAgent': { type: 'string', default: 'kiro_default', description: 'Default agent for new chat sessions' },
  'chat.modelDefaults': {
    type: 'object',
    description: 'Per-model defaults keyed by model id, e.g. {"claude-sonnet-4.6":{"output_config":{"effort":"high"}}}',
  },
  'chat.greeting.enabled': { type: 'boolean', default: true, description: 'Show the welcome text when a chat starts' },
  'chat.enablePromptHints': { type: 'boolean', default: true, description: 'Show startup tips' },
  'chat.enableNotifications': { type: 'boolean', default: false, description: 'Notify when a response completes' },
  'chat.notificationMethod': {
    type: 'string',
    default: 'auto',
    description: 'Notification method: auto, bel or osc9 (not supported in kiro-claude; notifications always ring the bell)',
  },
  'chat.disableMarkdownRendering': { type: 'boolean', default: false, description: 'Print raw model output instead of rendered Markdown' },
  'chat.disableWrap': { type: 'boolean', default: false, description: 'Do not hard-wrap output lines' },
  'chat.disableAutoCompaction': {
    type: 'boolean',
    default: false,
    description: 'Disable automatic conversation compaction (Claude Code DISABLE_AUTO_COMPACT; /compact still works)',
  },
  'compaction.excludeMessages': {
    type: 'number',
    default: 2,
    description: 'Minimum message pairs kept verbatim by compaction (not supported in kiro-claude)',
  },
  'compaction.excludeContextWindowPercent': {
    type: 'number',
    default: 2,
    description: 'Minimum percent of the context window kept by compaction (not supported in kiro-claude)',
  },
  'chat.editMode': { type: 'string', description: 'Line editor mode: vi (default emacs) (not supported in kiro-claude)' },
  'chat.enableHistoryHints': { type: 'boolean', default: false, description: 'Show history ghost hints while typing (not supported in kiro-claude)' },
  'chat.enableContextUsageIndicator': { type: 'boolean', default: false, description: 'Show context usage percentage in the prompt' },
  'chat.historyMode': { type: 'string', default: 'session', description: 'Up/Down history scope: session or global' },
  'chat.diffTool': { type: 'string', description: 'External diff tool used to show file changes (e.g. delta) (not supported in kiro-claude)' },
  'chat.disableGranularTrust': {
    type: 'boolean',
    default: false,
    description: 'Disable the tiered trust menu in tool approvals (not supported in kiro-claude, which has no tiered menu)',
  },
  'chat.autoExpandToolOutput': { type: 'boolean', default: false, description: 'Show full tool output instead of a truncated preview' },
  'chat.outputStyle': { type: 'string', description: 'Output style of the agent (not supported in kiro-claude)' },
  'chat.showThinking': { type: 'boolean', default: true, description: 'Show model reasoning blocks' },
  'chat.enableThinking': { type: 'boolean', default: false, description: 'Enable the thinking tool (no effect: Claude thinks natively)' },
  'chat.allowAnimations': { type: 'boolean', default: true, description: 'Show spinners and animations' },
  'chat.allowAsciiArt': { type: 'boolean', default: true, description: 'Use Unicode glyphs (false: ASCII only)' },
  'chat.allowIcons': { type: 'boolean', default: true, description: 'Show status icons (not supported in kiro-claude)' },
  'chat.terminalTitle': {
    type: 'boolean',
    default: false,
    description: 'Set the terminal title (not supported in kiro-claude; /title sets it regardless)',
    scope: 'global-only',
  },
  'chat.screenReader': {
    type: 'string',
    default: 'auto',
    description: 'Screen reader mode: auto, on or off (not supported in kiro-claude)',
    scope: 'global-only',
  },
  'chat.agentEngine': { type: 'string', description: 'Kiro agent engine (v3, v2, v1); accepted and ignored', scope: 'global-only' },
  'chat.uiMode': { type: 'string', description: 'Legacy render mode; accepted and ignored', scope: 'global-only' },
  'chat.enableAutoAgentUpgrade': { type: 'boolean', description: 'Auto-upgrade 2.x agents to V3; accepted and ignored', scope: 'global-only' },
  'chat.disableInheritingDefaultResources': {
    type: 'boolean',
    default: false,
    description: 'Custom agents do not inherit default resources (steering, skills, AGENTS.md)',
  },
  'chat.enableKnowledge': { type: 'boolean', description: 'Enable knowledge bases (not supported by kiro-claude)' },
  'chat.enableCodeIntelligence': { type: 'boolean', description: 'Enable code intelligence (not supported by kiro-claude)' },
  'chat.enableTangentMode': {
    type: 'boolean',
    default: false,
    description: 'Enable /tangent (not supported in kiro-claude; /tangent is always available)',
  },
  'chat.tangentModeKey': { type: 'string', default: 't', description: 'Key (with Ctrl) that toggles tangent mode (not supported in kiro-claude)' },
  'introspect.tangentMode': { type: 'boolean', default: false, description: 'Run introspect questions in a tangent (not supported in kiro-claude)' },
  'chat.enableTodoList': { type: 'boolean', default: false, description: 'Enable /todos (not supported in kiro-claude; /todos is always available)' },
  'chat.enableCheckpoint': { type: 'boolean', default: false, description: 'Enable /checkpoint (not supported in kiro-claude)' },
  'chat.enableDelegate': { type: 'boolean', default: false, description: 'Enable the delegate tool (not supported)' },
  'chat.enableWorkflows': { type: 'boolean', default: false, description: 'Enable workflows (not supported)' },
  'chat.workflowLaunch': { type: 'string', default: 'when-asked', description: 'Workflow launch policy (not supported)' },
  'chat.skimCommandKey': { type: 'string', default: 's', description: 'Key (with Ctrl) for fuzzy command search (not supported in kiro-claude)' },
  'chat.autocompletionKey': {
    type: 'string',
    default: 'g',
    description: 'Key (with Ctrl) that accepts a completion hint (not supported in kiro-claude)',
  },
  'chat.keybindings.cancelStream': {
    type: 'string',
    default: 'esc',
    description: 'Key that cancels a streaming response (not supported in kiro-claude)',
  },
  'chat.keybindings.closeMenu': { type: 'string', default: 'esc', description: 'Key that closes a menu (not supported in kiro-claude)' },
  'chat.keybindings.quit': { type: 'string', default: 'ctrl+c', description: 'Key that quits (not supported in kiro-claude)' },
  'chat.sessionDashboard.scope': {
    type: 'string',
    default: 'current',
    description: 'Session list scope: current or all (not supported in kiro-claude)',
  },
  'chat.sessionDashboard.indexResponses': {
    type: 'boolean',
    default: true,
    description: 'Index responses for session search (not supported in kiro-claude)',
  },
  'chat.enableCustomSpinnerVerbs': { type: 'boolean', default: false, description: 'Use chat.spinnerVerbs (not supported in kiro-claude)' },
  'chat.spinnerVerbs': {
    type: 'object',
    description: 'Custom spinner verbs: {"mode":"append"|"replace","verbs":[...]} (not supported in kiro-claude)',
  },
  'chat.preserveScrollback': { type: 'boolean', default: true, description: 'Preserve terminal scrollback (accepted and ignored)' },
  // ── MCP / API / app ──
  'mcp.initTimeout': {
    type: 'number',
    default: 5000,
    description: "MCP server initialization timeout (ms) in interactive and ACP sessions; when set above Claude Code's own 30 s limit it is passed as MCP_TIMEOUT (it never shortens it)",
  },
  'mcp.noInteractiveTimeout': {
    type: 'number',
    default: 30000,
    description: 'MCP initialization timeout in non-interactive mode (ms); --require-mcp-startup waits this long, and when set it is passed to Claude Code as MCP_TIMEOUT',
  },
  'mcp.loadedBefore': { type: 'boolean', description: 'Internal: the MCP safety note was shown (not supported in kiro-claude)' },
  'api.timeout': { type: 'number', default: 3600, description: 'Request timeout (seconds); passed to Claude Code as API_TIMEOUT_MS when set' },
  'api.streamIdleSoftTimeout': {
    type: 'number',
    default: 60,
    description: 'Seconds without stream output before a stall warning (not supported in kiro-claude)',
  },
  'api.streamIdleHardTimeout': {
    type: 'number',
    default: 300,
    description: 'Seconds without stream output before giving up (not supported in kiro-claude)',
  },
  'api.subagentTimeout': { type: 'number', default: 3600, description: 'Subagent timeout (seconds) (not supported in kiro-claude)' },
  'app.disableAutoupdates': {
    type: 'boolean',
    default: false,
    description: 'Disable automatic updates (not supported in kiro-claude, which never updates itself)',
  },
  'app.warnOnElevatedPrivileges': {
    type: 'boolean',
    default: true,
    description: 'Warn when running as root (not supported in kiro-claude)',
    scope: 'global-only',
  },
  'acp.agentEngine': { type: 'string', description: 'ACP agent engine; accepted and ignored', scope: 'global-only' },
  'telemetry.enabled': { type: 'boolean', description: 'Telemetry (not supported in kiro-claude, which sends none)' },
  'knowledge.defaultIncludePatterns': { type: 'array', description: 'Knowledge base include globs (not supported)' },
  'knowledge.defaultExcludePatterns': { type: 'array', description: 'Knowledge base exclude globs (not supported)' },
  'knowledge.maxFiles': { type: 'number', description: 'Knowledge base file limit (not supported)' },
  'knowledge.chunkSize': { type: 'number', description: 'Knowledge base chunk size (not supported)' },
  'knowledge.chunkOverlap': { type: 'number', description: 'Knowledge base chunk overlap (not supported)' },
  'knowledge.indexType': { type: 'string', description: 'Knowledge base index type (not supported)' },
  'toolSearch.enabled': { type: 'boolean', description: 'Defer MCP tools behind tool search' },
  'toolSearch.minPct': { type: 'number', default: 5, description: 'Tool search threshold (% of context window)' },
  'toolSearch.minTokens': { type: 'number', default: 50000, description: 'Tool search threshold (tokens) (not supported in kiro-claude)' },
  // ── kiro-claude adapter keys (kiro-claude.json) ──
  'kiroClaude.claudePath': {
    type: 'string',
    description: 'Path of the claude binary (below $KIRO_CLAUDE_BIN; default: PATH, /opt/claude-code/bin/claude)',
    scope: 'global-only',
  },
  'kiroClaude.allowApiKey': {
    type: 'boolean',
    default: false,
    description: 'Let ANTHROPIC_API_KEY and cloud-provider switches reach claude (default: subscription login only)',
    scope: 'global-only',
  },
  'kiroClaude.claudeSettingSources': {
    type: 'string',
    default: '',
    description: 'Value for claude --setting-sources (e.g. "user,project,local"); empty = Kiro semantics only',
    scope: 'global-only',
  },
  'kiroClaude.extraClaudeArgs': { type: 'array', default: [], description: 'Extra arguments appended to every claude invocation', scope: 'global-only' },
  'kiroClaude.spec.defaultWorkflow': {
    type: 'string',
    description: 'Default spec workflow: requirements-first or design-first (unset: ask)',
  },
  'kiroClaude.spec.maxParallelTasks': { type: 'number', default: 1, description: 'Spec tasks run concurrently by /spec run (1-4)' },
  'kiroClaude.autonomy': {
    type: 'string',
    default: 'autopilot',
    description: 'Agent autonomy: autopilot or supervised (not supported in kiro-claude)',
  },
};

/**
 * `kiroClaude.*` keys that change how `claude` is launched or authenticated — its binary
 * (`claudePath`), its argv (`extraClaudeArgs`; `claudeSettingSources` ⇒ `--setting-sources`,
 * which would let a repository's `.claude/settings.json` hooks run) and its environment /
 * credentials (`allowApiKey` lets `ANTHROPIC_API_KEY` and cloud-provider switches through).
 * A cloned repository must not control these, so they are honoured only from the global
 * (`KIRO_HOME`) settings: a workspace value is ignored with a ConfigWarning naming the key, and
 * `set(key, v, 'workspace')` is refused. Every other `kiroClaude.*` key (spec workflow
 * preferences, the unimplemented autonomy) keeps workspace-over-global semantics. (Found by grepping every
 * `kiroClaude.` read in src/: session/launch.ts, session/kiroSession.ts, cli/commands/*.ts.)
 */
export const CLAUDE_LAUNCH_KEYS: ReadonlySet<string> = new Set([
  'kiroClaude.claudePath',
  'kiroClaude.extraClaudeArgs',
  'kiroClaude.claudeSettingSources',
  'kiroClaude.allowApiKey',
]);

/**
 * Keys whose workspace value is ignored and which cannot be set with workspace scope (01 §7.1,
 * plus {@link CLAUDE_LAUNCH_KEYS}).
 */
export const GLOBAL_ONLY_KEYS: ReadonlySet<string> = new Set([
  ...Object.entries(SETTINGS_SCHEMA)
    .filter(([, v]) => v.scope === 'global-only')
    .map(([k]) => k),
  ...CLAUDE_LAUNCH_KEYS,
]);

/**
 * Parse a CLI-supplied value: JSON when it parses, else the raw string (Kiro semantics,
 * `serde_json::from_str(v).unwrap_or(json!(v))`). serde_json rejects numbers outside the f64
 * range (`1e400`) where `JSON.parse` yields `Infinity` (which would be written as `null`), so
 * such values stay strings, like in Kiro.
 */
export function parseSettingValue(raw: string): unknown {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return raw;
  }
  return containsNonFinite(v) ? raw : v;
}

function containsNonFinite(v: unknown): boolean {
  if (typeof v === 'number') return !Number.isFinite(v);
  if (Array.isArray(v)) return v.some(containsNonFinite);
  if (typeof v === 'object' && v !== null) return Object.values(v).some(containsNonFinite);
  return false;
}

/** Schema default for `key`, if any. */
export function settingDefault(key: string): unknown {
  return ownValue(SETTINGS_SCHEMA, key)?.default;
}

/** True for keys stored in kiro-claude.json. */
export function isAdapterKey(key: string): boolean {
  return key.startsWith(ADAPTER_KEY_PREFIX);
}

/** Thrown by {@link KiroSettingsStore.set} / `delete` for invalid requests or unwritable files. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

/** Extended store returned by {@link openSettings}. */
export interface KiroSettingsStore extends SettingsStore {
  /** Problems found while reading the files (invalid JSON, non-object roots). Refreshed on each read. */
  readonly warnings: ConfigWarning[];
  /** Backing file paths. */
  readonly files: { global: { cli: string; adapter: string }; workspace?: { cli: string; adapter: string } };
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  data: Record<string, unknown>;
  warning?: ConfigWarning;
  invalid: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sortedRecord(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(r).sort()) setOwn(out, k, r[k]);
  return out;
}

/** Own-property copy (keeps a literal `__proto__` key as data). */
function copyRecord(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) setOwn(out, k, v);
  return out;
}

/** Open the settings store for `ws` (files are read lazily; nothing is created until a write). */
export function openSettings(ws: WorkspaceContext): KiroSettingsStore {
  const gDir = path.join(ws.kiroHome, 'settings');
  const wKiro = workspaceKiroDir(ws);
  const wDir = wKiro ? path.join(wKiro, 'settings') : undefined;
  const files = {
    global: { cli: path.join(gDir, 'cli.json'), adapter: path.join(gDir, 'kiro-claude.json') },
    ...(wDir ? { workspace: { cli: path.join(wDir, 'cli.json'), adapter: path.join(wDir, 'kiro-claude.json') } } : {}),
  } as KiroSettingsStore['files'];

  const cache = new Map<string, CacheEntry>();

  const readFile = (p: string): CacheEntry => {
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(p);
    } catch {
      st = undefined;
    }
    if (!st || !st.isFile()) {
      const e: CacheEntry = { mtimeMs: -1, size: -1, data: {}, invalid: false };
      cache.set(p, e);
      return e;
    }
    const hit = cache.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    let entry: CacheEntry;
    try {
      const text = fs.readFileSync(p, 'utf8');
      if (text.trim() === '') {
        entry = { mtimeMs: st.mtimeMs, size: st.size, data: {}, invalid: false };
      } else {
        const v = parseJsonText<unknown>(text, p);
        if (isPlainObject(v)) entry = { mtimeMs: st.mtimeMs, size: st.size, data: v, invalid: false };
        else
          entry = {
            mtimeMs: st.mtimeMs,
            size: st.size,
            data: {},
            invalid: true,
            warning: { code: 'invalid-settings', message: `${p}: settings file must contain a JSON object`, path: p },
          };
      }
    } catch (e) {
      const msg = e instanceof JsonFileError ? jsonErrorMessage(e, p) : `${p}: ${errorText(e)}`;
      entry = { mtimeMs: st.mtimeMs, size: st.size, data: {}, invalid: true, warning: { code: 'invalid-settings', message: msg, path: p } };
    }
    cache.set(p, entry);
    return entry;
  };

  /** Files read for `scope` (undefined: no separate workspace files). */
  const scopeFiles = (scope: SettingsScope): { cli: string; adapter: string } | undefined =>
    scope === 'global' ? files.global : files.workspace;
  /**
   * Files written for `scope`. When the workspace is the home directory its `.kiro` IS the
   * global root, so workspace writes land in the global files (what kiro-cli does there).
   */
  const writeFiles = (scope: SettingsScope): { cli: string; adapter: string } => scopeFiles(scope) ?? files.global;

  /** Merged key/values of one scope (cli.json overlaid by kiroClaude.* keys of kiro-claude.json). */
  const scopeView = (scope: SettingsScope): Record<string, unknown> => {
    const f = scopeFiles(scope);
    if (!f) return {};
    const cli = readFile(f.cli).data;
    const ad = readFile(f.adapter).data;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cli)) setOwn(out, k, v);
    for (const [k, v] of Object.entries(ad)) if (isAdapterKey(k)) setOwn(out, k, v);
    return out;
  };

  const effective = (): Record<string, unknown> => {
    const g = scopeView('global');
    const w = scopeView('workspace');
    const out = copyRecord(g);
    for (const [k, v] of Object.entries(w)) if (!GLOBAL_ONLY_KEYS.has(k)) setOwn(out, k, v);
    return out;
  };

  const get = (key: string): unknown => {
    if (!GLOBAL_ONLY_KEYS.has(key)) {
      const w = scopeView('workspace');
      if (Object.prototype.hasOwnProperty.call(w, key)) return w[key];
    }
    const g = scopeView('global');
    return Object.prototype.hasOwnProperty.call(g, key) ? g[key] : undefined;
  };

  /** One warning per launch key present in a workspace file (CLAUDE_LAUNCH_KEYS: ignored). */
  const workspaceLaunchWarnings = (): ConfigWarning[] => {
    const f = files.workspace;
    if (!f) return [];
    const out: ConfigWarning[] = [];
    const seen = new Set<string>();
    // kiro-claude.json first: it wins over a kiroClaude.* key hand-written into cli.json.
    for (const p of [f.adapter, f.cli]) {
      const data = readFile(p).data;
      for (const key of Object.keys(data).sort()) {
        if (!CLAUDE_LAUNCH_KEYS.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push({
          code: 'workspace-launch-setting',
          message: `${p}: ${key} is ignored: it changes how Claude Code is launched, so it is honoured only in the global settings (${files.global.adapter})`,
          path: p,
        });
      }
    }
    return out;
  };

  const writable = (p: string): Record<string, unknown> => {
    const e = readFile(p);
    if (e.invalid) {
      throw new SettingsError(`Refusing to modify ${p}: ${e.warning?.message ?? 'invalid settings file'}`);
    }
    return copyRecord(e.data);
  };

  const write = (p: string, data: Record<string, unknown>): void => {
    writeJsonAtomic(p, sortedRecord(data));
    cache.delete(p);
  };

  const store: KiroSettingsStore = {
    files,
    get warnings(): ConfigWarning[] {
      const out: ConfigWarning[] = [];
      const ps = [files.global.cli, files.global.adapter, ...(files.workspace ? [files.workspace.cli, files.workspace.adapter] : [])];
      for (const p of ps) {
        const w = readFile(p).warning;
        if (w) out.push(w);
      }
      out.push(...workspaceLaunchWarnings());
      return out;
    },
    get,
    getString(key: string): string | undefined {
      const v = get(key);
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return undefined;
    },
    getBoolean(key: string, fallback: boolean): boolean {
      const v = get(key);
      if (typeof v === 'boolean') return v;
      if (v === 'true') return true;
      if (v === 'false') return false;
      return fallback;
    },
    getNumber(key: string, fallback: number): number {
      const v = get(key);
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return fallback;
    },
    set(key: string, value: unknown, scope: SettingsScope = 'global'): void {
      if (key === '') throw new SettingsError('Setting key must not be empty');
      if (scope === 'workspace' && GLOBAL_ONLY_KEYS.has(key)) {
        throw new SettingsError(`Setting '${key}' can only be set globally`);
      }
      const f = writeFiles(scope);
      const v = typeof value === 'string' ? parseSettingValue(value) : value;
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' || containsNonFinite(v)) {
        throw new SettingsError(`Invalid value for '${key}'`);
      }
      const p = isAdapterKey(key) ? f.adapter : f.cli;
      const data = writable(p);
      setOwn(data, key, v);
      write(p, data);
      // A kiroClaude.* key hand-written into cli.json would shadow nothing (adapter file wins),
      // but drop it so `list` shows one value.
      if (isAdapterKey(key)) {
        const cliEntry = readFile(f.cli);
        if (!cliEntry.invalid && Object.prototype.hasOwnProperty.call(cliEntry.data, key)) {
          const d = copyRecord(cliEntry.data);
          delete d[key];
          write(f.cli, d);
        }
      }
    },
    delete(pattern: string, scope: SettingsScope = 'global'): string[] {
      const f = writeFiles(scope);
      const matches = (k: string): boolean => (hasGlobMeta(pattern, 'globset') ? globMatch(pattern, k, 'globset') : k === pattern);
      const deleted = new Set<string>();
      for (const p of [f.cli, f.adapter]) {
        const e = readFile(p);
        const keys = Object.keys(e.data).filter(matches);
        if (keys.length === 0) continue;
        const data = writable(p);
        for (const k of keys) {
          delete data[k];
          deleted.add(k);
        }
        write(p, data);
      }
      return [...deleted].sort();
    },
    list(scope: SettingsScope | 'effective' = 'effective'): Record<string, unknown> {
      if (scope === 'effective') return sortedRecord(effective());
      return sortedRecord(scopeView(scope));
    },
    pathFor(key: string, scope: SettingsScope): string {
      const f = writeFiles(scope);
      return isAdapterKey(key) ? f.adapter : f.cli;
    },
  };
  return store;
}
