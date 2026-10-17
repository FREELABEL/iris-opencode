import { Model } from "@opencode/core/model"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { redactSecrets } from "./secrets"

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "model.list",
        Effect.fn(function* () {
          const models = yield* Model.Service
          return yield* response(models.available().pipe(Effect.map((list) => list.map(redactSecrets))))
        }),
      )
      .handle(
        "model.default",
        Effect.fn(function* () {
          const models = yield* Model.Service
          return yield* response(models.default())
        }),
      )
  }),
)
