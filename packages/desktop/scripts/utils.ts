import { $ } from "bun"

// These MUST match packages/opencode/script/build.ts's own local dist directory naming
// (pkg.name + os + arch, e.g. "opencode-darwin-arm64") -- that script hardcodes both the
// dist dir and the compiled binary's filename to "opencode", regardless of how release.yml
// later renames the packaged .zip/.tar.gz for distribution. This is NOT the same thing as
// the iris-<target> names release.yml uses for its uploaded artifacts/archives -- don't
// "fix" these to iris-* without also confirming what build.ts actually emits, or predev.ts
// (local `bun run tauri dev`) breaks looking for a directory that doesn't exist.
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
