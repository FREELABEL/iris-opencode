import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MINT_UNAVAILABLE, mintPath, runMint } from "./platform-agents-mint"
import { agentSealV1 } from "./kinetic-couple"

/**
 * `iris agents mint` (#184905) against a fake fl-api. The routes and payload are
 * AgentMintController's (fl-api 689ccc9d): POST/GET users/{u}/bloqs/agents/{agent}/mint.
 */

const AGENT = { id: 127, name: "patrol", initial_prompt: "watch the door", config: { model: "gpt-4.1-nano", tools: ["camera"] } }
const LOCAL = agentSealV1(AGENT)

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

function fakeServer(opts: { mintRoute: boolean; serverHash?: string }) {
  const calls: string[] = []
  let minted: { at: string; hash: string } | null = null
  const payload = () => ({
    agent_id: 127,
    minted: !!minted,
    minted_at: minted?.at ?? null,
    mint_hash: minted?.hash ?? null,
    current_hash: opts.serverHash ?? LOCAL,
    matches_current: minted ? minted.hash === (opts.serverHash ?? LOCAL) : null,
    seal_version: 1,
  })
  const fetcher = async (path: string, init: RequestInit) => {
    calls.push(`${init.method ?? "GET"} ${path}`)
    if (path === "/api/v1/users/193/bloqs/agents/127") return json(200, { data: AGENT })
    if (path === "/api/v1/users/193/bloqs/agents/999") return json(404, { message: "Agent not found" })
    if (path === mintPath(193, 127) && opts.mintRoute) {
      if (init.method === "POST") {
        if (minted) return json(409, { success: false, error_code: "already_minted", data: payload() })
        minted = { at: "2026-10-19T20:00:00.000Z", hash: opts.serverHash ?? LOCAL }
        return json(201, { success: true, data: payload() })
      }
      return json(200, { success: true, data: payload() })
    }
    return json(404, { message: "" })
  }
  return { calls, fetcher }
}

describe("runMint", () => {
  test("a server without the route says Mint is not available — not 'agent not found'", async () => {
    const srv = fakeServer({ mintRoute: false })
    const r = await runMint({ userId: 193, agentId: 127, status: true }, srv.fetcher)
    expect(r).toEqual({ kind: "unavailable", message: MINT_UNAVAILABLE })
    expect(MINT_UNAVAILABLE).toBe("Mint is not available on this server yet")
    expect(srv.calls).toEqual(["GET /api/v1/users/193/bloqs/agents/127", "GET /api/v1/users/193/bloqs/agents/127/mint"])
  })

  test("a missing agent is reported as a missing agent, before the mint route is touched", async () => {
    const srv = fakeServer({ mintRoute: true })
    const r = await runMint({ userId: 193, agentId: 999, status: true }, srv.fetcher)
    expect(r.kind).toBe("error")
    expect(srv.calls).toEqual(["GET /api/v1/users/193/bloqs/agents/999"])
  })

  test("--status before minting: not minted, and the local seal is compared with the server's current seal", async () => {
    const r = await runMint({ userId: 193, agentId: 127, status: true }, fakeServer({ mintRoute: true }).fetcher)
    expect(r.kind === "ok" && r.payload.minted).toBe(false)
    expect(r.kind === "ok" && r.local_matches_mint).toBeNull()
    expect(r.kind === "ok" && r.local_matches_current).toBe(true)
  })

  test("mint POSTs, then a second mint is the server's 409 reported as already minted", async () => {
    const srv = fakeServer({ mintRoute: true })
    const first = await runMint({ userId: 193, agentId: 127, status: false }, srv.fetcher)
    expect(first.kind === "ok" && first.already).toBe(false)
    expect(first.kind === "ok" && first.payload.mint_hash).toBe(LOCAL)
    expect(first.kind === "ok" && first.local_matches_mint).toBe(true)

    const again = await runMint({ userId: 193, agentId: 127, status: false }, srv.fetcher)
    expect(again.kind === "ok" && again.already).toBe(true)
    expect(srv.calls.filter((c) => c.startsWith("POST"))).toEqual([`POST ${mintPath(193, 127)}`, `POST ${mintPath(193, 127)}`])
  })

  test("a server whose seal disagrees with the CLI's is reported as a mismatch", async () => {
    const srv = fakeServer({ mintRoute: true, serverHash: "f".repeat(64) })
    await runMint({ userId: 193, agentId: 127, status: false }, srv.fetcher)
    const r = await runMint({ userId: 193, agentId: 127, status: true }, srv.fetcher)
    expect(r.kind === "ok" && r.local_matches_mint).toBe(false)
  })

  test("`iris agents mint` is registered, with --status", () => {
    const src = readFileSync(join(import.meta.dir, "platform-agents.ts"), "utf8")
    expect(src).toContain(".command(AgentsMintCommand)")
    expect(src).toMatch(/command: "mint <id>"/)
    expect(src).toMatch(/option\("status"/)
  })
})
