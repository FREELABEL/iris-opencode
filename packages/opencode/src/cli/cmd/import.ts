import type { Argv } from "yargs"
import { Session } from "../../session"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Storage } from "../../storage/storage"
import { Instance } from "../../project/instance"
import { EOL } from "os"
import { irisShareTarget } from "../../share/iris-target"

/** One item as IRIS's share server returns it: GET /api/v6/shares/{id}/data (#191488). */
export type ShareItem = { type: string; data: any }

/** The flat list → { info, messages: [{ info, parts }] }, the shape a session file has. */
export function groupShareItems(items: ShareItem[]): { info: any; messages: Array<{ info: any; parts: any[] }> } | undefined {
  const session = items.find((i) => i.type === "session")?.data
  const messages = items.filter((i) => i.type === "message").map((i) => i.data)
  if (!session || messages.length === 0) return undefined
  const parts = new Map<string, any[]>()
  for (const p of items.filter((i) => i.type === "part").map((i) => i.data)) {
    const list = parts.get(p.messageID) ?? []
    list.push(p)
    parts.set(p.messageID, list)
  }
  return { info: session, messages: messages.map((m) => ({ info: m, parts: parts.get(m.id) ?? [] })) }
}

export const ImportCommand = cmd({
  command: "import <file>",
  describe: "import session data from JSON file or URL",
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: "path to JSON file or opencode.ai share URL",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      let exportData:
        | {
            info: Session.Info
            messages: Array<{
              info: any
              parts: any[]
            }>
          }
        | undefined

      const isUrl = args.file.startsWith("http://") || args.file.startsWith("https://")

      if (isUrl) {
        // An IRIS share link (#191488): https://heyiris.io/share/<id>, read with the owner's IRIS key.
        const irisMatch = args.file.match(/^https?:\/\/([^/]+)\/share\/([a-z0-9]{10,40})$/)
        if (irisMatch && !/(^|\.)opncd\.ai$/.test(irisMatch[1])) {
          const t = irisShareTarget({ irisApi: new URL(args.file).origin, irisKey: process.env["IRIS_API_KEY"] })
          const response = await fetch(`${t.baseUrl}${t.api.data(irisMatch[2])}`, { headers: t.headers })
          if (!response.ok) {
            process.stdout.write(
              response.status === 404 ? `Share not found, or it is not yours: ${irisMatch[2]}` : `Failed to fetch share data: HTTP ${response.status}`,
            )
            process.stdout.write(EOL)
            return
          }
          const grouped = groupShareItems((await response.json()) as ShareItem[])
          if (!grouped) {
            process.stdout.write(`Share has no messages: ${irisMatch[2]}`)
            process.stdout.write(EOL)
            return
          }
          exportData = grouped
        }

        const urlMatch = exportData ? null : args.file.match(/https?:\/\/opncd\.ai\/share\/([a-zA-Z0-9_-]+)/)
        if (!exportData && !urlMatch) {
          process.stdout.write(`Invalid URL format. Expected: https://heyiris.io/share/<id>`)
          process.stdout.write(EOL)
          return
        }

        if (urlMatch) {
        const slug = urlMatch[1]
        const response = await fetch(`https://opncd.ai/api/share/${slug}`)

        if (!response.ok) {
          process.stdout.write(`Failed to fetch share data: ${response.statusText}`)
          process.stdout.write(EOL)
          return
        }

        const data = await response.json()

        if (!data.info || !data.messages || Object.keys(data.messages).length === 0) {
          process.stdout.write(`Share not found: ${slug}`)
          process.stdout.write(EOL)
          return
        }

        exportData = {
          info: data.info,
          messages: Object.values(data.messages).map((msg: any) => {
            const { parts, ...info } = msg
            return {
              info,
              parts,
            }
          }),
        }
        }
      } else {
        const file = Bun.file(args.file)
        exportData = await file.json().catch(() => {})
        if (!exportData) {
          process.stdout.write(`File not found: ${args.file}`)
          process.stdout.write(EOL)
          return
        }
      }

      if (!exportData) {
        process.stdout.write(`Failed to read session data`)
        process.stdout.write(EOL)
        return
      }

      await Storage.write(["session", Instance.project.id, exportData.info.id], exportData.info)

      for (const msg of exportData.messages) {
        await Storage.write(["message", exportData.info.id, msg.info.id], msg.info)

        for (const part of msg.parts) {
          await Storage.write(["part", msg.info.id, part.id], part)
        }
      }

      process.stdout.write(`Imported session: ${exportData.info.id}`)
      process.stdout.write(EOL)
    })
  },
})
