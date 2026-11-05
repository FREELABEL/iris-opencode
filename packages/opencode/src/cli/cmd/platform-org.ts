import { cmd } from "./cmd"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success, warn, IRIS_API } from "./iris-api"
import { readCouples, recentActs, nodeKey, nodeIsLocked, sigVerifier } from "./kinetic-store"
import { sealAgent, sealDefinition } from "./kinetic-couple"
import { kineticFor, verdict, type KineticView } from "./org-explain"

// ============================================================================
// iris org — who may do what, asked of the gates (#192420).
//
// `explain` is S0 of the epic: for one agent, what every gate decides — the trust level and what
// ToolTrustGate actually does, tool policy, rate caps and usage, the run gate, who receives its
// held actions, seven days of evidence — plus THIS node's Kinetic couples, which the cloud cannot
// see. `--verify` turns that into an exit code: 0 only when nothing on the sheet is wrong about
// what the gates do. It is the epic's exit check, and it is meant to fail today: no agent has a
// seat yet.
// ============================================================================

const ExplainCommand = cmd({
  command: "explain <agent>",
  describe: "what one agent may do alone, what it must ask for, who approves, and what it did — asked of the gates",
  builder: (y: any) =>
    y
      .positional("agent", { describe: "agent id", type: "number", demandOption: true })
      .option("verify", { describe: "exit non-zero when the sheet disagrees with what the gates do", type: "boolean", default: false })
      .option("json", { type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    const a = args as any
    const token = await requireAuth()
    if (!token) return
    const id = Number(a.agent)

    const res = await irisFetch(`/api/v1/agents/${id}/authority`, {}, IRIS_API)
    if (!(await handleApiError(res, "Read agent authority"))) {
      process.exitCode = 1
      return
    }
    const cloud = (await res.json()) as any

    // The sealed hash, computed exactly as `iris kinetic seal --agent` computes it, so this node's
    // couples for the agent are found — or, honestly, not found.
    let kinetic: KineticView | null = null
    let kineticError: string | null = null
    const userId = await requireUserId(a["user-id"])
    if (userId) {
      const ar = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${id}`)
      if (ar.ok) {
        const body = (await ar.json().catch(() => null)) as any
        const agent = body?.data ?? body
        if (agent?.id) {
          const { couples, error } = readCouples()
          kinetic = kineticFor({
            hash: sealAgent(sealDefinition(agent)),
            node: nodeKey(),
            couples,
            acts: recentActs(),
            now: new Date().toISOString(),
            verifySig: sigVerifier(),
            enforceOperators: nodeIsLocked(),
          })
          if (error) kineticError = error
        }
      } else kineticError = `could not read the agent definition to seal it (HTTP ${ar.status})`
    }

    const v = verdict(cloud.verify ?? { ok: false, failures: [{ code: "no_verify_from_cloud" }], warnings: [] }, kinetic)

    if (a.json) {
      console.log(JSON.stringify({ ...cloud, kinetic: kinetic ?? cloud.kinetic, kinetic_error: kineticError, verdict: v }))
    } else {
      render(cloud, kinetic, kineticError, v)
    }
    if (a.verify && !v.ok) process.exitCode = 1
  },
})

function render(c: any, k: KineticView | null, kErr: string | null, v: ReturnType<typeof verdict>) {
  const line = (s = "") => console.log(s)
  line("")
  line(`${bold(c.agent?.name ?? `agent ${c.agent?.id}`)}  ${dim(`#${c.agent?.id} · bloq ${c.agent?.bloq_id ?? "—"}`)}`)
  line(`  seat       ${c.seat ? bold(String(c.seat.title ?? c.seat.id)) : warn("none — authority is set by hand, agent by agent")}`)
  line(`  runs       ${c.run?.may_run ? success("may run") : `blocked — ${c.run?.blocked_reason}`}`)
  line(`  trust      ${c.trust?.level ?? dim("no level set")}${c.trust?.meaning ? dim(`  ${c.trust.meaning}`) : ""}`)
  line("")
  line(bold("  What it does alone, and what it must ask for"))
  line(dim("  effect             chat   gated   caps (used / limit, hour · day)"))
  for (const e of c.effects ?? []) {
    const probe = (m: string) => (e.probe ? e.probe[m].decision : `${e.claimed[m]}?`)
    const caps = e.rate_caps ? `${e.rate_caps.used_hour}/${e.rate_caps.per_hour} · ${e.rate_caps.used_day}/${e.rate_caps.per_day}${e.rate_caps.enforced ? "" : dim(" report-only")}` : ""
    line(`  ${String(e.effect).padEnd(18)} ${probe("chat").padEnd(6)} ${probe("gated").padEnd(7)} ${caps}`)
  }
  line(dim("  (a trailing ? means no catalogue tool could stand in for that effect, so the gate was not asked)"))
  if ((c.tools ?? []).length) {
    line("")
    line(bold("  Its tools"))
    for (const t of c.tools) line(`  ${String(t.tool).padEnd(32)} ${String(t.effect).padEnd(16)} chat ${t.chat.decision}${t.chat.source === "policy" ? dim(" (policy)") : ""} · gated ${t.gated.decision}`)
  }
  line("")
  line(bold("  Who approves"))
  line(`  ${c.approvals?.routes_to?.kind === "owner" ? `the owner (user ${c.approvals.routes_to.user_id}) — not a seat` : JSON.stringify(c.approvals?.routes_to)}`)
  const ap = c.approvals?.last_7d ?? {}
  line(dim(`  last 7 days: ${Object.keys(ap).length ? Object.entries(ap).map(([s, n]) => `${n} ${s}`).join(", ") : "none"}`))
  line("")
  line(bold(`  Kinetic on ${k?.node ?? "this node"}`))
  if (!k) line(dim(`  unknown${kErr ? ` — ${kErr}` : ""}`))
  else if (!k.couples.length) line(dim(`  no couples for ${k.hash.slice(0, 18)}…`))
  else
    for (const cp of k.couples)
      line(`  ${cp.body.padEnd(28)} ${cp.verbs.map((x) => `${x.verb}:${x.decision}`).join(" ")}${cp.active ? "" : dim(" (inactive)")}${cp.issued ? dim(" issued") : ""}`)
  if (k) line(dim(`  acts last 7 days: ${k.acts_7d.allow} allowed, ${k.acts_7d.deny} refused`))
  const ev = c.evidence_7d ?? {}
  line("")
  line(bold("  Evidence, last 7 days"))
  line(dim(`  executed: ${Object.keys(ev.executions_by_effect ?? {}).length ? Object.entries(ev.executions_by_effect).map(([e, n]) => `${n} ${e}`).join(", ") : "nothing capped"} · refused by policy: ${(ev.refusals ?? []).length}`))
  line("")
  line(v.ok ? success("  ✓ the sheet matches what the gates do") : bold(`  ✕ ${v.failures.length} thing${v.failures.length === 1 ? "" : "s"} on this sheet a person would be wrong about`))
  for (const f of v.failures) line(`    ✕ ${f.detail}`)
  for (const w of v.warnings) line(dim(`    · ${w.detail}`))
  line("")
}

export const PlatformOrgCommand = cmd({
  command: "org",
  describe: "who may do what — an agent's authority, asked of every gate (epic #192420)",
  builder: (y: any) => y.command(ExplainCommand).demandCommand(),
  async handler() {},
})
