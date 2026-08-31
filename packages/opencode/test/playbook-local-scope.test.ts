import { describe, expect, test } from "bun:test"

/**
 * #182937 — a first-class no-cloud scope for `iris playbook publish`.
 *
 * "private" reads like "stays on my machine" and does not mean that: it is a cloud-backed,
 * you-only association. `playbook verify` compares the local file against the API registry and
 * `check-private` fetches the URL "as a stranger would" — both require the playbook to have been
 * uploaded. Right primitive for reaching a second machine, wrong one for zero cloud footprint.
 *
 * The guarantee this feature makes is NEGATIVE — "never written to the API registry" — and a
 * negative is not provable by running the happy path. What makes it true is that the `local`
 * branch returns above every network call in the handler, so these assert on that ORDERING.
 * If someone later moves an irisFetch or a requireAuth above it, this fails.
 */
const SRC = await Bun.file(
  new URL("../src/cli/cmd/platform-playbook.ts", import.meta.url).pathname,
).text()

const publishHandler = (() => {
  const start = SRC.indexOf("const PublishCommand = cmd({")
  expect(start).toBeGreaterThan(-1)
  // The handler runs to the next top-level `const ...Command = cmd({`
  const next = SRC.indexOf("Command = cmd({", start + 30)
  return SRC.slice(start, next > -1 ? next : SRC.length)
})()

describe("playbook publish --scope local", () => {
  test("local is an offered scope", () => {
    expect(publishHandler).toContain('choices: ["local", "private", "project", "public"]')
  })

  test("the local branch returns BEFORE requireAuth", () => {
    const localBranch = publishHandler.indexOf('if (args.scope === "local")')
    const auth = publishHandler.indexOf("requireAuth(")
    expect(localBranch).toBeGreaterThan(-1)
    expect(auth).toBeGreaterThan(-1)
    expect(localBranch).toBeLessThan(auth)
  })

  test("the local branch returns BEFORE every irisFetch in the handler", () => {
    const localBranch = publishHandler.indexOf('if (args.scope === "local")')
    const firstFetch = publishHandler.indexOf("irisFetch(")
    expect(firstFetch).toBeGreaterThan(-1)
    expect(localBranch).toBeLessThan(firstFetch)
  })

  test("the local branch returns BEFORE the widen-consent prompt", () => {
    // Not a widening — it is the narrowest scope there is. Prompting would be nonsense.
    const localBranch = publishHandler.indexOf('if (args.scope === "local")')
    const widen = publishHandler.indexOf("confirmWiden(")
    expect(widen).toBeGreaterThan(-1)
    expect(localBranch).toBeLessThan(widen)
  })

  test("the branch actually returns rather than falling through", () => {
    const from = publishHandler.indexOf('if (args.scope === "local")')
    const to = publishHandler.indexOf('if (args.scope === "project"', from)
    const branch = publishHandler.slice(from, to)
    expect(branch).toContain("return")
    // and it must not itself reach the network
    expect(branch).not.toContain("irisFetch(")
    expect(branch).not.toContain("requireAuth(")
  })

  test("the audience note does not promise a URL for a local playbook", () => {
    const note = SRC.slice(SRC.indexOf("function audienceNote"), SRC.indexOf("const PublishCommand"))
    expect(note).toContain('case "local"')
    expect(note).toContain("never uploaded")
    // and private must stop implying it is local-only — the confusion that produced this ticket
    expect(note).toContain("stored in the cloud registry")
  })
})
