import { describe, test, expect } from "bun:test"
import {
  findLiveServer,
  deliverLive,
  candidateServers,
  shouldFallBackToBridge,
  deliveryTimeoutMs,
  resolveSessionLive,
  fetchLiveSessions,
} from "./session-live-delivery"

/**
 * `iris sessions send` must deliver on the LIVE path (epic #182718; bugs #184804, #184783).
 *
 * WHAT SHAPED THESE TESTS — three measurements from 2026-09-12, each of which a naive
 * implementation reproduces:
 *
 *  1. The shipped command shells out to `/opt/homebrew/bin/opencode` — UPSTREAM opencode 1.2.0,
 *     a different product — which cannot resolve an IRIS session and hangs until a 180s cap.
 *     Delivered nothing; 0 messages, 0 bus events. So delivery must be an HTTP POST to a
 *     server that is already listening, never a subprocess.
 *  2. Unknown paths on these servers return HTTP **200** with the SPA's HTML. A status-code
 *     check calls any open port a session server. So every probe asserts on the BODY.
 *  3. Session STORAGE is shared across servers but the event BUS is per-process. `GET /session`
 *     therefore lists sessions a given server is not rendering, and cannot be used to pick a
 *     delivery target. We ask for the ONE session by id and require the id to match.
 */

/** A stand-in server. `handler` decides what the probe sees. */
function withServer(handler: (req: Request) => Response | Promise<Response>) {
  const s = Bun.serve({ port: 0, fetch: handler })
  return { url: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true) }
}

const SID = "ses_abc123"

describe("candidateServers — where to look, with no registry", () => {
  test("an explicit url wins outright", () => {
    expect(candidateServers({ url: "http://127.0.0.1:9999" })[0]).toBe("http://127.0.0.1:9999")
  })

  test("an explicit --url is EXCLUSIVE — a typo must fail loudly, never deliver somewhere else", () => {
    // If the default stayed in the list, `--url http://127.0.0.1:9999` (typo) would silently
    // fall through to :4096 and land the message in whatever is running there. Mis-delivery is
    // worse than non-delivery, so an explicit target is the ONLY target.
    expect(candidateServers({ url: "http://127.0.0.1:9999" })).toEqual(["http://127.0.0.1:9999"])
  })

  test("env is NOT exclusive — it is a default, so the documented port stays a fallback", () => {
    const got = candidateServers({ env: { IRIS_SERVER: "http://127.0.0.1:8888" } })
    expect(got).toContain("http://127.0.0.1:8888")
    expect(got).toContain("http://127.0.0.1:4096")
  })

  test("the documented `iris serve` default is always a candidate, so the common case needs no flag", () => {
    expect(candidateServers({})).toContain("http://127.0.0.1:4096")
  })

  test("candidates are de-duplicated — probing the same port twice doubles the latency of a miss", () => {
    const got = candidateServers({ env: { IRIS_SERVER: "http://127.0.0.1:4096" } })
    expect(got.filter((u) => u === "http://127.0.0.1:4096")).toHaveLength(1)
  })

  test("a trailing slash does not create a second candidate or a double-slash URL", () => {
    expect(candidateServers({ url: "http://127.0.0.1:4096/" })).toEqual(["http://127.0.0.1:4096"])
  })
})

describe("findLiveServer — asserts on the BODY, never the status", () => {
  test("nothing listening returns null rather than throwing", async () => {
    expect(await findLiveServer(SID, ["http://127.0.0.1:1"], 300)).toBeNull()
  })

  test("HTTP 200 serving the SPA's HTML is NOT a session server", async () => {
    const s = withServer(() => new Response("<!doctype html><html>OpenCode</html>", {
      headers: { "content-type": "text/html" },
    }))
    try {
      expect(await findLiveServer(SID, [s.url], 1000)).toBeNull()
    } finally { s.stop() }
  })

  test("a server that does not have the session returns null", async () => {
    const s = withServer(() => new Response("not found", { status: 404 }))
    try {
      expect(await findLiveServer(SID, [s.url], 1000)).toBeNull()
    } finally { s.stop() }
  })

  test("a 200 whose body is a DIFFERENT session is refused — this is the mis-delivery guard", async () => {
    const s = withServer(() => Response.json({ id: "ses_somebodyelse" }))
    try {
      expect(await findLiveServer(SID, [s.url], 1000)).toBeNull()
    } finally { s.stop() }
  })

  test("a 200 whose body carries the matching id IS the target", async () => {
    const s = withServer(() => Response.json({ id: SID, title: "x" }))
    try {
      expect(await findLiveServer(SID, [s.url], 1000)).toBe(s.url)
    } finally { s.stop() }
  })

  test("the first live match wins and later candidates are not probed", async () => {
    let secondHit = 0
    const good = withServer(() => Response.json({ id: SID }))
    const other = withServer(() => { secondHit++; return Response.json({ id: SID }) })
    try {
      expect(await findLiveServer(SID, [good.url, other.url], 1000)).toBe(good.url)
      expect(secondHit).toBe(0)
    } finally { good.stop(); other.stop() }
  })

  test("a dead candidate does not stop the search", async () => {
    const good = withServer(() => Response.json({ id: SID }))
    try {
      expect(await findLiveServer(SID, ["http://127.0.0.1:1", good.url], 1000)).toBe(good.url)
    } finally { good.stop() }
  })
})

describe("deliverLive — the wire format is the contract", () => {
  test("POSTs noReply:true so the recipient spends NO tokens on a notification", async () => {
    let seen: any = null
    const s = withServer(async (req) => { seen = await req.json(); return Response.json({ ok: true }) })
    try {
      const ok = await deliverLive(s.url, SID, "hello there")
      expect(ok).toBe(true)
      expect(seen.noReply).toBe(true)
      expect(seen.parts).toEqual([{ type: "text", text: "hello there" }])
    } finally { s.stop() }
  })

  test("it posts to the session's message endpoint, not a guessed path", async () => {
    let path = ""
    const s = withServer((req) => { path = new URL(req.url).pathname; return Response.json({ ok: true }) })
    try {
      await deliverLive(s.url, SID, "x")
      expect(path).toBe(`/session/${SID}/message`)
    } finally { s.stop() }
  })

  test("--submit omits noReply, so the recipient's agent DOES take a turn", async () => {
    let seen: any = null
    const s = withServer(async (req) => { seen = await req.json(); return Response.json({ ok: true }) })
    try {
      await deliverLive(s.url, SID, "do the thing", 8000, { submit: true })
      expect(seen.noReply).toBeUndefined()
      expect(seen.parts).toEqual([{ type: "text", text: "do the thing" }])
    } finally { s.stop() }
  })

  test("notify is the DEFAULT — spending a teammate's tokens must be asked for", async () => {
    let seen: any = null
    const s = withServer(async (req) => { seen = await req.json(); return Response.json({ ok: true }) })
    try {
      await deliverLive(s.url, SID, "fyi")
      expect(seen.noReply).toBe(true)
    } finally { s.stop() }
  })

  test("a non-2xx is reported as failure, so the caller can fall back instead of claiming success", async () => {
    const s = withServer(() => new Response("nope", { status: 500 }))
    try {
      expect(await deliverLive(s.url, SID, "x")).toBe(false)
    } finally { s.stop() }
  })

  test("an unreachable server returns false rather than throwing", async () => {
    expect(await deliverLive("http://127.0.0.1:1", SID, "x", 300)).toBe(false)
  })
})

describe("shouldFallBackToBridge — an explicit target must fail loudly, not degrade", () => {
  test("no explicit url + no live server -> fall back (the normal case)", () => {
    expect(shouldFallBackToBridge({ explicitUrl: null, liveFound: false })).toBe(true)
  })

  test("EXPLICIT url + no live server -> do NOT fall back", () => {
    // Measured 2026-09-12: falling back here spent 180s on the known-broken bridge path after
    // the user had named a server that was not there. Asking for a specific target and getting
    // silent degradation to a different mechanism is how "it said it worked" happens.
    expect(shouldFallBackToBridge({ explicitUrl: "http://127.0.0.1:59999", liveFound: false })).toBe(false)
  })

  test("live server found -> never reaches the bridge either way", () => {
    expect(shouldFallBackToBridge({ explicitUrl: null, liveFound: true })).toBe(false)
    expect(shouldFallBackToBridge({ explicitUrl: "http://x", liveFound: true })).toBe(false)
  })
})

describe("timeouts — a model turn is not a notification", () => {
  test("NOTIFY uses a short timeout; INSTRUCT waits long enough for a real turn", () => {
    // Measured 2026-09-12: `--submit` against a live server reported "Failed" at 8s while the
    // recipient's model was still running — the turn COMPLETED and the assistant replied "ACK",
    // but the caller had already given up and printed a failure. A command that reports failure
    // on success is the same defect as one that reports success on failure: the output does not
    // describe what happened.
    expect(deliveryTimeoutMs({ submit: false })).toBe(8_000)
    expect(deliveryTimeoutMs({ submit: true })).toBeGreaterThanOrEqual(180_000)
  })

  test("a submit that genuinely exceeds even the long timeout still reports false", async () => {
    const s = withServer(async () => {
      await new Promise((r) => setTimeout(r, 400))
      return Response.json({ ok: true })
    })
    try {
      expect(await deliverLive(s.url, SID, "x", 100, { submit: true })).toBe(false)
    } finally { s.stop() }
  })
})

describe("resolveSessionLive — resolve without the bridge, same semantics as the bridge path", () => {
  const S = [
    { id: "ses_aaa111", title: "frontend work" },
    { id: "ses_aaa222", title: "backend work" },
    { id: "ses_bbb333", title: "docs" },
  ]

  test("an exact id resolves", () => {
    const r = resolveSessionLive(S, "ses_bbb333")
    expect("session" in r && r.session.id).toBe("ses_bbb333")
  })

  test("a unique prefix resolves", () => {
    const r = resolveSessionLive(S, "ses_bbb")
    expect("session" in r && r.session.id).toBe("ses_bbb333")
  })

  test("an ambiguous prefix REFUSES and names the candidates", () => {
    const r = resolveSessionLive(S, "ses_aaa")
    expect("error" in r).toBe(true)
    if ("error" in r) {
      expect(r.error).toContain("ses_aaa111")
      expect(r.error).toContain("ses_aaa222")
      expect(r.error).toContain("Use more characters")
    }
  })

  test("an EXACT id wins even when it is also a prefix of another session", () => {
    // Mis-delivery guard: `ses_aaa111` is a real id AND a prefix of `ses_aaa1119`. Treating it as
    // ambiguous would refuse a perfectly unambiguous request; picking the longer one would
    // deliver to the wrong session.
    const withSuffix = [...S, { id: "ses_aaa1119", title: "later" }]
    const r = resolveSessionLive(withSuffix, "ses_aaa111")
    expect("session" in r && r.session.id).toBe("ses_aaa111")
  })

  test("no match says so", () => {
    const r = resolveSessionLive(S, "ses_zzz")
    expect("error" in r && r.error).toContain("No session")
  })

  test("an empty prefix is refused rather than matching everything", () => {
    expect("error" in resolveSessionLive(S, "  ")).toBe(true)
  })

  test("an empty session list is not a crash", () => {
    expect("error" in resolveSessionLive([], "ses_a")).toBe(true)
  })
})

describe("fetchLiveSessions — reads the server, never the bridge", () => {
  test("returns the array from GET /session", async () => {
    const s = withServer(() => Response.json([{ id: "ses_x", title: "t" }]))
    try {
      const got = await fetchLiveSessions(s.url, 1000)
      expect(got).toEqual([{ id: "ses_x", title: "t" }])
    } finally { s.stop() }
  })

  test("HTML-200 (the SPA fallback) is not a session list", async () => {
    const s = withServer(() => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }))
    try {
      expect(await fetchLiveSessions(s.url, 1000)).toBeNull()
    } finally { s.stop() }
  })

  test("an unreachable server returns null rather than throwing", async () => {
    expect(await fetchLiveSessions("http://127.0.0.1:1", 300)).toBeNull()
  })
})
