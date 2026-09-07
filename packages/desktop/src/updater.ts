import { check, type Update } from "@tauri-apps/plugin-updater"
import { createSignal } from "solid-js"
import type { UpdaterPlatform, UpdaterState } from "@opencode-ai/app"
import { relaunch } from "@tauri-apps/plugin-process"
import { ask, message } from "@tauri-apps/plugin-dialog"
import { invoke } from "@tauri-apps/api/core"
import { type as ostype } from "@tauri-apps/plugin-os"
import { opencodeGlobal } from "./opencode-global"
import { Store } from "@tauri-apps/plugin-store"
import { decideUpdate, type UpdateMode } from "./update-policy"

export const UPDATER_ENABLED = opencodeGlobal().updaterEnabled ?? false

// ── Where the preference lives ───────────────────────────────────────────────
//
// Its own store file, not the app's settings store. The shell decides whether to prompt
// BEFORE the webview app has mounted its settings context, so a preference that only exists
// inside the Solid app would be unreadable at exactly the moment it is needed — the launch
// check. Two writers of one file, racing at startup, is the other way to get this wrong.
const STORE = "updates.dat"
const KEY_MODE = "mode"
const KEY_DECLINED = "declinedVersion"
const KEY_INSTALLED = "installedVersion"

const DEFAULT_MODE: UpdateMode = "ask"

async function store() {
  return Store.load(STORE)
}

/**
 * A store that will not load must never silently change behaviour. Falling back to the
 * default mode is right — "ask once" is the safe reading — but falling back to a FORGOTTEN
 * decline would resurrect the nag on every launch for anyone whose store is unreadable, and
 * it would look exactly like the bug we just fixed.
 */
export async function getUpdateMode(): Promise<UpdateMode> {
  try {
    const v = await (await store()).get<UpdateMode>(KEY_MODE)
    return v === "auto" || v === "ask" || v === "off" ? v : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

/**
 * Set by index.tsx to rebuild the native menu. Nothing here imports menu.ts — see setMode().
 */
let onModeChanged: (() => Promise<void>) | undefined

export function onUpdateModeChanged(fn: () => Promise<void>): void {
  onModeChanged = fn
}

async function notifyModeChanged(): Promise<void> {
  try {
    await onModeChanged?.()
  } catch {
    // A stale tick mark is cosmetic; never let it break setting the preference.
  }
}

export async function setUpdateMode(mode: UpdateMode): Promise<void> {
  try {
    const s = await store()
    await s.set(KEY_MODE, mode)
    // Switching the setting at all is a fresh decision about updates, so an old "no" should
    // not keep suppressing a prompt the user has just re-enabled.
    await s.delete(KEY_DECLINED)
    await s.save()
  } catch {
    // A preference that cannot be persisted is not worth crashing the app over; the session
    // still honours it in memory via the caller.
  }
}

async function getInstalled(): Promise<string | undefined> {
  try {
    return (await (await store()).get<string>(KEY_INSTALLED)) ?? undefined
  } catch {
    return undefined
  }
}

async function setInstalled(version: string): Promise<void> {
  try {
    const s = await store()
    await s.set(KEY_INSTALLED, version)
    await s.save()
  } catch {
    // Worst case we re-install the same version on the next check — wasteful, never wrong.
  }
}

async function getDeclined(): Promise<string | undefined> {
  try {
    return (await (await store()).get<string>(KEY_DECLINED)) ?? undefined
  } catch {
    return undefined
  }
}

async function setDeclined(version: string): Promise<void> {
  try {
    const s = await store()
    await s.set(KEY_DECLINED, version)
    await s.save()
  } catch {
    // If we cannot remember the decline we will ask again next time — the old behaviour,
    // and the correct degradation. Better to over-ask than to swallow a real update.
  }
}

/** Silent installs only where installing does not terminate the running app. See update-policy.ts. */
function canInstallSilently(): boolean {
  return ostype() === "macos"
}

/**
 * @param alertOnFail  say something when a check fails. False for background checks.
 * @param trigger      "manual" means a person asked on purpose, and it outranks the
 *                     preference — see decideUpdate().
 */
export async function runUpdater({
  alertOnFail,
  trigger = "manual",
}: {
  alertOnFail: boolean
  trigger?: "startup" | "interval" | "manual"
}) {
  const mode = await getUpdateMode()

  // Cheapest possible exit for the "off" case: do not even ask the update server. A user who
  // turned checks off should not generate a request on every launch, and the network call is
  // the part that used to make a flaky connection produce a dialog.
  if (mode === "off" && trigger !== "manual") return

  let update
  try {
    update = await check()
  } catch {
    if (alertOnFail) await message("Failed to check for updates", { title: "Update Check Failed" })
    return
  }

  const decision = decideUpdate({
    mode,
    trigger,
    available: update?.version,
    declined: await getDeclined(),
    installed: await getInstalled(),
    canInstallSilently: canInstallSilently(),
  })

  if (decision.action === "none") {
    // Only a manual check is owed an answer; a background one stays silent by design.
    if (alertOnFail && decision.reason === "no-update")
      await message("You are already using the latest version of IRIS", { title: "No Update Available" })
    return
  }

  if (!update) return // unreachable given decideUpdate, and cheaper than a non-null assertion

  try {
    await update.download()
  } catch {
    if (alertOnFail) await message("Failed to download update", { title: "Update Failed" })
    return
  }

  if (decision.action === "install-silently") {
    // macOS only. The bundle is swapped underneath the running process and takes effect the
    // NEXT time IRIS launches — no dialog, no relaunch, nothing interrupted. Deliberately
    // not calling relaunch(): "automatic" must mean the user never notices, and closing
    // someone's session to finish an update they did not ask about right now is exactly the
    // interruption this setting exists to remove.
    try {
      await update.install()
      await setInstalled(update.version)
    } catch {
      // Silent means silent, including on failure. It will be retried on the next check, and
      // a modal about a background task the user never initiated is the nag in a new costume.
    }
    return
  }

  const shouldUpdate = await ask(
    `Version ${update.version} of IRIS has been downloaded, would you like to install it and relaunch?`,
    { title: "Update Downloaded" },
  )

  if (!shouldUpdate) {
    // THE FIX. Without this line the same dialog returns at the next launch and every six
    // hours after it, for the same version, forever.
    await setDeclined(update.version)
    return
  }

  try {
    if (ostype() === "windows") await invoke("kill_sidecar")
    await update.install()
  } catch {
    await message("Failed to install update", { title: "Update Failed" })
    return
  }

  await invoke("kill_sidecar")
  await relaunch()
}

// ── UpdaterPlatform for the 1.18 mount ────────────────────────────────────────
//
// 1.18's AppInterface asks the shell for an updater object rather than owning the
// flow itself. runUpdater() above stays as-is — it is the menu-driven, dialog-based
// path — while this exposes the same Tauri plugin as the state machine the UI polls.
//
// NOTE: the injected global is `window.__OPENCODE__` (double underscore), set in
// src-tauri/src/lib.rs's initialization_script. Not `window.OPENCODE`.
export function createUpdaterPlatform(): UpdaterPlatform {
  const [state, setState] = createSignal<UpdaterState>(UPDATER_ENABLED ? { status: "idle" } : { status: "disabled" })

  // Mirrors the persisted preference so the Settings row can render it synchronously.
  // Seeded from the store on creation; the store stays authoritative because the shell's
  // launch-time check reads it directly, long before this signal exists.
  const [mode, setModeSignal] = createSignal<UpdateMode>("ask")
  void getUpdateMode()
    .then(setModeSignal)
    .catch(() => undefined)

  // Held between check() and install() — install() must not re-download.
  let pending: Update | undefined

  const doCheck = async (): Promise<UpdaterState> => {
    if (!UPDATER_ENABLED) return setState({ status: "disabled" })

    setState({ status: "checking" })
    let update: Update | null
    try {
      update = await check()
    } catch (e) {
      return setState({ status: "error", message: e instanceof Error ? e.message : String(e) })
    }

    if (!update) {
      pending = undefined
      return setState({ status: "up-to-date" })
    }

    setState({ status: "downloading", version: update.version })
    try {
      await update.download()
    } catch (e) {
      return setState({ status: "error", message: e instanceof Error ? e.message : String(e) })
    }

    pending = update
    return setState({ status: "ready", version: update.version })
  }

  const doInstall = async (): Promise<void> => {
    if (!pending) return
    setState({ status: "installing", version: pending.version })
    try {
      // Windows holds a lock on the running sidecar; the installer fails if it is alive.
      if (ostype() === "windows") await invoke("kill_sidecar")
      await pending.install()
      await invoke("kill_sidecar")
      await relaunch()
    } catch (e) {
      setState({ status: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }

  return {
    state,
    check: doCheck,
    install: doInstall,
    mode,
    setMode: async (next: UpdateMode) => {
      setModeSignal(next)
      await setUpdateMode(next)
      // Tell whoever owns the native menu to rebuild, so its tick marks agree with this
      // toggle — two surfaces for one preference disagreeing is worse than having one.
      // Via a registered listener rather than importing createMenu, because menu.ts already
      // imports this module: the direct call compiled fine and would have created an
      // import cycle evaluated at startup, where UPDATER_ENABLED can be read while this
      // module is still initialising. A crash on launch is not a fair price for a tick mark.
      await notifyModeChanged()
      // Switching it on should act now, not in six hours.
      if (next === "auto") void runUpdater({ alertOnFail: false, trigger: "interval" }).catch(() => undefined)
    },
  }
}
