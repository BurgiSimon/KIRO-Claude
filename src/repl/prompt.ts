/**
 * Prompt string, greeting and fixed REPL texts.
 *
 * Prompt (06 §5.1, Q `prompt_parser.rs` exact):
 * `{profile}{pct}{tangent}{warning}> ` where profile = `[<agent>] ` unless the agent is the
 * default (`kiro_default`), pct = `<N>% ` (context usage, `toFixed(0)`, only with
 * `chat.enableContextUsageIndicator`), tangent = `↯ `, warning = `!` (trust-all). Plan mode
 * shows `[plan] ` in the profile slot (01 §4.2, Kiro `[plan] > `). Colours: profile cyan, pct
 * green/yellow/red by floor(pct) < 50 / < 90 / else, `↯ ` yellow, `!` red, `> ` magenta.
 *
 * Greeting (06 §5.2 order, adapted per 01 §4.1 "Port recommendation"): welcome line (or
 * `Picking up where we left off...` when resumed), a tip (box `Did you know?` on ≥ 80 columns,
 * `💡 <tip>` otherwise) when `chat.enablePromptHints`, the shortcut line + `━` rule, the
 * trust-all warning, `🤖 You are chatting with <model>` + the Claude Code backend note, and the
 * agent's `welcomeMessage`.
 */

import { c } from '../util/ansi.js';

/** Kiro's built-in default agent: no `[name] ` in the prompt (06 §5.1, Kiro name). */
export const DEFAULT_PROMPT_AGENT = 'kiro_default';

export interface PromptState {
  agentName?: string;
  trustAll: boolean;
  tangent: boolean;
  usagePercent?: number;
  planMode?: boolean;
}

/** Uncoloured prompt (Q vectors: `> `, `!> `, `↯ > `, `[dev] ↯ !> `, `[a] 6% > `, `9% ↯ > `). */
export function generatePrompt(s: PromptState): string {
  return renderPrompt(s, false);
}

/** Coloured prompt (06 §5.1 colours; identity when colours are off). */
export function colorPrompt(s: PromptState): string {
  return renderPrompt(s, true);
}

function renderPrompt(s: PromptState, color: boolean): string {
  const id = (x: string): string => x;
  const cyan = color ? c.cyan : id;
  const red = color ? c.red : id;
  const yellow = color ? c.yellow : id;
  const green = color ? c.green : id;
  const magenta = color ? c.magenta : id;
  let profile = '';
  if (s.planMode) profile = cyan('[plan] ');
  else if (s.agentName && s.agentName !== DEFAULT_PROMPT_AGENT && s.agentName !== 'q_cli_default') profile = cyan(`[${s.agentName}] `);
  let pct = '';
  if (s.usagePercent !== undefined && Number.isFinite(s.usagePercent)) {
    const text = `${s.usagePercent.toFixed(0)}% `;
    const f = Math.floor(s.usagePercent);
    pct = f < 50 ? green(text) : f < 90 ? yellow(text) : red(text);
  }
  const warn = s.trustAll ? red('!') : '';
  const tangent = s.tangent ? yellow('↯ ') : '';
  return `${profile}${pct}${tangent}${warn}${magenta('> ')}`;
}

// ───────────────────────────── fixed texts ─────────────────────────────

/** Approval question (06 §2.1; letters green, rest dark grey). */
export function approvalQuestion(): string {
  const g = c.gray;
  const t = c.green;
  return `${g('Allow this action? Use \'')}${t('t')}${g("' to trust (always allow) this tool for the session. [")}${t('y')}${g('/')}${t('n')}${g('/')}${t('t')}${g(']:')}`;
}

/** Plain approval question text (tests, ACP-free callers). */
export const APPROVAL_QUESTION = "Allow this action? Use 't' to trust (always allow) this tool for the session. [y/n/t]:";

/** Q Ctrl+C / Ctrl+D hint at the idle prompt (06 §2.2), surrounding newlines included. */
export function exitHint(): string {
  return `\n(To exit the CLI, press Ctrl+C or Ctrl+D again or type ${c.green('/quit')})\n\n`;
}

/** Trust-all warning (06 §5.2 item 3, product/URL adapted per 01 §4.6). */
export function trustAllWarning(): string {
  return (
    `${c.green('All tools are now trusted (')}${c.red('!')}${c.green('). Kiro will execute tools without asking for confirmation.')}` +
    '\nAgents can sometimes do unexpected things so understand the risks.' +
    // URL: kiro.dev permissions page (01 §0.1 [D:perm]).
    '\n\nLearn more at https://kiro.dev/docs/permissions\n\n'
  );
}

/** Rotating tips (Kiro/Q tips that apply to kiro-claude). */
export const TIPS: readonly string[] = [
  'You can use /agent swap to switch between agents mid-conversation',
  'Use @path/to/file to add a file to your message, or @dir/ for a directory tree',
  'Run a shell command without leaving the chat by starting the line with !',
  'Use /context add <glob> to add files to the context for this session',
  'Use /compact to replace the conversation history with its summary when it gets long',
  'Saved prompts in .kiro/prompts/<name>.md can be run as /<name> or @<name>',
  'Steering files in .kiro/steering/ give the agent standing instructions for this project',
  'Use /tools trust <tool> to stop being asked about a tool for this session',
  'Use /plan to research and plan in read-only mode before making changes',
  'Use /tangent to explore a side question without polluting the main conversation',
  'Use /model to pick a Claude model for this session',
  'Ctrl + j inserts a new line so you can write multi-line prompts',
  'Use /chat save <file> to export this conversation and /chat load <file> to bring it back',
  'Use /spec to turn a feature idea into requirements, a design and a task list',
];

function centerIn(text: string, width: number): string {
  const pad = Math.max(0, width - text.length);
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + text + ' '.repeat(pad - left);
}

function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if (line && line.length + 1 + w.length > width) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

/** `Did you know?` box (width 80) or `💡 <tip>` on narrow terminals. */
export function formatTip(tip: string, columns: number, ascii = false): string {
  if (columns < 80) return `${ascii ? '*' : '💡'} ${tip}\n`;
  const inner = 78;
  const title = ' Did you know? ';
  const [tl, tr, bl, br, h, v] = ascii ? ['+', '+', '+', '+', '-', '|'] : ['╭', '╮', '╰', '╯', '─', '│'];
  const left = Math.floor((inner - title.length) / 2);
  const top = `${tl}${h.repeat(left)}${title}${h.repeat(inner - left - title.length)}${tr}`;
  const body = [
    `${v}${' '.repeat(inner)}${v}`,
    ...wrapWords(tip, inner - 8).map((l) => `${v}${centerIn(l, inner)}${v}`),
    `${v}${' '.repeat(inner)}${v}`,
  ];
  const bottom = `${bl}${h.repeat(inner)}${br}`;
  return c.gray([top, ...body, bottom].join('\n')) + '\n';
}

export interface GreetingInput {
  resumed: boolean;
  columns: number;
  greetingEnabled: boolean;
  promptHints: boolean;
  tip?: string;
  trustAll: boolean;
  modelName: string;
  welcomeMessage?: string;
  ascii?: boolean;
}

/** Startup text (see module doc). */
export function formatGreeting(g: GreetingInput): string {
  let s = '';
  if (g.greetingEnabled) {
    s += g.resumed ? c.magenta('Picking up where we left off...') : `Welcome to ${c.cyan('Kiro')} ${c.gray('(Claude Code backend)')}!`;
    s += '\n\n';
    if (g.promptHints && g.tip) s += formatTip(g.tip, g.columns, g.ascii) + '\n';
    const sep = g.ascii ? '-' : '•';
    const items = [`${c.green('/help')} all commands`, `${c.green('ctrl + j')} new lines`, `${c.green('!cmd')} runs a shell command`];
    if (g.columns < 80) s += items.join('\n') + '\n';
    else s += `${items.join(`  ${sep}  `)}\n${c.gray((g.ascii ? '-' : '━').repeat(80))}\n`;
    s += '\n';
  }
  if (g.trustAll) s += trustAllWarning();
  s += `${c.cyan(`${g.ascii ? '' : '🤖 '}You are chatting with ${g.modelName}`)}\n`;
  s += `${c.gray('Model calls run on your installed Claude Code and its subscription.')}\n\n`;
  if (g.welcomeMessage && g.welcomeMessage.trim() !== '') s += `${g.welcomeMessage.trim()}\n\n`;
  return s;
}

/** Exit hint (01 §4.8 port decision). */
export function resumeHint(progName: string, sessionId: string): string {
  return `To resume this session: ${progName} chat --resume-id ${sessionId}`;
}

/** Stub text for commands kiro-claude does not implement (01 §10 item 6). */
export function notSupported(cmd: string): string {
  return `/${cmd} is not supported in kiro-claude (Claude Code backend).`;
}

/** A command typed at a `[y/n/t]` prompt would start a turn or replace the session (DECISION). */
export const BUSY_MESSAGE = 'A response is still running: answer the pending tool request (y/n/t), or type your new instruction instead.';

/** Issue tracker of this port. */
export const ISSUES_URL = 'https://github.com/BurgiSimon/KIRO-Claude/issues';
