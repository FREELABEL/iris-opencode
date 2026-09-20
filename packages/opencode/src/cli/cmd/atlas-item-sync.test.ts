import { describe, expect, test } from "bun:test"
import { renderItemFile, parseItemFile, pullDecision, diffItem, verifyPush, contentSha, normalizeBody, itemFilename, divergenceRefusal } from "./atlas-item-sync"

const remote = {
  id: 186315,
  title: "EPIC — the clutch",
  content: "# The clutch\n\nNo couple, no move.\n",
  status: "active",
  updated_at: "2026-09-20T10:00:00.000Z",
  public_url: "https://heyiris.io/i/abc",
  list_name: "Kinetics",
}

const pulled = () => parseItemFile(renderItemFile(remote))

describe("a pulled file is one `publish` already knows how to push", () => {
  test("it carries the keys push keys on, not a parallel format", () => {
    const f = pulled()
    expect(f.fm.iris_item_id).toBe(186315)
    // the marker push compares the server's updated_at against (#154763)
    expect(f.fm.atlas_published_at).toBe("2026-09-20T10:00:00.000Z")
    expect(f.fm.title).toBe("EPIC — the clutch")
    expect(f.body.trim()).toBe("# The clutch\n\nNo couple, no move.")
  })

  test("a round trip through the file changes nothing", () => {
    const f = pulled()
    expect(normalizeBody(f.body)).toBe(normalizeBody(remote.content))
    expect(diffItem(f, remote).changed).toEqual([])
  })

  test("the filename is readable and keyed on the id, so two items cannot collide", () => {
    expect(itemFilename(remote)).toBe("epic-the-clutch-186315.md")
    expect(itemFilename({ id: 7, title: "EPIC — the clutch" })).toBe("epic-the-clutch-7.md")
    expect(itemFilename({ id: 9, title: null })).toBe("item-9.md")
  })
})

describe("pull must not eat work that was never pushed", () => {
  test("a fresh file is written", () => {
    expect(pullDecision({ local: null, remote }).action).toBe("write")
  })

  test("re-pulling an unchanged file is quiet, not busy", () => {
    expect(pullDecision({ local: pulled(), remote }).action).toBe("identical")
  })

  test("LOCAL EDITS ARE REFUSED — this is the whole point", () => {
    const f = pulled()
    f.body = "# The clutch\n\nNo couple, no move.\n\nMy unpushed paragraph.\n"
    const d = pullDecision({ local: f, remote })
    expect(d.action).toBe("refuse-local-edits")
    expect(d.reason).toContain("push them first")
    // and --force is the deliberate way to lose them
    expect(pullDecision({ local: f, remote, force: true }).action).toBe("write")
  })

  test("a file we did not produce is not overwritten on a guess", () => {
    const hand = { fm: { title: "something" }, body: "hand written" }
    expect(pullDecision({ local: hand, remote }).action).toBe("refuse-local-edits")
    expect(pullDecision({ local: hand, remote }).reason).toContain("not produced by a pull")
    expect(pullDecision({ local: hand, remote, force: true }).action).toBe("write")
  })

  test("server-side changes overwrite a clean file", () => {
    const f = pulled()
    const moved = { ...remote, content: "# The clutch\n\nRewritten upstream.\n", updated_at: "2026-09-20T12:00:00.000Z" }
    expect(pullDecision({ local: f, remote: moved }).action).toBe("write")
  })

  test("an item that does not exist is refused, never written as an empty file", () => {
    expect(pullDecision({ local: null, remote: null }).action).toBe("refuse-no-item")
    expect(pullDecision({ local: null, remote: { id: undefined as unknown as number } }).action).toBe("refuse-no-item")
  })

  test("whitespace is not an edit", () => {
    const f = pulled()
    f.body = f.body.replace(/\n/g, "\r\n") + "   \n\n"
    expect(pullDecision({ local: f, remote }).action).toBe("identical")
  })
})

describe("diff reads local → server, and flags the thing push refuses on", () => {
  test("it names every field that differs", () => {
    const f = pulled()
    f.fm.title = "EPIC — the clutch, revised"
    f.fm.status = "done"
    f.body = "# The clutch\n\nNo couple, no move. Ever.\n"
    const d = diffItem(f, remote)
    expect(d.changed.sort()).toEqual(["content", "status", "title"])
    expect(d.lines.some((l) => l.startsWith("+ title:"))).toBe(true)
    expect(d.lines.some((l) => l.startsWith("- "))).toBe(true)
  })

  test("it says when the SERVER moved since the pull — the divergence push stops on", () => {
    const f = pulled()
    expect(diffItem(f, remote).serverMovedSincePull).toBe(false)
    expect(diffItem(f, { ...remote, updated_at: "2026-09-20T18:00:00.000Z" }).serverMovedSincePull).toBe(true)
    // an unparseable or missing marker is NOT reported as movement — it is unknown, not false
    expect(diffItem({ fm: {}, body: "x" }, remote).serverMovedSincePull).toBe(false)
  })

  test("an absent local status is not a change to status", () => {
    const f = parseItemFile(renderItemFile({ ...remote, status: null }))
    expect(diffItem(f, remote).changed).not.toContain("status")
  })

  test("a long diff is truncated rather than printing a whole document", () => {
    const f = pulled()
    f.body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")
    const d = diffItem(f, remote)
    expect(d.lines.length).toBeLessThan(90)
    expect(d.lines[d.lines.length - 1]).toContain("more")
  })
})

describe("a push is not done because the server said 2xx", () => {
  test("the read-back has to match what was sent", () => {
    expect(verifyPush({ title: "T", body: "hello\n" }, { id: 1, title: "T", content: "hello" }).ok).toBe(true)
    expect(verifyPush({ title: "T", body: "hello" }, { id: 1, title: "T", content: "something else" }).ok).toBe(false)
    expect(verifyPush({ title: "T", body: "hello" }, { id: 1, title: "OTHER", content: "hello" }).ok).toBe(false)
    expect(verifyPush({ body: "hello" }, null as never).ok).toBe(false)
  })

  test("content equality ignores line endings, not words", () => {
    expect(verifyPush({ body: "a\r\nb" }, { id: 1, content: "a\nb" }).ok).toBe(true)
    expect(verifyPush({ body: "a\nb" }, { id: 1, content: "a\nB" }).ok).toBe(false)
  })

  test("the sha changes when the text does", () => {
    expect(contentSha("a")).toBe(contentSha("a"))
    expect(contentSha("a")).not.toBe(contentSha("b"))
  })
})

describe("push must not overwrite a change it never saw (#154763, and how it failed open)", () => {
  const marker = "2026-09-20T10:00:00.000Z"

  test("a server newer than the marker is refused, and the message says both times", () => {
    const r = divergenceRefusal({ itemId: 1, markerIso: marker, serverIso: "2026-09-20T11:00:00.000Z" })
    expect(r).toContain("was modified after your last publish")
    expect(r).toContain("2026-09-20T11:00:00.000Z")
    expect(r).toContain("--force")
  })

  test("equal timestamps are OUR OWN write, not someone else's", () => {
    expect(divergenceRefusal({ itemId: 1, markerIso: marker, serverIso: marker })).toBeNull()
    expect(divergenceRefusal({ itemId: 1, markerIso: marker, serverIso: "2026-09-20T09:00:00.000Z" })).toBeNull()
  })

  test("--force is the deliberate way through", () => {
    expect(divergenceRefusal({ itemId: 1, markerIso: marker, serverIso: "2026-09-21T00:00:00.000Z", force: true })).toBeNull()
  })

  test("what cannot be judged proceeds, and is not dressed up as safe", () => {
    // no marker: a legacy or hand-written file. Refusing every one of those would block real work.
    expect(divergenceRefusal({ itemId: 1, markerIso: null, serverIso: "2026-09-21T00:00:00.000Z" })).toBeNull()
    // unreadable dates on either side: unknown, so it proceeds — but it is NOT a comparison that passed
    expect(divergenceRefusal({ itemId: 1, markerIso: "whenever", serverIso: "2026-09-21T00:00:00.000Z" })).toBeNull()
    expect(divergenceRefusal({ itemId: 1, markerIso: marker, serverIso: null })).toBeNull()
  })

  test("THE BUG: the decision does not take a bloq id, because it never needed one", () => {
    // The inline version was guarded by `fm.atlas_published_at && guardBloqId && !force`, so a
    // pulled file — which has no iris_bloq_id — skipped the check entirely and clobbered the
    // server. Measured 2026-09-20. The signature is the fix: there is nothing to forget to pass.
    const args = { itemId: 186364, markerIso: marker, serverIso: "2026-09-20T11:00:00.000Z" }
    expect(divergenceRefusal(args)).not.toBeNull()
    expect(Object.keys(args)).not.toContain("bloqId")
  })
})
