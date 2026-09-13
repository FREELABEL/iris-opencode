// Types for IRIS platform sidebar panels.

export type IrisAgentStatus = "active" | "paused" | "error" | "idle"

export interface IrisAgent {
  id: number
  name: string
  type: "heartbeat" | "standard"
  status: IrisAgentStatus
  model?: string
  schedule?: string
  nextRun?: string
  lastRun?: string
}

export type IrisWorkflowStatus = "idle" | "running" | "success" | "error"

export interface IrisWorkflow {
  id: number
  name: string
  status: IrisWorkflowStatus
  category?: string
  lastRun?: string
  triggerCount: number
}

export interface IrisWorkflowDetail extends IrisWorkflow {
  description?: string
  steps?: any[]
  settings?: Record<string, any>
  input_schema?: Record<string, any>
  output_schema?: Record<string, any>
  allowed_tools?: string[]
  agent_config?: Record<string, any>
  execution_mode?: string
  dependencies?: string[]
  script_content?: string
  script_language?: string
  hive_task_type?: string
  callable_name?: string
  callable_description?: string
  require_human_approval?: boolean
  max_iterations?: number
}

// Atlas (bloq lists + items)

export interface AtlasItem {
  id: number
  title: string
  type?: string
  status?: string
  description?: string
  content?: string
}

export interface AtlasList {
  id: number
  name: string
  items: AtlasItem[]
}

export interface IrisPage {
  id: number
  title: string
  slug: string
  status: string
  url: string
  version: number
  updatedAt: string
}

export interface IrisContact {
  id: number
  name: string
  email?: string
  phone?: string
  company?: string
  status?: string
  source?: string
  leadScore: number
  isHot: boolean
}

/**
 * A machine registered to this account's Hive.
 *
 * The Hive tab used to list local tmux sessions, which answered a question nobody was asking:
 * tmux is how you drive ONE machine, and the tab is named after the network. On a fleet of
 * three online nodes it rendered "No active tmux sessions" — technically true, and completely
 * uninformative about the Hive. This is what the tab is about now.
 */
export interface IrisHiveNode {
  id: string
  name: string
  /** connection_status from the API: online / offline / paused. */
  status: string
  online: boolean
  /** Relative, already formatted — "1m ago". Empty string when never. */
  lastHeartbeat: string
  activeTasks: number
  maxConcurrent: number
  /** Claude/agent sessions the daemon reports running on that machine. */
  sessions: number
  /** True when this is the machine the TUI is running on. */
  isLocal: boolean
  /** The local-node match came from a hostname heuristic and can be wrong — say so. */
  localUncertain: boolean
}

/** A peer connection — someone else's Hive you are linked to. */
export interface IrisHivePeer {
  id: string
  name: string
  status: string
  active: boolean
  /** "chat,files" — the permissions granted on the link. */
  permissions: string
}
