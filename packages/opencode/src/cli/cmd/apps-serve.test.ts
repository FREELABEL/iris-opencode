import { describe, expect, test } from "bun:test"
import {
  buildListScript,
  buildServeScript,
  lintLocalApp,
  parseIrisHeader,
  parseListOutput,
  resolveManifest,
  servedContainerName,
} from "./apps-serve"
import { LOCAL_CONSOLE_FILES } from "./apps-local-console"

const HEADER_APP = `#!/usr/bin/env python3
# iris: name=price-check
# iris: port=8080
# iris: health=/healthz
# iris: secrets=STRIPE_KEY
# iris: secrets=SLACK_TOKEN
# iris: egress=api.stripe.com, hooks.slack.com
import os
# iris: port=9999
print("hi")
`

describe("parseIrisHeader", () => {
  test("reads the leading comment block only, appends list keys", () => {
    const h = parseIrisHeader(HEADER_APP)
    expect(h.port).toBe("8080") // the # iris: line after code is NOT a declaration
    expect(h.secrets).toEqual(["STRIPE_KEY", "SLACK_TOKEN"])
    expect(h.egress).toEqual(["api.stripe.com", "hooks.slack.com"])
  })
})

describe("resolveManifest", () => {
  test("header manifest for a one-file app", () => {
    const r = resolveManifest("Price Check", { "app.py": HEADER_APP })
    expect(r.errors).toEqual([])
    expect(r.source).toBe("header")
    expect(r.manifest).toMatchObject({ name: "price-check", entry: "app.py", port: 8080, health: "/healthz", run: "server" })
  })

  test("iris.app.json wins over the header", () => {
    const r = resolveManifest("x", { "app.py": HEADER_APP, "iris.app.json": JSON.stringify({ name: "from-json", entry: "app.py", port: 7000 }) })
    expect(r.source).toBe("iris.app.json")
    expect(r.manifest?.name).toBe("from-json")
    expect(r.manifest?.port).toBe(7000)
  })

  test("refuses anything that would be interpolated unsafely", () => {
    const r = resolveManifest("x", { "iris.app.json": JSON.stringify({ name: "a;rm -rf", entry: "../etc/x.py", port: 80, health: "/h; curl evil", secrets: ["lower"], egress: ["not a host"], data_class: "secret" }) })
    expect(r.manifest).toBeNull()
    expect(r.errors.join("\n")).toMatch(/name/)
    expect(r.errors.join("\n")).toMatch(/entry/)
    expect(r.errors.join("\n")).toMatch(/port/)
    expect(r.errors.join("\n")).toMatch(/health/)
    expect(r.errors.join("\n")).toMatch(/secret/)
    expect(r.errors.join("\n")).toMatch(/egress/)
    expect(r.errors.join("\n")).toMatch(/data_class/)
  })

  test("per-request is named as not servable yet, not silently served", () => {
    const r = resolveManifest("x", { "app.py": "# iris: run=per-request\n" })
    expect(r.manifest).toBeNull()
    expect(r.errors.join(" ")).toMatch(/per-request/)
  })

  test("ambiguous entry asks instead of guessing", () => {
    const r = resolveManifest("x", { "a.py": "", "b.py": "" })
    expect(r.manifest).toBeNull()
    expect(r.errors[0]).toMatch(/--entry/)
  })

  test("iris.app.json naming a missing entry is an error", () => {
    const r = resolveManifest("x", { "iris.app.json": JSON.stringify({ entry: "nope.py" }) })
    expect(r.errors.join(" ")).toMatch(/not in the folder/)
  })
})

describe("buildServeScript — the security baseline is the default", () => {
  const m = resolveManifest("price-check", { "app.py": HEADER_APP }).manifest!
  const s = buildServeScript({ manifest: m, remoteDir: "/home/me/.iris/apps/price-check", hostPort: 18080, replace: false })

  test("local-only, locked down, supervised", () => {
    expect(s).toContain("-p '127.0.0.1:18080:8080'")
    expect(s).not.toMatch(/-p '?0\.0\.0\.0/)
    for (const flag of ["--user 65534:65534", "--cap-drop ALL", "--security-opt no-new-privileges", "--read-only", "--memory 512m", "--pids-limit 256", "--restart unless-stopped"]) {
      expect(s).toContain(flag)
    }
    expect(s).toContain("-v '/home/me/.iris/apps/price-check':/app:ro")
  })

  test("secrets pass by name only", () => {
    expect(s).toContain("-e STRIPE_KEY")
    expect(s).toContain("-e SLACK_TOKEN")
    expect(s).not.toMatch(/STRIPE_KEY=/)
  })

  test("never replaces a running app unless asked", () => {
    expect(s).toMatch(/EXISTS/)
    expect(s).not.toContain("docker rm -f")
    const r = buildServeScript({ manifest: m, remoteDir: "/d", hostPort: 18080, replace: true })
    expect(r).toContain("docker rm -f 'hiveapp-price-check'")
  })

  test("a quote in the folder path cannot break out", () => {
    const evil = buildServeScript({ manifest: m, remoteDir: "/tmp/x'; touch /tmp/pwned; '", hostPort: 18080, replace: false })
    expect(evil).toContain(`'/tmp/x'\\''; touch /tmp/pwned; '\\'''`)
  })

  test("labels make the machine its own registry", () => {
    expect(s).toContain("--label iris.hive-app='price-check'")
    expect(s).toContain("--label iris.app.kind=served")
    expect(s).toContain("--label iris.app.port=18080")
    expect(servedContainerName("price-check")).toBe("hiveapp-price-check")
  })
})

describe("list --hive", () => {
  test("script asks docker for IRIS apps only", () => {
    expect(buildListScript()).toContain("--filter name=^/hiveapp-")
  })

  test("parses rows and judges health", () => {
    const out = [
      "noise from the shell",
      "APP\thiveapp-price-check\tprice-check\tserved\t18080\trunning\tUp 3 hours\t200\t127.0.0.1:18080->8080/tcp",
      "APP\thiveapp-stirling\tstirling-pdf\tkit\t8090\trunning\tUp 2 days\t000\t127.0.0.1:8090->8080/tcp",
      "APP\thiveapp-old\told\tserved\t18081\texited\tExited (1) 5 minutes ago\t-\t",
    ].join("\n")
    const { apps, noDocker } = parseListOutput(out)
    expect(noDocker).toBe(false)
    expect(apps.map((a) => [a.app, a.healthy])).toEqual([["price-check", true], ["stirling-pdf", false], ["old", false]])
    expect(apps[0]!.port).toBe(18080)
  })

  test("an unlabelled kit (empty fields) keeps its columns", async () => {
    const { execFileSync } = await import("child_process")
    // Run the real loop against a fake docker that prints one labelled and one unlabelled row.
    const fake = `docker(){ case "$1" in ps) printf '%s\\n' 'hiveapp-a|a|served|18901|/healthz|running|Up 1 hour|127.0.0.1:18901->8000/tcp' 'hiveapp-stirling-pdf|||||running|Up 5 days|127.0.0.1:8090->8080/tcp';; esac; }; curl(){ printf 200; }; command(){ return 0; }`
    const out = execFileSync("sh", ["-c", `${fake}\n${buildListScript()}`]).toString()
    const { apps } = parseListOutput(out)
    expect(apps.map((x) => [x.app, x.kind, x.port, x.state, x.healthy])).toEqual([
      ["a", "served", 18901, "running", true],
      ["stirling-pdf", "kit", 8090, "running", true],
    ])
  })

  test("no docker is reported, not mistaken for no apps", () => {
    expect(parseListOutput("NO-DOCKER\n").noDocker).toBe(true)
  })
})

describe("lintLocalApp (#189082)", () => {
  const HOLEY = `
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        subprocess.run("iris agents pause " + self.path, shell=True)
        self.send_header("Access-Control-Allow-Origin", "*")
HTTPServer(("0.0.0.0", 8000), H).serve_forever()
`
  test("finds every hole in the Heartbeat Console shape", () => {
    const rules = lintLocalApp({ "server.py": HOLEY }).map((f) => f.rule).sort()
    expect(rules).toEqual(["allowlist", "bind-local", "check-host", "no-shell", "no-wildcard-cors", "require-token"])
  })

  test("the shipped template is clean", () => {
    const files = LOCAL_CONSOLE_FILES("my-console")
    expect(lintLocalApp(files)).toEqual([])
  })

  test("a comment mentioning shell=True is not a finding", () => {
    expect(lintLocalApp({ "x.py": "# never use shell=True\nprint(1)\n" })).toEqual([])
  })

  test("served apps must listen on all interfaces inside the container, not be told off for it", () => {
    const src = `from http.server import HTTPServer\nimport secrets\nTOKEN=secrets.token_urlsafe()\nok = self.headers.get("Host")\nHTTPServer(("0.0.0.0", 8000), None)\n`
    expect(lintLocalApp({ "app.py": src }, { served: true }).map((f) => f.rule)).not.toContain("bind-local")
    expect(lintLocalApp({ "app.py": src }).map((f) => f.rule)).toContain("bind-local")
  })

  test("reading HOST with a 0.0.0.0 fallback is a warning, not a refusal", () => {
    const src = `import os\nHTTPServer((os.environ.get("HOST", "0.0.0.0"), 8000), H)\n`
    const f = lintLocalApp({ "app.py": src })
    expect(f.map((x) => x.rule)).not.toContain("bind-local")
    expect(f.find((x) => x.rule === "bind-default")?.severity).toBe("warning")
  })

  test("the generated server.py is valid Python", async () => {
    const { execFileSync } = await import("child_process")
    const { mkdtempSync, writeFileSync } = await import("fs")
    const { tmpdir } = await import("os")
    const { join } = await import("path")
    const dir = mkdtempSync(join(tmpdir(), "console-"))
    writeFileSync(join(dir, "server.py"), LOCAL_CONSOLE_FILES("t")["server.py"]!)
    execFileSync("python3", ["-m", "py_compile", join(dir, "server.py")]) // throws on a syntax error
  })

  test("the template manifest resolves", () => {
    const r = resolveManifest("my-console", LOCAL_CONSOLE_FILES("my-console"))
    expect(r.errors).toEqual([])
    expect(r.manifest?.entry).toBe("server.py")
  })
})
