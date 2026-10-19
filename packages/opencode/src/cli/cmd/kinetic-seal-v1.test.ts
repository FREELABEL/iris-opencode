import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  agentCanonicalJsonV1,
  agentSealV1,
  agentSealLegacy,
  coupleHash,
  mintHex,
  couplesNeedingReseal,
  RESEAL_MESSAGE,
  AGENT_HASH,
  type Couple,
} from "./kinetic-couple"

/**
 * Mint seal v1 (#184905). The CLI must produce the server's mint_hash byte for byte, or
 * `iris agents mint --status` reports a mismatch on every agent and a couple sealed locally never
 * equals the minted identity.
 *
 * GOLDEN VALUES ARE THE SERVER'S. Each `json`/`hash` below was produced by running fl-api's
 * App\Services\Agents\AgentSeal (commit 689ccc9d) under PHP 8.2 over the same input text — not
 * by this TypeScript. The inputs are JSON TEXT, parsed here exactly as an API response would be,
 * so `1.0` arrives the way it arrives over the wire.
 */
const INPUTS: Record<string, string> = {
  "unicode_name": "{\"name\": \"\\u00dcn\\u00efc\\u00f8d\\u00e9 \\ud83e\\udd16 agent\", \"config\": {\"model\": \"gpt-4.1-nano\"}, \"initial_prompt\": \"see https://heyiris.io/p/x\"}",
  "line_terminators": "{\"name\": \"lt\", \"initial_prompt\": \"line one\\u2028line two\\u2029end\\ttab\\u0001ctl \\\"q\\\"\", \"settings\": {\"system_prompt\": \"sys\"}}",
  "nested_unsorted": "{\"name\": \"nest\", \"config\": {\"zeta\": {\"b\": 2, \"a\": 1, \"B\": 0}, \"alpha\": [{\"y\": 1, \"x\": 2}], \"\\uff5a\": 1, \"\\ud83d\\ude00\": 2, \"model\": \"m\", \"tools\": [\"t2\", \"t1\"]}}",
  "empty_nested": "{\"name\": \"empty\", \"config\": {\"opts\": {}, \"list\": [], \"deep\": {\"inner\": {}}, \"model\": null}, \"settings\": {\"model\": \"s-model\"}}",
  "integral_float": "{\"name\": \"floats\", \"config\": {\"temperature\": 1.0, \"top_p\": 0.5, \"max\": -3.0}}",
  "volatile": "{\"name\": \"vol\", \"config\": {\"model\": \"x\", \"schedule\": \"* * * * *\", \"heartbeat\": {\"on\": true}, \"heartbeat_mode\": \"auto\", \"stats\": {\"n\": 3}, \"last_run_at\": \"2026\", \"last_status\": \"ok\", \"last_error\": null, \"last_heartbeat_at\": \"t\", \"cloud_sync\": true, \"keep\": \"yes\"}}",
  "volatile_stripped": "{\"name\": \"vol\", \"config\": {\"model\": \"x\", \"keep\": \"yes\"}}",
  "bare": "{\"name\": \"bare\"}"
}

const GOLDEN: Record<string, { json: string; hash: string }> = {
  unicode_name: { json: "{\"config\":{\"model\":\"gpt-4.1-nano\"},\"instructions\":\"see https://heyiris.io/p/x\",\"model\":\"gpt-4.1-nano\",\"name\":\"\u00dcn\u00efc\u00f8d\u00e9 \ud83e\udd16 agent\",\"system_prompt\":null,\"tools\":[]}", hash: "2075525f1b71f222f464d623c819701c71eb353fd2bf9bd2c7f76d1311cccb7d" },
  line_terminators: { json: "{\"config\":{},\"instructions\":\"line one\u2028line two\u2029end\\ttab\\u0001ctl \\\"q\\\"\",\"model\":null,\"name\":\"lt\",\"system_prompt\":\"sys\",\"tools\":[]}", hash: "ff0d2005881bdd60dab25b008b9a46cb07932a3e153b82539015dafe87d9f199" },
  nested_unsorted: { json: "{\"config\":{\"alpha\":[{\"x\":2,\"y\":1}],\"model\":\"m\",\"tools\":[\"t2\",\"t1\"],\"zeta\":{\"B\":0,\"a\":1,\"b\":2},\"\ud83d\ude00\":2,\"\uff5a\":1},\"instructions\":null,\"model\":\"m\",\"name\":\"nest\",\"system_prompt\":null,\"tools\":[\"t2\",\"t1\"]}", hash: "be7d2e19743100d6c8e53886961461d6a892d914aff618bca5aff13cfff17736" },
  empty_nested: { json: "{\"config\":{\"deep\":{\"inner\":[]},\"list\":[],\"model\":null,\"opts\":[]},\"instructions\":null,\"model\":\"s-model\",\"name\":\"empty\",\"system_prompt\":null,\"tools\":[]}", hash: "f2860771129387ee35aece2f95bdb0319903598b46a38b3d651697b072998f1f" },
  integral_float: { json: "{\"config\":{\"max\":-3,\"temperature\":1,\"top_p\":0.5},\"instructions\":null,\"model\":null,\"name\":\"floats\",\"system_prompt\":null,\"tools\":[]}", hash: "8f05361035f0f635a83e3b5e404d33154a536607042098de84d017355e7ed53d" },
  volatile: { json: "{\"config\":{\"keep\":\"yes\",\"model\":\"x\"},\"instructions\":null,\"model\":\"x\",\"name\":\"vol\",\"system_prompt\":null,\"tools\":[]}", hash: "3030a13cb6fe784a2b693299b4ba208c1f542084733f6da6a48e13941eb0653b" },
  volatile_stripped: { json: "{\"config\":{\"keep\":\"yes\",\"model\":\"x\"},\"instructions\":null,\"model\":\"x\",\"name\":\"vol\",\"system_prompt\":null,\"tools\":[]}", hash: "3030a13cb6fe784a2b693299b4ba208c1f542084733f6da6a48e13941eb0653b" },
  bare: { json: "{\"config\":{},\"instructions\":null,\"model\":null,\"name\":\"bare\",\"system_prompt\":null,\"tools\":[]}", hash: "36003008ae112c281dcdaa13ebc9c0a429e3bb567373cfed1b74a78d92abf0ef" },
}

const row = (k: string) => (JSON.parse(INPUTS[k]!) as Record<string, unknown>)

describe("agentSealV1 matches server Mint byte for byte", () => {
  for (const k of Object.keys(GOLDEN)) {
    test(k, () => {
      expect(agentCanonicalJsonV1(row(k))).toBe(GOLDEN[k]!.json)
      expect(agentSealV1(row(k))).toBe(GOLDEN[k]!.hash)
    })
  }

  test("U+2028/U+2029 and non-ASCII are written raw, '/' is not escaped", () => {
    const j = agentCanonicalJsonV1(row("line_terminators"))
    expect(j).toContain("\u2028")
    expect(j).not.toContain("\\u2028")
    expect(agentCanonicalJsonV1(row("unicode_name"))).toContain("https://heyiris.io/p/x")
    expect(agentCanonicalJsonV1(row("unicode_name"))).toContain("🤖")
  })

  test("keys sort by UTF-16 code unit, not code point (😀 before ｚ)", () => {
    const j = agentCanonicalJsonV1(row("nested_unsorted"))
    expect(j.indexOf("😀")).toBeLessThan(j.indexOf("ｚ"))
  })

  test("volatile config keys never move the hash", () => {
    expect(agentSealV1(row("volatile"))).toBe(agentSealV1(row("volatile_stripped")))
  })

  test("config and settings stored as JSON strings seal the same as objects", () => {
    const a = row("empty_nested")
    const b = { ...a, config: JSON.stringify(a.config), settings: JSON.stringify(a.settings) }
    expect(agentSealV1(b)).toBe(GOLDEN.empty_nested!.hash)
  })

  test("a non-finite number is refused rather than sealed as null", () => {
    expect(() => agentSealV1({ name: "x", config: { t: Number.NaN } })).toThrow()
  })
})

describe("hash forms: couples keep sha256:, the server prints bare hex", () => {
  test("coupleHash and mintHex round-trip either form", () => {
    const hex = GOLDEN.bare!.hash
    expect(coupleHash(hex)).toBe("sha256:" + hex)
    expect(coupleHash("sha256:" + hex)).toBe("sha256:" + hex)
    expect(AGENT_HASH.test(coupleHash(hex))).toBe(true)
    expect(mintHex("SHA256:" + hex.toUpperCase())).toBe(hex)
  })
})

describe("couples sealed with the legacy formula are named, not silently orphaned", () => {
  const agent = { id: 127, name: "patrol", initial_prompt: "watch the door", config: { model: "gpt-4.1-nano", tools: ["camera"] } }
  const legacy = agentSealLegacy(agent)
  const v1 = agentSealV1(agent)
  const mk = (id: string, hash: string, revoked: string | null = null): Couple => ({
    id, agent: hash, node: "n", body: "camera:*", allowlist: ["move"], policy: {}, created_at: "2026-10-01T00:00:00Z", revoked_at: revoked,
  })

  test("the legacy seal ignored the prompt and model — the bug v1 fixes", () => {
    expect(agentSealLegacy({ ...agent, initial_prompt: "something else" })).toBe(legacy)
    expect(agentSealV1({ ...agent, initial_prompt: "something else" })).not.toBe(v1)
    expect(coupleHash(v1)).not.toBe(legacy)
  })

  test("a live couple on the legacy hash needs a re-seal; v1, revoked and other agents' do not", () => {
    const couples = [mk("cpl_old", legacy), mk("cpl_new", coupleHash(v1)), mk("cpl_dead", legacy, "2026-10-02T00:00:00Z"), mk("cpl_other", "sha256:" + "c".repeat(64))]
    expect(couplesNeedingReseal(couples, legacy, v1).map((c) => c.id)).toEqual(["cpl_old"])
    expect(RESEAL_MESSAGE).toBe("re-seal: the seal format changed to match server Mint (#184905)")
  })

  test("`iris kinetic seal` seals with v1 and reports legacy couples", () => {
    const src = readFileSync(join(import.meta.dir, "platform-kinetic.ts"), "utf8")
    const seal = src.slice(src.indexOf("const SealCommand"), src.indexOf("const CoupleAddCommand"))
    expect(seal).toContain("agentSealV1(row)")
    expect(seal).toContain("couplesNeedingReseal(")
    expect(seal).toContain("RESEAL_MESSAGE")
    expect(seal).not.toMatch(/model:\s*a\.model/)
  })
})
