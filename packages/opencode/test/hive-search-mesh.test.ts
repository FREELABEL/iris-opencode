import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  remoteScript,
  parseRemote,
  sshArgs,
  searchRemoteNodes,
  readRoster,
  writeRoster,
  countHits,
  rowsFromCloudTask,
  fileSearchOff,
  ROSTER_TTL_MS,
  type ListedNode,
  type MeshOutcome,
  type Roster,
} from "../src/cli/lib/hive-search-mesh"
import { meshTargetFor } from "../src/cli/cmd/platform-hive-search"

const TOKEN = "t0ken-" + "a".repeat(58)

function catOnly(home: string): string {
  const d = join(home, "catonly")
  mkdirSync(d)
  symlinkSync("/bin/cat", join(d, "cat"))
  return d
}

/** Run the remote script in a real POSIX shell against a fake curl that records argv + stdin. */
function runScript(query: string, opts: { token?: boolean; curl?: boolean; standalone?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "hsm-"))
  const bin = join(home, "bin")
  mkdirSync(join(home, ".iris"), { recursive: true })
  mkdirSync(bin)
  if (opts.token !== false) writeFileSync(join(home, ".iris", "bridge-token"), TOKEN + "\n")
  if (opts.curl !== false) {
    writeFileSync(
      join(bin, "curl"),
      // Records argv + stdin; answers 404 on the embedded path when STANDALONE=1.
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > "$HOME/argv"\ncat > "$HOME/stdin"\nfor a in "$@"; do last="$a"; done\ncase "$last" in */daemon/*) if [ "$STANDALONE" = 1 ]; then printf 'Cannot GET\\n404'; exit 0; fi ;; esac\nprintf '{"rows":[],"backend":"x","url":"%s"}\\n200' "$last"\n`,
    )
    chmodSync(join(bin, "curl"), 0o755)
  }
  let code = 0
  let out = ""
  try {
    out = execFileSync("/bin/sh", ["-c", remoteScript(query, 10)], {
      // No curl: a PATH holding only `cat` (the token read must still work).
      env: { HOME: home, PATH: opts.curl === false ? catOnly(home) : `${bin}:/usr/bin:/bin`, STANDALONE: opts.standalone ? "1" : "" },
      encoding: "utf-8",
    })
  } catch (e: any) {
    code = e.status
  }
  const read = (f: string) => {
    try {
      return readFileSync(join(home, f), "utf-8")
    } catch {
      return ""
    }
  }
  return { code, out, argv: read("argv").split("\0").filter(Boolean), stdin: read("stdin"), home }
}

describe("remote script", () => {
  test("the operator token goes to curl on stdin, never in argv", () => {
    const r = runScript("invoice")
    expect(r.code).toBe(0)
    expect(r.argv.join(" ")).not.toContain(TOKEN)
    expect(r.stdin).toBe(`X-Bridge-Key: ${TOKEN}\n`)
    expect(r.argv).toContain("@-")
    expect(r.argv).toContain("http://127.0.0.1:3200/daemon/api/files/search")
    expect(parseRemote({ stdout: r.out, code: 0, timedOut: false }, 1).kind).toBe("hits")
  })

  test("embedded path 404 → the standalone path is asked, and its answer is what comes back", () => {
    const r = runScript("invoice", { standalone: true })
    expect(r.argv).toContain("http://127.0.0.1:3200/api/files/search")
    expect(r.out).toContain('"url":"http://127.0.0.1:3200/api/files/search"')
    expect(r.out.endsWith("200")).toBe(true)
  })

  test("a hostile query is ONE literal argument — nothing in it runs", () => {
    const q = `x'; touch "$HOME/pwned"; echo '$(id) \`id\` "q"`
    const r = runScript(q)
    expect(r.argv).toContain("q=" + q)
    expect(() => readFileSync(join(r.home, "pwned"))).toThrow()
  })

  test("no token → exit 90; no curl → exit 91 (both mean: use the cloud)", () => {
    expect(runScript("x", { token: false }).code).toBe(90)
    expect(runScript("x", { curl: false }).code).toBe(91)
  })
})

describe("parseRemote", () => {
  const r = (stdout: string, code: number | null = 0, timedOut = false) => parseRemote({ stdout, code, timedOut }, 5)
  test("200 with rows → hits", () => {
    const o = r(`{"backend":"plocate","rows":[{"source":"files","match":"/a"}]}\n200`)
    expect(o.kind).toBe("hits")
    if (o.kind === "hits") expect(o.rows).toHaveLength(1)
  })
  test("403 disabled → refused, with the node's own reason", () => {
    const o = r(`{"disabled":true,"error":"file search is turned off on this machine"}\n403`)
    expect(o).toMatchObject({ kind: "refused", reason: "file search is turned off on this machine" })
  })
  test("403 without disabled (bad key) is NOT a refusal — fall back", () => {
    expect(r(`{"error":"operator key required"}\n403`).kind).toBe("fallback")
  })
  test("404 (old daemon), 000 (not listening), ssh 255, timeout → fallback", () => {
    expect(r(`Cannot GET\n404`).kind).toBe("fallback")
    expect(r(`000`).kind).toBe("fallback")
    expect(r(``, 255).kind).toBe("fallback")
    expect(r(``, null, true).kind).toBe("fallback")
  })
})

test("ssh reuses one connection per node except on Windows", () => {
  const t = { id: "1", name: "n", host: "100.1.2.3", user: "u" }
  const mac = sshArgs(t, "true", "darwin").join(" ")
  expect(mac).toContain("ControlMaster=auto")
  expect(mac).toContain("BatchMode=yes")
  expect(mac).toContain("u@100.1.2.3")
  expect(sshArgs(t, "true", "win32").join(" ")).not.toContain("ControlMaster")
})

test("countHits ignores marker rows", () => {
  expect(countHits([{ source: "files", match: "/a", preview: "" }, { source: "files", match: "(file search disabled)", preview: "" }])).toBe(1)
})

describe("meshTargetFor — who may be sent an ssh login", () => {
  const node = (caps: any, ip = "100.9.9.9"): ListedNode => ({ id: "n1", name: "n", tailscale_ip: ip, bridge_capabilities: caps })
  test("a node with no ssh binding and no advertised route (e.g. a client's server on an old daemon) → never", () => {
    expect(meshTargetFor(node({ imessage: {} }), {})).toBeNull()
    expect(meshTargetFor(node(undefined), {})).toBeNull()
  })
  test("an existing ssh binding on this machine → that address and user", () => {
    expect(meshTargetFor(node(undefined), { n1: { host: "100.1.1.1", user: "me" } })).toEqual({ host: "100.1.1.1", user: "me" })
  })
  test("a daemon advertising the route on its tailnet address → that address", () => {
    expect(meshTargetFor(node({ file_search: { available: true, route: true } }), {})).toEqual({ host: "100.9.9.9", user: null })
    expect(meshTargetFor(node({ file_search: { available: false, route: true } }), {})).toBeNull()
    expect(meshTargetFor(node({ file_search: { available: true, route: true } }, ""), {})).toBeNull()
  })
})

// ── Orchestration ────────────────────────────────────────────────────────────────────────────

const hits = (n: number, ms = 40): MeshOutcome => ({ kind: "hits", rows: Array.from({ length: n }, (_, i) => ({ source: "files", match: `/f${i}`, preview: "" })), backend: "x", ms })
const OFF = { file_search: { available: false, reason: "file search is turned off on this machine (hive_search.files = false in ~/.iris/config.json)" } }

function fleet(): ListedNode[] {
  return [
    { id: "local", name: "ThisMac", connection_status: "online" },
    { id: "hive", name: "iris-hive-001", connection_status: "online", tailscale_ip: "100.79.0.1" },
    { id: "mac2", name: "OtherMac", connection_status: "online" },
    { id: "client", name: "qb-host-vanguard", connection_status: "online", bridge_capabilities: OFF },
    { id: "gone", name: "Old", connection_status: "offline" },
  ]
}

function deps(over: Partial<Parameters<typeof searchRemoteNodes>[2]> = {}, calls = { mesh: [] as string[], cloud: [] as string[] }) {
  return {
    calls,
    d: {
      nodes: Promise.resolve(fleet()),
      isLocal: async () => (n: ListedNode) => n.id === "local",
      target: async (n: ListedNode) => (n.id === "hive" ? { host: "100.79.0.1", user: "s" } : n.id === "mac2" ? { host: "100.2.2.2", user: "a" } : null),
      mesh: async (t: { id: string }) => {
        calls.mesh.push(t.id)
        return hits(t.id === "hive" ? 10 : 3)
      },
      cloud: async (n: { id: string }) => {
        calls.cloud.push(n.id)
        return [{ source: "files", match: "/cloud", preview: "" }]
      },
      ...over,
    },
  }
}

describe("searchRemoteNodes", () => {
  test("no roster: every online remote node is searched over the mesh; a node that turned file search off is skipped up front and never contacted", async () => {
    const { d, calls } = deps()
    const r = await searchRemoteNodes(1, null, d)
    expect(calls.mesh.sort()).toEqual(["hive", "mac2"])
    expect(calls.cloud).toEqual([])
    const client = r.reports.find((x) => x.id === "client")!
    expect(client.lane).toBe("skipped")
    expect(client.reason).toContain("turned off")
    expect(r.rows.filter((x) => x.node_id === "client")).toHaveLength(0)
    expect(r.reports.find((x) => x.id === "local")).toBeUndefined()
    expect(r.rows.filter((x) => x.node_id === "hive")).toHaveLength(10)
    expect(r.roster?.nodes.find((e) => e.id === "client")?.lane).toBe("skip")
    expect(r.roster?.nodes.find((e) => e.id === "hive")).toMatchObject({ lane: "mesh", host: "100.79.0.1" })
  })

  test("a mesh fallback goes to the cloud; a node with no mesh target goes straight to the cloud", async () => {
    const { d, calls } = deps({
      target: async (n: ListedNode) => (n.id === "hive" ? { host: "h", user: null } : null),
      mesh: async () => ({ kind: "fallback", reason: "node daemon predates the direct route", ms: 9 }) as MeshOutcome,
    })
    const r = await searchRemoteNodes(1, null, d)
    expect(calls.cloud.sort()).toEqual(["hive", "mac2"])
    const hive = r.reports.find((x) => x.id === "hive")!
    expect(hive.lane).toBe("cloud")
    expect(hive.reason).toContain("predates")
    expect(r.roster?.nodes.find((e) => e.id === "hive")?.lane).toBe("cloud")
  })

  test("a node that refuses on the mesh is reported skipped and NOT retried via the cloud — the node decided", async () => {
    const { d, calls } = deps({ mesh: async () => ({ kind: "refused", reason: "file search is turned off on this machine", ms: 20 }) as MeshOutcome })
    const r = await searchRemoteNodes(1, null, d)
    expect(calls.cloud).toEqual([])
    expect(r.reports.filter((x) => x.lane === "skipped")).toHaveLength(3)
  })

  test("a cloud answer carrying the node's refusal row is reported skipped, with no hits", async () => {
    const { d } = deps({
      target: async () => null,
      cloud: async () => [{ source: "files", match: "(file search disabled)", preview: "file search is turned off on this machine", disabled: true }],
    })
    const r = await searchRemoteNodes(1, null, d)
    expect(r.reports.every((x) => x.lane === "skipped")).toBe(true)
    expect(r.rows).toHaveLength(0)
  })

  test("with a fresh roster the search starts at once and does NOT wait for the node list", async () => {
    const roster: Roster = {
      user_id: 1, saved_at: Date.now(), local_node_id: "local",
      nodes: [
        { id: "hive", name: "iris-hive-001", lane: "mesh", host: "100.79.0.1", user: "s" },
        { id: "client", name: "qb-host-vanguard", lane: "skip", reason: "off" },
      ],
    }
    const { d, calls } = deps({ nodes: new Promise(() => {}) }) // never resolves
    const r = await searchRemoteNodes(1, roster, d)
    expect(r.fromRoster).toBe(true)
    expect(calls.mesh).toEqual(["hive"])
    expect(r.rows).toHaveLength(10)
    expect(r.roster).toBeNull() // not re-saved without the node list to check it against
  })

  test("roster + node list already here: a node that has since turned file search off is dropped, a removed node is dropped, a new node is searched", async () => {
    const roster: Roster = {
      user_id: 1, saved_at: Date.now(), local_node_id: "local",
      nodes: [
        { id: "hive", name: "iris-hive-001", lane: "mesh", host: "100.79.0.1", user: "s" },
        { id: "client", name: "qb-host-vanguard", lane: "mesh", host: "100.3.3.3", user: "x" },
        { id: "deleted", name: "Deleted", lane: "mesh", host: "100.4.4.4", user: "x" },
      ],
    }
    const list = Promise.resolve(fleet())
    await list
    const { d, calls } = deps({ nodes: list })
    const r = await searchRemoteNodes(1, roster, d)
    expect(r.rows.some((x) => x.node_id === "client")).toBe(false)
    expect(r.reports.find((x) => x.id === "client")?.lane).toBe("skipped")
    expect(r.reports.some((x) => x.id === "deleted")).toBe(false)
    expect(calls.mesh).toContain("mac2")
    expect(r.roster?.nodes.map((e) => e.id).sort()).toEqual(["client", "hive", "mac2"])
  })
})

describe("roster file", () => {
  test("only this user's, only while fresh", () => {
    const p = join(mkdtempSync(join(tmpdir(), "roster-")), "r.json")
    const now = 1_000_000_000_000
    writeRoster({ user_id: 7, saved_at: now, local_node_id: null, nodes: [] }, p)
    expect(readRoster(7, now + 1000, p)).not.toBeNull()
    expect(readRoster(8, now + 1000, p)).toBeNull()
    expect(readRoster(7, now + ROSTER_TTL_MS + 1, p)).toBeNull()
    expect(readRoster(7, now - 1000, p)).toBeNull()
  })
})

test("fileSearchOff reads the node's own advertisement", () => {
  expect(fileSearchOff({ bridge_capabilities: OFF })).toContain("turned off")
  expect(fileSearchOff({ bridge_capabilities: { file_search: { available: true } } })).toBeNull()
  expect(fileSearchOff({})).toBeNull()
})

test("--deadline: a node still searching is reported missed (not dropped), the rest come back, and the caller is told to stop polling", async () => {
  let stopped = false
  const { d } = deps({
    target: async (n: ListedNode) => (n.id === "hive" ? { host: "h", user: null } : null),
    cloud: () => new Promise(() => {}), // the cloud never answers
    deadlineMs: 50,
    onDeadline: () => { stopped = true },
  })
  const started = performance.now()
  const r = await searchRemoteNodes(1, null, d)
  expect(performance.now() - started).toBeLessThan(1000)
  expect(r.rows.filter((x) => x.node_id === "hive")).toHaveLength(10)
  const mac2 = r.reports.find((x) => x.id === "mac2")!
  expect(mac2.lane).toBe("missed")
  expect(mac2.reason).toContain("50 ms")
  expect(stopped).toBe(true)
  expect(r.roster?.nodes.find((e) => e.id === "mac2")).toBeTruthy() // still known next time
})

describe("rowsFromCloudTask (a refused task is not 0 hits)", () => {
  test("failed: one marker row naming the reason, counted as no hits", () => {
    const rows = rowsFromCloudTask({ status: "failed", result: { metadata: { reason: "is busy (CPU at 168%)" } } })
    expect(rows).toHaveLength(1)
    expect(rows[0].match).toBe("(not searched)")
    expect(rows[0].preview).toBe("refused: is busy (CPU at 168%)")
    expect(countHits(rows)).toBe(0)
  })
  test("completed: the node's rows; unparseable output: none", () => {
    expect(rowsFromCloudTask({ status: "completed", result: { output: JSON.stringify([{ source: "files", match: "/a", preview: "" }]) } })).toHaveLength(1)
    expect(rowsFromCloudTask({ status: "completed", result: { output: "not json" } })).toEqual([])
  })
})
