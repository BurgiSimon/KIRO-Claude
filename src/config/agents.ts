/**
 * Kiro agent loading, validation, built-ins and selection (02 §1–2, 06 §7, 00 §2.2).
 *
 * Discovery ({@link loadAgents}):
 *  - workspace `<workspaceRoot>/.kiro/agents/**​/*.{json,md}`; when the workspace has no
 *    `.kiro/` directory, the legacy `<ws>/.amazonq/cli-agents/*.json` instead (02 §1.2; with
 *    both present `.kiro` wins and a `legacy-ignored` warning is added);
 *  - global `<kiroHome>/agents/**​/*.{json,md}`; when that directory does not exist, the
 *    legacy `~/.aws/amazonq/cli-agents/*.json` (DECISION: the agents dir, not `~/.kiro`
 *    itself, decides, because kiro-claude creates `~/.kiro` for its own session store);
 *  - `$KIRO_AGENT_CONFIG_DIR` replaces the global dir and skips the workspace scan (02 §1.1);
 *  - legacy dirs are read like Q (non-recursive, JSON only); Kiro dirs recursively
 *    (depth ≤ 8, dot-directories and `node_modules` skipped); `._*` sidecars, `*.bak*`,
 *    `*.example` never match; files are visited in sorted relative-path order.
 *  - a `.md` file that a JSON agent of any scanned dir uses as its `file://` prompt (e.g.
 *    `agents/prompts/dev.md`) is not loaded as a Markdown agent (DECISION: the recursive V3
 *    scan would otherwise turn every prompt file into a bogus agent);
 *  - name = `name` field ?? path relative to the agents dir without extension, `/`-separated
 *    (`team/planner`); duplicate names in one scope keep the first with Q's
 *    `WARNING: Duplicate agent with name <n> was found in the <scope> directory.`;
 *    workspace beats global with `WARNING: Agent conflict for <n>. Using workspace version.`
 *    (06 §7.2); unreadable/invalid files are skipped with a warning (`Json supplied at <path>
 *    is invalid: <reason>`) and listed in `failed`.
 *  - built-ins ({@link builtinAgents}) are always present unless a user agent of the same
 *    name overrides them (Q: a user `q_cli_default` overrides the built-in).
 *
 * Parsing ({@link parseAgent}, field table 02 §2.2):
 *  - JSON object, or Markdown with YAML front matter whose body is the prompt (02 §2.1);
 *  - unknown fields warn (`unknown-field`) and never fail (02 §2.1 adapter rule); type
 *    problems warn (`invalid-field`) and the field falls back to its default;
 *  - `dialect`: `permissions` present ⇒ `v3` (capability engine), else `v2` (00 §2.2).
 *    v3 agents get empty V2 fields (`allowedTools`, `toolsSettings`, `toolAliases`), v2
 *    agents get no permission rules;
 *  - `prompt`: `file://` resolved relative to the agent file's directory (`~/` expanded,
 *    `file:///abs` absolute) with Q's error texts (`File URI not found: <uri> (resolved to
 *    <path>)`, …); a prompt that cannot be resolved makes the agent fail to load (Q `thaw`);
 *  - `tools` absent ⇒ `[]` plus a `tools-missing` warning (Q schema default; UNVERIFIED for
 *    V3); the string `"*"` is accepted as `["*"]`;
 *  - `includeMcpJson` absent ⇒ **true** (kiro-cli "reads an absent `includeMcpJson` as
 *    true", recorded from KiroCrew's source in 08a §4.1 — this supersedes the provisional
 *    00 §9 item 12 DECISION of false); an explicit `false` is honored (KiroCrew KC-SPEC-01).
 *    `useLegacyMcpJson` defaults to false (Q schema);
 *  - `inheritDefaultResources` = !`chat.disableInheritingDefaultResources` (custom agents),
 *    always true for built-ins (00 §8 C5).
 *
 * Selection ({@link selectAgent}, 02 §2.11, 06 §7.2): `--agent` > `chat.defaultAgent` >
 * `kiro_default`, with Q's fallback error texts as warnings.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentResource,
  ConfigWarning,
  KiroAgent,
  McpServerConfig,
  PermissionRule,
  SettingsStore,
  WorkspaceContext,
} from '../types.js';
import { parseFrontMatter } from '../util/frontmatter.js';
import { parseJsonText } from '../util/fsx.js';
import { expandTilde, realpathSafe } from '../util/paths.js';
import { stripBom } from '../util/text.js';
import { jsonErrorReason, setOwn } from './diag.js';
import { normalizeAgentHooks } from './hooks.js';
import { normalizeMcpServer } from './mcp.js';
import { parsePermissionRule } from './permissionsYaml.js';
import { legacyGlobalDir, samePath, workspaceAmazonqDir, workspaceKiroDir } from './workspace.js';

/** Q's published schema URL, kept in generated agent files. */
export const AGENT_SCHEMA_URL = 'https://raw.githubusercontent.com/aws/amazon-q-developer-cli/refs/heads/main/schemas/agent-v1.json';

export const DEFAULT_AGENT_NAME = 'kiro_default';
export const PLANNER_AGENT_NAME = 'kiro_planner';
export const HELP_AGENT_NAME = 'kiro_help';
export const BUILTIN_AGENT_NAMES: readonly string[] = [DEFAULT_AGENT_NAME, PLANNER_AGENT_NAME, HELP_AGENT_NAME];

/**
 * JSON schema shown by `agent schema`: Q's `agent-v1.json` (02 Appendix A) extended with the
 * Kiro 2.x / V3 fields (`permissions`, `excludedTools`, `includeMcpJson`, `welcomeMessage`,
 * `keyboardShortcut`, `includePowers`), V3 array hooks and `skill://` / knowledge-base
 * resources. `name` is no longer required (Kiro defaults it to the file name).
 */
export const AGENT_SCHEMA: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Agent',
  description: 'An Agent is a declarative way of configuring a given instance of q chat.',
  type: 'object',
  definitions: {
    hookCommands: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { description: 'The command to run when the hook is triggered', type: 'string' },
          timeout_ms: { type: 'integer', minimum: 0, default: 30000 },
          max_output_size: { type: 'integer', minimum: 0, default: 10240 },
          cache_ttl_seconds: { type: 'integer', minimum: 0, default: 0 },
          matcher: { type: 'string' },
        },
        required: ['command'],
      },
    },
    inlineHook: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        trigger: { type: 'string' },
        matcher: { type: 'string' },
        action: {
          oneOf: [
            { type: 'object', properties: { type: { const: 'command' }, command: { type: 'string' } }, required: ['type', 'command'] },
            { type: 'object', properties: { type: { const: 'agent' }, prompt: { type: 'string' } }, required: ['type', 'prompt'] },
          ],
        },
        timeout: { type: 'number', minimum: 0, default: 60 },
        enabled: { type: 'boolean', default: true },
        confirm: { type: 'object' },
      },
      required: ['name', 'trigger', 'action'],
    },
    TransportType: {
      oneOf: [
        { description: 'Standard input/output transport (default)', type: 'string', const: 'stdio' },
        { description: 'HTTP transport for web-based communication', type: 'string', const: 'http' },
      ],
    },
    permissionRule: {
      type: 'object',
      properties: {
        capability: { type: 'string' },
        match: { type: 'array', items: { type: 'string' } },
        exclude: { type: 'array', items: { type: 'string' } },
        effect: { enum: ['allow', 'ask', 'deny', 'evaluate'] },
      },
      required: ['capability', 'effect'],
    },
  },
  properties: {
    $schema: { description: 'The schema to use for validating the agent', type: 'string' },
    name: { description: 'Name of the agent', type: 'string' },
    description: {
      description: 'This field is not model facing and is mostly here for users to discern between agents',
      type: ['string', 'null'],
      default: null,
    },
    prompt: {
      description:
        'The intention for this field is to provide high level context to the\nagent. This should be seen as the same category of context as a system prompt.\nSupports both inline text and file:// URIs to reference external files.\nExample: "file://./my-prompt.md" (relative to agent config file)',
      type: ['string', 'null'],
      default: null,
    },
    mcpServers: {
      description: 'Configuration for Model Context Protocol (MCP) servers',
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          type: {
            description: 'The type of transport the mcp server is expecting. For http transport, only url (for now) is taken into account',
            $ref: '#/definitions/TransportType',
            default: 'stdio',
          },
          url: { description: 'The URL endpoint for HTTP-based MCP servers', type: 'string', default: '' },
          headers: {
            description: 'HTTP headers to include when communicating with HTTP-based MCP servers',
            type: 'object',
            additionalProperties: { type: 'string' },
            default: {},
          },
          oauthScopes: {
            description: 'Scopes with which oauth is done',
            type: 'array',
            items: { type: 'string' },
            default: ['openid', 'email', 'profile', 'offline_access'],
          },
          oauth: {
            description: 'OAuth configuration for this server',
            type: ['object', 'null'],
            properties: {
              redirectUri: {
                description:
                  'Custom redirect URI for OAuth flow (e.g., "127.0.0.1:7778"). If not specified, a random available port will be assigned by the OS',
                type: ['string', 'null'],
              },
            },
          },
          command: { description: 'The command string used to initialize the mcp server', type: 'string', default: '' },
          args: { description: 'A list of arguments to be used to run the command with', type: 'array', items: { type: 'string' }, default: [] },
          env: {
            description: 'A list of environment variables to run the command with',
            type: ['object', 'null'],
            additionalProperties: { type: 'string' },
          },
          timeout: { description: 'Timeout for each mcp request in ms', type: 'integer', format: 'uint64', minimum: 0, default: 120000 },
          disabled: { description: 'A boolean flag to denote whether or not to load this mcp server', type: 'boolean', default: false },
          autoApprove: { description: 'Tool names approved without asking ("*" = all tools of the server)', type: 'array', items: { type: 'string' } },
          disabledTools: { description: 'Tool names hidden from the model', type: 'array', items: { type: 'string' } },
        },
      },
      default: {},
    },
    tools: {
      description:
        'List of tools the agent can see. Use \\"@{MCP_SERVER_NAME}/tool_name\\" to specify tools from\nmcp servers. To include all tools from a server, use \\"@{MCP_SERVER_NAME}\\"',
      type: 'array',
      items: { type: 'string' },
      default: [],
    },
    excludedTools: {
      description: 'Tools removed even if "tools" selects them (same selectors and tags as "tools")',
      type: 'array',
      items: { type: 'string' },
      default: [],
    },
    toolAliases: {
      description: 'Tool aliases for remapping tool names',
      type: 'object',
      additionalProperties: {
        description: 'The name to change to. For tools in mcp servers, you would need to exclude their server prefix',
        type: 'string',
      },
      propertyNames: {
        description: 'Subject of the tool name change. For tools in mcp servers, you would need to prefix them with their server names',
        type: 'string',
      },
      default: {},
    },
    allowedTools: {
      description: 'List of tools the agent is explicitly allowed to use',
      type: 'array',
      uniqueItems: true,
      items: { type: 'string' },
      default: [],
    },
    resources: {
      description: "Files to include in the agent's context",
      type: 'array',
      items: {
        oneOf: [
          { type: 'string', pattern: '^(file|skill)://' },
          {
            type: 'object',
            properties: {
              type: { const: 'knowledgeBase' },
              source: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              indexType: { enum: ['best', 'fast'] },
              autoUpdate: { type: 'boolean' },
            },
            required: ['type', 'source', 'name'],
          },
        ],
      },
      default: [],
    },
    hooks: {
      description: 'Commands to run when a chat session is created',
      oneOf: [
        {
          type: 'object',
          properties: {
            userPromptSubmit: { $ref: '#/definitions/hookCommands' },
            agentSpawn: { $ref: '#/definitions/hookCommands' },
            preToolUse: { $ref: '#/definitions/hookCommands' },
            postToolUse: { $ref: '#/definitions/hookCommands' },
            stop: { $ref: '#/definitions/hookCommands' },
          },
        },
        { type: 'array', items: { $ref: '#/definitions/inlineHook' } },
      ],
      default: {},
    },
    toolsSettings: {
      description:
        'Settings for specific tools. These are mostly for native tools. The actual schema differs by\ntools and is documented in detail in our documentation',
      type: 'object',
      additionalProperties: { description: 'Settings for tools. Refer to our documentations to see how to configure them', type: 'object' },
      propertyNames: { description: 'The name of the tool to be configured', type: 'string' },
      default: {},
    },
    useLegacyMcpJson: {
      description:
        'Whether or not to include the legacy ~/.aws/amazonq/mcp.json in the agent\nYou can reference tools brought in by these servers as just as you would with the servers\nyou configure in the mcpServers field in this config',
      type: 'boolean',
      default: false,
    },
    includeMcpJson: {
      description: 'Whether to include ~/.kiro/settings/mcp.json and the workspace .kiro/settings/mcp.json (absent: true)',
      type: 'boolean',
      default: true,
    },
    includePowers: { description: 'Whether to include installed powers (not supported by kiro-claude)', type: 'boolean' },
    permissions: {
      description: 'Capability-based permission rules (Kiro V3)',
      type: 'object',
      properties: { rules: { type: 'array', items: { $ref: '#/definitions/permissionRule' } } },
    },
    welcomeMessage: { description: 'Shown when switching to this agent', type: 'string' },
    keyboardShortcut: { description: 'Shortcut that toggles this agent ([ctrl+|shift+]<a-z|0-9>)', type: 'string' },
    model: {
      description: 'The model ID to use for this agent. If not specified, uses the default model.',
      type: ['string', 'null'],
      default: null,
    },
  },
  additionalProperties: false,
};

/** Fields kiro-claude knows (schema + accepted non-schema keys seen in the wild, 02 §2.2). */
const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  ...Object.keys((AGENT_SCHEMA.properties as Record<string, unknown>) ?? {}),
  'kiroUpgrade',
  'includeCrewContext',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Schema-level checks of a raw agent object: unknown fields and field types. Messages use
 * Q's `WARNING Agent config <name> is malformed at /<field>: <error>` shape for type errors.
 */
export function validateAgentObject(obj: unknown, label?: string): ConfigWarning[] {
  const out: ConfigWarning[] = [];
  const name = label ?? (isPlainObject(obj) && typeof obj.name === 'string' ? obj.name : 'agent');
  if (!isPlainObject(obj)) {
    out.push({ code: 'invalid-agent', message: `Agent config ${name} must be an object, found ${typeName(obj)}` });
    return out;
  }
  const bad = (field: string, expected: string, v: unknown): void => {
    out.push({ code: 'invalid-field', message: `WARNING Agent config ${name} is malformed at /${field}: expected ${expected}, found ${typeName(v)}` });
  };
  for (const [k, v] of Object.entries(obj)) {
    if (!KNOWN_FIELDS.has(k)) {
      out.push({ code: 'unknown-field', message: `Agent config ${name} has unknown field '${k}' (ignored)` });
      continue;
    }
    switch (k) {
      case '$schema':
      case 'name':
      case 'welcomeMessage':
      case 'keyboardShortcut':
        if (typeof v !== 'string') bad(k, 'string', v);
        break;
      case 'description':
      case 'prompt':
      case 'model':
        if (v !== null && typeof v !== 'string') bad(k, 'string or null', v);
        break;
      case 'tools':
        if (!isStringArray(v) && v !== '*') bad(k, 'array of strings', v);
        break;
      case 'excludedTools':
      case 'allowedTools':
        if (!isStringArray(v)) bad(k, 'array of strings', v);
        break;
      case 'toolAliases':
        if (!isPlainObject(v) || !Object.values(v).every((x) => typeof x === 'string')) bad(k, 'object of strings', v);
        break;
      case 'toolsSettings':
        if (!isPlainObject(v)) bad(k, 'object', v);
        else
          for (const [tk, tv] of Object.entries(v)) {
            if (!isPlainObject(tv)) bad(`${k}/${tk}`, 'object', tv);
          }
        break;
      case 'mcpServers':
        if (!isPlainObject(v)) bad(k, 'object', v);
        else
          for (const [sk, sv] of Object.entries(v)) {
            if (!isPlainObject(sv)) bad(`${k}/${sk}`, 'object', sv);
          }
        break;
      case 'resources':
        if (!Array.isArray(v)) bad(k, 'array', v);
        else
          v.forEach((r, i) => {
            if (typeof r === 'string') {
              if (!/^(file|skill):\/\//i.test(r)) {
                out.push({
                  code: 'invalid-field',
                  message: `WARNING Agent config ${name} is malformed at /resources/${i}: "${r}" does not match "^(file|skill)://"`,
                });
              }
            } else if (!isPlainObject(r) || r.type !== 'knowledgeBase' || typeof r.source !== 'string' || typeof r.name !== 'string') {
              bad(`resources/${i}`, 'file:// or skill:// string or knowledgeBase object', r);
            }
          });
        break;
      case 'hooks':
        if (!isPlainObject(v) && !Array.isArray(v)) bad(k, 'object or array', v);
        break;
      case 'useLegacyMcpJson':
      case 'includeMcpJson':
      case 'includePowers':
        if (typeof v !== 'boolean') bad(k, 'boolean', v);
        break;
      case 'permissions':
        if (Array.isArray(v)) break; // lenient: bare rule list
        if (!isPlainObject(v)) bad(k, 'object', v);
        else if (v.rules !== undefined && !Array.isArray(v.rules)) bad('permissions/rules', 'array', v.rules);
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Resolve a `file://` prompt URI (Q `file_uri.rs`): relative to `baseDir`, `~/` expanded,
 * must be a regular file. Returns the file text or one of Q's error messages.
 */
export function resolveFilePrompt(uri: string, baseDir: string, env: NodeJS.ProcessEnv): { text?: string; error?: string } {
  const rest = uri.slice('file://'.length);
  if (rest.trim() === '') return { error: `Invalid file URI format: ${uri}` };
  const p = path.resolve(baseDir, expandTilde(rest, env));
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return { error: `File URI not found: ${uri} (resolved to ${p})` };
  }
  if (!st.isFile()) return { error: `File URI not found: ${uri} (resolved to ${p})` };
  try {
    return { text: fs.readFileSync(p, 'utf8') };
  } catch (e) {
    return { error: `Failed to read file URI: ${uri} (resolved to ${p}): ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Options for {@link parseAgent}. */
export interface ParseAgentMeta {
  path?: string;
  scope: KiroAgent['scope'];
  format: KiroAgent['format'];
  ws: WorkspaceContext;
  settings?: SettingsStore;
  /** Name used when the config has no `name` (loadAgents passes the relative stem). */
  defaultName?: string;
}

function parseResources(v: unknown): AgentResource[] {
  if (!Array.isArray(v)) return [];
  const out: AgentResource[] = [];
  for (const r of v) {
    if (typeof r === 'string') {
      if (/^file:\/\//i.test(r)) out.push({ kind: 'file', uri: r });
      else if (/^skill:\/\//i.test(r)) out.push({ kind: 'skill', uri: r });
    } else if (isPlainObject(r) && r.type === 'knowledgeBase' && typeof r.source === 'string' && typeof r.name === 'string') {
      const kb: AgentResource = { kind: 'knowledgeBase', source: r.source, name: r.name };
      if (typeof r.description === 'string') kb.description = r.description;
      out.push(kb);
    }
  }
  return out;
}

function stemOf(p: string): string {
  return path.basename(p).replace(/\.(json|md)$/i, '');
}

/** Parse one agent definition (see module doc). `raw` may be the file text or the parsed value. */
export function parseAgent(raw: unknown, meta: ParseAgentMeta): { agent?: KiroAgent; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const where = meta.path;
  const w = (code: string, message: string): void => {
    warnings.push(where ? { code, message, path: where } : { code, message });
  };
  let obj: unknown = raw;
  let mdBody: string | undefined;
  if (typeof raw === 'string') {
    if (meta.format === 'md') {
      const fm = parseFrontMatter(stripBom(raw));
      if (fm.error) {
        w('invalid-front-matter', `Markdown agent supplied at ${where ?? '<inline>'} is invalid: ${fm.error}`);
        return { warnings };
      }
      obj = fm.data;
      mdBody = fm.body.replace(/\r\n/g, '\n');
    } else {
      try {
        obj = parseJsonText(raw, where ?? '<inline>');
      } catch (e) {
        w('invalid-json', `Json supplied at ${where ?? '<inline>'} is invalid: ${jsonErrorReason(e)}`);
        return { warnings };
      }
    }
  }
  if (!isPlainObject(obj)) {
    w('invalid-agent', `${meta.format === 'md' ? 'Markdown agent' : 'Json'} supplied at ${where ?? '<inline>'} is invalid: expected an object, found ${typeName(obj)}`);
    return { warnings };
  }
  const o = obj;
  const name =
    typeof o.name === 'string' && o.name.trim() !== '' ? o.name.trim() : (meta.defaultName ?? (where ? stemOf(where) : 'unnamed'));
  for (const v of validateAgentObject(o, name)) warnings.push(where ? { ...v, path: where } : v);

  // prompt
  let prompt: string | undefined;
  const baseDir = where ? path.dirname(where) : meta.ws.cwd;
  const resolvePrompt = (p: string): boolean => {
    if (/^file:\/\//i.test(p)) {
      const r = resolveFilePrompt(p, baseDir, meta.ws.env);
      if (r.error !== undefined) {
        w('prompt-file', r.error);
        return false;
      }
      prompt = r.text;
    } else {
      prompt = p;
    }
    return true;
  };
  if (mdBody !== undefined && mdBody.trim() !== '') {
    prompt = mdBody.trim();
    if (typeof o.prompt === 'string') w('md-prompt-ignored', `Agent '${name}': the "prompt" field is ignored in Markdown agents (the body is the prompt)`);
  } else if (typeof o.prompt === 'string' && o.prompt !== '') {
    if (!resolvePrompt(o.prompt)) return { warnings };
  }

  const dialect: KiroAgent['dialect'] = isPlainObject(o.permissions) || Array.isArray(o.permissions) ? 'v3' : 'v2';

  // tools
  let tools: string[];
  if (o.tools === undefined || o.tools === null) {
    tools = [];
    w('tools-missing', `Agent '${name}' has no "tools" field; no tools will be available to it`);
  } else if (o.tools === '*') tools = ['*'];
  else tools = isStringArray(o.tools) ? [...o.tools] : [];

  // MCP servers
  const mcpServers: Record<string, McpServerConfig> = {};
  if (isPlainObject(o.mcpServers)) {
    for (const [sn, sv] of Object.entries(o.mcpServers)) {
      if (!isPlainObject(sv)) continue; // already reported by validateAgentObject
      const r = normalizeMcpServer(sn, sv, 'agent', meta.ws.env, where);
      warnings.push(...r.warnings);
      if (r.server) setOwn(mcpServers, sn, r.server);
    }
  }

  // hooks
  const hr = normalizeAgentHooks(o.hooks, name, where);
  warnings.push(...hr.warnings);

  // permissions (v3)
  const permissions: PermissionRule[] = [];
  if (dialect === 'v3') {
    const rules = Array.isArray(o.permissions) ? o.permissions : isPlainObject(o.permissions) ? o.permissions.rules : undefined;
    if (Array.isArray(rules)) {
      rules.forEach((r, i) => {
        const p = parsePermissionRule(r, 'agent');
        if (p.rule) permissions.push(p.rule);
        else w('permissions-invalid', `Agent '${name}': permissions.rules[${i}]: ${p.error} (ignored)`);
      });
    }
  }

  // V2 fields
  let allowedTools: string[] = [];
  let toolsSettings: Record<string, Record<string, unknown>> = {};
  let toolAliases: Record<string, string> = {};
  if (dialect === 'v2') {
    if (isStringArray(o.allowedTools)) allowedTools = [...new Set(o.allowedTools)];
    if (isPlainObject(o.toolsSettings)) {
      toolsSettings = {};
      for (const [k, v] of Object.entries(o.toolsSettings)) if (isPlainObject(v)) toolsSettings[k] = { ...v };
    }
    if (isPlainObject(o.toolAliases)) {
      toolAliases = {};
      for (const [k, v] of Object.entries(o.toolAliases)) if (typeof v === 'string') toolAliases[k] = v;
    }
  }

  const inherit = meta.scope === 'builtin' ? true : !(meta.settings?.getBoolean('chat.disableInheritingDefaultResources', false) ?? false);

  const agent: KiroAgent = {
    name,
    format: meta.format,
    scope: meta.scope,
    dialect,
    tools,
    excludedTools: isStringArray(o.excludedTools) ? [...o.excludedTools] : [],
    mcpServers,
    includeMcpJson: typeof o.includeMcpJson === 'boolean' ? o.includeMcpJson : true,
    useLegacyMcpJson: o.useLegacyMcpJson === true,
    resources: parseResources(o.resources),
    hooks: hr.hooks,
    permissions,
    allowedTools,
    toolsSettings,
    toolAliases,
    inheritDefaultResources: inherit,
    warnings,
  };
  if (where) agent.path = where;
  if (typeof o.description === 'string') agent.description = o.description;
  if (prompt !== undefined) agent.prompt = prompt;
  if (typeof o.model === 'string' && o.model.trim() !== '') agent.model = o.model.trim();
  if (typeof o.welcomeMessage === 'string') agent.welcomeMessage = o.welcomeMessage;
  if (dialect === 'v2' && typeof o.keyboardShortcut === 'string') agent.keyboardShortcut = o.keyboardShortcut;
  return { agent, warnings };
}

/** Load one agent file (used by `agent validate --path` and by {@link loadAgents}). */
export function loadAgentFile(
  filePath: string,
  meta: Omit<ParseAgentMeta, 'path' | 'format'> & { format?: KiroAgent['format'] },
): { agent?: KiroAgent; warnings: ConfigWarning[] } {
  const format = meta.format ?? (filePath.toLowerCase().endsWith('.md') ? 'md' : 'json');
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    const code = (e as { code?: string }).code;
    return {
      warnings: [
        {
          code: 'agent-read',
          message: code === 'ENOENT' ? `Agent config not found: ${filePath}` : `Failed to read ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
          path: filePath,
        },
      ],
    };
  }
  return parseAgent(text, { ...meta, path: filePath, format });
}

/** The Kiro agent directories for `ws` (no legacy fallback; see {@link agentSearchDirs}). */
export function agentDirs(ws: WorkspaceContext): { workspace: string; global: string } {
  const override = ws.env.KIRO_AGENT_CONFIG_DIR;
  const global = override && override.trim() !== '' ? path.resolve(ws.cwd, expandTilde(override.trim(), ws.env)) : path.join(ws.kiroHome, 'agents');
  return { workspace: path.join(ws.workspaceRoot, '.kiro', 'agents'), global };
}

interface SearchDir {
  dir: string;
  scope: 'workspace' | 'global';
  legacy: boolean;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Directories {@link loadAgents} scans, with legacy fallbacks applied (see module doc). */
export function agentSearchDirs(ws: WorkspaceContext): { dirs: SearchDir[]; warnings: ConfigWarning[] } {
  const warnings: ConfigWarning[] = [];
  const dirs: SearchDir[] = [];
  const override = ws.env.KIRO_AGENT_CONFIG_DIR;
  if (override && override.trim() !== '') {
    dirs.push({ dir: agentDirs(ws).global, scope: 'global', legacy: false });
    return { dirs, warnings };
  }
  const wk = workspaceKiroDir(ws);
  const aq = workspaceAmazonqDir(ws);
  if (wk) {
    const legacyDir = aq ? path.join(aq, 'cli-agents') : undefined;
    if (isDir(wk)) {
      dirs.push({ dir: path.join(wk, 'agents'), scope: 'workspace', legacy: false });
      if (legacyDir && isDir(legacyDir)) {
        warnings.push({
          code: 'legacy-ignored',
          message: `Both .kiro and .amazonq exist in ${ws.workspaceRoot}; using .kiro (agents in ${legacyDir} are ignored)`,
          path: legacyDir,
        });
      }
    } else if (legacyDir && isDir(legacyDir)) {
      dirs.push({ dir: legacyDir, scope: 'workspace', legacy: true });
    }
  }
  const g = path.join(ws.kiroHome, 'agents');
  if (isDir(g)) dirs.push({ dir: g, scope: 'global', legacy: false });
  else dirs.push({ dir: path.join(legacyGlobalDir(ws), 'cli-agents'), scope: 'global', legacy: true });
  // Never scan one directory twice (e.g. KIRO_HOME pointing at the workspace .kiro).
  const out: SearchDir[] = [];
  for (const d of dirs) if (!out.some((x) => samePath(x.dir, d.dir))) out.push(d);
  return { dirs: out, warnings };
}

const MAX_AGENT_DEPTH = 8;

function isAgentFileName(n: string, legacy: boolean): boolean {
  if (n.startsWith('._') || n.startsWith('.')) return false;
  const l = n.toLowerCase();
  if (l.endsWith('.json')) return true;
  return !legacy && l.endsWith('.md');
}

/** Agent files under `dir` as `[abs, relative stem]`, sorted by relative path. */
function listAgentFiles(dir: string, legacy: boolean): [string, string][] {
  const out: [string, string][] = [];
  const walk = (d: string, rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const relName = rel ? `${rel}/${e.name}` : e.name;
      let isDirectory = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          isDirectory = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectory) {
        if (legacy || depth >= MAX_AGENT_DEPTH || e.name.startsWith('.') || e.name === 'node_modules') continue;
        walk(full, relName, depth + 1);
      } else if (isFile && isAgentFileName(e.name, legacy)) {
        out.push([full, relName.replace(/\.(json|md)$/i, '')]);
      }
    }
  };
  walk(dir, '', 0);
  out.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return out;
}

/** Result of {@link loadAgents}. */
export interface LoadAgentsResult {
  agents: Map<string, KiroAgent>;
  warnings: ConfigWarning[];
  /** Files that could not be loaded, keyed by their relative stem (the name they would have had). */
  failed: Map<string, ConfigWarning>;
}

/**
 * Real path of the file a JSON agent's `file://` prompt points at, if any (best effort: the
 * file is parsed leniently and errors are ignored; the real parse reports them).
 */
function jsonPromptFile(file: string, env: NodeJS.ProcessEnv): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
  if (!isPlainObject(data) || typeof data.prompt !== 'string' || !/^file:\/\//i.test(data.prompt)) return undefined;
  const rest = data.prompt.slice('file://'.length);
  if (rest.trim() === '') return undefined;
  return realpathSafe(path.resolve(path.dirname(file), expandTilde(rest, env)));
}

/** Discover and load every agent (see module doc). */
export function loadAgents(ws: WorkspaceContext, opts: { settings?: SettingsStore } = {}): LoadAgentsResult {
  const warnings: ConfigWarning[] = [];
  const failed = new Map<string, ConfigWarning>();
  const sd = agentSearchDirs(ws);
  warnings.push(...sd.warnings);
  const listed = sd.dirs.map((d) => ({ d, files: listAgentFiles(d.dir, d.legacy) }));
  // Markdown files used as `file://` prompts of JSON agents (`prompts/dev.md`) are not agents
  // themselves, although the recursive V3 scan would otherwise pick them up (DECISION).
  const promptFiles = new Set<string>();
  for (const { files } of listed) {
    for (const [file] of files) {
      if (!file.toLowerCase().endsWith('.json')) continue;
      const pf = jsonPromptFile(file, ws.env);
      if (pf) promptFiles.add(pf);
    }
  }
  const byScope: Record<'workspace' | 'global', KiroAgent[]> = { workspace: [], global: [] };
  for (const { d, files } of listed) {
    for (const [file, stem] of files) {
      if (file.toLowerCase().endsWith('.md') && promptFiles.has(realpathSafe(file))) continue;
      const meta: Omit<ParseAgentMeta, 'path' | 'format'> = { scope: d.scope, ws, defaultName: stem };
      if (opts.settings) meta.settings = opts.settings;
      const r = loadAgentFile(file, meta);
      warnings.push(...r.warnings);
      if (!r.agent) {
        const reason = r.warnings.find((x) => x.code !== 'unknown-field' && x.code !== 'invalid-field') ?? r.warnings[0];
        if (reason && !failed.has(stem)) failed.set(stem, reason);
        continue;
      }
      const list = byScope[d.scope];
      if (list.some((a) => a.name === r.agent!.name)) {
        warnings.push({
          code: 'agent-duplicate',
          message: `WARNING: Duplicate agent with name ${r.agent.name} was found in the ${d.scope} directory.`,
          path: file,
        });
        continue;
      }
      list.push(r.agent);
    }
  }
  const agents = new Map<string, KiroAgent>();
  for (const a of byScope.workspace) agents.set(a.name, a);
  for (const a of byScope.global) {
    if (agents.has(a.name)) {
      warnings.push({ code: 'agent-conflict', message: `WARNING: Agent conflict for ${a.name}. Using workspace version.`, path: a.path });
      continue;
    }
    agents.set(a.name, a);
  }
  for (const b of builtinAgents(ws)) if (!agents.has(b.name)) agents.set(b.name, b);
  return { agents, warnings, failed };
}

// ───────────────────────────── built-ins ─────────────────────────────

const PLANNER_PROMPT = `You are the Kiro planning agent. You are in read-only plan mode: you may read files, search the codebase and search the web, but you must not write files, run commands or call MCP tools.

Work in three steps:
1. If the request is ambiguous, ask structured questions first, in this format:
[1]: <question>
a. <option>
b. <option>
(Answer with "1=a, 2=b" or provide your own answers)
2. Research the codebase as needed to ground the plan.
3. Produce the plan in this format:
**Implementation Plan - <Title>**
**Problem Statement:** <one paragraph>
**Requirements:**
- <requirement>
**Task Breakdown:**
Task 1: <title>
- <step>
- Demo: <what works after this task>

Keep tasks small, ordered and independently verifiable. Do not start implementing.`;

const HELP_PROMPT = `You are the Kiro help agent running inside kiro-claude, a port of the Kiro CLI that uses the locally installed Claude Code as its model backend. Answer questions about using kiro-claude: chat and its slash commands (/help, /agent, /model, /context, /tools, /hooks, /prompts, /spec, /clear, /compact, /quit), custom agents (~/.kiro/agents and .kiro/agents, JSON or Markdown), steering files (.kiro/steering), MCP servers (.kiro/settings/mcp.json), hooks, prompts, skills and settings (kiro-claude settings). You may read files to look up the user's configuration. Be concise; when unsure, say so.`;

function builtin(base: Partial<KiroAgent> & Pick<KiroAgent, 'name'>): KiroAgent {
  return {
    format: 'builtin',
    scope: 'builtin',
    dialect: 'v3',
    tools: [],
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
    ...base,
  };
}

/** Default resource list of `kiro_default` (02 §2.11 reconstruction). */
export const KIRO_DEFAULT_RESOURCES: readonly string[] = [
  'file://AGENTS.md',
  'file://README.md',
  'file://AmazonQ.md',
  'file://.kiro/steering/**/*.md',
  'file://~/.kiro/steering/**/*.md',
  'file://.amazonq/rules/**/*.md',
  'skill://.kiro/skills/*/SKILL.md',
  'skill://~/.kiro/skills/*/SKILL.md',
];

/**
 * Built-in agents: `kiro_default` (06 §7.5 + 02 §2.11 adapted: all tools, default resources,
 * global + workspace + legacy mcp.json, V3 default policy), `kiro_planner` (read-only
 * planner, 02 §2.11 / 03 §5.4) and `kiro_help` (stub help prompt).
 */
export function builtinAgents(ws: WorkspaceContext): KiroAgent[] {
  void ws;
  const resources = (list: readonly string[]): AgentResource[] =>
    list.map((u) => (u.startsWith('skill://') ? { kind: 'skill' as const, uri: u } : { kind: 'file' as const, uri: u }));
  return [
    builtin({
      name: DEFAULT_AGENT_NAME,
      description: 'Default agent',
      tools: ['*'],
      includeMcpJson: true,
      useLegacyMcpJson: true,
      resources: resources(KIRO_DEFAULT_RESOURCES),
    }),
    builtin({
      name: PLANNER_AGENT_NAME,
      description: 'Plan agent: read-only research and implementation planning',
      prompt: PLANNER_PROMPT,
      tools: ['read', 'web'],
      resources: resources(KIRO_DEFAULT_RESOURCES.filter((u) => u !== 'file://README.md' && u !== 'file://AmazonQ.md')),
      permissions: [
        { capability: 'fs_write', effect: 'deny', scope: 'agent' },
        { capability: 'shell', effect: 'deny', scope: 'agent' },
        { capability: 'mcp', effect: 'deny', scope: 'agent' },
        { capability: 'subagent', effect: 'deny', scope: 'agent' },
        { capability: 'fs_read', effect: 'allow', scope: 'agent' },
        { capability: 'web_search', effect: 'allow', scope: 'agent' },
      ],
    }),
    builtin({
      name: HELP_AGENT_NAME,
      description: 'Help agent: answers questions about using kiro-claude',
      prompt: HELP_PROMPT,
      tools: ['read'],
      permissions: [
        { capability: 'fs_write', effect: 'deny', scope: 'agent' },
        { capability: 'shell', effect: 'deny', scope: 'agent' },
      ],
    }),
  ];
}

// ───────────────────────────── selection ─────────────────────────────

/** Result of {@link selectAgent}. */
export interface SelectAgentResult {
  agent: KiroAgent;
  warnings: ConfigWarning[];
  /** The `--agent` name that was not found (headless callers exit 4). */
  missingRequested?: string;
  /** The `chat.defaultAgent` value that was not found. */
  missingDefault?: string;
}

/**
 * Pick the active agent: `requested` (`--agent`) > `chat.defaultAgent` > `kiro_default`
 * (02 §2.11), with Q's fallback texts (06 §7.2) as warnings. The caller decides whether a
 * missing agent is fatal (non-interactive ⇒ exit 4).
 */
export function selectAgent(
  ws: WorkspaceContext,
  agents: ReadonlyMap<string, KiroAgent>,
  settings: SettingsStore,
  requested?: string,
  opts: { interactive: boolean } = { interactive: true },
): SelectAgentResult {
  void opts;
  const warnings: ConfigWarning[] = [];
  const res: Partial<SelectAgentResult> = {};
  if (requested !== undefined && requested !== '') {
    const a = agents.get(requested);
    if (a) return { agent: a, warnings };
    warnings.push({ code: 'agent-missing', message: `Error: no agent with name ${requested} found. Falling back to user specified default` });
    res.missingRequested = requested;
  }
  const d = settings.getString('chat.defaultAgent');
  if (d !== undefined && d !== '') {
    const a = agents.get(d);
    if (a) return { ...res, agent: a, warnings };
    warnings.push({ code: 'default-agent-missing', message: `Error: user defined default ${d} not found. Falling back to in-memory default` });
    res.missingDefault = d;
  }
  const def = agents.get(DEFAULT_AGENT_NAME) ?? builtinAgents(ws)[0]!;
  return { ...res, agent: def, warnings };
}

// ───────────────────────────── create template ─────────────────────────────

/**
 * Content of a new agent file (06 §7.6 Q template, keys in Q's order, adapted to Kiro:
 * Kiro resource paths and `includeMcpJson: true` in place of `useLegacyMcpJson: true`).
 * Serialize with `JSON.stringify(t, null, 2)`.
 */
export function agentCreateTemplate(
  name: string,
  opts: { description?: string; prompt?: string; tools?: string[]; mcpServers?: object } = {},
): Record<string, unknown> {
  return {
    $schema: AGENT_SCHEMA_URL,
    name,
    description: opts.description ?? '',
    prompt: opts.prompt ?? null,
    mcpServers: opts.mcpServers ?? {},
    tools: opts.tools ?? ['*'],
    toolAliases: {},
    allowedTools: [],
    resources: ['file://AGENTS.md', 'file://README.md', 'file://.kiro/steering/**/*.md'],
    hooks: {},
    toolsSettings: {},
    includeMcpJson: true,
    model: null,
  };
}

/** Display path for `/agent list` (`**No path found**` for built-ins, Q 01 §2.1). */
export function agentLocation(agent: KiroAgent): string {
  return agent.path ? path.dirname(agent.path) : '**No path found**';
}
