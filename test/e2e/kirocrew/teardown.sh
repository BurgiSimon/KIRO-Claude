#!/usr/bin/env bash
# Teardown + leftover-process check (08-kirocrew-integration §5.3 C18, §5.2 S11 at the gateway
# level): `kiro-claude crew stop`, then no process of this run may be left — no gateway, no
# `kiro-claude acp`, no fake-claude / claude child, no KiroCrew MCP server — and `crew doctor` exits 0.
#
#   teardown.sh [--kill]     (--kill: SIGKILL leftovers of THIS $E2E by pid after reporting them)
#
# A process belongs to this run when its environ has HOME=$HOME (the run's fake HOME) or its
# command line mentions $E2E. Prints PASS|FAIL lines; exits 1 on any FAIL. Needs env.sh sourced.
set -u
: "${E2E:?source env.sh first}" "${KC_ENTRY:?source env.sh first}"
KILL=0
[ "${1:-}" = --kill ] && KILL=1
kc_crew() { "$KC_NODE" "$KC_ENTRY" crew "$@"; }
FAILS=0
out=$(kc_crew stop 2>&1); rc=$?
st=$(kc_crew status --json 2>/dev/null); src=$?
if [ $rc -eq 0 ] && [ $src -eq 3 ] && case "$st" in *'"holder":"nobody"'*) true ;; *) false ;; esac; then
  echo "PASS C18-stop crew stop rc=0 ($(echo "$out" | tail -1)); status exit 3, holder nobody"
else
  echo "FAIL C18-stop crew stop rc=$rc out=$(echo "$out" | tail -2 | tr '\n' ' ') status rc=$src $st"; FAILS=$((FAILS + 1))
fi
sleep 2
self=$$
leftovers() {
  local p
  for p in /proc/[0-9]*; do
    p=${p#/proc/}
    [ "$p" = "$self" ] && continue
    [ "$p" = "$BASHPID" ] && continue
    local cmd; cmd=$( { tr '\0' ' ' <"/proc/$p/cmdline"; } 2>/dev/null ) || continue
    [ -z "$cmd" ] && continue
    case "$cmd" in *teardown.sh*|*kirocrew.test*|*"node --test"*) continue ;; esac
    if { tr '\0' '\n' <"/proc/$p/environ"; } 2>/dev/null | grep -qxF "HOME=$HOME" || case "$cmd" in *"$E2E"*) true ;; *) false ;; esac; then
      case "$cmd" in
        *kiro-claude*|*fake-claude*|*kirocrew*|*claude-agent-acp*|*claude\ *|*/claude|*browser-harness*|*chrom*|*mcp-*) echo "$p $cmd" ;;
      esac
    fi
  done
}
left=$(leftovers)
if [ -z "$left" ]; then
  echo "PASS C18-procs no gateway / kiro-claude / Claude / MCP process of this run left"
else
  echo "FAIL C18-procs leftovers: $(echo "$left" | cut -c1-200 | tr '\n' ';')"; FAILS=$((FAILS + 1))
  if [ $KILL = 1 ]; then echo "$left" | awk '{print $1}' | xargs -r kill -9 2>/dev/null; fi
fi
# The spec's literal check: ps … | grep -E 'kiro-claude|claude ' | grep $E2E
lit=$(ps -eo pid,args | grep -E 'kiro-claude|claude ' | grep -F "$E2E" | grep -v -e grep -e teardown.sh)
if [ -z "$lit" ]; then echo "PASS C18-ps ps | grep -E 'kiro-claude|claude ' | grep \$E2E is empty"
else echo "FAIL C18-ps $(echo "$lit" | cut -c1-200 | tr '\n' ';')"; FAILS=$((FAILS + 1)); fi
doc=$(kc_crew doctor 2>&1); drc=$?
if [ $drc -eq 0 ]; then echo "PASS C18-doctor crew doctor exit 0 ($(echo "$doc" | grep -c '✅') ✅ rows)"
else echo "FAIL C18-doctor crew doctor exit $drc: $(echo "$doc" | grep -E '❌|⚠' | head -5 | tr '\n' ';')"; FAILS=$((FAILS + 1)); fi
exit $(( FAILS > 0 ))
