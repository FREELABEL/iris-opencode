export interface CommandCategory {
  name: string
  description: string
  order: number
}

export const CATEGORIES: Record<string, CommandCategory> = {
  crm: {
    name: "CRM & Sales",
    description: "Leads, outreach campaigns, invoicing, payments, delivery",
    order: 1,
  },
  atlas: {
    name: "Atlas OS",
    description: "Ledger, staff, inventory, meetings, brand kit, deals",
    order: 2,
  },
  knowledge: {
    name: "Knowledge & Content",
    description: "Bloqs, memory, boards, context, how-to recipes",
    order: 3,
  },
  pages: {
    name: "Pages & Publishing",
    description: "Composable pages, partials, copycat, remotion, uploads",
    order: 4,
  },
  agents: {
    name: "Agents & Automation",
    description: "Platform agents, chat, automations, workflows, schedules",
    order: 5,
  },
  integrations: {
    name: "Integrations & Tools",
    description: "OAuth connect, n8n, skills, tools, marketplace",
    order: 6,
  },
  entities: {
    name: "Entity Management",
    description: "Brands, products, services, events, venues, programs",
    order: 7,
  },
  communication: {
    name: "Communication",
    description: "Phone, voice, email (Apple Mail), iMessage, calendar, transcription",
    order: 8,
  },
  finance: {
    name: "Finance",
    description: "Wallets, payments, Good Deals planning",
    order: 9,
  },
  compute: {
    name: "Hive & Compute",
    description: "Hive nodes, tasks, projects, IRIS-hosted apps",
    order: 10,
  },
  system: {
    name: "System & Admin",
    description: "Users, config, bug reports, SDK calls, eval, diary, SOPs",
    order: 11,
  },
  core: {
    name: "Core CLI",
    description: "Run, auth, models, sessions, export/import, MCP, ACP",
    order: 12,
  },
}

export const COMMAND_CATEGORY_MAP: Record<string, string> = {
  // CRM & Sales
  leads: "crm",
  "leads:meeting": "crm",
  outreach: "crm",
  "outreach-campaign": "crm",
  "outreach-send": "crm",
  "outreach-strategy": "crm",
  som: "crm",
  invoices: "crm",
  deliver: "crm",

  // Atlas OS
  "atlas:ledger": "atlas",
  "atlas:staff": "atlas",
  "atlas:inventory": "atlas",
  "atlas:meetings": "atlas",
  "atlas:brand-kit": "atlas",
  "atlas:comms": "atlas",
  "good-deals": "atlas",

  // Knowledge & Content
  bloqs: "knowledge",
  memory: "knowledge",
  boards: "knowledge",
  bloq: "knowledge",
  "bloq-ingest": "knowledge",
  "bloq-members": "knowledge",
  "how-to": "knowledge",

  // Pages & Publishing
  domains: "pages",
  pages: "pages",
  "pages:batch": "pages",
  partials: "pages",
  copycat: "pages",
  remotion: "pages",
  "cloud:upload": "pages",

  // Agents & Automation
  agents: "agents",
  chat: "agents",
  automation: "agents",
  "automation:test": "agents",
  workflows: "agents",
  schedules: "agents",
  monitor: "agents",

  // Integrations & Tools
  integrations: "integrations",
  connect: "integrations",
  "list-connected": "integrations",
  "list-available": "integrations",
  tools: "integrations",
  skills: "integrations",
  n8n: "integrations",
  "platform-marketplace": "integrations",

  // Entity Management
  brands: "entities",
  products: "entities",
  services: "entities",
  events: "entities",
  venues: "entities",
  programs: "entities",
  opportunities: "entities",
  packages: "entities",
  profile: "entities",

  // Communication
  phone: "communication",
  voice: "communication",
  transcribe: "communication",
  mail: "communication",
  imessage: "communication",
  calendar: "communication",

  // Finance
  wallet: "finance",
  payments: "finance",

  // Hive & Compute
  hive: "compute",
  app: "compute",

  // System & Admin
  users: "system",
  config: "system",
  bug: "system",
  doctor: "system",
  "sdk:call": "system",
  eval: "system",
  diary: "system",
  sop: "system",

  // Core CLI
  completion: "core",
  acp: "core",
  mcp: "core",
  marketplace: "core",
  attach: "core",
  run: "core",
  generate: "core",
  debug: "core",
  auth: "core",
  agent: "core",
  upgrade: "core",
  uninstall: "core",
  serve: "core",
  web: "core",
  models: "core",
  stats: "core",
  export: "core",
  import: "core",
  github: "core",
  pr: "core",
  session: "core",
}

export interface RegisteredCommand {
  name: string
  describe: string
  aliases: string[]
}

const registry: RegisteredCommand[] = []

export function registerCommand(commandModule: any): void {
  const cmdStr = String(commandModule.command ?? "")
  const name = cmdStr.split(/\s/)[0]
  if (!name || name === "$0") return
  registry.push({
    name,
    describe: commandModule.describe ?? "",
    aliases: Array.isArray(commandModule.aliases) ? commandModule.aliases : [],
  })
}

export function getRegistry(): RegisteredCommand[] {
  return registry
}
