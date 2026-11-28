import { For, Show, createMemo, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { modelDetails, percent, type DetailsDoc, type Level, type ModelFacts } from "./model-details"
import "./model-detail-pane.css"

type Item = {
  id: string
  name: string
  latest?: boolean
  release_date?: string
  provider: { id: string; name: string }
  cost?: { input: number; output: number }
  limit?: { context: number }
  capabilities?: {
    reasoning: boolean
    toolcall?: boolean
    input: { image?: boolean; pdf?: boolean; audio?: boolean; video?: boolean }
  }
}

export function toFacts(item: Item): ModelFacts {
  return {
    id: item.id,
    name: item.name,
    providerID: item.provider.id,
    providerName: item.provider.name,
    cost: item.cost ? { input: item.cost.input, output: item.cost.output } : undefined,
    context: item.limit?.context || undefined,
    reasoning: item.capabilities?.reasoning,
    toolcall: item.capabilities?.toolcall,
    inputs: item.capabilities?.input,
    releaseDate: item.release_date || undefined,
  }
}

const shortDate = (iso: string) => {
  const date = new Date(`${iso}T00:00:00`)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

const money = (value: number) => `$${value < 1 ? value.toFixed(2) : value.toFixed(value % 1 ? 2 : 0)}`

function Fact(props: { label: string; value: JSX.Element; hint?: JSX.Element; level?: Level }) {
  return (
    <div data-slot="model-fact">
      <span data-slot="model-fact-label">{props.label}</span>
      <span data-slot="model-fact-value" data-level={props.level}>
        {props.value}
      </span>
      <Show when={props.hint}>
        <span data-slot="model-fact-hint">{props.hint}</span>
      </Show>
    </div>
  )
}

function Section(props: { title: string; source?: { name: string; url: string; asOf: string }; children: JSX.Element }) {
  const platform = usePlatform()
  return (
    <section data-slot="model-section">
      <header data-slot="model-section-head">
        <span>{props.title}</span>
        <Show when={props.source}>
          {(source) => (
            <button
              type="button"
              data-slot="model-source"
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                platform.openExternal(source().url)
              }}
            >
              {source().name} · {shortDate(source().asOf)}
            </button>
          )}
        </Show>
      </header>
      {props.children}
    </section>
  )
}

/**
 * The right half of the model picker (#194383): what the highlighted model is good for, what it
 * costs, how it scores in public, how it did on IRIS's own test and how much IRIS users use it.
 * Every number names where it came from; a model with no score says so instead of showing one.
 */
export function ModelDetailPane(props: { item?: Item; doc: DetailsDoc; free?: boolean }) {
  const language = useLanguage()
  const details = createMemo(() => (props.item ? modelDetails(props.doc, toFacts(props.item)) : undefined))
  const level = (value: Level, kind: "price" | "speed") => language.t(`model.details.${kind}.${value}`)

  return (
    <div data-component="model-detail-pane" data-model={props.item ? `${props.item.provider.id}:${props.item.id}` : undefined}>
      <Show when={props.item && details()} fallback={<div data-slot="model-empty">{language.t("model.details.empty")}</div>}>
        {(_) => {
          const item = () => props.item!
          const d = () => details()!
          return (
            <>
              <div data-slot="model-head">
                <span data-slot="model-provider">{item().provider.name}</span>
                <h3 data-slot="model-name">{item().name}</h3>
                <Show when={d().runsOn}>
                  {(name) => <p data-slot="model-runs-on">{language.t("model.details.runsOn", { model: name() })}</p>}
                </Show>
                <Show when={d().about}>{(about) => <p data-slot="model-about">{about()}</p>}</Show>
              </div>

              <Show when={d().goodFor.length}>
                <div data-slot="model-good-for" aria-label={language.t("model.details.goodFor")}>
                  <span data-slot="model-fact-label">{language.t("model.details.goodFor")}</span>
                  <div data-slot="model-chips">
                    <For each={d().goodFor}>{(text) => <span data-slot="model-chip">{text}</span>}</For>
                  </div>
                </div>
              </Show>

              <div data-slot="model-facts">
                <Show when={d().price}>
                  {(price) => (
                    <Fact
                      label={language.t("model.details.cost")}
                      value={price().free ? language.t("model.tag.free") : level(price().level, "price")}
                      level={price().free ? "low" : price().level}
                      hint={
                        price().free
                          ? undefined
                          : language.t("model.details.cost.hint", { input: money(price().input), output: money(price().output) })
                      }
                    />
                  )}
                </Show>
                <Show when={d().speed}>
                  {(speed) => (
                    <Fact
                      label={language.t("model.details.speed")}
                      value={level(speed(), "speed")}
                      level={speed() === "high" ? "low" : speed() === "low" ? "high" : "medium"}
                      hint={(() => {
                        const basis = d().speedBasis
                        if (!basis) return undefined
                        if (basis.kind !== "public")
                          return language.t("model.details.speed.answer", { seconds: Math.round(basis.seconds) })
                        if (basis.firstToken === undefined) return undefined
                        return language.t("model.details.speed.hint", { seconds: basis.firstToken.toLocaleString() })
                      })()}
                    />
                  )}
                </Show>
                <Show when={d().words}>
                  {(words) => (
                    <Fact
                      label={language.t("model.details.memory")}
                      value={language.t("model.details.memory.value", {
                        words: new Intl.NumberFormat(language.intl(), { notation: "compact" }).format(words()),
                      })}
                      hint={language.t("model.details.memory.hint")}
                    />
                  )}
                </Show>
              </div>

              <Section title={language.t("model.details.public")} source={d().publicScore?.source}>
                <Show
                  when={d().publicScore?.smarts !== undefined && d().publicScore}
                  fallback={<p data-slot="model-none">{language.t("model.details.public.none")}</p>}
                >
                  {(score) => (
                    <div data-slot="model-score">
                      <div data-slot="model-score-row">
                        <span data-slot="model-score-label">{language.t("model.details.public.smarts")}</span>
                        <span data-slot="model-score-value">{Math.round(score().smarts!)}</span>
                        <Show when={score().rank}>
                          <span data-slot="model-score-rank">
                            {language.t("model.details.public.rank", { rank: score().rank!, of: score().of! })}
                          </span>
                        </Show>
                      </div>
                      <Show when={score().rank && score().of}>
                        <div
                          data-slot="model-bar"
                          role="meter"
                          aria-valuemin={1}
                          aria-valuemax={score().of}
                          aria-valuenow={score().of! - score().rank! + 1}
                        >
                          <span style={{ width: `${Math.max(4, ((score().of! - score().rank! + 1) / score().of!) * 100)}%` }} />
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
              </Section>

              <Show when={d().iris}>
                {(iris) => (
                  <Section title={language.t("model.details.iris")} source={iris().source}>
                    <div data-slot="model-stats">
                      <Fact label={language.t("model.details.iris.accuracy")} value={`${iris().accuracy}/100`} />
                      <Fact
                        label={language.t("model.details.iris.honest")}
                        value={language.t("model.details.ofN", { n: iris().honest[0], of: iris().honest[1] })}
                      />
                      <Fact
                        label={language.t("model.details.iris.finished")}
                        value={language.t("model.details.ofN", { n: iris().finished[0], of: iris().finished[1] })}
                        level={iris().finished[0] < iris().finished[1] ? "high" : undefined}
                      />
                      <Fact
                        label={language.t("model.details.iris.time")}
                        value={language.t("model.details.seconds", { seconds: Math.round(iris().seconds) })}
                      />
                    </div>
                  </Section>
                )}
              </Show>

              <Show when={d().usage}>
                {(usage) => (
                  <Section title={language.t("model.details.usage", { days: usage().windowDays })}>
                    <div data-slot="model-stats">
                      <Show when={usage().rank}>
                        <Fact label={language.t("model.details.usage.rank")} value={`#${usage().rank}`} />
                      </Show>
                      <Show when={usage().share !== undefined}>
                        <Fact label={language.t("model.details.usage.share")} value={percent(usage().share!)} />
                      </Show>
                      <Show when={usage().success !== undefined}>
                        <Fact
                          label={language.t("model.details.usage.success")}
                          value={percent(usage().success!)}
                          level={usage().success! < 0.9 ? "high" : undefined}
                        />
                      </Show>
                      <Show when={usage().seconds !== undefined}>
                        <Fact
                          label={language.t("model.details.usage.time")}
                          value={language.t("model.details.seconds", { seconds: Math.round(usage().seconds!) })}
                        />
                      </Show>
                    </div>
                  </Section>
                )}
              </Show>

              <div data-slot="model-abilities">
                <Show when={d().can.length}>
                  <span>{language.t("model.details.reads", { inputs: d().can.join(", ") })}</span>
                </Show>
                <Show when={item().capabilities?.reasoning}>
                  <span>{language.t("model.details.thinks")}</span>
                </Show>
                <Show when={item().capabilities?.toolcall}>
                  <span>{language.t("model.details.tools")}</span>
                </Show>
              </div>
            </>
          )
        }}
      </Show>
    </div>
  )
}
