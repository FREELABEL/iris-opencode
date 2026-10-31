import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listResources, readResource, recipeResources, type ResourceDeps } from "./mcp-resources"

/**
 * #191844 — a cloud agent followed a recipe's "see `drive-iris-from-claude-code.md`" and read
 * iris://playbook/drive-iris-from-claude-code: "Unknown playbook". The name is a how-to recipe,
 * and recipes were only offered as one 600 KB blob. Each recipe is now its own resource; the
 * rule held here is the one the ticket asked for — every advertised URI resolves.
 */

let dir: string
let deps: ResourceDeps

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-res-"))
  writeFileSync(join(dir, "drive-iris-from-claude-code.md"), "---\ncategory: x\n---\n# How to: Drive IRIS from Claude Code\n\nbody\n")
  writeFileSync(join(dir, "agentic-loops.md"), "# How to: Build an agentic loop\n\nsee `drive-iris-from-claude-code.md`\n")
  writeFileSync(join(dir, "notes.txt"), "not a recipe")
  deps = {
    howtoDir: dir,
    playbooksEnabled: true,
    guide: () => "guide",
    commands: () => "commands",
    recipes: async () => "all recipes",
    listPlaybooks: async () => [{ uri: "iris://playbook/atlas-epic", name: "Playbook: atlas-epic", mimeType: "text/markdown" }],
    readPlaybook: async (name) => {
      if (name !== "atlas-epic") throw new Error(`Unknown playbook: ${name}`)
      return "# atlas-epic"
    },
  }
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("MCP resource catalog", () => {
  test("every advertised URI is one the read serves", async () => {
    const listed = await listResources(deps)
    expect(listed.length).toBeGreaterThan(4)
    for (const r of listed) expect(typeof (await readResource(r.uri, deps))).toBe("string")
  })

  test("each recipe is advertised as its own resource, titled from its heading", () => {
    expect(recipeResources(dir)).toEqual([
      { uri: "iris://recipe/agentic-loops", name: "Recipe: agentic-loops", description: "Build an agentic loop", mimeType: "text/markdown" },
      {
        uri: "iris://recipe/drive-iris-from-claude-code",
        name: "Recipe: drive-iris-from-claude-code",
        description: "Drive IRIS from Claude Code",
        mimeType: "text/markdown",
      },
    ])
  })

  test("the recipe the ticket could not read is readable, with or without .md", async () => {
    expect(await readResource("iris://recipe/drive-iris-from-claude-code", deps)).toContain("Drive IRIS from Claude Code")
    expect(await readResource("iris://recipe/drive-iris-from-claude-code.md", deps)).toContain("body")
  })

  test("a recipe name tried as a playbook says which URI to read", async () => {
    await expect(readResource("iris://playbook/drive-iris-from-claude-code", deps)).rejects.toThrow(
      "read iris://recipe/drive-iris-from-claude-code",
    )
    await expect(readResource("iris://playbook/nope", deps)).rejects.toThrow("Unknown playbook: nope")
  })

  test("a recipe name cannot leave the how-to directory", async () => {
    await expect(readResource("iris://recipe/../../etc/passwd", deps)).rejects.toThrow("Unknown recipe")
  })

  test("--no-playbooks advertises no playbook URIs and serves none", async () => {
    const off = { ...deps, playbooksEnabled: false }
    expect((await listResources(off)).some((r) => r.uri.startsWith("iris://playbook/"))).toBe(false)
    await expect(readResource("iris://playbook/atlas-epic", off)).rejects.toThrow("Unknown resource")
  })
})
