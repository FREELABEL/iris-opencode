import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
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

export const AtlasItem = Schema.Struct({
  id: Schema.Finite,
  title: Schema.String,
  type: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  content: Schema.optional(described(Schema.String, "The item body, as markdown. Only on a search: boards are read without bodies (#190231 0d).")),
  preview: Schema.optional(
    described(Schema.String, "The start of the body (fl-api summary.preview, up to 400 chars of prose) — a list row's second line (#190231 0d)."),
  ),
  createdAt: Schema.optional(described(Schema.String, "ISO timestamp the item was created.")),
  updatedAt: Schema.optional(described(Schema.String, "ISO timestamp the item was last edited.")),
  dueDate: Schema.optional(described(Schema.String, "Due date as fl-api stores it (#189806).")),
  priority: Schema.optional(Schema.String),
  cardType: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String)),
  tasks: Schema.optional(
    described(
      Schema.Struct({ open: Schema.Finite, done: Schema.Finite, total: Schema.Finite }),
      "Checklist progress from fl-api's card summary (#189793). Absent = not measured.",
    ),
  ),
  attachments: Schema.optional(described(Schema.Finite, "Attachment count. Absent = not measured.")),
  cover: Schema.optional(described(Schema.String, "The card's first image attachment, for the board face (#189797). Never sent for a contains_phi board.")),
  assignees: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.Finite,
        type: Schema.Literals(["user", "agent"]),
        userId: Schema.optional(Schema.Finite),
        agentId: Schema.optional(Schema.Finite),
        name: Schema.optional(Schema.String),
      }),
    ),
  ),
  pending: Schema.optional(
    described(
      Schema.Literals(["waiting", "held"]),
      "An edit made on this computer with no connection (#190537 W3): waiting = not sent yet, held = needs a person (see `outbox.heldItems`). A card created offline has a negative id until it is sent.",
    ),
  ),
}).annotate({ identifier: "IrisAtlasItem" })

const OutboxHeldItem = Schema.Struct({
  opId: Schema.String,
  itemId: Schema.Finite,
  kind: described(Schema.Literals(["conflict", "refused"]), "conflict = the card changed elsewhere in a field you also changed; refused = fl-api said no."),
  message: described(Schema.String, "A sentence to show as it is."),
  fields: Schema.Array(
    Schema.Struct({
      field: described(Schema.String, "fl-api's field name: title, content, status, priority, card_type, due_date, bloq_list_id."),
      base: Schema.optional(Schema.Unknown),
      mine: Schema.Unknown,
      theirs: Schema.Unknown,
    }),
  ),
}).annotate({ identifier: "IrisAtlasOutboxHeld" })

const LocalCopySettingsSchema = Schema.Struct({
  enabled: described(Schema.Boolean, "Keep a copy of each opened board on this machine. Off deletes every copy."),
  includePhi: described(Schema.Boolean, "Also keep boards fl-api marks contains_phi. Off by default: a copy on disk is unencrypted."),
  maxBoards: described(Schema.Finite, "Most recently opened boards kept, per account."),
  maxMB: described(Schema.Finite, "Total size kept, per account, in MB."),
}).annotate({ identifier: "IrisAtlasLocalCopySettings" })

export const AtlasResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  source: Schema.optional(
    described(Schema.Literals(["live", "copy"]), "live = read from fl-api now; copy = this machine's saved copy of the board (#190231 phase 1)."),
  ),
  copiedAt: Schema.optional(described(Schema.String, "When the saved copy was taken (ISO). Only with source = copy.")),
  offline: Schema.optional(
    described(Schema.Boolean, "True when fl-api could not be reached and the saved copy is shown instead. `reason` says why."),
  ),
  sync: Schema.optional(
    described(
      Schema.Literals(["unchanged", "delta", "full"]),
      "How a refresh reached fl-api (#190231 phase 3): unchanged = nothing moved, no board sent; delta = only changed cards fetched; full = the whole board.",
    ),
  ),
  outbox: Schema.optional(
    described(
      Schema.Struct({ waiting: Schema.Finite, held: Schema.Finite, heldItems: Schema.Array(OutboxHeldItem) }),
      "Edits to this board made on this computer with no connection (#190537 W3). Absent when there are none.",
    ),
  ),
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

// ── Hive › Sessions (#189446) ────────────────────────────────────────────────────────────────────
const HiveSessionSchema = Schema.Struct({
  sessionId: Schema.String,
  provider: Schema.String,
  label: Schema.String,
  status: described(Schema.String, "needs_you | active | idle | stale | unknown. `unknown` when the machine's report is not fresh."),
  activity: described(Schema.NullOr(Schema.String), "working | retrying | null — null is NOT MEASURED, never 'waiting'."),
  model: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  question: Schema.NullOr(Schema.String),
}).annotate({ identifier: "IrisHiveSession" })

const HiveSessionsResponse = Schema.Struct({
  ...Measured,
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      online: Schema.Boolean,
      lastHeartbeat: Schema.NullOr(Schema.String),
      report: described(Schema.String, "fresh | stale | unknown | never — how current this machine's session list is."),
      reportedAt: Schema.NullOr(Schema.String),
      incomplete: described(Schema.Array(Schema.String), "Providers cut at the cap or not reachable: the list is a floor."),
      sessions: Schema.Array(HiveSessionSchema),
    }).annotate({ identifier: "IrisHiveSessionNode" }),
  ),
}).annotate({ identifier: "IrisHiveSessionsResponse" })

const HiveTranscriptResponse = Schema.Struct({
  ...Measured,
  ranOn: Schema.NullOr(Schema.String),
  offset: described(Schema.NullOr(Schema.Finite), "Pass back as `since` to get only what was appended."),
  incremental: described(Schema.Boolean, "true: append these rows. false: replace what you have."),
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      type: Schema.String,
      text: Schema.NullOr(Schema.String),
      tool: Schema.NullOr(Schema.String),
      at: Schema.NullOr(Schema.String),
    }),
  ),
}).annotate({ identifier: "IrisHiveTranscript" })

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
  account: Schema.optional(Schema.NullOr(Schema.Number)),
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
      tags: described(Schema.Array(Schema.String), "`project:<board id>` puts a script in that board's Project view."),
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
      tags: Schema.Array(Schema.String),
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
const MarketScriptSchema = Schema.Struct({
  slug: Schema.String,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  version: Schema.optional(Schema.Finite),
  publishedAt: Schema.optional(Schema.String),
  requires: Schema.Array(Schema.String),
})
const MarketResponse = Schema.Struct({ ...Measured, scripts: Schema.Array(MarketScriptSchema) }).annotate({
  identifier: "IrisScriptMarketResponse",
})
const MarketSourceResponse = Schema.Struct({
  ...Measured,
  script: Schema.NullOr(
    Schema.Struct({
      ...MarketScriptSchema.fields,
      content: Schema.String,
      timeout: Schema.optional(Schema.Finite),
      egress: Schema.optional(Schema.String),
      assets: described(Schema.Finite, "Attached files. Adding the script copies its source, not these."),
      checks: Schema.Array(Schema.Struct({ title: Schema.String, status: Schema.String })),
    }),
  ),
}).annotate({ identifier: "IrisScriptMarketSourceResponse" })
const ScriptInstallResponse = Schema.Struct({
  ...ScriptSaveResponse.fields,
  assetsLeft: Schema.optional(Schema.Finite),
}).annotate({ identifier: "IrisScriptInstallResponse" })
const ScriptRunResponse = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  nodeId: Schema.optional(Schema.String),
  nodeName: Schema.optional(Schema.String),
  sha256: described(Schema.optional(Schema.NullOr(Schema.String)), "NULL = the run is UNVERIFIED (no hash could be pinned)."),
  timeoutSeconds: Schema.optional(Schema.Finite),
}).annotate({ identifier: "IrisScriptRunResponse" })
const HeartbeatRunRow = Schema.Struct({
  id: Schema.Finite,
  status: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Finite),
  tokens: Schema.NullOr(Schema.Finite),
  model: Schema.NullOr(Schema.String),
  preview: Schema.NullOr(Schema.String),
  response: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  itemId: Schema.NullOr(Schema.Finite),
  deliverableId: Schema.NullOr(Schema.Finite),
  publicUrl: Schema.NullOr(Schema.String),
  emailSent: Schema.NullOr(Schema.Boolean),
}).annotate({ identifier: "IrisHeartbeatRun" })
const HeartbeatRow = Schema.Struct({
  jobId: Schema.Finite,
  agentId: Schema.Finite,
  agentName: Schema.String,
  bloqId: Schema.NullOr(Schema.Finite),
  bloqName: Schema.NullOr(Schema.String),
  mode: Schema.NullOr(Schema.String),
  frequency: Schema.NullOr(Schema.String),
  status: Schema.String,
  agentActive: Schema.NullOr(Schema.Boolean),
  nextRunAt: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  runCount: Schema.Finite,
  consecutiveFailures: Schema.Finite,
  lastOk: Schema.NullOr(Schema.Boolean),
  lastError: Schema.NullOr(Schema.String),
  reportTo: Schema.Finite,
  tools: Schema.Finite,
  workingDays: Schema.NullOr(Schema.Array(Schema.String)),
  schedule: Schema.NullOr(
    Schema.Struct({
      timezone: Schema.String,
      days: Schema.Array(Schema.String),
      hours: Schema.NullOr(Schema.Struct({ start: Schema.String, end: Schema.String })),
    }),
  ),
  settingsFrequency: Schema.NullOr(Schema.String),
  timezone: Schema.NullOr(Schema.String),
  lastSkip: Schema.NullOr(
    Schema.Struct({ at: Schema.NullOr(Schema.String), reason: Schema.NullOr(Schema.String), kind: Schema.NullOr(Schema.String) }),
  ),
  runs: Schema.Array(HeartbeatRunRow),
  runsMeasured: described(Schema.Boolean, "False: the run history could not be read. Empty runs then mean NOT READ, not never ran."),
}).annotate({ identifier: "IrisHeartbeat" })
const HeartbeatsResponse = Schema.Struct({
  ...Measured,
  heartbeats: Schema.Array(HeartbeatRow),
}).annotate({ identifier: "IrisHeartbeatsResponse" })
const HeartbeatActionResponse = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  status: Schema.optional(described(Schema.String, "The status fl-api saved, read back.")),
}).annotate({ identifier: "IrisHeartbeatActionResponse" })
// Pulse (#189286) — heyiris.io/p/pulse-panel-directions, pick 01 "the route". Every endpoint is a READ.
const PulseStopRow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  from: Schema.optional(described(Schema.String, "The CLI command or endpoint the stop was read from.")),
  shut: described(Schema.Boolean, "True = NOT MEASURED. The count is null then — never render it as 0."),
  reason: Schema.NullOr(Schema.String),
  provenance: Schema.Literals(["measured", "partial", "not-kept", "not-measured"]),
  count: Schema.NullOr(Schema.Finite),
  floor: described(Schema.Boolean, "A capped count: at least `count`."),
  delta: Schema.NullOr(Schema.Finite),
  text: Schema.String,
  owed: Schema.Finite,
  fix: Schema.optional(Schema.Struct({ label: Schema.String, command: Schema.optional(Schema.String) })),
  items: Schema.Array(Schema.Struct({ when: Schema.optional(Schema.String), where: Schema.String, text: Schema.optional(Schema.String) })),
}).annotate({ identifier: "IrisPulseStop" })
const PulseTopicResponse = Schema.Struct({
  ...Measured,
  data: Schema.NullOr(
    Schema.Struct({
      keyword: Schema.String,
      days: Schema.Finite,
      repo: Schema.String,
      ms: Schema.Finite,
      summary: Schema.Struct({
        hits: Schema.Finite,
        floor: Schema.Boolean,
        withHits: Schema.Finite,
        reachable: Schema.Finite,
        total: Schema.Finite,
        shut: Schema.Finite,
        prior: described(Schema.NullOr(Schema.Finite), "NULL when any read stop cannot reconstruct the window before."),
        lastTouched: Schema.NullOr(Schema.Finite),
      }),
      stops: Schema.Array(PulseStopRow),
    }),
  ),
}).annotate({ identifier: "IrisPulseTopicResponse" })
const PulseContactRow = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  company: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
}).annotate({ identifier: "IrisPulseContact" })
const PulseContactsResponse = Schema.Struct({ ...Measured, data: Schema.Array(PulseContactRow) }).annotate({
  identifier: "IrisPulseContactsResponse",
})
const PulseContactResponse = Schema.Struct({
  ...Measured,
  data: Schema.NullOr(
    Schema.Struct({
      lead: PulseContactRow,
      days: Schema.Finite,
      ms: Schema.Finite,
      score: Schema.Struct({
        score: Schema.NullOr(Schema.Finite),
        band: Schema.NullOr(Schema.String),
        previous: Schema.NullOr(Schema.Finite),
        history: Schema.Array(Schema.Struct({ at: Schema.String, score: Schema.Finite })),
        coverage: Schema.NullOr(Schema.Finite),
      }),
      stops: Schema.Array(PulseStopRow),
      owed: Schema.Array(Schema.Struct({ what: Schema.String, amount: Schema.optional(Schema.String), since: Schema.optional(Schema.String) })),
      channels: Schema.Struct({ read: Schema.Finite, total: Schema.Finite }),
    }),
  ),
}).annotate({ identifier: "IrisPulseContactResponse" })
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
      held: described(Schema.Boolean, "Constellation Gate held this run for its owner's approval. It has NOT been sent."),
      gate: Schema.NullOr(
        Schema.Struct({
          explanation: Schema.String,
          reasons: Schema.Array(Schema.String),
          action: Schema.NullOr(Schema.String),
          score: Schema.NullOr(Schema.Finite),
          hardware: Schema.Array(Schema.String),
        }),
      ),
    }).annotate({ identifier: "IrisHiveTask" }),
  ),
}).annotate({ identifier: "IrisHiveTaskResponse" })

export const BloqsResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  bloqs: Schema.Array(Schema.Struct({ id: Schema.Finite, name: Schema.String }).annotate({ identifier: "IrisBloq" })),
  offline: Schema.optional(described(Schema.Boolean, "fl-api could not be reached; this is the machine's saved board list (#190231 phase 1).")),
  copiedAt: Schema.optional(described(Schema.String, "When that saved list was taken (ISO).")),
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
        id: Schema.optional(Schema.String),
        preview: Schema.optional(Schema.String),
        done: Schema.optional(described(Schema.Boolean, "Handled. Separate from read: opening is not finishing.")),
        doneAt: Schema.optional(Schema.String),
        item: Schema.optional(described(Schema.String, "A handoff/job's work item, e.g. bloq:item:1234.")),
        status: Schema.optional(Schema.String),
      }).annotate({ identifier: "IrisInboxItem" }),
    ),
    "Unread first, then newest first.",
  ),
}).annotate({ identifier: "IrisInboxResponse" })

const InboxMessageResponse = Schema.Struct({
  ...Measured,
  message: Schema.NullOr(
    Schema.Struct({
      index: described(Schema.Finite, "1-based MANIFEST position, as found NOW (it may have moved since the list)."),
      id: Schema.optional(Schema.String),
      read: Schema.Boolean,
      type: Schema.String,
      from: Schema.String,
      receivedAt: Schema.optional(Schema.String),
      label: Schema.String,
      preview: Schema.optional(Schema.String),
      body: described(Schema.NullOr(Schema.String), "The full text body. Null when there is none to show — see bodyState."),
      bodyState: Schema.Literals(["ok", "truncated", "binary", "missing", "none"]),
      url: Schema.optional(Schema.String),
      item: Schema.optional(Schema.String),
      status: Schema.optional(Schema.String),
      result: Schema.optional(Schema.String),
      file: Schema.optional(Schema.String),
      originalName: Schema.optional(Schema.String),
      sizeBytes: Schema.optional(Schema.Finite),
      burn: Schema.Boolean,
      done: Schema.optional(Schema.Boolean),
      doneAt: Schema.optional(Schema.String),
    }).annotate({ identifier: "IrisInboxMessage" }),
  ),
}).annotate({ identifier: "IrisInboxMessageResponse" })

const InboxReadResponse = Schema.Struct({
  ...Measured,
  read: Schema.Boolean,
  burned: described(Schema.Boolean, "It was a burn-after-read message, and it is now deleted."),
}).annotate({ identifier: "IrisInboxReadResponse" })

const InboxStateResponse = Schema.Struct({
  ...Measured,
  read: Schema.Boolean,
  done: Schema.Boolean,
  card: Schema.optional(
    described(
      Schema.Struct({ item: Schema.String, ok: Schema.Boolean, reason: Schema.optional(Schema.String) }),
      "When asked to close the handoff's Atlas card: whether that worked. The local write succeeding says nothing about the card.",
    ),
  ),
}).annotate({ identifier: "IrisInboxStateResponse" })

const OutboxRowSchema = Schema.Struct({
  id: Schema.String,
  to: Schema.String,
  text: Schema.String,
  sentAt: Schema.String,
  taskId: Schema.optional(described(Schema.String, "The server's task id: it ACCEPTED the message. Not proof of delivery or reading.")),
  replyTo: Schema.optional(Schema.String),
  via: Schema.optional(Schema.String),
  delivery: Schema.optional(
    described(
      Schema.Literals(["delivered", "waiting", "failed"]),
      "From the task: in their inbox / not yet / refused. Absent = not known. Never means read.",
    ),
  ),
  deliveryReason: Schema.optional(Schema.String),
  deliveredAt: Schema.optional(Schema.String),
}).annotate({ identifier: "IrisOutboxRow" })

const InboxSendResponse = Schema.Struct({
  ...Measured,
  ok: Schema.Boolean,
  sent: Schema.optional(OutboxRowSchema),
  offline: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "IrisInboxSendResponse" })

const InboxSentResponse = Schema.Struct({
  ...Measured,
  items: described(Schema.Array(OutboxRowSchema), "What this computer sent from the panel, newest last."),
}).annotate({ identifier: "IrisInboxSentResponse" })

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

// Genesis › Brand kits (#188816). Account-wide, like Sites: a brand is owned by its user.
const BrandSwatch = Schema.Struct({ name: Schema.String, value: Schema.String })
const BrandsResponse = Schema.Struct({
  ...Measured,
  brands: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      slug: Schema.String,
      status: Schema.String,
      entityType: Schema.optional(Schema.String),
      swatches: described(Schema.Array(BrandSwatch), "Up to six drawable colours, in stored order"),
      logoUrl: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.String),
    }).annotate({ identifier: "IrisBrandSummary" }),
  ),
}).annotate({ identifier: "IrisBrandsResponse" })

const BrandKitSchema = Schema.Struct({
  brand: Schema.Struct({
    id: Schema.Finite,
    name: Schema.String,
    slug: Schema.String,
    status: Schema.String,
    description: Schema.optional(Schema.String),
  }),
  colors: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.String,
      key: described(Schema.String, "Which key holds the value (DEFAULT or default) — saves write back to it"),
      extra: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  fonts: Schema.Array(Schema.Struct({ role: Schema.String, family: Schema.String })),
  typeScale: Schema.Array(Schema.Struct({ role: Schema.String, value: Schema.String })),
  logoUrl: Schema.optional(Schema.String),
  motion: Schema.optional(
    Schema.Struct({
      ease: Schema.optional(Schema.String),
      durationMs: Schema.optional(Schema.Finite),
      character: Schema.optional(Schema.String),
    }),
  ),
  personas: Schema.Array(
    Schema.Struct({ name: Schema.String, isDefault: Schema.Boolean, tone: Schema.optional(Schema.String) }),
  ),
  sections: described(
    Schema.Record(Schema.String, Schema.String),
    "Each editable section exactly as read. Echo it back as `expected` when saving.",
  ),
}).annotate({ identifier: "IrisBrandKit" })

const BrandKitResponse = Schema.Struct({ ...Measured, kit: Schema.optional(BrandKitSchema) }).annotate({
  identifier: "IrisBrandKitResponse",
})

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
  tokensUsed: Schema.optional(described(Schema.NullOr(Schema.Finite), "Tokens used this window. NULL = not reported.")),
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
  paid: described(Schema.NullOr(Schema.Boolean), "Has this person paid. NULL = unknown."),
  label: described(
    Schema.NullOr(Schema.String),
    "What to call the plan on screen (Free, IRIS Solo, Staff). NULL = the server did not say.",
  ),
  trialEndsAt: described(Schema.NullOr(Schema.String), "When a trial ends, ISO-8601. NULL = not on a trial."),
  fraction: described(Schema.NullOr(Schema.Finite), "Share of the allowance used; 1 = used up. NULL = uncapped or unknown."),
  tokensUsed: Schema.optional(described(Schema.NullOr(Schema.Finite), "Tokens used this window. NULL = not reported.")),
  resetsAt: Schema.optional(described(Schema.NullOr(Schema.String), "When the allowance window resets, ISO-8601.")),
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
 * Settings › Security (#189589). Whether Constellation Gate screens this account's model traffic,
 * WHY (the reason is the rollout policy's own), and what it has done. The policy is the server's;
 * the panel renders it and never decides it, so it cannot drift from what the proxy does.
 */
const GateEventSchema = Schema.Struct({
  id: Schema.Finite,
  at: Schema.NullOr(Schema.String),
  segment: Schema.String,
  action: described(Schema.String, "clean | flagged | held | error"),
  mode: Schema.String,
  verdict: Schema.NullOr(Schema.String),
  score: Schema.NullOr(Schema.Finite),
  reasonCode: Schema.NullOr(Schema.String),
  detected: Schema.Array(Schema.String),
  sensitivity: Schema.NullOr(Schema.String),
  latencyMs: Schema.NullOr(Schema.Finite),
  cached: Schema.Boolean,
  errorCode: Schema.NullOr(Schema.String),
  reportedFalse: Schema.Boolean,
}).annotate({ identifier: "IrisGateEvent" })

const SecurityResponse = Schema.Struct({
  measured: described(Schema.Boolean, "FALSE means we could not ask. Never render that as Gate off."),
  reason: Schema.optional(Schema.String),
  gate: Schema.Struct({
    enabled: Schema.Boolean,
    reason: described(Schema.String, "The rollout policy's reason: allowlisted, new_user, phi_no_baa, not_in_rollout, …"),
    explanation: Schema.String,
    choice: described(Schema.NullOr(Schema.String), "The person's own switch: on | off | null (following the rollout)"),
    canChange: described(Schema.Boolean, "False when a rule above the switch decided: health data, the kill switch, an operator"),
    mode: described(Schema.String, "shadow = scan and record only · enforce = hold flagged tool results"),
    org: Schema.NullOr(Schema.String),
    sensitivity: Schema.NullOr(Schema.String),
    categories: Schema.Array(Schema.String),
    segments: Schema.Array(Schema.String),
    failOpen: Schema.Boolean,
    availableChecks: Schema.Array(Schema.String),
    sensitivities: Schema.Array(Schema.String),
    stats: Schema.Struct({
      windowDays: Schema.Finite,
      scanned: Schema.Finite,
      clean: Schema.Finite,
      flagged: Schema.Finite,
      held: Schema.Finite,
      errors: Schema.Finite,
      reportedFalse: Schema.Finite,
      reportedFalsePct: Schema.NullOr(Schema.Finite),
      p50LatencyMs: Schema.NullOr(Schema.Finite),
      billableTokens: Schema.Finite,
    }),
    recent: Schema.Array(GateEventSchema),
  }),
  phiGuard: Schema.Struct({ active: Schema.Boolean, mode: Schema.String, explanation: Schema.String }),
  platform: described(
    Schema.NullOr(
      Schema.Struct({
        rollout: Schema.NullOr(
          Schema.Struct({
            enabled: Schema.Boolean,
            mode: Schema.String,
            percent: Schema.Finite,
            newUserDays: Schema.Finite,
            tiers: Schema.Array(Schema.String),
            allowUsers: Schema.Finite,
          }),
        ),
        keySource: Schema.String,
        last24h: Schema.Struct({
          scanned: Schema.Finite,
          clean: Schema.Finite,
          flagged: Schema.Finite,
          held: Schema.Finite,
          errors: Schema.Finite,
          accounts: Schema.Finite,
          cached: Schema.Finite,
          p50Ms: Schema.NullOr(Schema.Finite),
          p95Ms: Schema.NullOr(Schema.Finite),
          billableTokens: Schema.Finite,
          reportedFalsePct: Schema.NullOr(Schema.Finite),
        }),
        recent: Schema.Array(
          Schema.Struct({ ...GateEventSchema.fields, userId: Schema.NullOr(Schema.Finite), smoke: Schema.Boolean }),
        ),
      }),
    ),
    "Platform admins only: the rollout across all of IRIS. Null for everyone else.",
  ),
}).annotate({ identifier: "IrisSecurityResponse" })

const GateReportResponse = Schema.Struct({
  measured: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  event: Schema.NullOr(GateEventSchema),
}).annotate({ identifier: "IrisGateReportResponse" })

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
  inboxMessage: `${root}/inbox/:index`,
  inboxRead: `${root}/inbox/:index/read`,
  inboxState: `${root}/inbox/:index/state`,
  // Not under /inbox/: — `/inbox/:index` would claim "send" and "sent" as an index.
  inboxSend: `${root}/inbox-send`,
  inboxSent: `${root}/inbox-sent`,
  atlas: `${root}/atlas/:bloqID`,
  atlasLive: `${root}/atlas/:bloqID/live`,
  atlasItemCreate: `${root}/atlas/:bloqID/lists/:listID/items`,
  atlasListCreate: `${root}/atlas/:bloqID/lists`,
  atlasMembers: `${root}/atlas/:bloqID/members`,
  atlasMemberInvite: `${root}/atlas/:bloqID/members/invite`,
  atlasMember: `${root}/atlas/:bloqID/members/:memberID`,
  itemAssignees: `${root}/item/:itemID/assignees`,
  itemAssignee: `${root}/item/:itemID/assignees/:assigneeID`,
  itemActivity: `${root}/item/:itemID/activity`,
  itemComments: `${root}/item/:itemID/comments`,
  notifySettings: `${root}/notifications/settings`,
  atlasLocalCopy: `${root}/atlas-local-copy`,
  atlasOutboxSend: `${root}/atlas-outbox/send`,
  atlasOutboxResolve: `${root}/atlas-outbox/:opID/resolve`,
  meLive: `${root}/me/live`,
  agents: `${root}/agents/:bloqID`,
  agentsMine: `${root}/agents-mine`,
  leads: `${root}/leads/:bloqID`,
  pages: `${root}/pages/:bloqID`,
  schemas: `${root}/schemas/:bloqID`,
  playbooks: `${root}/playbooks/:bloqID`,
  integrations: `${root}/integrations/:bloqID`,
  records: `${root}/records/:bloqID/:slug`,
  sites: `${root}/sites/:bloqID`,
  brands: `${root}/brands`,
  brandKit: `${root}/brands/:brandID`,
  brandSave: `${root}/brands/:brandID/save`,
  agentTasks: `${root}/agents/:agentID/tasks`,
  agentLive: `${root}/agents/:agentID/live`,
  heartbeats: `${root}/heartbeats`,
  heartbeatRun: `${root}/heartbeats/:jobID/run`,
  heartbeatPause: `${root}/heartbeats/:jobID/pause`,
  pulseTopic: `${root}/pulse/topic`,
  pulseTopicStream: `${root}/pulse/topic/stream`,
  pulseContacts: `${root}/pulse/contacts`,
  pulseContact: `${root}/pulse/contacts/:leadID`,
  runTakeOver: `${root}/runs/:runID/take-over`,
  runHandBack: `${root}/runs/:runID/hand-back`,
  playbookDoc: `${root}/playbooks/doc/:name`,
  artifacts: `${root}/artifacts`,
  artifactDoc: `${root}/artifacts/:artifactID`,
  artifactPublish: `${root}/artifacts/:artifactID/publish`,
  playbookInstall: `${root}/playbooks/install`,
  bugReport: `${root}/bug-report`,
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
  itemMove: `${root}/item/:itemID/move`,
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
  hiveSessions: `${root}/hive/sessions`,
  hiveSessionTranscript: `${root}/hive/sessions/:sessionID/transcript`,
  hiveSessionReply: `${root}/hive/sessions/:sessionID/reply`,
  hiveScripts: `${root}/hive/scripts`,
  hiveScript: `${root}/hive/scripts/:slug`,
  hiveScriptDoctor: `${root}/hive/scripts/:slug/doctor`,
  hiveScriptSave: `${root}/hive/scripts/:slug/save`,
  hiveScriptRun: `${root}/hive/scripts/:slug/run`,
  hiveScriptTags: `${root}/hive/scripts/:slug/tags`,
  hiveMarket: `${root}/hive/market`,
  hiveMarketScript: `${root}/hive/market/:slug`,
  hiveMarketInstall: `${root}/hive/market/:slug/install`,
  hiveTask: `${root}/hive/tasks/:taskID`,
  hiveTaskDecide: `${root}/hive/tasks/:taskID/:decision`,
  allowance: `${root}/allowance`,
  plan: `${root}/plan`,
  me: `${root}/me`,
  security: `${root}/security`,
  securityGateReport: `${root}/security/gate/events/:id/report`,
  securityGate: `${root}/security/gate`,
  signOut: `${root}/sign-out`,
  accounts: `${root}/accounts`,
  accountSwitch: `${root}/accounts/switch`,
  accountRemove: `${root}/accounts/remove`,
  plans: `${root}/plans`,
  checkout: `${root}/checkout`,
  atlasNote: `${root}/atlas-note`,
  frameCheck: `${root}/frame-check`,
  panel: `${root}/panel`,
  panelState: `${root}/panel/state`,
  panelCommand: `${root}/panel/command`,
} as const

/**
 * THE SIDE PANEL (#190093) — see src/iris/panel.ts. The desktop reports what its panel shows; the
 * agent (side_panel tool) and any local caller read it and steer it. Loose on purpose: an older
 * desktop sends fewer fields, and the report is a description, not a contract the engine enforces.
 */
const PanelCatalog = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    hint: Schema.optional(Schema.String),
    subs: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, hint: Schema.optional(Schema.String) })),
  }),
)
export const PanelStatePayload = Schema.Struct({
  session: described(Schema.String, "The session on screen. One path segment: letters, digits, _ and -."),
  open: Schema.Boolean,
  tab: Schema.optional(Schema.String),
  tabs: Schema.optional(Schema.Array(Schema.String)),
  surface: Schema.optional(Schema.String),
  sub: Schema.optional(Schema.String),
  bloq: Schema.optional(Schema.Struct({ id: Schema.Finite, name: Schema.optional(Schema.String) })),
  artifact: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  catalog: Schema.optional(PanelCatalog),
  ack: Schema.optional(described(Schema.String, "The id of the iris.panel.command this report answers.")),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "IrisPanelState" })
const PanelReport = Schema.Struct({
  ...PanelStatePayload.fields,
  received: described(Schema.Finite, "When the engine received this report (ms since epoch)."),
}).annotate({ identifier: "IrisPanelReport" })
const PanelReadResponse = Schema.Struct({
  reported: described(Schema.Boolean, "false: no desktop has reported for this session since the engine started."),
  state: Schema.optional(PanelReport),
}).annotate({ identifier: "IrisPanelRead" })
export const PanelCommandPayload = Schema.Struct({
  session: Schema.String,
  action: Schema.Literals(["open", "close", "show", "artifact", "tab", "browse"]),
  surface: Schema.optional(Schema.String),
  sub: Schema.optional(Schema.String),
  bloq: Schema.optional(Schema.Finite),
  id: Schema.optional(Schema.String),
  tab: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
}).annotate({ identifier: "IrisPanelCommand" })
const PanelCommandResponse = Schema.Struct({
  answered: described(Schema.Boolean, "false: no desktop answered within 6 s — the session is not on screen in IRIS Desktop."),
  refused: Schema.optional(described(Schema.String, "Why the command was not sent.")),
  state: Schema.optional(PanelReport),
}).annotate({ identifier: "IrisPanelCommandResult" })

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
      HttpApiEndpoint.get("security", IrisPaths.security, {
        success: described(SecurityResponse, "What protects this account's model traffic, and why"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.security",
          summary: "Security settings",
          description:
            "Constellation Gate's state for the account chat uses — on or off and the rollout policy's reason, mode, checks, 30-day stats and recent scans — plus the health-data guard. Decided by fl-iris-api from a remote flag; read-only here.",
        }),
      ),
      HttpApiEndpoint.post("securityGate", IrisPaths.securityGate, {
        payload: Schema.Struct({
          enabled: described(Schema.NullOr(Schema.Boolean), "true = on, false = off, null = follow the rollout"),
        }),
        success: described(SecurityResponse, "The Security state as the server re-decided it after the change"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.securityGate",
          summary: "Switch Gate on or off for your account",
          description:
            "The person's own switch (#191083). Refused (measured: false, with the reason) when a rule above it decided — health data, the kill switch, an operator.",
        }),
      ),
      HttpApiEndpoint.post("securityGateReport", IrisPaths.securityGateReport, {
        params: { id: Schema.String },
        success: described(GateReportResponse, "The event, marked as reported"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.securityGateReport",
          summary: "Report a Gate mistake",
          description: "Marks one of your own scan events as wrong. It feeds the false-positive rate; it does not change the verdict.",
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
      HttpApiEndpoint.get("accounts", IrisPaths.accounts, {
        success: described(
          Schema.Struct({
            readable: Schema.Boolean,
            accounts: Schema.Array(
              Schema.Struct({
                ref: Schema.String,
                id: Schema.NullOr(Schema.Finite),
                email: Schema.NullOr(Schema.String),
                name: Schema.NullOr(Schema.String),
                active: Schema.Boolean,
                separateData: Schema.Boolean,
              }),
            ),
          }).annotate({ identifier: "IrisAccountsResult" }),
          "Every account this machine is signed in as. Keys are never returned.",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.accounts",
          summary: "Saved accounts",
          description:
            "The accounts in ~/.iris/accounts.json, with the one chat uses marked active. `ref` names an account to switch to or remove: its user id, or a key fingerprint for a sign-in saved before its identity was known.",
        }),
      ),
      HttpApiEndpoint.post("accountSwitch", IrisPaths.accountSwitch, {
        payload: Schema.Struct({ ref: Schema.String }),
        success: described(
          Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
            identifier: "IrisAccountSwitchResult",
          }),
          "Whether the saved key was made the active one",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.accountSwitch",
          summary: "Switch account",
          description:
            "Writes the saved account's key to ~/.iris/sdk/.env and to the CLI's auth store, so the app and the iris command both act as it. The engine keeps the old key until it restarts; the desktop restarts the app afterwards.",
        }),
      ),
      HttpApiEndpoint.post("accountRemove", IrisPaths.accountRemove, {
        payload: Schema.Struct({ ref: Schema.String }),
        success: described(
          Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({
            identifier: "IrisAccountRemoveResult",
          }),
          "Whether the saved sign-in was forgotten",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.accountRemove",
          summary: "Remove a saved account",
          description:
            "Forgets a saved sign-in that is not the active one. Its chat history stays on disk and comes back if it signs in again. The active account is signed out with sign-out instead.",
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
      HttpApiEndpoint.post("checkout", IrisPaths.checkout, {
        payload: Schema.Struct({ slug: Schema.String }),
        success: described(
          Schema.Struct({ ok: Schema.Boolean, url: Schema.optional(Schema.String), reason: Schema.optional(Schema.String) }).annotate({
            identifier: "IrisCheckoutResult",
          }),
          "Stripe's checkout URL for the plan, or why there is none",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.checkout",
          summary: "Start checkout",
          description:
            "Creates a Stripe Checkout session for one plan, for the signed-in account, and returns its URL. The desktop opens it directly — checkout never goes through a web app sign-in.",
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
      HttpApiEndpoint.get("inboxMessage", IrisPaths.inboxMessage, {
        params: { index: Schema.NumberFromString },
        query: Schema.Struct({ id: Schema.optional(Schema.String) }),
        success: described(InboxMessageResponse, "One Hive inbox message with its full body"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.inboxMessage",
          summary: "Read one Hive inbox message",
          description:
            "The message AND its body — the backing file `iris hive inbox read <n>` prints. Does not mark it read; POST …/read does. Pass the list's `id` so a manifest that shifted since the list (a burn, a clear) still opens the same message.",
        }),
      ),
      HttpApiEndpoint.post("inboxRead", IrisPaths.inboxRead, {
        params: { index: Schema.NumberFromString },
        payload: Schema.Struct({ id: Schema.optional(Schema.String) }),
        success: described(InboxReadResponse, "Whether it is now read"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.inboxRead",
          summary: "Mark a Hive inbox message read",
          description:
            "The same write `iris hive inbox read <n>` makes: read=true in the manifest, the sender's read receipt (best-effort), and burn-after-read deletes a burn message and its body.",
        }),
      ),
      HttpApiEndpoint.post("inboxState", IrisPaths.inboxState, {
        params: { index: Schema.NumberFromString },
        payload: Schema.Struct({
          id: Schema.optional(Schema.String),
          read: Schema.optional(Schema.Boolean),
          done: Schema.optional(Schema.Boolean),
          resolveCard: Schema.optional(Schema.Boolean),
        }),
        success: described(InboxStateResponse, "The row's read and done state now"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.inboxState",
          summary: "Mark a Hive inbox message unread, done, or not done",
          description:
            "read=false marks it unread again; done=true marks it handled (and read). Done is NOT read: opening a message never finishes it. resolveCard also moves a handoff's Atlas card to done through the CLI, and reports that result separately.",
        }),
      ),
      HttpApiEndpoint.post("inboxSend", IrisPaths.inboxSend, {
        payload: Schema.Struct({
          to: described(Schema.String, "The computer to send to — yours or a peer's, as `iris hive inbox send --target` takes it."),
          text: Schema.String,
          replyTo: Schema.optional(described(Schema.String, "The inbox row id this answers.")),
        }),
        success: described(InboxSendResponse, "Whether the server accepted it"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.inboxSend",
          summary: "Send or reply from the Hive inbox",
          description:
            "Runs `iris hive inbox send` — the CLI's own path, own node or a peer's via the relay. ok means the server accepted it and returned a task id; it never means delivered or read. Recorded in ~/.iris/hive/outbox.jsonl so the thread shows both sides.",
        }),
      ),
      HttpApiEndpoint.get("inboxSent", IrisPaths.inboxSent, {
        success: described(InboxSentResponse, "Messages sent from this computer's panel"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.inboxSent",
          summary: "Hive inbox: sent",
          description: "The local outbox. Only what was sent from this computer's panel — the CLI's own sends are not recorded here.",
        }),
      ),
      HttpApiEndpoint.get("atlas", IrisPaths.atlas, {
        query: Schema.Struct({
          ...PageQuery.fields,
          q: described(
            Schema.optional(Schema.String),
            "Filter this board's lists and items by title, description or BODY. Applied to the whole board before paging, so the count describes the matches and not a page. NOT the platform's global search, which is account-wide and would put another board's items under this board's heading.",
          ),
          fresh: described(
            Schema.optional(Schema.String),
            "Any value: skip the saved copy and read fl-api now (then update the copy). Without it, a saved copy is answered first (#190231 phase 1).",
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
      HttpApiEndpoint.post("atlasItemCreate", IrisPaths.atlasItemCreate, {
        params: { bloqID: Schema.NumberFromString, listID: Schema.NumberFromString },
        payload: Schema.Struct({
          title: Schema.String,
          body: Schema.optional(Schema.String),
          position: described(Schema.optional(Schema.Finite), "Ignored since #189791: fl-api appends to the end of the list itself"),
        }),
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            id: described(Schema.optional(Schema.Finite), "Negative while the card waits to be sent (#190537 W3)."),
            reason: Schema.optional(Schema.String),
          queued: described(Schema.optional(Schema.Boolean), "fl-api could not be reached: kept on this computer and sent when it can be (#190537 W3)."),
          offline: described(Schema.optional(Schema.Boolean), "fl-api could not be reached and the change could NOT be kept here (a board this computer does not keep). `reason` says so."),
          }).annotate({
            identifier: "IrisAtlasCreateResult",
          }),
          "Whether the card was created, and its id",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.atlasItemCreate",
          summary: "Add a card to a list (quick add)",
          description: "#189768. fl-api checks the caller may write to that list; a refusal comes back as `reason`.",
        }),
      ),
      HttpApiEndpoint.post("atlasListCreate", IrisPaths.atlasListCreate, {
        params: { bloqID: Schema.NumberFromString },
        payload: Schema.Struct({ name: Schema.String, position: Schema.optional(Schema.Finite) }),
        success: described(
          Schema.Struct({ ok: Schema.Boolean, id: Schema.optional(Schema.Finite), reason: Schema.optional(Schema.String) }).annotate({
            identifier: "IrisAtlasListCreateResult",
          }),
          "Whether the list was created, and its id",
        ),
      }).annotateMerge(
        OpenApi.annotations({ identifier: "iris.atlasListCreate", summary: "Add a list to a board", description: "#189768." }),
      ),
      HttpApiEndpoint.get("atlasMembers", IrisPaths.atlasMembers, {
        params: { bloqID: Schema.NumberFromString },
        success: described(
          Schema.Struct({
            ...Measured,
            ownerId: Schema.NullOr(Schema.Finite),
            youAreOwner: Schema.Boolean,
            members: Schema.Array(
              Schema.Struct({
                userId: Schema.Finite,
                name: Schema.String,
                email: Schema.String,
                permission: Schema.String,
                scope: Schema.optional(described(Schema.String, "'assigned' = only the cards assigned to them")),
              }),
            ),
          }).annotate({ identifier: "IrisAtlasMembers" }),
          "Who is on the board (#189795)",
        ),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.atlasMembers", summary: "List a board's members" })),
      HttpApiEndpoint.post("atlasMemberInvite", IrisPaths.atlasMemberInvite, {
        params: { bloqID: Schema.NumberFromString },
        payload: Schema.Struct({ email: Schema.String, permission: Schema.Literals(["viewer", "editor"]) }),
        success: described(Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }).annotate({ identifier: "IrisAtlasMemberResult" }), "Whether it landed"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.atlasMemberInvite", summary: "Invite someone to a board by email" })),
      HttpApiEndpoint.post("atlasMemberSave", IrisPaths.atlasMember, {
        params: { bloqID: Schema.NumberFromString, memberID: Schema.NumberFromString },
        payload: Schema.Struct({ permission: Schema.Literals(["viewer", "editor"]) }),
        success: described(Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }), "Whether it landed"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.atlasMemberSave", summary: "Change a member's permission" })),
      HttpApiEndpoint.delete("atlasMemberRemove", IrisPaths.atlasMember, {
        params: { bloqID: Schema.NumberFromString, memberID: Schema.NumberFromString },
        success: described(Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String) }), "Whether it landed"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.atlasMemberRemove", summary: "Remove a member from a board" })),
      HttpApiEndpoint.post("itemComment", IrisPaths.itemComments, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({ body: Schema.String, mentions: Schema.optional(Schema.Array(Schema.Finite)) }),
        success: described(
          Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String), mentioned: Schema.optional(Schema.Array(Schema.Finite)) }).annotate({ identifier: "IrisItemCommentResult" }),
          "Whether it landed, and who it told",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemComment",
          summary: "Comment on a card; @mentioned board members are told (#189799)",
        }),
      ),
      HttpApiEndpoint.get("notifySettings", IrisPaths.notifySettings, {
        success: described(Schema.Struct({ ...Measured, settings: Schema.Struct({ emailAssign: Schema.Boolean, emailMention: Schema.Boolean, emailDue: Schema.Boolean, push: Schema.Boolean }) }).annotate({ identifier: "IrisNotifySettings" }), "What you hear about from Atlas"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.notifySettings", summary: "Your Atlas notification settings (#189799)" })),
      HttpApiEndpoint.post("notifySettingsSave", IrisPaths.notifySettings, {
        payload: Schema.Struct({
          emailAssign: Schema.optional(Schema.Boolean),
          emailMention: Schema.optional(Schema.Boolean),
          emailDue: Schema.optional(Schema.Boolean),
          push: Schema.optional(Schema.Boolean),
        }),
        success: described(Schema.Struct({ ...Measured, settings: Schema.Struct({ emailAssign: Schema.Boolean, emailMention: Schema.Boolean, emailDue: Schema.Boolean, push: Schema.Boolean }) }), "Your settings after the change"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.notifySettingsSave", summary: "Change your Atlas notification settings" })),
      HttpApiEndpoint.get("atlasLocalCopy", IrisPaths.atlasLocalCopy, {
        success: described(LocalCopySettingsSchema, "Whether this machine keeps a copy of each Atlas board, and on what terms (#190231 phase 1)"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.atlasLocalCopy", summary: "Local copy of Atlas: settings" })),
      HttpApiEndpoint.post("atlasOutboxSend", IrisPaths.atlasOutboxSend, {
        success: described(
          Schema.Struct({ sent: Schema.Finite, held: Schema.Finite, waiting: Schema.Finite, offline: Schema.Boolean }).annotate({
            identifier: "IrisAtlasOutboxSendResult",
          }),
          "What was sent, what is held for a person, what still waits, and whether fl-api is still unreachable",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.atlasOutboxSend",
          summary: "Send edits made offline",
          description: "#190537 W3. Sends this computer's waiting Atlas edits now, in order. It also happens on its own every 20 s while any wait, and on any board read that reaches fl-api.",
        }),
      ),
      HttpApiEndpoint.post("atlasOutboxResolve", IrisPaths.atlasOutboxResolve, {
        params: { opID: Schema.String },
        payload: Schema.Struct({
          choice: described(Schema.Literals(["mine", "theirs"]), "mine = send your values; theirs = drop your edit and keep the card as it is"),
        }),
        success: described(
          Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String), waiting: Schema.Finite, held: Schema.Finite }).annotate({
            identifier: "IrisAtlasOutboxResolveResult",
          }),
          "Whether it was settled, and what is left",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.atlasOutboxResolve",
          summary: "Settle a held offline edit",
          description:
            "#190537 W3. A held edit is one the card changed under while you were offline, in a field you also changed. 'mine' sends yours against the card as it was when the conflict was found — if it changed AGAIN since, it comes back held with the new values rather than overwriting a change nobody here has seen.",
        }),
      ),
      HttpApiEndpoint.post("atlasLocalCopySave", IrisPaths.atlasLocalCopy, {
        payload: Schema.Struct({
          enabled: Schema.optional(Schema.Boolean),
          includePhi: Schema.optional(Schema.Boolean),
          maxBoards: Schema.optional(Schema.Finite),
          maxMB: Schema.optional(Schema.Finite),
        }),
        success: described(LocalCopySettingsSchema, "The settings after the change. Turning it off deletes every copy; turning includePhi off deletes the copies of contains_phi boards."),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.atlasLocalCopySave", summary: "Local copy of Atlas: change settings" })),
      HttpApiEndpoint.get("meLive", IrisPaths.meLive, {
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.meLive",
          summary: "Hear about your own Atlas cards (server-sent events)",
          description:
            "#189799. `ready` once connected, `notice` {kind, text, excerpt?, bloqId, itemId, title?, by?} when a card is assigned to you, mentions you or is due tomorrow, `status` {pusher}, and `ping` every 25 s. A contains_phi board's notice carries no title and no excerpt.",
        }),
      ),
      HttpApiEndpoint.get("agentsMine", IrisPaths.agentsMine, {
        success: described(
          Schema.Struct({ ...Measured, agents: Schema.Array(Schema.Struct({ id: Schema.Finite, name: Schema.String })) }).annotate({ identifier: "IrisAgentsMine" }),
          "Every agent you own, on any board",
        ),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.agentsMine", summary: "Your agents across all boards (#190269)" })),
      HttpApiEndpoint.get("itemActivity", IrisPaths.itemActivity, {
        params: { itemID: Schema.NumberFromString },
        success: described(
          Schema.Struct({
            ...Measured,
            activity: Schema.Array(
              Schema.Struct({
                id: Schema.Finite,
                type: Schema.String,
                text: Schema.String,
                icon: Schema.optional(Schema.String),
                actor: Schema.optional(Schema.String),
                actorId: Schema.optional(Schema.Finite),
                at: Schema.optional(Schema.String),
              }),
            ),
          }).annotate({ identifier: "IrisItemActivity" }),
          "A card's trail, newest first (#189799)",
        ),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.itemActivity", summary: "What happened to a card, and who did it" })),
      HttpApiEndpoint.get("itemAssignees", IrisPaths.itemAssignees, {
        params: { itemID: Schema.NumberFromString },
        success: described(Schema.Struct({ ...Measured, assignees: Schema.Array(Schema.Struct({ id: Schema.Finite, type: Schema.Literals(["user", "agent"]), userId: Schema.optional(Schema.Finite), agentId: Schema.optional(Schema.Finite), name: Schema.optional(Schema.String) })) }).annotate({ identifier: "IrisItemAssignees" }), "A card's assignees (#189796)"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.itemAssignees", summary: "List a card's assignees" })),
      HttpApiEndpoint.post("itemAssign", IrisPaths.itemAssignees, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({
          userId: Schema.optional(Schema.Finite),
          agentId: Schema.optional(Schema.Finite),
          email: described(Schema.optional(Schema.String), "Assign by email — someone not on the board gets access to their assigned cards"),
        }),
        success: described(Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String), accessGranted: Schema.optional(Schema.Boolean), assignees: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.Finite, type: Schema.Literals(["user", "agent"]), userId: Schema.optional(Schema.Finite), agentId: Schema.optional(Schema.Finite), name: Schema.optional(Schema.String) }))) }).annotate({ identifier: "IrisItemAssignResult" }), "The card's assignees after"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemAssign",
          summary: "Assign a board member or agent to a card",
          description: "Assigning someone not on the board gives them access to the cards assigned to them (#189801 ADR-02); only the board owner can grant that.",
        }),
      ),
      HttpApiEndpoint.delete("itemUnassign", IrisPaths.itemAssignee, {
        params: { itemID: Schema.NumberFromString, assigneeID: Schema.NumberFromString },
        success: described(Schema.Struct({ ok: Schema.Boolean, reason: Schema.optional(Schema.String), accessRemoved: Schema.optional(Schema.Boolean), assignees: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.Finite, type: Schema.Literals(["user", "agent"]), userId: Schema.optional(Schema.Finite), agentId: Schema.optional(Schema.Finite), name: Schema.optional(Schema.String) }))) }), "The card's assignees after"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.itemUnassign", summary: "Unassign someone from a card" })),
      HttpApiEndpoint.get("atlasLive", IrisPaths.atlasLive, {
        params: { bloqID: Schema.NumberFromString },
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.atlasLive",
          summary: "Watch an Atlas board for changes (server-sent events)",
          description:
            "#189767. `ready` once connected, `change` {at} when the board's fingerprint (lists, and each card's list, position, status, title, edit time) differs from the last check, `status` {pusher} when the instant channel connects or is refused, and `ping` every 25 s. Carries no board data — on `change`, re-read /atlas/:bloqID.",
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
      HttpApiEndpoint.post("bugReport", IrisPaths.bugReport, {
        payload: Schema.Struct({
          tool: Schema.String,
          command: Schema.String,
          error: Schema.String,
          output: Schema.optional(Schema.String),
          note: Schema.optional(Schema.String),
          preview: described(Schema.optional(Schema.Boolean), "Build the report and return it without sending"),
        }),
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            itemId: Schema.optional(Schema.Finite),
            reason: Schema.optional(Schema.String),
            title: Schema.optional(Schema.String),
            description: Schema.optional(Schema.String),
          }).annotate({ identifier: "IrisBugReportResult" }),
          "Whether the report was filed, and its ticket number",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.bugReport",
          summary: "Report a failed command",
          description:
            "The Report button on a failed command (#189435). Files it on the IRIS bug board like `iris bug report` does (fl-api, then the IRIS API host on a 5xx). Secrets are scrubbed and only the last 40 lines of output are sent. Only ever called from a user's press.",
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
            offline: described(
              Schema.optional(
                Schema.Struct({
                  copiedAt: Schema.String,
                  body: Schema.Boolean,
                  preview: Schema.optional(Schema.String),
                }),
              ),
              "Present when fl-api could not be reached and this is the card as this computer last read it, with its waiting edits on it (#191003). `body: false` means the card was never opened here online, so its notes are not on this computer: `content` is empty and must not be edited; `preview` is the start of it from the board.",
            ),
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
          base: described(
            Schema.optional(Schema.Struct({ body: Schema.optional(Schema.String) })),
            "What the editor showed before this edit, for fields a board copy does not hold (the body). If the save has to wait offline, this is what it is merged against (#190537 W3).",
          ),
        }),
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            reason: Schema.optional(Schema.String),
          queued: described(Schema.optional(Schema.Boolean), "fl-api could not be reached: kept on this computer and sent when it can be (#190537 W3)."),
          offline: described(Schema.optional(Schema.Boolean), "fl-api could not be reached and the change could NOT be kept here (a board this computer does not keep). `reason` says so."),
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
      HttpApiEndpoint.post("itemMove", IrisPaths.itemMove, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({
          listId: described(Schema.Finite, "The list (column) to put the card in, on the same board"),
          position: described(Schema.Finite, "0-based index in that list's full order, with the card itself taken out"),
        }),
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            reason: Schema.optional(Schema.String),
          queued: described(Schema.optional(Schema.Boolean), "fl-api could not be reached: kept on this computer and sent when it can be (#190537 W3)."),
          offline: described(Schema.optional(Schema.Boolean), "fl-api could not be reached and the change could NOT be kept here (a board this computer does not keep). `reason` says so."),
          }).annotate({ identifier: "IrisItemMoveResult" }),
          "Whether the move landed",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.itemMove",
          summary: "Move a card to a list and position",
          description:
            "The Board view's drag. Sends fl-api's PATCH /user/{uid}/bloqs/list/item/{id}/position, which renumbers the target column and the one the card left — so the order the board shows is the order saved.",
        }),
      ),
      HttpApiEndpoint.post("itemTaskAdd", IrisPaths.itemTaskAdd, {
        params: { itemID: Schema.NumberFromString },
        payload: Schema.Struct({
          title: Schema.String,
          parentId: described(Schema.optional(Schema.Finite), "Make it a subtask of this task (#189794)."),
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
      HttpApiEndpoint.get("panel", IrisPaths.panel, {
        query: Schema.Struct({ session: Schema.optional(Schema.String) }),
        success: described(PanelReadResponse, "What the desktop last said its side panel shows"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.panel",
          summary: "Read the side panel",
          description:
            "#190093. The desktop's own report of its side panel: open or closed, active tab, IRIS product and view, board, selected artifact, Browser address, and the catalogue of products and views. Without `session`, the most recent report from any session. In memory only; `received` says how old it is.",
        }),
      ),
      HttpApiEndpoint.post("panelState", IrisPaths.panelState, {
        payload: PanelStatePayload,
        success: described(Schema.Struct({ ok: Schema.Boolean }), "Stored"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.panelState",
          summary: "Report the side panel (desktop → engine)",
          description: "Sent by the desktop whenever its panel changes, and in answer to an iris.panel.command (with `ack`).",
        }),
      ),
      HttpApiEndpoint.post("panelCommand", IrisPaths.panelCommand, {
        payload: PanelCommandPayload,
        success: described(PanelCommandResponse, "What the desktop reported after applying it"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.panelCommand",
          summary: "Steer the side panel",
          description:
            "#190093. Emits iris.panel.command and waits up to 6 s for the desktop showing `session` to apply it and report back. The same path the side_panel tool takes; for agents outside the engine (MCP, scripts).",
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
      HttpApiEndpoint.get("heartbeats", IrisPaths.heartbeats, {
        success: described(HeartbeatsResponse, "Every live agent heartbeat on the account, each with its recent runs"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.heartbeats",
          summary: "List agent heartbeats",
          description:
            "#189110. fl-api scheduled jobs whose task is `heartbeat`, with up to 50 executions of each (a week for every cadence slower than 4-hourly). A `scheduled` status alone is not evidence a heartbeat is beating — the runs and next_run_at are.",
        }),
      ),
      HttpApiEndpoint.get("pulseTopic", IrisPaths.pulseTopic, {
        query: Schema.Struct({ q: Schema.String, days: Schema.optional(Schema.String), project: Schema.optional(Schema.String) }),
        success: described(PulseTopicResponse, "The topic route: one stop per source, in the order Pulse visits them"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.pulseTopic",
          summary: "Pulse a topic (iris pulse check, read-only)",
          description:
            "#189286. The same PulseScript `iris pulse check` walks, run on this machine. Unlike the CLI it never files the result: opening a route only reads.",
        }),
      ),
      HttpApiEndpoint.get("pulseTopicStream", IrisPaths.pulseTopicStream, {
        query: Schema.Struct({ q: Schema.String, days: Schema.optional(Schema.String), project: Schema.optional(Schema.String) }),
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.pulseTopicStream",
          summary: "Pulse a topic, streamed stop by stop (read-only)",
          description:
            "#189319. Server-sent events: `start` {source,label} as Pulse reaches a stop (the route is sequential), `stop` {stop} as that stop's result lands, then `done` {data} with the same body /pulse/topic returns, or `error` {reason}.",
        }),
      ),
      HttpApiEndpoint.get("pulseContacts", IrisPaths.pulseContacts, {
        query: Schema.Struct({ q: Schema.optional(Schema.String) }),
        success: described(PulseContactsResponse, "Contacts (leads) matching the search"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.pulseContacts", summary: "Find a contact to pulse" })),
      HttpApiEndpoint.get("pulseContact", IrisPaths.pulseContact, {
        params: { leadID: Schema.NumberFromString },
        query: Schema.Struct({ days: Schema.optional(Schema.String) }),
        success: described(PulseContactResponse, "The contact route: record, deal, tasks, checks, email log, then the channels"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.pulseContact",
          summary: "Pulse a contact (iris leads pulse, read-only)",
          description: "#189286. GETs only — the score is read without `?record=1` (#189218) and is never saved.",
        }),
      ),
      HttpApiEndpoint.post("heartbeatRun", IrisPaths.heartbeatRun, {
        params: { jobID: Schema.NumberFromString },
        success: described(HeartbeatActionResponse, "Dispatched — one beat now, outside the schedule"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.heartbeatRun", summary: "Run a heartbeat now (iris schedules run)" })),
      HttpApiEndpoint.post("heartbeatPause", IrisPaths.heartbeatPause, {
        params: { jobID: Schema.NumberFromString },
        payload: Schema.Struct({ paused: Schema.Boolean }),
        success: described(HeartbeatActionResponse, "The status fl-api saved"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.heartbeatPause", summary: "Pause or resume a heartbeat" })),
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
      HttpApiEndpoint.get("brands", IrisPaths.brands, {
        success: described(BrandsResponse, "Your brands, with swatches for the list"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.brands",
          summary: "List brand kits",
          description:
            "Genesis › Brand kits (#188816). Every brand on the signed-in account. A brand kit is the design tokens fl-api keeps at `brands.metadata.design_tokens`. Owner-scoped upstream: you see only your own brands.",
        }),
      ),
      HttpApiEndpoint.get("brandKit", IrisPaths.brandKit, {
        params: { brandID: Schema.NumberFromString },
        success: described(BrandKitResponse, "One brand's kit: colours, type, logo, motion, voice"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.brandKit",
          summary: "Read a brand kit",
          description:
            "Tokens are normalised the way fl-api's DesignTokenNormalizer does, so flat legacy kits and nested ones read the same. Font stacks and type sizes are separated: brands file both under typography.",
        }),
      ),
      HttpApiEndpoint.post("brandSave", IrisPaths.brandSave, {
        params: { brandID: Schema.NumberFromString },
        payload: Schema.Struct({
          section: Schema.Literals(["colors", "typography", "motion"]),
          value: Schema.Unknown,
          expected: described(Schema.String, "The section as read (kit.sections[section])"),
        }),
        success: described(
          Schema.Struct({
            ok: Schema.Boolean,
            reason: Schema.optional(Schema.String),
            kit: Schema.optional(BrandKitSchema),
          }).annotate({ identifier: "IrisBrandSaveResult" }),
          "Whether the save landed, and the kit as the server now holds it",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.brandSave",
          summary: "Save one section of a brand kit",
          description:
            "PINNED to what was read. fl-api's PATCH design-tokens replaces a whole section with no version check, so a second editor would silently win. This re-reads the section and refuses when it moved since `expected`, then writes and reads back.",
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
        payload: Schema.Struct({
          content: Schema.String,
          tags: described(Schema.optional(Schema.Array(Schema.String)), "Omitted = keep the saved tags."),
        }),
        success: described(ScriptSaveResponse, "The saved version's hash"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.hiveScriptSave",
          summary: "Save a Hive script (iris scripts push)",
          description: "Upsert. Name, description, runtime and auto-pull are carried over from the saved copy.",
        }),
      ),
      HttpApiEndpoint.post("hiveScriptTags", IrisPaths.hiveScriptTags, {
        params: { slug: Schema.String },
        payload: Schema.Struct({ tags: Schema.Array(Schema.String) }),
        success: described(ScriptSaveResponse, "The script, re-saved with these tags"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.hiveScriptTags",
          summary: "Set a Hive script's tags",
          description: "Replaces the tags. Same content, so the hub records no new version.",
        }),
      ),
      HttpApiEndpoint.get("hiveMarket", IrisPaths.hiveMarket, {
        query: { q: Schema.optional(Schema.String) },
        success: described(MarketResponse, "The public script directory"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.hiveMarket", summary: "Browse public Hive scripts" })),
      HttpApiEndpoint.get("hiveMarketScript", IrisPaths.hiveMarketScript, {
        params: { slug: Schema.String },
        success: described(MarketSourceResponse, "One public script, with its source and checks"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.hiveMarketScript", summary: "Read a public Hive script" })),
      HttpApiEndpoint.post("hiveMarketInstall", IrisPaths.hiveMarketInstall, {
        params: { slug: Schema.String },
        payload: Schema.Struct({ tags: Schema.optional(Schema.Array(Schema.String)) }),
        success: described(ScriptInstallResponse, "The copy saved to your account"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.hiveMarketInstall",
          summary: "Add a public Hive script to your account",
          description: "Copies the source under the same name. Refused if you already have a script by that name.",
        }),
      ),
      HttpApiEndpoint.post("hiveScriptRun", IrisPaths.hiveScriptRun, {
        params: { slug: Schema.String },
        payload: Schema.Struct({
          node: described(Schema.String, "Node id or name, resolved as the CLI does."),
          timeout: Schema.optional(Schema.Finite),
          args: Schema.optional(described(Schema.Record(Schema.String, Schema.String), "Values for the script's declared settings (# iris: arg=). The hub checks them; the node passes them as IRIS_ARG_<NAME>.")),
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
      HttpApiEndpoint.post("hiveTaskDecide", IrisPaths.hiveTaskDecide, {
        params: { taskID: Schema.String, decision: Schema.Literals(["approve", "reject", "cancel"]) },
        success: described(
          Schema.Struct({ ...Measured, taskId: Schema.NullOr(Schema.String) }).annotate({ identifier: "IrisHiveTaskDecision" }),
          "Approve or reject a run Constellation Gate held (approve answers with the NEW task to follow), or cancel/stop any run of yours.",
        ),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.hiveTaskDecide", summary: "Approve or reject a held Hive run" })),
      HttpApiEndpoint.get("hiveTask", IrisPaths.hiveTask, {
        params: { taskID: Schema.String },
        success: described(HiveTaskResponse, "A Hive task's stage timestamps, output and exit"),
      }).annotateMerge(OpenApi.annotations({ identifier: "iris.hiveTask", summary: "Read a Hive task" })),
      HttpApiEndpoint.get("hiveSessions", IrisPaths.hiveSessions, {
        success: described(HiveSessionsResponse, "Every AI session on every machine you can reach"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.hiveSessions",
          summary: "List AI sessions across your machines",
          description:
            "What each machine's daemon last reported, with the server's freshness applied: a machine whose report is old shows its sessions as `unknown`, never `active`.",
        }),
      ),
      HttpApiEndpoint.get("hiveSessionTranscript", IrisPaths.hiveSessionTranscript, {
        params: { sessionID: Schema.String },
        query: Schema.Struct({
          machine: Schema.optional(Schema.String),
          provider: Schema.optional(Schema.String),
          since: Schema.optional(Schema.NumberFromString),
          limit: Schema.optional(Schema.NumberFromString),
        }),
        success: described(HiveTranscriptResponse, "A session's transcript, read off the machine that holds it"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.hiveSessionTranscript",
          summary: "Read a session on another machine",
          description:
            "measured=false with a reason when the machine could not answer — an unreachable machine must never render as an empty session.",
        }),
      ),
      HttpApiEndpoint.post("hiveSessionReply", IrisPaths.hiveSessionReply, {
        params: { sessionID: Schema.String },
        payload: Schema.Struct({
          nodeId: Schema.String,
          provider: Schema.String,
          label: Schema.optional(Schema.String),
          message: Schema.String,
        }),
        success: described(
          Schema.Struct({ ...Measured, taskId: Schema.NullOr(Schema.String) }),
          "The delivery task — the reply appears in the session's own window",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.hiveSessionReply",
          summary: "Reply into a session on another machine",
          description:
            "The same `session_message` task as `iris hive send-input`. opencode only: a Claude Code reply from here would start a separate run rather than type into the open one.",
        }),
      ),
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
