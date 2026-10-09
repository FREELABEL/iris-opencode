import { defineConfig } from "vite"
import { fileURLToPath } from "url"
import desktopPlugin from "../vite"

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: here(".."),
  plugins: [
    desktopPlugin,
    {
      name: "preview-stubs",
      enforce: "pre",
      resolveId(id) {
        // The "@" alias has already been applied by the time this runs, so match the path's end.
        const bare = id.replace(/\.(tsx?|jsx?)$/, "")
        if (bare === "@/context/server-sdk" || bare.endsWith("/src/context/server-sdk")) return here("./stub-server-sdk.ts")
        if (bare === "@/context/platform" || bare.endsWith("/src/context/platform")) return here("./stub-platform.ts")
      },
    },
  ] as any,
  server: { port: 4317, host: "127.0.0.1" },
})
