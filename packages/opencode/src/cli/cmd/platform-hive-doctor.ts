/**
 * `iris hive doctor` — run the local health checks on the OTHER machine (#182019).
 *
 * bridge:doctor, `iris permissions check` and `iris hive nodes show` all answer "is this
 * machine healthy". All three only answered it for the machine you were typing on. So
 * diagnosing the second Mac on 2026-08-23 meant ssh-ing in by hand, finding the launchd
 * plist, tailing 1.5MB of stderr and grepping it. Everything needed already existed; none of
 * it was reachable.
 *
 * ── THE DISTINCTION THIS TOOL EXISTS TO MAKE ────────────────────────────────────────────
 *
 * A permission probe run over ssh measures THE SSH SESSION's privacy grants, not the
 * daemon's. They are different principals and on this mesh they differ in practice: ssh is
 * refused `~/Library/Containers/<app>/` while the daemon in the GUI session may read it
 * fine, and separately the daemon has been refused the Calendar store 69 times while ssh was
 * never asked.
 *
 * Reporting one as the other would be a new instance of exactly the bug this epic is about —
 * a check that answers a different question from the one asked. So the two are reported in
 * two clearly separated blocks:
 *
 *   SSH SESSION   measured directly, by attempting the real read
 *   DAEMON        inferred from the daemon's OWN logs, and labelled as evidence, because
 *                 there is no way to ask another process what TCC grants it holds
 */

import { requireAuth, requireUserId, dim, bold, success, writeJson } from "./iris-api"
import { fetchNodes, resolveNode } from "./platform-hive-nodes"
import { resolveSshTarget, ensureSshUser, sshRun, type SshTarget } from "./hive-tailscale"

/**
 * One ssh round trip, many answers. Emits `KEY<TAB>VALUE` so parsing cannot be confused by
 * spaces in values. Every probe is wrapped so a failure produces a value rather than
 * aborting the script — a doctor that dies on its first bad reading is useless.
 */
const PROBE = String.raw`
emit() { printf '%s\t%s\n' "$1" "$2"; }

emit os "$(uname -s)"
emit host "$(hostname 2>/dev/null)"
emit uptime "$(uptime 2>/dev/null | sed 's/^ *//')"

# ── daemon ────────────────────────────────────────────────────────────────────
PID="$(pgrep -f 'daemon\.js' | head -1)"
if [ -n "$PID" ]; then
  emit daemon_pid "$PID"
  emit daemon_started "$(ps -p "$PID" -o lstart= 2>/dev/null | sed 's/^ *//')"
else
  emit daemon_pid ""
fi

# The commit the daemon is actually running. Never infer this from anything else.
if [ -d "$HOME/.iris/bridge/.git" ]; then
  emit daemon_sha "$(git -C "$HOME/.iris/bridge" rev-parse --short HEAD 2>/dev/null)"
  emit daemon_branch "$(git -C "$HOME/.iris/bridge" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  emit daemon_dirty "$(git -C "$HOME/.iris/bridge" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
else
  emit daemon_sha ""
fi

# tmux decides which execution path the daemon uses, so a wrong answer here is worse than
# no answer. 'command -v' ALONE IS NOT ENOUGH: a non-interactive ssh session gets
# PATH=/usr/bin:/bin:/usr/sbin:/sbin, which excludes Homebrew — measured 2026-08-23, where
# this reported "no" for a machine with tmux at /opt/homebrew/bin/tmux and a daemon
# demonstrably using it. Search the real install locations too, and report WHICH path, so
# the reading can be audited instead of trusted.
TMUX_BIN="$(command -v tmux 2>/dev/null)"
if [ -z "$TMUX_BIN" ]; then
  for c in /opt/homebrew/bin/tmux /usr/local/bin/tmux /usr/bin/tmux /opt/local/bin/tmux; do
    [ -x "$c" ] && TMUX_BIN="$c" && break
  done
fi
[ -n "$TMUX_BIN" ] && emit tmux yes || emit tmux no
emit tmux_path "$TMUX_BIN"
emit disk_avail "$(df -h "$HOME" 2>/dev/null | awk 'NR==2{print $4}')"
emit disk_pct "$(df -h "$HOME" 2>/dev/null | awk 'NR==2{print $5}')"

# ── SSH SESSION privacy grants — the REAL read, never a presence test ─────────
# fs.existsSync-style probes cannot tell "granted" from "never asked" (#182007), so each of
# these actually attempts the access it is asking about.
if [ "$(uname -s)" = "Darwin" ]; then
  if sqlite3 "$HOME/Library/Messages/chat.db" "SELECT 1 FROM message LIMIT 1" >/dev/null 2>&1; then
    emit ssh_fda granted
  else
    emit ssh_fda denied
  fi
  # Same file, PRESENCE only — reported so the two can be compared in one glance. This is
  # the exact pair that proves why the daemon's capability probe is wrong.
  [ -e "$HOME/Library/Messages/chat.db" ] && emit ssh_fda_presence true || emit ssh_fda_presence false

  if sqlite3 "$HOME/Library/Application Support/AddressBook/AddressBook-v22.abcddb" "SELECT 1" >/dev/null 2>&1; then
    emit ssh_contacts granted
  else
    emit ssh_contacts denied
  fi
else
  emit ssh_fda n/a
fi

# ── DAEMON privacy grants — inferred from ITS OWN logs, not measured ─────────
LOG="$HOME/.iris/logs/daemon.stderr.log"
if [ -f "$LOG" ]; then
  emit daemon_log_bytes "$(wc -c < "$LOG" | tr -d ' ')"
  emit daemon_denials "$(grep -ic 'authorization denied\|Full Disk Access\|Operation not permitted' "$LOG" 2>/dev/null | tr -d ' ')"
  emit daemon_denial_last "$(grep -i 'authorization denied\|Full Disk Access\|Operation not permitted' "$LOG" 2>/dev/null | tail -1 | cut -c1-160)"
else
  emit daemon_log_bytes ""
fi
`

interface Reading {
  [k: string]: string
}

function parseProbe(stdout: string): Reading {
  const out: Reading = {}
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("\t")
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

export interface NodeVerdict {
  node: string
  reachable: boolean
  degraded: boolean
  problems: string[]
  notes: string[]
  reading: Reading
  api: { status?: string; heartbeat?: string | null; capabilities?: string[]; active?: number; completed?: number }
}

/**
 * Turn readings into a verdict. Pure, so the rules can be tested without a node.
 *
 * `expectedSha` is compared only when supplied — a mismatch is a real problem (a node
 * silently running different code cannot be reasoned about) but "unknown" is not.
 */
export function judge(node: string, api: NodeVerdict["api"], r: Reading, expectedSha?: string | null): NodeVerdict {
  const problems: string[] = []
  const notes: string[] = []

  if (!r.daemon_pid) problems.push("the Hive daemon is NOT running on this node")
  if (r.tmux === "no") {
    notes.push("tmux is absent — tasks fall back to direct spawn, which is the CLEANER output path (stdio pipes, separated streams)")
  } else if (r.tmux === "yes") {
    notes.push(
      `tmux present (${r.tmux_path || "path unknown"}) — the daemon takes the tmux path, so task output is a PTY scrape: wrapper text, prompts and ANSI escapes mixed in, stdout and stderr merged (#182004)`,
    )
  }

  if (r.daemon_sha && expectedSha && !expectedSha.startsWith(r.daemon_sha) && !r.daemon_sha.startsWith(expectedSha)) {
    problems.push(`daemon is on commit ${r.daemon_sha}, expected ${expectedSha} — a node running different code cannot be reasoned about`)
  }
  if (r.daemon_dirty && r.daemon_dirty !== "0") {
    notes.push(`daemon checkout has ${r.daemon_dirty} uncommitted file(s) — it is not running what its SHA says`)
  }

  const denials = Number(r.daemon_denials ?? "0")
  if (denials > 0) {
    problems.push(
      `the DAEMON has been refused a macOS privacy grant ${denials} time(s) — it is blind to whatever that guards, and nothing in its capability set says so`,
    )
  }

  if (r.ssh_fda === "denied") {
    notes.push("the SSH SESSION has no Full Disk Access — TCC-protected paths will refuse `hive files`, even where the daemon can read them")
  }

  // The presence-vs-access pair, when it disagrees, IS the defect in #182007 — surfaced here
  // rather than left as something you have to already know to look for.
  if (r.ssh_fda === "denied" && r.ssh_fda_presence === "true") {
    notes.push(
      "chat.db EXISTS but cannot be READ by this session — a presence probe (fs.existsSync) would report this machine as iMessage-capable. That is #182007.",
    )
  }

  const pct = Number(String(r.disk_pct ?? "").replace("%", ""))
  if (pct >= 90) problems.push(`disk is ${r.disk_pct} full (${r.disk_avail} free)`)
  else if (pct >= 80) notes.push(`disk is ${r.disk_pct} full (${r.disk_avail} free)`)

  return { node, reachable: true, degraded: problems.length > 0, problems, notes, reading: r, api }
}

/**
 * The REMOTE half of `iris hive doctor`.
 *
 * Called by the existing local doctor in platform-hive.ts when a node (or --all) is named.
 * It is a function rather than its own command because a second command called "doctor"
 * would shadow the local one, and because "check this machine" and "check that machine" are
 * the same question asked of a different subject — not two features.
 */
export async function runRemoteDoctor(argv: any) {
  {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    // total_tasks_completed, not completed_tasks (#182103) — that's the field
    // name the real HiveNode interface uses (platform-hive-nodes.ts), and the
    // one populated on the wire; the inverted name here was always undefined.
    let nodes: Array<{ id: string; name: string; connection_status?: string; last_heartbeat_at?: string | null; capabilities?: any; active_tasks?: number; total_tasks_completed?: number }>
    if (argv.all) {
      nodes = (await fetchNodes(userId)) as any
    } else {
      if (!argv.node) {
        console.error("Specify a node, or pass --all.")
        process.exit(1)
      }
      const n = await resolveNode(userId, String(argv.node))
      if (!n) {
        console.error(`No node matching "${argv.node}". Run: iris hive nodes list`)
        process.exit(1)
      }
      nodes = [n as any]
    }

    const verdicts: NodeVerdict[] = []

    for (const n of nodes) {
      const api = {
        status: n.connection_status,
        heartbeat: n.last_heartbeat_at ?? null,
        capabilities: Array.isArray(n.capabilities) ? n.capabilities : Object.keys(n.capabilities ?? {}),
        active: n.active_tasks,
        completed: n.total_tasks_completed,
      }

      const resolved = await resolveSshTarget(n.id, n.name, {
        host: nodes.length === 1 ? (argv.host as string | undefined) : undefined,
        user: argv.user as string | undefined,
        advertised: (n as any).tailscale_ip ?? null,
      })
      if ("error" in resolved) {
        verdicts.push({ node: n.name, reachable: false, degraded: true, problems: [resolved.error], notes: [], reading: {}, api })
        continue
      }
      const t = await ensureSshUser(n.id, resolved as SshTarget)
      if ("error" in t) {
        verdicts.push({ node: n.name, reachable: false, degraded: true, problems: [t.error], notes: [], reading: {}, api })
        continue
      }

      const r = await sshRun(t, PROBE, 60_000)
      // The probe is written so individual checks degrade to empty values rather than
      // aborting, so a non-zero exit here means the SESSION failed, not one reading.
      if (!r.stdout.trim()) {
        verdicts.push({
          node: n.name, reachable: false, degraded: true,
          problems: [`the health probe returned nothing over ssh: ${r.stderr.trim().slice(0, 200)}`],
          notes: [], reading: {}, api,
        })
        continue
      }
      verdicts.push(judge(n.name, api, parseProbe(r.stdout), (argv["expect-sha"] as string | undefined) ?? null))
    }

    if (argv.json) {
      await writeJson({ ok: verdicts.every((v) => !v.degraded), nodes: verdicts })
      if (verdicts.some((v) => v.degraded)) process.exit(1)
      return
    }

    console.log()
    for (const v of verdicts) {
      const tag = !v.reachable ? dim("✗") : v.degraded ? dim("✗") : success("✓")
      console.log(`${tag} ${bold(v.node)}  ${dim(v.reading.host ?? "")}`)

      if (!v.reachable) {
        for (const p of v.problems) console.log(`    ${p}`)
        console.log()
        continue
      }

      const r = v.reading
      console.log(`    ${dim("api:")}      ${v.api.status ?? "?"}  ${dim("caps")} ${(v.api.capabilities ?? []).length}  ${dim("active")} ${v.api.active ?? "?"}  ${dim("done")} ${v.api.completed ?? "?"}`)
      console.log(
        `    ${dim("daemon:")}   ${r.daemon_pid ? `pid ${r.daemon_pid}` : bold("NOT RUNNING")}` +
          `${r.daemon_sha ? dim(`  commit ${r.daemon_sha}${r.daemon_branch ? " (" + r.daemon_branch + ")" : ""}`) : dim("  commit unknown")}` +
          `${r.daemon_dirty && r.daemon_dirty !== "0" ? dim(`  +${r.daemon_dirty} uncommitted`) : ""}`,
      )
      console.log(`    ${dim("disk:")}     ${r.disk_avail ?? "?"} free (${r.disk_pct ?? "?"})   ${dim("tmux:")} ${r.tmux ?? "?"}`)

      // Two principals, two blocks, never merged.
      console.log(`    ${dim("ssh session grants (measured by attempting the read):")}`)
      console.log(`      full disk access: ${r.ssh_fda ?? "?"}${r.ssh_fda === "denied" && r.ssh_fda_presence === "true" ? dim("   [but the file EXISTS — a presence probe would say 'capable']") : ""}`)
      console.log(`      contacts:         ${r.ssh_contacts ?? "?"}`)

      console.log(`    ${dim("daemon grants (INFERRED from its own log — no API exists to ask another process):")}`)
      if (r.daemon_log_bytes) {
        const d = Number(r.daemon_denials ?? "0")
        console.log(`      privacy denials logged: ${d === 0 ? dim("none") : bold(String(d))}`)
        if (d > 0 && r.daemon_denial_last) console.log(`      most recent: ${dim(r.daemon_denial_last)}`)
      } else {
        console.log(`      ${dim("no daemon log found — cannot infer")}`)
      }

      for (const p of v.problems) console.log(`    ${bold("PROBLEM")}  ${p}`)
      for (const nt of v.notes) console.log(`    ${dim("note")}     ${nt}`)
      console.log()
    }

    const bad = verdicts.filter((v) => v.degraded)
    console.log(`  ${verdicts.length - bad.length}/${verdicts.length} healthy`)
    console.log()
    if (bad.length) process.exit(1)
  }
}
