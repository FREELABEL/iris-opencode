import { describe, test, expect } from "bun:test"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"

/**
 * No two top-level commands may claim the same name.
 *
 * Written after #181924, where PlatformIntegrationsCommand and PlatformRunCommand
 * both registered `integrations`. yargs resolves that silently in favour of the
 * LATER registration, so an entire module — eight subcommands including share,
 * unshare, disconnect and setup-native — became unreachable while `iris --help`
 * printed two `integrations` rows and advertised the verbs of the losing one.
 *
 * Nothing caught it because nothing was broken in a way a machine was looking at:
 * both compiled, both registered, both rendered in help, and the capability index
 * lists the token once so it could not show a conflict either. The only instrument
 * that could tell the difference was RUNNING the name, and no test did.
 *
 * It sat that way while both files stayed under active maintenance — a real bug in
 * the losing module was fixed three days before the collision was noticed, in a
 * command nobody could invoke.
 */

const CMD_DIR = join(import.meta.dir)
const INDEX = join(import.meta.dir, "..", "..", "index.ts")

/** Brace-match a cmd({...}) / productCommand({...}) block. */
function blockAt(src: string, from: number): string {
  let depth = 0
  let i = src.indexOf("{", from)
  const start = i
  while (i < src.length) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
    i++
  }
  return ""
}

type Decl = { token: string; aliases: string[] }

function collectDeclarations(): Map<string, Decl> {
  const out = new Map<string, Decl>()
  const aliasRefs: Array<[string, string]> = []

  for (const file of readdirSync(CMD_DIR)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
    const src = readFileSync(join(CMD_DIR, file), "utf8")

    for (const m of src.matchAll(
      /(?:export\s+)?const ([A-Za-z0-9_]+(?:Command|Group))\s*=\s*(?:cmd|productCommand)\(\s*\{/g,
    )) {
      const body = blockAt(src, m.index! + m[0].length - 1)
      if (!body) continue
      // productCommand spells `command:` as `name:`.
      const token = (body.match(/command:\s*"([^"]+)"/) ?? body.match(/\bname:\s*"([^"]+)"/))?.[1]
      if (!token) continue
      const aliasRaw = body.match(/aliases:\s*\[([^\]]*)\]/)?.[1] ?? ""
      if (!out.has(m[1])) {
        out.set(m[1], {
          token: token.split(/\s+/)[0],
          aliases: [...aliasRaw.matchAll(/"([^"]+)"/g)].map((a) => a[1]),
        })
      }
    }

    // `export const PlatformHeartbeatCommand = HeartbeatCommand` — index.ts registers
    // the exported name, so the alias has to resolve to the original's declaration.
    for (const m of src.matchAll(
      /export\s+const\s+([A-Za-z0-9_]+Command)\s*=\s*([A-Za-z0-9_]+Command)\s*$/gm,
    )) {
      aliasRefs.push([m[1], m[2]])
    }
  }

  for (const [alias, target] of aliasRefs) {
    if (!out.has(alias) && out.has(target)) out.set(alias, out.get(target)!)
  }
  return out
}

function registeredConsts(): string[] {
  const src = readFileSync(INDEX, "utf8")
  return [...src.matchAll(/\.command\((?:reg\()?([A-Za-z0-9_]+Command)/g)].map((m) => m[1])
}

/** name -> the registered consts claiming it, canonical or by alias. */
function claims(): Map<string, { canonical: string[]; alias: string[] }> {
  const decls = collectDeclarations()
  const map = new Map<string, { canonical: string[]; alias: string[] }>()
  const add = (name: string, who: string, kind: "canonical" | "alias") => {
    const e = map.get(name) ?? { canonical: [], alias: [] }
    e[kind].push(who)
    map.set(name, e)
  }
  for (const c of registeredConsts()) {
    const d = decls.get(c)
    if (!d) continue
    add(d.token, c, "canonical")
    for (const a of d.aliases) add(a, c, "alias")
  }
  return map
}

describe("top-level command names", () => {
  test("the scan actually resolves commands — a zero here would pass everything", () => {
    const resolved = [...claims().values()].filter((v) => v.canonical.length > 0)
    expect(resolved.length).toBeGreaterThan(100)
  })

  test("NO name is claimed as canonical by two different commands", () => {
    const offenders = [...claims().entries()]
      .filter(([, v]) => v.canonical.length > 1)
      .map(([name, v]) => `${name}: ${[...v.canonical].sort().join(" + ")}`)
    // Hard rule, no allowlist: two canonical claims means one command is unreachable
    // by its own name, which is what #181924 was.
    expect(offenders).toEqual([])
  })

  /**
   * Alias shadowing is softer — an alias losing to another command's canonical name
   * costs a shortcut, not a module. These are pre-existing and ratcheted so the count
   * cannot grow quietly. Each is still worth resolving: `iris health` reaches only one
   * of doctor / monitor / heartbeat, and the other two advertise it in their help.
   */
  const KNOWN_SHADOWED = [
    "contracts: PlatformAgreementsCommand + PlatformContractsCommand",
    // `find` was here and is GONE, fixed by #183479: PlatformSearchCommand now declares
    // `aliases: []` with a comment saying why — the alias "did nothing except make the help
    // attribute `find` to content search, hiding the real command".
    //
    // #183537 filed this test's failure and read it the other way round: that the scanner had
    // gone blind to a collision that still existed, and that pruning the entry would delete the
    // only signal of that. Reasonable caution, and wrong here — checked before pruning:
    //   - PlatformSearchCommand's declaration has aliases: [] (platform-bloqs.ts)
    //   - among REGISTERED commands only PlatformFindCommand claims `find`
    //   - the twelve other files declaring a `find` alias are all SUBcommands
    //     (`iris mail search`, `iris slack search`, …) and never registered at top level
    //   - 8 of the 9 known entries are still detected, so alias parsing plainly works
    //
    // The two failure modes are distinguishable, which is what makes pruning safe: a detector
    // that stopped seeing aliases empties `current` and reports ALL NINE as stale. One stale
    // entry is a fixed collision. Nine is a broken scanner. See the alias-detection test below.
    "flows: PlatformOnboardFlowsCommand + PlatformOnboardingCommand",
    "health: PlatformDoctorCommand + PlatformHeartbeatCommand + PlatformMonitorCommand",
    "identities: PlatformIdentityCommand + PlatformSendersCommand",
    "meetings: PlatformAtlasMeetingsCommand + PlatformMeetingsCommand",
    "memory: PlatformBloqsCommand + PlatformMemoryCommand",
    "onboard: PlatformOnboardCommand + PlatformOnboardingCommand",
    "team: PlatformBloqMembersCommand + PlatformTeamsCommand",
  ]

  test("no NEW alias collision is introduced", () => {
    const current = [...claims().entries()]
      .filter(([, v]) => v.canonical.length + v.alias.length > 1)
      .map(([name, v]) => `${name}: ${[...v.canonical, ...v.alias].sort().join(" + ")}`)
      .sort()
    expect(current.filter((c) => !KNOWN_SHADOWED.includes(c))).toEqual([])
  })

  /**
   * The blindness guard for the ALIAS path specifically.
   *
   * The scan test above counts resolved COMMANDS, so it stays green even if alias parsing
   * breaks entirely — and a detector that sees no aliases reports every known entry as "fixed",
   * which is the one way pruning the list could hide a real regression. Ratcheting the count of
   * detected alias collisions makes that failure loud and specific instead.
   */
  test("alias detection is alive — a silent scanner must not read as 'all fixed'", () => {
    const aliasCollisions = [...claims().entries()].filter(
      ([, v]) => v.canonical.length + v.alias.length > 1 && v.alias.length > 0,
    )

    expect(aliasCollisions.length).toBeGreaterThanOrEqual(5)
  })

  test("the known list has no stale entries — a fixed collision must leave it", () => {
    const current = new Set(
      [...claims().entries()]
        .filter(([, v]) => v.canonical.length + v.alias.length > 1)
        .map(([name, v]) => `${name}: ${[...v.canonical, ...v.alias].sort().join(" + ")}`),
    )
    expect(KNOWN_SHADOWED.filter((k) => !current.has(k))).toEqual([])
  })
})
