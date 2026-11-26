import { For, type JSX, Show, splitProps, type ComponentProps } from "solid-js"

/**
 * A record, read like a product page rather than a database row (#194363): a header (title, a
 * status badge, what it is, the primary actions), then its facts as a two-column list. Empty facts
 * are dropped here, so a caller can pass every field and nothing renders as "—" or "0".
 */
export type DetailFact = {
  label: string
  value?: JSX.Element | string | number | null
  /** Numbers and money: tabular figures, so a column of values lines up. */
  numeric?: boolean
  /** Long prose (a note, a description): spans both columns under its label. */
  wide?: boolean
}

export interface DetailViewProps extends Omit<ComponentProps<"section">, "title"> {
  title: JSX.Element
  /** One weak line under the title: a company, a model, a URL. */
  subtitle?: JSX.Element
  badge?: JSX.Element
  /** Leading mark: an avatar or an icon. */
  media?: JSX.Element
  /** Primary actions — ui Buttons. */
  actions?: JSX.Element
  facts?: DetailFact[]
  children?: JSX.Element
}

const present = (v: DetailFact["value"]) => v !== undefined && v !== null && v !== "" && !(typeof v === "number" && Number.isNaN(v))

export function DetailView(props: DetailViewProps) {
  const [split, rest] = splitProps(props, ["title", "subtitle", "badge", "media", "actions", "facts", "children", "class", "classList"])
  const facts = () => (split.facts ?? []).filter((f) => present(f.value))
  return (
    <section {...rest} data-component="detail-view" classList={{ ...split.classList, [split.class ?? ""]: !!split.class }}>
      <header data-slot="detail-view-header">
        <Show when={split.media}>
          <div data-slot="detail-view-media">{split.media}</div>
        </Show>
        <div data-slot="detail-view-heading">
          <div data-slot="detail-view-title-row">
            <h3 data-slot="detail-view-title">{split.title}</h3>
            <Show when={split.badge}>{split.badge}</Show>
          </div>
          <Show when={split.subtitle}>
            <p data-slot="detail-view-subtitle">{split.subtitle}</p>
          </Show>
        </div>
      </header>
      <Show when={split.actions}>
        <div data-slot="detail-view-actions">{split.actions}</div>
      </Show>
      <Show when={facts().length > 0}>
        <dl data-slot="detail-view-facts">
          <For each={facts()}>
            {(f) => (
              <div data-slot="detail-view-fact" data-wide={f.wide ? "" : undefined}>
                <dt>{f.label}</dt>
                <dd data-numeric={f.numeric ? "" : undefined}>{f.value as JSX.Element}</dd>
              </div>
            )}
          </For>
        </dl>
      </Show>
      {split.children}
    </section>
  )
}
