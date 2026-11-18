/**
 * The IRIS tool marks: one small icon per product, before a tool row's title in the chat.
 *
 * ONE FAMILY. They are the product strip's own lucide glyphs (app iris-product-icon.tsx) in the
 * same colours, so a Genesis row in the chat looks like the Genesis tab. The set is in the IRIS
 * brand kit (design tokens › icons.products), which is where a new product gets its mark first.
 *
 *  - While the step runs: full colour, a soft glow, and one small motion that says what it does
 *    (the globe turns, the lens sweeps, the hammer taps, the bars rise, the divider slides, the
 *    bot bobs). Reduced motion holds still.
 *  - Done: the same mark, quieter (about 70%), so a long run reads calmly.
 */
import { For, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"

type Shape = [tag: "path" | "circle" | "rect", attrs: Record<string, string>]

export type ToolMarkProduct = "browser" | "websearch" | "genesis" | "atlas" | "panel" | "agents"

/** Glyph, colour, and the motion it makes while running. Colours match the product strip. */
export const TOOL_MARKS: Record<ToolMarkProduct, { color: string; motion: string; shapes: Shape[] }> = {
  // lucide "globe" (the Browser tab), teal-500
  browser: {
    color: "#14b8a6",
    motion: "turn",
    shapes: [
      ["circle", { cx: "12", cy: "12", r: "10" }],
      ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20", "data-part": "spin" }],
      ["path", { d: "M2 12h20" }],
    ],
  },
  // lucide "search", sky-500: the IRIS glow cyan. Out on the internet.
  websearch: {
    color: "#0ea5e9",
    motion: "sweep",
    shapes: [
      ["circle", { cx: "11", cy: "11", r: "8" }],
      ["path", { d: "m21 21-4.3-4.3" }],
    ],
  },
  // lucide "hammer" (Genesis), lime-500
  genesis: {
    color: "#84cc16",
    motion: "tap",
    shapes: [
      ["path", { d: "m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9" }],
      ["path", { d: "m18 15 4-4" }],
      [
        "path",
        {
          d: "m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5",
        },
      ],
    ],
  },
  // lucide "chart-column" (Atlas), amber-500
  atlas: {
    color: "#f59e0b",
    motion: "rise",
    shapes: [
      ["path", { d: "M3 3v16a2 2 0 0 0 2 2h16" }],
      ["path", { d: "M18 17V9", "data-part": "bar" }],
      ["path", { d: "M13 17V5", "data-part": "bar" }],
      ["path", { d: "M8 17v-3", "data-part": "bar" }],
    ],
  },
  // lucide "panel-right", neutral: it is the app itself
  panel: {
    color: "#a3a3a3",
    motion: "slide",
    shapes: [
      ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
      ["path", { d: "M15 3v18", "data-part": "divider" }],
    ],
  },
  // lucide "bot" (Agents), pink-500
  agents: {
    color: "#ec4899",
    motion: "bob",
    shapes: [
      ["path", { d: "M12 8V4H8" }],
      ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }],
      ["path", { d: "M2 14h2" }],
      ["path", { d: "M20 14h2" }],
      ["path", { d: "M15 13v2" }],
      ["path", { d: "M9 13v2" }],
    ],
  },
}

export function ToolMark(props: { product: ToolMarkProduct; working: boolean }): JSX.Element {
  const mark = () => TOOL_MARKS[props.product]
  return (
    <span
      data-slot="tool-mark"
      data-product={props.product}
      data-motion={mark().motion}
      data-working={props.working ? "true" : undefined}
      style={{ "--tool-mark-color": mark().color }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <For each={mark().shapes}>{([tag, attrs]) => <Dynamic component={tag} {...attrs} />}</For>
      </svg>
    </span>
  )
}
