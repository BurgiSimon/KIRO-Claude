#!/usr/bin/env bash
# KiroCrew's kiro-cli CLI contract (08-kirocrew-integration §2.1 KC-BIN-*, §2.2 KC-CLI-*), checked
# against the crew shim with KiroCrew's OWN parsers ($KCPY -I -c 'from kiro_crew… import …').
#
#   contract.sh [--stage B|C] [--shim <path>]
#
# Stage B (default): the shim's baked Claude is test/fixtures/fake-claude.mjs (crew setup
# --claude-bin); whoami is checked signed in (fake default), signed out (FAKE_CLAUDE_LOGGED_OUT=1)
# and with a missing Claude. Stage C: the real `claude` (signed in), no signed-out variants and no
# `login` run.
# Prints one `PASS|FAIL|SKIP <id> <evidence>` line per row; exits 1 if any row FAILs.
# Needs env.sh sourced (HOME, SHIM, KCPY, E2E).
set -u
STAGE=B
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE=$2; shift 2 ;;
    --real) STAGE=C; shift ;;
    --shim) SHIM=$2; shift 2 ;;
    *) echo "usage: $0 [--stage B|C] [--shim PATH]" >&2; exit 2 ;;
  esac
done
: "${SHIM:?source env.sh first}" "${KCPY:?source env.sh first}" "${E2E:?source env.sh first}"
W="$E2E/contract"; mkdir -p "$W"
FAILS=0
pass() { echo "PASS $1 $2"; }
fail() { echo "FAIL $1 $2"; FAILS=$((FAILS + 1)); }
skip() { echo "SKIP $1 $2"; }
probe() { env -i HOME="$HOME" PATH=/usr/bin:/bin LANG=C.UTF-8 NO_COLOR=1 TERM=dumb "$@"; }
now_ms() { date +%s%3N; }
# run <name> <cmd…>: stdout → $W/<name>.out, stderr → $W/<name>.err, rc → RC, wall ms → MS; stdin /dev/null.
run() {
  local n=$1; shift
  local t0; t0=$(now_ms)
  "$@" </dev/null >"$W/$n.out" 2>"$W/$n.err"; RC=$?
  MS=$(( $(now_ms) - t0 ))
}
kcpy() { "$KCPY" -I -B -c "$@"; }
short() { tr '\n' ' ' <"$1" | cut -c1-${2:-160}; }
# A fake-claude log that must stay absent: proves a fast path spawned no Claude (stage B).
NOSPAWN="$W/no-spawn.jsonl"; rm -f "$NOSPAWN"
spawned() { [ -s "$NOSPAWN" ]; }

# ── KC-BIN ───────────────────────────────────────────────────────────────────
if [ -x "$SHIM" ] && [ "$(basename "$SHIM")" = kiro-claude ] && case "$SHIM" in /*) true ;; *) false ;; esac; then
  pass KC-BIN-01 "executable, absolute, basename kiro-claude"
else fail KC-BIN-01 "shim $SHIM not an absolute executable named kiro-claude"; fi
hidden=""
for d in "${KIROCREW_HOME:-$HOME/.kiro/crew}" "$HOME/.kiro/crew" "$HOME/.kirocrew" "$HOME/.local/share/kiro-cli" "$HOME/Library/Application Support/kiro-cli" "$HOME/.aws"; do
  case "$SHIM" in "$d"/*) hidden=$d ;; esac
done
if [ -z "$hidden" ]; then pass KC-BIN-02 "not under a probe-hidden dir"; else fail KC-BIN-02 "shim under $hidden"; fi
run bin03 probe "$SHIM" --version
if [ $RC -eq 0 ] && [ $MS -lt 1000 ] && grep -q '^kiro-claude ' "$W/bin03.out"; then pass KC-BIN-03 "probe env --version rc=0 in ${MS}ms"
else fail KC-BIN-03 "probe env --version rc=$RC ${MS}ms: $(short "$W/bin03.err")"; fi
best=999999
for _ in 1 2 3; do run bin05 env FAKE_CLAUDE_LOG="$NOSPAWN" "$SHIM" acp --help; [ $MS -lt $best ] && best=$MS; done
if [ $RC -eq 0 ] && [ $best -lt 300 ] && ! spawned; then pass KC-BIN-05 "acp --help best of 3 = ${best}ms, no claude spawn"
else fail KC-BIN-05 "acp --help rc=$RC best ${best}ms spawned=$(spawned && echo yes || echo no)"; fi

# ── KC-CLI-01 --version ──────────────────────────────────────────────────────
run cli01 probe "$SHIM" --version
if [ $RC -eq 0 ] && [ "$(cat "$W/cli01.out")" = "kiro-claude 0.1.0 (kiro-cli 1.26.0)" ] &&
   kcpy 'import sys;from kiro_crew.mcp_hot_reload import parse_kiro_cli_version as p;v=p(open(sys.argv[1]).read());assert v and (1,26,0)<=v<(2,21,0),v' "$W/cli01.out" 2>"$W/cli01.py.err"; then
  pass KC-CLI-01 "$(cat "$W/cli01.out") (parse_kiro_cli_version in [1.26,2.21))"
else fail KC-CLI-01 "rc=$RC out=$(short "$W/cli01.out") py=$(short "$W/cli01.py.err" 300)"; fi

# ── KC-CLI-02 acp --help ─────────────────────────────────────────────────────
run cli02 probe "$SHIM" acp --help
if [ $RC -eq 0 ] && kcpy 'import sys
t=open(sys.argv[1]).read()
from kiro_crew.kiro_cli import chat_agent_engines as e
from kiro_crew.agent_sdk.drivers.acp import kas_engine_gap as g
assert "--agent-engine" in t and "[possible values: v1, v2]" in t, "flag/values missing"
assert e(t)==("v1","v2"), e(t)
assert "v3" not in t, "v3 substring"
assert g(t), "kas_engine_gap falsy"' "$W/cli02.out" 2>"$W/cli02.py.err"; then
  pass KC-CLI-02 "chat_agent_engines==(v1,v2), no v3, kas_engine_gap truthy"
else fail KC-CLI-02 "rc=$RC py=$(short "$W/cli02.py.err" 300)"; fi

# ── KC-CLI-03 chat --help ────────────────────────────────────────────────────
run cli03 probe "$SHIM" chat --help
if [ $RC -eq 0 ] && kcpy 'import sys,re
t=open(sys.argv[1]).read()
from kiro_crew.kiro_cli import chat_agent_engines as e
assert e(t)==("v1","v2"), e(t)
assert "v3" not in t, "v3 substring"
m=re.search(r"\n      --agent-engine <ENGINE>(.*?)(?=\n      --|\n  -|\Z)", t, re.S)
assert m and "[possible values: v1, v2]" in m.group(1), "no [possible values: v1, v2] inside the --agent-engine block"' "$W/cli03.out" 2>"$W/cli03.py.err"; then
  pass KC-CLI-03 "--agent-engine block lists v1, v2; no v3"
else fail KC-CLI-03 "rc=$RC py=$(short "$W/cli03.py.err" 300)"; fi

# ── KC-CLI-04 whoami ─────────────────────────────────────────────────────────
run cli04 probe "$SHIM" whoami
if [ $RC -eq 0 ] && grep -q '^Logged in with Claude Code (' "$W/cli04.out" && ! grep -qi 'not logged in' "$W/cli04.out"; then
  pass KC-CLI-04 "probe env: $(head -1 "$W/cli04.out") rc=0"
else fail KC-CLI-04 "probe env rc=$RC out=$(short "$W/cli04.out") err=$(short "$W/cli04.err")"; fi
if [ "$STAGE" = B ]; then
  run cli04o env FAKE_CLAUDE_LOGGED_OUT=1 "$SHIM" whoami
  if [ $RC -eq 1 ] && [ "$(cat "$W/cli04o.err")" = 'Not logged in. Run "kiro-claude login" to sign in to Claude Code.' ] && [ ! -s "$W/cli04o.out" ]; then
    pass KC-CLI-04-loggedout "FAKE_CLAUDE_LOGGED_OUT=1: rc=1, exact stderr, empty stdout"
  else fail KC-CLI-04-loggedout "rc=$RC out=$(short "$W/cli04o.out") err=$(short "$W/cli04o.err")"; fi
  run cli04m env KIRO_CLAUDE_BIN="$E2E/no-such-claude" "$SHIM" whoami
  if [ $RC -eq 1 ] && grep -q '^Not logged in: Claude Code not found (' "$W/cli04m.err"; then
    pass KC-CLI-04-missing "missing claude: $(short "$W/cli04m.err" 120) rc=1"
  else fail KC-CLI-04-missing "rc=$RC err=$(short "$W/cli04m.err")"; fi
fi

# ── KC-CLI-05 whoami --format json ───────────────────────────────────────────
ok5=1; ev5=""
for f in "--format json" "-f json" "--format json-pretty"; do
  # shellcheck disable=SC2086
  run cli05 probe "$SHIM" whoami $f
  if [ $RC -ne 0 ] || ! kcpy 'import sys,json
t=open(sys.argv[1]).read()
from kiro_crew.cloud.login_target import parse_whoami_output as p
d=p(t); assert isinstance(d,dict), d
o=json.loads(t); assert isinstance(o,dict) and "accountType" not in o, o
assert set(o) <= {"email"}, o' "$W/cli05.out" 2>"$W/cli05.py.err"; then ok5=0; ev5="$ev5 [$f rc=$RC $(short "$W/cli05.py.err" 200)]"; fi
done
if [ "$STAGE" = B ]; then
  run cli05o env FAKE_CLAUDE_LOGGED_OUT=1 "$SHIM" whoami --format json
  if [ $RC -ne 1 ] || [ -s "$W/cli05o.out" ]; then ok5=0; ev5="$ev5 [logged out rc=$RC out=$(short "$W/cli05o.out")]"; fi
fi
if [ $ok5 = 1 ]; then pass KC-CLI-05 "--format json|-f json|json-pretty parse to a dict without accountType$([ "$STAGE" = B ] && echo '; logged out rc=1, no JSON')"
else fail KC-CLI-05 "$ev5"; fi

# ── KC-CLI-06 chat --list-models ─────────────────────────────────────────────
ok6=1; ev6=""; worst=0
for order in "chat --list-models --format json --no-interactive" "chat --no-interactive --list-models --format json" "chat --format json-pretty --list-models --no-interactive"; do
  # shellcheck disable=SC2086
  run cli06 env FAKE_CLAUDE_LOG="$NOSPAWN" "$SHIM" $order
  [ $MS -gt $worst ] && worst=$MS
  if [ $RC -ne 0 ] || [ $MS -ge 1000 ] || ! kcpy 'import sys,json
d=json.loads(open(sys.argv[1]).read())
assert isinstance(d,dict) and d["models"], "not an object with models"
from kiro_crew.model_registry import admit_catalog_rows as a
ids,w=a(d["models"])
assert "claude-haiku-5.5" in ids and w, (ids,w)
for r in d["models"]:
    assert r["model_name"] and r["model_id"] and "description" in r, r
    assert isinstance(r["context_window_tokens"],int) and r["context_window_tokens"]>0, r
    assert r["rate_multiplier"]==1.0, r' "$W/cli06.out" 2>"$W/cli06.py.err"; then ok6=0; ev6="$ev6 [$order rc=$RC ${MS}ms $(short "$W/cli06.py.err" 200)]"; fi
done
if spawned; then ok6=0; ev6="$ev6 [claude spawned]"; fi
if [ $ok6 = 1 ]; then pass KC-CLI-06 "3 flag orders: {models:[…]} admitted by admit_catalog_rows incl. claude-haiku-5.5, worst ${worst}ms, no claude spawn"
else fail KC-CLI-06 "$ev6"; fi

# ── KC-CLI-07 /usage ─────────────────────────────────────────────────────────
run cli07 env FAKE_CLAUDE_LOG="$NOSPAWN" "$SHIM" chat --no-interactive --agent-engine v2 --agent kirocrew-lite /usage
want7='Claude Code subscription usage is not reported as Kiro credits. Run /usage inside kiro-claude chat.'
if [ $RC -eq 0 ] && [ $MS -lt 1000 ] && [ "$(cat "$W/cli07.out")" = "$want7" ] && ! grep -q 'Estimated Usage' "$W/cli07.out" && ! spawned; then
  pass KC-CLI-07 "exact text, rc=0, ${MS}ms, no claude spawn"
else fail KC-CLI-07 "rc=$RC ${MS}ms out=$(short "$W/cli07.out") err=$(short "$W/cli07.err")"; fi

# ── KC-CLI-08 update ─────────────────────────────────────────────────────────
want8='kiro-claude is updated by its installer; nothing to do. Update Claude Code with: claude update'
ok8=1; ev8=""
for a in "update" "update --non-interactive" "update -y" "update --check"; do
  # shellcheck disable=SC2086
  run cli08 env FAKE_CLAUDE_LOG="$NOSPAWN" timeout 5 "$SHIM" $a
  if [ $RC -ne 0 ] || [ $MS -ge 1000 ] || [ "$(cat "$W/cli08.out")" != "$want8" ]; then ok8=0; ev8="$ev8 [$a rc=$RC ${MS}ms $(short "$W/cli08.out" 100) $(short "$W/cli08.err" 100)]"; fi
done
if spawned; then ok8=0; ev8="$ev8 [claude spawned]"; fi
if [ $ok8 = 1 ]; then pass KC-CLI-08 "update, --non-interactive, -y, --check: exact text, rc=0, <1s"; else fail KC-CLI-08 "$ev8"; fi

# ── KC-CLI-09 agent validate ─────────────────────────────────────────────────
spec="$HOME/.kiro/agents/kirocrew.json"
if [ ! -f "$spec" ]; then mkdir -p "$W/agents"; spec="$W/agents/kc-valid.json"; printf '{"name":"kc-valid","tools":["fs_read"],"allowedTools":["fs_read"]}\n' >"$spec"; fi
printf '{"name":"kc-bad","tools":5}\n' >"$W/bad-agent.json"
run cli09 probe "$SHIM" agent validate --path "$spec"
rc_ok=$RC; out_ok=$(cat "$W/cli09.out")
run cli09b probe "$SHIM" agent validate --path "$W/bad-agent.json"
if [ $rc_ok -eq 0 ] && [ -z "$out_ok" ] && [ $RC -eq 1 ] && grep -q "^Error: Json supplied at .* is invalid: " "$W/cli09b.out"; then
  pass KC-CLI-09 "$(basename "$spec") accepted silently; tools:5 → $(short "$W/cli09b.out" 120) rc=1"
else fail KC-CLI-09 "valid rc=$rc_ok out=$(echo "$out_ok" | head -c 160) err=$(short "$W/cli09.err"); bad rc=$RC out=$(short "$W/cli09b.out")"; fi

# ── KC-CLI-10 acp --agent-engine v3 ──────────────────────────────────────────
run cli10 "$SHIM" acp --agent-engine v3 --auth-method cli
want10=$(printf "error: invalid value 'v3' for '--agent-engine <ENGINE>'\n  [possible values: v1, v2]\n\nkiro-claude has no v3 (KAS) agent engine.")
if [ $RC -eq 2 ] && [ $MS -lt 500 ] && [ "$(cat "$W/cli10.err")" = "$want10" ]; then pass KC-CLI-10 "exact clap error, rc=2, ${MS}ms"
else fail KC-CLI-10 "rc=$RC ${MS}ms err=$(short "$W/cli10.err" 300)"; fi
# Also: v1/v2 accepted (they reach the ACP server, which exits on stdin EOF).
run cli10b timeout 10 "$SHIM" acp --agent-engine v2 --auth-method cli
if [ $RC -eq 0 ]; then pass KC-CLI-10-v2 "acp --agent-engine v2 accepted (EOF exit 0 in ${MS}ms)"; else fail KC-CLI-10-v2 "rc=$RC err=$(short "$W/cli10b.err")"; fi

# ── KC-CLI-11 login ──────────────────────────────────────────────────────────
if [ "$STAGE" = B ]; then
  # KiroCrew only shows `<bin> login` when signed out, so check it signed out (signed in,
  # kiro-cli's own `login` refuses with "Already logged in"; recorded as evidence only).
  run cli11 env FAKE_CLAUDE_LOGGED_OUT=1 FAKE_CLAUDE_AUTH_EXIT=0 timeout 10 "$SHIM" login
  rc11=$RC
  run cli11b env FAKE_CLAUDE_LOGGED_OUT=1 FAKE_CLAUDE_AUTH_EXIT=0 timeout 10 "$SHIM" acp --login
  rc11b=$RC
  run cli11c env FAKE_CLAUDE_AUTH_EXIT=0 timeout 10 "$SHIM" login
  if [ $rc11 -eq 0 ] && [ $rc11b -eq 0 ] && grep -q 'fake-claude: auth login' "$W/cli11.err" && grep -q 'fake-claude: auth login' "$W/cli11b.err"; then
    pass KC-CLI-11 "signed out: login and acp --login ran 'claude auth login' (rc 0); signed in, login says: $(short "$W/cli11c.err" 90)"
  else fail KC-CLI-11 "login rc=$rc11 err=$(short "$W/cli11.err") acp --login rc=$rc11b err=$(short "$W/cli11b.err")"; fi
else
  skip KC-CLI-11 "manual (would start a real Claude Code sign-in)"
fi

exit $(( FAILS > 0 ))
