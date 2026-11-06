/**
 * Informational commands: /hooks [run <name>] (06 §3.8), /mcp (01 §5.1), /usage (06 §5.7,
 * 00 §2.5: Claude `get_context_usage` + rate-limit windows, never Kiro credits; the cost is a
 * list-price estimate and labelled so), /todos [view|resume] (06 §6.5 display), /transcript
 * [save <file> [--plain|--json]] (01 §5.1).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KiroHook, UsageReport } from '../../types.js';
import { c, isColorEnabled } from '../../util/ansi.js';
import { notSupported } from '../prompt.js';
import { formatResetTime, formatTodos } from '../render.js';
import type { BuiltinCommand, TranscriptEntry } from '../types.js';

const HOOKS_DOC = 'https://kiro.dev/docs/cli/hooks';

function hookAction(h: KiroHook): string {
  return h.action.type === 'command' ? h.action.command : `ask agent: ${h.action.prompt}`;
}

/** /hooks listing: `<trigger>:` then `  - <name>: <command>` (06 §3.8 shape). */
export function formatHooks(hooks: readonly KiroHook[]): string {
  if (hooks.length === 0) {
    return `\nNo hooks are configured.\n\nRefer to the documentation for how to add hooks to your agent: ${c.green(HOOKS_DOC)}\n\n`;
  }
  const byTrigger = new Map<string, KiroHook[]>();
  for (const h of hooks) {
    const k = h.rawTrigger || h.trigger;
    const list = byTrigger.get(k) ?? [];
    list.push(h);
    byTrigger.set(k, list);
  }
  let s = '\n';
  for (const [trigger, list] of byTrigger) {
    s += `${c.bold(`${trigger}:`)}\n`;
    for (const h of list) {
      const off = h.enabled ? '' : c.gray(' (disabled)');
      const m = h.matcher ? c.gray(` [matcher: ${h.matcher}]`) : '';
      s += `  - ${h.name}: ${hookAction(h)}${m}${off}\n`;
    }
  }
  return `${s}\n`;
}

export const hooksCommand: BuiltinCommand = {
  name: 'hooks',
  summary: 'View the hooks of the current agent (/hooks run <name> runs a manual hook)',
  usage: '/hooks\n/hooks run <name>',
  async run(args, raw, r) {
    const sub = args[0];
    if (sub === undefined) {
      r.write(formatHooks(r.session.hooks()));
      return;
    }
    if (sub === 'run') {
      const name = raw.replace(/^\s*run\s*/, '').trim();
      if (!name) {
        r.write(`\n${c.red('Usage: /hooks run <name>')}\n\n`);
        return;
      }
      const hook = r.session.hooks().find((h) => h.name === name);
      if (!hook) {
        r.write(`\n${c.red(`No hook named '${name}'.`)}\n\n`);
        return;
      }
      const out = await r.session.runManualHook(name);
      r.write(out.trim() ? `\n${out.replace(/\s+$/, '')}\n\n` : `\n${c.gray(`Hook '${name}' produced no output.`)}\n\n`);
      return;
    }
    r.write(`${c.yellow(notSupported(`hooks ${sub}`))}\nEdit the agent file or .kiro/hooks/*.json to change hooks.\n`);
  },
};

export const mcpCommand: BuiltinCommand = {
  name: 'mcp',
  summary: 'See MCP server status',
  async run(args, _raw, r) {
    if (args[0]) {
      r.write(`${c.yellow(notSupported(`mcp ${args[0]}`))}\nMCP authentication is handled by Claude Code (run claude, then /mcp).\n`);
      return;
    }
    const list = await r.session.mcpStatus();
    if (list.length === 0) {
      r.write('\nNo MCP servers configured.\n\n');
      return;
    }
    const w = Math.max(...list.map((m) => m.name.length));
    let s = '\n';
    for (const m of list) {
      const icon = m.status === 'connected' ? c.green('✓') : m.status === 'pending' ? c.yellow('◌') : m.status === 'disabled' ? c.gray('○') : c.red('✗');
      const tools = m.toolCount !== undefined ? c.gray(` (${m.toolCount} ${m.toolCount === 1 ? 'tool' : 'tools'})`) : '';
      const err = m.error ? `: ${c.red(m.error)}` : '';
      s += `${icon} ${m.name.padEnd(w)}  ${m.status}${tools}${err}\n`;
    }
    r.write(`${s}\n`);
  },
};

const BAR_COLORS = [c.cyan, c.red, c.blue, c.magenta, c.yellow, c.green];

/** Claude's `get_context_usage` categories that are not usage (drawn as the grey filler). */
const FREE_CATEGORY = /^(free space|free)$/i;

/** /usage text (06 §5.7 layout with Claude's categories). */
export function formatUsage(u: UsageReport, columns: number): string {
  let s = '\n';
  const pct = u.contextPercent;
  const used = (u.categories ?? []).filter((x) => !FREE_CATEGORY.test(x.name.trim()));
  const free = (u.categories ?? []).filter((x) => FREE_CATEGORY.test(x.name.trim()));
  if (u.contextTokens !== undefined && u.contextWindowTokens) {
    const p = pct ?? (u.contextTokens / u.contextWindowTokens) * 100;
    s += `${c.bold(`Current context window (${u.contextTokens} of ${Math.round(u.contextWindowTokens / 1000)}k tokens used)`)}\n`;
    const width = Math.max(10, Math.min(columns, 80) - 10);
    let bar = '';
    let filled = 0;
    if (p > 100) bar = c.red('█'.repeat(width));
    else {
      used.forEach((cat, i) => {
        if (cat.tokens <= 0) return;
        const n = Math.floor((cat.tokens / u.contextWindowTokens!) * width);
        const color = BAR_COLORS[i % BAR_COLORS.length]!;
        if (n === 0) {
          // a non-zero category too small for one cell shows as '|' (06 §5.7)
          bar += color('|');
          filled += 1;
        } else {
          bar += color('█'.repeat(Math.min(n, width - filled)));
          filled += Math.min(n, width - filled);
        }
      });
      if (filled === 0 && p > 0) {
        const n = Math.min(width, Math.max(1, Math.floor((p / 100) * width)));
        bar += c.cyan('█'.repeat(n));
        filled = n;
      }
      // without colour the grey filler would be indistinguishable from used cells
      bar += c.gray((isColorEnabled() ? '█' : '░').repeat(Math.max(0, width - filled)));
    }
    s += `${bar}  ${p.toFixed(2)}%\n\n`;
    used.forEach((cat, i) => {
      const color = BAR_COLORS[i % BAR_COLORS.length]!;
      const cp = (cat.tokens / u.contextWindowTokens!) * 100;
      s += `${color('█')} ${cat.name}: ~${cat.tokens} tokens (${cp.toFixed(2)}%)\n`;
    });
    for (const cat of free) s += `${c.gray(`█ ${cat.name}: ~${cat.tokens} tokens (${((cat.tokens / u.contextWindowTokens!) * 100).toFixed(2)}%)`)}\n`;
    if (used.length || free.length) s += '\n';
  } else if (pct !== undefined) {
    s += `${c.bold(`Current context window (${pct.toFixed(1)}% used)`)}\n\n`;
  } else {
    s += `${c.gray('Context window usage is not available yet (send a message first).')}\n\n`;
  }
  if (u.rateLimit) {
    const rl = u.rateLimit;
    const util = rl.utilization !== undefined ? ` ${Math.round(rl.utilization <= 1 ? rl.utilization * 100 : rl.utilization)}% used` : '';
    const win = rl.window ? ` of the ${rl.window} window` : '';
    const reset = rl.resetsAt ? `, resets ${formatResetTime(rl.resetsAt)}` : '';
    s += `Claude subscription usage: ${rl.status}${util ? `,${util}${win}` : ''}${reset}\n`;
  }
  if (u.sessionCostUsd !== undefined) {
    s += `${c.gray(`Session cost estimate at API list prices: $${u.sessionCostUsd.toFixed(2)} (not what your subscription pays)`)}\n`;
  }
  s += `Model: ${u.model}\n`;
  s += `\n💡 ${c.bold('Pro Tips:')}\n`;
  s += `Run ${c.green('/compact')} to replace the conversation history with its summary\n`;
  s += `Run ${c.green('/clear')} to erase the entire chat history\n`;
  s += `Run ${c.green('/context show')} to see tokens per context file\n\n`;
  return s;
}

export const usageCommand: BuiltinCommand = {
  name: 'usage',
  summary: 'Show context window and subscription usage',
  async run(_args, _raw, r) {
    const u = await r.session.usage();
    r.write(formatUsage(u, r.columns));
  },
};

export const todosCommand: BuiltinCommand = {
  name: 'todos',
  aliases: ['todo'],
  summary: 'View the to-do list of the session',
  usage: '/todos [view]\n/todos resume',
  async run(args, _raw, r) {
    const sub = args[0] ?? 'view';
    const todos = r.session.todos().filter((t) => t.status !== 'deleted');
    if (sub === 'view') {
      r.write(todos.length === 0 ? '\nNo to-do lists to view!\n\n' : `\n${formatTodos(todos)}\n`);
      return;
    }
    if (sub === 'resume') {
      const open = todos.filter((t) => t.status !== 'completed');
      if (open.length === 0) {
        r.write('\nNo to-do lists to resume!\n\n');
        return;
      }
      r.write(`\n${c.magenta('⟳ Resuming:')} ${open[0]!.subject}\n\n`);
      return r.sendPrompt({
        text: '[SYSTEM NOTE: This is an automated request, not from the user]\nCheck the task list (TaskList) and continue working on the tasks that are not completed yet.',
      });
    }
    r.write(`${c.yellow(notSupported(`todos ${sub}`))}\n`);
  },
};

function transcriptMarkdown(t: readonly TranscriptEntry[]): string {
  return t.map((e) => (e.role === 'user' ? `> ${e.text.replace(/\n/g, '\n> ')}` : e.text)).join('\n\n') + '\n';
}

function transcriptPlain(t: readonly TranscriptEntry[]): string {
  return t.map((e) => `${e.role === 'user' ? 'You' : 'Kiro'}: ${e.text}`).join('\n\n') + '\n';
}

export const transcriptCommand: BuiltinCommand = {
  name: 'transcript',
  summary: 'Show or save the transcript of this chat',
  usage: '/transcript [--plain|--json]\n/transcript save <file> [--plain|--json]',
  async run(args, _raw, r) {
    const fmt = args.includes('--json') ? 'json' : args.includes('--plain') ? 'plain' : 'md';
    const words = args.filter((a) => a !== '--json' && a !== '--plain');
    const t = r.transcript;
    const text = fmt === 'json' ? `${JSON.stringify(t, null, 2)}\n` : fmt === 'plain' ? transcriptPlain(t) : transcriptMarkdown(t);
    if (words[0] === 'save') {
      const f = words[1];
      if (!f) {
        r.write(`\n${c.red('Usage: /transcript save <file> [--plain|--json]')}\n\n`);
        return;
      }
      const abs = path.resolve(r.ws.cwd, f);
      try {
        fs.writeFileSync(abs, text);
        r.write(`\n${c.green(`✔ Saved the transcript to ${f}`)}\n\n`);
      } catch (e) {
        r.write(`\n${c.red(`Failed to save the transcript to ${f}: ${e instanceof Error ? e.message : String(e)}`)}\n\n`);
      }
      return;
    }
    if (t.length === 0) {
      r.write('\nThe transcript is empty.\n\n');
      return;
    }
    r.write(`\n${text}\n`);
  },
};
