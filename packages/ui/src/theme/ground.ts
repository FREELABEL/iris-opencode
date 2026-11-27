import { resolveThemeVariantV2 } from "./v2/resolve"
import type { DesktopTheme } from "./types"

/** The window ground (`--v2-background-bg-deep`) of a theme variant, as a hex colour. */
export function themeGround(variant: DesktopTheme["light"], isDark: boolean) {
  const tokens = resolveThemeVariantV2(variant, isDark) as Record<string, string>
  let value = tokens["v2-background-bg-deep"] ?? ""
  for (let i = 0; i < 8 && value.startsWith("var(--"); i++) value = tokens[value.slice(6, -1)] ?? ""
  if (!value.startsWith("#")) return isDark ? "#16140f" : "#efede8"
  return value.length === 9 ? value.slice(0, 7) : value
}
