import { afterAll, describe, expect, test } from "bun:test"
import os from "node:os"
import { requestIsAuthorized, isLoopbackHost } from "../../src/cli/network"
import { Server } from "../../src/server/server"

/**
 * #182762 — a routable bind used to require a token to START, but nothing ever CHECKED it, so the
 * whole session surface (including POST /session/:id/shell) was still open to the network.
 */
const base = {
  boundHostname: "0.0.0.0",
  peer: "192.168.1.50",
  method: "GET",
  authorization: undefined as string | undefined,
  token: "s3cret-token",
}

describe("requestIsAuthorized", () => {
  test("a loopback bind is unchanged — local clients send no header", () => {
    expect(requestIsAuthorized({ ...base, boundHostname: "127.0.0.1" })).toBe(true)
  })

  test("a network peer on a routable bind is refused without the token", () => {
    expect(requestIsAuthorized(base)).toBe(false)
    expect(requestIsAuthorized({ ...base, method: "POST" })).toBe(false)
  })

  test("a wrong, empty or malformed token is refused", () => {
    for (const authorization of ["Bearer nope", "Bearer ", "s3cret-token", "Basic s3cret-token", "Bearer s3cret-token-x"]) {
      expect(requestIsAuthorized({ ...base, authorization })).toBe(false)
    }
  })

  test("the right bearer token is accepted", () => {
    expect(requestIsAuthorized({ ...base, authorization: "Bearer s3cret-token" })).toBe(true)
    expect(requestIsAuthorized({ ...base, authorization: "bearer s3cret-token" })).toBe(true)
  })

  test("no configured token means nothing from the network gets in", () => {
    expect(requestIsAuthorized({ ...base, token: undefined, authorization: "Bearer " })).toBe(false)
    expect(requestIsAuthorized({ ...base, token: undefined, authorization: "Bearer undefined" })).toBe(false)
  })

  test("loopback peers pass, including the IPv4-mapped form; an unknown peer does not", () => {
    expect(requestIsAuthorized({ ...base, peer: "127.0.0.1" })).toBe(true)
    expect(requestIsAuthorized({ ...base, peer: "::ffff:127.0.0.1" })).toBe(true)
    expect(requestIsAuthorized({ ...base, peer: "::1" })).toBe(true)
    expect(requestIsAuthorized({ ...base, peer: undefined })).toBe(false)
    expect(requestIsAuthorized({ ...base, peer: "::ffff:192.168.1.50" })).toBe(false)
  })

  test("CORS preflight passes (it carries no data)", () => {
    expect(requestIsAuthorized({ ...base, method: "OPTIONS" })).toBe(true)
  })

  test("::ffff:-mapped lookalikes are not loopback", () => {
    expect(isLoopbackHost("::ffff:10.0.0.1")).toBe(false)
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true)
  })
})

// A real socket, reached over a real non-loopback interface, so the peer address the middleware
// sees is the one a stranger on the LAN would have.
const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address

describe.skipIf(!lanAddress)("the server enforces it on a 0.0.0.0 bind", () => {
  const prev = process.env.IRIS_SERVER_TOKEN
  process.env.IRIS_SERVER_TOKEN = "integration-token"
  const server = Server.listen({ port: 0, hostname: "0.0.0.0" })
  const port = server.port
  afterAll(() => {
    server.stop(true)
    if (prev === undefined) delete process.env.IRIS_SERVER_TOKEN
    else process.env.IRIS_SERVER_TOKEN = prev
  })

  test("from the LAN address without a token: 401", async () => {
    const res = await fetch(`http://${lanAddress}:${port}/global/health`)
    expect(res.status).toBe(401)
    const shell = await fetch(`http://${lanAddress}:${port}/session/x/shell`, { method: "POST", body: "{}" })
    expect(shell.status).toBe(401)
  })

  test("from the LAN address with the token: through", async () => {
    const res = await fetch(`http://${lanAddress}:${port}/global/health`, {
      headers: { Authorization: "Bearer integration-token" },
    })
    expect(res.status).toBe(200)
  })

  test("from loopback without a token: through (the TUI's own client)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/global/health`)
    expect(res.status).toBe(200)
  })
})
