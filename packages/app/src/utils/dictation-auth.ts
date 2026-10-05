import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

/**
 * The Authorization header the SDK sends to `server`, for dictation's raw fetches to `url` — and
 * only when `url` IS that server, so a password never travels to a host it was not set for.
 */
export function dictationAuthFor(server: ServerConnection.HttpBase, url: string) {
  if (!server.password) return
  if (url.replace(/\/$/, "") !== server.url.replace(/\/$/, "")) return
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
  }
}
