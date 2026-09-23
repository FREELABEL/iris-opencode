/**
 * Is the webview's microphone LIVE? (#186525)
 *
 * The probe asks that, not "did they say anything yet". It used to compare the first 400ms of a
 * PUSH-TO-TALK recording against a speech threshold — and nobody has started speaking 400ms
 * after pressing the button. A perfectly good microphone in a quiet room therefore measured
 * "silent", the session cached the sidecar path, and a client got "Recording needs ffmpeg" on a
 * Mac whose webview could record all along.
 *
 * A live capture is never exactly zero: ambient noise and converter dither put something into
 * every buffer. The denied case measured 0.0000 — WKWebView hands back a track that emits
 * literal zeros. So the answerable question is "did ANY signal arrive", and its threshold sits
 * just above zero rather than just below speech.
 */
export const DEAD_SIGNAL = 1e-7

/** Buffers must have arrived AND carried something other than digital silence. */
export function captureIsLive(peak: number, buffers: number): boolean {
  return buffers > 0 && peak > DEAD_SIGNAL
}
