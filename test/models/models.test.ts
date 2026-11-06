import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ModelInfo } from '../../src/claude/protocol.js';
import {
  STATIC_MODELS,
  buildModelList,
  claudeToKiroModelId,
  contextWindowFor,
  findModelEntry,
  formatModelList,
  kiroToClaudeModel,
  liveKiroId,
  modelCachePath,
  modelListRows,
  readModelCache,
  writeModelCache,
} from '../../src/models/models.js';

/** `initialize.models` captured from claude 2.1.318 (04 e9). */
const FULL = ['low', 'medium', 'high', 'xhigh', 'max'];
const LIVE: ModelInfo[] = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: FULL },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks', supportsEffort: true, supportedEffortLevels: FULL },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'For your toughest challenges', supportsEffort: true, supportedEffortLevels: FULL },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', supportsEffort: true, supportedEffortLevels: FULL },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest for quick answers', supportsEffort: true, supportedEffortLevels: FULL },
  { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers', supportsThinkingOff: true },
  { value: 'claude-sonnet-5', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5', description: 'Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: FULL },
  { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', description: 'Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: FULL },
  { value: 'claude-fable-5', resolvedModel: 'claude-fable-5', displayName: 'Fable 5', description: 'Most capable for your hardest and longest-running tasks', supportsEffort: true, supportedEffortLevels: FULL },
  { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: FULL },
  { value: 'claude-opus-4-7', resolvedModel: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: FULL },
  { value: 'claude-opus-4-6', resolvedModel: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
  { value: 'claude-sonnet-4-6', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
];

describe('models: claudeToKiroModelId (00 §3.13)', () => {
  const cases: [string, string][] = [
    ['default', 'auto'],
    ['DEFAULT', 'auto'],
    ['claude-opus-5-5', 'claude-opus-5.5'],
    ['claude-sonnet-5-5', 'claude-sonnet-5.5'],
    ['claude-haiku-5-5', 'claude-haiku-5.5'],
    ['claude-fable-5-1', 'claude-fable-5.1'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4.5'],
    ['claude-sonnet-5', 'claude-sonnet-5'],
    ['claude-opus-5', 'claude-opus-5'],
    ['claude-opus-4-8', 'claude-opus-4.8'],
    ['claude-opus-4-8[1m]', 'claude-opus-4.8'],
    ['claude-sonnet-4-6', 'claude-sonnet-4.6'],
    ['claude-sonnet-4-20250514', 'claude-sonnet-4'],
    ['claude-opus-4-1-20250805', 'claude-opus-4.1'],
    ['claude-3-7-sonnet-20250219', 'claude-3.7-sonnet'],
    ['claude-3-5-haiku-20241022', 'claude-3.5-haiku'],
    ['opus', 'opus'],
    ['sonnet[1m]', 'sonnet[1m]'],
    ['gpt-5.6-sol', 'gpt-5.6-sol'],
    ['claude-opus-4-123', 'claude-opus-4-123'],
  ];
  for (const [inp, out] of cases) it(`${inp} -> ${out}`, () => assert.equal(claudeToKiroModelId(inp), out));
  it('liveKiroId prefers resolvedModel and maps default to auto', () => {
    assert.equal(liveKiroId(LIVE[0]!), 'auto');
    assert.equal(liveKiroId(LIVE[1]!), 'claude-opus-5.5');
    assert.equal(liveKiroId({ value: 'claude-opus-4-7' }), 'claude-opus-4.7');
  });
});

describe('models: kiroToClaudeModel without a live list (01 §8.3)', () => {
  const cases: [string, string | undefined][] = [
    ['auto', undefined],
    ['AUTO', undefined],
    ['', undefined],
    ['claude-opus-5.5', 'claude-opus-5-5'],
    ['claude-sonnet-5.5', 'claude-sonnet-5-5'],
    ['claude-haiku-5.5', 'claude-haiku-5-5'],
    ['claude-opus-4.8', 'claude-opus-4-8'],
    ['claude-opus-4.5', 'claude-opus-4-5'],
    ['claude-sonnet-4.6', 'claude-sonnet-4-6'],
    ['claude-haiku-4.5', 'claude-haiku-4-5'],
    ['claude-fable-5.1', 'claude-fable-5-1'],
    ['Claude-Opus-5.5', 'claude-opus-5-5'],
    ['claude-sonnet-4', 'claude-sonnet-4'],
    ['claude-opus-5', 'claude-opus-5'],
    ['claude-3.7-sonnet', 'claude-3-7-sonnet'],
    ['claude-4-sonnet', 'claude-sonnet-4'],
    ['opus', 'opus'],
    ['Sonnet', 'sonnet'],
    ['haiku', 'haiku'],
    ['fable', 'fable'],
    ['default', 'default'],
    ['opus[1m]', 'opus[1m]'],
    ['claude-opus-4-8[1m]', 'claude-opus-4-8[1m]'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'],
  ];
  for (const [inp, out] of cases) {
    it(`${JSON.stringify(inp)} -> ${String(out)}`, () => {
      const r = kiroToClaudeModel(inp);
      assert.equal(r.error, undefined);
      assert.equal(r.value, out);
    });
  }
  for (const bad of ['gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-3.2', 'minimax-m2.5', 'glm-5', 'qwen3-coder-next', 'kimi-k3', 'nonsense']) {
    it(`non-Claude id ${bad} -> Q error`, () => {
      const r = kiroToClaudeModel(bad);
      assert.equal(r.value, undefined);
      assert.equal(r.error, `Model '${bad}' does not exist. Available models: ${STATIC_MODELS.map((m) => m.kiroId).join(', ')}`);
    });
  }
});

describe('models: kiroToClaudeModel with the live list', () => {
  const cases: [string, string | undefined][] = [
    ['auto', undefined],
    ['claude-opus-5.5', 'opus'], // first non-default entry whose converted id matches
    ['claude-sonnet-5.5', 'sonnet'],
    ['claude-haiku-5.5', 'haiku'],
    ['claude-fable-5.1', 'fable'],
    ['claude-haiku-4.5', 'claude-haiku-4-5-20251001'],
    ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], // hyphenated id finds the dated one
    ['claude-sonnet-5', 'claude-sonnet-5'],
    ['claude-opus-4.8', 'claude-opus-4-8'],
    ['claude-sonnet-4.6', 'claude-sonnet-4-6'],
    ['opus', 'opus'],
    ['claude-opus-5-5', 'opus'],
    ['claude-opus-4-8[1m]', 'claude-opus-4-8[1m]'], // 1M variant kept verbatim
    ['claude-opus-4.5', 'claude-opus-4-5'], // not in the live list: converted anyway
  ];
  for (const [inp, out] of cases) {
    it(`${inp} -> ${String(out)}`, () => assert.deepEqual(kiroToClaudeModel(inp, LIVE), out === undefined ? {} : { value: out }));
  }
  it('error lists the live Kiro ids', () => {
    const r = kiroToClaudeModel('gpt-5.6-luna', LIVE);
    assert.equal(
      r.error,
      "Model 'gpt-5.6-luna' does not exist. Available models: auto, claude-opus-5.5, claude-fable-5.1, claude-sonnet-5.5, " +
        'claude-haiku-5.5, claude-haiku-4.5, claude-sonnet-5, claude-opus-5, claude-fable-5, claude-opus-4.8, claude-opus-4.7, ' +
        'claude-opus-4.6, claude-sonnet-4.6',
    );
  });
});

describe('models: contextWindowFor', () => {
  const cases: [string, number | undefined][] = [
    ['claude-opus-5.5', 1_000_000],
    ['claude-haiku-5.5', 1_000_000],
    ['claude-sonnet-5', 1_000_000],
    ['claude-opus-4.6', 1_000_000],
    ['claude-sonnet-4.6', 1_000_000],
    ['claude-opus-4-8', 1_000_000],
    ['claude-haiku-4.5', 200_000],
    ['claude-opus-4.5', 200_000],
    ['claude-sonnet-4', 200_000],
    ['claude-haiku-4-5-20251001', 200_000],
    ['claude-3.7-sonnet', 200_000],
    ['opus', undefined],
    ['gpt-5', undefined],
  ];
  for (const [id, w] of cases) it(`${id} -> ${String(w)}`, () => assert.equal(contextWindowFor(id), w));
});

describe('models: buildModelList', () => {
  it('static fallback when no live list', () => {
    const l = buildModelList();
    assert.deepEqual(l, STATIC_MODELS);
    assert.notEqual(l[0], STATIC_MODELS[0]); // copies
    assert.equal(l[0]!.kiroId, 'auto');
    assert.equal(l[0]!.claudeValue, undefined);
    assert.equal(l[0]!.isDefault, true);
    assert.deepEqual(buildModelList([]), STATIC_MODELS);
  });
  it('static list has the 2.1.318 models with values and effort levels', () => {
    const haiku45 = STATIC_MODELS.find((m) => m.kiroId === 'claude-haiku-4.5')!;
    assert.equal(haiku45.claudeValue, 'claude-haiku-4-5-20251001');
    assert.equal(haiku45.supportedEffortLevels, null);
    assert.equal(haiku45.contextWindowTokens, 200_000);
    assert.deepEqual(STATIC_MODELS.find((m) => m.kiroId === 'claude-sonnet-4.6')!.supportedEffortLevels, ['low', 'medium', 'high', 'max']);
    for (const m of STATIC_MODELS.slice(1)) assert.equal(claudeToKiroModelId(m.claudeValue!), m.kiroId);
  });
  it('live list: auto first, one entry per Kiro id, aliases as values', () => {
    const l = buildModelList(LIVE);
    assert.deepEqual(
      l.map((e) => [e.kiroId, e.claudeValue]),
      [
        ['auto', undefined],
        ['claude-opus-5.5', 'opus'],
        ['claude-fable-5.1', 'fable'],
        ['claude-sonnet-5.5', 'sonnet'],
        ['claude-haiku-5.5', 'haiku'],
        ['claude-haiku-4.5', 'claude-haiku-4-5-20251001'],
        ['claude-sonnet-5', 'claude-sonnet-5'],
        ['claude-opus-5', 'claude-opus-5'],
        ['claude-fable-5', 'claude-fable-5'],
        ['claude-opus-4.8', 'claude-opus-4-8'],
        ['claude-opus-4.7', 'claude-opus-4-7'],
        ['claude-opus-4.6', 'claude-opus-4-6'],
        ['claude-sonnet-4.6', 'claude-sonnet-4-6'],
      ],
    );
    assert.deepEqual(l[0], {
      kiroId: 'auto',
      displayName: 'Default (recommended)',
      description: 'Opus 5.5 · Best for everyday, complex tasks',
      contextWindowTokens: 1_000_000,
      supportedEffortLevels: FULL,
      isDefault: true,
    });
    assert.deepEqual(l[5], {
      kiroId: 'claude-haiku-4.5',
      claudeValue: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku 4.5',
      description: 'Fastest for quick answers',
      contextWindowTokens: 200_000,
      supportedEffortLevels: null,
    });
  });
  it('live list without a default entry still starts with auto; unknown window omitted', () => {
    const l = buildModelList([{ value: 'opus', resolvedModel: 'claude-opus-5-5' }, { value: 'mystery' }]);
    assert.equal(l[0]!.kiroId, 'auto');
    assert.equal(l[1]!.displayName, 'Opus 5.5');
    assert.equal(l[2]!.kiroId, 'mystery');
    assert.equal(l[2]!.contextWindowTokens, undefined);
  });
  it('measured windows override', () => {
    const l = buildModelList(LIVE, { 'claude-opus-5.5': 500_000, auto: 123 });
    assert.equal(l[0]!.contextWindowTokens, 123);
    assert.equal(l[1]!.contextWindowTokens, 500_000);
    assert.equal(buildModelList(undefined, { 'claude-haiku-4.5': 7 }).find((e) => e.kiroId === 'claude-haiku-4.5')!.contextWindowTokens, 7);
  });
  it('findModelEntry by Kiro id, value or display name', () => {
    const l = buildModelList(LIVE);
    assert.equal(findModelEntry(l, 'CLAUDE-OPUS-5.5')?.claudeValue, 'opus');
    assert.equal(findModelEntry(l, 'sonnet')?.kiroId, 'claude-sonnet-5.5');
    assert.equal(findModelEntry(l, 'haiku 4.5')?.kiroId, 'claude-haiku-4.5');
    assert.equal(findModelEntry(l, 'gpt'), undefined);
  });
});

describe('models: formatModelList (--list-models)', () => {
  const entries = buildModelList(LIVE).slice(0, 3);
  it('json is the KiroCrew object envelope (08a §2.2)', () => {
    const s = formatModelList(entries, 'json');
    assert.ok(!s.includes('\n'));
    const v = JSON.parse(s) as { models: Record<string, unknown>[] };
    assert.ok(v && typeof v === 'object' && Array.isArray(v.models));
    assert.deepEqual(v.models[0], {
      model_name: 'auto',
      model_id: 'auto',
      display_name: 'Default (recommended)',
      description: 'Opus 5.5 · Best for everyday, complex tasks',
      context_window_tokens: 1_000_000,
      rate_multiplier: 1,
    });
    for (const row of v.models) {
      assert.equal(row.model_id, row.model_name);
      assert.ok(Number.isInteger(row.context_window_tokens) && (row.context_window_tokens as number) > 0);
      assert.equal(row.rate_multiplier, 1);
    }
  });
  it('json-pretty is indented and equivalent', () => {
    const s = formatModelList(entries, 'json-pretty');
    assert.ok(s.includes('\n  "models": [\n'));
    assert.deepEqual(JSON.parse(s), JSON.parse(formatModelList(entries, 'json')));
  });
  it('static catalog contains the ids KiroCrew checks', () => {
    const v = JSON.parse(formatModelList(buildModelList(), 'json')) as { models: { model_id: string }[] };
    for (const id of ['auto', 'claude-opus-5.5', 'claude-sonnet-5.5', 'claude-haiku-5.5', 'claude-fable-5.1']) {
      assert.ok(v.models.some((m) => m.model_id === id), id);
    }
  });
  it('plain is an aligned table with the default marked', () => {
    assert.equal(
      formatModelList(entries, 'plain'),
      [
        '* auto              Default (recommended)  1M  Opus 5.5 · Best for everyday, complex tasks',
        '  claude-opus-5.5   Opus 5.5               1M  For complex work and everyday tasks',
        '  claude-fable-5.1  Fable 5.1              1M  For your toughest challenges',
      ].join('\n'),
    );
  });
  it('rows default missing windows to 200000 and description to display name', () => {
    assert.deepEqual(modelListRows([{ kiroId: 'x', displayName: 'X' }]), [
      { model_name: 'x', model_id: 'x', display_name: 'X', description: 'X', context_window_tokens: 200_000, rate_multiplier: 1 },
    ]);
    assert.equal(formatModelList([{ kiroId: 'x', displayName: 'X', contextWindowTokens: 123_456 }], 'plain'), '  x  X  123456');
    assert.equal(formatModelList([{ kiroId: 'y', displayName: 'Y', contextWindowTokens: 200_000 }], 'plain'), '  y  Y  200K');
  });
});

describe('models: model cache', () => {
  function env(): NodeJS.ProcessEnv {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-models-'));
    return { HOME: path.join(tmp, 'home'), XDG_CACHE_HOME: path.join(tmp, 'cache') };
  }
  it('path honors XDG_CACHE_HOME (absolute only), else ~/.cache', () => {
    assert.equal(modelCachePath({ HOME: '/h', XDG_CACHE_HOME: '/c' }), '/c/kiro-claude/models.json');
    assert.equal(modelCachePath({ HOME: '/h', XDG_CACHE_HOME: 'rel' }), '/h/.cache/kiro-claude/models.json');
    assert.equal(modelCachePath({ HOME: '/h' }), '/h/.cache/kiro-claude/models.json');
  });
  it('round-trips models and merges windows', () => {
    const e = env();
    assert.equal(readModelCache(e), undefined);
    assert.equal(writeModelCache({ models: LIVE }, e), true);
    const c1 = readModelCache(e)!;
    assert.deepEqual(c1.models, LIVE);
    assert.deepEqual(c1.contextWindows, {});
    assert.equal(writeModelCache({ contextWindows: { 'claude-haiku-5.5': 1_000_000 } }, e), true);
    const c2 = readModelCache(e)!;
    assert.deepEqual(c2.models, LIVE);
    assert.deepEqual(c2.contextWindows, { 'claude-haiku-5.5': 1_000_000 });
    assert.equal(fs.statSync(modelCachePath(e)).mode & 0o777, 0o600);
  });
  it('malformed cache reads as undefined; bad rows are dropped', () => {
    const e = env();
    fs.mkdirSync(path.dirname(modelCachePath(e)), { recursive: true });
    fs.writeFileSync(modelCachePath(e), '{nope');
    assert.equal(readModelCache(e), undefined);
    fs.writeFileSync(modelCachePath(e), JSON.stringify({ models: [{ value: 'opus' }, 3, { x: 1 }], contextWindows: { a: -1, b: 5 } }));
    assert.deepEqual(readModelCache(e), { version: 1, updatedAt: '', models: [{ value: 'opus' }], contextWindows: { b: 5 } });
  });
  it('write failure returns false', () => {
    const e = env();
    fs.mkdirSync(e.XDG_CACHE_HOME!, { recursive: true });
    fs.writeFileSync(path.join(e.XDG_CACHE_HOME!, 'kiro-claude'), 'a file blocks the directory');
    assert.equal(writeModelCache({ models: LIVE }, e), false);
  });
});
