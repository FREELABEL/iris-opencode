import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// #192625 — the ticket's "done when", run through the real CLI against a stand-in fl-api:
// setup → create a campaign → add 3 creatives → approve 2, reject 1 with a reason →
// `iris campaigns list --json` shows the three states with who decided and when.
//
// The stand-in answers the six /api/v1/campaigns routes with the server's rules that the CLI
// depends on (a rejection needs a reason; the reviewer is the signed-in account, not a flag).
// The server's own behaviour is tested in fl-api (tests/Feature/Campaigns/CampaignsTest.php).

const ME = "reviewer@brand.test"
let server: ReturnType<typeof Bun.serve>
let home: string
const seen: Array<{ method: string; path: string; body: any }> = []

beforeAll(() => {
  const campaigns: any[] = []
  const creatives: any[] = []
  let next = 100
  let setUp = false
  const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status })
  const out = (c: any) => ({ ...c, counts: counts(c.id), creatives: creatives.filter((x) => x.campaign_ref === String(c.id)) })
  const counts = (id: number) => {
    const n: Record<string, number> = { draft: 0, in_review: 0, approved: 0, rejected: 0, changes_requested: 0 }
    for (const x of creatives) if (x.campaign_ref === String(id)) n[x.approval_state]++
    return n
  }
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "GET" ? Object.fromEntries(url.searchParams) : await req.json().catch(() => ({}))
      seen.push({ method: req.method, path: url.pathname, body })
      if (req.headers.get("authorization") !== "Bearer test-key") return Response.json({ error: "no" }, { status: 401 })
      if (Number(body.bloq_id) !== 912) return Response.json({ success: false, error: "You don't have access to board." }, { status: 403 })
      const p = url.pathname
      if (p === "/api/v1/campaigns/setup") {
        const created = !setUp
        setUp = true
        const st = created ? "created" : "present"
        return ok({ bloq_id: 912, created, datasets: { campaign: st, "campaign-creative": st, "campaign-feedback": st, "campaign-template": st },
          page: { page_slug: "test-brand-campaigns", url: "https://heyiris.io/p/test-brand-campaigns", made: false, created: false } }, created ? 201 : 200)
      }
      if (!setUp) return Response.json({ success: false, error: "Campaigns aren't set up on board 912 yet.", setup: "iris campaigns setup --bloq 912" }, { status: 409 })
      if (p === "/api/v1/campaigns" && req.method === "GET") return ok(campaigns.map(out))
      if (p === "/api/v1/campaigns" && req.method === "POST") {
        const c = { id: next++, name: body.name, state: body.state ?? "draft", owner: ME, budget_cents: body.budget_cents, channels: body.channels }
        campaigns.push(c)
        return ok(out(c), 201)
      }
      let m = p.match(/^\/api\/v1\/campaigns\/(\d+)\/creatives$/)
      if (m) {
        const cr = { id: next++, headline: body.headline, post_text: body.post_text, campaign_ref: m[1], approval_state: body.submit ? "in_review" : "draft", approved_by: null, approved_at: null, approval_note: null }
        creatives.push(cr)
        return ok(cr, 201)
      }
      m = p.match(/^\/api\/v1\/campaigns\/creatives\/(\d+)\/review$/)
      if (m) {
        const cr = creatives.find((x) => x.id === Number(m![1]))
        if (!cr) return Response.json({ success: false, error: "No creative." }, { status: 404 })
        if (body.decision !== "approve" && !body.note) return Response.json({ success: false, error: "Say why." }, { status: 422 })
        cr.approval_state = { approve: "approved", reject: "rejected", request_changes: "changes_requested" }[body.decision as string]
        cr.approved_by = ME
        cr.approved_at = new Date().toISOString()
        cr.approval_note = body.note ?? null
        return ok(cr)
      }
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  home = mkdtempSync(join(tmpdir(), "iris-campaigns-e2e-"))
})

afterAll(() => {
  server?.stop(true)
  if (home) rmSync(home, { recursive: true, force: true })
})

// Async on purpose: the stand-in server runs in THIS process, and a sync spawn would block the
// event loop that has to answer the CLI's requests.
async function iris(...args: string[]): Promise<{ code: number; out: string; err: string; json: any }> {
  const p = Bun.spawn([process.execPath, "run", "--conditions=browser", join(import.meta.dir, "..", "..", "index.ts"), "campaigns", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      IRIS_FL_API_URL: `http://127.0.0.1:${server.port}`,
      IRIS_API_KEY: "test-key",
      IRIS_USER_ID: "1",
      HOME: home,
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
      NO_COLOR: "1",
    },
  })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  let json: any = null
  try {
    json = JSON.parse(out.slice(out.indexOf("{")))
  } catch {}
  return { code, out, err, json }
}

describe("iris campaigns — the ticket's done-when, end to end", () => {
  test(
    "setup → create → 3 creatives → approve 2, reject 1 → list --json shows states, who and when",
    async () => {
      const before = await iris("create", "Too early", "--bloq", "912", "--json")
      expect(before.code).toBe(1)
      expect(before.json.fix).toBe("iris campaigns setup --bloq 912")

      const setup = await iris("setup", "--bloq", "912", "--json")
      expect(setup.code).toBe(0)
      expect(setup.json.datasets["campaign-creative"]).toBe("created")
      expect((await iris("setup", "--bloq", "912", "--json")).json.created).toBe(false)

      const camp = (await iris("create", "Spring launch", "--bloq", "912", "--budget", "500", "--channels", "instagram,x", "--json")).json.campaign
      expect(camp.budget_cents).toBe(50000)
      expect(camp.channels).toEqual(["instagram", "x"])

      const ids: number[] = []
      for (const h of ["One", "Two", "Three"]) {
        ids.push((await iris("add-creative", String(camp.id), "--bloq", "912", "--headline", h, "--text", `${h} body`, "--json")).json.creative.id)
      }
      expect(ids).toHaveLength(3)

      expect((await iris("approve", String(ids[0]), "--bloq", "912", "--json")).json.published).toBe(false)
      expect((await iris("approve", `#${ids[1]}`, "--bloq", "912", "--note", "Ship it", "--json")).code).toBe(0)

      const noReason = await iris("reject", String(ids[2]), "--bloq", "912", "--json")
      expect(noReason.code).toBe(1)
      expect(noReason.json.error).toContain("why")
      expect((await iris("reject", String(ids[2]), "--bloq", "912", "--reason", "Off-brand colours", "--json")).code).toBe(0)

      const list = await iris("list", "--bloq", "912", "--json")
      expect(list.code).toBe(0)
      const [c] = list.json.campaigns
      expect(c.counts).toMatchObject({ approved: 2, rejected: 1 })
      const states = c.creatives.map((x: any) => [x.approval_state, x.approved_by, Boolean(x.approved_at), x.approval_note])
      expect(states).toEqual([
        ["approved", ME, true, null],
        ["approved", ME, true, "Ship it"],
        ["rejected", ME, true, "Off-brand colours"],
      ])

      // the reviewer is never sent by the CLI — the server decides who it was
      for (const r of seen.filter((s) => s.path.endsWith("/review"))) expect(r.body).not.toHaveProperty("approved_by")

      const human = await iris("list", "--bloq", "912")
      expect(human.out + human.err).toContain("2 approved · 1 rejected")
    },
    180_000,
  )

  test("a board you cannot reach says so, in JSON, and exits non-zero", async () => {
    const r = await iris("list", "--bloq", "1", "--json")
    expect(r.code).toBe(1)
    expect(r.json.success).toBe(false)
  }, 60_000)
})
