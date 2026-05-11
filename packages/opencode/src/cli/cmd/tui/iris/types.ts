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
