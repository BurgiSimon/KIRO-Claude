/**
 * Wire types for the Claude Code headless protocol (`claude -p --input-format stream-json
 * --output-format stream-json --verbose --permission-prompt-tool stdio`), as verified against
 * Claude Code 2.1.318.
 *
 * Sources: 00-synthesis §3 (binding wire reference: §3.3 initialize, §3.4 user turn, §3.5
 * hook_callback, §3.6 can_use_tool, §3.7 host control requests, §3.9 frames, §3.11 errors) and
 * 04-claude-protocol §5–§8 (full catalog).
 *
 * Design rules:
 * - Types are deliberately LOOSE. Every frame/request type carries an index signature
 *   (`[k: string]: unknown`) because the CLI emits many undocumented fields and new ones appear
 *   in every release. Only fields the adapter reads are typed.
 * - The set of frame `type`s and `subtype`s is OPEN: consumers must ignore what they do not
 *   understand (00 §3.9 "anything else ⇒ ignore"). `ClaudeFrame` therefore includes
 *   `UnknownFrame`.
 * - A handful of tiny type guards are exported for convenience; they never throw.
 */

/* ------------------------------------------------------------------------------------------ */
/* Content blocks                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface TextBlock {
  type: 'text';
  text: string;
  [k: string]: unknown;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ThinkingBlock {
  type: 'thinking';
  /** May be empty: with the default thinking display only the signature is sent (04 §6.2). */
  thinking: string;
  signature?: string;
  [k: string]: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  /** A string, or (MCP / subagent results) an array of content blocks. */
  content?: string | Array<TextBlock | { type: string; [k: string]: unknown }>;
  is_error?: boolean;
  [k: string]: unknown;
}

/** Any content block we do not model explicitly. */
export interface UnknownBlock {
  type: string;
  [k: string]: unknown;
}

export type AssistantContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | UnknownBlock;

/** Content blocks the host may send in a user turn (00 §3.4). */
export type UserContentBlock =
  | { type: 'text'; text: string; [k: string]: unknown }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string } | { type: string; [k: string]: unknown };
      [k: string]: unknown;
    }
  | {
      type: 'document';
      source:
        | { type: 'base64'; media_type: string; data: string }
        | { type: 'text'; media_type: string; data: string }
        | { type: string; [k: string]: unknown };
      title?: string;
      [k: string]: unknown;
    };

/* ------------------------------------------------------------------------------------------ */
/* CLI → host frames (stdout)                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** Fields common to (almost) every CLI frame. */
export interface FrameBase {
  type: string;
  session_id?: string;
  uuid?: string;
  [k: string]: unknown;
}

export interface McpServerInitStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | string;
  source?: string;
  [k: string]: unknown;
}

/** `system/init`: emitted at the start of EVERY turn (00 §3.9, 04 §6.1). */
export interface SystemInitFrame extends FrameBase {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd?: string;
  tools?: string[];
  mcp_servers?: McpServerInitStatus[];
  model?: string;
  permissionMode?: string;
  slash_commands?: string[];
  /** `"none"` for subscription/OAuth auth; e.g. `"ANTHROPIC_API_KEY"` when an env key is used. */
  apiKeySource?: string;
  claude_code_version?: string;
  output_style?: string;
  agents?: string[];
  skills?: string[];
  plugins?: Array<{ name: string; path?: string; version?: string; [k: string]: unknown }>;
  user_message_uuids?: string[];
}

/** Any other `system` subtype (status, compact_boundary, task_*, thinking_tokens, …). */
export interface SystemFrame extends FrameBase {
  type: 'system';
  subtype: string;
}

export interface AssistantMessage {
  id?: string;
  model?: string;
  role?: 'assistant';
  content: AssistantContentBlock[];
  stop_reason?: string | null;
  usage?: Usage;
  [k: string]: unknown;
}

/** One frame per completed content block; several may share `message.id` (04 §6.2). */
export interface AssistantFrame extends FrameBase {
  type: 'assistant';
  message: AssistantMessage;
  parent_tool_use_id?: string | null;
  /**
   * `SDKAssistantMessageError`: `authentication_failed | oauth_org_not_allowed | account_on_hold |
   * verification_required | billing_error | rate_limit | overloaded | invalid_request |
   * model_not_found | server_error | unknown | max_output_tokens | cloud_credential_error`.
   */
  error?: string;
  uuid?: string;
}

export interface UserFrame extends FrameBase {
  type: 'user';
  message: {
    role: 'user';
    content: string | Array<ToolResultBlock | TextBlock | UnknownBlock>;
    [k: string]: unknown;
  };
  parent_tool_use_id?: string | null;
  /** Structured tool output (per-tool shape, 00 §3.12), or an error string. */
  tool_use_result?: unknown;
  isSynthetic?: boolean;
  isReplay?: boolean;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [k: string]: unknown;
}

export interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  [k: string]: unknown;
}

export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Exactly one per turn. A turn FAILED iff `is_error === true` (00 §3.9/§3.11) — `subtype` alone
 * is not reliable (auth failures are `subtype:"success", is_error:true`).
 */
export interface ResultFrame extends FrameBase {
  type: 'result';
  subtype:
    | 'success'
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries'
    | string;
  is_error: boolean;
  result?: string;
  /** This turn only. */
  usage?: Usage;
  /** Cumulative for the process. */
  total_cost_usd?: number;
  /** Cumulative per model; `contextWindow` gives the model's window. */
  modelUsage?: Record<string, ModelUsageEntry>;
  num_turns?: number;
  duration_ms?: number;
  permission_denials?: PermissionDenial[];
  user_message_uuid?: string;
  user_message_uuids?: string[];
  /** Present for local slash commands (`clear`, `compact`, `effort`, `model`, `cost`, `context`). */
  local_command?: string;
  terminal_reason?: string;
  stop_reason?: string | null;
  errors?: string[];
  session_id: string;
  /**
   * Set (never by the CLI) on the result `ClaudeProcess.turn()` synthesises when its user line
   * was `cancelled` before it started (`is_error:true`, `terminal_reason:"cancelled"`).
   */
  synthetic?: boolean;
}

/** `--include-partial-messages` raw Anthropic stream events (04 §6.4). */
export interface StreamEventFrame extends FrameBase {
  type: 'stream_event';
  event: {
    type: string;
    index?: number;
    delta?: { type: string; text?: string; thinking?: string; partial_json?: string; [k: string]: unknown };
    content_block?: { type: string; [k: string]: unknown };
    message?: Record<string, unknown>;
    [k: string]: unknown;
  };
  parent_tool_use_id?: string | null;
}

/** Emitted by `/clear`: subsequent frames carry `new_conversation_id` as session id (00 §3.8). */
export interface ConversationResetFrame extends FrameBase {
  type: 'conversation_reset';
  new_conversation_id: string;
  trigger?: string;
  user_message_uuid?: string;
}

export interface RateLimitFrame extends FrameBase {
  type: 'rate_limit_event';
  rate_limit_info?: {
    status?: 'allowed' | 'allowed_warning' | 'rejected' | string;
    resetsAt?: number;
    rateLimitType?: string;
    unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string; [k: string]: unknown }>;
    [k: string]: unknown;
  };
}

/** Lifecycle of a user line sent with a `uuid` (00 §3.4). */
export interface CommandLifecycleFrame extends FrameBase {
  type: 'command_lifecycle';
  command_uuid: string;
  state: 'queued' | 'started' | 'completed' | 'cancelled' | string;
}

/** A frame whose type we do not model (`active_goal`, `autocompact_state`, `tool_progress`, …). */
export interface UnknownFrame extends FrameBase {
  type: string;
}

/** Every non-control frame the CLI may emit. */
export type ClaudeFrame =
  | SystemInitFrame
  | SystemFrame
  | AssistantFrame
  | UserFrame
  | ResultFrame
  | StreamEventFrame
  | ConversationResetFrame
  | RateLimitFrame
  | CommandLifecycleFrame
  | UnknownFrame;

/* ------------------------------------------------------------------------------------------ */
/* Control protocol (both directions)                                                          */
/* ------------------------------------------------------------------------------------------ */

export interface ControlRequestFrame<R extends { subtype: string } = { subtype: string; [k: string]: unknown }> {
  type: 'control_request';
  request_id: string;
  request: R;
  [k: string]: unknown;
}

export type ControlResponsePayload =
  | { subtype: 'success'; request_id: string; response?: unknown; [k: string]: unknown }
  | { subtype: 'error'; request_id: string; error: string; [k: string]: unknown };

export interface ControlResponseFrame {
  type: 'control_response';
  response: ControlResponsePayload;
  [k: string]: unknown;
}

/** Withdraws a pending request; the receiver must NOT answer it (00 §3.6, 04 §5.4). */
export interface ControlCancelRequestFrame {
  type: 'control_cancel_request';
  request_id: string;
  [k: string]: unknown;
}

/* --- hook_callback (CLI → host) ----------------------------------------------------------- */

/**
 * Input of an in-process hook callback (00 §3.5). PreToolUse fields are VERIFIED; PostToolUse
 * adds `tool_response`/`duration_ms` (VERIFIED R2); PostToolUseFailure adds `error`/`is_interrupt`
 * (TYPED only).
 */
export interface HookInput {
  hook_event_name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt_id?: string;
  permission_mode?: string;
  effort?: { level?: string; [k: string]: unknown };
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  /** Present only for calls made inside a subagent. */
  agent_id?: string;
  agent_type?: string;
  /** MCP calls: `{name, source}`. */
  mcp_server?: { name: string; source?: string; [k: string]: unknown };
  /** PostToolUse. */
  tool_response?: unknown;
  duration_ms?: number;
  /** PostToolUseFailure (TYPED). */
  error?: string;
  is_interrupt?: boolean;
  [k: string]: unknown;
}

export interface HookCallbackRequest {
  subtype?: 'hook_callback';
  callback_id: string;
  input: HookInput;
  tool_use_id?: string;
  [k: string]: unknown;
}

export interface PreToolUseHookSpecificOutput {
  hookEventName: 'PreToolUse';
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  additionalContext?: string;
  updatedInput?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface PostToolUseHookSpecificOutput {
  hookEventName: 'PostToolUse' | 'PostToolUseFailure';
  additionalContext?: string;
  [k: string]: unknown;
}

/** `SyncHookJSONOutput` subset we answer hook callbacks with (00 §3.5). `{}` = no decision. */
export interface HookCallbackOutput {
  continue?: boolean;
  decision?: 'approve' | 'block';
  reason?: string;
  systemMessage?: string;
  stopReason?: string;
  suppressOutput?: boolean;
  hookSpecificOutput?: PreToolUseHookSpecificOutput | PostToolUseHookSpecificOutput;
  [k: string]: unknown;
}

/* --- can_use_tool (CLI → host) ------------------------------------------------------------ */

/** Sent only after the gate answered `ask` (or for tools the gate passes through) (00 §3.6). */
export interface CanUseToolRequest {
  subtype?: 'can_use_tool';
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
  description?: string;
  display_name?: string;
  decision_reason?: string;
  /** `rule|mode|subcommandResults|permissionPromptTool|hook|asyncAgent|sandboxOverride|workingDir|safetyCheck|classifier|other`. */
  decision_reason_type?: string;
  permission_suggestions?: unknown[];
  blocked_path?: string;
  mcp_server?: { name: string; source?: string; [k: string]: unknown };
  agent_id?: string;
  [k: string]: unknown;
}

/**
 * Answer to `can_use_tool`. `deny.message` is shown verbatim to the model (tool_result
 * is_error); with `interrupt:true` the model gets a generic rejection and the turn ends
 * (`error_during_execution` / `aborted_tools`) (00 §3.6, VERIFIED 04 e2–e4).
 */
export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; [k: string]: unknown }
  | { behavior: 'deny'; message: string; interrupt?: boolean; [k: string]: unknown };

/* --- initialize (host → CLI) -------------------------------------------------------------- */

export interface HookCallbackMatcher {
  /** Regex-ish tool-name matcher; omitted ⇒ every tool (VERIFIED 07). */
  matcher?: string;
  hookCallbackIds: string[];
  /** Seconds. */
  timeout?: number;
  onFailure?: 'continue' | 'block';
}

export interface InitializeRequest {
  hooks?: Record<string, HookCallbackMatcher[]>;
  /** Skill filter, e.g. `["kiro:backend-patterns"]` (TYPED). */
  skills?: string[];
  [k: string]: unknown;
}

export interface ModelInfo {
  /** Alias or full id usable with `--model` / `set_model` (e.g. `default`, `haiku`). */
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  /** `null`/absent ⇒ effort unsupported. */
  supportedEffortLevels?: string[] | null;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
  supportsThinkingOff?: boolean;
  [k: string]: unknown;
}

export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
  [k: string]: unknown;
}

export interface InitializeResponse {
  commands?: SlashCommandInfo[];
  models?: ModelInfo[];
  account?: {
    subscriptionType?: string;
    apiProvider?: string;
    email?: string;
    organization?: string;
    tokenSource?: string;
    apiKeySource?: string;
    [k: string]: unknown;
  };
  agents?: Array<{ name: string; description?: string; model?: string; [k: string]: unknown }>;
  claude_code_version?: string;
  pid?: number;
  current_permission_mode?: string;
  output_style?: string;
  available_output_styles?: string[];
  hooks_applied?: boolean;
  [k: string]: unknown;
}

/* --- host → CLI info requests (00 §3.7) --------------------------------------------------- */

export interface ContextUsageCategory {
  id?: string;
  name: string;
  tokens: number;
  kind?: 'used' | 'free' | 'buffer' | 'deferred' | string;
  [k: string]: unknown;
}

/**
 * Answer to the host `interrupt` control request (VERIFIED 2.1.319): `still_queued` = user lines
 * the CLI keeps queued (they run after the interrupted result); with `cancel_queued:true` it is
 * empty and `cancelled` lists the dropped lines (each also reported `command_lifecycle
 * cancelled`, before this answer).
 */
export interface InterruptResponse {
  still_queued?: string[];
  cancelled?: string[];
  [k: string]: unknown;
}

/**
 * Answer to the host `cancel_async_message` control request (`{message_uuid}`, VERIFIED 2.1.319):
 * `cancelled:true` = the user line was still queued and is dropped (reported `command_lifecycle
 * cancelled` first); `false` = it was no longer queued (already started) or the CLI declined.
 */
export interface CancelAsyncMessageResponse {
  cancelled?: boolean;
  [k: string]: unknown;
}

export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  categories?: ContextUsageCategory[];
  model?: string;
  autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
  [k: string]: unknown;
}

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | string;
  tools?: Array<{ name: string; [k: string]: unknown }>;
  serverInfo?: { name?: string; version?: string; [k: string]: unknown };
  error?: string;
  [k: string]: unknown;
}

export interface McpStatus {
  mcpServers: McpServerStatus[];
  [k: string]: unknown;
}

/* --- host → CLI user line (00 §3.4) ------------------------------------------------------- */

export interface UserInputLine {
  type: 'user';
  message: { role: 'user'; content: string | UserContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
  uuid: string;
  priority?: 'now' | 'next' | 'later';
  [k: string]: unknown;
}

/* ------------------------------------------------------------------------------------------ */
/* Type guards (never throw)                                                                   */
/* ------------------------------------------------------------------------------------------ */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isSystemInit(f: unknown): f is SystemInitFrame {
  return isObj(f) && f.type === 'system' && f.subtype === 'init';
}

export function isAssistantFrame(f: unknown): f is AssistantFrame {
  return isObj(f) && f.type === 'assistant' && isObj(f.message);
}

export function isUserFrame(f: unknown): f is UserFrame {
  return isObj(f) && f.type === 'user' && isObj(f.message);
}

export function isResultFrame(f: unknown): f is ResultFrame {
  return isObj(f) && f.type === 'result';
}

export function isStreamEvent(f: unknown): f is StreamEventFrame {
  return isObj(f) && f.type === 'stream_event' && isObj(f.event);
}

export function isConversationReset(f: unknown): f is ConversationResetFrame {
  return isObj(f) && f.type === 'conversation_reset' && typeof f.new_conversation_id === 'string';
}

export function isRateLimitEvent(f: unknown): f is RateLimitFrame {
  return isObj(f) && f.type === 'rate_limit_event';
}

/** Text of an assistant frame's `text` blocks, concatenated (thinking/tool blocks ignored). */
export function assistantText(f: AssistantFrame): string {
  const content = Array.isArray(f.message?.content) ? f.message.content : [];
  let out = '';
  for (const b of content) {
    if (isObj(b) && b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  return out;
}

/** `tool_use` blocks of an assistant frame. */
export function toolUses(f: AssistantFrame): ToolUseBlock[] {
  const content = Array.isArray(f.message?.content) ? f.message.content : [];
  return content.filter((b): b is ToolUseBlock => isObj(b) && b.type === 'tool_use' && typeof b.id === 'string');
}

/** `tool_result` blocks of a user frame. */
export function toolResults(f: UserFrame): ToolResultBlock[] {
  const content = f.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is ToolResultBlock => isObj(b) && b.type === 'tool_result');
}

/** Flattens a tool_result `content` (string or block array) to plain text. */
export function toolResultText(b: ToolResultBlock): string {
  if (typeof b.content === 'string') return b.content;
  if (!Array.isArray(b.content)) return '';
  return b.content
    .map((c) => (isObj(c) && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .join('');
}
