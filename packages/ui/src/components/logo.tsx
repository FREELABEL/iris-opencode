import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M12 16H4V8H12V16Z" fill="var(--icon-weak-base)" />
      <path data-slot="logo-logo-mark-o" d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

// "IRIS OS" on the grid the original opencode wordmark used here: letters 24 wide on a 30
// pitch, 6 stroke, rows at 6 / 18 / 30 / 36. Rendered on the error screen and legacy home.
// Laid out from an array so the viewBox follows the word instead of being hardcoded.
const LOGO_S = 6
const LOGO_W = 24
const LOGO_PITCH = 30
const LOGO_SPACE = 15
const LOGO_TOP = 6
const LOGO_MID = 18
const LOGO_BOT = 30
const LOGO_H = 30

type LogoRect = { x: number; y: number; w: number; h: number }

const LOGO_GLYPHS: Record<string, (x: number) => LogoRect[]> = {
  I: (x) => [
    { x, y: LOGO_TOP, w: LOGO_W, h: LOGO_S },
    { x: x + (LOGO_W - LOGO_S) / 2, y: LOGO_TOP, w: LOGO_S, h: LOGO_H },
    { x, y: LOGO_BOT, w: LOGO_W, h: LOGO_S },
  ],
  R: (x) => [
    { x, y: LOGO_TOP, w: LOGO_S, h: LOGO_H },
    { x, y: LOGO_TOP, w: LOGO_W, h: LOGO_S },
    { x: x + LOGO_W - LOGO_S, y: LOGO_TOP, w: LOGO_S, h: LOGO_MID - LOGO_TOP + LOGO_S },
    { x, y: LOGO_MID, w: LOGO_W, h: LOGO_S },
    { x: x + LOGO_W - LOGO_S, y: LOGO_MID + LOGO_S, w: LOGO_S, h: LOGO_H - (LOGO_MID - LOGO_TOP) - LOGO_S },
  ],
  S: (x) => [
    { x, y: LOGO_TOP, w: LOGO_W, h: LOGO_S },
    { x, y: LOGO_TOP, w: LOGO_S, h: LOGO_MID - LOGO_TOP + LOGO_S },
    { x, y: LOGO_MID, w: LOGO_W, h: LOGO_S },
    { x: x + LOGO_W - LOGO_S, y: LOGO_MID, w: LOGO_S, h: LOGO_BOT - LOGO_MID + LOGO_S },
    { x, y: LOGO_BOT, w: LOGO_W, h: LOGO_S },
  ],
  O: (x) => [
    { x, y: LOGO_TOP, w: LOGO_W, h: LOGO_S },
    { x, y: LOGO_TOP, w: LOGO_S, h: LOGO_H },
    { x: x + LOGO_W - LOGO_S, y: LOGO_TOP, w: LOGO_S, h: LOGO_H },
    { x, y: LOGO_BOT, w: LOGO_W, h: LOGO_S },
  ],
}

const LOGO = (() => {
  const out: LogoRect[] = []
  let x = 0
  for (const ch of "IRIS OS") {
    if (ch === " ") {
      x += LOGO_SPACE
      continue
    }
    out.push(...LOGO_GLYPHS[ch](x))
    x += LOGO_PITCH
  }
  return { rects: out, width: x - (LOGO_PITCH - LOGO_W) }
})()

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${LOGO.width} 42`}
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        {LOGO.rects.map((r) => (
          <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="var(--icon-base)" />
        ))}
      </g>
    </svg>
  )
}
