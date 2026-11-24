import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { FL_API, requireAuth, printDivider, printKV, bold, success, warn, writeJson } from "./iris-api"
import { Auth } from "../../auth"
import { formatBytes } from "./platform-cloud-upload"

/** "1.2 GB of 10.0 GB (12%)", or "1.2 GB (unlimited)" — #194118 */
export function describeUsage(u: { used_bytes: number; quota_bytes: number }): string {
  if (u.quota_bytes < 0) return `${formatBytes(u.used_bytes)} (unlimited)`
  const pct = u.quota_bytes > 0 ? Math.round((u.used_bytes / u.quota_bytes) * 100) : 0
  return `${formatBytes(u.used_bytes)} of ${formatBytes(u.quota_bytes)} (${pct}%)`
}

export const PlatformCloudUsageCommand = cmd({
  command: "cloud:usage",
  describe: "how much cloud storage your plan gives you, how much you use, and the largest file you can upload",
  builder: (y) => y.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    if (!args.json) prompts.intro("◈  Cloud Storage")
    const fail = (m: string) => {
      prompts.log.error(m)
      prompts.outro("Failed")
      process.exitCode = 1
    }
    if (!(await requireAuth())) return fail("Not signed in — run `iris login`")

    const stored = await Auth.get("iris")
    const token = stored?.type === "api" ? stored.key : process.env.FL_API_TOKEN ?? process.env.IRIS_API_KEY ?? ""
    const res = await fetch(`${FL_API}/api/v1/cloud-files/usage`, {
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }).catch((e) => e as Error)
    if (res instanceof Error) return fail(`Could not reach the API: ${res.message}`)
    if (res.status === 404) return fail("This server does not report storage usage yet.")
    const body: any = await res.json().catch(() => ({}))
    if (!res.ok) return fail(body?.message ?? `HTTP ${res.status}`)
    const u = body.data

    if (args.json) return void (await writeJson(u))

    printDivider()
    printKV("Plan", `${u.tier_name}${u.quota_source === "account" ? "  (custom limit on your account)" : ""}`)
    const line = describeUsage(u)
    printKV("Used", u.over_quota ? bold(warn(`${line} — over your limit, new uploads are blocked`)) : u.used_ratio >= 0.8 ? warn(line) : success(line))
    if (u.quota_bytes >= 0) printKV("Left", formatBytes(u.remaining_bytes))
    printKV("Largest file", formatBytes(u.max_file_bytes))
    printKV("Files", String(u.file_count))
    if (u.reserved_bytes > 0) printKV("Uploading now", `${formatBytes(u.reserved_bytes)} (${u.pending_upload_count})`)
    if (u.expired_file_count > 0) printKV("Expired, not yet removed", `${u.expired_file_count} files, ${formatBytes(u.expired_bytes)} — still counted`)
    printDivider()
    prompts.outro("Done")
  },
})
