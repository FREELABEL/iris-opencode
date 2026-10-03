import { For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"

/**
 * The IRIS product icons, the same ones the heyiris.io nav draws (fl-iris-api
 * resources/js/components/landing/Navbar.vue). Same lucide glyph, same colour, so a product reads
 * as the same thing on the site and in the app.
 *
 * Inline rather than a lucide dependency: eight icons do not justify a package, and the geometry
 * below is copied verbatim from lucide-vue-next (ISC). Change the site and this together.
 *
 * Colour follows the site: products in its Solutions menu carry their Tailwind colour; things the
 * site lists under Resources (Integrations, Models) or not at all (Agents, MCP) are drawn in the
 * text colour, as the site does.
 */
type Shape = [tag: "path" | "rect" | "circle" | "line", attrs: Record<string, string>]

const CHART_COLUMN: Shape[] = [
  ["path", { d: "M3 3v16a2 2 0 0 0 2 2h16" }],
  ["path", { d: "M18 17V9" }],
  ["path", { d: "M13 17V5" }],
  ["path", { d: "M8 17v-3" }],
]
const HAMMER: Shape[] = [
  ["path", { d: "m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9" }],
  ["path", { d: "m18 15 4-4" }],
  [
    "path",
    {
      d: "m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5",
    },
  ],
]
const SCROLL_TEXT: Shape[] = [
  ["path", { d: "M15 12h-5" }],
  ["path", { d: "M15 8h-5" }],
  ["path", { d: "M19 17V5a2 2 0 0 0-2-2H4" }],
  [
    "path",
    { d: "M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" },
  ],
]
const NETWORK: Shape[] = [
  ["rect", { x: "16", y: "16", width: "6", height: "6", rx: "1" }],
  ["rect", { x: "2", y: "16", width: "6", height: "6", rx: "1" }],
  ["rect", { x: "9", y: "2", width: "6", height: "6", rx: "1" }],
  ["path", { d: "M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" }],
  ["path", { d: "M12 12V8" }],
]
const USER_PLUS: Shape[] = [
  ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }],
  ["circle", { cx: "9", cy: "7", r: "4" }],
  ["line", { x1: "19", x2: "19", y1: "8", y2: "14" }],
  ["line", { x1: "22", x2: "16", y1: "11", y2: "11" }],
]
const BOT: Shape[] = [
  ["path", { d: "M12 8V4H8" }],
  ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }],
  ["path", { d: "M2 14h2" }],
  ["path", { d: "M20 14h2" }],
  ["path", { d: "M15 13v2" }],
  ["path", { d: "M9 13v2" }],
]
const PLUG: Shape[] = [
  ["path", { d: "M12 22v-5" }],
  ["path", { d: "M9 8V2" }],
  ["path", { d: "M15 8V2" }],
  ["path", { d: "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" }],
]

/** Surface id → glyph and colour. Colours are Tailwind's, as the site uses them. */
export const PRODUCT_ICONS: Record<string, { shapes: Shape[]; color?: string }> = {
  atlas: { shapes: CHART_COLUMN, color: "#f59e0b" }, // amber-500
  pages: { shapes: HAMMER, color: "#84cc16" }, // Genesis — lime-500
  playbooks: { shapes: SCROLL_TEXT, color: "#c084fc" }, // purple-400
  hive: { shapes: NETWORK, color: "#f59e0b" }, // amber-500
  leads: { shapes: USER_PLUS, color: "#10b981" }, // ReachR — emerald-500
  agents: { shapes: BOT },
  integrations: { shapes: NETWORK }, // the site's Resources › Integrations
  mcp: { shapes: PLUG },
}

export function IrisProductIcon(props: { id: string; size?: number }) {
  const icon = () => PRODUCT_ICONS[props.id]
  return (
    <Show when={icon()}>
      {(i) => (
        <svg
          class="iris-product-icon shrink-0"
          data-product-icon={props.id}
          width={props.size ?? 14}
          height={props.size ?? 14}
          viewBox="0 0 24 24"
          fill="none"
          stroke={i().color ?? "currentColor"}
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <For each={i().shapes}>{([tag, attrs]) => <Dynamic component={tag} {...attrs} />}</For>
        </svg>
      )}
    </Show>
  )
}
