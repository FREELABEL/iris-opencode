import { $ } from "bun"

// These `ocBinary` values MUST match packages/opencode/script/build.ts's own local dist
// DIRECTORY naming (pkg.name + os + arch, e.g. "opencode-darwin-arm64") -- that part is
// pkg.name-based and unrelated to how release.yml later renames the packaged .zip/.tar.gz
// for distribution (iris-<target>). The compiled binary FILE inside that directory, though,
// is genuinely named "iris" (packages/opencode/package.json's `"bin": {"iris": "./bin/iris"}`
// wins over build.ts's literal outfile string once Bun's `--compile` step reads it via
// `autoloadPackageJson: true`) -- see prepare.ts/predev.ts, which reference `bin/iris`.
// Verified live via desktop-test-build.yml CI output (2026-08-24). Don't "fix" either half
// of this without re-confirming what a real build actually produces.
export const SIDECAR_BINARIES: Array<{ rustTarget: string; ocBinary: string; assetExt: string }> = [
  {
    rustTarget: "aarch64-apple-darwin",
    ocBinary: "opencode-darwin-arm64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    ocBinary: "opencode-darwin-x64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    ocBinary: "opencode-windows-x64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    ocBinary: "opencode-linux-x64",
    assetExt: "tar.gz",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    ocBinary: "opencode-linux-arm64",
    assetExt: "tar.gz",
  },
]

export const RUST_TARGET = Bun.env.RUST_TARGET

export function getCurrentSidecar(target = RUST_TARGET) {
  if (!target && !RUST_TARGET) throw new Error("RUST_TARGET not set")

  const binaryConfig = SIDECAR_BINARIES.find((b) => b.rustTarget === target)
  if (!binaryConfig) throw new Error(`Sidecar configuration not available for Rust target '${RUST_TARGET}'`)

  return binaryConfig
}

export async function copyBinaryToSidecarFolder(source: string, target = RUST_TARGET) {
  await $`mkdir -p src-tauri/sidecars`
  const dest = `src-tauri/sidecars/iris-cli-${target}${process.platform === "win32" ? ".exe" : ""}`
  await $`cp ${source} ${dest}`

  console.log(`Copied ${source} to ${dest}`)
}
