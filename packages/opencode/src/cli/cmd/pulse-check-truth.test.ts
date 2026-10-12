import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  currentSessionIds,
  nestedRepos,
  sweepRepos,
  sweepGit,
  sweepClaudeCode,
  sweepBloq,
  sweepDiaryAtlas,
  sweepAll,
  type SweepOptions,
} from "./pulse-check-sweep"

// #189155 — where `iris pulse check` read wrong, measured 2026-10-12.

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString()
const opts = (o: Partial<SweepOptions>): SweepOptions => ({ keyword: "heartbeat", repo: ".", windowDays: 7, limit: 20, sources: [], ...o })
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })

describe("commits: a work folder holding repos is not 'no commits'", () => {
  const work = mkdtempSync(join(tmpdir(), "pc-work-"))
  git(work, "init", "-q") // the folder is itself a repo with NO commits — the measured case
  const a = join(work, "api")
  mkdirSync(a)
  git(a, "init", "-q")
  writeFileSync(join(a, "f.txt"), "x")
  git(a, "add", ".")
  git(a, "commit", "-q", "-m", "fix(heartbeat): keep every beat")
  const b = join(work, "nested", "cli")
  mkdirSync(b, { recursive: true })
  git(b, "init", "-q")
  writeFileSync(join(b, "g.txt"), "y")
  git(b, "add", ".")
  git(b, "commit", "-q", "-m", "heartbeat tab")
  git(a, "worktree", "add", "-q", join(work, "api-wt"), "-b", "wt") // a worktree of api: same history
  mkdirSync(join(work, "node_modules", "dep"), { recursive: true })
  git(join(work, "node_modules", "dep"), "init", "-q")

  test("finds the independent repos below, once per history, skipping node_modules", () => {
    const repos = nestedRepos(work)
    expect(repos).toEqual([a, b].sort())
  })
  test("the enclosing empty repo hands over to the repos below it", () => {
    expect(sweepRepos(work)?.repos.sort()).toEqual([a, b].sort())
  })
  test("both commits are counted, and the worktree does not double one", () => {
    const s = sweepGit(opts({ repo: work }))
    expect(s.searched).toBe(true)
    expect(s.hits).toBe(2)
  })
  test("a repo WITH history keeps the monorepo behaviour (no walking below it)", () => {
    expect(sweepRepos(a)?.repos).toEqual([a])
  })
  test("cleanup", () => rmSync(work, { recursive: true, force: true }))
})

describe("the session running the check is not evidence", () => {
  test("ids come from the host's environment", () => {
    expect(currentSessionIds({ CLAUDE_CODE_SESSION_ID: "98a84008-f8ba-572d", OPENCODE_SESSION_ID: "short" })).toEqual(["98a84008-f8ba-572d"])
    expect(currentSessionIds({})).toEqual([])
  })
  test("its transcript and its subagents' are left out, and the line says so", () => {
    const home = mkdtempSync(join(tmpdir(), "pc-home-"))
    const proj = join(home, ".claude", "projects", "p")
    mkdirSync(join(proj, "self-session-id", "subagents"), { recursive: true })
    writeFileSync(join(proj, "self-session-id.jsonl"), "iris pulse check heartbeat\n")
    writeFileSync(join(proj, "self-session-id", "subagents", "agent-1.jsonl"), "heartbeat\n")
    writeFileSync(join(proj, "other-session.jsonl"), "we fixed the heartbeat\n")
    const root = join(home, ".claude", "projects")
    try {
      const all = sweepClaudeCode(opts({}), root)
      expect(all.hits).toBe(3)
      const s = sweepClaudeCode(opts({ excludeSessions: ["self-session-id"] }), root)
      expect(s.hits).toBe(1)
      expect(s.unavailableReason).toBe("left out the session running this check (2 transcript files)")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("Atlas: a topic matching several boards reads them, not 0", () => {
  const now = new Date().toISOString()
  const fetch = async (path: string) => {
    if (path.includes("/bloqs?")) return json({ data: [{ id: 1, name: "Heartbeat ops" }, { id: 2, name: "Heartbeat design" }, { id: 3, name: "Other" }] })
    if (path.endsWith("/bloqs/1")) return json({ data: { id: 1, name: "Heartbeat ops", lists: [{ id: 10, name: "Bugs", items: [{ id: 100, title: "skips", updated_at: now }] }] } })
    if (path.endsWith("/bloqs/2")) return json({ data: { id: 2, name: "Heartbeat design", lists: [{ id: 20, name: "Ideas", items: [{ id: 200, title: "week", updated_at: now }, { id: 201, title: "beat", updated_at: now }] }] } })
    return json({ data: [] })
  }
  test("merges every matching board and names them", async () => {
    const s = await sweepBloq(opts({ apiFetch: fetch as any, userId: 193 }))
    expect(s.searched).toBe(true)
    expect(s.hits).toBe(3)
    expect(s.unavailableReason).toBe('read 2 boards matching "heartbeat": #1 Heartbeat ops, #2 Heartbeat design')
  })
})

describe("Atlas text search reads the shape the endpoint actually returns", () => {
  test("data: { items: [...] } is rows, not zero", async () => {
    const now = new Date().toISOString()
    const fetch = async (path: string) => {
      if (path.includes("/bloqs?")) return json({ data: [{ id: 3, name: "Other" }] })
      if (path.includes("content-items")) return json({ success: true, data: { items: [{ id: 189141, title: "Heartbeat deliverable", updated_at: now, list_name: "Bugs" }] } })
      return json({ data: [] })
    }
    const s = await sweepBloq(opts({ apiFetch: fetch as any, userId: 193 }))
    expect(s.hits).toBe(1)
  })
})

describe("diary: no local folder reads the Atlas diary instead of 'shut'", () => {
  const day = (d: number) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10)
  const fetch = async (path: string) => {
    if (path.includes("/bloqs?")) return json({ data: [{ id: 336, name: "My Diary" }, { id: 9, name: "Work" }] })
    if (path.endsWith("/bloqs/336"))
      return json({
        data: {
          lists: [
            { id: 1, name: "Ideas", items: [{ id: 1, title: day(1), description: "heartbeat idea" }] }, // not a diary list
            {
              id: 1131,
              name: "Daily Diary",
              items: [
                { id: 11, title: day(1), description: "# Daily Diary\nShipped the heartbeat tab." },
                { id: 12, title: day(2), description: "Nothing on it." },
                { id: 13, title: day(10), description: "heartbeat bugs filed" }, // prior window
              ],
            },
          ],
        },
      })
    return json({ data: {} })
  }
  test("finds the entry, counts the prior window, says where it read", async () => {
    const s = await sweepDiaryAtlas(opts({ apiFetch: fetch as any, userId: 193 }))
    expect(s.searched).toBe(true)
    expect(s.hits).toBe(1)
    expect(s.hitsPrior).toBe(1)
    expect(s.items[0].text).toBe("Shipped the heartbeat tab.")
    expect(s.unavailableReason).toBe("read from the Atlas diary (no local daily-diary folder)")
  })
  test("sweepAll falls back to it when there is no local folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pc-nodiary-"))
    const out = await sweepAll(opts({ repo: dir, sources: ["diary"], apiFetch: fetch as any, userId: 193 }))
    expect(out[0].searched).toBe(true)
    expect(out[0].hits).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })
})
