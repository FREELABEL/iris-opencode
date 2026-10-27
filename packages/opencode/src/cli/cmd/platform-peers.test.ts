import { describe, expect, test } from "bun:test"
import type { SpawnSyncReturns } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { FetchOptions } from "./media-fetch"
import {
  addPeer,
  classifyPullError,
  coverageScore,
  extractKeywords,
  findPeer,
  listArgs,
  loadPeers,
  loadPosts,
  median,
  mergePosts,
  parseTarget,
  parseYtDlpLines,
  peersDir,
  postFromYtDlp,
  postText,
  pullAccount,
  pullFailureMessage,
  rankGaps,
  savePeers,
  savePosts,
  topicLabel,
  type PeerEntry,
  type PeerPost,
} from "./platform-peers"

// Fixtures trimmed from real `yt-dlp --dump-json` output captured 2026-10-27 (fields kept as
// yt-dlp names them; the dozens we don't read are dropped).
const YT_FULL = {
  id: "_4ELeWAgMwo",
  title: "ASMR iPhone Duo Unboxing",
  description: "iPhone duo only comes with 2 things in the box",
  webpage_url: "https://www.youtube.com/watch?v=_4ELeWAgMwo",
  original_url: "https://www.youtube.com/watch?v=_4ELeWAgMwo",
  channel: "Marques Brownlee",
  uploader: "Marques Brownlee",
  uploader_id: "@mkbhd",
  upload_date: "20261021",
  timestamp: 1792591233,
  view_count: 2206733,
  like_count: 69651,
  comment_count: 970,
  duration: 46,
  tags: [],
  extractor: "youtube",
  extractor_key: "Youtube",
  playlist: "Marques Brownlee - Shorts",
  playlist_uploader: "Marques Brownlee",
  _type: "video",
}
const YT_FLAT = {
  _type: "url",
  ie_key: "Youtube",
  id: "ESABTN4VtrA",
  url: "https://www.youtube.com/watch?v=ESABTN4VtrA",
  title: "iPhone Duo Review: First Generation Fun!",
  duration: 1745,
  view_count: 12000000,
  timestamp: null,
  playlist_uploader: "Marques Brownlee",
  playlist_uploader_id: "@mkbhd",
  webpage_url: "https://www.youtube.com/watch?v=ESABTN4VtrA",
  extractor_key: "Youtube",
}
const TT = {
  id: "7697307919943060767",
  title: "I guess is time to retire #learnfromkhaby #comedy 🥊",
  description: "I guess is time to retire #learnfromkhaby #comedy 🥊",
  webpage_url: "https://www.tiktok.com/@khaby.lame/video/7697307919943060767",
  uploader: "khaby.lame",
  uploader_id: "127905465618821121",
  channel: "Khabane lame",
  upload_date: "20261016",
  timestamp: 1792169181,
  view_count: 4400000,
  like_count: 302600,
  comment_count: 7406,
  extractor_key: "TikTok",
}
const IG_POST = {
  id: "DbcFYsCF8b9",
  title: "Video by mauroisruiz",
  description: "Charlie Rocket says 50 real fans beat 500K views 🎧\n\nFind the full length interview on our channel",
  webpage_url: "https://www.instagram.com/reel/DbcFYsCF8b9/",
  uploader: "Mauricio Ruiz",
  channel: "mauroisruiz",
  upload_date: "20260731",
  timestamp: 1785461360,
  view_count: null,
  like_count: 6473,
  comment_count: 103,
  extractor_key: "Instagram",
}

const NOW = "2026-10-27T12:00:00.000Z"

type Call = { bin: string; args: string[] }
function fakeYtDlp(answer: (args: string[]) => Partial<SpawnSyncReturns<string>>) {
  const calls: Call[] = []
  const run: FetchOptions["run"] = (bin, args) => {
    calls.push({ bin, args })
    return { pid: 0, output: [], stdout: "", stderr: "", status: 1, signal: null, ...answer(args) } as SpawnSyncReturns<string>
  }
  return { run, calls }
}

function post(over: Partial<PeerPost> & { id: string }): PeerPost {
  return {
    url: `https://x/${over.id}`,
    platform: "tiktok",
    author: null,
    date: "2026-10-20",
    title: null,
    caption: null,
    views: null,
    likes: null,
    comments: null,
    duration: null,
    first_seen_at: NOW,
    seen_at: NOW,
    ...over,
  }
}
const entry = (id: string, over: Partial<PeerEntry> = {}): PeerEntry => ({
  id,
  handle: id,
  platform: "tiktok",
  url: `https://www.tiktok.com/@${id}`,
  added_at: NOW,
  ...over,
})

describe("parseTarget — what a person types becomes an account", () => {
  test("YouTube @handle URL lists the videos tab; a named tab is kept", () => {
    expect(parseTarget("https://www.youtube.com/@mkbhd")).toEqual({ platform: "youtube", handle: "mkbhd", url: "https://www.youtube.com/@mkbhd/videos" })
    expect(parseTarget("youtube.com/@mkbhd/shorts")).toEqual({ platform: "youtube", handle: "mkbhd", url: "https://www.youtube.com/@mkbhd/shorts" })
    expect(parseTarget("https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ")).toMatchObject({ handle: "UCBJycsmduvYEL83R_U4JriQ", url: "https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ/videos" })
  })
  test("TikTok profile or post URL → the account", () => {
    expect(parseTarget("https://www.tiktok.com/@khaby.lame/video/7697307919943060767")).toEqual({ platform: "tiktok", handle: "khaby.lame", url: "https://www.tiktok.com/@khaby.lame" })
  })
  test("Instagram profile URL (with /reels/) → the profile; a single reel is refused", () => {
    expect(parseTarget("https://www.instagram.com/natgeo/reels/")).toEqual({ platform: "instagram", handle: "natgeo", url: "https://www.instagram.com/natgeo/" })
    expect(parseTarget("https://www.instagram.com/reel/DbcFYsCF8b9/")).toHaveProperty("error")
  })
  test("bare handle takes --platform, else Instagram", () => {
    expect(parseTarget("@khaby.lame", "tiktok")).toEqual({ platform: "tiktok", handle: "khaby.lame", url: "https://www.tiktok.com/@khaby.lame" })
    expect(parseTarget("natgeo")).toMatchObject({ platform: "instagram", handle: "natgeo" })
  })
  test("nonsense and unsupported sites say why", () => {
    expect(parseTarget("not a handle!")).toHaveProperty("error")
    expect(parseTarget("https://example.com/@x")).toHaveProperty("error")
    expect(parseTarget("x", "myspace")).toHaveProperty("error")
  })
})

describe("watch list", () => {
  test("same handle on a second platform gets its own id instead of overwriting", () => {
    let peers: PeerEntry[] = []
    peers = addPeer(peers, { platform: "tiktok", handle: "dj", url: "t" }, { now: NOW }).peers
    const r = addPeer(peers, { platform: "instagram", handle: "dj", url: "i" }, { now: NOW })
    expect(r.created).toBe(true)
    expect(r.peers.map((p) => p.id)).toEqual(["dj", "dj-instagram"])
  })
  test("re-adding updates in place; --mine moves to exactly one account", () => {
    let peers = addPeer([], { platform: "tiktok", handle: "a", url: "u" }, { now: NOW, mine: true }).peers
    peers = addPeer(peers, { platform: "tiktok", handle: "b", url: "u" }, { now: NOW }).peers
    const r = addPeer(peers, { platform: "tiktok", handle: "B", url: "u2" }, { now: NOW, mine: true, label: "scene" })
    expect(r.created).toBe(false)
    expect(r.peers.filter((p) => p.mine).map((p) => p.id)).toEqual(["b"])
    expect(r.peers.find((p) => p.id === "b")).toMatchObject({ url: "u2", label: "scene" })
    expect(r.peers.find((p) => p.id === "a")).not.toHaveProperty("mine")
  })
  test("findPeer by id or unambiguous handle", () => {
    const peers = [entry("dj"), entry("dj-instagram", { handle: "dj", platform: "instagram" }), entry("solo")]
    expect(findPeer(peers, "@dj")?.id).toBe("dj")
    expect(findPeer(peers, "SOLO")?.id).toBe("solo")
    expect(findPeer(peers, "nobody")).toBeNull()
  })
  test("peers.json and posts.json round-trip under IRIS_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "peers-test-"))
    try {
      const dir = peersDir({ IRIS_HOME: home } as any)
      expect(dir).toBe(join(home, "peers"))
      savePeers([entry("a")], dir)
      expect(loadPeers(dir).map((p) => p.id)).toEqual(["a"])
      savePosts("a", [post({ id: "1" })], dir)
      expect(loadPosts("a", dir).map((p) => p.id)).toEqual(["1"])
      expect(loadPosts("missing", dir)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("yt-dlp JSON → post record", () => {
  test("full YouTube entry keeps id, url, date, caption, views, likes, comments", () => {
    expect(postFromYtDlp(YT_FULL, NOW)).toEqual({
      id: "_4ELeWAgMwo",
      url: "https://www.youtube.com/watch?v=_4ELeWAgMwo",
      platform: "youtube",
      author: "Marques Brownlee",
      date: "2026-10-21",
      title: "ASMR iPhone Duo Unboxing",
      caption: "iPhone duo only comes with 2 things in the box",
      views: 2206733,
      likes: 69651,
      comments: 970,
      duration: 46,
      first_seen_at: NOW,
      seen_at: NOW,
    })
  })
  test("flat entry has no date or likes — nulls, not zeros", () => {
    const p = postFromYtDlp(YT_FLAT, NOW)!
    expect(p).toMatchObject({ id: "ESABTN4VtrA", date: null, likes: null, views: 12000000, author: "Marques Brownlee" })
  })
  test("Instagram reports likes but no views", () => {
    expect(postFromYtDlp(IG_POST, NOW)).toMatchObject({ views: null, likes: 6473, date: "2026-07-31" })
  })
  test("playlist wrappers and junk lines are skipped", () => {
    const lines = [JSON.stringify(TT), "WARNING: something", JSON.stringify({ _type: "playlist", id: "x" }), "{not json", JSON.stringify(YT_FULL)].join("\n")
    expect(parseYtDlpLines(lines, NOW).map((p) => p.id)).toEqual(["7697307919943060767", "_4ELeWAgMwo"])
  })
})

describe("mergePosts — merge, don't duplicate", () => {
  test("same id updates metrics, keeps first_seen_at + transcript; a flat re-pull can't erase likes", () => {
    const old = post({ id: "1", views: 100, likes: 10, first_seen_at: "2026-10-01T00:00:00Z", seen_at: "2026-10-01T00:00:00Z", transcript: "hello" })
    const fresh = post({ id: "1", views: 500, likes: null, seen_at: NOW })
    const r = mergePosts([old], [fresh, post({ id: "2", date: "2026-10-25" })])
    expect(r.added).toBe(1)
    expect(r.updated).toBe(1)
    expect(r.posts.map((p) => p.id)).toEqual(["2", "1"])
    expect(r.posts[1]).toMatchObject({ views: 500, likes: 10, first_seen_at: "2026-10-01T00:00:00Z", seen_at: NOW, transcript: "hello" })
  })
})

describe("pulling (yt-dlp mocked — never the network)", () => {
  test("metadata only: --skip-download, --playlist-end N, no browser cookies for TikTok", () => {
    const { run, calls } = fakeYtDlp(() => ({ status: 0, stdout: JSON.stringify(TT) + "\n" }))
    const r = pullAccount("yt-dlp", entry("khaby.lame"), { latest: 5, run }, NOW)
    expect(r.ok).toBe(true)
    expect(r.posts).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain("--skip-download")
    expect(calls[0].args.join(" ")).toContain("--playlist-end 5")
    expect(calls[0].args).not.toContain("--cookies-from-browser")
    expect(calls[0].args.at(-1)).toBe("https://www.tiktok.com/@khaby.lame")
  })
  test("--cookies file is passed through", () => {
    expect(listArgs({ latest: 3, cookies: "/c.txt", flat: true })).toEqual(["--skip-download", "--dump-json", "--ignore-errors", "--playlist-end", "3", "--flat-playlist", "--cookies", "/c.txt"])
  })
  test("partial output with exit 1 (--ignore-errors) still counts", () => {
    const { run } = fakeYtDlp(() => ({ status: 1, stdout: JSON.stringify(TT), stderr: "ERROR: one video unavailable" }))
    expect(pullAccount("yt-dlp", entry("k"), { latest: 5, run }, NOW).ok).toBe(true)
  })
  test("Instagram without a session → login failure, with the --cookies hint and the fallback", () => {
    const { run, calls } = fakeYtDlp(() => ({
      status: 1,
      stderr:
        "WARNING: The program functionality for this site has been marked as broken, and will probably not work.\nERROR: [instagram:user] natgeo: Unable to extract data; please report this issue",
    }))
    const ig = entry("natgeo", { platform: "instagram", url: "https://www.instagram.com/natgeo/" })
    const r = pullAccount("yt-dlp", ig, { latest: 5, run }, NOW)
    expect(r.ok).toBe(false)
    expect(r.failure).toBe("broken")
    // Instagram tries the browser cookie ladder before giving up.
    expect(calls.some((c) => c.args.includes("--cookies-from-browser"))).toBe(true)
    const msg = pullFailureMessage(ig, r.failure!, r.error!)
    expect(msg).toContain("logged-in session")
    expect(msg).toContain("--cookies <cookies.txt>")
    expect(msg).toContain("--urls")
  })
  test("classifyPullError", () => {
    expect(classifyPullError("ERROR: [instagram:story] You need to log in to access this content. Use --cookies-from-browser")).toBe("login")
    expect(classifyPullError("HTTP Error 429: Too Many Requests")).toBe("rate_limited")
    expect(classifyPullError("ERROR: This account does not exist")).toBe("not_found")
    expect(classifyPullError("ERROR: Unsupported URL: https://x")).toBe("unsupported")
    expect(classifyPullError("boom")).toBe("other")
  })
})

describe("topics", () => {
  test("keywords: lowercase, no stopwords/urls/mentions/reach-bait tags, adjacent phrases only", () => {
    const k = extractKeywords("The NEW iPhone Duo review! @apple #fyp #techreview https://t.co/x 2026")
    expect(k).toEqual(["iphone", "duo", "iphone duo", "review", "duo review", "techreview"])
  })
  test("phrases never jump a stopword or punctuation", () => {
    expect(extractKeywords("studio session, beat making")).toEqual(["studio", "session", "studio session", "beat", "making", "beat making"])
    expect(extractKeywords("vinyl in the city")).toEqual(["vinyl", "city"])
  })
  test("Instagram's 'Video by <handle>' title is not a topic", () => {
    expect(postText({ title: "Video by mauroisruiz", caption: "fans", transcript: undefined })).not.toContain("mauroisruiz")
  })
  test("topicLabel prefers phrases and drops words they contain", () => {
    expect(topicLabel(["iphone", "duo", "iphone duo", "review", "duo review", "techreview"])).toEqual(["iphone duo", "duo review", "techreview"])
  })
  test("coverageScore = share of the post's words found in yours", () => {
    expect(coverageScore(["iphone", "duo", "iphone duo", "review"], new Set(["iphone", "review"]))).toBe(0.67)
    expect(coverageScore([], new Set(["x"]))).toBe(0)
  })
  test("median", () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

describe("rankGaps — what worked that you haven't covered", () => {
  const now = new Date(NOW)
  const big = {
    entry: entry("big"),
    posts: [
      post({ id: "b1", views: 1_000_000, caption: "studio tour gear" }),
      post({ id: "b2", views: 1_100_000, caption: "beat making tutorial" }),
      post({ id: "b3", views: 900_000, caption: "vinyl crate digging" }),
      post({ id: "old", views: 9_000_000, caption: "ancient viral thing", date: "2026-01-01" }),
    ],
  }
  const small = {
    entry: entry("small", { label: "houston" }),
    posts: [
      post({ id: "s1", views: 2_000, caption: "open mic night" }),
      post({ id: "s2", views: 20_000, caption: "pop up show houston" }),
      post({ id: "s3", views: 2_000, caption: "merch drop" }),
    ],
  }
  const mine = [post({ id: "m1", caption: "my studio gear tour" }), post({ id: "m2", caption: "beat tutorial" })]
  const opts = { days: 30, top: 10, threshold: 0.5, sort: "relative" as const, now }

  test("a small account's breakout outranks a big account's ordinary day", () => {
    const { rows } = rankGaps([big, small], mine, opts)
    expect(rows[0]).toMatchObject({ account: "small", url: "https://x/s2", relative: 10, label: "houston" })
  })
  test("outside the window is ignored", () => {
    const { rows } = rankGaps([big, small], mine, opts)
    expect(rows.some((r) => r.url.endsWith("/old"))).toBe(false)
  })
  test("covered vs not: your studio/beat posts cover b1/b2, not the vinyl one", () => {
    const { rows } = rankGaps([big, small], mine, opts)
    const by = Object.fromEntries(rows.map((r) => [r.url.split("/").pop(), r]))
    expect(by.b1.covered).toBe(true)
    expect(by.b2.covered).toBe(true)
    expect(by.b3.covered).toBe(false)
    expect(by.b3.topic).toContain("crate digging")
  })
  test("--sort views ranks raw views", () => {
    const { rows } = rankGaps([big, small], mine, { ...opts, sort: "views" })
    expect(rows[0].url).toBe("https://x/b2")
  })
  test("no posts of your own → nothing counts as covered", () => {
    const { rows } = rankGaps([big], [], opts)
    expect(rows.every((r) => !r.covered)).toBe(true)
  })
  test("Instagram (likes only) ranks by likes relative to its median", () => {
    const ig = {
      entry: entry("ig", { platform: "instagram" }),
      posts: [post({ id: "i1", likes: 100 }), post({ id: "i2", likes: 100 }), post({ id: "i3", likes: 500, caption: "fans not views" })],
    }
    const { rows } = rankGaps([ig], [], opts)
    expect(rows[0]).toMatchObject({ metric: "likes", relative: 5 })
  })
  test("deterministic: same input, same output", () => {
    expect(rankGaps([big, small], mine, opts)).toEqual(rankGaps([big, small], mine, opts))
  })
})
