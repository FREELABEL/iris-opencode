import { createMemo, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/dialog-model"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import { useHiveInbox } from "../../iris/hive-inbox"

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const directory = useDirectory()
  const connected = useConnected()
  // Hive messages arrive while you work and nothing announces them — see iris/hive-inbox.ts.
  const inbox = useHiveInbox()

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeout = setTimeout(() => tick(), 5000)
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeout = setTimeout(() => tick(), 10_000)
        return
      }
    }
    let timeout = setTimeout(() => tick(), 10_000)

    onCleanup(() => {
      clearTimeout(timeout)
    })
  })

  return (
    <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
      <text fg={theme.textMuted}>{directory()}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <Switch>
          <Match when={store.welcome}>
            <text fg={theme.text}>
              Get started <span style={{ fg: theme.textMuted }}>/connect</span>
            </text>
          </Match>
          <Match when={connected()}>
            <Show when={permissions().length > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>△</span> {permissions().length} Permission
                {permissions().length > 1 ? "s" : ""}
              </text>
            </Show>
            {/* Silent at zero on purpose: a badge that is always present stops being read.
                `unread: null` means the manifest exists and could not be parsed — shown as a
                distinct mark rather than as a comfortable 0. */}
            <Show when={inbox().unreadable}>
              <text fg={theme.error}>
                <span style={{ fg: theme.error }}>✉</span> Hive inbox unreadable
              </text>
            </Show>
            <Show when={(inbox().unread ?? 0) > 0}>
              <text fg={theme.warning}>
                <span style={{ fg: theme.warning }}>✉</span> {inbox().unread} Hive
                <span style={{ fg: theme.textMuted }}> · hive inbox read</span>
              </text>
            </Show>
            <text fg={theme.text}>
              <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>•</span> {lsp().length} LSP
            </text>
            <Show when={mcp()}>
              <text fg={theme.text}>
                <Switch>
                  <Match when={mcpError()}>
                    <span style={{ fg: theme.error }}>⊙ </span>
                  </Match>
                  <Match when={true}>
                    <span style={{ fg: theme.success }}>⊙ </span>
                  </Match>
                </Switch>
                {mcp()} MCP
              </text>
            </Show>
            <text fg={theme.textMuted}>/status</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
