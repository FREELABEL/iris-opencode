import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

/**
 * IRIS platform data, served to the desktop UI.
 *
 * The webview cannot reach fl-api or iris-api itself: it can make the request (tauriFetch is
 * wired and the capability grants http/https) but the bearer token lives in the auth store on
 * disk, which only this process can read. So the sidecar is the only place this can happen,
 * and these are the routes that make it possible. See epic #184872.
 */

/**
 * EVERY reply carries `measured`, and it is not decoration.
 *
 * An account with an empty Atlas and an Atlas we could not reach produce the same `lists: []`.
 * A UI that cannot tell them apart will render "nothing here" for "the network is down", which
 * is the reassuring answer and the wrong one. The TUI sidebar shows "unreachable" rather than
 * "0 online" for exactly this reason; putting the distinction in the wire format means the next
 * UI cannot accidentally drop it.
 */
/**
 * The pagination envelope every /iris list carries.
 *
 * `total` is nullable on purpose: null means the upstream never said how many exist, and a
 * client must not render that as zero. `totalIsExact` says whether the number can be stated
 * flatly ("127 playbooks") or only as a floor ("127 so far") — see iris/pagination.ts.
 */
const Paged = {
  page: Schema.Finite,
  perPage: Schema.Finite,
  total: described(Schema.NullOr(Schema.Finite), "NULL means not measured. Never render it as zero."),
  totalIsExact: Schema.Boolean,
  hasMore: Schema.Boolean,
}

const PageQuery = Schema.Struct({
  page: Schema.optional(Schema.NumberFromString),
  perPage: Schema.optional(Schema.NumberFromString),
})

/**
 * Paging plus a filter, for the surfaces that have one.
 *
 * `q` is declared in ONE place so every surface means the same thing by it: matched before
 * paging, against the fields that surface considers searchable.
 */
const SearchQuery = Schema.Struct({
  ...PageQuery.fields,
  q: described(
    Schema.optional(Schema.String),
    "Filter before paging, so the count describes the matches and not a page.",
  ),
})

const Measured = {
  measured: described(Schema.Boolean, "False means NOT MEASURED. Do not render the data as an empty result."),
  reason: Schema.optional(
    described(Schema.String, "Why it could not be measured — an HTTP status, or that nobody is signed in."),
  ),
}

const AtlasItem = Schema.Struct({
  id: Schema.Finite,
  title: Schema.String,
  type: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  content: Schema.optional(described(Schema.String, "The item body, as markdown.")),
  createdAt: Schema.optional(described(Schema.String, "ISO timestamp the item was created.")),
  updatedAt: Schema.optional(described(Schema.String, "ISO timestamp the item was last edited.")),
}).annotate({ identifier: "IrisAtlasItem" })

const AtlasResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  lists: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      items: Schema.Array(AtlasItem),
    }).annotate({ identifier: "IrisAtlasList" }),
  ),
}).annotate({ identifier: "IrisAtlasResponse" })

const HiveResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      status: Schema.String,
      online: Schema.Boolean,
      lastHeartbeat: Schema.NullOr(Schema.String),
      activeTasks: Schema.Finite,
      maxConcurrent: Schema.Finite,
      os: Schema.optional(Schema.String),
      cpu: Schema.optional(Schema.String),
      cores: Schema.optional(Schema.Finite),
      memoryGb: Schema.optional(Schema.Finite),
      diskTotalGb: Schema.optional(Schema.Finite),
      diskFreeGb: Schema.optional(Schema.Finite),
      daemonVersion: Schema.optional(Schema.String),
      uptimeSeconds: Schema.optional(Schema.Finite),
      tasksCompleted: Schema.optional(Schema.Finite),
      capabilities: Schema.optional(Schema.Array(Schema.String)),
      recentRestarts: Schema.optional(Schema.Finite),
      transport: Schema.optional(Schema.String),
      tailscaleIp: Schema.optional(Schema.String),
      hardwareDetectedAt: described(
        Schema.optional(Schema.String),
        "When the hardware snapshot was taken — NOT the heartbeat. Can be many hours older.",
      ),
    }).annotate({ identifier: "IrisHiveNode" }),
  ),
}).annotate({ identifier: "IrisHiveResponse" })

// ── Hive › Scripts (#188817) ─────────────────────────────────────────────────────────────────────
const DoctorRowSchema = Schema.Struct({
  node: described(Schema.String, "A node NAME — names repeat across duplicate registrations of one computer."),
  verdict: Schema.optional(
    Schema.Struct({
      ok: Schema.optional(Schema.Boolean),
      unmet: Schema.optional(Schema.Array(Schema.Struct({ requirement: Schema.String, reason: Schema.String }))),
      summary: Schema.optional(Schema.String),
    }),
  ),
})
const ScriptDoctorSchema = Schema.Struct({
  slug: Schema.String,
  requires: Schema.Array(Schema.String),
  manifest_errors: Schema.Array(Schema.String),
  timeout: Schema.NullOr(Schema.Finite),
  eligible: Schema.Array(DoctorRowSchema),
  eligible_online: described(Schema.NullOr(Schema.Finite), "The HUB's count. NULL = not counted, never zero."),
  blocked: Schema.Array(DoctorRowSchema),
  runnable_now: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "IrisScriptDoctor" })
const ScriptsResponse = Schema.Struct({
  ...Measured,
  scripts: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      name: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
      runtime: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.String),
      lastExecutedAt: described(Schema.NullOr(Schema.String), "Never written by the hub today — do not show as 'last run'."),
      doctor: described(Schema.NullOr(ScriptDoctorSchema), "NULL = the doctor could not be asked, not 'can run'."),
    }).annotate({ identifier: "IrisScriptSummary" }),
  ),
}).annotate({ identifier: "IrisScriptsResponse" })
const ScriptSourceResponse = Schema.Struct({
  ...Measured,
  script: Schema.NullOr(
    Schema.Struct({
      slug: Schema.String,
      name: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
      runtime: Schema.String,
      content: Schema.String,
      sha256: described(Schema.String, "The content hash a run is pinned to."),
      updatedAt: Schema.optional(Schema.String),
      autoPull: Schema.Boolean,
      visibility: Schema.optional(Schema.String),
    }).annotate({ identifier: "IrisScriptSource" }),
  ),
}).annotate({ identifier: "IrisScriptSourceResponse" })
const ScriptDoctorResponse = Schema.Struct({ ...Measured, doctor: Schema.NullOr(ScriptDoctorSchema) }).annotate({
  identifier: "IrisScriptDoctorResponse",
})
const ScriptSaveResponse = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  sha256: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  created: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "IrisScriptSaveResponse" })
const ScriptRunResponse = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  nodeId: Schema.optional(Schema.String),
  nodeName: Schema.optional(Schema.String),
  sha256: described(Schema.optional(Schema.NullOr(Schema.String)), "NULL = the run is UNVERIFIED (no hash could be pinned)."),
  timeoutSeconds: Schema.optional(Schema.Finite),
}).annotate({ identifier: "IrisScriptRunResponse" })
const HiveTaskResponse = Schema.Struct({
  ...Measured,
  task: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      terminal: Schema.Boolean,
      createdAt: Schema.NullOr(Schema.String),
      dispatchedAt: Schema.NullOr(Schema.String),
      arrivedAt: Schema.NullOr(Schema.String),
      startedAt: Schema.NullOr(Schema.String),
      completedAt: Schema.NullOr(Schema.String),
      stdout: Schema.String,
      stderr: Schema.String,
      exitCode: Schema.NullOr(Schema.Finite),
      exitCodeSource: described(
        Schema.NullOr(Schema.Literals(["metadata", "result", "error_text"])),
        "error_text = recovered from the daemon's prose, not reported. Label it as inferred.",
      ),
      error: Schema.NullOr(Schema.String),
      nodeName: Schema.NullOr(Schema.String),
      durationMs: Schema.NullOr(Schema.Finite),
    }).annotate({ identifier: "IrisHiveTask" }),
  ),
}).annotate({ identifier: "IrisHiveTaskResponse" })

const BloqsResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  bloqs: Schema.Array(Schema.Struct({ id: Schema.Finite, name: Schema.String }).annotate({ identifier: "IrisBloq" })),
}).annotate({ identifier: "IrisBloqsResponse" })

const InboxResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  unread: described(
    Schema.NullOr(Schema.Finite),
    "Unread count. NULL means not measured — render it as a dash, never as zero.",
  ),
  from: Schema.optional(Schema.String),
  unreadable: described(Schema.Boolean, "The manifest exists and could not be parsed. A fault, not an empty inbox."),
  items: described(
    Schema.Array(
      Schema.Struct({
        index: described(Schema.Finite, "1-based MANIFEST position — the number `iris hive inbox read <n>` takes."),
        read: Schema.Boolean,
        type: Schema.String,
        from: Schema.String,
        receivedAt: Schema.optional(Schema.String),
        label: Schema.String,
      }).annotate({ identifier: "IrisInboxItem" }),
    ),
    "Unread first, then newest first.",
  ),
}).annotate({ identifier: "IrisInboxResponse" })

const AgentsResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  agents: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      status: Schema.String,
      model: Schema.optional(Schema.String),
      heartbeat: Schema.Boolean,
      schedule: Schema.optional(Schema.String),
      lastRun: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
      active: Schema.optional(Schema.Boolean),
      failures: Schema.optional(Schema.Finite),
      createdAt: Schema.optional(Schema.String),
    }).annotate({ identifier: "IrisAgent" }),
  ),
}).annotate({ identifier: "IrisAgentsResponse" })

const LeadsResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  leads: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      status: Schema.optional(Schema.String),
      company: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
      hot: Schema.Boolean,
      score: Schema.optional(Schema.Finite),
      type: Schema.optional(Schema.String),
      city: Schema.optional(Schema.String),
      country: Schema.optional(Schema.String),
      createdAt: Schema.optional(Schema.String),
      repliedAt: Schema.optional(Schema.Boolean),
      keywords: Schema.optional(Schema.String),
    }).annotate({ identifier: "IrisLead" }),
  ),
}).annotate({ identifier: "IrisLeadsResponse" })

const PagesResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  pages: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      title: Schema.String,
      slug: Schema.optional(Schema.String),
      status: Schema.String,
      url: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.String),
      version: Schema.optional(Schema.Finite),
      publishedAt: Schema.optional(Schema.String),
      visibility: Schema.optional(Schema.String),
      requiresAuth: Schema.optional(Schema.Boolean),
      category: Schema.optional(Schema.String),
    }).annotate({ identifier: "IrisPage" }),
  ),
}).annotate({ identifier: "IrisPagesResponse" })

const AuthResponse = Schema.Struct({
  signedIn: described(Schema.Boolean, "A credential exists somewhere we know to look."),
  source: Schema.String,
  providerCanSee: described(
    Schema.Boolean,
    "Whether the AI provider can read a key. THIS is what predicts whether chat works — the provider reads process.env and nothing else.",
  ),
  verdict: described(
    Schema.Literals(["ready", "signed-out", "unreachable-credential"]),
    "unreachable-credential means signed in but the provider cannot see it — do NOT prompt a re-login for that.",
  ),
}).annotate({ identifier: "IrisAuthResponse" })

const AgentTasksResponse = Schema.Struct({
  ...Measured,
  counts: Schema.Struct({
    itemTasks: Schema.Finite,
    leadTasks: Schema.Finite,
    scheduledJobs: Schema.Finite,
    heartbeatBloqs: Schema.Finite,
    total: described(
      Schema.Finite,
      "Counts the rows in `tasks`, INCLUDING heartbeat boards, which the upstream total omits.",
    ),
  }),
  tasks: Schema.Array(
    Schema.Struct({
      source: described(
        Schema.Literals(["bloq_item_task", "lead_task", "scheduled_job", "heartbeat_bloq"]),
        "Four kinds of work in one list. heartbeat_bloq is a whole board the agent runs on, and the one most likely to be forgotten because nothing about the board mentions it.",
      ),
      id: Schema.Finite,
      title: Schema.String,
      status: Schema.optional(Schema.String),
      done: Schema.Boolean,
      dueDate: Schema.optional(Schema.String),
      itemId: Schema.optional(Schema.Finite),
      itemTitle: Schema.optional(Schema.String),
      bloqId: Schema.optional(Schema.Finite),
      listId: Schema.optional(Schema.Finite),
      leadId: Schema.optional(Schema.Finite),
      nextRunAt: Schema.optional(Schema.String),
      frequency: Schema.optional(Schema.String),
    }).annotate({ identifier: "IrisAgentTask" }),
  ),
}).annotate({ identifier: "IrisAgentTasksResponse" })

const SitesResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  sites: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      slug: Schema.String,
      status: Schema.String,
      pagesCount: described(Schema.Finite, "Attached pages. A site with one page is usually a mistake."),
      homePageId: Schema.optional(Schema.Finite),
      requiresAuth: Schema.Boolean,
      owner: described(Schema.optional(Schema.String), '"bloq 174" or "user 193" — the list mixes both.'),
      description: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.String),
      navItems: Schema.Array(Schema.Struct({ label: Schema.String, url: Schema.String })),
    }).annotate({ identifier: "IrisSite" }),
  ),
}).annotate({ identifier: "IrisSitesResponse" })

const SchemaFieldSchema = Schema.Struct({
  key: described(Schema.String, "The key in a record's `data` map — what a table column reads."),
  label: Schema.String,
  type: Schema.String,
  sortable: Schema.optional(Schema.Boolean),
  filterable: Schema.optional(Schema.Boolean),
  visibility: described(
    Schema.optional(Schema.String),
    '"phi" marks protected health information. Carried so a table can LABEL the column rather than rendering it like any other.',
  ),
}).annotate({ identifier: "IrisSchemaField" })

const RecordsResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  schema: Schema.Struct({
    id: Schema.Finite,
    slug: Schema.String,
    name: Schema.String,
    version: Schema.optional(Schema.Finite),
  }).annotate({ identifier: "IrisRecordSchemaStub" }),
  columns: described(
    Schema.Array(SchemaFieldSchema),
    "From the SCHEMA, not inferred from the rows — a column inferred from data disappears the moment every row on the page has it null.",
  ),
  rows: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      externalId: Schema.optional(Schema.String),
      status: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.String),
      data: described(Schema.Record(Schema.String, Schema.Unknown), "The record's fields, keyed like the columns."),
    }).annotate({ identifier: "IrisRecordRow" }),
  ),
}).annotate({ identifier: "IrisRecordsResponse" })

const SchemasResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  schemas: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      slug: Schema.String,
      version: Schema.optional(Schema.Finite),
      isSystem: Schema.Boolean,
      scope: Schema.Literals(["board", "account"]),
      fields: Schema.Array(SchemaFieldSchema),
      displayField: Schema.optional(Schema.String),
    }).annotate({ identifier: "IrisSchema" }),
  ),
}).annotate({ identifier: "IrisSchemasResponse" })

const IntegrationsResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  integrations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      provider: Schema.optional(Schema.String),
      category: Schema.optional(Schema.String),
      status: Schema.String,
      connected: Schema.Boolean,
      account: Schema.optional(Schema.String),
      scope: described(
        Schema.Literals(["project", "organization", "user"]),
        "DERIVED: bloq_id -> project, organization_id -> organization, else personal.",
      ),
      type: described(Schema.optional(Schema.String), "Provider key, e.g. gmail. What an icon is chosen from."),
      lastTested: Schema.optional(Schema.String),
      lastError: described(
        Schema.optional(Schema.String),
        "Why it is failing. A red dot with no reason is not actionable.",
      ),
      logoUrl: described(
        Schema.optional(Schema.String),
        "Brand mark from the platform's Logo.dev catalogue. Absent is normal.",
      ),
      brandId: described(
        Schema.optional(Schema.Finite),
        "Which brand owns it. 16 of 25 on this account do — see #185160.",
      ),
      authMode: Schema.optional(Schema.String),
      needsTesting: described(
        Schema.optional(Schema.Boolean),
        "The platform has never tested it, so `status` is a guess rather than a measurement.",
      ),
      recentlyTested: Schema.optional(Schema.Boolean),
      functionsCount: Schema.optional(Schema.Finite),
      health: described(
        Schema.optional(
          Schema.Struct({
            state: Schema.String,
            basis: Schema.optional(Schema.String),
            lastVerifiedAt: Schema.optional(Schema.String),
            bars: Schema.Array(Schema.Struct({ state: Schema.String, from: Schema.optional(Schema.String) })),
          }),
        ),
        'PLATFORM health for the provider, NOT your credential. "Is Slack up" and "does your Slack token work" are different questions; a provider can be operational while your connection is broken, which is most of what people actually hit.',
      ),
      usage: described(
        Schema.optional(
          Schema.Struct({
            band: Schema.optional(Schema.String),
            series: Schema.Array(Schema.Struct({ day: Schema.String, v: Schema.Finite })),
          }),
        ),
        "30 days of call counts, for a sparkline.",
      ),
    }).annotate({ identifier: "IrisIntegration" }),
  ),
  attribution: described(
    Schema.optional(Schema.String),
    "Logo.dev credit, as HTML. A CONDITION of the free tier — travels with the logos so the marks cannot be shown without it.",
  ),
}).annotate({ identifier: "IrisIntegrationsResponse" })

const PlaybooksResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  playbooks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      attached: described(Schema.Boolean, "True when attached to THIS board."),
      steps: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          title: Schema.String,
          mode: described(Schema.optional(Schema.String), '"shell" runs a command, "prompt" asks a model.'),
          integrations: Schema.optional(Schema.Array(Schema.String)),
        }).annotate({ identifier: "IrisPlaybookStep" }),
      ),
      args: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          type: Schema.optional(Schema.String),
          required: Schema.optional(Schema.Boolean),
          default: Schema.optional(Schema.String),
          description: Schema.optional(Schema.String),
        }).annotate({ identifier: "IrisPlaybookArg" }),
      ),
      version: Schema.optional(Schema.Finite),
      scope: Schema.optional(Schema.String),
      accessType: Schema.optional(Schema.String),
      active: Schema.optional(Schema.Boolean),
      publishedAt: Schema.optional(Schema.String),
      publicUrl: Schema.optional(Schema.String),
      installs: Schema.optional(Schema.Finite),
      views: Schema.optional(Schema.Finite),
      hasLocal: described(
        Schema.Boolean,
        "Installed where this session can use it: <project>/.iris/playbooks, <project>/.claude/skills or ~/.iris/playbooks (#186277). Playbook content never leaves the machine, so the local document is richer than anything the API has.",
      ),
      localWhere: described(
        Schema.optional(Schema.Literals(["project", "skill", "home"])),
        "Which copy hasLocal found — the project's, a synced skill, or the home install.",
      ),
      installedVersion: described(
        Schema.optional(Schema.Finite),
        "The published version the local copy was installed at, from its .installed.json. Absent for a copy written or synced locally.",
      ),
      edited: described(
        Schema.optional(Schema.Boolean),
        "The local copy changed since it was installed — an update would replace those edits.",
      ),
      action: described(
        Schema.optional(Schema.Literals(["install", "update", "run"])),
        "What the card offers: install (not here), update (installed from the Marketplace and a newer version is published), run (#186274).",
      ),
      sources: described(
        Schema.optional(Schema.Array(Schema.Literals(["project", "installed", "account", "marketplace"]))),
        "view=all only: every place this playbook comes from — this project, installed on this machine, owned by your account, published. One row per name; a name found in several places lists them all.",
      ),
      bloqId: described(Schema.optional(Schema.Finite), "The board it is filed against. 19 of 128 carry one."),
      ownerUserId: Schema.optional(Schema.Finite),
      owned: described(
        Schema.Boolean,
        "Whether the SIGNED-IN account owns it. A reading aid, not a boundary: a list mixing yours with other people's makes you assume all of it is yours to change.",
      ),
    }).annotate({ identifier: "IrisPlaybook" }),
  ),
}).annotate({ identifier: "IrisPlaybooksResponse" })

const SchemaOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  color: Schema.optional(Schema.String),
}).annotate({ identifier: "IrisSchemaOption" })

/** A task on a card. Agent as id + name only — see iris.item. */
const ItemTask = Schema.Struct({
  id: Schema.Finite,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  done: Schema.Boolean,
  status: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.Finite),
  agentName: Schema.optional(Schema.String),
  dueDate: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  depth: described(Schema.Finite, "Nesting depth; getTasks returns a tree and this list is it flattened."),
}).annotate({ identifier: "IrisItemTask" })

const ShareMemberSchema = Schema.Struct({
  userId: Schema.Finite,
  name: Schema.String,
  email: Schema.String,
  permission: Schema.String,
}).annotate({ identifier: "IrisShareMember" })

const ShareLinkSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.optional(Schema.String),
  uses: Schema.Finite,
  revoked: Schema.Boolean,
}).annotate({ identifier: "IrisShareLink" })

const ShareStateResponse = Schema.Struct({
  ...Measured,
  isPublic: Schema.Boolean,
  publicUrl: Schema.optional(Schema.String),
  accessLevel: described(
    Schema.optional(Schema.String),
    "fl-api's ladder label: private | public | gated | password | expiring",
  ),
  allowKnown: described(
    Schema.Boolean,
    "False means this fl-api build does not return the allow-list. An empty list with this false is NOT 'anyone with the link'.",
  ),
  allowedEmails: Schema.Array(Schema.String),
  boardDefaults: Schema.Struct({ allowedEmails: Schema.Array(Schema.String) }),
  members: Schema.Array(ShareMemberSchema),
  links: Schema.Array(ShareLinkSchema),
}).annotate({ identifier: "IrisShareStateResponse" })

const LabelsResponse = Schema.Struct({
  ...Measured,
  labels: Schema.Array(Schema.String),
}).annotate({ identifier: "IrisLabelsResponse" })

const CardFileSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  size: Schema.optional(Schema.Finite),
  type: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  stored: Schema.Boolean,
}).annotate({ identifier: "IrisCardFile" })

const AttachmentsResponse = Schema.Struct({
  ...Measured,
  files: Schema.Array(CardFileSchema),
}).annotate({ identifier: "IrisAttachmentsResponse" })

const CardEventSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  startsAt: Schema.String,
  endsAt: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
}).annotate({ identifier: "IrisCardEvent" })

const EventsResponse = Schema.Struct({
  ...Measured,
  events: Schema.Array(CardEventSchema),
}).annotate({ identifier: "IrisEventsResponse" })

const CardAskSchema = Schema.Struct({
  id: Schema.String,
  to: Schema.String,
  what: Schema.String,
  dueAt: Schema.optional(Schema.String),
  status: Schema.Literals(["open", "answered"]),
  answer: Schema.optional(Schema.String),
}).annotate({ identifier: "IrisCardAsk" })

const AsksResponse = Schema.Struct({
  ...Measured,
  asks: Schema.Array(CardAskSchema),
}).annotate({ identifier: "IrisAsksResponse" })

const ChatMessageSchema = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "agent"]),
  text: Schema.String,
  at: Schema.String,
  agentName: Schema.optional(Schema.String),
}).annotate({ identifier: "IrisChatMessage" })

const ChatResponse = Schema.Struct({
  ...Measured,
  agentId: Schema.optional(Schema.Finite),
  messages: Schema.Array(ChatMessageSchema),
}).annotate({ identifier: "IrisChatResponse" })

// ── Rooms: threaded multi-agent chat with @mention (#186511) ──
const RoomAgentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: Schema.String,
  autoRespond: Schema.Boolean,
}).annotate({ identifier: "IrisRoomAgent" })

const RoomSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  agents: Schema.Array(RoomAgentSchema),
  messageCount: Schema.optional(Schema.Finite),
  updatedAt: Schema.optional(Schema.String),
}).annotate({ identifier: "IrisRoom" })

const RoomMessageSchema = Schema.Struct({
  id: Schema.String,
  sender: Schema.Literals(["user", "agent"]),
  senderId: Schema.String,
  senderName: Schema.String,
  text: Schema.String,
  at: Schema.String,
  inReplyTo: Schema.optional(Schema.String),
  addressees: Schema.Array(Schema.String),
  routing: Schema.optional(Schema.Literals(["mention", "room-default"])),
}).annotate({ identifier: "IrisRoomMessage" })

const RoomsResponse = Schema.Struct({ ...Measured, rooms: Schema.Array(RoomSchema) }).annotate({
  identifier: "IrisRoomsResponse",
})
const RoomResponse = Schema.Struct({
  ...Measured,
  room: Schema.NullOr(RoomSchema),
  messages: Schema.Array(RoomMessageSchema),
}).annotate({ identifier: "IrisRoomResponse" })
const RoomCreateResponse = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  room: Schema.optional(RoomSchema),
}).annotate({ identifier: "IrisRoomCreateResponse" })
const RoomSendResponse = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  message: Schema.optional(RoomMessageSchema),
  replies: Schema.Array(RoomMessageSchema),
}).annotate({ identifier: "IrisRoomSendResponse" })

const ChatSendResponse = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  message: Schema.optional(ChatMessageSchema),
}).annotate({ identifier: "IrisChatSendResponse" })

// A live view of a running agent + take over / hand back (#187921). Argument VALUES never
// appear: iris-api serves each argument's type and length only, so this cannot leak PHI.
const LiveToolCallSchema = Schema.Struct({
  tool: Schema.String,
  iteration: Schema.Finite,
  args: described(Schema.Record(Schema.String, Schema.String), "Argument key → value type and length, never the value."),
  fingerprint: described(Schema.String, "Same fingerprint twice = the same call repeated."),
  status: Schema.Literals(["running", "success", "error", "held", "skipped"]),
  error: Schema.optional(Schema.String),
  startedAt: Schema.String,
  durationMs: Schema.optional(Schema.Finite),
}).annotate({ identifier: "IrisLiveToolCall" })
const LiveTakeoverSchema = Schema.Struct({
  id: Schema.Finite,
  status: Schema.Literals(["pause_requested", "paused", "resuming", "resumed", "cancelled", "expired"]),
  pausedAtIteration: Schema.optional(Schema.Finite),
}).annotate({ identifier: "IrisLiveTakeover" })
const LiveRunSchema = Schema.Struct({
  runId: Schema.String,
  workflowId: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.Finite),
  status: Schema.String,
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  lastEventAt: Schema.optional(Schema.String),
  secondsSinceLastEvent: Schema.optional(Schema.Finite),
  step: Schema.NullOr(
    Schema.Struct({
      iteration: Schema.Finite,
      maxIterations: Schema.optional(Schema.Finite),
      phase: Schema.String,
      tool: Schema.optional(Schema.String),
      since: Schema.optional(Schema.String),
      secondsOnStep: Schema.optional(Schema.Finite),
    }),
  ),
  toolCalls: Schema.Array(LiveToolCallSchema),
  takeover: Schema.NullOr(LiveTakeoverSchema),
}).annotate({ identifier: "IrisLiveRun" })
const AgentLiveResponse = Schema.Struct({ ...Measured, run: Schema.NullOr(LiveRunSchema) }).annotate({
  identifier: "IrisAgentLiveResponse",
})
const RunControlResponse = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  takeover: Schema.optional(Schema.NullOr(LiveTakeoverSchema)),
}).annotate({ identifier: "IrisRunControlResponse" })

const root = "/iris"

/**
 * The weekly allowance, and the notice policy, exactly as the server states them.
 *
 * `thresholds` is a LIST and `window` is a STRING because both are policy that has already
 * changed twice. Nothing downstream of this may turn them into constants: the desktop ships on
 * its own cadence, so a compiled-in threshold is one we cannot change without a release.
 *
 * FETCHING THIS CONSUMES A PENDING NOTICE. The server writes the row that makes "once per
 * week" true as it answers, so a caller that polls and discards has eaten somebody's only
 * warning. Render-time only.
 */
const AllowanceNotice = Schema.Struct({
  threshold: Schema.Finite,
  fraction: Schema.Finite,
  spendUsd: Schema.Finite,
  capUsd: Schema.Finite,
  window: Schema.String,
  resetsAt: Schema.String,
  upgradeUrl: Schema.NullOr(Schema.String),
})

const AllowanceResponse = Schema.Struct({
  measured: described(Schema.Boolean, "FALSE means we could not ask. Never render that as 0% used."),
  reason: Schema.optional(Schema.String),
  window: Schema.String,
  capUsd: described(Schema.NullOr(Schema.Finite), "NULL means uncapped, which is not zero."),
  uncapped: Schema.Boolean,
  spendUsd: Schema.NullOr(Schema.Finite),
  fraction: described(Schema.NullOr(Schema.Finite), "NULL means uncapped or unmeasured. Not 0."),
  resetsAt: Schema.NullOr(Schema.String),
  thresholds: described(Schema.Array(Schema.Finite), "POLICY. Read it, never hold it."),
  surface: Schema.String,
  upgradeUrl: Schema.NullOr(Schema.String),
  notice: Schema.NullOr(AllowanceNotice),
})

/** The caller's plan, read WITHOUT consuming a notice — safe to poll (title bar Upgrade button). */
/** The IRIS plans on sale, from the same package list the web pricing page reads. */
const PlansResponse = Schema.Struct({
  measured: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  plans: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      title: Schema.String,
      subtitle: Schema.NullOr(Schema.String),
      price: Schema.Number,
      period: Schema.String,
      features: Schema.Array(Schema.String),
      trialDays: Schema.NullOr(Schema.Number),
      popular: Schema.Boolean,
    }),
  ),
})

const PlanResponse = Schema.Struct({
  measured: described(Schema.Boolean, "FALSE means we could not ask. Never render that as the Free plan."),
  reason: Schema.optional(Schema.String),
  plan: described(Schema.NullOr(Schema.String), "free | pro | business; NULL for staff."),
  paid: described(Schema.NullOr(Schema.Boolean), "Has this person paid. NULL = unknown; only false shows Upgrade."),
  uncapped: Schema.Boolean,
  upgradeUrl: Schema.NullOr(Schema.String),
})

/**
 * Settings > Account (#187966 K1 + K2). Identity, plan and allowance in one read, so the tab
 * cannot show one person's name beside another's usage. The allowance is read with ?peek=1, so
 * opening Settings never consumes the weekly notice.
 */
const MeResponse = Schema.Struct({
  measured: described(Schema.Boolean, "FALSE means we could not ask who you are. Not the same as signed out."),
  reason: Schema.optional(Schema.String),
  signedIn: Schema.Boolean,
  credential: described(
    Schema.Literals(["personal", "machine", "rejected", "none"]),
    "machine = this computer's Hive node key, not a person. rejected = IRIS refused the key (401/403).",
  ),
  panelsDiffer: described(
    Schema.Boolean,
    "The panels (Atlas, Hive) resolve a different credential from the one chat uses (#188506).",
  ),
  tokenSource: described(Schema.String, "Where the credential came from. A Hive node key is not a person."),
  id: Schema.NullOr(Schema.Finite),
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  plan: PlanResponse,
  allowance: AllowanceResponse,
})

/**
 * ARTIFACTS (epic #186508). What the agent made in this session, from the store in
 * src/iris/artifacts.ts. Both routes return JSON. Neither returns an HTML document, and none
 * ever may (ADR-01): the panel places `content` into a sandboxed `srcdoc` iframe, and an iframe
 * pointed at an /iris URL would be same-origin with the app, with the sandbox mere decoration.
 */
const ArtifactAuthor = Schema.Struct({
  agent: Schema.String,
  session: Schema.optional(Schema.String),
}).annotate({ identifier: "IrisArtifactAuthor" })

const ArtifactPublished = Schema.Struct({
  pageId: Schema.Finite,
  slug: Schema.String,
  url: Schema.String,
  visibility: Schema.Literals(["public", "unlisted", "private"]),
  requiresAuth: Schema.Boolean,
  revision: Schema.Finite,
  at: Schema.String,
}).annotate({ identifier: "IrisArtifactPublished" })

const ArtifactMeta = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  kind: Schema.Literals(["html", "markdown", "csv", "code"]),
  revision: described(Schema.Finite, "Bumps on every write. The panel reloads the preview when it changes."),
  created: Schema.String,
  updated: Schema.String,
  filename: Schema.String,
  language: Schema.optional(Schema.String),
  author: described(
    Schema.optional(ArtifactAuthor),
    "Who wrote the current revision — the pane shows it on every row.",
  ),
  createdBy: Schema.optional(ArtifactAuthor),
  published: described(
    Schema.optional(ArtifactPublished),
    "The Genesis page this artifact was published to — one page, updated in place.",
  ),
}).annotate({ identifier: "IrisArtifactMeta" })

const ArtifactQuery = Schema.Struct({
  session: described(Schema.String, "The session whose artifacts to read. One path segment: letters, digits, _ and -."),
  project: described(
    Schema.optional(Schema.String),
    "The session's project directory (absolute). Absent or invalid means the home store, ~/.iris/artifacts.",
  ),
})

const ArtifactWhere = {
  root: described(
    Schema.Literals(["project", "user"]),
    "Which store was read: <project>/.iris/artifacts or ~/.iris/artifacts.",
  ),
  dir: described(Schema.String, "The store folder on disk, for Reveal."),
}

export const IrisPaths = {
  auth: `${root}/auth`,
  bloqs: `${root}/bloqs`,
  inbox: `${root}/inbox`,
  atlas: `${root}/atlas/:bloqID`,
  agents: `${root}/agents/:bloqID`,
  leads: `${root}/leads/:bloqID`,
  pages: `${root}/pages/:bloqID`,
  schemas: `${root}/schemas/:bloqID`,
  playbooks: `${root}/playbooks/:bloqID`,
  integrations: `${root}/integrations/:bloqID`,
  records: `${root}/records/:bloqID/:slug`,
  sites: `${root}/sites/:bloqID`,
  agentTasks: `${root}/agents/:agentID/tasks`,
  agentLive: `${root}/agents/:agentID/live`,
  runTakeOver: `${root}/runs/:runID/take-over`,
  runHandBack: `${root}/runs/:runID/hand-back`,
  playbookDoc: `${root}/playbooks/doc/:name`,
  artifacts: `${root}/artifacts`,
  artifactDoc: `${root}/artifacts/:artifactID`,
  artifactPublish: `${root}/artifacts/:artifactID/publish`,
  playbookInstall: `${root}/playbooks/install`,
  catalog: `${root}/catalog`,
  integrationConnect: `${root}/integrations/connect`,
  onboardingState: `${root}/onboarding/state`,
  onboardingMail: `${root}/onboarding/mail`,
  onboardingGround: `${root}/onboarding/ground`,
  onboardingCapabilities: `${root}/onboarding/capabilities`,
  onboardingWorkspace: `${root}/onboarding/workspace`,
  onboardingTrack: `${root}/onboarding/track`,
  cliCommands: `${root}/commands`,
  hivePeers: `${root}/hive/peers`,
  graph: `${root}/graph`,
  graphBoard: `${root}/graph/:bloqID`,
  pageDoc: `${root}/page/:pageID`,
  pageSave: `${root}/page/:pageID/save`,
  item: `${root}/item/:itemID`,
  itemSave: `${root}/item/:itemID/save`,
  itemTaskAdd: `${root}/item/:itemID/tasks`,
  itemTaskSave: `${root}/item/:itemID/tasks/:taskID/save`,
  itemTaskDelete: `${root}/item/:itemID/tasks/:taskID/delete`,
  cardSchema: `${root}/card-schema/:bloqID`,
  itemShare: `${root}/item/:itemID/share`,
  itemShareVisibility: `${root}/item/:itemID/share/visibility`,
  itemShareAllowlist: `${root}/item/:itemID/share/allowlist`,
  itemShareInvite: `${root}/item/:itemID/share/invite`,
  itemSharePermission: `${root}/item/:itemID/share/permission`,
  itemShareRevoke: `${root}/item/:itemID/share/revoke`,
  itemShareLink: `${root}/item/:itemID/share/link`,
  itemShareLinkRevoke: `${root}/item/:itemID/share/link/:linkID/revoke`,
  itemLabels: `${root}/item/:itemID/labels`,
  itemAttachments: `${root}/item/:itemID/attachments`,
  itemAttachmentDelete: `${root}/item/:itemID/attachments/:fileID/delete`,
  itemEvents: `${root}/item/:itemID/events`,
  itemAsks: `${root}/item/:itemID/asks`,
  itemAskAnswer: `${root}/item/:itemID/asks/:askID/answer`,
  itemChat: `${root}/item/:itemID/chat`,
  rooms: `${root}/rooms`,
  room: `${root}/rooms/:roomID`,
  roomMessages: `${root}/rooms/:roomID/messages`,
  hive: `${root}/hive`,
  hiveScripts: `${root}/hive/scripts`,
  hiveScript: `${root}/hive/scripts/:slug`,
  hiveScriptDoctor: `${root}/hive/scripts/:slug/doctor`,
  hiveScriptSave: `${root}/hive/scripts/:slug/save`,
  hiveScriptRun: `${root}/hive/scripts/:slug/run`,
  hiveTask: `${root}/hive/tasks/:taskID`,
  allowance: `${root}/allowance`,
  plan: `${root}/plan`,
  me: `${root}/me`,
  signOut: `${root}/sign-out`,
  plans: `${root}/plans`,
  atlasNote: `${root}/atlas-note`,
  frameCheck: `${root}/frame-check`,
} as const

export const IrisApi = HttpApi.make("iris").add(
  HttpApiGroup.make("iris")
    .add(
      HttpApiEndpoint.get("auth", IrisPaths.auth, {
        success: described(AuthResponse, "Whether the app can authenticate, and which way it is broken"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.auth",
          summary: "Credential state",
          description:
            "Three states, not two. A key can exist in the auth store and still be invisible to the provider, which is why a signed-in machine could send a message and get a raw 401 with no prompt.",
        }),
      ),
      HttpApiEndpoint.get("allowance", IrisPaths.allowance, {
        success: described(AllowanceResponse, "The weekly allowance, the notice policy, and any notice now due"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.allowance",
          summary: "Allowance and notice policy",
          description:
            "The window, the amount, the reset instant, the threshold list and any pending notice. The thresholds travel because the client must not hold a policy the server can change without a desktop release. Fetching CONSUMES a pending notice — call it when rendering, never on a timer.",
        }),
      ),
      HttpApiEndpoint.get("plan", IrisPaths.plan, {
        success: described(PlanResponse, "The caller's plan, without consuming any notice"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.plan",
          summary: "Plan",
          description:
            "free, pro or business (null for staff), read with ?peek=1 so it never eats the weekly allowance notice. Safe to poll.",
        }),
      ),
      HttpApiEndpoint.get("me", IrisPaths.me, {
        success: described(MeResponse, "Who the app is acting as, their plan, and their allowance"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.me",
          summary: "Account",
          description:
            "Identity from fl-api, plan and allowance from fl-iris-api. The allowance is peeked, so this never consumes the weekly notice and is safe to call whenever Settings opens.",
        }),
      ),
      HttpApiEndpoint.post("signOut", IrisPaths.signOut, {
        success: described(
          Schema.Struct({ ok: Schema.Boolean, removed: Schema.Array(Schema.String) }).annotate({
            identifier: "IrisSignOutResult",
          }),
          "What was removed. The Hive node key is never touched.",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.signOut",
          summary: "Sign out of IRIS on this machine",
          description:
            "Removes the personal sign-in shared by the desktop and the CLI: IRIS_API_KEY and IRIS_USER_ID from ~/.iris/sdk/.env and the `iris` auth-store entry. Leaves ~/.iris/config.json (the Hive node key) alone. The engine still holds the old key until it restarts; the desktop restarts the app afterwards.",
        }),
      ),
      HttpApiEndpoint.get("plans", IrisPaths.plans, {
        success: described(PlansResponse, "The IRIS plans on sale"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.plans",
          summary: "Plans",
          description: "Self-serve IRIS plans with live prices, for the desktop Upgrade dialog.",
        }),
      ),
      HttpApiEndpoint.get("bloqs", IrisPaths.bloqs, {
        query: PageQuery,
        success: described(BloqsResponse, "The account's bloqs"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.bloqs",
          summary: "List bloqs",
          description:
            "Every bloq on the account, for a project picker. The desktop app has no bloq concept of its own and six platform surfaces are bloq-scoped, so without this a caller has to hardcode an id.",
        }),
      ),
      HttpApiEndpoint.get("inbox", IrisPaths.inbox, {
        query: PageQuery,
        success: described(InboxResponse, "Hive inbox state, and the messages themselves"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.inbox",
          summary: "Hive inbox state",
          description:
            "Unread count AND the messages, from the local inbox manifest. A file read, not a request — which is why it must come through the sidecar: the webview cannot read the user's home directory. `total` counts the items returned; `reason` says so when some manifest lines could not be parsed and are therefore missing from the list.",
        }),
      ),
      HttpApiEndpoint.get("atlas", IrisPaths.atlas, {
        query: Schema.Struct({
          ...PageQuery.fields,
          q: described(
            Schema.optional(Schema.String),
            "Filter this board's lists and items by title, description or BODY. Applied to the whole board before paging, so the count describes the matches and not a page. NOT the platform's global search, which is account-wide and would put another board's items under this board's heading.",
          ),
        }),
        params: { bloqID: Schema.NumberFromString },
        success: described(AtlasResponse, "Atlas lists and items for one bloq"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.atlas",
          summary: "Get Atlas for a bloq",
          description:
            "Lists and items for one bloq, fetched from fl-api with the signed-in user's token. Check `measured` before rendering: false means the fetch failed, not that the bloq is empty.",
        }),
      ),
      HttpApiEndpoint.get("agents", IrisPaths.agents, {
        query: Schema.Struct({
          ...SearchQuery.fields,
          mode: described(
            Schema.optional(Schema.Literals(["all", "scheduled", "ondemand"])),
            "Narrowed SERVER-SIDE, before paging — so `total` counts the agents in this mode, not all of them. Filtering a page on the client would report the page's leftovers as the whole set.",
          ),
        }),
        params: { bloqID: Schema.NumberFromString },
        success: described(AgentsResponse, "Agents on this bloq, merged with their schedules"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.agents",
          summary: "List agents",
          description:
            "Agents for one bloq, each carrying its schedule. `reason` is set with `measured: true` when the agents loaded but their schedules did not — a partial answer that must not read as 'nothing is scheduled'.",
        }),
      ),
      HttpApiEndpoint.get("leads", IrisPaths.leads, {
        query: SearchQuery,
        params: { bloqID: Schema.NumberFromString },
        success: described(LeadsResponse, "Leads on this bloq"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.leads",
          summary: "List leads",
          description:
            "Leads for one bloq. Personal data — this is the route to look at first when reviewing what the local server exposes.",
        }),
      ),
      HttpApiEndpoint.get("pages", IrisPaths.pages, {
        query: SearchQuery,
        params: { bloqID: Schema.NumberFromString },
        success: described(PagesResponse, "Pages owned by this bloq"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.pages",
          summary: "List pages",
          description: "Pages owned by one bloq. Narrowed by owner_type/owner_id, not filtered client-side.",
        }),
      ),
      HttpApiEndpoint.get("schemas", IrisPaths.schemas, {
        query: SearchQuery,
        params: { bloqID: Schema.NumberFromString },
        success: described(SchemasResponse, "Atlas dataset schemas on this board"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.schemas",
          summary: "List Atlas schemas",
          description:
            "Dataset schemas for one board. fl-api returns every schema on the ACCOUNT with no board filter, so the narrowing happens server-side here — an unfiltered list under a board heading is the same bug Pages already had once.",
        }),
      ),
      HttpApiEndpoint.get("playbooks", IrisPaths.playbooks, {
        query: Schema.Struct({
          ...SearchQuery.fields,
          view: described(
            Schema.optional(Schema.Literals(["all", "project", "marketplace"])),
            "all = everything you can run: this project's, installed on this machine, and your account's — one row per name, each with `sources`. Not the public catalogue. project = attached to this board or filed against it. marketplace = actually published (public or unlisted). `private` is neither: yours and unshared. Omitted = every row the platform returned.",
          ),
          project: described(
            Schema.optional(Schema.String),
            "The session's project directory, so 'installed here' counts <project>/.iris/playbooks and <project>/.claude/skills (#186277). Absolute path; anything else is ignored.",
          ),
        }),
        params: { bloqID: Schema.NumberFromString },
        success: described(PlaybooksResponse, "Playbooks, board-attached first then the account set"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.playbooks",
          summary: "List playbooks",
          description:
            "BOTH the board's attached playbooks and the account's full set, each flagged. Never one or the other — the TUI shipped either/or and each half hid something.",
        }),
      ),
      HttpApiEndpoint.get("graph", IrisPaths.graph, {
        query: PageQuery,
        success: described(
          Schema.Struct({
            ...Measured,
            ...Paged,
            summary: Schema.Struct({
              nodes: Schema.Finite,
              edges: Schema.Finite,
              isolated: described(Schema.Finite, "Boards with no relation to anything. Most of them."),
              isolatedPct: Schema.Finite,
              largestDegree: Schema.Finite,
            }),
            rows: Schema.Array(
              Schema.Struct({
                id: Schema.Finite,
                name: Schema.String,
                degree: Schema.Finite,
                links: Schema.Array(
                  Schema.Struct({
                    id: Schema.Finite,
                    name: Schema.String,
                    type: Schema.String,
                    direction: described(
                      Schema.Literals(["out", "in"]),
                      "Edges are directional — `feeds_into` read from the wrong end is a different claim.",
                    ),
                  }),
                ),
              }).annotate({ identifier: "IrisGraphRow" }),
            ),
          }).annotate({ identifier: "IrisGraphResponse" }),
          "Board-to-board relations, connected boards first",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.graph",
          summary: "The bloq relationship graph",
          description:
            "A REAL endpoint, worth saying because the obvious place to look says otherwise: Elon's RelationshipGraph is fed by a computed property that assembles one board's contents client-side and has no endpoint. This is a different graph — bloq to bloq across the account — served whole at 12 KB with degree per node.",
        }),
      ),
      HttpApiEndpoint.get("graphBoard", IrisPaths.graphBoard, {
        params: { bloqID: Schema.NumberFromString },
        query: Schema.Struct({
          expand: described(
            Schema.optional(Schema.String),
            "Comma-separated list ids to draw IN FULL, e.g. `expand=1871,1902`. A list holds at most six card nodes by default and collapses the rest into one `+N more` — readable, but a card with no node cannot be clicked open. Expanding a list restores every card in it as a real node; every other list stays capped. Unknown ids are ignored.",
          ),
        }),
        success: described(
          Schema.Struct({
            ...Measured,
            nodes: Schema.Array(
              Schema.Struct({
                id: described(
                  Schema.String,
                  "ELON's ids — `bloq-12` (centre or related board), `agents-hub`, `leadstatus-hot`, `list-900`, `item-88`. A STRING because an item id can equal a board id.",
                ),
                name: Schema.String,
                type: described(
                  Schema.String,
                  "One of ELON's node types, assigned by ELON's rules (list and item types are inferred from titles).",
                ),
                subtitle: Schema.optional(Schema.String),
                meta: Schema.optional(Schema.String),
                size: Schema.Finite,
              }).annotate({ identifier: "IrisInteriorNode" }),
            ),
            edges: Schema.Array(
              Schema.Struct({
                source: Schema.String,
                target: Schema.String,
                type: described(
                  Schema.optional(Schema.String),
                  "Set only on relations to other boards (parent, sibling, feeds_into, …). ELON's hub and child edges carry a label or nothing — REQUIRED here, an ELON-shaped payload failed to encode.",
                ),
                label: Schema.optional(Schema.String),
              }).annotate({ identifier: "IrisInteriorEdge" }),
            ),
            unread: described(
              Schema.optional(Schema.Array(Schema.String)),
              "Sources that could not be read. Each drops its hub, as in ELON — named here so a missing hub is not read as an empty category.",
            ),
          }).annotate({ identifier: "IrisGraphBoardResponse" }),
          "One board's interior: Atlas, category hubs, and the items under them",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.graphBoard",
          summary: "One board's interior graph",
          description:
            "The OTHER graph. `/iris/graph` is board-to-board across the account; this is what is INSIDE one board, which is what Elon's RelationshipGraph draws. Cards are capped at six per list with the remainder collapsed into a `+N more` node; pass `expand` to draw one list's cards in full. Elon has no endpoint for it — its computed property reads a store the board view already filled — so this fans out to the per-board fetchers instead. ONE BOARD PER CALL, deliberately: the panel asks on expand, because doing this for forty boards eagerly is forty fan-outs and thousands of nodes before anything is drawn. A category that is empty gets no hub, since an empty hub cannot be told from a failed fetch and these fetches fail independently.",
        }),
      ),
      HttpApiEndpoint.get("catalog", IrisPaths.catalog, {
        query: SearchQuery,
        success: described(
          Schema.Struct({
            ...Measured,
            ...Paged,
            catalog: Schema.Array(
              Schema.Struct({
                type: Schema.String,
                name: Schema.String,
                category: Schema.optional(Schema.String),
                description: Schema.optional(Schema.String),
                mode: described(
                  Schema.optional(Schema.String),
                  "brokered | key | bridge | oauth — what connecting actually involves. A key integration wants a credential you hold; brokered and oauth open a browser round trip; bridge talks to an app on this Mac rather than a service.",
                ),
                oauthRequired: Schema.Boolean,
                functionsCount: Schema.optional(Schema.Finite),
                connected: Schema.Boolean,
                logoUrl: Schema.optional(Schema.String),
                command: Schema.String,
                // The registry experience (#186542). PLATFORM reachability — we ask the provider
                // whether it answers, with no credential attached. It does NOT say your own
                // connection works, and a UI that implies otherwise is lying quietly.
                health: Schema.optional(
                  Schema.Struct({
                    state: described(
                      Schema.optional(Schema.String),
                      "operational | degraded | not_checked | not_applicable. ABSENT means nothing has measured it — never render that as down.",
                    ),
                    lastCheckedAt: Schema.optional(Schema.String),
                    bars: Schema.Array(Schema.Struct({ from: Schema.optional(Schema.String), state: Schema.String })),
                  }),
                ),
                // Platform-wide usage as a SHAPE: each point is relative to this connector's own
                // busiest day. Absolute volume is deliberately not published — call volume is a
                // customer's operational throughput.
                usage: Schema.optional(
                  Schema.Struct({
                    band: Schema.optional(Schema.String),
                    series: Schema.Array(Schema.Struct({ day: Schema.optional(Schema.String), v: Schema.Finite })),
                  }),
                ),
                // What an agent gets, ranked where use was measured. `share` is relative to the
                // most-called command; absent means not measured, not "never called".
                functions: Schema.optional(
                  Schema.Array(
                    Schema.Struct({
                      name: Schema.String,
                      label: Schema.optional(Schema.String),
                      share: Schema.optional(Schema.Finite),
                      rank: Schema.optional(Schema.Finite),
                    }),
                  ),
                ),
              }).annotate({ identifier: "IrisCatalogEntry" }),
            ),
            attribution: Schema.optional(Schema.String),
          }).annotate({ identifier: "IrisCatalogResponse" }),
          "Integrations you could add, and what adding each one takes",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.catalog",
          summary: "Integrations available to add",
          description:
            'Already-connected rows are dropped — this answers "what can I add", and the ones you have are the other tabs.',
        }),
      ),
      HttpApiEndpoint.get("pageDoc", IrisPaths.pageDoc, {
        params: { pageID: Schema.NumberFromString },
        success: described(
          Schema.Struct({
            ...Measured,
            id: Schema.Finite,
            title: Schema.String,
            slug: Schema.optional(Schema.String),
            status: Schema.String,
            visibility: Schema.optional(Schema.String),
            currentVersion: described(
              Schema.optional(Schema.Finite),
              "Send this back as expected_version. Without it a save is a blind overwrite.",
            ),
            publicUrl: Schema.optional(Schema.String),
            json: described(Schema.String, "json_content, pretty-printed, for editing."),
          }).annotate({ identifier: "IrisPageDoc" }),
          "One Genesis page's JSON, for editing",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.pageDoc",
          summary: "Read a page for editing",
        }),
      ),
      HttpApiEndpoint.post("playbookInstall", IrisPaths.playbookInstall, {
        payload: Schema.Struct({
          name: Schema.String,
          project: Schema.optional(Schema.String),
          force: Schema.optional(Schema.Boolean),
        }),
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            message: Schema.String,
            version: Schema.optional(Schema.Finite),
            location: Schema.optional(Schema.String),
            path: Schema.optional(Schema.String),
          }).annotate({ identifier: "IrisPlaybookInstallResult" }),
          "Whether the install landed, and where",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.playbookInstall",
          summary: "Install or update a playbook",
          description:
            "Runs the real `iris playbook install <name> --json` (no shell; name must be a slug) — into the session's project when `project` is sent, otherwise the home folder. `force` replaces the local copy (Update). The failure message is the CLI's own words (#186274).",
        }),
      ),
      HttpApiEndpoint.post("pageSave", IrisPaths.pageSave, {
        params: { pageID: Schema.NumberFromString },
        payload: Schema.Struct({
          json: Schema.String,
          expectedVersion: Schema.optional(Schema.Finite),
        }),
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            reason: Schema.optional(Schema.String),
            version: Schema.optional(Schema.Finite),
          }).annotate({ identifier: "IrisPageSaveResult" }),
          "Whether the save landed, and the new version",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.pageSave",
          summary: "Save a page's JSON",
          description:
            "PINNED to the version it was read at. fl-api refuses the write if the page moved since, which is the whole difference between saving and clobbering — `iris pages push` has no divergence check (#183600) and has overwritten other people's work. A stale save comes back as a refusal naming the conflict, never as a success that quietly won.",
        }),
      ),
      HttpApiEndpoint.get("item", IrisPaths.item, {
        params: { itemID: Schema.NumberFromString },
        success: described(
          Schema.Struct({
            ...Measured,
            id: Schema.Finite,
            title: Schema.String,
            content: described(Schema.String, "The readable body: the markdown itself, or a structured body's text."),
            contentKind: described(
              Schema.Literals(["markdown", "structured"]),
              "How the body is stored. STRUCTURED means fl-api holds a JSON object (Elon's {text, labels, assignedAgents, …}); saving its text goes through content_merge so the other keys survive.",
            ),
            description: Schema.optional(Schema.String),
            cardType: described(
              Schema.optional(Schema.String),
              "Elon's Type pill — the card_type column, not the type enum.",
            ),
            priority: Schema.optional(Schema.String),
            status: Schema.optional(Schema.String),
            dueDate: described(Schema.optional(Schema.String), "YYYY-MM-DD"),
            listId: Schema.optional(Schema.Finite),
            listName: Schema.optional(Schema.String),
            labels: described(
              Schema.Array(Schema.String),
              "Label names from a structured body. Read-only here; they live inside content.",
            ),
            isPublic: Schema.Boolean,
            publicUrl: Schema.optional(Schema.String),
            updatedAt: Schema.optional(Schema.String),
            tasks: Schema.Array(ItemTask),
            tasksMeasured: described(
              Schema.Boolean,
              "False means the tasks could NOT be read. An empty list with this false is not an item with no tasks.",
            ),
            tasksReason: Schema.optional(Schema.String),
          }).annotate({ identifier: "IrisItemDoc" }),
          "One board item with its tasks, for editing",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.item",
          summary: "Read a card for editing",
          description:
            "The item and its tasks in one reply, from two fl-api routes that fail independently — so `measured` covers the item and `tasksMeasured` covers the tasks. Each task carries its agent's id and name only: fl-api embeds the whole agent, system prompt included, and that has no business in a task list.",
        }),
      ),
      HttpApiEndpoint.post("itemSave", IrisPaths.itemSave, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({
          title: Schema.optional(Schema.String),
          body: Schema.optional(Schema.String),
          bodyMode: described(
            Schema.optional(Schema.Literals(["replace", "merge"])),
            "REPLACE sends `content`; MERGE sends `content_merge {text, body}`. Use merge for a structured body or its labels and agents are gone.",
          ),
          status: Schema.optional(Schema.String),
          priority: Schema.optional(Schema.NullOr(Schema.String)),
          cardType: Schema.optional(Schema.NullOr(Schema.String)),
          dueDate: described(Schema.optional(Schema.NullOr(Schema.String)), "YYYY-MM-DD, or null to clear"),
          listId: described(Schema.optional(Schema.Finite), "Move the item to this list on the same board"),
        }),
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            reason: Schema.optional(Schema.String),
          }).annotate({ identifier: "IrisItemSaveResult" }),
          "Whether the save landed",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemSave",
          summary: "Save a card's fields",
          description:
            "A PATCH in spirit: only the fields present are sent to fl-api's PUT /user/bloqs/list/item/{id}, so saving a title cannot blank the body. Status is checked against the set fl-api accepts before the request is made, and a 422 comes back as the field errors it named, not as a status code.",
        }),
      ),
      HttpApiEndpoint.post("itemTaskAdd", IrisPaths.itemTaskAdd, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({
          title: Schema.String,
          agentId: described(
            Schema.optional(Schema.Finite),
            "Assign the task to this agent. This is how an agent is put on a card.",
          ),
          dueDate: Schema.optional(Schema.String),
        }),
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            reason: Schema.optional(Schema.String),
            task: Schema.optional(ItemTask),
          }).annotate({ identifier: "IrisItemTaskAddResult" }),
          "The task as fl-api stored it",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemTaskAdd",
          summary: "Add a task to a card",
          description:
            'With `agentId` this IS assignment: there is deliberately no agent column on items, so "this agent is on that card" is a task carrying the agent — the primitive `iris agents assign --item` writes and `iris agents tasks` reads back.',
        }),
      ),
      HttpApiEndpoint.post("itemTaskSave", IrisPaths.itemTaskSave, {
        params: { itemID: Schema.NumberFromString, taskID: Schema.NumberFromString },
        payload: Schema.Struct({
          done: Schema.optional(Schema.Boolean),
          title: Schema.optional(Schema.String),
        }),
        success: described(
          Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
            identifier: "IrisOk",
          }),
          "Whether it landed",
        ),
      }).annotateMerge(
        OpenApi.annotations({ identifier: "iris.itemTaskSave", summary: "Complete, reopen or retitle a task" }),
      ),
      HttpApiEndpoint.post("itemTaskDelete", IrisPaths.itemTaskDelete, {
        params: { itemID: Schema.NumberFromString, taskID: Schema.NumberFromString },
        success: described(
          Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
            identifier: "IrisOk",
          }),
          "Whether it landed",
        ),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.itemTaskDelete", summary: "Delete a task" })),
      HttpApiEndpoint.get("cardSchema", IrisPaths.cardSchema, {
        params: { bloqID: Schema.NumberFromString },
        success: described(
          Schema.Struct({
            ...Measured,
            type: Schema.Array(SchemaOption),
            priority: Schema.Array(SchemaOption),
            status: Schema.Array(SchemaOption),
          }).annotate({ identifier: "IrisCardSchema" }),
          "The board's card vocabulary",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.cardSchema",
          summary: "What Type, Priority and Status can be on this board",
          description:
            "fl-api's effective card schema: defaults merged with the board's overrides, the same set Elon's Board.vue reads. Note the status list is a vocabulary, not the column's enum — `active` is a legal stored status the schema does not name, and the editor keeps whatever the item already has.",
        }),
      ),
      // ── The card editor's second pass (#185506). Sharing · Labels · Attachments · Events · Asks · Chat ──
      HttpApiEndpoint.get("itemShare", IrisPaths.itemShare, {
        params: { itemID: Schema.NumberFromString },
        query: Schema.Struct({ bloq: Schema.optional(Schema.NumberFromString) }),
        success: described(ShareStateResponse, "Who can open this card, and how"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemShare",
          summary: "The card's sharing state",
          description:
            "Four fl-api reads folded into one: the item's is_public / public_url / share_allowed_emails, the board's share-defaults, the board's shared users, and the board's share links. `measured` is false only when the ITEM could not be read; a board read that fails leaves its list empty and says so in `reason`. An EMPTY allow-list on a public item admits anyone with the link — the UI says that out loud; this route never rewrites an empty list into something else.",
        }),
      ),
      HttpApiEndpoint.post("itemShareVisibility", IrisPaths.itemShareVisibility, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({ public: Schema.Boolean }),
        success: Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
          identifier: "IrisOk",
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemShareVisibility",
          summary: "Make a card public or private (make-public / make-private)",
        }),
      ),
      HttpApiEndpoint.post("itemShareAllowlist", IrisPaths.itemShareAllowlist, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({ emails: Schema.Array(Schema.String) }),
        success: Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
          identifier: "IrisOk",
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemShareAllowlist",
          summary: "Who can open the public link — emails and @domains",
        }),
      ),
      HttpApiEndpoint.post("itemShareInvite", IrisPaths.itemShareInvite, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({ email: Schema.String, permission: Schema.String, bloq: Schema.Finite }),
        success: Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
          identifier: "IrisOk",
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemShareInvite",
          summary: "Invite someone to the BOARD (there is no per-item membership)",
        }),
      ),
      HttpApiEndpoint.post("itemSharePermission", IrisPaths.itemSharePermission, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({ userId: Schema.Finite, permission: Schema.String, bloq: Schema.Finite }),
        success: Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
          identifier: "IrisOk",
        }),
      }).annotateMerge(
        OpenApi.annotations({ identifier: "iris.itemSharePermission", summary: "Change a board member's permission" }),
      ),
      HttpApiEndpoint.post("itemShareRevoke", IrisPaths.itemShareRevoke, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({ userId: Schema.Finite, bloq: Schema.Finite }),
        success: Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
          identifier: "IrisOk",
        }),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.itemShareRevoke", summary: "Remove a board member" })),
      HttpApiEndpoint.post("itemShareLink", IrisPaths.itemShareLink, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({ bloq: Schema.Finite, expiresInDays: Schema.optional(Schema.Finite) }),
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            reason: Schema.optional(Schema.String),
            link: Schema.optional(ShareLinkSchema),
          }).annotate({ identifier: "IrisShareLinkCreated" }),
          "The new link. It is a BEARER link: whoever holds the URL is in.",
        ),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.itemShareLink", summary: "Create a board share link" })),
      HttpApiEndpoint.post("itemShareLinkRevoke", IrisPaths.itemShareLinkRevoke, {
        params: { itemID: Schema.NumberFromString, linkID: Schema.String },
        payload: Schema.Struct({ bloq: Schema.Finite }),
        success: Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
          identifier: "IrisOk",
        }),
      }).annotateMerge(
        OpenApi.annotations({ identifier: "iris.itemShareLinkRevoke", summary: "Revoke a board share link" }),
      ),
      HttpApiEndpoint.post("itemLabels", IrisPaths.itemLabels, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({ labels: Schema.Array(Schema.String) }),
        success: described(LabelsResponse, "The labels as stored, after the write"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemLabels",
          summary: "Set a card's labels",
          description:
            "Labels live INSIDE content JSON. A structured body gets content_merge {labels}; a markdown body is converted to {text: <the markdown>, labels} because there is nowhere else to keep them — the readable body is unchanged. The item's current card_type and priority are sent back explicitly so fl-api's label-derivation does not silently rewrite them.",
        }),
      ),
      HttpApiEndpoint.get("itemAttachments", IrisPaths.itemAttachments, {
        params: { itemID: Schema.NumberFromString },
        success: described(AttachmentsResponse, "content.attachments, with `stored` per file"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.itemAttachments", summary: "A card's attachments" })),
      HttpApiEndpoint.post("itemAttachmentUpload", IrisPaths.itemAttachments, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({
          name: Schema.String,
          type: Schema.optional(Schema.String),
          data: described(Schema.String, "The file, base64. A data: URL prefix is tolerated."),
          bloq: Schema.optional(Schema.Finite),
        }),
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            reason: Schema.optional(Schema.String),
            file: Schema.optional(CardFileSchema),
          }).annotate({ identifier: "IrisAttachmentUploaded" }),
          "The attachment as the card now lists it",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemAttachmentUpload",
          summary: "Upload one file to a card",
          description:
            "JSON with the file base64 — this route has no multipart machinery. Forwarded as multipart to fl-api /cloud-files/upload (the call Elon's CloudFileService makes), then appended to content.attachments in Elon's shape so both editors list it. 100MB cap is fl-api's.",
        }),
      ),
      HttpApiEndpoint.post("itemAttachmentDelete", IrisPaths.itemAttachmentDelete, {
        params: { itemID: Schema.NumberFromString, fileID: Schema.String },
        success: Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
          identifier: "IrisOk",
        }),
      }).annotateMerge(
        OpenApi.annotations({ identifier: "iris.itemAttachmentDelete", summary: "Remove an attachment from a card" }),
      ),
      HttpApiEndpoint.get("itemEvents", IrisPaths.itemEvents, {
        params: { itemID: Schema.NumberFromString },
        success: described(EventsResponse, "Events and deadlines tied to this card"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.itemEvents", summary: "A card's events" })),
      HttpApiEndpoint.post("itemEventAdd", IrisPaths.itemEvents, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({
          title: Schema.String,
          startsAt: Schema.String,
          endsAt: Schema.optional(Schema.String),
        }),
        success: Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
          identifier: "IrisOk",
        }),
      }).annotateMerge(
        OpenApi.annotations({ identifier: "iris.itemEventAdd", summary: "Add an event or deadline to a card" }),
      ),
      HttpApiEndpoint.get("itemAsks", IrisPaths.itemAsks, {
        params: { itemID: Schema.NumberFromString },
        success: described(AsksResponse, "Open and answered asks on this card"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemAsks",
          summary: "A card's asks",
          description:
            'An ask is "I need X from Y by Z". There is no primitive for it, so it is a bloq_item_task whose description carries {ask: {to}} and whose title is the X; answered = the task completed. Same table `iris agents tasks` reads, so an ask is visible everywhere a task is.',
        }),
      ),
      HttpApiEndpoint.post("itemAskAdd", IrisPaths.itemAsks, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({ to: Schema.String, what: Schema.String, dueAt: Schema.optional(Schema.String) }),
        success: Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
          identifier: "IrisOk",
        }),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.itemAskAdd", summary: "Record an ask" })),
      HttpApiEndpoint.post("itemAskAnswer", IrisPaths.itemAskAnswer, {
        params: { itemID: Schema.NumberFromString, askID: Schema.NumberFromString },
        payload: Schema.Struct({ answer: Schema.optional(Schema.String) }),
        success: Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
          identifier: "IrisOk",
        }),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.itemAskAnswer", summary: "Mark an ask answered" })),
      HttpApiEndpoint.get("itemChat", IrisPaths.itemChat, {
        params: { itemID: Schema.NumberFromString },
        query: Schema.Struct({ bloq: Schema.optional(Schema.NumberFromString) }),
        success: described(ChatResponse, "The conversation about this card"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.itemChat", summary: "A card's chat" })),
      HttpApiEndpoint.post("itemChatSend", IrisPaths.itemChat, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({ agentId: Schema.Finite, text: Schema.String, bloq: Schema.optional(Schema.Finite) }),
        success: described(ChatSendResponse, "The agent's reply"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemChatSend",
          summary: "Send one message to an agent about this card",
        }),
      ),
      HttpApiEndpoint.get("rooms", IrisPaths.rooms, {
        success: described(RoomsResponse, "Your multi-agent rooms (iris-api threads)"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.rooms", summary: "List rooms" })),
      HttpApiEndpoint.post("roomCreate", IrisPaths.rooms, {
        payload: Schema.Struct({ name: Schema.String, agentIds: Schema.Array(Schema.String) }),
        success: described(RoomCreateResponse, "The new room; the first agent is its primary"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.roomCreate", summary: "Create a room" })),
      HttpApiEndpoint.get("room", IrisPaths.room, {
        params: { roomID: Schema.String },
        success: described(RoomResponse, "A room and its thread, in send order"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.room", summary: "A room's thread" })),
      HttpApiEndpoint.post("roomSend", IrisPaths.roomMessages, {
        params: { roomID: Schema.String },
        payload: Schema.Struct({ text: Schema.String }),
        success: described(RoomSendResponse, "The sent message (with its resolved addressees) and every reply"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.roomSend",
          summary: "Send a message to a room; @mention addresses agents",
        }),
      ),
      HttpApiEndpoint.get("playbookDoc", IrisPaths.playbookDoc, {
        params: { name: Schema.String },
        query: Schema.Struct({
          project: described(
            Schema.optional(Schema.String),
            "The session's project directory, so 'installed here' counts <project>/.iris/playbooks and <project>/.claude/skills (#186277). Absolute path; anything else is ignored.",
          ),
        }),
        success: described(
          Schema.Struct({
            found: Schema.Boolean,
            name: Schema.String,
            path: described(Schema.String, "The file path when local, the landing-page URL when published."),
            source: described(
              Schema.Literals(["local", "published", "none"]),
              "Which copy this is. LOCAL wins: for a private playbook the file on disk is the only copy that exists.",
            ),
            content: described(Schema.String, "The playbook document, as markdown."),
          }).annotate({ identifier: "IrisPlaybookDoc" }),
          "One playbook's local document",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.playbookDoc",
          summary: "Read a playbook's local document",
          description:
            "Local file first, published copy second. The file read must come through the sidecar because playbook content never leaves the machine and the webview cannot read a home directory; the published fallback covers the 125 of 128 not installed here. NOT an iframe of the landing page: heyiris.io sends x-frame-options SAMEORIGIN, so embedding renders blank and reads as a broken panel.",
        }),
      ),
      HttpApiEndpoint.get("frameCheck", IrisPaths.frameCheck, {
        query: Schema.Struct({
          url: described(Schema.String, "The http(s) page the Browser tab wants to show."),
          origin: described(Schema.String, "The app's own origin — the page that would frame it."),
        }),
        success: described(
          Schema.Struct({
            state: described(
              Schema.Literals(["embeddable", "refused", "unreachable", "invalid"]),
              "embeddable: its headers allow this origin to frame it. refused: X-Frame-Options or CSP frame-ancestors forbid it, with the reason. unreachable: the fetch failed, which says nothing about framing. invalid: not an http(s) URL; nothing was fetched.",
            ),
            url: Schema.NullOr(Schema.String),
            reason: Schema.optional(Schema.String),
          }).annotate({ identifier: "IrisFrameCheck" }),
          "Whether a page can be shown in a frame inside the app",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.frameCheck",
          summary: "Can a page be framed",
          description:
            "A refused cross-origin frame fires load like a working one, and the deciding headers are invisible to the page — so the side panel's Browser tab asks the sidecar (#187864).",
        }),
      ),
      HttpApiEndpoint.get("atlasNote", IrisPaths.atlasNote, {
        query: Schema.Struct({
          url: described(Schema.String, "An Atlas note URL — https://heyiris.io/n/<uuid>. Anything else answers state=invalid."),
        }),
        success: described(
          Schema.Struct({
            state: described(
              Schema.Literals(["public", "unavailable", "unreachable", "invalid"]),
              "public: live, with its title. unavailable: heyiris.io answered non-200 — private, or the link is wrong. unreachable: the network failed, which says nothing about the note. invalid: not a note URL; nothing was fetched.",
            ),
            url: Schema.NullOr(Schema.String),
            title: Schema.optional(Schema.String),
            status: Schema.optional(Schema.Finite),
          }).annotate({ identifier: "IrisAtlasNote" }),
          "Whether an Atlas note is live, and what it calls itself",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.atlasNote",
          summary: "Check an Atlas note",
          description:
            "Atlas › Artifacts (#187717). Names a note that only appeared in Shell output, and tells the panel when one is private. The engine fetches it because the webview cannot read heyiris.io pages across origins. Only https://heyiris.io/n/<uuid> is ever fetched, so this is not a general proxy.",
        }),
      ),
      HttpApiEndpoint.get("artifacts", IrisPaths.artifacts, {
        query: ArtifactQuery,
        success: described(
          Schema.Struct({ ...Measured, ...ArtifactWhere, artifacts: Schema.Array(ArtifactMeta) }).annotate({
            identifier: "IrisArtifactList",
          }),
          "This session's artifacts, newest first",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.artifacts",
          summary: "List a session's artifacts",
          description:
            "Metadata only, newest first, capped at 200. measured=false with a reason when the session id is not a valid segment — never an empty list that reads as 'nothing made'.",
        }),
      ),
      HttpApiEndpoint.get("artifactDoc", IrisPaths.artifactDoc, {
        params: { artifactID: Schema.String },
        query: ArtifactQuery,
        success: described(
          Schema.Struct({
            ...ArtifactWhere,
            found: Schema.Boolean,
            meta: Schema.NullOr(ArtifactMeta),
            content: described(
              Schema.String,
              "The artifact's text. Goes into a sandboxed srcdoc iframe — never into the page itself.",
            ),
            truncated: described(Schema.Boolean, "True when the file is larger than the 2 MB preview cap."),
          }).annotate({ identifier: "IrisArtifactDoc" }),
          "One artifact and its content",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.artifactDoc",
          summary: "Read one artifact",
          description:
            "JSON, not a document. There is deliberately no raw/HTML variant of this route: an iframe src at an /iris URL is same-origin with the app and would bypass the preview sandbox (epic #186508, ADR-01).",
        }),
      ),
      HttpApiEndpoint.post("integrationConnect", IrisPaths.integrationConnect, {
        payload: Schema.Struct({ type: Schema.String }),
        success: described(
          Schema.Struct({
            ...Measured,
            mode: Schema.optional(Schema.String),
            url: described(
              Schema.optional(Schema.String),
              "The platform's authorize URL for THIS user. The app opens it in a real browser; fl-api's callback stores the credential.",
            ),
            hint: described(
              Schema.optional(Schema.String),
              "Set when there is nothing to authorize — a bridge connector runs on this machine.",
            ),
          }).annotate({ identifier: "IrisIntegrationConnect" }),
          "Where to send someone to connect this integration",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.integrationConnect",
          summary: "Start connecting an integration",
          description:
            "Asks the platform for the authorize URL and hands it back. measured=false carries the API's own words — 'no OAuth flow for this type' and 'connecting for an organization requires owner or admin' are different problems and the person has to read which. Scope is personal: fl-api treats an absent organization_id that way on purpose, because silence must never promote a credential to shared.",
        }),
      ),
      // First-run onboarding, screen 2 "Here's what I see" (D4 #188245, EPIC #188210).
      HttpApiEndpoint.get("onboardingState", IrisPaths.onboardingState, {
        success: described(
          Schema.Struct({
            ...Measured,
            signedIn: Schema.Boolean,
            mail: Schema.Struct({
              connected: Schema.Boolean,
              type: Schema.optional(Schema.String),
              account: Schema.optional(Schema.String),
            }),
            connected: Schema.optional(Schema.Array(Schema.String)),
          }).annotate({ identifier: "IrisOnboardingState" }),
          "Whether onboarding has anything to do yet",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.onboardingState",
          summary: "Onboarding state",
          description: "Signed in, and whether a mail account (gmail, then outlook) is connected. Safe to poll while a connect is pending in the browser — that is how the app learns the OAuth round trip finished.",
        }),
      ),
      HttpApiEndpoint.get("onboardingMail", IrisPaths.onboardingMail, {
        success: described(
          Schema.Struct({
            ...Measured,
            account: Schema.optional(Schema.String),
            threads: Schema.Array(Schema.Struct({
              id: Schema.String,
              threadId: Schema.optional(Schema.String),
              subject: Schema.String,
              from: Schema.String,
              date: Schema.optional(Schema.String),
              snippet: Schema.String,
              unread: Schema.optional(Schema.Boolean),
              automated: Schema.optional(Schema.Boolean),
              kind: Schema.optional(Schema.Literals(["person", "action", "fyi"])),
            })),
            waiting: Schema.Array(Schema.Struct({
              id: Schema.String,
              threadId: Schema.optional(Schema.String),
              subject: Schema.String,
              from: Schema.String,
              date: Schema.optional(Schema.String),
              snippet: Schema.String,
              unread: Schema.optional(Schema.Boolean),
              automated: Schema.optional(Schema.Boolean),
              kind: Schema.optional(Schema.Literals(["person", "action", "fyi"])),
            })),
          }).annotate({ identifier: "IrisOnboardingMail" }),
          "Recent inbox threads, and the few most likely waiting on this person",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.onboardingMail",
          summary: "Read recent mail",
          description: "The first real data pull: up to 10 recent inbox threads via iris-api execute-direct. Also what stamps users.activated_at server-side (T1). measured=false carries the reason (not connected, token expired) so the screen can say what to do.",
        }),
      ),
      HttpApiEndpoint.post("onboardingGround", IrisPaths.onboardingGround, {
        payload: Schema.Struct({ threads: Schema.Array(Schema.Struct({
              id: Schema.String,
              threadId: Schema.optional(Schema.String),
              subject: Schema.String,
              from: Schema.String,
              date: Schema.optional(Schema.String),
              snippet: Schema.String,
              unread: Schema.optional(Schema.Boolean),
              automated: Schema.optional(Schema.Boolean),
              kind: Schema.optional(Schema.Literals(["person", "action", "fyi"])),
            })) }),
        success: described(
          Schema.Struct({
            ...Measured,
            industry: Schema.optional(Schema.String),
            businessType: Schema.optional(Schema.String),
            line: Schema.optional(described(Schema.String, "One sentence for the headline.")),
            choices: described(Schema.Array(Schema.String), "Answers to 'What do you want off your plate first?', taken from what was found."),
          }).annotate({ identifier: "IrisOnboardingGround" }),
          "Who this person is, from their own inbox",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.onboardingGround",
          summary: "Ground IRIS on recent mail",
          description: "Sends a compact digest (sender name, subject, snippet; under 5,000 chars) to workflow-generation/business-summary. Nobody is asked to describe their business: the inbox is the description.",
        }),
      ),
      HttpApiEndpoint.post("onboardingCapabilities", IrisPaths.onboardingCapabilities, {
        payload: Schema.Struct({
          id: Schema.Literals(["reply", "admin", "catchup", "leads", "custom"]),
          goal: Schema.String,
        }),
        success: described(
          Schema.Struct({
            ...Measured,
            capabilities: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                title: Schema.String,
                detail: Schema.String,
                tool: Schema.String,
                evidence: Schema.Struct({
                  kinds: Schema.Array(Schema.Literals(["person", "action", "fyi"])),
                  pattern: Schema.optional(Schema.String),
                }),
                source: Schema.Literals(["catalog", "intent"]),
                primary: Schema.optional(Schema.Boolean),
              }),
            ),
            intent: Schema.optional(
              Schema.Struct({
                choice: Schema.optional(Schema.String),
                confidence: Schema.optional(Schema.Number),
                commands: Schema.Array(Schema.String),
              }),
            ),
          }).annotate({ identifier: "IrisOnboardingCapabilities" }),
          "What IRIS can do toward the person's stated goal",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.onboardingCapabilities",
          summary: "Capabilities for a stated goal",
          description: "The goal is the truth: options come from the curated catalog of first-class IRIS tools plus `iris intent --json` on the goal (confident picks only). The inbox is not read here; the app uses it afterwards only as evidence under each option.",
        }),
      ),
      HttpApiEndpoint.post("onboardingWorkspace", IrisPaths.onboardingWorkspace, {
        payload: Schema.Struct({ name: Schema.String }),
        success: described(
          Schema.Struct({ ...Measured, path: Schema.String }).annotate({ identifier: "IrisOnboardingWorkspace" }),
          "The folder the first session runs in",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.onboardingWorkspace",
          summary: "Create the first workspace",
          description: "Creates ~/IRIS/<slug of name> (reused if present). A new user never meets an empty folder picker before IRIS has done anything for them.",
        }),
      ),
      HttpApiEndpoint.post("onboardingTrack", IrisPaths.onboardingTrack, {
        payload: Schema.Struct({ event: Schema.String, label: Schema.optional(Schema.String) }),
        success: described(Schema.Struct({ ok: Schema.Boolean }), "Always ok — measurement never fails a step"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.onboardingTrack",
          summary: "Record an onboarding step",
          description: "Posts one of the app-side onboarding steps to the desktop funnel with this machine's install id. Unknown names are ignored.",
        }),
      ),
      HttpApiEndpoint.post("artifactPublish", IrisPaths.artifactPublish, {
        params: { artifactID: Schema.String },
        payload: Schema.Struct({
          session: Schema.String,
          project: Schema.optional(Schema.String),
          slug: described(Schema.String, "The page address: lowercase letters, numbers and hyphens."),
          visibility: described(
            Schema.Literals(["public", "unlisted", "private"]),
            "Asked every time. public: /p/<slug>. unlisted: only the /p/<id> link. private: only you — Save to Genesis.",
          ),
          requiresAuth: Schema.Boolean,
          bloq: Schema.optional(Schema.Finite),
          html: described(
            Schema.optional(Schema.String),
            "Markdown artifacts only: the page as the panel rendered it.",
          ),
        }),
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            reason: Schema.optional(Schema.String),
            published: Schema.optional(ArtifactPublished),
            sandbox: Schema.optional(Schema.Unknown),
          }).annotate({ identifier: "IrisArtifactPublishResult" }),
          "The page it went to, or why it did not",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.artifactPublish",
          summary: "Publish a Genesis artifact as a Genesis page",
        }),
      ),
      HttpApiEndpoint.get("cliCommands", IrisPaths.cliCommands, {
        query: Schema.Struct({
          q: described(Schema.optional(Schema.String), "What the person typed. Passed to the CLI as ONE argv item, never through a shell."),
          limit: Schema.optional(Schema.NumberFromString),
        }),
        success: described(
          Schema.Struct({
            ...Measured,
            commands: Schema.Array(
              Schema.Struct({
                name: Schema.String,
                describe: Schema.optional(Schema.String),
                run: described(Schema.String, "The line to type, e.g. `iris leads`."),
                aliases: Schema.optional(Schema.Array(Schema.String)),
              }),
            ),
          }).annotate({ identifier: "IrisCliCommands" }),
          "Commands the installed IRIS CLI offers",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.cliCommands",
          summary: "Search the IRIS CLI's commands",
          description:
            "Asks the INSTALLED CLI (`iris find --kind command --json`). This binary does not have them: the desktop engine carries 28 command modules and none of the platform ones, so the palette could only ever show the app's own three. measured=false with a reason when the CLI is not installed — an empty list would read as 'there are no commands'.",
        }),
      ),
      HttpApiEndpoint.get("hivePeers", IrisPaths.hivePeers, {
        query: PageQuery,
        success: described(
          Schema.Struct({
            ...Paged,
            ...Measured,
            peers: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                name: Schema.String,
                status: described(Schema.String, "active | pending | revoked. PENDING is an invite nobody has accepted, not a lesser active."),
                active: Schema.Boolean,
                inviter: described(Schema.Boolean, "Whose invite it was — 'you invited them' and 'they invited you' are different relationships."),
                inviteCode: described(Schema.optional(Schema.String), "Only while pending: what you send the other person."),
                permissions: Schema.Array(Schema.String),
                acceptedAt: Schema.optional(Schema.String),
                expiresAt: Schema.optional(Schema.String),
              }),
            ),
          }).annotate({ identifier: "IrisHivePeers" }),
          "The people you are connected to on Hive",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.hivePeers",
          summary: "List Hive peer connections",
          description:
            "The other half of Hive: the panel could only ever show YOUR machines. Active connections sort first — a live one is what you act on, a pending code is a reminder.",
        }),
      ),
      HttpApiEndpoint.get("agentLive", IrisPaths.agentLive, {
        params: { agentID: Schema.NumberFromString },
        query: Schema.Struct({ limit: Schema.optional(Schema.String) }),
        success: described(AgentLiveResponse, "The agent's current run: its step and last tool calls"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.agentLive",
          summary: "Is it stuck? A live view of an agent's run",
          description:
            "#187921. The current step (iteration, phase, seconds on it), seconds since the run last did anything, and the last N tool calls with status and duration. 'Thinking' for 75 minutes is answered by this.",
        }),
      ),
      HttpApiEndpoint.post("runTakeOver", IrisPaths.runTakeOver, {
        params: { runID: Schema.String },
        success: described(RunControlResponse, "The take-over; the run pauses after its current step"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.runTakeOver", summary: "Take over a running agent" })),
      HttpApiEndpoint.post("runHandBack", IrisPaths.runHandBack, {
        params: { runID: Schema.String },
        payload: Schema.Struct({ message: Schema.optional(Schema.String) }),
        success: described(RunControlResponse, "The run resumes from where it paused; the message is what the agent is told"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.runHandBack", summary: "Hand a taken-over run back" })),
      HttpApiEndpoint.get("agentTasks", IrisPaths.agentTasks, {
        params: { agentID: Schema.NumberFromString },
        query: Schema.Struct({ includeDone: Schema.optional(Schema.String) }),
        success: described(AgentTasksResponse, "What this agent has actually been given"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.agentTasks",
          summary: "What an agent is holding",
          description:
            "ATTACHMENT IS NOT ASSIGNMENT. `bloq_agents.bloq_id` says which agent belongs to a board; this says what it is supposed to DO. An agent attached to a 400-item board is attached to all of it and assigned none of it, and those two states looked identical from every surface until now.",
        }),
      ),
      HttpApiEndpoint.get("sites", IrisPaths.sites, {
        query: PageQuery,
        params: { bloqID: Schema.NumberFromString },
        success: described(SitesResponse, "This board's sites, published first"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.sites",
          summary: "List sites",
          description:
            "A site groups pages under shared navigation, and owns settings, a contact-form inbox and a comms thread that a page does not have. Listing only pages made all of that invisible and made a nine-page site look like nine unrelated rows. NOT board-filtered: sites are owned by a user OR a bloq and the endpoint mixes both, so narrowing by board would hide every account-level site.",
        }),
      ),
      HttpApiEndpoint.get("records", IrisPaths.records, {
        query: PageQuery,
        params: { bloqID: Schema.NumberFromString, slug: Schema.String },
        success: described(RecordsResponse, "One page of a dataset's records, with its columns"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.records",
          summary: "List dataset records",
          description:
            "The table behind an Atlas schema, and the dataset MUST belong to :bloqID — this took a bare slug once and returned 2,157 patient records from a board the caller was not on. Paged UPSTREAM — fl-api is Laravel-paginated, so this asks for the page the caller wants rather than pulling a 19,000-row dataset through the sidecar to show twenty-five lines.",
        }),
      ),
      HttpApiEndpoint.get("integrations", IrisPaths.integrations, {
        params: { bloqID: Schema.NumberFromString },
        query: Schema.Struct({
          ...SearchQuery.fields,
          scope: described(
            Schema.optional(Schema.Literals(["all", "project", "organization", "user"])),
            "Narrowed SERVER-side, before paging, so total counts the scope you are looking at.",
          ),
        }),
        success: described(IntegrationsResponse, "The account's integrations, connected first"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.integrations",
          summary: "List integrations",
          description:
            "Scoped three ways: project, organization, user. A connected account is not automatically a board to use. Failing rows sort FIRST so the one you opened the list to find is not buried under two dozen healthy ones.",
        }),
      ),
      HttpApiEndpoint.get("hiveScripts", IrisPaths.hiveScripts, {
        success: described(ScriptsResponse, "Your saved Hive scripts, each with the hub's doctor verdict"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.hiveScripts",
          summary: "List Hive scripts",
          description:
            "#188817. `iris scripts list` plus `iris scripts doctor` for every slug (cached 30 s). The verdict is the hub's — the same code that refuses a dispatch.",
        }),
      ),
      HttpApiEndpoint.get("hiveScript", IrisPaths.hiveScript, {
        params: { slug: Schema.String },
        success: described(ScriptSourceResponse, "One script's source"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.hiveScript", summary: "Read a Hive script (iris scripts pull)" })),
      HttpApiEndpoint.get("hiveScriptDoctor", IrisPaths.hiveScriptDoctor, {
        params: { slug: Schema.String },
        success: described(ScriptDoctorResponse, "Which computers can run it, and what each is missing"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.hiveScriptDoctor", summary: "Doctor a Hive script (fresh)" })),
      HttpApiEndpoint.post("hiveScriptSave", IrisPaths.hiveScriptSave, {
        params: { slug: Schema.String },
        payload: Schema.Struct({ content: Schema.String }),
        success: described(ScriptSaveResponse, "The saved version's hash"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.hiveScriptSave",
          summary: "Save a Hive script (iris scripts push)",
          description: "Upsert. Name, description, runtime and auto-pull are carried over from the saved copy.",
        }),
      ),
      HttpApiEndpoint.post("hiveScriptRun", IrisPaths.hiveScriptRun, {
        params: { slug: Schema.String },
        payload: Schema.Struct({
          node: described(Schema.String, "Node id or name, resolved as the CLI does."),
          timeout: Schema.optional(Schema.Finite),
        }),
        success: described(ScriptRunResponse, "The dispatched task — poll /iris/hive/tasks/:taskID"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.hiveScriptRun",
          summary: "Run a Hive script on a computer (iris scripts run)",
          description:
            "Pins the content hash like the CLI. Takes no arguments: the daemon does not pass a header's `arg=` values to a user script today, and sending them under an invented key would change nothing.",
        }),
      ),
      HttpApiEndpoint.get("hiveTask", IrisPaths.hiveTask, {
        params: { taskID: Schema.String },
        success: described(HiveTaskResponse, "A Hive task's stage timestamps, output and exit"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.hiveTask", summary: "Read a Hive task" })),
      HttpApiEndpoint.get("hive", IrisPaths.hive, {
        query: PageQuery,
        success: described(HiveResponse, "Registered Hive machines"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.hive",
          summary: "List Hive machines",
          description:
            "The machines registered to this account, from iris-api. Check `measured` before rendering a count: an unreachable fleet must never display as zero online.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "iris",
        description: "IRIS platform data (Atlas, Hive) for the desktop UI.",
      }),
    ),
)
