// ── iris app create <name> --template local-console (#189082) ───────────────────────────────
//
// The safe version of what an agent built on Kristen Montero's machine on 2026-10-12: a localhost
// server that shows your agents and can pause/resume them by running the `iris` CLI as you. That
// shape is useful and will be generated again, and the first one had three holes:
//   1. any website you visit can send requests to 127.0.0.1 (CSRF; DNS rebinding can read replies)
//   2. it runs `iris` with your whole account behind it
//   3. request data can reach a command line
// This template closes them by construction, and `iris app lint` checks a folder for them.
// Python standard library only, so it runs anywhere Python 3.9+ does — including Windows.

export const LOCAL_CONSOLE_FILES = (name: string): Record<string, string> => ({
  "server.py": SERVER_PY(name),
  "index.html": INDEX_HTML(name),
  "iris.app.json": JSON.stringify({
    name,
    runtime: "python",
    entry: "server.py",
    run: "server",
    port: 8765,
    health: "/healthz",
    egress: ["heyiris.io"],
    secrets: [],
    data_class: "internal",
  }, null, 2) + "\n",
  "launch.bat": LAUNCH_BAT,
  "launch.command": LAUNCH_SH,
  "README.md": README(name),
})

const SERVER_PY = (name: string) => `#!/usr/bin/env python3
# iris: name=${name}
# iris: run=server
# iris: port=8765
# iris: health=/healthz
"""
${name} — a local console for your IRIS agents.

SAFE BY CONSTRUCTION (iris app create --template local-console):
  * binds 127.0.0.1 only — nothing on your network can reach it;
  * a random token is minted at every launch and required on every request, so a website you
    happen to have open cannot drive it (localhost is reachable from any page in your browser);
  * Host and Origin are checked, which stops DNS-rebinding tricks;
  * it can run ONLY the commands in ALLOWED below, each as an argument list — request data never
    reaches a shell and cannot add flags;
  * read-only by default. Pause/resume need IRIS_CONSOLE_WRITE=1 AND a confirm in the page.
Check a changed copy with:  iris app lint .
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8765"))
TOKEN = os.environ.get("IRIS_CONSOLE_TOKEN") or secrets.token_urlsafe(32)
WRITE = os.environ.get("IRIS_CONSOLE_WRITE") == "1"
IRIS = shutil.which("iris") or shutil.which("iris.exe") or "iris"
HERE = os.path.dirname(os.path.abspath(__file__))
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
AGENT_ID = re.compile(r"^[0-9]{1,9}$")

# The ONLY commands this console may run. Every entry is a fixed argument list; an agent id is the
# one value that comes from a request, and it must match AGENT_ID before it is appended.
ALLOWED = {
    "agents": {"argv": ["agents", "list", "--json"], "write": False, "takes_id": False},
    "schedules": {"argv": ["schedules", "list", "--active", "--json"], "write": False, "takes_id": False},
    "approvals": {"argv": ["schedules", "approvals", "--json"], "write": False, "takes_id": False},
    "pause": {"argv": ["agents", "pause"], "write": True, "takes_id": True},
    "resume": {"argv": ["agents", "resume"], "write": True, "takes_id": True},
}


def run_allowed(action, agent_id=None):
    spec = ALLOWED.get(action)
    if spec is None:
        return 404, {"error": "unknown action"}
    if spec["write"] and not WRITE:
        return 403, {"error": "read-only console — relaunch with IRIS_CONSOLE_WRITE=1 to allow changes"}
    argv = [IRIS] + list(spec["argv"])
    if spec["takes_id"]:
        if not agent_id or not AGENT_ID.match(agent_id):
            return 400, {"error": "agent id must be a number"}
        argv.append(agent_id)
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=60)  # argument list, never a shell
    except FileNotFoundError:
        return 503, {"error": "the iris CLI is not installed or not on PATH"}
    except subprocess.TimeoutExpired:
        return 504, {"error": "iris took longer than 60s"}
    if done.returncode != 0:
        return 502, {"error": (done.stderr or done.stdout).strip()[-400:] or f"iris exited {done.returncode}"}
    try:
        return 200, json.loads(done.stdout or "null")
    except ValueError:
        return 200, {"output": done.stdout.strip()[-4000:]}


class Handler(BaseHTTPRequestHandler):
    server_version = "iris-local-console"
    protocol_version = "HTTP/1.1"  # keep-alive; every response sets Content-Length

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def _allowed(self, url):
        # Host: only this machine's own names (blocks DNS rebinding).
        if self.headers.get("Host", "") not in ALLOWED_HOSTS:
            return False
        # Origin, when a browser sends one, must be this console itself.
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc not in ALLOWED_HOSTS:
            return False
        # The per-launch token, from the query (page load) or a header (API calls).
        given = self.headers.get("X-Console-Token") or (parse_qs(url.query).get("t") or [""])[0]
        return secrets.compare_digest(given, TOKEN)

    def _get(self):
        url = urlparse(self.path)
        if url.path == "/healthz":  # no data, no token — only says it is up
            return self._send(200, {"ok": True})
        if not self._allowed(url):
            return self._send(403, {"error": "forbidden"})
        if url.path == "/":
            with open(os.path.join(HERE, "index.html"), "rb") as fh:
                return self._send(200, fh.read(), "text/html; charset=utf-8")
        if url.path.startswith("/api/"):
            action = url.path[len("/api/"):]
            if ALLOWED.get(action, {}).get("write"):  # checked BEFORE anything runs
                return self._send(405, {"error": "use POST for changes"})
            code, body = run_allowed(action)
            return self._send(code, body)
        return self._send(404, {"error": "not found"})

    def _post(self):
        url = urlparse(self.path)
        if not self._allowed(url):
            return self._send(403, {"error": "forbidden"})
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self._send(415, {"error": "send application/json"})  # forces a CORS preflight
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._send(400, {"error": "bad Content-Length"})
        if length > 4096:  # refuse, don't read and don't reset the connection
            self.close_connection = True
            return self._send(413, {"error": "body too large (max 4 KB)"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._send(400, {"error": "bad json"})
        if not isinstance(body, dict):
            return self._send(400, {"error": "body must be a JSON object"})
        action = url.path[len("/api/"):] if url.path.startswith("/api/") else ""
        code, out = run_allowed(action, str(body.get("agent_id", "")))
        return self._send(code, out)

    # One guarded entry point per method: any unexpected error is a 500 JSON answer, never a
    # dropped connection or a traceback in the browser.
    def do_GET(self):
        try:
            self._get()
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("GET error: %s\\n" % type(exc).__name__)
            self._send(500, {"error": "internal error"})

    def do_POST(self):
        try:
            self._post()
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("POST error: %s\\n" % type(exc).__name__)
            self._send(500, {"error": "internal error"})

    def log_message(self, fmt, *args):  # never log the token
        sys.stderr.write("%s %s\\n" % (self.command, urlparse(self.path).path))


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/?t={TOKEN}"
    print(f"${name} — {'read and write' if WRITE else 'read-only'}. Close this window to stop.")
    print(f"Open: {url}")
    if os.environ.get("IRIS_CONSOLE_NO_BROWSER") != "1":
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
`

const INDEX_HTML = (name: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<style>
:root{--g:#f3f4f0;--c:#fbfbf8;--i:#191b19;--s:#5a5f59;--r:#d6d9d2;--a:#0f8a5f;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--g:#0e110f;--c:#151916;--i:#e7ebe6;--s:#a6aea6;--r:#2b322c;--a:#34d399;--bad:#f0776b}}
body{margin:0;background:var(--g);color:var(--i);font:15px/1.5 "Segoe UI",system-ui,sans-serif}
main{max-width:56rem;margin:0 auto;padding:1.5rem}
h1{font-size:1.5rem;margin:0 0 .2rem} .s{color:var(--s)} .n{font-family:ui-monospace,Consolas,monospace}
.card{background:var(--c);border:1px solid var(--r);border-radius:10px;padding:.8rem 1rem;margin:.6rem 0;display:flex;justify-content:space-between;gap:1rem;align-items:center}
button{font:inherit;border:1px solid var(--r);background:var(--c);color:var(--i);border-radius:8px;padding:.35rem .8rem;cursor:pointer}
.err{color:var(--bad)}
</style></head><body><main>
<h1>${name}</h1><p class="s">Your IRIS agents, on this machine only. <span id="mode"></span></p>
<div id="list"><p class="s">Loading…</p></div>
<script>
const T=new URLSearchParams(location.search).get("t");
history.replaceState(null,"",location.pathname); // keep the token out of the address bar
const H={"X-Console-Token":T};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function get(a){const r=await fetch("/api/"+a,{headers:H});return [r.status,await r.json()]}
async function act(a,id,name){
  if(!confirm(a+" "+name+"?"))return;
  const r=await fetch("/api/"+a,{method:"POST",headers:{...H,"Content-Type":"application/json"},body:JSON.stringify({agent_id:String(id)})});
  const b=await r.json(); if(r.status!==200) alert(b.error||("HTTP "+r.status)); load();
}
async function load(){
  const [c,b]=await get("agents"); const box=document.getElementById("list");
  if(c!==200){box.innerHTML='<p class="err">'+esc(b.error)+'</p>';return}
  const list=Array.isArray(b)?b:(b.data||b.agents||[]);
  box.innerHTML=list.map(a=>'<div class="card"><div><b>'+esc(a.name)+'</b> <span class="n s">#'+esc(a.id)+'</span><br><span class="s">'+esc(a.heartbeat_mode||a.status||"")+'</span></div><div>'+
    '<button data-a="pause" data-id="'+esc(a.id)+'" data-n="'+esc(a.name)+'">Pause</button> <button data-a="resume" data-id="'+esc(a.id)+'" data-n="'+esc(a.name)+'">Resume</button></div></div>').join("")||'<p class="s">No agents.</p>';
  box.querySelectorAll("button").forEach(b=>b.onclick=()=>act(b.dataset.a,b.dataset.id,b.dataset.n));
}
load(); setInterval(load,45000);
</script></main></body></html>
`

const LAUNCH_BAT = `@echo off
REM Starts the console. Close this window to stop it.
cd /d "%~dp0"
where python >nul 2>nul && (python server.py) || (py -3 server.py)
pause
`

const LAUNCH_SH = `#!/bin/sh
# Starts the console. Close this window (or Ctrl-C) to stop it.
cd "$(dirname "$0")" && exec python3 server.py
`

const README = (name: string) => `# ${name}

A local console for your IRIS agents. Runs on this machine only.

- **Start:** double-click \`launch.bat\` (Windows) or \`launch.command\` (Mac). Your browser opens it.
- **Stop:** close the window that opened.
- **Read-only by default.** To allow Pause/Resume, set \`IRIS_CONSOLE_WRITE=1\` before launching.
- **Why it is safe:** it answers only on 127.0.0.1, needs a fresh random token every launch, checks
  Host and Origin, and can run only the commands listed in \`ALLOWED\` in \`server.py\`.
- **Changed it?** Run \`iris app lint .\` before you rely on it.
- **Not for \`iris app serve\`.** This console runs the \`iris\` CLI as you, so it belongs on your own
  desktop, not in a sealed container. \`iris app serve\` is for apps that do not need your login.
`
