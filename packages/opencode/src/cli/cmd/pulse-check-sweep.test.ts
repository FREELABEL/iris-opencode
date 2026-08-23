import { describe, expect, test } from "bun:test"
import { keywordVariants, topicSlug, toObservations, resolveRepoRoot, gitRepos, sweepImessage, decodeAttributedBody, type SourceSweep } from "./pulse-check-sweep"
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
