import { For, Show, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { EmptyState } from "@opencode-ai/ui/empty-state"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { ListRow } from "@opencode-ai/ui/list-row"
import { SkeletonRows } from "@opencode-ai/ui/skeleton"
import type { StatusTone } from "@opencode-ai/ui/status-badge"
import { useLanguage } from "@/context/language"
import "./iris-artifact-history.css"

/**
 * ONE ARTIFACT HISTORY for Genesis › Artifacts and Atlas › Artifacts (#194583).
 *
 * The two panes are one feature in two places (iris-atlas-artifacts.tsx says so), and the audit
 * found both stuck on "the current session only". This is the list they share: what was made,
 * what kind, who made it and when, and whether it is out in the world — with Open, Publish and
 * Share on each row. The panes decide where the rows come from (every chat's artifact store, a
 * chat's Atlas notes) and what Publish means; the list only draws them the same way.
 */
export type HistoryKind = "html" | "markdown" | "csv" | "code" | "note" | "file"

export interface HistoryRow {
  /** Unique within the list. */
  key: string
  title: string
  kind: HistoryKind
  /** Who made it: an agent's name, "you". */
  author?: string
  /** Where it was made, in words: "This chat", a chat's title. */
  where?: string
  /** When it last changed (ISO or ms). */
  when?: string | number
  status?: { label: string; tone: StatusTone }
  /** A link that can be handed out — only when it is published or public. */
  shareUrl?: string
  /** It can be published from here (not yet published, or behind). */
  canPublish?: boolean
  selected?: boolean
}

const KIND_ICON: Record<HistoryKind, IconProps["name"]> = {
  html: "window-cursor",
  markdown: "file-tree",
  csv: "bullet-list",
  code: "code",
  note: "speech-bubble",
  file: "open-file",
}

export function IrisArtifactHistory(props: {
  rows: HistoryRow[]
  loading?: boolean
  /** Shown above the list: a scope switch, a count. */
  header?: JSX.Element
  empty: { title: string; body?: string; action?: JSX.Element }
  onOpen: (row: HistoryRow) => void
  onPublish?: (row: HistoryRow) => void
  onShare?: (row: HistoryRow) => void
  /** Freeze the clock (screenshots, tests). */
  now?: number
}) {
  const language = useLanguage()
  return (
    <div class="iris-ah" data-component="iris-artifact-history">
      {props.header}
      <Show
        when={props.rows.length}
        fallback={
          <Show when={!props.loading} fallback={<SkeletonRows rows={4} label={language.t("iris.artifacts.history.loading")} />}>
            <EmptyState title={props.empty.title} description={props.empty.body} action={props.empty.action} />
          </Show>
        }
      >
        <ul class="iris-ah-list" aria-label={language.t("iris.artifacts.history.label")}>
          <For each={props.rows}>
            {(row) => (
              <li>
                <ListRow
                  data-slot="artifact-history-row"
                  data-kind={row.kind}
                  leading={
                    <span class="iris-ah-mark" aria-hidden="true">
                      <Icon name={KIND_ICON[row.kind]} size="small" />
                    </span>
                  }
                  title={row.title}
                  secondary={[language.t(`iris.artifacts.kind.${row.kind}`), row.author, row.where].filter(Boolean).join(" · ")}
                  time={row.when}
                  now={props.now}
                  status={row.status ? { label: row.status.label, tone: row.status.tone, mark: "dot" } : undefined}
                  selected={row.selected}
                  onSelect={() => props.onOpen(row)}
                  selectLabel={language.t("iris.artifacts.history.open", { title: row.title })}
                  actions={
                    <>
                      <Button size="small" variant="ghost" onClick={() => props.onOpen(row)}>
                        {language.t("iris.artifacts.history.openShort")}
                      </Button>
                      <Show when={props.onPublish && row.canPublish}>
                        <Button size="small" variant="secondary" onClick={() => props.onPublish!(row)}>
                          {language.t("iris.artifacts.history.publish")}
                        </Button>
                      </Show>
                      <Show when={props.onShare && row.shareUrl}>
                        <Button size="small" variant="secondary" icon="link" onClick={() => props.onShare!(row)}>
                          {language.t("iris.artifacts.history.share")}
                        </Button>
                      </Show>
                    </>
                  }
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

/** "This chat | All chats" — the scope above a history list. */
export function HistoryScope(props: { value: "chat" | "all"; onChange: (v: "chat" | "all") => void; counts?: { chat?: number; all?: number } }) {
  const language = useLanguage()
  const Opt = (p: { id: "chat" | "all"; label: string; n?: number }) => (
    <button type="button" role="tab" aria-selected={props.value === p.id} class="iris-ah-scope-btn" onClick={() => props.onChange(p.id)}>
      {p.label}
      <Show when={p.n != null}>
        <span class="iris-ah-scope-n">{p.n}</span>
      </Show>
    </button>
  )
  return (
    <div class="iris-ah-scope" role="tablist" aria-label={language.t("iris.artifacts.history.scope")}>
      <Opt id="chat" label={language.t("iris.artifacts.history.thisChat")} n={props.counts?.chat} />
      <Opt id="all" label={language.t("iris.artifacts.history.allChats")} n={props.counts?.all} />
    </div>
  )
}
