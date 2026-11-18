import { describe, expect, test } from "bun:test"
import golden from "./hive-scripts.golden.json"
import { clampTimeout, pickNode, readDoctor, readSource, readTask, scriptDigest, TERMINAL } from "@/iris/hive-scripts"

// #188817 — the sidecar's reading of iris-api for Hive › Scripts. Real payloads: the run of
// console-demo on iris-hive-001 (2026-10-09 21:19:32 UTC) and mambo-status's doctor verdict.

describe("readTask", () => {
  test("the real run: stage timestamps, stdout, exit code from result.metadata", () => {
    const t = readTask(golden.task)!
    expect(t.status).toBe("completed")
    expect(t.terminal).toBe(true)
    expect(t.createdAt).toBe("2026-10-09T21:19:32+00:00")
    expect(t.arrivedAt).toBe("2026-10-09T21:19:32.722Z")
    expect(t.completedAt).toBe("2026-10-09T21:19:55+00:00")
    expect(t.stdout.split("\n")).toEqual(["console demo starting on ca93b63ecc77", "console demo done"])
    expect(t.stderr).toBe("")
    expect(t.exitCode).toBe(0)
    expect(t.exitCodeSource).toBe("metadata")
    expect(t.nodeName).toBe("iris-hive-001")
  })
  test("a running task is not terminal and has no exit code", () => {
    const t = readTask({ ...golden.task, status: "running", completed_at: null, result: null, metadata: null })!
    expect(t.terminal).toBe(false)
    expect(t.exitCode).toBeNull()
    expect(t.completedAt).toBeNull()
    expect(t.stdout).toBe("")
  })
  test("the separated stream wins over the merged one", () => {
    const t = readTask({ id: "x", status: "completed", result: { output: "a\nb", stdout: "a", stderr: "b" } })!
    expect(t.stdout).toBe("a")
    expect(t.stderr).toBe("b")
  })
  test("an exit code recovered from prose is labelled as inferred", () => {
    const t = readTask({ id: "x", status: "failed", error: "Process exited with code 42" })!
    expect(t.exitCode).toBe(42)
    expect(t.exitCodeSource).toBe("error_text")
  })
  test("unknown statuses are not terminal successes", () => {
    expect(TERMINAL.has("dispatched")).toBe(false)
    // a task between stages is still live — the panel keeps polling it
    for (const status of ["pending", "queued", "dispatched", "assigned"]) expect(readTask({ id: "x", status })!.terminal).toBe(false)
    expect(readTask({ id: "x", status: "succeeded" })!.terminal).toBe(true)
    expect(readTask(null)).toBeNull()
  })
})

describe("readDoctor", () => {
  test("keeps the hub's count and every unmet reason", () => {
    const d = readDoctor(golden.doctor)!
    expect(d.slug).toBe("mambo-status")
    expect(d.requires).toEqual(["bluetooth", "python3"])
    expect(d.eligible_online).toBe(0)
    expect(d.blocked.length).toBe(5)
    expect(d.blocked[0].verdict?.unmet?.[0].requirement).toBe("bluetooth")
  })
  test("a missing count is null, never zero", () => {
    expect(readDoctor({ slug: "x" })!.eligible_online).toBeNull()
  })
})

describe("run", () => {
  test("source is hashed the way the CLI pins it", () => {
    const s = readSource({ slug: "a", script_content: "echo hi\n", runtime: "bash", auto_pull: 0 })!
    expect(s.sha256).toBe(scriptDigest("echo hi\n"))
    expect(s.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(s.autoPull).toBe(false)
  })
  test("the hash of the real run's script matches what the hub recorded", () => {
    const content = '#!/bin/bash\n# iris: arg=seconds default=20\n# iris: timeout=120\n# A harmless demo for the Hive console: prints, waits, prints again.\necho "console demo starting on $(hostname)"\nsleep "${SECONDS_ARG:-${SECONDS:-20}}"\necho "console demo done"'
    expect(scriptDigest(content)).toBe(golden.task.config.script_sha256)
  })
  test("node resolution: id, name, id prefix, name prefix", () => {
    const nodes = [
      { id: "01a1-mac", name: "Alexs-MacBook-Pro-11711" },
      { id: "01a1-hive", name: "iris-hive-001" },
    ]
    expect(pickNode(nodes, "01a1-hive")?.name).toBe("iris-hive-001")
    expect(pickNode(nodes, "IRIS-HIVE-001")?.id).toBe("01a1-hive")
    expect(pickNode(nodes, "01a1-m")?.name).toBe("Alexs-MacBook-Pro-11711")
    expect(pickNode(nodes, "alexs")?.id).toBe("01a1-mac")
    expect(pickNode(nodes, "nope")).toBeUndefined()
  })
  test("timeout clamps like the CLI", () => {
    expect(clampTimeout(undefined)).toBe(120)
    expect(clampTimeout(5)).toBe(30)
    expect(clampTimeout(99999)).toBe(3600)
    expect(clampTimeout(600)).toBe(600)
  })
})

describe("save keeps tags; adding from the marketplace never overwrites", () => {
  const H = () => import("@/iris/hive-scripts")
  const withHub = async (mine: Record<string, any>, fn: (posts: any[]) => Promise<void>) => {
    process.env.IRIS_USER_ID = "193"
    const posts: any[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)))
        return json({ data: { updated_at: "2026-10-11T00:00:00Z" } }, 201)
      }
      const pub = u.match(/\/api\/v1\/public\/scripts\/([a-z0-9-]+)$/)
      if (pub) return json({ data: { slug: pub[1], name: "Public", runtime: "bash", script_content: "echo public\n", assets: [{}], checks: [] } })
      const own = u.match(/\/api\/v1\/scripts\/([a-z0-9-]+)$/)
      if (own) return mine[own[1]] ? json({ data: mine[own[1]] }) : json({ message: "nope" }, 404)
      return json({}, 500)
    }) as any
    try {
      await fn(posts)
    } finally {
      globalThis.fetch = real
      delete process.env.IRIS_USER_ID
    }
  }
  const saved = { slug: "deal-scenarios", runtime: "bash", script_content: "echo mine\n", tags: ["ops", "project:7"], auto_pull: false }

  test("a plain save sends the saved tags back (the hub erases tags a push leaves out)", async () => {
    const { saveScript } = await H()
    await withHub({ "deal-scenarios": saved }, async (posts) => {
      expect((await saveScript("deal-scenarios", "echo edited\n")).ok).toBe(true)
      expect(posts[0].tags).toEqual(["ops", "project:7"])
      expect(posts[0].script_content).toBe("echo edited\n")
    })
  })
  test("setting tags re-saves the SAVED content with exactly those tags", async () => {
    const { setScriptTags } = await H()
    await withHub({ "deal-scenarios": saved }, async (posts) => {
      expect((await setScriptTags("deal-scenarios", ["ops", "ops", " "])).ok).toBe(true)
      expect(posts[0]).toMatchObject({ slug: "deal-scenarios", script_content: "echo mine\n", tags: ["ops"] })
    })
  })
  test("adding a public script I already have is refused and writes nothing", async () => {
    const { installScript } = await H()
    await withHub({ "deal-scenarios": saved }, async (posts) => {
      const r = await installScript("deal-scenarios")
      expect(r.ok).toBe(false)
      expect(r.reason).toContain("already have")
      expect(posts).toEqual([])
    })
  })
  test("adding a new one copies the public source and says what was left behind", async () => {
    const { installScript } = await H()
    await withHub({}, async (posts) => {
      const r = await installScript("csv-tidy")
      expect(r).toMatchObject({ ok: true, assetsLeft: 1 })
      expect(posts[0]).toMatchObject({ slug: "csv-tidy", name: "Public", script_content: "echo public\n", tags: null })
    })
  })
})

// #189589 — the hub's answer for a held run: not sent, with Gate's reasons for the person deciding.
test("readTask marks an awaiting_approval run held and carries Gate's verdict", () => {
  const t = readTask({
    id: 7,
    status: "awaiting_approval",
    gate: { explanation: "It controls hardware (bluetooth). It will not run until you approve it.", reasons: ["hardware"], action: "clean", score: 0.03, hardware: ["bluetooth"] },
  })
  expect(t?.held).toBe(true)
  expect(t?.terminal).toBe(false)
  expect(t?.gate).toMatchObject({ reasons: ["hardware"], hardware: ["bluetooth"] })
  expect(readTask({ id: 8, status: "running" })?.gate).toBeNull()
})

// #191674 — sharing: who can open a script, scripts shared with me, and runs the hub routes.
describe("sharing (#191674)", () => {
  const H = () => import("@/iris/hive-scripts")
  const UUID = "7e9a1c3b-5d7f-4a1b-8c3d-5e7f9a1b3c5d"
  /** A fake hub: records every call; `answer` decides POST /api/v6/nodes/tasks and the access calls. */
  const withHub = async (answer: (u: string, body: any) => Response | undefined, fn: (calls: { url: string; method: string; body?: any }[]) => Promise<void>) => {
    process.env.IRIS_USER_ID = "193"
    const calls: { url: string; method: string; body?: any }[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url: u, method: init?.method ?? "GET", body })
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
      const a = answer(u, body)
      if (a) return a
      if (u.includes("/api/v6/nodes/?")) return json({ nodes: [{ id: "01a1-hive", name: "iris-hive-001", connection_status: "online" }] })
      if (/\/api\/v1\/scripts\/mambo-status$/.test(u)) return json({ data: { slug: "mambo-status", script_content: "echo hi\n", runtime: "bash" } })
      if (u.endsWith("/api/v6/nodes/tasks")) return json({ task: { id: "t-1", status: "pending", node_id: "01a0-mac", node_name: "Alexs-MacBook-Pro-11711" } }, 201)
      return json({ message: "nope" }, 404)
    }) as any
    try {
      await fn(calls)
    } finally {
      globalThis.fetch = real
      delete process.env.IRIS_USER_ID
    }
  }
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
  const task = (calls: { url: string; body?: any }[]) => calls.find((c) => c.url.endsWith("/api/v6/nodes/tasks"))!.body

  test("readShared keeps what a member needs and drops a row it could not run", async () => {
    const { readShared } = await H()
    const s = readShared({ id: UUID, slug: "lead-dedupe", version: 6, visibility: "project", author_name: "Dana Ruiz", bloq_ids: [7, "12", 7, null], runs_on: { kind: "node", node: "studio-mac" } })!
    expect(s).toMatchObject({ id: UUID, author: "Dana Ruiz", version: 6, visibility: "project", bloqIds: [7, 12], runsOn: { kind: "node", node: "studio-mac" } })
    expect(readShared({ slug: "no-id" })).toBeNull()
  })
  test("runs_on and visibility read as the hub wrote them; anything else is null / private", async () => {
    const { readRunsOn, readVisibility } = await H()
    expect(readRunsOn({ kind: "capability", capability: "gpu" })).toEqual({ kind: "capability", capability: "gpu" })
    expect(readRunsOn({ kind: "any" })).toEqual({ kind: "any" })
    expect(readRunsOn("studio-mac")).toBeNull()
    expect(readRunsOn({ kind: "node" })).toBeNull()
    expect(readVisibility("PUBLIC")).toBe("private")
    expect(readVisibility("unlisted")).toBe("unlisted")
  })
  test("a refusal is the hub's sentence; a 404 says not found or not shared", async () => {
    const { refusal } = await H()
    expect(refusal(422, JSON.stringify({ message: "'lead-dedupe' runs only on studio-mac, and that machine is not one you can reach." }))).toBe(
      "'lead-dedupe' runs only on studio-mac, and that machine is not one you can reach.",
    )
    expect(refusal(422, JSON.stringify({ error: "This script has manifest errors and cannot be published.", errors: ["unknown directive 'reqires'"] }))).toBe(
      "This script has manifest errors and cannot be published. unknown directive 'reqires'",
    )
    expect(refusal(404, JSON.stringify({ message: "No such script" }))).toBe("Not found, or not shared with you.")
    expect(refusal(500, "boom")).toBe("iris-api 500 — boom")
  })
  test("access steps: a team needs a board, refused before any call", async () => {
    const { accessStepOf, accessRequest } = await H()
    expect(accessStepOf({ action: "publish", visibility: "project", bloqIds: [] })).toEqual({ error: "Pick at least one board to share it with." })
    expect(accessStepOf({ action: "share" })).toEqual({ error: "Pick a board." })
    expect(accessRequest("x", { action: "publish", visibility: "project", bloqIds: [7] })).toEqual({ path: "/api/v1/scripts/x/publish", body: { visibility: "project", bloq_ids: [7] } })
    expect(accessRequest("x", { action: "publish", visibility: "public" })).toEqual({ path: "/api/v1/scripts/x/publish", body: { visibility: "public" } })
    expect(accessRequest("x", { action: "unpublish" })).toEqual({ path: "/api/v1/scripts/x/unpublish" })
    expect(accessRequest("x", { action: "unshare", bloqId: 12 })).toEqual({ path: "/api/v1/scripts/x/unshare", body: { bloq_id: 12 } })
  })
  test("changeAccess: one hub call; the answer is the script's access as the hub has it", async () => {
    const { changeAccess } = await H()
    await withHub(
      (u) => (u.endsWith("/share") ? json({ data: { visibility: "project", bloq_ids: [12, 40], version: 4 } }) : undefined),
      async (calls) => {
        expect(await changeAccess("mambo-status", { action: "share", bloqId: 40 })).toEqual({ ok: true, visibility: "project", bloqIds: [12, 40], version: 4 })
        expect(calls.map((c) => [c.method, c.url.replace(/^https?:\/\/[^/]+/, ""), c.body])).toEqual([["POST", "/api/v1/scripts/mambo-status/share", { bloq_id: 40 }]])
      },
    )
    await withHub(() => undefined, async (calls) => {
      expect(await changeAccess("x", { action: "publish", visibility: "project" })).toMatchObject({ ok: false })
      expect(calls).toEqual([])
    })
    await withHub(
      (u) => (u.endsWith("/publish") ? json({ message: "Not a board you own or belong to: 99" }, 422) : undefined),
      async () => {
        expect(await changeAccess("x", { action: "publish", visibility: "project", bloqIds: [99] })).toEqual({ ok: false, reason: "Not a board you own or belong to: 99" })
      },
    )
  })
  test("a runs-on script is sent with NO computer — the hub routes it — and still pins my hash", async () => {
    const { runScript, scriptDigest } = await H()
    await withHub(() => undefined, async (calls) => {
      const r = await runScript("mambo-status", undefined, 60)
      expect(r).toMatchObject({ ok: true, taskId: "t-1", nodeName: "Alexs-MacBook-Pro-11711", nodeId: "01a0-mac" })
      expect(calls.some((c) => c.url.includes("/api/v6/nodes/?"))).toBe(false)
      const t = task(calls)
      expect("node_id" in t).toBe(false)
      expect(t.config).toEqual({ script_ref: "mambo-status", script_slug: "mambo-status", script_sha256: scriptDigest("echo hi\n") })
    })
  })
  test("an older version or a shared script goes as its ref, unhashed — the hub pins it", async () => {
    const { runScript } = await H()
    await withHub(() => undefined, async (calls) => {
      await runScript("mambo-status@2", "iris-hive-001")
      const t = task(calls)
      expect(t.node_id).toBe("01a1-hive")
      expect(t.prompt).toBe("mambo-status@2")
      expect(t.config).toEqual({ script_ref: "mambo-status@2" })
    })
    await withHub(() => undefined, async (calls) => {
      await runScript(`${UUID}@3`, undefined)
      expect(calls.filter((c) => c.url.includes("/api/v1/scripts/"))).toEqual([])
      expect(task(calls).config).toEqual({ script_ref: `${UUID}@3` })
    })
  })
  test("a refused run shows the hub's sentence; a missing one says so plainly", async () => {
    const { runScript } = await H()
    await withHub(
      (u) => (u.endsWith("/api/v6/nodes/tasks") ? json({ error: "refused", message: "'studio-render' runs only on studio-mac, and that machine is not one you can reach." }, 422) : undefined),
      async () => {
        expect(await runScript(UUID, undefined)).toEqual({ ok: false, reason: "'studio-render' runs only on studio-mac, and that machine is not one you can reach." })
      },
    )
    await withHub(
      (u) => (u.endsWith("/api/v6/nodes/tasks") ? json({ message: "No query results" }, 404) : undefined),
      async () => {
        expect((await runScript(UUID, undefined)).reason).toBe("Not found, or not shared with you.")
      },
    )
  })
})
