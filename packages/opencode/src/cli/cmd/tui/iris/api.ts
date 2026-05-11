import { createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { irisFetch, resolveUserId } from "../../iris-api"
import type { IrisAgent, IrisWorkflow, IrisWorkflowDetail, AtlasList, AtlasItem, IrisContact, IrisPage } from "./types"
import { IRIS_API } from "../../iris-api"
import os from "os"
import path from "path"

const PLATFORM_CONTEXT_PATH = path.join(os.homedir(), ".iris", "platform-context.md")

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

  function extractAtlas(raw: any): AtlasList[] {
    if (!raw?.lists) return []
    return (raw.lists as any[]).map((l: any) => ({
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
        irisFetch(`/api/v1/user/${_userId}/bloqs?simplified=true`),
        irisFetch(`/api/v1/pages?user_id=${_userId}&per_page=50`, {}, IRIS_API),
      ])
      if (bloqRes.status === 401) {
        setData("status", "no-auth")
        return
      }
      const raw = await extractData(bloqRes)
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
        await fetchBloqData(list[0].id)
      }
      setData("status", "loaded")
    } catch {
      if (data.status !== "loaded") setData("status", "error")
    }
  }

  async function fetchBloqData(bloqId: number) {
    if (!_userId) return

    try {
      const [bloqDetailRes, agentsRes, workflowsRes, jobsRes, leadsRes] = await Promise.all([
        irisFetch(`/api/v1/user/${_userId}/bloqs/${bloqId}`),
        irisFetch(`/api/v1/users/${_userId}/bloqs/agents?bloq_id=${bloqId}&per_page=50`),
        irisFetch(`/api/v1/users/${_userId}/bloqs/workflows?bloq_id=${bloqId}&per_page=20`),
        irisFetch(`/api/v1/users/${_userId}/bloqs/scheduled-jobs?bloq_id=${bloqId}&per_page=50`),
        irisFetch(`/api/v1/users/${_userId}/leads?bloq_id=${bloqId}&per_page=50`),
      ])

      // Extract atlas from single-bloq detail response
      try {
        if (bloqDetailRes.ok) {
          const bloqJson = await bloqDetailRes.json() as any
          const bloqData = bloqJson?.data ?? bloqJson
          setData("atlas", reconcile(extractAtlas(bloqData)))
        }
      } catch {}

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
      syncIrisContext()
    } catch {
      if (data.status !== "loaded") setData("status", "error")
    }
  }

  function syncIrisContext() {
    const bloq = data.bloqList.find((b) => b.id === data.selectedBloqId)
    if (!bloq) {
      import("fs").then((fs) => {
        try { fs.unlinkSync(PLATFORM_CONTEXT_PATH) } catch {}
      })
      return
    }

    const lines: string[] = [
      `# IRIS Platform Context`,
      `You have the following IRIS project selected. Use this to answer questions without running CLI commands.`,
      ``,
      `## Selected Project: ${bloq.name} (#${bloq.id})`,
      ``,
    ]

    // Atlas lists summary
    if (data.atlas.length > 0) {
      const totalItems = data.atlas.reduce((sum, l) => sum + l.items.length, 0)
      lines.push(`### Lists (${data.atlas.length} total, ${totalItems} items)`)
      for (const list of data.atlas) {
        if (list.items.length === 0) continue
        const preview = list.items.slice(0, 3).map((i) => i.title).join(", ")
        const more = list.items.length > 3 ? ` +${list.items.length - 3} more` : ""
        lines.push(`- ${list.name} (${list.items.length}): ${preview}${more}`)
      }
      lines.push(``)
    }

    // Agents
    lines.push(`### Agents (${data.agents.length})`)
    if (data.agents.length > 0) {
      for (const a of data.agents.slice(0, 10)) {
        lines.push(`- ${a.name} #${a.id}${a.model ? ` (${a.model})` : ""}${a.schedule ? ` every ${a.schedule}` : ""}`)
      }
      if (data.agents.length > 10) lines.push(`- +${data.agents.length - 10} more`)
    } else {
      lines.push(`None in this project.`)
    }
    lines.push(``)

    // Contacts
    lines.push(`### Contacts (${data.contacts.length})`)
    if (data.contacts.length > 0) {
      for (const c of data.contacts.slice(0, 10)) {
        lines.push(`- ${c.name} #${c.id}${c.status ? ` (${c.status})` : ""}`)
      }
      if (data.contacts.length > 10) lines.push(`- +${data.contacts.length - 10} more`)
    } else {
      lines.push(`None in this project.`)
    }
    lines.push(``)

    // Pages
    lines.push(`### Pages (${data.pages.length})`)
    if (data.pages.length > 0) {
      for (const p of data.pages.slice(0, 10)) {
        lines.push(`- ${p.title} /${p.slug}`)
      }
      if (data.pages.length > 10) lines.push(`- +${data.pages.length - 10} more`)
    } else {
      lines.push(`None in this project.`)
    }

    Bun.write(PLATFORM_CONTEXT_PATH, lines.join("\n")).catch(() => {})
  }

  async function fetchWorkflowDetail(workflowId: number): Promise<IrisWorkflowDetail | null> {
    if (!_userId) return null
    try {
      const res = await irisFetch(`/api/v1/users/${_userId}/bloqs/workflows/${workflowId}`)
      if (!res.ok) return null
      const raw = await res.json() as any
      const wf = raw?.data ?? raw
      let status: IrisWorkflowDetail["status"] = "idle"
      if (wf.status === "running") status = "running"
      else if (wf.failed_runs && wf.failed_runs > 0) status = "error"
      else if (wf.last_executed_at) status = "success"
      return {
        id: wf.id,
        name: wf.name,
        status,
        category: wf.category,
        lastRun: relativeTime(wf.last_executed_at),
        triggerCount: wf.run_count ?? 0,
        description: wf.description,
        steps: wf.steps,
        settings: wf.settings,
        input_schema: wf.input_schema,
        output_schema: wf.output_schema,
        allowed_tools: wf.allowed_tools,
        agent_config: wf.agent_config,
        execution_mode: wf.execution_mode,
        dependencies: wf.dependencies,
        script_content: wf.script_content,
        script_language: wf.script_language,
        hive_task_type: wf.hive_task_type,
        callable_name: wf.callable_name,
        callable_description: wf.callable_description,
        require_human_approval: wf.require_human_approval,
        max_iterations: wf.max_iterations,
      }
    } catch {
      return null
    }
  }

  function importWorkflowToContext(wf: IrisWorkflowDetail) {
    const lines: string[] = []

    lines.push(`\n## Active Workflow: ${wf.name} (#${wf.id})`)
    if (wf.description) lines.push(`**Description**: ${wf.description}`)
    if (wf.execution_mode) lines.push(`**Execution Mode**: ${wf.execution_mode}`)
    if (wf.callable_name) lines.push(`**Callable Name**: ${wf.callable_name}`)
    if (wf.callable_description) lines.push(`**Callable Description**: ${wf.callable_description}`)
    if (wf.category) lines.push(`**Category**: ${wf.category}`)
    if (wf.max_iterations) lines.push(`**Max Iterations**: ${wf.max_iterations}`)
    if (wf.require_human_approval) lines.push(`**Requires Human Approval**: yes`)
    if (wf.dependencies?.length) lines.push(`**Dependencies**: ${wf.dependencies.join(", ")}`)
    if (wf.script_language) lines.push(`**Script Language**: ${wf.script_language}`)
    if (wf.hive_task_type) lines.push(`**Hive Task Type**: ${wf.hive_task_type}`)

    if (wf.steps?.length) {
      lines.push(`\n### Steps (${wf.steps.length})`)
      lines.push("```json")
      lines.push(JSON.stringify(wf.steps, null, 2))
      lines.push("```")
    }

    if (wf.input_schema && Object.keys(wf.input_schema).length > 0) {
      lines.push(`\n### Input Schema`)
      lines.push("```json")
      lines.push(JSON.stringify(wf.input_schema, null, 2))
      lines.push("```")
    }

    if (wf.output_schema && Object.keys(wf.output_schema).length > 0) {
      lines.push(`\n### Output Schema`)
      lines.push("```json")
      lines.push(JSON.stringify(wf.output_schema, null, 2))
      lines.push("```")
    }

    if (wf.allowed_tools?.length) {
      lines.push(`\n### Allowed Tools`)
      lines.push(wf.allowed_tools.map((t) => `- ${t}`).join("\n"))
    }

    if (wf.agent_config && Object.keys(wf.agent_config).length > 0) {
      lines.push(`\n### Agent Config`)
      lines.push("```json")
      lines.push(JSON.stringify(wf.agent_config, null, 2))
      lines.push("```")
    }

    if (wf.settings && Object.keys(wf.settings).length > 0) {
      lines.push(`\n### Workflow Settings`)
      lines.push("```json")
      lines.push(JSON.stringify(wf.settings, null, 2))
      lines.push("```")
    }

    if (wf.script_content) {
      lines.push(`\n### Script Content`)
      lines.push("```" + (wf.script_language ?? ""))
      lines.push(wf.script_content)
      lines.push("```")
    }

    lines.push(`\n### Instructions`)
    lines.push(`You have this workflow loaded. Use the steps, schema, and tools above to execute or reason about this workflow. If it has input_schema, ask the user for required inputs before running. Use \`iris workflows run ${wf.id}\` to execute it, or run the steps manually if needed.`)

    // Append to existing platform-context.md
    const content = lines.join("\n")
    import("fs").then((fs) => {
      try {
        const existing = fs.existsSync(PLATFORM_CONTEXT_PATH)
          ? fs.readFileSync(PLATFORM_CONTEXT_PATH, "utf-8")
          : ""
        // Remove any previous "Active Workflow" section
        const cleaned = existing.replace(/\n## Active Workflow:[\s\S]*$/, "")
        fs.writeFileSync(PLATFORM_CONTEXT_PATH, cleaned + content)
      } catch {}
    })
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
  onCleanup(() => {
    clearInterval(interval)
    import("fs").then((fs) => {
      try { fs.unlinkSync(PLATFORM_CONTEXT_PATH) } catch {}
    })
  })

  return { data, selectBloq, refetch: fetchBloqList, fetchWorkflowDetail, importWorkflowToContext }
}
