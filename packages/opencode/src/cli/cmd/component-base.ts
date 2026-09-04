/**
 * Provenance and conflict handling for the stored Genesis component library.
 *
 * WHY THIS EXISTS
 *
 * The stored library IS the source. A filesystem search on 2026-09-03 found no `.vue` on disk
 * for `workspace-shell`, `registry-table`, `chat-stage`, `record-detail` or their siblings —
 * they live in `code_components` and nowhere else. Until now the only way to read one was
 * `library show --source`, which PRINTS to a terminal, so editing meant copy-paste out of
 * scrollback: not scriptable, not diffable, and no record of which state you edited.
 *
 * That last part is the dangerous one, and it is the reason this module is more than a file
 * writer. Publishing a component is a live code change to EVERY page naming the slug — no
 * build, no release, no review (#182331: `session-list` and `workspace-rail` are each named by
 * two pages, `filter-results` by two). And the CLI hardcodes `replace: true`, walking past the
 * one guard the API has. So two writers on one component was last-writer-wins, propagated to
 * every page at once.
 *
 * `CodeComponentVersion::snapshot()` runs before the overwrite, so the loss is recoverable —
 * which is more than pages had. It is still silent, and the person who needs to undo it is the
 * one who does not know it happened.
 *
 * THE MARKER LIVES IN THE FILE, NOT A SIDECAR
 *
 * A sidecar is lost the moment someone copies just the `.vue`, and a guard that silently
 * disables itself when a file moves is the defect it was built to prevent. Verified against the
 * real compiler (`compileSource`) that a leading HTML comment compiles clean.
 *
 * It is stripped before publishing. A marker stored as source would drift the hash by one byte
 * on every pull, and every publish would then conflict against itself.
 *
 * Pure and dependency-free so it is testable without the network — see component-base.test.ts.
 */

export type ComponentMeta = {
  slug: string
  hash: string
  compiler: string
  pulledAt: string
}

const MARKER = /^<!--\s*iris:component\s+slug=(\S+)\s+hash=(\S+)\s+compiler=(\S+)\s+pulled=(\S+)\s*-->\r?\n?/

/**
 * The provenance line `pull` stamps at the top of `<slug>.vue`.
 *
 * One line, and deliberately readable: someone opening the file in an editor should be able to
 * see what it came from without knowing this tool exists.
 */
export function componentHeader(meta: ComponentMeta): string {
  return `<!-- iris:component slug=${meta.slug} hash=${meta.hash} compiler=${meta.compiler} pulled=${meta.pulledAt} -->`
}

/**
 * Read the marker, or null.
 *
 * TOP OF FILE ONLY. A marker further down — quoted in a template as documentation, or pasted
 * into an example — is not provenance, and honouring it would compare against a hash that was
 * never a real stored state.
 */
export function parseComponentHeader(source: string): ComponentMeta | null {
  const m = MARKER.exec(source ?? "")
  if (!m) return null
  return { slug: m[1], hash: m[2], compiler: m[3], pulledAt: m[4] }
}

/** The source as it should be STORED: ours removed, anyone else's leading comment untouched. */
export function stripComponentHeader(source: string): string {
  if (!source) return source
  return source.replace(MARKER, "")
}

/**
 * Turn a publish response into a decision.
 *
 * Only `component_conflict` is ours. `component_exists` is a different refusal with a different
 * fix — it fires when an unrelated build collides on a slug — and mislabelling it would send
 * someone to re-pull a component they never had.
 */
export function handleComponentConflictResponse(
  slug: string,
  status: number,
  body: any,
): { conflicted: boolean; lines: string[]; exitCode: number } {
  if (status !== 409 || body?.error !== "component_conflict") {
    return { conflicted: false, lines: [], exitCode: 0 }
  }

  const when = typeof body?.changedAt === "string" && body.changedAt ? body.changedAt : "unknown"
  const pages = typeof body?.usedByPages === "number" ? body.usedByPages : null

  const lines: string[] = []
  lines.push(`Refusing to publish — "${slug}" changed since you pulled it.`)
  lines.push(`  someone else published over it at ${when}`)
  // The blast radius, stated at the moment somebody is actually looking (#182331). A publish
  // changes every page naming the slug at once, and that is normally what you want — which is
  // exactly why nothing distinguishes an intended propagation from an accidental one.
  if (pages !== null && pages > 0) {
    lines.push(`  this publish would have changed ${pages} page${pages === 1 ? "" : "s"}`)
  } else if (pages === null) {
    // The server answers 0 when the lookup itself failed. Printing "0 pages" would state as a
    // finding something that was never measured.
    lines.push(`  (could not determine how many pages name this component)`)
  }
  lines.push("")
  lines.push(`  Take their version:   iris pages library pull ${slug}`)
  lines.push(`  See what changed:     iris pages library versions ${slug}`)
  lines.push(`  Publish anyway:       iris pages library publish ${slug} --file <path> --force`)

  return { conflicted: true, lines, exitCode: 1 }
}

/**
 * Point the local file at the state a publish just created.
 *
 * Without this, `pull -> edit -> publish -> publish` refuses on the second publish, because the
 * file still claims the hash it was pulled at while the server has moved on — you conflict with
 * yourself. Measured on the real round trip before this existed.
 *
 * That failure mode is worse than it looks. A guard that fires on your own work teaches people
 * to pass `--force` by reflex, and a reflex `--force` removes the protection for the case it was
 * built for. So the guard has to be quiet when nothing is wrong.
 *
 * An empty new hash REMOVES the marker rather than leaving the old one: a stale marker would
 * make the next publish compare against a state that is no longer live, and a check whose
 * inputs disagree with reality is worse than no check.
 */
export function restampComponentHeader(fileContents: string, meta: ComponentMeta): string {
  const body = stripComponentHeader(fileContents ?? "")
  if (!meta?.hash) return body
  return `${componentHeader(meta)}\n${body}`
}
