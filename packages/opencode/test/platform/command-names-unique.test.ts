import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// #191225 — `install-app` declared the alias "desktop" while `iris desktop` was its own command.
// yargs resolves a clash by registration order and reg() silently overwrites, so which one ran
// depended on the build: on CLI 1.5.3 `iris desktop sessions` printed the installer's help.
// Every top-level name and alias must belong to exactly one command.

const SRC = join(import.meta.dir, "../../src")

/** identifier -> module path, for every `import { A, B } from "./cli/cmd/x"` in index.ts */
function importsOf(source: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\.\/cli\/cmd\/[^"]+)"/g)) {
    for (const part of m[1].split(",")) {
      const [orig, local] = part.trim().split(/\s+as\s+/)
      if (orig) out.set((local ?? orig).trim(), m[2])
    }
  }
  return out
}

describe("top-level command names", () => {
  test("no two registered commands share a name or alias", async () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8")
    const imports = importsOf(index)
    const registered = [...index.matchAll(/\.command\(reg\((\w+)\)\)/g)].map((m) => m[1])
    expect(registered.length).toBeGreaterThan(50) // the scan found the registrations at all

    const owner = new Map<string, string>()
    const clashes: string[] = []
    const unloadable: string[] = []
    let checked = 0
    for (const id of registered) {
      const from = imports.get(id)
      if (!from) continue // defined inline in index.ts
      let mod: any
      try {
        mod = (await import(join(SRC, from)))[id]
      } catch {
        unloadable.push(id) // a TUI module needs the app's JSX runtime; it cannot load in a test
        continue
      }
      if (!mod?.command) continue
      checked++
      const name = String(Array.isArray(mod.command) ? mod.command[0] : mod.command).split(" ")[0]
      const aliases: string[] = Array.isArray(mod.aliases) ? mod.aliases : mod.aliases ? [mod.aliases] : []
      for (const word of [name, ...aliases].filter((w) => w && w !== "$0" && w !== "*")) {
        const prev = owner.get(word)
        if (prev && prev !== id) clashes.push(`"${word}": ${prev} and ${id}`)
        else owner.set(word, id)
      }
    }
    // A scan that silently loaded nothing would pass; most commands must actually be checked.
    expect(checked).toBeGreaterThan(registered.length * 0.9)
    expect(unloadable.length).toBeLessThan(10)
    expect(clashes).toEqual([])
  })
})
