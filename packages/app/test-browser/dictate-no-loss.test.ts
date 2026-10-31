import { expect, test } from "bun:test"
import { join } from "node:path"

// The scenarios compile the real composer with a faked recorder, and bun shares its module registry
// across a test run, so they get a process of their own: neither side sees the other's modules.
test("dictating in the composer: nothing said is lost (solo/dictate-no-loss.scenarios.ts)", async () => {
  const app = join(import.meta.dir, "..")
  const run = Bun.spawn(
    [process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts", "./test-browser/solo/dictate-no-loss.scenarios.ts"],
    { cwd: app, stdout: "pipe", stderr: "pipe" },
  )
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  const report = out + err
  expect(report).toContain("18 pass")
  expect({ code, report: code === 0 ? "" : report }).toEqual({ code: 0, report: "" })
}, 60_000)
