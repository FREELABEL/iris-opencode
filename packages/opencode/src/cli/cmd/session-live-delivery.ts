/**
 * Live delivery into a running session (epic #182718; fixes #184804, and the local half of #184783).
 *
 * THE DEFECT THIS REPLACES. `iris sessions send` reached the bridge, which shelled out to
 * `/opt/homebrew/bin/opencode` — UPSTREAM opencode 1.2.0, a different product installed by
 * Homebrew, not iris. It cannot resolve an IRIS session, so it hung until a 180s cap and
 * delivered nothing: 0 messages in the session, 0 events on the bus, HTTP 500 to the caller.
 *
 * THE PRIMITIVE THAT ALREADY WORKED. Every running IRIS server exposes the session API on a
 * loopback port. `POST /session/:id/message` with `noReply:true` persists a real `role:"user"`
 * message AND emits `message.updated` on the `/event` bus the TUI renders from, in
 * milliseconds, with no model turn and no tokens. Shelling out to a CLI to talk to a process
 * that is already listening was the whole defect.
 *
 * WHY THERE IS NO PROCESS REGISTRY HERE. Session STORAGE is shared — one SQLite DB, so every
 * server's `GET /session` lists every session — but the event BUS is per-process. That makes the
 * session LIST useless for choosing a target. Rather than track processes, we ask each candidate
 * for the ONE session by id and require the returned id to match. In the recommended topology
 * (one `iris serve`, many `iris attach`) there is a single server and a single bus, so the first
 * candidate is the answer. A registry was built for this and then deleted: measured 2026-09-12,
 * two subscribers to one server's `/event` both received the same injection, so one server is
 * one bus and the registry was a part that did not need to exist.
 */

/** The port `iris serve` documents and defaults to. */
export const DEFAULT_SERVER = "http://127.0.0.1:4096"

/**
 * Where to look for a live server, in priority order: an explicit `--url`, then the environment,
 * then the documented default. De-duplicated, because probing the same port twice only doubles
 * the latency of a miss.
 */
export function candidateServers(input: {
  url?: string | null
  env?: Record<string, string | undefined>
}): string[] {
  const env = input.env ?? {}
  // An explicit --url is EXCLUSIVE. If the default stayed in the list, a typo
  // (`--url http://127.0.0.1:9999`) would silently fall through to :4096 and land the message
  // in whatever is running there. Mis-delivery is worse than non-delivery, so an explicit
  // target is the ONLY target and a wrong one fails loudly.
  if (input.url) return [input.url.replace(/\/+$/, "")]
  const raw = [env.IRIS_SERVER, env.OPENCODE_SERVER, DEFAULT_SERVER]
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of raw) {
    if (!u) continue
    const trimmed = u.replace(/\/+$/, "")
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * The first candidate that actually holds this session, or null.
 *
 * ASSERTS ON THE BODY, NEVER THE STATUS. Unknown paths on these servers return HTTP 200 with the
 * SPA's HTML, so a status check calls any open port a session server. We require JSON whose `id`
 * equals the id we asked for — which also rules out a 200 describing somebody else's session,
 * the mis-delivery case.
 */
export async function findLiveServer(
  sessionID: string,
  candidates: string[],
  timeoutMs = 1200,
): Promise<string | null> {
  for (const base of candidates) {
    try {
      const res = await fetch(`${base}/session/${encodeURIComponent(sessionID)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) continue
      const body = (await res.json()) as any
      if (body && typeof body === "object" && body.id === sessionID) return base
    } catch {
      // unreachable, non-JSON, or timed out — try the next candidate
    }
  }
  return null
}

/**
 * Put `text` into the session as a user message.
 *
 * Returns false rather than throwing, so the caller can fall back to the bridge instead of
 * reporting a success it did not achieve — which is the exact failure this whole change exists
 * to remove.
 */
export async function deliverLive(
  base: string,
  sessionID: string,
  text: string,
  timeoutMs = 8000,
  opts: { submit?: boolean } = {},
): Promise<boolean> {
  // NOTIFY is the default and INSTRUCT is opt-in. Omitting `noReply` makes the recipient's
  // agent take a turn — which spends THEIR tokens and changes THEIR working state. Defaulting
  // to that would quietly turn a messaging command into remote execution billed to a teammate.
  const body = opts.submit
    ? { parts: [{ type: "text", text }] }
    : { noReply: true, parts: [{ type: "text", text }] }
  try {
    const res = await fetch(`${base}/session/${encodeURIComponent(sessionID)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * May the caller fall back to the bridge?
 *
 * NO when the user named a server explicitly and it did not have the session. Measured
 * 2026-09-12: falling back there spent 180s on the known-broken bridge path after the user had
 * asked for a specific target. Naming a server and getting silent degradation to a different
 * mechanism is the same "it reported success" failure this change exists to remove — and with a
 * typo'd port it would be indistinguishable from the server being down.
 */
export function shouldFallBackToBridge(input: {
  explicitUrl?: string | null
  liveFound: boolean
}): boolean {
  if (input.liveFound) return false
  return !input.explicitUrl
}
