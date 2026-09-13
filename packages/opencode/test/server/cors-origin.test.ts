import { describe, test, expect } from "bun:test"
import { Server } from "../../src/server/server"

/**
 * The CORS allowlist is a SECURITY CONTROL, not a convenience.
 *
 * Measured 2026-09-13: the session server binds 127.0.0.1, so a remote host cannot reach it
 * (`GET <lan-ip>:<port>/session` → 000). But a browser on this machine can, and `GET /session`
 * answers with no credentials — it lists every session on the box. The only thing stopping a
 * page the user happens to visit from reading that, or from POSTing a message into a session,
 * is that an unknown origin gets no `Access-Control-Allow-Origin` back and the browser refuses.
 *
 * That control is one returned value. An edit that returns `input` unconditionally opens every
 * session on the machine to any page on the internet, and every existing test still passes.
 * Hence this file.
 *
 * Returning undefined = refuse.
 */
describe("corsOrigin — the door that is shut by returning nothing", () => {
  test("an arbitrary internet origin is REFUSED", () => {
    for (const evil of [
      "https://evil.example",
      "http://evil.example",
      "https://opencode.ai.evil.example",
      "https://notopencode.ai",
      "null",
      "https://localhost.evil.example",
    ]) {
      expect(Server.corsOrigin(evil)).toBeUndefined()
    }
  })

  test("a missing or empty origin is refused rather than defaulted", () => {
    expect(Server.corsOrigin(undefined)).toBeUndefined()
    expect(Server.corsOrigin(null)).toBeUndefined()
    expect(Server.corsOrigin("")).toBeUndefined()
  })

  test("local origins are allowed — this is what the TUI and the web UI use", () => {
    expect(Server.corsOrigin("http://localhost:4096")).toBe("http://localhost:4096")
    expect(Server.corsOrigin("http://127.0.0.1:60824")).toBe("http://127.0.0.1:60824")
    expect(Server.corsOrigin("tauri://localhost")).toBe("tauri://localhost")
    expect(Server.corsOrigin("http://tauri.localhost")).toBe("http://tauri.localhost")
  })

  test("opencode.ai over HTTPS only — plain http must not be allowed", () => {
    expect(Server.corsOrigin("https://opencode.ai")).toBe("https://opencode.ai")
    expect(Server.corsOrigin("https://app.opencode.ai")).toBe("https://app.opencode.ai")
    expect(Server.corsOrigin("http://opencode.ai")).toBeUndefined()
  })

  test("the subdomain pattern is ANCHORED — a lookalike domain must not slip through", () => {
    // The regex is anchored at both ends. Without the anchors every one of these would match
    // somewhere in the string and be granted.
    for (const lookalike of [
      "https://opencode.ai.attacker.com",
      "https://evil.com/https://opencode.ai",
      "https://xopencode.ai",
      "https://opencode-ai.com",
    ]) {
      expect(Server.corsOrigin(lookalike)).toBeUndefined()
    }
  })

  test("the explicit whitelist is honoured, and ONLY for exact matches", () => {
    const wl = ["https://trusted.example"]
    expect(Server.corsOrigin("https://trusted.example", wl)).toBe("https://trusted.example")
    expect(Server.corsOrigin("https://trusted.example.evil.com", wl)).toBeUndefined()
    expect(Server.corsOrigin("https://sub.trusted.example", wl)).toBeUndefined()
  })

  test("an empty whitelist grants nothing extra", () => {
    expect(Server.corsOrigin("https://trusted.example", [])).toBeUndefined()
    expect(Server.corsOrigin("https://trusted.example")).toBeUndefined()
  })
})
