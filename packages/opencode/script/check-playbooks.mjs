#!/usr/bin/env bun
/**
 * CLI wrapper around the playbook linter. THE RULES ARE NOT HERE.
 *
 * They live in src/skill/playbook-lint.ts, imported below, because the publish command needs
 * them at runtime and `bun build --compile` bundles static imports rather than files read
 * from disk — a rules copy in script/ would simply be absent from the installed binary.
 *
 * This file had its own copy for exactly one commit. That copy contained `\Z`, which
 * JavaScript does not support (it matches a literal "Z"), so it silently skipped the last
 * declared arg of every playbook it scanned and reported the corpus clean. One set of rules,
 * one place — the same reason `aiPromptFrom` exists.
 *
 * Usage:  check-playbooks.mjs [dir ...] [--tenancy=error|warn]
 * Default: <repo>/scaffold/playbooks — the set compiled into the binary, installed by
 * everyone, so a tenant default there is always an error.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { lintPlaybook, blockingFindings, PLAYBOOK_RULES } from "../src/skill/playbook-lint.ts"

const args = process.argv.slice(2)
const tenancy = (args.find((a) => a.startsWith("--tenancy=")) || "--tenancy=error").split("=")[1]
const dirs = args.filter((a) => !a.startsWith("--"))

// Resolve the default target from THIS FILE, not from cwd. It was cwd-relative, and the npm
// target runs from packages/opencode while the corpus sits at the repo root — so the check
// printed "clean" and exited 0 having scanned ZERO playbooks. A gate that cannot see its own
// corpus must not report the same success as one that checked it.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
if (!dirs.length) dirs.push(join(REPO_ROOT, "scaffold/playbooks"))

const findings = []
let scanned = 0

for (const dir of dirs) {
  // A missing target is a BROKEN GATE, not a clean one. The caller decides whether a
  // directory is worth checking; once it has asked, "not present" must never read as "fine".
  if (!existsSync(dir)) {
    console.error(`check-playbooks: cannot read ${dir} — refusing to report a corpus it never saw.`)
    process.exit(2)
  }
  for (const name of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const file = join(dir, name, "PLAYBOOK.md")
    if (!existsSync(file)) continue
    scanned++
    for (const f of lintPlaybook(readFileSync(file, "utf8"))) findings.push({ ...f, name })
  }
}

// `--tenancy=warn` mirrors blockingFindings(..., "private"): a playbook only you can install
// may hardcode your own ids. Everything else is a defect at any scope.
const errors = tenancy === "warn" ? findings.filter((f) => blockingFindings([f], "private").length) : findings
for (const f of findings) f.warn = !errors.includes(f)

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
  console.log(`  ${PLAYBOOK_RULES[rule]}`)
  for (const f of list) console.log(`    ${f.warn ? "warn " : "ERROR"}  ${f.name.padEnd(24)} ${f.detail}`)
}
if (findings.length) console.log(`\n${errors.length} error(s), ${findings.length - errors.length} warning(s)`)
process.exit(errors.length ? 1 : 0)
