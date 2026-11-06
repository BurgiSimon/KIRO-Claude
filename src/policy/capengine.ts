/**
 * Kiro V3 capability permission engine for V3 agents (02 §2.8, 00 §5.1 `capEngine`, §5.3).
 *
 * Rules (`{capability, match?, exclude?, effect}`) are gathered from every scope — agent
 * `permissions.rules`, user `permissions.yaml`, workspace `permissions.yaml`, session-requested
 * presets and session rules (`t`, `/tools trust`, `--trust-tools`; `trustAll` adds
 * `{capability: all, effect: allow}`) — with no scope precedence: deny > ask > allow > evaluate.
 *
 * A rule applies to a call when its capability equals the call's capability or is a meta
 * capability: `all` (everything except `sandbox_network`), `builtin` (everything that is not an
 * MCP tool), `filesystem` (`fs_read` + `fs_write`). It matches a subject when `match` is absent
 * (or empty — DECISION) or any `match` pattern matches, and no `exclude` pattern matches.
 *
 * Match syntax per capability:
 *  - `fs_read` / `fs_write`: util/glob `v3path` globs (`*` within a component, `**` across,
 *    braces, classes; a pattern without wildcards also matches everything below it). Relative
 *    patterns resolve against the WORKSPACE ROOT, `~` against home; the literal prefix is
 *    realpath'd and escaped (pathmatch.ts). Subjects are canonical absolute paths; for
 *    Glob/Grep (whose subject is a search root directory) `dir/` is tried as well so that
 *    `./**` covers a search of the workspace root itself (DECISION).
 *  - everything else: util/glob `wildcard` (`*` = any sequence incl. spaces and `/`). Shell
 *    subjects are the call's sub-commands; each is matched in its raw form, its
 *    util/shlex.normalizeCommand form (quotes removed, so `"rm" -rf /` is `rm -rf /`) and that
 *    form without leading `NAME=value` assignments — a pattern matches if any form matches.
 *    MCP subjects are `server/tool`, subagent the agent name, web_fetch the URL, web_search the
 *    query, skill the skill name.
 *
 * Evaluation (per subject; the call's verdict is the most severe over all subjects, so every
 * shell sub-command must pass): matching rules ⇒ most severe effect (`evaluate` alone ⇒ ask,
 * no Kiro trust classifier); no matching rule ⇒ {@link V3_DEFAULT_RULES}; still nothing ⇒ ask.
 * Shell commands that util/shlex.splitCompoundCommand cannot parse are denied with
 * {@link SHELL_PARSE_DENY}. The adapter's todo tools (`TaskCreate`…) are always allowed.
 */

import type { KiroToolCall, PermissionRule, PolicyVerdict, RuleEffect, WorkspaceContext } from '../types.js';
import { globMatch, wildcardMatch } from '../util/glob.js';
import { normalizeCommand } from '../util/shlex.js';
import { canonicalizePath, canonicalizePattern } from './pathmatch.js';
import { isTodoTool } from './toolmap.js';

/** Deny text for shell commands that cannot be split into simple commands (00 §5.1). */
export const SHELL_PARSE_DENY = 'Command could not be parsed; rewrite it as simple commands.';

export interface CapScopes {
  agentRules: PermissionRule[];
  userRules: PermissionRule[];
  workspaceRules: PermissionRule[];
  presetRules: PermissionRule[];
  sessionRules: PermissionRule[];
  trustAll: boolean;
}

/** Meta capabilities accepted in rules (02 §2.8). */
export const META_CAPABILITIES: readonly string[] = Object.freeze(['all', 'builtin', 'filesystem']);

// ───────────────────────────── default policy and presets ─────────────────────────────

/**
 * Shell commands allowed by the V3 default policy (00 §5.3 DECISION for "git read-only … and
 * system info … and similar").
 */
export const DEFAULT_READONLY_SHELL: readonly string[] = Object.freeze([
  'git status*', 'git log*', 'git diff*', 'git show*', 'git branch', 'git branch --list*', 'git branch -a',
  'git branch -r', 'git branch -v*', 'git rev-parse*', 'git remote -v', 'git ls-files*', 'git blame*',
  'pwd', 'whoami', 'uname*', 'hostname', 'date', 'id', 'uptime', 'which *',
]);

/**
 * Options that turn the default read-only git commands into writers (`git log --output=f`,
 * `git branch -v -D x`, external diff drivers). Excluded from the default allow rule so they
 * ask instead (DECISION, safety; 02 §2.8 "options that launch programs never read-only").
 */
export const DEFAULT_READONLY_SHELL_EXCLUDE: readonly string[] = Object.freeze([
  '*--output*', '*--ext-diff*', '*--textconv*', '* -d*', '* -D*', '*--delete*', '* -m*', '* -M*', '*--move*',
  '* -c*', '* -C*', '*--copy*', '* -u*', '*--set-upstream*', '*--unset-upstream*', '* -f*', '*--force*',
  '*--edit-description*',
]);

/** V3 default policy (00 §5.3): fs_read in the workspace, read-only shell, utility tools. */
export const V3_DEFAULT_RULES: readonly PermissionRule[] = Object.freeze([
  { capability: 'fs_read', match: ['./**'], effect: 'allow', scope: 'kiro' },
  {
    capability: 'shell',
    match: [...DEFAULT_READONLY_SHELL],
    exclude: [...DEFAULT_READONLY_SHELL_EXCLUDE],
    effect: 'allow',
    scope: 'kiro',
  },
  { capability: 'utility', effect: 'allow', scope: 'kiro' },
] satisfies PermissionRule[]);

/** `read-only-shell` preset command list (UNVERIFIED upstream list; DECISION). */
export const READ_ONLY_SHELL_PRESET: readonly string[] = Object.freeze([
  ...DEFAULT_READONLY_SHELL,
  'git tag', 'git tag -l*', 'git tag --list*', 'git stash list*', 'git config --get*', 'git config --list*',
  'cargo --version', 'cargo metadata*', 'cargo tree*', 'npm --version', 'npm ls*', 'npm list*', 'npm view*',
  'npm outdated*', 'docker ps*', 'docker images*', 'docker inspect*', 'docker version*', 'kubectl get *',
  'kubectl describe *', 'kubectl version*', 'kubectl logs *', 'rustup show*', 'rustup toolchain list*',
]);

/** `dev-shell` additions on top of `read-only-shell` (UNVERIFIED upstream list; DECISION). */
export const DEV_SHELL_PRESET: readonly string[] = Object.freeze([
  'git add *', 'git commit *', 'git checkout *', 'git switch *', 'git restore *', 'git stash*', 'git merge *',
  'git rebase *', 'git pull*', 'git fetch*', 'git cherry-pick *', 'git mv *', 'git rm *', 'git tag *',
  'cargo *', 'npm *', 'bun *', 'yarn *', 'mkdir *', 'touch *', 'mv *', 'cp *', 'ls', 'ls *', 'cat *', 'grep *',
  'echo', 'echo *',
]);

const DEV_SHELL_EXCLUDE = ['cargo publish*', 'npm publish*', 'yarn publish*', 'bun publish*', 'npm unpublish*'];

/** Known preset ids (02 §2.8). */
export const PRESET_IDS: readonly string[] = Object.freeze([
  'allow-all', 'edit-workspace', 'read-workspace', 'read-all', 'read-only-shell', 'dev-shell', 'approve-for-me',
]);

/** Rules of a session policy preset (02 §2.8), scope `preset`; `undefined` for unknown ids. */
export function presetRules(id: string): PermissionRule[] | undefined {
  const r = (capability: string, effect: RuleEffect, match?: readonly string[], exclude?: readonly string[]): PermissionRule => ({
    capability,
    ...(match ? { match: [...match] } : {}),
    ...(exclude ? { exclude: [...exclude] } : {}),
    effect,
    scope: 'preset',
  });
  const readOnlyShell = (): PermissionRule => r('shell', 'allow', READ_ONLY_SHELL_PRESET, DEFAULT_READONLY_SHELL_EXCLUDE);
  switch (id) {
    case 'allow-all':
      return [r('all', 'allow')];
    case 'edit-workspace':
      return [r('fs_read', 'allow', ['./**']), r('fs_write', 'allow', ['./**'])];
    case 'read-workspace':
      return [r('fs_read', 'allow', ['./**'])];
    case 'read-all':
      return [r('fs_read', 'allow'), r('web_fetch', 'allow'), r('web_search', 'allow')];
    case 'read-only-shell':
      return [readOnlyShell()];
    case 'dev-shell':
      return [readOnlyShell(), r('shell', 'allow', DEV_SHELL_PRESET, DEV_SHELL_EXCLUDE)];
    case 'approve-for-me':
      return [r('fs_read', 'allow', ['./**']), r('fs_write', 'allow', ['./**']), readOnlyShell(), r('all', 'evaluate')];
    default:
      return undefined;
  }
}

// ───────────────────────────── matching ─────────────────────────────

/** Whether `rule` targets `call`'s capability (incl. meta capabilities). */
export function ruleAppliesTo(rule: PermissionRule, call: Pick<KiroToolCall, 'capability'>): boolean {
  const cap = call.capability;
  switch (rule.capability) {
    case 'all':
      return cap !== 'sandbox_network';
    case 'builtin':
      return cap !== 'mcp' && cap !== 'sandbox_network';
    case 'filesystem':
      return cap === 'fs_read' || cap === 'fs_write';
    default:
      return rule.capability === cap;
  }
}

/** Matcher for one subject; caches canonicalized forms. */
class SubjectMatcher {
  private readonly forms: string[];
  constructor(
    private readonly call: KiroToolCall,
    subject: string,
    private readonly ws: WorkspaceContext,
  ) {
    const cap = call.capability;
    if (cap === 'fs_read' || cap === 'fs_write') {
      const c = canonicalizePath(subject, call.cwd || ws.cwd, ws.env);
      this.forms = [c];
      if ((call.claudeName === 'Glob' || call.claudeName === 'Grep') && !c.endsWith('/')) this.forms.push(`${c}/`);
    } else if (cap === 'shell') {
      const set = new Set<string>([subject]);
      const n = normalizeCommand(subject);
      if (n !== null) {
        set.add(n);
        const stripped = n.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S* +)+/, '');
        if (stripped) set.add(stripped);
      }
      this.forms = [...set];
    } else this.forms = [subject];
  }

  matches(pattern: string): boolean {
    const cap = this.call.capability;
    if (cap === 'fs_read' || cap === 'fs_write') {
      const cp = canonicalizePattern(pattern, this.ws.workspaceRoot, this.ws.env, this.ws.home, 'v3path');
      // An escaped literal prefix may contain `[x]` classes, which would defeat the dialect's
      // implicit-children rule; add `p/**` explicitly for wildcard-free user patterns.
      const pats = [cp.pattern];
      if (!hasWildcardChars(pattern)) pats.push(`${cp.pattern.replace(/\/+$/, '')}/**`);
      return pats.some((p) => this.forms.some((f) => globMatch(p, f, 'v3path')));
    }
    return this.forms.some((f) => wildcardMatch(pattern, f));
  }
}

/** True when `p` has an unescaped `*`, `?` or `[` (braces alone keep a pattern "literal"). */
function hasWildcardChars(p: string): boolean {
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '*' || ch === '?' || ch === '[') return true;
  }
  return false;
}

function ruleMatches(rule: PermissionRule, m: SubjectMatcher): boolean {
  const inc = !rule.match || rule.match.length === 0 || rule.match.some((p) => m.matches(p));
  if (!inc) return false;
  return !(rule.exclude ?? []).some((p) => m.matches(p));
}

/** Short human description of a rule, used as a denial / approval reason. */
export function describeRule(rule: PermissionRule): string {
  const match = rule.match && rule.match.length ? rule.match.join(', ') : '*';
  const exc = rule.exclude && rule.exclude.length ? ` (except ${rule.exclude.join(', ')})` : '';
  return `${rule.capability}: ${match}${exc} → ${rule.effect} [${rule.scope ?? 'agent'}]`;
}

const SEVERITY: Record<RuleEffect, number> = { deny: 3, ask: 2, allow: 1, evaluate: 0 };

interface SubjectResult {
  effect: 'deny' | 'ask' | 'allow';
  rules: PermissionRule[];
  subject: string;
}

function evaluateSubject(rules: PermissionRule[], call: KiroToolCall, subject: string, ws: WorkspaceContext): SubjectResult {
  const m = new SubjectMatcher(call, subject, ws);
  let matched = rules.filter((r) => ruleMatches(r, m));
  if (!matched.length) matched = V3_DEFAULT_RULES.filter((r) => ruleAppliesTo(r, call) && ruleMatches(r, m));
  if (!matched.length) return { effect: 'ask', rules: [], subject };
  const top = Math.max(...matched.map((r) => SEVERITY[r.effect]));
  const winners = matched.filter((r) => SEVERITY[r.effect] === top);
  const eff = winners[0]!.effect;
  return { effect: eff === 'evaluate' ? 'ask' : eff, rules: winners, subject };
}

/** All rules in force for a call, in scope order (agent, user, workspace, preset, session, trust-all). */
export function collectRules(scopes: CapScopes): PermissionRule[] {
  const tag = (rs: PermissionRule[], scope: PermissionRule['scope']): PermissionRule[] =>
    rs.map((r) => (r.scope ? r : { ...r, scope }));
  return [
    ...tag(scopes.agentRules ?? [], 'agent'),
    ...tag(scopes.userRules ?? [], 'user'),
    ...tag(scopes.workspaceRules ?? [], 'workspace'),
    ...tag(scopes.presetRules ?? [], 'preset'),
    ...tag(scopes.sessionRules ?? [], 'session'),
    ...(scopes.trustAll ? [{ capability: 'all', effect: 'allow', scope: 'session' } as PermissionRule] : []),
  ];
}

/** Capability-engine decision for one call (see module doc). */
export function evaluateCap(call: KiroToolCall, scopes: CapScopes, ws: WorkspaceContext): PolicyVerdict {
  if (isTodoTool(call.claudeName)) return { kind: 'allow', reasons: ['utility tools are always allowed'] };
  if (call.capability === 'shell' && !call.parseable) return { kind: 'deny', reasons: [SHELL_PARSE_DENY] };
  const rules = collectRules(scopes).filter((r) => ruleAppliesTo(r, call));
  const subjects = call.subjects.length ? call.subjects : [call.v3Id ?? call.claudeName];
  const results = subjects.map((s) => evaluateSubject(rules, call, s, ws));
  const denied = results.filter((r) => r.effect === 'deny');
  if (denied.length) {
    return { kind: 'deny', reasons: [...new Set(denied.flatMap((r) => r.rules.map(describeRule)))] };
  }
  const asked = results.filter((r) => r.effect === 'ask');
  if (asked.length) {
    const reasons = asked.map((r) =>
      r.rules.length
        ? `${r.subject}: ${r.rules.map(describeRule).join('; ')}`
        : `no permission rule allows ${call.capability}: ${r.subject}`,
    );
    return { kind: 'ask', reasons: [...new Set(reasons)] };
  }
  return { kind: 'allow', reasons: [...new Set(results.flatMap((r) => r.rules.map(describeRule)))] };
}
