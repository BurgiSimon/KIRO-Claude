"""Write a token-less kiro-cli identity store so KiroCrew sees a stable, non-empty
sign-in fingerprint (prevents its per-turn 'identity absent' runtime sweep).
usage: python3 make_identity_store.py <home>"""
import json, os, sqlite3, sys
home = sys.argv[1]
d = os.path.join(home, ".local", "share", "kiro-cli")
os.makedirs(d, mode=0o700, exist_ok=True)
db = sqlite3.connect(os.path.join(d, "data.sqlite3"))
db.execute("CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT)")
db.execute("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)")
blob = {"start_url": "https://claude.ai/kiro-claude", "region": "us-east-1",
        "oauth_flow": "kiro-claude", "client_id": "kiro-claude", "scopes": ["claude-code"]}
db.execute("INSERT OR REPLACE INTO auth_kv(key, value) VALUES (?, ?)", ("kirocli:social:token", json.dumps(blob)))
db.commit(); db.close()
print("wrote", os.path.join(d, "data.sqlite3"))
