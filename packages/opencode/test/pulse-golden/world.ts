/**
 * The fixed world the Pulse golden test runs the CLI in (#189244). Everything here is invented:
 * the topic is "widget", the lead is "Dana Example" at example.com, the board is "Widget Lab".
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs"
import { execFileSync } from "child_process"
import { join } from "path"
import { tmpdir } from "os"

export const NOW = "2026-09-15T12:00:00.000Z"
const NOW_MS = Date.parse(NOW)
const DAY = 864e5
export const ago = (days: number) => new Date(NOW_MS - days * DAY).toISOString()

export const USER_ID = 42

export interface World {
  root: string
  home: string
  repo: string
  routes: string
  log: string
  dispose(): void
}

function touch(path: string, daysAgo: number) {
  const t = new Date(NOW_MS - daysAgo * DAY)
  utimesSync(path, t, t)
}

function write(path: string, body: string, daysAgo?: number) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, body)
  if (daysAgo !== undefined) touch(path, daysAgo)
}

function git(repo: string, args: string[], date?: string) {
  execFileSync("git", ["-C", repo, ...args], {
    stdio: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Golden Author",
      GIT_AUTHOR_EMAIL: "author@example.com",
      GIT_COMMITTER_NAME: "Golden Author",
      GIT_COMMITTER_EMAIL: "author@example.com",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  })
}

/** A repo with commits in this window, the window before and earlier; a diary unless `diary: false`. */
function buildRepo(repo: string, opts: { diary: boolean }) {
  mkdirSync(repo, { recursive: true })
  git(repo, ["init", "-q", "-b", "main"])
  const commit = (file: string, body: string, subject: string, daysAgo: number) => {
    write(join(repo, file), body)
    git(repo, ["add", "."])
    git(repo, ["commit", "-q", "-m", subject], ago(daysAgo))
  }
  commit("README.md", "# demo\n", "chore: start", 90)
  commit("src/widget.ts", "export const widget = 1\n", "feat(widget): first cut of the widget", 45)
  commit("src/widgets.ts", "export const widgets = [] // widget list\n", "fix: widgets render twice", 10)
  commit("docs/notes.md", "Nothing about it here.\n", "docs: unrelated note", 4)
  commit("src/widget-panel.ts", "// Widget panel\n", "feat(Widget): panel for the widget", 3)
  touch(join(repo, "src/widget.ts"), 20)
  touch(join(repo, "src/widgets.ts"), 10)
  touch(join(repo, "src/widget-panel.ts"), 3)
  if (opts.diary) {
    write(join(repo, "daily-diary/2026-09-12.md"), "# 2026-09-12\n\n- Shipped the widget panel.\n- Lunch.\n")
    write(join(repo, "daily-diary/2026-08-01.md"), "# 2026-08-01\n\nPlanned the widget.\n")
    write(join(repo, "daily-diary/2026-09-01.md"), "# 2026-09-01\n\nNothing relevant.\n")
  }
}

function buildHome(home: string) {
  const projects = join(home, ".claude", "projects", "-work-demo")
  write(join(projects, "11111111-aaaa-4bbb-8ccc-000000000001.jsonl"), '{"text":"talked about the widget"}\n', 2)
  write(join(projects, "11111111-aaaa-4bbb-8ccc-000000000002.jsonl"), '{"text":"widgets again"}\n', 12)
  write(join(projects, "11111111-aaaa-4bbb-8ccc-000000000003.jsonl"), '{"text":"widget, early"}\n', 50)
  write(join(projects, "11111111-aaaa-4bbb-8ccc-000000000004.jsonl"), '{"text":"nothing"}\n', 5)

  const storage = join(home, ".local", "share", "opencode", "storage")
  write(join(storage, "part", "msg_1", "prt_1.json"), '{"sessionID":"ses_golden000001","text":"widget plan"}', 6)
  write(join(storage, "part", "msg_2", "prt_2.json"), '{"sessionID":"ses_golden000002","text":"other"}', 6)
  write(
    join(storage, "session", "proj", "ses_golden000001.json"),
    '{"id":"ses_golden000001","title":"Widget refactor","directory":"/work/widget-app"}',
    70,
  )
}

export function makeWorld(name: string, opts: { diary?: boolean; routes: unknown[] }): World {
  const root = mkdtempSync(join(tmpdir(), `pulse-golden-${name}-`))
  const home = join(root, "home")
  const repo = join(root, "repo")
  mkdirSync(home, { recursive: true })
  buildRepo(repo, { diary: opts.diary !== false })
  buildHome(home)
  const routes = join(root, "routes.json")
  writeFileSync(routes, JSON.stringify(opts.routes))
  return { root, home, repo, routes, log: join(root, "unmatched.log"), dispose: () => rmSync(root, { recursive: true, force: true }) }
}

// ── API / bridge answers ──────────────────────────────────────────────────

const board = {
  id: 9001,
  name: "Widget Lab",
  lists: [
    {
      id: 1,
      name: "Backlog",
      items: [
        { id: 101, title: "Widget sizing", updated_at: ago(2) },
        { id: 102, title: "Widget colours", updated_at: ago(40) },
        { id: 103, title: "Archive me", updated_at: ago(200) },
      ],
    },
    { id: 2, name: "Auto: nightly digest", items: [] },
    { id: 3, name: "Old ideas", items: [{ id: 104, title: "Gadget", updated_at: ago(150) }] },
  ],
}

const diaryBoard = {
  id: 9002,
  name: "Daily Diary",
  lists: [
    {
      id: 7,
      name: "Daily Diary",
      items: [
        { id: 201, title: "2026-09-10", description: "Reviewed the widget metrics.\nThen lunch." },
        { id: 202, title: "2026-08-05", description: "Widget kickoff." },
        { id: 203, title: "2026-09-11", description: "Nothing relevant." },
      ],
    },
  ],
}

/** Topic route: Atlas board match, Apple Mail via the bridge, Gmail via the platform. */
const gmailExec = (action: string, extra = "") => ({
  method: "POST",
  match: `/api/v1/users/${USER_ID}/integrations/execute-direct`,
  bodyMatch: `"integration":"gmail","action":"${action}"${extra}`,
})

export function topicRoutes(): unknown[] {
  return [
    { ...gmailExec("get_labels"), body: { success: true, data: { labels: [{ id: "INBOX", name: "INBOX" }] } } },
    // the prior-window query carries older_than; match it before the current-window one
    { ...gmailExec("read_emails"), bodyMatch: "older_than:30d", body: { success: true, data: { messages: [{ messageId: "m0", sender: "Old Sender <old@example.net>", subject: "widget idea", messageTimestamp: ago(40) }] } } },
    {
      ...gmailExec("read_emails"),
      body: {
        success: true,
        data: {
          messages: [
            { messageId: "m1", sender: "Sam Sample <sam@example.net>", subject: "Widget demo", messageTimestamp: ago(2), preview: { body: "the widget demo went well" } },
            { messageId: "m2", sender: "Lee Placeholder <lee@example.net>", subject: "", messageTimestamp: ago(6), preview: { body: "about the widgets" } },
          ],
        },
      },
    },
    { match: "/health", body: { ok: true } },
    {
      match: "/api/mail/search?subject=widget",
      body: {
        emails: [
          { date_sent: ago(1), sender_name: "Sam Sample", subject: "Re: widget pricing" },
          { date_sent: ago(8), sender_name: "Lee Placeholder", subject: "widget specs" },
        ],
      },
    },
    { match: `/api/v1/user/${USER_ID}/bloqs?simplified=1`, body: { data: [board, diaryBoard].map(({ id, name }) => ({ id, name })) } },
    { match: `/api/v1/user/${USER_ID}/bloqs/9001`, body: { data: board } },
    { match: `/api/v1/user/${USER_ID}/bloqs/9002`, body: { data: diaryBoard } },
    {
      match: `/api/v1/user/${USER_ID}/bloqs/content-items`,
      body: { data: { items: [{ id: 301, title: "Widget FAQ", list_name: "Docs", updated_at: ago(5) }] } },
    },
  ]
}

/** Topic route, second shape: no board by that name (text search) and no local diary (Atlas). */
export function topicRoutesTextSearch(): unknown[] {
  return [
    { ...gmailExec("get_labels"), status: 410, body: { success: false, error: "ConnectedAccountExpired" } },
    { match: "/health", status: 503, body: { ok: false } },
    { match: `/api/v1/user/${USER_ID}/bloqs?simplified=1`, body: { data: [{ id: 9002, name: "Daily Diary" }, { id: 9003, name: "Gizmo Board" }] } },
    { match: `/api/v1/user/${USER_ID}/bloqs/9002`, body: { data: diaryBoard } },
    {
      match: `/api/v1/user/${USER_ID}/bloqs/content-items`,
      body: {
        data: {
          items: [
            { id: 301, title: "Widget FAQ", list_name: "Docs", updated_at: ago(5) },
            { id: 302, title: "widget launch checklist", list_name: "Launch", updated_at: ago(45) },
            { id: 303, title: "Unrelated card", list_name: "Docs", updated_at: ago(3) },
          ],
        },
      },
    },
  ]
}
