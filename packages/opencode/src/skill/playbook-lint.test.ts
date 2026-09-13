import { describe, expect, test } from "bun:test"
import { lintPlaybook, blockingFindings } from "./playbook-lint"

/** The three defects that reached the public marketplace on 2026-09-04, as fixtures. */
const TENANT_DEFAULT_PB = `---
name: work-the-epic
version: 2
args:
  goal:
    type: string
    required: true
    description: the goal
  bloq:
    type: number
    required: false
    default: 297
    description: Bloq to file the epic in. 297 = IRIS CLI Bug Reports.
---

### step:noop Does nothing

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo hi
\`\`\`
`

const PHANTOM_FILE_PB = `---
name: phantom
version: 2
---

### step:draft Draft it

\`\`\`yaml
mode: ai
\`\`\`

Write an epic. No preamble. Write it to /tmp/epic-draft.md.

### step:publish Publish it

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
[ -s /tmp/epic-draft.md ] || exit 1
cat /tmp/epic-draft.md
\`\`\`
`

const CLEAN_PB = `---
name: clean
version: 2
args:
  limit:
    type: number
    required: false
    default: 50
    description: how many
---

### step:draft Draft it

\`\`\`yaml
mode: ai
\`\`\`

Write the thing and return it as your answer.

### step:use Use it

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
cat > /tmp/out.md <<'EOF'
hi
EOF
cat /tmp/out.md
\`\`\`
`

describe("lintPlaybook — defects that survive schema validation", () => {
  test("flags an id-shaped default (work-the-epic shipped bloq 297 publicly)", () => {
    const rules = lintPlaybook(TENANT_DEFAULT_PB).map((f) => f.rule)
    expect(rules).toContain("TENANT_DEFAULT")
  })

  test("flags a mode:ai step told to write a file, and the phantom read that follows", () => {
    const rules = lintPlaybook(PHANTOM_FILE_PB).map((f) => f.rule)
    expect(rules).toContain("AI_WRITES_FILE")
    expect(rules).toContain("READ_UNWRITTEN")
  })

  test("a shell step that WRITES the file it reads is not flagged", () => {
    expect(lintPlaybook(CLEAN_PB).map((f) => f.rule)).not.toContain("READ_UNWRITTEN")
  })

  test("a non-id numeric default (limit: 50) is not a tenant default", () => {
    expect(lintPlaybook(CLEAN_PB).map((f) => f.rule)).not.toContain("TENANT_DEFAULT")
  })

  test("a clean playbook yields nothing — the linter can say yes as well as no", () => {
    expect(lintPlaybook(CLEAN_PB)).toEqual([])
  })
})

describe("blockingFindings — scope decides only the tenancy rule", () => {
  const tenant = lintPlaybook(TENANT_DEFAULT_PB)
  const phantom = lintPlaybook(PHANTOM_FILE_PB)

  test("a tenant default blocks every scope others can install from", () => {
    for (const scope of ["public", "unlisted", "project"])
      expect(blockingFindings(tenant, scope).length, scope).toBeGreaterThan(0)
  })

  test("a tenant default does NOT block a private publish — that playbook is yours alone", () => {
    expect(blockingFindings(tenant, "private")).toEqual([])
  })

  test("a dataflow defect blocks at EVERY scope — a stale draft is stale whoever reads it", () => {
    for (const scope of ["public", "unlisted", "project", "private"])
      expect(blockingFindings(phantom, scope).length, scope).toBeGreaterThan(0)
  })
})
