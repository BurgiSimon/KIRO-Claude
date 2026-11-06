/**
 * /plan [prompt] (00 §2.5 row "/plan", §8 C8; 03 §5.4; 01 §5.1).
 *
 * Plan mode is a KiroSession flag (`session.planMode`): the gate denies mutating tools and
 * each user turn carries the `<kiro-plan-mode>` block (both owned by session/). The REPL
 * toggles the flag (`/plan`, Shift+Tab), shows `[plan] > `, and after a plan-mode turn whose
 * answer looks like a Kiro plan asks `Execute this plan? [y/n]`; `y` leaves plan mode and
 * sends `Implement the plan above.` (repl/core.ts afterTurn).
 *
 * `/plan <prompt>` enters plan mode (when needed) and sends the prompt.
 */

import { c } from '../../util/ansi.js';
import type { BuiltinCommand, ReplContext } from '../types.js';

export const PLAN_EXECUTE_QUESTION = 'Execute this plan? [y/n]';
export const PLAN_EXECUTE_PROMPT = 'Implement the plan above.';

/** Heuristic: the answer contains a Kiro-format plan (03 §5.4 step 3). */
export function looksLikePlan(text: string): boolean {
  if (!text) return false;
  return (
    /\*\*\s*Implementation Plan\b/i.test(text) ||
    /^#{1,6}\s*Implementation Plan\b/im.test(text) ||
    /\*\*\s*Task Breakdown\s*:?\s*\*\*/i.test(text) ||
    (/^\s*(?:\*\*)?Task\s+1\s*:/im.test(text) && /^\s*(?:\*\*)?Task\s+2\s*:/im.test(text))
  );
}

export function enterPlanMode(r: ReplContext): void {
  r.session.planMode = true;
  r.write(`\n${c.cyan('Entered plan mode.')} Kiro will research and plan without making changes. Use /plan or Shift+Tab to exit.\n\n`);
}

export function exitPlanMode(r: ReplContext): void {
  r.session.planMode = false;
  r.write(`\n${c.cyan('Exited plan mode.')}\n\n`);
}

export const planCommand: BuiltinCommand = {
  name: 'plan',
  summary: 'Toggle read-only plan mode, or plan a task: /plan <prompt>',
  usage: '/plan            Enter or leave plan mode\n/plan <prompt>   Enter plan mode and plan <prompt>',
  async run(_args, raw, r) {
    const prompt = raw.trim();
    if (prompt === '') {
      if (r.session.planMode) exitPlanMode(r);
      else enterPlanMode(r);
      return;
    }
    if (!r.session.planMode) enterPlanMode(r);
    return r.sendPrompt({ text: prompt });
  },
};
