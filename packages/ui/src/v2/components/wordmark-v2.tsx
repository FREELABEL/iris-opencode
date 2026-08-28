import { createUniqueId, type ComponentProps } from "solid-js"

// "IRIS OS", drawn on the same grid upstream used for the "opencode" wordmark, so the
// empty-session screen keeps its proportions and its bottom fade.
//
// The grid is taken from the original paths rather than invented: letters are 73.85 wide on a
// 92 pitch, stroke is 18.46, and the row lines sit at 18 / 54.86 / 91.71 / 110.14. Letters are
// laid out from the array below so the viewBox and the fade gradient follow automatically —
// hardcoding either is how a wordmark ends up clipped after someone changes a letter.

const S = 18.4615 // stroke width
const W = 73.8462 // letter width
const PITCH = 92 // letter-to-letter advance
const SPACE = 46 // extra advance for the word gap
const TOP = 18
const MID = 54.8571
const BOT = 91.7143
const H = 92.1429 // TOP -> 110.143

type Rect = { x: number; y: number; w: number; h: number }

// Each glyph is drawn relative to its own origin.
const GLYPHS: Record<string, (x: number) => Rect[]> = {
  // serifed I: top bar, centre stem, bottom bar
  I: (x) => [
    { x, y: TOP, w: W, h: S },
    { x: x + (W - S) / 2, y: TOP, w: S, h: H },
    { x, y: BOT, w: W, h: S },
  ],
  // R: stem, top bar, upper-right, waist, leg
  R: (x) => [
    { x, y: TOP, w: S, h: H },
    { x, y: TOP, w: W, h: S },
    { x: x + W - S, y: TOP, w: S, h: MID - TOP + S },
    { x, y: MID, w: W, h: S },
    { x: x + W - S, y: MID + S, w: S, h: H - (MID - TOP) - S },
  ],
  // S: top bar, upper-left, waist, lower-right, bottom bar
  S: (x) => [
    { x, y: TOP, w: W, h: S },
    { x, y: TOP, w: S, h: MID - TOP + S },
    { x, y: MID, w: W, h: S },
    { x: x + W - S, y: MID, w: S, h: BOT - MID + S },
    { x, y: BOT, w: W, h: S },
  ],
  // O: a closed box
  O: (x) => [
    { x, y: TOP, w: W, h: S },
    { x, y: TOP, w: S, h: H },
    { x: x + W - S, y: TOP, w: S, h: H },
    { x, y: BOT, w: W, h: S },
  ],
}

const WORD = "IRIS OS"

const { rects, width } = (() => {
  const out: Rect[] = []
  let x = 0
  for (const ch of WORD) {
    if (ch === " ") {
      x += SPACE
      continue
    }
    out.push(...GLYPHS[ch](x))
    x += PITCH
  }
  return { rects: out, width: x - (PITCH - W) }
})()

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} 129`}
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <g opacity="0.16">
            {rects.map((r) => (
              <rect opacity="0.7" x={r.x} y={r.y} width={r.w} height={r.h} fill="currentColor" />
            ))}
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width={width} height="129">
          <rect width={width} height="129" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient
          id={maskGradient}
          x1={width / 2}
          y1="68"
          x2={width / 2}
          y2="129"
          gradientUnits="userSpaceOnUse"
        >
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
