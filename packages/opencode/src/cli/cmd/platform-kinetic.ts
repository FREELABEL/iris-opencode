/**
 * `iris kinetic` — the clutch, as a command.
 *
 * KINETICS — THE CLUTCH (#184906): "A Kinetic act is a minted agent, on a node that holds both the
 * hash and a named body, passing a command the allowlist already blessed." This command is how a
 * person writes that sentence down (`couple add`), reads it back (`couple list`, `check`), and
 * takes it away (`couple revoke`).
 *
 * It is deliberately node-local and offline: every subcommand here works with the network down,
 * because the guard it feeds has to.
 */

import { cmd } from "./cmd"
import * as prompts from "./clack"
import { dim, bold, success, irisFetch, handleApiError, requireAuth, requireUserId } from "./iris-api"
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { AGENT_HASH, sealAgent, normalizeBody, coupleId, decide, findCouples, type Couple } from "./kinetic-couple"
import { revokedIds, readCouples, writeCouples, nodeKey, couplesPath, actLogPath, kineticDir, nodeIsLocked, currentActor, trustedIssuers, trustIssuer, untrustIssuer, issuerKeyPath, markRevoked, sigVerifier, recentActs, currentRunId } from "./kinetic-store"
import { generateIssuer, signCouple, verifyCoupleSig, issuerFingerprint } from "./kinetic-sign"
import { unknownVerbs, knownVerbs, BODY_CLASSES } from "./kinetic-bodies"
import { spendFor } from "./kinetic-budget"

const UI = { empty: () => console.log("") }

function printCouple(c: Couple, now: string): void {
  const verified = c.sig ? sigVerifier()(c) : true
  const live = verified && !c.revoked_at && findCouples([c], { agent: c.agent, node: c.node, body: c.body, now }).length > 0
  const state = c.revoked_at ? "revoked" : !verified ? "unverified" : live ? "active" : "expired"
  console.log(`  ${bold(c.id)}  ${state === "active" ? success(state) : dim(state)}`)
  console.log(`    agent  ${c.agent.slice(0, 20)}…${c.agent_label ? dim(`  (${c.agent_label})`) : ""}`)
  console.log(`    body   ${c.body}   ${dim(`on ${c.node}`)}${c.sig ? dim(`  issued by ${c.sig.issuer}`) : ""}`)
  console.log(`    verbs  ${(c.allowlist ?? []).join(", ") || dim("none")}`)
  const p = c.policy ?? {}
  const bits = [
    typeof p.max_single_expense_cents === "number" ? `max $${(p.max_single_expense_cents / 100).toFixed(2)}/act` : null,
    p.hitl ? "human confirms each act" : null,
    p.expires_at ? `expires ${p.expires_at}` : null,
  ].filter(Boolean)
  if (bits.length) console.log(`    policy ${bits.join(" · ")}`)
}

const SealCommand = cmd({
  command: "seal",
  describe: "seal an agent's definition into the identity hash a couple binds to",
  builder: (y) =>
    y
      .option("agent", { describe: "agent id or name to pull and seal", type: "string" })
      .option("file", { describe: "a local JSON definition to seal instead", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    let definition: unknown
    let label: string | null = null

    if (args.file) {
      if (!existsSync(String(args.file))) { console.error(`No such file: ${args.file}`); process.exitCode = 1; return }
      definition = JSON.parse(readFileSync(String(args.file), "utf-8"))
      label = String(args.file)
    } else if (args.agent) {
      const token = await requireAuth()
      if (!token) return
      const userId = await requireUserId(args["user-id"])
      if (!userId) return
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${args.agent}`)
      if (!(await handleApiError(res, "Get agent"))) { process.exitCode = 1; return }
      const body = (await res.json()) as { data?: any }
      const a = body?.data ?? body
      if (!a?.id) { console.error("Agent not found"); process.exitCode = 1; return }
      // Seal the DEFINITION, not the envelope: ids, timestamps and counters change without the
      // agent changing, and a hash that moves on its own would revoke couples at random.
      definition = { name: a.name, model: a.model, instructions: a.instructions ?? a.prompt ?? null, tools: a.tools ?? a.config?.tools ?? null, config: a.config ?? null }
      label = String(a.name ?? `agent-${a.id}`)
    } else {
      console.error("Give --agent <id|name> or --file <definition.json>.")
      process.exitCode = 1
      return
    }

    const hash = sealAgent(definition)
    if (args.json) { console.log(JSON.stringify({ hash, label })); return }
    UI.empty()
    console.log(`  ${bold(hash)}`)
    if (label) console.log(dim(`  ${label}`))
    console.log("")
    console.log(dim(`  Couple it to a body on this node:`))
    console.log(dim(`    iris kinetic couple add --agent ${hash} --body camera:obsbot-tiny --allow move,preset`))
    console.log(dim(`  Edit the agent and this hash changes — the couple stops matching, by design.`))
    console.log("")
  },
})

const CoupleAddCommand = cmd({
  command: "add",
  describe: "couple a sealed agent to a body on this node",
  builder: (y) =>
    y
      .option("agent", { describe: "sealed agent hash (iris kinetic seal)", type: "string", demandOption: true })
      .option("body", { describe: "class:instance, e.g. camera:obsbot-tiny or camera:*", type: "string", demandOption: true })
      .option("allow", { describe: "verbs this couple blesses, comma separated", type: "string", demandOption: true })
      .option("label", { describe: "a human name for the agent (not its identity)", type: "string" })
      .option("node", { describe: "node key (defaults to this machine)", type: "string" })
      .option("max-cents", { describe: "ceiling on a single act, in cents", type: "number" })
      .option("max-run-cents", { describe: "ceiling on one run (IRIS_RUN_ID), in cents", type: "number" })
      .option("max-day-cents", { describe: "ceiling on one UTC day, in cents", type: "number" })
      .option("max-day-acts", { describe: "how many acts this couple may make per UTC day", type: "number" })
      .option("sign", { describe: "sign it with this node's issuer key, so other nodes can accept it", type: "boolean", default: false })
      .option("force", { describe: "allow a verb this body class does not declare", type: "boolean", default: false })
      .option("hitl", { describe: "a human confirms every act", type: "boolean", default: false })
      .option("expires", { describe: "ISO timestamp after which the couple is dead", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const agent = String(args.agent).trim()
    if (!AGENT_HASH.test(agent)) {
      console.error(`Not a sealed hash: ${agent.slice(0, 24)}…\n  Get one with: iris kinetic seal --agent <id>`)
      process.exitCode = 1
      return
    }
    const body = normalizeBody(String(args.body))
    if (!body) { console.error(`Not a body name: ${args.body} — expected class:instance, e.g. camera:obsbot-tiny`); process.exitCode = 1; return }

    const allowlist = String(args.allow).split(",").map((v) => v.trim().toLowerCase()).filter(Boolean)
    if (allowlist.length === 0) { console.error("--allow needs at least one verb."); process.exitCode = 1; return }

    if (args.expires && !Number.isFinite(Date.parse(String(args.expires)))) {
      console.error(`--expires is not a date I can read: ${args.expires}`)
      process.exitCode = 1
      return
    }

    // A verb the class does not declare is a typo, and catching it HERE means the couple that
    // silently never matches is never written. --force is for an adapter we do not model yet.
    const strays = unknownVerbs(body, allowlist)
    if (strays.length > 0 && !args.force) {
      const cls = body.split(":")[0]!
      console.error(`${cls} does not have verb(s): ${strays.join(", ")}\n  known: ${knownVerbs(cls).join(", ")}\n  Use --force if this is a body class IRIS does not model yet.`)
      process.exitCode = 1
      return
    }

    const { couples, error } = readCouples()
    if (error) prompts.log.warn(error)

    const c: Couple = {
      id: coupleId(),
      agent,
      agent_label: args.label ? String(args.label) : null,
      node: String(args.node || nodeKey()),
      body,
      allowlist,
      policy: {
        max_single_expense_cents: typeof args["max-cents"] === "number" ? Number(args["max-cents"]) : null,
        max_run_cents: typeof args["max-run-cents"] === "number" ? Number(args["max-run-cents"]) : null,
        max_day_cents: typeof args["max-day-cents"] === "number" ? Number(args["max-day-cents"]) : null,
        max_day_acts: typeof args["max-day-acts"] === "number" ? Number(args["max-day-acts"]) : null,
        hitl: Boolean(args.hitl),
        expires_at: args.expires ? new Date(String(args.expires)).toISOString() : null,
      },
      created_at: new Date().toISOString(),
      revoked_at: null,
    }

    if (args.sign) {
      if (!existsSync(issuerKeyPath())) {
        console.error(`No issuer key on this machine. Make one with: iris kinetic issuer new`)
        process.exitCode = 1
        return
      }
      c.sig = signCouple(c, readFileSync(issuerKeyPath(), "utf-8"))
    }

    writeCouples([...couples, c])

    if (args.json) { console.log(JSON.stringify(c)); return }
    UI.empty()
    console.log(success(`  coupled`))
    printCouple(c, new Date().toISOString())
    console.log("")
    console.log(dim(`  ${couplesPath()}`))
    console.log("")
  },
})

const CoupleListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "every couple on this node",
  builder: (y) => y.option("json", { describe: "JSON output", type: "boolean", default: false }).option("all", { describe: "include revoked and expired", type: "boolean", default: false }),
  async handler(args) {
    const { couples, error } = readCouples()
    const now = new Date().toISOString()
    const shown = args.all ? couples : couples.filter((c) => !c.revoked_at && findCouples([c], { agent: c.agent, node: c.node, body: c.body, now }).length > 0)

    if (args.json) { console.log(JSON.stringify({ node: nodeKey(), locked: nodeIsLocked(), couples: shown, error })); return }

    UI.empty()
    console.log(`  ${bold("node")}  ${nodeKey()}${nodeIsLocked() ? "  " + bold("LOCKED — every act needs a couple") : ""}`)
    if (error) prompts.log.warn(error)
    if (shown.length === 0) {
      console.log(dim(`  no ${args.all ? "" : "active "}couples — nothing on this machine may be moved by an agent`))
      console.log("")
      console.log(dim(`  iris kinetic seal --agent <id>   then   iris kinetic couple add …`))
      console.log("")
      return
    }
    for (const c of shown) printCouple(c, now)
    console.log("")
  },
})

const CoupleRevokeCommand = cmd({
  command: "revoke <id>",
  describe: "end a couple now (it stops authorising immediately)",
  builder: (y) => y.positional("id", { describe: "couple id", type: "string", demandOption: true }).option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const { couples } = readCouples()
    const target = couples.find((c) => c.id === String(args.id))
    if (!target) { console.error(`No couple ${args.id} on this node.`); process.exitCode = 1; return }
    if (target.revoked_at) { console.log(dim(`already revoked ${target.revoked_at}`)); return }
    target.revoked_at = new Date().toISOString()
    writeCouples(couples)
    // The record stays correctly SIGNED after revocation, so the signature cannot be what withdraws
    // it. The node keeps its own no, and a re-import cannot talk it round.
    markRevoked(target.id)
    if (args.json) { console.log(JSON.stringify(target)); return }
    console.log(success(`revoked ${target.id} — ${target.agent.slice(0, 16)}… can no longer act on ${target.body}`))
  },
})

const CoupleCommand = cmd({
  command: "couple",
  describe: "the couple record — what may move what, on this node",
  builder: (y) => y.command(CoupleAddCommand).command(CoupleListCommand).command(CoupleRevokeCommand).command(CoupleExportCommand).command(CoupleImportCommand).demandCommand(),
  handler: () => {},
})

const CheckCommand = cmd({
  command: "check <body> <verb>",
  describe: "would this act be allowed? (asks the guard without touching the body)",
  builder: (y) =>
    y
      .positional("body", { describe: "class:instance", type: "string", demandOption: true })
      .positional("verb", { describe: "the verb the act would use", type: "string", demandOption: true })
      .option("agent", { describe: "sealed hash to test as (defaults to IRIS_AGENT, else operator)", type: "string" })
      .option("cents", { describe: "estimated cost of the act, in cents", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const { couples, error } = readCouples()
    const actor = args.agent ? ({ kind: "agent", hash: String(args.agent) } as const) : currentActor()
    const now = new Date().toISOString()
    const verifySig = sigVerifier()
    // `check` must ask the question the ACT PATH asks, or it answers about a different system. The
    // first draft left out verifySig and reported a perfectly good issued couple as unverifiable.
    const first = decide({ actor, node: nodeKey(), body: String(args.body), verb: String(args.verb), estimatedCents: typeof args.cents === "number" ? Number(args.cents) : null, couples, now, enforceOperators: nodeIsLocked(), verifySig })
    const spend = first.couple_id ? spendFor(recentActs(), { coupleId: first.couple_id, runId: currentRunId(), now }) : undefined
    const d = decide({
      actor,
      node: nodeKey(),
      body: String(args.body),
      verb: String(args.verb),
      estimatedCents: typeof args.cents === "number" ? Number(args.cents) : null,
      couples,
      now,
      enforceOperators: nodeIsLocked(),
      verifySig,
      spend,
    })

    if (args.json) { console.log(JSON.stringify({ ...d, node: nodeKey(), actor: actor.kind, error })); }
    else {
      UI.empty()
      const head = d.decision === "allow" ? success("ALLOW") : d.decision === "hitl" ? bold("NEEDS A HUMAN") : bold("REFUSE")
      console.log(`  ${head}  ${dim(d.reason)}`)
      if (error) prompts.log.warn(error)
      console.log("")
    }
    // A check is worth scripting against: 0 allow, 3 needs a human, 5 refused — the same 5 an act exits with.
    process.exit(d.decision === "allow" ? 0 : d.decision === "hitl" ? 3 : 5)
  },
})

const LockCommand = cmd({
  command: "lock",
  describe: "require a couple for EVERY act on this node, including an operator's",
  builder: (y) => y.option("off", { describe: "unlock", type: "boolean", default: false }),
  async handler(args) {
    mkdirSync(kineticDir(), { recursive: true, mode: 0o700 })
    const f = join(kineticDir(), "locked")
    if (args.off) {
      if (existsSync(f)) rmSync(f)
      console.log(success(`unlocked — an operator at this terminal may act without a couple (recorded as unbound)`))
      return
    }
    writeFileSync(f, new Date().toISOString() + "\n", { mode: 0o600 })
    console.log(success(`locked — every act on ${nodeKey()} now needs a couple`))
    console.log(dim(`  this includes you: seal a hash and couple it, or run: iris kinetic lock --off`))
  },
})

const LogCommand = cmd({
  command: "log",
  describe: "what has been acted, and what was refused, on this node",
  builder: (y) => y.option("limit", { describe: "how many lines", type: "number", default: 20 }).option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!existsSync(actLogPath())) { console.log(dim("  no acts recorded on this node yet")); return }
    const lines = readFileSync(actLogPath(), "utf-8").trim().split("\n").filter(Boolean)
    const tail = lines.slice(-Math.max(1, Number(args.limit)))
    if (args.json) { console.log("[" + tail.join(",") + "]"); return }
    UI.empty()
    for (const l of tail) {
      try {
        const r = JSON.parse(l)
        const mark = r.decision === "allow" ? success("✓") : bold("✗")
        console.log(`  ${mark} ${dim(r.ts)}  ${r.verb} ${r.body}  ${dim(r.couple_id || (r.unbound ? "unbound" : "—"))}`)
        if (r.decision !== "allow") console.log(dim(`      ${String(r.reason).split("\n")[0]}`))
      } catch { /* a corrupt line is not worth failing a listing over */ }
    }
    console.log("")
  },
})


// ── issuing couples for a fleet ───────────────────────────────────────────────────────────────

const IssuerNewCommand = cmd({
  command: "new",
  describe: "create this machine's issuer key (it signs couples other nodes will accept)",
  builder: (y) => y.option("force", { describe: "replace an existing key", type: "boolean", default: false }),
  async handler(args) {
    if (existsSync(issuerKeyPath()) && !args.force) {
      const pub = issuerFingerprint(readFileSync(issuerKeyPath() + ".pub", "utf-8"))
      console.log(dim(`  this machine already issues as ${bold(pub)}`))
      console.log(dim(`  --force replaces it, and every couple it signed stops verifying`))
      return
    }
    const k = generateIssuer()
    mkdirSync(kineticDir(), { recursive: true, mode: 0o700 })
    writeFileSync(issuerKeyPath(), k.privateKeyPem, { mode: 0o600 })
    writeFileSync(issuerKeyPath() + ".pub", k.publicKeyPem, { mode: 0o644 })
    // An issuer trusts itself, or the machine that issues a couple could not use it.
    trustIssuer(k.issuer, k.publicKeyPem)
    UI.empty()
    console.log(`  ${bold(k.issuer)}`)
    console.log(dim(`  private key  ${issuerKeyPath()}  (never copy this to a node)`))
    console.log(dim(`  public key   ${issuerKeyPath()}.pub`))
    console.log("")
    console.log(dim(`  Trust it on every node that should accept its couples:`))
    console.log(dim(`    iris kinetic issuer trust --file issuer.key.pub`))
    console.log("")
  },
})

const IssuerTrustCommand = cmd({
  command: "trust",
  describe: "accept issued couples from this public key",
  builder: (y) =>
    y
      .option("file", { describe: "path to a public key (.pub)", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!existsSync(String(args.file))) { console.error(`No such file: ${args.file}`); process.exitCode = 1; return }
    const pem = readFileSync(String(args.file), "utf-8")
    let fp: string
    try {
      fp = issuerFingerprint(pem)
    } catch (e) {
      console.error(`That file is not a public key: ${(e as Error).message}`)
      process.exitCode = 1
      return
    }
    trustIssuer(fp, pem)
    if (args.json) { console.log(JSON.stringify({ issuer: fp })); return }
    console.log(success(`trusting ${fp} — issued couples signed by it are now accepted on ${nodeKey()}`))
  },
})

const IssuerListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "issuers this node accepts couples from",
  builder: (y) => y.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const all = trustedIssuers()
    if (args.json) { console.log(JSON.stringify({ node: nodeKey(), issuers: Object.keys(all) })); return }
    UI.empty()
    const mine = existsSync(issuerKeyPath() + ".pub") ? issuerFingerprint(readFileSync(issuerKeyPath() + ".pub", "utf-8")) : null
    if (Object.keys(all).length === 0) {
      console.log(dim(`  no trusted issuers — this node accepts only couples written on it`))
    }
    for (const fp of Object.keys(all)) console.log(`  ${bold(fp)}${fp === mine ? dim("  (this machine)") : ""}`)
    console.log("")
  },
})

const IssuerRevokeCommand = cmd({
  command: "untrust <issuer>",
  describe: "stop accepting couples from an issuer",
  builder: (y) => y.positional("issuer", { describe: "issuer fingerprint", type: "string", demandOption: true }),
  async handler(args) {
    const gone = untrustIssuer(String(args.issuer))
    if (!gone) { console.error(`${args.issuer} was not trusted here.`); process.exitCode = 1; return }
    console.log(success(`untrusted ${args.issuer} — its couples no longer authorise anything on ${nodeKey()}`))
  },
})

const IssuerCommand = cmd({
  command: "issuer",
  describe: "who may issue couples that this node accepts",
  builder: (y) => y.command(IssuerNewCommand).command(IssuerTrustCommand).command(IssuerListCommand).command(IssuerRevokeCommand).demandCommand(),
  handler: () => {},
})

const CoupleExportCommand = cmd({
  command: "export [id]",
  describe: "print couples as JSON, to hand to another node",
  builder: (y) => y.positional("id", { describe: "one couple, or all of them", type: "string" }),
  async handler(args) {
    const { couples } = readCouples()
    const out = args.id ? couples.filter((c) => c.id === String(args.id)) : couples
    if (out.length === 0) { console.error(`Nothing to export.`); process.exitCode = 1; return }
    const unsigned = out.filter((c) => !c.sig).length
    if (unsigned > 0) prompts.log.warn(`${unsigned} of these are unsigned — another node will refuse them. Re-create with --sign.`)
    console.log(JSON.stringify(out, null, 2))
  },
})

const CoupleImportCommand = cmd({
  command: "import <file>",
  describe: "accept couples issued elsewhere (each must be signed by a trusted issuer)",
  builder: (y) =>
    y
      .positional("file", { describe: "JSON file of couples, or - for stdin", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const raw = String(args.file) === "-" ? readFileSync(0, "utf-8") : existsSync(String(args.file)) ? readFileSync(String(args.file), "utf-8") : null
    if (raw === null) { console.error(`No such file: ${args.file}`); process.exitCode = 1; return }

    let incoming: Couple[]
    try {
      const parsed = JSON.parse(raw)
      incoming = Array.isArray(parsed) ? parsed : [parsed]
    } catch (e) {
      console.error(`That is not JSON: ${(e as Error).message}`)
      process.exitCode = 1
      return
    }

    const verify = sigVerifier()
    const { couples } = readCouples()
    const have = new Set(couples.map((c) => c.id))
    const revoked = new Set(revokedIds())
    const taken: Couple[] = []
    const refused: Array<[string, string]> = []

    for (const c of incoming) {
      if (!c?.id) { refused.push(["(no id)", "not a couple"]); continue }
      if (have.has(c.id)) { refused.push([c.id, "already here"]); continue }
      // It would be stored and then read back as dead, which reads as "imported" followed by an
      // inexplicable refusal. Say no at the door instead.
      if (revoked.has(c.id)) { refused.push([c.id, "revoked on this node — re-issue it with a new id if that was a mistake"]); continue }
      // Signature FIRST. An imported couple is a stranger's claim until an issuer this node trusts
      // has vouched for every field that grants anything.
      if (!c.sig) { refused.push([c.id, "unsigned — only couples written on this node may be unsigned"]); continue }
      if (!verify(c)) { refused.push([c.id, "signature does not verify against a trusted issuer"]); continue }
      if (c.node !== nodeKey()) { refused.push([c.id, `names node ${c.node}, this is ${nodeKey()}`]); continue }
      taken.push(c)
    }

    if (taken.length > 0) writeCouples([...couples, ...taken])

    if (args.json) { console.log(JSON.stringify({ imported: taken.map((c) => c.id), refused })); process.exitCode = taken.length ? 0 : 1; return }
    UI.empty()
    for (const c of taken) console.log(success(`  imported ${c.id} — ${c.body} (${c.allowlist.join(", ")})`))
    for (const [id, why] of refused) console.log(dim(`  refused ${id}: ${why}`))
    console.log("")
    if (taken.length === 0) process.exitCode = 1
  },
})

const BodiesCommand = cmd({
  command: "bodies",
  describe: "body classes IRIS can drive, and the verbs each one declares",
  builder: (y) => y.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (args.json) { console.log(JSON.stringify(BODY_CLASSES)); return }
    UI.empty()
    for (const b of BODY_CLASSES) {
      console.log(`  ${bold(b.name)}  ${dim(b.describe)}`)
      console.log(`    ${b.verbs.join(", ")}`)
    }
    console.log("")
    console.log(dim(`  A class listed here is guarded wherever it is driven. A body IRIS does not`))
    console.log(dim(`  model yet still couples — use --force on the verbs.`))
    console.log("")
  },
})

const SpendCommand = cmd({
  command: "spend <couple-id>",
  describe: "what a couple has spent this run and today, against its ceilings",
  builder: (y) => y.positional("couple-id", { type: "string", demandOption: true }).option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const { couples } = readCouples()
    const c = couples.find((x) => x.id === String(args["couple-id"]))
    if (!c) { console.error(`No couple ${args["couple-id"]} on this node.`); process.exitCode = 1; return }
    const now = new Date().toISOString()
    const s = spendFor(recentActs(), { coupleId: c.id, runId: currentRunId(), now })
    if (args.json) { console.log(JSON.stringify({ couple: c.id, spend: s, policy: c.policy })); return }
    const cap = (v: number | null | undefined) => (typeof v === "number" ? `$${(v / 100).toFixed(2)}` : dim("none"))
    UI.empty()
    console.log(`  ${bold(c.id)}  ${c.body}`)
    console.log(`    this run   $${(s.runCents / 100).toFixed(2)} of ${cap(c.policy?.max_run_cents)}`)
    console.log(`    today      $${(s.dayCents / 100).toFixed(2)} of ${cap(c.policy?.max_day_cents)}`)
    console.log(`    acts today ${s.dayActs} of ${typeof c.policy?.max_day_acts === "number" ? c.policy.max_day_acts : dim("no limit")}`)
    console.log("")
  },
})

export const PlatformKineticCommand = cmd({
  command: "kinetic",
  aliases: ["kinetics"],
  describe: "Kinetic — which agent may move which body on this node, and on what terms",
  builder: (y) =>
    y
      .command(SealCommand)
      .command(IssuerCommand)
      .command(CoupleCommand)
      .command(BodiesCommand)
      .command(SpendCommand)
      .command(CheckCommand)
      .command(LockCommand)
      .command(LogCommand)
      .demandCommand(),
  handler: () => {},
})
