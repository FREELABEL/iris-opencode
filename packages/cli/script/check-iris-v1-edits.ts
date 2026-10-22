#!/usr/bin/env bun
// [IRIS] Refuse an edit to the vendored v1 platform layer that the next release would throw away (#190589).
//
// WHY THIS EXISTS. Every iris2 release runs script/sync-iris-v1.ts, which replaces src/iris-v1 with a
// fresh copy of main. An edit made here on iris2/channel merges green and is gone at the next release.
// On 2026-10-22 three features were lost that way before anyone noticed: `iris hive tasks rerun`
// (#283), `iris integrations rotate` (#284) and playbook install for Cursor/Codex/Gemini (#190526).
//
// The rule: a file the sync overwrites may change here only to what main already has (a sync commit,
// or a change mirrored after it landed on main). Anything else is refused, naming the main file.
//
//   bun script/check-iris-v1-edits.ts --base=origin/iris2/channel --main=origin/main
import { $ } from "bun"
import path from "node:path"

const V1 = "packages/cli/src/iris-v1/"

/**
 * The file on main that the sync copies over `repoPath`, or null when the sync leaves it alone.
 * "patched" marks index.ts, which is main's index.ts with the v2-owned commands removed — it can
 * only be compared after that patch, so any edit to it is refused.
 */
export function mainSourceFor(repoPath: string): string | "patched" | null {
  // The two extra copies of the capability index the sync writes from iris-v1's.
  if (repoPath === "packages/cli/capabilities.json" || repoPath === "packages/cli/src/capabilities.json")
    return "packages/opencode/capabilities.json"
  if (!repoPath.startsWith(V1)) return null
  const rel = repoPath.slice(V1.length)
  if (rel === "SYNCED_FROM") return null
  if (rel === "index.ts") return "patched"
  if (rel === "capabilities.json") return "packages/opencode/capabilities.json"
  if (rel.startsWith("vendor/")) {
    const v = rel.slice("vendor/".length)
    if (v.startsWith("js/src/")) return "packages/sdk/js/src/" + v.slice("js/src/".length)
    if (v.startsWith("pulse-core/")) return "packages/pulse-core/src/" + v.slice("pulse-core/".length)
    if (!v.includes("/") && v.endsWith(".ts")) return "packages/util/src/" + v
    return null // vendor/js/package.json, tsconfig, … are kept as they are
  }
  return "packages/opencode/src/" + rel
}

export type Lost = { file: string; mainFile: string; why: string }

/**
 * Which of `changed` would the next sync undo. A file is safe when it equals its source on any of
 * `mainRefs` — main now, and for a sync PR the main commit it synced from (SYNCED_FROM), since main
 * may have moved on before CI runs. `syncing` lets the regenerated index.ts through: only a sync
 * writes it. `read(ref, path)` returns null for a missing file.
 */
export async function lostEdits(
  changed: string[],
  head: string,
  mainRefs: string[],
  read: (ref: string, file: string) => Promise<string | null>,
  syncing = false,
): Promise<Lost[]> {
  const lost: Lost[] = []
  for (const file of changed) {
    const source = mainSourceFor(file)
    if (source === null) continue
    if (source === "patched") {
      if (!syncing)
        lost.push({ file, mainFile: "packages/opencode/src/index.ts", why: "regenerated from main's index.ts at every release" })
      continue
    }
    const ours = await read(head, file)
    const theirs = await Promise.all(mainRefs.map((ref) => read(ref, source)))
    if (theirs.some((t) => t === ours)) continue
    lost.push({
      file,
      mainFile: source,
      why: ours === null ? "deleted here, but main still has it — the release puts it back" : "differs from main — the release replaces it with main's",
    })
  }
  return lost
}

if (import.meta.main) {
  const arg = (name: string, fallback: string) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
  const base = arg("base", "origin/iris2/channel")
  const main = arg("main", "origin/main")
  const head = arg("head", "HEAD")
  const root = (await $`git rev-parse --show-toplevel`.text()).trim()

  const all = (await $`git -C ${root} diff --name-only ${base}...${head}`.text()).split("\n").filter(Boolean)
  const changed = all.filter((f) => mainSourceFor(f) !== null)
  const read = async (ref: string, file: string) => {
    const r = await $`git -C ${root} show ${ref}:${file}`.nothrow().quiet()
    return r.exitCode === 0 ? r.stdout.toString() : null
  }

  // A sync PR rewrites SYNCED_FROM with the main commit it copied; judge it against that commit.
  const syncing = all.includes(V1 + "SYNCED_FROM")
  const syncedFrom = syncing ? (await read(head, V1 + "SYNCED_FROM"))?.split("\n")[0]?.trim() : undefined
  if (syncedFrom) await $`git -C ${root} fetch --no-tags -q origin ${syncedFrom}`.nothrow().quiet()
  const mainRefs = syncedFrom ? [main, syncedFrom] : [main]

  const lost = await lostEdits(changed, head, mainRefs, read, syncing)
  if (!lost.length) {
    console.log(`check-iris-v1-edits: ${changed.length} vendored file(s) changed, all identical to ${mainRefs.join(" or ")}`)
    process.exit(0)
  }
  console.error(`check-iris-v1-edits: ${lost.length} change(s) here would be thrown away by the next release.`)
  console.error(`src/iris-v1 is a copy of main, replaced at every release (script/sync-iris-v1.ts).`)
  console.error(`Make the change on main instead, then sync:\n`)
  for (const l of lost) console.error(`  ${path.relative("packages/cli", l.file)}\n    → edit ${l.mainFile} on main (${l.why})`)
  process.exit(1)
}
