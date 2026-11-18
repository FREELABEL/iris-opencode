/**
 * The desktop engine lives exactly as long as the app that started it (#193427).
 *
 * The app stops its engine on a normal quit, a restart and an update. It cannot when it crashes,
 * hangs and is force-quit, or is killed: then nothing runs in the app, and the engine was left
 * behind, reparented to launchd, holding 400-850 MB each. Three were found on one Mac after a day.
 * Only the engine can notice that, so it checks: spawn_sidecar passes IRIS_APP_PID, and once that
 * process is gone the engine exits the same way a quit would.
 */

export const PARENT_ENV = "IRIS_APP_PID"

/** True while a process with this pid exists. EPERM means it exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

/** The app's pid from the environment, or undefined for an engine nobody's app started. */
export function parentFromEnv(env: Record<string, string | undefined> = process.env): number | undefined {
  const pid = Number(env[PARENT_ENV])
  return Number.isInteger(pid) && pid > 1 ? pid : undefined
}

/** Calls onGone once, the first check after the parent stops existing. Returns a stop function. */
export function watchParent(opts: {
  pid: number
  onGone: () => void
  intervalMs?: number
  alive?: (pid: number) => boolean
}): () => void {
  const alive = opts.alive ?? processAlive
  let done = false
  const timer = setInterval(() => {
    if (done || alive(opts.pid)) return
    done = true
    clearInterval(timer)
    opts.onGone()
  }, opts.intervalMs ?? 2000)
  // Never the reason the engine stays up.
  ;(timer as { unref?: () => void }).unref?.()
  return () => {
    done = true
    clearInterval(timer)
  }
}

/**
 * Start watching when this engine was started by the app. On the app's death: SIGTERM ourselves
 * (so the usage flush and other quit handlers run), and exit hard 3 s later if anything holds on.
 */
export function exitWithParent(env: Record<string, string | undefined> = process.env): (() => void) | undefined {
  const pid = parentFromEnv(env)
  if (!pid) return undefined
  return watchParent({
    pid,
    onGone: () => {
      console.error(`iris: the app (pid ${pid}) is gone; this engine exits with it (#193427)`)
      setTimeout(() => process.exit(0), 3000).unref?.()
      process.kill(process.pid, "SIGTERM")
    },
  })
}
