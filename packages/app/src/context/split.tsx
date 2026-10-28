import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore, reconcile as reconcileStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { accountKey } from "@/utils/account-scope"
import { close, open, type PaneRef } from "@/pages/session/split-model"

/**
 * The sessions on screen side by side (#191484), per window and kept across restarts like the
 * tab strip. Empty means one column — the app as it was. The rules live in split-model.ts.
 */
export const { use: useSplit, provider: SplitProvider } = createSimpleContext({
  name: "Split",
  gate: false,
  init: () => {
    const [store, setStore, , ready] = persisted(
      Persist.window(accountKey("split")),
      createStore<{ panes: PaneRef[]; last: number }>({ panes: [], last: 0 }),
    )
    const set = (panes: PaneRef[]) => setStore("panes", reconcileStore(panes))
    return {
      ready,
      panes: () => store.panes,
      /** The column the user was last in, so a tab picked from the strip lands there. */
      last: () => store.last,
      setLast: (i: number) => setStore("last", i),
      set,
      open: (focused: PaneRef, next: PaneRef) => set(open(store.panes, focused, next)),
      close: (target: PaneRef) => set(close(store.panes, target)),
      clear: () => set([]),
    }
  },
})
