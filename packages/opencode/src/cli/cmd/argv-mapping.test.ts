import { describe, test, expect } from "bun:test"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"

/**
 * Every registered CLI option must be READ by its handler.
 *
 * This exists because `--thread` and `--fresh` shipped inert: both were declared in the
 * builder, both appeared in `--help`, and the handler mapped argv field by field and simply
 * did not forward them. Nothing failed. The flags were accepted and silently discarded — the
 * same shape as `traces --source`, `packages set/push`, and the rest of the sprint.
 *
 * A convention ("remember to add it to the mapping") is what produced the bug. This is the
 * structural version.
 */

const CMD_DIR = join(import.meta.dir)

/**
 * Brace-match every `cmd({ ... })` block, SKIPPING strings, template literals and comments.
 *
 * A naive counter ends the block at the first `}` inside a string — which truncates the
 * handler and makes options look unread that are read a few lines later. That produced 62
 * false positives here, and it is the same defect that silently unindexed `mcp serve` from
 * the capability index: a brace matcher that cannot see quotes.
 */
function blocks(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/cmd\(\s*\{/g)) {
    const start = m.index! + m[0].length - 1
    let depth = 0
    let i = start
    while (i < src.length) {
      const c = src[i]
      const next = src[i + 1]

      if (c === "/" && next === "/") {
        i = src.indexOf("\n", i)
        if (i < 0) break
        continue
      }
      if (c === "/" && next === "*") {
        const end = src.indexOf("*/", i + 2)
        i = end < 0 ? src.length : end + 2
        continue
      }
      if (c === '"' || c === "'" || c === "`") {
        const quote = c
        i++
        while (i < src.length) {
          if (src[i] === "\\") { i += 2; continue }
          if (src[i] === quote) { i++; break }
          i++
        }
        continue
      }

      if (c === "{") depth++
      else if (c === "}") {
        depth--
        if (depth === 0) { out.push(src.slice(start, i + 1)); break }
      }
      i++
    }
  }
  return out
}

export function findUnreadOptions(src: string): Array<{ command: string; option: string }> {
  const out: Array<{ command: string; option: string }> = []
  for (const b of blocks(src)) {
    const cm = b.match(/command:\s*"([^"]+)"/)
    // The handler's PARAMETER NAME is not always `args` — mcp-serve calls it `argv`.
    // Assuming `args` reported five false violations there before this was read properly.
    const hm = b.match(/(?:async\s+)?handler\s*[:(]?\s*(?:async\s*)?\(?\s*(\w+)\s*[,)]/)
    if (!cm || !hm) continue

    const param = hm[1]
    // Start AFTER the signature. Slicing from `handler(args)` made the wholesale-forwarding
    // check below match the handler's own declaration, so almost every command was skipped
    // and the whole suite reported a clean zero. A guard that passes by never looking is
    // precisely the defect this file exists to prevent.
    const sigAt = b.indexOf(hm[0])
    const handler = b.slice(sigAt + hm[0].length)
    const options = [...b.matchAll(/\.option\(\s*"([^"]+)"/g)].map((m) => m[1])
    if (options.length === 0) continue

    // A handler that never touches the param cannot be checked this way.
    if (!handler.includes(`${param}.`) && !handler.includes(`${param}[`)) continue
    // A handler that forwards the whole object (`run(args)` / `...args`) passes everything
    // through, so per-option checking would be noise.
    if (new RegExp(`\\w+\\(\\s*${param}\\s*[,)]`).test(handler) || handler.includes(`...${param}`)) continue

    for (const o of options) {
      const camel = o.replace(/-(\w)/g, (_, c) => c.toUpperCase())
      const read = [`${param}.${o}`, `${param}["${o}"]`, `${param}['${o}']`, `${param}.${camel}`, `"${o}"`, `'${o}'`]
      if (!read.some((r) => handler.includes(r))) out.push({ command: cm[1], option: o })
    }
  }
  return out
}

describe("argv mapping", () => {
  // The guard must be able to FAIL, or it is a green light that means nothing. This is the
  // exact shape of the bug that motivated the file: options declared, handler maps field by
  // field, two of them never forwarded.
  test("the detector catches the bug it was written for", () => {
    const bug = `
      export const BadCommand = cmd({
        command: "chat [message]",
        builder: (y) => y
          .option("message", { type: "string" })
          .option("timeout", { type: "number" })
          .option("thread", { type: "string" })
          .option("fresh", { type: "boolean" }),
        async handler(args) {
          await executeChat({ message: args.message ?? "", timeout: args.timeout })
        },
      })`
    const found = findUnreadOptions(bug).map((v) => v.option).sort()
    expect(found).toEqual(["fresh", "thread"])
  })

  test("it does not flag options the handler actually reads", () => {
    const ok = `
      export const GoodCommand = cmd({
        command: "x",
        builder: (y) => y.option("limit", { type: "number" }).option("dry-run", { type: "boolean" }),
        async handler(args) {
          if (args["dry-run"]) return
          console.log(args.limit)
        },
      })`
    expect(findUnreadOptions(ok)).toEqual([])
  })

  test("it understands a handler parameter that is not called `args`", () => {
    const argv = `
      export const C = cmd({
        command: "serve",
        builder: (y) => y.option("port", { type: "number" }),
        async handler(argv) { listen(argv.port) },
      })`
    expect(findUnreadOptions(argv)).toEqual([])
  })

  /**
   * KNOWN, PRE-EXISTING candidates — frozen 21 Aug 2026.
   *
   * This is a ratchet, not a clean bill of health. These are options whose handler does not
   * appear to read them; each is a flag a user can pass that may do nothing. They are NOT all
   * verified — a file with two commands of the same name collapses to one key here, so a few
   * are likely false positives. The point is that the list cannot GROW: a new dead flag fails
   * the build the day it is written, which is the only way `--thread` and `--fresh` would have
   * been caught before shipping.
   *
   * Working the list down is real bug-fixing. Adding to it is not allowed.
   */
  const KNOWN: string[] = [
  "howto-backup.ts · backup · --json",
  "mcp-serve.ts · serve · --http",
  "mcp-serve.ts · serve · --port",
  "mcp-serve.ts · serve · --token",
  "mcp-serve.ts · serve · --stateful",
  "platform-agents.ts · thread [id] · --user-id",
  "platform-atlas-ledger.ts · list · --user-id",
  "platform-atlas-ledger.ts · add · --user-id",
  "platform-bloq-context.ts · get <bloqId> [path] · --json",
  "platform-bloq-context.ts · get <bloqId> [path] · --user-id",
  "platform-bloq-context.ts · set <bloqId> <path> <value> · --user-id",
  "platform-bloq-context.ts · append <bloqId> <listPath> <jsonValue> · --user-id",
  "platform-bloq-context.ts · remove <bloqId> <listPath> <itemId> · --user-id",
  "platform-bloq-context.ts · get <bloqId> · --user-id",
  "platform-bloq-context.ts · set <bloqId> <value> · --user-id",
  "platform-bloq-context.ts · list <bloqId> · --user-id",
  "platform-bloq-context.ts · remove <bloqId> <itemId> · --user-id",
  "platform-bloq-context.ts · complete <bloqId> <itemId> · --user-id",
  "platform-bloq-context.ts · stage <bloqId> <itemId> <newStage> · --user-id",
  "platform-bloqs.ts · update-item <item-id> · --user-id",
  "platform-bloqs.ts · add-member <bloq-id> · --email",
  "platform-bloqs.ts · add-member <bloq-id> · --user-id",
  "platform-bloqs.ts · remove-member <bloq-id> · --email",
  "platform-bloqs.ts · remove-member <bloq-id> · --user-id",
  "platform-dashboard.ts · create · --lead",
  "platform-discover.ts · curate · --dry-run",
  "platform-exchange.ts · list · --user-id",
  "platform-hive.ts · save-session · --account",
  "platform-integrations-pathways.ts · onboard <client> · --user-id",
  "platform-integrations.ts · list · --all",
  "platform-leads.ts · sync-calendar <id> · --account",
  "platform-leads.ts · enrich · --queue",
  "platform-leads.ts · list · --json",
  "platform-leads.ts · create <name> · --json",
  "platform-leads.ts · view <id> · --json",
  "platform-leads.ts · create <lead-id> · --json",
  "platform-leads.ts · list <lead-id> · --json",
  "platform-leads.ts · summary <lead-id> · --json",
  "platform-leads.ts · delete <lead-id> · --json",
  "platform-leads.ts · all · --json",
  "platform-leads.ts · schedule <lead-id> · --json",
  "platform-loop.ts · run <name> [skillArgs..] · --yes",
  "platform-mint.ts · import <file> · --json",
  "platform-outreach-approve.ts · approve [id] · --json",
  "platform-outreach-approve.ts · approve · --id",
  "platform-pages.ts · search <query> · --limit",
  "platform-pages.ts · search <query> · --page",
  "platform-pages.ts · search <query> · --json",
  "platform-profile.ts · memberships <slug> · --force",
  "platform-profile.ts · enrich <slug> · --platform",
  "platform-run.ts · connect <type> · --client-id",
  "platform-run.ts · connect <type> · --client-secret",
  "platform-run.ts · connect <type> · --port",
  "platform-run.ts · connect <type> · --paste",
  "platform-run.ts · connect <type> · --bloq",
  "platform-run.ts · connect <type> · --json",
  "platform-run.ts · connect <type> · --user-id",
  "platform-scan.ts · scan · --basic",
  "platform-sdk-call.ts · sdk:call [endpoint] [params..] · --json",
  "platform-tools.ts · invoke <name> · --json",
  "platform-workflows-export.ts · export <id> · --format",
  "platform-workflows.ts · run <workflowId> · --tag",
  ]

  test("no NEW option is registered without its handler reading it", () => {
    const offenders: string[] = []
    for (const file of readdirSync(CMD_DIR).sort()) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
      const src = readFileSync(join(CMD_DIR, file), "utf8")
      for (const v of findUnreadOptions(src)) {
        offenders.push(`${file} · ${v.command} · --${v.option}`)
      }
    }
    const added = offenders.filter((o) => !KNOWN.includes(o))
    expect(added).toEqual([])
  })

  // Keeps the ratchet honest: a fixed entry must leave the list, or KNOWN slowly becomes a
  // place where dead flags are stored rather than removed.
  test("the known list has no stale entries", () => {
    const current = new Set<string>()
    for (const file of readdirSync(CMD_DIR).sort()) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
      for (const v of findUnreadOptions(readFileSync(join(CMD_DIR, file), "utf8"))) {
        current.add(`${file} · ${v.command} · --${v.option}`)
      }
    }
    expect(KNOWN.filter((k) => !current.has(k))).toEqual([])
  })
})
