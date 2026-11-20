import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ensureApiFallback, pairedApiHost, planApiFallback } from "./node-api-fallback"

/**
 * #189649 — every customer's Hive node needs a second API host. Production daemons had none, so
 * when freelabel.net stopped answering (2026-10-14/15) every node failed cloud auth for hours.
 * Old daemons already read `iris_api_url_fallback`; `iris update` writes it.
 */
describe("planApiFallback", () => {
  test("a node on freelabel.net gets heyiris.io (the outage case)", () => {
    const p = planApiFallback({ node_api_key: "k", api_url: "https://freelabel.net" })
    expect(p.change && p.fallback).toBe("https://heyiris.io")
  })
  test("iris_api_url (what the installer writes) counts as the primary too", () => {
    const p = planApiFallback({ node_api_key: "k", iris_api_url: "https://heyiris.io" })
    expect(p.change && p.fallback).toBe("https://freelabel.net")
  })
  test("no url at all means the daemon's default, freelabel.net", () => {
    const p = planApiFallback({ node_api_key: "k" })
    expect(p.change && p.fallback).toBe("https://heyiris.io")
  })
  test("never overwrites a fallback someone set", () => {
    expect(planApiFallback({ node_api_key: "k", api_url: "https://freelabel.net", iris_api_url_fallback: "https://x" }).change).toBe(false)
  })
  test("a custom host gets no invented fallback", () => {
    expect(planApiFallback({ node_api_key: "k", api_url: "https://api.client.example" }).change).toBe(false)
  })
  test("not a node, or a local dev node: nothing to do", () => {
    expect(planApiFallback({ api_url: "https://freelabel.net" }).change).toBe(false)
    expect(planApiFallback({ node_api_key: "k", api_url: "https://local.iris.freelabel.net" }).change).toBe(false)
    expect(planApiFallback(null).change).toBe(false)
  })
  test("only ADDS the key — the primary and every other field are untouched", () => {
    const cfg = { node_api_key: "k", api_url: "https://freelabel.net", node_id: "n", paused: false }
    const p = planApiFallback(cfg)
    expect(p.change && p.config).toEqual({ ...cfg, iris_api_url_fallback: "https://heyiris.io" })
  })
  test("pairedApiHost handles www and junk", () => {
    expect(pairedApiHost("https://www.freelabel.net/")).toBe("https://heyiris.io")
    expect(pairedApiHost("nope")).toBeNull()
  })
})

describe("ensureApiFallback on disk", () => {
  const home = () => {
    const h = mkdtempSync(join(tmpdir(), "iris-fb-"))
    mkdirSync(join(h, ".iris"))
    return h
  }
  test("writes the key, keeps the file's permissions, and is idempotent", () => {
    const h = home()
    const p = join(h, ".iris", "config.json")
    writeFileSync(p, JSON.stringify({ node_api_key: "k", api_url: "https://freelabel.net" }), { mode: 0o600 })
    expect(ensureApiFallback(h)).toContain("heyiris.io")
    expect(JSON.parse(readFileSync(p, "utf8")).iris_api_url_fallback).toBe("https://heyiris.io")
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(ensureApiFallback(h)).toBeNull()
  })
  test("no config, or a broken one: silent, nothing written", () => {
    expect(ensureApiFallback(home())).toBeNull()
    const h = home()
    writeFileSync(join(h, ".iris", "config.json"), "{not json")
    expect(ensureApiFallback(h)).toBeNull()
    expect(readFileSync(join(h, ".iris", "config.json"), "utf8")).toBe("{not json")
  })
})
