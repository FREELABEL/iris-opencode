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
    }).annotate({ identifier: "IrisIntegration" }),
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
  integrations: `${root}/integrations`,
  records: `${root}/records/:slug`,
  sites: `${root}/sites`,
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
        query: PageQuery,
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
        query: PageQuery,
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
      HttpApiEndpoint.get("sites", IrisPaths.sites, {
        query: PageQuery,
        success: described(SitesResponse, "The account's sites, published first"),
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
        params: { slug: Schema.String },
        success: described(RecordsResponse, "One page of a dataset's records, with its columns"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.records",
          summary: "List dataset records",
          description:
            "The table behind an Atlas schema. Paged UPSTREAM — fl-api is Laravel-paginated, so this asks for the page the caller wants rather than pulling a 19,000-row dataset through the sidecar to show twenty-five lines.",
        }),
      ),
      HttpApiEndpoint.get("integrations", IrisPaths.integrations, {
        query: PageQuery,
        success: described(IntegrationsResponse, "The account's integrations, connected first"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.integrations",
          summary: "List integrations",
          description: "Not board-scoped — a connected account is connected for the whole account. Connected ones sort first.",
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
