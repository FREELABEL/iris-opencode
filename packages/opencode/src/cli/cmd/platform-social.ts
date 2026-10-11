import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, writeJson, printDivider, dim, bold, success, warn } from "./iris-api"

/**
 * `iris social accounts` — which social accounts IRIS can actually post to, per brand (#188875).
 *
 * Reads GET /api/v1/social-media/accounts, the same matrix the server uses to route
 * `iris post --brand`. Before this the CLI could not say which accounts were connected,
 * switched off, or needed reconnecting — so "post it to all of our socials" meant knowing
 * every upload-post username and platform list by hand.
 */

export type AccountState = "connected" | "disabled" | "needs_reauth" | "not_connected"

export interface PlatformCell {
  integration_id: number | null
  profile: string | null
  handle: string | null
  enabled: boolean
  needs_reauth: boolean
  state: AccountState
}

export interface BrandAccounts {
  brand_slug: string | null
  brand_name: string
  scope: string
  platforms: Record<string, PlatformCell>
}

export interface AccountsMatrix {
  success: boolean
  platforms: string[]
  brands: BrandAccounts[]
  enforced?: boolean
  capacity?: { plan?: string; limit?: number; used?: number; remaining?: number; success?: boolean }
}

/** "@x", never "@@x" — handles arrive both with and without their @ (#188876). */
export function at(handle: string | null | undefined): string {
  const h = String(handle ?? "").replace(/^@+/, "")
  return h ? `@${h}` : ""
}

export async function fetchAccounts(): Promise<AccountsMatrix> {
  const res = await irisFetch("/api/v1/social-media/accounts")
  const data = (await res.json().catch(() => ({}))) as any
  if (!res.ok || !data?.success) throw new Error(`could not read connected accounts (HTTP ${res.status}): ${data?.message ?? "unknown error"}`)
  return data as AccountsMatrix
}

export function findBrand(matrix: AccountsMatrix, slug: string): BrandAccounts | undefined {
  const want = slug.toLowerCase().replace(/-/g, "_")
  return matrix.brands.find((b) => (b.brand_slug ?? "").toLowerCase().replace(/-/g, "_") === want)
}

const STATE_REASON: Record<Exclude<AccountState, "connected">, string> = {
  disabled: "connected but switched off",
  needs_reauth: "needs reconnecting",
  not_connected: "not connected",
}

/**
 * The platforms `--to all` means for a brand: every one whose state is `connected`.
 * Every other connected-ish platform (switched off, needs reconnecting) is returned in
 * `skipped` with its reason, so the caller can NAME it rather than silently drop it.
 */
export function connectedTargets(brand: BrandAccounts): { platforms: string[]; skipped: { platform: string; reason: string }[] } {
  const platforms: string[] = []
  const skipped: { platform: string; reason: string }[] = []
  for (const [platform, cell] of Object.entries(brand.platforms)) {
    if (cell.state === "connected") platforms.push(platform)
    else if (cell.state !== "not_connected") skipped.push({ platform, reason: `${at(cell.handle ?? cell.profile)} ${STATE_REASON[cell.state]}`.trim() })
  }
  return { platforms, skipped }
}

function stateLabel(cell: PlatformCell): string {
  if (cell.state === "connected") return success("connected")
  if (cell.state === "needs_reauth") return warn("needs reauth")
  if (cell.state === "disabled") return dim("disabled")
  return dim("—")
}

const SocialAccountsCommand = cmd({
  command: "accounts",
  describe: "which social accounts you can post to, per brand — connected, switched off, or needing reauth",
  builder: (y) =>
    y
      .option("brand", { type: "string", describe: "only this brand (slug, e.g. heyiris)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Social accounts")
    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let matrix: AccountsMatrix
    try {
      matrix = await fetchAccounts()
    } catch (e) {
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
      return
    }

    let brands = matrix.brands
    if (args.brand) {
      const b = findBrand(matrix, String(args.brand))
      if (!b) {
        prompts.log.error(`No accounts for brand '${args.brand}'. Brands with accounts: ${matrix.brands.map((x) => x.brand_slug ?? "personal").join(", ")}`)
        prompts.outro("Done")
        return
      }
      brands = [b]
    }

    if (args.json) {
      await writeJson({ ...matrix, brands })
      prompts.outro("Done")
      return
    }

    printDivider()
    for (const b of brands) {
      const cells = Object.entries(b.platforms).filter(([, c]) => c.state !== "not_connected")
      console.log(`  ${bold(b.brand_name)} ${dim(b.brand_slug ?? "personal")}`)
      if (!cells.length) console.log(`    ${dim("nothing connected")}`)
      for (const [platform, cell] of cells) {
        console.log(`    ${platform.padEnd(10)} ${at(cell.handle ?? cell.profile).padEnd(24)} ${stateLabel(cell)}`)
      }
      const t = connectedTargets(b)
      if (t.platforms.length) console.log(`    ${dim("post here:")} iris post --brand ${b.brand_slug} --to all`)
      console.log()
    }
    const cap = matrix.capacity
    if (cap?.limit != null) console.log(`  ${dim("plan")} ${cap.plan ?? "?"} · ${cap.used ?? "?"}/${cap.limit} profiles used · ${cap.remaining ?? "?"} left`)
    printDivider()
    prompts.outro("Done")
  },
})

export const SocialCommand = cmd({
  command: "social",
  describe: "your connected social accounts (see: iris post --brand)",
  builder: (y) => y.command(SocialAccountsCommand).demandCommand(1),
  async handler() {},
})
