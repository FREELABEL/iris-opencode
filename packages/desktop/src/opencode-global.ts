// The bridge values Rust injects into the webview, in one typed place.
//
// src-tauri/src/lib.rs sets these via initialization_script before any app code runs:
//
//     window.__OPENCODE__ ??= {}
//     window.__OPENCODE__.updaterEnabled = <bool>
//     window.__OPENCODE__.port           = <u16>
//
// Upstream declares `Window.__OPENCODE__` as `{ deepLinks?: string[] }` (app.tsx). Those
// are OUR additions, and the nested object type cannot be widened by declaration merging,
// so the cast lives here — once, named, documented — instead of at every call site.
//
// Note the DOUBLE underscore. `window.OPENCODE` is a different (non-existent) thing.
type OpencodeBridge = {
  deepLinks?: string[]
  updaterEnabled?: boolean
  port?: number
}

export function opencodeGlobal(): OpencodeBridge {
  return (window.__OPENCODE__ ?? {}) as OpencodeBridge
}
