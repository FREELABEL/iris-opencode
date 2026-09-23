import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import {
  ARTIFACT_CSP,
  ARTIFACT_SANDBOX,
  authorLine,
  changedSince,
  markdownDocument,
  parseCsv,
  sandboxedDocument,
  publishState,
  slugify,
  liveUrl,
  LIVE_SANDBOX,
} from "./iris-artifacts-model"

describe("ADR-01 — the artifact sandbox", () => {
  test("the sandbox grants scripts and nothing else — never same-origin, never top navigation", () => {
    expect(ARTIFACT_SANDBOX).toBe("allow-scripts")
    expect(ARTIFACT_SANDBOX).not.toContain("allow-same-origin")
    expect(ARTIFACT_SANDBOX).not.toContain("allow-top-navigation")
  })

  test("the pane uses the constant, and sets content with srcdoc — never src= an /iris URL", () => {
    const src = readFileSync(path.join(import.meta.dir, "iris-artifacts.tsx"), "utf8")
    expect(src).toContain("sandbox={ARTIFACT_SANDBOX}")
    expect(src).toContain("srcdoc=")
    expect(src).not.toContain("allow-same-origin")
    // Every frame showing agent-written content is srcdoc under ARTIFACT_SANDBOX. The ONE src=
    // frame is the live heyiris.io page (#186541): LIVE_SANDBOX, its URL only from liveUrl().
    const frames = src.match(/<iframe[\s\S]*?\/>/g) ?? []
    for (const f of frames) {
      if (/\ssrc=/.test(f)) expect(f).toContain("sandbox={LIVE_SANDBOX}")
      else expect(f).toContain("sandbox={ARTIFACT_SANDBOX}")
    }
    expect(frames.filter((f) => /\ssrc=/.test(f))).toHaveLength(1)
    expect(src).not.toMatch(/src=\{?[`"'][^`"']*\/iris\//)
  })

  test("markdown is never placed with innerHTML — marked passes raw HTML through", () => {
    const src = readFileSync(path.join(import.meta.dir, "iris-artifacts.tsx"), "utf8")
    expect(src).not.toMatch(/innerHTML=/)
    const doc = sandboxedDocument(markdownDocument('<img src=x onerror="parent.document.title=1">'))
    // Still present — but only ever inside the sandboxed, CSP-locked frame.
    expect(doc.indexOf(ARTIFACT_CSP)).toBeLessThan(doc.indexOf("onerror"))
  })

  test("the CSP forbids connections and forms", () => {
    expect(ARTIFACT_CSP).toContain("connect-src 'none'")
    expect(ARTIFACT_CSP).toContain("form-action 'none'")
    expect(ARTIFACT_CSP).toContain("default-src 'none'")
  })

  test("the CSP meta goes first in <head>, ahead of anything the page declares", () => {
    const out = sandboxedDocument(
      `<html><head lang="en"><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>`,
    )
    const ours = out.indexOf(ARTIFACT_CSP)
    const theirs = out.indexOf("default-src *")
    expect(ours).toBeGreaterThan(0)
    expect(ours).toBeLessThan(theirs)
  })

  test("a fragment with no <head> is wrapped, still with the CSP", () => {
    expect(sandboxedDocument("<h1>hi</h1>")).toContain(`content="${ARTIFACT_CSP}"`)
  })
})

describe("authorLine — which agent made it", () => {
  test("names the writer of the current revision", () => {
    expect(authorLine({ revision: 1, author: { agent: "build" }, createdBy: { agent: "build" } })).toBe("rev 1 · build")
  })
  test("and who started it, when that was someone else", () => {
    expect(authorLine({ revision: 3, author: { agent: "researcher" }, createdBy: { agent: "build" } })).toBe(
      "rev 3 · researcher (started by build)",
    )
  })
  test("an artifact written before authorship existed says unknown, not blank", () => {
    expect(authorLine({ revision: 2 })).toBe("rev 2 · unknown")
  })
})

test("parseCsv handles quotes, doubled quotes and embedded commas/newlines", () => {
  expect(parseCsv('name,note\n"Smith, J","said ""hi""\nthen left"\nx,y')).toEqual([
    ["name", "note"],
    ["Smith, J", 'said "hi"\nthen left'],
    ["x", "y"],
  ])
})

test("changedSince marks a new artifact AND a new revision of an old one", () => {
  const m = (id: string, revision: number) => ({ id, revision }) as any
  expect([...changedSince([m("a", 1), m("b", 1)], [m("a", 2), m("b", 1), m("c", 1)])].sort()).toEqual(["a", "c"])
  expect(changedSince(undefined, [m("a", 1)]).size).toBe(0)
})

test("the chat card obeys the same sandbox as the pane — it renders agent-written HTML too", () => {
  const src = readFileSync(path.join(import.meta.dir, "genesis-artifact-card.tsx"), "utf8")
  expect(src).toContain("sandbox={ARTIFACT_SANDBOX}")
  expect(src).toContain("srcdoc=")
  expect(src).not.toMatch(/<iframe[^>]*\ssrc=/)
  expect(src).not.toContain("allow-same-origin")
  expect(src).not.toMatch(/innerHTML=/)
})

describe("publishing an artifact as a page", () => {
  const pub = (revision: number) => ({
    pageId: 1,
    slug: "x",
    url: "u",
    visibility: "public" as const,
    requiresAuth: false,
    revision,
    at: "",
  })
  test("never published → Publish…; current → settings; behind → Update page…", () => {
    expect(publishState({ revision: 1 })).toEqual({ label: "Publish…", behind: false })
    expect(publishState({ revision: 2, published: pub(2) })).toEqual({ label: "Publish settings…", behind: false })
    expect(publishState({ revision: 3, published: pub(2) })).toEqual({ label: "Update page…", behind: true })
  })
  test("the suggested address is one the engine accepts", () => {
    expect(slugify("All Hallows — Landing Page!")).toBe("all-hallows-landing-page")
    expect(slugify("Café Menu")).toBe("cafe-menu")
  })
  test("the form asks for the scope: nothing is pre-selected on a first publish", () => {
    const src = readFileSync(path.join(import.meta.dir, "iris-artifact-publish.tsx"), "utf8")
    // First publish: preset is undefined (Publish…) and there is no prior page → no scope.
    expect(src).toContain("setScope(preset ?? p?.visibility)")
    expect(src).toContain("disabled={!scope() || !slug().trim() || busy()}")
  })
})

describe("the live page in the app (#186541)", () => {
  test("only https://heyiris.io /p/ and /n/ are ever loaded", () => {
    expect(liveUrl("https://heyiris.io/p/all-hallows")).toBe("https://heyiris.io/p/all-hallows")
    expect(liveUrl("https://heyiris.io/n/469239b7-1303-4159-ba4c-c10ba9f317eb")).toBeTruthy()
    for (const bad of [
      "http://heyiris.io/p/x",
      "https://heyiris.io.evil.com/p/x",
      "https://evil.com/p/x",
      "https://heyiris.io/dashboard",
      "https://heyiris.io/p/",
      "javascript:alert(1)",
      "http://127.0.0.1:4097/iris/artifacts/x",
      undefined,
    ]) {
      expect([bad, liveUrl(bad as any)]).toEqual([bad, undefined])
    }
  })
  test("the live frame never gets top navigation", () => {
    expect(LIVE_SANDBOX).not.toContain("allow-top-navigation")
  })
  test("the live frame is only ever given a liveUrl, and the draft frame keeps srcdoc", () => {
    const src = readFileSync(path.join(import.meta.dir, "iris-artifacts.tsx"), "utf8")
    expect(src).toContain("liveUrl(open()?.published?.url)")
    expect(src).toContain("sandbox={LIVE_SANDBOX}")
    expect((src.match(/src=\{src\(\)\}/g) ?? []).length).toBe(1)
  })
})
