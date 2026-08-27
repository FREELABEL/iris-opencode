import { check, type Update } from "@tauri-apps/plugin-updater"
import { createSignal } from "solid-js"
import type { UpdaterPlatform, UpdaterState } from "@opencode-ai/app"
import { relaunch } from "@tauri-apps/plugin-process"
import { ask, message } from "@tauri-apps/plugin-dialog"
import { invoke } from "@tauri-apps/api/core"
import { type as ostype } from "@tauri-apps/plugin-os"
import { opencodeGlobal } from "./opencode-global"

export const UPDATER_ENABLED = opencodeGlobal().updaterEnabled ?? false

export async function runUpdater({ alertOnFail }: { alertOnFail: boolean }) {
  let update
  try {
    update = await check()
  } catch {
    if (alertOnFail) await message("Failed to check for updates", { title: "Update Check Failed" })
    return
  }

  if (!update) {
    if (alertOnFail)
      await message("You are already using the latest version of IRIS", { title: "No Update Available" })
    return
  }

  try {
    await update.download()
  } catch {
    if (alertOnFail) await message("Failed to download update", { title: "Update Failed" })
    return
  }

  const shouldUpdate = await ask(
    `Version ${update.version} of IRIS has been downloaded, would you like to install it and relaunch?`,
    { title: "Update Downloaded" },
  )
  if (!shouldUpdate) return

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
  const [state, setState] = createSignal<UpdaterState>(
    UPDATER_ENABLED ? { status: "idle" } : { status: "disabled" },
  )

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

  return { state, check: doCheck, install: doInstall }
}
