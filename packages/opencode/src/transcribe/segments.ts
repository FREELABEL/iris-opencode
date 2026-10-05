import { wrapPcmAsWav } from "./capture"

/**
 * Long recordings in pieces the platform will accept.
 *
 * The platform refuses uploads over 25 MB (~13.5 minutes of 16 kHz mono PCM16), and background
 * recordings run up to an hour. So a held recording longer than SEGMENT_SECONDS is transcribed as
 * consecutive WAV segments and the text joined. Only the 16 kHz mono 16-bit WAV that both capture
 * paths produce is split; anything else is passed through whole, exactly as before.
 */
export const SEGMENT_SECONDS = 300

export function splitWav(audio: Uint8Array, segmentSeconds = SEGMENT_SECONDS): Uint8Array[] {
  const format = wavFormat(audio)
  if (!format) return [audio]
  const pcm = audio.subarray(format.dataOffset, format.dataOffset + format.dataBytes)
  const bytesPerSegment = segmentSeconds * 16000 * 2
  if (pcm.byteLength <= bytesPerSegment) return [audio]
  const count = Math.ceil(pcm.byteLength / bytesPerSegment)
  return Array.from({ length: count }, (_, i) =>
    wrapPcmAsWav(pcm.subarray(i * bytesPerSegment, Math.min(pcm.byteLength, (i + 1) * bytesPerSegment))),
  )
}

/** 16 kHz mono PCM16 WAV -> where its samples are; undefined for any other audio. */
function wavFormat(audio: Uint8Array) {
  if (audio.byteLength < 44) return undefined
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  const tag = (offset: number) => String.fromCharCode(...audio.subarray(offset, offset + 4))
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined
  const pcm = view.getUint16(20, true) === 1
  const mono = view.getUint16(22, true) === 1
  const rate = view.getUint32(24, true) === 16000
  const bits = view.getUint16(34, true) === 16
  if (!pcm || !mono || !rate || !bits || tag(36) !== "data") return undefined
  return { dataOffset: 44, dataBytes: Math.min(view.getUint32(40, true), audio.byteLength - 44) }
}
