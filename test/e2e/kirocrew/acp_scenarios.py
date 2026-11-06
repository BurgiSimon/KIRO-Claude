#!/usr/bin/env python3
"""ACP scenarios S1-S13 of 08-kirocrew-integration §5.2 against `kiro-claude acp` (stdlib only).

Each scenario is a plain ACP client that speaks to `<bin> acp --agent-engine v2 --agent <name>`
exactly like KiroCrew does (initialize params of 08b §4.4, spawn env of 08b §4.3), in its own
workspace `$E2E/ws-<n>` with the agent spec written to `<ws>/.kiro/agents/<name>.json`.

  acp_scenarios.py --bin <shim> [--stage B|C | --real] [--out DIR] [S1 S4r ...]

Stage B (default): KIRO_CLAUDE_BIN is the shim's baked fake-claude; FAKE_CLAUDE_SCRIPT is
fake-script.json next to this file, and each scenario's FAKE_CLAUDE_LOG is `<ws>/fake-claude.jsonl`.
Stage C (`--real`): the real `claude` (KIRO_CLAUDE_FORCE_MODEL=haiku unless set); prompts carry
a nonce and text is matched loosely; checks that need fake-claude's log are skipped.

Prints `PASS|FAIL|SKIP <id> <evidence>`; exits 1 if any FAILs. Every agent→client frame is
recorded per scenario to `<out>/frames/<S>.jsonl` (first line: a KiroCrew replay-corpus provenance
header), so the frame-shape parity check (08 §5.2 item 4) can replay them; every line in both
directions goes to `<out>/wire/<S>.jsonl`. A non-JSON stdout line from the agent is a failure
(KC-FS-06).
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
INIT_PARAMS = {
    "clientInfo": {"name": "kirocrew", "version": "0.13.0"},
    "protocolVersion": "2025-08-22",
    "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False,
                           "elicitation": {"form": {}, "url": {}}},
}
PROVENANCE = {"_meta": {"backend": "", "recorded": "live", "agent_name": "kiro-claude", "agent_version": "1.26.0"}}
UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
KIRO_OPTIONS = {"allow_once", "allow_always", "reject_once"}

RESULTS: list[tuple[str, str, str]] = []


def report(sid: str, status: str, evidence: str) -> None:
    evidence = " ".join(str(evidence).split())
    RESULTS.append((sid, status, evidence))
    print(f"{status} {sid} {evidence[:900]}", flush=True)


class Check:
    """Collects the failed assertions of one scenario row."""

    def __init__(self, sid: str):
        self.sid, self.bad, self.good = sid, [], []

    def ok(self, cond, what: str, detail: str = "") -> bool:
        if cond:
            self.good.append(what)
        else:
            self.bad.append(f"{what}{(': ' + detail) if detail else ''}")
        return bool(cond)

    def done(self, extra: str = "") -> None:
        if self.bad:
            report(self.sid, "FAIL", "; ".join(self.bad) + (f" | ok: {', '.join(self.good)}" if self.good else ""))
        else:
            report(self.sid, "PASS", ", ".join(self.good) + (f"; {extra}" if extra else ""))


class Agent:
    """One `kiro-claude acp` process."""

    def __init__(self, ctx: "Ctx", name: str, ws: str, agent: str, extra_env: dict | None = None, label: str | None = None):
        self.ctx, self.ws, self.agent = ctx, ws, agent
        self.label = label or name
        self.frames: list[tuple[float, dict]] = []  # agent→client, parsed
        self.bad_lines: list[str] = []
        self.cv = threading.Condition()
        self.next_id = 1
        self.eof = False
        self.permission_policy = "allow_once"  # or "reject_once" | "hold" | "cancelled"
        self.pending_permissions: list[dict] = []
        os.makedirs(os.path.join(ctx.out, "frames"), exist_ok=True)
        os.makedirs(os.path.join(ctx.out, "wire"), exist_ok=True)
        self.frames_path = os.path.join(ctx.out, "frames", f"{self.label}.jsonl")
        self.wire = open(os.path.join(ctx.out, "wire", f"{self.label}.jsonl"), "a", encoding="utf-8")
        with open(self.frames_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(PROVENANCE) + "\n")
        env = ctx.agent_env(ws)
        if extra_env:
            env.update(extra_env)
        self.env = env
        self.argv = [ctx.bin, "acp", "--agent-engine", "v2", "--agent", agent]
        self.t0 = time.time()
        self.stderr = open(os.path.join(ws, f"acp-{self.label}.stderr"), "ab")
        self.p = subprocess.Popen(self.argv, cwd=ws, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=self.stderr, start_new_session=True)
        ctx.procs.append(self.p)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    # ── wire ──
    def _log(self, direction: str, obj) -> None:
        try:
            self.wire.write(json.dumps({"t": round(time.time() - self.t0, 3), "dir": direction, "msg": obj}) + "\n")
            self.wire.flush()
        except ValueError:
            pass

    def _read(self) -> None:
        assert self.p.stdout is not None
        for raw in self.p.stdout:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
                if not isinstance(msg, dict):
                    raise ValueError("not an object")
            except ValueError:
                self.bad_lines.append(line[:200])
                self._log("bad", line[:2000])
                continue
            self._log("in", msg)
            with open(self.frames_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(msg) + "\n")
            with self.cv:
                self.frames.append((time.time(), msg))
                self.cv.notify_all()
            if "method" in msg and "id" in msg:
                threading.Thread(target=self._on_request, args=(msg,), daemon=True).start()
        with self.cv:
            self.eof = True
            self.cv.notify_all()

    def send(self, obj: dict) -> None:
        self._log("out", obj)
        assert self.p.stdin is not None
        self.p.stdin.write((json.dumps(obj) + "\n").encode())
        self.p.stdin.flush()

    def _on_request(self, msg: dict) -> None:
        if msg["method"] == "session/request_permission":
            pol = self.permission_policy
            if pol == "hold":
                with self.cv:
                    self.pending_permissions.append(msg)
                    self.cv.notify_all()
                return
            self.answer_permission(msg, pol)
            return
        self.send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": f"Method not found: {msg['method']}"}})

    def answer_permission(self, msg: dict, option: str) -> None:
        if option == "cancelled":
            outcome = {"outcome": "cancelled"}
        else:
            outcome = {"outcome": "selected", "optionId": option}
        self.send({"jsonrpc": "2.0", "id": msg["id"], "result": {"outcome": outcome}})

    def request_async(self, method: str, params: dict) -> int:
        rid = self.next_id
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        return rid

    def wait_response(self, rid: int, timeout: float = 30.0):
        """(result, error, index) of the response to request `rid`; raises on timeout/EOF."""
        hit = self.wait_for(lambda m: m.get("id") == rid and "method" not in m and ("result" in m or "error" in m), timeout)
        if hit is None:
            raise TimeoutError(f"no response to id {rid} within {timeout}s (eof={self.eof})")
        idx, m = hit
        return m.get("result"), m.get("error"), idx

    def request(self, method: str, params: dict, timeout: float = 30.0):
        return self.wait_response(self.request_async(method, params), timeout)

    def notify(self, method: str, params: dict) -> None:
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def wait_for(self, pred, timeout: float = 30.0, start: int = 0):
        deadline = time.time() + timeout
        with self.cv:
            i = start
            while True:
                while i < len(self.frames):
                    if pred(self.frames[i][1]):
                        return i, self.frames[i][1]
                    i += 1
                left = deadline - time.time()
                if left <= 0 or self.eof:
                    return None
                self.cv.wait(min(left, 0.5))

    def wait_permission(self, timeout: float = 30.0):
        deadline = time.time() + timeout
        with self.cv:
            while not self.pending_permissions:
                left = deadline - time.time()
                if left <= 0 or self.eof:
                    return None
                self.cv.wait(min(left, 0.5))
            return self.pending_permissions.pop(0)

    def msgs(self, start: int = 0, end: int | None = None) -> list[dict]:
        with self.cv:
            return [m for _, m in self.frames[start:end]]

    def updates(self, start: int = 0, end: int | None = None, kind: str | None = None, method: str = "session/update") -> list[dict]:
        out = []
        for m in self.msgs(start, end):
            if m.get("method") != method:
                continue
            u = (m.get("params") or {}).get("update") or {}
            if kind is None or u.get("sessionUpdate") == kind:
                out.append(u)
        return out

    def text(self, start: int = 0, end: int | None = None, kind: str = "agent_message_chunk") -> str:
        return "".join(((u.get("content") or {}).get("text") or "") for u in self.updates(start, end, kind))

    def close(self, timeout: float = 10.0) -> int | None:
        try:
            if self.p.stdin and not self.p.stdin.closed:
                self.p.stdin.close()
        except OSError:
            pass
        try:
            return self.p.wait(timeout)
        except subprocess.TimeoutExpired:
            self.kill()
            return None
        finally:
            self.reader.join(2)
            self.wire.close()

    def kill(self) -> None:
        try:
            os.killpg(self.p.pid, signal.SIGKILL)
        except OSError:
            pass

    # ── ACP helpers ──
    def initialize(self):
        return self.request("initialize", INIT_PARAMS, timeout=15)

    def new_session(self, mcp_servers: list | None = None, cwd: str | None = None):
        return self.request("session/new", {"cwd": cwd or self.ws, "mcpServers": mcp_servers or []}, timeout=60)

    def prompt(self, sid: str, text: str, timeout: float = 120.0):
        rid = self.request_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": text}]})
        start = len(self.frames)
        res, err, idx = self.wait_response(rid, timeout)
        return res, err, idx, start


class Ctx:
    def __init__(self, a):
        self.bin = a.bin
        self.real = a.real
        self.e2e = os.environ.get("E2E") or os.path.dirname(os.path.abspath(a.out))
        self.out = os.path.abspath(a.out)
        self.home = os.environ["HOME"]
        self.script = a.script
        self.procs: list[subprocess.Popen] = []
        self.nonce = os.urandom(4).hex()
        self.kiro_home = os.path.join(self.home, ".kiro")

    def agent_env(self, ws: str) -> dict:
        env = dict(os.environ)
        env.update({
            "KIRO_CLI_CLIENT_APPLICATION": "kirocrew",
            "KIRO_CHAT_LOG_FILE": os.path.join(ws, "kiro-chat.log"),
            "KIROCREW_SPAWNED": "1",
            "KIROCREW_RUNTIME_AGENT": "kirocrew",
            "NO_COLOR": "1",
        })
        if self.real:
            for k in [k for k in env if k.startswith("FAKE_CLAUDE_")]:
                env.pop(k)
            env.setdefault("KIRO_CLAUDE_FORCE_MODEL", "haiku")
        else:
            env["FAKE_CLAUDE_SCRIPT"] = self.script
            env["FAKE_CLAUDE_LOG"] = os.path.join(ws, "fake-claude.jsonl")
        return env

    def workspace(self, n: str, spec_name: str, spec: dict, files: dict | None = None) -> str:
        ws = os.path.join(self.e2e, f"ws-{n.lower()}")
        os.makedirs(os.path.join(ws, ".kiro", "agents"), exist_ok=True)
        with open(os.path.join(ws, ".kiro", "agents", f"{spec_name}.json"), "w") as f:
            json.dump(spec, f, indent=2)
        for rel, content in (files or {}).items():
            p = os.path.join(ws, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w") as f:
                f.write(content)
        return ws

    def sessions_dir(self) -> str:
        return os.path.join(self.kiro_home, "sessions", "cli")


def fake_log(ws: str) -> list[dict]:
    p = os.path.join(ws, "fake-claude.jsonl")
    out = []
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def stream_starts(log: list[dict]) -> list[dict]:
    return [r for r in log if r.get("event") == "start" and "-p" in (r.get("argv") or [])]


def argv_value(argv: list[str], flag: str) -> list[str]:
    return [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == flag]


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split(") ", 1)[1].split()[0] != "Z"
    except OSError:
        return True


def spec(name: str, **kw) -> dict:
    s = {"name": name, "description": f"kiro-claude e2e agent {name}", "prompt": "You are a test agent.",
         "tools": ["execute_bash", "fs_read", "fs_write", "grep", "glob"], "allowedTools": ["fs_read", "grep", "glob"],
         "resources": ["file://AGENTS.md", "file://.kiro/steering/**/*.md"], "includeMcpJson": False, "mcpServers": {}}
    s.update(kw)
    return s


def opener(ctx: Ctx, n: str, spec_name: str, sp: dict, files: dict | None = None, extra_env: dict | None = None, mcp: list | None = None):
    """Workspace + process + initialize + session/new (asserted only for transport errors)."""
    ws = ctx.workspace(n, spec_name, sp, files)
    ag = Agent(ctx, n, ws, spec_name, extra_env)
    ag.initialize()
    res, err, idx = ag.new_session(mcp)
    if err or not res:
        raise RuntimeError(f"session/new failed: {err}")
    return ws, ag, res["sessionId"], idx


def words(ctx: Ctx, w: str) -> str:
    """Prompt text for a fixed fake-script word (stage B) or a nonce instruction (stage C)."""
    if not ctx.real:
        return w
    n = ctx.nonce
    return {
        "PING": f"Reply with exactly: PONG-{n}",
        "RUN-ECHO": f"Use your shell tool (execute_bash / Bash) to run exactly: echo kc-e2e-{n} . Then reply DONE.",
        "ECHO-STEER": f"Use your shell tool to run exactly: echo kc-e2e-{n} . Then reply STEER-DONE.",
        "SLOW": "Count from 1 to 400, one number per line, with no other text.",
        "READ-DENIED": "Use your file read tool to read the file secret/token.txt and print its contents.",
    }.get(w, w)


def expect_text(ctx: Ctx, got: str, w: str) -> bool:
    if not ctx.real:
        return w in got
    return (f"{w}-{ctx.nonce}".lower() in got.lower()) if w in ("PONG",) else (w.lower() in got.lower())


# ─────────────────────────── scenarios ───────────────────────────

def s1(ctx: Ctx) -> None:
    c = Check("S1")
    ws = ctx.workspace("S1", "kc-probe", spec("kc-probe"))
    ag = Agent(ctx, "S1", ws, "kc-probe")
    try:
        t0 = time.time()
        res, err, _ = ag.initialize()
        dt = time.time() - t0
        c.ok(err is None and isinstance(res, dict), "initialize ok", str(err))
        res = res or {}
        caps = res.get("agentCapabilities") or {}
        c.ok(res.get("protocolVersion") == 1, "protocolVersion 1", repr(res.get("protocolVersion")))
        c.ok(caps.get("loadSession") is True, "loadSession")
        c.ok(caps.get("promptCapabilities") == {"image": True, "audio": False, "embeddedContext": True}, "promptCapabilities", json.dumps(caps.get("promptCapabilities")))
        c.ok(caps.get("mcpCapabilities") == {"http": True, "sse": True}, "mcpCapabilities", json.dumps(caps.get("mcpCapabilities")))
        c.ok(res.get("authMethods") == [], "authMethods []")
        info = res.get("agentInfo") or {}
        c.ok(info.get("name") == "kiro-claude" and info.get("version") == "1.26.0", "agentInfo kiro-claude/1.26.0", json.dumps(info))
        c.ok(not (((res.get("_meta") or {}).get("kiro") or {}).get("extensionMethods")), "no _meta.kiro.extensionMethods")
        c.ok(dt < 1.0, f"initialize {dt*1000:.0f}ms < 1s")
        res, err, _ = ag.new_session()
        c.ok(err is None and isinstance(res, dict), "session/new ok", str(err))
        res = res or {}
        sid = res.get("sessionId", "")
        c.ok(bool(UUID4.match(sid)), "sessionId uuid v4", sid)
        modes = res.get("modes") or {}
        c.ok(modes.get("currentModeId") == "kc-probe", "currentModeId==kc-probe", json.dumps(modes)[:200])
        c.ok("kc-probe" in [m.get("id") for m in modes.get("availableModes") or []], "availableModes has kc-probe")
        models = res.get("models") or {}
        am = models.get("availableModels") or []
        c.ok(bool(models.get("currentModelId")) and am and all({"modelId", "name"} <= set(m) for m in am), "models shape",
             json.dumps(models)[:200])
        c.ok("claude-haiku-5.5" in [m.get("modelId") for m in am], "claude-haiku-5.5 advertised")
        # Guard A2: a missing spec is a JSON-RPC error naming the file, never a silent fallback.
        ws2 = ctx.workspace("S1-missing", "kc-other", spec("kc-other"))
        ag2 = Agent(ctx, "S1-missing", ws2, "kc-no-such-agent", label="S1-missing")
        try:
            ag2.initialize()
            r2, e2, _ = ag2.new_session()
            c.ok(e2 is not None and "kc-no-such-agent" in json.dumps(e2), "missing --agent spec ⇒ error naming it", json.dumps(r2 or e2)[:200])
        finally:
            ag2.close()
        c.ok(not ag.bad_lines, "stdout only JSON-RPC (KC-FS-06)", repr(ag.bad_lines[:2]))
    finally:
        ag.close()
    c.done()


def s2(ctx: Ctx) -> None:
    c = Check("S2")
    sp = spec("kc-mcp", mcpServers={
        "kc-alpha": {"command": "/bin/true", "args": [], "fakeTools": ["ping"]},
        "kc-beta": {"command": "/bin/true", "args": ["--x"], "env": {"KC_SPEC_ONLY": "${HOME}"}},
        "kirocrew-core": {"command": "/bin/false", "args": ["spec-version"]},
    }, tools=["execute_bash", "fs_read", "@kc-alpha", "@kc-beta", "@kirocrew-core", "@kirocrew-computer"])
    stub = [{"name": "kirocrew-core", "command": "/bin/true", "args": ["mcp-core"], "type": "stdio",
             "env": [{"name": "KIROCREW_STUB_SESSION_TOKEN", "value": "tok-e2e-stub"}, {"name": "KIROCREW_HOME", "value": "/x"}]}]
    files = {".kiro/steering/kc-marker.md": "KC-STEERING-MARKER-7f3a\n", ".kiro/settings/cli.json": json.dumps({"chat.modelDefaults.auto.output_config.effort": "high"})}
    ws, ag, sid, idx_new = opener(ctx, "S2", "kc-mcp", sp, files, extra_env={"ASBX_KIRO_MANDATORY_MCPS": "kc-alpha,kirocrew-core"}, mcp=stub)
    try:
        res, err, idx = ag.request("session/set_mode", {"sessionId": sid, "modeId": "kc-mcp"})
        c.ok(err is None and res == {}, "set_mode same id ⇒ {}", json.dumps(res or err))
        cmu = ag.wait_for(lambda m: m.get("method") == "session/update" and (m["params"].get("update") or {}).get("sessionUpdate") == "current_mode_update", 5, idx_new)
        c.ok(cmu is not None and cmu[1]["params"]["update"].get("currentModeId") == "kc-mcp", "current_mode_update")
        want = {"kc-alpha", "kc-beta", "kirocrew-core"}
        t0 = time.time()
        seen: dict[str, int] = {}
        while time.time() - t0 < 10 and set(seen) < want:
            for m in ag.msgs(idx_new):
                if m.get("method") in ("_kiro.dev/mcp/server_initialized", "_kiro.dev/mcp/server_init_failure"):
                    seen.setdefault(m["params"].get("serverName"), 0)
            time.sleep(0.1)
        counts = {}
        for m in ag.msgs(idx_new):
            if m.get("method") == "_kiro.dev/mcp/server_initialized":
                counts[m["params"].get("serverName")] = counts.get(m["params"].get("serverName"), 0) + 1
        c.ok(set(counts) == want and all(v == 1 for v in counts.values()), "one server_initialized per server within 10s", json.dumps(counts))
        res, err, _ = ag.request("_kiro.dev/commands/execute", {"sessionId": sid, "command": {"command": "mcp", "args": {}}}, timeout=40)
        servers = ((res or {}).get("data") or {}).get("servers") or []
        c.ok((res or {}).get("success") is True and {s.get("name") for s in servers} == want and all(s.get("status") == "running" for s in servers),
             "/mcp data.servers all running", json.dumps(res or err)[:300])
        c.ok(all(isinstance(s.get("toolCount"), int) for s in servers), "toolCount ints")
        res, err, _ = ag.request("_kiro.dev/commands/execute", {"sessionId": sid, "command": {"command": "tools", "args": {}}}, timeout=40)
        tools = ((res or {}).get("data") or {}).get("tools") or []
        srcs = sorted({t.get("source") for t in tools})
        has_mcp = any(str(s).startswith("mcp:") for s in srcs)
        if ctx.real or has_mcp:
            c.ok((res or {}).get("success") is True and has_mcp, "/tools has mcp: sources", json.dumps(srcs)[:300])
        else:
            # fake-claude lists MCP tools only from a `fakeTools` key inside the --mcp-config entry,
            # which kiro-claude (like any host) normalises away; the fake has no other way to
            # declare an MCP server's tools, so the mcp: mapping cannot be shown in stage B.
            report("S2-mcp-tools", "SKIP", f"fake-claude limitation: no MCP tools reported (sources {srcs}); needs a "
                   "fake knob that survives host config normalisation, e.g. FAKE_CLAUDE_MCP_TOOLS={server:[tools]}")
        c.ok(any(t.get("source") == "builtin" for t in tools), "/tools has builtin sources")
        # KC-ACP-22 available_commands_update after session/new
        c.ok(bool(ag.updates(idx_new, kind="available_commands_update")), "available_commands_update")
        if not ctx.real:
            time.sleep(0.3)
            starts = stream_starts(fake_log(ws))
            c.ok(len(starts) == 1, "eager claude child at session/new (1 fake start)", str(len(starts)))
            if starts:
                st = starts[0]
                env = st.get("env") or {}
                c.ok(env.get("KIROCREW_SPAWNED") == "1" and "CLAUDECODE" not in env, "KC-ENV-01 env passed, CLAUDECODE scrubbed",
                     f"KIROCREW_SPAWNED={env.get('KIROCREW_SPAWNED')} CLAUDECODE={'CLAUDECODE' in env}")
                cfgs = []
                for v in argv_value(st["argv"], "--mcp-config"):
                    try:
                        cfgs.append(json.loads(v if v.strip().startswith("{") else open(v).read()))
                    except (OSError, ValueError) as e:
                        cfgs.append({"_err": str(e)})
                merged = {}
                for cf in cfgs:
                    merged.update(cf.get("mcpServers") or {})
                core = merged.get("kirocrew-core") or {}
                c.ok((core.get("env") or {}).get("KIROCREW_STUB_SESSION_TOKEN") == "tok-e2e-stub" and core.get("command") == "/bin/true",
                     "KC-ENV-02 session stub overrides spec server, env kept", json.dumps(core)[:300])
                c.ok(merged.get("kc-alpha", {}).get("alwaysLoad") is True and merged.get("kirocrew-core", {}).get("alwaysLoad") is True
                     and not merged.get("kc-beta", {}).get("alwaysLoad"), "KC-ENV-03 alwaysLoad on ASBX_KIRO_MANDATORY_MCPS",
                     json.dumps({k: v.get("alwaysLoad") for k, v in merged.items()}))
                c.ok((merged.get("kc-beta", {}).get("env") or {}).get("KC_SPEC_ONLY") == ctx.home, "KC-SPEC-04 ${VAR} expansion",
                     json.dumps(merged.get("kc-beta"))[:200])
                eff = argv_value(st["argv"], "--effort")
                c.ok(eff == ["high"], "KC-FS-05 cli.json effort ⇒ --effort high", repr(eff))
                prompt_files = argv_value(st["argv"], "--append-system-prompt-file") + argv_value(st["argv"], "--system-prompt-file")
                inline = argv_value(st["argv"], "--append-system-prompt") + argv_value(st["argv"], "--system-prompt")
                blob = "".join(inline)
                for pf in prompt_files:
                    try:
                        blob += open(pf, encoding="utf-8").read()
                    except OSError:
                        pass
                c.ok("KC-STEERING-MARKER-7f3a" in blob, "KC-FS-07 steering marker in Claude system prompt",
                     f"files={prompt_files} inline={len(blob)}B")
        c.ok(not ag.bad_lines, "stdout only JSON-RPC", repr(ag.bad_lines[:2]))
    finally:
        ag.close()
    c.done()


def s3(ctx: Ctx) -> None:
    c = Check("S3")
    ws, ag, sid, _ = opener(ctx, "S3", "kc-chat", spec("kc-chat"))
    try:
        filler = "".join(f"Rule {i}: be concise, cite files, and keep the workspace tidy at all times.\n" for i in range(700))
        text = "[AGENT SYSTEM PROMPT]\n" + filler + "[END AGENT SYSTEM PROMPT]\n[CURRENT USER REQUEST -- respond to this]\n" + words(ctx, "PING")
        c.ok(len(text) >= 45000, f"prompt {len(text)} chars")
        res, err, idx, start = ag.prompt(sid, text, timeout=180)
        got = ag.text(start, idx)
        c.ok(err is None and (res or {}).get("stopReason") == "end_turn", "end_turn", json.dumps(res or err)[:200])
        c.ok(expect_text(ctx, got, "PONG"), "chunks contain PONG", repr(got[:120]))
        meta = ag.wait_for(lambda m: m.get("method") == "_kiro.dev/metadata" and "contextUsagePercentage" in (m.get("params") or {}), 5, start)
        c.ok(meta is not None, "_kiro.dev/metadata.contextUsagePercentage")
        usage = ag.updates(start, kind="usage_update")
        c.ok(bool(usage) and all({"used", "size"} <= set(u) for u in usage), "KC-ACP-18 usage_update {used,size}", json.dumps(usage[:1]))
        c.ok(isinstance((res or {}).get("usage"), dict), "KC-ACP-18 PromptResponse.usage", json.dumps((res or {}).get("usage"))[:200])
        time.sleep(0.3)
        jf = os.path.join(ctx.sessions_dir(), f"{sid}.json")
        jl = os.path.join(ctx.sessions_dir(), f"{sid}.jsonl")
        kinds = []
        if os.path.exists(jl):
            for line in open(jl, encoding="utf-8"):
                try:
                    kinds.append(json.loads(line).get("kind"))
                except ValueError:
                    kinds.append("<bad>")
        c.ok("Prompt" in kinds and "AssistantMessage" in kinds and os.path.getsize(jl) >= 10, "KC-FS-03 <sid>.jsonl Prompt+AssistantMessage", repr(kinds))
        env = json.load(open(jf)) if os.path.exists(jf) else {}
        c.ok(env.get("session_id") == sid and (env.get("session_state") or {}).get("agent_name") == "kc-chat"
             and ((env.get("session_state") or {}).get("permissions") or {}).get("filesystem") is not None
             and env.get("kind") == "kiro-claude-session", "KC-FS-02 <sid>.json kiro-cli envelope", json.dumps(env)[:200])
        c.ok(os.path.exists(jf) and (os.stat(jf).st_mode & 0o777) == 0o600, "KC-FS-02 mode 0600",
             oct(os.stat(jf).st_mode & 0o777) if os.path.exists(jf) else "missing")
    finally:
        ag.close()
    c.done()


def _tool_frames(ag: Agent, start: int):
    """(tool_call updates, tool_call_update updates, index of first permission request or None, index of first tool_call or None)."""
    calls, upd, perm_i, call_i = [], [], None, None
    for i, m in enumerate(ag.msgs(start)):
        if m.get("method") == "session/request_permission" and perm_i is None:
            perm_i = i
        if m.get("method") == "session/update":
            u = m["params"].get("update") or {}
            if u.get("sessionUpdate") == "tool_call":
                calls.append(u)
                if call_i is None:
                    call_i = i
            elif u.get("sessionUpdate") == "tool_call_update":
                upd.append(u)
    return calls, upd, perm_i, call_i


def _deny_in_fake_log(ws: str) -> bool:
    for r in fake_log(ws):
        if r.get("event") != "stdin":
            continue
        s = json.dumps(r.get("line"))
        if '"behavior": "deny"' in s or '"permissionDecision": "deny"' in s or '"decision": "block"' in s:
            return True
    return False


def s4(ctx: Ctx, variant: str) -> None:
    sid_name = {"allow": "S4", "reject": "S4r", "allowed": "S4b"}[variant]
    c = Check(sid_name)
    allowed = ["fs_read", "execute_bash"] if variant == "allowed" else ["fs_read"]
    ws, ag, sid, _ = opener(ctx, sid_name, "kc-tools", spec("kc-tools", allowedTools=allowed))
    ag.permission_policy = "reject_once" if variant == "reject" else "allow_once"
    try:
        res, err, idx, start = ag.prompt(sid, words(ctx, "RUN-ECHO"), timeout=180)
        calls, upd, perm_i, call_i = _tool_frames(ag, start)
        perms = [m for m in ag.msgs(start) if m.get("method") == "session/request_permission"]
        c.ok(err is None and (res or {}).get("stopReason") == "end_turn", "end_turn", json.dumps(res or err)[:200])
        shell = [u for u in calls if ((u.get("_meta") or {}).get("kiro") or {}).get("toolName") == "shell"]
        c.ok(bool(shell), "tool_call _meta.kiro.toolName=shell", json.dumps([(u.get("_meta") or {}) for u in calls])[:300])
        c.ok(all(((u.get("_meta") or {}).get("kiro") or {}).get("toolName") for u in calls), "_meta.kiro.toolName on every tool_call")
        c.ok(all(u.get("status") == "pending" for u in calls), "tool_call status pending", json.dumps([u.get("status") for u in calls]))
        purpose = [((u.get("rawInput") or {}).get("__tool_use_purpose")) for u in shell]
        c.ok(any(purpose), "rawInput.__tool_use_purpose", json.dumps([u.get("rawInput") for u in shell])[:200])
        tcid = shell[0].get("toolCallId") if shell else None
        mine = [u for u in upd if u.get("toolCallId") == tcid]
        final = [u for u in mine if u.get("status") in ("completed", "failed")]
        if variant == "allowed":
            c.ok(not perms, "S4b allowedTools ⇒ no permission request", str(len(perms)))
        else:
            c.ok(len(perms) == 1, "one session/request_permission", str(len(perms)))
            if perms:
                p = perms[0]["params"]
                opts = {o.get("optionId") for o in p.get("options") or []}
                c.ok(opts == KIRO_OPTIONS, "3 kiro options", json.dumps(p.get("options"))[:300])
                c.ok(call_i is not None and perm_i is not None and call_i < perm_i, "tool_call precedes request_permission")
                c.ok((p.get("toolCall") or {}).get("toolCallId") == tcid, "permission names the tool_call")
        if variant == "reject":
            fm = (final[-1].get("_meta") or {}).get("kiro") if final else {}
            c.ok(bool(final) and final[-1].get("status") == "failed", "on reject: failed", json.dumps(final)[:300])
            c.ok((fm or {}).get("toolCallFailureReason") == "permission_denied", "toolCallFailureReason permission_denied", json.dumps(fm)[:200])
            if not ctx.real:
                c.ok(_deny_in_fake_log(ws), "fake log shows a deny answer")
                ran = any(r.get("event") == "stdin" and "kc-e2e" in json.dumps(r.get("line")) and '"tool_result"' in json.dumps(r.get("line")) for r in fake_log(ws))
                c.ok(not ran, "no side effect (tool not run)")
        else:
            ro = final[-1].get("rawOutput") if final else None
            stdout = None
            try:
                stdout = ro["items"][0]["Json"]["stdout"]
            except (TypeError, KeyError, IndexError):
                pass
            c.ok(bool(final) and final[-1].get("status") == "completed", "completed", json.dumps(final)[-300:])
            c.ok(stdout is not None and "kc-e2e" in stdout, "rawOutput.items[0].Json.stdout has kc-e2e", json.dumps(ro)[:300])
            c.ok(expect_text(ctx, ag.text(start, idx), "DONE"), "reply DONE", repr(ag.text(start, idx)[:100]))
    finally:
        ag.close()
    c.done()


def s5(ctx: Ctx) -> None:
    c = Check("S5")
    ws, ag, sid, _ = opener(ctx, "S5", "kc-chat", spec("kc-chat"))
    try:
        res, err, _ = ag.request("session/set_model", {"sessionId": sid, "modelId": "claude-haiku-5.5"})
        c.ok(err is None and res == {}, "set_model claude-haiku-5.5 ⇒ {}", json.dumps(res or err))
        res, err, _ = ag.request("session/set_model", {"sessionId": sid, "modelId": "bogus"})
        c.ok(err is not None and "Invalid model ID: bogus" in json.dumps(err), "bogus ⇒ error 'Invalid model ID: bogus'", json.dumps(res or err)[:200])
        res, err, _ = ag.request("_kiro.dev/commands/execute", {"sessionId": sid, "command": {"command": "effort", "args": {"value": "high"}}})
        if not ((res or {}).get("message") == "Effort set to high"):
            # tolerate the other args spellings KiroCrew has used
            res, err, _ = ag.request("_kiro.dev/commands/execute", {"sessionId": sid, "command": {"command": "effort", "args": {"level": "high"}}})
        c.ok((res or {}).get("success") is True and (res or {}).get("message") == "Effort set to high", "effort high ⇒ 'Effort set to high'", json.dumps(res or err)[:200])
        res, err, _ = ag.request("_kiro.dev/commands/execute", {"sessionId": sid, "command": {"command": "foo", "args": {}}})
        c.ok(err is None and (res or {}).get("success") is False and (res or {}).get("message") == "Unknown command: /foo", "foo ⇒ {success:false, Unknown command: /foo}", json.dumps(res or err)[:200])
        if not ctx.real:
            # the change reaches Claude: next turn's fake log shows set_model/effort
            r2, e2, idx, start = ag.prompt(sid, words(ctx, "PING"))
            sm = [((r.get("line") or {}).get("request") or {}).get("model") for r in fake_log(ws)
                  if r.get("event") == "stdin" and ((r.get("line") or {}).get("request") or {}).get("subtype") == "set_model"]
            c.ok(any(m in ("haiku", "claude-haiku-5-5") for m in sm), "set_model reached Claude (control set_model)", json.dumps(sm))
    finally:
        ag.close()
    c.done()


def s6(ctx: Ctx) -> None:
    c = Check("S6")
    ws, ag, sid, _ = opener(ctx, "S6", "kc-chat", spec("kc-chat"))
    try:
        ag.prompt(sid, words(ctx, "PING"))
        res, err, idx, start = ag.prompt(sid, "/compact", timeout=180)
        c.ok(err is None and (res or {}).get("stopReason") == "end_turn", "end_turn", json.dumps(res or err)[:200])
        c.ok("Compacting conversation" in ag.text(start, idx), "chunk 'Compacting conversation...'", repr(ag.text(start, idx)[:80]))
        done = ag.wait_for(lambda m: m.get("method") == "_kiro.dev/compaction/status" and ((m["params"].get("status") or {}).get("type") in ("completed", "failed")), 60, start)
        cps = [m["params"] for m in ag.msgs(start) if m.get("method") == "_kiro.dev/compaction/status"]
        sts = [(p.get("status") or {}) for p in cps]
        types = [s.get("type") for s in sts]
        c.ok(types[:1] == ["started"] and done is not None and types[-1] == "completed", "compaction/status started → completed", json.dumps(types))
        pos_resp = idx - start
        pos_first = next((i for i, m in enumerate(ag.msgs(start)) if m.get("method") == "_kiro.dev/compaction/status"), None)
        c.ok(pos_first is not None and pos_first > pos_resp, "status frames after the end_turn response")
        # kiro-cli's wire (KiroCrew corpus compaction-live.jsonl): params {sessionId, status:{type}, summary}
        c.ok(bool(cps) and isinstance(cps[-1].get("summary"), str) and cps[-1]["summary"].strip() != "", "completed + summary", json.dumps(cps[-1:])[:200])
        time.sleep(0.3)
        jl = os.path.join(ctx.sessions_dir(), f"{sid}.jsonl")
        kinds = [json.loads(l).get("kind") for l in open(jl)] if os.path.exists(jl) else []
        c.ok("Compaction" in kinds, "Compaction jsonl record", repr(kinds))
    finally:
        ag.close()
    c.done()


def s7(ctx: Ctx) -> None:
    c = Check("S7")
    ws, ag, sid, _ = opener(ctx, "S7", "kc-chat", spec("kc-chat"))
    try:
        rid = ag.request_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": words(ctx, "SLOW")}]})
        start = len(ag.frames)
        ag.wait_for(lambda m: m.get("method") == "session/update" and (m["params"].get("update") or {}).get("sessionUpdate") == "agent_message_chunk", 60, start)
        time.sleep(0.2)
        t0 = time.time()
        ag.notify("session/cancel", {"sessionId": sid})
        res, err, idx = ag.wait_response(rid, 10)
        dt = time.time() - t0
        c.ok((res or {}).get("stopReason") == "cancelled", "stopReason cancelled", json.dumps(res or err)[:200])
        c.ok(dt <= 2.0, f"within {dt:.2f}s ≤ 2s")
        if not ctx.real:
            c.ok("TOO-LATE" not in ag.text(start), "turn did not finish")
            ints = [r for r in fake_log(ws) if r.get("event") == "stdin" and ((r.get("line") or {}).get("request") or {}).get("subtype") == "interrupt"]
            c.ok(bool(ints), "Claude got an interrupt control request")
        r2, e2, i2, s2_ = ag.prompt(sid, words(ctx, "PING"))
        c.ok((r2 or {}).get("stopReason") == "end_turn" and expect_text(ctx, ag.text(s2_, i2), "PONG"), "session usable after cancel")
    finally:
        ag.close()
    c.done()


def s8(ctx: Ctx) -> None:
    c = Check("S8")
    ws, ag, sid, _ = opener(ctx, "S8", "kc-chat", spec("kc-chat"))
    try:
        ag.prompt(sid, words(ctx, "PING"))
        res, err, _ = ag.request("_kiro.dev/session/terminate", {"sessionId": sid})
        c.ok(err is None and res == {}, "terminate ⇒ {}", json.dumps(res or err))
        res2, err2, _ = ag.request("_kiro.dev/session/terminate", {"sessionId": sid})
        c.ok(err2 is None and res2 == {}, "terminate idempotent", json.dumps(res2 or err2))
        res, err, _ = ag.request("session/set_mode", {"sessionId": sid, "modeId": "kc-chat"})
        c.ok(err is not None and err.get("code") == -32603 and err.get("message") == "Internal error" and err.get("data") == "Session not found",
             "then set_mode ⇒ -32603 Internal error / Session not found", json.dumps(res or err))
        d = ctx.sessions_dir()
        c.ok(os.path.exists(os.path.join(d, f"{sid}.json")) and os.path.exists(os.path.join(d, f"{sid}.jsonl")), "files kept")
        if not ctx.real:
            time.sleep(0.5)
            pids = {r["pid"] for r in stream_starts(fake_log(ws))}
            c.ok(pids and not any(pid_alive(p) for p in pids), "Claude child closed", str(pids))
    finally:
        ag.close()
    c.done()


def s9(ctx: Ctx) -> None:
    c = Check("S9")
    ws, ag, sid, _ = opener(ctx, "S9", "kc-chat", spec("kc-chat"))
    try:
        ag.prompt(sid, words(ctx, "PING"))
        ag.prompt(sid, words(ctx, "RUN-ECHO"), timeout=180)
    finally:
        ag.close()
    claude_sid = None
    try:
        rec = json.load(open(os.path.join(ctx.sessions_dir(), f"{sid}.json")))
        claude_sid = (rec.get("kiro_claude") or {}).get("claudeSessionId")
    except (OSError, ValueError):
        pass
    ag2 = Agent(ctx, "S9", ws, "kc-chat", label="S9-load")
    try:
        ag2.initialize()
        start = len(ag2.frames)
        res, err, idx = ag2.request("session/load", {"sessionId": sid, "cwd": ws, "mcpServers": [],
                                                     "_meta": {"_kiro.dev/session_file": os.path.join(ctx.sessions_dir(), f"{sid}.json")}}, timeout=60)
        c.ok(err is None and isinstance(res, dict), "session/load ok (fresh process)", json.dumps(err)[:200])
        res = res or {}
        c.ok((res.get("modes") or {}).get("currentModeId") == "kc-chat", "result has modes", json.dumps(res.get("modes"))[:150])
        c.ok(isinstance(res.get("models"), dict), "result has models")
        um = ag2.text(start, idx, "user_message_chunk")
        am = ag2.text(start, idx, "agent_message_chunk")
        c.ok(bool(um) and bool(am), "replayed user_message_chunk + agent_message_chunk", f"user={um[:60]!r} agent={am[:60]!r}")
        c.ok(bool(ag2.updates(start, idx, "tool_call")), "replayed tool_call")
        if not ctx.real:
            starts = stream_starts(fake_log(ws))
            last = starts[-1]["argv"] if starts else []
            c.ok(claude_sid is not None and argv_value(last, "--resume") == [claude_sid], "fake log --resume <claude sid>",
                 f"claude_sid={claude_sid} argv_resume={argv_value(last, '--resume')}")
        r2, e2, i2, s2_ = ag2.prompt(sid, words(ctx, "PING"))
        c.ok((r2 or {}).get("stopReason") == "end_turn" and expect_text(ctx, ag2.text(s2_, i2), "PONG"), "prompt after load")
    finally:
        ag2.close()
    c.done()


def s10(ctx: Ctx) -> None:
    c = Check("S10")
    ws, ag, main, _ = opener(ctx, "S10", "kc-chat", spec("kc-chat"))
    try:
        sids = [main]
        for _ in range(2):
            r, e, _ = ag.new_session()
            sids.append(r["sessionId"])
        # 3 concurrent prompts
        rids = [ag.request_async("session/prompt", {"sessionId": s, "prompt": [{"type": "text", "text": words(ctx, "PING")}]}) for s in sids]
        outs = [ag.wait_response(r, 120) for r in rids]
        c.ok(all((o[0] or {}).get("stopReason") == "end_turn" for o in outs), "3 concurrent sessions end_turn", json.dumps([o[0] or o[1] for o in outs])[:200])
        # 2 helper sessions while the main ones idle: open → prompt → terminate (lite spec, no tools)
        helpers_ok = []
        for _ in range(2):
            r, e, _ = ag.new_session()
            h = r["sessionId"]
            ag.request("session/set_mode", {"sessionId": h, "modeId": "kc-chat"})
            ag.request("session/set_model", {"sessionId": h, "modelId": "auto"})
            pr = ag.prompt(h, "You are a session naming agent. Name ONLY the conversation delimited below.\n---\nhello\n---")
            t = ag.request("_kiro.dev/session/terminate", {"sessionId": h})
            helpers_ok.append((pr[0] or {}).get("stopReason") == "end_turn" and t[0] == {})
        c.ok(all(helpers_ok), "2 helper sessions open → prompt → terminate", json.dumps(helpers_ok))
        r2 = ag.prompt(main, words(ctx, "PING"))
        c.ok((r2[0] or {}).get("stopReason") == "end_turn", "main session still serves after helpers")
        c.ok(ag.p.poll() is None, f"one kiro-claude process (pid {ag.p.pid}) served all")
        if not ctx.real:
            starts = stream_starts(fake_log(ws))
            c.ok(len({r['pid'] for r in starts}) == 5, "one fake-claude child per session (5)", str(len(starts)))
    finally:
        ag.close()
    c.done()


def _children(pid: int) -> list[int]:
    out = []
    for d in glob.glob("/proc/[0-9]*"):
        try:
            with open(f"{d}/stat") as f:
                st = f.read()
            if int(st.rsplit(") ", 1)[1].split()[1]) == pid:
                out.append(int(d.rsplit("/", 1)[1]))
        except (OSError, ValueError, IndexError):
            pass
    return out


def s11(ctx: Ctx) -> None:
    for how in ("eof", "sigterm"):
        c = Check(f"S11{'' if how == 'eof' else 't'}")
        ws, ag, sid, _ = opener(ctx, f"S11-{how}", "kc-chat", spec("kc-chat"))
        try:
            ag.new_session()
            ag.prompt(sid, words(ctx, "PING"))
            rid = ag.request_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": words(ctx, "SLOW")}]})
            ag.wait_for(lambda m: m.get("method") == "session/update" and (m["params"].get("update") or {}).get("sessionUpdate") == "agent_message_chunk"
                        and "Working" in json.dumps(m) if not ctx.real else True, 30)
            kids = _children(ag.p.pid)
            fake_pids = {r["pid"] for r in stream_starts(fake_log(ws))} if not ctx.real else set(kids)
            t0 = time.time()
            if how == "eof":
                ag.p.stdin.close()
            else:
                ag.p.send_signal(signal.SIGTERM)
            try:
                rc = ag.p.wait(10)
            except subprocess.TimeoutExpired:
                rc = None
            dt = time.time() - t0
            c.ok(rc is not None and dt <= 5.0, f"{how}: exit rc={rc} in {dt:.2f}s ≤ 5s")
            time.sleep(0.5)
            left = [p for p in fake_pids | set(kids) if pid_alive(p)]
            c.ok(fake_pids and not left, f"no Claude child left ({len(fake_pids)} started)", str(left))
            ag.reader.join(2)
            c.ok(not ag.bad_lines, "only frames on stdout", repr(ag.bad_lines[:2]))
            _ = rid
        finally:
            ag.kill()
            try:
                ag.wire.close()
            except ValueError:
                pass
        c.done()


def s12(ctx: Ctx) -> None:
    c = Check("S12")
    ws, ag, sid, _ = opener(ctx, "S12", "kc-tools", spec("kc-tools"))
    ag.permission_policy = "hold"
    try:
        # (a) steer while the tool waits for permission ⇒ queued, injected after the tool result
        rid = ag.request_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": words(ctx, "ECHO-STEER")}]})
        start = len(ag.frames)
        perm = ag.wait_permission(60)
        c.ok(perm is not None, "permission pending")
        steer_text = "KC-STEER-ALPHA also say hi"
        res, err, _ = ag.request("_session/steer", {"sessionId": sid, "message": steer_text})
        c.ok(err is None and (res or {}).get("queued") is True, "steer ⇒ {queued:true}", json.dumps(res or err))
        q = ag.wait_for(lambda m: m.get("method") == "_kiro.dev/session/update" and (m["params"].get("update") or {}).get("sessionUpdate") == "AgentExecutionUserMessageQueued", 5, start)
        c.ok(q is not None, "AgentExecutionUserMessageQueued")
        if perm:
            ag.answer_permission(perm, "allow_once")
        r, e, idx = ag.wait_response(rid, 120)
        c.ok((r or {}).get("stopReason") == "end_turn", "turn ends end_turn", json.dumps(r or e)[:150])
        upd_kinds = [((m.get("params") or {}).get("update") or {}).get("sessionUpdate") for m in ag.msgs(start, idx + 1)
                     if m.get("method") in ("session/update", "_kiro.dev/session/update")]
        inj = "AgentExecutionSteeringInjected" in upd_kinds
        c.ok(inj, "AgentExecutionSteeringInjected", json.dumps(upd_kinds)[:400])
        if inj:
            last_tool = max(i for i, k in enumerate(upd_kinds) if k == "tool_call_update")
            c.ok(upd_kinds.index("AgentExecutionSteeringInjected") > upd_kinds.index("AgentExecutionUserMessageQueued")
                 and upd_kinds.index("AgentExecutionSteeringInjected") > last_tool - 0, "Queued → tool result → Injected order")
        if not ctx.real:
            got = [r for r in fake_log(ws) if r.get("event") == "stdin" and "KC-STEER-ALPHA" in json.dumps(r.get("line"))]
            c.ok(bool(got) and (got[0].get("line") or {}).get("priority") == "next", "steer reached Claude with priority next",
                 json.dumps([(g.get("line") or {}).get("priority") for g in got]))
        # (b) steer then clear while the permission is pending ⇒ {cleared:true} + UserMessageCleared; never injected
        rid = ag.request_async("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": words(ctx, "ECHO-STEER")}]})
        start = len(ag.frames)
        perm = ag.wait_permission(60)
        res, err, _ = ag.request("_session/steer", {"sessionId": sid, "message": "KC-STEER-BRAVO drop me"})
        c.ok((res or {}).get("queued") is True, "second steer queued")
        res, err, _ = ag.request("_session/steer/clear", {"sessionId": sid})
        c.ok(err is None and (res or {}).get("cleared") is True, "steer/clear ⇒ {cleared:true}", json.dumps(res or err))
        cl = ag.wait_for(lambda m: m.get("method") == "_kiro.dev/session/update" and (m["params"].get("update") or {}).get("sessionUpdate") == "AgentExecutionUserMessageCleared", 5, start)
        c.ok(cl is not None, "AgentExecutionUserMessageCleared")
        if perm:
            ag.answer_permission(perm, "allow_once")
        r, e, idx = ag.wait_response(rid, 120)
        kinds_b = [((m.get("params") or {}).get("update") or {}).get("sessionUpdate") for m in ag.msgs(start, idx + 1)]
        c.ok((r or {}).get("stopReason") == "end_turn" and "AgentExecutionSteeringInjected" not in kinds_b, "cleared steer never injected; end_turn")
        if not ctx.real:
            c.ok(not any("KC-STEER-BRAVO" in json.dumps(r.get("line")) for r in fake_log(ws) if r.get("event") == "stdin"), "cleared steer never reached Claude")
    finally:
        ag.close()
    c.done()


def s13(ctx: Ctx) -> None:
    c = Check("S13")
    ws, ag, sid, _ = opener(ctx, "S13", "kc-zero", spec("kc-zero", tools=[], allowedTools=[], mcpServers={}))
    try:
        res, err, idx, start = ag.prompt(sid, words(ctx, "PING"))
        calls, upd, perm_i, _ = _tool_frames(ag, start)
        c.ok((res or {}).get("stopReason") == "end_turn" and not calls and not upd and perm_i is None, "zero-tools: no tool frames, no permission request")
        if not ctx.real:
            st = stream_starts(fake_log(ws))
            tv = argv_value(st[0]["argv"], "--tools") if st else None
            c.ok(tv == [""], "zero-tools: claude --tools \"\"", repr(tv))
            c.ok(st and "--strict-mcp-config" in st[0]["argv"] and not argv_value(st[0]["argv"], "--mcp-config"),
                 "zero-tools: no MCP config, --strict-mcp-config")
    finally:
        ag.close()
    c.done()
    c2 = Check("S13r")
    files = {"secret/token.txt": "TOP-SECRET-VALUE\n", "notes.txt": "public\n"}
    sp = spec("kc-ro--readonly", tools=["fs_read", "grep", "glob"], allowedTools=["fs_read", "grep", "glob"],
              toolsSettings={"fs_read": {"deniedPaths": ["secret/**", os.path.join(ctx.e2e, "ws-s13r", "secret")]}})
    ws, ag, sid, _ = opener(ctx, "S13r", "kc-ro--readonly", sp, files)
    try:
        res, err, idx, start = ag.prompt(sid, words(ctx, "READ-DENIED"), timeout=180)
        calls, upd, perm_i, _ = _tool_frames(ag, start)
        final = [u for u in upd if u.get("status") in ("completed", "failed")]
        c2.ok((res or {}).get("stopReason") == "end_turn", "end_turn", json.dumps(res or err)[:150])
        c2.ok(perm_i is None, "no permission request for the denied read")
        c2.ok(bool(final) and final[-1].get("status") == "failed", "read of a denied path ⇒ failed", json.dumps(final)[:300])
        c2.ok("TOP-SECRET-VALUE" not in json.dumps(ag.msgs(start)), "secret never on the wire")
        if not ctx.real:
            c2.ok(_deny_in_fake_log(ws), "Claude got a deny before the tool ran")
    finally:
        ag.close()
    c2.done()


SCENARIOS = {
    "S1": s1, "S2": s2, "S3": s3,
    "S4": lambda c: s4(c, "allow"), "S4r": lambda c: s4(c, "reject"), "S4b": lambda c: s4(c, "allowed"),
    "S5": s5, "S6": s6, "S7": s7, "S8": s8, "S9": s9, "S10": s10, "S11": s11, "S12": s12, "S13": s13,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.environ.get("SHIM"))
    ap.add_argument("--stage", default="B", choices=["B", "C"])
    ap.add_argument("--real", action="store_true")
    ap.add_argument("--out", default=None)
    ap.add_argument("--script", default=os.path.join(HERE, "fake-script.json"))
    ap.add_argument("only", nargs="*")
    a = ap.parse_args()
    a.real = a.real or a.stage == "C"
    if not a.bin:
        ap.error("--bin is required (or source env.sh for $SHIM)")
    if not a.out:
        a.out = os.path.join(os.environ.get("E2E", "."), "acp")
    os.makedirs(a.out, exist_ok=True)
    ctx = Ctx(a)
    names = a.only or list(SCENARIOS)
    for n in names:
        if n not in SCENARIOS:
            report(n, "FAIL", "unknown scenario")
            continue
        try:
            SCENARIOS[n](ctx)
        except Exception as e:  # noqa: BLE001 - one broken scenario must not hide the others
            report(n, "FAIL", f"harness exception {type(e).__name__}: {e}")
        finally:
            for p in ctx.procs:
                if p.poll() is None:
                    try:
                        os.killpg(p.pid, signal.SIGKILL)
                    except OSError:
                        pass
            ctx.procs.clear()
    return 1 if any(s == "FAIL" for _, s, _ in RESULTS) else 0


if __name__ == "__main__":
    sys.exit(main())
