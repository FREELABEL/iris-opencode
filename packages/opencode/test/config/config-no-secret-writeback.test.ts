import { expect, test } from "bun:test"
import path from "path"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const FAKE = "fake-secret-value-for-test-only"

async function loadWith(raw: string, extra?: Record<string, string>) {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "opencode.jsonc"), raw)
      for (const [name, body] of Object.entries(extra ?? {})) await Bun.write(path.join(dir, name), body)
    },
  })
  process.env.IRIS_TEST_FAKE_SECRET = FAKE
  let loaded: any
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      loaded = await Config.get()
    },
  })
  delete process.env.IRIS_TEST_FAKE_SECRET
  return { loaded, onDisk: await Bun.file(path.join(tmp.path, "opencode.jsonc")).text() }
}

test("a missing $schema never writes an {env:} value to disk, and it still loads", async () => {
  const { loaded, onDisk } = await loadWith(
    `{\n  // keep this comment\n  "provider": { "x": { "options": { "apiKey": "{env:IRIS_TEST_FAKE_SECRET}" } } }\n}\n`,
  )
  expect(onDisk).not.toContain(FAKE)
  expect(onDisk).toContain("{env:IRIS_TEST_FAKE_SECRET}")
  expect(onDisk).toContain("// keep this comment")
  expect(onDisk).toContain('"$schema"')
  expect(loaded.provider.x.options.apiKey).toBe(FAKE)
})

test("a missing $schema never writes a {file:} value to disk", async () => {
  const { loaded, onDisk } = await loadWith(
    `{ "provider": { "x": { "options": { "apiKey": "{file:key.txt}" } } } }`,
    { "key.txt": FAKE },
  )
  expect(onDisk).not.toContain(FAKE)
  expect(onDisk).toContain("{file:key.txt}")
  expect(loaded.provider.x.options.apiKey).toBe(FAKE)
})

test("Config.update never writes an {env:} value to disk", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "config.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { x: { options: { apiKey: "{env:IRIS_TEST_FAKE_SECRET}" } } } }),
      )
    },
  })
  process.env.IRIS_TEST_FAKE_SECRET = FAKE
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Config.update({ model: "test/model" } as any)
    },
  })
  delete process.env.IRIS_TEST_FAKE_SECRET
  const onDisk = await Bun.file(path.join(tmp.path, "config.json")).text()
  expect(onDisk).not.toContain(FAKE)
  expect(onDisk).toContain("{env:IRIS_TEST_FAKE_SECRET}")
  expect(onDisk).toContain("test/model")
})
