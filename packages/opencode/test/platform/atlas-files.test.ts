/**
 * `iris atlas files` — the shape normalisation (#182009).
 *
 * MEASURED FAILURE, 2026-08-23. This API returns a file list in two different shapes:
 *
 *     /api/v1/user/{id}/bloqs/files?bloq_id=N   ->  data: { items, pagination, filters }
 *     /api/v1/bloqs/{id}/files                  ->  data: [ ... ]
 *
 * platform-bloq-export.ts read the first as the second — `filesData?.data ?? []` — and got
 * the OBJECT. `files.length` was therefore `undefined`, `files.length > 0` was false, and the
 * download loop never ran. Bloq 569 has sixteen attachments and the export produced none.
 *
 * It then wrote `attachments_downloaded: 0, attachments_failed: 0` into the manifest, which
 * is EXACTLY what a bloq with no attachments produces. On that reading a session concluded,
 * and stated confidently, that an irreplaceable artefact was not backed up. It was.
 *
 * (The manifest did carry `attachments_listed`, but it was `undefined`, and JSON.stringify
 * drops undefined keys — so the evidence took the form of an ABSENT FIELD, which is not
 * something a reader notices.)
 */

import { describe, test, expect } from "bun:test"
import { normalizeFileList } from "../../src/cli/cmd/platform-atlas-files"

// The real payload from /user/{id}/bloqs/files?bloq_id=569, trimmed.
const PAGINATED = {
  success: true,
  data: {
    items: [
      { id: 1277, filename: "Pioneer-DDJ-T1-script.js", title: "current mapping", url: "https://cdn.heyiris.io/cloud-files/x.js", size: 8850, filetype: "text/plain" },
      { id: 1276, filename: "Pioneer DDJ-T1.midi.xml", url: "https://cdn.heyiris.io/cloud-files/y.xml", size: 56933, filetype: "text/xml" },
    ],
    pagination: { total: 2 },
    filters: {},
  },
}

// The real payload from /bloqs/{id}/files, trimmed.
const FLAT = {
  success: true,
  data: [
    { id: 1277, original_filename: "Pioneer-DDJ-T1-script.js", filename: "1787454475_Pioneer-DDJ-T1-script.js", file_size: 8850, filetype: "text/plain" },
  ],
}

describe("normalizeFileList", () => {
  test("reads the PAGINATED shape — the one the export silently mis-read", () => {
    const files = normalizeFileList(PAGINATED)
    expect(files.length).toBe(2)
    expect(files[0].id).toBe(1277)
    expect(files[0].size).toBe(8850)
    expect(files[1].name).toBe("Pioneer DDJ-T1.midi.xml")
  })

  test("reads the FLAT shape too, preferring the original filename over the stored one", () => {
    const files = normalizeFileList(FLAT)
    expect(files.length).toBe(1)
    // The stored name is prefixed with a timestamp; the original is what a person recognises.
    expect(files[0].name).toBe("Pioneer-DDJ-T1-script.js")
    expect(files[0].size).toBe(8850)
  })

  test("THE REGRESSION GUARD: the paginated shape must never normalise to zero files", () => {
    // This is the exact assertion whose absence let a bloq with 16 attachments export none.
    expect(normalizeFileList(PAGINATED).length).toBeGreaterThan(0)
    // And the specific bug: treating `data` as the array yields an object with no length.
    expect(Array.isArray((PAGINATED as any).data)).toBe(false)
  })

  test("an empty list is empty — not an error, and not a crash", () => {
    expect(normalizeFileList({ success: true, data: { items: [], pagination: {}, filters: {} } })).toEqual([])
    expect(normalizeFileList({ success: true, data: [] })).toEqual([])
  })

  test("garbage in does not throw — a malformed body must not take down an export", () => {
    expect(normalizeFileList(null)).toEqual([])
    expect(normalizeFileList(undefined)).toEqual([])
    expect(normalizeFileList({})).toEqual([])
    expect(normalizeFileList({ data: null })).toEqual([])
    expect(normalizeFileList({ data: { items: "nope" } })).toEqual([])
  })

  test("falls back through the url field names rather than dropping the file", () => {
    expect(normalizeFileList({ data: [{ id: 1, cdn_url: "https://a/1" }] })[0].url).toBe("https://a/1")
    expect(normalizeFileList({ data: [{ id: 2, public_url: "https://a/2" }] })[0].url).toBe("https://a/2")
    // No url at all is null, so the caller can report "the record has no URL" rather than
    // silently skipping it.
    expect(normalizeFileList({ data: [{ id: 3 }] })[0].url).toBeNull()
  })

  test("a file with no name still gets one, so it can be reported", () => {
    expect(normalizeFileList({ data: [{ id: 99 }] })[0].name).toBe("file-99")
  })

  test("size is null when unknown — never 0, which would read as an empty file", () => {
    expect(normalizeFileList({ data: [{ id: 1 }] })[0].size).toBeNull()
  })
})
