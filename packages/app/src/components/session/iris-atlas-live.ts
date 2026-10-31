/**
 * Atlas, live (#189767) — the panel's end of GET /iris/atlas/:bloqID/live.
 *
 * The stream carries no board data, only "it changed"; the panel re-reads the board through the
 * same route it always uses, so there is one path from fl-api to rows.
 */

export type LiveState = "off" | "polling" | "instant"

/** Split a server-sent-events body into (event, data) pairs until it ends or is aborted. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: any) => void,
): Promise<void> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buf += dec.decode(value, { stream: true })
    let cut: number
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, cut)
      buf = buf.slice(cut + 2)
      let event = "message"
      let data = ""
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) data += line.slice(5).trimStart()
      }
      let parsed: unknown = {}
      try {
        parsed = data ? JSON.parse(data) : {}
      } catch {}
      onEvent(event, parsed)
    }
    if (done) return
  }
}

/** What the toolbar says about it — the promise a live board makes has to be visible. */
export function liveLabel(s: LiveState): { text: string; title: string } {
  if (s === "instant") return { text: "Live", title: "Changes appear as they happen." }
  if (s === "polling") return { text: "Live", title: "Changes by anyone — you, a teammate or an agent — appear within about 10 seconds." }
  return { text: "Paused", title: "Not watching for changes right now. The board reloads when you come back to it." }
}
