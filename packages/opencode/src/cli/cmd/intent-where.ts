/**
 * Where a picked command will actually run (#189480).
 *
 * `iris intent` chose the right command for "respond to the job outreach emails in my Apple
 * Mail inbox" and said nothing about where it runs. On the cloud box that command could see no
 * mail, and the online Mac with apple_mail went unmentioned, so the next step was SSH. Intent
 * now names the machine for commands that read one machine's own data.
 */

/** Commands that read a machine's local data, by the bridge provider that serves them. */
const LOCAL_SOURCES: Array<{ prefix: RegExp; source: string }> = [
  // Word boundary: `iris mailing` is the bulk-mail product and runs in the cloud.
  { prefix: /^iris\s+mail(\s|$)/, source: "apple_mail" },
  { prefix: /^iris\s+imessage(\s|$)/, source: "imessage" },
]

export function localSourceOf(line: string): string | null {
  const l = String(line ?? "").trim()
  return LOCAL_SOURCES.find((s) => s.prefix.test(l))?.source ?? null
}

export type Reach = { state: string; node_name?: string; reason?: string } | null

/** One line for the intent output, or null when there is nothing to say. */
export function whereItRuns(line: string, a: { platform: string; localAvailable?: boolean; reach: Reach }): string | null {
  const source = localSourceOf(line)
  if (!source) return null
  if (a.platform === "darwin" && a.localAvailable) return null
  if (a.reach === null) return `needs ${source} on some machine — could not check which Hive node has it (iris hive nodes list)`
  if (a.reach.state === "ready" && a.reach.node_name) {
    return `runs on Hive node ${a.reach.node_name} (${source}) — this machine has none; iris routes it there automatically`
  }
  return `needs ${source} — no online Hive node has it${a.reach.reason ? ` (${a.reach.reason})` : ""}. Check: iris hive nodes list`
}
