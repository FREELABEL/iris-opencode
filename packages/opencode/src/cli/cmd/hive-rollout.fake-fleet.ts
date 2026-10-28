// A fake Hive for the rollout tests (#191614). Each fake node is a temp HOME with a fake `iris`
// (CLI version, `daemon update --help/--dry-run/--detach-restart`, `update`), a fake `curl` for
// the daemon's /health, and the helper's ~/.iris/daemon-update/last.json. The scripts the rollout
// generates run for real under bash against that HOME, so the probe/verify parsing is tested on
// what the scripts actually print. Nothing here talks to a network or a real node.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { FleetNode, RolloutDeps, TaskOutcome } from "./hive-rollout"

export const OLD = "ccd10f8" + "0".repeat(33)
export const TARGET = "fbbfe22" + "1".repeat(33)

export type Behavior = "updated" | "updated-but-old-running" | "rolled-back" | "helper-dies" | "start-fails"

export type FakeSpec = {
  name: string
  id?: string
  online?: boolean
  os?: string
  lastHeartbeat?: string
  cli?: string //               what `iris --version` prints
  hasUpdate?: boolean //        does `daemon update --help` list --detach-restart
  cliAfter?: string //          what `iris update` installs
  hasUpdateAfter?: boolean
  health?: string | null //     the commit /health reports (null = daemon not answering)
  hubVersion?: string | null // daemon_version in the hub record
  hubLags?: boolean //          the hub never picks up the new version (#191641)
  plan?: any //                 the dry-run JSON this node prints
  planAfterCli?: any //         the dry-run JSON after `iris update`
  behavior?: Behavior
  kept?: string[]
  unreachable?: boolean //      tasks never come back
  dropsDuringUpdate?: boolean //the update task is never answered (machine fell off the network)
  dispatchFailsDuringUpdate?: boolean // the hub refuses to dispatch the update (node went offline)
}

export function dryPlan(o: { from?: string | null; upToDate?: boolean; modified?: string[]; missing?: string[]; untracked?: string[]; kept?: string[]; conflicts?: string[]; deps?: boolean; oldCli?: boolean; kind?: string; blocked?: string | null } = {}): any {
  const modified = o.modified ?? []
  const missing = o.missing ?? []
  const untracked = o.untracked ?? o.kept ?? []
  const kept = o.kept ?? []
  const conflicts = o.conflicts ?? []
  const blocking = o.oldCli ? modified.length + missing.length + untracked.length : modified.length + missing.length + conflicts.length
  const blocked = o.blocked !== undefined ? o.blocked : o.kind === "unknown" || blocking > 0 ? "the current install has local changes to files the update ships (listed above). Re-run with --force" : null
  const plan: any = {
    current: { kind: o.kind ?? "manifest", commit: o.from === undefined ? OLD : o.from, modified, untracked, missing },
    target: TARGET,
    upToDate: Boolean(o.upToDate),
    filesChanged: { added: ["lib/b.js"], removed: [], modified: ["lib/a.js"] },
    depsChanged: Boolean(o.deps),
    depsReason: o.deps ? "package-lock.json changed" : "package-lock.json unchanged — reusing node_modules",
    carryOver: [".env"],
    blocked,
  }
  if (!o.oldCli) {
    plan.keptYours = kept
    plan.untrackedConflicts = conflicts
  }
  return { ok: true, status: "dry-run", from: plan.current.commit, to: TARGET, plan }
}

const FAKE_IRIS = `#!/bin/bash
F="$HOME/fake"; echo "$*" >> "$F/calls"
case "$1" in
  --version) cat "$F/cli"; exit 0 ;;
  update)
    [ -f "$F/cli_after" ] && cp "$F/cli_after" "$F/cli"
    [ -f "$F/has_update_after" ] && touch "$F/has_update"
    [ -f "$F/plan_after_cli.json" ] && cp "$F/plan_after_cli.json" "$F/plan.json"
    echo "IRIS CLI Update"; echo "updated to $(cat "$F/cli")"; exit 0 ;;
  daemon)
    [ "$2" = "update" ] || exit 2
    if [ "$3" = "--help" ]; then echo "iris daemon update"; [ -f "$F/has_update" ] && echo "  --detach-restart  for Hive tasks"; exit 0; fi
    REF=""; DRY=0; prev=""
    for a in "$@"; do [ "$prev" = "--ref" ] && REF="$a"; [ "$a" = "--dry-run" ] && DRY=1; prev="$a"; done
    if [ "$DRY" = 1 ]; then cat "$F/plan.json"; exit 0; fi
    B="$(cat "$F/behavior")"
    if [ "$B" = "start-fails" ]; then echo "blocked: the current install has local changes"; exit 1; fi
    L="$HOME/.iris/daemon-update/last.json"; mkdir -p "$(dirname "$L")"
    NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    DL=60; [ "$B" = "helper-dies" ] && DL=1
    echo "{\\"ok\\":true,\\"status\\":\\"restart-scheduled\\",\\"to\\":\\"$REF\\",\\"deadline_s\\":$DL,\\"at\\":\\"$NOW\\"}" > "$L"
    echo "  restart helper: setsid"
    echo "✓ restart-scheduled  ccd10f8 → \${REF:0:7}"
    case "$B" in
      updated) ( sleep 0.3; echo "$REF" > "$F/health"; echo "{\\"ok\\":true,\\"status\\":\\"updated\\",\\"to\\":\\"$REF\\",$(cat "$F/kept_json" 2>/dev/null)\\"at\\":\\"$NOW\\"}" > "$L" ) >/dev/null 2>&1 & ;;
      updated-but-old-running) ( sleep 0.3; echo "{\\"ok\\":true,\\"status\\":\\"updated\\",\\"to\\":\\"$REF\\",\\"at\\":\\"$NOW\\"}" > "$L" ) >/dev/null 2>&1 & ;;
      rolled-back) ( sleep 0.3; echo "{\\"ok\\":false,\\"status\\":\\"rolled-back\\",\\"to\\":\\"$REF\\",\\"detail\\":\\"it never answered /health; the previous version is running again\\",\\"at\\":\\"$NOW\\"}" > "$L" ) >/dev/null 2>&1 & ;;
    esac
    exit 0 ;;
esac
exit 2
`

const FAKE_CURL = `#!/bin/bash
F="$HOME/fake"
[ -s "$F/health" ] || exit 7
printf '{"status":"ok","daemon_commit":"%s","daemon_version":"2.0.0+%s","providers":["x"]}' "$(cat "$F/health")" "$(cat "$F/health")"
`

export type FakeFleet = {
  deps: RolloutDeps
  root: string
  home(name: string): string
  calls(name: string): string[]
  logs: string[]
  dispatched: Array<{ node: string; title: string; script: string }>
  cleanup(): void
}

export function fakeFleet(specs: FakeSpec[], o: { localName?: string; localCli?: string } = {}): FakeFleet {
  const root = mkdtempSync(join(tmpdir(), "rollout-fleet-"))
  const homes = new Map<string, string>()
  const byId = new Map<string, FakeSpec>()
  specs.forEach((s, i) => {
    const id = s.id ?? `node-${i}-${s.name}`
    s.id = id
    byId.set(id, s)
    const home = join(root, id)
    homes.set(id, home)
    const f = join(home, "fake")
    mkdirSync(join(home, ".iris", "bin"), { recursive: true })
    mkdirSync(join(home, "fakebin"), { recursive: true })
    mkdirSync(f, { recursive: true })
    writeFileSync(join(home, ".iris", "bin", "iris"), FAKE_IRIS)
    chmodSync(join(home, ".iris", "bin", "iris"), 0o755)
    writeFileSync(join(home, "fakebin", "curl"), FAKE_CURL)
    chmodSync(join(home, "fakebin", "curl"), 0o755)
    writeFileSync(join(f, "cli"), (s.cli ?? "1.5.22") + "\n")
    if (s.hasUpdate ?? true) writeFileSync(join(f, "has_update"), "")
    if (s.cliAfter) writeFileSync(join(f, "cli_after"), s.cliAfter + "\n")
    if (s.hasUpdateAfter) writeFileSync(join(f, "has_update_after"), "")
    if (s.health !== null) writeFileSync(join(f, "health"), s.health ?? OLD)
    writeFileSync(join(f, "plan.json"), JSON.stringify(s.plan ?? dryPlan()))
    if (s.planAfterCli) writeFileSync(join(f, "plan_after_cli.json"), JSON.stringify(s.planAfterCli))
    writeFileSync(join(f, "behavior"), s.behavior ?? "updated")
    if (s.kept?.length) writeFileSync(join(f, "kept_json"), `"kept":${JSON.stringify(s.kept)},`)
  })

  const hubNode = (s: FakeSpec): FleetNode => {
    const home = homes.get(s.id!)!
    const health = existsSync(join(home, "fake", "health")) ? readFileSync(join(home, "fake", "health"), "utf8").trim() : null
    const v = s.hubLags || !health ? (s.hubVersion === undefined ? `2.0.0+${OLD}` : s.hubVersion) : `2.0.0+${health}`
    const os = s.os ?? "darwin-arm64"
    return {
      id: s.id!,
      name: s.name,
      connection_status: s.online === false ? "offline" : "online",
      last_heartbeat_at: s.lastHeartbeat ?? new Date().toISOString(),
      daemon_version: v,
      hardware_profile: { os: { label: os, platform: os.split("-")[0] } },
    }
  }

  const logs: string[] = []
  const dispatched: FakeFleet["dispatched"] = []
  let taskN = 0
  const deps: RolloutDeps = {
    listNodes: async () => specs.map(hubNode),
    resolveRef: async (ref) => (ref === "main" ? TARGET : ref),
    async run(node, script, t): Promise<TaskOutcome> {
      const s = byId.get(node.id)!
      dispatched.push({ node: node.name, title: t.title, script })
      const taskId = `task-${++taskN}`
      if (s.online === false) return { finished: false, exit_code: null, stdout: "", stderr: "", error: "HTTP 409 node offline", taskId }
      if (s.unreachable) return { finished: false, exit_code: null, stdout: "", stderr: "", taskId }
      if (s.dispatchFailsDuringUpdate && script.includes("--detach-restart --restart-delay")) {
        return { finished: false, exit_code: null, stdout: "", stderr: "", error: "HTTP 409 node went offline", taskId }
      }
      if (s.dropsDuringUpdate && script.includes("--detach-restart --restart-delay")) {
        return { finished: false, exit_code: null, stdout: "", stderr: "", taskId }
      }
      const home = homes.get(node.id)!
      const p = Bun.spawn(["bash", "-c", script], { env: { ...process.env, HOME: home, IRIS_HOME: "", PATH: `${join(home, "fakebin")}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      const code = await p.exited
      return { finished: true, exit_code: code, stdout, stderr, taskId }
    },
    cancel: async () => {},
    localNodeId: async () => (o.localName ? (specs.find((s) => s.name === o.localName)?.id ?? null) : null),
    localCliVersion: o.localCli ?? "1.5.22",
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 150))),
    now: () => Date.now(),
    log: (s) => logs.push(s),
  }
  return {
    deps,
    root,
    home: (name) => homes.get(specs.find((s) => s.name === name)!.id!)!,
    calls: (name) => {
      const f = join(homes.get(specs.find((s) => s.name === name)!.id!)!, "fake", "calls")
      return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : []
    },
    logs,
    dispatched,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
