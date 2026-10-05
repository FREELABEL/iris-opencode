import { describe, expect, test } from "bun:test"
import { titleProvenance } from "./platform-bug"

// #184937. The old predicate scanned the assembled title for a "--" substring. Measured against
// the real builder, that fires ONLY on the safe shape and never on the dangerous one:
//   --title "…--json…"                  -> one argv element, nothing collapsed  (was REFUSED)
//   report "a" b --json c d             -> --json consumed as a flag, gone from the title (was ALLOWED)
// So every bug titled after the flag that causes it was unfileable, while the corruption the
// guard existed to stop went through looking complete.
describe("titleProvenance", () => {
  test("explicit --title is verbatim, even when the title names a flag", () => {
    const p = titleProvenance(["iris", "bug", "report", "--title", "leads tasks list --json has a null status"])
    expect(p.explicit).toBe("leads tasks list --json has a null status")
    expect(p.collapsed).toBeUndefined()
  })

  test("--title= form is verbatim too", () => {
    expect(titleProvenance(["iris", "bug", "report", "--title=pulse --json prints TUI first"]).explicit).toBe(
      "pulse --json prints TUI first",
    )
  })

  test("collapsed quoting IS detected — a bare word after an option flag", () => {
    const p = titleProvenance(["iris", "bug", "report", "search returns 0", "daycare", "--json", "TX", "78634"])
    expect(p.explicit).toBeUndefined()
    expect(p.collapsed).toEqual({ flag: "--json", strayAfter: "TX" })
  })

  test("a value-taking option does NOT look like a collapse", () => {
    // `-d body` consumes its value; "body" is not a stray title word.
    expect(titleProvenance(["iris", "bug", "report", "a title", "-d", "body text"]).collapsed).toBeUndefined()
    expect(titleProvenance(["iris", "bug", "report", "a title", "--description", "body"]).collapsed).toBeUndefined()
  })

  test("a normal unquoted multi-word title is not a collapse", () => {
    expect(titleProvenance(["iris", "bug", "report", "pulse", "json", "flag", "broken"]).collapsed).toBeUndefined()
  })

  test("explicit --title survives positionals, which yargs alone drops", () => {
    // yargs yields title ["foo","bar"] here and discards "baz" entirely.
    expect(titleProvenance(["iris", "bug", "report", "foo", "bar", "--title", "baz"]).explicit).toBe("baz")
  })

  test("tokens after a bare -- are not scanned", () => {
    expect(titleProvenance(["iris", "bug", "report", "a title", "--", "--json", "stray"]).collapsed).toBeUndefined()
  })

  test("aliases carry the same behaviour", () => {
    expect(titleProvenance(["iris", "bug", "submit", "--title", "x --json y"]).explicit).toBe("x --json y")
    expect(titleProvenance(["iris", "bug", "new", "a", "--json", "b"]).collapsed?.flag).toBe("--json")
  })
})
