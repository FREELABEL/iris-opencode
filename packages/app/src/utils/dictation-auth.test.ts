import { describe, expect, test } from "bun:test"
import { dictationAuthFor } from "./dictation-auth"

// Dictation talks to the local server with raw fetches, not through the SDK. These must carry the
// SDK's credentials, or the microphone breaks the day a server password is set.
describe("dictationAuthFor", () => {
  const server = { url: "http://127.0.0.1:4096/", username: "opencode", password: "s3cret" }

  test("the server's own URL gets the SDK's Basic header", () => {
    expect(dictationAuthFor(server, "http://127.0.0.1:4096")).toEqual({
      Authorization: `Basic ${btoa("opencode:s3cret")}`,
    })
  })

  test("another server's URL gets nothing — credentials never go to a host they are not for", () => {
    expect(dictationAuthFor(server, "http://127.0.0.1:5000")).toBeUndefined()
  })

  test("no password, no header", () => {
    expect(dictationAuthFor({ url: "http://127.0.0.1:4096" }, "http://127.0.0.1:4096")).toBeUndefined()
  })
})
