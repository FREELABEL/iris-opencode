/**
 * Is the phone fit to work right now? (#191799)
 *
 * The night shift's premise is an old phone on a charger with nobody watching. Old phones fail in
 * the boring ways: the cable is loose and the battery drains, the case traps heat, the screen
 * locks. An agent acting on a dying or locked phone does not fail cleanly — it taps the lock
 * screen, or gets halfway through a form when the phone dies. So the batch asks this before every
 * task, and pauses rather than pushes through.
 *
 * Pure: parses `dumpsys` text. platform-android.ts runs the commands.
 */

export interface Battery {
  level: number | null
  plugged: boolean | null
  /** Celsius. dumpsys reports tenths of a degree. */
  tempC: number | null
  status: string | null
}

const STATUS: Record<string, string> = { "1": "unknown", "2": "charging", "3": "discharging", "4": "not charging", "5": "full" }

/** Parse `dumpsys battery`. A field we cannot read is null, never a guessed default. */
export function parseBattery(text: string): Battery {
  const t = String(text ?? "")
  const num = (re: RegExp) => {
    const m = t.match(re)
    return m ? Number(m[1]) : null
  }
  const level = num(/^\s*level:\s*(-?\d+)/m)
  const scale = num(/^\s*scale:\s*(\d+)/m)
  const temp = num(/^\s*temperature:\s*(-?\d+)/m)
  const flags = ["AC powered", "USB powered", "Wireless powered", "Dock powered"].map((k) => {
    const m = t.match(new RegExp(`^\\s*${k}:\\s*(true|false)`, "m"))
    return m ? m[1] === "true" : null
  })
  const known = flags.filter((f) => f !== null)
  const statusCode = t.match(/^\s*status:\s*(\d+)/m)?.[1]
  return {
    level: level === null ? null : scale && scale !== 100 ? Math.round((level / scale) * 100) : level,
    plugged: known.length ? known.some(Boolean) : null,
    tempC: temp === null ? null : temp / 10,
    status: statusCode ? STATUS[statusCode] ?? statusCode : null,
  }
}

/**
 * Is the keyguard up? Read from `dumpsys window`, whose field names have changed across Android
 * releases — so any of the known names counts, and none of them present is UNKNOWN (null), not
 * "unlocked". An unknown lock state does not pause the batch; a known lock does.
 */
export function parseLocked(windowDump: string): boolean | null {
  const t = String(windowDump ?? "")
  const m = t.match(/\b(?:mShowingLockscreen|isKeyguardShowing|mDreamingLockscreen|isStatusBarKeyguard|mKeyguardShowing)=(true|false)/g)
  if (!m) return null
  return m.some((s) => s.endsWith("true"))
}

/** Is the display on? `dumpsys power` → mWakefulness=Awake|Asleep|Dozing|Dreaming. */
export function parseAwake(powerDump: string): boolean | null {
  const m = String(powerDump ?? "").match(/mWakefulness=(\w+)/)
  return m ? m[1] === "Awake" : null
}

export interface Health {
  battery: Battery
  locked: boolean | null
  awake: boolean | null
}

export interface HealthLimits {
  /** Pause below this level when NOT on power. On power a low phone is recovering, not dying. */
  minLevel: number
  maxTempC: number
}

export const DEFAULT_LIMITS: HealthLimits = { minLevel: 20, maxTempC: 42 }

export interface HealthVerdict {
  ok: boolean
  reasons: string[]
}

export function healthVerdict(h: Health, limits: HealthLimits = DEFAULT_LIMITS): HealthVerdict {
  const reasons: string[] = []
  const b = h.battery
  if (b.level !== null && b.level < limits.minLevel && b.plugged !== true)
    reasons.push(`battery ${b.level}% and not charging (pause below ${limits.minLevel}%)`)
  if (b.tempC !== null && b.tempC > limits.maxTempC) reasons.push(`battery at ${b.tempC} °C (pause above ${limits.maxTempC} °C)`)
  if (h.locked === true) reasons.push("screen is locked — an agent on a lock screen taps the lock screen")
  if (h.awake === false) reasons.push("display is asleep")
  return { ok: reasons.length === 0, reasons }
}
