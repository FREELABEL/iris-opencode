import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore, reconcile as reconcileStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { accountKey } from "@/utils/account-scope"
import { close, open, type PaneRef } from "@/pages/session/split-model"

/** Plain copies of pane refs, detached from any store. */
export const snapshot = (panes: readonly PaneRef[]): PaneRef[] => panes.map((p) => ({ server: p.server, sessionId: p.sessionId }))

/**
 * The sessions on screen side by side (#191484), per window and kept across restarts like the
 * tab strip. Empty means one column — the app as it was. The rules live in split-model.ts.
 *
 * Reads and writes are snapshots, never the store's own objects. reconcile rewrites slots in
 * place, so a caller holding a store object across a write read whatever moved into its slot:
 * closing [X, Y, Z] at X returned "focus Y", the write moved Z into Y's slot, and focus landed on
 * Z — then the same session sat in two columns and the split collapsed.
 */
export const { use: useSplit, provider: SplitProvider } = createSimpleContext({
  name: "Split",
  gate: false,
  init: () => {
    const [store, setStore, , ready] = persisted(
      Persist.window(accountKey("split")),
      createStore<{ panes: PaneRef[]; last: number }>({ panes: [], last: 0 }),
    )
    const set = (panes: PaneRef[]) => setStore("panes", reconcileStore(snapshot(panes)))
    return {
      ready,
      panes: () => snapshot(store.panes),
      /** The column the user was last in, so a tab picked from the strip lands there. */
      last: () => store.last,
      setLast: (i: number) => setStore("last", i),
      set,
      open: (focused: PaneRef, next: PaneRef) => set(open(snapshot(store.panes), focused, next)),
      close: (target: PaneRef) => set(close(snapshot(store.panes), target)),
      clear: () => set([]),
    }
  },
})
