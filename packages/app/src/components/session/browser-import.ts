/**
 * "Sign in with Chrome" (S3b, #193051): the app's half, pure.
 *
 * ONE button. The Rust side (chrome_cookies.rs) finds the person's Chrome profiles (names and
 * counts, nothing decrypted); we take their main one (the most sites) and bring in every site it
 * is signed into. macOS shows its own Keychain prompt; that prompt is the consent. Cookie VALUES
 * never come here, and a sign-in being here does not let the agent use the site: the per-site
 * Allow (browser-grants.ts) still decides that.
 *
 * Kept here: only THAT it was done (and whether the store keeps it), so the start page can say
 * "Signed in from Chrome" and, where the store forgets on quit (macOS 13), it is redone at launch.
 */
import type { NativeBrowser, NativeBrowserImportSource } from "@/context/platform"

const KEY = "iris.browser.signins.v2"

/** The profile to use: the one with the most sites (the person's main one). */
export function primarySource(list: NativeBrowserImportSource[]): NativeBrowserImportSource | undefined {
  return [...list].sort((a, b) => b.sites.length - a.sites.length)[0]
}

export type SignedIn = { from: string; sites: number; persistent: boolean; at: number }

export function parseSignedIn(raw: string | null | undefined): SignedIn | undefined {
  try {
    const v = raw ? JSON.parse(raw) : undefined
    if (!v || typeof v.from !== "string") return undefined
    return { from: v.from, sites: Number(v.sites) || 0, persistent: v.persistent !== false, at: Number(v.at) || 0 }
  } catch {
    return undefined
  }
}

export function loadSignedIn(storage = globalThis.localStorage): SignedIn | undefined {
  try {
    return parseSignedIn(storage?.getItem(KEY))
  } catch {
    return undefined
  }
}

function save(v: SignedIn, storage: Storage | undefined) {
  try {
    storage?.setItem(KEY, JSON.stringify(v))
  } catch {}
}

/** Redo at launch only where the Browser forgets on quit (macOS 13). */
export function shouldRedo(v: SignedIn | undefined): boolean {
  return !!v && !v.persistent
}

export type SignInResult =
  | { ok: true; sites: number; from: string }
  | { ok: false; reason: "none" | "denied" | "error"; message?: string }

/** The whole flow behind the button. */
export async function signInWithChrome(
  b: Pick<NativeBrowser, "importSources" | "importSignIns">,
  storage: Storage | undefined = globalThis.localStorage,
): Promise<SignInResult> {
  if (!b.importSources || !b.importSignIns) return { ok: false, reason: "none" }
  try {
    const src = primarySource(await b.importSources())
    if (!src || !src.sites.length) return { ok: false, reason: "none" }
    const r = await b.importSignIns(
      src.id,
      src.sites.map((s) => s.site),
    )
    const from = `${src.browser}${src.profile && src.profile !== "Default" ? ` · ${src.profile}` : ""}`
    save({ from, sites: r.sites.length, persistent: r.persistent, at: Date.now() }, storage)
    return { ok: true, sites: r.sites.length, from }
  } catch (e) {
    const message = String(e)
    return { ok: false, reason: /didn't give IRIS the key|Deny/i.test(message) ? "denied" : "error", message }
  }
}
