import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// #190220: a command that exits non-zero is routine for an agent (a probe, a retry). The group
// header must not tally failures, and the per-command reason must not be painted in alarm red.
const dir = import.meta.dir
const tsx = readFileSync(join(dir, "message-part.tsx"), "utf8")
const css = readFileSync(join(dir, "message-part.css"), "utf8")

function rule(selector: string) {
  const at = css.indexOf(selector)
  expect(at).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf("}", at))
}

describe("command group shows failures calmly (#190220)", () => {
  test("the header renders no failed count", () => {
    expect(tsx).not.toContain('data-slot="context-tool-group-failed"')
    expect(tsx).not.toContain("ui.messagePart.iris.failed")
  })

  test("the failed command keeps its reason inline", () => {
    expect(tsx).toContain('data-slot="context-tool-group-error"')
  })

  test("neither the rule nor the reason uses the danger colour", () => {
    expect(rule('[data-slot="context-tool-group-item"][data-error]')).not.toContain("danger")
    expect(rule('[data-slot="context-tool-group-error"]')).not.toContain("danger")
  })
})
