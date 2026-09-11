import { cmd } from "./cmd"
import { FL_API, dim, bold, success } from "./iris-api"
import { EOL } from "os"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { resolveRef, buildMarkdown, describeSeal } from "./platform-atlas-use"
import {
  atlasHome,
  readManifest,
  writeManifest,
  pinItem,
  unpinItem,
  contentHash,
  shortHash,
  driftReport,
  parseDuration,
  pinAgeMs,
  humanAge,
  previousHash,
  blobPath,
  appendLog,
  readPolicy,
  writePolicy,
  type Pin,
} from "./platform-atlas-store"

// ============================================================================
// iris atlas pin / pins / status / update / rollback / seal
//
// Epic #184607 — "cognition is a deployed artifact, not a live query."
//
// `atlas use` READS. These commands GRANT. The difference is that a grant is
// written down, addressed by content, ageable, revocable, and refusable — five
// properties a read does not have and cannot be given afterwards.
//
// ADR-02: the machine does not track the cloud. Nothing here touches the network
// unless an operator asks for it (`update`, or `status --check`). Freshness is an
// OPERATION. That is only defensible because pin age is visible and `--max-age`
// can fail a script, which is what keeps "frozen" from quietly meaning "stale".
// ============================================================================

async function fetchPublicItem(uuid: string): Promise<{ item?: any; error?: string }> {
  const url = `${FL_API}/api/v1/bloq/item/${uuid}`
  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } })
  } catch (e: any) {
    return { error: `could not reach ${FL_API}: ${e?.message ?? e}` }
  }
  if (res.status === 404) return { error: "no public item with that reference" }
  if (res.status === 410) return { error: "withdrawn — the link has expired" }
  if (res.status === 401) return { error: "sealed behind a password — open it in a browser to unseal" }
  if (!res.ok) return { error: `request failed (${res.status})` }
  const body: any = await res.json().catch(() => null)
  if (!body?.data) return { error: "unexpected response shape" }
  return { item: body.data }
}

function refOrDie(ref: string): string | null {
  const uuid = resolveRef(ref)
  if (!uuid) {
    process.stderr.write(
      `Not a full reference: ${ref}${EOL}` + dim(`  pass the item's public URL, or its full uuid`) + EOL,
    )
    return null
  }
  return uuid
}

// ── pin ─────────────────────────────────────────────────────────────────────

export const AtlasPinCommand = cmd({
  command: "pin <refs..>",
  aliases: ["grant"],
  describe: "GRANT an item to this machine — pull it onto disk, pinned by content hash",
  builder: (yargs) =>
    yargs
      .positional("refs", { describe: "one or more item URLs or uuids", type: "string", array: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .example("iris atlas pin https://heyiris.io/n/<uuid>", "grant one item")
      .example("iris atlas pin <uuid> <uuid> <uuid>", "grant a set"),

  async handler(args: any) {
    const home = atlasHome()
    const results: any[] = []
    let failed = 0

    for (const ref of args.refs as string[]) {
      const uuid = refOrDie(ref)
      if (!uuid) {
        failed++
        continue
      }
      const { item, error } = await fetchPublicItem(uuid)
      if (!item) {
        process.stderr.write(`  ✗ ${uuid.slice(0, 8)} — ${error}${EOL}`)
        results.push({ uuid, ok: false, error })
        failed++
        continue
      }
      const rendered = buildMarkdown(item, `https://heyiris.io/n/${uuid}`)
      const { pin, sha, previous } = pinItem(home, uuid, item, rendered)
      results.push({ uuid, ok: true, sha256: sha, previous, path: pin.path, title: pin.title })
      if (!args.json) {
        const verb = !previous ? "pinned" : previous === sha ? "unchanged" : "updated"
        process.stderr.write(
          `  ${verb === "unchanged" ? "·" : "✓"} ${bold(pin.title)} ${dim(`@${shortHash(sha)}`)} ${dim(verb)}${EOL}` +
            dim(`    ${pin.path}`) +
            EOL,
        )
      }
    }

    if (args.json) {
      process.stdout.write(JSON.stringify({ home, results }, null, 2) + "\n")
    } else {
      const held = Object.keys(readManifest(home).pins).length
      process.stderr.write(EOL + dim(`  this machine holds ${held} item(s) · ${home}`) + EOL + EOL)
    }
    if (failed) process.exitCode = 1
  },
})

// ── unpin ───────────────────────────────────────────────────────────────────

export const AtlasUnpinCommand = cmd({
  command: "unpin <ref>",
  aliases: ["ungrant"],
  describe: "REVOKE an item from this machine — drop it from the grant and remove it from the tree",
  builder: (yargs) =>
    yargs
      .positional("ref", { describe: "item URL or uuid", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),

  async handler(args: any) {
    const uuid = refOrDie(args.ref)
    if (!uuid) {
      process.exitCode = 1
      return
    }
    const pin = unpinItem(atlasHome(), uuid)
    if (!pin) {
      process.stderr.write(`Not granted to this machine: ${uuid}${EOL}`)
      process.exitCode = 1
      return
    }
    if (args.json) process.stdout.write(JSON.stringify({ revoked: pin }, null, 2) + "\n")
    else
      process.stderr.write(
        `  ✓ revoked ${bold(pin.title)}${EOL}` +
          dim(`    the blob stays in store/ — history is not deleted by a revocation`) +
          EOL,
      )
  },
})

// ── pins ────────────────────────────────────────────────────────────────────

export const AtlasPinsCommand = cmd({
  command: "pins",
  aliases: ["granted", "held"],
  describe: "what this machine was granted — offline, from the manifest",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),

  async handler(args: any) {
    const home = atlasHome()
    const m = readManifest(home)
    const pins = Object.values(m.pins)
    if (args.json) {
      process.stdout.write(JSON.stringify({ home, sealed: readPolicy(home).sealed, pins }, null, 2) + "\n")
      return
    }
    if (!pins.length) {
      process.stdout.write(`Nothing granted to this machine.${EOL}` + dim(`  iris atlas pin <url|uuid>`) + EOL)
      return
    }
    process.stdout.write(EOL + bold(`  ${pins.length} item(s) held · ${home}`) + EOL + EOL)
    for (const p of pins) {
      const where = [p.bloq, p.list].filter(Boolean).join(" / ")
      process.stdout.write(
        `  ${bold(p.title)}${EOL}` +
          dim(`    @${shortHash(p.sha256)} · pinned ${humanAge(pinAgeMs(p))} ago${where ? ` · ${where}` : ""}`) +
          EOL +
          dim(`    ${p.uuid}`) +
          EOL,
      )
    }
    if (readPolicy(home).sealed) process.stdout.write(EOL + dim(`  SEALED — ${describeSeal()}`) + EOL)
    process.stdout.write(EOL)
  },
})

// ── status ──────────────────────────────────────────────────────────────────

export const AtlasStatusCommand = cmd({
  command: "status",
  describe: "declared vs actual, with pin age — offline by default; --check asks the cloud; --max-age fails",
  builder: (yargs) =>
    yargs
      .option("check", {
        describe: "ask the cloud which pins are behind (an explicit operation)",
        type: "boolean",
        default: false,
      })
      .option("max-age", {
        describe: "stale-gate: exit non-zero if any pin is older than this (e.g. 7d, 36h)",
        type: "string",
      })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),

  async handler(args: any) {
    const home = atlasHome()
    const m = readManifest(home)
    const pins = Object.values(m.pins)
    const drift = driftReport(home)
    const sealed = readPolicy(home).sealed

    const maxAge = parseDuration(args["max-age"])
    if (args["max-age"] && maxAge === null) {
      process.stderr.write(`Could not read --max-age "${args["max-age"]}" (try 7d, 36h, 90m).${EOL}`)
      process.exitCode = 2
      return
    }

    const rows = pins.map((p) => {
      const age = pinAgeMs(p)
      return {
        uuid: p.uuid,
        title: p.title,
        sha256: p.sha256,
        revised: p.revised,
        pulled_at: p.pulled_at,
        age_ms: Number.isFinite(age) ? age : null,
        age: humanAge(age),
        stale: maxAge !== null ? age > maxAge : false,
        behind: null as null | boolean,
        cosmetic: null as null | boolean,
      }
    })

    if (args.check) {
      for (const r of rows) {
        const { item, error } = await fetchPublicItem(r.uuid)
        if (!item) {
          // Unreachable is NOT up-to-date. Proof 5 is "the cloud is down and the
          // machine still works" — which requires never reporting an error as a
          // fact about the pin.
          ;(r as any).check_error = error
          continue
        }
        const sha = contentHash(item)
        r.behind = sha !== r.sha256
        // The server's updated_at moved but the content did not: someone re-saved
        // it. Reporting that as "behind" trains operators to ignore the diff.
        r.cosmetic = !r.behind && !!item?.updated_at && item.updated_at !== r.revised
      }
    }

    const stale = rows.filter((r) => r.stale)
    const behind = rows.filter((r) => r.behind)
    const unreachable = rows.filter((r) => (r as any).check_error)

    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            home,
            sealed,
            checked: !!args.check,
            held: pins.length,
            declared_missing: drift.declaredMissing.map((p) => p.path),
            undeclared_files: drift.undeclaredFiles,
            max_age: args["max-age"] ?? null,
            stale: stale.length,
            behind: args.check ? behind.length : null,
            items: rows,
          },
          null,
          2,
        ) + "\n",
      )
    } else {
      process.stdout.write(EOL + bold(`  Atlas · ${home}`) + EOL)
      process.stdout.write(dim(`  ${pins.length} granted · ${sealed ? "SEALED" : "not sealed"}`) + EOL + EOL)
      for (const r of rows) {
        const flags = [
          r.stale ? "STALE" : null,
          r.behind ? "BEHIND" : null,
          r.cosmetic ? "re-saved, same content" : null,
          (r as any).check_error ? `unchecked: ${(r as any).check_error}` : null,
        ].filter(Boolean)
        process.stdout.write(
          `  ${bold(r.title)}${EOL}` +
            dim(`    @${shortHash(r.sha256)} · ${r.age} old${flags.length ? ` · ${flags.join(" · ")}` : ""}`) +
            EOL,
        )
      }
      if (drift.declaredMissing.length)
        process.stdout.write(
          EOL +
            `  ${drift.declaredMissing.length} DECLARED BUT MISSING — granted, not held:` +
            EOL +
            drift.declaredMissing.map((p) => dim(`    ${p.path}`)).join(EOL) +
            EOL,
        )
      if (drift.undeclaredFiles.length)
        process.stdout.write(
          EOL +
            `  ${drift.undeclaredFiles.length} UNDECLARED — held, not granted:` +
            EOL +
            drift.undeclaredFiles.map((f) => dim(`    ${f}`)).join(EOL) +
            EOL,
        )
      if (unreachable.length)
        process.stdout.write(EOL + dim(`  ${unreachable.length} could not be checked — the machine still works`) + EOL)
      process.stdout.write(EOL)
    }

    // The stale-gate. An instrument that can never come back red is decoration,
    // so this is the one path where `status` fails a script on purpose.
    if (stale.length || drift.declaredMissing.length || drift.undeclaredFiles.length) process.exitCode = 1
  },
})

// ── update ──────────────────────────────────────────────────────────────────

export const AtlasUpdateCommand = cmd({
  command: "refresh [refs..]",
  aliases: ["pull-updates"],
  describe: "explicit, staged refresh of pinned items — stages by default, --apply commits",
  builder: (yargs) =>
    yargs
      .positional("refs", { describe: "items to refresh (default: everything granted)", type: "string", array: true })
      .option("apply", {
        describe: "commit the refresh (without this, nothing changes)",
        type: "boolean",
        default: false,
      })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),

  async handler(args: any) {
    const home = atlasHome()
    const m = readManifest(home)
    const targets: Pin[] = (args.refs as string[] | undefined)?.length
      ? ((args.refs as string[]).map((r) => m.pins[resolveRef(r) ?? ""]).filter(Boolean) as Pin[])
      : Object.values(m.pins)

    if (!targets.length) {
      process.stderr.write(`Nothing to refresh — this machine holds no matching grant.${EOL}`)
      process.exitCode = 1
      return
    }

    const plan: any[] = []
    for (const p of targets) {
      const { item, error } = await fetchPublicItem(p.uuid)
      if (!item) {
        plan.push({ uuid: p.uuid, title: p.title, state: "unreachable", error })
        continue
      }
      const sha = contentHash(item)
      if (sha === p.sha256) {
        plan.push({ uuid: p.uuid, title: p.title, state: "current", sha256: sha })
        continue
      }
      plan.push({ uuid: p.uuid, title: p.title, state: "changed", from: p.sha256, to: sha, item })
    }

    const changed = plan.filter((x) => x.state === "changed")

    if (args.apply) {
      for (const c of changed) {
        const rendered = buildMarkdown(c.item, `https://heyiris.io/n/${c.uuid}`)
        pinItem(home, c.uuid, c.item, rendered, { op: "update" })
      }
    }

    const report = plan.map(({ item, ...rest }) => rest)
    if (args.json) {
      process.stdout.write(JSON.stringify({ applied: !!args.apply, plan: report }, null, 2) + "\n")
    } else {
      process.stdout.write(EOL + bold(args.apply ? "  Refreshed" : "  Staged — nothing has changed yet") + EOL + EOL)
      for (const r of report) {
        const detail =
          r.state === "changed"
            ? dim(`@${shortHash(r.from)} → @${shortHash(r.to)}`)
            : r.state === "unreachable"
              ? dim(r.error)
              : dim("current")
        process.stdout.write(`  ${r.state === "changed" ? "→" : "·"} ${bold(r.title)} ${detail}${EOL}`)
      }
      process.stdout.write(
        EOL +
          (changed.length
            ? args.apply
              ? success(`  ${changed.length} updated · roll back with: iris atlas rollback <uuid>`) + EOL
              : dim(`  ${changed.length} would change · re-run with --apply to commit`) + EOL
            : dim("  everything is current") + EOL) +
          EOL,
      )
    }
  },
})

// ── rollback ────────────────────────────────────────────────────────────────

export const AtlasRollbackCommand = cmd({
  command: "rollback <ref>",
  describe: "move a pin back to the version it held before — a pointer move, no network",
  builder: (yargs) =>
    yargs
      .positional("ref", { describe: "item URL or uuid", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),

  async handler(args: any) {
    const home = atlasHome()
    const uuid = refOrDie(args.ref)
    if (!uuid) {
      process.exitCode = 1
      return
    }
    const m = readManifest(home)
    const pin = m.pins[uuid]
    if (!pin) {
      process.stderr.write(`Not granted to this machine: ${uuid}${EOL}`)
      process.exitCode = 1
      return
    }
    const prev = previousHash(home, uuid)
    if (!prev) {
      process.stderr.write(`No earlier version recorded for ${bold(pin.title)} — nothing to roll back to.${EOL}`)
      process.exitCode = 1
      return
    }
    const blob = blobPath(home, prev)
    if (!existsSync(blob)) {
      // The log says it existed; the store says it does not. Say which, rather
      // than reporting "no earlier version" and hiding a damaged store.
      process.stderr.write(
        `The log records ${shortHash(prev)} but store/${prev}.md is missing — the store is damaged.${EOL}`,
      )
      process.exitCode = 2
      return
    }
    const content = readFileSync(blob, "utf8")
    const abs = join(home, pin.path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, "utf8")
    const from = pin.sha256
    m.pins[uuid] = { ...pin, sha256: prev, pulled_at: new Date().toISOString() }
    writeManifest(home, m)
    appendLog(home, { at: new Date().toISOString(), op: "rollback", uuid, from, to: prev, title: pin.title })

    if (args.json) process.stdout.write(JSON.stringify({ uuid, from, to: prev }, null, 2) + "\n")
    else
      process.stderr.write(
        `  ✓ ${bold(pin.title)} rolled back ${dim(`@${shortHash(from)} → @${shortHash(prev)}`)}${EOL}`,
      )
  },
})

// ── seal ────────────────────────────────────────────────────────────────────

export const AtlasSealCommand = cmd({
  command: "seal",
  describe: "deny-by-default: this machine may only read what it was granted (CLI-level)",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const home = atlasHome()
    writePolicy(home, { sealed: true, sealed_at: new Date().toISOString() })
    const held = Object.keys(readManifest(home).pins).length
    if (args.json) process.stdout.write(JSON.stringify({ sealed: true, held, scope: describeSeal() }, null, 2) + "\n")
    else
      process.stderr.write(
        `  ✓ sealed · ${held} item(s) readable${EOL}` +
          dim(`    ${describeSeal()}`) +
          EOL +
          dim(`    runtime and network enforcement are NOT in place — see #184612`) +
          EOL,
      )
  },
})

export const AtlasUnsealCommand = cmd({
  command: "unseal",
  describe: "lift the seal — an operator decision, recorded",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const home = atlasHome()
    writePolicy(home, { sealed: false })
    if (args.json) process.stdout.write(JSON.stringify({ sealed: false }, null, 2) + "\n")
    else process.stderr.write(`  ✓ unsealed — this machine may read any published item again${EOL}`)
  },
})
