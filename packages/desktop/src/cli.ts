import { invoke } from "@tauri-apps/api/core"
import { message } from "@tauri-apps/plugin-dialog"

export async function installCli(): Promise<void> {
  try {
    const path = await invoke<string>("install_cli")
    await message(`CLI installed to ${path}\n\nRestart your terminal to use the 'iris' command.`, {
      title: "CLI Installed",
    })
  } catch (e) {
    await message(`Failed to install CLI: ${e}`, { title: "Installation Failed" })
  }
}

/// Run one of the allowlisted maintenance actions and show its output.
///
/// The daemon prints its actual reason on failure ("token not authorized", "already
/// running"), so the error is SHOWN rather than replaced with a generic "it failed" — the
/// specific text is the whole reason someone can act on the result instead of opening a
/// terminal.
export async function irisAction(action: string, title: string): Promise<void> {
  try {
    const out = await invoke<string>("iris_action", { action })
    await message(out.trim().slice(0, 2000), { title })
  } catch (e) {
    await message(String(e).slice(0, 2000), { title: `${title} — failed` })
  }
}
