/**
 * Offer diagnosis — the analysis half of `iris offers audit`, with no network in it.
 *
 * WHY THIS FILE HAS NO FETCH. Every judgement here is a claim about a catalogue, and a claim you
 * cannot reproduce is an opinion. Keeping the rules pure means each one is provable against a
 * fixture, and the command becomes a thin renderer over something that has already been argued.
 *
 * WHAT IT IS MEASURING AGAINST. Hormozi's $100M Offers Ch. 9-10 (Trim & Stack) and the Value
 * Equation the chapter is built on:
 *
 *     Value = (Dream Outcome × Perceived Likelihood) ÷ (Time Delay × Effort & Sacrifice)
 *
 * The chapter's operating claim is that a catalogue a buyer can price-shop is not an offer, it is
 * a feature list. Every check below is one of the failure modes the chapter NAMES, so the output
 * can say which one it found rather than inventing a private vocabulary.
 *
 * THE RULE THIS FILE IS MOST CAREFUL ABOUT: never report a clean pass on something that was not
 * measured. Several of these checks need per-component value and cost data that the current
 * `features` column does not carry. Those return `unmeasured` and name the field that would
 * unlock them — because "no problems found" and "no data to find problems in" render identically
 * to a reader, and only one of them is good news.
 */

/** One thing found, in the chapter's own vocabulary. */
export type Finding = {
  /** Stable id, safe to grep for and to suppress. */
  code: string
  /** The failure mode as the source names it — not a coinage. */
  failureMode: string
  severity: "high" | "medium" | "low"
  /** What is true about the catalogue. */
  what: string
  /** What to do about it. */
  fix: string
  /** Package titles the finding rests on, so it can be checked rather than believed. */
  evidence: string[]
}

/** A check that could not run, and the one thing that would let it. */
export type Unmeasured = {
  code: string
  question: string
  blockedBy: string
}

export type Audit = {
  packageCount: number
  findings: Finding[]
  unmeasured: Unmeasured[]
}

export type OfferPackage = {
  title?: string | null
  price?: number | string | null
  brand?: string | null
  features?: unknown
  description?: string | null
  subtitle?: string | null
}

/**
 * Keys that describe HOW something is billed rather than WHAT the buyer gets.
 *
 * This is the distinction the whole audit turns on. `seats`, `unit` and `credits` are pricing
 * mechanics; a stack is a list of outcomes. A package whose entire `features` object is mechanics
 * has a price and no stack, which is the state the chapter calls a feature list.
 */
const MECHANIC_KEYS = new Set([
  "kind",
  "unit",
  "seats",
  "credits",
  "creditTiers",
  "isPayAsYouGo",
  "interval",
  "billing",
  "billingInterval",
  "billing_interval",
  "currency",
  "trial",
  "trialDays",
  "popular",
  "price",
  "amount",
])

/** The component list, if this package has one at all. */
export function componentsOf(pkg: OfferPackage): string[] {
  const f = pkg.features
  if (Array.isArray(f)) {
    return f.map((x) => (typeof x === "string" ? x : String((x as any)?.name ?? (x as any)?.label ?? ""))).filter(Boolean)
  }
  if (f && typeof f === "object") {
    const entries = Object.entries(f as Record<string, unknown>)
    // A nested list under any key counts as components; bare mechanic keys do not.
    const nested = entries
      .filter(([k]) => !MECHANIC_KEYS.has(k))
      .flatMap(([, v]) => (Array.isArray(v) ? v : []))
      .map((x) => (typeof x === "string" ? x : String((x as any)?.name ?? (x as any)?.label ?? "")))
      .filter(Boolean)
    if (nested.length) return nested
    const informative = entries.filter(([k]) => !MECHANIC_KEYS.has(k)).map(([k]) => k)
    return informative
  }
  return []
}

/**
 * The "if bought separately" arithmetic, when the catalogue carries it.
 *
 * THIS IS THE MECHANISM, not a nice-to-have. The chapter's whole move is a subtraction the
 * PROSPECT performs: a summed standalone value against one price, so the gap is felt rather than
 * claimed. Without per-component value there is no sum, and the price is asked for on trust —
 * which is why `no-anchor` is the highest finding this file can raise.
 *
 * Components may be bare strings (no value) or objects carrying `value` and `cost`. Both shapes
 * exist in the catalogue because `features` is JSON and nothing has ever required the richer one.
 * A component with no value contributes nothing to the sum AND is counted as unvalued, so a
 * half-filled stack cannot masquerade as a complete one.
 */
export type StackMath = {
  components: number
  valued: number
  /** Summed standalone value, in whatever unit the catalogue uses. */
  separately: number
  /** Summed cost to deliver, when present. */
  cost: number | null
  costed: number
}

export function stackMath(pkg: OfferPackage): StackMath {
  const f = pkg.features
  const raw: unknown[] = Array.isArray(f)
    ? f
    : f && typeof f === "object"
      ? Object.entries(f as Record<string, unknown>)
          .filter(([k]) => !MECHANIC_KEYS.has(k))
          .flatMap(([, v]) => (Array.isArray(v) ? v : []))
      : []

  let separately = 0
  let valued = 0
  let cost = 0
  let costed = 0

  for (const c of raw) {
    if (!c || typeof c !== "object") continue
    const rec = c as Record<string, unknown>
    const v = Number(rec.value ?? rec.worth ?? rec.retail ?? rec.msrp)
    if (Number.isFinite(v) && v > 0) {
      separately += v
      valued++
    }
    const k = Number(rec.cost ?? rec.cost_to_deliver ?? rec.costToDeliver)
    if (Number.isFinite(k) && k >= 0) {
      cost += k
      costed++
    }
  }

  return { components: raw.length, valued, separately, cost: costed ? cost : null, costed }
}

export function priceOf(pkg: OfferPackage): number | null {
  const raw = pkg.price
  const n = typeof raw === "string" ? Number(raw) : raw
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

/**
 * Does this title say where the buyer ARRIVES, or only what the thing is called?
 *
 * DELIBERATELY CONSERVATIVE, and it reports a prompt rather than a verdict. A product name is a
 * brand decision with history behind it, and a regex is not entitled to overrule that. What it
 * can say honestly is: this title contains no outcome language, so it carries no destination on
 * its own and must be doing that work somewhere else — a subtitle, a page, a salesperson.
 *
 * A single abstract noun ("Lexicon", "Pulse") is the shape that triggers it. Anything with a verb,
 * a result, an audience or a number is left alone.
 */
export function carriesDestination(pkg: OfferPackage): boolean {
  const text = `${pkg.title ?? ""} ${pkg.subtitle ?? ""}`.trim().toLowerCase()
  if (!text) return false
  // Outcome language: a verb or a result the buyer would recognise as a destination.
  const OUTCOME = /\b(get|grow|launch|fill|close|save|cut|double|reach|book|hire|ship|build|convert|reply|replies|leads?|revenue|customers?|clients?|bookings?|hours?|days?|weeks?|per\b|%|\$)/
  return OUTCOME.test(text)
}

/**
 * Where this package sits on the Sales-to-Fulfilment continuum, read from data that already
 * exists rather than a field somebody has to remember to fill in.
 *
 * `sales_led` is the honest signal for done-for-you: it means a human is in the loop before money
 * changes hands, which is exactly the expensive-to-fulfil end. `kind` separates a single module
 * from the bundle. Neither was added for this purpose, which is the point — the catalogue was
 * already describing its own continuum and nothing was reading it.
 */
export function effortModeOf(pkg: OfferPackage): "DFY" | "DIY" | "unknown" {
  const f = pkg.features
  if (!f || typeof f !== "object") return "unknown"
  const rec = f as Record<string, unknown>
  if (rec.sales_led === true) return "DFY"
  if (rec.sales_led === false) return "DIY"
  return "unknown"
}

/** Packages grouped into price bands, to see a menu when there is one. */
export function priceBands(pkgs: OfferPackage[]): Map<number, string[]> {
  const bands = new Map<number, string[]>()
  for (const p of pkgs) {
    const price = priceOf(p)
    if (price === null || price <= 0) continue
    // Order of magnitude, so 49 and 99 are the same conversation and 49 and 4999 are not.
    const band = Math.floor(Math.log10(price))
    const list = bands.get(band) ?? []
    list.push(String(p.title ?? "(untitled)"))
    bands.set(band, list)
  }
  return bands
}

/**
 * Run every rule. Order of findings is severity, then discovery — the caller does not re-sort,
 * so what it prints first is what this file considers most load-bearing.
 */
export function auditOffers(pkgs: OfferPackage[]): Audit {
  const findings: Finding[] = []
  const unmeasured: Unmeasured[] = []

  const named = pkgs.map((p) => String(p.title ?? "(untitled)"))

  // ── 1. Is there a stack at all? ────────────────────────────────────────────
  const stackless = pkgs.filter((p) => componentsOf(p).length < 2)
  if (stackless.length) {
    findings.push({
      code: "no-stack",
      failureMode: "a price with no stack",
      severity: "high",
      what: `${stackless.length} of ${pkgs.length} package(s) list no components a buyer would recognise — only billing mechanics (seats, unit, credits).`,
      fix: "Give each one 3–5 named components, and name them after the outcome they produce rather than the format they arrive in. A stack is what makes the price a comparison the buyer wins.",
      evidence: stackless.map((p) => String(p.title ?? "(untitled)")).slice(0, 12),
    })
  }

  // ── 2. Can the buyer do the subtraction? ───────────────────────────────────
  // The chapter's mechanism is arithmetic the PROSPECT performs: sum of "if bought separately"
  // against one price. With no per-component value anywhere, that subtraction is unavailable and
  // the price is asked for on trust.
  const math = pkgs.map((p) => ({ pkg: p, m: stackMath(p) }))
  const anyValued = math.some((x) => x.m.valued > 0)

  if (!anyValued) {
    findings.push({
      code: "no-anchor",
      failureMode: "no 'if bought separately' sum",
      severity: "high",
      what: "No package carries a per-component value, so there is no sum to price against.",
      fix:
        "Put a defensible standalone value on each component and show the total beside the price. " +
        "Components live in the JSON `features` column, so this needs no migration — a component may be " +
        '{"name":"…","value":400,"cost":25} instead of a bare string.',
      evidence: [],
    })
  } else {
    // A PARTIALLY VALUED STACK IS THE DANGEROUS ONE. It sums to a number, the number looks like an
    // anchor, and it is quietly missing whatever nobody priced — so the gap shown to a prospect is
    // smaller than the real one and the arithmetic cannot be defended if questioned.
    const partial = math.filter((x) => x.m.valued > 0 && x.m.valued < x.m.components)
    if (partial.length) {
      findings.push({
        code: "partial-anchor",
        failureMode: "a sum that is missing components",
        severity: "medium",
        what: `${partial.length} package(s) value only some of their components, so the "if bought separately" total understates itself.`,
        fix: "Value every component or none. A total that silently omits items is not an anchor you can defend in a sales conversation.",
        evidence: partial.map((x) => `${x.pkg.title}: ${x.m.valued}/${x.m.components} valued`).slice(0, 8),
      })
    }

    // The gap IS the offer. A stack summing to less than its own price inverts the mechanism.
    const inverted = math.filter((x) => {
      const price = priceOf(x.pkg)
      return x.m.valued > 0 && price !== null && price > 0 && x.m.separately <= price
    })
    if (inverted.length) {
      findings.push({
        code: "no-gap",
        failureMode: "priced at or above its own stack",
        severity: "high",
        what: `${inverted.length} package(s) sum to no more than their price — there is no steal for the buyer to feel.`,
        fix: "Either the components are undervalued or the price is wrong. The bundle is supposed to be a fraction of the summed value; at parity the prospect is just paying retail.",
        evidence: inverted
          .map((x) => `${x.pkg.title}: sums to ${x.m.separately} at $${priceOf(x.pkg)}`)
          .slice(0, 8),
      })
    }
  }

  // Trim needs cost. Where it exists, run the 2x2's margin question for real.
  const costed = math.filter((x) => x.m.cost !== null)
  if (costed.length) {
    const thin = costed.filter((x) => {
      const price = priceOf(x.pkg)
      return price !== null && price > 0 && (x.m.cost as number) / price > 0.2
    })
    if (thin.length) {
      findings.push({
        code: "thin-margin",
        failureMode: "high-cost delivery in the core offer",
        severity: "medium",
        what: `${thin.length} package(s) spend more than 20% of price on delivery.`,
        fix:
          "The chapter's compass is roughly 80% gross margin on the core offer after trim. Not a law — but " +
          "high-cost items belong in a premium tier or as a scarce bonus, not in the thing you sell at volume.",
        evidence: thin
          .map((x) => `${x.pkg.title}: cost ${x.m.cost} of $${priceOf(x.pkg)}`)
          .slice(0, 8),
      })
    }
  }

  // ── 3. Is there a middle of the ladder? ────────────────────────────────────
  // Read from `sales_led`, which the catalogue already sets. The chapter's ladder is
  // DIY → DWY → DFY; a catalogue with only the two ends makes the buyer jump from self-serve to
  // an agency engagement, and the people who fall in that gap are the ones who wanted help and
  // could not afford a human.
  const diy = pkgs.filter((p) => effortModeOf(p) === "DIY")
  const dfy = pkgs.filter((p) => effortModeOf(p) === "DFY")
  if (diy.length && dfy.length) {
    const diyTop = Math.max(...diy.map((p) => priceOf(p) ?? 0))
    const dfyFloor = Math.min(...dfy.map((p) => priceOf(p) ?? Infinity))
    findings.push({
      code: "no-dwy",
      failureMode: "the ladder has no middle",
      severity: "high",
      what:
        `${diy.length} self-serve package(s) up to $${diyTop}, and ${dfy.length} sales-led package(s) from $${dfyFloor} — ` +
        "and nothing done-with-you in between.",
      fix:
        "A DWY tier is the cheapest rung to add and usually the best margin: your assets plus a scheduled human, " +
        "priced between the two. It also gives the self-serve buyer somewhere to go that is not a five-figure decision.",
      evidence: [
        `DIY tops out: ${diy.map((p) => String(p.title)).slice(0, 3).join(", ")}`,
        `DFY starts at: ${dfy.map((p) => String(p.title)).slice(0, 3).join(", ")}`,
      ],
    })
  }

  // ── 4. Menu, not offer ─────────────────────────────────────────────────────
  for (const [band, titles] of priceBands(pkgs)) {
    if (titles.length >= 5) {
      const lo = 10 ** band
      findings.push({
        code: "price-cluster",
        failureMode: "feature list you can price-shop",
        severity: "medium",
        what: `${titles.length} packages sit in the $${lo}–$${lo * 10 - 1} band.`,
        fix: "Several near-identical prices is a menu, and a menu invites comparison on price. Either bundle them into one system with a stack, or make each one answer a visibly different problem.",
        evidence: titles.slice(0, 12),
      })
    }
  }

  // ── 5. Selling the vehicle ─────────────────────────────────────────────────
  const vehicleNamed = pkgs.filter((p) => !carriesDestination(p))
  if (vehicleNamed.length) {
    findings.push({
      code: "vehicle-named",
      failureMode: "selling the vehicle instead of the destination",
      severity: "low",
      what: `${vehicleNamed.length} package(s) carry no outcome language in title or subtitle.`,
      fix: "Not a verdict on the names — a prompt. If the title does not say where the buyer arrives, something else has to, and it is worth knowing what that is and whether the buyer ever reads it.",
      evidence: vehicleNamed.map((p) => String(p.title ?? "(untitled)")).slice(0, 12),
    })
  }

  // ── 6. Risk reversal ───────────────────────────────────────────────────────
  const blob = JSON.stringify(pkgs).toLowerCase()
  if (!/guarantee|refund|money.back|risk.free|cancel any/.test(blob)) {
    findings.push({
      code: "no-guarantee",
      failureMode: "no risk reversal",
      severity: "medium",
      what: "No guarantee or refund language anywhere in the catalogue.",
      fix: "The guarantee is the Perceived Likelihood lever, and it is the cheapest one to move. Guarantee only what a delivery vehicle actually produces — a promise you cannot keep is worse than none.",
      evidence: [],
    })
  }

  // ── What could not be measured, and why ────────────────────────────────────
  // Reported only while still true. A permanent "cannot measure" on something that has since
  // become measurable is the same lie as a false pass, pointing the other way.
  const anyCosted = pkgs.some((p) => stackMath(p).cost !== null)
  if (!anyCosted) {
    unmeasured.push({
      code: "trim-2x2",
      question: "Which components are high-cost and low-value, and should be cut first?",
      blockedBy:
        'no cost on components — the trim 2×2 needs cost to you AND value to them. `features` is JSON, so a component can carry {"cost": 25} today',
    })
    unmeasured.push({
      code: "margin-after-trim",
      question: "What is gross margin on the core offer after trimming?",
      blockedBy: "same — without per-component cost there is no margin to check against the ~80% compass",
    })
  }
  unmeasured.push({
    code: "ratio",
    question: "Is each package delivered 1:1, to a group, or one-to-many?",
    blockedBy:
      "not recorded. `sales_led` gives the effort axis, so the continuum is half-read — ratio is the half that decides marginal cost",
  })

  const order = { high: 0, medium: 1, low: 2 } as const
  findings.sort((a, b) => order[a.severity] - order[b.severity])

  return { packageCount: pkgs.length, findings, unmeasured, ...(named.length ? {} : {}) }
}
