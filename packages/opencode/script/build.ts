#!/usr/bin/env bun

import solidPlugin from "../node_modules/@opentui/solid/scripts/solid-plugin"
import path from "path"
import fs from "fs"
import { $ } from "bun"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

import pkg from "../package.json"
import { Script } from "@opencode-ai/script"

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      return true
    })
  : allTargets

/**
 * Refuse to start a build that cannot finish.
 *
 * Each target writes ~175 MB (a ~115 MB compiled binary plus ~36 MB of external source maps),
 * so the default all-targets build is ~1.9 GB — and `bun run build` is what a developer
 * naturally types when they only wanted to test one change locally.
 *
 * Running out of disk PART WAY THROUGH is much worse than not starting: it leaves a half-written
 * dist that looks like a build, and it takes the whole machine to zero free bytes, so the next
 * unrelated file write anywhere fails with ENOSPC. That happened here — an editor save died
 * mid-session with `ENOSPC: no space left on device` and the cause was this script, several
 * minutes earlier and in a different directory.
 *
 * So: measure first, say the number, and point at --single, which almost always what was wanted.
 */
const PER_TARGET_BYTES = 200 * 1024 * 1024 // measured ~175 MB; round up rather than guess low
{
  const need = targets.length * PER_TARGET_BYTES

  // statfs is NOT trustworthy everywhere. On GitHub's macos-15-intel runner this reported
  // 0.0 GB free while `df -h $GITHUB_WORKSPACE` on the very same volume, seconds earlier,
  // reported 185Gi available — and it blocked three consecutive releases (v1.3.181/182/183)
  // with "0.0 GB free" printed directly beneath a log line saying 110Gi. It reads correctly on
  // macOS arm64, so this is platform-specific and not something the caller can fix.
  //
  // A reading of zero is therefore treated as UNKNOWN, not as full. It cannot be literally true
  // at this point in the build anyway: checkout and `bun install` have already written
  // hundreds of megabytes, so a genuinely zero-byte volume would have failed long before here.
  //
  // The guard still does its job — it refuses on a PLAUSIBLE shortfall, which is the case it
  // was written for (a developer typing `bun run build` and filling their laptop). It just no
  // longer converts a broken measurement into a blocked release.
  let free = 0
  try {
    const stat = fs.statfsSync(dir)
    free = Number(stat.bsize) * Number(stat.bavail)
  } catch {
    free = 0
  }

  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`
  const measured = Number.isFinite(free) && free > 0

  console.log(
    measured
      ? `${targets.length} target(s), ~${gb(need)} needed, ${gb(free)} free`
      : `${targets.length} target(s), ~${gb(need)} needed, free space UNKNOWN (statfs unavailable here) — continuing`,
  )

  if (measured && free < need) {
    console.error(
      [
        ``,
        `Not enough disk to build ${targets.length} target(s).`,
        `  needed  ~${gb(need)}`,
        `  free     ${gb(free)}`,
        ``,
        singleFlag
          ? `Free up space and retry.`
          : `For local work build only this machine's target:`,
        singleFlag ? `` : `  bun run build:local      # --single --install, ~${gb(PER_TARGET_BYTES)}`,
        ``,
      ]
        .filter((l) => l !== undefined)
        .join("\n"),
    )
    process.exit(1)
  }
}

await $`rm -rf dist`

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
}
for (const item of targets) {
  const name = [
    pkg.name,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const parserWorker = fs.realpathSync(path.resolve(dir, "./node_modules/@opentui/core/parser.worker.js"))
  const workerPath = "./src/cli/cmd/tui/worker.ts"

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  await Bun.build({
    conditions: ["browser"],
    tsconfig: "./tsconfig.json",
    plugins: [solidPlugin],
    sourcemap: "external",
    external: ["playwright", "electron"],
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      //@ts-ignore (bun types aren't up to date)
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/iris`,
      execArgv: [`--user-agent=iris/${Script.version}`, "--"],
      windows: {},
    },
    entrypoints: ["./src/index.ts", parserWorker, workerPath],
    define: {
      OPENCODE_VERSION: `'${Script.version}'`,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      OPENCODE_WORKER_PATH: workerPath,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
    },
  })

  // Ad-hoc sign macOS binaries so Gatekeeper doesn't SIGKILL them (exit 137)
  // xattr -cr strips com.apple.provenance + quarantine BEFORE signing.
  // Without this, macOS taskgated rejects the binary even with a valid adhoc signature.
  if (item.os === "darwin") {
    await $`xattr -cr dist/${name}/bin/iris`.quiet()
    await $`codesign --force --deep --sign - dist/${name}/bin/iris`
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: Script.version,
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

// Auto-install to ~/.iris/bin/ on macOS when --install flag is passed
// Handles xattr + codesign to prevent SIGKILL (exit 137) on copy
const installFlag = process.argv.includes("--install")
if (installFlag && process.platform === "darwin") {
  const home = process.env.HOME ?? ""
  const target = `${home}/.iris/bin/iris`
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const source = `dist/opencode-darwin-${arch}/bin/iris`
  if (fs.existsSync(source)) {
    // The install is a SECOND ~115 MB copy, written after the build has already reported success
    // — so a disk that survived the build can still die here, at the point everything upstream
    // says "done". Check against the real size of what we are about to copy.
    const size = fs.statSync(source).size
    const st = fs.statfsSync(home)
    const avail = st.bsize * st.bavail
    if (avail < size * 1.2) {
      console.error(
        `\nBuilt, but NOT installed: ${(size / 1024 ** 2).toFixed(0)} MB to copy, ` +
          `${(avail / 1024 ** 2).toFixed(0)} MB free on ${home}.\n` +
          `The binary is at ${source} — free space and copy it yourself.\n`,
      )
      process.exit(1)
    }
    await $`mkdir -p ${home}/.iris/bin`
    await $`cp -f ${source} ${target}`
    await $`xattr -cr ${target}`.quiet()
    await $`codesign --force --deep --sign - ${target}`
    console.log(`\nInstalled to ${target} (signed)`)
  }
}

export { binaries }
