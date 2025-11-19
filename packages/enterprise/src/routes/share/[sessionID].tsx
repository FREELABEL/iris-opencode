import { FileDiff, Message, Part, Session } from "@opencode-ai/sdk"
import { createAsync, query, useParams } from "@solidjs/router"
import { ParentProps } from "solid-js"
import { Share } from "~/core/share"

const getData = query(async (sessionID) => {
  return Share.data(sessionID)
}, "getShareData")

export default function (props: ParentProps) {
  const params = useParams()
  const data = createAsync(async () => {
    if (!params.sessionID) return
    const data = await getData(params.sessionID)
    const result: {
      session: Session[]
      session_diff: {
        [sessionID: string]: FileDiff[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
    } = {
      session: [],
      session_diff: {
        [params.sessionID]: [],
      },
      message: {},
      part: {},
    }

    for (const item of data) {
      switch (item.type) {
        case "session":
          result.session.push(item.data)
          break
        case "session_diff":
          result.session_diff[params.sessionID] = item.data
          break
        case "message":
          result.message[item.data.sessionID] = result.message[item.data.sessionID] ?? []
          result.message[item.data.sessionID].push(item.data)
          break
        case "part":
          result.part[item.data.messageID] = result.part[item.data.messageID] ?? []
          result.part[item.data.messageID].push(item.data)
          break
      }
    }
    return result
  })

  return <pre>{JSON.stringify(data(), null, 2)}</pre>
}
