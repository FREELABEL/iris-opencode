import fs from "fs"
import { spawn } from "child_process"
import { shouldRetrySpec } from "./reachr-core"

/**
 * Run one of the Freelabel Playwright specs (Instagram / LinkedIn scrapers, the inbox scan) the
 * way every reachr lane does: visible browser, output captured, result read from RESULT_FILE.
 *
 * ONE RETRY, FOR ONE FAILURE. Measured 2026-09-18: 3 of 9 runs from the CLI died on the FIRST
 * navigation with "Target page, context or browser has been closed", within seconds; the same
 * command straight after passed, and so did every direct run. It was always the first run after
 * an idle spell. So a run that (a) produced no result file, (b) says the browser closed, and (c)
 * died fast is retried once. Anything else — a login wall, a timeout, a failure after the scan
 * wrote its result — is reported as it happened, never retried away. Nothing is written by the
 * specs before their result file exists, so a retry cannot repeat a write.
 */
export async function runSpec(o: {
  root: string
  spec: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  resultFile: string
}): Promise<{ code: number; text: string; attempts: number }> {
  const once = () =>
    new Promise<{ code: number; text: string }>((resolve) => {
      const child = spawn("npx", ["playwright", "test", o.spec, "--headed", "--timeout", String(o.timeoutMs)], {
        cwd: o.root,
        env: o.env,
      })
      let text = ""
      child.stdout.on("data", (d) => (text += d))
      child.stderr.on("data", (d) => (text += d))
      child.on("close", (code) => resolve({ code: code ?? 1, text }))
      child.on("error", (e) => resolve({ code: 1, text: String(e) }))
    })

  const started = Date.now()
  const first = await once()
  const retry = shouldRetrySpec({ resultFileExists: fs.existsSync(o.resultFile), text: first.text, elapsedMs: Date.now() - started })
  if (!retry) return { ...first, attempts: 1 }
  await new Promise((r) => setTimeout(r, 5000)) // let the dead browser finish tearing down
  const second = await once()
  return { ...second, attempts: 2 }
}
