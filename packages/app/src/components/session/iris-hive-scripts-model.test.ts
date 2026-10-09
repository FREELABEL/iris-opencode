import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
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
  parseCommand,
  parseHeader,
  setArgDefault,
  readiness,
  skillsOf,
  stageStates,
  taskStatusWord,
  topFix,
  type Doctor,
  type HiveNodeRow,
  type ScriptRow,
  type TaskView,
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
