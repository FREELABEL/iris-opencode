import { $ } from "bun"

import { copyBinaryToSidecarFolder, getCurrentSidecar } from "./utils"

const RUST_TARGET = Bun.env.TAURI_ENV_TARGET_TRIPLE

const sidecarConfig = getCurrentSidecar(RUST_TARGET)

const binaryPath = `../opencode/dist/${sidecarConfig.ocBinary}/bin/iris${process.platform === "win32" ? ".exe" : ""}`

await $`cd ../opencode && bun run build --single`

await copyBinaryToSidecarFolder(binaryPath, RUST_TARGET)

// macOS dictation records through the iris-mic helper (tauri.macos.conf.json lists it as an externalBin,
// so a dev run needs the file staged too). Other platforms have no helper.
if (process.platform === "darwin" && RUST_TARGET) {
  await $`sh ../opencode/native/macos-mic/build-sidecar.sh ${RUST_TARGET} src-tauri/sidecars`
}
