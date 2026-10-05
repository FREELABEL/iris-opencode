/** Bars in the waveform. Fixed, so the strip never changes width as audio arrives. */
export const LEVEL_HISTORY = 40

/** dBFS mapped onto 0..1: below FLOOR is the room, above CEIL is shouting. */
const FLOOR_DB = -60
const CEIL_DB = -12

/**
 * Loudness on a scale a person hears. Raw RMS is useless for drawing: speech sits around
 * 0.02–0.1, so linear bars would barely move. Decibels spread it across the height.
 */
export function levelFromRms(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0
  const db = 20 * Math.log10(rms)
  const v = (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB)
  return Math.min(1, Math.max(0, v))
}

/** RMS of a slice of samples. */
export function rms(samples: Float32Array, start = 0, end = samples.length): number {
  let sum = 0
  for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!
  return end > start ? Math.sqrt(sum / (end - start)) : 0
}

export function pushLevel(history: readonly number[], level: number): number[] {
  return [...history.slice(1), level]
}

export function emptyLevels(): number[] {
  return new Array(LEVEL_HISTORY).fill(0)
}

export type Bar = { x: number; y: number; w: number; h: number }

/** Bars centred on the midline. Silence keeps a thin stub: a flat strip reads as broken. */
export function waveformBars(levels: readonly number[], box: { width: number; height: number; gap: number }): Bar[] {
  const n = levels.length
  if (n === 0) return []
  const w = Math.max(0.5, (box.width - box.gap * (n - 1)) / n)
  const min = Math.min(box.height, Math.max(1.5, w))
  return levels.map((level, i) => {
    const h = min + (box.height - min) * Math.min(1, Math.max(0, level))
    return { x: i * (w + box.gap), y: (box.height - h) / 2, w, h }
  })
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export function capProgress(seconds: number, max: number): number {
  return max > 0 ? Math.min(1, Math.max(0, seconds / max)) : 0
}
