/**
 * Bring your Chrome sign-ins into the Browser (S3b, #193051): the app's half, pure.
 *
 * The Rust side (chrome_cookies.rs) lists Chrome profiles and the sites each is signed into
 * (names and counts, nothing decrypted), and imports the sites the person ticks. Cookie VALUES
 * never come here. What is kept here is only the person's CHOICE (which profile, which sites),
 * so that where the Browser's store forgets on quit (macOS 13) the same sites come back at launch.
 */
import type { NativeBrowserImportSource } from "@/context/platform"
import { QUICK_SITES } from "./native-browser-model"

const KEY = "iris.browser.signins.v1"

/** Sites people most often want signed in, ticked for them when Chrome has them. Never banks. */
const LIKELY = ["heb.com", "amazon.com", "airbnb.com", "facebook.com", "reddit.com", "notion.so", "discord.com", "twitch.tv"]

export function siteOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").split(".").slice(-2).join(".")
  } catch {
    return ""
  }
}

/** Which of this profile's sites start ticked: the quick tiles' sites plus a few common ones. */
export function presetSites(source: NativeBrowserImportSource | undefined): string[] {
  if (!source) return []
  const wanted = new Set([...QUICK_SITES.map((s) => siteOfUrl(s.url)), "google.com", ...LIKELY])
  return source.sites.map((s) => s.site).filter((s) => wanted.has(s))
}

export function filterSites(source: NativeBrowserImportSource | undefined, query: string) {
  const q = query.trim().toLowerCase()
  const all = source?.sites ?? []
  return q ? all.filter((s) => s.site.includes(q)) : all
}

/** The profile to show first: the one with the most sites (most likely the person's main one). */
export function primarySource(list: NativeBrowserImportSource[]): NativeBrowserImportSource | undefined {
  return [...list].sort((a, b) => b.sites.length - a.sites.length)[0]
}

export type SignInChoice = { source: string; sites: string[]; persistent: boolean; at: number }

export function parseChoice(raw: string | null | undefined): SignInChoice | undefined {
  try {
    const v = raw ? JSON.parse(raw) : undefined
    if (!v || typeof v.source !== "string" || !Array.isArray(v.sites)) return undefined
    const sites = v.sites.filter((s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length < 256)
    return { source: v.source, sites, persistent: v.persistent !== false, at: Number(v.at) || 0 }
  } catch {
    return undefined
  }
}

export function loadChoice(storage = globalThis.localStorage): SignInChoice | undefined {
  try {
    return parseChoice(storage?.getItem(KEY))
  } catch {
    return undefined
  }
}

export function saveChoice(choice: SignInChoice, storage = globalThis.localStorage) {
  try {
    storage?.setItem(KEY, JSON.stringify(choice))
  } catch {}
}

/** Re-import at launch only where the store forgets (macOS 13): elsewhere the cookies are still there. */
export function shouldReimport(choice: SignInChoice | undefined): choice is SignInChoice {
  return !!choice && !choice.persistent && choice.sites.length > 0
}
