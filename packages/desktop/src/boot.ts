// The one script index.html loads. The iPhone build (#194511) has no engine of its own, so it
// gets its own entry; the desktop entry stays exactly as it was.
import { opencodeGlobal } from "./opencode-global"

// The flag Rust injects, and the user agent in case the injection did not run before this script.
const mobile = opencodeGlobal().mobile || /iPhone|iPad|iPod/.test(navigator.userAgent)

// On the phone there is no devtools and no engine.log: an error before the first render would
// leave the boot splash up forever. Say what broke, on screen.
if (mobile) {
  const show = (what: unknown) => {
    const root = document.getElementById("root")
    if (!root || root.childElementCount) return
    const text = what instanceof Error ? `${what.message}\n${what.stack ?? ""}` : String(what)
    root.innerHTML = ""
    const pre = document.createElement("pre")
    pre.style.cssText = "white-space:pre-wrap;padding:72px 20px 20px;font:12px ui-monospace,monospace;color:#f08a7e"
    pre.textContent = `IRIS could not start\n\n${text}`
    root.append(pre)
  }
  window.addEventListener("error", (event) => show(event.error ?? event.message))
  window.addEventListener("unhandledrejection", (event) => show(event.reason))
}

void (mobile ? import("./mobile") : import("./index"))
