import { atlasHome, isGranted, readPolicy } from "./platform-atlas-store"
import { PLATFORM_URLS } from "./iris-api"

// ============================================================================
// THE SEAL, at the egress. Epic #184607, component 7 — layers 2 and 3.
//
// WHY NOT GATE THE COMMANDS.
//
// `platform-bloqs.ts` alone makes 63 network calls across ~30 atlas subcommands.
// Adding a check to each one is a DENYLIST: it protects exactly the doors someone
// remembered, it silently fails to cover the next command anybody adds, and this
// project has already leaked three times through controls of precisely that shape
// (an empty allow-list that admitted everyone; a gate that checked a domain rather
// than membership; a scope list that had to be updated by hand).
//
// So the check goes where every one of those calls has to pass anyway: the fetch
// that leaves the process. Deny-by-default, and a command written tomorrow is
// covered without anyone remembering to cover it.
//
// WHAT THIS IS, EXACTLY — and it must be said everywhere it refuses:
//
//   ✅ it stops THIS PROCESS reaching Atlas for anything the machine was not granted
//   ✅ it covers every current and future iris command, including ones added later
//   ❌ it does NOT stop `curl`, another binary, or a process that already has the bytes
//   ❌ it is not a firewall — OS-level network isolation is a sandbox's job
//
// An overclaimed boundary costs more trust than a documented partial one, which is
// why `describeSealScope()` is printed by every refusal rather than kept in a doc.
// ============================================================================

/**
 * The one window in which atlas egress is allowed on a sealed machine: an explicit,
 * operator-initiated update. Freshness is an OPERATION (ADR-02), so the network opens
 * for the length of that operation and closes again.
 *
 * A counter rather than a boolean: nested or concurrent refreshes must not have the
 * inner one close the window while the outer is still using it.
 */
let unsealedDepth = 0

export async function withAtlasUnsealed<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  unsealedDepth++
  try {
    return await fn()
  } finally {
    unsealedDepth--
    if (unsealedDepth < 0) unsealedDepth = 0
    void reason
  }
}

export function isAtlasEgressOpen(): boolean {
  return unsealedDepth > 0
}

/** Said out loud at every refusal, so the claim can never quietly grow. */
export function describeSealScope(): string {
  return "the seal stops THIS PROCESS — not curl, not another binary, and not a process that already holds the bytes"
}

/** Hosts that serve Atlas content. A sealed machine may not reach these unprompted. */
export function atlasHosts(): string[] {
  return [PLATFORM_URLS.flApi, PLATFORM_URLS.irisApi, PLATFORM_URLS.publicSite]
    .map((u) => {
      try {
        return new URL(u).host
      } catch {
        return ""
      }
    })
    .filter(Boolean)
}

/**
 * Is this URL an Atlas CONTENT read, and if so which item does it address?
 *
 * Returns the uuid or numeric id when the path names one, `null` when the request
 * touches Atlas but names no single item (a listing, a search — which a sealed
 * machine must not be able to run, because enumerating the library is itself the
 * thing being denied), and `undefined` when the request is not Atlas at all.
 */
export function atlasRefInUrl(url: string): string | null | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  if (!atlasHosts().includes(u.host)) return undefined
  const p = u.pathname

  // Not content: auth, health, telemetry, version. Blocking these would break the
  // CLI's ability to say WHY it is refusing, which is worse than the leak it prevents.
  if (/\/(oauth|health|version|telemetry|install-code|api\/v1\/me)\b/.test(p)) return undefined
  if (!/\/(bloq|bloqs|atlas|how-tos?|playbooks?)\b/.test(p)) return undefined

  const uuid = p.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  if (uuid) return uuid[0].toLowerCase()
  const id = p.match(/\/item\/(\d+)|\/items\/(\d+)|\/list\/item\/(\d+)/)
  if (id) return id[1] ?? id[2] ?? id[3]
  return null
}

export class SealedError extends Error {
  constructor(what: string) {
    super(
      `Sealed: this machine was not granted ${what}.\n` +
        `  ${describeSealScope()}\n` +
        `  iris atlas pins     what this machine holds\n` +
        `  iris atlas refresh  the one operation that opens the network\n` +
        `  iris atlas unseal   lift it (an operator decision)`,
    )
    this.name = "SealedError"
  }
}

/**
 * Install the guard over `globalThis.fetch`.
 *
 * Called once at CLI startup. On an unsealed machine it installs NOTHING — no wrapper,
 * no overhead, no behaviour change — so the sealed path is the only one that can differ.
 */
export function installSealedFetchGuard(): { installed: boolean; reason: string } {
  const home = atlasHome()
  let sealed = false
  try {
    sealed = readPolicy(home).sealed
  } catch {
    // An unreadable policy already fails closed in readPolicy; if even that throws,
    // refuse to install rather than pretend a seal is in force that is not.
    return { installed: false, reason: "policy unreadable" }
  }
  if (!sealed) return { installed: false, reason: "not sealed" }
  if ((globalThis as any).__atlasSealInstalled) return { installed: true, reason: "already installed" }

  const original = globalThis.fetch
  const guarded = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input))
    const ref = atlasRefInUrl(url)

    if (ref !== undefined && !isAtlasEgressOpen()) {
      // A LISTING or SEARCH (ref === null) is refused outright: being able to
      // enumerate the library is the capability the grant exists to withhold, and
      // "it only returned titles" is not a defence.
      if (ref === null) throw new SealedError("a listing or search of the library")
      if (!isGranted(home, ref)) throw new SealedError(ref)
    }
    return original(input, init)
  }

  // Carry over `preconnect` and anything else the runtime hangs off fetch, so the
  // wrapper is a guard and not a partial reimplementation.
  Object.assign(guarded, original)
  globalThis.fetch = guarded as typeof fetch
  ;(globalThis as any).__atlasSealInstalled = true
  return { installed: true, reason: "sealed" }
}
