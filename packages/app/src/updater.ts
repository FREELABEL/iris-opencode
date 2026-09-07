import type { Accessor } from "solid-js"

/**
 * How the shell should behave when an update exists.
 *
 * Lives on the platform rather than in the app's own settings store because the SHELL owns
 * the decision: its launch-time check runs before this app has mounted a settings context,
 * so a preference kept only here would be unreadable at the exact moment it is needed.
 */
export type UpdateMode = "auto" | "ask" | "off"

export type UpdaterState =
  | { status: "disabled" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent?: number }
  | { status: "ready"; version: string }
  | { status: "up-to-date" }
  | { status: "installing"; version: string }
  | { status: "error"; message: string }

export type UpdaterPlatform = {
  state: Accessor<UpdaterState>
  check(): Promise<UpdaterState>
  install(): Promise<void>
  /**
   * Optional: only the desktop shell can install anything, so web and other hosts leave
   * these undefined and the settings row hides itself rather than offering a dead control.
   */
  mode?: Accessor<UpdateMode>
  setMode?: (mode: UpdateMode) => Promise<void>
}
