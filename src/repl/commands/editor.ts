/**
 * /editor [initial text…] and /reply (01 §5.7, Classic exact strings).
 *
 *  - `/editor`: `$EDITOR` (fallback `vi`) on a temp file prefilled with the arguments.
 *    Empty ⇒ `Empty content from editor, not submitting.`; failure ⇒ `Error opening editor:
 *    <err>`; else `Content loaded from editor. Submitting prompt...`, the content is echoed as
 *    `> <content>` and handled like a typed input.
 *  - `/reply`: the same with the last assistant message quoted (`> ` per line). No message ⇒
 *    `No assistant message found to reply to.`; unchanged ⇒ `No changes made in editor, not
 *    submitting.`
 */

import { c } from '../../util/ansi.js';
import type { BuiltinCommand, ReplContext } from '../types.js';

async function submitFromEditor(r: ReplContext, content: string): Promise<void | 'quit'> {
  r.write(`\n${c.green('Content loaded from editor. Submitting prompt...')}\n\n`);
  r.write(`${c.magenta('> ')}${content}\n`);
  return r.submit(content);
}

export const editorCommand: BuiltinCommand = {
  name: 'editor',
  summary: 'Open $EDITOR (defaults to vi) to compose a prompt',
  usage: '/editor [initial text…]',
  async run(_args, raw, r) {
    const res = await r.openEditor(raw);
    if (!res.ok) {
      r.write(`\n${c.red(`Error opening editor: ${res.error}`)}\n\n`);
      return;
    }
    const content = res.text.trim();
    if (content === '') {
      r.write(`\n${c.yellow('Empty content from editor, not submitting.')}\n\n`);
      return;
    }
    return submitFromEditor(r, content);
  },
};

export const replyCommand: BuiltinCommand = {
  name: 'reply',
  summary: 'Open $EDITOR with the most recent assistant message quoted for reply',
  async run(_args, _raw, r) {
    const last = r.lastAssistantText;
    if (!last || last.trim() === '') {
      r.write(`\n${c.yellow('No assistant message found to reply to.')}\n\n`);
      return;
    }
    const initial = `${last
      .trim()
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')}\n\n`;
    const res = await r.openEditor(initial);
    if (!res.ok) {
      r.write(`\n${c.red(`Error opening editor: ${res.error}`)}\n\n`);
      return;
    }
    const content = res.text.trim();
    if (content === initial.trim()) {
      r.write(`\n${c.yellow('No changes made in editor, not submitting.')}\n\n`);
      return;
    }
    if (content === '') {
      r.write(`\n${c.yellow('Empty content from editor, not submitting.')}\n\n`);
      return;
    }
    return submitFromEditor(r, content);
  },
};
