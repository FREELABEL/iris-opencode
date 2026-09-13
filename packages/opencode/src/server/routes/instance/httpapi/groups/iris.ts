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
}).annotate({ identifier: "IrisAtlasItem" })

const AtlasResponse = Schema.Struct({
  ...Measured,
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
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      status: Schema.String,
      online: Schema.Boolean,
      lastHeartbeat: Schema.NullOr(Schema.String),
      activeTasks: Schema.Finite,
      maxConcurrent: Schema.Finite,
    }).annotate({ identifier: "IrisHiveNode" }),
  ),
}).annotate({ identifier: "IrisHiveResponse" })

const BloqsResponse = Schema.Struct({
  ...Measured,
  bloqs: Schema.Array(
    Schema.Struct({ id: Schema.Finite, name: Schema.String }).annotate({ identifier: "IrisBloq" }),
  ),
}).annotate({ identifier: "IrisBloqsResponse" })

const InboxResponse = Schema.Struct({
  unread: described(
    Schema.NullOr(Schema.Finite),
    "Unread count. NULL means not measured — render it as a dash, never as zero.",
  ),
  total: Schema.Finite,
  from: Schema.optional(Schema.String),
  unreadable: described(Schema.Boolean, "The manifest exists and could not be parsed. A fault, not an empty inbox."),
}).annotate({ identifier: "IrisInboxResponse" })

const AgentsResponse = Schema.Struct({
  ...Measured,
  agents: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      status: Schema.String,
      model: Schema.optional(Schema.String),
      heartbeat: Schema.Boolean,
      schedule: Schema.optional(Schema.String),
      lastRun: Schema.optional(Schema.String),
    }).annotate({ identifier: "IrisAgent" }),
  ),
}).annotate({ identifier: "IrisAgentsResponse" })

const LeadsResponse = Schema.Struct({
  ...Measured,
  leads: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      status: Schema.optional(Schema.String),
      company: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
      hot: Schema.Boolean,
    }).annotate({ identifier: "IrisLead" }),
  ),
}).annotate({ identifier: "IrisLeadsResponse" })

const PagesResponse = Schema.Struct({
  ...Measured,
  pages: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      title: Schema.String,
      slug: Schema.optional(Schema.String),
      status: Schema.String,
      url: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.String),
    }).annotate({ identifier: "IrisPage" }),
  ),
}).annotate({ identifier: "IrisPagesResponse" })

const root = "/iris"

export const IrisPaths = {
  bloqs: `${root}/bloqs`,
  inbox: `${root}/inbox`,
  atlas: `${root}/atlas/:bloqID`,
  agents: `${root}/agents/:bloqID`,
  leads: `${root}/leads/:bloqID`,
  pages: `${root}/pages/:bloqID`,
  hive: `${root}/hive`,
} as const

export const IrisApi = HttpApi.make("iris").add(
  HttpApiGroup.make("iris")
    .add(
      HttpApiEndpoint.get("bloqs", IrisPaths.bloqs, {
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
        success: described(InboxResponse, "Hive inbox state"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.inbox",
          summary: "Hive inbox state",
          description:
            "Unread count from the local inbox manifest. A file read, not a request — which is why it must come through the sidecar: the webview cannot read the user's home directory.",
        }),
      ),
      HttpApiEndpoint.get("atlas", IrisPaths.atlas, {
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
        params: { bloqID: Schema.NumberFromString },
        success: described(PagesResponse, "Pages owned by this bloq"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "iris.pages",
          summary: "List pages",
          description: "Pages owned by one bloq. Narrowed by owner_type/owner_id, not filtered client-side.",
        }),
      ),
      HttpApiEndpoint.get("hive", IrisPaths.hive, {
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
