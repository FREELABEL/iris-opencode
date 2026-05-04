// Quick simulation of the recommendation logic.
// Runs against canned SSH probe outputs so we can verify each branch
// without needing a real remote machine.

import { spawnSync } from "child_process"
import { writeFileSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const SCENARIOS: Array<{
  name: string
  probeOutput: string
  expect: string
}> = [
  {
    name: "fresh machine — no iris",
    probeOutput: `UNAME=Darwin 23.5.0 arm64\nIRIS_PATH=\nDAEMON=stopped\n`,
    expect: "install",
  },
  {
    name: "iris installed but old version",
    probeOutput: `UNAME=Darwin 23.5.0 arm64\nIRIS_PATH=/usr/local/bin/iris\nIRIS_VERSION=1.0.50\nDAEMON=stopped\n`,
    expect: "upgrade",
  },
  {
    name: "iris current but not registered",
    probeOutput: `UNAME=Darwin 23.5.0 arm64\nIRIS_PATH=/usr/local/bin/iris\nIRIS_VERSION=1.3.28\nDAEMON=stopped\n`,
    expect: "reconfigure",
  },
  {
    name: "registered but daemon not running",
    probeOutput: `UNAME=Darwin 23.5.0 arm64\nIRIS_PATH=/usr/local/bin/iris\nIRIS_VERSION=1.3.28\nDAEMON=stopped\nNODE_KEY=node_live_abc123\nUSER_ID=42\n`,
    expect: "start-daemon",
  },
  {
    name: "fully healthy",
    probeOutput: `UNAME=Darwin 23.5.0 arm64\nIRIS_PATH=/usr/local/bin/iris\nIRIS_VERSION=1.3.28\nDAEMON=running\nNODE_KEY=node_live_abc123\nUSER_ID=42\n`,
    expect: "skip",
  },
  {
    name: "registered, daemon running, version unknown",
    probeOutput: `UNAME=Linux 6.5.0 x86_64\nIRIS_PATH=/home/alex/.iris/bin/iris\nIRIS_VERSION=\nDAEMON=running\nNODE_KEY=node_live_xyz\n`,
    expect: "skip",
  },
]

// Reproduce the parsing + decision logic from platform-hive-enroll.ts in
// isolation, so we can drive it with canned strings.

function parse(output: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=")
    if (eq < 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

function compareVersion(local: string, remote: string): "same" | "remote-older" | "remote-newer" | "unknown" {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10))
  const l = parts(local)
  const r = parts(remote)
  if (l.some(isNaN) || r.some(isNaN)) return "unknown"
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (r[i] ?? 0)) return "remote-older"
    if ((l[i] ?? 0) < (r[i] ?? 0)) return "remote-newer"
  }
  return "same"
}

function recommend(probe: Record<string, string>, localVersion: string): string {
  const irisPath = probe["IRIS_PATH"] || null
  const irisVersion = probe["IRIS_VERSION"] || null
  const daemonRunning = probe["DAEMON"] === "running"
  const hasKey = !!probe["NODE_KEY"]

  if (!irisPath) return "install"
  if (localVersion && irisVersion) {
    const cmp = compareVersion(localVersion, irisVersion)
    if (cmp === "remote-older") return "upgrade"
    if (!hasKey) return "reconfigure"
    if (!daemonRunning) return "start-daemon"
    return "skip"
  }
  if (!hasKey) return "reconfigure"
  if (!daemonRunning) return "start-daemon"
  return "skip"
}

const LOCAL_VERSION = "1.3.28"

let passed = 0
let failed = 0

for (const sc of SCENARIOS) {
  const probe = parse(sc.probeOutput)
  const got = recommend(probe, LOCAL_VERSION)
  const ok = got === sc.expect
  if (ok) {
    passed++
    console.log(`  ✓ ${sc.name}  →  ${got}`)
  } else {
    failed++
    console.log(`  ✗ ${sc.name}  →  got "${got}", expected "${sc.expect}"`)
  }
}

console.log()
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
