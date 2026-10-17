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
 * Open the side panel on an IRIS surface from OUTSIDE a session — the titlebar's machines and
 * inbox dialogs (#189763). The titlebar has no session layout of its own (it renders above the
 * session providers), so it asks; the session page, which owns the panel and its tabs, answers.
 */
const [panelRequest, setPanelRequest] = createSignal<{ surface: string; sub?: string; nonce: number } | null>(null)

export const irisPanelRequest = panelRequest

export function requestIrisPanel(surface: string, sub?: string) {
  setPanelRequest({ surface, sub, nonce: Date.now() + Math.random() })
}

export function clearIrisPanel() {
  setPanelRequest(null)
}

/** Hive › Machines: the computer to select when the pane opens (a dialog's "Details →"). */
const [machineFocus, setMachineFocus] = createSignal<{ id: string; nonce: number } | null>(null)

export const irisMachineFocus = machineFocus

export function focusHiveMachine(id: string | null) {
  setMachineFocus(id ? { id, nonce: Date.now() + Math.random() } : null)
}
