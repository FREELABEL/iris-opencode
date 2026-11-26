import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createPagePayload } from "./platform-pages"

// #194367 — `pages create` returned "Status: published": it sent auto_publish:true, and the server
// publishes on that. A created page is a draft unless --publish is passed.
describe("pages create (#194367)", () => {
  const base = { slug: "x", title: "X", ownerType: "bloq", ownerId: 952, jsonContent: { components: [] } }

  test("a new page is a draft — auto_publish is off unless asked for", () => {
    const p = createPagePayload(base)
    expect(p.status).toBe("draft")
    expect(p.auto_publish).toBe(false)
  })

  test("--publish is the only way to go live at create", () => {
    expect(createPagePayload({ ...base, publish: true }).auto_publish).toBe(true)
  })

  test("the owner is whatever was passed — there is no default board", () => {
    expect(createPagePayload(base).owner_id).toBe(952)
    const src = readFileSync(path.join(import.meta.dir, "platform-pages.ts"), "utf8")
    const create = src.slice(src.indexOf('command: "create"'), src.indexOf("async handler", src.indexOf('command: "create"')))
    expect(create).not.toMatch(/"owner-id",\s*\{[^}]*default:/)
    expect(create).toMatch(/"owner-id",\s*\{[^}]*demandOption: true/)
  })

  test("the help says it is a draft, and what --publish does", () => {
    const src = readFileSync(path.join(import.meta.dir, "platform-pages.ts"), "utf8")
    const create = src.slice(src.indexOf('command: "create"'), src.indexOf("async handler", src.indexOf('command: "create"')))
    expect(create).toContain("as a DRAFT")
    expect(create).toMatch(/"publish",\s*\{[\s\S]*WORLD-READABLE/)
    expect(create).toContain('"draft"')
  })
})
