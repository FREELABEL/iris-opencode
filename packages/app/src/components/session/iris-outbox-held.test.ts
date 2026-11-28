import { describe, expect, test } from "bun:test"
import { outboxResultLine } from "./iris-outbox-held"

// "Send now" (#194509): what POST /iris/atlas-outbox/send answered, as one line.
const t = (key: string, p?: Record<string, string | number>) => `${key}${p ? ` ${JSON.stringify(p)}` : ""}`

describe("outboxResultLine", () => {
  test("all sent is a success, in its count", () => {
    expect(outboxResultLine({ sent: 3, held: 0, waiting: 0, offline: false }, t)).toEqual({
      tone: "success",
      text: 'iris.atlas.outbox.sent {"count":3}',
    })
  })
  test("held or still waiting is a warning, and says each", () => {
    const r = outboxResultLine({ sent: 1, held: 1, waiting: 2, offline: false }, t)
    expect(r.tone).toBe("warning")
    expect(r.text).toBe('iris.atlas.outbox.sent {"count":1} · iris.atlas.outbox.held {"count":1} · iris.atlas.outbox.left {"count":2}')
  })
  test("still offline says so, not 'nothing sent'", () => {
    expect(outboxResultLine({ sent: 0, held: 0, waiting: 3, offline: true }, t)).toEqual({ tone: "warning", text: "iris.atlas.outbox.offline" })
  })
  test("nothing waiting, and a failed call", () => {
    expect(outboxResultLine({ sent: 0, held: 0, waiting: 0, offline: false }, t).text).toBe("iris.atlas.outbox.nothing")
    expect(outboxResultLine({ error: "HTTP 500" }, t)).toEqual({ tone: "critical", text: 'iris.atlas.outbox.failed {"reason":"HTTP 500"}' })
  })
})
