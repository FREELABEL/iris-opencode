import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

/**
 * THE OLDEST WEBKIT WE DRAW IN (#191625). On macOS the desktop app renders in the system WebKit,
 * which only moves when the user updates Safari: an Intel iMac on Ventura runs Safari 16.6. CSS
 * that WebKit does not know is dropped without a sound — light-dark() (Safari 17.5) took the
 * Hive cards' borders, fills and buttons with it. Lightning CSS lowers newer syntax to what this
 * target understands when the bundle is minified; light-dark() becomes color-scheme variables,
 * switched by the theme's [data-color-scheme] rules. JS for the same WebKit: src/polyfills.ts.
 */
export const CSS_TARGETS = { safari: 16 << 16 }

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        define: {
          "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
        },
        worker: {
          format: "es",
        },
        css: {
          lightningcss: { targets: CSS_TARGETS },
        },
        build: {
          cssMinify: "lightningcss",
          // Minifying takes its targets from cssTarget, which otherwise inherits build.target
          // "esnext" — lowering nothing. Measured: the bundle kept all 42 light-dark() without it.
          cssTarget: "safari16",
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  tailwindcss(),
  solidPlugin(),
]
