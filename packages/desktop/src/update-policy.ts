// What to do when an update exists — decided as pure data, so it can be tested without
// Tauri, a signed build, or a real release to download.
//
// ## The bug this exists to kill
//
// runUpdater() checked at launch and every six hours, and on every one of those checks it
// downloaded the update and asked "install and relaunch?". Answering NO was not recorded
// anywhere. So the same person got the same dialog about the same version at launch, and
// again six hours later, and again at the next launch, forever.
//
// That is worse than an ineffective prompt: it teaches people to dismiss update dialogs
// without reading them, and the one that finally matters — a security fix, a broken model
// rail — arrives looking exactly like the four they have already waved away this week.
// `alertOnFail: false` was chosen for precisely that reason ("a launch-time check that pops
// 'Failed to check for updates' on a flaky connection trains people to dismiss update
// dialogs") and then the success path did the training instead.
//
// A declined version is remembered. A NEW version asks again, deliberately — declining
// 1.18.40 says nothing about 1.18.41, which may be the one they are waiting for.

export type UpdateMode =
  /** Install in the background; never interrupt. The opt-in people are asking for. */
  | "auto"
  /** Ask once per version. The default, and the honest reading of "notify me". */
  | "ask"
  /** Never check on a timer. The menu item still works when asked on purpose. */
  | "off"

export type UpdateTrigger = "startup" | "interval" | "manual"

export type UpdateDecision =
  | { action: "none"; reason: "no-update" | "checks-disabled" | "already-declined" | "already-installed" }
  | { action: "install-silently" }
  | { action: "prompt" }

export interface UpdateContext {
  mode: UpdateMode
  trigger: UpdateTrigger
  /** The version the updater found, or undefined when there is nothing to install. */
  available?: string
  /** The version this user already said no to, if any. */
  declined?: string
  /**
   * A version already installed silently but not yet RUNNING, if any.
   *
   * A silent install swaps the bundle on disk while the old process keeps going, so check()
   * honestly keeps reporting that same version as available until IRIS is restarted — it is
   * comparing against the running binary, which really is older. Without this the six-hourly
   * timer re-downloads and re-installs an update already sitting on disk, every six hours,
   * for as long as the app stays open. Invisible to the user and expensive: it is the whole
   * application bundle each time, on whatever connection they are paying for.
   */
  installed?: string
  /**
   * Silent installs are macOS-only, and that is a platform fact rather than a preference.
   *
   * On macOS the updater swaps the .app bundle and the running process carries on — the new
   * version is simply what launches next time, so "install without asking" costs the user
   * nothing. On Windows the NSIS installer TERMINATES the running application to replace
   * files (it is why kill_sidecar exists on that path), and on Linux the AppImage swap has
   * the same shape. Installing silently there would close someone's app mid-sentence, which
   * is a far worse interruption than the dialog we are removing.
   *
   * So on those platforms "auto" degrades to asking once per version. That is still a large
   * improvement — once per version instead of every launch and every six hours — and it does
   * not require lying to the user about what the setting does.
   */
  canInstallSilently: boolean
}

export function decideUpdate(ctx: UpdateContext): UpdateDecision {
  // Nothing to do. Checked first so "off" never reports a phantom update.
  if (!ctx.available) return { action: "none", reason: "no-update" }

  // A manual check is a REQUEST, and it outranks everything: the mode, and any earlier
  // decline. Someone who opens the menu and clicks "Check For Updates..." while updates are
  // switched off has just asked a direct question, and answering "no" silently would look
  // like the app is broken.
  if (ctx.trigger === "manual") return { action: "prompt" }

  if (ctx.mode === "off") return { action: "none", reason: "checks-disabled" }

  // Already on disk, waiting for a restart. Nothing left to do for this version.
  if (ctx.installed === ctx.available) return { action: "none", reason: "already-installed" }

  if (ctx.mode === "auto" && ctx.canInstallSilently) return { action: "install-silently" }

  // Asked already, about this exact version, and told no.
  if (ctx.declined === ctx.available) return { action: "none", reason: "already-declined" }

  return { action: "prompt" }
}
