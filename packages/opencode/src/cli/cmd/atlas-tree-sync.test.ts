import { describe, expect, test } from "bun:test"
import { planPull, planPush, summarize, listDirName, boardDirName, pulledIdsFrom, slug, type LocalEntry } from "./atlas-tree-sync"
import { renderItemFile, parseItemFile, itemFilename } from "./atlas-item-sync"

const item = (id: number, title: string, content: string, updated = "2026-09-20T10:00:00.000Z") => ({
  id, title, content, updated_at: updated, status: "active",
})

const board = {
  id: 676,
  name: "IRIS Product Vision",
  lists: [
    { id: 2425, name: "Kinetics — The Clutch", items: [item(1, "The clutch", "no couple, no move\n"), item(2, "Returns", "video is the other half\n")] },
    { id: 2418, name: "Ideas", items: [item(3, "Actuators", "70% of the cost\n")] },
  ],
}

const pulledFiles = () => {
  const out: Record<string, ReturnType<typeof parseItemFile>> = {}
  for (const l of board.lists) for (const i of l.items) out[`${listDirName(l)}/${itemFilename(i)}`] = parseItemFile(renderItemFile(i))
  return out
}

const entry = (path: string, file: ReturnType<typeof parseItemFile>, listId: number | null): LocalEntry => ({ path, file, listId })

describe("the folder a board pulls into", () => {
  test("names are readable and keyed on ids, so nothing collides", () => {
    expect(boardDirName(board)).toBe("iris-product-vision-676")
    expect(listDirName(board.lists[0]!)).toBe("kinetics-the-clutch-2425")
    expect(slug("Ideas & Notes!!")).toBe("ideas-notes")
    expect(listDirName({ id: 9, name: null })).toBe("list-9")
  })

  test("a first pull writes every item once", () => {
    const steps = planPull({ board, local: {}, itemFilename })
    expect(steps.length).toBe(3)
    expect(steps.every((s) => s.action === "write")).toBe(true)
  })

  test("a second pull is quiet", () => {
    const steps = planPull({ board, local: pulledFiles(), itemFilename })
    expect(steps.every((s) => s.action === "identical")).toBe(true)
  })

  test("a file with local edits is refused, not overwritten", () => {
    const local = pulledFiles()
    const k = Object.keys(local)[0]!
    local[k]!.body = "edited on disk, never pushed\n"
    const steps = planPull({ board, local, itemFilename })
    expect(steps.find((s) => s.path === k)!.action).toBe("refuse-local-edits")
    expect(planPull({ board, local, force: true, itemFilename }).find((s) => s.path === k)!.action).toBe("write")
  })

  test("AN ITEM GONE FROM THE SERVER IS REPORTED, NEVER DELETED", () => {
    const local = pulledFiles()
    const shrunk = { ...board, lists: [{ ...board.lists[0]!, items: [board.lists[0]!.items[0]!] }, board.lists[1]!] }
    const steps = planPull({ board: shrunk, local, itemFilename })
    const orphan = steps.find((s) => s.action === "orphan-local")
    expect(orphan).toBeDefined()
    expect(orphan!.reason).toContain("left alone")
    // and nothing in a pull plan ever deletes
    expect(steps.some((s) => (s.action as string) === "delete")).toBe(false)
  })

  test("a new local file is not an orphan — it is waiting to be pushed", () => {
    const local = { ...pulledFiles(), "kinetics-the-clutch-2425/brand-new.md": { fm: { title: "New" }, body: "hi" } }
    const steps = planPull({ board, local, itemFilename })
    expect(steps.some((s) => s.path.endsWith("brand-new.md"))).toBe(false)
  })
})

describe("pushing a folder back", () => {
  const remoteById = Object.fromEntries(board.lists.flatMap((l) => l.items).map((i) => [String(i.id), i]))
  const titlesByList = { "2425": ["The clutch", "Returns"], "2418": ["Actuators"] }

  const entriesFrom = (files: Record<string, ReturnType<typeof parseItemFile>>): LocalEntry[] =>
    Object.entries(files).map(([p, f]) => entry(p, f, p.startsWith("kinetics") ? 2425 : 2418))

  test("unchanged files are skipped, and the plan says it is a no-op", () => {
    const steps = planPush({ entries: entriesFrom(pulledFiles()), remoteById, titlesByList })
    expect(steps.every((s) => s.action === "skip")).toBe(true)
    expect(summarize(steps).noop).toBe(true)
  })

  test("an edited file updates, and the reason names what changed", () => {
    const files = pulledFiles()
    const k = Object.keys(files)[0]!
    files[k]!.body = "no couple, no move. ever.\n"
    const steps = planPush({ entries: entriesFrom(files), remoteById, titlesByList })
    const s = steps.find((x) => x.path === k)!
    expect(s.action).toBe("update")
    expect(s.reason).toContain("content")
  })

  test("a server that moved since the pull is REFUSED, and --force goes through", () => {
    const files = pulledFiles()
    const k = Object.keys(files)[0]!
    files[k]!.body = "local change\n"
    const moved = { ...remoteById, "1": { ...remoteById["1"]!, updated_at: "2026-09-21T00:00:00.000Z" } }
    expect(planPush({ entries: entriesFrom(files), remoteById: moved, titlesByList }).find((x) => x.path === k)!.action).toBe("refuse-diverged")
    expect(planPush({ entries: entriesFrom(files), remoteById: moved, titlesByList, force: true }).find((x) => x.path === k)!.action).toBe("update")
  })

  test("a file with no id creates an item in its list", () => {
    const e = [entry("ideas-2418/fresh.md", { fm: { title: "Fresh thought" }, body: "new\n" }, 2418)]
    const steps = planPush({ entries: e, remoteById, titlesByList })
    expect(steps[0]!.action).toBe("create")
    expect(steps[0]!.listId).toBe(2418)
  })

  test("but not a SECOND item with a title the list already has", () => {
    const e = [entry("ideas-2418/dupe.md", { fm: { title: "Actuators" }, body: "again\n" }, 2418)]
    expect(planPush({ entries: e, remoteById, titlesByList })[0]!.action).toBe("refuse-duplicate")
    expect(planPush({ entries: e, remoteById, titlesByList, allowDuplicate: true })[0]!.action).toBe("create")
  })

  test("a stray file outside any list folder is refused, not guessed into a list", () => {
    const e = [entry("notes.md", { fm: { title: "Stray" }, body: "x" }, null)]
    expect(planPush({ entries: e, remoteById, titlesByList })[0]!.action).toBe("refuse-no-list")
  })

  test("a file whose item was deleted upstream is refused, not recreated silently", () => {
    const files = pulledFiles()
    const k = Object.keys(files)[0]!
    files[k]!.body = "changed\n"
    const without = { ...remoteById }
    delete (without as Record<string, unknown>)["1"]
    expect(planPush({ entries: entriesFrom(files), remoteById: without, titlesByList }).find((x) => x.path === k)!.action).toBe("refuse-no-list")
  })
})

describe("ABSENCE IS NOT DELETION", () => {
  const remoteById = Object.fromEntries(board.lists.flatMap((l) => l.items).map((i) => [String(i.id), i]))
  const titlesByList = { "2425": ["The clutch", "Returns"], "2418": ["Actuators"] }

  test("a removed file deletes NOTHING without --prune", () => {
    const files = pulledFiles()
    const pulledIds = pulledIdsFrom(Object.entries(files).map(([p, f]) => entry(p, f, 2425)))
    const keys = Object.keys(files)
    delete files[keys[0]!]
    const entries = Object.entries(files).map(([p, f]) => entry(p, f, p.startsWith("kinetics") ? 2425 : 2418))
    const steps = planPush({ entries, remoteById, titlesByList, pulledIds })
    expect(steps.some((s) => s.action === "delete")).toBe(false)
  })

  test("--prune deletes ONLY an item this folder pulled and whose file is now gone", () => {
    const files = pulledFiles()
    const pulledIds = pulledIdsFrom(Object.entries(files).map(([p, f]) => entry(p, f, 2425)))
    const keys = Object.keys(files)
    delete files[keys[0]!]
    const entries = Object.entries(files).map(([p, f]) => entry(p, f, p.startsWith("kinetics") ? 2425 : 2418))
    const steps = planPush({ entries, remoteById, titlesByList, prune: true, pulledIds })
    const dels = steps.filter((s) => s.action === "delete")
    expect(dels.length).toBe(1)
    expect(String(dels[0]!.itemId)).toBe("1")
  })

  test("--prune never touches an item the folder never pulled", () => {
    // item 3 lives on the server and was never part of this folder
    const files = pulledFiles()
    const onlyList = Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith("kinetics")))
    const entries = Object.entries(onlyList).map(([p, f]) => entry(p, f, 2425))
    const steps = planPush({ entries, remoteById, titlesByList, prune: true, pulledIds: pulledIdsFrom(entries) })
    expect(steps.some((s) => s.action === "delete")).toBe(false)
  })

  test("--prune does not plan a delete for an item that is ALREADY gone", () => {
    // the file was removed AND the item no longer exists upstream: nothing to do, and planning a
    // delete would report work that cannot happen
    const steps = planPush({ entries: [], remoteById: {}, titlesByList: {}, prune: true, pulledIds: [1, 2, 3] })
    expect(steps.some((s) => s.action === "delete")).toBe(false)
  })

  test("a file that was never pulled is not an orphan on the next pull", () => {
    // pinned because the guard is one line: without it, every new file a person adds to the folder
    // is reported as 'gone from the server' the moment they pull again
    const local = { "kinetics-the-clutch-2425/draft.md": { fm: { title: "Draft" }, body: "not pushed yet" } }
    const steps = planPull({ board, local, itemFilename })
    expect(steps.some((s) => s.action === "orphan-local")).toBe(false)
  })

  test("the summary counts what a person is about to approve", () => {
    const s = summarize([
      { path: "a", itemId: 1, listId: 1, action: "update", reason: "" },
      { path: "b", itemId: null, listId: 1, action: "create", reason: "" },
      { path: "c", itemId: 2, listId: 1, action: "skip", reason: "" },
      { path: "d", itemId: 3, listId: 1, action: "refuse-diverged", reason: "" },
      { path: "e", itemId: 4, listId: 1, action: "delete", reason: "" },
    ])
    expect(s).toEqual({ update: 1, create: 1, skip: 1, delete: 1, refused: 1, noop: false })
  })
})
