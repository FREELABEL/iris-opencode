import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { decideSeal, e2eMode, nodeKeyFetch, sealedConfigFields } from "../../src/cli/cmd/hive-e2e"
import { ENVELOPE_VERSION, generateDek, openContent, sealContent } from "../../src/cli/lib/envelope"
import { parseManifest } from "../../src/cli/cmd/platform-hive-inbox"

/**
 * 2.1 of "Hive without Tailscale": our servers must not be able to read what one node sends
 * another. Measured 2026-10-28 on iris-hive-001 / iris-hive-002:
 *   - default `hive send` used AES-CBC under SHA-256(the sender's node_api_key), a key the
 *     platform can derive, and sent text and links in plain text;
 *   - `--envelope` failed for every signed-in user ("Include your node API key"): the envelope
 *     endpoints are auth.node and the CLI sent the user token;
 *   - dispatchToNode forwarded only encrypted + encryption_iv, dropping every envelope field.
 */

describe("e2eMode — end-to-end is the default", () => {
  test("no flag, no env → auto (seal when the recipient has a key)", () => {
    expect(e2eMode(undefined, {})).toBe("auto")
  })
  test("--envelope → require (never downgrade)", () => {
    expect(e2eMode(true, {})).toBe("require")
  })
  test("--no-envelope → off", () => {
    expect(e2eMode(false, {})).toBe("off")
  })
  test("env opt-outs and opt-ins still work", () => {
    expect(e2eMode(undefined, { IRIS_HIVE_ENVELOPE: "1" })).toBe("require")
    expect(e2eMode(undefined, { IRIS_HIVE_E2E: "require" })).toBe("require")
    expect(e2eMode(undefined, { IRIS_HIVE_E2E: "off" })).toBe("off")
  })
})

describe("decideSeal — when to seal, warn, or refuse", () => {
  test("recipient has a key → seal", () => {
    expect(decideSeal("auto", { ok: true }, "iris-hive-002")).toEqual({ seal: true })
  })
  test("recipient has no key (default) → legacy, with a warning that names the fix", () => {
    const d = decideSeal("auto", { ok: false, code: "no_recipient_key", message: "x" }, "iris-hive-002")
    expect(d.seal).toBe(false)
    expect("warning" in d && d.warning).toContain("iris hive keys register")
    expect("warning" in d && d.warning).toContain("iris-hive-002")
  })
  test("recipient has no key with --envelope → refuse", () => {
    const d = decideSeal("require", { ok: false, code: "no_recipient_key", message: "no key" }, "n")
    expect("error" in d).toBe(true)
  })
  test("any other failure → refuse, never a silent downgrade", () => {
    const d = decideSeal("auto", { ok: false, code: "other", message: "HTTP 500" }, "n")
    expect("error" in d).toBe(true)
  })
  test("server refuses on escrow policy (production today) → legacy with a warning, not a broken send", () => {
    const d = decideSeal("auto", { ok: false, code: "server_policy", message: "escrow policy is `required`" }, "n")
    expect(d.seal).toBe(false)
    expect("warning" in d && d.warning).toContain("escrow policy")
  })
  test("server policy refusal when the sender named a class → refuse", () => {
    const d = decideSeal("auto", { ok: false, code: "server_policy", message: "x" }, "n", { explicitPolicy: true })
    expect("error" in d).toBe(true)
  })
  test("server policy refusal with --envelope → refuse", () => {
    expect("error" in decideSeal("require", { ok: false, code: "server_policy", message: "x" }, "n")).toBe(true)
  })
  test("--no-envelope → legacy, and it says so", () => {
    const d = decideSeal("off", null, "n")
    expect(d.seal).toBe(false)
    expect("warning" in d && d.warning).toContain("our servers can decrypt")
  })
})

describe("sealedConfigFields — the daemon gets everything it needs to open the envelope", () => {
  test("every envelope field is forwarded, and the recipient can open the blob from them alone", () => {
    const id = "11111111-2222-3333-4444-555555555555"
    const dek = generateDek()
    const sealed = sealContent(Buffer.from("secret plan"), dek, id)
    const payload = {
      encrypted: true,
      envelope_version: ENVELOPE_VERSION,
      envelope_id: id,
      envelope_nonce: sealed.nonce.toString("base64"),
      envelope_tag: sealed.tag.toString("base64"),
      envelope_target: "node:abc",
      prompt: "End-to-end encrypted message",
    }
    const cfg = sealedConfigFields(payload) as Record<string, string>
    expect(cfg.envelope_version).toBe(ENVELOPE_VERSION)
    expect(cfg.envelope_target).toBe("node:abc")
    expect(cfg.encryption_iv).toBeUndefined()
    const opened = openContent(
      { ciphertext: sealed.ciphertext, nonce: Buffer.from(cfg.envelope_nonce, "base64"), tag: Buffer.from(cfg.envelope_tag, "base64") } as any,
      dek,
      cfg.envelope_id,
    )
    expect(opened.toString()).toBe("secret plan")
    expect(sealed.ciphertext.toString("latin1")).not.toContain("secret plan")
  })
  test("legacy transfers still forward their iv", () => {
    expect(sealedConfigFields({ encrypted: true, encryption_iv: "ab" })).toEqual({ encrypted: true, encryption_iv: "ab" })
  })
  test("plain payloads carry no crypto fields", () => {
    expect(sealedConfigFields({ prompt: "hi" })).toEqual({})
  })
})

describe("nodeKeyFetch — envelope endpoints are auth.node", () => {
  let home: string
  const realHome = process.env.HOME
  const realFetch = globalThis.fetch
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "e2e-home-"))
    process.env.HOME = home
  })
  afterEach(() => {
    process.env.HOME = realHome
    globalThis.fetch = realFetch
    rmSync(home, { recursive: true, force: true })
  })
  test("sends this machine's node_api_key, not the user token", async () => {
    mkdirSync(join(home, ".iris"), { recursive: true })
    writeFileSync(join(home, ".iris", "config.json"), JSON.stringify({ node_api_key: "node_live_TEST" }))
    let auth = ""
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).Authorization
      return new Response("{}")
    }) as any
    await nodeKeyFetch("/api/v6/hive/transfers/targets", { headers: { Authorization: "Bearer user-token" } })
    expect(auth).toBe("Bearer node_live_TEST")
  })
  test("a machine with no node key is told so (no request made)", async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response("{}") }) as any
    await expect(nodeKeyFetch("/api/v6/hive/keys")).rejects.toThrow("not a Hive node")
    expect(called).toBe(false)
  })
})

describe("parseManifest — one bad row must not take down the inbox (#191574)", () => {
  test("a row without a file is skipped and kept verbatim; valid rows list", () => {
    const good = JSON.stringify({ id: "a1", file: "2026_message.txt", type: "text", from_node: "x", received_at: "2026-10-28", read: false })
    const bad = JSON.stringify({ id: "a", read: true, from_user: "alex" })
    const { items, skipped } = parseManifest([good, bad, "not json", ""].join("\n"))
    expect(items.map((i) => i.id)).toEqual(["a1"])
    expect(skipped).toEqual([bad, "not json"])
  })
})
