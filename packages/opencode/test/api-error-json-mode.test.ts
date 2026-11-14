import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { handleApiError, isJsonMode } from "../src/cli/cmd/iris-api"

/**
 * --json must answer on STDOUT even when the call fails (#180540).
 *
 * The reported symptom was `iris bounty create --json` printing an application-form schema
 * instead of the error. That specific case was already guarded before the payload is composed,
 * and the reporter's binary was simply older than the guard — but the sentence underneath it is
 * the real defect and is still live:
 *
 *   "Which is a perfect error message — it is just unreachable under --json,
 *    the mode a script would use."
 *
 * Every failure branch in handleApiError printed clack prose to STDERR and wrote NOTHING to
 * stdout. So a `--json` consumer got an empty stream on 401, 402, 403, 404, 422 and 500 alike —
 * byte-identical to a successful call that returned nothing. That is the failure this codebase
 * keeps rediscovering: a signal that cannot distinguish "it broke" from "there was none", which
 * is exactly how the reporter concluded a bounty had been created and went looking for it.
 *
 * These assert the CONTRACT, not the prose: on failure, stdout carries one parseable object with
 * success:false and a non-empty error, and the process exits non-zero.
 *
 * The suite captures process.stdout.write rather than mocking the clack module, following
 * api-error-402.test.ts — bun's mock.module is process-global and mocking clack there broke four
 * unrelated suites.
 */

let written: string[] = []
let restoreWrite: (() => void) | null = null
let savedArgv: string[] = []
let savedExit: number | string | undefined

function captureStdout() {
  written = []
  const original = process.stdout.write.bind(process.stdout)
  // Narrowing the overloaded write() signature for the duration of a test.
  process.stdout.write = ((chunk: any, cb?: any) => {
    written.push(typeof chunk === "string" ? chunk : String(chunk))
    if (typeof cb === "function") cb()
    return true
  }) as typeof process.stdout.write
  restoreWrite = () => {
    process.stdout.write = original
  }
}

/** The one object a script is supposed to be able to parse off stdout. */
function parsed(): any {
  const raw = written.join("")
  expect(raw.trim().length).toBeGreaterThan(0) // the whole bug: this used to be empty
  return JSON.parse(raw)
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

beforeEach(() => {
  savedArgv = process.argv
  savedExit = process.exitCode
  captureStdout()
})

afterEach(() => {
  restoreWrite?.()
  restoreWrite = null
  process.argv = savedArgv
  process.exitCode = savedExit
})

/** Put the process into --json mode the same way a real invocation does. */
function asJsonRun() {
  process.argv = ["bun", "iris", "bounty", "create", "--json"]
}

describe("isJsonMode", () => {
  test("detects the forms yargs actually accepts", () => {
    process.argv = ["bun", "iris", "x", "--json"]
    expect(isJsonMode()).toBe(true)

    process.argv = ["bun", "iris", "x", "--json=true"]
    expect(isJsonMode()).toBe(true)
  })

  test("is false for a plain human run", () => {
    process.argv = ["bun", "iris", "bounty", "list"]
    expect(isJsonMode()).toBe(false)
  })

  test("does not fire on a flag that merely contains the word", () => {
    // --json-schema / --jsonl are different flags; matching them would send JSON to a human.
    process.argv = ["bun", "iris", "x", "--jsonl", "--json-schema"]
    expect(isJsonMode()).toBe(false)
  })
})

describe("handleApiError under --json", () => {
  test("404 — the reporter's case: stdout carries the error, not silence", async () => {
    asJsonRun()

    const ok = await handleApiError(json({ message: "No query results for model [App\\Models\\X]" }, 404), "Create bounty")

    expect(ok).toBe(false)
    const out = parsed()
    expect(out.success).toBe(false)
    expect(out.error).toBe("Resource not found") // still sanitised — #57646 stays fixed
    expect(out.status).toBe(404)
    expect(process.exitCode).toBe(1)
  })

  test("422 — keeps the field errors STRUCTURED so a script need not parse prose", async () => {
    asJsonRun()

    await handleApiError(
      json({ message: "The given data was invalid.", errors: { description: ["The description field is required."] } }, 422),
      "Create bounty",
    )

    const out = parsed()
    expect(out.success).toBe(false)
    expect(out.errors.description).toEqual(["The description field is required."])
  })

  test("401 — carries the remedy as a field rather than a sentence", async () => {
    asJsonRun()

    await handleApiError(new Response("", { status: 401 }), "Create bounty")

    const out = parsed()
    expect(out.success).toBe(false)
    expect(out.status).toBe(401)
    expect(out.fix).toBe("iris auth login --force")
    expect(process.exitCode).toBe(1)
  })

  test("402 — forwards the whole remediation payload, which is the actionable part", async () => {
    asJsonRun()

    await handleApiError(
      json({ error: "subscription_required", message: "Subscribe to continue.", checkout_url: "https://x/pay", cli_command: "iris billing" }, 402),
      "Run agent",
    )

    const out = parsed()
    expect(out.error).toBe("Subscribe to continue.")
    expect(out.payment_required.checkout_url).toBe("https://x/pay")
    expect(out.payment_required.cli_command).toBe("iris billing")
  })

  test("403 — also answers, rather than exiting quietly", async () => {
    asJsonRun()

    await handleApiError(json({ error: "You do not own this bounty" }, 403), "Create bounty")

    const out = parsed()
    expect(out.error).toBe("You do not own this bounty")
    expect(out.status).toBe(403)
  })

  test("a non-JSON error body still produces parseable JSON", async () => {
    asJsonRun()

    // A proxy 502 HTML page — the case where res.json() throws.
    await handleApiError(new Response("<html>502 Bad Gateway</html>", { status: 502 }), "Create bounty")

    const out = parsed()
    expect(out.success).toBe(false)
    expect(typeof out.error).toBe("string")
    expect(out.error.length).toBeGreaterThan(0)
    expect(out.status).toBe(502)
  })

  test("every failure emits exactly ONE object — never two, never a fragment", async () => {
    // A consumer doing JSON.parse(stdout) breaks on concatenated objects just as surely as on
    // an empty string, so the count matters as much as the presence.
    asJsonRun()

    await handleApiError(json({ message: "nope" }, 500), "Create bounty")

    const raw = written.join("")
    expect(raw.trimEnd().split("\n").length).toBe(1)
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  test("success is untouched — no error object on a 2xx", async () => {
    asJsonRun()

    expect(await handleApiError(new Response("{}", { status: 200 }), "Create bounty")).toBe(true)
    expect(written.join("")).toBe("")
  })
})

describe("handleApiError without --json", () => {
  test("the human path writes no JSON to stdout", async () => {
    process.argv = ["bun", "iris", "bounty", "create"]

    const ok = await handleApiError(json({ message: "nope" }, 500), "Create bounty")

    expect(ok).toBe(false)
    // clack + the console.error backstop go to stderr; stdout stays clean for humans.
    expect(written.join("")).not.toContain('"success"')
    expect(process.exitCode).toBe(1)
  })
})
