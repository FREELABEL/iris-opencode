;(function () {
  var key = "opencode-theme-id"
  // Default theme (#194375): "iris" until a person picks one. Keep in step with ui/src/theme/default-id.ts.
  var themeId = localStorage.getItem(key) || "iris"
  // The IRIS window ground (--v2-background-bg-deep) — used before any theme has been cached.
  var grounds = { light: "#efede8", dark: "#16140f" }

  if (themeId === "oc-1") {
    themeId = "oc-2"
    localStorage.setItem(key, themeId)
    localStorage.removeItem("opencode-theme-css-light")
    localStorage.removeItem("opencode-theme-css-dark")
    localStorage.removeItem("opencode-theme-ground-light")
    localStorage.removeItem("opencode-theme-ground-dark")
  }

  var scheme = localStorage.getItem("opencode-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"
  // One launch colour, from the active theme: the theme provider caches it on every apply.
  var ground = localStorage.getItem("opencode-theme-ground-" + mode) || grounds[mode]

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.backgroundColor = ground

  // Update theme-color meta tag to match app color scheme
  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", ground)

  var css = localStorage.getItem("opencode-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
