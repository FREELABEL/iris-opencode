/**
 * The android body class — ARTEMIS is the actuator, the clutch is the authorisation.
 *
 * A phone is the highest-consequence body IRIS drives: it carries the sessions that authorise
 * everything else. These pin the three ways this row could be wrong while looking right.
 */
import { describe, expect, test } from "bun:test"
import { routeFor, unknownVerbs, knownVerbs, BODY_CLASSES } from "./kinetic-bodies"
import { decide, decideClass, bodyForDevice, bodyMatches, type Couple } from "./kinetic-couple"

const HASH = "sha256:" + "b".repeat(64)
const ACTOR = { kind: "agent" as const, hash: HASH }
const NODE = "hive-node-studio"
const NOW = "2026-09-21T12:00:00.000Z"
const SERIAL = "39081FDJH00ABC"

const couple = (over: Partial<Couple> = {}): Couple => ({
  id: "cpl_android",
  agent: HASH,
  node: NODE,
  body: `android:${SERIAL.toLowerCase()}`,
  allowlist: ["run"],
  policy: {},
  created_at: "2026-09-21T11:00:00.000Z",
  ...over,
})

describe("the phone is routed as a body, so no act path is opt-in", () => {
  test("every verb the command exposes reaches the guard", () => {
    expect(routeFor(["android", "run", "open settings"])).toMatchObject({ class: "android", verb: "run" })
    expect(routeFor(["android", "tap", "500", "900"])).toMatchObject({ class: "android", verb: "tap" })
    expect(routeFor(["android", "type", "hello"])).toMatchObject({ class: "android", verb: "type" })
    expect(routeFor(["android", "swipe", "up"])).toMatchObject({ class: "android", verb: "swipe" })
    expect(routeFor(["android", "key", "back"])).toMatchObject({ class: "android", verb: "key" })
    expect(routeFor(["android", "app", "launch", "com.android.settings"])).toMatchObject({ class: "android", verb: "app" })
    expect(routeFor(["android", "open", "https://example.com"])).toMatchObject({ class: "android", verb: "open" })
  })

  test("the aliases route too — `iris adb tap` is the same act as `iris android tap`", () => {
    expect(routeFor(["adb", "tap", "1", "2"])).toMatchObject({ class: "android", verb: "tap" })
    expect(routeFor(["android", "click", "1", "2"])).toMatchObject({ class: "android", verb: "tap" })
    expect(routeFor(["android", "task", "do a thing"])).toMatchObject({ class: "android", verb: "run" })
    expect(routeFor(["android", "scroll", "down"])).toMatchObject({ class: "android", verb: "swipe" })
  })

  /**
   * FOUND BY BREAKING IT. The first draft of this class was called `phone` and mapped the head
   * word "phone" to it — but `iris phone` is an EXISTING, unrelated command that manages agent
   * phone NUMBERS. Mapping it here would have put an unrelated command behind the clutch, where
   * the failure is a refusal to list a phone number with a message about coupling a body.
   * ARTEMIS is Android-only anyway, so `android` is both the safe name and the honest one.
   */
  test("`iris phone` is a different command and never routes to a body", () => {
    // Its CURRENT sub-commands, which must stay unguarded…
    for (const r of [["phone", "list"], ["phone", "buy", "+15551234567"], ["phone", "search"], ["phone", "providers"], ["phone", "get", "42"]])
      expect(routeFor(r)).toBeNull()
    // …and the real assertion, which is about the future: NO android verb may be reachable under
    // the head word `phone`. The first version of this test only checked the sub-commands above
    // and passed even with the bad mapping restored — none of them happen to collide TODAY. The
    // day `iris phone` gains an `open` or a `run`, that version would have stayed green while the
    // command quietly started demanding a couple.
    for (const v of knownVerbs("android")) expect(routeFor(["phone", v, "x"]), `iris phone ${v} must not route`).toBeNull()
  })

  test("looking is not moving — reads route to nothing", () => {
    for (const r of [
      ["android", "devices"], ["android", "list"], ["android", "ls"],
      ["android", "state"], ["android", "status"], ["android", "screenshot"], ["android", "screen"],
      ["android", "doctor"], ["android", "logcat"], ["android", "trace"],
    ])
      expect(routeFor(r)).toBeNull()
  })
})

/**
 * THE ONE THAT MATTERS. Every other body either has no positional instance or keeps it in a fixed
 * slot. A phone's serial arrives as `--device`, while the word after the sub-command is the
 * PAYLOAD. Reading it as an instance asks for a couple on `android:open settings` — a body that can
 * never exist — so every act is refused for a reason that looks like the guard being broken, and
 * the obvious "fix" is to loosen it.
 */
describe("the instance never comes from the payload", () => {
  test("a task, a coordinate and a package name are not device serials", () => {
    expect(routeFor(["android", "run", "open settings"])?.instance ?? null).toBeNull()
    expect(routeFor(["android", "tap", "500", "900"])?.instance ?? null).toBeNull()
    expect(routeFor(["android", "app", "launch", "com.android.settings"])?.instance ?? null).toBeNull()
    expect(routeFor(["android", "open", "https://example.com"])?.instance ?? null).toBeNull()
  })

  test("so the middleware asks the CLASS question, which a phone:* couple answers", () => {
    const route = routeFor(["android", "run", "transfer money"])!
    const d = decideClass({
      actor: ACTOR, node: NODE, bodyClass: route.class, verb: route.verb,
      couples: [couple({ body: "android:*" })], now: NOW,
    })
    expect(d.decision).not.toBe("deny")
  })

  test("and the act path's precise question still binds to the real serial", () => {
    const body = bodyForDevice("android", SERIAL)!
    expect(body).toBe(`android:${SERIAL.toLowerCase()}`)
    expect(bodyMatches("android:*", body)).toBe(true)
    // a couple for a DIFFERENT handset must not cover this one
    expect(bodyMatches("android:otherserial", body)).toBe(false)
  })
})

describe("no couple, no move — the point of attaching a clutch to ARTEMIS", () => {
  test("an uncoupled agent is denied the natural-language path", () => {
    const d = decide({ actor: ACTOR, node: NODE, body: `android:${SERIAL.toLowerCase()}`, verb: "run", couples: [], now: NOW })
    expect(d.decision).toBe("deny")
  })

  test("a couple that blesses `run` does not bless `type` — no free pass on the rest", () => {
    const only = [couple({ allowlist: ["run"] })]
    const args = { actor: ACTOR, node: NODE, body: `android:${SERIAL.toLowerCase()}`, couples: only, now: NOW }
    expect(decide({ ...args, verb: "run" }).decision).not.toBe("deny")
    expect(decide({ ...args, verb: "type" }).decision).toBe("deny")
  })
})

/**
 * The `device` row's first draft declared verbs no act path had — a couple that could never match,
 * wearing the costume of a policy. This asserts the two halves cannot drift: every verb the class
 * DECLARES must be one `routeFor` can actually emit, and vice versa.
 */
describe("declared verbs and routable verbs are the same set", () => {
  const declared = knownVerbs("android")

  test("the class is registered at all", () => {
    expect(BODY_CLASSES.some((c) => c.name === "android")).toBe(true)
    expect(declared.length).toBeGreaterThan(0)
  })

  test("every declared verb is reachable from a real command", () => {
    const sample: Record<string, string[]> = {
      run: ["android", "run", "x"],
      tap: ["android", "tap", "1", "2"],
      type: ["android", "type", "x"],
      swipe: ["android", "swipe", "up"],
      key: ["android", "key", "back"],
      app: ["android", "app", "launch", "com.x.y"],
      open: ["android", "open", "https://x.test"],
    }
    for (const v of declared) {
      expect(sample[v], `declared verb "${v}" has no command that produces it`).toBeDefined()
      expect(routeFor(sample[v])).toMatchObject({ class: "android", verb: v })
    }
  })

  test("coupling a verb the phone does not have is refused as a typo", () => {
    expect(unknownVerbs("android:*", ["run", "tap"])).toEqual([])
    expect(unknownVerbs("android:*", ["reboot"])).toEqual(["reboot"])
    // `wait_for_delay` is real inside ARTEMIS but is not an IRIS verb — transcribing their whole
    // internal vocabulary would bless couples that no command can ever satisfy.
    expect(unknownVerbs("android:*", ["wait_for_delay"])).toEqual(["wait_for_delay"])
  })
})
