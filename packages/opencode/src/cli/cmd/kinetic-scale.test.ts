/**
 * The four gaps the first build left open, each closed and pinned here:
 * enforcement was opt-in · couples did not travel · budgets were decorative · verbs were typos.
 */
import { describe, expect, test } from "bun:test"
import { decide, decideClass, type Couple } from "./kinetic-couple"
import { routeFor, unknownVerbs, declaredCents, BODY_CLASSES, knownVerbs } from "./kinetic-bodies"
import { spendFor, budgetRefusal, utcDay, EMPTY_SPEND } from "./kinetic-budget"
import { generateIssuer, signCouple, verifyCoupleSig, canonicalCouple, issuerFingerprint } from "./kinetic-sign"

const HASH = "sha256:" + "a".repeat(64)
const NODE = "hive-node-studio"
const NOW = "2026-09-19T12:00:00.000Z"

const couple = (over: Partial<Couple> = {}): Couple => ({
  id: "cpl_test",
  agent: HASH,
  node: NODE,
  body: "camera:obsbot-tiny",
  allowlist: ["move"],
  policy: {},
  created_at: "2026-09-19T11:00:00.000Z",
  ...over,
})

describe("gap 1 — the route table, so enforcement is not opt-in", () => {
  test("the act paths that were unguarded now route to a body and a verb", () => {
    expect(routeFor(["hive", "run", "studio-mac", "rm", "-rf", "/"])).toEqual({ class: "node", verb: "run", instance: "studio-mac" })
    expect(routeFor(["device", "clean", "--apply"])).toMatchObject({ class: "device", verb: "clean" })
    expect(routeFor(["n8n", "trigger", "wf-7"])).toMatchObject({ class: "n8n", verb: "trigger" })
    expect(routeFor(["camera", "left"])).toMatchObject({ class: "camera", verb: "move" })
    expect(routeFor(["obs", "record", "start"])).toMatchObject({ class: "obs", verb: "record", instance: "studio" })
  })

  test("looking is not moving — reads route to nothing", () => {
    for (const r of [["camera", "list"], ["camera", "pos"], ["obs", "scenes"], ["obs", "status"], ["hive", "nodes"], ["device", "scan"], ["n8n", "list"]])
      expect(routeFor(r)).toBeNull()
    // the same sub-command, read vs act, decided by the NEXT word
    expect(routeFor(["obs", "record", "status"])).toBeNull()
    expect(routeFor(["obs", "record", "start"])).not.toBeNull()
    // and `device clean` deletes nothing until --apply, so only that form is an act
    expect(routeFor(["device", "clean"])).toBeNull()
    expect(routeFor(["device", "clean", "--apply"])).not.toBeNull()
  })

  test("inspecting the clutch never needs the clutch's permission", () => {
    // otherwise `kinetic couple list` would require a couple to discover you have none
    expect(routeFor(["kinetic", "couple", "list"])).toBeNull()
    expect(routeFor(["kinetic", "check", "camera:x", "move"])).toBeNull()
  })

  test("a global flag before the command cannot hide the act behind it", () => {
    // `iris --print-logs camera left` still routes; reading parts[0] would have found the flag,
    // matched nothing, and let the act through unguarded.
    expect(routeFor(["--print-logs", "camera", "left"])).toMatchObject({ class: "camera", verb: "move" })
    // A flag's VALUE looks like a word, so the command name comes from yargs' parsed path; raw
    // argv alone would read this as the command "debug" and route nothing.
    const raw = ["--log-level", "DEBUG", "hive", "run", "studio-mac", "ls"]
    expect(routeFor(raw, ["hive", "run"])).toMatchObject({ class: "node", verb: "run", instance: "studio-mac" })
  })

  test("the target node is taken from the raw argv, because yargs drops it", () => {
    // `iris hive run studio-mac ls` reaches a middleware as _ = ["hive","run"] — the node, the one
    // thing that says WHICH machine is driven, is gone. So the route reads raw argv.
    expect(routeFor(["hive", "run", "studio-mac", "ls"], ["hive", "run"])!.instance).toBe("studio-mac")
    expect(routeFor(["hive", "run"], ["hive", "run"])!.instance).toBeNull()
  })

  test("a command nobody routed is a read, not an act", () => {
    // fail-safe direction: an unrouted command cannot silently DEMAND a couple nobody can create
    expect(routeFor(["leads", "list"])).toBeNull()
    expect(routeFor([])).toBeNull()
    expect(routeFor(["camera"])).toBeNull()
  })

  test("the class-level check passes a coupled agent and refuses an uncoupled one", () => {
    const base = { actor: { kind: "agent" as const, hash: HASH }, node: NODE, verb: "move", now: NOW }
    expect(decideClass({ ...base, bodyClass: "camera", couples: [couple()] }).decision).toBe("allow")
    expect(decideClass({ ...base, bodyClass: "camera", couples: [] }).decision).toBe("deny")
    // a couple for ANOTHER class does not pass the gate for this one
    expect(decideClass({ ...base, bodyClass: "node", couples: [couple()] }).decision).toBe("deny")
    // nor does a verb it was never blessed for
    expect(decideClass({ ...base, verb: "run", bodyClass: "camera", couples: [couple()] }).decision).toBe("deny")
  })

  test("the coarse check is coarse ON PURPOSE, and the fine check still disagrees", () => {
    // one camera coupled; the class gate passes for the class…
    const c = [couple({ body: "camera:obsbot-tiny" })]
    const base = { actor: { kind: "agent" as const, hash: HASH }, node: NODE, verb: "move", couples: c, now: NOW }
    expect(decideClass({ ...base, bodyClass: "camera" }).decision).toBe("allow")
    // …and the instance check refuses the camera that is NOT coupled. Coarse-then-fine.
    expect(decide({ ...base, body: "camera:logitech-brio" }).decision).toBe("deny")
  })

  test("an operator and a locked node behave the same at both levels", () => {
    const base = { node: NODE, verb: "move", couples: [], now: NOW }
    expect(decideClass({ ...base, bodyClass: "camera", actor: { kind: "operator" } }).decision).toBe("allow")
    expect(decideClass({ ...base, bodyClass: "camera", actor: { kind: "operator" }, enforceOperators: true }).decision).toBe("deny")
  })
})

describe("gap 2 — signed couples, so a fleet can be coupled centrally", () => {
  const iss = generateIssuer()
  const trusted = { [iss.issuer]: iss.publicKeyPem }
  const verifySig = (c: Couple) => verifyCoupleSig(c, trusted)
  const act = (couples: Couple[], v?: (c: Couple) => boolean) =>
    decide({ actor: { kind: "agent", hash: HASH }, node: NODE, body: "camera:obsbot-tiny", verb: "move", couples, now: NOW, verifySig: v })

  test("a couple issued elsewhere works here, with no network call", () => {
    const c = couple({ id: "cpl_issued" })
    const signed = { ...c, sig: signCouple(c, iss.privateKeyPem, iss.issuer) }
    expect(verifyCoupleSig(signed, trusted)).toBe(true)
    expect(act([signed], verifySig).decision).toBe("allow")
  })

  test("a signed couple with NO verifier available is refused, never waved through", () => {
    const c = couple({ id: "cpl_issued" })
    const signed = { ...c, sig: signCouple(c, iss.privateKeyPem, iss.issuer) }
    expect(act([signed]).decision).toBe("deny")
    expect(act([signed]).reason).toContain("could not be verified")
  })

  test("an issuer this node does not trust is nobody", () => {
    const rogue = generateIssuer()
    const c = couple({ id: "cpl_rogue" })
    const signed = { ...c, sig: signCouple(c, rogue.privateKeyPem, rogue.issuer) }
    expect(verifyCoupleSig(signed, trusted)).toBe(false)
    expect(act([signed], verifySig).decision).toBe("deny")
  })

  test("the signature must match the issuer it NAMES, not merely some issuer this node trusts", () => {
    // Two trusted issuers — a studio key and a client key. A couple signed by the client that
    // claims to come from the studio must fail, or trusting two issuers would mean trusting
    // either one to speak for the other.
    const second = generateIssuer()
    const both = { [iss.issuer]: iss.publicKeyPem, [second.issuer]: second.publicKeyPem }
    const c = couple({ id: "cpl_crossclaim" })
    const signedBySecond = signCouple(c, second.privateKeyPem, second.issuer)
    expect(verifyCoupleSig({ ...c, sig: signedBySecond }, both)).toBe(true)
    expect(verifyCoupleSig({ ...c, sig: { ...signedBySecond, issuer: iss.issuer } }, both)).toBe(false)
    // and an issuer name this node has never heard of is refused even when the bytes were signed
    // by a key it DOES trust — the lookup must be by the claimed name, never "try the keys we have"
    expect(verifyCoupleSig({ ...c, sig: { ...signCouple(c, iss.privateKeyPem, iss.issuer), issuer: "iss_neverseen" } }, both)).toBe(false)
  })

  test("EVERY GRANTING FIELD IS SIGNED — editing any of them breaks the signature", () => {
    const c = couple({ id: "cpl_issued", policy: { max_single_expense_cents: 50, hitl: true, expires_at: "2026-09-20T00:00:00.000Z" } })
    const sig = signCouple(c, iss.privateKeyPem, iss.issuer)
    const tampered: Array<[string, Couple]> = [
      ["agent", { ...c, agent: "sha256:" + "b".repeat(64) }],
      ["node", { ...c, node: "someone-elses-node" }],
      ["body", { ...c, body: "camera:*" }],
      ["allowlist", { ...c, allowlist: ["move", "record"] }],
      ["budget", { ...c, policy: { ...c.policy, max_single_expense_cents: 100000 } }],
      ["hitl", { ...c, policy: { ...c.policy, hitl: false } }],
      ["expiry", { ...c, policy: { ...c.policy, expires_at: "2099-01-01T00:00:00.000Z" } }],
      ["id", { ...c, id: "cpl_other" }],
    ]
    for (const [field, t] of tampered) {
      expect({ field, ok: verifyCoupleSig({ ...t, sig }, trusted) }).toEqual({ field, ok: false })
    }
    // decoration is NOT signed: renaming the label grants nothing, so it must not break the couple
    expect(verifyCoupleSig({ ...c, agent_label: "renamed", sig }, trusted)).toBe(true)
  })

  test("a forged or malformed signature fails closed", () => {
    const c = couple()
    expect(verifyCoupleSig({ ...c, sig: { alg: "ed25519", issuer: iss.issuer, value: "not base64 !!" } }, trusted)).toBe(false)
    expect(verifyCoupleSig({ ...c, sig: { alg: "hmac" as "ed25519", issuer: iss.issuer, value: "x" } }, trusted)).toBe(false)
    expect(verifyCoupleSig(c, trusted)).toBe(false) // unsigned is not "verified"
    expect(verifyCoupleSig({ ...c, sig: signCouple(c, iss.privateKeyPem, iss.issuer) }, { [iss.issuer]: "-----BEGIN PUBLIC KEY-----\nrubbish\n-----END PUBLIC KEY-----" })).toBe(false)
  })

  test("the same couple always signs to the same bytes, whatever the key order", () => {
    const a = couple({ allowlist: ["move", "zoom"] })
    const b = { ...couple({ allowlist: ["zoom", "move"] }) }
    expect(canonicalCouple(a)).toBe(canonicalCouple(b))
    expect(issuerFingerprint(iss.publicKeyPem)).toBe(iss.issuer)
  })
})

describe("gap 3 — budgets that see a whole run, not one act", () => {
  const acts = [
    { ts: "2026-09-19T09:00:00.000Z", couple_id: "cpl_test", decision: "allow", estimated_cents: 30, run_id: "run_a" },
    { ts: "2026-09-19T10:00:00.000Z", couple_id: "cpl_test", decision: "allow", estimated_cents: 30, run_id: "run_a" },
    { ts: "2026-09-19T10:05:00.000Z", couple_id: "cpl_test", decision: "deny", estimated_cents: 500, run_id: "run_a" },
    { ts: "2026-09-18T23:00:00.000Z", couple_id: "cpl_test", decision: "allow", estimated_cents: 999, run_id: "run_old" },
    { ts: "2026-09-19T11:00:00.000Z", couple_id: "cpl_other", decision: "allow", estimated_cents: 900, run_id: "run_a" },
  ]

  test("spend counts this couple, this day, this run — and never a refusal", () => {
    const s = spendFor(acts, { coupleId: "cpl_test", runId: "run_a", now: NOW })
    expect(s).toEqual({ runCents: 60, dayCents: 60, dayActs: 2 })
    // a refusal costs nothing: counting them would let a misconfigured agent exhaust its own budget
    expect(spendFor([acts[2]!], { coupleId: "cpl_test", runId: "run_a", now: NOW })).toEqual(EMPTY_SPEND)
    expect(utcDay("2026-09-19T23:59:59.999Z")).toBe("2026-09-19")
  })

  test("a thousand cheap acts are stopped by the day ceiling the per-act cap never sees", () => {
    const policy = { max_single_expense_cents: 50, max_day_cents: 100 }
    // each act is well under the per-act cap…
    expect(budgetRefusal(policy, EMPTY_SPEND, 30)).toBeNull()
    // …and the day ceiling still ends the night
    expect(budgetRefusal(policy, { runCents: 0, dayCents: 90, dayActs: 3 }, 30)).toContain("one day may not exceed")
  })

  test("each ceiling fires on its own, and the boundary is allowed", () => {
    expect(budgetRefusal({ max_run_cents: 100 }, { runCents: 70, dayCents: 0, dayActs: 0 }, 31)).toContain("one run")
    expect(budgetRefusal({ max_run_cents: 100 }, { runCents: 70, dayCents: 0, dayActs: 0 }, 30)).toBeNull()
    expect(budgetRefusal({ max_day_acts: 3 }, { runCents: 0, dayCents: 0, dayActs: 3 }, 0)).toContain("3 time(s) per day")
    expect(budgetRefusal({ max_day_acts: 3 }, { runCents: 0, dayCents: 0, dayActs: 2 }, 0)).toBeNull()
    expect(budgetRefusal({}, { runCents: 9e9, dayCents: 9e9, dayActs: 9e9 }, 9e9)).toBeNull() // no policy, no ceiling
  })

  test("the guard refuses when a window is exhausted, naming which one", () => {
    const c = couple({ policy: { max_day_cents: 100 } })
    const d = decide({
      actor: { kind: "agent", hash: HASH }, node: NODE, body: "camera:obsbot-tiny", verb: "move",
      couples: [c], now: NOW, estimatedCents: 30, spend: { runCents: 0, dayCents: 90, dayActs: 3 },
    })
    expect(d.decision).toBe("deny")
    expect(d.reason).toContain("one day may not exceed")
  })

  test("an act declares its cost; nothing guesses one", () => {
    expect(declaredCents(["hive", "run", "--cents", "250"], {})).toBe(250)
    expect(declaredCents(["hive", "run"], { IRIS_ACT_CENTS: "75" })).toBe(75)
    expect(declaredCents(["hive", "run"], {})).toBeNull()
    expect(declaredCents(["hive", "run", "--cents", "-5"], {})).toBeNull()
    expect(declaredCents(["hive", "run", "--cents", "abc"], {})).toBeNull()
  })
})

describe("gap 4 — a blessed verb the body does not have is a typo", () => {
  test("coupling an unknown verb is caught at coupling time, not at act time", () => {
    expect(unknownVerbs("camera:obsbot-tiny", ["move", "pan"])).toEqual(["pan"])
    expect(unknownVerbs("camera:obsbot-tiny", ["move", "zoom"])).toEqual([])
    expect(unknownVerbs("obs:studio", ["record", "*"])).toEqual([])
  })

  test("a class IRIS does not model yet is not second-guessed", () => {
    // an adapter we have never heard of: we do not know its vocabulary, so we claim nothing
    expect(unknownVerbs("arm:ur5", ["grip", "rotate"])).toEqual([])
    expect(knownVerbs("arm")).toEqual([])
  })

  test("every class in the registry declares verbs, and the route table only emits those", () => {
    for (const c of BODY_CLASSES) expect(c.verbs.length).toBeGreaterThan(0)
    const routed = [
      ["camera", "left"], ["camera", "zoom", "60"], ["camera", "patrol"], ["camera", "reset"],
      ["obs", "scene", "x"], ["obs", "record", "start"], ["obs", "stream", "start"], ["obs", "mute", "mic"],
      ["hive", "run", "n", "ls"], ["hive", "task", "x"], ["hive", "send", "x"],
      ["n8n", "trigger", "w"], ["device", "clean", "--apply"],
    ]
    for (const argv of routed) {
      const r = routeFor(argv)!
      expect({ argv: argv.join(" "), ok: knownVerbs(r.class).includes(r.verb) }).toEqual({ argv: argv.join(" "), ok: true })
    }
  })
})
