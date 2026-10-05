import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * `--scope` on `genesis library publish` carries a security property that lives in its ABSENCE
 * of a default, which is exactly the kind of thing a later edit "tidies up" by adding one.
 *
 * Omitting the flag must send no visibility at all, so the server reads it as "unchanged".
 * A default of "private" would look equivalent and behave differently: the studio and
 * build-genesis-page.mjs republish on every save with no opinion about scope, and a defaulted
 * private would pull a public component out of the catalogue on the next ordinary save, with
 * nothing in the output to explain it.
 *
 * Asserted against the source with COMMENTS STRIPPED — the words "default" and "private" appear
 * in the prose around this code, and matching a comment is how a guard passes against the bug
 * it was written to catch.
 */
const SRC = (() => {
  const raw = readFileSync(join(import.meta.dir, "platform-components.ts"), "utf8")
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n")
})()

function scopeOption(): string {
  const m = SRC.match(/\.option\(\s*"scope"\s*,\s*\{[^}]*\}/)
  return m ? m[0] : ""
}

describe("genesis library publish --scope", () => {
  test("the option exists", () => {
    expect(scopeOption()).not.toBe("")
  })

  test("it offers exactly private and public", () => {
    const opt = scopeOption()
    expect(opt).toContain('"private"')
    expect(opt).toContain('"public"')
    expect(opt).toContain("choices")
  })

  // The property under test. An added default silently changes what an omitted flag means.
  test("it declares NO default", () => {
    expect(scopeOption()).not.toMatch(/\bdefault\s*:/)
  })

  test("visibility is sent only when the flag was given", () => {
    // The spread must be conditional on args.scope. An unconditional `visibility:` line would
    // send undefined or a default on every publish.
    expect(SRC).toMatch(/\.\.\.\(\s*args\.scope\s*\?\s*\{\s*visibility:\s*args\.scope\s*\}\s*:\s*\{\}\s*\)/)
    const unconditional = SRC.match(/^\s*visibility:\s/m)
    expect(unconditional).toBeNull()
  })

  test("the comment-stripper actually strips, or every assertion above is meaningless", () => {
    expect(SRC).not.toContain("No DEFAULT on purpose")
    expect(readFileSync(join(import.meta.dir, "platform-components.ts"), "utf8")).toContain("No DEFAULT on purpose")
  })
})
