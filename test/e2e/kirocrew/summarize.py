"""Print a readable, secret-trimmed transcript of fake-kiro-cli logs (stage A) or of an
acp_scenarios.py wire log (`<out>/wire/<S>.jsonl`, records {"t","dir","msg"}).
usage: python3 -I summarize.py <log.jsonl> [maxlen]
Paths under $HOME, $KCDIR and $E2E are shown as those names."""
import json, os, re, sys
path = sys.argv[1]; maxlen = int(sys.argv[2]) if len(sys.argv) > 2 else 400
SUBST = [(os.environ.get(k, ""), "$" + k) for k in ("HOME", "E2E", "KCDIR")]
SUBST = sorted([(v, n) for v, n in SUBST if v and v != "/"], key=lambda x: -len(x[0]))
def scrub(s):
    for v, n in SUBST:
        s = s.replace(v, n)
    s = re.sub(r'("KIROCREW_STUB_SESSION_TOKEN",\s*"value":\s*")[0-9a-f]+', r'\1<tok>', s)
    s = re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', lambda m: "<uuid:" + m.group(0)[:4] + ">", s)
    return s
for line in open(path):
    r = json.loads(line)
    ts, pid = r.get("ts", r.get("t")), r.get("pid", "")
    if r.get("event") == "invocation":
        print(f"{ts} [{pid}] SPAWN argv={scrub(json.dumps(r['argv'][1:]))} cwd={scrub(r['cwd'])}")
    elif r.get("event") == "exit":
        print(f"{ts} [{pid}] EXIT {r['code']}")
    elif r.get("event") == "chat-stdin":
        print(f"{ts} [{pid}] CHAT-STDIN {r['lines']}")
    elif "dir" in r:
        m = r["msg"]; s = m if isinstance(m, str) else json.dumps(m, separators=(",", ":"))
        arrow = {"in": "->", "out": "<-"}.get(r["dir"], r["dir"].upper())
        s = scrub(s)
        print(f"{ts} [{pid}] {arrow} {s[:maxlen]}{'...' if len(s) > maxlen else ''}")
