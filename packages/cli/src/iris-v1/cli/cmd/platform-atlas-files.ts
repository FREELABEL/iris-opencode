/**
 * `iris atlas files` — list, upload, download and remove bloq attachments (#182009).
 *
 * There was no CLI verb for attachments at all, so every attempt was a hand-rolled request
 * against an endpoint nobody could check, answered by an error body that says nothing
 * (#182023). Those two conditions together are sufficient to manufacture a false "done" — and
 * on 2026-08-23 they manufactured two, in opposite directions:
 *
 *   - a session recorded "mapping files now attached to this board" after a 404 with an empty
 *     body, and
 *   - a later session (mine) declared the files were NOT attached, from an export that
 *     reported 0 downloaded / 0 failed. They were attached. All 16 of them.
 *
 * THE RULE THIS COMMAND IS BUILT AROUND, learned from both:
 *
 *     An upload is verified by READ-BACK, never by a status code.
 *
 * So `upload` does not trust its own 2xx. It computes sha256 locally, uploads, fetches the
 * stored bytes back from the URL the server returned, and compares. A mismatch is a hard
 * failure. That is the only check that can tell "stored" from "reported stored".
 */

import { cmd } from "./cmd"
import { irisFetch, requireAuth, requireUserId, dim, bold, success, writeJson } from "./iris-api"
import { createHash } from "crypto"
import { readFile, writeFile, mkdir } from "fs/promises"
import { basename, join } from "path"
import { existsSync, statSync } from "fs"

export interface AtlasFile {
  id: number
  name: string
  size: number | null
  type: string | null
  url: string | null
  title?: string | null
  created_at?: string | null
}

/**
 * Normalise the two shapes this API returns for a file list.
 *
 * `/user/{id}/bloqs/files?bloq_id=N` returns `data: { items, pagination, filters }`, while
 * `/bloqs/{id}/files` returns `data: [...]`. Reading one as the other is not hypothetical:
 * platform-bloq-export.ts does `filesData?.data ?? []`, gets the OBJECT, finds `.length`
 * undefined, and silently exports zero attachments from a bloq that has sixteen — then
 * reports `attachments_downloaded: 0, attachments_failed: 0`, which is indistinguishable
 * from a bloq with no attachments. Exported so the normalisation is tested, not repeated.
 */
export function normalizeFileList(payload: any): AtlasFile[] {
  const d = payload?.data
  const raw: any[] = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(payload) ? payload : []
  return raw.map((f) => ({
    id: Number(f?.id),
    name: String(f?.original_filename ?? f?.filename ?? f?.name ?? `file-${f?.id}`),
    size: typeof f?.size === "number" ? f.size : typeof f?.file_size === "number" ? f.file_size : null,
    type: f?.filetype ?? f?.type ?? null,
    url: f?.url ?? f?.cdn_url ?? f?.public_url ?? null,
    title: f?.title ?? null,
    created_at: f?.created_at ?? null,
  }))
}

function sha256(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex")
}

async function listFiles(userId: number, bloqId: number): Promise<{ ok: true; files: AtlasFile[] } | { ok: false; error: string }> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/files?bloq_id=${bloqId}`)
  if (!res.ok) {
    // Say WHICH failure this was. An empty body on a 404 (#182023) is otherwise
    // indistinguishable from an empty result, which is how both false "done"s happened.
    const body = (await res.text()).trim()
    return { ok: false, error: `listing failed: HTTP ${res.status}${body && body !== '{ "message": "" }' ? ` — ${body.slice(0, 200)}` : " with an empty body"}` }
  }
  return { ok: true, files: normalizeFileList(await res.json()) }
}

const ListCommand = cmd({
  command: "list <bloq-id>",
  describe: "list files attached to a bloq",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const bloqId = Number(argv["bloq-id"])

    const r = await listFiles(userId, bloqId)
    if (!r.ok) {
      if (argv.json) await writeJson({ ok: false, error: r.error })
      else console.error(`\n  ${bold("COULD NOT LIST")}  ${r.error}\n`)
      process.exit(1)
    }

    if (argv.json) {
      await writeJson({ ok: true, bloq_id: bloqId, count: r.files.length, files: r.files })
      return
    }

    console.log()
    if (r.files.length === 0) {
      // Distinct wording from a failure, on purpose. "No files" is a RESULT here, because
      // the listing itself succeeded — the branch above proves it.
      console.log(`  ${dim("No files attached to bloq " + bloqId + " (the listing succeeded — this is a real empty, not a failed call)")}`)
    } else {
      for (const f of r.files) {
        console.log(`  ${bold("#" + f.id)}  ${f.name}  ${dim(`${f.size ?? "?"} bytes  ${f.type ?? ""}`)}`)
        if (f.title && f.title !== f.name) console.log(`       ${dim(f.title)}`)
      }
      console.log()
      console.log(`  ${r.files.length} file(s)`)
    }
    console.log()
  },
})

const UploadCommand = cmd({
  command: "upload <bloq-id> <path..>",
  describe: "attach file(s) to a bloq — verified by reading the stored bytes back",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("path", { describe: "local file(s)", type: "string", demandOption: true })
      .option("item", { describe: "attach to this bloq ITEM rather than the board", type: "number" })
      .option("title", { describe: "title (single file only)", type: "string" })
      .option("no-verify", { describe: "skip the read-back check (not recommended)", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const bloqId = Number(argv["bloq-id"])
    const paths = ([] as string[]).concat(argv.path as any)

    const results: any[] = []
    for (const p of paths) {
      if (!existsSync(p)) {
        results.push({ ok: false, path: p, error: "no such local file" })
        continue
      }
      const buf = await readFile(p)
      const localSha = sha256(buf)
      const name = basename(p)

      const form = new FormData()
      form.append("file", new Blob([new Uint8Array(buf)]), name)
      form.append("user_id", String(userId))
      form.append("bloq_id", String(bloqId))
      if (argv.item) form.append("bloq_item_id", String(argv.item))
      if (argv.title && paths.length === 1) form.append("title", String(argv.title))

      const res = await irisFetch(`/api/v1/bloqs/files/upload`, { method: "POST", body: form })
      const text = await res.text()
      let json: any = null
      try {
        json = JSON.parse(text)
      } catch {
        /* keep raw */
      }

      if (!res.ok) {
        // Surface the server's own reason where it gives one — the allow-list rejection
        // names the supported types, which is genuinely useful (#182024).
        const msg = json?.message || text.trim() || "(empty body)"
        const types = Array.isArray(json?.supported_types) ? Object.keys(json.supported_types) : json?.supported_types ? Object.keys(json.supported_types) : null
        results.push({
          ok: false, path: p, sha256: localSha,
          error: `HTTP ${res.status}: ${msg === "" ? "(the server returned an EMPTY message — see #182023)" : msg}`,
          ...(types ? { supported_types: types } : {}),
        })
        continue
      }

      const file = json?.data ?? json?.file ?? json
      const id = Number(file?.id)
      const url = file?.url ?? file?.cdn_url ?? file?.public_url ?? null

      // READ-BACK. A 2xx is a claim; the stored bytes are the fact. This is the check that
      // both of 2026-08-23's false "done"s would have caught.
      let verified: boolean | null = null
      let remoteSha: string | null = null
      if (!argv["no-verify"] && url) {
        try {
          const dl = await fetch(String(url))
          if (dl.ok) {
            remoteSha = sha256(Buffer.from(await dl.arrayBuffer()))
            verified = remoteSha === localSha
          }
        } catch {
          verified = null
        }
      }

      results.push({
        ok: argv["no-verify"] ? true : verified === true,
        path: p, id, url, bytes: buf.length, sha256: localSha, remote_sha256: remoteSha, verified,
        ...(verified === false ? { error: `STORED BYTES DIFFER — local ${localSha.slice(0, 12)}… vs stored ${remoteSha?.slice(0, 12)}…` } : {}),
        ...(verified === null && !argv["no-verify"] ? { error: "uploaded, but the stored bytes could NOT be read back — treat as UNVERIFIED" } : {}),
      })
    }

    if (argv.json) {
      await writeJson({ ok: results.every((r) => r.ok), results })
      if (!results.every((r) => r.ok)) process.exit(1)
      return
    }

    console.log()
    for (const r of results) {
      if (r.ok) {
        console.log(`  ${success("✓")} ${bold("#" + r.id)}  ${basename(r.path)}  ${dim(`${r.bytes} bytes`)}`)
        console.log(`     ${dim("sha256 " + r.sha256 + " — read back from the server and matched")}`)
      } else {
        console.log(`  ${dim("✗")} ${basename(r.path)}`)
        console.log(`     ${r.error}`)
        if (r.supported_types) console.log(`     ${dim("server accepts: " + r.supported_types.join(", "))}`)
      }
    }
    console.log()
    const bad = results.filter((r) => !r.ok).length
    if (bad) {
      console.log(`  ${bad} of ${results.length} failed.`)
      process.exit(1)
    }
  },
})

const DownloadCommand = cmd({
  command: "download <bloq-id>",
  describe: "download attachments from a bloq, sha256 printed for each",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("file", { describe: "download only this file ID (repeatable)", type: "array" })
      .option("out", { describe: "output directory", type: "string", default: "." })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const bloqId = Number(argv["bloq-id"])

    const r = await listFiles(userId, bloqId)
    if (!r.ok) {
      if (argv.json) await writeJson({ ok: false, error: r.error })
      else console.error(`\n  ${bold("COULD NOT LIST")}  ${r.error}\n`)
      process.exit(1)
    }

    const want = (argv.file as any[] | undefined)?.map(Number)
    const files = want?.length ? r.files.filter((f) => want.includes(f.id)) : r.files
    const outDir = String(argv.out)
    await mkdir(outDir, { recursive: true })

    const results: any[] = []
    for (const f of files) {
      if (!f.url) {
        results.push({ ok: false, id: f.id, name: f.name, error: "the record has no URL" })
        continue
      }
      try {
        const dl = await fetch(f.url)
        if (!dl.ok) {
          results.push({ ok: false, id: f.id, name: f.name, error: `HTTP ${dl.status} fetching ${f.url}` })
          continue
        }
        const buf = Buffer.from(await dl.arrayBuffer())
        // Name collisions are real here: bloq 569 holds several files with the SAME name from
        // different dates. Prefix with the id so nothing is silently overwritten.
        const target = join(outDir, `${f.id}-${f.name}`)
        await writeFile(target, buf)
        results.push({ ok: true, id: f.id, name: f.name, path: target, bytes: buf.length, sha256: sha256(buf) })
      } catch (e: any) {
        results.push({ ok: false, id: f.id, name: f.name, error: String(e?.message ?? e).slice(0, 200) })
      }
    }

    if (argv.json) {
      await writeJson({ ok: results.every((x) => x.ok), count: results.length, results })
      if (!results.every((x) => x.ok)) process.exit(1)
      return
    }

    console.log()
    for (const x of results) {
      if (x.ok) {
        console.log(`  ${success("✓")} ${bold(x.path)}  ${dim(`${x.bytes} bytes`)}`)
        console.log(`     ${dim("sha256 " + x.sha256)}`)
      } else {
        console.log(`  ${dim("✗")} #${x.id} ${x.name}`)
        console.log(`     ${x.error}`)
      }
    }
    console.log()
    console.log(`  ${results.filter((x) => x.ok).length}/${results.length} downloaded`)
    console.log()
    if (results.some((x) => !x.ok)) process.exit(1)
  },
})

const RmCommand = cmd({
  command: "rm <file-id..>",
  describe: "delete attachment(s) by file ID",
  builder: (yargs) =>
    yargs
      .positional("file-id", { describe: "cloud file ID(s)", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)
    const ids = ([] as any[]).concat(argv["file-id"] as any).map(Number)

    const results: any[] = []
    for (const id of ids) {
      const res = await irisFetch(`/api/v1/cloud-files/${id}`, { method: "DELETE" })
      const text = await res.text()
      results.push(
        res.ok
          ? { ok: true, id }
          : {
              ok: false,
              id,
              // #182010: create-but-never-delete is the asymmetry that guarantees debris.
              // Name it rather than printing a bare 403.
              error:
                res.status === 403
                  ? "403 — this account may create attachments but not delete them (#182010). The debris cannot be cleaned up from here."
                  : `HTTP ${res.status}${text.trim() ? ` — ${text.trim().slice(0, 160)}` : " with an empty body"}`,
            },
      )
    }

    if (argv.json) {
      await writeJson({ ok: results.every((r) => r.ok), results })
      if (!results.every((r) => r.ok)) process.exit(1)
      return
    }

    console.log()
    for (const r of results) {
      if (r.ok) console.log(`  ${success("✓")} deleted #${r.id}`)
      else console.log(`  ${dim("✗")} #${r.id}  ${r.error}`)
    }
    console.log()
    if (results.some((r) => !r.ok)) process.exit(1)
  },
})

const AtlasFilesCommand = cmd({
  command: "files",
  describe: "bloq attachments — list, upload (read-back verified), download, rm",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(UploadCommand)
      .command(DownloadCommand)
      .command(RmCommand)
      .demandCommand(1, "Specify: list, upload, download, rm"),
  async handler() {},
})

export const AtlasFilesCommandExport = AtlasFilesCommand
