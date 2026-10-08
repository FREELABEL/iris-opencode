import { describe, expect, test } from "bun:test"
import { parseHookEvents } from "./platform-atlas-dataset-hooks"

/**
 * #187898 — `iris datasets hooks add <slug> --on …`. yargs hands `--on` over as an array of
 * whatever was typed; the server only accepts created/updated/deleted. Refusing an unknown
 * name here, by name, beats a generic 422 that leaves the caller guessing which word was wrong.
 */
describe("parseHookEvents", () => {
  test("repeated, comma-separated and mixed-case forms all land on the canonical list", () => {
    expect(parseHookEvents(["created"]).events).toEqual(["created"])
    expect(parseHookEvents(["Updated,created", "deleted"]).events).toEqual(["created", "updated", "deleted"])
    expect(parseHookEvents("created, created").events).toEqual(["created"])
  })

  test("all means every event", () => {
    expect(parseHookEvents(["all"]).events).toEqual(["created", "updated", "deleted"])
  })

  test("an unknown event is reported, not silently dropped", () => {
    const r = parseHookEvents(["created", "inserted"])
    expect(r.unknown).toEqual(["inserted"])
    expect(r.events).toEqual(["created"])
  })

  test("nothing given is nothing", () => {
    expect(parseHookEvents(undefined).events).toEqual([])
  })
})
