/**
 * The one definition of "a request to OUR servers". Harvest and verify both ask it.
 *
 * They used to keep separate copies, and the copies drifted: harvest's regex required https and did
 * not list apiv2.heyiris.io, while verify's matched any scheme and did. So a page calling apiv2 was
 * never mirrored by harvest — and then failed verify's independence check, for an asset the export
 * had been perfectly able to fetch. Two instruments that disagree about what they are measuring
 * produce a failure nobody can act on. One predicate, imported by both.
 *
 * Match on HOST, never substring: a substring test flags the harvested copies under
 * /_ext/freelabel.net/... as calls home, and a checker that cries wolf gets ignored exactly as fast
 * as one that stays silent.
 */
export const OUR_HOSTS =
  /^(?:www\.)?(?:freelabel\.net|heyiris\.io|cdn\.heyiris\.io|raichu\.heyiris\.io|apiv2\.heyiris\.io)$/

export const isOurs = (u: string): boolean => {
  try {
    const url = new URL(u)
    return (url.protocol === "https:" || url.protocol === "http:") && OUR_HOSTS.test(url.hostname)
  } catch {
    return false
  }
}
