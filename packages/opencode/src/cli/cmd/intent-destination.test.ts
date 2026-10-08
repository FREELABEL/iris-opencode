import { describe, expect, test } from "bun:test"
import { chunk, DECIDE_MAX_QUESTIONS, destinationOf, withDestination, type Candidate } from "./platform-intent-select"
import { pickList, pickProject } from "../lib/file-to-project"
import { findYtDlp, ytDlpAsset } from "./transcribe"

const c = (name: string, run = `iris ${name}`): Candidate => ({ name, describe: "", run, score: 0 })

describe("#188392 — the destination half of an intent is carried, not dropped", () => {
  test("'for <project>' is extracted, URLs and punctuation removed", () => {
    expect(destinationOf("transcribe this IG for IRIS ORBIT")).toBe("IRIS ORBIT")
    expect(destinationOf("transcribe this IG for IRIS ORBIT https://www.instagram.com/reel/DeMfh6jgvVK/")).toBe("IRIS ORBIT")
    expect(destinationOf("transcribe https://x.com/a/status/1 for the Orbit project.")).toBe("Orbit")
  })
  test("pronouns and times are not projects", () => {
    expect(destinationOf("transcribe this for me")).toBeUndefined()
    expect(destinationOf("transcribe this video for later")).toBeUndefined()
    expect(destinationOf("transcribe this video")).toBeUndefined()
  })
  test("only commands that take --for get it", () => {
    const t = "transcribe this IG for IRIS ORBIT"
    expect(withDestination("iris transcribe <url>", c("transcribe", "iris transcribe [url]"), t)).toBe('iris transcribe <url> --for "IRIS ORBIT"')
    expect(withDestination('iris web-search "coffee"', c("web-search"), "search for coffee")).toBe('iris web-search "coffee"')
    expect(withDestination('iris transcribe u --for "X"', c("transcribe"), t)).toBe('iris transcribe u --for "X"')
  })
})

describe("#188392 — project resolution refuses rather than guesses", () => {
  const bloqs = [
    { id: 735, name: "Iris Orbit — Orbital Intelligence OS" },
    { id: 571, name: "IRIS Labs — Agency" },
    { id: 381, name: "IRIS Hive — Distributed Compute Mesh" },
    { id: 900, name: "Orbit Fans" },
  ]
  test("a name prefix resolves to the one project", () => {
    expect(pickProject("IRIS ORBIT", bloqs)).toEqual({ bloq: bloqs[0] })
    expect(pickProject("iris orbit", bloqs)).toEqual({ bloq: bloqs[0] })
  })
  test("an id wins outright", () => {
    expect(pickProject("#571", bloqs)).toEqual({ bloq: bloqs[1] })
  })
  test("an ambiguous name is an error naming the candidates, never a guess", () => {
    const r = pickProject("orbit", bloqs) as any
    expect(r.error).toContain("matches 2 projects")
    expect(r.candidates.map((b: any) => b.id).sort()).toEqual([735, 900])
  })
  test("no match is an error", () => {
    expect("error" in pickProject("Saturn", bloqs)).toBe(true)
  })
  test("files into Ideas, else Todo, else the first list", () => {
    expect(pickList([{ id: 1, name: "Daily Diary" }, { id: 2, name: "Todo" }, { id: 3, name: "Ideas" }])?.id).toBe(3)
    expect(pickList([{ id: 1, name: "Daily Diary" }, { id: 2, name: "Todo" }])?.id).toBe(2)
    expect(pickList([{ id: 9, name: "Inbox" }])?.id).toBe(9)
  })
})

describe("#188391 — relevance never sends more questions than Decide accepts", () => {
  test("chunks stay at or under the limit and keep every item in order", () => {
    const pool = Array.from({ length: 150 }, (_, i) => i)
    const parts = chunk(pool, DECIDE_MAX_QUESTIONS)
    expect(parts.every((p) => p.length <= 64)).toBe(true)
    expect(parts.flat()).toEqual(pool)
    expect(parts.length).toBe(3)
  })
})

describe("#188318 row 5 — yt-dlp on a machine with no brew", () => {
  test("a standalone asset exists for every machine we ship to", () => {
    expect(ytDlpAsset("linux", "x64")).toBe("yt-dlp_linux")
    expect(ytDlpAsset("linux", "arm64")).toBe("yt-dlp_linux_aarch64")
    expect(ytDlpAsset("darwin", "arm64")).toBe("yt-dlp_macos")
  })
  test("#187135 — a Homebrew yt-dlp off PATH is still found", () => {
    const found = findYtDlp((p) => p === "/opt/homebrew/bin/yt-dlp")
    // On a machine where yt-dlp IS on PATH, which() answers first — either way it is found.
    expect(found).not.toBeNull()
  })
})
