import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { showToast } from "@/utils/toast"
import { backgroundRows } from "./background-work-model"

/**
 * The "N working in the background" chip, now a button (#189437). It opens a list of every running
 * chat and sub-agent: click a row to open it, ✕ (or Delete) to stop it. Same set as the count, so
 * they cannot disagree. Interaction copied from upstream OpenCode 2.0's running menu.
 */
export function BackgroundWorkMenu() {
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const navigate = useNavigate()
  const params = useParams<{ serverKey?: string; id?: string }>()
  const [open, setOpen] = createSignal(false)
  const data = () => serverSync().session.data

  const rows = createMemo(() =>
    backgroundRows({
      status: data().session_status,
      working: (id) => data().session_working(id),
      info: (id) => serverSync().session.get(id),
      current: params.id,
      untitled: "New chat",
    }),
  )

  // A session running in another project may not be cached yet; fetch its title once it shows up.
  createEffect(() => {
    for (const row of rows()) {
      if (!serverSync().session.get(row.id)) void serverSync().session.resolve(row.id).catch(() => {})
    }
  })

  const go = (id: string) => {
    setOpen(false)
    const session = serverSync().session.get(id)
    navigate(params.serverKey ? sessionHref(requireServerKey(params.serverKey), id) : legacySessionHref(session?.directory ?? "", id))
  }

  const stop = (id: string) => {
    const session = serverSync().session.get(id)
    serverSDK()
      .createClient({ directory: session?.directory, throwOnError: true })
      .session.abort({ sessionID: id })
      .catch((error: unknown) =>
        showToast({ title: "Could not stop it", description: error instanceof Error ? error.message : String(error) }),
      )
  }

  return (
    <Show when={rows().length > 0}>
      <MenuV2 gutter={6} modal={false} placement="top-end" open={open()} onOpenChange={setOpen}>
        <MenuV2.Trigger as="button" type="button" class="iris-glow__chip" data-action="background-work" aria-label={`${rows().length} working in the background`}>
          <i aria-hidden="true" />
          {rows().length} working in the background
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content class="iris-bg-menu" aria-label="Working in the background">
            <div class="iris-bg-menu__head">Working in the background</div>
            <For each={rows()}>
              {(row) => (
                <MenuV2.Item
                  class="iris-bg-menu__row"
                  onSelect={() => go(row.id)}
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key !== "Delete" && event.key !== "Backspace") return
                    event.preventDefault()
                    stop(row.id)
                  }}
                >
                  <span class="iris-bg-menu__dot" data-retry={row.retrying ? "" : undefined} aria-hidden="true" />
                  <span class="iris-bg-menu__text">
                    <span class="iris-bg-menu__title">{row.title}</span>
                    <Show when={row.subagent || row.retrying}>
                      <span class="iris-bg-menu__sub">
                        {row.retrying ? "Retrying" : `Sub-agent · ${row.parent}`}
                      </span>
                    </Show>
                  </span>
                  {/* The row opens on press, so the stop button keeps its pointer events to itself. */}
                  <button
                    type="button"
                    class="iris-bg-menu__stop"
                    aria-label={`Stop ${row.title}`}
                    title="Stop"
                    tabIndex={-1}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    onPointerUp={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      stop(row.id)
                    }}
                  >
                    <Icon name="outline-xmark" />
                  </button>
                </MenuV2.Item>
              )}
            </For>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </Show>
  )
}
