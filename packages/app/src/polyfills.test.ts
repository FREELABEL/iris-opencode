import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { installPolyfills } from "./polyfills"

// Each entry: the global that owns it and the name to strip, so a test can run as if on
// Safari 16 (the system webview on an un-updated Ventura Mac, #191428).
const FILLED = [
  [Map, "groupBy"],
  [Object, "groupBy"],
  [Promise, "withResolvers"],
  [URL, "canParse"],
] as const

const saved = FILLED.map(([owner, name]) => [owner, name, Object.getOwnPropertyDescriptor(owner, name)] as const)

// Shadow rather than delete: under happy-dom some of these are inherited (URL.canParse),
// and deleting an own property would leave the native one answering — a test that cannot fail.
function strip() {
  for (const [owner, name] of FILLED)
    Object.defineProperty(owner, name, { value: undefined, configurable: true, writable: true })
}

function asOldWebKit() {
  strip()
  installPolyfills()
}

afterEach(() => {
  for (const [owner, name, desc] of saved) {
    if (desc) Object.defineProperty(owner, name, desc)
    else delete (owner as any)[name]
  }
})

describe("polyfills on a webview that lacks them", () => {
  test("every filled API is missing before install and present after", () => {
    strip()
    for (const [owner, name] of FILLED) expect(typeof (owner as any)[name]).toBe("undefined")
    installPolyfills()
    for (const [owner, name] of FILLED) {
      expect(typeof (owner as any)[name]).toBe("function")
      expect(Object.getOwnPropertyDescriptor(owner, name)?.value).not.toBe(
        saved.find(([o, n]) => o === owner && n === name)?.[2]?.value,
      )
    }
  })

  test("Map.groupBy keeps first-seen key order and item order", () => {
    asOldWebKit()
    const grouped = Map.groupBy(["a1", "b1", "a2", "c1", "b2"], (s) => s[0])
    expect([...grouped.keys()]).toEqual(["a", "b", "c"])
    expect(grouped.get("a")).toEqual(["a1", "a2"])
    expect(grouped.get("b")).toEqual(["b1", "b2"])
  })

  test("Object.groupBy returns a null-prototype record", () => {
    asOldWebKit()
    const grouped = Object.groupBy([1, 2, 3, 4], (n) => (n % 2 ? "odd" : "even"))
    expect(Object.getPrototypeOf(grouped)).toBeNull()
    expect({ ...grouped }).toEqual({ odd: [1, 3], even: [2, 4] })
  })

  test("Promise.withResolvers settles from outside", async () => {
    asOldWebKit()
    const ok = Promise.withResolvers<number>()
    ok.resolve(7)
    expect(await ok.promise).toBe(7)
    const bad = Promise.withResolvers<number>()
    bad.reject(new Error("no"))
    await expect(bad.promise).rejects.toThrow("no")
  })

  test("URL.canParse answers instead of throwing", () => {
    asOldWebKit()
    expect(URL.canParse("https://heyiris.io/x")).toBe(true)
    expect(URL.canParse("/relative")).toBe(false)
    expect(URL.canParse("/relative", "https://heyiris.io")).toBe(true)
    expect(URL.canParse("not a url")).toBe(false)
  })

  test("a native implementation is left alone", () => {
    const native = Map.groupBy
    installPolyfills()
    expect(Map.groupBy).toBe(native)
  })
})

// Runtime APIs newer than Safari 16.6 that are NOT filled in above. Using one in shipped
// UI code crashes the app on an un-updated Mac. Either avoid it or add it to polyfills.ts.
const TOO_NEW = [
  {
    api: "Set.prototype.union & co (Safari 17)",
    re: /\bnew Set\b[^;\n]*\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/,
  },
  {
    api: "Iterator helpers (Safari 18.4)",
    re: /\bIterator\.from\(|\.(values|keys|entries)\(\)\.(map|filter|take|drop|flatMap|reduce|toArray|forEach|some|every|find)\(/,
  },
  { api: "Promise.try (Safari 18.2)", re: /\bPromise\.try\(/ },
  { api: "RegExp.escape (Safari 18.2)", re: /\bRegExp\.escape\(/ },
  { api: "Uint8Array base64 (Safari 18.2)", re: /\bUint8Array\.fromBase64\(|\.toBase64\(\)|\bUint8Array\.fromHex\(/ },
  { api: "Math.sumPrecise", re: /\bMath\.sumPrecise\(/ },
  { api: "Error.isError", re: /\bError\.isError\(/ },
  { api: "ArrayBuffer transfer (Safari 17.4)", re: /\.transferToFixedLength\(/ },
  { api: "URL.parse (Safari 18)", re: /\bURL\.parse\(/ },
]

const ROOTS = ["../../app/src", "../../ui/src", "../../desktop/src"].map((p) => join(import.meta.dir, p))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe("UI source stays within what old macOS webviews can run", () => {
  test("no runtime API newer than Safari 16.6 unless polyfills.ts fills it", () => {
    const hits: string[] = []
    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (/^\s*(\/\/|\*)/.test(line)) return
            for (const { api, re } of TOO_NEW)
              if (re.test(line)) hits.push(`${relative(join(import.meta.dir, "../.."), file)}:${i + 1} — ${api}`)
          })
      }
    }
    expect(hits).toEqual([])
  })
})
