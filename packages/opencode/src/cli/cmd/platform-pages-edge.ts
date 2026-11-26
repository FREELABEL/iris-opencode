/**
 * `iris genesis export` and `iris genesis deploy` — IRIS Edge.
 *
 * The second answer to "can we not be on your servers". The first is a custom domain (`iris domains
 * connect`): our servers, their domain. This one hands over FILES, so the page runs on hardware they
 * control and nothing of ours runs there.
 *
 * What that costs, stated once so nobody has to discover it: a file cannot ask who is reading it.
 * Pages behind a sign-in, rows that differ per viewer, and anything that looks like health
 * information are REFUSED rather than shipped — see edge/export-data.ts for the rules, and
 * FREELABEL #185860 for the decision record.
 */
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, writeJson, irisFetch, resolveToken } from "./iris-api"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, join, resolve } from "path"
import { publicUrl } from "./page-ref"
import { exportPage, writeProvenance, readProvenance, discard } from "./edge/export"
import { exportPageData } from "./edge/export-data"
import { harvest } from "./edge/harvest"
import { verifyExport } from "./edge/verify"
import { startStaticServer, HOST_CONFIG } from "./edge/serve"
import { buildIco, buildIcns, linuxDesktopEntry, macAppFiles, safeName, shortcutPaths, windowsShortcutScript, type IconPng } from "./edge/shortcut"
import { LivePage, liveHooks } from "./edge/live"
import { LocalActions, parseDecl, execRunner, dialogApprover, appVersion, describe as describePowers, type LocalDecl } from "./edge/local-actions"
import { selfCommand } from "./hive-relay-ssh"
import {
  answering,
  keepRunning,
  listServed,
  portFor,
  publicNameFor,
  readState,
  safeSlug,
  servedDir,
  stopKeeping,
  swapSite,
  writeState,
} from "./edge/served"
import { openBrowser } from "../../util/browser"
import { prepareRelayRunner } from "./platform-hive-tunnel"
import { parseRunnerLine } from "./platform-hive-relay"
import { spawn, spawnSync } from "child_process"
import { Remote, loadConfig, newReleaseId, EXAMPLE_CONFIG, type Target } from "./edge/deploy"

const DEFAULT_ORIGIN = "https://freelabel.net"

/** The origin a slug is actually published at, so an export never silently targets the wrong host. */
function originFor(explicit?: string): string {
  if (explicit) return explicit.replace(/\/+$/, "")
  try {
    return new URL(publicUrl("x")).origin
  } catch {
    return DEFAULT_ORIGIN
  }
}

function printChecks(checks: { label: string; ok: boolean; detail: string }[]) {
  for (const c of checks) {
    const line = `  ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? " — " + c.detail : ""}`
    if (c.ok) prompts.log.info(line)
    else prompts.log.error(line)
  }
}

// ── export ──────────────────────────────────────────────────────────────────────────────────────

export const EdgeExportCmd = cmd({
  command: "export <slug> [out]",
  describe: "export a published page to a folder any static host can serve (IRIS Edge)",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .positional("out", { type: "string", describe: "output directory (default: ./exports/<slug>)" })
      .option("origin", { type: "string", describe: "origin to export from (default: the published host)" })
      // Literal `--no-*` flags: this CLI runs yargs with boolean-negation OFF (index.ts), so a
      // `verify` option defaulting to true could never be turned off — and the refusal text below
      // names `--no-verify`, which would have been a flag that did not exist.
      .option("no-verify", {
        type: "boolean",
        default: false,
        describe: "skip opening the export in a browser with IRIS Cloud switched off — not recommended",
      })
      .option("no-data", { type: "boolean", default: false, describe: "skip exporting bound collections" })
      .option("no-harvest", { type: "boolean", default: false, describe: "skip pulling assets the page injects at runtime" })
      .option("host-config", { type: "boolean", default: false, describe: "print nginx/Caddy/S3 config and exit" })
      .option("json", { type: "boolean", default: false })
      .example("iris genesis export my-page", "export to ./exports/my-page, verified")
      .example("iris genesis export my-page --host-config", "what their web server needs"),
  async handler(args) {
    if (args["host-config"]) {
      UI.println(HOST_CONFIG)
      return
    }

    const slug = String(args.slug)
    const origin = originFor(args.origin as string | undefined)
    const outDir = resolve(String(args.out ?? join("exports", slug)))
    const json = Boolean(args.json)

    if (!json) {
      UI.empty()
      prompts.intro(`◈  Edge export: ${slug}`)
    }
    const sp = json ? null : prompts.spinner()
    sp?.start(`Fetching ${origin}/p/${slug}…`)

    try {
      mkdirSync(outDir, { recursive: true })
      const res = await exportPage(slug, outDir, { origin })

      if (!res.ok) {
        sp?.stop("Refused")
        const f = res.failure!
        // Each of these is a REFUSAL, not a crash — the export could have produced a folder in every
        // one of these cases, and that folder would have looked fine.
        if (f.kind === "gated") {
          discard(outDir)
          process.exitCode = 5
          if (json) return writeJson({ ok: false, reason: "auth-gated", slug })
          prompts.log.error(
            "This page is behind a sign-in. Sign-ins are handled by IRIS Cloud, so a self-hosted " +
              "copy would show the sign-in form with nothing behind it.",
          )
          prompts.log.info("Keep this page on IRIS Cloud under your own domain instead: iris domains connect <domain> --page " + slug)
          prompts.outro("Not exported")
          return
        }
        if (f.kind === "torn") {
          process.exitCode = 2
          if (json) return writeJson({ ok: false, reason: "torn", before: f.before, after: f.after })
          prompts.log.error(`A deploy landed mid-export (${f.before} → ${f.after}). The copy is torn and renders blank.`)
          prompts.log.info("Re-run. Do not ship this folder.")
          prompts.outro("Not exported")
          return
        }
        process.exitCode = 3
        if (json) return writeJson({ ok: false, reason: "incomplete", missing: f.missing })
        prompts.log.error(`${f.missing.length} asset(s) missing — one missing chunk renders the page blank.`)
        for (const m of f.missing.slice(0, 5)) prompts.log.info(dim(`  ${m}`))
        prompts.outro("Not exported")
        return
      }

      for (const l of res.log) sp?.message(l)

      if (!args["no-harvest"]) {
        sp?.message("Asking the browser what else it loads…")
        const h = await harvest(res.site, { origin })
        if (!json) for (const l of h.log) prompts.log.info(dim(l))
      }

      let data: Awaited<ReturnType<typeof exportPageData>> | null = null
      if (!args["no-data"]) {
        sp?.message("Exporting bound collections…")
        data = await exportPageData(res.site, { slug, origin })
        if (!json) for (const l of data.log) prompts.log.info(dim(l))
      }

      writeProvenance(outDir, {
        slug,
        origin,
        page_url: `${origin}/p/${slug}`,
        build_entry: res.buildEntry,
        exported_at: new Date().toISOString(),
        files: res.files,
      })

      let verified: Awaited<ReturnType<typeof verifyExport>> | null = null
      if (!args["no-verify"]) {
        sp?.message("Opening it in a browser with IRIS Cloud switched off…")
        // Offline is not optional. Without it the independence check reads "zero calls", which
        // cannot tell an independent page from one that had not needed the network yet.
        verified = await verifyExport(res.site, { offline: true, baseline: `${origin}/p/${slug}` })
      }

      sp?.stop(verified && !verified.ok ? "Failed verification" : "Exported")

      if (verified && !verified.ok) process.exitCode = 4
      if (json) {
        return writeJson({
          ok: !verified || verified.ok,
          slug,
          site: res.site,
          files: res.files,
          bytes: res.bytes,
          data: data ? { exported: data.exported.length, refused: data.refused } : null,
          checks: verified?.checks ?? null,
        })
      }

      if (verified) printChecks(verified.checks)
      prompts.log.success(`${res.files} files · ${(res.bytes / 1e6).toFixed(1)}MB → ${res.site}`)
      prompts.log.info(dim(`serve locally: iris genesis serve-edge ${res.site}`))
      prompts.log.info(dim(`deploy:        iris genesis deploy ${res.site} --target <name>`))
      prompts.outro(verified && !verified.ok ? "Exported, but it did NOT verify — do not ship it" : "Done")
    } catch (e: any) {
      sp?.stop("Error")
      process.exitCode = 1
      if (json) return writeJson({ ok: false, error: e?.message ?? String(e) })
      prompts.log.error(e?.message ?? String(e))
      prompts.outro("Failed")
    }
  },
})

// ── serve ───────────────────────────────────────────────────────────────────────────────────────

export const EdgeServeCmd = cmd({
  command: "serve-edge <dir>",
  aliases: ["edge-serve"],
  describe: "serve an exported folder locally, with the SPA fallback a real host must replicate",
  builder: (y) =>
    y
      .positional("dir", { type: "string", demandOption: true })
      .option("port", { type: "number", default: 8080 })
      .option("public-name", {
        type: "string",
        describe: "also publish it at https://<name>.t.heyiris.io through the Hive relay (used by `pages serve --public`)",
      })
      .option("live", {
        type: "string",
        describe: "page slug: serve it with LIVE data, signed in as you, on this computer only (used by `pages serve`)",
      }),
  async handler(args) {
    const dir = resolve(String(args.dir))
    if (!existsSync(join(dir, "index.html"))) {
      UI.error(`${dir} has no index.html — point this at the "site" directory an export produced.`)
      process.exitCode = 1
      return
    }
    let hooks = {}
    const liveSlug = args.live && !args["public-name"] ? safeSlug(String(args.live)) : null
    if (liveSlug) {
      // state.json sits beside site/; it carries where the page is published and its bindings.
      const st = readState(liveSlug)
      const live = new LivePage({
        slug: liveSlug,
        origin: st?.origin ?? originFor(undefined),
        bindings: st?.live_bindings ?? [],
        // Read at run time from the CLI's own sign-in, never written into a plist, task or unit.
        token: () => resolveToken(),
        cacheDir: join(dirname(dir), "live"),
      })
      const srvPort = Number(args.port)
      // Local actions (#194354): the page's `local` block, read fresh (30 s) so a publish that
      // changes what it asks for takes effect — and, through the version hash, asks again.
      let declCache: { at: number; decl: LocalDecl | null } = { at: 0, decl: null }
      const decl = async () => {
        if (Date.now() - declCache.at < 30000) return declCache.decl
        const c = await pageContent(liveSlug)
        declCache = { at: Date.now(), decl: c ? parseDecl(c.local) : declCache.decl }
        return declCache.decl
      }
      const local = new LocalActions(liveSlug, servedDir(liveSlug), decl, () => live.document(), execRunner, dialogApprover, selfCommand())
      hooks = liveHooks(live, liveSlug, () => srvPort, local)
    }
    const srv = await startStaticServer(dir, Number(args.port), hooks)
    UI.println(`serving ${dir} on ${srv.url}  (SPA fallback on, assets 404 honestly)${liveSlug ? " · live data, signed in as you" : ""}`)
    const name = args["public-name"] ? String(args["public-name"]) : ""
    if (name) {
      // The relay runner is a CHILD of this server, so the two live and die together, and the OS
      // keeper that restarts this process restarts the tunnel with it. The token is read here, at
      // run time, from the CLI's own sign-in — never written into a plist, task or unit (#194213).
      const prep = await prepareRelayRunner(name, srv.port)
      if (!prep.ok) {
        UI.error(`public address not opened: ${prep.error}`)
        process.exit(1)
      }
      const child = spawn(prep.node, ["--no-warnings", ...prep.args], { env: prep.env, stdio: ["ignore", "pipe", "pipe"] })
      let buf = ""
      child.stdout.on("data", (d) => {
        buf += String(d)
        let i
        while ((i = buf.indexOf("\n")) >= 0) {
          const ev = parseRunnerLine(buf.slice(0, i))
          buf = buf.slice(i + 1)
          if (ev) UI.println(`${new Date().toISOString()} relay ${JSON.stringify(ev)}`)
        }
      })
      child.stderr.on("data", (d) => UI.println(`relay stderr: ${String(d).trim()}`))
      const stop = (code: number) => {
        child.kill("SIGTERM")
        void srv.stop().finally(() => process.exit(code))
      }
      // A dead tunnel must not leave a server that LOOKS fine locally: exit, and let the keeper
      // restart both.
      child.on("exit", (code) => {
        UI.println(`relay runner exited (${code}) — exiting so both restart`)
        stop(1)
      })
      process.on("SIGTERM", () => stop(0))
      process.on("SIGINT", () => stop(0))
      UI.println(`public: ${prep.url}/p/  (through the Hive relay)`)
    }
    UI.println(dim("ctrl-c to stop"))
    await new Promise(() => {})
  },
})

/** A page's json_content, read with this CLI's sign-in. Null when it cannot be read. */
async function pageContent(slug: string): Promise<any | null> {
  try {
    const res = await irisFetch(`/api/v1/pages/by-slug/${encodeURIComponent(slug)}?include_json=1`)
    if (!res.ok) return null
    const j = (await res.json()) as any
    const page = j?.data ?? j
    let c = page?.json_content
    if (typeof c === "string") c = JSON.parse(c)
    return c && typeof c === "object" ? c : null
  } catch {
    return null
  }
}

/** The binding names a page declares (json_content.bindings). [] when it has none or cannot be read. */
async function pageBindings(slug: string): Promise<string[]> {
  const b = (await pageContent(slug))?.bindings
  return b && typeof b === "object" && !Array.isArray(b) ? Object.keys(b).filter((k) => /^[A-Za-z0-9_.-]{1,64}$/.test(k)) : []
}

// ── pages serve: a page running on this computer (#194212) ──────────────────────────────────────

/**
 * `iris pages serve <slug>` — export the published page, serve it on this computer, keep it served
 * after a reboot (launchd / logon task / systemd), and open it so it can be installed as an app.
 * Run it again to re-sync from the cloud; `list` and `stop <slug>` manage what is served.
 *
 * Read-only: a served copy shows the page as published. Forms and edits still go to IRIS Cloud.
 */
export const PagesServeCmd = cmd({
  command: "serve <slug> [target]",
  describe: "run a published page on this computer — starts with the computer, installable as an app",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true, describe: "page slug — or `list`, or `stop <slug>`" })
      .positional("target", { type: "string", describe: "with stop: the page to stop" })
      .option("port", { type: "number", describe: "local port (default: the same one every time for this page)" })
      .option("origin", { type: "string", describe: "origin to export from (default: the published host)" })
      .option("no-open", { type: "boolean", default: false, describe: "do not open it in a browser" })
      .option("no-autostart", { type: "boolean", default: false, describe: "serve it now only — do not start it when this computer restarts" })
      .option("public", {
        type: "boolean",
        default: false,
        describe: "also give it a public https address (Hive relay), the same one every time — so a phone can install it",
      })
      .option("name", { type: "string", describe: "with --public: the name in https://<name>.t.heyiris.io (default: from the slug)" })
      .option("live", {
        type: "boolean",
        default: true,
        describe: "live data, signed in as you: your rows, your saves and buttons work, and a publish shows on the next load (--no-live: a frozen copy)",
      })
      .option("json", { type: "boolean", default: false })
      .example("iris pages serve my-page", "running at http://localhost:<port>/p/my-page, starts with the computer")
      .example("iris pages serve my-page --public", "…and at https://my-page.t.heyiris.io/p/my-page, for phones")
      .example("iris pages serve list", "what is served here, and whether it is answering")
      .example("iris pages serve stop my-page", "stop it and remove it from startup"),
  async handler(args) {
    const json = Boolean(args.json)
    const first = String(args.slug)

    if (first === "list") {
      const rows = await Promise.all(listServed().map(async (s) => ({ ...s, up: await answering(s.port, s.slug) })))
      if (json) return writeJson({ ok: true, served: rows })
      if (!rows.length) return UI.println("Nothing is served on this computer. Start one: iris pages serve <slug>")
      for (const r of rows) {
        const when = r.synced_at.slice(0, 16).replace("T", " ")
        UI.println(
          `${r.up ? "●" : "○"} ${r.slug.padEnd(32)} http://localhost:${r.port}/p/${r.slug}  ` +
            dim(`synced ${when} · ${r.keeper}${r.up ? "" : " · NOT answering"}`),
        )
        if (r.public_url) UI.println(`  ${" ".repeat(32)} ${r.public_url}`)
      }
      return
    }

    if (first === "stop") {
      const slug = safeSlug(String(args.target ?? ""))
      const s = slug ? readState(slug) : null
      if (!s) {
        UI.error(`Nothing served as "${args.target ?? ""}". See: iris pages serve list`)
        process.exitCode = 1
        return
      }
      const removed = stopKeeping(s)
      rmSync(servedDir(s.slug), { recursive: true, force: true })
      if (json) return writeJson({ ok: true, stopped: s.slug, removed })
      UI.println(`Stopped ${s.slug}${removed.length ? dim(` — removed ${removed.join(", ")}`) : ""}`)
      return
    }

    const slug = safeSlug(first)
    if (!slug) {
      UI.error(`"${first}" is not a page slug (letters, digits, - and _).`)
      process.exitCode = 1
      return
    }

    // `serve` was an alias of `dev` until #194212. Someone with a local draft and the old habit
    // gets a local COPY of the published page now — say so, rather than surprise them.
    if (!json && existsSync(join("pages", `${slug}.json`))) {
      UI.println(dim(`(previewing your local edits? that is \`iris pages dev ${slug}\` — serve runs the PUBLISHED page)`))
    }

    const origin = originFor(args.origin as string | undefined)
    const dir = servedDir(slug)
    const prev = readState(slug)
    const taken = new Set(listServed().filter((s) => s.slug !== slug).map((s) => s.port))
    const port = Number(args.port ?? prev?.port ?? portFor(slug, taken))

    // --public: claim the name and check this machine can run the relay BEFORE exporting anything,
    // so "name taken" or "update your bridge" is said first, not after a minute of work.
    const publicName = args.public ? String(args.name ?? prev?.public_name ?? publicNameFor(slug)) : undefined
    let publicUrl: string | undefined
    if (publicName) {
      const claim = await prepareRelayRunner(publicName, port)
      if (!claim.ok) {
        if (json) return writeJson({ ok: false, reason: "public", detail: claim.error })
        UI.error(`No public address: ${claim.error}${/taken|use/i.test(claim.error) ? ` — pick another with --name` : ""}`)
        process.exitCode = 1
        return
      }
      publicUrl = `${claim.url}/p/${slug}`
    }

    if (!json) {
      UI.empty()
      prompts.intro(`◈  Serve ${slug} on this computer`)
    }
    const sp = json ? null : prompts.spinner()
    sp?.start(`Exporting ${origin}/p/${slug}…`)

    const stage = join(dir, "next")
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true })
    const res = await exportPage(slug, stage, { origin })
    if (!res.ok) {
      sp?.stop("Not served")
      rmSync(stage, { recursive: true, force: true })
      const f = res.failure!
      const why =
        f.kind === "gated"
          ? "this page is behind a sign-in, which only IRIS Cloud can check — keep it on IRIS Cloud"
          : f.kind === "torn"
            ? "a deploy landed mid-export — run it again"
            : `${f.missing.length} asset(s) missing`
      if (json) return writeJson({ ok: false, reason: f.kind, detail: why })
      UI.error(`Could not export ${slug}: ${why}`)
      process.exitCode = 3
      return
    }
    sp?.message("Pulling in what the page loads at runtime…")
    let harvestNote = ""
    try {
      await harvest(res.site, { origin })
    } catch (e: any) {
      // Harvest needs a Chrome-family browser. Without one the page still serves from its asset
      // graph; what it injects at runtime may be missing. Say so instead of failing the serve.
      harvestNote = String(e?.message ?? e).split("\n")[0]!
    }
    try {
      await exportPageData(res.site, { slug, origin })
    } catch {}

    swapSite(dir, res.site)
    rmSync(stage, { recursive: true, force: true })
    const site = join(dir, "site")

    // Live (#194353): on by default when this CLI is signed in, never with --public. The binding
    // names come from the page itself, so the server knows what to fetch fresh on every load.
    let liveBindings: string[] | undefined
    let liveNote = ""
    if (args.live && !publicName) {
      if (!(await resolveToken().catch(() => ""))) liveNote = "not signed in — serving a frozen copy (iris auth login, then run this again)"
      else liveBindings = await pageBindings(slug)
    } else if (args.live && publicName) {
      liveNote = "a public copy is a frozen copy: live data is for this computer only"
    }

    // Re-serving: a server already answering on this port reads the swapped folder per request, so
    // it needs nothing. Otherwise (first serve, a changed port, or it died) start it and keep it.
    // Public or not is part of the command the keeper runs, so changing it means a restart.
    const already =
      !!prev && prev.port === port && (prev.public_name ?? undefined) === publicName &&
      !!prev.live_bindings === !!liveBindings && (await answering(port, slug))
    let kept: ReturnType<typeof keepRunning> | null = null
    if (!already) {
      if (prev) stopKeeping(prev)
      sp?.message("Starting it…")
      kept = keepRunning(slug, site, port, { autostart: !args["no-autostart"], publicName, liveSlug: liveBindings ? slug : undefined })
    }
    const state = {
      slug,
      port,
      origin,
      synced_at: new Date().toISOString(),
      keeper: kept?.keeper ?? prev!.keeper,
      ...(kept?.pid ? { pid: kept.pid } : already && prev?.pid ? { pid: prev.pid } : {}),
      ...(publicName ? { public_name: publicName, public_url: publicUrl } : {}),
      ...(liveBindings ? { live_bindings: liveBindings } : {}),
    }
    writeState(state)

    let up = false
    for (let i = 0; i < 30 && !(up = await answering(port, slug)); i++) await new Promise((r) => setTimeout(r, 500))
    const url = `http://localhost:${port}/p/${slug}`
    sp?.stop(up ? "Served" : "Started, but not answering yet")

    const survivesRestart = kept ? kept.keeper !== "process" : state.keeper !== "process"
    // The public address: wait for the relay to answer (a first run fetches a certificate).
    let publicUp = false
    if (publicUrl) {
      sp?.start("Opening the public address…")
      for (let i = 0; i < 60 && !(publicUp = await fetch(publicUrl, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false)); i++)
        await new Promise((r) => setTimeout(r, 2000))
      sp?.stop(publicUp ? "Public" : "Public address not answering yet")
    }

    if (json) return writeJson({ ok: up && (!publicUrl || publicUp), url, ...state, live: !!liveBindings, ...(liveNote ? { live_note: liveNote } : {}), public_up: publicUrl ? publicUp : undefined, starts_with_computer: survivesRestart, harvest: harvestNote || "ok" })

    UI.println(`  ${up ? "●" : "○"} ${url}`)
    if (publicUrl) UI.println(`  ${publicUp ? "●" : "○"} ${publicUrl}  ${dim("anyone with this address can open it · on a phone: Share → Add to Home Screen")}`)
    if (liveBindings) UI.println(dim("  live: your data, signed in as you · changes you publish show on the next load · offline it shows the last data it had"))
    else if (liveNote) UI.println(`  ${liveNote}`)
    if (already) UI.println(dim("  re-synced from IRIS Cloud; the running server picked it up"))
    if (survivesRestart) UI.println(dim(`  starts with this computer${kept ? ` (${kept.detail})` : ""}`))
    else if (!args["no-autostart"]) UI.println(`  ⚠ will NOT start after a restart${kept ? ` — ${kept.detail}` : ""}. Run this again after rebooting.`)
    if (harvestNote) UI.println(`  ⚠ some things the page loads at runtime may be missing: ${harvestNote}`)
    UI.println(dim("  install it as an app: Chrome or Edge → Install · Safari (Mac) → File → Add to Dock"))
    UI.println(dim(`  update it: iris pages serve ${slug}   stop it: iris pages serve stop ${slug}`))
    if (up && !args["no-open"]) openBrowser(url)
    if (!up) process.exitCode = 1
  },
})

// ── pages install: the app in the Start menu / Dock / launcher (#194356) ──────────────────────

/**
 * `iris pages install <slug>` — a real shortcut with the app's own icon, opening in its own window.
 * `--local` points it at the copy served on this computer (`iris pages serve`); default is IRIS
 * Cloud. `--remove` takes it out again.
 */
export const PagesInstallCmd = cmd({
  command: "install <slug>",
  describe: "put an app in your Start menu, Dock or launcher — its own name, its own icon, its own window",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .option("local", { type: "boolean", default: false, describe: "open the copy served on this computer (iris pages serve) instead of IRIS Cloud" })
      .option("origin", { type: "string", describe: "where the page is published (default: the published host)" })
      .option("remove", { type: "boolean", default: false, describe: "remove the shortcut" })
      .option("json", { type: "boolean", default: false })
      .example("iris pages install my-dashboard", "Start menu (Windows), ~/Applications (Mac) or your launcher (Linux)")
      .example("iris pages install my-dashboard --local", "…opening the copy running on this computer"),
  async handler(args) {
    const json = Boolean(args.json)
    const slug = safeSlug(String(args.slug))
    const fail = (msg: string, reason: string) => {
      if (json) writeJson({ ok: false, reason, detail: msg })
      else UI.error(msg)
      process.exitCode = 1
    }
    if (!slug) return fail(`"${args.slug}" is not a page slug.`, "slug")
    const home = homedir()
    const appDir = join(home, ".iris", "apps", slug)
    const record = join(appDir, "install.json")

    if (args.remove) {
      let removed: string[] = []
      try {
        removed = (JSON.parse(readFileSync(record, "utf8")).paths ?? []) as string[]
      } catch {}
      for (const p of removed) rmSync(p, { recursive: true, force: true })
      rmSync(appDir, { recursive: true, force: true })
      if (json) return writeJson({ ok: true, removed })
      return UI.println(removed.length ? `Removed ${slug} from this computer.` : `${slug} was not installed here.`)
    }

    const origin = originFor(args.origin as string | undefined).replace(/\/$/, "")
    let url = `${origin}/p/${slug}?source=pwa`
    if (args.local) {
      const st = readState(slug)
      if (!st) return fail(`${slug} is not served on this computer. Serve it first: iris pages serve ${slug}`, "not_served")
      url = `http://localhost:${st.port}/p/${slug}?source=pwa`
    }

    // The app's own name and icon come from IRIS — the same ones a browser install would use.
    const man = await fetch(`${origin}/p/${slug}/manifest.webmanifest`, { signal: AbortSignal.timeout(10000) }).catch(() => null)
    if (!man?.ok) return fail(`${slug} does not install as an app (it is private, turned off, or not found).`, "not_installable")
    const m = (await man.json().catch(() => ({}))) as { name?: string; short_name?: string }
    const name = safeName(String(m.name || m.short_name || slug))
    const icon = async (size: number): Promise<IconPng | null> => {
      const r = await fetch(`${origin}/p/${slug}/app-icon-${size}.png`, { signal: AbortSignal.timeout(15000) }).catch(() => null)
      return r?.ok ? { size, data: Buffer.from(await r.arrayBuffer()) as Buffer } : null
    }
    const got = async (sizes: number[], fallback: number): Promise<IconPng[]> => {
      const imgs: IconPng[] = []
      for (const x of await Promise.all(sizes.map(icon))) if (x) imgs.push(x)
      // An older IRIS draws only 180/192/512: use the closest it has rather than no icon.
      if (!imgs.length) {
        const f = await icon(fallback)
        if (f) imgs.push(f)
      }
      return imgs
    }

    const plat = process.platform
    const where = shortcutPaths(plat, home, name, slug, process.env.APPDATA)
    mkdirSync(appDir, { recursive: true })
    const paths: string[] = []
    try {
      if (plat === "win32") {
        const imgs = await got([16, 32, 48, 256], 192)
        if (!imgs.length) return fail("Could not fetch the app's icon from IRIS.", "icon")
        writeFileSync(where.icon, buildIco(imgs))
        const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", windowsShortcutScript({ lnk: where.shortcut, ico: where.icon, url, name })], {
          encoding: "utf8",
          windowsHide: true,
        })
        if (r.status !== 0) return fail(`Windows refused the shortcut: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`, "shortcut")
        paths.push(where.shortcut)
      } else if (plat === "darwin") {
        const imgs = await got([16, 32, 256, 512], 512)
        rmSync(where.shortcut, { recursive: true, force: true })
        for (const [rel, f] of Object.entries(macAppFiles({ name, url, slug }))) {
          const p = join(where.shortcut, rel)
          mkdirSync(dirname(p), { recursive: true })
          writeFileSync(p, f.data)
          if (f.mode) chmodSync(p, f.mode)
        }
        mkdirSync(join(where.shortcut, "Contents", "Resources"), { recursive: true })
        if (imgs.length) writeFileSync(join(where.shortcut, "Contents", "Resources", "app.icns"), buildIcns(imgs))
        // Finder caches icons by bundle; touching it makes the new one show without a log-out.
        spawnSync("touch", [where.shortcut])
        paths.push(where.shortcut)
      } else {
        const imgs = await got([256], 512)
        if (imgs[0]) writeFileSync(where.icon, imgs[0].data)
        mkdirSync(dirname(where.shortcut), { recursive: true })
        writeFileSync(where.shortcut, linuxDesktopEntry({ name, url, icon: where.icon, slug }))
        chmodSync(where.shortcut, 0o755)
        paths.push(where.shortcut)
      }
    } catch (e: any) {
      return fail(`Could not install ${slug}: ${String(e?.message ?? e).split("\n")[0]}`, "write")
    }
    writeFileSync(record, JSON.stringify({ slug, name, url, paths, installed_at: new Date().toISOString() }, null, 2))

    if (json) return writeJson({ ok: true, slug, name, url, paths })
    const place = plat === "win32" ? "the Start menu (IRIS Apps)" : plat === "darwin" ? "~/Applications/IRIS Apps — drag it to the Dock to keep it there" : "your app launcher"
    UI.println(`Installed ${name} in ${place}.`)
    UI.println(dim(`  opens ${args.local ? "the copy on this computer" : "from IRIS Cloud"} in its own window · remove: iris pages install ${slug} --remove`))
  },
})

// ── pages allow: approve what an app may do on this computer (#194354) ─────────────────────────

/**
 * `iris pages allow <slug>` — the approval for local actions, from the terminal. Shows exactly what
 * the app asks for (every file, every command, verbatim) and records the approval for THIS version;
 * a publish that changes the app asks again. `--revoke` removes every approval for the page.
 */
export const PagesAllowCmd = cmd({
  command: "allow <slug>",
  describe: "allow an app served on this computer to do what it asks for here (notifications, your agents, listed files and commands)",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .option("yes", { type: "boolean", default: false, describe: "allow without asking (you have read the list)" })
      .option("revoke", { type: "boolean", default: false, describe: "remove every approval for this app" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const slug = safeSlug(String(args.slug))
    const st = slug ? readState(slug) : null
    if (!slug || !st) {
      UI.error(`"${args.slug}" is not served on this computer. Serve it first: iris pages serve ${args.slug ?? "<slug>"}`)
      process.exitCode = 1
      return
    }
    const dir = servedDir(slug)
    if (args.revoke) {
      rmSync(join(dir, "approvals.json"), { force: true })
      if (args.json) return writeJson({ ok: true, revoked: slug })
      return UI.println(`Removed every approval for ${slug}. It will ask again.`)
    }
    const decl = parseDecl((await pageContent(slug))?.local)
    if (!decl) {
      if (args.json) return writeJson({ ok: true, slug, asks_for: [] })
      return UI.println(`${slug} asks for nothing on this computer.`)
    }
    const live = new LivePage({ slug, origin: st.origin, bindings: [], token: () => resolveToken(), cacheDir: join(dir, "live") })
    const doc = await live.document()
    if (doc === null) {
      UI.error("Could not read the app from IRIS, and there is no saved copy. Try again when online.")
      process.exitCode = 1
      return
    }
    const version = appVersion(decl, doc)
    const powers = describePowers(decl)
    const actions = new LocalActions(slug, dir, async () => decl, async () => doc, execRunner, async () => false)
    if (!args.json) {
      UI.println(`${slug} wants to:`)
      for (const p of powers) UI.println(`  • ${p}`)
    }
    let ok = Boolean(args.yes)
    if (!ok && !args.json) {
      const answer = await prompts.confirm({ message: "Allow this version of it?", initialValue: false })
      ok = answer === true
    }
    if (!ok) {
      if (args.json) return writeJson({ ok: false, slug, version, asks_for: powers, reason: "not_confirmed" })
      return UI.println("Not allowed.")
    }
    actions.grant(version, powers)
    if (args.json) return writeJson({ ok: true, slug, version, allowed: powers })
    UI.println(dim(`Allowed for this version. If the app changes, it will ask again. Undo: iris pages allow ${slug} --revoke`))
  },
})

// ── deploy ──────────────────────────────────────────────────────────────────────────────────────

export const EdgeDeployCmd = cmd({
  command: "deploy [site]",
  describe: "publish an export to a client's server as a new release, with rollback (IRIS Edge)",
  builder: (y) =>
    y
      .positional("site", { type: "string", describe: "the site/ directory an export produced" })
      .option("target", { type: "string", describe: "target name from the deploy config" })
      .option("config", { type: "string", default: "genesis-deploy.json" })
      .option("list", { type: "boolean", default: false, describe: "list releases on the target" })
      .option("rollback", { type: "boolean", default: false, describe: "point the target at a previous release" })
      .option("to", { type: "string", describe: "with --rollback: which release" })
      .option("force", { type: "boolean", default: false, describe: "allow replacing a DIFFERENT page on this target" })
      .option("dry-run", { type: "boolean", default: false })
      .option("no-verify", { type: "boolean", default: false, describe: "deploy without verifying first — not recommended" })
      .option("min-chars", { type: "number", describe: "render floor when there is no baseline" })
      .option("json", { type: "boolean", default: false })
      .example("iris genesis deploy exports/my-page/site --target production", "ship it")
      .example("iris genesis deploy --target production --rollback", "undo, transferring nothing"),
  async handler(args) {
    const configPath = resolve(String(args.config))
    const json = Boolean(args.json)
    const dryRun = Boolean(args["dry-run"])

    const fail = (msg: string, code = 1) => {
      process.exitCode = code
      if (json) writeJson({ ok: false, error: msg })
      else UI.error(msg)
    }

    let config
    try {
      config = loadConfig(configPath)
    } catch {
      if (json) return fail(`no deploy config at ${configPath}`, 64)
      UI.error(`No deploy config at ${configPath}`)
      UI.println("")
      UI.println("Write one — it is the record of where a client's site actually lives, which is")
      UI.println("otherwise a fact that exists only in whoever set it up:")
      UI.println("")
      UI.println(EXAMPLE_CONFIG)
      process.exitCode = 64
      return
    }

    const names = Object.keys(config.targets ?? {})
    if (!names.length) return fail(`${configPath} defines no targets`, 64)
    // Refuse to guess when there is more than one. Picking the wrong target here publishes a
    // client's page to a different client's server, and it looks like a success.
    const name = (args.target as string | undefined) ?? (names.length === 1 ? names[0]! : "")
    if (!name) return fail(`--target is required; ${configPath} defines: ${names.join(", ")}`, 64)
    const target: Target | undefined = config.targets[name]
    if (!target) return fail(`no target "${name}" in ${configPath} (have: ${names.join(", ")})`, 64)

    try {
      const remote = new Remote(target, dryRun, (s) => UI.println(dim(`    [dry-run] ${s}`)))

      // ── list ──
      if (args.list) {
        const [releases, cur] = [await remote.releases(), await remote.current()]
        if (json) return writeJson({ target: name, root: remote.label, current: cur, releases })
        UI.println(`${name} → ${remote.label}`)
        if (!releases.length) UI.println("  no releases yet")
        for (const r of releases) UI.println(`  ${r === cur ? "→" : " "} ${r}${r === cur ? "  (live)" : ""}`)
        return
      }

      // ── rollback ──
      if (args.rollback) {
        const releases = await remote.releases()
        const cur = await remote.current()
        const to = (args.to as string | undefined) ?? releases.filter((r) => r !== cur).pop()
        if (!to) return fail(`nothing to roll back to on ${remote.label} — ${releases.length} release(s), current is ${cur ?? "unset"}`)
        if (!releases.includes(to)) return fail(`no release "${to}" on ${remote.label} (have: ${releases.join(", ") || "none"})`)
        if (to === cur) return fail(`${to} is already live`)
        await remote.pointAt(to)
        if (json) return writeJson({ ok: true, target: name, from: cur, to })
        UI.println(`✓ rolled back ${name}: ${cur ?? "(none)"} → ${to}`)
        UI.println(dim("  nothing was transferred — the old release never left the machine."))
        return
      }

      // ── deploy ──
      if (!args.site) return fail("usage: iris genesis deploy <site-dir> --target <name>   (or --list / --rollback)", 64)
      const site = resolve(String(args.site))
      if (!existsSync(join(site, "index.html"))) {
        return fail(`${site} has no index.html — point this at the "site" directory an export produced, not the export root`)
      }

      const provenance = readProvenance(site)
      // A BASELINE, when we know it. Without one, verify compares against absolutes and fails a
      // FAITHFUL export of a page whose source is already broken — /p/atlas has 5 images that 404
      // on the live site, and a deploy that refuses those is blaming us for the client's own
      // defect. That is the failure that makes people reach for --no-verify, and then it is off
      // for the real failures too.
      const baseline = target.source ?? provenance?.page_url ?? null

      if (!args["no-verify"]) {
        if (!json) UI.println(`→ verifying ${site} before it goes anywhere${baseline ? dim(` (against ${baseline})`) : ""}`)
        const v = await verifyExport(site, {
          offline: true,
          baseline,
          ...(args["min-chars"] ? { minChars: Number(args["min-chars"]) } : {}),
        })
        if (!json) printChecks(v.checks)
        if (!v.ok) {
          return fail("export failed verification — refusing to deploy it. Re-export; do not use --no-verify to get past this.")
        }
      }

      // One target serves one site. Silently replacing one page with another because someone
      // reused a config is how a client's server ends up showing a different client's page,
      // reported as a success.
      if (provenance?.slug && !dryRun) {
        const prior = await remote.deployedSlug()
        if (prior && prior !== provenance.slug && !args.force) {
          return fail(
            `${remote.label} is currently serving "${prior}", and this export is "${provenance.slug}". ` +
              `Deploying would replace one page with a different one on the same machine. ` +
              `If that is deliberate, re-run with --force.`,
          )
        }
      }

      const release = newReleaseId()
      if ((await remote.releases()).includes(release)) {
        return fail(`a release named ${release} already exists — two deploys in the same second. Re-run.`)
      }
      const dest = `${remote.root}/releases/${release}`
      if (!json) UI.println(`→ deploying to ${remote.label} as ${release}`)

      await remote.sh(`mkdir -p ${remote.root}/releases`)
      await remote.upload(site, dest)
      if (!dryRun && !json) {
        const files = (await remote.sh(`find ${dest} -type f | wc -l`)).trim()
        UI.println(dim(`  uploaded ${files} files`))
      }

      const previous = await remote.current()
      if (provenance?.slug && !dryRun) await remote.recordSlug(provenance.slug)
      await remote.pointAt(release)
      if (!json) UI.println(`✓ live: ${name} → ${release}${previous ? dim(` (was ${previous})`) : ""}`)

      const pruned = await remote.prune(release)
      if (pruned && !json) UI.println(dim(`  pruned ${pruned} old release(s), kept ${remote.keep}`))

      // A post-deploy fetch is the only check that covers the WEB SERVER's own config — the release
      // can be perfect on disk while the vhost still points at the old path, or at releases/ itself.
      let reachable: boolean | null = null
      if (target.url && !dryRun) {
        try {
          const res = await fetch(target.url, { redirect: "follow" })
          const body = await res.text()
          reachable = res.ok && body.includes('<div id="app"')
          if (!json) {
            UI.println(
              `  ${reachable ? "✓" : "✗"} ${target.url} → ${res.status}` +
                (reachable ? "" : " — reachable, but that is not the page we just deployed"),
            )
          }
          if (!reachable) process.exitCode = 1
        } catch (e: any) {
          if (!json) {
            UI.println(`  ! could not reach ${target.url}: ${e?.message ?? e}`)
            UI.println(dim("    The release is live on disk. This is their web server or DNS, not the export."))
          }
        }
      }

      if (json) return writeJson({ ok: true, target: name, release, previous, pruned, reachable })
      UI.println(dim(`  rollback: iris genesis deploy --target ${name} --rollback`))
    } catch (e: any) {
      fail(e?.message ?? String(e))
    }
  },
})
