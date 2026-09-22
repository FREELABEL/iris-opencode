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
    expect(src).not.toMatch(/<iframe[^>]*\ssrc=/)
    expect(src).not.toContain("allow-same-origin")
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
