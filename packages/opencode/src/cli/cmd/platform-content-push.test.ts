import { describe, expect, test } from "bun:test"
import { pushBody, PUSH_FIELDS } from "./platform-content"

// #194159: `content push` used one field list for every type, so a track's audio and artwork
// were dropped on the floor while the command printed "Updated".
describe("content push body", () => {
  test("a track sends its audio and artwork", () => {
    const body = pushBody("track", { id: 1, title: "Set", trackmp3: "https://cdn/x.mp3", photo: "https://cdn/x.jpg", poster: "https://cdn/x.jpg", status: 1 })
    expect(body.trackmp3).toBe("https://cdn/x.mp3")
    expect(body.photo).toBe("https://cdn/x.jpg")
    expect(body.poster).toBe("https://cdn/x.jpg")
    expect(body.id).toBeUndefined()
  })

  test("fields missing from the local file are not sent (never blanked)", () => {
    const body = pushBody("track", { title: "Only title" })
    expect(Object.keys(body)).toEqual(["title"])
  })

  test("every type still sends the original fields", () => {
    for (const t of Object.keys(PUSH_FIELDS)) {
      for (const f of ["title", "description", "status"]) expect(PUSH_FIELDS[t]).toContain(f)
    }
  })
})
