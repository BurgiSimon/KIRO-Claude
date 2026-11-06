/**
 * Conversation-shaping commands: /compact [instructions…] (00 §2.5: Claude's local `/compact`,
 * Kiro-only flags accepted and ignored), /tangent [name | ls | root | merge | tail]
 * (01 §5.11, 06 §6.4 Classic strings; V3 errors), /rewind [N] (00 §2.5, §8 C25).
 */

import { SessionStore, sessionsDir } from '../../session/store.js';
import { c } from '../../util/ansi.js';
import type { BuiltinCommand, ReplContext } from '../types.js';

/** Kiro /compact flags that take a value / are boolean (accepted and ignored). */
const COMPACT_VALUE_FLAGS = new Set(['--messages-to-exclude', '--truncate-large-messages', '--max-message-length']);
const COMPACT_BOOL_FLAGS = new Set(['--show-summary']);

/** Instructions of a /compact command line with the Kiro flags removed. */
export function compactInstructions(args: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (COMPACT_BOOL_FLAGS.has(key)) continue;
    if (COMPACT_VALUE_FLAGS.has(key)) {
      if (!a.includes('=')) i++;
      continue;
    }
    out.push(a);
  }
  return out.join(' ').trim();
}

export const compactCommand: BuiltinCommand = {
  name: 'compact',
  summary: 'Summarize the conversation to free up context space',
  usage: '/compact [instructions…] [--show-summary]',
  async run(args, _raw, r) {
    const instr = compactInstructions(args);
    const { result, seen } = await r.runEvents(() => r.session.compact(instr || undefined));
    if (!result.isError && result.stopReason !== 'cancelled' && !seen.has('compaction')) {
      r.write(`${c.green('✔ Conversation history has been compacted successfully!')}\n\n`);
    }
    await r.refreshUsage();
  },
};

const TANGENT_ENTER =
  'Created a conversation checkpoint (↯). Use /tangent to restore the conversation later.\nNote: this functionality is experimental and may change or be removed in the future.';
const TANGENT_EXIT = 'Restored conversation from checkpoint (↯). - Returned to main conversation.';
const TANGENT_TAIL = 'Restored conversation from checkpoint (↯) with last conversation entry preserved.';

function hasHistory(r: ReplContext): boolean {
  const rec = r.session.record;
  return (rec?.turns?.length ?? 0) > 0 || (rec?.messageCount ?? 0) > 0;
}

async function enter(r: ReplContext, name?: string): Promise<void> {
  if (!hasHistory(r)) {
    r.write(`\n${c.red("Can't branch an empty chat.")}\n\n`);
    return;
  }
  await r.session.enterTangent(name);
  await r.refreshUsage();
  r.write(`\n${c.gray(TANGENT_ENTER.split('\n')[0]!)}\n${c.yellow(TANGENT_ENTER.split('\n')[1]!)}\n\n`);
}

export const tangentCommand: BuiltinCommand = {
  name: 'tangent',
  summary: 'Start or leave a side conversation (↯) without affecting the main one',
  usage: [
    '/tangent              Enter a tangent, or return to the main conversation',
    '/tangent <name>       Enter (or create) the named tangent',
    '/tangent tail         Return, keeping the last question and answer',
    '/tangent merge        Return and bring a summary of the tangent into the main conversation',
    '/tangent root         Return to the root conversation',
    '/tangent ls           List the tangents of this conversation',
  ].join('\n'),
  async run(args, _raw, r) {
    const sub = args[0];
    const inTangent = r.session.tangent !== undefined;
    switch (sub) {
      case undefined:
        if (inTangent) {
          await r.session.exitTangent('discard');
          await r.refreshUsage();
          r.write(`\n${c.green(TANGENT_EXIT)}\n\n`);
        } else await enter(r);
        return;
      case 'tail':
        if (!inTangent) {
          r.write(`\n${c.red('You need to be in tangent mode to use tail.')}\n\n`);
          return;
        }
        await r.session.exitTangent('tail');
        await r.refreshUsage();
        r.write(`\n${c.green(TANGENT_TAIL)}\n\n`);
        return;
      case 'merge':
        if (!inTangent) {
          r.write(`\n${c.red('Already on the root session — nothing to merge into')}\n\n`);
          return;
        }
        await r.session.exitTangent('merge');
        await r.refreshUsage();
        r.write(`\n${c.green("Merged the tangent's findings into the main conversation (↯).")}\n\n`);
        return;
      case 'root':
        if (!inTangent) {
          r.write('\nAlready on the root session.\n\n');
          return;
        }
        for (let i = 0; i < 64 && r.session.tangent !== undefined; i++) await r.session.exitTangent('discard');
        await r.refreshUsage();
        r.write(`\n${c.green('Returned to the root conversation.')}\n\n`);
        return;
      case 'ls': {
        const store = new SessionStore(sessionsDir(r.ws));
        const all = store.list({ cwd: r.ws.cwd });
        const cur = r.session.id;
        const rootId = inTangent ? r.session.tangent!.parentId : cur;
        const tangents = all.filter((s) => s.forkKind === 'tangent' && s.parentId !== null);
        let s = `\n${rootId === cur ? c.green('* ') : '  '}main ${c.gray(`(${rootId})`)}\n`;
        const walk = (parent: string, depth: number): void => {
          for (const t of tangents.filter((x) => x.parentId === parent)) {
            s += `${t.sessionId === cur ? c.green('* ') : '  '}${'  '.repeat(depth)}↯ ${t.tangentName ?? t.sessionId} ${c.gray(`(${t.sessionId})`)}\n`;
            if (depth < 16) walk(t.sessionId, depth + 1);
          }
        };
        walk(rootId, 1);
        r.write(`${s}\n`);
        return;
      }
      default:
        await enter(r, sub);
    }
  },
};

export const rewindCommand: BuiltinCommand = {
  name: 'rewind',
  summary: 'Fork the conversation at an earlier turn (the original is kept)',
  usage: '/rewind [N]',
  async run(args, _raw, r) {
    const turns = r.session.record?.turns ?? [];
    if (turns.length === 0) {
      r.write('\nNothing to rewind yet.\n\n');
      return;
    }
    let n: number | undefined;
    if (args[0] !== undefined) {
      n = Number(args[0]);
      if (!Number.isInteger(n) || n < 1 || n > turns.length) {
        r.write(`\n${c.red(`Invalid turn number '${args[0]}'. Choose a number between 1 and ${turns.length}.`)}\n\n`);
        return;
      }
    } else {
      // Oldest first, so the number typed at the numbered picker IS the turn number (Kiro's
      // TUI picker lists newest first; with a numbered line picker that would make "1" mean
      // the latest turn while `/rewind 1` means the first — DECISION).
      const idx = await r.choose('Rewind to which turn? (the conversation continues after that answer)', turns.map((t) => t.preview || '(empty)'));
      if (idx === undefined) return;
      n = idx + 1;
    }
    const before = r.session.id;
    await r.session.rewind(n);
    await r.refreshUsage();
    r.write(`\n${c.green(`✔ Rewound the conversation to turn ${n}.`)} ${c.gray(`The original conversation is kept as ${before}.`)}\n\n`);
  },
};
