import { createSignal } from "solid-js"

/**
 * Steering the IRIS side panel from outside it — e.g. a Genesis artifact card in the chat that,
 * clicked, opens Genesis › Artifacts on that artifact.
 *
 * A module-level signal, not a window event: SessionIrisTab mounts lazily (on the first open of
 * the IRIS tab), and an event fired before it mounts is lost. A signal holds the request until
 * the tab reads it.
 */
export type IrisNavRequest = {
  surface: string
  sub?: string
  /** Genesis › Artifacts: the artifact to select once the list has it. */
  artifactId?: string
  /** Switch the panel to this board first — an Atlas Epic card opening the board it saved to. */
  bloqId?: number
  nonce: number
}

const [request, setRequest] = createSignal<IrisNavRequest | null>(null)

export const irisNavRequest = request

export function clearIrisNav() {
  setRequest(null)
}

export function requestIrisNav(r: Omit<IrisNavRequest, "nonce">) {
  setRequest({ ...r, nonce: Date.now() + Math.random() })
}

/** The artifact the pane should select, kept until the pane has actually shown it. */
const [artifactFocus, setArtifactFocus] = createSignal<{ id: string; nonce: number } | null>(null)

export const irisArtifactFocus = artifactFocus

export function focusArtifact(id: string) {
  setArtifactFocus({ id, nonce: Date.now() + Math.random() })
}

export function clearArtifactFocus() {
  setArtifactFocus(null)
}

/** Atlas › Artifacts (#187717): the note (by canonical URL) the pane should show. */
const [atlasFocus, setAtlasFocus] = createSignal<{ url: string; nonce: number } | null>(null)

export const irisAtlasFocus = atlasFocus

export function focusAtlasNote(url: string) {
  setAtlasFocus({ url, nonce: Date.now() + Math.random() })
}

export function clearAtlasFocus() {
  setAtlasFocus(null)
}

/**
 * Hive › Machines "Send a task": the computer Scripts should pick, kept until Scripts reads it.
 * (Scripts may not be mounted yet when Machines asks — same reason as the request above.)
 */
const [hiveNodeFocus, setHiveNodeFocus] = createSignal<{ id: string; nonce: number } | null>(null)

export const irisHiveNodeFocus = hiveNodeFocus

export function focusHiveNode(id: string | null) {
  setHiveNodeFocus(id ? { id, nonce: Date.now() + Math.random() } : null)
}

/**
 * OPEN THE SIDE PANEL from outside a session's layout (#189279) — the titlebar's Hive and Inbox
 * pills. The titlebar has no session context, so it cannot call tabs().open("iris") itself; it
 * leaves a request here and the session page (which owns the panel) acts on it. Same reason as
 * requestIrisNav for being a signal: whoever reads it may mount after the click.
 */
const [panelOpen, setPanelOpen] = createSignal<{ nonce: number } | null>(null)

export const irisPanelOpenRequest = panelOpen

export function clearIrisPanelOpen() {
  setPanelOpen(null)
}

/** Open the panel AND put it on this surface/sub-view. */
export function openIrisPanel(r: Omit<IrisNavRequest, "nonce">) {
  requestIrisNav(r)
  setPanelOpen({ nonce: Date.now() + Math.random() })
}

/**
 * The inbox changed here (a message was opened and marked read). The titlebar's unread badge
 * re-reads on this instead of waiting up to 30s to agree with the list you are looking at.
 */
const [inboxVersion, setInboxVersion] = createSignal(0)
export const irisInboxVersion = inboxVersion
export function bumpIrisInbox() {
  setInboxVersion((v) => v + 1)
}
