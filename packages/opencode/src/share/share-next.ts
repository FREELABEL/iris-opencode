import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { irisShareTarget } from "./iris-target"
import { ulid } from "ulid"
import { Provider } from "@/provider/provider"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import type * as SDK from "@opencode-ai/sdk/v2"

export namespace ShareNext {
  const log = Log.create({ service: "share-next" })

  // IRIS's own share server, never opencode's public one (#191488). See iris-target.ts.
  async function target() {
    return irisShareTarget({
      enterpriseUrl: await Config.get().then((x) => x.enterprise?.url),
      irisApi: process.env["IRIS_API_URL"]?.trim() || "https://heyiris.io",
      irisKey: process.env["IRIS_API_KEY"],
    })
  }

  export async function init() {
    Bus.subscribe(Session.Event.Updated, async (evt) => {
      await sync(evt.properties.info.id, [
        {
          type: "session",
          data: evt.properties.info,
        },
      ])
    })
    Bus.subscribe(MessageV2.Event.Updated, async (evt) => {
      await sync(evt.properties.info.sessionID, [
        {
          type: "message",
          data: evt.properties.info,
        },
      ])
      if (evt.properties.info.role === "user") {
        await sync(evt.properties.info.sessionID, [
          {
            type: "model",
            data: [
              await Provider.getModel(evt.properties.info.model.providerID, evt.properties.info.model.modelID).then(
                (m) => m,
              ),
            ],
          },
        ])
      }
    })
    Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
      await sync(evt.properties.part.sessionID, [
        {
          type: "part",
          data: evt.properties.part,
        },
      ])
    })
    Bus.subscribe(Session.Event.Diff, async (evt) => {
      await sync(evt.properties.sessionID, [
        {
          type: "session_diff",
          data: evt.properties.diff,
        },
      ])
    })
  }

  export async function create(sessionID: string) {
    log.info("creating share", { sessionID })
    const t = await target()
    const result = await fetch(`${t.baseUrl}${t.api.create}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...t.headers },
      body: JSON.stringify({ sessionID: sessionID }),
    }).then(async (x) => {
      if (!x.ok) throw new Error(`IRIS could not create the share (HTTP ${x.status})`)
      return (await x.json()) as { id: string; url: string; secret: string }
    })
    await Storage.write(["session_share", sessionID], result)
    fullSync(sessionID)
    return result
  }

  function get(sessionID: string) {
    return Storage.read<{
      id: string
      secret: string
      url: string
    }>(["session_share", sessionID])
  }

  type Data =
    | {
        type: "session"
        data: SDK.Session
      }
    | {
        type: "message"
        data: SDK.Message
      }
    | {
        type: "part"
        data: SDK.Part
      }
    | {
        type: "session_diff"
        data: SDK.FileDiff[]
      }
    | {
        type: "model"
        data: SDK.Model[]
      }

  const queue = new Map<string, { timeout: NodeJS.Timeout; data: Map<string, Data> }>()
  async function sync(sessionID: string, data: Data[]) {
    const existing = queue.get(sessionID)
    if (existing) {
      for (const item of data) {
        existing.data.set("id" in item ? (item.id as string) : ulid(), item)
      }
      return
    }

    const dataMap = new Map<string, Data>()
    for (const item of data) {
      dataMap.set("id" in item ? (item.id as string) : ulid(), item)
    }

    const timeout = setTimeout(async () => {
      const queued = queue.get(sessionID)
      if (!queued) return
      queue.delete(sessionID)
      const share = await get(sessionID).catch(() => undefined)
      if (!share) return

      const t = await target().catch(() => undefined)
      if (!t) return // signed out since sharing: nothing is sent anywhere
      await fetch(`${t.baseUrl}${t.api.sync(share.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...t.headers },
        body: JSON.stringify({
          secret: share.secret,
          data: Array.from(queued.data.values()),
        }),
      })
    }, 1000)
    queue.set(sessionID, { timeout, data: dataMap })
  }

  export async function remove(sessionID: string) {
    log.info("removing share", { sessionID })
    const share = await get(sessionID)
    if (!share) return
    const t = await target()
    await fetch(`${t.baseUrl}${t.api.remove(share.id)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...t.headers },
      body: JSON.stringify({
        secret: share.secret,
      }),
    })
    await Storage.remove(["session_share", sessionID])
  }

  async function fullSync(sessionID: string) {
    log.info("full sync", { sessionID })
    const session = await Session.get(sessionID)
    const diffs = await Session.diff(sessionID)
    const messages = await Array.fromAsync(MessageV2.stream(sessionID))
    const models = await Promise.all(
      messages
        .filter((m) => m.info.role === "user")
        .map((m) => (m.info as SDK.UserMessage).model)
        .map((m) => Provider.getModel(m.providerID, m.modelID).then((m) => m)),
    )
    await sync(sessionID, [
      {
        type: "session",
        data: session,
      },
      ...messages.map((x) => ({
        type: "message" as const,
        data: x.info,
      })),
      ...messages.flatMap((x) => x.parts.map((y) => ({ type: "part" as const, data: y }))),
      {
        type: "session_diff",
        data: diffs,
      },
      {
        type: "model",
        data: models,
      },
    ])
  }
}
