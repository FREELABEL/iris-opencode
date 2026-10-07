import { wrapPcmAsWav } from "./capture"
import { frameLoudness } from "./vad"

/**
 * Long recordings in pieces the platform will accept.
 *
 * The platform refuses uploads over 25 MB (~13.5 minutes of 16 kHz mono PCM16), and background
 * recordings run up to an hour. So a held recording longer than SEGMENT_SECONDS is transcribed as
 * consecutive WAV segments and the text joined. Only the 16 kHz mono 16-bit WAV that both capture
 * paths produce is split; anything else is passed through whole, exactly as before.
 *
 * Each cut lands in a PAUSE when there is one. A cut at a fixed byte offset lands mid-word as
 * often as not, and both engines then mis-hear the half-word on each side of the seam. So the cut
 * moves back to the quietest 30 ms in the last CUT_SEARCH_SECONDS before the boundary — but only
 * when that moment is clearly quieter than its surroundings; in steady audio it stays put.
 * Segments therefore never exceed SEGMENT_SECONDS, which is what keeps them under the limit.
 */
export const SEGMENT_SECONDS = 300
const CUT_SEARCH_SECONDS = 20
/** A pause must be this much quieter than the window's median to be worth moving the cut for. */
const PAUSE_BELOW_MEDIAN_DB = 6

export function splitWav(audio: Uint8Array, segmentSeconds = SEGMENT_SECONDS): Uint8Array[] {
  const format = wavFormat(audio)
  if (!format) return [audio]
  const pcm = audio.subarray(format.dataOffset, format.dataOffset + format.dataBytes)
  const bytesPerSegment = segmentSeconds * 16000 * 2
  if (pcm.byteLength <= bytesPerSegment) return [audio]
  const search = Math.min(CUT_SEARCH_SECONDS, segmentSeconds / 5) * 16000 * 2
  const parts: Uint8Array[] = []
  let start = 0
  while (pcm.byteLength - start > bytesPerSegment) {
    const end = quietestCut(pcm, start + bytesPerSegment - search, start + bytesPerSegment)
    parts.push(wrapPcmAsWav(pcm.subarray(start, end)))
    start = end
  }
  parts.push(wrapPcmAsWav(pcm.subarray(start)))
  return parts
}

/** Byte offset in [from, to] to cut at: the middle of the quietest frame, or `to` if nothing stands out. */
function quietestCut(pcm: Uint8Array, from: number, to: number) {
  const db = frameLoudness(pcm.subarray(from, to))
  if (db.length < 3) return to
  let quietest = 0
  for (let i = 1; i < db.length; i++) if (db[i]! < db[quietest]!) quietest = i
  const median = Float64Array.from(db).sort()[Math.floor(db.length / 2)]!
  if (db[quietest]! > median - PAUSE_BELOW_MEDIAN_DB) return to
  // Middle of the frame, on a sample boundary.
  return from + (quietest * 480 + 240) * 2
}

/** 16 kHz mono PCM16 WAV -> where its samples are; undefined for any other audio. */
export function wavFormat(audio: Uint8Array) {
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
