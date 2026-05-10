// Types and mock data for IRIS platform sidebar panels.
// Replace these with real API/SDK calls once the platform client is wired in.

export type IrisAgentStatus = "active" | "paused" | "error" | "idle"

export interface IrisAgent {
  id: string
  name: string
  type: "heartbeat" | "standard"
  status: IrisAgentStatus
  schedule?: string  // heartbeat only — "1h", "30m", "daily"
  nextRun?: string   // relative — "in 23m"
  lastRun?: string   // relative — "37m ago"
}

export type IrisWorkflowStatus = "idle" | "running" | "success" | "error"

export interface IrisWorkflow {
  id: string
  name: string
  status: IrisWorkflowStatus
  lastRun?: string
  triggerCount: number
}

export type IrisBloqStatus = "active" | "archived" | "draft"

export interface IrisBloq {
  id: string
  name: string
  status: IrisBloqStatus
  context?: string    // category tag shown alongside name — "Sales", "CRM"
  leadCount: number
  messageCount: number
  lastActivity: string
}

export const MOCK_AGENTS: IrisAgent[] = [
  {
    id: "a1",
    name: "lead-enricher",
    type: "heartbeat",
    status: "active",
    schedule: "1h",
    nextRun: "in 23m",
    lastRun: "37m ago",
  },
  {
    id: "a2",
    name: "outreach-sender",
    type: "heartbeat",
    status: "active",
    schedule: "30m",
    nextRun: "in 8m",
    lastRun: "22m ago",
  },
  {
    id: "a3",
    name: "deal-scorer",
    type: "heartbeat",
    status: "paused",
    schedule: "6h",
  },
  {
    id: "a4",
    name: "email-classifier",
    type: "standard",
    status: "active",
    lastRun: "5m ago",
  },
  {
    id: "a5",
    name: "doc-indexer",
    type: "standard",
    status: "idle",
    lastRun: "1d ago",
  },
]

export const MOCK_WORKFLOWS: IrisWorkflow[] = [
  { id: "w1", name: "Onboard New Lead", status: "idle", lastRun: "2h ago", triggerCount: 47 },
  { id: "w2", name: "Weekly Report", status: "running", triggerCount: 12 },
  { id: "w3", name: "Follow-up Sequence", status: "success", lastRun: "1h ago", triggerCount: 203 },
  { id: "w4", name: "Contract Review", status: "error", lastRun: "3h ago", triggerCount: 8 },
  { id: "w5", name: "Lead Qualification", status: "idle", lastRun: "4h ago", triggerCount: 31 },
]

export const MOCK_BLOCS: IrisBloq[] = [
  {
    id: "b1",
    name: "Q2 Outreach",
    status: "active",
    context: "Sales",
    leadCount: 142,
    messageCount: 1820,
    lastActivity: "5m ago",
  },
  {
    id: "b2",
    name: "Enterprise Pipeline",
    status: "active",
    context: "CRM",
    leadCount: 38,
    messageCount: 674,
    lastActivity: "1h ago",
  },
  {
    id: "b3",
    name: "Dev Partner Leads",
    status: "active",
    context: "BD",
    leadCount: 21,
    messageCount: 289,
    lastActivity: "3h ago",
  },
  {
    id: "b4",
    name: "Inbound Q1",
    status: "archived",
    context: "Sales",
    leadCount: 87,
    messageCount: 1203,
    lastActivity: "2w ago",
  },
]
