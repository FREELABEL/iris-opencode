import { RGBA } from "@opentui/core"
import { createComponentTimeline, useTimeline } from "@opentui/solid"
import { createMemo } from "solid-js"

export type ShimmerProps = {
  text: string
  color: string
}

const DURATION = 200

export function Shimmer(props: ShimmerProps) {
  const timeline = createComponentTimeline({
    duration: (props.text.length + 1) * DURATION,
    loop: true,
  })
  const characters = props.text.split("")
  const color = createMemo(() => RGBA.fromHex(props.color))

  const animation = characters.map((_, i) =>
    useTimeline(
      timeline,
      { shimmer: 0.4 },
      { shimmer: 1 },
      {
        duration: DURATION,
        ease: "linear",
        alternate: true,
        loop: 2,
      },
      (i * DURATION) / 2,
    ),
  )

  return (
    <text live>
      {(() => {
        return characters.map((ch, i) => {
          const shimmer = animation[i]().shimmer
          const fg = RGBA.fromInts(color().r * 255, color().g * 255, color().b * 255, shimmer * 255)
          return <span style={{ fg }}>{ch}</span>
        })
      })()}
    </text>
  )
}
