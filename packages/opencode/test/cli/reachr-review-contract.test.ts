/**
 * Reachr Review contract, CLI half (#191986, epic #191985). Spawns the REAL CLI against a local server.
 * The API half, against real routes and auth, is fl-api tests/Feature/Reachr/ReachrReviewContractTest.
 *
 * Fake classification, as the ticket asks:
 *   fl-api responses - RECORDED, from that fl-api test (test/fixture/reachr-review/fl-api-recorded.json).
 *   email, Instagram - not reached from here. The CLI only ever talks to fl-api.
 *
 * `iris reachr drafts` (#191989) doesn't exist yet. Those cases are test.failing, not skipped: they pass
 * while the command is missing and go RED the day it exists, so they can't be forgotten or stay green
 * by accident. When that happens, drop `.failing` and drive the exit check for real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { join } from "path"
import fs from "fs/promises"
import os from "os"
import recorded from "../fixture/reachr-review/fl-api-recorded.json"
import capabilities from "../../capabilities.json"

const PKG = join(import.meta.dir, "../..")
const CLI = join(PKG, "src/index.ts")
const ID = recorded.approve.data.id

let server: ReturnType<typeof Bun.serve>
let home = ""
let seen: { route: string; body: any }[] = []
/** What the server answers to `review`: the recorded answer, or the one a not-yet-deployed fl-api gives. */
let reviewAnswer: any = recorded.approve
let sendAnswer: { status: number; body: any } = { status: 200, body: recorded.send }

beforeAll(async () => {
  home = await fs.mkdtemp(join(os.tmpdir(), "reachr-review-"))
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" ? await req.json().catch(() => null) : null
      seen.push({ route: `${req.method} ${url.pathname}${url.search}`, body })
      if (url.pathname === "/api/v1/outreach/pending-approvals")
        return Response.json(url.searchParams.get("state") === "approved" ? recorded.approved : recorded.pending)
      if (url.pathname === `/api/v1/outreach/messages/${ID}/review`) return Response.json(reviewAnswer)
      if (url.pathname === `/api/v1/outreach/messages/${ID}/send`) return Response.json(sendAnswer.body, { status: sendAnswer.status })
      return Response.json({ success: false, message: "not here" }, { status: 404 })
    },
  })
})

afterAll(async () => {
  server?.stop(true)
  if (home) await fs.rm(home, { recursive: true, force: true })
})

beforeEach(() => {
  seen = []
  reviewAnswer = recorded.approve
  sendAnswer = { status: 200, body: recorded.send }
})

async function iris(args: string[]) {
  const base = `http://127.0.0.1:${server.port}`
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: PKG,
    env: { ...process.env, HOME: home, OPENCODE_TEST_HOME: home, IRIS_API_URL: base, IRIS_FL_API_URL: base, IRIS_API_KEY: "test-key", IRIS_USER_ID: "2945" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out: stdout + stderr, exit }
}

const writes = () => seen.filter((s) => s.route.startsWith("POST /api/v1/outreach"))

describe("approving is not sending", () => {
  test("approve calls review once, never send, and says it was not sent", async () => {
    const r = await iris(["outreach", "approve", "approve", String(ID)])
    expect(r.exit).toBe(0)
    expect(writes()).toEqual([{ route: `POST /api/v1/outreach/messages/${ID}/review`, body: { action: "approve", notes: null } }])
    expect(r.out).toContain("Not sent")
    expect(r.out).not.toContain("approved and sent")
    expect(r.out).toContain(`iris outreach approve send ${ID}`)
  }, 60_000)

  test("approve --all approves the queue, sends nothing and points at what waits", async () => {
    const r = await iris(["outreach", "approve", "--all"])
    expect(r.exit).toBe(0)
    expect(writes().map((w) => w.route)).toEqual([`POST /api/v1/outreach/messages/${ID}/review`])
    expect(r.out).toContain("1 approved and not sent")
  }, 60_000)

  test("while an older fl-api still sends on approve, the CLI reports what the server did", async () => {
    reviewAnswer = { success: true, message: "Email approved and sent", data: { id: ID, status: "sent" } }
    const r = await iris(["outreach", "approve", "approve", String(ID)])
    expect(r.out).toContain("approved and sent")
    expect(r.out).not.toContain("Not sent")
  }, 60_000)
})

describe("sending is its own action", () => {
  test("send posts to send, once, without retry", async () => {
    const r = await iris(["outreach", "approve", "send", String(ID)])
    expect(r.exit).toBe(0)
    expect(writes()).toEqual([{ route: `POST /api/v1/outreach/messages/${ID}/send`, body: {} }])
    expect(r.out).toContain(`Message #${ID} sent`)
  }, 60_000)

  test("a refused send exits non-zero and gives the server's reason", async () => {
    sendAnswer = { status: 409, body: recorded.send_again }
    const r = await iris(["outreach", "approve", "send", String(ID)])
    expect(r.exit).toBe(1)
    expect(r.out).toContain(recorded.send_again.error)
    expect(r.out).toContain("Not sent")
    expect(r.out).not.toContain(`Message #${ID} sent`)
  }, 60_000)

  test("--retry is passed only when asked for", async () => {
    await iris(["outreach", "approve", "send", String(ID), "--retry"])
    expect(writes()[0].body).toEqual({ retry: true })
  }, 60_000)

  test("approved lists what is waiting, from the approved queue", async () => {
    const r = await iris(["outreach", "approve", "approved"])
    expect(r.exit).toBe(0)
    expect(seen.map((s) => s.route)).toContain("GET /api/v1/outreach/pending-approvals?state=approved")
    expect(writes()).toEqual([])
    expect(r.out).toContain(`#${ID}`)
  }, 60_000)
})

/** pending #191989. The exit check in the epic, one command at a time. */
describe("iris reachr drafts (pending #191989)", () => {
  const names = (capabilities as any).entries.map((c: any) => c.name as string)

  test("the capability index is readable, so the cases below fail for the right reason", () => {
    expect(names).toContain("reachr approve send")
  })

  for (const sub of ["create", "list", "edit", "approve", "hold", "schedule", "wait", "check", "audit"]) {
    test.failing(`pending #191989: reachr drafts ${sub} exists`, () => {
      expect(names.some((n: string) => n.startsWith(`reachr drafts ${sub}`))).toBe(true)
    })
  }
})
