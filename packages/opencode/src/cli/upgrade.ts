import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"
import { Installation } from "@/installation"

export async function upgrade() {
  // Skip auto-update for dev builds — version "0.0.0-dev-*" always mismatches
  // the latest release, causing the binary to be overwritten on every TUI launch
  if (Installation.VERSION.includes("-dev-")) return

  const config = await Config.global()
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch(() => {})
  if (!latest) return
  if (Installation.VERSION === latest) return

  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) {
    return
  }

  // Default to "notify" — show update available but don't silently replace binary.
  // Only auto-download if explicitly opted in with autoupdate: true
  if (config.autoupdate !== true) {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (method === "unknown") return
  await Installation.upgrade(method, latest)
    .then(() => Bus.publish(Installation.Event.Updated, { version: latest }))
    .catch(() => {})
}
