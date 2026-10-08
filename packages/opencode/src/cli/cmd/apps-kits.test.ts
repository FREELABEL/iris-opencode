import { describe, expect, test } from "bun:test"
import {
  buildRunScript,
  buildVerifyScript,
  containerName,
  kitSlug,
  matchKits,
  noKitAdvice,
  parsePort,
  parseVerifyOutput,
  recordTitle,
  runnableReason,
  safeInstanceName,
  shq,
  words,
  type Kit,
} from "./apps-kits"

// A slice of the real `hive-app-kits` dataset (2026-10-07), verdicts included on purpose:
// the verdict prose is where the playbook's first matcher went wrong.
const KITS: Kit[] = [
  {
    name: "Stirling-PDF",
    kind: "app",
    order: "1",
    image: "stirlingtools/stirling-pdf:latest-ultra-lite",
    port: "8080",
    replaces: "Paid PDF editors (Adobe Acrobat, Smallpdf, iLovePDF): edit, merge, split, rotate, convert, OCR",
    verdict: "ADOPT as kit #1.",
  },
  {
    name: "AppFlowy",
    kind: "app",
    order: "2",
    image: "appflowyinc/appflowy_cloud (self-host stack)",
    replaces: "Notion (wiki, docs, projects)",
  },
  { name: "open-lovable", kind: "app", order: "3", port: "3000", replaces: "Paid AI site builders (Lovable, Bolt, v0)" },
  {
    name: "SkillSpector",
    kind: "capability",
    order: "12",
    replaces: "Manual review of third-party skills",
    verdict: "ADOPT as a check on marketplace playbooks (next to the pre-push playbook scan).",
  },
  { name: "Twenty", kind: "have", order: "20", image: "twentycrm/twenty", port: "3000", replaces: "Salesforce / HubSpot" },
  { name: "DeepSeek-OCR", kind: "capability", order: "4", replaces: "Paid OCR / document capture" },
]

describe("matching", () => {
  test("the owner's example finds Stirling-PDF", () => {
    const m = matchKits("edit and merge PDFs", KITS)
    expect(m[0]?.kit.name).toBe("Stirling-PDF")
    expect(m[0]?.matched).toEqual(expect.arrayContaining(["edit", "merge", "pdfs"]))
  })

  test('"book" must NOT match "playbooks" — verdict prose is never searched', () => {
    expect(matchKits("book a haircut appointment", KITS)).toEqual([])
  })

  test("whole words only: a fragment inside a word does not match", () => {
    // "vable" sits inside "Lovable" but starts no word, so it must not match.
    expect(matchKits("vable", KITS)).toEqual([])
  })

  test("kind `have` is never a candidate (IRIS already does it)", () => {
    expect(matchKits("a CRM like Salesforce", KITS).map((m) => m.kit.name)).not.toContain("Twenty")
  })

  test("stop words alone match nothing", () => {
    expect(matchKits("I need an app for my team", KITS)).toEqual([])
    expect(words("the app for my software")).toEqual(new Set())
  })

  test("ties break on catalogue order", () => {
    const m = matchKits("ocr", KITS)
    expect(m.map((x) => x.kit.name)).toEqual(["Stirling-PDF", "DeepSeek-OCR"])
  })

  test("--kit pins by name prefix and skips matching", () => {
    expect(matchKits("anything at all", KITS, "stirling")[0]?.kit.name).toBe("Stirling-PDF")
    expect(matchKits("edit pdfs", KITS, "nope")).toEqual([])
  })
})

describe("runnable", () => {
  test("a single image with a port is runnable", () => {
    expect(runnableReason(KITS[0]!)).toEqual({ ok: true, image: "stirlingtools/stirling-pdf:latest-ultra-lite", port: 8080 })
  })
  test("a multi-service stack is refused", () => {
    const r = runnableReason(KITS[1]!)
    expect(r.ok).toBe(false)
  })
  test("no image is refused", () => {
    expect(runnableReason(KITS[2]!).ok).toBe(false)
  })
  test("a capability is not an app", () => {
    expect(runnableReason(KITS[3]!).ok).toBe(false)
  })
  test("an image with shell metacharacters is refused", () => {
    expect(runnableReason({ name: "x", kind: "app", image: "foo;rm -rf /", port: 80 }).ok).toBe(false)
  })
})

describe("names and ports", () => {
  test("slug", () => {
    expect(kitSlug(KITS[0]!)).toBe("stirling-pdf")
    expect(kitSlug({ name: "openrig / agenticSeek" })).toBe("openrig")
    expect(containerName("stirling-pdf")).toBe("hiveapp-stirling-pdf")
  })
  test("instance names are container-safe or refused", () => {
    expect(safeInstanceName("PDF-test")).toBe("pdf-test")
    expect(safeInstanceName("a b")).toBeNull()
    expect(safeInstanceName("$(x)")).toBeNull()
  })
  test("ports: unprivileged only", () => {
    expect(parsePort("8092")).toBe(8092)
    expect(parsePort(80)).toBeNull()
    expect(parsePort("x")).toBeNull()
  })
  test("shq quotes single quotes", () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`)
  })
  test("record title fits the 191-char limit", () => {
    expect(recordTitle(KITS[0]!, "n", 8091, "x".repeat(400)).length).toBeLessThanOrEqual(191)
  })
})

describe("run script", () => {
  const base = { container: "hiveapp-stirling-pdf", image: "stirlingtools/stirling-pdf:latest-ultra-lite", hostPort: 8092, containerPort: 8080, slug: "stirling-pdf" }

  test("binds to localhost only", () => {
    const s = buildRunScript({ ...base, replace: false })
    expect(s).toContain(`-p '127.0.0.1:8092:8080'`)
    expect(s).not.toMatch(/-p '?0\.0\.0\.0/)
    expect(s).not.toMatch(/-p '?\d+:\d+'?/)
  })

  test("does not remove an existing container unless asked", () => {
    const s = buildRunScript({ ...base, replace: false })
    expect(s).not.toContain("docker rm")
    expect(s).toContain("EXISTS:")
    expect(buildRunScript({ ...base, replace: true })).toContain("docker rm -f 'hiveapp-stirling-pdf'")
  })

  test("verify script accepts 2xx/3xx and fails closed otherwise", () => {
    const v = buildVerifyScript(8092, 60)
    expect(v).toContain("http://127.0.0.1:8092/")
    expect(v).toContain("seq 1 30")
    expect(v.trim().endsWith("exit 1")).toBe(true)
  })

  test("verify output parsing", () => {
    expect(parseVerifyOutput("READY http=200 after 6s\n")).toEqual({ ready: true, http: 200, afterSec: 6 })
    expect(parseVerifyOutput("NOT-READY last http=000 after 120s")).toEqual({ ready: false, http: 0 })
    expect(parseVerifyOutput("")).toEqual({ ready: false, http: undefined })
  })
})

describe("no kit", () => {
  test("says nothing was run, gives the paths, and lists what IS runnable", () => {
    const text = noKitAdvice("book a haircut appointment", KITS).join("\n")
    expect(text).toContain("Nothing was run")
    expect(text).toContain("open-lovable")
    expect(text).toContain("- Stirling-PDF")
    expect(text).not.toContain("- AppFlowy")
  })
})
