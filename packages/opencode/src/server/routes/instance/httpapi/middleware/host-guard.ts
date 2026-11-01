import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { currentAllowedHosts, hostAllowed } from "@/server/shared/host-guard"
import { defaultHostAllowed } from "@/server/shared/local-auth"

// Global, so it runs before routing, auth and CORS — a preflight from a rebound name is refused too.
// The allowlist is read per request (see currentAllowedHosts): cheap, and tests can set it without
// rebuilding routes.
export const hostGuardLayer = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const allowed = currentAllowedHosts()
      const request = yield* HttpServerRequest.HttpServerRequest
      // No explicit list: the loopback names and the bound host, once a command opened a socket (#192113).
      if (allowed ? hostAllowed(request.headers.host, allowed) : defaultHostAllowed(request.headers.host))
        return yield* effect
      return HttpServerResponse.text("Host not allowed", { status: 403 })
    }),
  { global: true },
)
