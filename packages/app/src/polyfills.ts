// The desktop app renders in the OS webview, not a bundled browser. On macOS that is
// the system WebKit, which only updates when the user updates Safari — an Intel iMac on
// Ventura with Safari 16.6 crashed on Home because Map.groupBy (Safari 17.4) was missing
// (#191428). The bundle is not polyfilled, so every runtime API newer than the oldest
// WebKit we support has to be filled in here, before any app code runs.
//
// Only APIs the shipped bundle actually calls unguarded belong here. polyfills.test.ts
// fails if app source starts using one of the newer APIs it lists without adding it.

type Grouper<T, K> = (item: T, index: number) => K

export function installPolyfills() {
  if (typeof Map.groupBy !== "function") {
    Object.defineProperty(Map, "groupBy", {
      configurable: true,
      writable: true,
      value: function groupBy<T, K>(items: Iterable<T>, key: Grouper<T, K>) {
        const out = new Map<K, T[]>()
        let index = 0
        for (const item of items) {
          const k = key(item, index++)
          const list = out.get(k)
          if (list) list.push(item)
          else out.set(k, [item])
        }
        return out
      },
    })
  }

  if (typeof Object.groupBy !== "function") {
    Object.defineProperty(Object, "groupBy", {
      configurable: true,
      writable: true,
      value: function groupBy<T>(items: Iterable<T>, key: Grouper<T, PropertyKey>) {
        const out: Partial<Record<PropertyKey, T[]>> = Object.create(null)
        let index = 0
        for (const item of items) {
          const k = key(item, index++)
          ;(out[k] ??= []).push(item)
        }
        return out
      },
    })
  }

  if (typeof Promise.withResolvers !== "function") {
    Object.defineProperty(Promise, "withResolvers", {
      configurable: true,
      writable: true,
      value: function withResolvers<T>() {
        let resolve!: (value: T | PromiseLike<T>) => void
        let reject!: (reason?: unknown) => void
        const promise = new Promise<T>((res, rej) => {
          resolve = res
          reject = rej
        })
        return { promise, resolve, reject }
      },
    })
  }

  if (typeof URL.canParse !== "function") {
    Object.defineProperty(URL, "canParse", {
      configurable: true,
      writable: true,
      value: function canParse(url: string | URL, base?: string | URL) {
        try {
          new URL(url, base)
          return true
        } catch {
          return false
        }
      },
    })
  }
}

installPolyfills()
