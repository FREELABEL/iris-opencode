import { describe, expect, test } from "bun:test"
import { parseAlsaPcm, parseAvfoundationAudioDevices, resolveCaptureDevice } from "../../src/transcribe/capture"

describe("microphone listing", () => {
  test("ALSA: only capture PCMs, as plughw ids, named by the PCM name", () => {
    // Verbatim /proc/asound/pcm from iris-hive-001 (Dell OptiPlex 7040).
    const pcm = [
      "00-00: ALC3234 Analog : ALC3234 Analog : playback 1 : capture 1",
      "00-02: ALC3234 Alt Analog : ALC3234 Alt Analog : capture 1",
      "00-03: HDMI 0 : HDMI 0 : playback 1",
      "01-00: USB Audio : USB Audio : playback 1 : capture 1",
    ].join("\n")
    expect(parseAlsaPcm(pcm)).toEqual([
      { id: "plughw:0,0", name: "ALC3234 Analog" },
      { id: "plughw:0,2", name: "ALC3234 Alt Analog" },
      { id: "plughw:1,0", name: "USB Audio" },
    ])
  })

  test("avfoundation: audio devices only, names without the index", () => {
    const stderr = [
      "[AVFoundation indev @ 0x7f8] AVFoundation video devices:",
      "[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera",
      "[AVFoundation indev @ 0x7f8] [1] Capture screen 0",
      "[AVFoundation indev @ 0x7f8] AVFoundation audio devices:",
      "[AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone",
      "[AVFoundation indev @ 0x7f8] [1] Shure MV7",
      ': Input/output error',
    ].join("\n")
    expect(parseAvfoundationAudioDevices(stderr)).toEqual(["MacBook Pro Microphone", "Shure MV7"])
  })

  test("no name, or a platform with nothing to resolve against, means the default device", () => {
    expect(resolveCaptureDevice(undefined, "darwin", null)).toBeUndefined()
    expect(resolveCaptureDevice("  ", "linux")).toBeUndefined()
    // No ffmpeg: nothing can be listed, so a named mic cannot be confirmed — record from the default.
    expect(resolveCaptureDevice("Shure MV7", "darwin", null)).toBeUndefined()
  })
})
