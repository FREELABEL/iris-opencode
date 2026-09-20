import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { PRODUCTS, productEpilogue } from "../../src/cli/cmd/product-command"
import "../../src/cli/cmd/platform-mint"
import "../../src/cli/cmd/platform-commerce"

/**
 * #186319 — `iris mint --help` pointed at `track-finances-atlas-ledger`, a recipe about
 * `iris atlas:ledger`: a different subsystem that never says "mint" once. Mint had no how-to
 * at all, and looked documented for its entire life, because **a pointer to the wrong doc
 * reads exactly like a pointer to the right one**. Nothing was broken, nothing errored, and
 * the footer printed a real recipe name that really existed.
 *
 * So the check here is not "does the recipe exist" — that was always true. It is "does the
 * recipe this command sends people to actually talk about this command".
 */

const HOW_TO_DIR = join(import.meta.dir, "../../../../scaffold/how-to")

/**
 * Pointers where the recipe is genuinely the right guide but does not contain the command's
 * own name — usually because the recipe is written around a sibling command. Each one is a
 * judgement someone made on purpose; new entries need the same.
 */
const TOPICAL_EXCEPTIONS: Record<string, string[]> = {
  commons: ["certification-courses", "community-curation"],
  reachr: ["outreach-campaign"],
}

const recipes = () => {
  if (!existsSync(HOW_TO_DIR)) return null
  return Object.fromEntries(
    readdirSync(HOW_TO_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => [f.slice(0, -3), readFileSync(join(HOW_TO_DIR, f), "utf8").toLowerCase()]),
  )
}

describe("a product's how-to pointers", () => {
  test("name recipes that exist", () => {
    const all = recipes()
    if (!all) return // recipes live in the repo, not the published package

    const missing: string[] = []
    for (const p of PRODUCTS) {
      for (const h of p.howtos ?? []) if (!(h in all)) missing.push(`${p.name} -> ${h}`)
    }

    expect(missing).toEqual([])
  })

  test("name recipes that actually cover the command", () => {
    const all = recipes()
    if (!all) return

    const silent: string[] = []
    for (const p of PRODUCTS) {
      for (const h of p.howtos ?? []) {
        if (!(h in all)) continue
        if (TOPICAL_EXCEPTIONS[p.name]?.includes(h)) continue
        // The bar is deliberately low — one mention of the command's own name. A recipe
        // that cannot clear it is about something else, which is exactly the mint bug.
        if (!all[h].includes(p.name)) silent.push(`${p.name} -> ${h} never mentions "${p.name}"`)
      }
    }

    expect(silent).toEqual([])
  })

  test("mint points at its own how-to first", () => {
    const all = recipes()
    if (!all) return
    const mint = PRODUCTS.find((p) => p.name === "mint")

    expect(mint?.howtos?.[0]).toBe("track-money-with-iris-mint")
    expect(all["track-money-with-iris-mint"]).toContain("iris mint")
  })

  test("commerce tells the reader where the guide is", () => {
    // It shipped with no howtos and no playbooks key at all, so `iris commerce --help`
    // named neither the recipe nor the playbook that had already been written for it.
    const commerce = PRODUCTS.find((p) => p.name === "commerce")

    expect(commerce?.howtos ?? []).toContain("genesis-atlas-commerce")
    expect(commerce?.playbooks ?? []).toContain("genesis-atlas-commerce")
  })

  test("the footer a reader actually sees names the right guide", () => {
    // The spec being right and the printed help being right are different claims. This
    // asserts the rendered epilogue — the only part anyone reads.
    const mint = PRODUCTS.find((p) => p.name === "mint")!
    const commerce = PRODUCTS.find((p) => p.name === "commerce")!

    expect(productEpilogue(mint)).toContain("iris how-to view track-money-with-iris-mint")
    expect(productEpilogue(mint)).not.toContain("track-finances-atlas-ledger")
    expect(productEpilogue(commerce)).toContain("iris how-to view genesis-atlas-commerce")
    expect(productEpilogue(commerce)).toContain("iris playbook run genesis-atlas-commerce")
  })
})
