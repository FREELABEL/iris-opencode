import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  matchesQuery,
  sortScripts,
  pageOf,
  pageHolding,
  shortAgo,
  readSort,
  commandFor,
  computerVerdict,
  defaultComputer,
  diskCritical,
  elapsedSeconds,
  fileName,
  findComputer,
  groupComputers,
  isTestScript,
  lastLine,
  listWidth,
  projectTag,
  readView,
  scriptsInView,
  withTag,
  parseCommand,
  parseHeader,
  setArgDefault,
  readiness,
  skillsOf,
  stageStates,
  taskStatusWord,
  highlightLine,
  runArgs,
  missingRequired,
  topFix,
  type Doctor,
  type HiveNodeRow,
  type ScriptRow,
  type TaskView, plugged,
  accessLabel,
  boardNames,
  planAccess,
  readAccess,
  routing,
  runRef,
  sharedVia,
  shareLink,
  unshareMakesPrivate,
  versionChoices,
  versionWord,
  type Board,
  type SharedScript,
} from "./iris-hive-scripts-model"

// #188817 — every rule the Scripts tab draws from, over a REAL snapshot of account #193 on
// 2026-10-09 (27 scripts, 17 doctor verdicts, 6 node records, one real run of console-demo).

// Read, not imported: a JSON import is outside the typecheck project.
const snap = JSON.parse(readFileSync(new URL("./__fixtures__/hive-scripts.json", import.meta.url), "utf8"))
const scripts = snap.scripts as unknown as ScriptRow[]
const nodes = snap.nodes as unknown as HiveNodeRow[]
const task = snap.task as unknown as TaskView
const computers = groupComputers(nodes)
const onlineNames = new Set(nodes.filter((n) => n.online).map((n) => n.name))
const doctorOf = (slug: string) => scripts.find((s) => s.slug === slug)!.doctor as Doctor

describe("test fixtures", () => {
  test("the Hive's own test scripts are hidden; real ones are not", () => {
    const hidden = scripts.filter((s) => isTestScript(s.slug)).map((s) => s.slug)
    expect(hidden).toContain("e2e-fda")
    expect(hidden).toContain("console-demo")
    expect(hidden).toContain("probe-gate-test")
    expect(hidden).not.toContain("node-health")
    expect(hidden).not.toContain("mambo-status")
    expect(scripts.length - hidden.length).toBe(17)
  })
})

describe("header", () => {
  test("console-demo: one arg with a default, a timeout", () => {
    const h = parseHeader(snap.source.content)
    expect(h.args).toEqual([{ name: "seconds", default: "20", required: false, line: 2 }])
    expect(h.timeout).toBe(120)
    expect(h.lines).toEqual([2, 3])
  })
  test("required and default-less args, egress, requires", () => {
    const h = parseHeader(
      "#!/bin/bash\n# iris: arg=source_dir required\n# iris: arg=quality\n# iris: egress=none\n# iris: requires=bluetooth,python3\n# iris: timeout=600\necho hi\n# iris: timeout=5\n",
    )
    expect(h.args.map((a) => [a.name, a.required, a.default])).toEqual([
      ["source_dir", true, undefined],
      ["quality", false, undefined],
    ])
    expect(h.egress).toBe("none")
    expect(h.requires).toEqual(["bluetooth", "python3"])
    // a header line AFTER code is not a header — the daemon's parser stops at code too
    expect(h.timeout).toBe(600)
  })
  test("an input box edits the header line it came from", () => {
    const src = snap.source.content as string
    const next = setArgDefault(src, "seconds", "5")
    expect(next.split("\n")[1]).toBe("# iris: arg=seconds default=5")
    expect(parseHeader(next).args[0].default).toBe("5")
    // nothing else moved — a save of this must not rewrite the script body
    expect(next.split("\n").filter((_, i) => i !== 1)).toEqual(src.split("\n").filter((_, i) => i !== 1))
    expect(setArgDefault(src, "seconds", "").split("\n")[1]).toBe("# iris: arg=seconds")
    expect(setArgDefault("# iris: arg=q required\necho", "q", "7")).toBe("# iris: arg=q default=7 required\necho")
    expect(setArgDefault(src, "nope", "1")).toBe(src)
  })
  test("file names follow the runtime", () => {
    expect(fileName("console-demo", "bash")).toBe("console-demo.sh")
    expect(fileName("deal-scenarios", "python")).toBe("deal-scenarios.py")
    expect(fileName("x")).toBe("x.sh")
  })
})

describe("⌘K", () => {
  test("run with args and a computer", () => {
    expect(parseCommand("run console-demo seconds=20 on iris-hive-001")).toEqual({
      verb: "run",
      slug: "console-demo",
      args: { seconds: "20" },
      node: "iris-hive-001",
    })
  })
  test("bare slug opens it; nonsense is refused, not guessed", () => {
    expect(parseCommand("node-health")).toEqual({ verb: "open", slug: "node-health", args: {}, node: undefined })
    expect(parseCommand("run")).toBeNull()
    expect(parseCommand("run x stray")).toBeNull()
    expect(parseCommand("   ")).toBeNull()
  })
  test("round-trips", () => {
    const line = commandFor("console-demo", { seconds: "20" }, "iris-hive-001")
    expect(line).toBe("run console-demo seconds=20 on iris-hive-001")
    expect(parseCommand(line)?.args).toEqual({ seconds: "20" })
  })
})

describe("computers", () => {
  test("the MacBook's three registrations are one computer", () => {
    const mac = computers.find((c) => c.name === "Alexs-MacBook-Pro-11711")!
    expect(mac.regs).toBe(3)
    expect(mac.online).toBe(true)
    expect(mac.names).toContain("MacBookPro")
    expect(computers.length).toBe(4)
    expect(computers.filter((c) => c.online).map((c) => c.name).sort()).toEqual(["Alexs-MacBook-Pro-11711", "iris-hive-001"])
  })
  test("disk under 2% free is critical", () => {
    expect(diskCritical(computers.find((c) => c.name === "Alexs-MacBook-Pro-11711")!)).toBe(true)
    expect(diskCritical(computers.find((c) => c.name === "iris-hive-001")!)).toBe(false)
  })
  test("at most three skill icons, no repeated word", () => {
    const mac = computers.find((c) => c.name === "Alexs-MacBook-Pro-11711")!
    const s = skillsOf(mac)
    expect(s.length).toBe(3)
    expect(new Set(s.map((x) => x.word)).size).toBe(3)
  })
  test("⌘K `on` resolves the way the CLI does", () => {
    expect(findComputer(computers, "iris-hive-001")?.name).toBe("iris-hive-001")
    expect(findComputer(computers, "macbookpro")?.name).toBe("Alexs-MacBook-Pro-11711")
    expect(findComputer(computers, "iris")?.name).toBe("iris-hive-001")
    expect(findComputer(computers, "nope")).toBeUndefined()
  })
})

describe("readiness", () => {
  test("ready counts come from the hub, not from name matching", () => {
    const r = readiness(doctorOf("node-health"), onlineNames)
    expect(r.state).toBe("ok")
    expect(r.label).toBe("Ready on 1 computer")
  })
  test("blocked scripts carry the most actionable fix", () => {
    const r = readiness(doctorOf("mambo-status"), onlineNames)
    expect(r.state).toBe("blocked")
    expect(r.fix).toBe("Alexs-MacBook-Pro-11711 stopped reporting what it can do — restart its Hive daemon")
  })
  test("a privacy setting outranks a daemon restart", () => {
    const d: Doctor = {
      slug: "x",
      eligible_online: 0,
      blocked: [
        { node: "a", verdict: { unmet: [{ requirement: "bluetooth", reason: "node STOPPED reporting permissions" }] } },
        { node: "b", verdict: { unmet: [{ requirement: "full-disk-access", reason: "denied by macOS privacy" }] } },
      ],
    }
    expect(readiness(d, new Set(["a", "b"])).fix).toBe("b needs Full Disk Access — grant it in macOS Settings")
    // an OFFLINE computer's reasons are not fixes
    expect(readiness(d, new Set(["a"])).fix).toBe("a stopped reporting what it can do — restart its Hive daemon")
  })
  test("no doctor is unknown, never ready", () => {
    expect(readiness(null, onlineNames).state).toBe("unknown")
  })
  test("one fix unblocks six scripts", () => {
    const f = topFix(scripts, onlineNames)!
    expect(f.fix).toContain("restart its Hive daemon")
    expect(f.slugs.length).toBe(6)
  })
  test("a blocked script cannot go to an online computer even when an offline duplicate is 'eligible'", () => {
    const mac = computers.find((c) => c.name === "Alexs-MacBook-Pro-11711")!
    expect(computerVerdict(mac, doctorOf("mambo-status")).can).toBe(false)
    expect(defaultComputer(computers, doctorOf("mambo-status"))).toBeUndefined()
  })
  test("Run defaults to a computer that can take it", () => {
    expect(defaultComputer(computers, doctorOf("node-health"))).toBeDefined()
    // with no doctor, any online computer — but not the one whose disk is 99.5% full
    expect(defaultComputer(computers, null)?.name).toBe("iris-hive-001")
    expect(defaultComputer(computers, null)?.online).toBe(true)
  })
})

describe("stages", () => {
  test("the real run: five stages done, exit 0", () => {
    const st = stageStates(task)
    expect(Object.values(st)).toEqual(["done", "done", "done", "done", "done"])
    expect(taskStatusWord(task)).toBe("Done · exit 0")
    expect(elapsedSeconds(task, 0)).toBe(23)
    expect(lastLine(task.stdout)).toBe("console demo done")
  })
  test("mid-run: the furthest timestamp is now", () => {
    const mid: TaskView = { ...task, status: "running", terminal: false, completedAt: null, exitCode: null }
    expect(stageStates(mid)).toEqual({ queued: "done", sent: "done", arrived: "done", running: "now", done: "todo" })
    expect(taskStatusWord(mid)).toBe("Running")
    const sent: TaskView = { ...mid, arrivedAt: null, startedAt: null }
    expect(stageStates(sent).sent).toBe("now")
  })
  test("a failure is never painted Done", () => {
    const failed: TaskView = { ...task, status: "failed", exitCode: 42, completedAt: null }
    const st = stageStates(failed)
    expect(st.running).toBe("failed")
    expect(st.done).toBe("todo")
    expect(taskStatusWord(failed)).toBe("Failed · exit 42")
    // "completed" with a non-zero exit code is still a failure
    expect(taskStatusWord({ ...task, exitCode: 1 })).toBe("Failed · exit 1")
  })
  test("no task: nothing reached", () => {
    expect(Object.values(stageStates(null))).toEqual(["todo", "todo", "todo", "todo", "todo"])
  })
})

describe("listWidth", () => {
  test("keeps the list between 130 and 360px, and defaults to 196", () => {
    expect(listWidth(200)).toBe(200)
    expect(listWidth(10)).toBe(130)
    expect(listWidth(900)).toBe(360)
    expect(listWidth(undefined)).toBe(196)
    expect(listWidth("wide")).toBe(196)
    expect(listWidth(Number.NaN)).toBe(196)
  })
})

describe("views", () => {
  const rows = [
    { slug: "deal-scenarios", tags: ["project:7"] },
    { slug: "node-health", tags: [] },
    { slug: "e2e-fda", tags: ["project:7"] },
    { slug: "s1-probe" },
  ]
  const tag = projectTag(7)
  test("All hides test scripts unless asked, but keeps the open one", () => {
    expect(scriptsInView(rows, "all", tag, { showTests: false }).map((s) => s.slug)).toEqual(["deal-scenarios", "node-health"])
    expect(scriptsInView(rows, "all", tag, { showTests: false, open: "s1-probe" }).map((s) => s.slug)).toContain("s1-probe")
    expect(scriptsInView(rows, "all", tag, { showTests: true })).toHaveLength(4)
  })
  test("Project is exactly what the board claimed, tests included", () => {
    expect(scriptsInView(rows, "project", tag, { showTests: false }).map((s) => s.slug)).toEqual(["deal-scenarios", "e2e-fda"])
    expect(scriptsInView(rows, "project", projectTag(8), { showTests: true })).toEqual([])
    expect(scriptsInView(rows, "project", undefined, { showTests: true })).toEqual([])
  })
  test("a board with no id claims nothing; tags other than the board's survive a toggle", () => {
    expect(projectTag(undefined)).toBeUndefined()
    expect(projectTag(0)).toBeUndefined()
    expect(withTag(["ops", "project:7"], "project:7", false)).toEqual(["ops"])
    expect(withTag(["ops"], "project:7", true)).toEqual(["ops", "project:7"])
    expect(withTag(["project:7"], "project:7", true)).toEqual(["project:7"])
  })
  test("an unknown remembered view falls back to All", () => {
    expect(readView("market")).toBe("market")
    expect(readView("nope")).toBe("all")
    expect(readView(null)).toBe("all")
  })
})

describe("find · sort · page", () => {
  const rows = [
    { slug: "nyc-budget", updatedAt: "2026-10-01T00:00:00Z" },
    { slug: "deal-scenarios", name: "Deal Scenarios", description: "fear and greed", updatedAt: "2026-10-10T00:00:00Z" },
    { slug: "hello-fleet" },
    { slug: "csv-tidy", tags: ["project:571"], updatedAt: "2026-10-10T00:00:00Z" },
  ]
  test("every word must match somewhere; hyphens and case do not matter", () => {
    expect(matchesQuery(rows[1], "deal scen")).toBe(true)
    expect(matchesQuery(rows[1], "DEAL-SCENARIOS")).toBe(true)
    expect(matchesQuery(rows[1], "greed")).toBe(true)
    expect(matchesQuery(rows[1], "deal budget")).toBe(false)
    expect(matchesQuery(rows[3], "571")).toBe(true)
    expect(matchesQuery(rows[0], "   ")).toBe(true)
  })
  test("recent puts the newest edit first, undated last, ties by slug", () => {
    expect(sortScripts(rows, "recent").map((r) => r.slug)).toEqual(["csv-tidy", "deal-scenarios", "nyc-budget", "hello-fleet"])
    expect(sortScripts(rows, "name").map((r) => r.slug)).toEqual(["csv-tidy", "deal-scenarios", "hello-fleet", "nyc-budget"])
    expect(rows[0].slug).toBe("nyc-budget") // not sorted in place
  })
  test("pages clamp, and the page holding a script is found", () => {
    const many = Array.from({ length: 37 }, (_, i) => ({ slug: `s${String(i).padStart(2, "0")}` }))
    expect(pageOf(many, 1)).toMatchObject({ page: 1, pages: 2, from: 1, to: 25, total: 37 })
    expect(pageOf(many, 2).rows.length).toBe(12)
    expect(pageOf(many, 9)).toMatchObject({ page: 2, from: 26, to: 37 })
    expect(pageOf([], 3)).toMatchObject({ page: 1, pages: 1, from: 0, to: 0 })
    expect(pageHolding(many, "s30")).toBe(2)
    expect(pageHolding(many, "nope")).toBeUndefined()
  })
  test("short ages and the remembered order", () => {
    const now = Date.parse("2026-10-11T00:00:00Z")
    expect(shortAgo("2026-10-10T23:59:30Z", now)).toBe("now")
    expect(shortAgo("2026-10-10T23:00:00Z", now)).toBe("1h")
    expect(shortAgo("2026-10-08T00:00:00Z", now)).toBe("3d")
    expect(shortAgo("2026-08-01T00:00:00Z", now)).toBe("10w")
    expect(shortAgo(undefined, now)).toBe("")
    expect(readSort("name")).toBe("name")
    expect(readSort("junk")).toBe("recent")
  })
})

// #189589 — a run Constellation Gate held has not been sent; "Queued" would read as on its way.
test("a held run reads as waiting for approval, not queued", () => {
  const held = { id: "t1", status: "awaiting_approval", terminal: false, stdout: "", stderr: "", exitCode: null, exitCodeSource: null, error: null, nodeName: null, durationMs: null, held: true } as any
  expect(taskStatusWord(held)).toBe("Waiting for your approval")
})

describe("highlightLine (script view colour)", () => {
  const kinds = (line: string, lang: "python" | "bash" | "js") =>
    highlightLine(line, lang).filter((t) => t.k).map((t) => `${t.k}:${t.t}`)

  test("the iris header is its own colour — it decides where the script runs", () => {
    expect(highlightLine("# iris: requires=bluetooth,python3", "python")).toEqual([{ t: "# iris: requires=bluetooth,python3", k: "dir" }])
  })

  test("python: keywords, calls, strings, numbers, trailing comment", () => {
    expect(kinds('def hop(n=2): print("up", 1)  # go', "python")).toEqual(["kw:def", "fn:hop", "num:2", "fn:print", 'str:"up"', "num:1", "com:# go"])
  })

  test("a # inside a string is not a comment", () => {
    expect(kinds('x = "a # b"', "python")).toEqual(['str:"a # b"'])
  })

  test("bash: variables and keywords; $# is a variable, not a comment", () => {
    expect(kinds('if [ $# -gt 0 ]; then echo "$HOME"; fi', "bash")).toEqual(["kw:if", "var:$#", "num:0", "kw:then", "kw:echo", 'str:"$HOME"', "kw:fi"])
  })

  test("the text is never changed, only wrapped", () => {
    const line = 'VENV = os.path.expanduser("~/.iris/venvs/mambo")'
    expect(highlightLine(line, "python").map((t) => t.t).join("")).toBe(line)
  })
})

describe("script settings (#189589)", () => {
  const h = parseHeader("#!/bin/sh\n# iris: arg=mode default=status choices=status|hop|spin\n# iris: arg=note\n# iris: arg=fixture required\necho\n")

  test("choices= makes a pick-list", () => {
    expect(h.args[0]).toMatchObject({ name: "mode", default: "status", choices: ["status", "hop", "spin"] })
    expect(h.args[1].choices).toBeUndefined()
  })

  test("a run sends picked values, else defaults; empty optional settings are left out", () => {
    expect(runArgs(h.args, { mode: "hop", fixture: "case-1" })).toEqual({ mode: "hop", fixture: "case-1" })
    expect(runArgs(h.args, { fixture: "x" })).toEqual({ mode: "status", fixture: "x" })
  })

  test("Run names the required settings that are still empty", () => {
    expect(missingRequired(h.args, {})).toEqual(["fixture"])
    expect(missingRequired(h.args, { fixture: "a" })).toEqual([])
  })
})

// #189589 — the card names a plugged-in webcam; the laptop's own camera is not news.
test("plugged names external cameras only", () => {
  const base = { id: "1", name: "mac", online: true, lastHeartbeat: null }
  expect(plugged({ ...base, cameras: ["FaceTime HD Camera", "OBSBOT Tiny Camera"] })).toEqual(["OBSBOT Tiny Camera"])
  expect(plugged({ ...base, cameras: ["FaceTime HD Camera"] })).toEqual([])
  expect(plugged({ ...base })).toEqual([])
})

// ── #191674: who can open a script, shared with me, where it runs, which version ────────────────
describe("sharing (#191674)", () => {
  const sharing = snap.sharing
  const boards = sharing.boards as Board[]
  const mine = (slug: string): ScriptRow => ({ ...scripts.find((s) => s.slug === slug)!, ...sharing.mine[slug] })
  const shared = sharing.shared as SharedScript[]

  test("the badge speaks the person's words, never the hub's", () => {
    expect(accessLabel(undefined, [], boards).short).toBe("Only me")
    expect(accessLabel("private", [7], boards).short).toBe("Only me")
    expect(accessLabel("project", [12], boards).short).toBe("My team: Mambo crew")
    expect(accessLabel(mine("nyc-budget").visibility, mine("nyc-budget").bloqIds, boards).short).toBe(
      "My team: Deals board, Mambo crew and 1 more",
    )
    expect(accessLabel("unlisted", [], boards).short).toBe("Anyone with the link")
    expect(accessLabel("public", [], boards)).toMatchObject({ short: "Public gallery", icon: "globe" })
    // nothing the hub calls it leaks into what a person reads
    for (const v of ["private", "project", "unlisted", "public", "PUBLIC", "nonsense"]) {
      const l = accessLabel(v, [7, 12], boards)
      expect(`${l.short} ${l.long}`).not.toMatch(/\bprivate\b|\bproject\b|unlisted|bloq|visibility|#\d/i)
    }
  })

  test("anything unrecognised is private — a typo never reads as public", () => {
    expect(readAccess("PUBLIC")).toBe("private")
    expect(readAccess(null)).toBe("private")
    expect(readAccess("public")).toBe("public")
  })

  test("a board I am not on is named as such, not by its number", () => {
    expect(boardNames([7, 99], boards)).toEqual(["Deals board", "a board you're not on"])
    expect(boardNames([12], undefined)).toEqual(["a board you're not on"])
  })

  test("Only me is one unpublish; already private is nothing", () => {
    expect(planAccess(mine("photo-resize"), { visibility: "private" })).toEqual({ steps: [{ action: "unpublish" }], confirm: false })
    expect(planAccess({ visibility: "private" }, { visibility: "private" })).toEqual({ steps: [], confirm: false })
  })

  test("My team needs a board, and is refused before any call without one", () => {
    expect(planAccess({ visibility: "private" }, { visibility: "project", bloqIds: [] })).toEqual({
      error: "Pick at least one board to share it with.",
    })
    expect(planAccess({ visibility: "private" }, { visibility: "project", bloqIds: [7] })).toEqual({
      steps: [{ action: "publish", visibility: "project", bloqIds: [7] }],
      confirm: false,
    })
  })

  test("changing a team's boards shares the new ones BEFORE unsharing the old — never private in between", () => {
    const plan = planAccess(mine("mambo-status"), { visibility: "project", bloqIds: [40] })
    expect(plan).toEqual({ steps: [{ action: "share", bloqId: 40 }, { action: "unshare", bloqId: 12 }], confirm: false })
    expect(planAccess(mine("nyc-budget"), { visibility: "project", bloqIds: [40, 12, 7] })).toEqual({ steps: [], confirm: false })
    expect(planAccess(mine("nyc-budget"), { visibility: "project", bloqIds: [7] })).toEqual({
      steps: [
        { action: "unshare", bloqId: 12 },
        { action: "unshare", bloqId: 40 },
      ],
      confirm: false,
    })
  })

  test("going public asks first; narrowing from public never does", () => {
    expect(planAccess({ visibility: "private" }, { visibility: "public" })).toEqual({
      steps: [{ action: "publish", visibility: "public" }],
      confirm: true,
    })
    expect(planAccess(mine("mambo-status"), { visibility: "public" })).toMatchObject({ confirm: true })
    expect(planAccess(mine("photo-resize"), { visibility: "public" })).toEqual({ steps: [], confirm: false })
    expect(planAccess(mine("photo-resize"), { visibility: "unlisted" })).toEqual({
      steps: [{ action: "publish", visibility: "unlisted" }],
      confirm: false,
    })
  })

  test("leaving a team for public moves it to the gallery and leaves it to the hub whether the boards stay", () => {
    expect(planAccess(mine("mambo-status"), { visibility: "unlisted" })).toEqual({
      steps: [{ action: "publish", visibility: "unlisted" }],
      confirm: false,
    })
    // from public to a team: the boards are published to, and none dropped
    expect(planAccess(mine("photo-resize"), { visibility: "project", bloqIds: [12] })).toEqual({
      steps: [{ action: "publish", visibility: "project", bloqIds: [12] }],
      confirm: false,
    })
  })

  test("the last board out of a team makes it private", () => {
    expect(unshareMakesPrivate(mine("mambo-status"), 12)).toBe(true)
    expect(unshareMakesPrivate(mine("nyc-budget"), 12)).toBe(false)
    expect(unshareMakesPrivate(mine("photo-resize"), 12)).toBe(false)
  })

  test("a link exists for 'anyone with the link' and the gallery, never for a team", () => {
    expect(shareLink("unlisted", "hello-fleet")).toBe("https://heyiris.io/api/v1/public/scripts/hello-fleet")
    expect(shareLink("public", "photo-resize")).toContain("/photo-resize")
    expect(shareLink("project", "nyc-budget")).toBeNull()
    expect(shareLink(undefined, "x")).toBeNull()
  })

  test("a shared script names the board it came through — only boards I am on", () => {
    expect(sharedVia(shared[0], boards)).toBe("Deals board")
    expect(sharedVia(shared[1], boards)).toBe("Mambo crew")
    expect(sharedVia({ bloqIds: [99] }, boards)).toBe("a board you're on")
  })

  test("runs-on a machine: nothing to pick; any or a capability still takes a pick", () => {
    expect(routing(mine("mambo-status").runsOn)).toEqual({ routed: true, node: "Alexs-MacBook-Pro-11711", label: "Runs on Alexs-MacBook-Pro-11711" })
    expect(routing(shared[1].runsOn)).toMatchObject({ routed: true, node: "studio-mac" })
    expect(routing(mine("photo-resize").runsOn)).toEqual({ routed: false })
    expect(routing(mine("hello-fleet").runsOn)).toEqual({ routed: false })
    expect(routing(undefined)).toEqual({ routed: false })
  })

  test("versions: latest first; latest runs as the plain name, an older one pins @N", () => {
    expect(versionChoices(4)).toEqual([4, 3, 2, 1])
    expect(versionChoices(1)).toEqual([1])
    expect(versionChoices(null)).toEqual([])
    expect(versionChoices(50).length).toBe(20)
    expect(runRef({ slug: "mambo-status" }, null, 4)).toBe("mambo-status")
    expect(runRef({ slug: "mambo-status" }, 4, 4)).toBe("mambo-status")
    expect(runRef({ slug: "mambo-status" }, 2, 4)).toBe("mambo-status@2")
    expect(versionWord(null, 4)).toBe("v4")
    expect(versionWord(2, 4)).toBe("v2 of 4")
  })

  test("a shared script always runs by its id — a slug names a script in ONE account", () => {
    const s = shared[0]
    expect(runRef({ slug: s.slug, id: s.id, shared: true }, null, s.version)).toBe(s.id)
    expect(runRef({ slug: s.slug, id: s.id, shared: true }, 3, s.version)).toBe(`${s.id}@3`)
  })
})
