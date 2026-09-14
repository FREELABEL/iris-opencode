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

const Measured = {
  measured: described(Schema.Boolean, "False means NOT MEASURED. Do not render the data as an empty result."),
  reason: Schema.optional(described(Schema.String, "Why it could not be measured — an HTTP status, or that nobody is signed in.")),
}

const AtlasItem = Schema.Struct({
  id: Schema.Finite,
  title: Schema.String,
  type: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  content: Schema.optional(described(Schema.String, "The item body, as markdown.")),
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

const BloqsResponse = Schema.Struct({
  ...Measured,
  ...Paged,
  bloqs: Schema.Array(
    Schema.Struct({ id: Schema.Finite, name: Schema.String }).annotate({ identifier: "IrisBloq" }),
  ),
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
    total: described(Schema.Finite, "Counts the rows in `tasks`, INCLUDING heartbeat boards, which the upstream total omits."),
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
      owner: described(Schema.optional(Schema.String), "\"bloq 174\" or \"user 193\" — the list mixes both."),
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
    "\"phi\" marks protected health information. Carried so a table can LABEL the column rather than rendering it like any other.",
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
      lastError: described(Schema.optional(Schema.String), "Why it is failing. A red dot with no reason is not actionable."),
      logoUrl: described(Schema.optional(Schema.String), "Brand mark from the platform's Logo.dev catalogue. Absent is normal."),
      brandId: described(Schema.optional(Schema.Finite), "Which brand owns it. 16 of 25 on this account do — see #185160."),
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
        "PLATFORM health for the provider, NOT your credential. \"Is Slack up\" and \"does your Slack token work\" are different questions; a provider can be operational while your connection is broken, which is most of what people actually hit.",
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
          mode: described(Schema.optional(Schema.String), "\"shell\" runs a command, \"prompt\" asks a model."),
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
        "~/.iris/playbooks/<name>/PLAYBOOK.md exists on THIS machine. Playbook content never leaves the machine, so the local document is richer than anything the API has.",
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

const root = "/iris"

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
  playbookDoc: `${root}/playbooks/doc/:name`,
  catalog: `${root}/catalog`,
  graph: `${root}/graph`,
  pageDoc: `${root}/page/:pageID`,
  pageSave: `${root}/page/:pageID/save`,
  hive: `${root}/hive`,
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
          ...PageQuery.fields,
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
        query: PageQuery,
        params: { bloqID: Schema.NumberFromString },
        success: described(LeadsResponse, "Leads on this bloq"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.leads",
          summary: "List leads",
          description: "Leads for one bloq. Personal data — this is the route to look at first when reviewing what the local server exposes.",
        }),
      ),
      HttpApiEndpoint.get("pages", IrisPaths.pages, {
        query: PageQuery,
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
        query: PageQuery,
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
          ...PageQuery.fields,
          view: described(
            Schema.optional(Schema.Literals(["all", "project", "marketplace"])),
            "project = attached to this board or filed against it. marketplace = actually published (public or unlisted). `private` is neither: yours and unshared.",
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
      HttpApiEndpoint.get("catalog", IrisPaths.catalog, {
        query: PageQuery,
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
            "Already-connected rows are dropped — this answers \"what can I add\", and the ones you have are the other tabs.",
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
      HttpApiEndpoint.get("playbookDoc", IrisPaths.playbookDoc, {
        params: { name: Schema.String },
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
          ...PageQuery.fields,
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
          description: "Scoped three ways: project, organization, user. A connected account is not automatically a board to use. Failing rows sort FIRST so the one you opened the list to find is not buried under two dozen healthy ones.",
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
