import { describe, expect, test } from "bun:test"
import { playbookDependencies } from "./playbook-deps"

const fm = (body: string, rest = "") => `---\nname: parent\nversion: 2\n${body}\n---\n\n# Parent\n${rest}`

describe("playbookDependencies", () => {
  test("reads an inline requires list", () => {
    expect(playbookDependencies(fm("requires: [genesis-motion, competitive-marketing]"))).toEqual(["genesis-motion", "competitive-marketing"])
  })

  test("reads a comma string and a YAML block list", () => {
    expect(playbookDependencies(fm("requires: genesis-motion, x-ads"))).toEqual(["genesis-motion", "x-ads"])
    expect(playbookDependencies(fm("requires:\n  - genesis-motion\n  - \"x-ads\""))).toEqual(["genesis-motion", "x-ads"])
  })

  test("adds every mode: playbook child, once", () => {
    const steps = [
      "### step:a A", "```yaml", "mode: playbook", "playbook: capture-sops", "```",
      "### step:b B", "```yaml", "mode: shell", "```", "```bash", "echo playbook: not-a-child", "```",
      "### step:c C", "```yaml", "mode: playbook", "playbook: \"capture-sops\"", "args: x", "```",
    ].join("\n")
    expect(playbookDependencies(fm("requires: genesis-motion", steps))).toEqual(["genesis-motion", "capture-sops"])
  })

  test("never lists itself, blanks or junk", () => {
    expect(playbookDependencies(fm("requires: [parent, '', 'bad name!', ok-one]"), "parent")).toEqual(["ok-one"])
  })

  test("no frontmatter and no children means no dependencies", () => {
    expect(playbookDependencies("# just a doc\n\n```yaml\nmode: shell\n```")).toEqual([])
  })
})
