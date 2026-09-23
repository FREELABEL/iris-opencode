import { createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { renderMarkdown } from "./iris-item"
import { ARTIFACT_SANDBOX, markdownDocument, parseCsv, sandboxedDocument } from "./iris-artifacts-model"
import { docxHtml, headerRowIndex, readDocx, readXlsx, type Sheet } from "./iris-office"
import type { PromotedFile } from "./iris-promote"

/**
 * One PROMOTED file in Genesis › Artifacts (#186584 / #186585) — a document this session made,
 * shown from where it lives on disk. Nothing is copied into the artifact store.
 *
 * Same trust rules as tool artifacts (ADR-01): anything that becomes HTML — markdown, html, a
 * docx — renders in the allow-scripts-only srcdoc sandbox. Spreadsheets and CSV render as a
 * plain table of text nodes, never as markup.
 */

export interface FileContent {
  type: "text" | "binary"
  content: string
  encoding?: "base64"
  mimeType?: string
}

const MAX_BYTES = 20 * 1024 * 1024
const MAX_RENDER_ROWS = 1000

const bytesOf = (c: FileContent) => {
  if (c.encoding !== "base64") return new TextEncoder().encode(c.content)
  const bin = atob(c.content)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
const textOf = (c: FileContent) => (c.encoding === "base64" ? new TextDecoder().decode(bytesOf(c)) : c.content)
const sizeOf = (c: FileContent) => (c.encoding === "base64" ? Math.floor((c.content.length * 3) / 4) : c.content.length)

type View =
  | { kind: "sheet"; sheets: Sheet[] }
  | { kind: "csv"; rows: string[][] }
  | { kind: "srcdoc"; html: string }
  | { kind: "pdf"; url: string }
  | { kind: "fallback"; reason: string }

export function IrisFileArtifact(props: {
  file: PromotedFile
  revision: string
  read: (path: string) => Promise<FileContent | undefined>
  onOpen?: () => void
}) {
  let pdfUrl: string | undefined
  const release = () => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl)
    pdfUrl = undefined
  }
  onCleanup(release)

  const [view] = createResource(
    () => [props.file.path, props.file.kind, props.revision] as const,
    async ([path, kind]): Promise<View> => {
      const c = await props.read(path)
      if (!c) return { kind: "fallback", reason: "Could not read this file." }
      if (sizeOf(c) > MAX_BYTES) return { kind: "fallback", reason: "Too large to preview here." }
      switch (kind) {
        case "sheet": {
          const r = await readXlsx(bytesOf(c))
          return "error" in r
            ? { kind: "fallback", reason: `Could not read the spreadsheet — ${r.error}.` }
            : { kind: "sheet", sheets: r.sheets }
        }
        case "docx": {
          const r = await readDocx(bytesOf(c))
          return "error" in r
            ? { kind: "fallback", reason: `Could not read the document — ${r.error}.` }
            : { kind: "srcdoc", html: docxHtml(r.blocks) }
        }
        case "csv": {
          const text = textOf(c)
          const rows = path.toLowerCase().endsWith(".tsv")
            ? text
                .split(/\r?\n/)
                .filter(Boolean)
                .map((l) => l.split("\t"))
            : parseCsv(text)
          return { kind: "csv", rows }
        }
        case "markdown":
          return { kind: "srcdoc", html: markdownDocument(renderMarkdown(textOf(c))) }
        case "html":
          return { kind: "srcdoc", html: textOf(c) }
        case "pdf": {
          release()
          pdfUrl = URL.createObjectURL(new Blob([bytesOf(c)], { type: "application/pdf" }))
          return { kind: "pdf", url: pdfUrl }
        }
      }
    },
  )

  const [sheetIndex, setSheetIndex] = createSignal(0)
  const sheet = createMemo(() => {
    const v = view.latest
    if (v?.kind !== "sheet") return undefined
    return v.sheets[Math.min(sheetIndex(), v.sheets.length - 1)]
  })

  /*
   * The header is not always row 1: a sheet can open with a title and notes (headerRowIndex).
   * Those rows show as plain text above the table; the header row is pinned; rows with nothing in
   * them are dropped.
   */
  const Table = (p: { rows: string[][] }) => {
    const h = createMemo(() => headerRowIndex(p.rows))
    const preamble = createMemo(() =>
      h() > 0
        ? p.rows
            .slice(0, h())
            .map((r) => r.filter((c) => c.trim() !== "").join(" · "))
            .filter(Boolean)
        : [],
    )
    const header = createMemo(() => (h() >= 0 ? p.rows[h()] : undefined))
    const body = createMemo(() =>
      p.rows.slice(h() + 1, h() + 1 + MAX_RENDER_ROWS).filter((r) => r.some((c) => c.trim() !== "")),
    )
    return (
      <div class="iris-artifacts__doc iris-file__doc">
        <For each={preamble()}>
          {(line, i) => <p classList={{ "iris-file__title": i() === 0, "iris-file__pre": i() > 0 }}>{line}</p>}
        </For>
        <table class="iris-artifacts__table iris-file__table">
          <Show when={header()}>
            {(row) => (
              <thead>
                <tr>
                  <For each={row()}>{(cell) => <th>{cell}</th>}</For>
                </tr>
              </thead>
            )}
          </Show>
          <tbody>
            <For each={body()}>
              {(row) => (
                <tr>
                  <For each={row}>{(cell) => <td>{cell}</td>}</For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={p.rows.length - h() - 1 > MAX_RENDER_ROWS}>
          <p class="iris-artifacts__note">
            Showing the first {MAX_RENDER_ROWS} of {p.rows.length - h() - 1} rows.
          </p>
        </Show>
      </div>
    )
  }

  return (
    <div class="iris-artifacts__preview" data-file-kind={props.file.kind}>
      <Show when={view.latest} fallback={<p class="iris-artifacts__note">Reading {props.file.name}…</p>}>
        {(v) => (
          <Switch>
            <Match when={v().kind === "sheet" && v()}>
              {(s) => (
                <div class="iris-file__sheet">
                  <Show when={(s() as { sheets: Sheet[] }).sheets.length > 1}>
                    <div class="iris-file__tabs" role="tablist" aria-label="Sheets">
                      <For each={(s() as { sheets: Sheet[] }).sheets}>
                        {(sh, i) => (
                          <button
                            type="button"
                            role="tab"
                            aria-selected={i() === sheetIndex()}
                            onClick={() => setSheetIndex(i())}
                          >
                            {sh.name}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Table rows={sheet()?.rows ?? []} />
                </div>
              )}
            </Match>
            <Match when={v().kind === "csv" && v()}>{(s) => <Table rows={(s() as { rows: string[][] }).rows} />}</Match>
            <Match when={v().kind === "srcdoc" && v()}>
              {(s) => (
                <iframe
                  class="iris-artifacts__frame"
                  title={props.file.name}
                  sandbox={ARTIFACT_SANDBOX}
                  referrerpolicy="no-referrer"
                  srcdoc={sandboxedDocument((s() as { html: string }).html)}
                />
              )}
            </Match>
            {/* The webview's own PDF viewer, from a blob of the file's bytes. */}
            <Match when={v().kind === "pdf" && v()}>
              {(s) => (
                <iframe class="iris-artifacts__frame" title={props.file.name} src={(s() as { url: string }).url} />
              )}
            </Match>
            <Match when={v().kind === "fallback" && v()}>
              {(s) => (
                <div class="iris-artifacts__note">
                  {(s() as { reason: string }).reason}{" "}
                  <Show when={props.onOpen}>
                    <button type="button" class="underline cursor-pointer" onClick={() => props.onOpen?.()}>
                      Open it in its app
                    </button>
                  </Show>
                </div>
              )}
            </Match>
          </Switch>
        )}
      </Show>
    </div>
  )
}
