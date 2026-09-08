import { describe, expect, test } from "bun:test"
import { explainLoadFailure } from "./transcription"

/**
 * The message a user gets when local transcription will not run.
 *
 * MEASURED. A real machine had ffmpeg on PATH that could not load libx265.215.dylib, because
 * Homebrew upgraded x265 to soname 217 without rebuilding ffmpeg. The CLI said, in order:
 *
 *   Local transcription unavailable
 *   ffmpeg conversion failed
 *   Install local transcription: brew install whisper-cpp
 *
 * Three messages, all true, none of them the problem — whisper was installed and working.
 * The dyld error naming the exact library was captured by `stdio: "ignore"` and discarded.
 */
describe("explainLoadFailure", () => {
  const REAL = `dyld[96792]: Library not loaded: /opt/homebrew/opt/x265/lib/libx265.215.dylib
  Referenced from: /opt/homebrew/Cellar/ffmpeg/8.1/bin/ffmpeg
  Reason: tried: '/opt/homebrew/opt/x265/lib/libx265.215.dylib' (no such file)`

  test("names the library that is missing", () => {
    expect(explainLoadFailure(REAL)).toContain("libx265.215.dylib")
  })

  test("gives a command that would actually fix it", () => {
    const out = explainLoadFailure(REAL)!
    expect(out).toContain("brew reinstall ffmpeg")
    // and the right package, derived from the library name rather than guessed
    expect(out).toContain("brew reinstall x265")
  })

  test("explains the CAUSE, not just the symptom", () => {
    // "upgraded without rebuilding" is the sentence that stops someone reinstalling whisper.
    expect(explainLoadFailure(REAL)).toMatch(/upgraded without rebuilding/i)
  })

  test("does not mention whisper — it was never the problem", () => {
    expect(explainLoadFailure(REAL)!.toLowerCase()).not.toContain("whisper")
  })

  test("returns null for an error that is NOT a load failure", () => {
    // A codec problem must not be dressed up as a broken install; that would send someone to
    // reinstall a working ffmpeg, which is the same failure pointed the other way.
    expect(explainLoadFailure("Invalid data found when processing input")).toBeNull()
    expect(explainLoadFailure("")).toBeNull()
  })

  test("handles an unversioned library name without producing a nonsense package", () => {
    const out = explainLoadFailure("dyld: Library not loaded: /usr/lib/libfoo.dylib")!
    expect(out).toContain("libfoo.dylib")
    expect(out).toContain("brew reinstall foo")
  })
})
