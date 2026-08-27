/**
 * Addressing for public IRIS page URLs — kept dependency-free ON PURPOSE.
 *
 * These are pure functions that decide WHERE a slug lives and WHAT to say when nothing is
 * there. They live outside `platform-pages.ts` so they can be tested without dragging in
 * yargs, the UI layer and the API client — the same split `hive-uptime.ts` uses.
 */

/**
 * A PUBLISHED ATLAS NOTE is not served from /p/.
 *
 * Notes get an `n-<uuid>` slug and render through the public NOTE viewer at `/n/<uuid>`.
 * Building `/p/n-<uuid>` for one is a guaranteed 404 against a page that is live and
 * readable — and the old 404 text then blamed the only cause it knew about ("this is a
 * draft, publish it"), which sent you to publish something already published. A read-back
 * tool naming a cause it did not check is the same defect class these commands exist to
 * remove, so the ref shape is now recognised instead of assumed. Matches `atlas use`,
 * which has always addressed notes by uuid.
 */
const NOTE_SLUG_RE = /^(?:n-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** The uuid behind a note ref (`n-<uuid>` or a bare uuid), or null for an ordinary page slug. */
export function noteUuid(slugOrPage: string | { slug?: string }): string | null {
  const slug = typeof slugOrPage === "string" ? slugOrPage : (slugOrPage?.slug ?? "")
  const m = (slug || "").trim().match(NOTE_SLUG_RE)
  return m ? m[1].toLowerCase() : null
}

export function publicUrl(slugOrPage: string | { public_url?: string; slug?: string }): string {
  if (typeof slugOrPage === "object" && slugOrPage.public_url) {
    return slugOrPage.public_url
  }
  const slug = typeof slugOrPage === "string" ? slugOrPage : (slugOrPage.slug ?? "")
  const uuid = noteUuid(slug)
  const path = uuid ? `n/${uuid}` : `p/${slug}`
  const env = process.env.IRIS_ENV ?? "production"
  return env === "local"
    ? `http://local.iris.freelabel.net:9300/${path}`
    : `https://freelabel.net/${path}`
}

/**
 * Why a public read came back empty — WITHOUT asserting a cause that was never checked.
 *
 * A note that 404s is not a draft (notes are not published through `pages publish` at all),
 * so offering that command would be wrong twice over.
 */
export function notFoundHint(slug: string): string {
  return noteUuid(slug)
    ? `That is a NOTE ref — notes render at /n/<uuid>, not /p/. If this url 404s the note is unshared or the uuid is wrong; read its text with: iris atlas use ${slug}`
    : `/p/ serves PUBLISHED pages only. If this is a draft: iris pages publish ${slug}`
}
