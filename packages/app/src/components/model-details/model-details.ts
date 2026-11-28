/**
 * What the model picker says about a model (#194383).
 *
 * Pure: takes the model the picker already has (price, context, capabilities) and the details
 * document (bundled snapshot, or the live copy from /iris/model-details) and returns plain-words
 * facts for the detail pane. It never invents a figure: a model with no published score gets
 * `publicScore: undefined`, and the pane says "not scored yet" rather than showing a guess.
 */

export type PublicEntry = {
  name: string
  maker?: string
  smarts?: number
  rank?: number
  speed?: number
  first_token?: number
}

export type IrisBenchEntry = {
  accuracy: number
  worst: number
  honest: [number, number]
  finished: [number, number]
  seconds: number
}

export type UsageEntry = {
  /** Share of IRIS requests in the window, 0..1. */
  share?: number
  /** 1 = the most used model on IRIS in the window. */
  rank?: number
  /** Share of requests that came back with an answer, 0..1. */
  success?: number
  /** Median seconds to a full answer. */
  seconds?: number
}

export type CuratedEntry = {
  good_for?: string[]
  about?: string
  /** The model a tier (IRIS AI, IRIS Pro, …) routes to. */
  runs_on?: string
}

export type DetailsDoc = {
  version: number
  as_of: string
  sources: {
    public?: { name: string; url: string; as_of: string; ranked: number }
    iris?: { name: string; url: string; as_of: string }
    usage?: { window_days: number; as_of: string }
  }
  aliases?: Record<string, string>
  models: Record<string, CuratedEntry>
  iris_bench?: Record<string, IrisBenchEntry>
  public?: Record<string, PublicEntry>
  usage?: Record<string, UsageEntry>
}

export type ModelFacts = {
  id: string
  name: string
  providerID: string
  providerName: string
  cost?: { input: number; output: number }
  context?: number
  reasoning?: boolean
  toolcall?: boolean
  inputs?: { image?: boolean; pdf?: boolean; audio?: boolean; video?: boolean }
  releaseDate?: string
}

export type Level = "low" | "medium" | "high"

export type ModelDetails = {
  goodFor: string[]
  about?: string
  /** Display name of the model a tier currently runs on. */
  runsOn?: string
  publicScore?: {
    smarts?: number
    rank?: number
    of?: number
    speed?: number
    firstToken?: number
    source: { name: string; url: string; asOf: string }
  }
  iris?: IrisBenchEntry & { source: { name: string; url: string; asOf: string } }
  usage?: UsageEntry & { windowDays: number }
  price?: { level: Level; free: boolean; input: number; output: number }
  speed?: Level
  /** Where `speed` came from: our own timing beats a public tokens-per-second figure. */
  speedBasis?: { kind: "usage" | "iris"; seconds: number } | { kind: "public"; firstToken?: number }
  /** Roughly how many words it can read at once. */
  words?: number
  can: string[]
}

const SUFFIX = /-(or|zen|go|openai)$/

/** "iris/gpt-5.6-luna-or" → "gpt-5.6-luna" — the routes of one model share its facts. */
export function baseModelID(id: string) {
  return id.replace(/^[^/]+\//, "").replace(SUFFIX, "")
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")

function findPublic(doc: DetailsDoc, keys: string[]): PublicEntry | undefined {
  const table = doc.public
  if (!table) return
  const bySlug = new Map(Object.entries(table).map(([key, value]) => [slug(key), value]))
  for (const key of keys) {
    const direct = bySlug.get(slug(doc.aliases?.[key] ?? key))
    if (direct) return direct
  }
  // Connected providers name models their own way ("claude-opus-5-5", "Claude Opus 5.5").
  const names = new Map(Object.values(table).map((value) => [slug(value.name), value]))
  for (const key of keys) {
    const byName = names.get(slug(key))
    if (byName) return byName
  }
}

export function priceLevel(output: number): Level {
  if (output <= 1.5) return "low"
  if (output <= 6) return "medium"
  return "high"
}

/** Seconds to a whole answer, as measured on IRIS → how it feels to wait on it. */
export function answerLevel(seconds: number): Level {
  if (seconds <= 12) return "high"
  if (seconds <= 40) return "medium"
  return "low"
}

/** Output tokens per second → how it feels to wait on it. */
export function speedLevel(tokensPerSecond: number): Level {
  if (tokensPerSecond >= 120) return "high"
  if (tokensPerSecond >= 50) return "medium"
  return "low"
}

export function modelDetails(doc: DetailsDoc, model: ModelFacts): ModelDetails {
  const id = baseModelID(model.id)
  const curated = doc.models[id] ?? doc.models[model.id] ?? {}
  const target = curated.runs_on ?? id
  const keys = [target, id, model.name]
  const pub = findPublic(doc, keys)
  const bench = doc.iris_bench?.[target] ?? doc.iris_bench?.[id]
  const usage = model.providerID === "iris" ? doc.usage?.[id] : undefined
  // Leaderboards name dated snapshots ("… Flash 1017"); a person wants the model, not the build.
  const runsOnName = curated.runs_on
    ? (findPublic(doc, [curated.runs_on])?.name.replace(/ \d{4}$/, "") ?? curated.runs_on)
    : undefined
  // A public tokens-per-second figure can say "fast" about a model that takes 40 s to answer
  // here because it thinks at length. What we measured ourselves wins.
  const speedBasis: ModelDetails["speedBasis"] =
    usage?.seconds !== undefined
      ? { kind: "usage", seconds: usage.seconds }
      : bench
        ? { kind: "iris", seconds: bench.seconds }
        : pub?.speed
          ? { kind: "public", firstToken: pub.first_token }
          : undefined

  const can: string[] = []
  if (model.inputs?.image) can.push("images")
  if (model.inputs?.pdf) can.push("PDFs")
  if (model.inputs?.audio) can.push("audio")
  if (model.inputs?.video) can.push("video")

  const cost = model.cost
  return {
    goodFor: curated.good_for ?? [],
    about: curated.about,
    runsOn: runsOnName,
    publicScore:
      pub && doc.sources.public
        ? {
            smarts: pub.smarts,
            rank: pub.rank,
            of: doc.sources.public.ranked,
            speed: pub.speed,
            firstToken: pub.first_token,
            source: { name: doc.sources.public.name, url: doc.sources.public.url, asOf: doc.sources.public.as_of },
          }
        : undefined,
    iris:
      bench && doc.sources.iris
        ? { ...bench, source: { name: doc.sources.iris.name, url: doc.sources.iris.url, asOf: doc.sources.iris.as_of } }
        : undefined,
    usage: usage && doc.sources.usage ? { ...usage, windowDays: doc.sources.usage.window_days } : undefined,
    price: cost
      ? { level: priceLevel(cost.output), free: cost.input === 0 && cost.output === 0, input: cost.input, output: cost.output }
      : undefined,
    speed:
      speedBasis?.kind === "public" ? speedLevel(pub!.speed!) : speedBasis ? answerLevel(speedBasis.seconds) : undefined,
    speedBasis,
    words: model.context ? Math.round((model.context * 0.75) / 1000) * 1000 : undefined,
    can,
  }
}

/**
 * Lay the live document over the bundled one. Live wins per model; anything live does not
 * mention keeps its bundled value, so a partial server answer never blanks the pane.
 */
export function mergeDetails(base: DetailsDoc, live: Partial<DetailsDoc> | undefined): DetailsDoc {
  if (!live || typeof live !== "object") return base
  return {
    version: live.version ?? base.version,
    as_of: live.as_of ?? base.as_of,
    sources: { ...base.sources, ...(live.sources ?? {}) },
    aliases: { ...base.aliases, ...(live.aliases ?? {}) },
    models: { ...base.models, ...(live.models ?? {}) },
    iris_bench: { ...base.iris_bench, ...(live.iris_bench ?? {}) },
    public: { ...base.public, ...(live.public ?? {}) },
    usage: live.usage ?? base.usage,
  }
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

export function wordsLabel(words: number) {
  return `About ${compact.format(words)} words at once`
}

export function percent(value: number) {
  if (value > 0 && value < 0.01) return "under 1%"
  return `${Math.round(value * 100)}%`
}
