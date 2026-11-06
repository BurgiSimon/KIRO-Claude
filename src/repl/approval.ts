/**
 * Approval answers at the `[y/n/t]` prompt (06 §2.2, 00 §2.3 "Interactive approval").
 *
 * Input is Unicode-tag-sanitized and trimmed, then (Q `handle_input` precedence):
 *  1. empty ⇒ re-prompt, nothing changes;
 *  2. `/…` ⇒ the slash command runs, the question is printed again and the tool stays pending;
 *  3. `!…` ⇒ the shell command runs, the tool stays pending;
 *  4. `@…` ⇒ reject + run the prompt (Q quirk normalized, 06 §2.2 item 3 "deviation acceptable");
 *  5. `y`/`Y` ⇒ allow once; `t`/`T` ⇒ trust the tool for the session + allow; `n`/`N` ⇒ deny
 *     (the model gets `I deny this tool request. Ask a follow up question clarifying the
 *     expected action`); anything else ⇒ cancel the tool, interrupt, and send the text as the
 *     next user turn (`redirect`).
 * Ctrl+C while the question is shown ⇒ `cancelled` (handled by the caller).
 */

import type { ApprovalResponse } from '../types.js';
import { sanitizeUnicodeTags } from './input.js';

export type ApprovalInput =
  | { kind: 'empty' }
  | { kind: 'command'; text: string }
  | { kind: 'shell'; command: string }
  | { kind: 'prompt'; text: string }
  | { kind: 'answer'; response: ApprovalResponse };

/** Classify one line typed at the approval prompt (see module doc). */
export function classifyApprovalInput(line: string): ApprovalInput {
  const text = sanitizeUnicodeTags(line).trim();
  if (text === '') return { kind: 'empty' };
  if (text.startsWith('/')) return { kind: 'command', text };
  if (text.startsWith('!')) return { kind: 'shell', command: text.slice(1) };
  if (text.startsWith('@')) return { kind: 'prompt', text };
  if (text === 'y' || text === 'Y') return { kind: 'answer', response: { kind: 'allow-once' } };
  if (text === 't' || text === 'T') return { kind: 'answer', response: { kind: 'allow-always' } };
  if (text === 'n' || text === 'N') return { kind: 'answer', response: { kind: 'deny' } };
  return { kind: 'answer', response: { kind: 'redirect', text } };
}
