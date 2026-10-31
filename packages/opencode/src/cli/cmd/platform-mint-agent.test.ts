import { describe, test, expect } from "bun:test"
import path from "path"
import {
  REFUSAL_TEXT,
  describeRefusal,
  formatVersions,
  mintAgentRequest,
  sendMintAgent,
  summarizeSeal,
  summarizeStatus,
} from "./platform-mint-agent"

/**
 * `iris mint agent seal|versions|stop|resume` (#190380 SH-05, epic #184944 step 3).
 *
 * The paths are the contract with iris-api's AgentMintController, and every refusal code it can
 * return must reach the person as its own sentence: #184944's acceptance is that a dirty draft is
 * refused BY NAME, and a refusal that prints like a success measures nothing.
 */

const SERVER_REASONS = ["no_model", "model_not_pinned", "unknown_tools", "no_identity", "unchanged", "already_sealed", "not_owner", "no_such_version"]

describe("mintAgentRequest", () => {
  test("each action hits its own route", () => {
    expect(mintAgentRequest("seal", 42)).toEqual({ method: "POST", path: "/api/v1/agents/42/mint/seal" })
    expect(mintAgentRequest("versions", "42")).toEqual({ method: "GET", path: "/api/v1/agents/42/mint/versions" })
    expect(mintAgentRequest("stop", 42, 3)).toEqual({ method: "POST", path: "/api/v1/agents/42/mint/versions/3/stop" })
    expect(mintAgentRequest("resume", 42, "v3")).toEqual({ method: "POST", path: "/api/v1/agents/42/mint/versions/3/resume" })
  })

  test("a bad id or version is a sentence, decided offline", () => {
    for (const bad of [undefined, "", "forge", -1, 1.5]) expect(mintAgentRequest("seal", bad)).toHaveProperty("error")
    for (const bad of [undefined, "", "latest", 0, "v-2"]) expect(mintAgentRequest("stop", 42, bad)).toHaveProperty("error")
  })
})

describe("refusals, by name", () => {
  test("every reason the server can give has its own plain sentence", () => {
    const lines = SERVER_REASONS.map((r) => REFUSAL_TEXT[r])
    for (const l of lines) expect(typeof l === "string" && l.length > 20).toBe(true)
    expect(new Set(lines).size).toBe(SERVER_REASONS.length)
    for (const l of lines) expect(l).not.toMatch(/[a-z]+_[a-z]+/) // words, not codes
  })

  test("the headline is the reason's sentence, then every condition the server listed", () => {
    const body = {
      reason: "model_not_pinned",
      problems: [
        { reason: "model_not_pinned", message: "The model is not pinned: 'auto' is an alias that picks a model at run time." },
        { reason: "no_identity", message: "The agent has no system prompt (its identity)." },
      ],
    }
    const lines = describeRefusal("seal", "model_not_pinned", body)
    expect(lines[0]).toBe(`Not sealed: ${REFUSAL_TEXT.model_not_pinned}`)
    expect(lines.slice(1)).toEqual(["  · " + body.problems[0].message, "  · " + body.problems[1].message])
  })

  test("an unknown code still prints the server's words rather than nothing", () => {
    expect(describeRefusal("seal", "http_500", { message: "boom" })[0]).toBe("Not sealed: boom")
  })
})

describe("round-trip against a fake iris-api", () => {
  // A stand-in for AgentMintController: seal refuses an unchanged agent, versions are never edited,
  // stop/resume change status only, and another user's agent is a 404 not_owner.
  function fakeServer() {
    const versions: { version: number; hash12: string; status: string; prod: boolean }[] = []
    let content = "a"
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
    const fetcher = async (p: string, init: RequestInit) => {
      if (!p.startsWith("/api/v1/agents/42/")) return json(404, { success: false, reason: "not_owner", message: "No agent you own has that id." })
      if (p.endsWith("/mint/seal") && init.method === "POST") {
        const hash12 = (content + "000000000000").slice(0, 12)
        const prod = versions.find((v) => v.prod)
        if (prod && prod.hash12 === hash12) return json(409, { success: false, reason: "unchanged", message: "Nothing to seal." })
        versions.forEach((v) => (v.prod = false))
        versions.push({ version: versions.length + 1, hash12, status: "active", prod: true })
        return json(201, { success: true, sealed: true, version: versions.length, hash: hash12.padEnd(64, "0"), hash12, prod: true })
      }
      if (p.endsWith("/mint/versions") && init.method === "GET") return json(200, { success: true, versions: [...versions].reverse() })
      const m = p.match(/\/mint\/versions\/(\d+)\/(stop|resume)$/)
      if (m) {
        const v = versions.find((x) => x.version === Number(m[1]))
        if (!v) return json(404, { success: false, reason: "no_such_version" })
        const next = m[2] === "stop" ? "stopped" : "active"
        const changed = v.status !== next
        v.status = next
        return json(200, { success: true, changed, version: { ...v } })
      }
      return json(404, { reason: "no route" })
    }
    return { versions, fetcher, edit: (c: string) => (content = c) }
  }

  test("seal → unchanged → edit → v2; stop/resume change status only; a stranger's id is not_owner", async () => {
    const srv = fakeServer()

    const s1 = await sendMintAgent("seal", 42, undefined, srv.fetcher)
    expect(s1).toMatchObject({ ok: true, status: 201, body: { version: 1, prod: true } })
    expect(summarizeSeal(42, (s1 as any).body)).toContain("v1 · hash a00000000000")

    expect(await sendMintAgent("seal", 42, undefined, srv.fetcher)).toMatchObject({ ok: false, status: 409, reason: "unchanged" })

    srv.edit("b")
    expect(await sendMintAgent("seal", 42, undefined, srv.fetcher)).toMatchObject({ ok: true, body: { version: 2 } })

    const listed = (await sendMintAgent("versions", 42, undefined, srv.fetcher)) as any
    expect(formatVersions(listed.body)[0]).toContain("v2  b00000000000")
    expect(formatVersions(listed.body)[0]).toContain("← prod")

    const stop = (await sendMintAgent("stop", 42, 1, srv.fetcher)) as any
    expect(summarizeStatus("stop", 42, stop.body)).toBe("Agent #42 v1 (a00000000000) stopped — status: stopped")
    expect(srv.versions[0].hash12).toBe("a00000000000")
    const again = (await sendMintAgent("stop", 42, 1, srv.fetcher)) as any
    expect(summarizeStatus("stop", 42, again.body)).toContain("already stopped")
    await sendMintAgent("resume", 42, 1, srv.fetcher)
    expect(srv.versions[0].status).toBe("active")

    expect(await sendMintAgent("seal", 7, undefined, srv.fetcher)).toMatchObject({ ok: false, status: 404, reason: "not_owner" })
    expect(await sendMintAgent("stop", 42, 9, srv.fetcher)).toMatchObject({ ok: false, reason: "no_such_version" })
  })

  test("a usage error never reaches the network", async () => {
    let called = false
    const r = await sendMintAgent("seal", "forge", undefined, async () => ((called = true), new Response("{}")))
    expect(r).toHaveProperty("error")
    expect(called).toBe(false)
  })
})

describe("the real CLI", () => {
  const entry = path.join(import.meta.dir, "../../index.ts")
  const run = (...argv: string[]) => {
    const p = Bun.spawnSync([process.execPath, "run", entry, ...argv], { env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" })
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
  }

  // The iris-shapes playbook's mint gate greps the PARENT help for exactly this, so the gate opens
  // only when the command really exists (#190375: `seal --help` used to print the parent and exit 0).
  test("`iris mint --help` lists the agent group on a line starting `  iris mint agent`", () => {
    const { out } = run("mint", "--help")
    expect(out).toMatch(/^\s+iris mint agent( |$)/m)
  }, 60_000)

  test("`iris mint agent seal --help` is the seal command's own help", () => {
    const { code, out } = run("mint", "agent", "seal", "--help")
    expect(code).toBe(0)
    expect(out).toContain("iris mint agent seal <id>")
  }, 60_000)

  test("a refusal exits 1 — here, a usage refusal decided before any network or sign-in", () => {
    const { code, out } = run("mint", "agent", "seal", "forge", "--json")
    expect(code).toBe(1)
    expect(out).toContain('"reason": "usage"')
  }, 60_000)
})
