#!/usr/bin/env bun
/**
 * Contrast gate for shipped themes (#194375).
 *
 * For every theme in src/theme/themes, light and dark: resolve the tokens exactly as the app does,
 * then check each body-text token against the grounds it sits on. Tuned themes (TUNED) fail the run
 * below 4.5:1; every other theme is reported as a warning so it is visible without blocking.
 *
 *   bun run script/check-contrast.ts            # exit 1 if a tuned theme fails
 *   bun run script/check-contrast.ts --all      # print every pair, not just failures
 *
 * `text-weaker` and `v2-text-text-faint` are deliberately not checked: they are for disabled and
 * placeholder text only (WCAG exempts inactive UI).
 */

import { readdirSync } from "node:fs"
import { resolveThemeVariant } from "../src/theme/resolve"
import { resolveThemeVariantV2 } from "../src/theme/v2/resolve"
import type { DesktopTheme } from "../src/theme/types"

export const TUNED = ["iris", "oc-2"]
export const MIN = 4.5

/** Text tokens and the grounds each must clear. Raised surfaces are composited onto their parent. */
export const PAIRS: { text: string[]; on: string[] }[] = [
  {
    text: ["text-strong", "text-base", "text-weak"],
    on: [
      "background-base",
      "background-weak",
      "background-strong",
      "surface-raised-base",
      "surface-raised-strong",
      "v2-background-bg-base",
      "v2-background-bg-deep",
      "v2-background-bg-layer-01",
    ],
  },
  {
    text: ["v2-text-text-base", "v2-text-text-muted"],
    on: ["v2-background-bg-base", "v2-background-bg-deep", "v2-background-bg-layer-01", "background-base"],
  },
]

type RGBA = [number, number, number, number]

function parse(value: string): RGBA | undefined {
  const v = value.trim().toLowerCase()
  const hex = v.match(/^#([0-9a-f]{3,8})$/)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16)
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1]
  }
  const fn = v.match(/^rgba?\(([^)]+)\)$/)?.[1]
  if (fn) {
    const parts = fn.split(/[\s,/]+/).filter(Boolean).map(Number)
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1]
  }
}

function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top[3]
  return [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a)).concat(1) as RGBA
}

function luminance([r, g, b]: RGBA) {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function ratio(a: RGBA, b: RGBA) {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const hex = (c: RGBA) => "#" + c.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")

export function resolveAll(theme: DesktopTheme, mode: "light" | "dark") {
  const variant = theme[mode]
  const isDark = mode === "dark"
  const tokens: Record<string, string> = {
    ...(resolveThemeVariant(variant, isDark) as Record<string, string>),
    ...(resolveThemeVariantV2(variant, isDark) as Record<string, string>),
  }
  const lookup = (name: string, depth = 0): string | undefined => {
    let value = tokens[name]
    if (value === undefined || depth > 10) return
    const ref = value.match(/^var\(--([\w-]+)(?:,\s*([^)]+))?\)$/)
    if (ref) return lookup(ref[1]!, depth + 1) ?? ref[2]
    return value
  }
  return lookup
}

export type Finding = { theme: string; mode: string; text: string; on: string; ratio: number; fg: string; bg: string }

export function checkTheme(theme: DesktopTheme): { findings: Finding[]; skipped: string[] } {
  const findings: Finding[] = []
  const skipped: string[] = []
  for (const mode of ["light", "dark"] as const) {
    const lookup = resolveAll(theme, mode)
    const color = (name: string) => {
      const raw = lookup(name)
      return raw ? parse(raw) : undefined
    }
    const ground = color("background-base") ?? [255, 255, 255, 1]
    const deep = color("v2-background-bg-deep") ?? ground
    const solid = (name: string): RGBA | undefined => {
      const c = color(name)
      if (!c) return
      if (c[3] >= 1) return c
      // Translucent layers sit on their family's ground.
      return over(c, name.startsWith("v2-") ? over(deep, ground) : over(ground, [255, 255, 255, 1]))
    }
    for (const pair of PAIRS) {
      for (const bgName of pair.on) {
        const bg = solid(bgName)
        if (!bg) {
          skipped.push(`${theme.id} ${mode} ${bgName}`)
          continue
        }
        for (const textName of pair.text) {
          const raw = color(textName)
          if (!raw) {
            skipped.push(`${theme.id} ${mode} ${textName}`)
            continue
          }
          const fg = raw[3] < 1 ? over(raw, bg) : raw
          findings.push({ theme: theme.id, mode, text: textName, on: bgName, ratio: ratio(fg, bg), fg: hex(fg), bg: hex(bg) })
        }
      }
    }
  }
  return { findings, skipped }
}

if (import.meta.main) {
  const all = process.argv.includes("--all")
  const dir = import.meta.dir + "/../src/theme/themes"
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort((a, b) => Number(TUNED.includes(b)) - Number(TUNED.includes(a)) || a.localeCompare(b))
  let errors = 0
  let warnings = 0
  for (const id of ids) {
    const theme = (await Bun.file(`${dir}/${id}.json`).json()) as DesktopTheme
    const tuned = TUNED.includes(id)
    const { findings } = checkTheme(theme)
    const low = findings.filter((f) => f.ratio < MIN)
    const worst = findings.reduce((a, b) => (b.ratio < a.ratio ? b : a), findings[0]!)
    if (tuned) errors += low.length
    else warnings += low.length
    const tag = low.length === 0 ? "ok  " : tuned ? "FAIL" : "warn"
    console.log(`${tag} ${id.padEnd(22)} ${findings.length} pairs, lowest ${worst.ratio.toFixed(2)}:1 (${worst.mode} ${worst.text} on ${worst.on})`)
    for (const f of all ? findings : tuned ? low : []) {
      console.log(`       ${f.mode.padEnd(5)} ${f.text.padEnd(20)} ${f.fg} on ${f.on.padEnd(26)} ${f.bg}  ${f.ratio.toFixed(2)}:1`)
    }
  }
  console.log(`\n${errors} failing pair(s) in tuned themes (${TUNED.join(", ")}); ${warnings} below ${MIN}:1 in untuned themes (warnings).`)
  process.exit(errors > 0 ? 1 : 0)
}
