/**
 * "Remind me" on the out card (#194530): a system notification when the week resets. The app's only
 * notification path is platform.notify, which fires now — so the wait is a timer, and the reset
 * time is kept in localStorage so a relaunch before the reset re-arms it.
 */
const KEY = "iris.usage.remind-at"
const MAX_DELAY = 2_147_000_000 // setTimeout's ceiling (~24.8 days); a week is well inside it
let pending: ReturnType<typeof setTimeout> | null = null

type Notify = (title: string, description?: string) => Promise<void> | void

/** When a reminder for `at` would fire, in ms from now — null for a past, invalid or too-far time. */
export function reminderDelay(at: string | null | undefined, now: number = Date.now()): number | null {
  if (!at) return null
  const t = new Date(at).getTime()
  if (Number.isNaN(t)) return null
  const d = t - now
  return d > 0 && d <= MAX_DELAY ? d : null
}

function arm(at: string, notify: Notify): boolean {
  const delay = reminderDelay(at)
  if (delay === null) return false
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    try {
      localStorage.removeItem(KEY)
    } catch {}
    void notify("Your IRIS week has reset", "Your weekly tokens are back. Pick up where you left off.")
  }, delay)
  return true
}

/** Schedule it. False when there is nothing to schedule (no reset time, or it already passed). */
export function scheduleResetReminder(at: string | null | undefined, notify: Notify): boolean {
  if (!at || !arm(at, notify)) return false
  try {
    localStorage.setItem(KEY, at)
  } catch {}
  return true
}

/** A reminder set before a relaunch. */
export function rearmResetReminder(notify: Notify): string | null {
  if (pending) return reminderAt()
  const at = reminderAt()
  if (!at) return null
  if (!arm(at, notify)) {
    try {
      localStorage.removeItem(KEY)
    } catch {}
    return null
  }
  return at
}

export function reminderAt(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}
