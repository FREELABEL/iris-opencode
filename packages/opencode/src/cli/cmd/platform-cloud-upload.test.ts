import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import {
  DEFAULT_EXPIRES_DAYS,
  expiryDate,
  expiryWarning,
  isPermanentByDefault,
  parseExpiration,
  resolveExpiration,
  tooLargeMessage,
  DIRECT_UPLOAD_THRESHOLD,
} from "./platform-cloud-upload"

// #193366 — `iris cloud:upload` used to default EVERY file to 180 days. Share cards (og:image),
// email images, newsletter figures and ad creatives are referenced forever from pages and emails
// already out, so they would break six months later with no warning. These pin the new defaults.

describe("default expiry by file type", () => {
  test.each(["og-card.png", "Photo.JPG", "fig.webp", "logo.svg", "page.html", "site.css", "deck.pdf", "ad.mp4", "clip.mov", "song.mp3", "Inter.woff2"])(
    "%s is permanent when --expires is not given",
    (name) => {
      const r = resolveExpiration(undefined, name)
      expect(r.permanent).toBe(true)
      expect(r.days).toBe(0)
      expect(r.source).toBe("type")
    },
  )

  test.each(["export.zip", "leads.csv", "notes.txt", "dump.json", "noextension"])(
    "%s keeps the 180-day default, and says so",
    (name) => {
      const r = resolveExpiration(undefined, name)
      expect(r.permanent).toBe(false)
      expect(r.days).toBe(DEFAULT_EXPIRES_DAYS)
      expect(r.label).toContain("default")
    },
  )

  test("type check is by extension only, case-insensitive", () => {
    expect(isPermanentByDefault("A.PNG")).toBe(true)
    expect(isPermanentByDefault("png")).toBe(false)
    expect(isPermanentByDefault("archive.png.zip")).toBe(false)
  })
})

describe("an explicit --expires always wins", () => {
  test("an image can still be given a short life", () => {
    const r = resolveExpiration("7d", "og-card.png")
    expect(r).toMatchObject({ days: 7, permanent: false, source: "flag" })
  })

  test("a zip can be made permanent", () => {
    for (const v of ["never", "permanent", "none", "0"]) {
      expect(resolveExpiration(v, "export.zip")).toMatchObject({ days: 0, permanent: true, source: "flag" })
    }
  })

  test("units parse", () => {
    expect(parseExpiration("90")?.days).toBe(90)
    expect(parseExpiration("12h")?.days).toBe(1)
    expect(parseExpiration("2w")?.days).toBe(14)
    expect(parseExpiration("6mo")?.days).toBe(180)
    expect(parseExpiration("1y")?.days).toBe(365)
  })

  test("an unreadable value is refused, not silently turned into 180 days", () => {
    expect(parseExpiration("forever")).toBeNull()
    expect(() => resolveExpiration("soon", "og-card.png")).toThrow(/Can't read --expires "soon"/)
  })
})

describe("the warning when a link will die", () => {
  const now = new Date("2026-11-13T00:00:00Z")

  test("permanent files get no warning and no date", () => {
    const r = resolveExpiration(undefined, "og-card.png")
    expect(expiryDate(r, null, now)).toBeNull()
    expect(expiryWarning(r, null)).toBeNull()
  })

  test("expiring files name the date and the flag that keeps them", () => {
    const r = resolveExpiration(undefined, "export.zip")
    const date = expiryDate(r, null, now)
    expect(date).toBe("2027-05-12")
    const w = expiryWarning(r, date)!
    expect(w).toContain("STOPS WORKING on 2027-05-12")
    expect(w).toContain("--expires never")
  })

  test("the server's expires_at is preferred over our own arithmetic", () => {
    const r = resolveExpiration("30", "export.zip")
    expect(expiryDate(r, "2026-12-01T10:00:00.000000Z", now)).toBe("2026-12-01")
  })
})

describe("wiring", () => {
  const src = readFileSync(join(import.meta.dir, "platform-cloud-upload.ts"), "utf8")

  test("--expires has no yargs default (a default would make every file look like an explicit choice)", () => {
    const opt = src.slice(src.indexOf('.option("expires"'), src.indexOf('.option("bloq"'))
    expect(opt).not.toMatch(/default:/)
  })

  test("--json carries permanent + warning, and the warning also goes to stderr", () => {
    expect(src).toContain("permanent: expiration.permanent")
    expect(src).toContain("warning,")
    expect(src).toContain("process.stderr.write(`WARNING: ${warning}")
  })
})

// #194118 — a file over the limit printed a pointer to a PHP CLI nobody has, then "Done", and
// exited 0. Anything driving the CLI recorded an upload that never happened.
describe("an upload that did not happen never looks like one that did", () => {
  const src = readFileSync(join(import.meta.dir, "platform-cloud-upload.ts"), "utf8")
  const handler = src.slice(src.indexOf("async handler("))

  test("the too-large message says nothing was uploaded and what to do instead", () => {
    const m = tooLargeMessage(560 * 1024 * 1024)
    expect(m).toContain("560.0 MB")
    expect(m).toContain("95.0 MB")
    expect(m).toContain("nothing was uploaded")
    expect(m).not.toContain("PHP CLI")
  })

  test("the limit is still checked before reading the file", () => {
    expect(handler).toContain("fileSize > DIRECT_UPLOAD_THRESHOLD")
    expect(handler.indexOf("fileSize > DIRECT_UPLOAD_THRESHOLD")).toBeLessThan(handler.indexOf("readFileSync(localPath)"))
    expect(DIRECT_UPLOAD_THRESHOLD).toBe(95 * 1024 * 1024)
  })

  test("only the success path says Done; every failure path goes through fail(), which exits 1", () => {
    expect(handler.match(/prompts\.outro\("Done"\)/g)?.length).toBe(1)
    // the only error print in the handler is the one inside fail()
    expect(handler.match(/prompts\.log\.error\(/g)?.length).toBe(1)
    const failFn = handler.slice(handler.indexOf("const fail ="), handler.indexOf("const fail =") + 200)
    expect(failFn).toContain("process.exitCode = 1")
  })
})

// #194118 — large files go straight to storage: upload-url → PUT → complete.
describe("direct upload", () => {
  const { directUpload, refusalMessage, guessContentType } = require("./platform-cloud-upload")
  const MB = 1024 * 1024

  type Call = { url: string; method: string; body?: any; headers?: any }
  function fakeServer(routes: Record<string, (c: Call) => Response>) {
    const calls: Call[] = []
    const impl = (async (url: string, init: any = {}) => {
      const c: Call = { url, method: init.method ?? "GET", headers: init.headers, body: (() => { try { return JSON.parse(init.body) } catch { return init.body } })() }
      calls.push(c)
      const key = Object.keys(routes).find((k) => url.includes(k))
      if (!key) throw new Error(`unexpected ${url}`)
      return routes[key](c)
    }) as any
    return { calls, impl }
  }
  const json = (status: number, body: any) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  const started = () => json(201, { data: { upload_id: 7, url: "https://bucket.test/k?sig", headers: { "Content-Type": "application/zip" } } })
  const opts = (fetchImpl: any) => ({ path: "/x", filename: "Vintage EP.zip", size: 560 * MB, headers: { Authorization: "Bearer t" }, expiresDays: 30, fetchImpl, body: "bytes" })

  test("start → PUT to the signed URL with the signed headers → complete", async () => {
    const s = fakeServer({
      "/upload-url": started,
      "bucket.test": () => new Response("", { status: 200 }),
      "/uploads/7/complete": () => json(201, { data: { id: 99, share_url: "https://x/content/Cloud/file/99", cdn_url: "https://cdn/k" } }),
    })
    const r = await directUpload(opts(s.impl))
    expect(r).toEqual({ ok: true, data: { id: 99, share_url: "https://x/content/Cloud/file/99", cdn_url: "https://cdn/k" } })
    expect(s.calls.map((c) => c.method)).toEqual(["POST", "PUT", "POST"])
    expect(s.calls[0].body).toMatchObject({ original_filename: "Vintage EP.zip", file_size: 560 * MB, filetype: "application/zip", expires_days: 30 })
    expect(s.calls[1].headers["Content-Type"]).toBe("application/zip")
    expect(s.calls[1].headers.Authorization).toBeUndefined() // never send our token to the bucket
  })

  test("a plan refusal comes back in words, with usage", async () => {
    const s = fakeServer({
      "/upload-url": () => json(413, {
        error: "file_too_large",
        message: "This file is 559.5 MB; the largest file your plan allows is 100.0 MB.",
        storage: { used_bytes: 200 * MB, quota_bytes: 1024 * MB, tier_name: "Free" },
      }),
    })
    const r = await directUpload(opts(s.impl))
    expect(r.ok).toBe(false)
    expect(r.error).toContain("largest file your plan allows is 100.0 MB")
    expect(r.error).toContain("200.0 MB of 1.0 GB on Free")
    expect(s.calls).toHaveLength(1)
  })

  test("an older server without the endpoint gets the honest too-large message", async () => {
    const s = fakeServer({ "/upload-url": () => json(404, { message: "Not Found" }) })
    const r = await directUpload(opts(s.impl))
    expect(r.ok).toBe(false)
    expect(r.error).toContain("nothing was uploaded")
  })

  test("a failed PUT aborts, so nothing is left reserved or stored", async () => {
    const s = fakeServer({
      "/upload-url": started,
      "bucket.test": () => new Response("SignatureDoesNotMatch", { status: 403 }),
      "/uploads/7/abort": () => json(200, { success: true }),
    })
    const r = await directUpload(opts(s.impl))
    expect(r.ok).toBe(false)
    expect(r.error).toContain("HTTP 403")
    expect(r.error).toContain("nothing was kept")
    expect(s.calls.at(-1)!.url).toContain("/uploads/7/abort")
  })

  test("a network error mid-PUT also aborts", async () => {
    const s = fakeServer({
      "/upload-url": started,
      "bucket.test": () => { throw new Error("socket hang up") },
      "/uploads/7/abort": () => json(200, {}),
    })
    const r = await directUpload(opts(s.impl))
    expect(r.error).toContain("socket hang up")
    expect(s.calls.some((c) => c.url.includes("/abort"))).toBe(true)
  })

  test("content types the signed URL is made for", () => {
    expect(guessContentType("Vintage EP.zip")).toBe("application/zip")
    expect(guessContentType("beat.WAV")).toBe("audio/wav")
    expect(guessContentType("stems.unknownext")).toBe("application/octet-stream")
  })

  test("refusal without storage info still reads", () => {
    expect(refusalMessage({ message: "Quota exceeded" }, 413)).toBe("Quota exceeded")
    expect(refusalMessage({}, 413)).toBe("Upload refused (HTTP 413)")
  })

  test("large local files are never read into memory", () => {
    const src = readFileSync(join(import.meta.dir, "platform-cloud-upload.ts"), "utf8")
    const handler = src.slice(src.indexOf("async handler("))
    expect(handler.indexOf("if (direct)")).toBeLessThan(handler.indexOf("readFileSync(localPath)"))
  })
})

describe("cloud:usage", () => {
  const { describeUsage } = require("./platform-cloud-usage")
  test("describes used of quota, or unlimited", () => {
    expect(describeUsage({ used_bytes: 1610612736, quota_bytes: 10737418240 })).toBe("1.5 GB of 10.0 GB (15%)")
    expect(describeUsage({ used_bytes: 1024, quota_bytes: -1 })).toBe("1.0 KB (unlimited)")
  })
})
