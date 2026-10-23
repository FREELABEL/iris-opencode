import { describe, expect, test } from "bun:test"
import { localWhisperInstallHint } from "./transcription"

// #188318: the install advice used to be "brew install whisper-cpp" on every OS, including
// Linux Hive nodes that have no brew — a dead end under the sovereign policy.
describe("local whisper install hint names a path this OS can take", () => {
  test("macOS keeps Homebrew", () => {
    expect(localWhisperInstallHint("darwin")).toBe("brew install whisper-cpp")
  })
  test("Linux never says brew, and names the built-in installer", () => {
    const hint = localWhisperInstallHint("linux")
    expect(hint).not.toContain("brew")
    expect(hint).toContain("iris transcribe --install-local")
  })
  test("anything else points at the official releases", () => {
    expect(localWhisperInstallHint("win32")).toContain("github.com/ggml-org/whisper.cpp/releases")
  })
})
