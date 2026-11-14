/**
 * B6 #192669 (epic #192663) — a persona drafted from a brand's own voice and tone.
 *
 * A kit like IRIS #8 carries its voice as two sentences of text (`brand.voice`, `brand.tone`) and
 * no persona, so writing tools have nothing to select. This turns that text into a persona a person
 * can read and approve — name, audience, do / don't, sample lines — WITHOUT inventing anything:
 * every do, don't and sample line is a phrase lifted from the kit, and a field the kit does not
 * state (most often the audience) is left empty and named in `missing`, never filled with a guess.
 *
 * Pure (no network, no yargs) so it is tested on its own. `iris brands personas add <id>
 * --from-voice` prints it; only `--save` writes it, through the existing persona API.
 */

export type BrandVoiceKit = {
  name?: string
  voice?: string
  tone?: string
  tagline?: string
  description?: string
  audience?: string
}

export type PersonaDraft = {
  /** The body POSTed to /api/v1/brands/{id}/personas — fields that endpoint validates. */
  body: {
    name: string
    archetype: string
    tone?: string
    target_demographic?: string
    system_prompt: string
    style_guidelines: {
      do: string[]
      dont: string[]
      sample_lines: string[]
      drafted_from: string[]
    }
    is_default: boolean
  }
  /** Fields the kit did not state, for the person to fill (e.g. "audience"). */
  missing: string[]
}

const clean = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,;:\-–—\s]+|[,;:\-–—.\s]+$/g, "")

const sentences = (text?: string): string[] =>
  (text ?? "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)

const AUDIENCE = /^(?:speaks to|talks to|written for|writes for|for|our audience is|audience:)\s+(.+)$/i
const NEGATED_ITEM = /^(?:no|never|not|avoid)\s+(.+)$/i
const NEGATION = /\b(?:don['’]t|do not|never|we don['’]t)\s+([^—–;:]+)/i
const AFTER_DASH_WE = /[—–]\s*we\s+([^.;]+)/i

const uniq = (xs: string[]) => {
  const seen = new Set<string>()
  return xs.filter((x) => {
    const k = x.toLowerCase()
    if (!x || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Split a voice/tone sentence into what to do and what not to. A comma list of traits
 * ("Confident, direct, no fluff.") gives one item each; "no X" / "never X" goes to don't. A
 * sentence with a negation ("We don't sell dreams — we show what the system does.") gives the
 * negated phrase to don't and the "— we …" clause to do.
 */
function splitSentence(s: string, out: { do: string[]; dont: string[] }) {
  const neg = s.match(NEGATION)
  if (neg) {
    out.dont.push(clean(neg[1]))
    const pos = s.match(AFTER_DASH_WE)
    if (pos) out.do.push(clean(pos[1]))
    return
  }
  const parts = s.includes(",") ? s.split(/,|\band\b(?=[^,]*$)/) : [s]
  for (const raw of parts) {
    const p = clean(raw)
    if (!p) continue
    const n = p.match(NEGATED_ITEM)
    if (n) out.dont.push(clean(n[1]))
    else out.do.push(p)
  }
}

export function draftPersonaFromVoice(
  kit: BrandVoiceKit,
  opts: { brandName?: string; name?: string; audience?: string; isDefault?: boolean } = {},
): PersonaDraft | { error: string } {
  const voice = kit.voice?.trim()
  const tone = kit.tone?.trim()
  if (!voice && !tone) {
    return { error: "This brand's kit states no voice or tone (design_tokens.brand.voice / .tone) — there is nothing to draft from." }
  }
  const brandName = opts.brandName?.trim() || kit.name?.trim() || "This brand"
  const lists = { do: [] as string[], dont: [] as string[] }
  let audience = opts.audience?.trim() || kit.audience?.trim() || ""
  const from: string[] = []

  for (const s of sentences(voice)) {
    const a = s.match(AUDIENCE)
    if (a) {
      if (!audience) audience = clean(a[1])
      continue
    }
    splitSentence(s, lists)
  }
  if (voice) from.push("brand.voice")
  for (const s of sentences(tone)) splitSentence(s, lists)
  if (tone) from.push("brand.tone")

  // Sample lines are the kit's own words in its own voice — quoted, never written for it.
  const samples: string[] = []
  if (kit.tagline?.trim()) {
    samples.push(kit.tagline.trim())
    from.push("brand.tagline")
  }
  for (const s of sentences(tone)) if (NEGATION.test(s) && AFTER_DASH_WE.test(s)) samples.push(s)
  const firstDescription = sentences(kit.description)[0]
  if (firstDescription) {
    samples.push(firstDescription)
    from.push("brand.description")
  }

  const doList = uniq(lists.do)
  const dontList = uniq(lists.dont)
  const sampleLines = uniq(samples)
  const missing: string[] = []
  if (!audience) missing.push("audience")
  if (sampleLines.length === 0) missing.push("sample lines")

  const prompt = [
    `You write as ${brandName}.`,
    voice ? `Voice: ${voice}` : undefined,
    tone ? `Tone: ${tone}` : undefined,
    audience ? `Audience: ${audience}.` : undefined,
    doList.length ? `Do: ${doList.join("; ")}.` : undefined,
    dontList.length ? `Don't: ${dontList.join("; ")}.` : undefined,
    sampleLines.length ? `Lines in this voice:\n${sampleLines.map((l) => `- ${l}`).join("\n")}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")

  return {
    body: {
      name: opts.name?.trim() || `${brandName} voice`,
      archetype: "brand_voice",
      ...(tone ? { tone: tone.slice(0, 500) } : {}),
      ...(audience ? { target_demographic: audience.slice(0, 500) } : {}),
      system_prompt: prompt,
      style_guidelines: { do: doList, dont: dontList, sample_lines: sampleLines, drafted_from: from },
      is_default: opts.isDefault === true,
    },
    missing,
  }
}
