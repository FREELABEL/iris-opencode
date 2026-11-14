#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const { binaries } = await import("./build.ts")
{
  const name = `${pkg.name}-${process.platform}-${process.arch}`
  console.log(`smoke test: running dist/${name}/bin/iris --version`)
  await $`./dist/${name}/bin/iris --version`

  // The COMPILED binary must be able to answer a discovery query.
  //
  // v1.3.156 shipped `iris find` with the capability index loaded purely by filesystem path.
  // That works under `bun run src/index.ts`, which is how it was developed and tested, and
  // fails on every installed binary — `bun build --compile` bundles static imports but not
  // files merely read with fs, so the index existed nowhere in the artifact. Dev was the one
  // surface incapable of exposing the bug, and `--version` was too shallow to notice.
  //
  // Run from a neutral cwd (/) so a stray capabilities.json in the build tree cannot fake a
  // pass, and assert on the RESULT rather than the exit code — printing "not found" and
  // exiting 1 is the failure this is here to catch.
  console.log(`smoke test: capability discovery in the compiled binary`)
  const found = await $`./dist/${name}/bin/iris find "genesis bespoke html page" --json`.cwd("/").text()
  const parsed = JSON.parse(found)
  if (!parsed.matched || !parsed.results?.length) {
    throw new Error(`compiled binary cannot search capabilities — refusing to publish. Got: ${found.slice(0, 200)}`)
  }
  console.log(`  ok — ${parsed.matched} capabilities reachable from the binary`)
}

await $`mkdir -p ./dist/${pkg.name}`
await $`cp -r ./bin ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: "iris-code",
      bin: {
        iris: `./bin/iris`,
      },
      scripts: {
        postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
      },
      version: Script.version,
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

const tags = [Script.channel]

const tasks = Object.entries(binaries).map(async ([name]) => {
  if (process.platform !== "win32") {
    await $`chmod -R 755 .`.cwd(`./dist/${name}`)
  }
  await $`bun pm pack`.cwd(`./dist/${name}`)
  for (const tag of tags) {
    await $`npm publish *.tgz --access public --tag ${tag}`.cwd(`./dist/${name}`)
  }
})
await Promise.all(tasks)
for (const tag of tags) {
  await $`cd ./dist/${pkg.name} && bun pm pack && npm publish *.tgz --access public --tag ${tag}`
}

if (!Script.preview) {
  // Create archives for GitHub release
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }

  const image = "ghcr.io/freelabel/iris-code"
  const platforms = "linux/amd64,linux/arm64"
  const tags = [`${image}:${Script.version}`, `${image}:latest`]
  const tagFlags = tags.flatMap((t) => ["-t", t])
  await $`docker buildx build --platform ${platforms} ${tagFlags} --push .`
}
