import { describe, test, expect } from "bun:test"
import { RECIPE_TITLE_PREFIX, titleForRecipe, recipeNameFromTitle, diffRecipes } from "./howto-backup"

const L = (name: string, content: string) => ({ name, content })
const R = (itemId: number, name: string, content: string) => ({ itemId, name, content })

describe("title round-trip", () => {
  test("name -> title -> name", () => {
    expect(recipeNameFromTitle(titleForRecipe("drive-iris-from-claude-code"))).toBe("drive-iris-from-claude-code")
  })

  test("a title that is not a recipe returns null", () => {
    expect(recipeNameFromTitle("💰 THE MONEY MAP")).toBeNull()
  })

  test("the prefix is exact, not a substring match", () => {
    expect(recipeNameFromTitle(`x ${RECIPE_TITLE_PREFIX}foo`)).toBeNull()
  })

  test("names with dots and dashes survive", () => {
    expect(recipeNameFromTitle(titleForRecipe("v6.tools-and_things"))).toBe("v6.tools-and_things")
  })
})

describe("diffRecipes", () => {
  test("a recipe with no remote counterpart is created", () => {
    const d = diffRecipes([L("a", "one")], [])
    expect(d.toCreate.map((r) => r.name)).toEqual(["a"])
    expect(d.toUpdate).toEqual([])
  })

  test("identical content is unchanged — no pointless write", () => {
    const d = diffRecipes([L("a", "one")], [R(7, "a", "one")])
    expect(d.unchanged).toEqual(["a"])
    expect(d.toUpdate).toEqual([])
    expect(d.toCreate).toEqual([])
  })

  test("changed content updates the SAME item, never creates a duplicate", () => {
    const d = diffRecipes([L("a", "two")], [R(7, "a", "one")])
    expect(d.toUpdate).toEqual([{ local: L("a", "two"), itemId: 7 }])
    expect(d.toCreate).toEqual([])
  })

  // A recipe deleted locally must NOT be silently dropped from the backup — a backup that
  // mirrors deletions is not a backup. It is reported so a human decides.
  test("remote-only recipes are reported, never auto-deleted", () => {
    const d = diffRecipes([], [R(7, "gone", "x")])
    expect(d.remoteOnly.map((r) => r.name)).toEqual(["gone"])
  })

  test("trailing-whitespace-only difference is not a change", () => {
    const d = diffRecipes([L("a", "one\n")], [R(7, "a", "one")])
    expect(d.unchanged).toEqual(["a"])
  })

  test("mixed set is partitioned correctly and nothing is lost", () => {
    const d = diffRecipes(
      [L("keep", "same"), L("edit", "new"), L("fresh", "x")],
      [R(1, "keep", "same"), R(2, "edit", "old"), R(3, "orphan", "y")],
    )
    expect(d.unchanged).toEqual(["keep"])
    expect(d.toUpdate.map((u) => u.local.name)).toEqual(["edit"])
    expect(d.toCreate.map((c) => c.name)).toEqual(["fresh"])
    expect(d.remoteOnly.map((r) => r.name)).toEqual(["orphan"])
    expect(d.unchanged.length + d.toUpdate.length + d.toCreate.length).toBe(3)
  })

  test("empty on both sides is empty, not an error", () => {
    const d = diffRecipes([], [])
    expect(d.toCreate.length + d.toUpdate.length + d.unchanged.length + d.remoteOnly.length).toBe(0)
  })
})
