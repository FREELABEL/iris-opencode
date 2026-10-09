import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { allPlaybooks, playbookRows, type AllViewRow } from "../../src/iris/playbook-local"

/**
 * The Playbooks panel's All tab: every playbook this person can run — this project's, the ones
 * installed on this machine, and the ones their account owns — one row per name, each saying
 * where it comes from. NOT the public catalogue: that is the Marketplace tab.
 */

const BOARD = 174

type Row = AllViewRow
const row = (name: string, over: Partial<Row> = {}): Row => ({
  name,
  attached: false,
  steps: [],
  args: [],
  hasLocal: false,
  owned: false,
  ...over,
})

const root = mkdtempSync(path.join(tmpdir(), "pb-all-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
/** A fresh home + project per test, so one test's files never answer another's question. */
function machine() {
  const dir = path.join(root, String(n++))
  const home = path.join(dir, "home")
  const project = path.join(dir, "project")
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const put = (file: string, body = "# doc\n") => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  return {
    roots: { home, project },
    home: (name: string, body?: string) => put(path.join(home, ".iris", "playbooks", name, "PLAYBOOK.md"), body),
    project: (name: string, body?: string) => put(path.join(project, ".iris", "playbooks", name, "PLAYBOOK.md"), body),
    skill: (name: string) => put(path.join(project, ".claude", "skills", name, "SKILL.md")),
  }
}

const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort()
const sourcesOf = (rows: { name: string; sources?: string[] }[], name: string) =>
  rows.find((r) => r.name === name)?.sources

describe("All is the union of what this person can run", () => {
  test("this project's, this machine's and this account's — and not the rest of the catalogue", () => {
    const m = machine()
    m.home("installed-from-catalogue")
    const platform = [
      row("attached-here", { attached: true }),
      row("filed-against-board", { bloqId: BOARD }),
      row("mine-private", { owned: true, scope: "private" }),
      row("installed-from-catalogue", { scope: "public", ownerUserId: 9 } as any),
      row("someone-elses-public", { scope: "public" }),
      row("other-board", { bloqId: 999, owned: false }),
    ]
    const all = allPlaybooks(platform, { bloqId: BOARD, roots: m.roots })
    expect(names(all)).toEqual(
      ["attached-here", "filed-against-board", "installed-from-catalogue", "mine-private"].sort(),
    )
    // The catalogue stays in Marketplace — All is not Marketplace with extras.
    expect(names(all)).not.toContain("someone-elses-public")
    expect(names(all)).not.toContain("other-board")
  })

  test("a playbook that exists only on disk is listed, as yours, with its description", () => {
    const m = machine()
    m.home("home-only", "---\nname: home-only\ndescription: \"Written here, never published\"\n---\n# x\n")
    m.project("project-only")
    const all = allPlaybooks<Row>([], { bloqId: BOARD, roots: m.roots })
    expect(names(all)).toEqual(["home-only", "project-only"])
    const home = all.find((r) => r.name === "home-only")!
    expect(home.sources).toEqual(["installed"])
    expect(home.owned).toBe(true)
    expect(home.description).toBe("Written here, never published")
    expect(sourcesOf(all, "project-only")).toEqual(["project"])
  })

  test("a synced skill counts as this project's only when a platform playbook has its name", () => {
    const m = machine()
    m.skill("synced-playbook")
    m.skill("plain-claude-skill")
    const all = allPlaybooks([row("synced-playbook", { scope: "public" })], { bloqId: BOARD, roots: m.roots })
    expect(names(all)).toEqual(["synced-playbook"])
    expect(sourcesOf(all, "synced-playbook")).toEqual(["project", "marketplace"])
  })
})

describe("All has one row per name, and keeps every source", () => {
  test("the same playbook in project, home, account and catalogue is ONE row naming all four", () => {
    const m = machine()
    m.home("everywhere")
    m.project("everywhere")
    const all = allPlaybooks([row("everywhere", { attached: true, owned: true, scope: "public" })], {
      bloqId: BOARD,
      roots: m.roots,
    })
    expect(all.filter((r) => r.name === "everywhere")).toHaveLength(1)
    expect(sourcesOf(all, "everywhere")).toEqual(["project", "installed", "account", "marketplace"])
  })

  test("a name the platform lists twice is still one row, with both rows' sources", () => {
    const m = machine()
    const all = allPlaybooks(
      [row("dup", { attached: true }), row("dup", { owned: true, scope: "public" })],
      { bloqId: BOARD, roots: m.roots },
    )
    expect(all.filter((r) => r.name === "dup")).toHaveLength(1)
    expect(sourcesOf(all, "dup")).toEqual(["project", "account", "marketplace"])
    // The first row wins — the platform puts the board's copy first.
    expect(all[0].attached).toBe(true)
  })

  test("a local-only playbook in both project and home is one row with both sources", () => {
    const m = machine()
    m.project("local-twice")
    m.home("local-twice")
    const all = allPlaybooks<Row>([], { bloqId: BOARD, roots: m.roots })
    expect(all).toHaveLength(1)
    expect(all[0].sources).toEqual(["project", "installed"])
  })

  test("yours first, then other accounts' — the order the panel draws its owner heading on", () => {
    const m = machine()
    m.home("zz-mine-local")
    const all = allPlaybooks(
      [row("aa-theirs-attached", { attached: true, owned: false }), row("mm-mine", { owned: true })],
      { bloqId: BOARD, roots: m.roots },
    )
    expect(all.map((r) => r.owned)).toEqual([true, true, false])
    expect(all.at(-1)!.name).toBe("aa-theirs-attached")
  })
})

describe("the route's list step (playbookRows)", () => {
  const platform = () => [
    row("capture-sops", { owned: true, description: "Turn a recording into an SOP" }),
    row("restaurant-booking-cancel", { attached: true, steps: [{ title: "Find the reservation" }] }),
    row("catalogue-only", { scope: "public", description: "SOP gallery" }),
  ]

  test("view=all is the union; search narrows it by name, description or step", () => {
    const m = machine()
    m.home("local-sop-helper", "---\ndescription: drafts an SOP\n---\n")
    const all = playbookRows(platform(), { view: "all", bloqId: BOARD, roots: m.roots })
    expect(names(all)).toEqual(["capture-sops", "local-sop-helper", "restaurant-booking-cancel"])

    const sop = playbookRows(platform(), { view: "all", bloqId: BOARD, q: "sop", roots: m.roots })
    // The catalogue's "SOP gallery" matches the words but is not in All — search cannot add rows.
    expect(names(sop)).toEqual(["capture-sops", "local-sop-helper"])
    expect(names(playbookRows(platform(), { view: "all", bloqId: BOARD, q: "reservation", roots: m.roots }))).toEqual([
      "restaurant-booking-cancel",
    ])
    expect(playbookRows(platform(), { view: "all", bloqId: BOARD, q: "nothing-like-this", roots: m.roots })).toEqual([])
  })

  test("other views are untouched — no union, no sources", () => {
    const m = machine()
    m.home("local-only")
    for (const view of [undefined, "project", "marketplace"]) {
      const rows = playbookRows(platform(), { view, bloqId: BOARD, roots: m.roots })
      expect(names(rows)).toEqual(names(platform()))
      expect(rows.every((r) => r.sources === undefined)).toBe(true)
    }
  })

  test("empty All: nothing owned, attached or installed — and a catalogue full of others' work", () => {
    const m = machine()
    const rows = playbookRows([row("public-a", { scope: "public" }), row("public-b", { scope: "unlisted" })], {
      view: "all",
      bloqId: BOARD,
      roots: m.roots,
    })
    expect(rows).toEqual([])
  })
})
