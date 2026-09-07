#!/usr/bin/env node
/**
 * Playbook corpus linter — the defect classes that VALIDATE clean and then misbehave.
 *
 * `iris playbook test` answers "does this parse and satisfy the schema". Every bug below
 * passed that and shipped anyway, because none of them are schema questions:
 *
 *   AI_WRITES_FILE   a `mode: ai` step told to write a file. An AI step returns text; it
 *                    cannot touch the filesystem. The instruction is simply impossible.
 *   READ_UNWRITTEN   a shell step reads a path no step in the playbook writes. It reads
 *                    whatever a PREVIOUS RUN left there. work-the-epic filed five epics on
 *                    2026-09-04 carrying stale drafts, every run reporting success — a
 *                    clean /tmp gives an honest error, a dirty one gives a confident lie.
 *   TENANT_DEFAULT   an id-shaped default (bloq/list/agent/user/...) on a playbook other
 *                    people install. work-the-epic defaulted to bloq 297 — the authors'
 *                    own bug board — so every stranger's run tried to file into it.
 *   AI_NO_PROMPT     a `mode: ai` step that sends nothing under the body||code rule.
 *
 * No network, no auth, no fixtures — same constraint as check-routes. A hook that needs any
 * of those gets disabled, and then the decay resumes.
 *
 * Usage:  check-playbooks.mjs [dir ...] [--tenancy=error|warn]
 * Default dir: scaffold/playbooks (the set compiled into the binary — installed by everyone,
 * so a tenant default there is always an error).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)
const tenancy = (args.find((a) => a.startsWith("--tenancy=")) || "--tenancy=error").split("=")[1]
const dirs = args.filter((a) => !a.startsWith("--"))

// Resolve the default target from THIS FILE, not from cwd.
//
// It was `"scaffold/playbooks"` — a cwd-relative path — and the npm target runs from
// packages/opencode while the corpus lives at the repo root. So `bun run playbooks:check`
// printed "clean" and exited 0 having scanned ZERO playbooks. A gate that cannot see its
// own corpus reports the same success as a gate that checked it and found nothing wrong,
// which is the exact defect class this linter exists to catch. Caught on the first run
// after wiring, by reading the output instead of the exit code.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
if (!dirs.length) dirs.push(join(REPO_ROOT, "scaffold/playbooks"))

const RULES = {
  AI_WRITES_FILE: "a `mode: ai` step is told to write a file — an AI step returns text and cannot write one",
  READ_UNWRITTEN: "a shell step reads a path no step here writes — it will read whatever a previous run left",
  TENANT_DEFAULT: "an id-shaped default on an installable playbook — a default here is a default for every tenant",
  AI_NO_PROMPT: "a `mode: ai` step whose prompt is empty under the body||code rule — it would send nothing",
}

function parseSteps(md) {
  const out = []
  const m = [...md.matchAll(/^### step:([\w-]+) +(.+)$/gm)]
  for (let i = 0; i < m.length; i++) {
    const start = m[i].index + m[i][0].length
    const end = i + 1 < m.length ? m[i + 1].index : md.length
    const section = md.slice(start, end)
    const yaml = section.match(/```yaml\n([\s\S]*?)```/)
    const mode = (yaml?.[1].match(/^mode:\s*(\S+)/m) || [])[1] || "manual"
    const fences = [...section.matchAll(/```(\w*)\n([\s\S]*?)```/g)].filter((f) => f[1] !== "yaml")
    out.push({
      id: m[i][1],
      mode,
      body: section.replace(/```[\s\S]*?```/g, "").trim(),
      code: fences.map((f) => f[2]).join("\n"),
      section,
    })
  }
  return out
}

const findings = []
let scanned = 0

for (const dir of dirs) {
  // A missing target is a BROKEN GATE, not a clean one. The caller decides whether a
  // directory is worth checking (the pre-push hook guards the optional workspace set with
  // `[ -d ]`); once it has asked for one, "not present" must never read as "nothing wrong".
  if (!existsSync(dir)) {
    console.error(`check-playbooks: cannot read ${dir} — refusing to report a corpus it never saw.`)
    process.exit(2)
  }
  for (const name of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const file = join(dir, name, "PLAYBOOK.md")
    if (!existsSync(file)) continue
    scanned++
    const md = readFileSync(file, "utf8")
    const steps = parseSteps(md)
    const add = (rule, detail) => findings.push({ dir, name, rule, detail })

    // Tenant-shaped arg defaults, read from the frontmatter block.
    const front = md.split(/^---$/m)[1] || ""
    for (const a of front.matchAll(/^ {2}([a-z_]+):\s*$([\s\S]*?)(?=^ {2}[a-z_]+:\s*$|\Z)/gm)) {
      const [, arg, blk] = a
      const def = (blk.match(/^ {4}default:\s*(\S+)\s*$/m) || [])[1]
      if (def && /^\d{2,}$/.test(def) && /(bloq|list|agent|user|project|board|item)/i.test(arg))
        add("TENANT_DEFAULT", `arg "${arg}" defaults to ${def}`)
    }

    // Which /tmp paths does this playbook actually write?
    const writes = new Set()
    for (const s of steps)
      for (const w of s.section.matchAll(/(?:>|>>|tee(?:\s+-a)?|cat\s*>)\s*(\/tmp\/[\w.\-/]+)/g)) writes.add(w[1])

    const seen = new Set()
    for (const s of steps) {
      if (s.mode === "ai" || s.mode === "prompt") {
        if (!(s.body.trim() ? s.body : s.code).trim()) add("AI_NO_PROMPT", `step "${s.id}" would send nothing`)
        const w = s.section.match(/[Ww]rite (?:it|them|the \w+) to (\/tmp\/[\w.\-/]+)/)
        if (w) add("AI_WRITES_FILE", `step "${s.id}" is told to write ${w[1]}`)
      }
      if (s.mode === "shell")
        for (const r of s.section.matchAll(/(?:\[ -s |cat )(\/tmp\/[\w.\-/]+)/g)) {
          const key = `${s.id}:${r[1]}`
          if (!writes.has(r[1]) && !seen.has(key)) {
            seen.add(key)
            add("READ_UNWRITTEN", `step "${s.id}" reads ${r[1]}`)
          }
        }
    }
  }
}

for (const f of findings) f.warn = f.rule === "TENANT_DEFAULT" && tenancy === "warn"
const errors = findings.filter((f) => !f.warn)

console.log(`check-playbooks — ${scanned} playbook(s) in ${dirs.join(", ")}`)
if (scanned === 0) {
  console.error("check-playbooks: scanned 0 playbooks — the gate measured nothing. Treating as failure.")
  process.exit(2)
}
if (!findings.length) console.log("  clean")
const byRule = {}
for (const f of findings) (byRule[f.rule] ||= []).push(f)
for (const [rule, list] of Object.entries(byRule)) {
  console.log(`\n${rule}  (${list.length})`)
  console.log(`  ${RULES[rule]}`)
  for (const f of list)
    console.log(`    ${f.warn ? "warn " : "ERROR"}  ${f.name.padEnd(24)} ${f.detail}`)
}
if (findings.length) console.log(`\n${errors.length} error(s), ${findings.length - errors.length} warning(s)`)
process.exit(errors.length ? 1 : 0)
