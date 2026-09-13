import { describe, test, expect } from "bun:test"
import { McpOAuthProvider } from "../../src/mcp/oauth-provider"

const noop = { onRedirect: async () => {} }

describe("McpOAuthProvider.clientMetadata", () => {
  // The SDK transports call auth() with no scope and fall back to clientMetadata.scope.
  // A configured scope missing from here is silently never sent — X Ads MCP then fails
  // authorization with no scope, and nothing in the config looks wrong.
  test("carries the configured scope", () => {
    const provider = new McpOAuthProvider(
      "x-ads",
      "https://ads-api.x.com/mcp",
      { clientId: "pre-registered", scope: "ads.read offline.access" },
      noop,
    )
    expect(provider.clientMetadata.scope).toBe("ads.read offline.access")
  })

  test("omits scope when none is configured", () => {
    const provider = new McpOAuthProvider("remote", "https://example.com/mcp", {}, noop)
    expect("scope" in provider.clientMetadata).toBe(false)
  })
})
