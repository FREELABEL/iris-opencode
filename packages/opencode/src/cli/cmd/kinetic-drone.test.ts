/**
 * The drone body class (#189857, step 1) — a drone flown by a Hive script asks the clutch before
 * it takes off, so "only approved maneuvers" is true for drones and not only for cameras.
 */
import { describe, expect, test } from "bun:test"
import { routeFor, unknownVerbs, knownVerbs, BODY_CLASSES } from "./kinetic-bodies"
import { decide, bodyForDevice, type Couple } from "./kinetic-couple"

const HASH = "sha256:" + "d".repeat(64)
const ACTOR = { kind: "agent" as const, hash: HASH }
const NODE = "studio-mac"
const NOW = "2026-10-19T12:00:00.000Z"
const DRONE = "drone:mambo-716814"

const couple = (over: Partial<Couple> = {}): Couple => ({
  id: "cpl_drone",
  agent: HASH,
  node: NODE,
  body: DRONE,
  allowlist: ["takeoff", "up", "down", "turn", "hover"],
  policy: {},
  created_at: "2026-10-19T11:00:00.000Z",
  ...over,
})

describe("the class is the flight-plan grammar, not a list of preset names", () => {
  test("registered, with mambo.py's step verbs plus the takeoff every plan implies", () => {
    expect(BODY_CLASSES.some((c) => c.name === "drone")).toBe(true)
    expect([...knownVerbs("drone")].sort()).toEqual(["down", "flip", "hover", "takeoff", "turn", "up"])
  })

  /**
   * #189857's first draft proposed hop/spin/move. hop and spin are PRESETS — sequences of the verbs
   * above — so coupling them would bless a name the script never asks about. `move` is a direction
   * the plan language has no word for. A couple naming any of them is a typo, not a policy.
   */
  test("preset names and invented directions are refused at coupling time", () => {
    expect(unknownVerbs("drone:*", ["takeoff", "turn"])).toEqual([])
    expect(unknownVerbs("drone:*", ["hop", "spin", "move"])).toEqual(["hop", "spin", "move"])
  })

  /**
   * Landing is never something a couple can withhold. If `land` were a verb, a couple that left it
   * out would refuse the one act that must always happen — every plan ends with it, on error too.
   */
  test("land is not a verb, so no couple can refuse a landing", () => {
    expect(knownVerbs("drone")).not.toContain("land")
  })
})

describe("no couple, no flight", () => {
  const ask = (verb: string, couples: Couple[]) => decide({ actor: ACTOR, node: NODE, body: DRONE, verb, couples, now: NOW })

  test("an uncoupled agent cannot take off", () => {
    expect(ask("takeoff", []).decision).toBe("deny")
  })

  test("an indoor couple flies the vertical presets and refuses a flip", () => {
    const indoor = [couple()]
    for (const v of ["takeoff", "up", "down", "turn", "hover"]) expect(ask(v, indoor).decision, v).toBe("allow")
    expect(ask("flip", indoor).decision).toBe("deny")
  })

  test("a couple for one drone does not cover another", () => {
    const d = decide({ actor: ACTOR, node: NODE, body: "drone:mambo-000001", verb: "takeoff", couples: [couple()], now: NOW })
    expect(d.decision).toBe("deny")
  })

  test("drone:* covers every drone on that node, and only that node", () => {
    const fleet = [couple({ body: "drone:*" })]
    expect(decide({ actor: ACTOR, node: NODE, body: "drone:mambo-000001", verb: "takeoff", couples: fleet, now: NOW }).decision).toBe("allow")
    expect(decide({ actor: ACTOR, node: "other-node", body: "drone:mambo-000001", verb: "takeoff", couples: fleet, now: NOW }).decision).toBe("deny")
  })
})

describe("the drone's name becomes a legal, stable body", () => {
  /**
   * A Mambo advertises itself as `Mambo_716814`. An underscore is not legal in an instance, so the
   * raw name would be refused as "not a body name" — the wrong refusal, for the wrong reason.
   * mambo.py slugs the name the same way; this pins the shape it must produce.
   */
  test("Mambo_716814 → drone:mambo-716814", () => {
    expect(bodyForDevice("drone", "Mambo_716814")).toBe(DRONE)
  })
})

describe("no `iris` sub-command routes to a drone", () => {
  /**
   * The script is the actuator and it asks the clutch itself. If a head word ever routed here, the
   * middleware would start demanding a drone couple for some unrelated command.
   */
  test("drone verbs under any head word are not routed", () => {
    for (const head of ["drone", "mambo", "fly"]) for (const v of knownVerbs("drone")) expect(routeFor([head, v, "x"]), `${head} ${v}`).toBeNull()
  })
})
