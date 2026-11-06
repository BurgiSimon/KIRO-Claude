#!/usr/bin/env bash
# Teardown + leftover-process check (08-kirocrew-integration §5.3 C18, §5.2 S11 at the gateway
# level): `kiro-claude crew stop`, then no process of this run may be left — no gateway, no
# `kiro-claude acp`, no fake-claude / claude child, no KiroCrew MCP server — and `crew doctor` exits 0.
#
#   teardown.sh [--kill]     (--kill: SIGKILL leftovers of THIS $E2E by pid after reporting them)
#
# A process belongs to this run when its HOME is under $E2E (h, identity.sh's h2) or its command
# line mentions $E2E, whatever its name. Also checks that the shim and the identity stub never
# changed during the run, that the real user's kiro-cli store is untouched, and that kiro-claude
# removed the runtime dirs of its sessions. Prints PASS|FAIL|SKIP lines; exits 1 on any FAIL.
# Needs env.sh sourced.
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
# Every process of this run: HOME under $E2E (h, h2, …), whatever its name (MCP servers are
# python/node children; a name filter would miss them), or one of the run's programs naming $E2E
# in its argv (observers such as a `tail -f $E2E/…` shell are not leftovers). Our own session
# (this script and its pipeline) is excluded.
left=$(python3 -I - "$E2E" <<'PY'
import os, re, sys
e2e = sys.argv[1].rstrip("/") + "/"
me = os.getsid(0)
for d in os.listdir("/proc"):
    if not d.isdigit():
        continue
    pid = int(d)
    try:
        if os.getsid(pid) == me:
            continue
        cmd = open(f"/proc/{d}/cmdline", "rb").read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
        env = open(f"/proc/{d}/environ", "rb").read().split(b"\0")
    except OSError:
        continue
    if not cmd:
        continue
    home = next((x[5:].decode("utf-8", "replace") for x in env if x.startswith(b"HOME=")), "")
    if (home + "/").startswith(e2e):
        print(pid, cmd[:200])  # runs as this run's fake HOME: always ours
    elif e2e.rstrip("/") in cmd and re.search(r"kiro-claude|fake-claude|kirocrew|kiro_crew|claude-agent-acp|browser-harness|chrom|mcp", cmd) \
            and not re.match(r"^\S*/?(bash|sh|grep|tail|cat|less|sleep|timeout)\b", cmd):
        print(pid, cmd[:200])  # names the run dir and looks like one of its programs (observers excluded)
PY
)
if [ -z "$left" ]; then
  echo "PASS C18-procs no process of this run left (any process with HOME under \$E2E or \$E2E in its argv)"
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
# kiro-claude runtime dirs (<TMPDIR>/kiro-claude-<uid>/session-*) of this run's sessions are removed.
# ACP-scenario sessions end by stdin EOF / SIGTERM (kiro-claude must clean up): FAIL if any is left.
# Gateway sessions (TMPDIR = KiroCrew's scratch/runtime-*) may be SIGKILLed by KiroCrew's orphan
# sweep after its teardown grace, which no process can clean up after: reported, not failed.
rt=$(python3 -I - "$E2E" <<'PY'
import glob, json, os, re, sys
e2e = sys.argv[1]
def dirs(logs):
    out = set()
    for log in logs:
        for line in open(log, encoding="utf-8", errors="replace"):
            if '"event":"start"' in line or '"event": "start"' in line:
                out.update(m.group(1) for m in re.finditer(r'(/[^"\s]*/kiro-claude-\d+/session-[0-9a-f-]+)', line))
    return out
acp = dirs(glob.glob(os.path.join(e2e, "ws-*", "fake-claude.jsonl")))
gw = dirs(glob.glob(os.path.join(e2e, "fake-claude.jsonl")))
la = sorted(d for d in acp if os.path.exists(d)); lg = sorted(d for d in gw if os.path.exists(d))
print(json.dumps({"acp": len(acp), "acp_left": la[:3], "n_acp_left": len(la), "gw": len(gw), "gw_left": lg[:3], "n_gw_left": len(lg)}))
PY
)
rtv() { python3 -I -c 'import json,sys;print(json.loads(sys.argv[1])[sys.argv[2]])' "$rt" "$1"; }
if [ "$(rtv acp)" = 0 ]; then echo "SKIP C18-runtime-dirs no ACP-scenario runtime dir recorded (stage C)"
elif [ "$(rtv n_acp_left)" = 0 ]; then echo "PASS C18-runtime-dirs all $(rtv acp) runtime dirs of the ACP-scenario sessions (EOF / SIGTERM / terminate) were removed"
else echo "FAIL C18-runtime-dirs $(rtv n_acp_left) of $(rtv acp) ACP-scenario runtime dirs left: $(rtv acp_left)"; FAILS=$((FAILS + 1)); fi
if [ "$(rtv gw)" != 0 ]; then
  if [ "$(rtv n_gw_left)" = 0 ]; then echo "PASS C18-runtime-dirs-gateway all $(rtv gw) runtime dirs of gateway sessions were removed"
  else echo "SKIP C18-runtime-dirs-gateway $(rtv n_gw_left) of $(rtv gw) gateway-session runtime dirs left under KiroCrew scratch (not attributable: KiroCrew SIGKILLs survivors of its teardown): $(rtv gw_left)"; fi
fi
# KC-BIN-04: the shim KiroCrew pinned at start never changed during the run.
if [ -f "$E2E/shim.sha256" ]; then
  if [ "$(sha256sum "$SHIM" 2>/dev/null | cut -d' ' -f1)" = "$(cat "$E2E/shim.sha256")" ]; then echo "PASS KC-BIN-04-stable shim sha256 unchanged since the contract step"
  else echo "FAIL KC-BIN-04-stable shim changed during the run"; FAILS=$((FAILS + 1)); fi
fi
# Identity stub (09 item 1): nothing rewrote our stub during the run; the real store is untouched.
if [ -f "$E2E/identity.stub.json" ]; then
  want=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1])).get("sha256",""))' "$E2E/identity.stub.json")
  got=$(sha256sum "$HOME/.local/share/kiro-cli/data.sqlite3" 2>/dev/null | cut -d' ' -f1)
  sib=$(ls -A "$HOME/.local/share/kiro-cli" 2>/dev/null | tr '\n' ' ')
  if [ -n "$want" ] && [ "$got" = "$want" ] && [ "$sib" = "data.sqlite3 " ]; then echo "PASS ID-stub-stable the fake HOME's stub is byte-identical after the whole run (no -wal/-shm/-journal)"
  else echo "FAIL ID-stub-stable stub changed or gained siblings: [$sib]"; FAILS=$((FAILS + 1)); fi
fi
if [ -f "$E2E/identity.real-store.json" ]; then
  if python3 -I - "$E2E/identity.real-store.json" <<'PY'
import json, os, sys
r = json.load(open(sys.argv[1]))
real = os.path.join(os.path.expanduser("~" + __import__("pwd").getpwuid(os.getuid()).pw_name), ".local/share/kiro-cli/data.sqlite3")
now = {"exists": os.path.lexists(real)}
if now["exists"]:
    st = os.lstat(real)
    now.update(size=st.st_size, mtime_ns=st.st_mtime_ns, ino=st.st_ino)
sys.exit(0 if all(r.get(k) == now.get(k) for k in now) and r.get("exists") == now["exists"] else 1)
PY
  then echo "PASS ID-real-store-stable the real user's kiro-cli store is unchanged (stat only; $(python3 -I -c 'import json,sys;print("present" if json.load(open(sys.argv[1]))["exists"] else "absent before and after")' "$E2E/identity.real-store.json"))"
  else echo "FAIL ID-real-store-stable the real user's kiro-cli store changed during the run"; FAILS=$((FAILS + 1)); fi
fi
exit $(( FAILS > 0 ))
