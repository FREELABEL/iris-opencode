import { createEffect, createMemo, createResource, createSignal, For, on, Show, type JSX } from "solid-js"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { CommandAction } from "@/components/command-action"
import { RelativeTime } from "@opencode-ai/ui/relative-time"
import { Stat } from "@opencode-ai/ui/stat"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { Button } from "@opencode-ai/ui/button"
import { EmptyState } from "@opencode-ai/ui/empty-state"
import "./iris-drives.css"
import {
  baseName,
  countBy,
  FINDINGS_PER_PAGE,
  MAX_FINDING_PAGES,
  onDrive,
  driveMeta,
  emptyDrive,
  findingMeta,
  findingsUnder,
  fmtCount,
  fmtDate,
  fmtGb,
  fmtKb,
  folderMeta,
  HIDE_NAMES_KEY,
  maskedFindingMeta,
  maskedName,
  readHideNames,
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
   * FINDINGS, LAZILY, PER DRIVE — and then ALL of them (#193814). Asked for only when the Findings
   * segment or a folder opens; the first page paints at once and the rest load behind it, 200 at a
   * time, so search and folders cover every finding, not the first hundred. The largest drive measured
   * held 433 records (3 requests). MAX_FINDING_PAGES is a safety stop, and the footer says when it hits.
   * Cached per drive, so going back and forth does not refetch.
   */
  type FindingsCache = { rows: DriveFinding[]; page: number; total: number | null; hasMore: boolean; loading: boolean; error?: string }
  const [cache, setCache] = createSignal<Record<string, FindingsCache>>({})
  const findingsFor = (id?: string) => (id ? cache()[id] : undefined)
  const loadFindings = async (id: string) => {
    const cur = cache()[id]
    if (cur?.loading || (cur && !cur.hasMore)) return
    setCache((c) => ({ ...c, [id]: { ...(cur ?? { rows: [], page: 0, total: null, hasMore: true }), loading: true, error: undefined } }))
    let state = cache()[id]!
    while (state.hasMore && state.page < MAX_FINDING_PAGES) {
      try {
        const p = await readJson<FindingsPayload>(
          `/iris/drives/findings?drive=${encodeURIComponent(id)}&page=${state.page + 1}&perPage=${FINDINGS_PER_PAGE}`,
        )
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
      if (id && (seg === "findings" || f)) void loadFindings(id)
    }),
  )

  // Anything that changes the list resets the selection; leaving a scope closes the sheet.
  createEffect(on([driveId, folder, segment, query], () => setSel(-1)))
  // Leaving a view closes the sheet — a path revealed there must not ride along to the next one.
  createEffect(on([driveId, folder, segment], () => setSheet(undefined)))
  /*
   * HIDE NAMES (#193817). The tab lists sensitive files by path — .env files, credentials, database
   * dumps — and a screen share or a capture shows them. With names hidden, folders and files show only
   * what kind they are, and the sheet reveals one path on request. Drive names stay: they are the
   * labels people navigate by. Remembered on this device.
   */
  const [hideNames, setHideNames] = createSignal(readHideNames())
  const toggleHideNames = () => {
    setHideNames((v) => !v)
    try {
      localStorage.setItem(HIDE_NAMES_KEY, hideNames() ? "1" : "0")
    } catch {}
  }
  const [revealed, setRevealed] = createSignal(false)
  createEffect(on([sheet, hideNames], () => setRevealed(false)))
  // Moved findings are history, folded away until asked for; every new scope starts folded.
  const [showMoved, setShowMoved] = createSignal(false)
  createEffect(on([driveId, folder, segment], () => setShowMoved(false)))
  /*
   * KEEP THE KEYBOARD AFTER A DRILL. The row a person clicked or pressed Enter on is replaced by the
   * next level's rows, and focus falls to <body> — after which arrows and Backspace reach nothing.
   * Pull it back to the panel, but only from <body> or from inside the panel: never out of the chat box.
   */
  createEffect(
    on(
      [driveId, folder, sheet, revealed],
      () =>
        queueMicrotask(() => {
          const a = document.activeElement
          if (!rootEl || (a && a !== document.body && !rootEl.contains(a))) return
          if (a instanceof HTMLInputElement) return
          rootEl.focus({ preventScroll: true })
        }),
      { defer: true },
    ),
  )

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

  /*
   * ONE MEANING OF "FINDINGS" (#193813): sensitive files ON THE DRIVE NOW — what the drive row's count
   * (the scan's sensitive_files) means. Records the scan marked `moved` are no longer on the drive;
   * they list below a fold, never in the count.
   */
  const scopedFindings = createMemo(() => {
    const all = findingsFor(drive()?.id)?.rows ?? []
    const inScope = folder() ? findingsUnder(folder()!, all) : all
    const q = query()
    const hit = inScope.filter((f) => matches(q, f.path, f.kind, f.status))
    return { current: hit.filter(onDrive), moved: hit.filter((f) => !onDrive(f)) }
  })
  const rows = createMemo<Row[]>(() => {
    const q = query()
    if (!drive()) return drives().filter((d) => matches(q, d.label, d.kind, d.node)).map((d) => ({ kind: "drive", drive: d }))
    if (!folder() && segment() === "folders") {
      return driveFolders().filter((f) => matches(q, f.folder, f.kinds)).map((f) => ({ kind: "folder", folder: f }))
    }
    if (!folder() && segment() !== "findings") return []
    const f = scopedFindings()
    return [...f.current, ...(showMoved() ? f.moved : [])].map((finding) => ({ kind: "finding", finding }))
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
      // The fallback shows the text so it can be selected — never a hidden path.
      setNote(hideNames() ? `Couldn't copy ${what}. Show file names to select it.` : text)
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
    return folder() ? `${drive()!.label} / ${shownFolder()}` : drive()!.label
  }
  const shownFolder = () => (hideNames() ? maskedName("folder") : folder())
  const findingsCount = () => {
    const c = findingsFor(drive()?.id)
    // Every page read: count what is on the drive. Until then, the scan's own count — the same meaning.
    if (c && !c.hasMore && !c.error) return c.rows.filter(onDrive).length
    return drive()?.sensitiveFiles ?? null
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
            <span class="iris-drv-crumb">{drive()!.label} /</span> {shownFolder()}
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
        <Show when={data()?.state === "ok" && drives().length}>
          <button
            class="iris-drv-icon-btn"
            aria-label={hideNames() ? "Show file names" : "Hide file names"}
            title={hideNames() ? "Show file names" : "Hide file names (for screen sharing)"}
            aria-pressed={hideNames()}
            onClick={toggleHideNames}
          >
            <Icon name="eye" size="small" />
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
        <Show when={data()?.state === "ok" && drives().length} fallback={<TopState data={data()} retry={refetch} doFetch={props.doFetch} />}>
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
                cta={<ScanAction drive={drive()!} doFetch={props.doFetch} onDone={refetch} />}
              />
            </Show>
            <Show when={drive() && emptyDrive(drive()!, driveFolders()) && segment() !== "info" && !folder()}>
              <DriveState
                title="Nothing catalogued on this drive"
                body="The last scan found no project folders or files. If that's wrong, scan it again where it's plugged in."
                cta={<ScanAction drive={drive()!} doFetch={props.doFetch} onDone={refetch} />}
              />
            </Show>
            <Show when={drive() && segment() === "info" && !folder()}>
              <DriveInfo
                drive={drive()!}
                folders={driveFolders()}
                findings={findingsFor(drive()!.id)?.rows ?? []}
                complete={findingsFor(drive()!.id)?.hasMore === false}
              />
            </Show>
            <For each={rows()}>
              {(r, i) => (
                <>
                <Show when={showMoved() && r.kind === "finding" && i() === scopedFindings().current.length}>
                  <button class="iris-drv-fold" aria-expanded="true" onClick={() => setShowMoved(false)}>
                    <Icon name="chevron-down" size="small" />
                    Hide {fmtCount(scopedFindings().moved.length)} moved off this drive
                  </button>
                </Show>
                <RowView
                  row={r}
                  index={i()}
                  selected={sel() === i() || (r.kind === "finding" && sheet()?.id === r.finding.id)}
                  driveEncrypted={drive()?.encrypted}
                  hideNames={hideNames()}
                  onClick={() => {
                    setSel(i())
                    open(r)
                  }}
                />
                </>
              )}
            </For>
            <FindingsFooter
              show={!!drive() && (segment() === "findings" || !!folder())}
              state={findingsFor(drive()?.id)}
              current={scopedFindings().current.length}
              moved={scopedFindings().moved.length}
              showMoved={showMoved()}
              toggleMoved={() => setShowMoved((v) => !v)}
              filtered={!!query()}
              folder={folder()}
              retry={() => drive() && loadFindings(drive()!.id)}
            />
            <Show when={query() && rows().length === 0 && (drive() ? segment() !== "info" : true)}>
              <div class="iris-drv-weak iris-drv-pad">Nothing matches “{query()}”.</div>
            </Show>
          </div>

          <Show when={sheet()}>
            {(f) => (
              <section class="iris-drv-sheet" aria-label="Finding">
                <div class="iris-drv-sheet-hd">
                  <span class="iris-drv-sheet-nm" title={hideNames() && !revealed() ? undefined : f().path}>
                    {hideNames() && !revealed() ? maskedName("file", f().kind) : baseName(f().path)}
                  </span>
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
                  <dd class="iris-drv-mono">
                    <Show
                      when={!hideNames() || revealed()}
                      fallback={
                        <button class="iris-drv-reveal" onClick={() => setRevealed(true)}>
                          Hidden · Reveal
                        </button>
                      }
                    >
                      {f().path}
                    </Show>
                  </dd>
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

function RowView(props: { row: Row; index: number; selected: boolean; driveEncrypted?: boolean; hideNames?: boolean; onClick: () => void }) {
  const r = props.row
  const icon: IconProps["name"] =
    r.kind === "drive"
      ? "disk"
      : r.kind === "folder"
        ? "folder"
        : r.finding.status === "exposed"
          ? "warning"
          : r.finding.status === "moved"
            ? "archive"
            : "lock"
  // Functions, not values: the row stays mounted when names are hidden or shown.
  const name = () => {
    if (r.kind === "drive") return r.drive.label
    if (props.hideNames) return r.kind === "folder" ? maskedName("folder", r.folder.mainKind) : maskedName("file", r.finding.kind)
    return r.kind === "folder" ? r.folder.folder : baseName(r.finding.path)
  }
  const meta = () => {
    if (r.kind === "drive") return driveMeta(r.drive)
    if (r.kind === "folder") return folderMeta(r.folder)
    return props.hideNames ? maskedFindingMeta(r.finding) : findingMeta(r.finding)
  }
  const trail = (): JSX.Element => {
    if (r.kind === "finding") return <span class="iris-drv-pill" data-tone={statusTone(r.finding.status)}>{r.finding.status ?? "—"}</span>
    const n = r.kind === "drive" ? r.drive.sensitiveFiles : r.folder.sensitiveFiles
    if (r.kind === "drive" && neverScanned(r.drive)) return <span class="iris-drv-pill" data-tone="muted">not scanned</span>
    // Red only where a finding is readable by anyone holding the drive; on an encrypted drive it is contained.
    const exposed = r.kind === "drive" ? !r.drive.encrypted : props.driveEncrypted === undefined ? undefined : !props.driveEncrypted
    return n ? (
      <span class="iris-drv-count" data-tone={exposed === false ? "muted" : "bad"} title={`${n} sensitive files`}>
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
      title={props.hideNames && r.kind !== "drive" ? undefined : r.kind === "finding" ? r.finding.path : name()}
      onClick={props.onClick}
    >
      <span class="iris-drv-row-ic">
        <Icon name={icon} size="small" />
      </span>
      <span class="iris-drv-row-body">
        <span class="iris-drv-row-n">{name()}</span>
        <span class="iris-drv-row-m">{meta()}</span>
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

function DriveInfo(props: { drive: Drive; folders: DriveFolder[]; findings: DriveFinding[]; complete: boolean }) {
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
      {/* Stat (#194581): the three numbers that say what is on the drive, labelled. */}
      <div class="iris-drv-stats">
        <Stat size="small" label="Files" value={fmtCount(d.files)} />
        <Stat size="small" label="Folders" value={fmtCount(d.folders ?? props.folders.length)} />
        <Stat
          size="small"
          label="Findings"
          value={fmtCount(d.sensitiveFiles)}
          changeText={
            props.findings.length ? `${countBy(props.findings, "exposed")} exposed${props.complete ? "" : " so far"}` : undefined
          }
        />
      </div>
      <dl class="iris-drv-kv">
        <dt>Kind</dt>
        <dd>{d.kind ?? "—"}</dd>
        <dt>Encrypted</dt>
        <dd>{d.encrypted ? "yes" : "no"}</dd>
        <dt>Scanned</dt>
        <dd>
          <RelativeTime value={d.lastScanned} fallback="—" />
        </dd>
        <dt>Last seen</dt>
        <dd>
          {d.lastSeenOn ?? "—"}
          <Show when={d.lastSeenAt}>
            {" · "}
            <RelativeTime value={d.lastSeenAt} />
          </Show>
        </dd>
        <dt>Backup</dt>
        <dd>
          <RelativeTime value={d.lastBackupAt} fallback="—" />
        </dd>
      </dl>
      <p class="iris-drv-weak">Paths are valid only on the machine this drive is plugged into.</p>
    </div>
  )
}

function FindingsFooter(props: {
  show: boolean
  state?: { rows: DriveFinding[]; page: number; total: number | null; hasMore: boolean; loading: boolean; error?: string }
  current: number
  moved: number
  showMoved: boolean
  toggleMoved: () => void
  filtered: boolean
  folder?: string
  retry: () => void
}) {
  const done = () => !!props.state && !props.state.loading && !props.state.error
  const capped = () => done() && props.state!.hasMore
  return (
    <Show when={props.show}>
      <Show when={props.state?.error}>
        <div class="iris-drv-callout" data-tone="bad">
          Couldn't read findings: {props.state!.error}
          <button class="iris-drv-btn" onClick={props.retry}>
            Try again
          </button>
        </div>
      </Show>
      <Show when={props.state?.loading}>
        <div class="iris-drv-loading">
          <Spinner class="iris-drv-spin" /> Reading findings…
          <Show when={props.state!.total != null}>
            <span class="iris-drv-mono">
              {fmtCount(props.state!.rows.length)} of {fmtCount(props.state!.total)}
            </span>
          </Show>
          <Show when={props.filtered}>
            <span>· results so far</span>
          </Show>
        </div>
      </Show>
      <Show when={done() && props.current === 0 && props.moved === 0 && !props.filtered}>
        <div class="iris-drv-weak iris-drv-pad">{props.folder ? "No sensitive files found in this folder." : "No sensitive files found on this drive."}</div>
      </Show>
      <Show when={done() && props.current === 0 && props.moved > 0 && !props.filtered && !props.showMoved}>
        <div class="iris-drv-weak iris-drv-pad">No sensitive files on this drive now. The ones found earlier were moved off it.</div>
      </Show>
      <Show when={props.moved > 0 && done() && !props.showMoved}>
        <button class="iris-drv-fold" aria-expanded="false" onClick={props.toggleMoved}>
          <Icon name="chevron-right" size="small" />
          Show {fmtCount(props.moved)} moved off this drive
        </button>
      </Show>
      <Show when={capped()}>
        <div class="iris-drv-weak iris-drv-pad">
          Showing the first {fmtCount(props.state!.rows.length)} of {fmtCount(props.state!.total)} findings. Open the full page to see the rest.
        </div>
      </Show>
    </Show>
  )
}

/** Why there is nothing to list, and the one thing to do next — the shared EmptyState. */
function DriveState(props: { title: string; body: string; action?: string; onAction?: () => void; cta?: JSX.Element }) {
  return (
    <EmptyState
      class="iris-drv-state"
      title={props.title}
      description={props.body}
      action={
        props.cta ?? (
          <Button size="small" variant="primary" onClick={() => props.onAction?.()}>
            {props.action}
          </Button>
        )
      }
    />
  )
}

/**
 * Sign in (#194583), not "copy the sign-in command": `iris auth login` is interactive, so it is not
 * a command a button can run. The desktop has its own sign-in window — the same one Settings ›
 * Account opens — and the drives are read again when the person comes back to this window. Where
 * there is no sign-in window (IRIS opened in a browser), the step says where to sign in instead.
 */
function SignInState(props: { retry: () => void }) {
  const language = useLanguage()
  const platform = usePlatform()
  let watching = false
  const signIn = () => {
    platform.openSignIn?.()
    if (watching || typeof window === "undefined") return
    watching = true
    window.addEventListener(
      "focus",
      () => {
        watching = false
        props.retry()
      },
      { once: true },
    )
  }
  return (
    <Show
      when={platform.openSignIn}
      fallback={
        <DriveState
          title={language.t("iris.drives.signIn.title")}
          body={language.t("iris.drives.signIn.elsewhere")}
          action={language.t("iris.drives.signIn.check")}
          onAction={props.retry}
        />
      }
    >
      <DriveState
        title={language.t("iris.drives.signIn.title")}
        body={language.t("iris.drives.signIn.body")}
        cta={
          <Button size="small" variant="primary" data-action="drives-sign-in" onClick={signIn}>
            {language.t("iris.drives.signIn.action")}
          </Button>
        }
      />
    </Show>
  )
}

/**
 * Scan, as a button that runs it (#194581), not a line to copy. The line opens first: the
 * path is where the drive is mounted on THIS computer, so the person checks it, then confirms.
 */
function ScanAction(props: { drive?: Drive; doFetch: Fetch; onDone: () => void }) {
  const language = useLanguage()
  return (
    <CommandAction
      command={scanCommand(props.drive)}
      label={language.t(props.drive ? "iris.drives.scan.again" : "iris.drives.scan.new")}
      describe={language.t("iris.drives.scan.describe")}
      editable
      fetch={props.doFetch}
      base=""
      onDone={(r) => r.ran && r.code === 0 && props.onDone()}
    />
  )
}

/** The four reasons there is nothing to list, each with its own words and one action. */
function TopState(props: {
  data?: DrivesPayload & { bridge: boolean }
  retry: () => void
  doFetch: Fetch
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
          <SignInState retry={props.retry} />
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
            cta={<ScanAction doFetch={props.doFetch} onDone={props.retry} />}
          />
        </Show>
      </Show>
    </div>
  )
}
