/**
 * #189372 — `iris hive send` refused EVERY input. The Kinetic route table read the word after
 * `send` as the node, but that word is the PAYLOAD; the node is `--to`. So the guard asked for a
 * couple on `node:/tmp/handoff.md` / `node:hello there`, decided "not a body name", and exited
 * before anything was sent — for files, text and links alike, to the sender's own online node.
 *
 * These drive the same two pure functions the CLI runs (routeFor → decide, and the handler's
 * argument resolver) with the exact invocations from the bug report.
 */
import { describe, expect, test } from "bun:test"
import { routeFor } from "./kinetic-bodies"
import { decide } from "./kinetic-couple"
import { resolveSendArgs } from "./platform-hive-send"

const NOW = "2026-10-14T17:37:19.000Z"

/** What kinetic-guard asks for an operator on an unlocked node — the reporter's situation. */
function gate(argv: string[]) {
  const route = routeFor(argv)!
  expect(route).toMatchObject({ class: "node", verb: "send" })
  const body = `${route.class}:${route.instance ?? "*"}`
  return {
    route,
    decision: decide({ actor: { kind: "operator" }, node: "hive-node-sender", body, verb: route.verb, couples: [], now: NOW, enforceOperators: false } as any),
  }
}

describe("#189372 — the guard reads the node from --to, never from the content", () => {
  const cases: [string, string[]][] = [
    ["file", ["hive", "send", "/tmp/epic-189371-rodney-mailjet-handoff.md", "--to", "alexmaysnow1063", "-m", "urgent"]],
    ["text", ["hive", "send", "handoff epic #189371 — fix rodney's mailjet", "--to", "alexmaysnow1063"]],
    ["url", ["hive", "send", "https://heyiris.io/p/x", "--to", "alexmaysnow1063"]],
    ["--to=", ["hive", "send", "hello there", "--to=alexmaysnow1063"]],
    ["flag first", ["hive", "send", "--to", "alexmaysnow1063", "hello there"]],
  ]
  for (const [name, argv] of cases) {
    test(`${name}: the body is node:<--to>, and an operator's send is allowed`, () => {
      const { route, decision } = gate(argv)
      expect(route.instance).toBe("alexmaysnow1063")
      expect(decision.decision).toBe("allow")
      expect(decision.reason).not.toContain("not a body name")
    })
  }

  test("node-first positional form: the first word is the node", () => {
    expect(routeFor(["hive", "send", "alexmaysnow1063", "build is green"])).toEqual({ class: "node", verb: "send", instance: "alexmaysnow1063" })
  })

  test("a node name with spaces becomes a legal instance instead of a 'not a body name' refusal", () => {
    expect(routeFor(["hive", "send", "x", "--to", "alex's macbook pro"])?.instance).toBe("alex-s-macbook-pro")
  })

  test("--to all is a class-level ask, not an instance called 'all'", () => {
    expect(routeFor(["hive", "send", "hi", "--to", "all"])).toEqual({ class: "node", verb: "send", instance: null })
  })

  test("hive run still takes its node from the word after the sub-command", () => {
    expect(routeFor(["hive", "run", "studio-mac", "ls"])).toEqual({ class: "node", verb: "run", instance: "studio-mac" })
  })
})

describe("#189372 — the handler resolves target and content from both forms", () => {
  test("documented form: <content> --to <node>", () => {
    expect(resolveSendArgs("/tmp/a.md", [], "Mac")).toEqual({ target: "Mac", content: "/tmp/a.md" })
  })
  test("with --to, every positional is content (an unquoted sentence is not truncated)", () => {
    expect(resolveSendArgs("hello", ["there", "friend"], "Mac")).toEqual({ target: "Mac", content: "hello there friend" })
  })
  test("node-first form: <node> <message...>", () => {
    expect(resolveSendArgs("Mac", ["build", "is green"], undefined)).toEqual({ target: "Mac", content: "build is green" })
  })
  test("one word and no --to is an error that names both forms, not a guess", () => {
    const r = resolveSendArgs("hello", undefined, undefined)
    expect("error" in r && r.error).toContain("--to <node>")
  })
})
