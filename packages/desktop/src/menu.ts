import { invoke } from "@tauri-apps/api/core"
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu"
import { type as ostype } from "@tauri-apps/plugin-os"

import { runUpdater, UPDATER_ENABLED } from "./updater"
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
            action: () => runUpdater({ alertOnFail: true }),
            text: "Check For Updates...",
          }),
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
