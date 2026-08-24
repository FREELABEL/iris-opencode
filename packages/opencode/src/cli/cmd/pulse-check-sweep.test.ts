import { describe, expect, test } from "bun:test"
import { keywordVariants, keywordPattern, topicSlug, toObservations, resolveRepoRoot, gitRepos, sweepImessage, sweepDiary, sweepFiles, sweepBloq, decodeAttributedBody, parseMailResponse, type SourceSweep } from "./pulse-check-sweep"
import { execFileSync } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

/**
 * The collectors themselves are I/O against a real machine and are covered by
 * running the command. What is tested here is the part that decides what LEAVES
 * the machine and what the server is told — where a mistake is silent and
 * flattering rather than loud.
 */

function sweep(over: Partial<SourceSweep> & Pick<SourceSweep, "source">): SourceSweep {
  return { searched: true, hits: 0, items: [], ...over }
}

describe("keywordVariants", () => {
  test("covers the spellings a multi-word topic actually appears in", () => {
    expect(keywordVariants("creator os")).toEqual(["creator os", "creator-os", "creator_os", "creatoros"])
  })

  test("a single word has exactly one form", () => {
    expect(keywordVariants("  Pulse  ")).toEqual(["pulse"])
  })

  test("punctuation in the subject does not change what gets searched", () => {
    // REGRESSION. Splitting on spaces made the variant set depend on how the
    // subject was punctuated: "MAYO — Life Atlas" produced `mayo-—-life-atlas`,
    // an em-dash wedged between hyphens that matches nothing, and never produced
    // the plain `mayo-life-atlas` the repo contains. The two spellings returned
    // different local results for the same board — one subject, two confident
    // answers, which is the bug this whole tool exists to refuse.
    const punctuated = keywordVariants("MAYO — Life Atlas")
    const plain = keywordVariants("mayo life atlas")

    for (const v of plain) expect(punctuated).toContain(v)
    expect(punctuated).toContain("mayo-life-atlas")
    expect(punctuated.some((v) => v.includes("—"))).toBe(true) // the raw phrase is kept
    expect(punctuated.filter((v) => v.includes("—")).length).toBe(1) // but only once
  })
})

describe("topicSlug", () => {
  test("is stable across punctuation and case, so re-runs hit the same entity", () => {
    expect(topicSlug("Creator OS")).toBe("creator-os")
    expect(topicSlug("  creator/os!  ")).toBe("creator-os")
  })

  test("never produces an empty external id", () => {
    expect(topicSlug("!!!")).toBe("topic")
  })
})

describe("sweepBloq — a non-array `data` must never crash the sweep (#182191)", () => {
  function fakeRes(body: unknown, ok = true): Response {
    return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response
  }

  test("board list returning data:{} (no boards) does not throw", async () => {
    // REGRESSION. `?.data ?? []` only substitutes on null/undefined — it lets
    // a non-array truthy `data` (an empty PHP array serialising as `{}`
    // instead of `[]`, a real shape from this endpoint) straight through,
    // and `for (const row of rows)` on a plain object throws "{} is not
    // iterable". This is exactly what a keyword matching no Atlas board hit.
    const apiFetch = async (path: string) =>
      path.includes("content-items") ? fakeRes({ data: {} }) : fakeRes({ data: {} })

    await expect(
      sweepBloq({ keyword: "no such board", repo: ".", windowDays: 30, limit: 6, sources: ["bloq"], apiFetch, userId: 1 }),
    ).resolves.toMatchObject({ source: "bloq", items: [] })
  })

  test("item-search returning data:{} after a board-list miss does not throw", async () => {
    const apiFetch = async (path: string) =>
      path.includes("content-items") ? fakeRes({ data: {} }) : fakeRes({ data: [] })

    await expect(
      sweepBloq({ keyword: "another miss", repo: ".", windowDays: 30, limit: 6, sources: ["bloq"], apiFetch, userId: 1 }),
    ).resolves.toMatchObject({ source: "bloq", items: [] })
  })

  test("a real array of boards/rows still works (not just the empty case)", async () => {
    const apiFetch = async (path: string) =>
      path.includes("content-items")
        ? fakeRes({ data: [{ id: 1, updated_at: new Date().toISOString(), list_name: "L", title: "creator os thread" }] })
        : fakeRes({ data: [] })

    const result = await sweepBloq({ keyword: "creator os", repo: ".", windowDays: 30, limit: 6, sources: ["bloq"], apiFetch, userId: 1 })
    expect(result.items.length).toBe(1)
  })
})

describe("toObservations", () => {
  const base = { includeContext: false, windowDays: 30 }

  test("metrics are namespaced per source, because the server rollup is a flat merge", () => {
    // CorpusIngestService merges metrics last-write-wins. A shared `hits` key
    // would let whichever collector ran last decide the topic's numbers.
    const [git, diary] = toObservations(
      "creator os",
      [
        sweep({ source: "git", hits: 23, hitsPrior: 4, lastHitEpoch: 1_700_000_000 }),
        sweep({ source: "diary", hits: 2, hitsPrior: 1, lastHitEpoch: 1_700_000_100 }),
      ],
      base,
    )

    expect(git.metrics).toEqual({ git_hits: 23, git_hits_prior: 4, git_last_hit_epoch: 1_700_000_000 })
    expect(diary.metrics).toEqual({ diary_hits: 2, diary_hits_prior: 1, diary_last_hit_epoch: 1_700_000_100 })
    expect(Object.keys(git.metrics)).not.toContain("hits")
  })

  test("a source that could not run sends NO metrics, not zeroes", () => {
    // Rule 1. Zeroes here would turn "Full Disk Access is off" into "this topic
    // is never discussed in messages" — a permissions problem laundered into a
    // finding about the work.
    const [obs] = toObservations(
      "creator os",
      [sweep({ source: "imessage", searched: false, unavailableReason: "Full Disk Access required" })],
      base,
    )

    expect(obs.metrics).toEqual({})
    expect(obs.payload.searched).toBe(false)
    expect(obs.payload.unavailable_reason).toBe("Full Disk Access required")
  })

  test("a source that cannot see the prior window omits it rather than sending zero", () => {
    // Rule 2. files knows mtimes and nothing else. prior=0 against hits=30
    // would read as infinite growth — the most flattering possible lie.
    const [obs] = toObservations("creator os", [sweep({ source: "files", hits: 30 })], base)

    expect(obs.metrics.files_hits).toBe(30)
    expect(obs.metrics).not.toHaveProperty("files_hits_prior")
  })

  test("a real zero from a source that DID look is still sent", () => {
    const [obs] = toObservations("creator os", [sweep({ source: "diary", hits: 0, hitsPrior: 3 })], base)

    expect(obs.metrics.diary_hits).toBe(0)
    expect(obs.metrics.diary_hits_prior).toBe(3)
    expect(obs.payload.searched).toBe(true)
  })

  test("private-source TEXT stays on the machine by default; locators still travel", () => {
    const items = [{ when: "2026-08-18T00:00:00.000Z", where: "me → +15551234567", text: "the API key is sk-live-abc" }]

    const [withheld] = toObservations("creator os", [sweep({ source: "imessage", hits: 1, items })], base)

    expect(withheld.text).toBeNull()
    expect(withheld.payload.content_included).toBe(false)
    expect(JSON.stringify(withheld)).not.toContain("sk-live-abc")
    // Knowing WHICH conversation to open carries nothing private and is the
    // whole point of filing the sweep.
    expect(withheld.payload.locators[0].where).toBe("me → +15551234567")
    expect(withheld.payload.locators[0]).not.toHaveProperty("text")
  })

  test("--include-context is what makes private text travel", () => {
    const items = [{ when: "2026-08-18T00:00:00.000Z", where: "me → +15551234567", text: "ship the portal" }]

    const [shared] = toObservations(
      "creator os",
      [sweep({ source: "imessage", hits: 1, items })],
      { ...base, includeContext: true },
    )

    expect(shared.text).toContain("ship the portal")
    expect(shared.payload.content_included).toBe(true)
  })

  test("repo-born sources travel by default — they are already in a git history", () => {
    const items = [{ when: "2026-08-19T00:00:00.000Z", where: "fl-iris-api@712816f0", text: "feat(creator-os): allowlist" }]

    const [obs] = toObservations("creator os", [sweep({ source: "git", hits: 1, items })], base)

    expect(obs.text).toContain("feat(creator-os): allowlist")
    expect(obs.payload.content_included).toBe(true)
  })

  test("every observation targets one entity, so a re-run updates rather than forks", () => {
    const observations = toObservations(
      "Creator OS",
      [sweep({ source: "git", hits: 1 }), sweep({ source: "diary", hits: 1 }), sweep({ source: "email", searched: false, unavailableReason: "x" })],
      base,
    )

    expect(new Set(observations.map((o) => o.external_id))).toEqual(new Set(["topic:creator-os"]))
    expect(new Set(observations.map((o) => o.entity_type))).toEqual(new Set(["topic"]))
    expect(new Set(observations.map((o) => o.observed_at)).size).toBe(1)
  })
})

describe("resolveRepoRoot", () => {
  // REGRESSION (#181943). The strict "toplevel must equal the directory" test
  // belongs to gitlinks — an uninitialised one makes `git -C` answer about its
  // parent — but applying it to the ROOT argument reported "no git repository
  // at …/packages/opencode" for a directory plainly inside one. git, files and
  // diary all went dark, the answer dropped from 51 hits to 34, and the headline
  // still said "heating up". The honesty was in the small text; the confidence
  // was in the number.
  const here = import.meta.dir // …/packages/opencode/src/cli/cmd

  test("resolves a deep subdirectory to a repository root", () => {
    const root = resolveRepoRoot(here)
    expect(root).toBeTruthy()
    expect(here.startsWith(root!)).toBe(true)
  })

  test("climbs to the repo that CONTAINS this one as a gitlink", () => {
    // …/iris-code is itself a repo, but it is a component of the monorepo above
    // it, and "this project" means the outer one — that is where the diary and
    // the other ten repos live.
    const root = resolveRepoRoot(here)!
    expect(root.endsWith("/iris-code")).toBe(false)
  })

  test("the answer does not depend on which directory you ran from", () => {
    // The bug's real shape: same command, two directories, two different
    // answers, both stated with the same confidence.
    const deep = resolveRepoRoot(here)
    const top = resolveRepoRoot(resolveRepoRoot(here)!)
    expect(deep).toBe(top)
  })

  test("every nested repo is discovered from the resolved root", () => {
    const repos = gitRepos(resolveRepoRoot(here)!)
    // The parent plus its gitlinks — read from the index, since this monorepo
    // has no .gitmodules at all.
    expect(repos.length).toBeGreaterThan(1)
    expect(new Set(repos).size).toBe(repos.length)
  })
})

describe("toObservations — Atlas source", () => {
  test("an unresolvable board still sends no metrics when it could not look", () => {
    const [obs] = toObservations(
      "mayo life atlas",
      [sweep({ source: "bloq", searched: false, unavailableReason: "not signed in" })],
      { includeContext: false, windowDays: 30 },
    )
    expect(obs.metrics).toEqual({})
    expect(obs.payload.searched).toBe(false)
  })

  test("board item titles are NOT uploaded without --include-context", () => {
    // A life atlas holds finances, health and family. Its titles are the most
    // private text any source in this sweep produces.
    const items = [{ when: "2026-08-22T00:00:00.000Z", where: "Finances #181468", text: "THE MONEY MAP" }]
    const [obs] = toObservations(
      "mayo life atlas",
      [sweep({ source: "bloq", hits: 1, items })],
      { includeContext: false, windowDays: 30 },
    )
    expect(obs.text).toBeNull()
    expect(JSON.stringify(obs)).not.toContain("MONEY MAP")
    expect(obs.payload.locators[0].where).toBe("Finances #181468")
  })
})

/**
 * The iMessage collector, against a fixture database.
 *
 * This exists because of a bug that shipped and survived: the sweep matched
 * `message.text` and nothing else, so it was blind to every rich message (words
 * in the `attributedBody` blob, ~44% of a real week) and to every attachment
 * (a `RevOps-SaveLifeAI.pdf` was on the machine and unfindable by "revenue ops").
 *
 * Both misses reported `searched: true, hits: 0` — the exact shape this module's
 * rule 1 exists to forbid, reappearing one level down: the SOURCE was searched,
 * a structural subset of the ROWS was not, and nothing said so.
 */
describe("sweepImessage — the three places a message's words live", () => {
  const APPLE_EPOCH = 978307200
  const appleNs = (secondsAgo: number) =>
    (Math.floor(Date.now() / 1000) - secondsAgo - APPLE_EPOCH) * 1_000_000_000

  /** A plausible NSKeyedArchiver stream with the words buried in it. */
  const attributedBody = (text: string) =>
    Buffer.concat([
      Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01\x40\x84\x84\x84", "binary"),
      Buffer.from("NSMutableAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84", "binary"),
      Buffer.from("NSString\x01\x94\x84\x01\x2b", "binary"),
      Buffer.from(String.fromCharCode(text.length), "binary"),
      Buffer.from(text, "utf8"),
      Buffer.from("\x86\x84\x02iI\x01", "binary"),
    ]).toString("hex")

  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "pulse-imsg-"))
    const db = join(dir, "chat.db")
    const sql = `
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, text TEXT, attributedBody BLOB, handle_id INTEGER, is_from_me INTEGER);
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, transfer_name TEXT, filename TEXT);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);

INSERT INTO handle VALUES (1, '+15550001111');

-- 1. plain text: the case that already worked, kept as the control
INSERT INTO message VALUES (1, ${appleNs(3600)}, 'lets talk revenue ops on monday', NULL, 1, 0);

-- 2. rich message: text NULL, words only in the blob
INSERT INTO message VALUES (2, ${appleNs(7200)}, NULL, X'${attributedBody("here is the revenue ops deck")}', 1, 0);

-- 3. attachment: no words anywhere, the filename IS the trail
INSERT INTO message VALUES (3, ${appleNs(10800)}, NULL, NULL, 1, 0);
INSERT INTO attachment VALUES (1, 'RevenueOps-Teardown.pdf', '~/Library/Messages/Attachments/aa/RevenueOps-Teardown.pdf');
INSERT INTO message_attachment_join VALUES (3, 1);

-- 4. unrelated, must not match
INSERT INTO message VALUES (4, ${appleNs(1800)}, 'dinner at 8', NULL, 1, 0);
`
    execFileSync("sqlite3", [db], { input: sql, encoding: "utf8" })
    return db
  }

  const run = (keyword: string, db: string) =>
    sweepImessage({ keyword, repo: process.cwd(), windowDays: 30, limit: 10, sources: ["imessage"], messagesDb: db })

  test("finds words in text, in attributedBody, AND in an attachment filename", () => {
    const db = fixture()
    try {
      const r = run("revenue ops", db)
      expect(r.searched).toBe(true)
      // three hits, one per place a message can carry the topic
      expect(r.hits).toBe(3)
      expect(r.items.map((i) => i.text ?? "").join(" | ")).toContain("monday")
    } finally {
      rmSync(db.replace(/\/chat\.db$/, ""), { recursive: true, force: true })
    }
  })

  test("a rich message with NULL text is not invisible", () => {
    const db = fixture()
    try {
      const found = run("revenue ops", db).items.find((i) => (i.text ?? "").includes("deck"))
      expect(found).toBeDefined()
      // and what is shown is the sentence, not the archive's class names
      expect(found!.text).not.toContain("NSMutableAttributedString")
      expect(found!.text).not.toContain("streamtyped")
    } finally {
      rmSync(db.replace(/\/chat\.db$/, ""), { recursive: true, force: true })
    }
  })

  test("an attachment hit is labelled as a file, not folded into the message body", () => {
    const db = fixture()
    try {
      const found = run("revenue ops", db).items.find((i) => (i.text ?? "").includes("RevenueOps-Teardown.pdf"))
      expect(found).toBeDefined()
      expect(found!.text!.startsWith("📎")).toBe(true)
    } finally {
      rmSync(db.replace(/\/chat\.db$/, ""), { recursive: true, force: true })
    }
  })

  test("an unrelated message stays unmatched — the widened net still has holes in it", () => {
    const db = fixture()
    try {
      expect(run("revenue ops", db).items.some((i) => (i.text ?? "").includes("dinner"))).toBe(false)
      expect(run("dinner", db).hits).toBe(1)
    } finally {
      rmSync(db.replace(/\/chat\.db$/, ""), { recursive: true, force: true })
    }
  })

  test("a missing database reports why rather than returning a clean zero", () => {
    const r = run("revenue ops", join(tmpdir(), "definitely-not-a-chat-db-9137"))
    expect(r.searched).toBe(false)
    expect(r.hits).toBe(0)
    expect(r.unavailableReason).toContain("no Messages database")
  })
})

describe("decodeAttributedBody", () => {
  test("returns the sentence and drops the archiver's vocabulary", () => {
    const raw = "\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84NSMutableAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84NSString\x01\x94\x84\x01+\x1bhere is the revenue ops deck\x86"
    const out = decodeAttributedBody(raw)
    expect(out).toContain("here is the revenue ops deck")
    expect(out).not.toContain("NSString")
    expect(out).not.toContain("streamtyped")
  })

  test("an undecodable blob yields empty rather than garbage", () => {
    expect(decodeAttributedBody("\x00\x01\x02\x03")).toBe("")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PC-07 — one subject must produce one answer, however it is spelled.
//
// Written before the implementation. The existing variant list matches N LITERAL
// strings, so it can only find the separators someone thought to enumerate:
// `pulse check "MAYO — Life Atlas"` found 6 diary / 13 files and
// `pulse check "mayo life atlas"` found 4 / 8 — the same board, two confident
// answers. Matching the token SEQUENCE with any separator collapses that.
// ─────────────────────────────────────────────────────────────────────────────

describe("keywordPattern", () => {
  // Spellings that carry a SEPARATOR. The concatenated form is deliberately not
  // here: "MAYOLIFEATLAS" cannot be split back into three words without a
  // dictionary, so expecting it to compile to the same pattern was a wrong
  // assumption in the test, not a gap in the code. It still has to MATCH.
  const SEPARATED = [
    "MAYO — Life Atlas",
    "mayo life atlas",
    "Mayo-Life-Atlas",
    "mayo_life_atlas",
    "  mayo / life / atlas  ",
  ]
  const SPELLINGS = [...SEPARATED, "MAYOLIFEATLAS"]

  test("every separated spelling of one subject compiles to the SAME pattern", () => {
    const patterns = new Set(SEPARATED.map((s) => keywordPattern(s)))
    expect([...patterns]).toHaveLength(1)
  })

  test("that one pattern matches every spelling, concatenation included", () => {
    const re = new RegExp(keywordPattern("mayo life atlas")!, "i")
    for (const spelling of SPELLINGS) expect(re.test(spelling)).toBe(true)
    // and the forms that actually occur in prose
    expect(re.test("the MAYO — Life Atlas bloq #544")).toBe(true)
    expect(re.test("see mayo/life/atlas")).toBe(true)
  })

  test("a separator run cannot span a paragraph break", () => {
    // `[^a-z0-9]*` would let "…mayo." at the end of one paragraph join "Life
    // Atlas" at the start of the next and call it a hit. Real separators are at
    // most a few characters; the bound is what keeps the match local.
    const re = new RegExp(keywordPattern("mayo life atlas")!, "i")
    expect(re.test("mayo — life atlas")).toBe(true)
    expect(re.test("...mayo.\n\n## Life Atlas is elsewhere")).toBe(false)
  })

  test("regex metacharacters in the subject cannot break or inject", () => {
    // The pattern is built from alphanumeric TOKENS, so metacharacters are
    // separators by construction and never reach the regex engine as syntax.
    for (const nasty of ["a.b*c", "C++", "x)|(y", "[a-z]", "$(whoami)"]) {
      expect(() => new RegExp(keywordPattern(nasty)!)).not.toThrow()
    }
    expect(new RegExp(keywordPattern("a.b")!, "i").test("a-b")).toBe(true)
    expect(new RegExp(keywordPattern("a.b")!, "i").test("axb")).toBe(false)
  })

  test("a subject with no alphanumerics is refused rather than matching everything", () => {
    // "" or "***" would compile to an empty pattern that matches every line.
    expect(keywordPattern("***")).toBeNull()
    expect(keywordPattern("   ")).toBeNull()
  })
})

describe("PC-07 — collectors agree across spellings", () => {
  const repo = resolveRepoRoot(import.meta.dir)!
  const base = { repo, windowDays: 3650, limit: 500, sources: [] as any }

  test("sweepDiary returns the SAME hits for a punctuated and a plain spelling", () => {
    const a = sweepDiary({ ...base, keyword: "MAYO — Life Atlas" })
    const b = sweepDiary({ ...base, keyword: "mayo life atlas" })

    expect(a.searched && b.searched).toBe(true)
    // Set equality, not containment. Containment is what the variant list
    // earned; equality is the actual requirement.
    expect(new Set(a.items.map((i) => i.where))).toEqual(new Set(b.items.map((i) => i.where)))
    expect(a.hits).toBe(b.hits)
  })

  // 30s: this greps every tracked file in every repo under the root, twice. It passes
  // alone and exceeded the 5s default inside the full suite — a timeout here reads as a
  // logic failure, which is the most expensive kind of false alarm.
  test("sweepFiles returns the SAME hits for a punctuated and a plain spelling", () => {
    const a = sweepFiles({ ...base, keyword: "MAYO — Life Atlas" })
    const b = sweepFiles({ ...base, keyword: "mayo life atlas" })

    expect(a.searched && b.searched).toBe(true)
    expect(new Set(a.items.map((i) => i.where))).toEqual(new Set(b.items.map((i) => i.where)))
    expect(a.hits).toBe(b.hits)
  }, 30000)

  test("the punctuated spelling still finds the em-dashed occurrences", () => {
    // The regression guard in the other direction: collapsing to a canonical
    // token form must not LOSE the hits the punctuated spelling used to find.
    const a = sweepDiary({ ...base, keyword: "MAYO — Life Atlas" })
    expect(a.hits).toBeGreaterThan(0)
  })
})

describe("parseMailResponse — a moved response key must not read as zero mail", () => {
  test("reads the envelope-index shape (emails / date_sent)", () => {
    const rows = parseMailResponse({
      emails: [{ subject: "Your IRIS access code", sender: "alex@freelabel.net", sender_name: "FREELABEL", date_sent: "2026-08-23T16:27:25.000Z" }],
      count: 1,
    })
    expect(rows).toHaveLength(1)
    expect(rows![0].where).toBe("FREELABEL · Your IRIS access code")
    expect(rows![0].when).toBe("2026-08-23T16:27:25.000Z")
  })

  test("still reads the older AppleScript shape (messages / date)", () => {
    const rows = parseMailResponse({ messages: [{ subject: "hi", sender: "a@b.c", date: "2026-08-01T00:00:00.000Z" }] })
    expect(rows).toHaveLength(1)
    expect(rows![0].where).toBe("a@b.c · hi")
  })

  test("an UNRECOGNISED shape returns null, never an empty array", () => {
    // The live regression: `emails` replaced `messages`, the collector read
    // `messages ?? []`, and pulse check reported "none" while a direct call to
    // the same endpoint returned real mail. Zero is a claim about the mailbox;
    // this is a claim about the parser, and they must not look alike.
    expect(parseMailResponse({ items: [{ subject: "x" }] })).toBeNull()
    expect(parseMailResponse({})).toBeNull()
    expect(parseMailResponse(null)).toBeNull()
    expect(parseMailResponse("nope")).toBeNull()
  })

  test("a genuinely empty mailbox is still an empty array, not null", () => {
    expect(parseMailResponse({ emails: [], count: 0 })).toEqual([])
  })
})
