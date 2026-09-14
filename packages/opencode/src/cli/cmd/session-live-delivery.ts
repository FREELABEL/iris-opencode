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
  /** Injectable for tests; defaults to enumerating loopback listeners. */
  discover?: () => number[]
}): string[] {
  const env = input.env ?? {}
  // An explicit --url is EXCLUSIVE. If the default stayed in the list, a typo
  // (`--url http://127.0.0.1:9999`) would silently fall through to :4096 and land the message
  // in whatever is running there. Mis-delivery is worse than non-delivery, so an explicit
  // target is the ONLY target and a wrong one fails loudly.
  if (input.url) return [input.url.replace(/\/+$/, "")]
  const seen = new Set<string>()
  const out: string[] = []
  const add = (u?: string | null) => {
    if (!u) return
    const trimmed = u.replace(/\/+$/, "")
    if (seen.has(trimmed)) return
    seen.add(trimmed)
    out.push(trimmed)
  }

  add(env.IRIS_SERVER)
  add(env.OPENCODE_SERVER)

  // DISCOVER the ports iris is actually listening on, BEFORE falling back to the documented
  // default. Session servers bind an EPHEMERAL port (:60824, :51477 — different every start)
  // unless someone ran `iris serve --port 4096`. Probing only the default meant this command
  // failed on most machines with "No session matching <id>" — it had fallen through to the
  // bridge resolver, whose list is the heartbeat's, so the message named the session rather
  // than the real problem. The same call with an explicit --url delivered.
  //
  // Discovery failing is not an error: the default still stands behind it.
  try {
    for (const port of (input.discover ?? discoverLocalServerPorts)()) {
      add(`http://127.0.0.1:${port}`)
    }
  } catch {
    /* no lsof, or nothing listening */
  }

  add(DEFAULT_SERVER)
  return out
}

/**
 * Loopback ports an `iris` process is listening on.
 *
 * A subprocess, which is what this module exists to avoid on the DELIVERY path — but discovery
 * has no portable in-process equivalent, and the alternative is a registry file with its own
 * format, lifecycle and staleness. It runs once per send, costs ~50ms, and its failure is
 * non-fatal.
 */
function discoverLocalServerPorts(): number[] {
  const proc = Bun.spawnSync([
    "sh",
    "-c",
    "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i iris | awk '{print $9}'",
  ])
  if (!proc.success) return []
  return [
    ...new Set(
      new TextDecoder()
        .decode(proc.stdout)
        .split("\n")
        .map((l) => l.trim().split(":").pop() ?? "")
        .filter((p) => /^\d+$/.test(p))
        .map(Number),
    ),
  ]
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

/**
 * How long to wait on the POST.
 *
 * A notification returns as soon as the message is persisted — milliseconds. An INSTRUCT runs
 * the recipient's model turn SYNCHRONOUSLY before responding, so it takes as long as the turn.
 *
 * Measured 2026-09-12: `--submit` with an 8s cap printed "Failed" while the turn was still
 * running. It then completed and the assistant replied "ACK". Reporting failure on success is
 * the same defect as reporting success on failure — the output did not describe what happened.
 */
export function deliveryTimeoutMs(opts: { submit?: boolean }): number {
  return opts.submit ? 180_000 : 8_000
}

/** One row of `GET /session` on a live server. Only the fields delivery actually needs. */
export interface LiveSession {
  id: string
  title?: string
  directory?: string
}

/**
 * `GET /session` from a live server, or null.
 *
 * This is what lets `sessions send` work with the daemon DOWN. The bridge is only ever needed to
 * RESOLVE a session id; delivery itself is a POST to a server that is already listening. Reading
 * the list from that same server removes the bridge from the opencode path entirely.
 *
 * Null rather than throwing on anything that is not a JSON array — including the SPA's HTML,
 * which these servers return with HTTP 200 for unknown paths.
 */
export async function fetchLiveSessions(base: string, timeoutMs = 4000): Promise<LiveSession[] | null> {
  try {
    const res = await fetch(`${base}/session`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = await res.json()
    return Array.isArray(body) ? (body as LiveSession[]) : null
  } catch {
    return null
  }
}

/**
 * Resolve an id or prefix against a live session list.
 *
 * Mirrors the bridge resolver's semantics deliberately, so switching paths cannot change which
 * session a given argument means: an EXACT id wins outright, a unique prefix resolves, and an
 * ambiguous prefix is an ERROR that names the candidates rather than a pick. Mis-delivering a
 * message is worse than refusing to deliver it.
 *
 * The exact-match-first rule is load-bearing: `ses_aaa111` can be a real id AND a prefix of
 * `ses_aaa1119`. Prefix-only matching would refuse an unambiguous request.
 */
export function resolveSessionLive(
  sessions: LiveSession[],
  idPrefix: string,
): { session: LiveSession } | { error: string } {
  const want = (idPrefix ?? "").trim()
  if (!want) return { error: "No session id given." }

  const exact = sessions.find((s) => s.id === want)
  if (exact) return { session: exact }

  const matches = sessions.filter((s) => s.id.startsWith(want))
  if (matches.length === 0) return { error: `No session matching '${want}'.` }
  if (matches.length > 1) {
    const list = matches.slice(0, 6).map((m) => m.id.slice(0, 12)).join(", ")
    const more = matches.length > 6 ? `, +${matches.length - 6} more` : ""
    return { error: `'${want}' matches ${matches.length} sessions: ${list}${more}. Use more characters.` }
  }
  return { session: matches[0] }
}
