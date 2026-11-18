import { describe, expect, test } from "bun:test"
import { directoryHint } from "../../src/tool/glob"

// #191073: the agent globbed **/.git, got nothing a repository could produce, and kept widening
// the search until it was walking the whole disk. Glob now says what it can and cannot match.
describe("directoryHint", () => {
  test(".git points at the pattern that actually finds repositories", () => {
    expect(directoryHint("**/.git", 0)).toContain("**/.git/HEAD")
    // Even with matches: those are worktree .git FILES, and every real repository is missing.
    expect(directoryHint("**/.git", 9)).toContain("**/.git/HEAD")
    expect(directoryHint(".git/", 0)).toContain("**/.git/HEAD")
  })

  test("a bare directory name gets told how to list inside it", () => {
    expect(directoryHint("**/node_modules", 0)).toContain("**/node_modules/*")
    expect(directoryHint("src/components", 0)).toContain("src/components/*")
  })

  test("ordinary file patterns get no hint", () => {
    expect(directoryHint("**/*.ts", 0)).toBeUndefined()
    expect(directoryHint("src/**", 0)).toBeUndefined()
    // Dot-less FILE names that matched are files: no hint.
    expect(directoryHint("**/.git/HEAD", 3)).toBeUndefined()
    expect(directoryHint("**/Makefile", 1)).toBeUndefined()
    expect(directoryHint("**/package.json", 4)).toBeUndefined()
  })
})
