import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { printDivider, dim, bold, success, highlight, getBridgeToken, BRIDGE_URL } from "./iris-api"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join, dirname } from "path"

/**
 * Obsidian vaults — local markdown, via the IRIS bridge.
 *
 * Obsidian is local-first: no cloud API, no OAuth, so it can never be a Composio
 * integration. The bridge reads the vault off disk instead, the same way the iMessage and
 * Apple Mail drivers do — which means this only works on the machine holding the vault,
 * with the bridge running.
 */

const BRIDGE_BASE = BRIDGE_URL
const CONFIG_PATH = join(homedir(), ".iris", "obsidian.json")

interface VaultConfig {
  defaultVault?: string
}

function readConfig(): VaultConfig {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
  } catch {}
  return {}
}

function writeConfig(cfg: VaultConfig): void {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
  } catch {}
}

const BRIDGE_TOKEN_PATH = join(homedir(), ".iris", "bridge-token")

/**
 * Read the bridge token via the STATIC fs import.
 *
 * The shared getBridgeToken() helper does `require("fs")` inside a try/catch, which
 * returns null the moment `require` is unavailable in the module context — and it does so
 * SILENTLY. Measured here: the identical fetch returned 200 with a token read this way and
 * 401 through the helper, in the same process. An auth helper that fails closed without
 * saying so turns "not authorised" into an unexplained 401 at every call site.
 */
function readBridgeToken(): string | null {
  try {
    if (existsSync(BRIDGE_TOKEN_PATH)) return readFileSync(BRIDGE_TOKEN_PATH, "utf-8").trim() || null
  } catch {}
  return getBridgeToken() // fall back to the shared helper if the direct read fails
}

function bridgeHeaders(): Record<string, string> {
  const token = readBridgeToken()
  const h: Record<string, string> = { Accept: "application/json" }
  if (token) h["X-Bridge-Key"] = token
  return h
}

/**
 * Call the bridge. Distinguishes "bridge is not running" from "the bridge said no" —
 * conflating the two is how a dead dependency gets mistaken for an empty result.
 */
async function bridgeFetch(path: string, timeout = 30000): Promise<any> {
  let res: Response
  try {
    res = await fetch(`${BRIDGE_BASE}${path}`, { headers: bridgeHeaders(), signal: AbortSignal.timeout(timeout) })
  } catch (e: any) {
    throw new Error(
      `IRIS bridge is not reachable at ${BRIDGE_BASE}. Obsidian is read from local disk, ` +
        `so the bridge must be running on the machine holding the vault. Start it with: iris-daemon start`,
    )
  }

  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401) throw new Error(`Bridge rejected the request (401). Token ${readBridgeToken() ? "was sent but refused" : "could not be read"} from ${BRIDGE_TOKEN_PATH}`)
    throw new Error(String((body as any)?.error ?? `Bridge returned HTTP ${res.status}`))
  }
  return body
}

/**
 * Resolve which vault to act on: explicit --vault, else the saved default, else the only
 * discovered vault. Refuses to guess between several — picking one silently is how you
 * end up reading the wrong person's notes.
 */
async function resolveVault(explicit?: string): Promise<string> {
  if (explicit) return explicit

  const saved = readConfig().defaultVault
  if (saved) return saved

  const { vaults } = await bridgeFetch("/api/obsidian/vaults")
  if (!vaults?.length) {
    throw new Error("No Obsidian vaults found. Pass --vault <path>, or set one with: iris obsidian use <path>")
  }
  if (vaults.length === 1) return vaults[0].path

  const names = vaults.map((v: any) => `  ${bold(v.name)}  ${dim(v.path)}`).join("\n")
  throw new Error(`${vaults.length} vaults found — pick one with --vault, or set a default:\n${names}\n\n  iris obsidian use "<path>"`)
}

export const PlatformObsidianCommand = cmd({
  command: "obsidian <action> [query]",
  aliases: ["ob"],
  describe: "search and read local Obsidian vaults (via the IRIS bridge)",
  builder: (y) =>
    y
      .positional("action", {
        describe: "vaults | use | notes | search | read",
        type: "string",
        choices: ["vaults", "use", "notes", "search", "read"],
      })
      .positional("query", { describe: "search query, note path, or vault path (for `use`)", type: "string" })
      .option("vault", { describe: "vault path (defaults to the saved or only vault)", type: "string" })
      .option("folder", { describe: "limit to a folder within the vault", type: "string" })
      .option("limit", { describe: "max results", type: "number", default: 25 })
      .option("body", { describe: "search note bodies as well as names", type: "boolean", default: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),

  async handler(args) {
    UI.empty()
    if (!args.json) prompts.intro(`◈  Obsidian: ${args.action}`)

    try {
      // ── vaults ──
      if (args.action === "vaults") {
        const { vaults } = await bridgeFetch("/api/obsidian/vaults")
        if (args.json) { console.log(JSON.stringify(vaults, null, 2)); return }

        const def = readConfig().defaultVault
        printDivider()
        if (!vaults.length) {
          console.log(`  ${dim("No vaults found in the usual locations.")}`)
          console.log(`  ${dim("Pass a root explicitly, or set one: iris obsidian use \"<path>\"")}`)
        } else {
          for (const v of vaults) {
            const marker = v.path === def ? success("  ← default") : ""
            console.log(`  ${bold(v.name)}${marker}`)
            console.log(`    ${dim(v.path)}`)
          }
        }
        printDivider()
        prompts.outro(`${success("✓")} ${vaults.length} vault(s)`)
        return
      }

      // ── use (set default) ──
      if (args.action === "use") {
        const target = (args.query as string) ?? (args.vault as string)
        if (!target) throw new Error('Provide a vault path: iris obsidian use "<path>"')

        // Verify it really is a vault before saving, so a typo fails now and not later.
        const { vaults } = await bridgeFetch("/api/obsidian/vaults")
        const match = vaults.find((v: any) => v.path === target || v.name === target)
        const resolved = match?.path ?? target

        await bridgeFetch(`/api/obsidian/notes?vault=${encodeURIComponent(resolved)}&limit=1`)
        writeConfig({ ...readConfig(), defaultVault: resolved })

        if (args.json) { console.log(JSON.stringify({ defaultVault: resolved }, null, 2)); return }
        prompts.outro(`${success("✓")} Default vault set to ${bold(resolved)}`)
        return
      }

      const vault = await resolveVault(args.vault as string | undefined)
      const vq = encodeURIComponent(vault)

      // ── notes ──
      if (args.action === "notes") {
        const params = new URLSearchParams({ vault, limit: String(args.limit) })
        if (args.folder) params.set("folder", String(args.folder))
        const { notes } = await bridgeFetch(`/api/obsidian/notes?${params}`)

        if (args.json) { console.log(JSON.stringify(notes, null, 2)); return }
        printDivider()
        for (const n of notes) {
          console.log(`  ${bold(n.name)}${n.folder ? dim(`  ${n.folder}/`) : ""}`)
        }
        printDivider()
        prompts.outro(`${success("✓")} ${notes.length} note(s) in ${bold(vault.split("/").pop() ?? vault)}`)
        return
      }

      // ── search ──
      if (args.action === "search") {
        const q = args.query as string
        if (!q) throw new Error('Provide a query: iris obsidian search "vanguard"')

        const params = new URLSearchParams({ vault, q, limit: String(args.limit) })
        if (args.body) params.set("body", "1")
        const { results } = await bridgeFetch(`/api/obsidian/search?${params}`)

        if (args.json) { console.log(JSON.stringify(results, null, 2)); return }
        printDivider()
        if (!results.length) {
          console.log(`  ${dim(`No notes matching "${q}"`)}`)
        } else {
          for (const r of results) {
            console.log(`  ${bold(r.name)}  ${dim(`[${r.matched}]`)}`)
            if (r.folder) console.log(`    ${dim(r.folder + "/")}`)
            if (r.snippet) console.log(`    ${dim(r.snippet.slice(0, 100))}`)
            console.log(`    ${dim(r.path)}`)
          }
        }
        printDivider()
        prompts.outro(`${success("✓")} ${results.length} result(s)`)
        return
      }

      // ── read ──
      if (args.action === "read") {
        const notePath = args.query as string
        if (!notePath) throw new Error('Provide a note path: iris obsidian read "Folder/Note.md"')

        const note = await bridgeFetch(`/api/obsidian/note?vault=${vq}&path=${encodeURIComponent(notePath)}`)
        if (args.json) { console.log(JSON.stringify(note, null, 2)); return }

        printDivider()
        console.log(`  ${bold(note.name)}`)
        if (note.folder) console.log(`  ${dim(note.folder + "/")}`)
        if (note.tags?.length) console.log(`  ${dim("tags:")}  ${note.tags.join(", ")}`)
        // Wikilinks are the vault's graph — a note's neighbours are usually what make it
        // meaningful, so surface them rather than burying them in --json.
        if (note.links?.length) console.log(`  ${dim("links:")} ${note.links.join(", ")}`)
        printDivider()
        console.log(note.body)
        if (note.truncated) console.log(`\n  ${highlight("… truncated")}`)
        printDivider()
        prompts.outro(`${success("✓")} ${note.path}`)
        return
      }
    } catch (err: any) {
      prompts.log.error(String(err?.message ?? err))
      process.exitCode = 1
      if (!args.json) prompts.outro("Done")
    }
  },
})
