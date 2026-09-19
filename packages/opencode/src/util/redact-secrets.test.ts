import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { findSecretShapes, redactSecrets } from "./redact-secrets"

test("redacts credential shapes, including a webhook written without https://", () => {
  const t = "post to discord.com/api/webhooks/1473000000000000000/abcDEF_ghi-JKLmnoPQRstuVWXyz0123 and use sk-proj-ABCDEFGHIJKLMNOPQRSTUV and node_live_ABCDEFGHIJKLMNOP"
  const r = redactSecrets(t)
  expect(findSecretShapes(r)).toEqual([])
  expect(r).toContain("post to [redacted]")
})

test("leaves ordinary prose alone", () => {
  const t = "Set DISCORD_TASK_WEBHOOK_URL in the environment; run iris playbook run marketing-pipeline"
  expect(redactSecrets(t)).toBe(t)
})

test("GUARD: the committed capability index carries no credential shapes (#186275)", () => {
  const index = readFileSync(join(import.meta.dir, "..", "..", "capabilities.json"), "utf8")
  expect(findSecretShapes(index)).toEqual([])
})
