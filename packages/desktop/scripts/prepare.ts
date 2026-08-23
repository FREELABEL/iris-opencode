#!/usr/bin/env bun
import { $ } from "bun"

import { copyBinaryToSidecarFolder, getCurrentSidecar } from "./utils"

const sidecarConfig = getCurrentSidecar()

const dir = "src-tauri/target/iris-binaries"

// NOTE: this artifact name/shape matches the old (unused for this fork) publish.yml pipeline,
// not the live release.yml `build` job — that job uploads one artifact per target named
// `iris-<target>` (e.g. `iris-darwin-arm64`) containing a flat iris-<target>.zip/.tar.gz with
// the `iris` binary at its root, not nested under `<ocBinary>/bin/`. This script needs a real
// rewrite (download the per-target artifact, extract the archive) before this package can be
// wired into release.yml — tracked in bloq #503 item #182113.
await $`mkdir -p ${dir}`
await $`gh run download ${Bun.env.GITHUB_RUN_ID} -n iris-cli`.cwd(dir)

await copyBinaryToSidecarFolder(
  `${dir}/${sidecarConfig.ocBinary}/bin/iris${process.platform === "win32" ? ".exe" : ""}`,
)
