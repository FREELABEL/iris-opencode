// Prebuilt light shows for `iris home run <template>` (#185775).
//
// Written in TypeScript, not shipped as .py files: the released CLI is a single compiled
// binary and loose files beside the source do not survive `--compile`. Rooms come from the
// client's own registry, never from a hardcoded list, so every template works in any home.
//
// Photosensitivity floor: no template may change state faster than MIN_STEP_MS, and "dark"
// moments dim to the lowest brightness instead of switching lights off — a template must
// never leave someone in a room in sudden darkness. Both are enforced by tests.

import type { Verbs } from "./home-core"

export const MIN_STEP_MS = 100

export interface TemplateCtx {
  /** distinct rooms from the registry, in registry order */
  rooms: string[]
  send(room: string, verbs: Verbs): Promise<void>
  sleep(ms: number): Promise<void>
  random(): number
  /** ms clock — injected so timed shows can be tested without waiting */
  now(): number
  /** seconds requested with --duration, when the template supports it */
  duration?: number
}

export interface Template {
  name: string
  description: string
  seconds: number
  /** true when --duration stretches the show */
  stretch?: boolean
  play(ctx: TemplateCtx): Promise<void>
}

const hue = (h: number, sat = 254): Verbs => ({ hue: h, sat })
const C: Record<string, Verbs> = {
  hotPink: hue(58500),
  bubblegum: hue(60000, 140),
  magenta: hue(54500),
  blush: hue(62000, 80),
  pumpkin: hue(5500),
  ember: hue(3000),
  witch: hue(48500),
  toxic: hue(22000),
  blood: hue(0),
  purple: hue(46920),
  blue: hue(42000),
  red: hue(0),
  green: hue(25500),
  cyan: hue(34000),
  amber: hue(8000, 200),
  orange: hue(5000),
  pink: hue(55000, 150),
  sparkle: { ct: 153 },
  warm: { ct: 340 },
}

const pick = <T>(ctx: TemplateCtx, xs: T[]): T => xs[Math.floor(ctx.random() * xs.length) % xs.length]
const between = (ctx: TemplateCtx, lo: number, hi: number) => Math.round(lo + ctx.random() * (hi - lo))
const on = (ctx: TemplateCtx, room: string, c: Verbs, bri = 254) => ctx.send(room, { on: true, bri, ...c })
const each = (ctx: TemplateCtx, fn: (room: string, i: number) => Promise<void>) =>
  Promise.all(ctx.rooms.map((r, i) => fn(r, i)))
const deadline = (ctx: TemplateCtx, fallback: number) => ctx.now() + (ctx.duration ?? fallback) * 1000

export const TEMPLATES: Template[] = [
  {
    name: "disco",
    description: "random party colors in every room",
    seconds: 30,
    stretch: true,
    async play(ctx) {
      const palette = [C.purple, C.blue, C.red, C.green, C.cyan, C.amber, C.pink, C.orange]
      const end = deadline(ctx, 30)
      while (ctx.now() < end) {
        await each(ctx, (room) => on(ctx, room, pick(ctx, palette)))
        await ctx.sleep(250)
      }
      await on(ctx, "all", C.blue)
    },
  },
  {
    name: "barbie",
    description: "hot pink breathe, room chase, white sparkle, fast finale",
    seconds: 24,
    async play(ctx) {
      for (let n = 0; n < 3; n++) {
        await on(ctx, "all", C.hotPink); await ctx.sleep(500)
        await on(ctx, "all", C.bubblegum, 90); await ctx.sleep(500)
      }
      const r = ctx.rooms
      for (let n = 0; n < 4; n++) {
        for (let i = 0; i < r.length; i++) {
          await on(ctx, r[i], C.hotPink)
          if (r.length > 1) await on(ctx, r[(i + 1) % r.length], C.blush, 120)
          if (r.length > 2) await on(ctx, r[(i + 2) % r.length], C.magenta, 160)
          await ctx.sleep(300)
        }
      }
      for (let i = 0; i < 12; i++) {
        const room = r[i % r.length]
        await on(ctx, room, C.sparkle); await ctx.sleep(120)
        await on(ctx, room, [C.hotPink, C.magenta, C.bubblegum][i % 3]); await ctx.sleep(180)
      }
      for (const wait of [400, 320, 250, 200, 160, 130, 110, 100, 100, 100]) {
        await on(ctx, "all", C.hotPink); await ctx.sleep(wait)
        await on(ctx, "all", C.magenta, 140); await ctx.sleep(wait)
      }
      await on(ctx, "all", C.sparkle); await ctx.sleep(250)
      await on(ctx, "all", C.hotPink)
    },
  },
  {
    name: "halloween",
    description: "pumpkin flicker, purple fog, lightning, cauldron, a (gentle) jump scare",
    seconds: 35,
    async play(ctx) {
      const dim = (room: string) => on(ctx, room, C.witch, 1)
      for (let n = 0; n < 24; n++) {
        await each(ctx, (room) => on(ctx, room, pick(ctx, [C.pumpkin, C.ember]), between(ctx, 60, 200)))
        await ctx.sleep(between(ctx, 150, 260))
      }
      for (let n = 0; n < 3; n++) {
        for (const room of ctx.rooms) {
          await each(ctx, (other) => (other === room ? on(ctx, other, C.witch, 180) : on(ctx, other, C.witch, 15)))
          await ctx.sleep(600)
        }
      }
      await dim("all"); await ctx.sleep(1200)
      for (let n = 0; n < 4; n++) {
        await on(ctx, "all", C.sparkle); await ctx.sleep(250)
        await dim("all"); await ctx.sleep(between(ctx, 900, 1500))
      }
      for (let n = 0; n < 14; n++) {
        await each(ctx, (room) => on(ctx, room, pick(ctx, [C.toxic, C.witch]), between(ctx, 50, 230)))
        await ctx.sleep(250)
      }
      await dim("all"); await ctx.sleep(2500)
      await on(ctx, "all", C.blood); await ctx.sleep(1500)
      await on(ctx, "all", C.pumpkin, 120)
    },
  },
  {
    name: "christmas",
    description: "red and green trade places room to room, with twinkles",
    seconds: 30,
    stretch: true,
    async play(ctx) {
      const end = deadline(ctx, 30)
      let flip = 0
      while (ctx.now() < end) {
        await each(ctx, (room, i) => on(ctx, room, (i + flip) % 2 ? C.green : C.red))
        await ctx.sleep(900)
        if (ctx.random() < 0.4) {
          const room = pick(ctx, ctx.rooms)
          await on(ctx, room, C.sparkle); await ctx.sleep(150)
          await on(ctx, room, (ctx.rooms.indexOf(room) + flip) % 2 ? C.green : C.red)
        }
        flip++
      }
      await on(ctx, "all", C.warm, 200)
    },
  },
  {
    name: "sunrise",
    description: "slow wake-up: deep red to amber to bright daylight (default 5 min)",
    seconds: 300,
    stretch: true,
    async play(ctx) {
      const stops: Verbs[] = [
        { ...C.red, bri: 1 }, { ...C.ember, bri: 40 }, { ...C.orange, bri: 90 },
        { ...C.amber, bri: 150 }, { ct: 400, bri: 200 }, { ct: 250, bri: 254 },
      ]
      const total = (ctx.duration ?? 300) * 1000
      const step = Math.max(MIN_STEP_MS, Math.round(total / stops.length))
      for (const s of stops) {
        await ctx.send("all", { on: true, ...s, transitiontime: Math.round(step / 100) })
        await ctx.sleep(step)
      }
    },
  },
  {
    name: "chill",
    description: "slow ocean drift through blues and purples",
    seconds: 60,
    stretch: true,
    async play(ctx) {
      const end = deadline(ctx, 60)
      while (ctx.now() < end) {
        await each(ctx, (room) => on(ctx, room, pick(ctx, [C.blue, C.cyan, C.purple, C.witch]), between(ctx, 70, 160)))
        await ctx.sleep(3000)
      }
    },
  },
]

export function findTemplate(name: string): Template | undefined {
  const n = name.toLowerCase()
  return TEMPLATES.find((t) => t.name === n)
}
