import { describe, expect, test } from "bun:test"
import { splitPlaybookArgv } from "./executor"

/**
 * #181577 — `iris playbook run freelabel-ads topic="AI agents..." brand=freelabel` resolved to
 * { topic: "topic=AI agents...", brand: "brand=freelabel" }. Only `--key=value` bound; a bare
 * key=value fell through to the positionals and resolveArgs handed the whole string, prefix
 * included, to the first declared arg.
 *
 * Nothing reported it: the steps ran, the AI steps shrugged off a stray "topic=" prefix, and it
 * only surfaced where a value needed an EXACT match — a brand slug — several steps from the
 * cause, after two AI steps had already spent tokens on a wrong prompt.
 */
describe("splitPlaybookArgv", () => {
  const declared = { topic: {}, brand: {} }

  test("binds a bare key=value when the key is declared — the reported case", () => {
    const { flagArgs, positional } = splitPlaybookArgv(
      ['topic=AI agents that actually ship', 'brand=freelabel'],
      declared,
    )

    expect(flagArgs).toEqual({ topic: "AI agents that actually ship", brand: "freelabel" })
    expect(positional).toEqual([])
  })

  test("leaves a positional that merely CONTAINS = alone", () => {
    // The guard that makes this safe: bind on the declared NAME, not on the presence of "=".
    // Without it, any value with an equals sign would be silently torn in half.
    const { flagArgs, positional } = splitPlaybookArgv(['a=b', 'https://x.test/?q=1'], declared)

    expect(flagArgs).toEqual({})
    expect(positional).toEqual(['a=b', 'https://x.test/?q=1'])
  })

  test("still handles --key=value and bare --flag", () => {
    const { flagArgs, positional } = splitPlaybookArgv(['--topic=x', '--dry'], declared)

    expect(flagArgs).toEqual({ topic: "x", dry: true })
    expect(positional).toEqual([])
  })

  test("keeps everything after the FIRST = so a value may contain one", () => {
    const { flagArgs } = splitPlaybookArgv(['topic=a=b'], declared)

    expect(flagArgs).toEqual({ topic: "a=b" })
  })
})
