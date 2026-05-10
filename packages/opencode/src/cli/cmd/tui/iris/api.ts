import { createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { irisFetch, resolveUserId } from "../../iris-api"
import type { IrisAgent, IrisWorkflow, AtlasList, AtlasItem, IrisContact, IrisPage } from "./types"
import { IRIS_API } from "../../iris-api"

type DataStatus = "loading" | "loaded" | "error" | "no-auth"

export interface BloqOption {
  id: number
  name: string
}

interface IrisDataStore {
  status: DataStatus
  bloqList: BloqOption[]
  selectedBloqId: number | null
  agents: IrisAgent[]
  workflows: IrisWorkflow[]
  atlas: AtlasList[]
  contacts: IrisContact[]
  pages: IrisPage[]
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0) return "just now"
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  return `${weeks}w ago`
}

function relativeTimeUntil(iso: string | null | undefined): string {
  if (!iso) return ""
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return "now"
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  return `in ${hours}h`
}

function deriveScheduleLabel(interval: number | null | undefined): string | undefined {
  if (!interval) return undefined
  if (interval < 60) return `${interval}m`
  if (interval < 1440) return `${Math.round(interval / 60)}h`
  return `${Math.round(interval / 1440)}d`
}

interface RawAgent {
  id: number
  name: string
  heartbeat_mode?: string | boolean
  active?: boolean
  health_status?: string
  model?: string
  config?: { model?: string; modelName?: string }
}

interface RawScheduledJob {
  id: number
  agent_id?: number
  interval_minutes?: number
  next_run_at?: string
  last_run_at?: string
  status?: string
}

interface RawWorkflow {
  id: number
  name: string
  run_count?: number
  failed_runs?: number
  last_executed_at?: string
  status?: string
}

function mapAgents(agents: RawAgent[], jobs: RawScheduledJob[]): IrisAgent[] {
  return agents.map((a) => {
    const job = jobs.find((j) => j.agent_id === a.id)
    const isHeartbeat = a.heartbeat_mode && a.heartbeat_mode !== "off"
    const type: "heartbeat" | "standard" = isHeartbeat ? "heartbeat" : "standard"
    let status: IrisAgent["status"] = "idle"
    if (a.health_status === "unhealthy" || a.health_status === "error") status = "error"
    else if (!a.active) status = "paused"
    else if (a.active) status = "active"

    return {
      id: a.id,
      name: a.name,
      type,
      status,
      model: a.model ?? a.config?.modelName ?? a.config?.model,
      schedule: job ? deriveScheduleLabel(job.interval_minutes) : undefined,
      nextRun: job?.next_run_at ? relativeTimeUntil(job.next_run_at) : undefined,
      lastRun: job?.last_run_at ? relativeTime(job.last_run_at) : undefined,
    }
  })
}

function mapWorkflows(workflows: RawWorkflow[]): IrisWorkflow[] {
  return workflows.map((w) => {
    let status: IrisWorkflow["status"] = "idle"
    if (w.status === "running") status = "running"
    else if (w.failed_runs && w.failed_runs > 0) status = "error"
    else if (w.last_executed_at) status = "success"

    return {
      id: w.id,
      name: w.name,
      status,
      lastRun: relativeTime(w.last_executed_at),
      triggerCount: w.run_count ?? 0,
    }
  })
}

function mapPages(pages: any[]): IrisPage[] {
  return pages.map((p) => ({
    id: p.id,
    title: p.title || p.slug || "Untitled",
    slug: p.slug,
    status: p.status ?? "draft",
    url: p.public_url ?? "",
    version: p.current_version ?? 1,
    updatedAt: relativeTime(p.updated_at),
  }))
}

function mapContacts(leads: any[]): IrisContact[] {
  return leads.map((l) => ({
    id: l.id,
    name: l.name || l.nickname || "Unknown",
    email: l.email || undefined,
    phone: l.phone || undefined,
    company: l.company || undefined,
    status: l.status || undefined,
    source: l.source || undefined,
    leadScore: l.lead_score ?? 0,
    isHot: !!l.is_hot_lead,
  }))
}

async function extractData(res: Response): Promise<any[]> {
  if (!res.ok) return []
  const json = await res.json() as any
  return json?.data ?? json ?? []
}

export function useIrisData() {
  const [data, setData] = createStore<IrisDataStore>({
    status: "loading",
    bloqList: [],
    selectedBloqId: null,
    agents: [],
    workflows: [],
    atlas: [],
    contacts: [],
    pages: [],
  })

  let _userId: number | null = null
  let _rawBloqs: any[] = []

  function extractAtlas(bloqId: number): AtlasList[] {
    const bloq = _rawBloqs.find((b: any) => b.id === bloqId)
    if (!bloq?.lists) return []
    return (bloq.lists as any[]).map((l: any) => ({
      id: l.id,
      name: l.name,
      items: (l.items ?? []).map((i: any) => ({
        id: i.id,
        title: i.title ?? "Untitled",
        type: i.type,
        status: i.status,
        description: i.description || undefined,
        content: i.content || undefined,
      })),
    }))
  }

  async function fetchBloqList() {
    _userId = await resolveUserId()
    if (!_userId) {
      setData("status", "no-auth")
      return
    }

    try {
      const [bloqRes, pagesRes] = await Promise.all([
        irisFetch(`/api/v1/user/${_userId}/bloqs`),
        irisFetch(`/api/v1/pages?user_id=${_userId}&per_page=50`, {}, IRIS_API),
      ])
      if (bloqRes.status === 401) {
        setData("status", "no-auth")
        return
      }
      const raw = await extractData(bloqRes)
      _rawBloqs = raw
      const list: BloqOption[] = raw.map((b: any) => ({ id: b.id, name: b.name }))
      setData("bloqList", reconcile(list))

      // Pages from iris-api (nested pagination response)
      try {
        if (pagesRes.ok) {
          const pagesJson = await pagesRes.json() as any
          const rawPages = pagesJson?.data?.data ?? pagesJson?.data ?? []
          setData("pages", reconcile(mapPages(rawPages)))
        }
      } catch {}

      // Auto-select first bloq if none selected
      if (!data.selectedBloqId && list.length > 0) {
        setData("selectedBloqId", list[0].id)
        setData("atlas", reconcile(extractAtlas(list[0].id)))
        await fetchBloqData(list[0].id)
      } else if (data.selectedBloqId) {
        setData("atlas", reconcile(extractAtlas(data.selectedBloqId)))
      }
      setData("status", "loaded")
    } catch {
      if (data.status !== "loaded") setData("status", "error")
    }
  }

  async function fetchBloqData(bloqId: number) {
    if (!_userId) return

    try {
      const [agentsRes, workflowsRes, jobsRes, leadsRes] = await Promise.all([
        irisFetch(`/api/v1/users/${_userId}/bloqs/agents?bloq_id=${bloqId}&per_page=50`),
        irisFetch(`/api/v1/users/${_userId}/bloqs/workflows?per_page=20`),
        irisFetch(`/api/v1/users/${_userId}/bloqs/scheduled-jobs?per_page=50`),
        irisFetch(`/api/v1/users/${_userId}/leads?bloq_id=${bloqId}&per_page=50`),
      ])

      const [rawAgents, rawWorkflows, rawJobs, rawLeads] = await Promise.all([
        extractData(agentsRes),
        extractData(workflowsRes),
        extractData(jobsRes),
        extractData(leadsRes),
      ])

      setData("agents", reconcile(mapAgents(rawAgents, rawJobs)))
      setData("workflows", reconcile(mapWorkflows(rawWorkflows)))
      setData("contacts", reconcile(mapContacts(rawLeads)))
      setData("status", "loaded")
    } catch {
      if (data.status !== "loaded") setData("status", "error")
    }
  }

  function selectBloq(bloqId: number) {
    setData("selectedBloqId", bloqId)
    setData("agents", [])
    setData("workflows", [])
    setData("contacts", [])
    setData("atlas", reconcile(extractAtlas(bloqId)))
    setData("status", "loading")
    fetchBloqData(bloqId)
  }

  // Initial fetch
  fetchBloqList()

  // Poll every 30s — refresh data for current bloq
  const interval = setInterval(() => {
    if (data.selectedBloqId) fetchBloqData(data.selectedBloqId)
  }, 30_000)
  onCleanup(() => clearInterval(interval))

  return { data, selectBloq, refetch: fetchBloqList }
}
