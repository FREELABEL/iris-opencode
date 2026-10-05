/**
 * Verify an exported page actually renders — in a real browser, off-origin, with no dependencies.
 *
 * WHY THIS IS IN THE TOOL AND NOT A CHECKLIST. An export can succeed and render BLANK, and it did
 * so twice while this was built: once from a torn snapshot across a deploy, once from a single
 * missing 462-byte icon chunk. Both reported success. Neither was visible without loading the page.
 *
 * WHY CDP AND NOT PLAYWRIGHT. The IRIS CLI ships no browser dependency, so this talks to a
 * throwaway headless Chrome over the protocol Chrome already speaks. It also turned out to be the
 * STRICTER instrument: it caught a 404 on /icons/site.webmanifest that the Playwright version
 * reported as clean — an asset silently dropped because it sorted last in a list read by a loop
 * that discards the final line when the file has no trailing newline.
 *
 * Four checks, each one a failure that actually happened:
 *   1. RENDERS       body text, measured against the live page when one is given
 *   2. NO NEW ERRORS failed requests and exceptions, compared to the source
 *   3. INDEPENDENT   zero SUCCESSFUL calls to our servers — never excused by the baseline
 *   4. IMAGES        every <img> has pixels
 *
 * Ported from scripts/genesis-edge/verify.mjs. Returns the checks; the caller prints them.
 */
import { launch, inspect } from "./cdp"
import { startStaticServer } from "./serve"

export type VerifyCheck = { label: string; ok: boolean; detail: string }

// Defined once in ./hosts — see there for why harvest and verify must share it.
export { OUR_HOSTS, isOurs } from "./hosts"
import { isOurs } from "./hosts"

const PROBE = `
  const imgs = [...document.images].map(i => ({ src: i.currentSrc || i.src, ok: i.naturalWidth > 0 }));
  return {
    text: (document.body ? document.body.innerText : '').trim().length,
    images: imgs.length,
    broken: imgs.filter(i => !i.ok).length,
    brokenSrc: (imgs.find(i => !i.ok) || {}).src || null,
  };
`

export async function verifyExport(
  dir: string,
  opts: { offline?: boolean; baseline?: string | null; minChars?: number; port?: number } = {},
): Promise<{ ok: boolean; checks: VerifyCheck[] }> {
  const minChars = Number(opts.minChars ?? 400)
  const baseline = opts.baseline ?? null
  // The only honest proof of independence: BLOCK our hosts and reload. "No request was made" cannot
  // distinguish an independent page from one that had not needed the network yet.
  const offline = !!opts.offline

  const checks: VerifyCheck[] = []
  let failed = false
  const check = (ok: boolean, label: string, detail: string) => {
    checks.push({ label, ok, detail: detail || "" })
    if (!ok) failed = true
  }

  let srv: Awaited<ReturnType<typeof startStaticServer>> | undefined
  let session: Awaited<ReturnType<typeof launch>> | undefined
  try {
    srv = await startStaticServer(dir, opts.port ?? 0)
    session = await launch()

    const got = await inspect(session, `${srv.url}/`, {
      evaluate: PROBE,
      blockHosts: offline ? isOurs : null,
    })
    const base = baseline ? await inspect(session, baseline, { evaluate: PROBE }) : null

    // A call to an asset that 404s at the source is a dead link the export copied faithfully, not a
    // dependency on our infrastructure.
    const homeAll = got.requests.filter(isOurs)
    const homeDead = homeAll.filter((u) => got.failures.some((f) => f.includes(u)))
    const homeLive = homeAll.filter((u) => !homeDead.includes(u))

    // Against a baseline, "renders" means "renders as much as the source does". A gated page is short
    // on BOTH sides — one measured 182 chars live — and an absolute floor fails a faithful export.
    const renderOk = base
      ? got.value.text >= Math.min(minChars, Math.floor(base.value.text * 0.9))
      : got.value.text >= minChars
    check(
      renderOk,
      "renders",
      base
        ? `${got.value.text} chars here vs ${base.value.text} live`
        : `${got.value.text} chars of body text (floor ${minChars})`,
    )

    // Chrome asks for /favicon.ico on every page that declares no icon link. Nobody wrote that
    // request and no missing favicon ever blanked a page, so counting it is the checker crying wolf
    // — and a checker that cries wolf gets overridden exactly as fast as one that stays silent.
    const realFailures = got.failures.filter((f) => !/\/favicon\.ico\b/.test(f))
    const problems = realFailures.length + got.errors.length
    const baseProblems = base
      ? base.failures.filter((f) => !/\/favicon\.ico\b/.test(f)).length + base.errors.length
      : 0
    check(
      problems <= baseProblems,
      "no new errors or failed requests",
      problems === 0
        ? "clean"
        : base
          ? `${problems} here vs ${baseProblems} live${problems <= baseProblems ? " (same as source)" : ""}: ${realFailures[0] || got.errors[0]}`
          : realFailures[0] || got.errors[0],
    )

    // Independence is the export's own job and is never excused by the baseline.
    check(
      homeLive.length === 0,
      "runs without IRIS Cloud",
      homeLive.length
        ? `${homeLive.length} live call(s): ${homeLive[0].slice(0, 90)}`
        : homeDead.length
          ? `zero live calls (${homeDead.length} dead link(s) copied from the source)`
          : "zero calls",
    )

    const baseBroken = base ? base.value.broken : 0
    check(
      got.value.broken <= baseBroken,
      "images load",
      got.value.broken === 0
        ? `${got.value.images}/${got.value.images}`
        : base
          ? `${got.value.broken} broken here vs ${baseBroken} live${got.value.broken <= baseBroken ? " — SOURCE defect, not the export" : ""}`
          : `${got.value.broken} broken: ${String(got.value.brokenSrc).slice(0, 70)}`,
    )
  } catch (e: any) {
    check(false, "verification threw", String(e?.message ?? e))
  } finally {
    if (session) await session.close()
    if (srv) await srv.stop()
  }

  return { ok: !failed, checks }
}
