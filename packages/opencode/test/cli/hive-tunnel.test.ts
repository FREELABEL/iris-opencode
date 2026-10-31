import { expect, test } from "bun:test"
import { refusedPort, parseFor, funnelArgs, explainFunnelError, DEFAULT_PUBLIC_PORT } from "../../src/cli/cmd/platform-hive-tunnel"

// #188585 — a public URL via Tailscale Funnel, shaped around the risk. These pin the guardrails.
test("the Hive bridge port is never published, whatever it is configured as", () => {
  expect(refusedPort(3200)).toMatch(/Hive bridge/)
  expect(refusedPort(4555, { BRIDGE_PORT: "4555" })).toMatch(/Hive bridge/)
  expect(refusedPort(3000, {})).toBeNull()
  for (const bad of [0, -1, 70000, 3.5]) expect(refusedPort(bad, {})).toMatch(/not a port/)
})
test("foreground by default; --bg only when asked; 8443 so a tailnet serve on 443 is never replaced", () => {
  expect(DEFAULT_PUBLIC_PORT).toBe(8443)
  expect(funnelArgs(3000, 8443, false)).toEqual(["funnel", "--https=8443", "3000"])
  expect(funnelArgs(3000, 443, true)).toEqual(["funnel", "--bg", "--https=443", "3000"])
})
test("--for is bounded: 24h max, no zero, no garbage", () => {
  expect(parseFor("30m")).toBe(30 * 60_000)
  expect(parseFor("2h")).toBe(2 * 3_600_000)
  expect(parseFor("90s")).toBe(90_000)
  expect(parseFor("45")).toBe(45 * 60_000)
  for (const bad of ["0m", "25h", "forever", "", undefined]) expect(parseFor(bad as any)).toBeNull()
})
test("funnel refusals are explained in words that say what to do", () => {
  expect(explainFunnelError("Funnel not available; \"funnel\" node attribute not set")).toMatch(/node attribute/)
  expect(explainFunnelError("serve: HTTPS is disabled")).toMatch(/HTTPS Certificates/)
  expect(explainFunnelError("NeedsLogin")).toMatch(/vpn up/)
  expect(explainFunnelError("something else")).toBeNull()
})
