import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Guard for #193865: `iris cloud:upload` sent `process.env.IRIS_USER_ID ?? "193"` as the
 * account. `iris login` saves the id to ~/.iris/sdk/.env, not the shell environment, so on
 * a client's machine the env var was unset and every upload claimed account 193. fl-api
 * refused it ("You may only act on your own account"); before that check existed, the file
 * would have been filed under someone else's account.
 *
 * Bans: an IRIS_USER_ID read that falls back to a fixed number. Use resolveUserId() /
 * requireUserId() from cli/cmd/iris-api, which read the env, then the login file, then ask
 * the API who is signed in.
 */

const SRC = join(import.meta.dir, "..", "src")

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p)
  }
  return out
}

const FIXED = /IRIS_USER_ID\s*(\?\?|\|\|)\s*["'`]?\d+/

describe("no command falls back to a fixed account (#193865)", () => {
  test("no IRIS_USER_ID read defaults to a hardcoded user id", () => {
    const hits = walk(SRC).flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ f: f.slice(SRC.length + 1), n: i + 1, line }))
        .filter((x) => FIXED.test(x.line)),
    )
    expect(hits.map((h) => `${h.f}:${h.n}: ${h.line.trim()}`)).toEqual([])
  })
})
