import { describe, expect, test } from "bun:test"
import { assertBindIsSafe, isLoopbackHost } from "../../src/cli/network"

/**
 * #182762 — the session server has no authentication, so the loopback bind is the only control.
 *
 * The server exposes POST /session/:id/shell and the Pty routes. Putting that on 0.0.0.0 is
 * unauthenticated remote code execution as the logged-in user, and `--mdns` also advertises it
 * over Bonjour so an attacker on the same wifi does not even have to scan for it.
 *
 * These assertions are the rule itself, provable without binding a socket.
 */
describe("isLoopbackHost", () => {
  test("recognises the loopback forms", () => {
    for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]", " 127.0.0.1 "]) {
      expect(isLoopbackHost(h)).toBe(true)
    }
  })

  test("recognises the whole 127.0.0.0/8 block, not just .1", () => {
    // 127.0.0.2 is as local as 127.0.0.1, and treating it as routable would refuse a legitimate
    // bind — a fail-closed check that cries wolf gets disabled.
    for (const h of ["127.0.0.2", "127.1.2.3", "127.255.255.254"]) {
      expect(isLoopbackHost(h)).toBe(true)
    }
  })

  test("does NOT treat a routable address as loopback", () => {
    // 0.0.0.0 is the one that matters: it is every interface, which is what --mdns used to set.
    // The 127.x lookalikes are here because a substring or prefix check would pass them.
    for (const h of ["0.0.0.0", "192.168.1.10", "10.0.0.5", "::", "example.com", "127.0.0.1.evil.com", "1127.0.0.1"]) {
      expect(isLoopbackHost(h)).toBe(false)
    }
  })

  test("an empty or missing hostname is not loopback", () => {
    // Absent input must not read as safe. "" binds to every interface in some stacks.
    expect(isLoopbackHost("")).toBe(false)
    expect(isLoopbackHost(undefined as unknown as string)).toBe(false)
  })
})

describe("assertBindIsSafe", () => {
  test("loopback is allowed with no token — the default must keep working", () => {
    expect(() => assertBindIsSafe({ hostname: "127.0.0.1", tokenPresent: false })).not.toThrow()
    expect(() => assertBindIsSafe({ hostname: "localhost", tokenPresent: false })).not.toThrow()
  })

  test("a routable bind with no token is REFUSED, not warned about", () => {
    // Warn-and-continue was the old shape of this bug elsewhere in the codebase: a warning on a
    // terminal that has already scrolled is not a control.
    expect(() => assertBindIsSafe({ hostname: "0.0.0.0", tokenPresent: false })).toThrow()
    expect(() => assertBindIsSafe({ hostname: "192.168.1.10", tokenPresent: false })).toThrow()
  })

  test("--mdns is refused too, and the message says why", () => {
    // --mdns is the dangerous one: it flips the bind AND publishes the service over Bonjour.
    let msg = ""
    try {
      assertBindIsSafe({ hostname: "0.0.0.0", mdns: true, tokenPresent: false })
    } catch (e) {
      msg = String((e as Error).message)
    }
    expect(msg).toContain("--mdns")
    expect(msg).toContain("Bonjour")
    // The refusal has to tell someone how to proceed, or it just gets worked around.
    expect(msg).toContain("IRIS_SERVER_TOKEN")
    expect(msg).toContain("182762")
  })

  test("a token permits a deliberate routable bind", () => {
    expect(() => assertBindIsSafe({ hostname: "0.0.0.0", mdns: true, tokenPresent: true })).not.toThrow()
  })
})
