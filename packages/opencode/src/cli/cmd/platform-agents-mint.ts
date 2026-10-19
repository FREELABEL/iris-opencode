import { irisFetch } from "./iris-api"
import { agentSealV1, mintHex } from "./kinetic-couple"

/**
 * `iris agents mint <id> [--status]` — Mint v1 from the terminal (#184905).
 *
 * The server (fl-api AgentMintController) seals the agent's definition once and records it; a
 * minted agent then refuses edits to its sealed fields (423). This file asks it to, or asks what
 * it recorded, and checks the answer against a seal computed HERE from the live agent row with
 * the same canonical rules (agentSealV1). A server and a CLI that disagree about the seal would
 * make every couple to a minted identity unreachable, so the comparison is printed every time.
 *
 * The agent is fetched FIRST. The mint route uses model binding, so "agent not found" and "this
 * server has no mint route" are both 404 — reading the agent beforehand is what tells them apart.
 */

export type Fetcher = (path: string, init: RequestInit) => Promise<Response>
const defaultFetcher: Fetcher = (path, init) => irisFetch(path, init)

export const MINT_UNAVAILABLE = "Mint is not available on this server yet"

export function mintPath(userId: number, agentId: number): string {
  return `/api/v1/users/${userId}/bloqs/agents/${agentId}/mint`
}

export interface MintPayload {
  agent_id?: number
  minted?: boolean
  minted_at?: string | null
  mint_hash?: string | null
  mint_key?: string | null
  current_hash?: string | null
  matches_current?: boolean | null
  seal_version?: number
}

export type MintOutcome =
  | { kind: "error"; message: string; status?: number }
  | { kind: "unavailable"; message: string }
  | {
      kind: "ok"
      /** POST on an agent that was already minted (409) — reported, not a failure. */
      already: boolean
      payload: MintPayload
      local_hash: string
      /** Local v1 seal of the live agent equals the server's mint_hash; null when not minted. */
      local_matches_mint: boolean | null
      /** Local v1 seal equals the server's seal of the agent as it stands now. */
      local_matches_current: boolean | null
    }

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}))
}

function messageOf(body: any, fallback: string): string {
  return String(body?.message || body?.error || fallback)
}

export async function runMint(
  opts: { userId: number; agentId: number; status: boolean },
  fetcher: Fetcher = defaultFetcher,
): Promise<MintOutcome> {
  const agentRes = await fetcher(`/api/v1/users/${opts.userId}/bloqs/agents/${opts.agentId}`, { method: "GET" })
  if (agentRes.status === 404) return { kind: "error", status: 404, message: `Agent #${opts.agentId} not found` }
  if (!agentRes.ok) {
    return { kind: "error", status: agentRes.status, message: messageOf(await readJson(agentRes), `Get agent failed (${agentRes.status})`) }
  }
  const agentBody = await readJson(agentRes)
  const row = agentBody?.data ?? agentBody
  if (!row || typeof row !== "object" || !row.id) return { kind: "error", message: `Agent #${opts.agentId} not found` }
  const local = agentSealV1(row)

  const res = await fetcher(mintPath(opts.userId, opts.agentId), opts.status ? { method: "GET" } : { method: "POST", body: "{}" })
  const body = await readJson(res)

  if (res.status === 404) {
    // Model binding's miss says "No query results for model …"; a missing route says nothing
    // like it. The agent was just read successfully, so this is almost always the route.
    if (/no query results/i.test(String(body?.message ?? ""))) return { kind: "error", status: 404, message: `Agent #${opts.agentId} not found` }
    return { kind: "unavailable", message: MINT_UNAVAILABLE }
  }
  const already = res.status === 409 && body?.error_code === "already_minted"
  if (!res.ok && !already) return { kind: "error", status: res.status, message: messageOf(body, `Mint failed (${res.status})`) }

  const payload = (body?.data ?? {}) as MintPayload
  return {
    kind: "ok",
    already,
    payload,
    local_hash: local,
    local_matches_mint: payload.mint_hash ? mintHex(payload.mint_hash) === local : null,
    local_matches_current: payload.current_hash ? mintHex(payload.current_hash) === local : null,
  }
}
