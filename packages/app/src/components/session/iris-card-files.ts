/**
 * Files onto a card (#189797) — the one upload path the card face (drop) and the card editor
 * (pick, paste) share. Each file is its own atomic attach on fl-api (#189791), so two people
 * dropping onto the same card never erase each other's files.
 */
type DoFetch = (path: string, init?: RequestInit) => Promise<Response>

/** A drag carrying files from the desktop, as opposed to a card being dragged across the board. */
export const dragHasFiles = (dt: DataTransfer | null | undefined) => !!dt && Array.from(dt.types ?? []).includes("Files")

/** Files pasted from the clipboard — a screenshot is the common one. */
export function pastedFiles(e: ClipboardEvent): File[] {
  const items = Array.from(e.clipboardData?.items ?? [])
  return items.map((i) => (i.kind === "file" ? i.getAsFile() : null)).filter((f): f is File => !!f)
}

const readAsDataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ""))
    r.onerror = () => reject(r.error ?? new Error("could not read file"))
    r.readAsDataURL(f)
  })

/** Upload each file; says how many landed and, if any did not, why the last one failed. */
export async function uploadCardFiles(
  doFetch: DoFetch,
  itemId: number,
  bloqId: number | undefined,
  files: File[],
  onEach?: (done: number, total: number) => void,
): Promise<{ ok: number; total: number; reason?: string }> {
  let ok = 0
  let reason: string | undefined
  for (const [i, f] of files.entries()) {
    try {
      const data = await readAsDataUrl(f)
      const res = await doFetch(`/iris/item/${itemId}/attachments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: f.name || `pasted-${Date.now()}.png`, type: f.type || undefined, data, bloq: bloqId }),
      })
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; message?: string }
      if (res.ok && j.ok !== false) ok++
      else reason = j.reason ?? j.message ?? `upload failed (${res.status})`
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e)
    }
    onEach?.(i + 1, files.length)
  }
  return { ok, total: files.length, ...(ok < files.length ? { reason: reason ?? "upload failed" } : {}) }
}
