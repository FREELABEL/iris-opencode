import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { currentAllowedHosts, hostAllowed } from "@/server/shared/host-guard"

// Global, so it runs before routing, auth and CORS — a preflight from a rebound name is refused too.
// The allowlist is read per request (see currentAllowedHosts): cheap, and tests can set it without
// rebuilding routes.
export const hostGuardLayer = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const allowed = currentAllowedHosts()
      if (!allowed) return yield* effect
      const request = yield* HttpServerRequest.HttpServerRequest
      if (hostAllowed(request.headers.host, allowed)) return yield* effect
      return HttpServerResponse.text("Host not allowed", { status: 403 })
    }),
  { global: true },
)
