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

const root = "/iris"

export const IrisPaths = {
  atlas: `${root}/atlas/:bloqID`,
  hive: `${root}/hive`,
} as const

export const IrisApi = HttpApi.make("iris").add(
  HttpApiGroup.make("iris")
    .add(
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
