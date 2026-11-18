import { describe, expect, test, afterEach } from "bun:test"
import { applyEnvelope, followLive, newLiveState, type Envelope, type FollowMode } from "./hive-live-follow"

/**
 * #192964 W1 — live follow. The reducer is pinned on the shapes that go wrong: gaps, duplicates,
 * split snapshots, a snapshot sent for someone else. The follow itself runs against a REAL
 * WebSocket server speaking the Pusher protocol, so the socket, the subscribe/notify order and the
 * outage fallback are exercised over a socket and not through a typed fake.
 */

const SID = "0e9cc2cb-04c0-4de3-a156-3afcfef87956"
const env = (o: Partial<Envelope>): Envelope => ({
  v: 1, kind: "delta", node_id: "n", session_id: SID, seq: 0, from: 0, to: 0, enc: "none", body: "[]", final: true, ...o,
})
const msg = (text: string, role = "assistant") => ({ role, type: "text", text })
const body = (...texts: string[]) => JSON.stringify(texts.map((t) => msg(t)))

describe("applyEnvelope", () => {
  test("a snapshot sets the view and the cursor; deltas continue from it", () => {
    const s = newLiveState()
    const a = applyEnvelope(s, env({ kind: "snapshot", from: 100, to: 100, body: body("old") }))
    expect(a.reset).toBe(true)
    expect(s.to).toBe(100)
    const b = applyEnvelope(s, env({ from: 100, to: 160, body: body("new") }))
    expect(b.appended.map((m) => m.text)).toEqual(["new"])
    expect(s.to).toBe(160)
    expect(s.messages.map((m) => m.text)).toEqual(["old", "new"])
  })

  test("a delta before any snapshot is ignored — there is nothing to apply it to", () => {
    const s = newLiveState()
    expect(applyEnvelope(s, env({ from: 0, to: 10, body: body("x") })).appended).toEqual([])
    expect(s.to).toBeNull()
  })

  test("a gap (from past our cursor) asks for a resync and drops deltas until a snapshot", () => {
    const s = newLiveState()
    applyEnvelope(s, env({ kind: "snapshot", from: 10, to: 10 }))
    expect(applyEnvelope(s, env({ from: 50, to: 80, body: body("after a hole") })).resync).toBe(true)
    expect(applyEnvelope(s, env({ from: 80, to: 90, body: body("still behind") })).appended).toEqual([])
    const r = applyEnvelope(s, env({ kind: "snapshot", from: 90, to: 90, body: body("whole") }))
    expect(r.reset).toBe(true)
    expect(s.needsResync).toBe(false)
  })

  test("a duplicate (from behind our cursor) is dropped, never printed twice", () => {
    const s = newLiveState()
    applyEnvelope(s, env({ kind: "snapshot", from: 0, to: 0 }))
    applyEnvelope(s, env({ from: 0, to: 20, body: body("once") }))
    expect(applyEnvelope(s, env({ from: 0, to: 20, body: body("once") })).appended).toEqual([])
    expect(s.messages.length).toBe(1)
  })

  test("a flush split across envelopes: every chunk checks the SAME cursor, it moves on final", () => {
    const s = newLiveState()
    applyEnvelope(s, env({ kind: "snapshot", from: 5, to: 5 }))
    applyEnvelope(s, env({ seq: 1, from: 5, to: 99, body: body("a"), final: false }))
    expect(s.to).toBe(5)
    applyEnvelope(s, env({ seq: 2, from: 5, to: 99, body: body("b"), final: true }))
    expect(s.to).toBe(99)
    expect(s.messages.map((m) => m.text)).toEqual(["a", "b"])
  })

  test("a split snapshot replaces once, then appends its other chunks", () => {
    const s = newLiveState()
    const a = applyEnvelope(s, env({ kind: "snapshot", from: 7, to: 7, body: body("1"), final: false }))
    const b = applyEnvelope(s, env({ kind: "snapshot", from: 7, to: 7, body: body("2"), final: true }))
    expect([a.reset, b.reset]).toEqual([true, false])
    expect(s.messages.map((m) => m.text)).toEqual(["1", "2"])
  })

  test("a snapshot sent for ANOTHER follower is ignored by one already on the cursor", () => {
    const s = newLiveState()
    applyEnvelope(s, env({ kind: "snapshot", from: 0, to: 0, body: body("mine") }))
    const r = applyEnvelope(s, env({ kind: "snapshot", from: 0, to: 0, body: body("theirs") }))
    expect(r).toEqual({ appended: [], reset: false, resync: false })
    expect(s.messages.map((m) => m.text)).toEqual(["mine"])
  })

  test("a ping (a message too big to push) asks to fetch exactly its range", () => {
    const s = newLiveState()
    applyEnvelope(s, env({ kind: "snapshot", from: 30, to: 30 }))
    const r = applyEnvelope(s, env({ kind: "ping", from: 30, to: 900, body: "" }))
    expect(r.fetchSince).toBe(30)
    expect(s.to).toBe(900)
  })

  test("an encoding this client cannot read is a resync, never an empty transcript (ADR-02)", () => {
    const s = newLiveState()
    applyEnvelope(s, env({ kind: "snapshot", from: 0, to: 0 }))
    expect(applyEnvelope(s, env({ from: 0, to: 5, enc: "xchacha20poly1305:k1", body: "q83v" })).resync).toBe(true)
  })
})

// ─── A real socket ───────────────────────────────────────────────────────────────────────────

type Call = { path: string; body: any; at: number }

function fakePusher() {
  const sockets = new Set<any>()
  const events: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 })
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        ws.send(JSON.stringify({ event: "pusher:connection_established", data: JSON.stringify({ socket_id: "123.456", activity_timeout: 120 }) }))
      },
      message(ws, raw) {
        const m = JSON.parse(String(raw))
        events.push(m.event)
        if (m.event === "pusher:subscribe") {
          if (m.data.auth !== `pk:sig-for-123.456:${m.data.channel}`) {
            ws.send(JSON.stringify({ event: "pusher:error", data: { code: 4009, message: "bad auth" } }))
            return
          }
          ws.send(JSON.stringify({ event: "pusher_internal:subscription_succeeded", channel: m.data.channel, data: "{}" }))
        }
      },
      close(ws) {
        sockets.delete(ws)
      },
    },
  })
  return {
    url: `ws://127.0.0.1:${server.port}`,
    events,
    push(channel: string, e: Envelope) {
      for (const ws of sockets) ws.send(JSON.stringify({ event: "session.stream", channel, data: JSON.stringify(e) }))
    },
    dropAll() {
      for (const ws of sockets) ws.close()
    },
    stop: () => server.stop(true),
  }
}

function fakePlatform(channel: string) {
  const calls: Call[] = []
  let transcriptReads = 0
  const fetch = async (path: string, init?: RequestInit) => {
    const b = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ path, body: b, at: Date.now() })
    if (path.endsWith("/follow")) {
      return Response.json({ success: true, channel, event: "session.stream", renew_s: 30, ttl_s: 90, pusher: { key: "pk", cluster: "x" }, auth_endpoint: "/auth" })
    }
    if (path === "/auth") return Response.json({ auth: `pk:sig-for-${b.socket_id}:${b.channel_name}` })
    if (path.includes("/transcript")) {
      transcriptReads++
      return Response.json({ success: true, messages: [msg(`polled ${transcriptReads}`)], offset: 1000 + transcriptReads, incremental: false })
    }
    return new Response("?", { status: 404 })
  }
  return { fetch, calls, reads: () => transcriptReads }
}

const until = async (fn: () => any, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()!()
})

describe("followLive over a real socket", () => {
  const CH = `private-hive-session.node-1.${SID}`

  test("subscribes FIRST, then tells the daemon — a snapshot sent before anyone listens is lost", async () => {
    const p = fakePusher()
    const api = fakePlatform(CH)
    const f = followLive({ sessionId: SID, machine: "b", provider: "claude_code", fetch: api.fetch, ws: () => new WebSocket(p.url) as any, onMessages: () => {}, onMode: () => {} })
    cleanup.push(f.stop, p.stop)
    await until(() => api.calls.filter((c) => c.path.endsWith("/follow")).length === 2)
    const follows = api.calls.filter((c) => c.path.endsWith("/follow"))
    expect(follows[0].body.notify).toBe(false) // where to listen
    expect(follows[1].body).toMatchObject({ notify: true, snapshot: true }) // after the subscription
    expect(p.events).toContain("pusher:subscribe")
  })

  test("words pushed on the channel reach the follower with no transcript read at all", async () => {
    const p = fakePusher()
    const api = fakePlatform(CH)
    const got: string[] = []
    const modes: FollowMode[] = []
    const f = followLive({
      sessionId: SID, machine: "b", provider: "claude_code", fetch: api.fetch, ws: () => new WebSocket(p.url) as any,
      onMessages: (m) => got.push(...m.map((x) => x.text!)), onMode: (m) => modes.push(m),
    })
    cleanup.push(f.stop, p.stop)
    await until(() => modes.includes("live"))
    p.push(CH, env({ kind: "snapshot", from: 0, to: 0, body: body("hello") }))
    const t0 = Date.now()
    p.push(CH, env({ seq: 1, from: 0, to: 40, body: body("typed on B") }))
    await until(() => got.includes("typed on B"))
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(api.reads()).toBe(0)
  })

  test("socket down → says 'live paused — polling' and polls; socket back → live again, polling stops", async () => {
    const p = fakePusher()
    const api = fakePlatform(CH)
    const modes: Array<[FollowMode, string | undefined]> = []
    const f = followLive({
      sessionId: SID, machine: "b", provider: "claude_code", fetch: api.fetch, ws: () => new WebSocket(p.url) as any, pollMs: 50,
      onMessages: () => {}, onMode: (m, why) => modes.push([m, why]),
    })
    cleanup.push(f.stop, p.stop)
    await until(() => modes.some(([m]) => m === "live"))
    p.dropAll()
    await until(() => modes.some(([m]) => m === "polling"))
    expect(modes.find(([m]) => m === "polling")![1]).toContain("live paused")
    await until(() => api.reads() >= 1)
    // pusher-socket reconnects with backoff (500 ms) to the same server, which is still up
    await until(() => modes.filter(([m]) => m === "live").length === 2, 4000)
    const readsWhenLive = api.reads()
    await Bun.sleep(200)
    expect(api.reads()).toBe(readsWhenLive)
    // and asked for a snapshot on return, without a NodeTask
    expect(api.calls.filter((c) => c.path.endsWith("/follow") && c.body.notify && c.body.snapshot).length).toBe(2)
  })

  test("no socket at all → polls after the connect timeout, and says why", async () => {
    const api = fakePlatform(CH)
    const modes: Array<[FollowMode, string | undefined]> = []
    const f = followLive({
      sessionId: SID, machine: "b", provider: "claude_code", fetch: api.fetch, ws: () => new WebSocket("ws://127.0.0.1:1") as any,
      pollMs: 50, connectTimeoutMs: 100, onMessages: () => {}, onMode: (m, why) => modes.push([m, why]),
    })
    cleanup.push(f.stop)
    await until(() => api.reads() >= 1)
    expect(modes[0][0]).toBe("polling")
    expect(modes[0][1]).toContain("live paused")
  })
})
