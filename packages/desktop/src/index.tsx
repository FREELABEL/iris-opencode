// @refresh reload
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface, PlatformProvider, Platform, ServerConnection } from "@opencode-ai/app"
import { open, save } from "@tauri-apps/plugin-dialog"
import { open as shellOpen } from "@tauri-apps/plugin-shell"
import { type as ostype } from "@tauri-apps/plugin-os"
import { AsyncStorage } from "@solid-primitives/storage"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import { Store } from "@tauri-apps/plugin-store"

import { UPDATER_ENABLED, createUpdaterPlatform } from "./updater"
import { opencodeGlobal } from "./opencode-global"
import { createMenu } from "./menu"
import { check, Update } from "@tauri-apps/plugin-updater"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification"
import { relaunch } from "@tauri-apps/plugin-process"
import pkg from "../package.json"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  )
}

let update: Update | null = null

const platform: Platform = {
  platform: "desktop",
  version: pkg.version,

  // 1.18's application-global updater (PlatformBase.updater). The older
  // checkUpdate()/update() pair below is the 1.3-era imperative API and is kept for
  // the menu path; this is the state machine the new UI reads. Both drive the same
  // Tauri plugin — the flag gates them identically, so they cannot disagree about
  // whether updating is possible.
  updater: createUpdaterPlatform(),

  async openDirectoryPickerDialog(opts) {
    const result = await open({
      directory: true,
      multiple: opts?.multiple ?? false,
      title: opts?.title ?? "Choose a folder",
    })
    return result
  },

  // NOT part of 1.18's PlatformBase (which declares openDirectoryPickerDialog and
  // openAttachmentPickerDialog only), so there is no contextual type for `opts` and
  // nothing in the app calls it any more. Kept rather than deleted — it is harmless,
  // and removing shell capability is not this port's job — but typed explicitly.
  async openFilePickerDialog(opts?: { multiple?: boolean; title?: string }) {
    const result = await open({
      directory: false,
      multiple: opts?.multiple ?? false,
      title: opts?.title ?? "Choose a file",
    })
    return result
  },

  async saveFilePickerDialog(opts) {
    const result = await save({
      title: opts?.title ?? "Save file",
      defaultPath: opts?.defaultPath,
    })
    return result
  },

  openLink(url: string) {
    void shellOpen(url).catch(() => undefined)
  },

  storage: (name = "default.dat") => {
    type StoreLike = {
      get(key: string): Promise<string | null | undefined>
      set(key: string, value: string): Promise<unknown>
      delete(key: string): Promise<unknown>
      clear(): Promise<unknown>
      keys(): Promise<string[]>
      length(): Promise<number>
    }

    const memory = () => {
      const data = new Map<string, string>()
      const store: StoreLike = {
        get: async (key) => data.get(key),
        set: async (key, value) => {
          data.set(key, value)
        },
        delete: async (key) => {
          data.delete(key)
        },
        clear: async () => {
          data.clear()
        },
        keys: async () => Array.from(data.keys()),
        length: async () => data.size,
      }
      return store
    }

    const api: AsyncStorage & { _store: Promise<StoreLike> | null; _getStore: () => Promise<StoreLike> } = {
      _store: null,
      _getStore: async () => {
        if (api._store) return api._store
        api._store = Store.load(name).catch(() => memory())
        return api._store
      },
      getItem: async (key: string) => {
        const store = await api._getStore()
        const value = await store.get(key).catch(() => null)
        if (value === undefined) return null
        return value
      },
      setItem: async (key: string, value: string) => {
        const store = await api._getStore()
        await store.set(key, value).catch(() => undefined)
      },
      removeItem: async (key: string) => {
        const store = await api._getStore()
        await store.delete(key).catch(() => undefined)
      },
      clear: async () => {
        const store = await api._getStore()
        await store.clear().catch(() => undefined)
      },
      key: async (index: number) => {
        const store = await api._getStore()
        return (await store.keys().catch(() => []))[index]
      },
      getLength: async () => {
        const store = await api._getStore()
        return await store.length().catch(() => 0)
      },
      get length() {
        return api.getLength()
      },
    }
    return api
  },

  checkUpdate: async () => {
    if (!UPDATER_ENABLED) return { updateAvailable: false }
    const next = await check().catch(() => null)
    if (!next) return { updateAvailable: false }
    const ok = await next
      .download()
      .then(() => true)
      .catch(() => false)
    if (!ok) return { updateAvailable: false }
    update = next
    return { updateAvailable: true, version: next.version }
  },

  update: async () => {
    if (!UPDATER_ENABLED || !update) return
    if (ostype() === "windows") await invoke("kill_sidecar").catch(() => undefined)
    await update.install().catch(() => undefined)
  },

  restart: async () => {
    await invoke("kill_sidecar").catch(() => undefined)
    await relaunch()
  },

  notify: async (title, description, onClick) => {
    const granted = await isPermissionGranted().catch(() => false)
    const permission = granted ? "granted" : await requestPermission().catch(() => "denied")
    if (permission !== "granted") return

    const win = getCurrentWindow()
    const focused = await win.isFocused().catch(() => document.hasFocus())
    if (focused) return

    await Promise.resolve()
      .then(() => {
        const notification = new Notification(title, {
          body: description ?? "",
          icon: "https://heyiris.io/apple-touch-icon.png",
        })
        notification.onclick = () => {
          const win = getCurrentWindow()
          void win.show().catch(() => undefined)
          void win.unminimize().catch(() => undefined)
          void win.setFocus().catch(() => undefined)
          // 1.18 changed this contract: the third notify() argument is an onClick
          // CALLBACK, not an href. The 1.3-era code pushed it onto the history stack,
          // which under the new signature would push a function object as a URL.
          // The app now owns its own navigation; we just invoke what it handed us.
          onClick?.()
          notification.close()
        }
      })
      .catch(() => undefined)
  },

  // @ts-expect-error
  fetch: tauriFetch,
}

createMenu()

// Stops mousewheel events from reaching Tauri's pinch-to-zoom handler
root?.addEventListener("mousewheel", (e) => {
  e.stopPropagation()
})

// The sidecar connection. lib.rs injects window.__OPENCODE__.port (double underscore)
// via initialization_script before the webview loads, so this is populated by mount time.
//
// AppInterface needs BOTH halves and they must agree:
//   - `servers`       the actual connection list. Without it the list is empty, the
//                     default key resolves to nothing, server.current is undefined, and
//                     useServerSDK's memo dies as `undefined is not an object
//                     (evaluating 'e().scope')` behind AppBaseProviders' ErrorBoundary.
//   - `defaultServer` a KEY, and for a sidecar connection ServerConnection.key() returns
//                     the literal "sidecar" -- NOT the url. Passing the url here looks
//                     right and silently matches nothing.
// Derived with ServerConnection.key() rather than hardcoded so the two cannot drift.
const serverPort = opencodeGlobal().port
const sidecarConnection: ServerConnection.Any = {
  displayName: "Local",
  type: "sidecar",
  variant: "base",
  http: { url: `http://127.0.0.1:${serverPort}` },
}
const servers = [sidecarConnection]
const defaultServer = ServerConnection.key(sidecarConnection)

render(() => {
  return (
    <PlatformProvider value={platform}>
      {ostype() === "macos" && (
        <div class="mx-px bg-background-base border-b border-border-weak-base h-8" data-tauri-drag-region />
      )}
      <AppBaseProviders>
        <AppInterface defaultServer={defaultServer} servers={servers} />
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)
