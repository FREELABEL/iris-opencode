import { afterEach, describe, expect, test } from "bun:test"
import { TerminalMode, transcript, TRANSCRIPT_OUTPUT_LIMIT, type TerminalEntry } from "./terminal-mode"

const entry = (over: Partial<TerminalEntry>): TerminalEntry => ({
  key: "k",
  command: "ls",
  output: "",
  truncated: false,
  status: "exited",
  exitCode: 0,
  error: null,
  started: 1000,
  ended: 1400,
  ...over,
})

afterEach(() => TerminalMode.reset())

describe("terminal transcript (#190530)", () => {
  test("one message: each command, its output, and how it ended", () => {
    const text = transcript(
      [
        entry({ command: "echo hi", output: "hi\n" }),
        entry({ command: "false", exitCode: 1 }),
        entry({ command: "sleep 9", status: "cancelled", ended: 3000 }),
        entry({ command: "nope", status: "error", error: "spawn failed", ended: null }),
      ],
      "/repo",
    )
    expect(text).toBe(
      [
        "Terminal · 4 commands · /repo",
        "",
        "$ echo hi",
        "hi",
        "[exit 0 · 400ms]",
        "",
        "$ false",
        "[exit 1 · 400ms]",
        "",
        "$ sleep 9",
        "[stopped · 2.0s]",
        "",
        "$ nope",
        "[error: spawn failed]",
      ].join("\n"),
    )
  })

  test("a command still running is said so, not reported as finished", () => {
    expect(transcript([entry({ status: "running", ended: null })])).toContain("still running when the terminal closed")
  })

  test("colour codes are removed", () => {
    expect(transcript([entry({ output: "\u001b[31mred\u001b[0m plain" })])).toContain("\nred plain\n")
  })

  test("long output keeps its tail and says the start was omitted", () => {
    const text = transcript([entry({ output: "x".repeat(TRANSCRIPT_OUTPUT_LIMIT + 50) + "END" })])
    expect(text).toContain("END")
    expect(text).toContain("earlier output omitted")
    expect(text.length).toBeLessThan(TRANSCRIPT_OUTPUT_LIMIT + 500)
  })
})

describe("TerminalMode", () => {
  test("runs, follows output to the end, and closing hands over one transcript and starts fresh", async () => {
    const reads = [
      { status: "running", output: "1\n", next: 2, truncated: false, exitCode: null, error: null },
      { status: "exited", output: "2\n", next: 4, truncated: false, exitCode: 0, error: null },
    ]
    const calls: string[] = []
    TerminalMode.attach("ses", "/repo", async (path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`)
      if (init?.method === "POST") return new Response(JSON.stringify({ id: "r1" }))
      return new Response(JSON.stringify(reads.shift()))
    })
    await TerminalMode.run("ses", "seq 2")
    expect(calls).toEqual(["POST /session/ses/terminal", "GET /session/ses/terminal/r1?from=0", "GET /session/ses/terminal/r1?from=2"])
    expect(TerminalMode.entries("ses")[0]).toMatchObject({ output: "1\n2\n", status: "exited", exitCode: 0 })
    expect(TerminalMode.running("ses")).toBe(false)

    const sent: string[] = []
    await TerminalMode.close("ses", async (text) => sent.push(text))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("$ seq 2")
    expect(TerminalMode.entries("ses")).toEqual([])
  })

  test("a failed send keeps the transcript so nothing is lost", async () => {
    TerminalMode.attach("ses", "/repo", async (_path, init) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ id: "r1" }))
        : new Response(JSON.stringify({ status: "exited", output: "", next: 0, truncated: false, exitCode: 0, error: null })),
    )
    await TerminalMode.run("ses", "true")
    await expect(TerminalMode.close("ses", async () => Promise.reject(new Error("offline")))).rejects.toThrow("offline")
    expect(TerminalMode.entries("ses")).toHaveLength(1)
  })

  test("a start the server refuses is an error entry with its reason", async () => {
    TerminalMode.attach("ses", "/repo", async () =>
      new Response(JSON.stringify({ message: "Too many terminal commands" }), { status: 409 }),
    )
    await TerminalMode.run("ses", "ls")
    expect(TerminalMode.entries("ses")[0]).toMatchObject({ status: "error", error: "Too many terminal commands" })
  })

  test("closing while a command runs asks first; Stop and close cancels it", async () => {
    const cancels: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    TerminalMode.attach("ses", "/repo", async (path, init) => {
      if (path.endsWith("/cancel")) {
        cancels.push(path)
        release()
        return new Response(JSON.stringify({ cancelled: true }))
      }
      if (init?.method === "POST") return new Response(JSON.stringify({ id: "r1" }))
      await gate
      return new Response(JSON.stringify({ status: "cancelled", output: "", next: 0, truncated: false, exitCode: null, error: null }))
    })
    const running = TerminalMode.run("ses", "sleep 30")
    await new Promise((r) => setTimeout(r, 10))
    expect(TerminalMode.requestClose("ses")).toBe(false)
    expect(TerminalMode.confirming("ses")).toBe(true)
    TerminalMode.stopAndClose("ses")
    await running
    expect(cancels).toEqual(["/session/ses/terminal/r1/cancel"])
    expect(TerminalMode.closing("ses")).toBe(true)
    expect(TerminalMode.entries("ses")[0]?.status).toBe("cancelled")
  })
})
