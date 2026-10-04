import { ErrorBoundary, Suspense, type ParentProps } from "solid-js"
import * as Sentry from "@sentry/solid"

/**
 * Keeps a failed IRIS panel inside the panel.
 *
 * The IRIS panels read createResource()s that fetch the local sidecar. When the sidecar is
 * unreachable — still starting, restarted, or asleep after a Windows resume — the fetch rejects
 * with "TypeError: Failed to fetch", the resource read throws, and with no boundary nearer than
 * app.tsx the whole window became "Something went wrong". One side panel took the app down
 * (reported from Windows on 1.18.87). Here the panel shows its own error and a Retry instead.
 *
 * The same reads SUSPEND while loading, and the nearest <Suspense> above used to be the one in
 * session.tsx around the whole side panel — no fallback, so a loading pane blanked the entire
 * panel, tab strip included, to its dark ground. This one keeps a load inside the panel too.
 */
export function IrisPanelBoundary(props: ParentProps<{ label?: string }>) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        Sentry.captureException(error)
        return (
          <div
            data-slot="iris-panel-error"
            class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-12-regular text-text-weak"
          >
            <div class="text-text-base">{props.label ?? "This panel"} couldn't reach the local IRIS server.</div>
            <div class="max-w-72 break-words">{error instanceof Error ? error.message : String(error)}</div>
            <button
              type="button"
              data-slot="iris-panel-retry"
              class="mt-1 rounded-md border border-border-base px-3 py-1 text-text-base hover:bg-surface-base-hover"
              onClick={reset}
            >
              Retry
            </button>
          </div>
        )
      }}
    >
      <Suspense
        fallback={
          <div
            data-slot="iris-panel-loading"
            class="flex h-full items-center justify-center text-12-regular text-text-weak"
          >
            Loading…
          </div>
        }
      >
        {props.children}
      </Suspense>
    </ErrorBoundary>
  )
}
