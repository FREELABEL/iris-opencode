#!/usr/bin/env bun
import { $ } from "bun"

import { copyBinaryToSidecarFolder, getCurrentSidecar } from "./utils"

const sidecarConfig = getCurrentSidecar()

const dir = "src-tauri/target/opencode-binaries"

// NOTE: this artifact name/shape (a single "opencode-cli" artifact containing
// <ocBinary>/bin/iris per target) matches the old, unused-for-this-fork publish.yml
// pipeline -- not the live release.yml `build` job, which uploads one artifact per target
// named `iris-<target>` containing a flat iris-<target>.zip/.tar.gz. Verified live (2026-08-24,
// desktop-test-build.yml CI run): the dist DIRECTORY name is pkg.name-based ("opencode-<target>"),
// but the compiled binary FILE inside it is genuinely named "iris" -- packages/opencode's
// package.json has `"bin": {"iris": "./bin/iris"}`, and Bun's `--compile` step (with
// `autoloadPackageJson: true`) honors that over the literal `outfile` string in build.ts.
// This script still needs a real rewrite (download the per-target artifact, extract the
// archive) before this package can be wired into release.yml -- tracked in bloq #503 item
// #182113.
await $`mkdir -p ${dir}`
await $`gh run download ${Bun.env.GITHUB_RUN_ID} -n opencode-cli`.cwd(dir)

await copyBinaryToSidecarFolder(
  `${dir}/${sidecarConfig.ocBinary}/bin/iris${process.platform === "win32" ? ".exe" : ""}`,
)
