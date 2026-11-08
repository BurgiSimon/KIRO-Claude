/**
 * `kiro-claude crew …` — run KiroCrew's whole persistent pipeline on Claude Code through
 * kiro-claude (08-kirocrew-integration §0, §3; user decision 09 item 1).
 *
 * Subcommands: setup, doctor, start, stop, status, open, logs, exec, unstub, uninstall.
 * Flags follow 08 §3.3/§3.8, plus the aliases this task names: `setup --source <dir>` = `--dir`,
 * `setup --no-claude-acp` = `--members none`, `setup --remove-identity-stub` = `crew unstub`, and
 * the test-only `setup --kiro-bin <abs>` of the e2e plan (08 §5.0 stage A).
 * Exit codes: 0 ok, 1 failure, 2 usage error; `status`: 0 running and ready, 3 stopped, 4 running
 * but not ready; `open`: 3 when not running; `exec`: the child's exit code.
 *
 * {@link createCrewCommand} takes injectable dependencies (tests use fake executables and fake
 * system seams); {@link runCrewCommand} is the production instance.
 */
import type { CliContext, SubcommandRunner } from '../types.js';
import { defaultDeps, makeCrewCtx, type CrewDeps } from './context.js';
import { crewDoctor } from './doctor.js';
import { parseEnvPair } from './env.js';
import { crewExec, crewLogs, crewOpen, crewStart, crewStatus, crewStop } from './gateway.js';
import { crewSetup, crewUninstall, crewUnstub } from './setup.js';

export const CREW_HELP_TEXT = `Run Kiro Crew (persistent sessions, memory, skills, schedules, delegation, dashboard) on Claude Code

Usage: kiro-claude crew <COMMAND> [OPTIONS]

Commands:
  setup      Fetch, build and configure Kiro Crew to use kiro-claude as its kiro-cli
  doctor     Check the installation ([--json] [--fix] [--no-gateway])
  start      Start the Kiro Crew gateway in the background
  stop       Stop the gateway and reap its agent processes
  status     Show whether the gateway is running and ready ([--json])
  open       Open the dashboard in a browser ([--print] [--ttl 1h])
  logs       Show gateway logs ([-f] [--acp] [-n 200])
  exec       Run a kirocrew command with the gateway environment (exec -- <args…>)
  unstub     Remove kiro-claude's kiro-cli identity stub (only if it is ours)
  uninstall  Undo setup ([--purge])

Every model turn Kiro Crew makes runs on your installed Claude Code (claude), through
kiro-claude for main, cron, heartbeat, subagent and task sessions, and through
claude-agent-acp for Bot sessions.

Run 'kiro-claude crew <COMMAND> --help' for the options of a command.
`;

const SUB_HELP: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  setup: `Fetch, build and configure Kiro Crew for kiro-claude

Usage: kiro-claude crew setup [OPTIONS]

Options:
      --dir <PATH>            Kiro Crew checkout to use (alias: --source)
      --slim                  Fetch without temp-screenshots/ and with a blob filter
      --full                  Full build (make build; needed for Kiro Crew's pytest suites)
      --no-build              Do not build
      --no-fetch              Do not fetch; use the checkout as it is
      --members <claude|none> Bot sessions on claude-agent-acp (default) or none
      --no-claude-acp         Same as --members none
      --claude-bin <PATH>     Claude Code executable to bake into the shim
      --port <N>              Default dashboard port (default 5476)
      --no-identity-stub      Do not write the token-less kiro-cli identity stub
      --remove-identity-stub  Remove kiro-claude's identity stub and exit (same as crew unstub)
      --with-embeddings       Let Kiro Crew download its embedding model (610 MB)
      --app-store             Let Kiro Crew fetch its app store
      --allow-tmp             Allow a checkout under the system temp directory
      --kiro-bin <PATH>       Use another kiro-cli for Kiro Crew (test only)
  -y, --yes                   Do not ask for confirmation
`,
  doctor: `Check the Kiro Crew installation

Usage: kiro-claude crew doctor [--json] [--fix] [--no-gateway]
`,
  start: `Start the Kiro Crew gateway

Usage: kiro-claude crew start [OPTIONS]

Options:
      --port <N|auto>         Dashboard port (default: the setup port, 5476)
      --approval <MODE>       auto (= Kiro Crew's yolo), interactive or reads
      --no-crons              Do not run schedules in this gateway
      --test-mode             Bring-up only (skips readiness checks and housekeeping)
      --foreground            Run in the foreground (systemd, containers)
      --env <K=V>             Extra environment for the gateway (repeatable)
      --kiro-bin <PATH>       Use another kiro-cli (test only)
`,
  stop: `Stop the Kiro Crew gateway

Usage: kiro-claude crew stop [--timeout <SECONDS>]

Runs 'kirocrew stop' and waits for the gateway to exit (--timeout, default 30 s). If it still
runs and its pid is known, it gets SIGTERM and, 10 s later, SIGKILL. Then crew stop reaps
orphaned 'kiro-claude acp' agent processes, ends what is left of the gateway's own process
tree and removes the dashboard token.

On Linux it also retires the processes that a gateway which crashed left running in its
process group, proven from run/ready.json and run/crashed.json (crew start warns when there
are any); elsewhere it signals none of them.

Exit status: 0 stopped (or not running); 1 not set up, the gateway did not exit, its lock is
still held, or, with no gateway running, a leftover of a crashed one survived SIGKILL.
`,
  status: `Show the gateway state

Usage: kiro-claude crew status [--json]

Exit status: 0 running and ready, 3 stopped, 4 running but not ready.
`,
  open: `Open the dashboard

Usage: kiro-claude crew open [--print] [--ttl <DURATION>]
`,
  logs: `Show gateway logs

Usage: kiro-claude crew logs [-f] [--acp] [-n <LINES>]
`,
  exec: `Run a kirocrew command with the gateway environment

Usage: kiro-claude crew exec [--env <K=V>]... -- <kirocrew args…>

Examples:
  kiro-claude crew exec -- chat -m "hi"
  kiro-claude crew exec -- doctor
  kiro-claude crew exec -- service install
`,
  unstub: `Remove kiro-claude's token-less kiro-cli identity stub (never a real kiro-cli store)

Usage: kiro-claude crew unstub
`,
  uninstall: `Undo crew setup: stops the gateway, restores Kiro Crew's previous config, and removes
the shim, the identity stub (only if crew setup created it), crew.json and the run files and
logs under run/ (crashed.json included). Kiro Crew's data and the checkout are kept.

Usage: kiro-claude crew uninstall [--purge]

  --purge  also remove the private claude-agent-acp bridge and the build caches, then the crew
           state directory itself when it is empty, and print what it removed and what it
           kept. After an earlier plain uninstall, it removes just these leftovers (not while
           a gateway may still be running)
`,
});

/** Own-key lookup (never `Object.prototype` names such as `constructor`). */
function subHelp(name: string | undefined): string | undefined {
  return name !== undefined && Object.prototype.hasOwnProperty.call(SUB_HELP, name) ? SUB_HELP[name] : undefined;
}

type FlagType = 'bool' | 'string' | 'multi';
interface FlagDef {
  type: FlagType;
  short?: string;
}
type FlagSpec = Record<string, FlagDef>;
type FlagValues = Record<string, boolean | string | string[] | undefined>;

class UsageError extends Error {}

/** Parses `--flag`, `--flag value`, `--flag=value`, `-x` (short aliases). Stops at `--`. */
export function parseFlags(args: string[], spec: FlagSpec): { flags: FlagValues; rest: string[] } {
  const flags: FlagValues = {};
  const rest: string[] = [];
  const shortMap = new Map<string, string>();
  for (const [name, def] of Object.entries(spec)) if (def.short) shortMap.set(def.short, name);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    let name: string | undefined;
    let inline: string | undefined;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    } else if (/^-[A-Za-z]$/.test(a)) {
      name = shortMap.get(a.slice(1));
      if (!name) throw new UsageError(`unexpected argument '${a}' found`);
    } else {
      rest.push(a);
      continue;
    }
    const def = spec[name];
    if (!def) throw new UsageError(`unexpected argument '${a}' found`);
    if (def.type === 'bool') {
      if (inline !== undefined) throw new UsageError(`unexpected value '${inline}' for '--${name}' found`);
      flags[name] = true;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      value = args[i + 1];
      if (value === undefined) throw new UsageError(`a value is required for '--${name}' but none was supplied`);
      i++;
    }
    if (def.type === 'multi') flags[name] = [...((flags[name] as string[] | undefined) ?? []), value];
    else flags[name] = value;
  }
  return { flags, rest };
}

function parsePort(v: string | undefined, allowAuto: boolean): number | 'auto' | undefined {
  if (v === undefined) return undefined;
  if (allowAuto && v === 'auto') return 'auto';
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) throw new UsageError(`invalid value '${v}' for '--port <N>'`);
  return Number(v);
}

function parseEnvFlags(values: string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const v of values) {
    try {
      const [k, val] = parseEnvPair(v);
      out[k] = val;
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
  }
  return out;
}

function noRest(rest: string[]): void {
  if (rest.length) throw new UsageError(`unexpected argument '${rest[0]}' found`);
}

const HELP_FLAG: FlagSpec = { help: { type: 'bool', short: 'h' } };

export function createCrewCommand(depsOverride: Partial<CrewDeps> = {}): SubcommandRunner {
  return async (args: string[], ctx: CliContext): Promise<number> => {
    const deps = { ...defaultDeps(), ...depsOverride };
    const sub = args[0];
    let signalCleanup: (() => void) | undefined;
    // Only `logs -f` waits for Ctrl+C; every other command keeps Node's default SIGINT behaviour.
    if (!deps.signal && sub === 'logs') {
      const ac = new AbortController();
      const onInt = (): void => ac.abort();
      process.once('SIGINT', onInt);
      signalCleanup = () => process.removeListener('SIGINT', onInt);
      deps.signal = ac.signal;
    }
    const c = makeCrewCtx(ctx, deps);
    const rest = args.slice(1);
    try {
      if (sub === undefined) {
        ctx.stderr.write(CREW_HELP_TEXT);
        return 2;
      }
      if (sub === '--help' || sub === '-h' || sub === 'help') {
        const topic = sub === 'help' ? rest[0] : undefined;
        ctx.stdout.write(subHelp(topic) ?? CREW_HELP_TEXT);
        return 0;
      }
      const help = subHelp(sub);
      if (help === undefined) throw new UsageError(`unrecognized subcommand '${sub}'`);
      if (sub !== 'exec' && (rest.includes('--help') || rest.includes('-h'))) {
        ctx.stdout.write(help);
        return 0;
      }
      switch (sub) {
        case 'setup': {
          const { flags, rest: pos } = parseFlags(rest, {
            ...HELP_FLAG,
            dir: { type: 'string' },
            source: { type: 'string' },
            slim: { type: 'bool' },
            full: { type: 'bool' },
            'no-build': { type: 'bool' },
            'no-fetch': { type: 'bool' },
            members: { type: 'string' },
            'no-claude-acp': { type: 'bool' },
            'claude-bin': { type: 'string' },
            port: { type: 'string' },
            'no-identity-stub': { type: 'bool' },
            'remove-identity-stub': { type: 'bool' },
            'with-embeddings': { type: 'bool' },
            'app-store': { type: 'bool' },
            'allow-tmp': { type: 'bool' },
            'kiro-bin': { type: 'string' },
            yes: { type: 'bool', short: 'y' },
          });
          noRest(pos);
          if (flags['remove-identity-stub']) return await crewUnstub(c);
          const setupKiroBin = flags['kiro-bin'] as string | undefined;
          if (setupKiroBin !== undefined && !setupKiroBin.startsWith('/')) throw new UsageError("'--kiro-bin' needs an absolute path");
          if (flags.full && flags['no-build']) throw new UsageError("the argument '--full' cannot be used with '--no-build'");
          if (flags.dir && flags.source && flags.dir !== flags.source) throw new UsageError("the argument '--dir' cannot be used with '--source'");
          const members = flags['no-claude-acp'] ? 'none' : ((flags.members as string | undefined) ?? 'claude');
          if (members !== 'claude' && members !== 'none') throw new UsageError(`invalid value '${members}' for '--members <claude|none>'`);
          if (flags['no-claude-acp'] && flags.members === 'claude') throw new UsageError("the argument '--no-claude-acp' cannot be used with '--members claude'");
          const port = parsePort(flags.port as string | undefined, false) as number | undefined;
          return await crewSetup(c, {
            dir: (flags.dir ?? flags.source) as string | undefined,
            slim: !!flags.slim,
            build: flags.full ? 'full' : flags['no-build'] ? 'none' : 'light',
            fetch: !flags['no-fetch'],
            members,
            claudeBin: flags['claude-bin'] as string | undefined,
            port,
            identityStub: !flags['no-identity-stub'],
            withEmbeddings: !!flags['with-embeddings'],
            appStore: !!flags['app-store'],
            allowTmp: !!flags['allow-tmp'],
            kiroBin: setupKiroBin,
            yes: !!flags.yes,
          });
        }
        case 'doctor': {
          const { flags, rest: pos } = parseFlags(rest, { ...HELP_FLAG, json: { type: 'bool' }, fix: { type: 'bool' }, 'no-gateway': { type: 'bool' }, 'kiro-bin': { type: 'string' } });
          noRest(pos);
          return await crewDoctor(c, { json: !!flags.json, fix: !!flags.fix, noGateway: !!flags['no-gateway'], kiroBin: flags['kiro-bin'] as string | undefined });
        }
        case 'start': {
          const { flags, rest: pos } = parseFlags(rest, {
            ...HELP_FLAG,
            port: { type: 'string' },
            approval: { type: 'string' },
            'no-crons': { type: 'bool' },
            'test-mode': { type: 'bool' },
            foreground: { type: 'bool' },
            env: { type: 'multi' },
            'kiro-bin': { type: 'string' },
          });
          noRest(pos);
          const approvalFlag = flags.approval as string | undefined;
          if (approvalFlag !== undefined && !['auto', 'interactive', 'reads', 'yolo'].includes(approvalFlag)) {
            throw new UsageError(`invalid value '${approvalFlag}' for '--approval <MODE>' [possible values: auto, interactive, reads]`);
          }
          // KiroCrew's `gateway --approval` choices are reads|yolo|interactive (SRC cli.py); 08 §3.8's
          // `auto` (auto-approve every tool) is its `yolo`. DECISION (08 names `auto` without a mapping).
          const approval = approvalFlag === 'auto' ? 'yolo' : approvalFlag;
          const kiroBin = flags['kiro-bin'] as string | undefined;
          if (kiroBin !== undefined && !kiroBin.startsWith('/')) throw new UsageError("'--kiro-bin' needs an absolute path");
          return await crewStart(c, {
            port: parsePort(flags.port as string | undefined, true),
            approval,
            noCrons: !!flags['no-crons'],
            testMode: !!flags['test-mode'],
            foreground: !!flags.foreground,
            env: parseEnvFlags(flags.env as string[] | undefined),
            kiroBin,
          });
        }
        case 'stop': {
          const { flags, rest: pos } = parseFlags(rest, { ...HELP_FLAG, timeout: { type: 'string' } });
          noRest(pos);
          const t = flags.timeout as string | undefined;
          if (t !== undefined && !/^\d+$/.test(t)) throw new UsageError(`invalid value '${t}' for '--timeout <SECONDS>'`);
          return await crewStop(c, { timeoutSec: t === undefined ? undefined : Number(t) });
        }
        case 'status': {
          const { flags, rest: pos } = parseFlags(rest, { ...HELP_FLAG, json: { type: 'bool' } });
          noRest(pos);
          return await crewStatus(c, { json: !!flags.json });
        }
        case 'open': {
          const { flags, rest: pos } = parseFlags(rest, { ...HELP_FLAG, print: { type: 'bool' }, ttl: { type: 'string' } });
          noRest(pos);
          return await crewOpen(c, { print: !!flags.print, ttl: flags.ttl as string | undefined });
        }
        case 'logs': {
          const { flags, rest: pos } = parseFlags(rest, { ...HELP_FLAG, follow: { type: 'bool', short: 'f' }, acp: { type: 'bool' }, lines: { type: 'string', short: 'n' } });
          noRest(pos);
          const n = flags.lines as string | undefined;
          if (n !== undefined && !/^\d+$/.test(n)) throw new UsageError(`invalid value '${n}' for '-n <LINES>'`);
          return await crewLogs(c, { follow: !!flags.follow, acp: !!flags.acp, lines: n === undefined ? undefined : Number(n) });
        }
        case 'exec': {
          // Options of ours only before `--`; everything after goes to kirocrew verbatim.
          const dd = rest.indexOf('--');
          const ours = dd >= 0 ? rest.slice(0, dd) : [];
          const theirs = dd >= 0 ? rest.slice(dd + 1) : rest;
          if (dd < 0 && (theirs[0] === '--help' || theirs[0] === '-h')) {
            ctx.stdout.write(SUB_HELP.exec!);
            return 0;
          }
          const { flags, rest: pos } = parseFlags(ours, { env: { type: 'multi' } });
          noRest(pos);
          if (theirs.length === 0) throw new UsageError('kirocrew arguments are required: kiro-claude crew exec -- <args…>');
          return await crewExec(c, theirs, { env: parseEnvFlags(flags.env as string[] | undefined) });
        }
        case 'unstub': {
          const { rest: pos } = parseFlags(rest, HELP_FLAG);
          noRest(pos);
          return await crewUnstub(c);
        }
        case 'uninstall': {
          const { flags, rest: pos } = parseFlags(rest, { ...HELP_FLAG, purge: { type: 'bool' } });
          noRest(pos);
          return await crewUninstall(c, { purge: !!flags.purge });
        }
        default:
          throw new UsageError(`unrecognized subcommand '${sub}'`);
      }
    } catch (e) {
      if (e instanceof UsageError) {
        ctx.stderr.write(`error: ${e.message}\n\nFor more information, try 'kiro-claude crew ${subHelp(sub) !== undefined ? `${sub} ` : ''}--help'.\n`);
        return 2;
      }
      ctx.stderr.write(`kiro-claude: ${(e as Error).message}\n`);
      return 1;
    } finally {
      signalCleanup?.();
    }
  };
}

/** `kiro-claude crew …` (fixed entry point, see src/types.ts SubcommandRunner). */
export const runCrewCommand: SubcommandRunner = (args, ctx) => createCrewCommand()(args, ctx);
