/**
 * Gmail CONTRACT test — the real binary against the real backend and a real mailbox.
 *
 * Why this exists (#189389): every unit test passed while `iris gmail read <id>` said "not
 * found" for EVERY message on every Composio account. The backend's fake Composio returned
 * `id`; real Composio returns `messageId`. A fake typed from the docs agrees with the code that
 * was written from the same docs — it cannot catch this. Only the real boundary can.
 *
 * The contract is the thing a client's agent relies on, stated as round-trips:
 *   every id a listing returns opens with `read`, as itself, with a sender and a subject.
 *
 * Opt-in (needs a signed-in account with Gmail connected):
 *   IRIS_CONTRACT=1 bun test test/contract/gmail.contract.test.ts
 *   IRIS_BIN=/path/to/iris   to test a specific build (default: `iris` on PATH)
 * Read-only: it never sends, labels, moves or deletes anything.
 */
import { describe, expect, test } from "bun:test"

const ON = process.env.IRIS_CONTRACT === "1"
// IRIS_BIN may be a command line, e.g. "bun run --conditions=browser ./src/index.ts" to test this checkout.
const BIN = (process.env.IRIS_BIN || "iris").split(" ").filter(Boolean)
const T = 90_000

function run(...args: string[]) {
  const p = Bun.spawnSync([...BIN, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

function json(r: { out: string; code: number | null; err: string }, what: string): any {
  try {
    return JSON.parse(r.out)
  } catch {
    throw new Error(`${what}: stdout is not JSON (exit ${r.code}).\nstdout: ${r.out.slice(0, 400)}\nstderr: ${r.err.slice(0, 400)}`)
  }
}

describe.skipIf(!ON)("gmail contract (live)", () => {
  let ids: string[] = []

  test("a listing returns messages with an id, a sender and a subject", () => {
    const r = run("gmail", "inbox", "--limit", "5", "--json")
    expect(r.code).toBe(0)
    const list = json(r, "gmail inbox --json")
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)
    for (const m of list) {
      expect(m.id, "listing row has no id").toBeTruthy()
      expect(m.from, `message ${m.id} has no sender`).toBeTruthy()
    }
    ids = list.map((m: any) => m.id)
  }, T)

  test("every listed id opens with `gmail read`, as itself", () => {
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids.slice(0, 3)) {
      const r = run("gmail", "read", id, "--json")
      expect(r.code, `gmail read ${id} exited ${r.code}: ${r.out.slice(0, 200)}`).toBe(0)
      const m = json(r, `gmail read ${id} --json`)
      expect(m.id).toBe(id)
      expect(m.from).toBeTruthy()
      expect(typeof m.subject).toBe("string")
    }
  }, T)

  test("the backend action an agent falls back to returns the same message, with its id", () => {
    const id = ids[0]
    const r = run("integrations", "exec", "gmail", "get_email", `message_id=${id}`, "--json")
    expect(r.code).toBe(0)
    const d = json(r, "integrations exec gmail get_email --json")
    const e = d.email ?? d.data?.email ?? d
    expect(e.id, "get_email returned an empty id (#189389)").toBe(id)
  }, T)

  test("a message that does not exist is a FAILURE — non-zero exit, not a quiet 'not found' with exit 0", () => {
    const r = run("gmail", "read", "0000000000000000", "--json")
    expect(r.code).not.toBe(0)
  }, T)

  // Source runs (IRIS_BIN="bun run ...") print a dev-dependency staleness notice the compiled binary does not.
  const stderrOf = (r: { err: string }) => r.err.split("\n").filter((l) => l.trim() && !l.includes("[baseline-browser-mapping]")).join("\n")

  test("a successful --json call writes nothing to stderr (PowerShell 2>&1 turns any stderr into exit 1)", () => {
    for (const args of [["gmail", "inbox", "--limit", "5", "--json"], ["gmail", "read", ids[0], "--json"]]) {
      const r = run(...args)
      expect(r.code, args.join(" ")).toBe(0)
      expect(stderrOf(r), `${args.join(" ")} wrote to stderr`).toBe("")
    }
  }, T)
})
