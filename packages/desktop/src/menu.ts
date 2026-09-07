import { invoke } from "@tauri-apps/api/core"
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu"
import { type as ostype } from "@tauri-apps/plugin-os"

import { getUpdateMode, runUpdater, setUpdateMode, UPDATER_ENABLED } from "./updater"
import type { UpdateMode } from "./update-policy"
import { installCli, irisAction } from "./cli"

export async function createMenu() {
  if (ostype() !== "macos") return

  const menu = await Menu.new({
    items: [
      await Submenu.new({
        text: "IRIS",
        items: [
          await PredefinedMenuItem.new({
            item: { About: null },
          }),
          await MenuItem.new({
            enabled: UPDATER_ENABLED,
            action: () => runUpdater({ alertOnFail: true, trigger: "manual" }),
            text: "Check For Updates...",
          }),
          // The setting people have been asking for, next to the thing it governs.
          //
          // It lives in the menu rather than only in Settings > Updates because the shell
          // owns the prompt: the launch check runs before the webview app has mounted its
          // settings context, so this is the one surface guaranteed to exist at the moment
          // the preference matters. (The app-side row reads the same store.)
          await updatesSubmenu(),
          // Sign-in, always reachable. It used to appear ONLY as a startup prompt when no
          // credential existed, so dismissing it left no way back except relaunching the app —
          // and the thing it fixes ("0 tokens", empty replies) does not look like a sign-in
          // problem, so nobody would think to relaunch for it. A permanent item also covers
          // re-authenticating after a token expires, which the startup path never handled.
          await MenuItem.new({
            action: () => invoke("open_login_window"),
            text: "Sign In...",
          }),
          await MenuItem.new({
            action: () => installCli(),
            text: "Install CLI...",
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
          // The Hive actions people actually need after installing, so recovery does not
          // require a terminal. "Register" is the fix for the common case where `iris auth
          // whoami` works but the daemon reports 401: the account key is fine and the machine
          // simply is not a registered node — two different credentials.
          await MenuItem.new({
            action: () => irisAction("daemon-status", "Hive Daemon Status"),
            text: "Hive: Daemon Status",
          }),
          await MenuItem.new({
            action: () => irisAction("daemon-register", "Register Hive Node"),
            text: "Hive: Register This Machine",
          }),
          await MenuItem.new({
            action: () => irisAction("daemon-restart", "Restart Hive Daemon"),
            text: "Hive: Restart Daemon",
          }),
          await MenuItem.new({
            action: () => irisAction("auth-whoami", "IRIS Account"),
            text: "Who Am I Logged In As",
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
          await PredefinedMenuItem.new({
            item: "Hide",
          }),
          await PredefinedMenuItem.new({
            item: "HideOthers",
          }),
          await PredefinedMenuItem.new({
            item: "ShowAll",
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
          await PredefinedMenuItem.new({
            item: "Quit",
          }),
        ].filter(Boolean),
      }),
      // await Submenu.new({
      //   text: "File",
      //   items: [
      //     await MenuItem.new({
      //       enabled: false,
      //       text: "Open Project...",
      //     }),
      //     await PredefinedMenuItem.new({
      //       item: "Separator"
      //     }),
      //     await MenuItem.new({
      //       enabled: false,
      //       text: "New Session",
      //     }),
      //     await PredefinedMenuItem.new({
      //       item: "Separator"
      //     }),
      //     await MenuItem.new({
      //       enabled: false,
      //       text: "Close Project",
      //     })
      //   ]
      // }),
      await Submenu.new({
        text: "Edit",
        items: [
          await PredefinedMenuItem.new({
            item: "Undo",
          }),
          await PredefinedMenuItem.new({
            item: "Redo",
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
          await PredefinedMenuItem.new({
            item: "Cut",
          }),
          await PredefinedMenuItem.new({
            item: "Copy",
          }),
          await PredefinedMenuItem.new({
            item: "Paste",
          }),
          await PredefinedMenuItem.new({
            item: "SelectAll",
          }),
        ],
      }),
    ],
  })
  menu.setAsAppMenu()
}

/**
 * Radio-style update preference. CheckMenuItem rather than a Switch because there are three
 * states, not two, and "Automatic" and "Never" are not opposites of each other.
 *
 * Rebuilt on each selection: Tauri menu items are native objects, so the tick marks do not
 * re-render from a signal the way a DOM control would.
 */
async function updatesSubmenu(): Promise<Submenu> {
  const current = await getUpdateMode().catch(() => "ask" as UpdateMode)

  const choose = async (mode: UpdateMode) => {
    await setUpdateMode(mode)
    // Rebuild the whole app menu so the ticks reflect what was just chosen.
    await createMenu()
    // Turning automatic updates ON should DO something, not wait six hours to prove it.
    if (mode === "auto") void runUpdater({ alertOnFail: false, trigger: "interval" }).catch(() => undefined)
  }

  const item = async (mode: UpdateMode, text: string) =>
    await CheckMenuItem.new({
      text,
      checked: current === mode,
      enabled: UPDATER_ENABLED,
      action: () => void choose(mode),
    })

  return await Submenu.new({
    text: "Automatic Updates",
    enabled: UPDATER_ENABLED,
    items: [
      await item("auto", "Install Automatically"),
      await item("ask", "Ask Me Once Per Version"),
      await item("off", "Never Check Automatically"),
    ],
  })
}
