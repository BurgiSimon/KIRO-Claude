import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UsageError, jaro, parseArgs, renderHelp, suggest, usageLine, type CommandDef } from '../../src/cli/args.js';

const DEF: CommandDef = {
  name: 'demo',
  about: 'A demo command',
  positionals: [
    { id: 'input', valueName: 'INPUT', help: 'The input' },
    { id: 'rest', valueName: 'REST', multiple: true, help: 'More' },
  ],
  args: [
    { id: 'all', long: 'all', short: 'a', kind: 'bool', help: 'Everything' },
    { id: 'verbose', long: 'verbose', short: 'v', kind: 'count', help: 'Louder' },
    { id: 'agent', long: 'agent', aliases: ['profile'], kind: 'value', valueName: 'AGENT', help: 'Agent to use' },
    { id: 'format', long: 'format', short: 'f', kind: 'value', valueName: 'FORMAT', possibleValues: ['plain', 'json'], help: 'Output format' },
    { id: 'tag', long: 'tag', short: 't', kind: 'value', valueName: 'TAG', multiple: true, help: 'Tags' },
    { id: 'args', long: 'args', kind: 'value', valueName: 'ARGS', multiple: true, allowHyphenValues: true },
    { id: 'changelog', long: 'changelog', kind: 'value', valueName: 'CHANGELOG', optionalValue: true, missingValue: '' },
    { id: 'x', long: 'x', kind: 'bool', conflictsWith: ['y'] },
    { id: 'y', long: 'y', kind: 'bool' },
    { id: 'secret', long: 'secret', kind: 'bool', hidden: true },
  ],
};

const p = (argv: string[]) => parseArgs(DEF, argv, 'prog');

test('long, short, clusters, counts, values', () => {
  const r = p(['--all', '-vvv', '--agent', 'dev', '-fjson', 'hello']);
  assert.equal(r.count('all'), 1);
  assert.equal(r.count('verbose'), 3);
  assert.equal(r.value('agent'), 'dev');
  assert.equal(r.value('format'), 'json');
  assert.equal(r.pos('input'), 'hello');
});

test('table: value spellings', () => {
  const cases: Array<[string[], string | undefined]> = [
    [['--agent=dev'], 'dev'],
    [['--agent', 'dev'], 'dev'],
    [['--agent='], ''],
    [['--profile', 'old'], 'old'],
    [['--agent', 'a', '--agent=b'].slice(0, 2), 'a'],
  ];
  for (const [argv, want] of cases) assert.equal(p(argv).value('agent'), want, argv.join(' '));
  assert.equal(p(['-f', 'plain']).value('format'), 'plain');
  assert.equal(p(['-af', 'json']).value('format'), 'json');
  assert.equal(p(['-af=json']).value('format'), 'json');
  assert.equal(p(['-a', '-v', '-f', 'json']).count('verbose'), 1);
});

test('repeated multiple values accumulate; hyphen values only where allowed', () => {
  const r = p(['-t', 'a', '--tag', 'b', '--tag=c', '--args', '-y', '--args', '--flag']);
  assert.deepEqual(r.valuesOf('tag'), ['a', 'b', 'c']);
  assert.deepEqual(r.valuesOf('args'), ['-y', '--flag']);
  assert.throws(() => p(['--agent', '-x']), (e: unknown) => e instanceof UsageError && /a value is required for '--agent <AGENT>' but none was supplied/.test(e.message));
  assert.equal(p(['--agent', '-']).value('agent'), '-');
});

test('optional value: =value, or a following non-flag token (clap num_args 0..=1)', () => {
  assert.equal(p(['--changelog']).value('changelog'), '');
  assert.equal(p(['--changelog=all']).value('changelog'), 'all');
  const r = p(['--changelog', '1.0.0']);
  assert.equal(r.value('changelog'), '1.0.0');
  assert.equal(r.pos('input'), undefined);
  const f = p(['--changelog', '-a']);
  assert.equal(f.value('changelog'), '');
  assert.equal(f.count('all'), 1);
  // require_equals: only through =
  const eqDef: CommandDef = {
    name: 'x',
    args: [{ id: 'c', long: 'c', kind: 'value', optionalValue: true, requireEquals: true, missingValue: '' }],
    positionals: [{ id: 'input', valueName: 'INPUT' }],
  };
  const q = parseArgs(eqDef, ['--c', '1.0.0'], 'kc');
  assert.equal(q.value('c'), '');
  assert.equal(q.pos('input'), '1.0.0');
});

test('positionals, multiple last, and -- passthrough', () => {
  const r = p(['one', 'two', 'three']);
  assert.equal(r.pos('input'), 'one');
  assert.deepEqual(r.posAll('rest'), ['two', 'three']);
  const d = p(['--', '--all', '-v']);
  assert.equal(d.pos('input'), '--all');
  assert.deepEqual(d.posAll('rest'), ['-v']);
  assert.equal(d.count('all'), 0);
  const raw = parseArgs({ ...DEF, rawTrailing: true }, ['x', '--', '--all'], 'prog');
  assert.deepEqual(raw.trailing, ['--all']);
});

test('help short and long', () => {
  assert.equal(p(['-h']).help, 'short');
  assert.equal(p(['--help']).help, 'long');
  // help wins even after other flags (parsing stops)
  assert.equal(p(['--all', '--help', '--bogus']).help, 'long');
});

test('error: unexpected argument with tip and usage (clap layout)', () => {
  try {
    p(['--agnet', 'x']);
    assert.fail('expected an error');
  } catch (e) {
    assert.ok(e instanceof UsageError);
    assert.equal(e.exitCode, 2);
    assert.equal(
      e.message,
      [
        "error: unexpected argument '--agnet' found",
        '',
        "  tip: a similar argument exists: '--agent'",
        '',
        'Usage: prog demo [OPTIONS] [INPUT] [REST]...',
        '',
        "For more information, try '--help'.",
      ].join('\n'),
    );
  }
  assert.throws(() => p(['--zzzzzz']), (e: unknown) => e instanceof UsageError && !/tip:/.test(e.message) && /unexpected argument '--zzzzzz' found/.test(e.message));
  assert.throws(() => p(['-q']), /unexpected argument '-q' found/);
  assert.throws(() => p(['-aq']), /unexpected argument '-q' found/);
});

test('error table', () => {
  const cases: Array<[string[], RegExp]> = [
    [['--format', 'xml'], /^error: invalid value 'xml' for '--format <FORMAT>'\n  \[possible values: plain, json\]\n\nFor more information, try '--help'\.$/],
    [['--format'], /^error: a value is required for '--format <FORMAT>' but none was supplied\n  \[possible values: plain, json\]/],
    [['--agent', 'a', '--agent', 'b'], /error: the argument '--agent <AGENT>' cannot be used multiple times/],
    [['--all', '--all'], /error: the argument '--all' cannot be used multiple times/],
    [['--all=yes'], /error: unexpected value 'yes' for '--all' found; no more were expected/],
    [['--x', '--y'], /error: the argument '--x' cannot be used with '--y'/],
    [['--y', '--x'], /error: the argument '--y' cannot be used with '--x'/],
  ];
  for (const [argv, re] of cases) {
    assert.throws(() => p(argv), (e: unknown) => e instanceof UsageError && re.test(e.message), argv.join(' '));
  }
});

test('required positional', () => {
  const def: CommandDef = { name: 'x', args: [], positionals: [{ id: 'name', valueName: 'NAME', required: true }] };
  assert.throws(
    () => parseArgs(def, [], 'prog'),
    (e: unknown) => e instanceof UsageError && e.message.startsWith('error: the following required arguments were not provided:\n  <NAME>\n\nUsage: prog x [OPTIONS] <NAME>'),
  );
});

test('usage line variants', () => {
  assert.equal(usageLine(DEF, 'prog'), 'Usage: prog demo [OPTIONS] [INPUT] [REST]...');
  assert.equal(usageLine({ name: '', args: [], subcommands: [{ name: 'a', about: '' }] }, 'p'), 'Usage: p [OPTIONS] [COMMAND]');
  assert.equal(usageLine({ name: 'mcp', args: [], usage: '<COMMAND>' }, 'p'), 'Usage: p mcp <COMMAND>');
});

test('long help layout: next-line help, blank line before possible values, hidden omitted', () => {
  const h = renderHelp(DEF, 'prog', 'long');
  assert.ok(h.startsWith('A demo command\n\nUsage: prog demo [OPTIONS] [INPUT] [REST]...\n\nArguments:\n  [INPUT]\n          The input\n'));
  assert.ok(h.includes('  -f, --format <FORMAT>\n          Output format\n\n          [possible values: plain, json]\n\n'));
  assert.ok(h.includes('\n      --agent <AGENT>\n          Agent to use\n\n'));
  assert.ok(h.includes('  -v, --verbose...\n          Louder\n'));
  assert.ok(h.includes('      --changelog [<CHANGELOG>]\n'));
  assert.ok(!h.includes('--secret'));
  assert.ok(!h.includes('--profile'));
  assert.ok(h.endsWith('  -h, --help\n          Print help\n'));
});

test('short help layout: aligned columns, inline possible values', () => {
  const h = renderHelp(DEF, 'prog', 'short');
  const lines = h.split('\n');
  const fmt = lines.find((l) => l.includes('--format'))!;
  assert.match(fmt, /^ {2}-f, --format <FORMAT> +Output format \[possible values: plain, json\]$/);
  const all = lines.find((l) => l.includes('--all'))!;
  assert.equal(all.indexOf('Everything'), fmt.indexOf('Output format'));
  assert.ok(lines.includes('Arguments:'));
});

test('jaro similarity and suggestions', () => {
  assert.equal(jaro('abc', 'abc'), 1);
  assert.equal(jaro('', 'abc'), 0);
  assert.ok(jaro('agnet', 'agent') > 0.9);
  assert.equal(suggest('agnet', ['agent', 'all']), 'agent');
  assert.equal(suggest('zzz', ['agent', 'all']), undefined);
});
