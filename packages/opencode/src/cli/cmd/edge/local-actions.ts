/**
 * Local actions: an app served on this computer asks for things only this computer can do
 * (#194354, epic #194350) — IRIS's answer to Claude's "full computer access", narrow on purpose.
 *
 * THE PAGE DECLARES, THE PERSON APPROVES, THIS PROCESS ENFORCES.
 *
 *   json_content.local = {
 *     "notify":   true,                                   // send a notification
 *     "agents":   ["pause", "resume"],                    // on agents this account owns
 *     "files":    ["~/Reports", "~/Reports/q3.pdf"],      // opened in their own app, never read into the page
 *     "commands": { "backup": ["rsync", "-a", "~/Docs", "/Volumes/B"] }   // exactly this argv, no shell
 *   }
 *
 * Nothing outside this allowlist exists here: there is no "run a shell", no "read a file into the
 * page", no argument a page can pass to a command. A page can only name an entry it declared.
 *
 * APPROVAL IS PER APP VERSION. The version is a hash of the declared powers AND the page document,
 * so a publish that changes what the app does — or only the code that calls these — asks again.
 * The person approves OUTSIDE the page (an OS dialog, or `iris pages allow <slug>`): a button
 * inside the page could be clicked by the page itself.
 *
 * EVERY CALL IS LOGGED to ~/.iris/served/<slug>/local-actions.log, refused ones included.
 *
 * The HTTP checks (this computer, this page) are the live server's — see live.ts. This module adds
 * what is specific to acting on the machine.
 */
import { createHash } from "crypto"
import { execFile } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

export interface LocalDecl {
  notify?: boolean
  agents?: ("pause" | "resume")[]
  files?: string[]
  commands?: Record<string, string[]>
}

export type Runner = (file: string, args: string[]) => Promise<{ code: number; out: string }>
export type Approver = (summary: string[], slug: string) => Promise<boolean>

// "trigger" waits for a CLI command that starts a run; until then it is not offered at all.
const AGENT_VERBS = ["pause", "resume"] as const

/** Read a page's `local` block, keeping only what this module knows. Unknown keys are dropped, not honoured. */
export function parseDecl(raw: unknown): LocalDecl | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const d: LocalDecl = {}
  if (r.notify === true) d.notify = true
  if (Array.isArray(r.agents)) d.agents = AGENT_VERBS.filter((v) => (r.agents as unknown[]).includes(v))
  if (Array.isArray(r.files)) d.files = r.files.filter((f): f is string => typeof f === "string" && f.length > 0 && f.length < 1024).slice(0, 50)
  if (r.commands && typeof r.commands === "object" && !Array.isArray(r.commands)) {
    const c: Record<string, string[]> = {}
    for (const [name, argv] of Object.entries(r.commands as Record<string, unknown>)) {
      if (/^[A-Za-z0-9_.-]{1,64}$/.test(name) && Array.isArray(argv) && argv.length && argv.every((a) => typeof a === "string")) c[name] = argv as string[]
    }
    if (Object.keys(c).length) d.commands = c
  }
  return Object.keys(d).length ? d : null
}

/** The app version an approval is for: what it may do, plus the code that does it. */
export function appVersion(decl: LocalDecl, documentHtml: string): string {
  return createHash("sha256").update(JSON.stringify(decl)).update("\0").update(documentHtml).digest("hex").slice(0, 16)
}

export function expandHome(p: string, home = os.homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p
}

/** What the person is asked to approve, in words — every power, with the exact files and commands. */
export function describe(decl: LocalDecl): string[] {
  const out: string[] = []
  if (decl.notify) out.push("Show notifications")
  if (decl.agents?.length) out.push(`${decl.agents.map((v) => v[0]!.toUpperCase() + v.slice(1)).join(", ")} your agents`)
  for (const f of decl.files ?? []) out.push(`Open ${f}`)
  for (const [name, argv] of Object.entries(decl.commands ?? {})) out.push(`Run "${name}": ${argv.join(" ")}`)
  return out
}

interface Approvals {
  [version: string]: { approved_at: string; powers: string[] }
}

export class LocalActions {
  constructor(
    private slug: string,
    private dir: string,
    private decl: () => Promise<LocalDecl | null>,
    private document: () => Promise<string | null>,
    private run: Runner,
    private approve: Approver,
    private self: string[] = ["iris"],
  ) {}

  private log(entry: Record<string, unknown>) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(path.join(this.dir, "local-actions.log"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n")
    } catch {}
  }

  private approvals(): Approvals {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, "approvals.json"), "utf8"))
    } catch {
      return {}
    }
  }

  /** Record an approval for the current version. Used by the dialog and by `iris pages allow`. */
  grant(version: string, powers: string[]) {
    const a = this.approvals()
    a[version] = { approved_at: new Date().toISOString(), powers }
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(path.join(this.dir, "approvals.json"), JSON.stringify(a, null, 2))
    this.log({ event: "approved", version, powers })
  }

  async current(): Promise<{ decl: LocalDecl; version: string } | null> {
    const [decl, doc] = await Promise.all([this.decl(), this.document()])
    if (!decl || doc === null) return null
    return { decl, version: appVersion(decl, doc) }
  }

  /** What the page may call right now, and whether it is approved — for iris.local.available(). */
  async status() {
    const cur = await this.current()
    if (!cur) return { available: false as const }
    return { available: true as const, approved: !!this.approvals()[cur.version], powers: describe(cur.decl) }
  }

  async call(action: string, args: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const refuse = (status: number, reason: string, error: string) => {
      this.log({ action, result: "refused", reason })
      return { status, body: { ok: false, reason, error } }
    }
    const cur = await this.current()
    if (!cur) return refuse(404, "no_local_actions", "This app asks for nothing on this computer.")
    const { decl, version } = cur

    // Resolve the call against the DECLARATION before asking anyone anything: an undeclared
    // action is refused without a dialog, so a page cannot spam prompts for powers it never listed.
    let file = ""
    let argv: string[] = []
    let label = action
    if (action === "notify" && decl.notify) {
      const title = String(args.title ?? "").slice(0, 120)
      const body = String(args.body ?? "").slice(0, 400)
      ;[file, argv] = notifyCommand(title || this.slug, body)
    } else if (action.startsWith("agents.") && decl.agents?.includes(action.slice(7) as any)) {
      const id = Number(args.id)
      if (!Number.isInteger(id) || id <= 0) return refuse(422, "bad_agent_id", "Which agent? Pass its number.")
      const verb = action.slice(7)
      ;[file, ...argv] = [...this.self, "agents", verb, String(id)]
      label = `${action} ${id}`
    } else if (action === "open" && decl.files?.length) {
      const want = String(args.path ?? "")
      if (!decl.files.includes(want)) return refuse(403, "file_not_listed", "That file is not one this app may open.")
      ;[file, argv] = openCommand(expandHome(want))
      label = `open ${want}`
    } else if (action.startsWith("command.") && decl.commands?.[action.slice(8)]) {
      const listed = decl.commands[action.slice(8)]!.map((a) => expandHome(a))
      ;[file, ...argv] = listed
    } else {
      return refuse(403, "not_declared", `This app did not ask to "${action}".`)
    }

    if (!this.approvals()[version]) {
      const powers = describe(decl)
      const ok = await this.approve(powers, this.slug).catch(() => false)
      if (!ok) return refuse(403, "not_approved", `Not allowed yet. Allow it on this computer: iris pages allow ${this.slug}`)
      this.grant(version, powers)
    }

    const res = await this.run(file, argv).catch((e) => ({ code: -1, out: String(e?.message ?? e) }))
    this.log({ action: label, version, result: res.code === 0 ? "ok" : "failed", code: res.code })
    return res.code === 0
      ? { status: 200, body: { ok: true, output: res.out.slice(-2000) } }
      : { status: 502, body: { ok: false, reason: "failed", error: "It did not work on this computer.", output: res.out.slice(-2000) } }
  }
}

// ── per-OS commands. argv only, never a shell string. ───────────────────────────────────────────

function asAppleScriptString(s: string) {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

export function notifyCommand(title: string, body: string, platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["osascript", ["-e", `display notification ${asAppleScriptString(body)} with title ${asAppleScriptString(title)}`]]
  if (platform === "win32") {
    // The text goes in as environment-free literals inside a single-quoted PowerShell string.
    const q = (s: string) => "'" + s.replace(/'/g, "''") + "'"
    return [
      "powershell",
      ["-NoProfile", "-Command", `[void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;$n.ShowBalloonTip(6000,${q(title)},${q(body)},'Info');Start-Sleep 7;$n.Dispose()`],
    ]
  }
  return ["notify-send", [title, body]]
}

export function openCommand(target: string, platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [target]]
  if (platform === "win32") return ["explorer.exe", [target]]
  return ["xdg-open", [target]]
}

/** An OS dialog the page cannot click: approval happens outside the browser. */
export function dialogCommand(slug: string, powers: string[], platform = process.platform): [string, string[]] | null {
  const text = `The app "${slug}" wants to:\n\n• ${powers.join("\n• ")}\n\nAllow this version of it?`
  if (platform === "darwin")
    return ["osascript", ["-e", `button returned of (display dialog ${asAppleScriptString(text)} with title "IRIS" buttons {"Don't allow", "Allow"} default button "Don't allow")`]]
  if (platform === "win32") {
    const q = "'" + text.replace(/'/g, "''") + "'"
    return ["powershell", ["-NoProfile", "-Command", `Add-Type -AssemblyName PresentationFramework;[System.Windows.MessageBox]::Show(${q},'IRIS','YesNo','Question')`]]
  }
  return ["zenity", ["--question", "--title=IRIS", `--text=${text}`, "--ok-label=Allow", "--cancel-label=Don't allow"]]
}

export const execRunner: Runner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 120000, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as any).code ?? 1) : 0, out: String(stdout) + String(stderr) })
    })
  })

export const dialogApprover: Approver = async (powers, slug) => {
  const cmd = dialogCommand(slug, powers)
  if (!cmd) return false
  const r = await execRunner(cmd[0], cmd[1])
  if (process.platform === "win32") return /Yes/.test(r.out)
  if (process.platform === "darwin") return r.code === 0 && /Allow/.test(r.out) && !/Don't/.test(r.out)
  return r.code === 0
}
