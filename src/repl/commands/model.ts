/**
 * /model [<id> | set-current-as-default | fallback … | edit] and
 * /effort [<level> | set-current-as-default] (01 §5.4, 00 §2.5).
 *
 * The list comes from KiroSession.listModels() (live `initialize.models`, static fallback).
 * Bare `/model` is the Classic picker (`Select a model for this chat session`, labels
 * `<name> (active) | <description>`, then `\n Using <name>\n\n`). `set-current-as-default`
 * writes `chat.defaultModel` to the GLOBAL settings file. `fallback` uses Kiro's text for
 * credentials that cannot configure fallbacks (Claude Code picks its own fallback).
 * Effort: `set-current-as-default` saves `chat.modelDefaults.<model>.output_config.effort`
 * (01 §8.1).
 */

import { findModelEntry } from '../../models/models.js';
import type { ModelEntry } from '../../types.js';
import { c } from '../../util/ansi.js';
import { notSupported } from '../prompt.js';
import type { BuiltinCommand, ReplContext } from '../types.js';

export const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Classic picker label `<name> (active) | <description>` (01 §5.4) with the Kiro id. */
function label(e: ModelEntry, active: boolean): string {
  const name = e.kiroId === 'auto' ? 'auto' : `${e.displayName} [${e.kiroId}]`;
  const desc = e.kiroId === 'auto' ? [e.displayName, e.description].filter(Boolean).join(': ') : e.description;
  return `${name}${active ? ' (active)' : ''}${desc ? ` | ${desc}` : ''}`;
}

async function currentEntry(r: ReplContext): Promise<{ entries: ModelEntry[]; entry?: ModelEntry }> {
  const entries = await r.session.listModels();
  const entry = findModelEntry(entries, r.session.model);
  return entry ? { entries, entry } : { entries };
}

export const modelCommand: BuiltinCommand = {
  name: 'model',
  summary: 'Select a model for the current conversation session',
  usage: '/model                       Pick a model\n/model <id>                  Switch to <id>\n/model set-current-as-default  Make the current model the default for new sessions',
  async run(args, _raw, r) {
    const sub = args[0];
    if (sub === 'set-current-as-default') {
      r.settings.set('chat.defaultModel', r.session.model, 'global');
      r.write(`\n${c.green(`✓ Default model set to '${r.session.model}'. This will take effect the next time ${r.progName} chat is launched.`)}\n\n`);
      return;
    }
    if (sub === 'fallback') {
      r.write(`\n${c.yellow("This session's credentials cannot configure model fallbacks. Sign in to Kiro to configure one.")}\n\n`);
      return;
    }
    if (sub === 'edit') {
      r.write(`${c.yellow(notSupported('model edit'))}\n`);
      return;
    }
    const entries = await r.session.listModels();
    if (entries.length === 0) {
      r.write('\nNo models available\n\n');
      return;
    }
    let chosen: ModelEntry | undefined;
    if (sub === undefined) {
      const active = findModelEntry(entries, r.session.model);
      const idx = await r.choose('Select a model for this chat session', entries.map((e) => label(e, e === active)));
      if (idx === undefined) return;
      chosen = entries[idx];
    } else {
      chosen = findModelEntry(entries, sub);
      if (!chosen) {
        r.write(`\n${c.red(`Model '${sub}' does not exist. Available models: ${entries.map((e) => e.kiroId).join(', ')}`)}\n\n`);
        return;
      }
    }
    if (!chosen) return;
    await r.session.setModel(chosen.kiroId);
    await r.refreshUsage();
    r.write(`\n Using ${chosen.kiroId === 'auto' ? 'auto' : chosen.displayName}\n\n`);
  },
};

export const effortCommand: BuiltinCommand = {
  name: 'effort',
  summary: 'Set the reasoning effort for the current model',
  usage: '/effort                       Pick an effort level\n/effort <low|medium|high|xhigh|max>\n/effort set-current-as-default  Save the current effort for this model',
  async run(args, _raw, r) {
    const sub = args[0];
    const { entry } = await currentEntry(r);
    const supported = entry?.supportedEffortLevels;
    if (sub === 'set-current-as-default') {
      const eff = r.session.effort;
      if (!eff) {
        r.write(`\n${c.yellow('No effort level is set for this session.')}\n\n`);
        return;
      }
      const model = r.session.model;
      const cur = r.settings.get('chat.modelDefaults');
      const all: Record<string, unknown> = cur && typeof cur === 'object' && !Array.isArray(cur) ? { ...(cur as Record<string, unknown>) } : {};
      const m = all[model] && typeof all[model] === 'object' ? { ...(all[model] as Record<string, unknown>) } : {};
      const oc = m.output_config && typeof m.output_config === 'object' ? { ...(m.output_config as Record<string, unknown>) } : {};
      oc.effort = eff;
      m.output_config = oc;
      all[model] = m;
      r.settings.set('chat.modelDefaults', all, 'global');
      r.write(`\n${c.green(`✓ Default effort for ${model} set to '${eff}'.`)}\n\n`);
      return;
    }
    if (supported === null) {
      r.write(`\n${c.yellow(`The model ${r.session.model} does not support effort levels.`)}\n\n`);
      return;
    }
    const levels = Array.isArray(supported) && supported.length > 0 ? supported : [...EFFORT_LEVELS];
    let level: string | undefined = sub?.toLowerCase();
    if (level === undefined) {
      const cur = r.session.effort;
      r.write(`\nCurrent effort: ${cur ?? 'default'}\n`);
      const idx = await r.choose('Select an effort level', levels.map((l) => (l === cur ? `${l} (active)` : l)));
      if (idx === undefined) return;
      level = levels[idx];
    } else if (!EFFORT_LEVELS.includes(level)) {
      r.write(`\n${c.red(`Invalid effort level '${sub}'. Valid levels: ${EFFORT_LEVELS.join(', ')}`)}\n\n`);
      return;
    } else if (!levels.includes(level)) {
      r.write(`\n${c.red(`Effort level '${level}' is not supported by ${r.session.model}. Supported levels: ${levels.join(', ')}`)}\n\n`);
      return;
    }
    if (!level) return;
    await r.session.setEffort(level);
    r.write(`\n Effort set to ${level}\n\n`);
  },
};
