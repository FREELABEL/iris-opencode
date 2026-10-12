// ── iris app serve / list --hive / lint — the pure half ─────────────────────────────────────
//
// IRIS Hive Apps S1 (EPIC #188312, ADR-03 #189087): a customer's own script, served from one
// of their own machines. ADR-03 decided there is ONE noun — an App — whose manifest declares
// how it runs, so a "Hive Service" (#189080) is just an app with `run: server`, and "what is
// served where" (#189084) is `iris app list --hive`. Every decision that needs no network lives
// here, with its tests; platform-app.ts wires it to ssh and the API.
//
// The manifest (decided 2026-10-12):
//   * a one-file script declares itself in `# iris:` header lines — the format Hive Functions
//     already defined (#182272 S1: requires=, timeout=, expect-exit=), extended for serving;
//   * a multi-file app adds `iris.app.json`, which wins over the header when both exist.
//
// Security is the default, not a flag (#189083): the container binds 127.0.0.1 only, runs as
// nobody with every capability dropped, a read-only root, no privilege escalation, and memory,
// CPU and process limits. Exposing it beyond the machine is a separate, authenticated step
// (#189081) — nothing in this file opens a port to the network.

export const MANIFEST_FILE = "iris.app.json"

export type RunMode = "server" | "per-request"
export type DataClass = "public" | "internal" | "phi"

export interface AppManifest {
  name: string
  runtime: "python"
  entry: string
  run: RunMode
  /** Port the app listens on INSIDE the container. */
  port: number
  /** Path probed to decide the app is healthy. */
  health: string
  egress: string[]
  secrets: string[]
  data_class: DataClass
  requires: string[]
}

export interface ManifestResult {
  manifest: AppManifest | null
  errors: string[]
  /** Where the manifest came from — shown so a person can find what to edit. */
  source: "iris.app.json" | "header" | "defaults"
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/
const ENTRY_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*\.py$/
const SECRET_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const HOST_RE = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i

/**
 * Read `# iris: key=value` lines from the top of a script. Only the leading comment block counts —
 * a `# iris:` line in the middle of the code is code, not a declaration. Repeated keys append for
 * list keys (requires, egress, secrets) and overwrite otherwise.
 */
export function parseIrisHeader(source: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const LIST = new Set(["requires", "egress", "secrets"])
  for (const raw of String(source ?? "").split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#!")) continue
    if (!line.startsWith("#")) break
    const m = /^#\s*iris:\s*([a-z_-]+)\s*=\s*(.*)$/i.exec(line)
    if (!m) continue
    const key = m[1]!.toLowerCase().replace(/-/g, "_")
    const value = m[2]!.trim()
    if (LIST.has(key)) {
      const prev = (out[key] as string[] | undefined) ?? []
      out[key] = prev.concat(value.split(",").map((v) => v.trim()).filter(Boolean))
    } else out[key] = value
  }
  return out
}

/**
 * Validate a manifest from either source into one shape. Unknown keys are ignored; anything that
 * would be interpolated into a command or a URL is checked against a strict pattern, because a
 * manifest is customer-written and the node runs what it says.
 */
export function normaliseManifest(raw: Record<string, unknown>, fallbackName: string, fallbackEntry: string): { manifest: AppManifest | null; errors: string[] } {
  const errors: string[] = []
  const str = (k: string) => (raw[k] === undefined || raw[k] === null ? undefined : String(raw[k]).trim())
  const list = (k: string): string[] => {
    const v = raw[k]
    if (v === undefined || v === null || v === "") return []
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
    return String(v).split(",").map((x) => x.trim()).filter(Boolean)
  }

  const name = (str("name") ?? fallbackName).toLowerCase()
  if (!NAME_RE.test(name)) errors.push(`name "${name}" must be lowercase letters, digits and dashes (max 41)`)

  const runtime = str("runtime") ?? "python"
  if (runtime !== "python") errors.push(`runtime "${runtime}" is not supported yet — only python`)

  const entry = str("entry") ?? fallbackEntry
  if (!ENTRY_RE.test(entry) || entry.includes("..")) errors.push(`entry "${entry}" must be a .py path inside the app folder`)

  const run = (str("run") ?? "server") as RunMode
  if (run !== "server" && run !== "per-request") errors.push(`run "${run}" must be server or per-request`)
  if (run === "per-request") errors.push("run: per-request is a Hive Function — not servable yet (#188472); use run: server")

  const port = Number(str("port") ?? 8000)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) errors.push(`port ${str("port")} must be 1024–65535`)

  const health = str("health") ?? "/"
  if (!/^\/[A-Za-z0-9_./-]*$/.test(health)) errors.push(`health "${health}" must be a path like /health`)

  const egress = list("egress")
  for (const h of egress) if (h !== "none" && !HOST_RE.test(h)) errors.push(`egress "${h}" must be a host name (or none)`)

  const secrets = list("secrets")
  for (const s of secrets) if (!SECRET_RE.test(s)) errors.push(`secret "${s}" must be an UPPER_SNAKE env var name`)

  const data_class = (str("data_class") ?? "internal") as DataClass
  if (!["public", "internal", "phi"].includes(data_class)) errors.push(`data_class "${data_class}" must be public, internal or phi`)

  const requires = list("requires")

  if (errors.length) return { manifest: null, errors }
  return { manifest: { name, runtime: "python", entry, run, port, health, egress, secrets, data_class, requires }, errors }
}

/**
 * Resolve the manifest for an app folder from the files in it. `files` maps a relative path to
 * its text (only what is needed: iris.app.json and .py sources). iris.app.json wins; otherwise the
 * entry script's header; otherwise defaults, with the entry chosen only when it is unambiguous.
 */
export function resolveManifest(folderName: string, files: Record<string, string>, entryHint?: string): ManifestResult {
  const fallbackName = folderName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 41) || "app"

  if (files[MANIFEST_FILE] !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(files[MANIFEST_FILE]!)
    } catch (err) {
      return { manifest: null, errors: [`${MANIFEST_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`], source: "iris.app.json" }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { manifest: null, errors: [`${MANIFEST_FILE} must be a JSON object`], source: "iris.app.json" }
    }
    const { manifest, errors } = normaliseManifest(parsed as Record<string, unknown>, fallbackName, entryHint ?? "app.py")
    if (manifest && files[manifest.entry] === undefined) errors.push(`entry ${manifest.entry} is not in the folder`)
    return { manifest: errors.length ? null : manifest, errors, source: "iris.app.json" }
  }

  const py = Object.keys(files).filter((f) => f.endsWith(".py"))
  const entry = entryHint ?? (py.includes("app.py") ? "app.py" : py.includes("server.py") ? "server.py" : py.includes("main.py") ? "main.py" : py.length === 1 ? py[0] : undefined)
  if (!entry || files[entry] === undefined) {
    return { manifest: null, errors: [py.length ? `More than one .py file and no ${MANIFEST_FILE} — say which runs: --entry <file> or add ${MANIFEST_FILE}` : "No .py file found"], source: "defaults" }
  }
  const header = parseIrisHeader(files[entry]!)
  const { manifest, errors } = normaliseManifest(header, fallbackName, entry)
  return { manifest, errors, source: Object.keys(header).length ? "header" : "defaults" }
}

/** Single-quote for POSIX sh. */
export function shq(s: string | number): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

export const SERVE_EXIT = { NO_DOCKER: 3, EXISTS: 4 } as const

export const PYTHON_IMAGE = "python:3.12-slim"

export interface ServeScriptInput {
  manifest: AppManifest
  /** Absolute directory on the node holding the app's files. */
  remoteDir: string
  hostPort: number
  replace: boolean
}

export function servedContainerName(name: string): string {
  return `hiveapp-${name}`
}

/**
 * The script the node runs to serve an app. The defaults ARE the security baseline (#189083):
 *   - 127.0.0.1 only — exposure is a separate authenticated step (#189081);
 *   - runs as nobody, every capability dropped, no privilege escalation, read-only root;
 *   - the app folder is mounted READ-ONLY; dependencies install into a tmpfs;
 *   - memory, CPU and process caps, so one app cannot starve the machine;
 *   - restarts on crash and on reboot (docker's unless-stopped) — the supervision #189080 asked for;
 *   - labels carry what `list --hive` needs, so the machine itself is the registry.
 * Secrets are passed by NAME only (`-e NAME` copies the node's env var); values never appear in
 * the command line, the task log or this script.
 *
 * NOT ENFORCED HERE: `egress`. `--network none` would also cut the published port, so outbound
 * limits need a per-container firewall on the node (#182272 S2.3). The manifest records the
 * declaration now so enforcement can arrive without customers rewriting their apps.
 */
export function buildServeScript(i: ServeScriptInput): string {
  const m = i.manifest
  const name = servedContainerName(m.name)
  const n = shq(name)
  const dir = shq(i.remoteDir)
  const install = `if [ -f /app/requirements.txt ]; then pip install --quiet --no-cache-dir --target /tmp/deps -r /app/requirements.txt || exit 1; fi`
  const start = `${install}; exec python /app/${m.entry}`
  const labels = [
    `--label iris.hive-app=${shq(m.name)}`,
    `--label iris.app.kind=served`,
    `--label iris.app.health=${shq(m.health)}`,
    `--label iris.app.port=${i.hostPort}`,
    `--label iris.app.data-class=${m.data_class}`,
  ].join(" ")
  const secrets = m.secrets.map((s) => `-e ${s}`).join(" ")
  return [
    "set -u",
    `command -v docker >/dev/null 2>&1 || { echo "NO-DOCKER: this machine has no docker on PATH"; exit ${SERVE_EXIT.NO_DOCKER}; }`,
    `[ -f ${shq(`${i.remoteDir}/${m.entry}`)} ] || { echo "MISSING: ${m.entry} is not in ${i.remoteDir}"; exit 2; }`,
    `if docker inspect ${n} >/dev/null 2>&1; then`,
    i.replace
      ? `  echo "REPLACING existing ${name}"; docker rm -f ${n} >/dev/null`
      : `  echo "EXISTS: ${name} is already on this machine"; docker ps -a --filter name=^/${name}$ --format '{{.Status}}  {{.Ports}}'; exit ${SERVE_EXIT.EXISTS}`,
    "fi",
    [
      `docker run -d --name ${n} --restart unless-stopped ${labels}`,
      `-p ${shq(`127.0.0.1:${i.hostPort}:${m.port}`)}`,
      `-v ${dir}:/app:ro --workdir /app`,
      `--user 65534:65534 --cap-drop ALL --security-opt no-new-privileges`,
      `--read-only --tmpfs /tmp:rw,size=512m,exec`,
      `--memory 512m --cpus 1 --pids-limit 256`,
      `-e PORT=${m.port} -e PYTHONPATH=/tmp/deps -e PYTHONUNBUFFERED=1 -e HOME=/tmp ${secrets}`,
      `${PYTHON_IMAGE} sh -c ${shq(start)} || exit $?`,
    ].filter(Boolean).join(" "),
    `docker ps --filter name=^/${name}$ --format 'STARTED {{.Names}}  {{.Status}}  {{.Ports}}'`,
  ].join("\n")
}

/** Probe the app's health path on the node until it answers 2xx/3xx or time runs out. */
export function buildHealthScript(hostPort: number, path: string, waitSec: number): string {
  const tries = Math.max(1, Math.ceil(waitSec / 2))
  return [
    "c=000",
    `for i in $(seq 1 ${tries}); do`,
    `  c=$(curl -s -o /dev/null -w '%{http_code}' ${shq(`http://127.0.0.1:${hostPort}${path}`)} || true)`,
    `  case "$c" in 2??|3??) echo "READY http=$c after $((i*2))s"; exit 0;; esac`,
    "  sleep 2",
    "done",
    `echo "NOT-READY last http=$c after ${tries * 2}s"`,
    "exit 1",
  ].join("\n")
}

// ── list --hive: the machine is the registry ────────────────────────────────────────────────

/**
 * One line per IRIS container, then its health probe. Tab-separated so parsing is exact.
 * Matched by NAME (every IRIS container is hiveapp-*), not label: kits started before labels
 * existed carry none, and a registry that silently omits them is exactly the "what runs where"
 * question answered wrong. Port falls back to the published 127.0.0.1 mapping.
 */
export function buildListScript(): string {
  return [
    "command -v docker >/dev/null 2>&1 || { echo 'NO-DOCKER'; exit 0; }",
    // '|' not tab: tab is IFS whitespace, so empty fields (an unlabelled kit) would collapse.
    `docker ps -a --filter name=^/hiveapp- --format '{{.Names}}|{{.Label "iris.hive-app"}}|{{.Label "iris.app.kind"}}|{{.Label "iris.app.port"}}|{{.Label "iris.app.health"}}|{{.State}}|{{.Status}}|{{.Ports}}' | while IFS='|' read -r name app kind port health state status ports; do`,
    `  [ -n "$app" ] || app=\${name#hiveapp-}`,
    `  [ -n "$port" ] || port=$(printf '%s' "$ports" | sed -n 's/.*127\\.0\\.0\\.1:\\([0-9][0-9]*\\)->.*/\\1/p' | head -n1)`,
    `  code=-`,
    `  if [ "$state" = running ] && [ -n "$port" ]; then code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port\${health:-/}" || echo 000); fi`,
    `  printf 'APP\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$app" "\${kind:-kit}" "$port" "$state" "$status" "$code" "$ports"`,
    "done",
  ].join("\n")
}

export interface ServedApp {
  container: string
  app: string
  kind: string
  port: number | null
  state: string
  status: string
  http: string
  ports: string
  healthy: boolean
}

export function parseListOutput(out: string): { apps: ServedApp[]; noDocker: boolean } {
  const apps: ServedApp[] = []
  let noDocker = false
  for (const line of String(out ?? "").split(/\r?\n/)) {
    if (line.trim() === "NO-DOCKER") noDocker = true
    if (!line.startsWith("APP\t")) continue
    const [, container, app, kind, port, state, status, http, ports] = line.split("\t")
    const p = Number(port)
    apps.push({
      container: container ?? "", app: app ?? "", kind: kind || "kit",
      port: Number.isInteger(p) && p > 0 ? p : null,
      state: state ?? "", status: status ?? "", http: http ?? "-", ports: ports ?? "",
      healthy: state === "running" && /^[23]\d\d$/.test(http ?? ""),
    })
  }
  return { apps, noDocker }
}

// ── lint: the holes an agent-built local console must not have (#189082) ───────────────────

export interface LintFinding {
  severity: "error" | "warning"
  file: string
  rule: string
  message: string
}

/**
 * Static checks for a local console — the Heartbeat Console shape (a localhost server that runs
 * `iris` as the user). Aimed at the honest author and the agent that generates these, not at a
 * determined adversary; the runtime defaults in buildServeScript are the control.
 */
export function lintLocalApp(files: Record<string, string>, opts: { served?: boolean } = {}): LintFinding[] {
  const out: LintFinding[] = []
  const py = Object.entries(files).filter(([f]) => f.endsWith(".py"))
  const strip = (s: string) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join("\n")
  for (const [file, rawSrc] of py) {
    const src = strip(rawSrc)
    const servesHttp = /http\.server|BaseHTTPRequestHandler|from\s+flask|import\s+flask|fastapi|aiohttp\.web|uvicorn|bottle/i.test(src)
    if (/shell\s*=\s*True/.test(src)) out.push({ severity: "error", file, rule: "no-shell", message: "subprocess with shell=True — pass an argument list instead; request data must never reach a shell" })
    if (/os\.system\s*\(|os\.popen\s*\(/.test(src)) out.push({ severity: "error", file, rule: "no-shell", message: "os.system/os.popen run a shell — use subprocess.run([...]) with an argument list" })
    // Inside a served container 0.0.0.0 is REQUIRED (docker publishes it on the host's 127.0.0.1);
    // on a desktop it exposes the console to the whole network.
    // Reading the address from HOST (which the launcher sets to 127.0.0.1) is the right shape; a
    // 0.0.0.0 that is only the FALLBACK default is a warning, not a refusal (stress test 2026-10-12:
    // the refusal blocked a correct app).
    const readsHost = /environ(\.get)?\s*[\[(]\s*["']HOST["']|getenv\(\s*["']HOST["']/.test(src)
    const wildcard = /["']0\.0\.0\.0["']|host\s*=\s*["']["']|\(\s*["']["']\s*,\s*\d+\s*\)/.test(src)
    if (!opts.served && wildcard && !readsHost) out.push({ severity: "error", file, rule: "bind-local", message: "binds to every interface — bind 127.0.0.1 so only this machine can reach it" })
    if (!opts.served && wildcard && readsHost) out.push({ severity: "warning", file, rule: "bind-default", message: "falls back to 0.0.0.0 when HOST is unset (e.g. run by hand) — make the fallback 127.0.0.1" })
    if (opts.served && /["']127\.0\.0\.1["']|["']localhost["']/.test(src) && !/["']0\.0\.0\.0["']/.test(src)) out.push({ severity: "warning", file, rule: "served-bind", message: "served apps run in a container — listen on 0.0.0.0:$PORT inside it (the host still only exposes 127.0.0.1)" })
    if (servesHttp) {
      if (!/secrets\.(token_urlsafe|token_hex)|IRIS_CONSOLE_TOKEN/.test(src)) out.push({ severity: "error", file, rule: "require-token", message: "no per-launch token — any website you visit can send requests to a localhost server; require a random token on every request" })
      // Must READ the request header — merely mentioning Origin (e.g. Access-Control-Allow-Origin)
      // is not a check, and was how this rule first passed a file with no check at all.
      if (!/headers(\.get\(|\[)\s*["'](Host|Origin)["']|request\.(host|origin)\b|META\[["']HTTP_(HOST|ORIGIN)["']\]/i.test(src)) out.push({ severity: "error", file, rule: "check-host", message: "no Host/Origin check — accept only 127.0.0.1/localhost (stops DNS rebinding)" })
      if (/["']\*["']/.test(src) && /Access-Control-Allow-Origin/i.test(src)) out.push({ severity: "error", file, rule: "no-wildcard-cors", message: "Access-Control-Allow-Origin: * lets every site read the answers" })
    }
    if (/subprocess\./.test(src) && !/ALLOWED|ALLOWLIST|allowlist|allowed_commands/i.test(src)) out.push({ severity: "warning", file, rule: "allowlist", message: "runs subprocesses without an allowlist — name exactly which commands it may run" })
  }
  return out
}
