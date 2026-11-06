"""Send one prompt to a running KiroCrew gateway and print the assistant reply.

usage: python3 -I kc_chat.py --port 5476 --token <tok> [--slot KEY] [--new] "message"
  token: from the gateway's KIROCREW_READY line, or `kirocrew token --port N`
         (the ?token= value of the printed URL).
Prints the slot key on stderr (reuse it with --slot for the next turn).
stdlib only."""
import argparse, http.cookiejar, json, sys, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=5476)
ap.add_argument("--token", required=True)
ap.add_argument("--slot")
ap.add_argument("--agent", default=None)
ap.add_argument("--timeout", type=float, default=600)
ap.add_argument("message")
a = ap.parse_args()
base = f"http://127.0.0.1:{a.port}"
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
op.open(f"{base}/api/status?token={a.token}", timeout=15).read()  # mints mc_token_<port> cookie

def post(path, body, timeout=30):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    return op.open(req, timeout=timeout)

slot, agent = a.slot, a.agent
if not slot:
    created = json.loads(post("/api/chat/slots", {}).read())
    slot, agent = created["key"], agent or created.get("agent")
print(f"slot={slot}", file=sys.stderr)
body = {"message": a.message, "slot": slot}
if agent:
    body["agent"] = agent
reply = None
with post("/api/chat", body, timeout=a.timeout) as resp:  # SSE: data: {...}\n\n ... data: [DONE]
    for raw in resp:
        line = raw.decode("utf-8", "replace").rstrip("\n")
        if not line.startswith("data: "):
            continue
        data = line[6:]
        if data == "[DONE]":
            break
        try:
            ev = json.loads(data)
        except ValueError:
            continue
        if ev.get("type") == "assistant":
            reply = ev.get("content")
        elif ev.get("type") in ("error", "permission", "approval"):
            print(f"[{ev.get('type')}] {ev.get('content')}", file=sys.stderr)
print(reply if reply is not None else "")
