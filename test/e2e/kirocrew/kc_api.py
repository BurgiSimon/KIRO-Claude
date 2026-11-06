"""Tiny authenticated client for a KiroCrew gateway.
usage: python3 -I kc_api.py <port> <token> GET|POST|DELETE <path> [json-body]"""
import http.cookiejar, json, sys, urllib.request, urllib.error
port, token, method, path = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
body = sys.argv[5] if len(sys.argv) > 5 else None
base = f"http://127.0.0.1:{port}"
op = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
op.open(f"{base}/api/status?token={token}", timeout=15).read()
req = urllib.request.Request(base + path, method=method, data=body.encode() if body else None,
                             headers={"Content-Type": "application/json"})
try:
    with op.open(req, timeout=120) as r:
        print(r.status, r.read().decode()[:4000])
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode()[:2000])
