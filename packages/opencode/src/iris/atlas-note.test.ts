import { afterEach, describe, expect, test } from "bun:test"
import { atlasNotesIn, atlasNoteUrl, noteTitle, probeAtlasNote } from "./atlas-note"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const UUID = "17ac82c8-ade9-4384-9311-9d48a0930f2f"

describe("atlasNoteUrl — only heyiris.io/n/<uuid>, canonicalised", () => {
  test("accepts the note and drops query, hash, trailing slash and case", () => {
    expect(atlasNoteUrl(`https://heyiris.io/n/${UUID}`)).toBe(`https://heyiris.io/n/${UUID}`)
    expect(atlasNoteUrl(` https://heyiris.io/n/${UUID.toUpperCase()}/?x=1#top `)).toBe(`https://heyiris.io/n/${UUID}`)
  })

  test("refuses everything else — the panel frames what passes here same-origin", () => {
    for (const bad of [
      undefined,
      "",
      `http://heyiris.io/n/${UUID}`,
      `https://evil.example/n/${UUID}`,
      `https://heyiris.io.evil.example/n/${UUID}`,
      `https://user:pw@heyiris.io/n/${UUID}`,
      `https://heyiris.io:8443/n/${UUID}`,
      `https://heyiris.io/p/${UUID}`,
      `https://heyiris.io/n/not-a-uuid`,
      `https://heyiris.io/n/${UUID}/edit`,
      `javascript:alert(1)`,
    ])
      expect(atlasNoteUrl(bad)).toBeUndefined()
  })
})

describe("atlasNotesIn — what a Shell run printed", () => {
  test("finds every distinct note, once, in order", () => {
    const out = `  Public URL  https://heyiris.io/n/${UUID}\n  again https://heyiris.io/n/${UUID}.\n  https://heyiris.io/n/bbeca56c-e5c8-4548-8fec-27ad13e838b4`
    expect(atlasNotesIn(out)).toEqual([
      `https://heyiris.io/n/${UUID}`,
      "https://heyiris.io/n/bbeca56c-e5c8-4548-8fec-27ad13e838b4",
    ])
  })
  test("ignores lookalikes", () => {
    expect(atlasNotesIn(`https://heyiris.io/p/${UUID} http://heyiris.io/n/${UUID}`)).toEqual([])
    expect(atlasNotesIn(undefined)).toEqual([])
  })
})

describe("noteTitle", () => {
  test("prefers og:title and decodes entities", () => {
    expect(noteTitle(`<title inertia>Plain</title><meta property="og:title" content="EPIC &amp; more">`)).toBe("EPIC & more")
  })
  test("falls back to <title>, and to undefined when there is none", () => {
    expect(noteTitle(`<title inertia>  EPIC — Atlas  </title>`)).toBe("EPIC — Atlas")
    expect(noteTitle(`<html></html>`)).toBeUndefined()
  })
})

describe("probeAtlasNote — private and offline are different answers", () => {
  const url = `https://heyiris.io/n/${UUID}`
  test("200 is public, with the page's title", async () => {
    globalThis.fetch = (async () => new Response("<title>The plan</title>", { status: 200 })) as unknown as typeof fetch
    expect(await probeAtlasNote(url)).toEqual({ state: "public", url, title: "The plan" })
  })
  test("404 is unavailable — the person can fix that", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch
    expect(await probeAtlasNote(url)).toEqual({ state: "unavailable", url, status: 404 })
  })
  test("a network failure is unreachable, never unavailable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNRESET")
    }) as unknown as typeof fetch
    expect(await probeAtlasNote(url)).toEqual({ state: "unreachable", url, reason: "ECONNRESET" })
  })
})
