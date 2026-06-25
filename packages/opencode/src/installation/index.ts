import { BusEvent } from "@/bus/bus-event"
import path from "path"
import { $ } from "bun"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { Log } from "../util/log"
import { iife } from "@/util/iife"
import { Flag } from "../flag/flag"

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export namespace Installation {
  const log = Log.create({ service: "installation" })

  export type Method = Awaited<ReturnType<typeof method>>

  export const Event = {
    Updated: BusEvent.define(
      "installation.updated",
      z.object({
        version: z.string(),
      }),
    ),
    UpdateAvailable: BusEvent.define(
      "installation.update-available",
      z.object({
        version: z.string(),
      }),
    ),
  }

  export const Info = z
    .object({
      version: z.string(),
      latest: z.string(),
    })
    .meta({
      ref: "InstallationInfo",
    })
  export type Info = z.infer<typeof Info>

  export async function info() {
    return {
      version: VERSION,
      latest: await latest(),
    }
  }

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  export function isIris() {
    return (
      process.execPath.includes(path.join(".iris", "bin")) ||
      process.execPath.includes("iris") ||
      process.env.IRIS_MODE === "true"
    )
  }

  export async function method() {
    if (process.execPath.includes(path.join(".iris", "bin"))) return "curl"
    if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl"
    if (process.execPath.includes(path.join(".local", "bin"))) return "curl"
    const exec = process.execPath.toLowerCase()

    const checks = [
      {
        name: "npm" as const,
        command: () => $`npm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "yarn" as const,
        command: () => $`yarn global list`.throws(false).quiet().text(),
      },
      {
        name: "pnpm" as const,
        command: () => $`pnpm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "bun" as const,
        command: () => $`bun pm ls -g`.throws(false).quiet().text(),
      },
      {
        name: "brew" as const,
        command: () => $`brew list --formula opencode`.throws(false).quiet().text(),
      },
    ]

    checks.sort((a, b) => {
      const aMatches = exec.includes(a.name)
      const bMatches = exec.includes(b.name)
      if (aMatches && !bMatches) return -1
      if (!aMatches && bMatches) return 1
      return 0
    })

    for (const check of checks) {
      const output = await check.command()
      if (output.includes(check.name === "brew" ? "opencode" : "opencode-ai")) {
        return check.name
      }
    }

    return "unknown"
  }

  export const UpgradeFailedError = NamedError.create(
    "UpgradeFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  async function getBrewFormula() {
    const tapFormula = await $`brew list --formula sst/tap/opencode`.throws(false).quiet().text()
    if (tapFormula.includes("opencode")) return "sst/tap/opencode"
    const coreFormula = await $`brew list --formula opencode`.throws(false).quiet().text()
    if (coreFormula.includes("opencode")) return "opencode"
    return "opencode"
  }

  export async function upgrade(method: Method, target: string) {
    let cmd

    if (isIris()) {
      // IRIS: download binary directly from GitHub release (don't re-run full installer)
      const platform = process.platform === "darwin" ? "darwin" : "linux"
      const arch = process.arch === "arm64" ? "arm64" : "x64"
      const ext = platform === "linux" ? "tar.gz" : "zip"
      const assetName = `iris-${platform}-${arch}.${ext}`
      const releaseUrl = `https://github.com/FREELABEL/iris-opencode/releases/download/v${target}/${assetName}`
      // Resolve symlinks to get the real binary path
      const realExecPath = await import("fs").then(fs => fs.realpathSync(process.execPath))
      const binDir = path.dirname(realExecPath)
      const tmpDir = path.join(binDir, ".iris-update-tmp")

      // Use a script file to avoid Bun template literal interpolation issues
      const home = process.env.HOME || process.env.USERPROFILE || "/tmp"
      const irisDir = path.join(home, ".iris")
      const script = `#!/bin/bash
set -e
mkdir -p "${tmpDir}"
cd "${tmpDir}"
curl -fsSL -o "${assetName}" "${releaseUrl}"
if [ "${ext}" = "tar.gz" ]; then
  tar -xzf "${assetName}"
else
  unzip -o "${assetName}"
fi
chmod +x iris
xattr -cr iris 2>/dev/null || true
# cd out of tmpDir BEFORE deleting it (avoids 'cwd deleted' errors)
cd "${binDir}"
# Remove old binary first (avoids overwriting a running executable)
rm -f "${binDir}/iris"
mv "${tmpDir}/iris" "${binDir}/iris"
rm -rf "${tmpDir}"
# Verify the new binary works
"${binDir}/iris" --version

# ─── Post-update: Update daemon/bridge code ───
BRIDGE_DIR="${irisDir}/bridge"
if [ -d "$BRIDGE_DIR" ] && [ -d "$BRIDGE_DIR/.git" ]; then
  echo "Updating Hive daemon..."
  # Pin the bridge to main and self-heal branch drift (#133629) — a node stranded
  # on a stale/feature branch would pull old code forever. Untracked runtime state
  # (sessions, caches) survives a checkout -B.
  (cd "$BRIDGE_DIR" && git fetch origin --quiet 2>/dev/null && git checkout -B main origin/main --quiet 2>/dev/null && npm install --production --silent 2>/dev/null) || true
fi

# ─── Post-update: Fix stale API URLs in daemon config ───
CONFIG_FILE="${irisDir}/config.json"
if [ -f "$CONFIG_FILE" ]; then
  # Replace any stale DO/heyiris URLs with freelabel.net
  if grep -qE 'ondigitalocean\\.app|main\\.heyiris\\.io|apiv2\\.heyiris\\.io' "$CONFIG_FILE" 2>/dev/null; then
    echo "Fixing stale API URL in daemon config..."
    sed -i.bak \\
      -e 's|https://[^"]*ondigitalocean\\.app[^"]*|https://freelabel.net|g' \\
      -e 's|https://main\\.heyiris\\.io[^"]*|https://freelabel.net|g' \\
      -e 's|https://apiv2\\.heyiris\\.io[^"]*|https://freelabel.net|g' \\
      "$CONFIG_FILE" && rm -f "$CONFIG_FILE.bak"
  fi
fi

# ─── Post-update: Sync IRIS chat token (opencode auth.json) from SDK .env ───
# The chat provider resolves its token from opencode auth.json BEFORE ~/.iris/sdk/.env.
# Every legit writer (iris auth login / --token) writes both together, so if auth.json's
# "iris" key drifts from .env it is STALE — heal it here so the chat never authes with an
# old key ("Unauthorized: token not authorized for this endpoint" on fresh client installs).
ENV_FILE="${irisDir}/sdk/.env"
AUTH_DIR="$XDG_DATA_HOME"
if [ -z "$AUTH_DIR" ]; then AUTH_DIR="$HOME/.local/share"; fi
AUTH_FILE="$AUTH_DIR/opencode/auth.json"
if [ -f "$ENV_FILE" ] && command -v python3 >/dev/null 2>&1; then
  python3 - "$AUTH_FILE" "$ENV_FILE" <<'PYEOF' || true
import json, os, sys
auth_file, env_file = sys.argv[1], sys.argv[2]
key = None
try:
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line.startswith("IRIS_API_KEY="):
                key = line.split("=", 1)[1].strip()
                break
except FileNotFoundError:
    sys.exit(0)
if not key:
    sys.exit(0)
data = {}
if os.path.exists(auth_file):
    try:
        with open(auth_file) as f:
            data = json.load(f)
    except Exception:
        data = {}
cur = data.get("iris") or {}
if cur.get("type") == "api" and cur.get("key") == key:
    sys.exit(0)  # already in sync
data["iris"] = {"type": "api", "key": key}
os.makedirs(os.path.dirname(auth_file), exist_ok=True)
with open(auth_file, "w") as f:
    json.dump(data, f, indent=2)
os.chmod(auth_file, 0o600)
print("Synced IRIS chat token from SDK .env into auth.json")
PYEOF
fi

# ─── Post-update: register IRIS MCP server into real clients (#152284) ───
# The bespoke ~/.iris/mcp.json is kept only as a reference scaffold — NO MCP
# client reads it. Real wiring is done by 'iris mcp install', which registers
# 'iris mcp serve' into every detected client (Claude Code/Desktop/Cursor/
# opencode) with an ABSOLUTE binary path so GUI clients (no login shell) resolve
# it. Running it on every update also wires existing users on upgrade.
MCP_CONFIG="${irisDir}/mcp.json"
if [ ! -f "$MCP_CONFIG" ]; then
  cat > "$MCP_CONFIG" << 'MCPEOF'
{
  "_comment": "Reference scaffold only — real wiring lives in your editor's config via 'iris mcp install'. Run 'iris mcp list' to verify.",
  "mcpServers": {
    "IRIS OS": {
      "command": "iris",
      "args": ["mcp", "serve"],
      "enabled": true
    }
  }
}
MCPEOF
fi

IRIS_BIN="${irisDir}/bin/iris"
if [ -x "$IRIS_BIN" ]; then
  if "$IRIS_BIN" mcp install >/dev/null 2>&1; then
    echo "Registered IRIS MCP server with your editors (verify: iris mcp list)"
  fi
fi

# ─── Post-update: Restart daemon if it was running ───
DAEMON_SOCK="${irisDir}/daemon.sock"
if [ -S "$DAEMON_SOCK" ]; then
  echo "Restarting Hive daemon with updated code..."
  DAEMON_PID=$(lsof -ti :3200 2>/dev/null || true)
  if [ -n "$DAEMON_PID" ]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    sleep 2
  fi
  rm -f "$DAEMON_SOCK"
  if [ -f "$BRIDGE_DIR/daemon.js" ]; then
    nohup node "$BRIDGE_DIR/daemon.js" > "$BRIDGE_DIR/daemon.log" 2>&1 &
    sleep 3
    if [ -S "$DAEMON_SOCK" ]; then
      echo "Daemon restarted successfully"
    else
      echo "Daemon restart failed. Check: iris-daemon logs"
    fi
  fi
fi
`
      const scriptPath = path.join(tmpDir + "-script.sh")
      await import("fs").then(fs => {
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
        fs.writeFileSync(scriptPath, script, { mode: 0o755 })
      })
      cmd = $`bash ${scriptPath} && rm -f ${scriptPath}`.env({ ...process.env })
    } else {
      switch (method) {
        case "curl":
          cmd = $`curl -fsSL https://opencode.ai/install | bash`.env({
            ...process.env,
            VERSION: target,
          })
          break
        case "npm":
          cmd = $`npm install -g opencode-ai@${target}`
          break
        case "pnpm":
          cmd = $`pnpm install -g opencode-ai@${target}`
          break
        case "bun":
          cmd = $`bun install -g opencode-ai@${target}`
          break
        case "brew": {
          const formula = await getBrewFormula()
          cmd = $`brew install ${formula}`.env({
            HOMEBREW_NO_AUTO_UPDATE: "1",
            ...process.env,
          })
          break
        }
        default:
          throw new Error(`Unknown method: ${method}`)
      }
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp"
    const result = await cmd.cwd(homeDir).quiet().throws(false)
    log.info("upgraded", {
      method: isIris() ? "iris-installer" : method,
      target,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    })
    if (result.exitCode !== 0)
      throw new UpgradeFailedError({
        stderr: result.stderr.toString("utf8"),
      })
    await $`${process.execPath} --version`.cwd(homeDir).nothrow().quiet().text()
  }

  export const VERSION = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
  export const CHANNEL = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
  export const USER_AGENT = `opencode/${CHANNEL}/${VERSION}/${Flag.OPENCODE_CLIENT}`

  export async function latest(installMethod?: Method) {
    // IRIS: check our own GitHub releases
    if (isIris()) {
      return fetch("https://api.github.com/repos/FREELABEL/iris-opencode/releases/latest")
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.tag_name.replace(/^v/, ""))
    }

    const detectedMethod = installMethod || (await method())

    if (detectedMethod === "brew") {
      const formula = await getBrewFormula()
      if (formula === "opencode") {
        return fetch("https://formulae.brew.sh/api/formula/opencode.json")
          .then((res) => {
            if (!res.ok) throw new Error(res.statusText)
            return res.json()
          })
          .then((data: any) => data.versions.stable)
      }
    }

    if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
      const registry = await iife(async () => {
        const r = (await $`npm config get registry`.quiet().nothrow().text()).trim()
        const reg = r || "https://registry.npmjs.org"
        return reg.endsWith("/") ? reg.slice(0, -1) : reg
      })
      const channel = CHANNEL
      return fetch(`${registry}/opencode-ai/${channel}`)
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    return fetch("https://api.github.com/repos/anomalyco/opencode/releases/latest")
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText)
        return res.json()
      })
      .then((data: any) => data.tag_name.replace(/^v/, ""))
  }
}
