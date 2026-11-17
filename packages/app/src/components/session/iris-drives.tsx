import { createEffect, createMemo, createResource, createSignal, For, on, Show, type JSX } from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import "./iris-drives.css"
import {
  baseName,
  countBy,
  driveMeta,
  emptyDrive,
  findingMeta,
  findingsUnder,
  fmtCount,
  fmtDate,
  fmtGb,
  fmtKb,
  folderMeta,
  foldersOf,
  FULL_PAGE_URL,
  matches,
  moveSelection,
  neverScanned,
  scanCommand,
  statusTone,
  type Drive,
  type DriveFinding,
  type DriveFolder,
  type DrivesPayload,
  type FindingsPayload,
  type Segment,
} from "./iris-drives-model"

/**
 * Drives (#193705) — the person's catalogued drives, inside the IRIS panel.
 *
 * DESIGNED FOR 360px, NOT FOR A WINDOW. The panel clamps at 360 (iris-shell.tsx) and usually sits
 * near 460. The full page (/p/iris-drives-files) is a 3-column Finder needing ~824px, so this is not
 * that page made smaller: one column, drill-in, a sheet for detail. Study: heyiris.io/p/iris-drives-panel.
 *
 *   Level 1  every drive
 *   Level 2  one drive — Folders / Findings / Info; chips switch drive in one tap
 *   Level 3  one folder — the findings under it
 *   Sheet    any finding, over the list, dismissible
 *
 * ATLAS ONLY. Nothing here reads the disk or opens a path: a path is valid only on the machine its
 * drive is plugged into. Findings are fetched per drive when first needed, never on first paint.
 */
type Fetch = (path: string, init?: RequestInit) => Promise<Response>
type Row =
  | { kind: "drive"; drive: Drive }
  | { kind: "folder"; folder: DriveFolder }
  | { kind: "finding"; finding: DriveFinding }

function Ic(props: { name: IconProps["name"] }) {
  return (
    <span class="iris-drv-ic" aria-hidden="true">
      <Icon name={props.name} size="small" />
    </span>
  )
}

export function IrisDrives(props: { doFetch: Fetch; openExternal?: (url: string) => void }) {
  const readJson = async <T,>(path: string): Promise<T> => {
    const res = await props.doFetch(path)
    const body = (await res.json().catch(() => null)) as T | null
    if (!body) throw new Error(`HTTP ${res.status}`)
    return body
  }

  // "no data bridge": the engine itself did not answer — distinct from the platform not answering.
  const [data, { refetch }] = createResource(async (): Promise<DrivesPayload & { bridge: boolean }> => {
    try {
      return { ...(await readJson<DrivesPayload>("/iris/drives")), bridge: true }
    } catch (e: any) {
      return { measured: false, reason: e?.message ?? String(e), state: "unreachable", drives: [], folders: [], bridge: false }
    }
  })

  const [driveId, setDriveId] = createSignal<string>()
  const [folder, setFolder] = createSignal<string>()
  const [segment, setSegment] = createSignal<Segment>("folders")
  const [query, setQuery] = createSignal("")
  const [searching, setSearching] = createSignal(false)
  const [sel, setSel] = createSignal(-1)
  const [sheet, setSheet] = createSignal<DriveFinding>()
  const [note, setNote] = createSignal<string>()
  let searchEl: HTMLInputElement | undefined
  let listEl: HTMLDivElement | undefined
  let rootEl: HTMLDivElement | undefined

  const drives = () => data()?.drives ?? []
  const drive = createMemo(() => drives().find((d) => d.id === driveId()))
  const driveFolders = createMemo(() => (drive() ? foldersOf(drive()!.id, data()?.folders ?? []) : []))

  /*
   * FINDINGS, LAZILY, PER DRIVE. Pages accumulate in a cache keyed by drive so going back and forth
   * does not refetch. Asked for only when the Findings segment or a folder is open.
   */
  type FindingsCache = { rows: DriveFinding[]; page: number; total: number | null; hasMore: boolean; loading: boolean; error?: string }
  const [cache, setCache] = createSignal<Record<string, FindingsCache>>({})
  const findingsFor = (id?: string) => (id ? cache()[id] : undefined)
  const loadFindings = async (id: string, all = false) => {
    const cur = cache()[id]
    if (cur?.loading || (cur && !cur.hasMore)) return
    setCache((c) => ({ ...c, [id]: { ...(cur ?? { rows: [], page: 0, total: null, hasMore: true }), loading: true, error: undefined } }))
    let state = cache()[id]!
    // Bounded: all=true pages through at most 10 pages (1,000 findings) for a folder view.
    for (let i = 0; i < (all ? 10 : 1) && state.hasMore; i++) {
      try {
        const p = await readJson<FindingsPayload>(`/iris/drives/findings?drive=${encodeURIComponent(id)}&page=${state.page + 1}`)
        if (!p.measured) {
          state = { ...state, loading: false, error: p.reason ?? "could not read findings" }
          break
        }
        state = { rows: [...state.rows, ...p.findings], page: p.page, total: p.total, hasMore: p.hasMore, loading: true }
      } catch (e: any) {
        state = { ...state, error: e?.message ?? String(e) }
        break
      }
      setCache((c) => ({ ...c, [id]: state }))
    }
    setCache((c) => ({ ...c, [id]: { ...state, loading: false } }))
  }
  createEffect(
    on([driveId, segment, folder], ([id, seg, f]) => {
      if (id && (seg === "findings" || f)) void loadFindings(id, !!f)
    }),
  )

  // Anything that changes the list resets the selection; leaving a scope closes the sheet.
  createEffect(on([driveId, folder, segment, query], () => setSel(-1)))
  createEffect(on([driveId, folder], () => setSheet(undefined)))

  const openDrive = (id: string) => {
    setDriveId(id)
    setFolder(undefined)
    setSegment("folders")
    setQuery("")
  }
  /** Back returns to the previous scope: folder → drive → every drive. */
  const back = () => {
    if (sheet()) return setSheet(undefined)
    if (folder()) return setFolder(undefined)
    setDriveId(undefined)
    setQuery("")
  }

  const rows = createMemo<Row[]>(() => {
    const q = query()
    if (!drive()) return drives().filter((d) => matches(q, d.label, d.kind, d.node)).map((d) => ({ kind: "drive", drive: d }))
    if (folder()) {
      return findingsUnder(folder()!, findingsFor(drive()!.id)?.rows ?? [])
        .filter((f) => matches(q, f.path, f.kind, f.status))
        .map((f) => ({ kind: "finding", finding: f }))
    }
    if (segment() === "folders") return driveFolders().filter((f) => matches(q, f.folder, f.kinds)).map((f) => ({ kind: "folder", folder: f }))
    if (segment() === "findings") {
      return (findingsFor(drive()!.id)?.rows ?? []).filter((f) => matches(q, f.path, f.kind, f.status)).map((f) => ({ kind: "finding", finding: f }))
    }
    return []
  })

  const open = (r: Row) => {
    if (r.kind === "drive") openDrive(r.drive.id)
    else if (r.kind === "folder") {
      setFolder(r.folder.folder)
      setQuery("")
    } else setSheet(r.finding)
  }

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNote(`Copied ${what}`)
    } catch {
      setNote(text)
    }
    setTimeout(() => setNote(undefined), 2400)
  }
  const openFull = () => (props.openExternal ? props.openExternal(FULL_PAGE_URL) : window.open(FULL_PAGE_URL, "_blank", "noopener"))

  const onKey = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement
    if (e.key === "Escape") {
      if (sheet()) setSheet(undefined)
      else if (query() || searching()) {
        setQuery("")
        setSearching(false)
        rootEl?.focus()
      } else return
      e.preventDefault()
      return
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      setSel((s) => moveSelection(s, e.key === "ArrowDown" ? 1 : -1, rows().length))
      listEl?.querySelector<HTMLElement>(`[data-index="${sel()}"]`)?.scrollIntoView({ block: "nearest" })
      return
    }
    if (e.key === "Enter" && sel() >= 0 && rows()[sel()]) {
      e.preventDefault()
      open(rows()[sel()])
      return
    }
    if (!typing && (e.key === "Backspace" || (e.key === "ArrowLeft" && e.altKey)) && driveId()) {
      e.preventDefault()
      back()
    }
  }

  const title = () => {
    if (!drive()) return "Drives"
    return folder() ? `${drive()!.label} / ${folder()}` : drive()!.label
  }
  const findingsCount = () => {
    const c = findingsFor(drive()?.id)
    return c?.total ?? drive()?.sensitiveFiles ?? null
  }

  return (
    <div class="iris-drv" ref={rootEl} tabIndex={-1} onKeyDown={onKey} data-level={folder() ? 3 : drive() ? 2 : 1}>
      <header class="iris-drv-bar">
        <Show when={drive()}>
          <button class="iris-drv-icon-btn" aria-label="Back" title="Back" onClick={back}>
            <Icon name="chevron-left" size="small" />
          </button>
        </Show>
        <div class="iris-drv-title" title={title()}>
          <Show when={folder()} fallback={title()}>
            <span class="iris-drv-crumb">{drive()!.label} /</span> {folder()}
          </Show>
        </div>
        <Show when={data()?.state === "ok" && drives().length}>
          <button
            class="iris-drv-icon-btn"
            aria-label="Search"
            title="Search"
            aria-pressed={searching()}
            onClick={() => {
              setSearching((s) => !s)
              if (searching()) queueMicrotask(() => searchEl?.focus())
              else setQuery("")
            }}
          >
            <Icon name="magnifying-glass" size="small" />
          </button>
        </Show>
        <button class="iris-drv-icon-btn" aria-label="Open the full Drives page" title="Open the full Drives page" onClick={openFull}>
          <Icon name="square-arrow-top-right" size="small" />
        </button>
      </header>

      <Show when={searching()}>
        <div class="iris-drv-searchwrap">
          <label class="iris-drv-search">
            <Ic name="magnifying-glass" />
            <input
              ref={searchEl}
              value={query()}
              placeholder={folder() ? "Search this folder" : drive() ? `Search ${drive()!.label}` : "Search drives"}
              aria-label="Search"
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </label>
        </div>
      </Show>

      <Show when={!data.loading} fallback={<div class="iris-drv-loading"><Spinner class="iris-drv-spin" /> Reading your drives…</div>}>
        <Show when={data()?.state === "ok" && drives().length} fallback={<TopState data={data()} retry={refetch} copy={copy} />}>
          <Show when={drive()}>
            <div class="iris-drv-chips" role="tablist" aria-label="Drives">
              <For each={drives()}>
                {(d) => (
                  <button class="iris-drv-chip" role="tab" aria-selected={d.id === driveId()} onClick={() => openDrive(d.id)}>
                    {d.label}
                  </button>
                )}
              </For>
            </div>
            <Show when={!folder()}>
              <div class="iris-drv-segs" role="tablist" aria-label="View">
                <button class="iris-drv-seg" role="tab" aria-selected={segment() === "folders"} onClick={() => setSegment("folders")}>
                  Folders <span>{driveFolders().length}</span>
                </button>
                <button class="iris-drv-seg" role="tab" aria-selected={segment() === "findings"} onClick={() => setSegment("findings")}>
                  Findings <span>{fmtCount(findingsCount())}</span>
                </button>
                <button class="iris-drv-seg" role="tab" aria-selected={segment() === "info"} onClick={() => setSegment("info")}>
                  Info
                </button>
              </div>
            </Show>
          </Show>

          <div class="iris-drv-list" ref={listEl} role="listbox" aria-label={title()}>
            <Show when={drive() && neverScanned(drive()!)}>
              <DriveState
                title="This drive hasn't been scanned"
                body="It's catalogued, but nothing on it has been read yet. Scan it on the machine it's plugged into."
                action="Copy scan command"
                onAction={() => copy(scanCommand(drive()!), "the scan command")}
              />
            </Show>
            <Show when={drive() && emptyDrive(drive()!, driveFolders()) && segment() !== "info" && !folder()}>
              <DriveState
                title="Nothing catalogued on this drive"
                body="The last scan found no project folders or files. If that's wrong, scan it again where it's plugged in."
                action="Copy scan command"
                onAction={() => copy(scanCommand(drive()!), "the scan command")}
              />
            </Show>
            <Show when={drive() && segment() === "info" && !folder()}>
              <DriveInfo drive={drive()!} folders={driveFolders()} findings={findingsFor(drive()!.id)?.rows ?? []} />
            </Show>
            <For each={rows()}>
              {(r, i) => (
                <RowView
                  row={r}
                  index={i()}
                  selected={sel() === i() || (r.kind === "finding" && sheet()?.id === r.finding.id)}
                  onClick={() => {
                    setSel(i())
                    open(r)
                  }}
                />
              )}
            </For>
            <FindingsFooter
              show={!!drive() && (segment() === "findings" || !!folder())}
              state={findingsFor(drive()?.id)}
              shown={rows().length}
              filtered={!!query()}
              folder={folder()}
              more={() => drive() && loadFindings(drive()!.id, !!folder())}
            />
            <Show when={query() && rows().length === 0 && (drive() ? segment() !== "info" : true)}>
              <div class="iris-drv-weak iris-drv-pad">Nothing matches “{query()}”.</div>
            </Show>
          </div>

          <Show when={sheet()}>
            {(f) => (
              <section class="iris-drv-sheet" aria-label="Finding">
                <div class="iris-drv-sheet-hd">
                  <span class="iris-drv-sheet-nm" title={f().path}>{baseName(f().path)}</span>
                  <span class="iris-drv-pill" data-tone={statusTone(f().status)}>{f().status ?? "—"}</span>
                  <button class="iris-drv-icon-btn" aria-label="Close" title="Close (Esc)" onClick={() => setSheet(undefined)}>
                    <Icon name="close-small" size="small" />
                  </button>
                </div>
                <dl class="iris-drv-kv">
                  <dt>Kind</dt>
                  <dd>{f().kind ?? "—"}</dd>
                  <dt>Drive</dt>
                  <dd>
                    {drive()?.label} · {f().driveEncrypted ? "encrypted" : "not encrypted"}
                  </dd>
                  <dt>Path</dt>
                  <dd class="iris-drv-mono">{f().path}</dd>
                  <dt>Size</dt>
                  <dd class="iris-drv-mono">{fmtKb(f().sizeKb)}</dd>
                  <dt>Found</dt>
                  <dd class="iris-drv-mono">{fmtDate(f().found)}</dd>
                </dl>
                <div class="iris-drv-sheet-actions">
                  <button class="iris-drv-btn" onClick={() => copy(f().path, "the path")}>
                    <Ic name="copy" /> Copy path
                  </button>
                  <button class="iris-drv-btn" onClick={openFull}>
                    <Ic name="square-arrow-top-right" /> Open full page
                  </button>
                </div>
              </section>
            )}
          </Show>

          <footer class="iris-drv-foot">
            <Show
              when={drive()}
              fallback={
                <>
                  <span>{drives().length} drives</span>
                  <span>{fmtCount(drives().reduce((n, d) => n + (d.sensitiveFiles ?? 0), 0))} findings</span>
                  <span>{drives().filter((d) => !d.encrypted).length} unencrypted</span>
                </>
              }
            >
              <span>{drive()!.encrypted ? "encrypted" : "not encrypted"}</span>
              <span>{neverScanned(drive()!) ? "never scanned" : `scanned ${fmtDate(drive()!.lastScanned)}`}</span>
              <Show when={drive()!.lastSeenOn}>
                <span>on {drive()!.lastSeenOn}</span>
              </Show>
            </Show>
          </footer>
        </Show>
      </Show>
      <Show when={note()}>
        <div class="iris-drv-toast" role="status">
          {note()}
        </div>
      </Show>
    </div>
  )
}

function RowView(props: { row: Row; index: number; selected: boolean; onClick: () => void }) {
  const r = props.row
  const icon: IconProps["name"] = r.kind === "drive" ? "disk" : r.kind === "folder" ? "folder" : "open-file"
  const name = r.kind === "drive" ? r.drive.label : r.kind === "folder" ? r.folder.folder : baseName(r.finding.path)
  const meta = r.kind === "drive" ? driveMeta(r.drive) : r.kind === "folder" ? folderMeta(r.folder) : findingMeta(r.finding)
  const trail = (): JSX.Element => {
    if (r.kind === "finding") return <span class="iris-drv-pill" data-tone={statusTone(r.finding.status)}>{r.finding.status ?? "—"}</span>
    const n = r.kind === "drive" ? r.drive.sensitiveFiles : r.folder.sensitiveFiles
    if (r.kind === "drive" && neverScanned(r.drive)) return <span class="iris-drv-pill" data-tone="muted">not scanned</span>
    return n ? (
      <span class="iris-drv-count" title={`${n} sensitive files`}>
        {fmtCount(n)}
      </span>
    ) : null
  }
  return (
    <button
      class="iris-drv-row"
      role="option"
      data-index={props.index}
      aria-selected={props.selected}
      title={r.kind === "finding" ? r.finding.path : name}
      onClick={props.onClick}
    >
      <span class="iris-drv-row-ic">
        <Icon name={icon} size="small" />
      </span>
      <span class="iris-drv-row-body">
        <span class="iris-drv-row-n">{name}</span>
        <span class="iris-drv-row-m">{meta}</span>
      </span>
      {trail()}
      <Show when={r.kind !== "finding"}>
        <span class="iris-drv-chev" aria-hidden="true">
          <Icon name="chevron-right" size="small" />
        </span>
      </Show>
    </button>
  )
}

function DriveInfo(props: { drive: Drive; folders: DriveFolder[]; findings: DriveFinding[] }) {
  const d = props.drive
  const usedPct = () => (d.usedGb != null && d.sizeGb ? Math.min(100, (d.usedGb / d.sizeGb) * 100) : null)
  return (
    <div class="iris-drv-info">
      <Show when={usedPct() != null}>
        <div class="iris-drv-meter" role="img" aria-label={`${fmtGb(d.usedGb)} used of ${fmtGb(d.sizeGb)}`}>
          <span style={{ width: `${usedPct()}%` }} />
        </div>
        <div class="iris-drv-meter-cap iris-drv-mono">
          {fmtGb(d.usedGb)} used · {fmtGb(d.freeGb)} free · {fmtGb(d.sizeGb)}
        </div>
      </Show>
      <dl class="iris-drv-kv">
        <dt>Kind</dt>
        <dd>{d.kind ?? "—"}</dd>
        <dt>Encrypted</dt>
        <dd>{d.encrypted ? "yes" : "no"}</dd>
        <dt>Files</dt>
        <dd class="iris-drv-mono">{fmtCount(d.files)}</dd>
        <dt>Folders</dt>
        <dd class="iris-drv-mono">{fmtCount(d.folders ?? props.folders.length)}</dd>
        <dt>Findings</dt>
        <dd class="iris-drv-mono">
          {fmtCount(d.sensitiveFiles)}
          <Show when={props.findings.length}>
            {" "}
            <span class="iris-drv-weak">
              ({countBy(props.findings, "exposed")} exposed of {props.findings.length} loaded)
            </span>
          </Show>
        </dd>
        <dt>Scanned</dt>
        <dd class="iris-drv-mono">{fmtDate(d.lastScanned)}</dd>
        <dt>Last seen</dt>
        <dd>
          {d.lastSeenOn ?? "—"}
          <Show when={d.lastSeenAt}>
            <span class="iris-drv-mono"> · {fmtDate(d.lastSeenAt)}</span>
          </Show>
        </dd>
        <dt>Backup</dt>
        <dd class="iris-drv-mono">{d.lastBackupAt ? fmtDate(d.lastBackupAt) : "—"}</dd>
      </dl>
      <p class="iris-drv-weak">Paths are valid only on the machine this drive is plugged into.</p>
    </div>
  )
}

function FindingsFooter(props: {
  show: boolean
  state?: { rows: DriveFinding[]; total: number | null; hasMore: boolean; loading: boolean; error?: string }
  shown: number
  filtered: boolean
  folder?: string
  more: () => void
}) {
  return (
    <Show when={props.show}>
      <Show when={props.state?.error}>
        <div class="iris-drv-callout" data-tone="bad">
          Couldn't read findings: {props.state!.error}
          <button class="iris-drv-btn" onClick={props.more}>
            Try again
          </button>
        </div>
      </Show>
      <Show when={props.state?.loading}>
        <div class="iris-drv-loading">
          <Spinner class="iris-drv-spin" /> Reading findings…
        </div>
      </Show>
      <Show when={props.state && !props.state.loading && !props.state.error && props.shown === 0 && !props.filtered}>
        <div class="iris-drv-weak iris-drv-pad">{props.folder ? "No sensitive files found in this folder." : "No sensitive files found on this drive."}</div>
      </Show>
      <Show when={props.state && !props.state.loading && props.state.hasMore && !props.folder}>
        <div class="iris-drv-pad">
          <button class="iris-drv-btn" onClick={props.more}>
            Load more
            <Show when={props.state!.total != null}>
              {" "}
              <span class="iris-drv-mono iris-drv-weak">
                {props.state!.rows.length} of {fmtCount(props.state!.total)}
              </span>
            </Show>
          </button>
        </div>
      </Show>
    </Show>
  )
}

function DriveState(props: { title: string; body: string; action: string; onAction: () => void }) {
  return (
    <div class="iris-drv-state">
      <div class="iris-drv-state-t">{props.title}</div>
      <p>{props.body}</p>
      <button class="iris-drv-btn" data-primary onClick={props.onAction}>
        {props.action}
      </button>
    </div>
  )
}

/** The four reasons there is nothing to list, each with its own words and one action. */
function TopState(props: {
  data?: DrivesPayload & { bridge: boolean }
  retry: () => void
  copy: (text: string, what: string) => void
}) {
  const s = () => props.data
  return (
    <div class="iris-drv-list">
      <Show
        when={s()?.bridge !== false}
        fallback={
          <DriveState
            title="IRIS isn't answering"
            body="The panel couldn't reach the IRIS engine on this computer, so your drives can't be read right now."
            action="Try again"
            onAction={props.retry}
          />
        }
      >
        <Show when={s()?.state === "signed_out"}>
          <DriveState
            title="Sign in to see your drives"
            body="Your drive catalogue lives in your IRIS account. Sign in from a terminal, then come back."
            action="Copy sign-in command"
            onAction={() => props.copy("iris auth login", "the sign-in command")}
          />
        </Show>
        <Show when={s()?.state === "unreachable"}>
          <DriveState
            title="Couldn't reach your catalogue"
            body={`IRIS didn't answer when asked for your drives${s()?.reason ? ` (${s()!.reason})` : ""}.`}
            action="Try again"
            onAction={props.retry}
          />
        </Show>
        <Show when={s()?.state === "no_datasets" || (s()?.state === "ok" && !s()?.drives.length)}>
          <DriveState
            title="No drives catalogued yet"
            body="Scan a drive or folder on the machine it's plugged into. It shows up here, and on every computer you sign in to."
            action="Copy scan command"
            onAction={() => props.copy(scanCommand(), "the scan command")}
          />
        </Show>
      </Show>
    </div>
  )
}
