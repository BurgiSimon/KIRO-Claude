/**
 * Exact Q / Kiro strings used around hook execution (06 §3.3, §3.4, §3.7; 02 §7.1, §7.6;
 * 03 §2.5; 00 §2.4). Pure functions only; nothing here prints.
 *
 *  - {@link wrapHookContext}: Q's `format_hook_context` (`Q:cli/chat/conversation.rs:1093-1119`).
 *    agentSpawn/SessionStart outputs get the ` for the entire conversation` variant, the
 *    userPromptSubmit outputs the plain one. Returns `''` when every output is empty (Q `None`);
 *    otherwise every output (empty ones included) is followed by `\n\n`.
 *  - {@link formatHookFailure}: the non-zero exit line
 *    `✗ <trigger> "<command>" failed with exit code: <n>, stderr: <output trimEnd>)` — the stray
 *    `)` is Q's (06 §3.4). Printed for exit 2 too.
 *  - {@link formatHookError}: spawn error / timeout line `✗ <command> failed after <s.ss> s: <err>`.
 *  - {@link formatHooksProgress} / {@link formatHooksFinished}: spinner text and the summary line.
 *  - {@link preToolBlockMessage}: `PreToolHook blocked the tool execution: <stderr>` (02 App. B).
 *  - Stop continuation default text (03 §2.5) and the port's 3-continuation guard.
 *
 * Colors are left to the UI (Q: `✗` red, command blue, duration yellow); these are plain strings.
 */

/** Q `CONTEXT_ENTRY_START_HEADER`. */
export const CONTEXT_ENTRY_BEGIN = '--- CONTEXT ENTRY BEGIN ---\n';
/** Q `CONTEXT_ENTRY_END_HEADER`. */
export const CONTEXT_ENTRY_END = '--- CONTEXT ENTRY END ---\n\n';

/** Body sentence of Q's hook context block (06 §3.7). */
export const HOOK_CONTEXT_PREAMBLE =
  'This section (like others) contains important information that I want you to use in your responses. ' +
  'I have gathered this context from valuable programmatic script hooks. You must follow any requests and ' +
  'consider all of the information in this section';

/** Appended to {@link HOOK_CONTEXT_PREAMBLE} for agentSpawn / SessionStart output only. */
export const WHOLE_CONVERSATION_SUFFIX = ' for the entire conversation';

/** Text appended to truncated hook output (Q `max_output_size`, 06 §3.3). */
export const TRUNCATED_SUFFIX = ' ... truncated';

/** Default Stop-hook continuation text when the hook gave no reason (03 §2.5, 00 §2.4). */
export const DEFAULT_STOP_CONTINUE_TEXT = 'Continue working; the stop hook requested more work.';

/** Port loop guard: max consecutive hook-driven continuations without a user message (03 §2.5). */
export const MAX_HOOK_CONTINUATIONS = 3;

/** Prefix Q uses for the PreToolUse block result (02 App. B, 06 §3.7). */
export const PRE_TOOL_BLOCK_PREFIX = 'PreToolHook blocked the tool execution: ';

/**
 * Q `format_hook_context`: wrap hook outputs in a context entry. `wholeConversation` selects the
 * agentSpawn variant (` for the entire conversation`). Returns `''` if no output is non-empty.
 */
export function wrapHookContext(outputs: readonly string[], wholeConversation: boolean): string {
  if (outputs.every((o) => o.length === 0)) return '';
  let s = CONTEXT_ENTRY_BEGIN + HOOK_CONTEXT_PREAMBLE;
  if (wholeConversation) s += WHOLE_CONVERSATION_SUFFIX;
  s += '\n\n';
  for (const o of outputs) s += `${o}\n\n`;
  s += CONTEXT_ENTRY_END;
  return s;
}

/** `✗ <trigger> "<command>" failed with exit code: <n>, stderr: <output trimEnd>)` (06 §3.4). */
export function formatHookFailure(trigger: string, command: string, exitCode: number, output: string): string {
  return `✗ ${trigger} "${command}" failed with exit code: ${exitCode}, stderr: ${output.trimEnd()})`;
}

/** Seconds with two decimals, as Q prints durations (`{:.2}`). */
export function formatSeconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(2);
}

/** `✗ <command> failed after <s.ss> s: <err>` for spawn errors and timeouts (06 §3.4). */
export function formatHookError(command: string, durationMs: number, error: string): string {
  return `✗ ${command} failed after ${formatSeconds(durationMs)} s: ${error}`;
}

/**
 * The Q warning line for one failed hook run: {@link formatHookError} when the run errored
 * (timeout, spawn failure), else {@link formatHookFailure} for a non-zero exit.
 */
export function formatHookWarning(w: {
  trigger: string;
  command: string;
  exitCode?: number;
  output?: string;
  error?: string;
  durationMs?: number;
}): string {
  if (w.error !== undefined) return formatHookError(w.command, w.durationMs ?? 0, w.error);
  return formatHookFailure(w.trigger, w.command, w.exitCode ?? -1, w.output ?? '');
}

/** Q timeout error text (06 §3.3). */
export function hookTimeoutError(timeoutMs: number): string {
  return `command timed out after ${timeoutMs} ms`;
}

/** Q spawn error text (06 §3.3). */
export function hookSpawnError(err: string): string {
  return `failed to execute command: ${err}`;
}

/** Spinner text while hooks run: `<k> of <n> hooks finished` (06 §3.4). */
export function formatHooksProgress(done: number, total: number): string {
  return `${done} of ${total} hooks finished`;
}

/** Summary after the last hook: `<✓|✗> <k> of <n> hooks finished in <s.ss> s` (✓ iff all exit 0). */
export function formatHooksFinished(done: number, total: number, durationMs: number, allOk: boolean): string {
  return `${allOk ? '✓' : '✗'} ${formatHooksProgress(done, total)} in ${formatSeconds(durationMs)} s`;
}

/** Text of the PreToolUse block (sent as `permissionDecisionReason`, 00 §2.4 / C15). */
export function preToolBlockMessage(stderr: string): string {
  return PRE_TOOL_BLOCK_PREFIX + stderr;
}

/**
 * V3 CLI UserPromptSubmit non-zero exit: the prompt is still sent and the hook's output plus its
 * exit code are forwarded to the agent as context (02 §7.6). Exact Kiro wording is unknown
 * (UNVERIFIED); DECISION: `<trigger> hook "<name>" exited with code <n>` + `:\n<output>` when
 * there is output.
 */
export function formatPromptHookExitNote(trigger: string, hookName: string, exitCode: number, output: string): string {
  const out = output.trimEnd();
  return `${trigger} hook "${hookName}" exited with code ${exitCode}${out ? `:\n${out}` : ''}`;
}

/** Same as {@link formatPromptHookExitNote} for a timeout / spawn error (03 §2.5: timeout = non-zero). */
export function formatPromptHookErrorNote(trigger: string, hookName: string, error: string): string {
  return `${trigger} hook "${hookName}" failed: ${error}`;
}

/** Past-tense verb for a file trigger (`created`, `saved`, `deleted`). */
export function fileTriggerVerb(trigger: 'PostFileCreate' | 'PostFileSave' | 'PostFileDelete'): string {
  return trigger === 'PostFileCreate' ? 'created' : trigger === 'PostFileDelete' ? 'deleted' : 'saved';
}

/**
 * Agent action of a file trigger ⇒ PostToolUse `additionalContext` (03 §2.5):
 * `File <path> was saved. <prompt>` (`created` / `deleted` for the other triggers).
 */
export function formatFileHookContext(
  trigger: 'PostFileCreate' | 'PostFileSave' | 'PostFileDelete',
  filePath: string,
  prompt: string,
): string {
  return `File ${filePath} was ${fileTriggerVerb(trigger)}. ${prompt}`;
}

/** Warning when the Stop continuation guard suppresses a continuation (port wording). */
export function formatContinuationLimitWarning(limit: number = MAX_HOOK_CONTINUATIONS): string {
  return `Stop hook requested another turn, but ${limit} consecutive hook-driven continuations were already sent; not continuing.`;
}
