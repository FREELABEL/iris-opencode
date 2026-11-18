import { cmd } from "./cmd"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success, warn, IRIS_API } from "./iris-api"
import { readCouples, recentActs, nodeKey, nodeIsLocked, sigVerifier } from "./kinetic-store"
import { sealAgent, sealDefinition } from "./kinetic-couple"
import { kineticFor, verdict, type KineticView } from "./org-explain"
import { reviewerFor, type Objective } from "./seat-args"
import { spawnSync } from "child_process"
import * as prompts from "./clack"

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
  if (c.approvals?.routes_to?.kind === "owner") line(`  the owner (user ${c.approvals.routes_to.user_id}) — not a seat`)
  else
    for (const [effect, r] of Object.entries(c.approvals?.by_effect ?? {}) as Array<[string, any]>)
      line(`  ${effect.padEnd(18)} ${r.kind === "seat" ? `user #${r.user_id} — seat #${r.role_id}${r.via && r.via !== "decision_rights" ? dim(` (${r.via})`) : ""}` : dim(`the owner (user ${r.user_id})`)}`)
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

// ─────────────────────────────── chart (S4, #192425) ───────────────────────────────

const effectsWhere = (rights: any, want: "self" | "held") =>
  ["own_write", "unclassified", "shared_write", "shared_overwrite", "egress", "payment"].filter((e) =>
    want === "self" ? rights?.[e]?.decide === "self" : rights?.[e]?.decide !== "self",
  )

const ChartCommand = cmd({
  command: "chart <playbook>",
  describe: "the org chart as SEATS — who fills each, what it may do alone, who approves the rest, and whether that is true",
  builder: (y: any) => y.positional("playbook", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    const a = args as any
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(String(a.playbook))}/roles`, {}, IRIS_API)
    if (!(await handleApiError(res, "Read seats"))) return void (process.exitCode = 1)
    const body = (await res.json()) as any
    const roles: any[] = body?.roles ?? []
    // Each agent-held seat is checked against the gates — the chart must not show authority it
    // cannot back. A seat whose agent cannot be read says so; it is not shown as verified.
    const authority = new Map<number, any>()
    for (const r of roles.filter((x) => x.holder?.type === "agent")) {
      const ar = await irisFetch(`/api/v1/agents/${r.holder.id}/authority`, {}, IRIS_API)
      authority.set(r.id, ar.ok ? await ar.json() : { error: `HTTP ${ar.status}` })
    }
    if (a.json) {
      console.log(JSON.stringify({ playbook: body.playbook, seats: roles.map((r) => ({ ...r, authority: authority.get(r.id) ?? null })) }))
      return
    }
    const titleOf = (id: number) => roles.find((r) => r.id === id)?.title ?? `#${id}`
    const seen = new Set<number>()
    console.log("")
    console.log(`${bold(body?.playbook?.name ?? a.playbook)}  ${dim(`v${body?.playbook?.version ?? "?"} · ${roles.length} seats`)}`)
    const walk = (parent: number | null, depth: number) => {
      for (const r of roles.filter((x) => (x.reports_to_role_id ?? null) === parent)) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        const pad = "  ".repeat(depth + 1)
        const who = r.holder ? (r.holder.type === "agent" ? `🤖 agent #${r.holder.id}` : `👤 user #${r.holder.id}`) : dim("vacant")
        const au = authority.get(r.id)
        const check = r.holder?.type !== "agent" ? "" : au?.error ? dim(` · unverified (${au.error})`) : au?.verify?.ok ? success(" · ✓ verified") : ` · ✕ ${(au?.verify?.failures ?? []).map((f: any) => f.code).join(", ")}`
        console.log(`${pad}${bold(r.title)}  ${dim(`#${r.id}`)}  ${who}${check}`)
        if (r.decision_rights || r.holder?.type === "agent") {
          const alone = effectsWhere(r.decision_rights, "self")
          const held = effectsWhere(r.decision_rights, "held")
          console.log(`${pad}  ${dim("alone:")} ${alone.length ? alone.join(", ") : dim("nothing")}   ${dim("asks:")} ${held.map((e) => { const d = r.decision_rights?.[e]?.decide; return typeof d === "number" ? `${e}→${titleOf(d)}` : e }).join(", ")}`)
        }
        const ev = au?.evidence_7d
        if (ev) {
          const n = Object.values(ev.executions_by_effect ?? {}).reduce((x: number, y: any) => x + Number(y), 0)
          const ap = au.approvals?.last_7d ?? {}
          console.log(`${pad}  ${dim(`7d: ${n} capped acts · ${Object.entries(ap).map(([k, v]) => `${v} ${k}`).join(", ") || "no approvals"} · ${(ev.refusals ?? []).length} refused`)}`)
        }
        walk(r.id, depth + 1)
      }
    }
    walk(null, 0)
    const orphans = roles.filter((r) => !seen.has(r.id))
    if (orphans.length) console.log(dim(`  unreachable (broken reports-to): ${orphans.map((r) => r.title).join(", ")}`))
    console.log("")
  },
})

// ─────────────────────────────── review (S5, #192426) ───────────────────────────────

const ReviewCommand = cmd({
  command: "review <playbook>",
  describe: "run each seat's objective checks, record the result on the seat, and name who reviews what failed",
  builder: (y: any) =>
    y
      .positional("playbook", { type: "string", demandOption: true })
      .option("seat", { type: "number", describe: "only this seat" })
      .option("yes", { type: "boolean", default: false, describe: "run the checks without asking (they are YOUR playbook's commands)" })
      .option("timeout", { type: "number", default: 120, describe: "seconds per check" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const a = args as any
    if (!(await requireAuth())) return
    const name = String(a.playbook)
    const res = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(name)}/roles`, {}, IRIS_API)
    if (!(await handleApiError(res, "Read seats"))) return void (process.exitCode = 1)
    const body = (await res.json()) as any
    // A seat's exit_check is a shell command stored in the playbook. A public playbook is readable
    // by anyone, so running another owner's checks would be running their code on this machine.
    if (!body?.can_edit) {
      console.error("Refused: you do not own this playbook, and review runs its commands on this machine. Only an owner's own checks are run.")
      return void (process.exitCode = 5)
    }
    const roles: any[] = (body.roles ?? []).filter((r: any) => (!a.seat || r.id === a.seat) && (r.objectives ?? []).length)
    if (!roles.length) {
      console.log(dim("No seat has objectives. Add one: iris playbook roles objectives <playbook> <roleId> --add \"id|title|command\""))
      return
    }
    if (!a.yes) {
      if (!process.stdout.isTTY) {
        console.error("Review runs commands. Re-run with --yes, or from a terminal to confirm.")
        return void (process.exitCode = 1)
      }
      console.log(bold("These commands will run on this machine:"))
      for (const r of roles) for (const o of r.objectives as Objective[]) console.log(`  ${r.title} / ${o.id}:  ${o.exit_check}`)
      const ok = await prompts.confirm({ message: "Run them?" })
      if (prompts.isCancel(ok) || !ok) return
    }
    const report: any[] = []
    for (const r of roles) {
      const next: Objective[] = []
      for (const o of r.objectives as Objective[]) {
        const run = spawnSync("sh", ["-c", o.exit_check], { encoding: "utf-8", timeout: Number(a.timeout) * 1000, maxBuffer: 8 * 1024 * 1024 })
        const okRun = run.status === 0
        const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().slice(-500)
        next.push({ id: o.id, title: o.title, exit_check: o.exit_check, last: { ok: okRun, at: new Date().toISOString(), exit_code: run.status, output } })
        const reviewer = okRun ? null : reviewerFor(r.id, body.roles)
        report.push({ seat: r.title, seat_id: r.id, objective: o.id, title: o.title, ok: okRun, exit_code: run.status, reviewer })
      }
      // Recorded on the seat: the measurement is part of the seat's history, not a terminal scrollback.
      const put = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(name)}/roles/${r.id}`, { method: "PUT", body: JSON.stringify({ objectives: next }) }, IRIS_API)
      if (!put.ok) console.error(`  could not record results on seat #${r.id} (HTTP ${put.status})`)
    }
    if (a.json) console.log(JSON.stringify({ playbook: name, results: report }))
    else {
      console.log("")
      for (const x of report)
        console.log(`  ${x.ok ? success("✓ met    ") : bold("✕ NOT MET")}  ${x.seat} / ${x.title}${x.ok ? "" : dim(`  exit ${x.exit_code} · review: ${x.reviewer ? `${x.reviewer.title} (user #${x.reviewer.user_id})` : "the owner — nobody above this seat"}`)}`)
      console.log("")
    }
    if (report.some((x) => !x.ok)) process.exitCode = 2
  },
})

export const PlatformOrgCommand = cmd({
  command: "org",
  describe: "who may do what — an agent's authority, asked of every gate (epic #192420)",
  builder: (y: any) => y.command(ExplainCommand).command(ChartCommand).command(ReviewCommand).demandCommand(),
  async handler() {},
})
