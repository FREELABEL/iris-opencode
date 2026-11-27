import { Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useTabs } from "@/context/tabs"
import { useServer } from "@/context/server"
import { SharedRoomView } from "@/components/session/iris-shared-rooms"
import { sharedFetch, sharedMe } from "@/components/session/iris-shared-store"

/**
 * A shared room in the main chat pane (#194463) — its own tab, like any chat. The side panel keeps
 * the list of shared rooms and their settings; this is where the people and the agents work.
 */
export default function SharedRoomPage() {
  const params = useParams<{ roomId: string }>()
  const tabs = useTabs()
  const server = useServer()
  return (
    <div data-page="shared-room" class="sr iris-ui flex h-full min-h-0 w-full min-w-0 flex-col">
      <Show when={sharedFetch()} fallback={<div class="m-auto text-v2-text-text-muted text-[13px]">Connecting…</div>}>
        {(f) => (
          <Show when={params.roomId} keyed>
            {(id) => (
              <SharedRoomView
                id={id}
                doFetch={f()}
                myId={sharedMe()}
                layout="pane"
                onRoom={(name) => tabs.addSharedTab({ server: server.key, roomId: id, title: name })}
              />
            )}
          </Show>
        )}
      </Show>
    </div>
  )
}
