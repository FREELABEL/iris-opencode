import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Log } from "../../src/util/log"

const mode = async (target: string) => (await fs.stat(target)).mode & 0o777

test.skipIf(process.platform === "win32")("data, log and every log file are private to the user", async () => {
  await fs.chmod(Global.Path.log, 0o755)
  const old = path.join(Global.Path.log, "left-by-an-older-version.log")
  await fs.writeFile(old, "canary", { mode: 0o644 })
  await fs.chmod(old, 0o644)

  await Log.init({ print: false, dev: true })
  const current = path.join(Global.Path.log, "dev.log")

  expect(await mode(Global.Path.data)).toBe(0o700)
  expect(await mode(old)).toBe(0o600)
  expect(await mode(current)).toBe(0o600)
  await fs.rm(old)
})
