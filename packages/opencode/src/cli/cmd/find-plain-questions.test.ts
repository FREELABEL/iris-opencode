import { describe, expect, test } from "bun:test"
import { searchCapabilities } from "./platform-find"
import index from "../../../capabilities.json"

// #192223: an evaluation of a "one screen for my business" post asked IRIS plain questions whose
// answers already exist. `iris find` returned unrelated playbooks for them, so the capability read
// as missing. Each case is a question as a non-technical owner would type it.
const rank = (q: string, name: string) =>
  searchCapabilities(index as any, q.toLowerCase(), "command", 400).findIndex((h) => h.e.name === name) + 1

const CASES: [string, string][] = [
  ["every message from whatsapp email slack and calendar in one feed", "atlas:comms"],
  ["see my leads by funnel stage", "leads stats"],
  ["ask a question across everything my business knows", "memory"],
  ["send one instruction to all my agents at once", "broadcast"],
  ["bank statements into profit and loss per business", "mint import"],
  ["what machines and compute do i own", "hive inventory"],
]

describe("#192223 plain questions reach the command that answers them", () => {
  for (const [q, name] of CASES) {
    test(`"${q}" → ${name} in the top 3`, () => {
      const r = rank(q, name)
      expect(r).toBeGreaterThan(0)
      expect(r).toBeLessThanOrEqual(3)
    })
  }
})
