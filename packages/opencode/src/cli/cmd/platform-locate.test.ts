import { describe, expect, test } from "bun:test"
import { FSEARCH_COMMIT, isThisMachine, nodePlatform, parseNodeAnswer, selectNodes, setupScript } from "./platform-locate"

const node = (name: string, extra: any = {}) => ({ id: `id-${name}`, name, status: "active", connection_status: "online", ...extra }) as any

describe("iris locate (#188665)", () => {
  test("one machine by name, id or prefix; offline machines are never asked", () => {
    const ns = [node("Alexs-MacBook-Pro-11711"), node("iris-hive-001"), node("old-box", { connection_status: "offline" })]
    expect(selectNodes(ns).map((n) => n.name)).toEqual(["Alexs-MacBook-Pro-11711", "iris-hive-001"])
    expect(selectNodes(ns, "alexs-macbook").map((n) => n.name)).toEqual(["Alexs-MacBook-Pro-11711"])
    expect(selectNodes(ns, "id-iris-hive-001").map((n) => n.name)).toEqual(["iris-hive-001"])
    expect(selectNodes(ns, "old-box")).toEqual([])
  })

  test("this machine is recognised by the hostname its node reported, with or without .local", () => {
    const mac = node("Alexs-MacBook-Pro-11711", { hardware_profile: { hostname: "Alexs-MacBook-Pro-11711.local", os: { platform: "darwin" } } })
    expect(isThisMachine(mac, "Alexs-MacBook-Pro-11711.local")).toBe(true)
    expect(isThisMachine(mac, "iris-hive-001")).toBe(false)
    expect(nodePlatform(mac)).toBe("darwin")
    expect(nodePlatform(node("x"))).toBeNull()
  })

  test("Linux setup installs plocate with sudo -n, and stops with the command to run when there is no admin", () => {
    const s = setupScript("linux")!
    expect(s).toContain("apt-get install -y -q plocate")
    expect(s).toContain("sudo -n updatedb")
    expect(s).toContain("NEEDS_ADMIN: this machine needs an administrator")
    // Every sudo the script RUNS is non-interactive; the only bare one is in the text shown to a person.
    const executed = s.split("\n").filter((l) => !/^\s*'?say|NEEDS_ADMIN/.test(l)).join("\n")
    expect(executed).not.toMatch(/\bsudo (?!-n)/)
  })

  test("Mac setup builds the audited fsearch commit in a temp dir, refuses on a full disk, and cleans up", () => {
    const s = setupScript("darwin")!
    expect(s).toContain(`checkout -q ${FSEARCH_COMMIT}`)
    expect(s).toContain("LOW_DISK")
    expect(s).toMatch(/trap 'rm -rf "\$W"' EXIT/)
    expect(s).toContain("--profile minimal")
  })

  test("Windows needs no setup — Windows Search is built in", () => {
    expect(setupScript("win32")).toBeNull()
  })

  test("a node's answer is JSON, or a sentence saying why not", () => {
    expect(parseNodeAnswer('noise\n[{"source":"files","match":"/a"}]')).toEqual({ json: [{ source: "files", match: "/a" }] })
    expect(parseNodeAnswer("")).toEqual({ error: "no answer" })
    expect("error" in parseNodeAnswer("{not json")).toBe(true)
  })
})

import { readNodeRows } from "./platform-locate"

describe("reading a machine's answer (#188665 patient-data guard)", () => {
  test("a withheld answer is a count and a sentence, never a fake file called '(names withheld)'", () => {
    const r = readNodeRows([{ source: "files", match: "(names withheld)", preview: "3 matches in files — names kept on this machine because it handles patient data.", count: 3, phi: true }])
    expect(r.hits).toEqual([])
    expect(r.withheld).toBe(3)
    expect(r.note).toContain("names kept on this machine")
  })
  test("diagnostic rows become the note; real rows are hits; other sources are ignored", () => {
    const r = readNodeRows([
      { source: "files", match: "(no file results)", preview: "no file index on this node" },
      { source: "imessage", match: "+1", preview: "hi" },
      { source: "files", match: "/a/b.pdf", preview: "plocate · whole disk · 9 ms", provider: "plocate" },
    ])
    expect(r.hits.map((h) => h.match)).toEqual(["/a/b.pdf"])
    expect(r.note).toBe("no file index on this node")
    expect(r.withheld).toBe(0)
  })
})
