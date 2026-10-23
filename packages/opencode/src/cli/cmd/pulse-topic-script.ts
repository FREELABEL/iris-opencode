/**
 * The topic route as a PulseScript (#189244): every sweep in pulse-check-sweep.ts registered as a
 * Source, each with one Stop whose output is the SourceSweep the brief already renders. The
 * sweeps themselves are unchanged — this file only names them.
 */
import { join } from "path"
import { homedir } from "os"
import { registerDefault, type PulseScript, type Source, type SourceResult, type Stop } from "../../pulse/core"
import {
  type Hit,
  type SourceSweep,
  type SweepOptions,
  type TopicSource,
  sweepGit,
  sweepDiary,
  sweepDiaryAtlas,
  sweepFiles,
  sweepClaudeCode,
  sweepOpencode,
  sweepDesktop,
  sweepImessage,
  sweepEmail,
  sweepGmail,
  sweepBloq,
} from "./pulse-check-sweep"

export interface TopicReading extends SourceResult<Hit> {
  sweep: SourceSweep
}

export const TOPIC_LABEL: Record<TopicSource, string> = {
  git: "commits",
  diary: "diary",
  files: "files",
  claude_code: "Claude Code",
  opencode: "opencode",
  iris_desktop: "IRIS Desktop",
  imessage: "iMessage",
  email: "Apple Mail",
  gmail: "Gmail",
  bloq: "Atlas",
}

function reading(sweep: SourceSweep, provenance: string[]): TopicReading {
  return {
    sweep,
    hits: sweep.hits,
    items: sweep.items,
    measured: sweep.searched,
    reason: sweep.unavailableReason,
    floor: !!sweep.capped,
    provenance: sweep.board ? [...provenance, `board #${sweep.board.id} ${sweep.board.name}`] : provenance,
  }
}

function topicSource(
  id: TopicSource,
  provenance: (q: SweepOptions) => string[],
  sweep: (q: SweepOptions) => SourceSweep | Promise<SourceSweep>,
): Source<SweepOptions, TopicReading> {
  return {
    id,
    label: TOPIC_LABEL[id],
    async read(q) {
      return reading(await sweep(q), provenance(q))
    },
  }
}

/** One stop per source. A shut stop renders the same SourceSweep a sweep that could not look does. */
function topicStop(source: Source<SweepOptions, TopicReading>): Stop<SweepOptions, TopicReading, SourceSweep> {
  return {
    id: source.id,
    source,
    extract: (r) => r.sweep,
    unavailable: (reason) => ({ source: source.id as TopicSource, searched: false, unavailableReason: reason, hits: 0, items: [] }),
  }
}

export const topicSources: Record<TopicSource, Source<SweepOptions, TopicReading>> = {
  git: topicSource("git", (q) => [`git log --all in ${q.repo}`], (q) => sweepGit(q)),
  // No local diary folder is not "the diary is shut" when the diary lives in Atlas (#189155).
  diary: topicSource(
    "diary",
    (q) => [`${q.repo}/daily-diary`, "Atlas diary lists"],
    async (q) => {
      const local = sweepDiary(q)
      if (!local.searched && q.apiFetch && q.userId) return sweepDiaryAtlas(q)
      return local
    },
  ),
  files: topicSource("files", (q) => [`git grep in ${q.repo}`], (q) => sweepFiles(q)),
  claude_code: topicSource("claude_code", () => [join(homedir(), ".claude", "projects")], (q) => sweepClaudeCode(q)),
  opencode: topicSource("opencode", () => [join(homedir(), ".local", "share", "opencode", "opencode.db"), join(homedir(), ".local", "share", "opencode", "storage")], (q) => sweepOpencode(q)),
  iris_desktop: topicSource("iris_desktop", () => [join(homedir(), ".iris", "accounts", "<account>", "opencode", "opencode.db")], (q) => sweepDesktop(q)),
  imessage: topicSource("imessage", (q) => [q.messagesDb ?? join(homedir(), "Library", "Messages", "chat.db")], (q) => sweepImessage(q)),
  email: topicSource("email", (q) => [`${q.bridgeUrl ?? "http://127.0.0.1:3200"}/api/mail/search`], (q) => sweepEmail(q)),
  gmail: topicSource("gmail", () => ["Gmail via IRIS integrations"], (q) => sweepGmail(q)),
  bloq: topicSource("bloq", (q) => [`Atlas boards of user ${q.userId ?? "?"}`], (q) => sweepBloq(q)),
}

/**
 * The default topic script. Sequential, in TOPIC_SOURCES order: these sources are disk- or
 * AppleScript-bound on one machine, and running them at once makes the slowest one slower and
 * the progress line meaningless.
 */
export const defaultTopicScript: PulseScript<SweepOptions, SourceSweep> = {
  route: "topic",
  readOnly: true,
  mode: "sequential",
  stops: (["git", "diary", "files", "claude_code", "opencode", "iris_desktop", "imessage", "email", "gmail", "bloq"] as const).map((id) =>
    topicStop(topicSources[id]),
  ),
}

registerDefault("topic", defaultTopicScript)
