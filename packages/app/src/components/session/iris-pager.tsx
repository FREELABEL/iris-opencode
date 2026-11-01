import { Show } from "solid-js"

/**
 * The footer every paged list in the panel shares: how many of how many, then the way to more.
 * Each control appears only when the server said it leads somewhere, never as a dead button.
 *
 * `onNext` alone is Load more, for lists that grow. With `onPrevious` it's page by page, for lists
 * that replace their rows. Counts come from pageSummary in use-paged-surface.
 */
export function IrisPager(props: {
  summary?: string | null
  /** A footer whose count isn't a pageSummary (Atlas) passes it as children. */
  children?: any
  loading?: boolean
  hasMore?: boolean
  onNext: () => void
  hasPrevious?: boolean
  onPrevious?: () => void
  class?: string
}) {
  const paged = () => props.onPrevious !== undefined
  const button = "px-2 py-0.5 rounded cursor-pointer text-text-weak hover:text-text-base hover:bg-background-element"
  return (
    <div class={`flex items-center gap-2 text-11-regular text-text-weaker ${props.class ?? "py-2"}`} data-slot="iris-pager">
      {props.children}
      <Show when={props.summary}>
        {(text) => <span class="font-mono tabular-nums">{text()}</span>}
      </Show>
      <span class="ms-auto flex items-center gap-1">
        <Show when={paged() && props.hasPrevious}>
          <button type="button" class={button} disabled={props.loading} onClick={() => props.onPrevious!()}>
            Previous page
          </button>
        </Show>
        <Show when={props.hasMore}>
          <button type="button" class={button} disabled={props.loading} onClick={() => props.onNext()}>
            {props.loading ? "Loading…" : paged() ? "Next page" : "Load more"}
          </button>
        </Show>
      </span>
    </div>
  )
}
