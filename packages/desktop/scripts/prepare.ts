#!/usr/bin/env bun
import { $ } from "bun"

import { copyBinaryToSidecarFolder, getCurrentSidecar } from "./utils"

const sidecarConfig = getCurrentSidecar()

const dir = "src-tauri/target/opencode-binaries"

// NOTE: this artifact name/shape (a single "opencode-cli" artifact containing
// <ocBinary>/bin/opencode per target) matches the old, unused-for-this-fork publish.yml
// pipeline -- not the live release.yml `build` job, which uploads one artifact per target
// named `iris-<target>` containing a flat iris-<target>.zip/.tar.gz (whose contents are
// still a binary literally named `opencode`, per packages/opencode/script/build.ts's
// hardcoded outfile -- only the outer archive gets renamed to iris-*, not the binary
// inside it). This script needs a real rewrite (download the per-target artifact, extract
// the archive) before this package can be wired into release.yml -- tracked in bloq #503
// item #182113.
await $`mkdir -p ${dir}`
await $`gh run download ${Bun.env.GITHUB_RUN_ID} -n opencode-cli`.cwd(dir)

await copyBinaryToSidecarFolder(
  `${dir}/${sidecarConfig.ocBinary}/bin/opencode${process.platform === "win32" ? ".exe" : ""}`,
)
