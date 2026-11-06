#!/usr/bin/env bash
# Identity-stub rule (08-kirocrew-integration §3.5; user decision 09 item 1, binding):
# `crew setup` writes the token-less kiro-cli identity stub ONLY when no store file exists, and
# never modifies an existing store (a present file, even one without an identity row, counts as a
# real store). `crew unstub` removes the store only when it is provably our stub.
#
#   identity.sh            (after setup.sh; needs env.sh sourced)
#
# ID-stub        the run's fake HOME had no store: setup wrote exactly the §3.5 stub (modes, rows,
#                sentinel, no token fields, no auth.idc.* rows), crew.json records it; its sha256
#                is saved so teardown can prove the run never changed it.
# ID-existing    a second fake HOME ($E2E/h2) with a pre-existing non-stub store: `crew setup`
#                (and `crew doctor --fix`, `crew unstub`) leave it byte-identical (sha256, size,
#                mtime, inode; no -wal/-shm/-journal created); crew.json says created:false.
# ID-fix-unstub  same HOME after that store is gone: `crew doctor --fix` writes the stub, and
#                `crew unstub` removes it (ours).
# ID-empty       a 0-byte store file is a real store too: doctor --fix and unstub keep it.
# ID-real-store  the real user's store (getent passwd HOME) is only stat()ed, never opened: its
#                stat is saved for teardown (or its absence noted).
# Prints PASS|FAIL lines; exits 1 on any FAIL.
set -u
: "${E2E:?source env.sh first}" "${KC_ENTRY:?source env.sh first}" "${KCDIR:?}" "${KCPY:?}"
FAILS=0
pass() { echo "PASS $1 $2"; }
fail() { echo "FAIL $1 $2"; FAILS=$((FAILS + 1)); }
PY=python3
STORE_REL=.local/share/kiro-cli/data.sqlite3

# Read-only facts about a store: never opens a real store; for test-owned stores (our HOMEs) it
# reads the rows with an immutable sqlite open (creates nothing next to the file).
facts() {
  "$PY" -I - "$1" "${2:-rows}" <<'PY'
import hashlib, json, os, pathlib, sqlite3, stat, sys
p, mode = sys.argv[1], sys.argv[2]
r = {"exists": os.path.lexists(p)}
if r["exists"]:
    st = os.lstat(p)
    r.update(size=st.st_size, mtime_ns=st.st_mtime_ns, ino=st.st_ino, mode=oct(stat.S_IMODE(st.st_mode)),
             dirmode=oct(stat.S_IMODE(os.stat(os.path.dirname(p)).st_mode)),
             siblings=sorted(os.listdir(os.path.dirname(p))))
    if mode == "rows":
        r["sha256"] = hashlib.sha256(open(p, "rb").read()).hexdigest()
        try:
            db = sqlite3.connect(pathlib.Path(p).as_uri() + "?mode=ro&immutable=1", uri=True)
            r["tables"] = sorted(t for (t,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'"))
            r["auth_kv"] = db.execute("SELECT key, value FROM auth_kv").fetchall() if "auth_kv" in r["tables"] else []
            r["state"] = db.execute("SELECT key, value FROM state").fetchall() if "state" in r["tables"] else []
            db.close()
        except Exception as e:  # noqa: BLE001
            r["sqlite_error"] = str(e)
print(json.dumps(r))
PY
}
jget() { "$PY" -I -c 'import json,sys;d=json.loads(sys.argv[1])
for k in sys.argv[2].split("."):
    d=d.get(k) if isinstance(d,dict) else None
print(json.dumps(d))' "$1" "$2"; }
crew_in() { local h=$1; shift; HOME="$h" "$KC_NODE" "$KC_ENTRY" crew "$@" </dev/null; }

# ── ID-real-store: the real user's store, stat only ─────────────────────────
REAL_HOME=$(getent passwd "$(id -u)" | cut -d: -f6)
if [ -n "$REAL_HOME" ] && [ "$REAL_HOME" != "$HOME" ]; then
  real=$(facts "$REAL_HOME/$STORE_REL" stat)
  printf '%s\n' "$real" >"$E2E/identity.real-store.json"
  pass ID-real-store "real store $REAL_HOME/$STORE_REL $( [ "$(jget "$real" exists)" = true ] && echo "exists (stat recorded for teardown; never opened)" || echo "absent (teardown checks it stays absent)")"
fi

# ── ID-stub: the run's own fake HOME ─────────────────────────────────────────
S=$(facts "$HOME/$STORE_REL")
printf '%s\n' "$S" >"$E2E/identity.stub.json"
if "$PY" -I - "$S" "$CS/crew.json" "$HOME/$STORE_REL" <<'PY'
import json, sys
s = json.loads(sys.argv[1]); crew = json.load(open(sys.argv[2])); path = sys.argv[3]
bad = []
want_auth = json.dumps({"start_url": "https://claude.ai/kiro-claude", "region": "us-east-1", "oauth_flow": "kiro-claude",
                        "client_id": "kiro-claude", "scopes": ["claude-code"]}, separators=(",", ":"))
if not s.get("exists"): bad.append("no store")
if s.get("mode") != "0o600": bad.append(f"file mode {s.get('mode')}")
if s.get("dirmode") != "0o700": bad.append(f"dir mode {s.get('dirmode')}")
if s.get("tables") != ["auth_kv", "state"]: bad.append(f"tables {s.get('tables')}")
auth = s.get("auth_kv") or []
if len(auth) != 1 or auth[0][0] != "kirocli:social:token" or json.loads(auth[0][1]) != json.loads(want_auth): bad.append(f"auth_kv {auth}")
if auth and any(k in json.loads(auth[0][1]) for k in ("access_token", "refresh_token", "accessToken", "refreshToken", "token", "expires_at")):
    bad.append("token fields in the stub")
st = s.get("state") or []
if len(st) != 1 or st[0][0] != "kiro-claude.identity-stub": bad.append(f"state {st}")
else:
    v = json.loads(st[0][1])
    if v.get("createdBy") != "kiro-claude crew setup" or v.get("version") != 1 or not isinstance(v.get("createdAt"), str): bad.append(f"sentinel {v}")
if any(k.startswith("auth.idc.") for k, _ in st): bad.append("auth.idc.* row")
ids = crew.get("identityStub") or {}
if ids.get("created") is not True or ids.get("path") != path: bad.append(f"crew.json identityStub {ids}")
print("; ".join(bad))
sys.exit(1 if bad else 0)
PY
then pass ID-stub "fake HOME had no store: setup wrote exactly the §3.5 stub at $HOME/$STORE_REL (0600 in a 0700 dir; auth_kv = the one claims row, no token fields; state = the sentinel only; no auth.idc.*); crew.json identityStub.created=true"
else fail ID-stub "$(jget "$S" exists) $S"; fi

# ── ID-existing: a pre-existing (non-stub) store is never modified ──────────
H2=$E2E/h2
mkdir -p "$H2"
"$PY" -I - "$H2/$STORE_REL" <<'PY'
import json, os, sqlite3, sys
p = sys.argv[1]
os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True)
db = sqlite3.connect(p)
db.execute("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)")
db.execute("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)")
# a stand-in for a real kiro-cli sign-in: NOT our claims, no secret material
db.execute("INSERT INTO auth_kv VALUES (?, ?)", ("kirocli:odic:token", json.dumps({"region": "eu-west-1", "start_url": "https://example.invalid/start", "note": "e2e fixture, not a credential"})))
db.execute("INSERT INTO state VALUES (?, ?)", ("auth.e2e.profile", json.dumps({"fixture": True})))
db.commit(); db.close()
os.chmod(p, 0o600)
PY
touch -d '2001-02-03 04:05:06' "$H2/$STORE_REL"
B0=$(facts "$H2/$STORE_REL")
args=(--dir "$KCDIR" --no-fetch --no-build --members none --yes --claude-bin "$FAKE_CLAUDE")
case "$KCDIR" in /tmp/*|"${TMPDIR:-/tmp}"/*) args+=(--allow-tmp) ;; esac
crew_in "$H2" setup "${args[@]}" >"$E2E/logs/identity-h2-setup.log" 2>&1; rc_setup=$?
B1=$(facts "$H2/$STORE_REL")
crew_in "$H2" doctor --fix --no-gateway >"$E2E/logs/identity-h2-doctor.log" 2>&1
crew_in "$H2" unstub >"$E2E/logs/identity-h2-unstub.log" 2>&1; rc_unstub=$?
B2=$(facts "$H2/$STORE_REL")
created=$("$PY" -I -c 'import json,sys;print(json.dumps((json.load(open(sys.argv[1])).get("identityStub") or {}).get("created")))' "$H2/.local/share/kiro-claude/crew/crew.json" 2>/dev/null)
same() { "$PY" -I -c 'import json,sys;a,b=json.loads(sys.argv[1]),json.loads(sys.argv[2])
k=("exists","sha256","size","mtime_ns","ino","mode","siblings")
d={x:(a.get(x),b.get(x)) for x in k if a.get(x)!=b.get(x)}
print(json.dumps(d)); sys.exit(1 if d else 0)' "$1" "$2"; }
d1=$(same "$B0" "$B1"); s1=$?; d2=$(same "$B0" "$B2"); s2=$?
if [ $rc_setup -eq 0 ] && [ $s1 -eq 0 ] && [ $s2 -eq 0 ] && [ "$created" = false ]; then
  pass ID-existing "pre-existing non-stub store: crew setup (rc 0), doctor --fix and unstub (rc $rc_unstub) left it byte-identical (sha256, size, mtime, inode, mode; no -wal/-shm/-journal); crew.json identityStub.created=false"
else fail ID-existing "setup rc=$rc_setup created=$created after setup: $d1 after doctor/unstub: $d2 (logs $E2E/logs/identity-h2-*.log)"; fi

# ── ID-fix-unstub: doctor --fix writes the stub only into an empty slot; unstub removes ours ──
rm -f "$H2/$STORE_REL"
crew_in "$H2" doctor --fix --no-gateway >"$E2E/logs/identity-h2-fix.log" 2>&1
F1=$(facts "$H2/$STORE_REL")
crew_in "$H2" unstub >"$E2E/logs/identity-h2-unstub2.log" 2>&1; rc_u2=$?
F2=$(facts "$H2/$STORE_REL")
if [ "$(jget "$F1" exists)" = true ] && jget "$F1" state | grep -q 'kiro-claude.identity-stub' && [ $rc_u2 -eq 0 ] && [ "$(jget "$F2" exists)" = false ]; then
  pass ID-fix-unstub "no store: doctor --fix wrote our stub (sentinel present); crew unstub removed it (rc 0)"
else fail ID-fix-unstub "after fix: $(echo "$F1" | cut -c1-200); unstub rc=$rc_u2 after: $(echo "$F2" | cut -c1-120)"; fi

# ── ID-empty: an empty file is a real store (09: present without an identity row) ──
mkdir -p "$(dirname "$H2/$STORE_REL")"; : >"$H2/$STORE_REL"; touch -d '2001-02-03 04:05:06' "$H2/$STORE_REL"
E0=$(facts "$H2/$STORE_REL" stat)
crew_in "$H2" doctor --fix --no-gateway >"$E2E/logs/identity-h2-fix2.log" 2>&1
crew_in "$H2" unstub >"$E2E/logs/identity-h2-unstub3.log" 2>&1
E1=$(facts "$H2/$STORE_REL" stat)
de=$(same "$E0" "$E1"); se=$?
if [ $se -eq 0 ] && [ "$(jget "$E1" size)" = 0 ]; then pass ID-empty "0-byte store file kept as is by doctor --fix and unstub (treated as a real store)"
else fail ID-empty "changed: $de"; fi
exit $(( FAILS > 0 ))
