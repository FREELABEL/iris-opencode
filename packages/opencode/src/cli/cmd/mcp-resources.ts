/**
 * The IRIS MCP server's resource catalog, as two functions that must agree (#191844).
 *
 * The how-to recipes reference each other by file name — agentic-loops.md says "see
 * `drive-iris-from-claude-code.md`" — but the server only ever offered them as ONE resource,
 * `iris://recipes`, a ~600 KB concatenation of all of them. A cloud agent with no filesystem
 * that followed such a reference had nothing it could read: it tried the only per-item
 * namespace in the catalog, `iris://playbook/drive-iris-from-claude-code`, and got
 * "Unknown playbook" — that name is a recipe, not a playbook.
 *
 * So each recipe is now its own resource, `iris://recipe/<name>`, advertised in the list and
 * served by the read; a playbook-namespace miss that matches a recipe says which URI to read.
 * `listResources` and `readResource` live together so a test can hold them to one rule:
 * every URI the list advertises, the read serves.
 */

import { existsSync, readdirSync, readFileSync } from "fs"
import { join } from "path"
import { PLAYBOOK_URI_PREFIX } from "./mcp-playbooks"

export const RECIPE_URI_PREFIX = "iris://recipe/"

export interface McpResource {
  uri: string
  name: string
  description?: string
  mimeType: string
}

export interface ResourceDeps {
  howtoDir: string
  playbooksEnabled: boolean
  guide: () => string
  commands: () => string
  recipes: () => Promise<string>
  listPlaybooks: () => Promise<McpResource[]>
  readPlaybook: (name: string) => Promise<string>
}

/** Recipe names are file stems; anything that could leave the directory is not one. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function recipeFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
}

/** "# How to: Drive IRIS from Claude Code" -> "Drive IRIS from Claude Code". */
function recipeTitle(text: string): string | undefined {
  const h = text.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return h ? h.replace(/^how to:\s*/i, "") : undefined
}

export function recipeResources(dir: string): McpResource[] {
  return recipeFiles(dir).map((f) => {
    const name = f.slice(0, -3)
    let title: string | undefined
    try {
      title = recipeTitle(readFileSync(join(dir, f), "utf-8"))
    } catch {}
    return {
      uri: `${RECIPE_URI_PREFIX}${name}`,
      name: `Recipe: ${name}`,
      description: title ?? `How-to recipe ${name}`,
      mimeType: "text/markdown",
    }
  })
}

/** The recipe called `name` (a `.md` suffix is accepted), or undefined. */
export function readRecipe(dir: string, name: string): string | undefined {
  const stem = name.endsWith(".md") ? name.slice(0, -3) : name
  if (!SAFE_NAME.test(stem)) return undefined
  const file = join(dir, `${stem}.md`)
  if (!existsSync(file)) return undefined
  return readFileSync(file, "utf-8")
}

export async function listResources(deps: ResourceDeps): Promise<McpResource[]> {
  return [
    { uri: "iris://guide", name: "IRIS CLI Guide", description: "Install, authenticate, and use the IRIS CLI", mimeType: "text/markdown" },
    { uri: "iris://commands", name: "Command Catalog", description: "Full catalog of 120+ IRIS CLI commands grouped by category", mimeType: "text/markdown" },
    {
      uri: "iris://recipes",
      name: "How-To Recipes",
      description: `Every recipe from ~/.iris/how-to/ in one document (large). Read one with ${RECIPE_URI_PREFIX}<name>.`,
      mimeType: "text/markdown",
    },
    ...recipeResources(deps.howtoDir),
    // Every playbook is readable, whether or not it can be run. Most are
    // written procedures with no steps at all — that IS the artefact.
    ...(deps.playbooksEnabled ? await deps.listPlaybooks() : []),
  ]
}

export async function readResource(uri: string, deps: ResourceDeps): Promise<string> {
  if (uri.startsWith(RECIPE_URI_PREFIX)) {
    const name = uri.slice(RECIPE_URI_PREFIX.length)
    const text = readRecipe(deps.howtoDir, name)
    if (text === undefined) throw new Error(`Unknown recipe: ${name}. List them with the iris://recipes resource or \`iris how-to list\`.`)
    return text
  }
  if (deps.playbooksEnabled && uri.startsWith(PLAYBOOK_URI_PREFIX)) {
    const name = uri.slice(PLAYBOOK_URI_PREFIX.length)
    try {
      return await deps.readPlaybook(name)
    } catch (e) {
      // The miss that #191844 hit: a recipe name tried in the playbook namespace.
      if (readRecipe(deps.howtoDir, name) !== undefined)
        throw new Error(`Unknown playbook: ${name}. '${name}' is a how-to recipe — read ${RECIPE_URI_PREFIX}${name.replace(/\.md$/, "")}.`)
      throw e
    }
  }
  switch (uri) {
    case "iris://guide":
      return deps.guide()
    case "iris://commands":
      return deps.commands()
    case "iris://recipes":
      return deps.recipes()
    default:
      throw new Error(`Unknown resource: ${uri}`)
  }
}
