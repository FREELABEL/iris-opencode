import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))
const fontDir = fileURLToPath(new URL("./public/assets", import.meta.url))
/** True when the host serves packages/app/public itself (then vite copies the fonts already). */
let ownPublic = false
const fonts = () => readdirSync(fontDir).filter((name) => name.endsWith(".woff2"))

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
    // The fonts live in packages/app/public/assets. Hosts with their own public dir (packages/desktop)
    // get them too, at the same /assets/<name> URL the @font-face rules use (#194375).
    name: "opencode-desktop:fonts",
    configResolved(config) {
      ownPublic = config.publicDir === fileURLToPath(new URL("./public", import.meta.url))
    },
    configureServer(server) {
      if (ownPublic) return
      server.middlewares.use((req, res, next) => {
        const name = req.url?.match(/^\/assets\/([\w.-]+\.woff2)$/)?.[1]
        if (!name || !fonts().includes(name)) return next()
        res.setHeader("content-type", "font/woff2")
        res.end(readFileSync(join(fontDir, name)))
      })
    },
    generateBundle() {
      if (ownPublic) return
      for (const name of fonts()) {
        this.emitFile({ type: "asset", fileName: `assets/${name}`, source: readFileSync(join(fontDir, name)) })
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
