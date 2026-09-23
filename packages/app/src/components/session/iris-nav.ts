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
