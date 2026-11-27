/**
 * What an empty view says (#194369): what goes here, in one line, and the one next step. Replaces
 * "Nothing in Atlas › Schemas on this board." — a sentence a new customer meets first and learns
 * nothing from. Keys are i18n keys; the action is what the panel does when it is clicked.
 */
export type EmptyAction = "add-list" | "marketplace" | "connect" | "ask-schema" | "ask-page" | "clear-search"

export type EmptyCopy = {
  title: string
  body?: string
  action?: { label: string; kind: EmptyAction }
}

const COPY: Record<string, EmptyCopy> = {
  atlas: {
    title: "iris.empty.atlas.title",
    body: "iris.empty.atlas.body",
    action: { label: "iris.empty.atlas.action", kind: "add-list" },
  },
  schemas: {
    title: "iris.empty.schemas.title",
    body: "iris.empty.schemas.body",
    action: { label: "iris.empty.schemas.action", kind: "ask-schema" },
  },
  graph: { title: "iris.empty.graph.title", body: "iris.empty.graph.body" },
  playbooks: {
    title: "iris.empty.playbooks.title",
    body: "iris.empty.playbooks.body",
    action: { label: "iris.empty.playbooks.action", kind: "marketplace" },
  },
  integrations: {
    title: "iris.empty.integrations.title",
    body: "iris.empty.integrations.body",
    action: { label: "iris.empty.integrations.action", kind: "connect" },
  },
  pages: {
    title: "iris.empty.pages.title",
    body: "iris.empty.pages.body",
    action: { label: "iris.empty.pages.action", kind: "ask-page" },
  },
}

/** The copy for an empty pane; `searched` is the query when the emptiness is a search's. */
export function emptyCopy(pane: string, searched?: string): EmptyCopy | undefined {
  if (searched)
    return {
      title: "iris.empty.search.title",
      body: "iris.empty.search.body",
      action: { label: "iris.empty.search.action", kind: "clear-search" },
    }
  return COPY[pane]
}
